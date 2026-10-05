# Complete-suite findings — 2026-10-03

The October 4 implementation and current verification are recorded in
[the convergence closure](codex-cli-convergence-fixes-2026-10-04.md). This document retains the October 3 failures,
measurements, and acceptance criteria; its historical outcomes do not replace current receipts.

This records reproducible failures and remaining coverage debt from the post-convergence testing run. The user asked
for missing tests to be added and failures to be retained for future fixes. Production behavior was not changed to make
these regressions pass. The branch therefore has known failing tests and is not an all-green release candidate.

Reference host: VS Code **1.125.0**. Toolchain: Node **24.21.0**, pnpm **11.24.0**, TypeScript **5.8.3**.
The checkout is dirty on base commit `2660a8f8d68d38ec42d473de6a0eee6d2537e58b`; existing convergence changes were preserved.
Codex behavior was checked against upstream commit `b741e480e203f037ca726bc2a76d99a8e8668e66`, retrieved 2026-10-03.
Alpha's existing permissions and extension features remain in scope; Codex's sandbox is excluded.

Detailed command receipts, raw reports, performance measurements, and logs are retained locally under
`artifacts/core-confidence/testing-2026-10-03/`. Host campaign owners retain their original receipts separately; the
final run report in that directory links them. Unit totals and successful setup do not establish live-model quality.

## Formal gates and repository outcomes

The [formal core gate](../artifacts/core-confidence/testing-2026-10-03/formal-core-confidence/gate-result.json)
finished at `certify:managed-agents` with a failed result. Its exact-host smoke prerequisite and all five core host
files passed: nine executed assertions, no pending or failed assertions, and verified shutdown/capture/retention.
The [fresh certificate](../artifacts/core-confidence/testing-2026-10-03/formal-core-confidence/certification-evidence.json)
contains 3,054 passing and one failing subset test, with source stable during the run. The nickname regression
`TEST-SUBAGENT-001` fails the lifecycle-routing track and propagates to 19 matrix rows; those are not 19 distinct
defects. Seven rows pass and eight integration rows remain pending. Artifact-stability finalization was not reached.
The earlier green certificate is historical evidence and does not replace this failed result.

The [original scripted development campaign](../artifacts/core-confidence/testing-2026-10-03/scripted-development-campaign/report-00017.json)
completed all 12 planned scenarios: 11 passing sample cells and one failed cancellation cell, whose matching
reproduction also failed. It used 121 scripted requests, preserved its evaluation identity, and verified all 14
underlying exact-1.125.0 hosts. The extra host belongs to reload's prepare/continue phases. These overlapping counts
remain separate from ordinary tests and the 43-case host audit.

## Open reproducible defects

### TEST-REPLAY-001 — persisted freeform patch acquires JSON quoting (P2)

- Regression: [openai-responses.spec.ts](../src/api/providers/__tests__/openai-responses.spec.ts),
  `replays a persisted freeform patch string without JSON quoting`.
- Reproduce: `pnpm --dir src test api/providers/__tests__/openai-responses.spec.ts`.
- Observed: Responses request projection JSON-stringifies an already-string `apply_patch` input. The native custom
  tool call receives outer quotes and escaped newlines rather than the accepted saved patch string.
- Owning boundary: [openai-responses.ts](../src/api/providers/openai-responses.ts), custom-tool input projection.
  The persistence reader already accepts the raw string and preserves it. Current newly produced calls ordinarily
  use an object containing `patch`; the demonstrated failure is accepted legacy/imported history compatibility.
- Reference: Codex protocol represents custom tool input as a raw string in
  [models.rs at the pinned commit](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/protocol/src/models.rs).
- Acceptance: preserve exact raw patch bytes and object-form equivalence, including LF/CRLF, quotes, and backslashes.
  Preserve IDs, result ordering, and reasoning metadata across reload, retry, and both Responses storage settings.
  Replaying history must neither rewrite its contents nor execute the historical tool again. Audit equivalent
  provider projections without interpreting arbitrary scalar tool input as a patch.

### TEST-REPLAY-002 — accepted legacy tool result is dropped (P1)

- Regression: [openai-responses.spec.ts](../src/api/providers/__tests__/openai-responses.spec.ts),
  `replays a legacy tool_call_id result with its matching native function call`.
- Reproduce: the same focused command above.
- Observed: saved `tool_result.tool_call_id` is accepted by the persistence validator, but Responses projection checks
  only `tool_use_id` and omits its terminal result. The request retains the call without its matching receipt.
