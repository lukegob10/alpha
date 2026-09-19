# Harness follow-up audit

Mode: follow-up audit, 2026-09-18. Scope is the changed harness surface and its direct callers, not a repository-wide
rewrite. The target is trustworthy local execution, evidence and comparisons, with Docker-free corporate use.
Existing successful results are reused unless a new edit affects them.

## Fixed now

| Severity           | Finding and resolution                                                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High, must-fix     | The command wrapper did not propagate cancellation or await process-tree cleanup. It now delegates to the existing host process owner, records cancellation, stops later steps and retains the build lease when cleanup is unverified. A failing regression reproduced the missing signal before the fix. |
| High, must-fix     | Build identity omitted packaged runtime dependencies. It now includes the executed `src/dist` tree; mutation of the bundled ripgrep executable is a regression case.                                                                                                                                      |
| High, must-fix     | Comparison observations could claim matching policy fields inconsistent with their variant manifests. Admission now binds observed fields to the declared variant.                                                                                                                                        |
| Medium, should-fix | Missing/unknown host failure classifications could enter a comparison, and export failure could obscure the execution error. Both now retain explicit failure evidence.                                                                                                                                   |
| High, must-fix     | Diagnostic projections could imply stable joins without the required identity. Closed projections, source-change handling and stable identity joins now fail closed; private replay remains separate.                                                                                                     |
| High, must-fix     | Docker-independent Redis contracts were coupled to container cleanup. Native service contracts and read-only readiness now have separate commands; Docker infrastructure remains explicit optional coverage.                                                                                              |

The evaluator audit also reviews source-reset safety, argument-safe native host launch and database reset boundaries;
see [Docker-free evaluator details](harness-docker-free.md) and [experiment audit](harness-implementation-experiments.md).
Two failing regressions also exposed missing cleanup around legacy local-host launch and IPC failures. The adapter
now observes early process rejection, preserves the primary failure and closes its owned client, process and logger
on every exit. A cleanup timeout remains a failure after a force-kill request; it is not reported as verified cleanup.
Six focused cleanup tests passed, alongside evaluator lint and type checks.

## Reviewed and validation

Reviewed command/CI entrypoints, ownership and cleanup, report statuses, bounded/private diagnosis, campaign source/build
identity, statistics/admission, grader controls, native service requirements and all eight integration acceptance rows.
New code continues to use existing process, host, grading and persistence owners. No new agent runtime, database
replacement, grader engine or security sandbox was introduced.

The wrapper regressions pass (9 tests), and the owned-process tests pass on Windows (10 passed, 2 POSIX-specific skips),
including real descendant termination with inherited terminal output. The playbook Windows preflight passed. Further
affected-surface results are appended after final validation.

The follow-up static lane passed lint and type checks. The tooling lane passed 110 root tooling tests and 385
host-runner tests (two POSIX-specific skips). The offline lane passed 256 evaluator unit tests, 19 contract tests and
five certification tests. An additional bounded-readiness timeout regression passed with its four-test focused suite.

The generic stale-script helper was stopped after excessive whole-tree scan time. References for the changed scripts
were audited directly against manifests, CI and docs; no repository-wide stale-code conclusion is claimed.

## Closure ledger

- **Fixed now:** concrete defects above; default corporate checks and host comparisons do not depend on Docker.
- **Flagged for follow-up:** the eight precise integration requirements in the [acceptance ledger](harness-acceptance-status.md),
  including absent churn/reload instrumentation, human UI checkpoints and real-provider usage evidence.
- **Not verified:** native/shared PostgreSQL and Redis service success (not available here), corporate Artifactory
  authentication, paid-provider comparisons, POSIX-specific process termination on this Windows host.
- **Out of scope:** rewriting persistence, declaring local processes a sandbox, installing unapproved corporate services,
  merging, publishing or deploying. No live-model quality/speed improvement is inferred from deterministic checks.

The inspected default/user registry configuration showed public npm and no corporate endpoint, and there were no listeners on the configured
test ports 5433/6380. Readiness and test reset authority are separate: a reachable database is not permission to truncate
it. The optional persistent-evaluator service arrangement was asked as an explicit corporate decision; independent
Docker-free work continued.

## Additional actual-host evidence

The exact VS Code 1.122.1 smoke gate passed after the review fixes (10 tests, complete capture/retention).
Existing shared-storage and storage-recovery campaigns also ran, with zero live-provider requests:

- Two real extension hosts: identities verified, two ready and two done receipts, complete capture and verified cleanup.
- Fault/healthy restart: both phases passed and the offline storage preservation snapshot was unchanged.

Receipts are indexed in `artifacts/harness/storage-review-result.json`; the private log is
`artifacts/harness/storage-review.log`. These close missing execution evidence for those existing experiments, not
the larger mailbox/nested-reload/global-state-size contracts. The acceptance ledger distinguishes those requirements.

A subsequent shared-host run, `c98eeb46-32f3-4335-9fd7-92274735ac3c`, additionally passed the mailbox claim race:
exactly one winner before the acknowledgment barrier, no redelivery in either host, and one durable acknowledged
event matching the winning claim. Its report records `mailboxClaimsVerified: true`, matching bundle hashes,
complete capture and verified cleanup/lease release. This is real-host mailbox evidence; it does not change the
historical deterministic certification artifact or claim the separate nested-child reload requirements.

The final `taskHistory` probe passed in the two-phase VS Code 1.122.1 recovery run indexed by
`artifacts/harness/mirror-review-result.json`. The fault phase measured 2 -> 423 bytes; the reopened healthy phase
measured 423 -> 875 bytes, with a 196,608-byte compatibility budget. Both phases retained valid receipts and the
offline task-file preservation check passed. Nine receipt/probe tests, E2E lint and E2E type checks passed. This is
a small actual-memento restart measurement, not managed-agent churn, multi-window size coverage or a budget for the
whole VS Code memento.

The read-only native-service check ran and failed cleanly because the configured local endpoints were unavailable;
no database reset, migration or provider request occurred. Its sanitized log is
`artifacts/harness/native-services-readiness.log`. A [bounded live plan](harness-live-validation-plan.md) was validated
with dry runs only; it records the request/time caps and the absence of a monetary cap before any spending decision.
