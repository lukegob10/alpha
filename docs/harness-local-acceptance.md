# Local acceptance engineering

This continuation closes independently testable host mechanics without Docker, services or live-provider spending.
Historical certification reports remain unchanged. The precise remaining external boundaries are tracked separately
from these executable experiments.

## Repeatable local runs

Use `pnpm harness:acceptance <case> --output <fresh-absolute-directory> --vscode-executable
<absolute-Code-executable>`. Cases are `nested-restart`, `cancellation`, `budgets`, `rendered-ui`, `history-churn`,
`host-termination`, and `shared-workers`.
The wrapper acquires the existing build/host lease, builds the extension/webview and host fixtures, then runs the
exact 1.122.1 host using a disposable profile. Existing output directories are rejected. It retains the lease when
host shutdown is unverified and writes a result index beneath the supplied output directory. The fixtures make no
live-provider requests; budget usage is explicitly synthetic and is not billing evidence.
Use a short output directory on Windows: Git's worktree metadata path can exceed its Windows path limit when a long
output name is combined with the isolated VS Code profile and Worker UUID directories. An overlong fixture run is
retained as a failure, not a shutdown or Worker success.

## Nested crash and reload

Run the compiled campaign with `--nested-restart-root <fresh-absolute-directory> --vscode-version 1.122.1
--vscode-executable <absolute-Code-executable>` through `pnpm --filter @alpha-code/vscode-e2e test:campaign`.
Keep the build/host lease held for compilation and execution; do not bundle concurrently.

The fixture uses the real task/delegation owners with proactive fixture settings, creates nested Workers, writes one
partial nested change through the canonical tool, rejects a third child at the root-wide capacity limit, flushes
history, then exits its owned extension host abruptly with code 73. The subsequent host uses the same profile and
verifies unique retained identities, interrupted states, exactly one result per child routed to its immediate parent,
empty versus partial Worker recovery, no orphan worktree directories, and admission/cancellation of a replacement
child. It discards the recovered nested proposal through the real host owner and verifies the original workspace
content remains unchanged. This is host mechanics evidence, not human authorization or rendered Apply evidence.

The passing run is indexed by `artifacts/harness/nested-review-result.json`, fixture
`C:\Users\Luke Goblirsch\AppData\Local\Temp\alpha-nested-restart-sik0aG\fixture`. Its prepare run deliberately remains
failed with exit 73; the separate recovery experiment is passed. Both phases have verified host identity, complete
capture, held retention, observed exit and no surviving verified host PID before profile reuse.

Earlier failed fixture runs remain retained: invalid fixture task names, omitted runtime scripted-provider callbacks
after reload, admission before approving the resume ask, incorrect discard-result shape, and a recovery receipt that
spread old identity fields were corrected. The production runtime was not changed to make these tests pass.

## Cancellation with a held HTTP response and process tree

The `cancellation` case starts two actual Worker tasks: one reads a localhost HTTP response that never completes;
the other runs a command which spawns a separate descendant process. It waits for transport and PID readiness,
then cancels through the real task API. Before fixture teardown it verifies provider signal delivery, the pending
reader abort, server-observed client closure, both PIDs gone, one abort and no completion per task, paired persisted
command call/result, one terminal mailbox result per Worker, and zero active/queued capacity.

The passing run is indexed by `artifacts/harness/cancellation-review-result.json`, retained under
`C:\Users\Luke Goblirsch\AppData\Local\Temp\alpha-cancellation-review-lmQKei\evidence\managed-cancellation`.
Its verified extension-host PID was 45544; capture and shutdown receipts are complete. Earlier failures were fixture
ownership mistakes: awaiting a newly rehydrated root after cancellation, and reading child handles before launch
had materialized. Those failed runs remain retained. This proves task cancellation inside a real host; abrupt host
termination with an external transport observer is a separate experiment.

## Orderly host termination and recovery

