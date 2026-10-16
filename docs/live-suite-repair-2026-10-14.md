# Live suite investigation, repairs, and acceptance — October 14–15, 2026

**Live execution is working. The complete frozen matrix recorded 46 passed and nine failed test executions; the final affected live batch passed all eight tests.** Common validation and the rebuilt exact-host gate pass. Earlier failures, source epochs and remaining quality findings are preserved. UTC timestamps and America/New_York dates are recorded separately.

The original run recorded **43 failed and 7 passed test executions**. Its [native evidence](F:/alpha-e2e/full-live-20261014-01c26a9d) and [findings report](F:/roo-fork/Alpha-Code/docs/live-suite-findings-2026-10-14.md) retain the original results. Classification identified 23 bundled Copilot observer errors, eight command-fixture policy conflicts, five provider-configuration failures, five assertion defects, and two session/browser findings. These were not 43 independent product defects.

## Completed frozen matrix

The [full acceptance matrix](F:/alpha-e2e/live-repair-acceptance-20261014-214800/matrix-final-summary.json) completed **34 selections: 29 passed, 5 failed**. Its **39 native host launches** recorded **55 test executions: 46 passed, 9 failed, 0 pending**; driver exit was 1. Reproductions and the two-host reload explain the differing denominators. All 34 rows are embedded below so these results remain readable without external artifacts.

Conditions: exact VS Code **1.125.0**, product commit `93cfdd489c3b228840d0f86ec77c3636277c93ea`; Copilot **gpt-6-luna / max**; Node **24.21.0**, pnpm **11.24.0**; signed-in Alpha profile `F:/alpha-e2e/profiles/1.125.0`. The base commit was `e628bf82ba2ca3ec29c6a2ac226d5d6327306e87`, with hashed uncommitted repairs. This is a working-tree result, not a release.

The [independent audit](F:/alpha-e2e/live-repair-acceptance-20261014-214800/independent-workflow-reviews/final-native-epoch-audit.md) reconciled all counts. Every host matched version/model/effort, run identity, verified PID ownership, observed numeric exit, complete capture, and completed readiness. All nine failed executions retained E2E-suite provenance. It parsed 906 native JSON files, verified 327 manifest artifact hashes, and rechecked 990 stored input hashes unchanged.

All 40 frozen TypeScript files remained unchanged. Of 22 workflow campaigns, 21 retain `evaluationIdentity.unchanged: true` and `missing: []`. **Long-context recovery passed its scenario but retains `unchanged: false` / `identity_changed_during_campaign`.** Another user-owned chat added `docs/speech-to-text-investigation-2026-10-14.md` during that campaign. The [drift proof](F:/alpha-e2e/live-repair-acceptance-20261014-214800/independent-workflow-reviews/native-epoch-document-drift-proof.json) reconstructs both whole-tree digests by omitting only that document in memory. Runtime build, compiled harness, task set, source components, and commit match. The document and native flag remain preserved; the fresh affected follow-up below passed long-context recovery with independently verified stable raw fingerprints.

## Nine repairs included before that matrix

