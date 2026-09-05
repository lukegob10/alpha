# Local Git initialization trace review

Reviewed September 5, 2026. Mode: performance optimization review. Scope: the two consecutive requests
“have we created a local git?” and “can you initialize a local git”. A successful initialization should use Git's
initialization operation and a bounded repository check. An unavailable runtime operation should produce an actionable
blocker, without manufacturing repository metadata.

## Verdict

The run was excessive and unsuccessful. The dominant issues were command admission, an incorrect model recovery
strategy, and serial lifecycle publication. This was not a completion-rejection loop or a long-running Git command.
No successful shell execution occurred. Four file-tool writes left an invalid `.git` directory. The user stopped the
continuing run; this trace provides no evidence that the agent would have stopped on its own shortly afterward.

## Evidence and provenance

- Inspected the matching task's `api_conversation_history.json`, `ui_messages.json`, `agent_turn_events.jsonl`,
  `agent_lifecycle_events.jsonl`, task metadata, and the corresponding extension-host log.
- The activation log reports Alpha **2.1.22**. The host stack identifies the reference VS Code **1.122.1** executable
  and the main checkout's `src/dist/extension.js`. The loaded-directory bundle predates activation and contains the
  admission and lifecycle code described below. Its SHA-256 at review time was
  `d80759a2b4f3556d6392b1b98cc706f54657bb11a152f16ff5f81eb866a3e2f2`.
- This is not a run of the newer NOR-31 integrated candidate. An installed-extension registry entry alone would have
  incorrectly identified this development-host run as 2.1.18.
- Raw reasoning, prompts, private workspace paths, task IDs, and raw logs are not copied into this report.
- Inspected the resulting `.git` entries and ran a read-only Git recognition check. No project repair was performed.

## Measured behavior

| Measurement                                    | Repository question | Initialization request |
| ---------------------------------------------- | ------------------: | ---------------------: |
| Model requests                                 |                   4 |                     10 |
| Tool calls, including rejected/cancelled calls |                   3 |                     11 |
| Successful shell executions                    |                   0 |                      0 |
| Reported input tokens, summed across requests  |              43,927 |                124,626 |
| Reported output tokens, summed across requests |               1,090 |                 15,168 |
| Reported cache-read tokens                     |                   0 |                      0 |
| Time to visible answer / user Stop             |        39.3 seconds |          414.5 seconds |

The initial question reached its completion-review boundary at 40.5 seconds. Initialization started at 14:12:22.595 UTC,
the cancellation event was recorded at 14:19:17.115, and the terminal event at 14:19:43.648. Thus the full initialization
interval through shutdown was 441.1 seconds, including 26.5 seconds after Stop. The later resume UI is not execution time.
Token sums describe recorded request usage, not unique context or an independently verified billing amount.

The initialization's 11 calls comprised four `execute_command` attempts, four `write_to_file` calls, two `list_files`
calls, and one `read_file` call. Three command attempts were rejected before launch; the final attempt was cancelled.
There were no provider retry events, no `attempt_completion` calls, and no rejected completion candidate during this
request. All ten recorded tool approvals resolved as approved; the eleventh tool was cancelled before approval.

## Findings

### High / must-fix: command admission provides an unusable recovery contract

The first `git init` was a sensible action. The runtime rejected it before execution with a generic message saying that
workspace mutation scope could not be observed and suggesting explicit file tools or a supported inspection command.

[`ExecuteCommandTool`](../src/core/tools/ExecuteCommandTool.ts) first captures the entire primary workspace's mutation
baseline. [`VerificationScope`](../src/core/agent/VerificationScope.ts) uses a bounded full-file snapshot when `.git` is
absent, capped at 256 files, with additional byte, depth, entry, and symlink constraints. Replaying its non-Git traversal
against the current workspace, excluding `.git` as the implementation does, reaches the 257th file and fails the bound.
The host log also records an inaccessible virtual-environment link during checkpoint initialization. The original
admission exception was swallowed, so the trace cannot prove which observation failure occurred first at that moment.