The `host-termination` case owns its HTTP server outside VS Code. After both actual Workers report transport and
command/grandchild readiness, the fixture invokes `workbench.action.closeWindow`. The controller waits for verified
host exit and observes connection closure and both command PIDs gone before any safety cleanup. A second host opens
the same profile, checks three interrupted identities and exactly one immediate-parent result per Worker, selects
the recovered root, and verifies zero active/queued capacity and no orphan worktrees. Both captures include the
three task IDs. The first host's missing completed-test receipt remains failed because window closure interrupted
the test; the separate two-phase experiment is what passes.

The passing index is `artifacts/harness/termination-review-result.json`, retained fixture
`C:\Users\Luke Goblirsch\AppData\Local\Temp\alpha-termination-review-dQim5U\fixture` (host PIDs 18304 and 62952).
Capture, held retention, host exit and external resource cleanup all passed.

The initial run exposed a production bug: VS Code 1.122.1 closed the output channel before calling `deactivate`,
and the first diagnostic write threw `Channel has been closed`, skipping provider disposal. The extension now
shares a lifecycle-safe channel adapter with its consumers. It suppresses only that known closed-channel error
and writes after explicit disposal; unexpected errors still propagate. A focused regression failed before the fix
and passed afterward. The original failing external process observation remains retained under
`alpha-termination-review-98JMUX`. Subsequent fixture corrections removed an invalid post-exit liveness assertion
and selected the recovered root before reading its UI capacity projection.

## Rendered Worker and Settings flows

See [rendered UI evidence](harness-ui-acceptance.md). The passing CDP run exercised actual DOM controls in the owned
1.122.1 webview: nested/root/sibling navigation while a sibling kept running, overflow actions, nested and outer
Apply confirmations, Discard confirmation, and Settings edits surviving two distinct incoming state refreshes.
The backend verified canonical task identity, proposal state and filesystem effects. Screenshots and trusted mouse
input receipts are retained. This is automated rendered interaction, not a factual human-authorization checkpoint.

## Scripted budget enforcement

The `budgets` case passed in the actual 1.122.1 host, indexed by
`artifacts/harness/budgets-review-result.json`, retained under
`C:\Users\Luke Goblirsch\AppData\Local\Temp\alpha-budgets-review-FMWFux` (extension-host PID 31524).
It verifies a ten-second Worker timeout and command/grandchild death; a one-token child output limit against
reported usage of two input/eight output tokens; and a fifteen-token root budget exceeded by two ten-token
Reviewer requests. The first Reviewer waits through the canonical `wait_agent` tool while the second usage settles,
so both descendants are active when root exhaustion cancels them. Results, stop reasons, cancellation signals,
usage and released capacity are asserted. Capture and shutdown are complete.

Usage is local fixture data, cost is zero, and `billingEvidence` is `none`. A genuine provider's billed cost and
cost-limit behavior still require an authorized live campaign. Earlier failed fixture runs are retained: one held
a usage-only stream open before accounting could settle; another used a `wait_agent` timeout below the tool's
minimum. The final passing run uses a valid ten-second wait and has no tool-validation error.

## Churn and terminal history preservation

The paired workload creates sixteen roots and sixteen Explore children per window per phase, using 8 KiB root
prompts and 2 KiB child objectives. Every root invokes the canonical spawn and wait tools before completing.
The second phase reopens the same profile, verifies every earlier identity and parent relationship, then repeats
the workload. Each phase accounts for 130 scripted requests, including the two basic shared-storage probes.
The mirror is sampled after each root's history write-through and again at the phase boundaries.

The first complete populate workload (`alpha-churn-review-TsWFnW`) observed peaks of 190,386 and 190,389 bytes,
below the canonical 196,608-byte mirror budget. That experiment remains failed: the controller's default capture
allowance accepted only twenty task IDs, whereas the phase contains sixty-six. Churn now explicitly requests the
existing bounded maximum of one hundred capture IDs; its control-file read permits four MiB, matching the existing
capture source limit and allowing both retained generations. Neither change increases the production mirror budget.

