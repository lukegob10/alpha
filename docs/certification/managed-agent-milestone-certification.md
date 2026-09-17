# Managed-Agent Milestone Certification

## Recorded deterministic verdict

The latest source-stable strict run recorded on 2026-08-23 for the combined configurable-orchestration,
nested-agent, Worker-verification, and live-tree implementation passed its deterministic release gate.

- Deterministic matrix: **26 PASS, 0 FAIL, 0 pending merge, 0 baseline-debt exceptions**.
- Focused execution: **10 tracks, 974 tests passed, 0 failed, 0 skipped, 0 todo**.
- External boundary: **8 PENDING-INTEGRATION** cases that require a real VS Code host, native provider traffic,
  deliberate reload/process interruption, or multiple extension-host writers.

The deterministic suite now has a separate scripted Extension Host acceptance test for nested Worker Apply/Discard,
verification, projection, and navigation. The remaining integration rows still require real provider traffic,
deliberate reload/process interruption, pixel-level UI observation, or multiple extension-host writers. The operator
playbook for those boundaries is in
[`managed-agent-live-acceptance.md`](./managed-agent-live-acceptance.md).

Certification evidence is source-bound, not evergreen. Rerun `pnpm certify:managed-agents` after any tracked or
untracked source change; only a fresh artifact whose start and end source hashes match certifies the tree under review.

The machine-readable source of truth is
[`managed-agent-milestone.matrix.json`](../../scripts/certification/managed-agent-milestone.matrix.json). The harness
discovers focused tests by stable repository paths, removes provider credentials from the test environment, detects
declared skips/placeholders/source blockers, rejects cross-track test-file overlap, verifies the published count
arithmetic/summaries, enforces a per-track regression floor totaling 903 tests, and emits stable row IDs and statuses.
Each executed run writes the
gitignored `artifacts/certification/managed-agent-milestone-evidence.json` with the HEAD commit, dirty-source hash,
source-stability check, per-track Vitest counts, deterministic row outcomes, and an explicit `liveAcceptance: NOT_RUN`.
The harness refuses a tracked or non-gitignored evidence destination so writing its own artifact cannot mutate the
source state it just certified.
Its prerequisite rejects stale pacing guidance, requires Run A to treat an omitted pacing block as zero, keeps the
retained follow-up payload exact, requires cancellation immediately after the second PID, and makes timed UI choices
non-evidentiary. On Windows, it also executes Run A's documented setup command in a temporary workspace, runs a
bounded short form of the documented sleeper command, and verifies the documented PID-check command before any live
handoff.
The self-check runs that same preflight in a bounded child process and requires its platform-specific PASS receipt, so
it cannot report success while the certification prerequisite is broken.

## Canonical commands

