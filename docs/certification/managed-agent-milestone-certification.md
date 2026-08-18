# Managed-Agent Milestone Certification

## Scope and verdict rules

This is the conflict-isolated certification track for configurable orchestration, nested managed agents, the live
agent tree, Worker Apply verification, and Settings buffering. It does not modify production code or shared tests.

The supplied snapshot implements and tests the depth-one managed-agent foundation. Configuration, managed nesting,
and the dedicated live tree are not present yet, so the default run reports those rows as `PENDING-MERGE`. The strict
post-merge run converts any remaining deterministic merge-dependent gap into `FAIL`. Declared real-host/provider
cases always remain `PENDING-INTEGRATION` until separate acceptance evidence is attached.

The machine-readable source of truth is
[`managed-agent-milestone.matrix.json`](../../scripts/certification/managed-agent-milestone.matrix.json). The harness
discovers focused tests by stable repository paths, runs them with provider credentials removed, detects declared
test debt/source blockers, and emits clearly delimited commands and matrix results.

## Final merged certification commands

Run these from the repository root in PowerShell:

```powershell
# === FINAL MERGED CERTIFICATION COMMANDS BEGIN ===
pnpm install --frozen-lockfile
node scripts/certification/managed-agent-milestone-certify.mjs --list
node scripts/certification/managed-agent-milestone-certify.mjs --strict
pnpm exec prettier --check scripts/certification docs/certification src/core/agent/__tests__/certification
node --check scripts/certification/managed-agent-milestone-certify.mjs
# === FINAL MERGED CERTIFICATION COMMANDS END ===
```

`--list` prints every resolved focused Vitest command without executing it. The matrix JSON is suitable for tooling;
the harness output uses stable row IDs and `PASS`, `FAIL`, `PENDING-MERGE`, `PENDING-BASELINE-DEBT`, and
`PENDING-INTEGRATION` tokens.

For the supplied pre-merge snapshot, omit `--strict` to run and retain expected merge-dependent rows as pending:

```powershell
node scripts/certification/managed-agent-milestone-certify.mjs
```

## Stable backend contract

Adapters, Settings controls, persistence, and tests must use these exact names and semantics:

| Field                      | Contract                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `maxConcurrentSubagents`   | Integer `1..16`, default `2`                                                                                |
| `subagentDelegationPolicy` | <code>"explicit-only" &#124; "proactive"</code>, default `"explicit-only"`; per-task policy may only narrow |
| `subagentMaxDepth`         | Integer `1..5`, default `1`                                                                                 |
| `subagentRoleTimeoutsMs`   | Partial `explore/review/worker`, each `10_000..3_600_000`; defaults `120_000/120_000/900_000`               |
| `subagentMaxInputTokens`   | Positive bounded value, default `16_000`                                                                    |
| `subagentMaxOutputTokens`  | Positive bounded value, default `4_000`                                                                     |
| `subagentRootTokenBudget`  | Positive value or `null`, default `null`                                                                    |
| `subagentRootCostBudget`   | Positive value or `null`, default `null`                                                                    |

Every child freezes `contextManifest.orchestration = { ancestry, delegationPolicy, limits }`. A legacy manifest that
omits it must recover with frozen legacy defaults, not current mutable Settings. Live/list projections expose `depth`,
`maxDepth`, `delegationPolicy`, `effectiveLimits`, and terminal `stopReason`.

Stop reasons cover timeout, input/output token limits, root token/cost budgets, depth/authority denial, ancestor
cancellation, orphan/recovery failure, cancellation, failure, and completion.

## Deterministic matrix