- Owning boundaries: provider-facing tool-result normalization and resume validation. The source audit also found
  canonical-ID-only consumers in other adapters and resume repair. Those additional paths were not reproduced by
  this test; they require their own regressions before claims about observed failures.
- Evidence: [apiMessages.spec.ts](../src/core/task-persistence/__tests__/apiMessages.spec.ts) passes save/read checks
  for both accepted ID fields and error receipts. This separates intact persisted data from faulty request projection.
- Reference: call/result identity is explicit in the same pinned Codex protocol source.
- Acceptance: normalize both accepted ID representations before provider projection and recovery. Define handling
  for empty IDs, conflicting fields, and duplicate receipts; preserve content, error status, order, and exactly one
  terminal receipt per accepted call. Cover reload, retries, background tasks, cancellation, and mixed function/custom
  tool routes. A completed legacy transaction must retain its real result rather than synthesize interruption or
  reexecute the tool. Historical prevalence and actual remote-provider rejection were not measured.

### TEST-TELEMETRY-001 — awaited shutdown returns before client cleanup (P2)

- Regression: [TelemetryService.spec.ts](../packages/telemetry/src/__tests__/TelemetryService.spec.ts),
  `waits for every client to finish shutdown before resolving`.
- Reproduce: `pnpm --filter @alpha-code/telemetry test`.
- Observed: the service's shutdown promise resolves while both controlled client cleanup promises remain pending.
  The public implementation calls client shutdown methods through `forEach` and discards their promises.
- Owning boundary: [TelemetryService.ts](../packages/telemetry/src/TelemetryService.ts), asynchronous cleanup.
- Scope: this is a retained public API defect. Current extension activation creates the service with zero clients;
  the test does not establish an active telemetry leak in today's extension.
- Acceptance: awaiting service shutdown must wait for every successful client cleanup, including when one client
  finishes earlier. Add explicit client-error handling and cleanup tests when implementing the fix. The regression
  uses controlled promises and settles every fixture in `finally`; it does not rely on sleeps or private fields.
- Validation: the new regression fails for the stated reason; package lint and type checking pass.

### TEST-PROBE-CANCELLATION — clean stream abort is misclassified as an empty response (P2)

- Regression: [probeModel.spec.ts](../src/api/__tests__/probeModel.spec.ts),
  `reports cancellation after dispatch while the provider stream is stalled`.
- Reproduce: `pnpm --dir src test api/__tests__/probeModel.spec.ts`.
- Observed: a controlled `AbortController` abort after one request is dispatched returns `empty_response` instead of
  `cancelled_or_deadline`. The fixture uses the real `iterateApiStreamWithAbort`; every pending provider operation is
  released and settled in `finally`. The focused file runs four cases: three existing passes and this new failure.
- Owning boundary: [probeModel.ts](../src/api/probeModel.ts) readiness outcome classification after stream iteration.
  [stream.ts](../src/api/transform/stream.ts) ends iteration cleanly when its abort wins. The probe checks cancellation
  in its exception path, then classifies clean stream termination by text/completion alone.
- Evidence: [original result](../artifacts/core-confidence/testing-2026-10-03/probe-cancellation-regression.result.json),
  [raw assertions](../artifacts/core-confidence/testing-2026-10-03/probe-cancellation-regression.raw.json), and
  [log](../artifacts/core-confidence/testing-2026-10-03/probe-cancellation-regression.log).
- Acceptance: preserve cancellation/deadline identity after dispatch for clean and throwing stream termination,
  including no-output and partial-output cases. Preserve zero requests before dispatch, exactly one request after
  dispatch, unknown usage, handler disposal, and provider cleanup. Ordinary non-aborted empty/incomplete responses
  must keep their separate failure codes. Use controlled promises and a bounded deadline fixture.
- Scope: this proves a diagnostic classification defect. It does not establish why the live provider returned no
  semantic output, or prove that repairing the classifier would make that live request succeed.

### TEST-SUBAGENT-001 — nickname reservations leak across independent roots (P1)

- Regression: [AlphaProvider.subagents.spec.ts](../src/core/webview/__tests__/AlphaProvider.subagents.spec.ts),
  `reuses a requested task name across roots prepared by the same provider`.
- Reproduce: `pnpm --dir src test core/webview/__tests__/AlphaProvider.subagents.spec.ts`.
- Observed: preparing `history_churn_child` for a second independent parent through the same provider throws
  `Sub-agent task_name "history_churn_child" is already in use`. The first prepared group has a different parent and
  child ID. The focused receipt records 148 passing cases and this one failing case; only the newly added case
  increases the distinct ordinary inventory.