After `.git/HEAD` was written, `.git` existence switched observation to Git mode, although the directory was not a valid
repository. This made subsequent baseline capture fail for another reason while returning the same generic message.

The fallback reuses [`classifyPlanCommand`](../src/shared/plan-command.ts), including in Code mode. The attempted `&&`
chains are outside its single-command subset; even an unchained Git inspection requires `--no-pager`. Running the actual
classifier confirmed that `git --no-pager rev-parse --is-inside-work-tree` is accepted, while the attempted forms are not.
None of these actionable distinctions reached the model.

There is also a bootstrap contract gap: the reviewed observer rejects a before/after transition from non-Git observation
to Git observation. Merely allowing `git init` past admission would not provide a complete mutation-receipt solution.

Recommended change, generalized following the user's clarification: preserve bounded mutation enforcement and expose
structured observation/admission reasons and supported recovery capabilities for every task. Operation receipts need to
represent supported workspace transitions without assuming the workspace is already in its final form. Git initialization
is a regression example, not a new special-case workflow. Do not solve this by raising every workspace limit, silently
ignoring arbitrary paths, or treating mutations as read-only. The broader design is recorded in
[general task efficiency](nor-36-general-task-efficiency-design.md).

### High / must-fix: the recovery strategy damaged the requested outcome

After the rejected initialization, the model wrote `.git/HEAD`, reread that just-written file, wrote `.git/config`,
retried the rejected compound inspection, and then wrote `.git/description` and an empty `.git/index`. It listed the
partial structure again, retried another unsupported compound inspection, and eventually retried `git init` before
cancellation.

The extra file writes did not resolve the admission blocker. The description file did not make the repository usable,
and the empty index was incorrect. The current `.git` directory contains only those four files, with a zero-byte index
and no `objects` or `refs` directory. A read-only recognition check returned “not a git repository”.

