# Managed-agent live acceptance

Use this runbook for the real provider, rendered webview, OS-process, reload, and shared-storage boundaries listed in
[the certification matrix](../../scripts/certification/managed-agent-milestone.matrix.json). The
[lifecycle contract](../subagent-lifecycle-hardening.md) describes current settings, authority, lifetime, and Worker
integration. The matrix owns requirement IDs and evidence scope.

## Run reproducible prerequisites

Build and test one fixed source tree. Run these commands serially from the repository root with the pinned toolchain:

```sh
pnpm certify:managed-agents:self-check
pnpm certify:managed-agents:list
pnpm certify:managed-agents:automated
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
```

`certify:managed-agents:list` prints the current focused selection. The automated gate runs deterministic checks and
scripted real-host scenarios. It does not consume live-provider requests or establish all supplemental integration
requirements. Changes to host adapters or the installation minimum also require:

```sh
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

The existing runner exposes focused scripted checks for cancellation and retired-limit compatibility after the gate
has built the extension, webview, and runner:

```sh
node apps/vscode-e2e/out/runTest.js --vscode-version 1.138.0 --provider scripted --require-all-tests --file managed-agents.cancellation.acceptance.test
node apps/vscode-e2e/out/runTest.js --vscode-version 1.138.0 --provider scripted --require-all-tests --file managed-agents.budget.acceptance.test
```

The compatibility fixture requires work to continue after a wait timeout and after loading retired child-limit settings.
It then requires explicit cancellation to stop the owned work. A wait deadline does not terminate an agent. Ordinary
provider failures and individual tool deadlines remain separate boundaries.

## Prepare supplemental live observations

1. Use a disposable workspace and a dedicated, signed-in exact VS Code **1.138.0** profile prepared with the
   [profile guide](../vscode-live-test-profiles.md). Record the actual host, extension version, commit, built artifact,
   model ID, effort, request pacing, approval policy, command allowlist/denials, and initial workspace status.
2. Declare a bounded task, allowed workspace effects, request/time/spend ceilings, and required observations before
   starting. Use separate root tasks for independent scenarios. Keep the build and captured policy fixed for each run.
3. Authorize the exact delegation required by the scenario in the human task request. Inspect the current advertised
   tool catalog rather than copying historical prompts. Role or model selection cannot widen captured authority.
4. Use retained task IDs and canonical paths for every checkpoint. Record root and immediate-parent identities,
   timestamps, mailbox/result ownership, and known process IDs. Preserve original failures and retries separately.
5. At user checkpoints, perform the actual UI action and record only observations. A conversational acknowledgment,
   suggested reply, completion suffix, or green counter is not evidence of cancellation, reload, integration, or a UI state.

The runner never copies credentials or adopts a normal editor profile. A stale preflight or model catalog proves no
current live-provider readiness. Stop on authentication, provider admission, uncertain process ownership, or storage
lease failures before launching another attempt.

## Observe the required boundaries

For each row, retain `PASS`, `FAIL`, or `INCONCLUSIVE` with the evidence that establishes its predicate. Missing evidence
remains inconclusive or failed according to the matrix; it cannot be filled from another scenario's success.

| Boundary                   | Required observation                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization provenance   | A directly authorized child starts with inherited scope; quoted workspace instructions, generated text, and agent messages cannot supply human authorization or approval, including after reload.                                                                                         |
| Capacity and messaging     | An occupied root-wide slot rejects excess admission for capacity; passive messages preserve recipient identity and do not answer human approval or start a stopped turn. Authorized follow-up uses the retained identity and releases capacity exactly once.                              |
| Wait and lifetime          | Wait expiry returns control while the child remains active. Retired execution, token, cost, research, and nesting settings cannot recreate generic agent lifetime ceilings.                                                                                                               |
| Nested reload              | Record the real root/child/grandchild topology before reload. Reopen the same root and prove retained identities, immediate-parent routing, terminal ownership, and orphan-process cleanup. Do not spawn a replacement to hide missing recovery.                                          |
| Worker integration         | A successful completed Worker integrates already-approved in-scope effects before terminal publication. Concurrent edits, reduced authority, partial work, and recoverable proposals retain the appropriate review path. Verify actual file contents and parent settlement across reload. |
| Rendered tree and Settings | Open the exact child and return to its immediate parent without changing sibling selection. Observe compact status/attention/overflow controls. An unsaved local Settings edit survives unrelated tree updates and is discarded or saved only through the explicit form action.           |
| Cancellation and processes | Once stream/process readiness and exact ownership are recorded, use the real host Stop control. Require provider termination, every recorded descendant process gone, one terminal result, and released capacity. A cancellation request alone is insufficient.                           |
| Shared writers             | Two owned hosts sharing test storage preserve valid registry/mailbox state, distinct root identities, exact result claims, and independent cancellation/reload.                                                                                                                           |
| Global-state size          | Capture actual serialized compatibility-state bytes before and after churn/reload, then compare with the configured budget. Helper tests and lifecycle success cannot substitute for this measurement.                                                                                    |

Successful Worker effects follow the shared mutation and original-content checks. A process receipt establishes process
execution, while fixture assertions or independent workspace inspection establish file correctness. Keep those claims
separate. Parent completion requires all descendant effects and results to be settled under their actual owner.

## Scripted restart and shared-storage campaigns

The existing campaign controller owns repeatable nested restart and concurrent-storage experiments. After the build,
use a different new absolute fixture root for each command, outside the repository and personal editor data:

```sh
pnpm --filter @alpha-code/vscode-e2e test:campaign --nested-restart-root <new-absolute-fixture-root> --vscode-version 1.138.0 --vscode-executable <absolute-1.138.0-Code-executable>
pnpm --filter @alpha-code/vscode-e2e test:campaign --shared-storage-root <different-new-absolute-fixture-root> --vscode-version 1.138.0 --vscode-executable <absolute-1.138.0-Code-executable>
```

These run scripted providers and retain their own ownership, restart, process, and storage receipts. They can establish
only their selected scripted boundaries. Real-provider and rendered-UI requirements remain separate when specified by
the matrix. Read the complete terminal campaign report and cleanup receipts before beginning another phase.

## Evidence and cleanup

Keep source/build identity, host/model/effort, launch conditions, task hierarchy, original failures, actual usage, and
bounded structural projections with each run. Raw prompts, credentials, and provider bodies do not belong in maintained
runbooks or sanitized comparison reports. Generated evidence stays with its existing owner as described in the
[evidence runbook](../harness-evidence.md).

Measure application lifecycle latency separately from provider/model selection, configured pacing, and retry time.
Predeclare any performance threshold and workload; a successful single run is not a speed or quality improvement.

Before cleanup, confirm all recorded descendants and processes are terminal, settle or retain every Worker proposal
according to its current approval/conflict state, and restore changed settings. Remove only the verified owned fixture
paths after evidence review. Preserve unrelated workspace changes, uncertain ownership records, authentication profiles,
and unresolved failures. No row passes merely because a final response says it passed.