1. **Copilot/Git host isolation.** Fixture launches disable `vscode.git` and record `fixtureIsolation` in `launch.json`, while workflows execute real Git. This avoids the bundled branch-observer crash without modifying vendor extensions or swallowing uncaught errors. Native SCM/API integration is outside this isolated matrix.
2. **Fixture configuration and commands.** Legacy task/Markdown cases preserve the selected provider and restore configuration/listeners after failure. Eight opaque inline commands became inspectable prepared scripts. The independent read-evidence verifier retains BOM, CRLF, and unrelated-byte checks. Command policy remains enforced.
3. **Observable assertions.** Visible answers exclude reasoning/tool payloads; automatically answered approval rows differ from pending human review. Repair acceptance requires exact checker calls and process exits. Session evidence requires a real handle, HTTP success, same-session polling, shutdown markers, and final exit zero. Source strings cannot establish executed behavior.
4. **Command output ownership.** Environment prompt capture no longer drains `write_stdin` output, including output awaiting a final poll after process exit. Task disposal releases owned sessions. If feedback-image processing fails before initial result publication, only the unpublished session is released; published and other-task sessions keep their ownership.
5. **Integrated browser.** The adapter honors an explicit optional host `hasError` after cancellation checks. The fixture closes owned editors so tokenless browser tools become visible. **The original `Count1` appeared in an `onclick` HTML source attribute, not an observed post-click snapshot; it did not prove a click succeeded.** Repaired evidence requires a real click and separate same-page snapshot. Some host Playwright failures remain unmarked text; arbitrary page content is not classified by error-like wording.
6. **Evidence integrity.** Sidecar preparation precedes campaign fingerprinting. Workflow JSON is written/flushed to a unique temporary file and published without replacing an existing artifact, preventing incomplete canonical receipts.
7. **Newly reached legacy probes.** Task completion verifies an exact requested marker instead of an incidental persona name. Markdown prompts explicitly request chat output with tools disabled. Anchored markers, horizontal indentation, and both nested children reject inline punctuation and blank-line pseudo-nesting. These remain source-output checks, not rendered webview coverage.
8. **Streaming Git-read admission.** Early admission and isolated execution share readiness inspection. Reads unavailable because of ignore rules or unsupported Git capabilities wait for ordinary approved execution after EOF instead of becoming denied results. Late prerequisite loss still fails closed. Ignore protections and policy were not relaxed.
9. **Captured process environment.** Execa launches use `extendEnv: false`, preventing environment additions after preparation from entering the child. An installed-Execa Node child reproduced the inheritance defect and verified the fix. This machine's Git 2.43 lacks `--no-lazy-fetch`; the process-boundary proof does not certify isolated Git on that installation.