- Owning boundaries: [AlphaProvider.ts](../src/core/webview/AlphaProvider.ts) owns one
  [SubagentNicknameRegistry](../src/core/agent/SubagentNicknameRegistry.ts) whose retained `assigned` set applies to
  every root using that provider. Preparation correctly builds a root-scoped reserved-name list, but the registry adds
  its provider-wide reservations to that list.
- Evidence: [original regression result](../artifacts/core-confidence/testing-2026-10-03/subagent-nickname-regression.result.json)
  and [raw assertions](../artifacts/core-confidence/testing-2026-10-03/subagent-nickname-regression.raw.json).
  The first and post-Auto-repair history-churn campaigns remain failed; their original receipts are linked in the run
  report. The public regression isolates a production invariant without relying on the campaign's later stages.
- Acceptance: independent roots may reuse a requested name while retaining distinct stable child IDs. Names must
  remain unique within the same root, including active/prepared siblings and retained history where that contract
  applies. Cover concurrent preparation, nested parents in one root, failed preparation/slot rollback, close/reload,
  and same-provider sequential roots without widening authority or exceeding capacity.
- Capacity correction: nickname assignment fails before `reserveSubagentSlots`. The fixture's total and per-root
  concurrency limits are valid; increasing them does not repair the ownership scope and must not be used to make
  this regression pass.

### TEST-WINDOWS-WORKTREE-001 — legitimate long storage paths fail Git Worker startup (P1)

- Observed: shared Workers admitted with explicit Auto never reach their first provider request because their private
  Git storage path is too long for the current Git invocation. Controlled triage found a 275-character index path and
  280-character lock path. Ordinary filesystem access to that long path succeeds; the equivalent short Git path
  succeeds in the same environment. This is a Windows Git/storage-adapter compatibility defect, not evidence that
  root capacity is exhausted.
- The long-root managed acceptance receipt independently records a Worker failing during `git worktree add --detach`
  with `fatal: '$GIT_DIR' too big`. The owned profile/workspace paths are legitimate inputs to the current host owner;
  shortening a fixture may help isolate the defect but cannot certify the original path.
- Owning boundary: `ManagedSubagentWorktreeService` in
  [managed-subagent-worktree.ts](../packages/core/src/worktree/managed-subagent-worktree.ts), called by Worker
  preparation in [AlphaProvider.ts](../src/core/webview/AlphaProvider.ts).
- Evidence: [post-repair shared Worker receipt](../artifacts/core-confidence/testing-2026-10-03/host-audit-faults-b5e06e1d-dc88-409a-bab6-c78f326d01da/shared-workers/original-result.json)
  retains its controller timeout, complete capture, verified shutdown, and unchanged extension bundle.
  [Managed acceptance log](../artifacts/core-confidence/testing-2026-10-03/host-core-no-build.log)
  and [original host result](../artifacts/core-confidence/testing-2026-10-03/host-audit-core-6fd3aafd-d4e7-4555-aa10-87610a05b1d1/managed-agents.acceptance.test/original-result.json)
  preserve the separate Git startup failure. Both campaigns remain failed.
- The later [short-profile Worker campaign](../artifacts/core-confidence/testing-2026-10-03/host-audit-faults-35933eeb-222d-4b72-93d6-3c36a80446e2/audit-ledger.json)
  passes with the same concurrency caps and verified shutdown. Its shorter storage/profile paths change the
  conditions; that successful run isolates the path sensitivity and does not clear the long-path defect.
- A bounded public-service
  [reproduction](../artifacts/core-confidence/testing-2026-10-03/windows-worktree-path-repro-f69a4148-708e-490d-9912-d8f9868b20f1.json)
  and its [execution receipt](../artifacts/core-confidence/testing-2026-10-03/windows-worktree-path-repro-f69a4148-708e-490d-9912-d8f9868b20f1.execution.json)
  reproduce the defect with Git `2.43.0.windows.1` and repository-local `core.longpaths=false`. A 37-character storage
  root succeeds; a 202-character root fails at `git read-tree` with `Filename too long` at the observed 275/280-character
  index/lock paths. The execution exits 1 intentionally and retains `originalFailureStatus: "OPEN"`.
  Both cases call public cleanup; the fixture is removed and source hashes, HEAD, index, and repository status are
  preserved. These two diagnostic durations do not establish a performance improvement.
- Startup cleanup is also incomplete: the failed long-path create leaves an empty UUID artifact directory before
  the caller invokes public cleanup. The first snapshot Git operation precedes the create method's cleanup-protected
  `try` block. Failed creation must clean owned artifacts even when it fails before `git worktree add`.
