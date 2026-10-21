# Host task admission and accepted completion

Mode: **operational hardening**, restricted to the host/session findings CC05-01, CC05-02 and CC05-03 in `clean-05-host-sessions.md`. This patch closes those reproduced boundaries; it does not establish a complete host or repository audit.

## Behavior and ownership

- `AlphaProvider.createTask` rejects disposed callers before entering its creation queue and rechecks the shutdown fence after asynchronous preparation, registration and presentation. Disposal closes admission before joining that same queue and taking its owned-task snapshot. Direct API admission therefore has the same resource owner as webview admission.
- Cross-view child creation routes to the parent owner before acquiring either provider's queue. Opposite requests cannot each hold a queue while waiting for the other. Disposal initiated synchronously during construction joins the accepted admission without having the admission await disposal.
- `TaskSessionRegistry.reserveTaskAdmission` synchronously claims shared host capacity for every new runtime, including default API editor creation. Replacement first releases the old runtime. A prepared child uses its owning reservation without an extra charge; the admission continues holding the slot if its prepared group is cancelled. Failed admission restores the remaining prepared reservation or releases the unreserved slot. Release closures are idempotent and cannot release a successor claim for the same identity.
- A partially constructed task keeps a canonical handle through cleanup. Failed cleanup retains that handle and its capacity for an explicit disposal retry. Task constructors always receive `startTask: false`; the provider starts the registered runtime only after its final shutdown and ownership checks.
- `API` forwards completion from the provider's accepted lifecycle event, preserving captured `isSubtask` metadata. Raw managed-child completion no longer reports success to API/IPC before durable provider acknowledgement. Registering the same provider again does not duplicate forwarding.

Existing startup-profile availability/read optimizations and the Ticket-search edits in `AlphaProvider.ts` were preserved. There are no persisted/public schema changes, central `Task.ts` edits, dependencies or lockfile edits.

## Deterministic regressions

The new tests ran before production edits. After correcting a test-only attempt to assign the existing getter-only configuration queue, the baseline reproduced:

1. Final history disposal ran while a direct task admission was still blocked on configuration.
2. A registered task started after disposal began while its presentation operation was pending.
3. Default creation in a fresh editor exceeded shared capacity; the equivalent `preserveExisting: true` path already rejected.
4. Frozen-instruction preparation left an in-flight construction uncounted and uncleaned on failure.
5. API/IPC forwarded raw child completion while the test's result/mailbox commit gate was held or failed. Canonical provider completion was not observed by API.

The host baseline was **4 failing, 27 passing**; the new API boundary tests failed on early completion/missing canonical forwarding. Five additional registry cases initially failed because the admission method did not exist.

After coverage includes configuration/presentation shutdown races, constructor-triggered disposal, opposite cross-view admissions, actual public API new-editor admission, replacement at capacity, frozen-instruction failure and cleanup retry, reserved-child admission at capacity, group cancellation during admission, repeated/stale release callbacks, and successful/failed canonical completion publication. The API tests drive the actual provider publication method and API/IPC forwarding with a controlled commit gate; they do not simulate a native process/IPC client or disk failure.

## Coordinated history integration

At agent 8's request, `readIndependentThread` now reads lifecycle events after the API transcript from the owning provider's storage path and passes them through the optional `ThreadHistoryReadInput.lifecycleEvents`. Cancellation is rechecked before and after the journal read. Worktree resolution uses the same captured storage path. Agent 8 owns the history projection implementation; this patch owns its provider call site.

Two real-journal cold-read regressions in `CrossTaskOrchestration.spec.ts` verify an older failed/interrupted canonical turn remains distinct and keeps its status after a later completed turn, including pagination. Existing legacy read, privacy and cancellation coverage remains in the focused test set.

## Upstream evidence

Inspected the current checkout pinned by the parent to **`c7234c1174b27d9c55199fba0d546dc27d1b0415`**, retrieved 2026-10-20, under the temporary `ac-c7234c1` checkout:

- [Local runtime admission and shutdown](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/agent/control/runtime.rs#L275): reject after closing membership, recheck racing admission, close before cancellation, and join admitted members before reporting teardown.
- [Shutdown during child startup regression](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/agent/control_tests.rs#L780): hold parent lookup, request shutdown, reject child admission and release its membership.
- [Spawn capacity reservation](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/agent/control/spawn.rs#L720): admit startup and reserve execution/residency/thread capacity before later asynchronous construction.
- [Child completion watcher](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/agent/control.rs#L467): observe final child status, stop on tree shutdown, and deliver results to the parent through its control surface.

Alpha translates those ownership/fencing principles into its existing TypeScript provider/registry. It intentionally retains its stronger durable child result plus parent-mailbox publication barrier and terminal/mutation serialization. No sandbox behavior or upstream runtime/prompt code was copied.

## Validation

Completed after-run:

```text
pnpm --dir src test core/webview/__tests__/AlphaProvider.host-ownership.spec.ts core/webview/__tests__/CrossTaskOrchestration.spec.ts extension/__tests__/api-canonical-completion.spec.ts --maxWorkers=1
```

**3 files passed, 102 tests passed**; Vitest reported 32.55 seconds. `git diff --check` for the touched production and test files passed. Prettier ran only on touched files.

Final expanded focused run:

```text
pnpm --dir src test core/webview/__tests__/TaskSessionRegistry.spec.ts core/webview/__tests__/AlphaProvider.host-ownership.spec.ts core/webview/__tests__/AlphaProvider.spec.ts core/webview/__tests__/AlphaProvider.reasoning-preference.spec.ts core/webview/__tests__/AlphaProvider.unavailable-profile-admission.spec.ts core/webview/__tests__/CrossTaskOrchestration.spec.ts core/webview/__tests__/AlphaProvider.managed-owned-disposal.spec.ts core/webview/__tests__/AlphaProvider.managed-lifecycle-convergence.spec.ts core/webview/__tests__/AlphaProvider.managed-automatic-cold-followup.spec.ts extension/__tests__/api-canonical-completion.spec.ts extension/__tests__/api-start-new-task.spec.ts --maxWorkers=1
```

**11 files passed, 369 tests passed, 6 skipped**; Vitest reported 53.20 seconds. Existing skipped tests were not changed. The parent typecheck initially identified a nullable cursor in the new host test; the test now passes `nextCursor ?? undefined`. No production type errors were reported by that parent run. Integrated workspace typecheck/lint, complete unit gates, exact VS Code 1.138.0 smoke/1.125.0 compatibility, and managed-agent certification belong to the parent integration run; this report does not claim they passed.

## Remaining limits

- No native editor-close or live IPC client reproduction ran in this slice. The regressions execute real provider/registry/API boundary methods with controlled Task/resource adapters.
- Exact-host and packaging verification require the parent integration gates. No performance claim or live provider benchmark is made.
- Saved-task restore and unrelated registration entrypoints were not broadened into a new admission architecture; this patch specifically owns new-runtime `createTask` admission and existing prepared-child slots.

## Integrated legacy fixture follow-up — 2026-10-21

The parent full `src` run exposed two older fixture files that still omitted `getAvailableProfile` or the admission fence/registry effects. A focused baseline reproduced **15 failed, 74 passed** across `src/__tests__/provider-create-task-start.spec.ts` and `src/__tests__/single-open-invariant.spec.ts` (plus the already-failing slow-start test's unhandled rejection).

Updated only those fixtures: availability lookups delegate to their existing profile mocks; Task doubles honor the provider's reserved identity; add/remove adapters update a real `TaskSessionRegistry`; the cap case fills a real one-slot registry; and replacement releases its actual slot. The plain provider fixture uses the production admission-fence helper. All existing assertions, startup ordering checks, profile-override rejection checks and capacity expectations are preserved. There were no additional runtime changes.

```text
pnpm --dir src test __tests__/provider-create-task-start.spec.ts __tests__/single-open-invariant.spec.ts --maxWorkers=1
pnpm --dir src exec eslint __tests__/provider-create-task-start.spec.ts __tests__/single-open-invariant.spec.ts --max-warnings=0
```

Result: **2 files passed, 89 tests passed**, 11.33 seconds reported by Vitest, with no unhandled errors. Scoped ESLint passed with exit 0. Prettier touched only these two fixture files.