| Row                       | Gate                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `CFG-CONTRACT-001`        | Exact ExtensionState/updateSettings field names, ranges, and defaults       |
| `CFG-FROZEN-001`          | Frozen orchestration manifest and legacy-default recovery                   |
| `PROJECTION-CONTRACT-001` | Depth/effective-limit/stop-reason live and list projection                  |
| `CFG-POLICY-001`          | Explicit-only/proactive behavior, narrowing, and reload persistence         |
| `CFG-TIMEOUT-001`         | Role timeout configuration, reload, and exactly-once terminal outcome       |
| `CFG-BUDGET-001`          | Output/token/cost enforcement and durable stop reason                       |
| `NEST-DEPTH-001`          | Positive authorized nesting, maximum depth, and authority narrowing         |
| `NEST-CAPACITY-001`       | Atomic root-wide capacity and exact slot release                            |
| `NEST-CANCEL-001`         | Recursive cancel/interrupt/close and race idempotency                       |
| `ROUTING-MAILBOX-001`     | Depth-one durable cursor and wait-versus-injection ownership baseline       |
| `ROUTING-NESTED-001`      | Immediate-parent routing, descendant authorization, and atomic claims       |
| `RECOVERY-BASE-001`       | Registry, Worker orphan, and Apply-decision reload baseline                 |
| `RECOVERY-NESTED-001`     | Nested topology/budget/mailbox rehydration and orphan cleanup               |
| `CONTEXT-INHERIT-001`     | Frozen, credential-free, digest-checked `fork_turns` inheritance            |
| `NEST-COMPLETION-001`     | Active/unowned descendants block managed-parent completion                  |
| `WORKER-GATE-001`         | Quarantine, Apply, durable parent verification, and double completion check |
| `PROTOCOL-STRICT-001`     | Strict native-provider/lifecycle parsing                                    |
| `WORKER-NESTED-001`       | Explicit descendant Worker verification ownership                           |
| `UI-LIVE-TREE-001`        | Nested rendering, controls, aggregates, attention, and reload               |
| `UI-SETTINGS-BUFFER-001`  | Local cached edits survive unrelated extension/live-tree updates            |
| `UI-SETTINGS-DEBT-001`    | No skipped/placeholder Settings change-detection assertions                 |
| `RUNTIME-LEGACY-DEBT-001` | Selected legacy Task coverage has no skipped cases                          |

The new public-seam invariant suite
[`managed-agent-store-certification.spec.ts`](../../src/core/agent/__tests__/certification/managed-agent-store-certification.spec.ts)
proves arbitrary-depth store identity, immediate-parent mailbox routing, reload event ownership, bottom-up close/path
tombstones, and concurrent duplicate-event serialization. It deliberately does not pretend that the current provider
can launch nested managed agents.

## Expected integration-dependent pending rows

These are intentional, visible pending rows in both snapshot and strict offline runs:

```text
=== EXPECTED INTEGRATION PENDING BEGIN ===
INT-POLICY-PROVENANCE-001
INT-NESTED-RELOAD-001
INT-BUDGET-STOP-001
INT-WORKER-GATE-001
INT-LIVE-TREE-001
INT-PROCESS-CANCEL-001
INT-STORAGE-WRITERS-001
=== EXPECTED INTEGRATION PENDING END ===
```

Their shared prerequisite is:

```powershell
pnpm --filter @alpha-code/vscode-e2e test:ci
```

That existing command is only a host prerequisite. These rows stay pending until dedicated acceptance cases prove:

- genuine human authorization versus generated/replayed explicit-only requests;
- real extension-host hard-kill/reload at nested lifecycle and mailbox-claim boundaries;
- billable provider timeout/token/cost cutoff plus final usage settlement;
- real Worker Apply -> blocked completion -> parent verification -> accepted completion across reload;
- live webview tree selection, controls, attention, aggregate usage, stale-event rejection, and Settings edit survival;
- HTTP/process-tree cancellation and capacity cleanup; and
- multi-process global-storage writers without corruption or duplicate mailbox claims.

## Supplied-snapshot execution

The final expanded strict run on 2026-08-18 completed every executable prerequisite and focused track:

- public types build: pass;
- focused Vitest tracks: `8/8` pass;
- test files: `58` pass;
- test cases: `685` pass, `0` fail, `9` pre-existing skip;
- new nested store invariant cases: `4/4` pass;
- formatting, new-test ESLint, harness syntax, and matrix/list validation: pass.