- Acceptance: exercise short and long owned profile roots on exact VS Code 1.125.0/Windows with real Git, including
  the observed index/lock lengths, spaces, and nested Workers. Worker startup must either complete through the
  supported adapter or report one explicit terminal failure promptly; it must not hang awaiting a provider request.
  Preserve worktree isolation, scope/policy, change-set identity, deterministic cleanup, and existing profiles.
  Assert that failed startup leaves no owned UUID directory, index/lock file, registration, or live worktree, while
  preserving the source repository. Add the regression at the Git adapter boundary and repeat the original
  exact-host workload after the fix. A successful short-path run does not resolve the original long-path defect.
- Counting: these host observations are separate from ordinary unit totals. No extra ordinary case is added until
  a distinct regression is actually introduced and run.

## Host fixture failures and remaining investigation

### TEST-FIXTURE-SETTLEMENT-001 — exclusive fixture creation collides inside one suite

- The first command-settlement test creates `.alphaignore` with `flag: "wx"`. The two terminal-provider tests reuse
  the same suite workspace and attempt the same exclusive creation. Both fail with `EEXIST` before their command
  settlement assertions execute. The original host receipt contains one passing and two failing cases.
- Evidence: [command-settlement log](../artifacts/core-confidence/testing-2026-10-03/host-extra-final.log)
  and [original receipt](../artifacts/core-confidence/testing-2026-10-03/host-audit-extra-1fd15ef0-58e9-4ec6-99c3-f73ea1c1c336/command-settlement.test/original-result.json).
- Owner: [command-settlement.test.ts](../apps/vscode-e2e/src/suite/command-settlement.test.ts), fixture lifetime.
  Initialize common owned files once or isolate each test's files, and restore only verified fixture-owned content.
  Preserve exclusive creation at the appropriate boundary and all receipt/terminal assertions. A rerun must reach
  both real terminal-provider workloads; suppressing `EEXIST` without establishing ownership is insufficient.

The [isolated backend ledger](../artifacts/core-confidence/testing-2026-10-03/command-settlement-isolated-1b07592c-9161-415d-a975-f124b92034e7/isolated-ledger.json)
records two passing filtered tests, one per fresh workspace/profile for execa and VS Code terminals. Both reach
their original file-edit and command-result assertions, with exact-host identity, held retention, complete capture,
and verified shutdown. This supplies supplemental backend coverage; the original unfiltered fixture failure stays
OPEN. The wrapper uses the alias `TEST-HOST-COMMAND-SETTLEMENT-FIXTURE-001` for this same register entry.

### TEST-FIXTURE-CANCEL-RESUME-001 — cancellation fixture waits for an already-approved command

- Original sample and reproduction both fail with `command_approval_timeout` after about 306 seconds in the
  [completed campaign](../artifacts/core-confidence/testing-2026-10-03/scripted-development-campaign/report-00017.json).
- Owner: [extensionWorkflowHost.ts](../apps/vscode-e2e/src/scenarios/extensionWorkflowHost.ts), paired with
  [workflowDriver.ts](../apps/vscode-e2e/src/scenarios/workflowDriver.ts). The fixture selects canonical Auto while
  retaining legacy `alwaysAllowExecute: false`. Canonical Auto wins. Captured transactions show approval, successful
  execution, and completion before the fixture's wait for a pending command Ask expires.
- This does not reproduce a production cancellation or approval defect. Existing unit fixtures supplied a pending
  Ask manually and therefore missed admission-policy setup.
- Required repair: start only the held-command phase in canonical Ask. After cancellation, retain the real
  rehydrated task and use the existing public task-approval update to establish Auto before continuation guidance.
  Changing global configuration alone does not override the task's persisted Ask. Reject unavailable, denied, or
  mismatched policy-update receipts before sending guidance. Preserve scope, denied commands, request budgets,
  same-task resume, call/result receipts, and the original cancellation assertions.
- Resolution: the fixture now applies the required canonical policy through the host bridge. Three new cases cover
  held-command admission, rejection/mismatched receipts, and unchanged ordinary Auto behavior. The
  [before-fix receipt](../artifacts/core-confidence/testing-2026-10-03/workflow-approval-before.result.json)
  records one pass and two intended failures; the
  [after-fix file](../artifacts/core-confidence/testing-2026-10-03/workflow-approval-after.result.json)
  passes all 27 cases. Owning-package types, lint, and compilation pass; the production extension bundle is unchanged.
  The [real-host rerun](../artifacts/core-confidence/testing-2026-10-03/cancel-resume-repaired-campaign/report-00005.json)
  passes cancellation, retained-task resume, and continuation in six scripted requests. Its controller completes,
  evaluation identity stays unchanged, and exact-host capture/shutdown are verified. The command takes 36.95 seconds
  including setup and shutdown. Its 100-request ceiling and one-iteration limit are explicit supplemental run
  conditions, not a rerun of every original campaign cell. Original sample/reproduction failures remain unchanged.