Run these from the repository root in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm check-types
pnpm test
pnpm certify:managed-agents:self-check
pnpm certify:managed-agents:list
pnpm certify:managed-agents
pnpm certify:managed-agents:host-e2e
pnpm certify:managed-agents:automated
```

`pnpm test` deliberately bundles the extension and webview once before package tests fan out. Package-level `pretest`
hooks must not independently rebuild the shared `src/dist` directory; doing so created a reproducible Windows WASM
copy race.

`certify:managed-agents:list` prints the exact focused commands without executing them. The strict command is the one
authoritative managed-agent deterministic release gate; there is no second hand-maintained focused-test list.
`certify:managed-agents:host-e2e` bundles the current tree and runs the dedicated scripted scenario in an isolated real
VS Code Extension Host and Git workspace. `certify:managed-agents:automated` runs both gates. Integration rows remain
`PENDING-INTEGRATION` until their full real-provider/reload/UI/multi-host evidence is attached.

## Stable backend contract

Adapters, Settings controls, persistence, and tests use these names and semantics:

| Field                      | Contract                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `maxConcurrentSubagents`   | Integer `1..16`, default `2`                                                                                |
| `subagentDelegationPolicy` | <code>"explicit-only" &#124; "proactive"</code>, default `"explicit-only"`; per-task policy may only narrow |
| `subagentMaxDepth`         | Integer `1..5`, default `1`                                                                                 |
| `subagentRoleTimeoutsMs`   | Partial `explore/review/worker`, each `10_000..3_600_000`; defaults `120_000/120_000/900_000`               |
| `subagentMaxInputTokens`   | Integer `1..10_000_000`, default `16_000`                                                                   |
| `subagentMaxOutputTokens`  | Integer `1..10_000_000`, default `4_000`                                                                    |
| `subagentRootTokenBudget`  | Integer `1..10_000_000` or `null`, default `null`                                                           |
| `subagentRootCostBudget`   | Positive finite number or `null`, default `null`                                                            |

Every child freezes `contextManifest.orchestration = { ancestry, delegationPolicy, limits }`. A legacy manifest that
omits it recovers with frozen legacy defaults, not current mutable Settings. Live/list projections expose `depth`,
`maxDepth`, `delegationPolicy`, `effectiveLimits`, and terminal `stopReason`.

Stop reasons cover timeout, input/output token limits, root token/cost budgets, depth/authority denial, ancestor
cancellation, orphan/recovery failure, cancellation, failure, and completion.

## Deterministic matrix

| Row                                    | Gate                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `CFG-CONTRACT-001`                     | Exact ExtensionState/updateSettings field names, ranges, and defaults       |
| `CFG-FROZEN-001`                       | Frozen orchestration manifest and legacy-default recovery                   |
| `PROJECTION-CONTRACT-001`              | Depth/effective-limit/stop-reason live and list projection                  |
| `CFG-POLICY-001`                       | Explicit-only/proactive behavior, narrowing, and reload persistence         |
| `CFG-TIMEOUT-001`                      | Role timeout configuration, reload, and exactly-once terminal outcome       |
| `CFG-BUDGET-001`                       | Output/token/cost enforcement and durable stop reason                       |
| `NEST-DEPTH-001`                       | Positive authorized nesting, maximum depth, and authority narrowing         |
| `NEST-CAPACITY-001`                    | Atomic root-wide capacity and exact slot release                            |
| `NEST-CANCEL-001`                      | Recursive cancel/interrupt/close and race idempotency                       |
| `ROUTING-MAILBOX-001`                  | Durable cursors, result claims, and managed-child parent-control waits      |
| `ROUTING-NESTED-001`                   | Immediate-parent routing, descendant authorization, and atomic claims       |
| `ROUTING-STEERING-RECEIPT-001`         | Durable steering acknowledgment and retained-follow-up recovery             |
| `ROUTING-PROGRESS-001`                 | Bounded immediate-parent progress routing and exact claim                   |
| `RECOVERY-BASE-001`                    | Registry, Worker orphan, and Apply-decision reload baseline                 |
| `RECOVERY-NESTED-001`                  | Nested topology/budget/mailbox rehydration and orphan cleanup               |
| `CONTEXT-INHERIT-001`                  | Frozen, credential-free, digest-checked `fork_turns` inheritance            |
| `NEST-COMPLETION-001`                  | Active/unowned descendants block managed-parent completion                  |
| `WORKER-GATE-001`                      | Quarantine, Apply, durable parent verification, and double completion check |
| `PROTOCOL-STRICT-001`                  | Strict native-provider/lifecycle parsing                                    |
| `WORKER-NESTED-001`                    | Explicit descendant Worker verification ownership                           |
| `UI-LIVE-TREE-001`                     | Compact nested task navigation, attention, overflow controls, and reload    |
| `UI-SETTINGS-BUFFER-001`               | Local cached edits survive unrelated extension/live-tree updates            |
| `UI-SETTINGS-DEBT-001`                 | No skipped/placeholder Settings change-detection assertions                 |
| `RUNTIME-LEGACY-DEBT-001`              | Selected legacy Task coverage has no skipped cases                          |
| `PROCESS-TREE-CLEANUP-001`             | Awaited Task/provider cleanup and real local OS process-tree removal        |
| `PERSISTENCE-COMPACT-GLOBAL-STATE-001` | Bounded root-only global-state compatibility history                        |

## Latest deterministic execution

| Track                                 |   Tests |
| ------------------------------------- | ------: |
| Managed-agent type/schema contracts   |      81 |
| Worker worktree isolation/recovery    |      13 |
| Runtime/store invariants              |     194 |
| Lifecycle and mailbox routing         |     220 |
| Awaited terminal/process-tree cleanup |      29 |
| Global-state history compatibility    |      23 |
| Worker completion gate                |      70 |
| Native provider protocol              |     130 |
| Compact task and transcript UI        |     182 |
| Settings buffering                    |      32 |
| **Total**                             | **974** |

The 974-test artifact attests only to the focused deterministic tracks above. Lint, typecheck, and the broader package
suite are separate canonical commands and must retain their own run logs; their result is not inferred from this
artifact. No skip or todo inside a strict managed-agent track is accepted.

## Expected integration-dependent rows

These are intentional pending rows in strict offline runs:

```text
INT-POLICY-PROVENANCE-001
INT-NESTED-RELOAD-001
INT-BUDGET-STOP-001
INT-WORKER-GATE-001
INT-LIVE-TREE-001
INT-PROCESS-CANCEL-001
INT-STORAGE-WRITERS-001
INT-GLOBAL-STATE-SIZE-001
```

The dedicated scripted Extension Host test proves nested spawn, nested Apply, root Apply/Discard, parent-owned command
verification, persisted orchestration settings, hierarchy projection, and exact task navigation in an isolated Git
workspace. It intentionally does not promote the rows below because it does not simulate real provider provenance and
usage, restart the extension host mid-run, inspect rendered pixels, or coordinate multiple extension-host writers.
Those rows remain pending until dedicated evidence proves:

- genuine human authorization versus generated, workspace-supplied, or replayed authorization;
- real extension-host reload with nested processes, immediate-parent mailbox ownership, and orphan cleanup;
- provider-backed timeout/output/root-token/root-cost stops with accurate final usage and one terminal outcome;
- nested and outer Worker Apply, blocked completion, parent-owned verification, and recovery across reload;
- live host/webview compact-row convergence, exact child navigation, sibling continuity, contextual actions,
  attention, transcript selection isolation, and Settings edit-buffer survival;
- termination of non-cooperative command/provider streams without leaked capacity; and
- multiple real extension-host writers without state corruption or duplicate mailbox claims; and
- bounded VS Code global-state serialization during managed-agent churn and multi-window reload.

## Run B prompt revision status

- `MANAGED_AGENT_RUN_B_V5` completed successfully on 2026-08-20 in root task
  `01a01d4f-a6a2-741d-abf2-5782bb201036`. The trace retained the exact completion markers, the prepared child recovered
  as terminal Cancelled with `stopReason: never_launched`, the child had no durable AgentControl record, and the final
  process/worktree/workspace checks were clean.
- `MANAGED_AGENT_RUN_B_V3` remains valid historical evidence superseded by the stricter V5 run.
- V4 exposed that an auto-selected follow-up suggestion could advance the reload checkpoint; it is invalid as
  acceptance evidence and did not approve or launch `approval_child`.
- V5 requires the exact human marker `CONTINUE_PRELAUNCH_RELOAD` and uses the sole non-advancing sentinel
  `I have not reloaded; remain at CHECKPOINT_PRELAUNCH_RELOAD.`

## Resolved release-gate blockers

- Settings inputs remain bound to local `cachedState`; hydration and import are edge-triggered, so background tree
  updates cannot erase unsaved edits.
- Former skipped Settings and selected legacy Task cases now execute with real assertions. The placeholder Settings
  assertion was removed.
- Managed-parent completion now has explicit coverage for active descendants and undelivered descendant results.
- Asynchronous terminal child results remain in the durable mailbox and lifecycle UI, enter model context only as
  native `wait_agent` tool results, and are acknowledged only after the matching API-history receipt is persisted.
- Root test orchestration no longer launches competing extension/webview bundles against the same output directory.
- The asynchronous ErrorBoundary test waits for `componentDidCatch` source-map/telemetry work, eliminating a
  concurrency-sensitive environment-teardown rejection.
- Formatting configuration now uses `.prettierignore` rather than the unsupported `ignore` option in
  `.prettierrc.json`.

## Release invariants

1. Preserve both `rootTaskId` and immediate `parentTaskId`/`parentPath`; never flatten descendants under root.
2. Route results, recovery events, waits, and upward progress to the owning immediate parent. Restrict downward
   messages and lifecycle-control targets to an authorized descendant subtree.
3. Reserve root-keyed capacity and task names atomically before asynchronous preparation.
4. Persist effective policy, ancestry, limits, deadlines, usage, and stop reason before launch. Reload must not read
   changed current Settings for an existing child.
5. Keep native `wait_agent` result claiming atomic and receipt-based. A lifecycle render must not consume a result;
   reload must ACK a claim with a persisted matching tool result and release a claim without one for exact retry.
6. Cascade cancel/interrupt/close through descendants with one terminal event and exact capacity release.
7. Block managed-parent completion while descendants are active or terminal results are unowned. Keep nested Worker
   verification owned by its immediate Worker parent and the outer proposal owned by root.
8. Build the compact task strip from durable registry identity, not transcript-card state. Background refreshes must
   not overwrite the selected task or local Settings buffer.

## Closure ledger

- Covered by the latest recorded deterministic gate: types, configuration, frozen policy/limits, nesting, capacity,
  budgets, lifecycle controls,
  mailbox ownership, recovery logic, Worker isolation and layered verification, managed-parent completion, compact
  task-strip projection/UI, Settings buffering, and strict certification. A fresh source-stable run is required after
  this or any later cleanup.
- Requires operator evidence: the eight real-host/provider/process/storage rows above.
- Intentionally deferred: `delegate_task` retirement and unrelated top-level same-workspace UX hardening. Compatibility
  removal must wait until live acceptance is green.
