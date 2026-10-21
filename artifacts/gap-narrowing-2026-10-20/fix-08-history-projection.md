# Fix 08: public thread history preserves terminal boundaries

Contract-alignment pass, 2026-10-20. Scope is the confirmed public-history defect from
`artifacts/directory-review-2026-10-20/converge-05-persistence.md`; active-fork capability changes are excluded.

## Evidence and intended behavior

Inspected the local `openai/codex` checkout at
`C:/Users/Luke Goblirsch/AppData/Local/Temp/ac-c7234c1`, verified HEAD
**`c7234c1174b27d9c55199fba0d546dc27d1b0415`**. Relevant sources/tests:

- [`thread_history.rs`, terminal projection and explicit turn identity](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/app-server-protocol/src/protocol/thread_history.rs#L1264): interruption targets its named turn; starting a turn creates an explicit boundary; completion preserves an existing failure/interruption.
- [`marks_turn_as_interrupted_when_aborted`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/app-server-protocol/src/protocol/thread_history.rs#L2829): an aborted request followed by another request remains two turns, first interrupted.
- [`late_turn_aborted_does_not_interrupt_active_turn`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/app-server-protocol/src/protocol/thread_history.rs#L4517): terminal evidence applies to the matching identity.
- [`rollout_reconstruction.rs`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/session/rollout_reconstruction.rs#L390) and `reconstruct_attribution_ignores_previous_turn_terminal` in `rollout_reconstruction_tests.rs`: replay keeps explicit start attribution and rejects contamination by another turn's terminal event.

Upstream Rust tests were inspected, not executed. Alpha's native TypeScript lifecycle journal and transcript remain the source of persisted evidence; no upstream runtime or storage implementation is copied.

## Before and after

Before: a human request, cancelled/failed commentary response, second human request, and final answer projected as one completed turn. Partitioning recognized only final assistant text; historical lifecycle identity/status was unavailable to the public reader.

Added deterministic regressions before implementation and ran the owning test file: **2 failed / 11 passed**, with actual `["completed"]` instead of `["completed", "interrupted"]` or `["completed", "failed"]`.

After:

- `buildThreadReadResult` optionally accepts validated canonical lifecycle events. Task/run/turn identity supplies stable scoped turn IDs and historical status; visible final phases do not override a canonical interrupted/failed/active state.
- Message timestamps and existing assistant-message/tool-call IDs associate transcript envelopes with those identities. Inputs staged just before a canonical start attach to their owning turn, including before its first response. A completed legacy prefix retains its original cursor identity.
- Canonical same-turn steering, rejected final candidates and failed model attempts remain together. Journal step failures do not substitute for turn terminality.
- Without correlated lifecycle evidence, persisted cancelled outcomes establish interrupted boundaries and nonretryable failed outcomes establish failed boundaries. Incomplete/retryable attempts and synthetic agent continuations do not open a new human turn. Trailing hidden reasoning cannot erase an interrupted/failed boundary.
- Latest host terminal status takes precedence over an inferred legacy final phase.
- Cold cloned reads and pagination preserve older terminal status. Private provider state, hidden reasoning, journal-only arguments and opt-in tool output filtering retain their existing boundary.

## Files and integration

Owned edits:

- `src/core/task-persistence/ThreadHistory.ts`
- `src/core/task-persistence/__tests__/ThreadHistory.spec.ts`
- `artifacts/gap-narrowing-2026-10-20/fix-08-history-projection.md`

Coordinated caller integration is owned by implementation agent 06 in `src/core/webview/AlphaProvider.ts`: read lifecycle events using the owning provider's storage path after the transcript read, preserve cancellation checks, and pass `lifecycleEvents` to the projector. This agent did not edit that file. No Task/shared-type/persisted-schema changes, dependencies, lockfiles, fork implementation, or generated outputs were changed here.

## Validation

Executed after implementation:

```powershell
pnpm --dir src test core/task-persistence/__tests__/ThreadHistory.spec.ts --maxWorkers=1
pnpm --dir src exec eslint core/task-persistence/ThreadHistory.ts core/task-persistence/__tests__/ThreadHistory.spec.ts --max-warnings=0
```

**24 tests passed; ESLint passed.** Prettier was applied only to the two touched TypeScript files. Existing fork regressions remain green.

Parent/host owner runs extension type checks, caller integration tests, and required exact-host gates. They are not claimed as executed by this agent.

## Residual limits

Old transcripts do not carry a host run/turn stamp. Timestamp-less envelopes without a matching persisted message/tool ID, and unstamped envelopes ambiguous between equal-timestamp starts, retain the legacy text/outcome fallback. Missing historical evidence cannot be reconstructed with certainty; this fix does not migrate or invent it. Canonical IDs replace heuristic cursor IDs when a previously uncorrelated history first gains lifecycle evidence.

Journal read cost and large-history throughput were not benchmarked; no performance claim is made. Sandbox architecture, storage implementation identity, and the broader active-fork snapshot capability are out of scope.