### TEST-FIXTURE-TEMP-PATH-001 — cleanup guards compare valid Windows path spellings literally

- The [first gated live preparation](../artifacts/core-confidence/testing-2026-10-03/live-core-preparation-forward-slash/gate-result.json)
  stops before host/model requests: the unit prerequisite reports 544 passes, two failures, and two skips. Both
  failures occur in cleanup guards after substantive assertions, comparing `F:\alpha-e2e\tmp` with the equivalent
  task-scoped `F:/alpha-e2e/tmp`. All 27 planned live cells remain unrun in this attempt.
- Owners: [harnessReceipt.spec.ts](../apps/vscode-e2e/src/unit/harnessReceipt.spec.ts) and
  [runTest.spec.ts](../apps/vscode-e2e/src/unit/runTest.spec.ts). The guards now compare real parent paths, following
  the owning file's existing pattern; fresh-directory prefixes and all receipt/count assertions remain intact.
  The [focused forward-slash check](../artifacts/core-confidence/testing-2026-10-03/fixture-temp-guard-after.result.json)
  passes both tests. Types, lint, compilation, and formatting pass; no new cases or production changes are added.
- The saved launcher uses native Windows temporary-path spelling and restores its temporary environment in `finally`.
  The saved signed-in profile stays separate from these transient fixtures.
- Two original test roots remain as deliberate diagnostic evidence. Their metadata and
  [retention receipt](../artifacts/core-confidence/testing-2026-10-03/fixture-temp-guard-retention.json) record ownership
  and existence. Automatic approval review rejected their deletion before execution with `blocked by policy` and
  supplied no detailed reason. No alternate deletion was attempted. This leaves folders, not an observed live host.

### TEST-FIXTURE-UI-001 — rendered acceptance targets retired Agents settings

- The rendered acceptance controller tries to open an `Agents` tab and edit `#max-concurrent-subagents-input`.
  The captured Settings DOM has the current tabs and no such control; the controller times out before its
  refresh/discard and nested Apply/Discard/navigation stages run.
- Evidence: [failed control and rendered DOM](../artifacts/core-confidence/testing-2026-10-03/host-audit-rendered-198332b9-ed6d-40e7-8b5b-f723dc2c55d6/ui-acceptance/evidence-ui-aabd8120-7c13-4f46-9b0c-b9489ba53223/ui-failed-control.json)
  and [original rendered acceptance receipt](../artifacts/core-confidence/testing-2026-10-03/host-audit-rendered-198332b9-ed6d-40e7-8b5b-f723dc2c55d6/ui-acceptance/original-result.json).
- Owner: [renderedAcceptance.ts](../apps/vscode-e2e/src/ui/renderedAcceptance.ts), paired with
  [managed-agents.acceptance.test.ts](../apps/vscode-e2e/src/suite/managed-agents.acceptance.test.ts).
  Exercise a supported visible edit-buffer field and preserve the Settings `cachedState` refresh/dirty/discard
  assertions. Keep the nested Worker Apply/Discard and navigation stages. Reintroducing retired UI or increasing
  runtime caps is not an acceptance repair.
- Resolution: the controller now exercises the supported Terminal preview setting and its `cachedState` edit buffer.
  The [rerun ledger](../artifacts/core-confidence/testing-2026-10-03/host-audit-rendered-a9a0f53f-9040-4af6-a6d7-d95b17e18b1c/audit-ledger.json)
  and [original rerun result](../artifacts/core-confidence/testing-2026-10-03/host-audit-rendered-a9a0f53f-9040-4af6-a6d7-d95b17e18b1c/ui-acceptance/original-result.json)
  pass with verified shutdown. Captured stages retain Settings refresh/discard, nested Apply, Worker Discard,
  outer Apply, and live/final nested, outer, and root navigation. The command took 42.105 seconds, including setup
  and host shutdown; that is one scripted acceptance run, not a product latency claim. The first red receipt remains.

### TEST-UI-INVESTIGATE-001 — original provider setup Enter navigation failure

