# Managed-agent certification workflow

Run the current source tree through the commands below. The machine-readable requirements live in
[`managed-agent-milestone.matrix.json`](../../scripts/certification/managed-agent-milestone.matrix.json).
Results belong in generated, source-bound evidence rather than a maintained implementation-status summary.

The harness writes `artifacts/certification/managed-agent-milestone-evidence.json` with source hashes,
per-track execution receipts, test counts, row outcomes, and live-acceptance status. A source change requires
a fresh run. Use the [live acceptance playbook](managed-agent-live-acceptance.md) for host, provider,
process, reload, and shared-storage requirements.

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

Current agent Settings follow the Codex V2 public agent controls: enablement, root-wide thread count, default model
and reasoning effort, interruption messages, and custom agent definitions. See
[the lifecycle and compatibility contract](../subagent-lifecycle-hardening.md).

Generic execution deadlines, the separate research cutoff, per-agent token/cost limits, proactive-delegation preferences,
provider-profile routes and nesting-depth controls are retired. Old global preferences cannot restore them. Historical
manifests and stop reasons remain readable, while new manifests and live projections use null for retired ceilings.
Capacity, captured permission scopes, cancellation ownership and atomic persistence remain enforced.

## Deterministic matrix

| Row                                    | Gate                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CFG-CONTRACT-001`                     | Exact ExtensionState/updateSettings field names, ranges, and defaults                                      |
| `CFG-FROZEN-001`                       | Frozen orchestration manifest and legacy-default recovery                                                  |
| `PROJECTION-CONTRACT-001`              | Depth/effective-limit/stop-reason live and list projection                                                 |
| `CFG-POLICY-001`                       | Explicit authorization, inherited authority narrowing, retired-setting compatibility, and reload           |
| `CFG-TIMEOUT-001`                      | Wait timeout without child termination; explicit cancellation and reload                                   |
| `CFG-BUDGET-001`                       | Retired budget compatibility, continued work and durable historical stop reasons                           |
| `NEST-DEPTH-001`                       | Authorized nesting without a separate depth ceiling, with authority narrowing                              |
| `NEST-CAPACITY-001`                    | Atomic root-wide capacity and exact slot release                                                           |
| `NEST-CANCEL-001`                      | Recursive cancel/interrupt/close and race idempotency                                                      |
| `ROUTING-MAILBOX-001`                  | Durable cursors, result claims, and managed-child passive parent-mail wakes                                |
| `ROUTING-NESTED-001`                   | Immediate-parent routing, descendant authorization, and atomic claims                                      |
| `ROUTING-STEERING-RECEIPT-001`         | Durable agent-message acknowledgment, human approval isolation, and retained-follow-up recovery            |
| `ROUTING-PROGRESS-001`                 | Bounded immediate-parent progress routing and exact claim                                                  |
| `RECOVERY-BASE-001`                    | Registry, Worker orphan, and Apply-decision reload baseline                                                |
| `RECOVERY-NESTED-001`                  | Nested topology/usage/mailbox rehydration and orphan cleanup                                               |
| `CONTEXT-INHERIT-001`                  | Frozen, credential-free, digest-checked `fork_turns` inheritance                                           |
| `NEST-COMPLETION-001`                  | Active/unowned descendants block managed-parent completion                                                 |
| `WORKER-GATE-001`                      | Approved-effect integration, recoverable Worker review, durable parent verification, and single completion |
| `PROTOCOL-STRICT-001`                  | Strict native-provider/lifecycle parsing                                                                   |
| `WORKER-NESTED-001`                    | Explicit descendant Worker verification ownership                                                          |
| `UI-LIVE-TREE-001`                     | Compact nested task navigation, attention, overflow controls, and reload                                   |
| `UI-SETTINGS-BUFFER-001`               | Local cached edits survive unrelated extension/live-tree updates                                           |
| `UI-SETTINGS-DEBT-001`                 | No skipped/placeholder Settings change-detection assertions                                                |
| `RUNTIME-LEGACY-DEBT-001`              | Selected legacy Task coverage has no skipped cases                                                         |
| `PROCESS-TREE-CLEANUP-001`             | Awaited Task/provider cleanup and real local OS process-tree removal                                       |
| `PERSISTENCE-COMPACT-GLOBAL-STATE-001` | Bounded root-only global-state compatibility history                                                       |

## Expected integration-dependent rows

These requirements need their specified host, provider, process, UI, or shared-storage evidence.
An offline or scripted result establishes only the boundaries it actually exercises.

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

## Release invariants

1. Preserve both `rootTaskId` and immediate `parentTaskId`/`parentPath`; never flatten descendants under root.
2. Route results, recovery events, waits, and upward progress to the owning immediate parent. Restrict downward
   messages and lifecycle-control targets to an authorized descendant subtree.
3. Reserve root-keyed capacity and task names atomically before asynchronous preparation.
4. Persist effective policy, ancestry, supported limits, usage, and stop reason before launch. Reload must not read
   changed current Settings for an existing child.
5. Keep native `wait_agent` result claiming atomic and receipt-based. A lifecycle render must not consume a result;
   reload must ACK a claim with a persisted matching tool result and release a claim without one for exact retry.
6. Cascade cancel/interrupt/close through descendants with one terminal event and exact capacity release.
7. Block managed-parent completion while descendants are active or terminal results are unowned. Keep nested Worker
   verification owned by its immediate Worker parent and the outer proposal owned by root.
8. Build the compact task strip from durable registry identity, not transcript-card state. Background refreshes must
   not overwrite the selected task or local Settings buffer.