A separate disposable probe using Git 2.43.0.windows.1 confirmed that normal initialization creates no index and passes
`git status`; adding a zero-byte index then makes status fail with “index file smaller than expected”. The probe was
removed; the user's project was left untouched. Git documents initialization and repository layout in
[git-init](https://git-scm.com/docs/git-init) and [gitrepository-layout](https://git-scm.com/docs/gitrepository-layout)
(retrieved September 5, 2026).

Recommended change: route an unchanged infrastructure blocker to an actionable blocked outcome or an explicitly supported
recovery. Generic advice to use file tools is inappropriate for repository initialization. Progress detection should not
interpret arbitrary metadata changes as resolution of command admission. Add a real-task regression that rejects init
and verifies that the agent does not manufacture `.git` internals or repeatedly retry an unchanged blocker.

### High / must-fix: serial lifecycle publication substantially delays tool execution and cancellation

The initialization emitted **2,150 `assistant_reasoning` lifecycle items**, totaling only **11,050 UTF-8 bytes** of
reasoning text. The observed first-to-last publication windows for the eight responses containing reasoning totaled
**227.7 seconds**. The last response's publication window alone was **88.4 seconds**. These are measured journal-event
intervals, not a profiler's isolated filesystem time, and include part of cancellation shutdown.

The source explains the critical path: `persistAssistantResponseBeforeEffects()` awaits
`publishCanonicalLifecycleResponseItems()`, which awaits one `enqueueCanonicalLifecycleEvent()` per response item.
[`AgentLifecycleJournal.append()`](../src/core/agent/lifecycle/AgentLifecycleJournal.ts) then acquires the journal lock,
reduces the state, appends the event, maintains snapshots/cache, and returns cloned state. This happens before tools run.
See [`Task.ts`](../src/core/task/Task.ts).

Across the ten requests, request-start-to-usage intervals totaled 180.0 seconds; usage-to-assistant-commit intervals totaled
231.9 seconds. All tool-batch intervals together totaled only **10.1 seconds**. These boundaries are diagnostic, not a
complete CPU/network/disk decomposition. The trace nevertheless directly contradicts an explanation based on slow shell
commands or mostly tool execution. The request added only 10 seconds of logged configured request pacing.

Recommended change: publish lifecycle response items in bounded batches while preserving order, IDs, durable
tool-before-effect barriers, replay, and cancellation. Use the recorded fragmentation shape in a deterministic
benchmark, including cancellation during publication. The newer integrated checkout still has the per-item awaited
publication loop at review time; its separate transcript-buffer results do not establish that this delay is fixed.

### Medium / should-fix: the initial answer overstated its evidence

The question was answered after a rejected command, a root listing, and a missing `.git/HEAD` read. That is weaker than a
successful Git recognition check: repositories can be inherited from a parent directory or use a `.git` pointer file.
The observed project is currently not a recognized repository, but the agent's original certainty exceeded its evidence.
Use the supported Git inspection form or accurately qualify the answer when inspection is unavailable.

## What this changes about NOR-36 attribution

This trace supplies concrete evidence that was absent from the scripted proportional-scope fixtures. It supports work
on command admission/recovery and lifecycle publication before adding a task-size classifier or more prompt wording.
Lower reasoning effort might reduce some generation time, but cannot repair admission, invalid metadata, or serial
publication. The completion-wait optimization described previously does not address this run: initialization never
reached a completion candidate.

No production code, Git metadata, settings, or trace files were changed. The review validated counts against both UI and
canonical events, checked the bundled implementation, exercised the actual command classifier, performed read-only
workspace inspection, and ran the disposable Git probe. No new build, extension-host run, or comparative speed claim
was made. Fixes to admission, durable publication, and cancellation require their own focused regression and exact-host
validation; this report does not claim those gaps are closed.

## Resumed attempt: September 5, 16:08–16:13 UTC

The same task was resumed with the user feedback “if you have completed the task then stop” at 16:08:30.861 UTC.
This continuation is separate from the earlier user-cancelled initialization attempt. It ended automatically with an
explicit incomplete outcome at 16:13:48.666 UTC, approximately 5 minutes 18 seconds after the feedback.

### Observed sequence

1. At 16:09:34.146, the assistant visibly claimed that creating the local `.git` directory completed the task. That claim
   was not supported by a successful initialization or recognition check.
2. At 16:09:44.451, the completion gate rejected success because the four earlier metadata writes still had unresolved
   verification obligations. Rejecting unsupported success was correct.
3. The agent then attempted six commands: a shell file-existence check, a directory listing, a Python file-existence
   check, Git status, Git initialization, and Git directory recognition. All six received approval but were rejected
   before process launch with the same workspace-observation message. These were six attempted commands, not six
   executed processes. No new file-write tool ran in this continuation.
4. After the sixth failure, the model received the no-progress strategy-change warning. It then called
   `attempt_completion` with `outcome: "blocked"`.
5. The tool returned an error result, and the canonical run recorded `turn_incomplete`. The visible final error is the
   intentional representation of blocked/unverified work in `AttemptCompletionTool`, not evidence of a provider crash.

The continuation contained **8 model requests, 6 rejected command calls, and 1 blocked-completion call**, with reported
usage of **120,075 input tokens and 10,882 output tokens**. Request-start to final incomplete event was 281.240 seconds.
The first request began 36.565 seconds after user feedback. The extension log separately records resumed shadow-checkpoint
initialization taking 36,741 ms after reporting a 15-second timeout; this is an additional resume-latency finding, not the
cause established for the final command-admission error.

### Diagnosis and confidence

The blocking result is accurate: a read-only recognition check still reports that the workspace is not a Git repository,
and the manually created index remains zero bytes. A directory or file-existence check would not establish the original
requested postcondition even if admitted. The model also supplied the bare task identifier as a verification change-set
ID while the gate named a `primary-change:` identifier. That is a potential later association problem, but it did not
cause these six failures because admission rejected every command before execution.

The demonstrated recovery defect is repeated work against an unchanged unavailable capability. The no-progress warning
eventually helped the run stop; the trace does not show an endless loop on this continuation. The generic rejection
nevertheless supplied neither the failed observation reason nor a precise supported inspection or recovery path, and
each different command reached the same rejection. More reasoning capability would not make that boundary available.

Runtime identity matters. The active output channel reports extension **2.1.22**, and the development bundle referenced by
the host is older than the integrated fixes. The prior implementation run was pushed to `main-v2` at
`98e8c93940882b61466d44c452a56ef10ea5f5d7`; this trace is not an acceptance run of that build. However, inspection of that
exact Git revision confirms the same command-admission catch block still discards the observation exception, falls back
to `classifyPlanCommand`, and returns the same generic error. Updating the running build is necessary to isolate remaining
defects, but is not evidence that this admission/recovery gap has already been removed.

### Sequencing recommendation

Treat a focused command-admission/recovery regression as a prerequisite to relying on the two-stage workflow. Verify the
failure on a freshly built current integration in disposable fixtures, then preserve structured reasons, supported recovery,
outcome-appropriate verification, and bounded handling of an unchanged blocker through the existing runtime. Cover a
non-Git equivalent to keep the fix general. Preserve the completion gate's refusal to claim success without evidence.

Stage-one instructions can build on that correction; stage-two model/tool escalation must not turn an authority or
infrastructure failure into a more expensive retry of the same unavailable operation. The old tickets can remain closed
under their explicit closeout decision; this finding does not invalidate their delivered, separately tested fixes.

This follow-up changed only the review document. It did not repair the user's project, rebuild/reload the running
extension, change Linear status, or claim that the current integration has passed a reproduction of this trace.

## Unshipped Alpha-only patch — recommendation withdrawn

The [subsequent overfitting review](agent-overfitting-review-2026-09-05.md) found that this patch adds narrow
verification recipes while retaining the broader execution barrier. Its implementation and test results are historical
evidence, not a recommendation to ship it or proof that ordinary tasks are fixed.

The implementation adds structured pre-launch observation diagnostics to the existing command path. The result states
that no process started, preserves bounded observer failures without printing raw process errors, and supplies a supported
read-only diagnostic. It no longer recommends replacing an unavailable application operation with arbitrary metadata writes.
Mutation observation and approval requirements remain enforced; an unobservable mutation still cannot launch.

The existing verification resolver now recognizes narrowly scoped `postcondition` evidence. A fixed Git status command
with pager, filesystem-monitor helpers, untracked-cache updates, and optional locks disabled validates only the four
administrative paths in this trace. It verifies a repository rooted at the workspace and rejects corrupt indexes.
`python -m json.tool <file.json>` supplies a non-Git example: it validates that exact file's syntax. Neither check can
substitute for required application tests, types, or lint. Ordinary successful commands and file-existence checks still
do not count. Model guidance names the supported checks and requires copying the exact change-set identifier.

The host captures bounded file fingerprints, checks the current postcondition before crediting terminal evidence, and
revalidates credited postconditions before completion, including after reload without command history. If repository state
becomes invalid while recorded file bytes remain unchanged, the ledger expires the receipt by advancing its content
version. Replaying the old successful command cannot restore that credit. Readers still accept historical evidence kinds.

Regression fixtures cover the trace's malformed metadata, observation-cap rejection for Git and non-Git mutations,
admission of the advertised diagnostic, failing process exits, successful administrative completion, mandatory source
checks, cancellation, corruption after admission, and persisted verification after reload. No model tiers, routing,
call-count budgets, or recovery-attempt limits are changed.

This correction does not repair the user's project or make its rejected initialization successful retroactively. The
original invalid repository must still be reported as incomplete. The running development host must load a build containing
this change to exercise it; a unit test or extension-host smoke run is not a live-model replay of the original task.