- The renderer probe focuses the setup button inside the webview and dispatches Enter through its CDP target, then
  times out with `rendered_provider_setup_navigation_timeout`. The hosted test passes, but the rendered owner result
  correctly stays failed and the captured page remains on Welcome.
- Evidence: [original probe receipt](../artifacts/core-confidence/testing-2026-10-03/host-audit-rendered-198332b9-ed6d-40e7-8b5b-f723dc2c55d6/ui-probe/original-result.json)
  and [captured rendered text](../artifacts/core-confidence/testing-2026-10-03/host-audit-rendered-198332b9-ed6d-40e7-8b5b-f723dc2c55d6/ui-probe/evidence-ui-00345b28-95b4-4954-a328-b5200abc7b4e/ui-last-rendered.txt).
- Classification: production keyboard navigation is not yet proven defective. Confirm foreground workbench focus,
  active webview/button focus, and input-target delivery, then compare trusted keyboard and pointer activation.
  Do not turn a passing hosted test into a passing rendered acceptance result or bypass the keyboard assertion.
- Resolution: the controller now brings the owning page to the foreground and supplies Enter's text through the
  trusted input path. The [rendered rerun](../artifacts/core-confidence/testing-2026-10-03/host-audit-rendered-f3563612-f2ae-4a91-9be3-8080698f17a2/audit-ledger.json)
  passes with verified shutdown; its command took 6.916 seconds. This resolves the demonstrated fixture input
  omissions while preserving the original failure. No production keyboard defect is claimed.

### Fixture alignment and remaining failures

Explicit `approvalMode: "auto"` repairs replace legacy auto-approval flags in fixtures that intend automatic child
admission. The original Ask-mode failures remain retained. Scripted fixtures also need native tool stream/model
metadata that matches the captured tool surface. After these fixture repairs, owned
[nested restart](../artifacts/core-confidence/testing-2026-10-03/host-audit-faults-619c3939-1d71-4107-a770-30021370c0e2/audit-ledger.json)
and [rich documents](../artifacts/core-confidence/testing-2026-10-03/host-audit-extra-d5cef74a-4c57-41e0-b89c-64e19c553ad5/audit-ledger.json)
reruns pass with verified shutdown. All 43 planned host-audit cases were observed; the final report retains each
original failure and subsequent result. The unfiltered command-settlement fixture, cross-root nickname regression,
and original long-path Git workloads remain open. Passing isolated or shorter-path workloads do not clear them.
Keep real tool-call/result, completion, cancellation, request-count, and shutdown assertions. The history workload
still requires sixteen roots and sixteen children per window, exactly three root and one child request per root,
durable completion identities, and the 192 KiB history mirror budget. Do not increase total/per-root caps to work around
nickname reservations, Git startup errors, or stale fixture metadata.

## Current performance concern

`AgentControlStore.benchmark.ts` measured `reserve-settle` with 60 samples per writer after five warmups. All four
cases completed without command or transaction failures. This is current performance characterization on an AMD
Ryzen 7 5800X / 64 GiB Windows machine, with fresh workers and warmed filesystem cache; it is not a historical A/B
comparison or a demonstrated regression against a release threshold.

| Retained agents | Writers | Samples | Median operation | p95 operation |
| --------------- | ------- | ------- | ---------------- | ------------- |
| 1               | 1       | 60      | 26.97 ms         | 34.01 ms      |
| 1               | 2       | 120     | 55.67 ms         | 64.35 ms      |
| 5,000           | 1       | 60      | 1,134.73 ms      | 1,258.85 ms   |
| 5,000           | 2       | 120     | 2,350.67 ms      | 2,558.13 ms   |

**PERF-STATE-001:** investigate retained-state validation and serialization costs before optimizing locks or small
allocations. The large single-writer case spends substantial time validating and writing state. Preserve ownership
fences, deterministic ordering, cleanup, and bounded concurrency. Reuse the same benchmark/source identity and
workload for any future before/after claim; raw phase and contention data are in `control-store-current.json`.

Other measured current-state workloads are retained in the final run report. A read-only whole-checkout Git
checkpoint takes a median **10,335.81 ms** over five samples, dominated by Git add and commit. In one actual
VS Code 1.125.0 renderer, reopening a task with 1,200 synthetic persisted messages takes **328 ms p50 / 356 ms p95**
over ten warm cycles. That settled-content measure includes a 150 ms quiet window and two animation frames;
the opening indicator appears earlier and is not task content. The one cold reopen takes 368 ms. These different
fixtures and sample counts cannot establish a release regression, live-model latency, or a general speedup.