Repairs used [Codex reference commit 4ca84a10](https://github.com/openai/codex/tree/4ca84a10696623fcd7c200db3df9c41671d3bad0) and [VS Code product commit 93cfdd48](https://github.com/microsoft/vscode/tree/93cfdd489c3b228840d0f86ec77c3636277c93ea), retrieved October 14, 2026. Alpha retains its native TypeScript architecture, workspace/ignore protections, approval boundaries, and security policy.

## Five failure groups remain recorded

- **Bootstrap — two failures:** the first attempt recovered from three malformed workdirs and completed tests/commit, but failed the strict unexpected-error check. Reproduction tested/staged the implementation but omitted the required commit after a benign line-ending warning. Different fingerprints remain `unreproduced`.
- **Refactor — two failures:** the first recovered from two malformed workdirs and completed tests/commit. Reproduction supplied an outside-workspace Add File path; Alpha required review, the fixture cancelled, and no patch applied. Native `policy/unexpected_write_approval` is not a host-crash diagnosis.
- **Selective commit — two failures:** both eventually completed the intended implementation/tests/commit and preserved unrelated work; preceding malformed-directory errors remain failures.
- **Search recovery — two failures:** malformed explicit Git-status workdirs caused realpath ENOENT. One attempt corrected its path. Correct final reports do not erase earlier errors. Current and stricter candidate oracles agree on the actual reports.
- **Skill composition — one failure:** both skills loaded, but the verifier required `apply_patch` without stating it. Execution reached an unanswered inline-write review. That fixture contract is repaired below; its historical failure remains.

[Scoped classifications](F:/alpha-e2e/live-repair-acceptance-20261014-214800/post-freeze-findings.md) retain the evidence. Earlier context contained the correct root; malformed prefixes first appeared in assistant arguments. Full system wire prompts were not retained, so this is not a complete wire-prompt audit. Ordinary task Git commands inherited system `core.autocrlf=true`, unlike fixture verification's pinned setting; benign warnings did not establish corruption. Bootstrap/refactor/selective-commit remain live task-quality findings.

## Four repairs integrated after the matrix

These changes create a new epoch and do not rescore the 55 records:

1. **Skill fixture:** states the asserted patch method and supplies bounded prepared reads, preserving approval policy.
2. **Recovery finality v2:** requires matching canonical final UI/assistant evidence and a completed phase; earlier commentary cannot satisfy a contradictory final answer. Transcript/UI/lifecycle bounds exclude later phases. Two negative controls now provide legitimate completion evidence while retaining their exact bad-Git-status expectations.
3. **Session publication v2:** required session framing survives result publication, including zero requested stdout and valid feedback images. If framing cannot fit, launch is rejected before effects. Actual scheduler regressions cover lost-handle cases.
4. **SD-04 proactive recovery:** failed early compaction may continue only when measured retained input fits the safe limit; rebuilt final input is checked again. Forced/oversized recovery, malformed counts, cancellation, and error reporting remain enforced. SD-06 displayed-cost accounting is excluded.

## Validation of the integrated epoch

The latest [55-file source freeze](F:/alpha-e2e/live-repair-acceptance-20261014-214800/post-integration/cleanup-fixture-validation/source-freeze.json) was captured **04:09:21 UTC** and verified unchanged at **04:23:04 UTC**.

- Root typecheck and lint: **exit 0**.
- Root `pnpm test --concurrency=1 -- --maxWorkers=2`: **exit 0**, eight Turbo tasks, five cached. [Native package summaries](F:/alpha-e2e/live-repair-acceptance-20261014-214800/post-integration/cleanup-fixture-validation/unit-summary.json): src **12,482 passed / 32 skipped**; core **187 passed**; webview **2,280 passed / 2 skipped**; types **558**, IPC **28**, build **7**, telemetry **7** passed. Cached results and overlapping focused runs are not added into a new combined denominator.
- Full runner: **661 passed / 2 platform skips**. Focused command/session **219**, fixture **50**, workflow-driver **24**, SD-04 context/Task **119**, expanded context **174** passed; these overlap.
- Rebuilt exact-host gate: **42 tests across 13 suites passed**, actual **1.125.0**, exit **0**. [Strict audit](F:/alpha-e2e/live-repair-acceptance-20261014-214800/post-integration/cleanup-fixture-validation/exact-host-audit.json) found no errors; ownership, capture, observed exit, and eligible retention checks passed. Native results/command/log are retained alongside it. This used fresh disposable scripted/LM-fixture profiles, separately from the signed-in live profile.

Earlier red runs remain retained. Three original core tests exceeded unchanged 30-second limits during concurrent validation; their **33-test isolated run** and later **187-test package run** passed. Contention is plausible, not a proven lock-owner diagnosis. The first post-SD-04 src run recorded **12,480 pass / 2 fail / 32 skip**: two old fixtures demanded truncation even though measured input fit. Only those fixtures changed to genuinely over-limit removable middle history; truncation/metadata assertions were retained and strengthened. An intermediate fixture charged a preserved first step and correctly exhausted. Expanded coverage passed **174/174** and independent review found no assertion weakening.

The next src run recorded **12,481 pass / 1 cleanup failure / 32 skip**, with EBUSY in incidental checkpoint Git initialization. The owning **23 tests** passed, and the fixture now explicitly disables checkpoints outside its intended surface. Production checkpoint behavior and assertions were unchanged. Whether production termination should join the initializer's actual unwind remains a **separate open inference requiring deterministic proof**, not an established user-data defect. [Timeout review](F:/alpha-e2e/live-repair-acceptance-20261014-214800/post-integration/core-timeout-review/review.md) and [cleanup review](F:/alpha-e2e/live-repair-acceptance-20261014-214800/post-integration/post-eof-cleanup-review/review.md) preserve failed logs and limits. The final common run above passed after these scoped corrections.

## Fresh affected live follow-up

**Five selections passed; all eight native tests passed, zero failed or pending; driver exit 0.** The [fresh batch](F:/alpha-e2e/live-followup-20261015042325-63a0bf54-8896-477a-88bb-988d85d85026/final-followup-summary.json) ran on October 15, 2026, **00:23:31–00:35:22 America/New_York / 04:23:31–04:35:22 UTC**, using the exact host, model, effort and signed-in profile above. Each workflow had one attempt, fresh run/workspace IDs and no automatic reproduction. This is affected-surface validation after the four repairs, separate from the complete 34-selection matrix.

| Selection                                                 | Native passed / failed / pending |                   Guarded requests |
| --------------------------------------------------------- | -------------------------------: | ---------------------------------: |
| Harness quality: repair, command session, browser, skills |                        4 / 0 / 0 | 11 / 4 / 8 / 13, each capped at 24 |
| Git inspection                                            |                        1 / 0 / 0 |                           14 of 80 |
| Search recovery                                           |                        1 / 0 / 0 |                           10 of 80 |
| Unavailable verification                                  |                        1 / 0 / 0 |                            8 of 60 |
| Long-context recovery                                     |                        1 / 0 / 0 |                           48 of 80 |

The [independent native audit](F:/alpha-e2e/live-repair-acceptance-20261014-214800/post-integration/fresh-audit-20261015043737-e3c3d776.md) passed **307 evidence checks**, verified **41/41 exported artifact hashes**, and rechecked the original inputs unchanged. Actual host/model/effort, native completion, process ownership, numeric exits, capture and retention all matched. Each harness task completed exactly once. The owned profile lease was released after every selection and was absent at audit completion.

Raw whole-tree source, runtime and compiled-runner fingerprints matched before/after every selection and were independently recomputed after the batch, before repository report edits. Direct runTest workflow receipts do not emit campaign evaluationIdentity; this fresh raw-fingerprint proof is recorded separately. The original long-context campaign's document-drift flag remains intact. Its historical result is not rescored.

Fresh workflow guards record **80 dispatch attempts: 61 task + 19 reasoning-summary**. The four harness case guards record **36** requests in their separate scope. **Five readiness requests** are separate again. These measurements are not a global provider/network-call or billing total. The [driver command receipt](F:/alpha-e2e/live-repair-acceptance-20261014-214800/final-followup-driver.command.json) and the audit JSON linked by its Markdown report preserve the final identity and counts. Report edits belong to the subsequent documentation phase.

## Accounting and remaining coverage

The frozen workflow hosts used **429 budgeted VS Code LM dispatch attempts: 310 task-handler + 119 reasoning-summary**; **39 readiness requests are separate**. These are not all standalone traffic, solving rounds, successful responses, or backend HTTP requests. Workflow manifests contain 33 captures covering 32 distinct task IDs, including reload epochs.

[Fault methodology](F:/alpha-e2e/live-repair-acceptance-20261014-214800/independent-workflow-reviews/live-provider-injection-methodology-2026-10-15.md) distinguishes injected recovery from natural provider failures. Faults suppress/interrupt genuine response streams; workflow recovery can approve a retry ask. Standalone empty recovery requires automatic retry without Continue. Long-context empty-exhaustion exercised two injected empty responses, an explicit follow-up, compaction/reopen, and graded repair; it did not exhaust the overall request cap. Original readiness-only blocked selections retain unknown task totals.

All 12 standalone manifests omit native task capture; some bespoke guarded receipts supply task/model/request details separately. The basic task and four Markdown tasks lack native per-task model/request-budget receipts despite [separate corroboration](F:/alpha-e2e/live-repair-acceptance-20261014-214800/supplemental-legacy-corroboration/manifest.json). Eight disabled legacy suites (37 tests), eight pending managed-agent integration certification rows, the historical manual playbook, rendered Markdown/accessibility, native SCM, and external dataset grading remain outside this matrix. The earlier deterministic certification receipt belongs to the baseline and remains byte-for-byte preserved.

The [spec investigation](F:/alpha-e2e/spec-detail-investigation-20261014/INVESTIGATION.md) records integrated SD-04 and **confirmed OPEN SD-06 failed-summary cost accounting**. Returning cost does not prove displayed totals include it. The original complaint concerned another computer; these probes establish no causal explanation. The separate 24-clause comparative workload has zero live comparison runs.

The [read-only convergence audit](F:/alpha-e2e/codex-convergence-audit-20261014/audit-result.json) reports **97 selected checkpoints / 27 findings**, not suite failures or a parity score, pinned to Codex `160b2b1ef62114eeb41e41e5e3be0000d944b713`. Four P1 entries include SD-04; three others concern UTF-8 journal-tail repair, off-screen question authority, and command residency/output bounds. The user-authorized implementation queue has **10 workstreams / 20 subagents** covering those 27 IDs plus SD-06, under a separate `bb64b894` upstream epoch. During this batch the queue had no shared write/build/profile lease. Its later changes require their own source epoch and validation; they are not part of these results.

The live-suite integration is complete at the documented source epoch. Remaining model-quality, coverage, accounting and separately queued audit findings retain their own status. These samples establish no parity, speed, cost-improvement or broad reliability claim.

## Complete frozen matrix tables

These rows preserve native scenario outcomes. Long-context recovery's scenario pass retains the identity flag described above. Counts are **pass / fail / pending**; workflow request totals include auxiliary reasoning summaries and bounded reproductions.

### Workflow scenarios

| Scenario                           | Outcome | Host test records | Budgeted model requests |
| ---------------------------------- | ------- | ----------------: | ----------------------: |
| `review-edit-test-commit-followup` | passed  |             1/0/0 |                      32 |
| `cancel-resume`                    | passed  |             1/0/0 |                       7 |
| `long-thread`                      | passed  |             1/0/0 |                      42 |
| `reload-continuation`              | passed  |             2/0/0 |                       9 |
| `dev-repo-bootstrap`               | failed  |             0/2/0 |                      32 |
| `dev-git-inspect`                  | passed  |             1/0/0 |                      14 |
| `dev-refactor`                     | failed  |             0/2/0 |                      17 |
| `dev-selective-commit`             | failed  |             0/2/0 |                      33 |
| `dev-merge-conflict`               | passed  |             1/0/0 |                      13 |
| `dev-local-migration`              | passed  |             1/0/0 |                      16 |
| `dev-search-recovery`              | failed  |             0/2/0 |                      19 |
| `dev-verification-unavailable`     | passed  |             1/0/0 |                       4 |
| `completion-admission`             | passed  |             1/0/0 |                      36 |
| `completion-idle`                  | passed  |             1/0/0 |                      36 |
| `stream-cancel-recovery`           | passed  |             1/0/0 |                       5 |
| `provider-error-recovery`          | passed  |             1/0/0 |                       5 |
| `provider-empty-recovery`          | passed  |             1/0/0 |                       6 |
| `task-cycle-soak`                  | passed  |             1/0/0 |                      21 |
| `context-compaction`               | passed  |             1/0/0 |                       8 |
| `background-isolation`             | passed  |             1/0/0 |                       6 |
| `long-context-recovery`            | passed  |             1/0/0 |                      44 |
| `long-context-empty-exhaustion`    | passed  |             1/0/0 |                      24 |

### Standalone live suites

| Suite                      | Outcome | Host test records |
| -------------------------- | ------- | ----------------: |
| `task`                     | passed  |             1/0/0 |
| `markdown-lists`           | passed  |             4/0/0 |
| `alpha-tickets-live`       | passed  |             1/0/0 |
| `approval-github-live`     | passed  |             1/0/0 |
| `command-file-diff-live`   | passed  |             1/0/0 |
| `file-tools-live`          | passed  |             3/0/0 |
| `read-evidence-live`       | passed  |             4/0/0 |
| `live-quality`             | passed  |             4/0/0 |
| `harness-quality-live`     | failed  |             3/1/0 |
| `vscode-lm-empty-recovery` | passed  |             1/0/0 |
| `command-settlement`       | passed  |             3/0/0 |
| `completion-idle`          | passed  |             1/0/0 |
