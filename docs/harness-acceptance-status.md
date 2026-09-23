# Managed-agent acceptance status

Updated 2026-09-18/19 against the [certification matrix](../scripts/certification/managed-agent-milestone.matrix.json)
and [operator procedure](certification/managed-agent-live-acceptance.md). New local experiments are described in
[local acceptance engineering](harness-local-acceptance.md) and [rendered UI evidence](harness-ui-acceptance.md).

The final `pnpm harness run confidence` passed under
`artifacts/core-confidence/core-20260919005623665-0742d164`: runner units (427 passed, two platform skips), exact
VS Code 1.122.1 smoke and core regressions, actual-host core loop, completion idle and managed-agent acceptance,
and strict certification (2,000 tests and 26 deterministic rows passed). Captures and owned-host exits were verified,
packaged artifacts stayed unchanged, and the shared build lease was released. No live-provider requests were made.

Strict certification still records eight `PENDING-INTEGRATION` rows and `liveAcceptance: NOT_RUN`. The historical
1,997-test artifact remains unchanged. The additional evidence below must be read on its own terms: actual
VS Code 1.122.1 hosts and rendered controls, with local scripted model decisions. It does not retroactively certify
human authorization or provider billing.

| Boundary                    | Current evidence                                                                                                                                                                          | Remaining boundary                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `INT-POLICY-PROVENANCE-001` | Policy/protocol/reload unit coverage and strict deterministic certification passed.                                                                                                       | Factual human authorization and negative generated/workspace/replayed authorization at the real conversation boundary.                      |
| `INT-NESTED-RELOAD-001`     | Actual nested Worker write, capacity denial, abrupt host exit, same-profile reload, immediate-parent unique results, proposal recovery/discard, orphan cleanup and capacity reuse passed. | Human/operator certification procedure remains distinct from this executable host experiment.                                               |
| `INT-BUDGET-STOP-001`       | Actual-host role timeout, child output limit and root token exhaustion passed with synthetic usage and exact cancellation/result assertions.                                              | Selected live provider/profile and authorized budget; actual billed cost for monetary-limit evidence.                                       |
| `INT-WORKER-GATE-001`       | Earlier rendered nested/outer Apply and Discard confirmations passed; canonical proposal and filesystem effects were verified.                                                            | Re-run the operator procedure for the approval-aware contract: Ask review, Auto/Full Access automatic application, and factual checkpoints. |
| `INT-LIVE-TREE-001`         | Actual rendered nested/root/sibling navigation, overflow actions, running-sibling continuity and buffered Settings refresh/discard passed.                                                | Automated interaction does not substitute for a human accessibility or provenance report.                                                   |
| `INT-PROCESS-CANCEL-001`    | API cancellation and orderly window termination both passed with external HTTP observation and real command/grandchild PIDs; recovery released capacity without orphans.                  | Genuine provider transport behavior remains provider-specific supplemental evidence.                                                        |
| `INT-STORAGE-WRITERS-001`   | Two real hosts passed the control-event race and the actual Worker interruption/follow-up/result ACK flow, including foreign-root ownership denial and sibling continuity.                | This proves task interruption; it does not claim that one window was reloaded while its peer continued.                                     |
| `INT-GLOBAL-STATE-SIZE-001` | Both two-window churn phases passed: 128 workload tasks, same-profile reload, and a 190,044-byte maximum mirror against the 196,608-byte cap.                                             | The corrected bounded writer assembled the verified phases offline; the original wrapper publication failure remains retained.              |

## Retained passing indexes

- `artifacts/harness/nested-review-result.json`: nested crash/recovery, retained under `alpha-nested-restart-sik0aG`.
  The deliberate prepare crash stays failed with exit 73; the separate recovery experiment passed.
- `artifacts/harness/cancellation-review-result.json`: task cancellation, retained under
  `alpha-cancellation-review-lmQKei`; extension-host PID 45544.
- `artifacts/harness/termination-review-result.json`: orderly host termination and recovery, retained under
  `alpha-termination-review-dQim5U`; extension-host PIDs 18304 and 62952. Includes the production closed-output-channel
  regression and its fix; see the local acceptance document for failed-run context.
- `artifacts/harness/budgets-review-result.json`: synthetic timeout/token enforcement, retained under
  `alpha-budgets-review-FMWFux`; extension-host PID 31524. No billed cost claim.
- `artifacts/harness/rendered-ui-probe/ui-probe-9c279299-9c11-4dd6-ba2c-90db2d9b3eef.json`: 12 actual UI stages,
  18 screenshots, verified backend effects and complete owned-host shutdown.
- `artifacts/harness/storage-closure-result.json`: shared-storage control-event claim race,
  run `c98eeb46-32f3-4335-9fd7-92274735ac3c`, with one winning claim/ACK and no redelivery.
- `artifacts/harness/mirror-review-result.json`: small same-profile restart mirror measurements.
- `artifacts/harness/churn-derived-final/task-history-churn-report.json`: verified populate/reload phase reports,
  260 scripted requests; `provenance.json` records offline assembly and the unchanged failed wrapper receipt.
- `artifacts/harness/workers-review-result.json`: actual Worker protocol run under
  `C:\Temp\alpha-workers-review-wuM0De`, seven scripted requests, complete capture and verified cleanup.

Raw task/storage evidence stays in owned retained fixture directories. Public summaries contain bounded projections,
identity/capture/shutdown receipts and measurements. Failed experiments are retained; no failed run is relabeled as
passed because a later corrected fixture succeeds.

## External prerequisites

No paid-provider calls were made. A live campaign requires a selected provider/profile and explicitly authorized
usage; actual cost evidence requires a provider that reports billed cost. Human authorization cannot be invented by
an automated fixture.

The corporate workflow is Docker-free. Host campaigns, local graders and paired reports do not need services.
Persistent evaluator checks still require dedicated configured PostgreSQL/Redis resources: local test ports were
not listening and no native service was found. No services were installed. The setup used the public npm registry;
corporate Artifactory authentication remains unverified. These are separate from the executable host experiments.