## Resolved testing gaps

- Root tooling discovery omitted two existing test files. Broader owner globs and an inventory regression now cover
  them; all 185 tooling cases pass. The temporary loader failure during repair was resolved, not hidden.
- The unit harness omitted `packages/build`; it now executes and records that package. Telemetry has its first
  meaningful test and an explicit Vitest execution receipt rather than treating an empty package as coverage.
- Eleven PowerShell cases were falsely skipped because their availability probe was never loaded. The focused file
  now loads its setup once; all eleven pass on PowerShell 7.6.5.
- NOR36's request fixture lagged the current reasoning ownership/context fields. Its setup was repaired without
  changing production behavior; all nine bounded request-construction samples pass.
- New tests cover queued delegation authority, late child cancellation/mutation evidence, shared skills discovery,
  provider terminal/cancellation boundaries, and accepted persisted input/result formats.
- Evaluator Postgres/Redis readiness initially failed. Fresh run-owned containers then passed migrations, database,
  Redis, and Docker adapter tests. They mounted no historical volumes and were verified removed after the run.
- A provisional managed certificate had passing assertions but correctly rejected source edits during execution.
  Retain that diagnostic receipt; only a subsequent stable-source certificate can supply passing certification.

## Remaining ordinary-suite coverage debt

After the PowerShell/benchmark supplements and new nickname/cancellation regressions, the distinct ordinary-suite
inventory contains 13,934 cases: 13,897 passed, 5 failed, and 32 skipped. Parameterized instances are retained;
overlapping focused and certification runs are not added again. The original complete extension receipt remains
10,189 passed / 2 failed / 42 skipped; supplements replace fourteen of those skipped cases with passes. The focused
nickname file repeats 148 existing passing cases and adds only its one newly failing case to this total. The probe
file repeats three existing passes and adds only its one newly failing case. The repaired workflow fixture adds
three passing runner cases; its other 24 repeated passing cases are excluded. Host failures and performance samples
remain separate.

| Remaining group                    | Cases | Follow-up                                                                                         |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| Extension Windows guards           | 8     | Exercise supported behavior on POSIX and repair unnecessary mock-only platform guards separately. |
| Swift parser static skips          | 12    | Establish a bounded parser fixture before removing slow-test exclusions.                          |
| AlphaProvider static harness skips | 6     | Repair stale storage/mocking expectations; preserve real assertions.                              |
| Network proxy isolation            | 1     | Isolate module state before enabling.                                                             |
| Million-line terminal stress       | 1     | Provide an explicit bounded stress lane and portable fixture.                                     |
| Welcome provider UI placeholders   | 2     | Add selection/save interaction assertions and a faithful radio-group mock.                        |
| Host-runner POSIX termination      | 2     | Run negative-PID process-group failure cases in POSIX CI; Windows cleanup cases already ran.      |

Retired extension suites and live-only or fixture-specific host scenarios are accounted for separately by the host
inventory. Skipped tests, scripted provider decisions, model discovery, and synthetic SecretStorage markers are not
evidence of authenticated live-provider task success.

## Saved live profile

The user's reusable profile is `F:\alpha-e2e\profiles\1.125.0`. Local `F:\alpha-e2e\saved-profile.json` and
`F:\alpha-e2e\Run-SavedLiveTests.ps1` supply the existing runner/campaign paths explicitly. The runner appends the host
version to the profile root, preserves stores, and enforces its existing lease. Campaign workspaces remain separate.
Profile storage is not subject to successful-run artifact pruning. No credentials were exported or copied.

Profile launcher syntax and compiled setup/campaign argument parsing were validated without launching a provider
request. The initial setup was closed without its Finish receipt and stayed blocked; its host was cancelled and the
profile preserved. The first read-only cold model discovery attempt failed at fixture API loading before
activation/model query, with zero provider requests and verified shutdown. A later
[cold discovery validation](../artifacts/core-confidence/testing-2026-10-03/saved-profile-discovery-80dbc688-a0b8-4378-b6f9-ff218bc2bd4e.validation.json)
passes on the exact normal development host with complete capture and verified shutdown. Its
[sanitized native receipt](../artifacts/core-confidence/testing-2026-10-03/saved-live-profile-discovery.json)
records 21 discovered models, all authorized through the actual Alpha extension context, with zero model requests.
This verifies retained profile authorization on cold reopen; successful solving and authenticated task resume
remain separate unverified contracts.
Safe [saved selection metadata](../artifacts/core-confidence/testing-2026-10-03/saved-live-model-selection.json) records
the user's `gpt-6-luna` model with `max` effort and `authorizationObserved: true`. Model availability and accepted
configuration are separate from successful task execution.