The default snapshot matrix is expected to classify `5 PASS`, `1 FAIL`, `14 PENDING-MERGE`,
`2 PENDING-BASELINE-DEBT`, and `7 PENDING-INTEGRATION`. Strict mode intentionally converts the 14 missing merged
capabilities to failures, producing `15 FAIL`, `5 PASS`, `2 PENDING-BASELINE-DEBT`, and `7 PENDING-INTEGRATION`.
Both modes exit nonzero on this snapshot because `UI-SETTINGS-BUFFER-001` is a real deterministic failure. No focused
test process failed.

## Hard snapshot finding

`UI-SETTINGS-BUFFER-001` is a deterministic `FAIL` on the supplied snapshot. The import cache-bust effect in
`SettingsView` depends on `[settingsImportedAt, extensionState]` and gates only on a truthy timestamp. Because the
timestamp remains present after import, any unrelated state object update can replace `cachedState` and clear the dirty
flag. Live-tree refresh traffic makes this data-loss race more likely.

The required contract is edge-triggered rehydration only when the import timestamp itself changes. All Settings inputs,
including the managed-agent controls, remain bound to `cachedState` and write only through `setCachedStateField` until
Save.

The Settings track also reports five existing skipped cases in `SettingsView.unsaved-changes.spec.tsx` and the
placeholder `expect(true).toBe(true)` in `SettingsView.change-detection.spec.tsx` as `PENDING-BASELINE-DEBT`; Vitest's
overall exit code must not conceal them.

The lifecycle track likewise reports four unrelated legacy skips in `Task.spec.ts` as `RUNTIME-LEGACY-DEBT-001`. They
do not replace any managed-agent matrix row, but they remain visible rather than being hidden behind a green file exit.

## Merge-owner contract and risks

Highest-risk integration contracts:

1. Preserve both `rootTaskId` and the immediate `parentTaskId`/`parentPath`; never flatten descendants under root.
2. Route results, recovery events, waits, messages, and controls to the owning immediate parent. Restrict targets to an
   authorized descendant subtree.
3. Acquire root-keyed capacity and task-name reservations atomically before any asynchronous preparation. The current
   check-then-await-then-reserve flow can over-admit concurrent parents.
4. Persist effective policy, ancestry, limits, deadlines, usage, and stop reason before launch. Reload must never consult
   changed current Settings for an existing child.
5. Make mailbox result claiming atomic across concurrent `wait_agent` and automatic injection paths.
6. Cascade cancel/interrupt/close through queued and running descendants with one terminal event and exact capacity
   release. Reject or quarantine cycles, missing parents, inconsistent roots, and orphaned topology deterministically.
7. Block managed-parent completion while descendants are active or terminal results are unowned. Define the
   descendant Worker verification owner and apply both completion checks to managed parents.
8. Build the live tree from durable registry identity, not transcript `SubagentGroupCard` state. Every action carries
   explicit task/root identity; tree refreshes never overwrite the selected transcript or local Settings buffer.

Primary merge hotspots:

- `packages/types/src/{global-settings,agent-control,message,subagent,subagent-context,vscode-extension-host}.ts`
- `src/core/agent/{AgentControlStore,AsyncSubagentRunManager,BoundedDelegationManager,InternalTaskEnvelope}.ts`
- `src/core/task/{Task,build-tools}.ts`
- `src/core/tools/AttemptCompletionTool.ts`
- `src/core/webview/{ClineProvider,webviewMessageHandler}.ts`
- `webview-ui/src/context/ExtensionStateContext.tsx`
- `webview-ui/src/components/{settings/SettingsView,settings/AgentsSettings,chat/SubagentGroupCard}.tsx`

Do not count `src/__tests__/nested-delegation-resume.spec.ts` as managed-agent nesting evidence; it exercises the legacy
blocking `new_task` delegation path.

## Closure ledger

- Fixed now: conflict-isolated combined harness, machine-readable matrix, deterministic store invariants, explicit
  integration pending rows, exact command emission, and merge contract/risk documentation.
- Flagged for follow-up: configuration/nesting/live-tree implementation evidence, atomic capacity/mailbox claims,
  managed-parent completion, descendant Worker ownership, and the Settings import cache-bust defect.
- Not verified offline: real host restart, provider accounting/abort, process cleanup, multi-process storage, and live
  webview convergence.
- Out of scope: production/source fixes, edits to existing shared tests, package/type changes, and UI component changes.
