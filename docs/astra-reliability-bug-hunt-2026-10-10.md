# Astra reliability bug hunt — October 10, 2026

## Scope and reference

This is a follow-up reliability audit of Alpha's shared agent harness, tool transactions, chat recovery, provider
history, managed delegation, and native workflow extras. Five independent audit tracks use `gpt-6-astra` with `max`
reasoning. The environment permits three workers alongside the parent, so the five tracks run in waves. Fresh Astra/max
workers implement confirmed findings, followed by combined validation. This pass improves verified failure paths; it
does not establish complete Codex parity or guarantee that external tools cannot fail.

Codex CLI's current `main` was rechecked through the GitHub connector at **2026-10-11 01:37:17 UTC**:
[`cc7ba33601286a751477832b01de7b6f8de0dd9c`](https://github.com/openai/codex/commit/cc7ba33601286a751477832b01de7b6f8de0dd9c),
committed October 10 at 22:28:01 UTC. Alpha's sandbox and its skills, Tickets, HTML previewer, and scheduled tasks remain
intentional native extension capabilities. VS Code **1.125.0** remains the exact reference host.

The starting checkout already contained 42 modified or untracked files. Their hashes were recorded before this
pass. The original 16 user-authored code-search changes are preserved: 12 files retain their original hashes, and four
have narrow integrations for artifact reads and custom-tool test context. Full preimages of the command integration
paths were captured before editing. Earlier verified fixes are described in
[`codex-workflow-bug-hunt-2026-10-10.md`](codex-workflow-bug-hunt-2026-10-10.md) and are part of this pass's starting state.

## Audit tracks

| Track                | Investigator             | Focus                                                                                         |
| -------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| Tool execution       | `astra_tools_audit`      | Scheduler admission, approvals, command yielding, receipts, cancellation and session identity |
| Chat recovery        | `astra_chat_audit`       | Turn ownership, terminal repair, queue receipts, persistence, retry and follow-up             |
| Provider consistency | `astra_providers_audit`  | Streaming and nonstreaming history, opaque state, signatures, usage and terminal outcomes     |
| Managed delegation   | `astra_delegation_audit` | Authority, root budgets, close/follow-up, durable delivery and failure rollback               |
| Workflow extras      | `astra_extras_audit`     | Scheduled tasks, Tickets, skills, HTML preview and settings flow                              |

The repository inventory helper was run as an initial map, then refined against repository-owned paths. Its raw counts
include downloaded VS Code distributions and generated outputs; those trees are excluded from code review and edits.
This is a harness and workflow audit, not a repository-wide style, dependency, release or infrastructure sweep.

## Confirmed findings and closure ledger

All 13 ledger findings and their adjacent integration fixes are implemented. Independent review and final automated
gates passed. Before-fix results below record failures at the intended assertions, after correcting fixture setup
mistakes; they are not final gate results. Two additional Astra/max app chats independently reviewed tool/chat flow and
persistence/reload after the user requested additional chats.

| Severity            | Finding                                                                                     | Before-fix evidence                                                                                                             | Current closure                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| High / must-fix     | Anthropic thinking blocks lose opaque state or signatures before tool continuation          | Six failures across streaming/nonstreaming; two normal signed-block controls pass                                               | Fixed; adapter and replay tests pass                                   |
| Medium / should-fix | Anthropic cumulative output usage is counted repeatedly                                     | Provider totals `1 → 5 → 9` become `15`, expected `9`                                                                           | Fixed; cumulative counter controls pass                                |
| Medium / should-fix | A post-transcript queue deletion failure duplicates durable tool results and human guidance | Real abort and normal recovery each save two copies; transcript-save-failure control passes                                     | Fixed; commit-fence recovery tests pass                                |
| Medium / should-fix | Delayed nonzero command exits become failed tool transactions                               | Two `write_stdin` cases return `is_error: true`; immediate `exec_command` control returns `false`                               | Fixed; command and terminal tests pass                                 |
| Medium / should-fix | Truncated command output has no callable native retrieval path                              | Actual receipt instructs retired `read_command_output`; replacing it with hidden `manage_command` also fails real retrieval     | Fixed; Code and Plan artifact tests pass                               |
| Medium / should-fix | A before-run notification blocks scheduled admission                                        | Four controlled cases: pending or rejected toast prevents prompt and command starts                                             | Fixed; advisory notification tests pass                                |
| High / must-fix     | Closing a child erases its spend from root budget admission                                 | Token and cost cases fall from `50,000 / $5` to `10,000 / $1`; new admission incorrectly succeeds                               | Fixed; close/reload accounting tests pass                              |
| High / must-fix     | Failed follow-up publication strands an agent as pending                                    | Mailbox or parent-group write failure leaves a pending record with a completed runner; retry buffers instead of restarting      | Fixed; atomic admission and rollback tests pass                        |
| Medium / should-fix | Deleting the last closed child's history loses frozen root limits                           | Two independent review cases correctly reject with history, then admit after public deletion and reload with increased defaults | Fixed; expanded deletion/reload proof passes                           |
| Medium / should-fix | A completed command poll conceals retained unread output                                    | Two real Execa receipt cases omit the tail or all output while reporting `truncated: false`; a second poll recovers it          | Fixed; both terminal providers and bounded delivery tests pass         |
| High / must-fix     | Custom callbacks bypass Ask approval and durable effect admission                           | A denied custom call still executes; approved order lacks both approval and effect-start                                        | Fixed; approval, admission, captured mode and cancellation tests pass  |
| High / must-fix     | Resume deletes committed tool results and guidance before new input commits                 | Cancellation at a controlled preparation barrier leaves the saved transcript without its committed user tail                    | Fixed; append-only resume and independent repair/steering proofs pass  |
| High / must-fix     | Resume replaces historical input provenance and revives revoked authorization               | Reload and retained-history revocations select the older instruction; hook input becomes human-authorized                       | Fixed; resume, live steering, retry, grant and hook-origin proofs pass |

### Anthropic history and accounting

`AnthropicVertexHandler` previously emitted unsigned reasoning text and retained a single last signature. Redacted thinking was ignored.
The legacy Task fallback then drops signed empty thinking or merges multiple thinking blocks under the last signature.
The regression follows the real adapter, accumulator, Task persistence, JSON reload, request projection, and next provider
request. Both direct Vertex and gateway Claude routes use this adapter.

The typed stream, canonical accumulator and existing history projection now preserve each signed or redacted block in
order, including signed empty blocks. Output indices keep separate provider blocks separate, and request-local signature
state is published only after successful completion. Interrupted tasks retain valid sealed reasoning without assigning a
completed block's signature to an unsigned partial block.

[Anthropic's current thinking contract](https://platform.claude.com/docs/en/build-with-claude/thinking) requires unchanged
thinking and redacted blocks during tool continuation. The
[streaming contract](https://platform.claude.com/docs/en/build-with-claude/streaming#event-types) specifies cumulative usage.
The adapter must normalize cumulative counters into the shared additive usage contract. Current
[SDK accumulation](https://github.com/anthropics/anthropic-sdk-typescript/blob/2979ed5cef4b2f059b95af23e08728c01e588f86/src/lib/MessageStream.ts#L580)
replaces signature deltas; concatenating them was ruled out and is not a proposed fix.

### Transcript success and queue acknowledgment

`Task.flushPendingToolResultsToHistory` previously awaited queue deletion before retiring the content snapshot that had
already been saved. A deletion-save error leaves those results staged. Actual abort finalization and subsequent normal
recovery append them again. Provider request normalization suppresses identical duplicate result blocks, so the evidence
does not establish a provider protocol rejection; saved history and repeated human guidance remain incorrect.

The fix retires precisely the durable snapshot at transcript success, before fallible queue settlement, while retaining
concurrent new content and pending deletion retry. A failed transcript save still retains unsaved results. The same commit
fence now resolves a durable follow-up admission receipt before independent queue deletion; otherwise a saved instruction
could remain unacknowledged. Rejected acknowledgment callbacks remain observable. Mailbox acknowledgment exceptions were
ruled out as the original duplication trigger because production settlement already catches them.

### Command receipts and output retrieval

The native command contract distinguishes a successful tool transaction from a nonzero process exit. `exec_command`
already returns a successful transaction containing the process error and exit code. `write_stdin` incorrectly returns
a tool error for the same known exit. The owning result mapping now preserves genuine cancellation, timeout,
signal, and infrastructure failures. This defect does not produce `outcome_unknown`.

`formatCommandToolResult` recommended the retired `read_command_output` alias for persisted output. A real retrieval test
then showed that `manage_command` was also absent from the native catalog. The complete fix adds an exclusive artifact read
branch to the existing `write_stdin` tool and delegates to the existing bounded, task-owned artifact reader. The actual
receipt recommends `write_stdin` with `artifact_id`. Plan advertises only that read branch and runtime validation rejects
terminal sessions or input. Numeric session behavior, serial scheduler metadata, ownership checks and retired tool names
remain intact. This is an intentional Alpha output-retention extension to Codex's command contract.

Current Codex unified-exec handlers and tests preserve completed receipts, exit metadata and session cleanup. Alpha's
existing `executeCommandTool.spec.ts` also establishes its transaction distinction.

The added exact-host workflow found one more integration gap in this same artifact contract. Canonical artifact reads
succeeded with successful tool results, but the native parser's separate chat projection still rejected artifact
arguments and logged false failures. Its complete and streaming argument guard now accepts the same exclusive artifact
branch while retaining numeric-session validation. The first Plan host assertion also expected plain UI text instead of
the existing `<proposed_plan>` completion envelope; the fixture now verifies that envelope alongside the canonical plain
assistant text and one terminal event. This is a parser/projection correction and a fixture correction, not evidence that
the retained artifact operations failed. Final host results are recorded below after those corrections.

The audited parallel-read producer uses a UUID execution identity, while the artifact reader previously accepted only
numeric filenames. A real `rg` reproduction therefore saved an unreadable artifact and emitted another hidden
`manage_command` hint. The shared filename contract now recognizes both existing numeric names and the producer's strict
lowercase v4 UUID names. Its native schema and reader use the same constant, and the producer recommends `write_stdin`.
History rewind cleanup requires affirmative UI and API transcript-save receipts and retains files named in either
transcript. Deletion is limited to validated pre-rewind candidates removed by that rewind; new or untracked output is
preserved. Even unchanged API memory is re-saved before cleanup, because a previous failed write may have left disk behind.

After awaited directory reads and prior unlinks, the owner synchronously rechecks current references, active work, and
queued or pending input immediately before each unlink begins. Controlled filesystem and queue-persistence barriers cover
those admission windows. A reference admitted after deletion has already begun is outside this cleanup guarantee. The
independent reviewer cleared this bounded existing cleanup path without adding a separate lifecycle engine.

### Scheduled notifications

`ScheduledTaskService.startRun` awaits the informational before-run toast. The queue processes starts serially, so an
undismissed toast prevents both its own task and later schedules from starting. A rejected notification similarly loses
admission. The notification preference is advisory; actual command approval has a separate modal path. Notification
delivery is detached and caught without widening command authority or changing durable run admission.

### Managed budget retention and follow-up admission

Root budget accounting enumerates retained control records and live tasks. Closing a terminal child removes that control
record; its historical spend is no longer enumerated, even though its task history remains. Closing a child must release
runtime capacity while preserving its cumulative contribution to the root's frozen token and cost limits, including reload.

Follow-up admission changes a terminal child to pending before publishing its mailbox event and parent group. Failure at
either write leaves the child pending without an active runner. A retry then follows the message-buffering path for pending
agents instead of launching a new turn. Admission failure must remain retryable without dropping or duplicating durable
instructions or reopening a child whose runner has already started. An optional committed follow-up event ID survives
prelaunch rollback and reload. Retry reuses that instruction; replacing its text is rejected. A started generation keeps
ownership and cannot be rolled back by the failed admission.

The independent integration reviewer reproduced a further case through public history deletion: spending survives in a
tombstone, but frozen orchestration limits do not. After the final child closes and its history is deleted, reload can
adopt increased or unlimited current settings. The regression uses exact-limit normal completion, which the live `>`
budget check permits while admission's `>=` check correctly rejects. Frozen root limits now remain durable alongside
closed-agent accounting through optional validated orchestration metadata; this is separate from retaining spend alone.

### Additional chat findings

The two additional app chats produced four independently reproduced defects beyond the original nine. Their audit
snapshots and primary-source evidence are in
[`astra-additional-tool-chat-review-2026-10-10.md`](astra-additional-tool-chat-review-2026-10-10.md) and
[`astra-additional-persistence-review-2026-10-10.md`](astra-additional-persistence-review-2026-10-10.md).

A completed command poll can retain unread bytes while reporting a complete receipt with no retrieval hint. The
second poll proves the bytes are still present. Receipts now expose `has_more_output`, retain the numeric session until
the output is drained, and report truthful truncation metadata without describing the exited process as running.
Both terminal providers capture this information with a receipt; cursor advancement still requires successful delivery.

Custom tool descriptors declare approval-required external effects, but their wrapper previously invoked the callback
directly. Both Ask approval and the scheduler's durable effect-start fence were bypassed. The wrapper now uses the existing
canonical approval callback, captures mode from the step, and checks cancellation before dispatch. A fixed `custom_tool`
approval discriminator prevents custom names from inheriting built-in automatic-approval exemptions. The optional public
callback signal enables cooperative cancellation; arbitrary callback code cannot be forcibly stopped by the scheduler.

`resumeTaskFromHistory` previously deleted and saved the committed user tail before preparing its replacement. Cancelling
that preparation loses tool results, human guidance and receipt metadata. Even when all writes succeed, flattening old
and new user records selects an earlier task-creation instruction after a later revocation, or relabels hook-generated
input as human authority. Preserve chronological message envelopes and append only new input; historical provider roles
must not create new authorization.

### Adjacent resume regression found during integration

Independent review added a controlled steering-during-preparation proof. When resume stages a missing tool-result repair,
the pending-steering merge replaces its persistence callback. The next input save succeeds and the provider boundary sees
the repaired history, but resume's finalizer still considers the repair uncommitted and restores the old in-memory prefix.
A later save then removes the already committed repair and fresh input. Both retained-history and disk-reload cases fail;
two no-repair controls pass. The callback replacement predates this audit, while the append-only repair finalizer exposed
the same latent problem in the ordinary reload path. This is an adjacent integration regression under resume durability,
rather than an additional original audit finding.

The proof is in
[`Task.resume-steering-commit.astra-review.spec.ts`](../src/core/task/__tests__/Task.resume-steering-commit.astra-review.spec.ts).
The fix binds repair retirement to the actual saved snapshot, preserves every uncommitted admission callback through
steering, and joins each callback once even when one rejects. The pending flag retires before propagating those errors.
Three low-level tests distinguish matching snapshots, older queued snapshots, and failed sidecar commits. Failed saves
still roll back only uncommitted staging.

Further review of the same input-provenance finding reproduced a live-steering variant. A fresh task-creation revocation
or grant could be ignored because the merged record's first `<user_message>` wrapper supplied authority. Image-only human
steering could also stamp earlier agent or hook guidance as human. The new
[`Task.steering-authorization.astra-review.spec.ts`](../src/core/task/__tests__/Task.steering-authorization.astra-review.spec.ts)
recorded **eight failing regressions and four passing controls**, using durable queued steering at preparation and
post-save pacing boundaries, the real native catalog, and actual independent-task admission. The fixture stops before
task creation; ordinary tool approval is deliberately granted and remains intact.

The fix preserves chronological typed user-message envelopes and their original origin, hook provenance and queue IDs.
Uncommitted original input and fresh steering share one existing atomic save/acknowledgment fence. Steering after a
commit appends fresh input without popping or restamping the saved record. Authority parsing and wire formats remain
unchanged. The earlier reviewer proof deliberately updates its expected record count from four merged records to five
ordered records while retaining its one-commit, repair, provider-boundary, memory and disk invariants.

A deterministic manual-retry proof found an equivalent boundary: steering arriving while the retry notification is
published inherited the committed input's retry attempt and skipped saving the fresh instruction. Fresh steering now
starts at attempt zero, while only genuinely uncommitted predecessor records are staged. Both an ordinary retry and a
retry after an earlier split input preserve each record once and honor the latest human instruction. This extends the
same provenance fix rather than adding a new finding to the ledger. The independent reviewer cleared the final source
and ran its four repair cases plus both retry variants; all six passed.

Relevant pinned upstream contracts are
[contextual user-message classification](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context/contextual_user_message.rs#L51),
[hook provenance tests](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context/contextual_user_message_tests.rs#L147),
and [retained authorization](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context_manager/history_user_authorization.rs#L143).

## Reproduction commands

```sh
pnpm --dir src test core/tools/__tests__/ManageCommandTool.astra-audit.spec.ts --maxWorkers=2
pnpm --dir src test core/task/__tests__/Task.result-ack-durability.astra.spec.ts --maxWorkers=2
pnpm --dir src test api/providers/__tests__/provider-history-roundtrip.audit.spec.ts --maxWorkers=2
pnpm --dir src test services/scheduled-tasks/__tests__/ScheduledTaskService.before-run.astra-audit.spec.ts --maxWorkers=2
pnpm --dir src test core/webview/__tests__/AlphaProvider.delegation-astra-audit.spec.ts --maxWorkers=2
```

Before-fix counts are respectively **3 failed / 1 passed**, **2 failed / 1 passed**, **7 failed / 2 passed**,
**4 failed**, and **4 failed**. The provider investigator also ran the existing Anthropic Vertex, VS Code LM contract and Gemini format
suites: **94 tests passed**. Narrowly escalated pnpm execution was required after sandbox `EPERM` on workspace realpath.

The native parser reproduction recorded **16 failures and 25 passing controls** before the fix; all **41 cases** now
pass. The real parallel-read/reader reproduction recorded **3 failures and 78 passing controls**. Cleanup reproduction
recorded **6 failures and 33 passing controls**, followed by a separate failing real queue-admission barrier case. The
final artifact/retention run passes **139 tests across four files**, including 30 rewind cases. These targeted counts
overlap broader runs and are not additive.

## Final validation

The final combined affected-surface run passes **987 tests across 30 files**. It includes provider round-trips,
transcript acknowledgment, resume/steering/retry, custom approval, command receipts, parser projections, numeric/UUID
artifact retrieval, rewind persistence and cleanup, delegation, and schedule notification boundaries. Root `pnpm lint`
passes all eight tasks, and `pnpm check-types` passes all nine tasks. The complete shared-types suite passes
**404 tests across 41 files**.

The rebuilt final source passes **55 exact-host tests across 18 launches**. Every runner receipt reports actual VS Code
**1.125.0**, verified host ownership, complete capture, exit code zero, `requireAllTests: true`, and no failed or pending
tests. Seventeen launches use scripted providers; one uses the VS Code LM fixture. Each uses an isolated runner-owned
temporary profile, released after success.

| Exact-host gate                          | Passed tests | Launches |
| ---------------------------------------- | ------------ | -------- |
| Required `test:smoke:1250`               | 42           | 13       |
| Command artifact workflow, Code and Plan | 2            | 1        |
| Core-loop boundaries                     | 4            | 1        |
| Scheduled-task acceptance                | 5            | 1        |
| Managed-agent acceptance and fan-out     | 2            | 2        |

`pnpm certify:managed-agents:automated` exits zero. Strict certification passes **26 deterministic requirements** across
10 tracks, reporting **3,277 passing test executions**, no failures, skips or todo cases, and unchanged source during the
run. Track executions overlap; they are not an additional unique-test count. The two managed-agent host scenarios above
also pass after certification. Eight existing live/integration requirements remain explicitly pending, including
billable-provider behavior, full restart/process ownership, multi-window storage writers and real UI timing. The live
playbook preflight uses stubs and is not a live-model evaluation.

Commands, final run IDs, verification fields and certification source hashes are preserved in
[`astra-reliability-validation-2026-10-10.json`](astra-reliability-validation-2026-10-10.json). The generated certification
evidence is [`managed-agent-milestone-evidence.json`](../artifacts/certification/managed-agent-milestone-evidence.json).
Final report updates were saved after the gates; code and test sources remained frozen. Earlier interrupted runs and the
initial Plan fixture assertion failure are excluded from the final cohort.

Final diff checks and scoped formatting pass. No dependency, lockfile, release-version, host-baseline or generated tracked
artifact changes were introduced by this pass.

## Compatibility and limits

All behavior changes use Alpha's existing TypeScript harness, task-owned artifact reader, approval callbacks and atomic
transcript storage. No runtime, sandbox, production dependency or host baseline was replaced. The workflow catalog now
contains 24 tasks, including 14 Astra additions; its command-artifact host scenarios exercise real command output in
Code and a seeded retained artifact in Plan.

The new public cancellation signal, command receipt field, pending follow-up ID and tombstone accounting/orchestration
fields are optional. Existing saved data remains readable. Chronological input envelopes use the existing `ApiMessage`
origin, hook and queue metadata; no wire migration or authorization-parser change is required. Original transcript
records remain intact while provider adapters continue their existing request projection.

Older records that already lost signed thinking, input provenance or closed-agent evidence cannot be reconstructed
reliably. No heuristic migration invents authority for already merged input. An older tombstone without retained limits
still needs surviving historical manifests to recover those limits. Cooperative custom callbacks must observe their
signal themselves. Persistently unavailable storage can still prevent recovery; bounded retries do not manufacture a
successful commit. Deterministic fixtures and exact-host tests establish these covered contracts, not live-model quality,
general performance gains or complete Codex CLI parity.