The first probe wrapper used the wrong budget option; its
[failed validation](../artifacts/core-confidence/testing-2026-10-03/saved-profile-probe-af5bd817-9c3f-47ec-9667-5168cfe65f80.validation.json)
is retained as a fixture failure. After that option repair, the
[one-request probe owner](../artifacts/core-confidence/testing-2026-10-03/saved-profile-probe-949b2135-d24c-41e0-b257-72e81ddd34ff.owner-result.json)
remains blocked with `provider-unavailable`, complete capture, and verified shutdown.
[Validation](../artifacts/core-confidence/testing-2026-10-03/saved-profile-probe-949b2135-d24c-41e0-b257-72e81ddd34ff.validation.json)
preserves `ownerPassed: false` and `exactModel: false`: the owner publishes its actual-model field only after successful
preflight. The completion probe itself records `gpt-6-luna`; no model mismatch is established. The run owner records
one actual Alpha request, no first text,
60,007.5171 ms wall time, unknown usage, and `empty_response`. The cancellation regression above proves that this
failure code can misclassify clean abort; it does not establish the cause of the live no-output result.

[Profile behavior and commands](vscode-live-test-profiles.md).

### TEST-LIVE-COPILOT-001 — live campaign stops at completion readiness

The final [gated live core campaign](../artifacts/core-confidence/testing-2026-10-03/live-core-campaign/gate-result.json)
uses exact VS Code 1.125.0, the saved profile, the user's `gpt-6-luna` selection at `max`, three samples per scenario,
and a 300-request campaign ceiling for task traffic. All four deterministic prerequisites pass: the runner unit
suite has 546 passes and two POSIX skips, the thirteen smoke hosts execute 42 passing assertions, the focused core regressions have 432
passing subset cases, and the five core hosts execute nine passing assertions. All eighteen prerequisite host
launches have complete capture, retention, and verified shutdown. These overlapping counts are not added to the
ordinary inventory.

The campaign's first live host discovers Luna, confirms Alpha's authorization, and applies the requested effort.
Its one-request readiness probe produces no first text within **60,004.2192 ms** and records `empty_response` with
unknown usage. The host stops before a task-solving scenario begins. The owner reports `provider-unavailable`,
complete capture, verified ownership, observed host exit, and complete retention. Evaluation identity and packaged
artifacts remain unchanged during the campaign. No repair or provider substitution is performed.

The [terminal report](../artifacts/core-confidence/testing-2026-10-03/live-core-campaign/report-00005.json) records
zero passing or failing solving attempts and one infrastructure-blocked attempt. The stricter gate labels that
first cell failed and the other **26 cells not run**. Thus none of the planned 27 live cells has successful semantic
evidence. Campaign usage fields are `null`, not proof of zero actual requests or zero billed usage: the separate
readiness receipt records one dispatched request with `countsAsSolving: false`. The earlier isolated readiness
probe also dispatched one request; it is a separate run, not an additional campaign sample.

This is a tracked live-provider investigation, not a seventh proven production defect. The controlled probe
cancellation regression explains why `empty_response` can be a misleading diagnostic; it does not explain the
no-output provider behavior. Future work should isolate request admission, response draining, and deadline handling
with safe host diagnostics, then rerun the same model/effort and all planned cells. Do not infer lost sign-in from
this outcome or replace the selected provider to obtain a green receipt. Authenticated solving, task resume after
cold reopen, and live-model quality/latency remain unverified. The saved profile and reusable launcher are preserved.

## Release receipt identity

The completed [bundle](../artifacts/core-confidence/testing-2026-10-03/release-bundle-current.result.json),
[VSIX](../artifacts/core-confidence/testing-2026-10-03/release-vsix-current.result.json), and
[contents verification](../artifacts/core-confidence/testing-2026-10-03/release-vsix-contents-current.result.json)
command receipts pass. VSIX verification checked 1,675 entries and 16 document assets, with no environment files.
This is packaging evidence and does not clear the open execution/UI defects or certify live Copilot behavior.

Earlier deterministic hosts used development extension SHA-256
`8506999cfd430107fd08b7419e7f1827954a47905489fb8b42f964932b710065`. VSIX prepublish enabled production minification,
producing `ebbc7dcc4ed18de83cd2c3a1164fa3213c643f49f643636d20209dba790c01d6`. Do not present one global current bundle
hash for all host runs. Preserve each run's observed bundle identity and original receipt.