Reviewing the retained histories exposed a production regression: replacing a completed root disposes its runtime,
which emits an abort event. The history projection changed the completed outcome to interrupted, while the canonical
control store correctly kept it completed. The serialized history writer now preserves completed/failed outcomes
when the runtime closes. A resumed turn queues active first, so a subsequent real interruption still persists.
The focused regression failed for both terminal outcomes before the fix and passed afterward, alongside cancellation
and delegation coverage. Persisted schemas and readers are unchanged; this prevents new incorrect status rewrites
and does not relabel older interrupted records without evidence.

Earlier fixture failures also identified two evidence-boundary errors: a completed child need not remain in the
ephemeral lifecycle projection, and TaskCompleted precedes the final asynchronous history mirror write. The fixture
now joins the original Task instance, waits for canonical completed history, and checks the durable control record
and unique immediate-parent result. It does not weaken the expected terminal status.

The rebuilt actual-host run under `C:\Temp\ac-churn-0240a490` passed both phases:
`0bfe401a-7710-4444-be0c-dbaf22e31f08` (populate) and `44a693e4-2f02-4a5e-8903-a4e1ec2a34d3` (reload).
Both report actual extension-host execution, 130 scripted requests, complete capture, verified cleanup and lease
release. All 64 prior workload identities and parent relationships survived reload with completed history. Across
both phases, the workload created 64 roots and 64 children; mirror peaks were 189,214 bytes in populate and
190,044 bytes in reload. The four basic probe tasks are additional to those workload counts.

The outer wrapper's final aggregation failed because the generic sixteen-KiB protocol receipt limit was too small
for two complete phase reports. The failed wrapper receipt remains unchanged. The aggregate writer now has its own
bounded allowance, with a regression for reports larger than sixteen KiB; it does not raise shared protocol limits.
Verified phase reports can be assembled offline without relaunching hosts or relabeling failed host results.
The final passing derived report is `artifacts/harness/churn-derived-final/task-history-churn-report.json`;
the adjacent `provenance.json` names both original phase reports and the unchanged failed wrapper receipt.
The corrected writer was exercised directly against these real reports as well as its size/validation regressions.

## Shared Worker result protocol

The `shared-workers` case starts a real root and Worker in each of two owned extension hosts sharing one profile.
It interrupts A's Worker, consumes its unique interruption result, follows up on the same Worker ID/path, and checks
that B's original Worker instance remained running with one uncancelled request throughout. Both hosts attempt to
claim A's actual completed Worker result. The owning host claims and acknowledges it; the foreign root's ownership
denial is recorded distinctly from an empty mailbox. Both retry after ACK, then close the Workers and strictly abort
and join the roots through the existing runtime owner. Offline checks verify unique result identities, ACKs and
closed Worker tombstones. The preceding control-event race separately covers two eligible claimers.

The fixture never appends a synthetic Worker result. It uses a scoped owned workspace with the read/write and
delegation policy required for Worker admission. Earlier failed runs remain retained: an initial fixture disabled
write auto-approval while expecting admission; the next reached claim/ACK but rejected at root cancellation's
rehydration boundary. The latter's exact exception was not retained, so no specific exception message is claimed.
Strict close-and-join avoids that unnecessary rehydration and propagates cleanup errors. Its conservative blocked
cleanup receipt remains unchanged; `artifacts/harness/workers-review-2-offline-cleanup.json` separately records
verified process absence before releasing only the shared build lease.

The final actual-host run passed under `C:\Temp\alpha-workers-review-wuM0De`, indexed by
`artifacts/harness/workers-review-result.json`: seven scripted requests, both mailbox checks verified, complete
capture, unchanged bundle hash, and verified host cleanup/lease release. A's post-ACK retry was empty; B's was
ownership-denied. This is task interruption across two running hosts, not a claim that a window was reloaded while
its peer continued working.
