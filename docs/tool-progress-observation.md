# Tool progress observation (NOR-56)

## Initial repair, September 11, 2026

Source baseline: `2f8eb34a5cd4092676dc79a11b06430cb37d5288`. This change addresses successful Alpha Ticket
operations being counted as stagnation and productive work becoming stagnant when the observation history fills.
It is the first implementation increment of NOR-56, under NOR-47. It does not establish a general improvement in
live-model completion rates; that measurement belongs to NOR-48.

`TicketTools` previously returned successful results, but `Task.recordToolCallForStopping` classified them as `other`
and supplied only repository verification fingerprints. `ClineProvider.getVerificationProgressState` derives those
fingerprints from changed-file obligations. Deleting distinct tickets consequently looked like unchanged work.
The detector also stopped admitting new identities when its sets reached capacity.

## Contract

`ToolResultMetadata.trustedProgress` carries a host-produced read or mutation observation through `ToolSchedulerResult`
to the existing Task detector. It contains a stable resource scope and a semantic state digest. A mutation can supply
the previous state protected by its concurrency check. The scheduler copies metadata on receipt, validates bounded
scope/digests, and admits it only for successful terminal operations. It never extracts progress claims from result text.
There is no new approval, tool policy, provider-history format, or completion engine.

Ticket operations provide the first resource observer:

- Create confirms an absent resource becoming a stored ticket; delete confirms the returned stored ticket becoming absent.
- Update compares the persisted result with a read whose revision matches the revision checked by the store's transaction.
  An unprotected baseline cannot claim a delta. Existing revision checks still reject intervening external edits.
- Read fingerprints substantive ticket fields. List fingerprints the returned page, count, and invalid-file information;
  page order and timestamps do not create novelty. Different empty-search arguments do not create different observations.
- Scope includes project identity and, for individual tickets, the actual stored ticket ID. Call IDs, timestamps, raw revision
  hashes, and spelling differences in model arguments do not prove progress. Ticket contents are retained only as digests
  by the detector.

Resource progress is separate from repository state and validation evidence. A ticket mutation resets a stagnation streak
when its confirmed after-state is new; it cannot satisfy a test obligation or clear another operation's retry block.
An unchanged update cannot reset the streak. Existing failure allowances, unknown-effect retry protection, approvals,
cancellation, and terminal-result ordering stay in place.

Novelty sets retain recent identities with bounded least-recently-used eviction. Repeats refresh retention without earning
progress, so a frequently revisited no-op is not evicted merely because productive work fills the window. Fresh observations
continue to be recognized after rollover. This is a bounded observation window, not a proof that every historical operation
is unique: cycles whose entire working set exceeds the retained window need independent task budgets or further detection.
Unresolved failure records retain their existing stricter capacity policy and are not evicted by successful work.

## Deterministic reproduction

The isolated fixture in `Task.ticket-progress.spec.ts` redirects only the ticket profile root and uses the real ticket store,
tool registry, scheduler, and Task progress adapter. Its limit is deliberately small (`noProgressLimit: 2`, `historyLimit: 8`).
The current test also runs the deletion batch through `AgentTurnEngine` and verifies one final completion.

| Workload                                                                        | Baseline                                    | Candidate                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| 20 distinct deletions, serial scheduling                                        | 4 successful, 16 refused                    | 20 successful; stored ticket count is zero |
| Same deletion batch, selective-parallel scheduling (mutations still serialized) | 4 successful, 16 refused                    | 20 successful; stored ticket count is zero |
| 200 distinct scoped file/range reads                                            | First unrecognized read after 64 identities | All 200 recognized without stagnation      |

These are deterministic correctness and completed-work counts, not latency or live-model benchmarks. New regressions also
cover incremental ticket updates, changed-result rereads, pagination, empty-query churn, successful no-op updates, alternating
states after rollover, optional failures, and cancellation during deletion approval. Scheduler tests reject forged output
claims and malformed/nonterminal metadata and verify each accepted observation is delivered once.

Focused reproduction:

```sh
pnpm --dir src test -- core/task/__tests__/Task.ticket-progress.spec.ts core/tools/__tests__/ToolRepetitionDetector.progress.spec.ts
```

## Surface audit and remaining NOR-56 work

Validation on this increment: 548 tests passed across 22 focused/affected suites, including scheduler, Task persistence and
compaction, scheduled-task profile/approval, Copilot VS Code LM, and all three Vertex adapters. `pnpm --dir src check-types`
and `pnpm --dir src lint` passed; the two test files extended afterward also passed a focused lint check and a fresh typecheck.
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` passed all three real-host suites on exactly 1.122.1, including LM
tool-result history, follow-up resume, late cancellation, and provider-error recovery. These provider checks use fixtures.

The managed-agent strict certification also selects an existing `ChatView` replay test that skips unless
`ALPHA_COMPLETION_IDLE_EVIDENCE` names a real completion-idle capture. A default invocation passed 1,791 assertions but
failed strict certification because of that one skip; editing this design note during the same run also invalidated its
source-stability check. The existing `completion-idle.test` host scenario supports the scripted provider on 1.122.1 and
produces the required capture, including an actual 35-second quiet interval and a same-task follow-up. Use that captured
file for the replay and rerun `pnpm certify:managed-agents:automated` against an unchanged tree. The generated
`artifacts/certification/managed-agent-milestone-evidence.json` records the final source identity and deterministic result;
the separate managed-agent host run must also pass. No fabricated capture or skip allowance is appropriate.
The scripted capture scenario passed on 1.122.1 in run `nor56-completion-idle-01`, with owned host exit and complete evidence
retained under `F:/alpha-vscode-e2e-runs/nor56-20260911/artifacts/nor56-completion-idle-01`.

The managed-agent host scenario additionally exposed a scripted-driver error: its first targeted wait returned
`{ "timedOut": true, "events": [] }`, but the script advanced and later tried to complete with that child's result still
unconsumed. The persisted transcript and mailbox confirmed the missing consumption. The driver now repeats a timed-out
wait up to three times, retains the overall suite deadline, and uses a fresh tool-call ID for each attempt. Failed tools
still fail the scenario; the runtime completion guard remains intact. This exercises useful repeated waits instead of
assuming the child always finishes in the first 20-second interval.
The corrected scenario passed on 1.122.1 in run `fa0530e1-d4f4-45d2-a46c-cfc5ce549174`, including the repeated root wait
and successful parent completion. E2E package lint/typecheck also passed. The final deterministic certification is
refreshed separately after this test-driver correction; the extension code is the same as in the passing exact-host smoke.

- `Task` and `ToolScheduler` own this path for extension tasks regardless of provider or presentation surface. Scheduled prompt
  and skill runs enter the existing task-launch path with `background: true`; command-only runs use their direct command runner.
  Scheduled runs do not receive a separate detector. The Copilot VS Code LM and Vertex adapters
  do not receive or interpret progress metadata. Their reasoning/model selection changes remain NOR-44/45.
- Repository mutations and verification keep their existing obligation fingerprints. Supported shell inspection keeps its
  existing trusted semantic identity. Dedicated file reads still use the existing scoped call identity; general changed-result
  semantics beyond tickets need a separate bounded extension of this contract.
- MCP output remains opaque. A successful arbitrary server response is not authoritative semantic progress evidence. The
  remaining uncertainty policy must avoid both falsely declaring stagnation and trusting model-supplied claims; this increment
  does not solve that policy for all MCP tools.
- Managed-agent wait classification is repaired in the second increment below. Command-output polling retains its existing
  handling; tighter semantic observation of output reads remains open.
- Progress metadata is ephemeral; successful tool receipts and ticket effects use existing persistence. Scheduler deduplication
  remains authoritative for staged/persisted call IDs. Existing explicit-input reset and compaction behavior are unchanged;
  wider primary/child/background steering and crash/reload acceptance remains part of NOR-56.

Keep NOR-56 in progress until the remaining uncertainty/wait/lifecycle acceptance is covered. Do not infer that all NOR-47
work, or medium/hard task quality evaluation, is complete from these regressions.

## Efficient managed waits, September 11, 2026

The next increment balances successful resolution with the user's finite API-call allowance. The metric is useful results
delivered per model/tool round trip, retaining genuine incomplete outcomes. There is no new 10,000-call allowance per task,
no increase to the stagnation threshold, and no change to model, reasoning, approval, or verification authority.

The old Task adapter classified every `wait_agent` response as polling. Immediate `noActiveAgents` and `alreadyDelivered`
responses therefore bypassed the detector indefinitely. The same host also defaulted to 30-second waits, requiring a new
model request after each timeout when a child simply needed longer. This differs from the deadline/activity distinction in
the pinned Codex wait source linked in [core-completion-reliability.md](core-completion-reliability.md).

`WaitAgentTool` now classifies the in-process host envelope as active or idle and passes that ephemeral observation through
`ToolResultMetadata` and the scheduler. Only successful canonical `wait_agent` receipts can carry the observation. The
scheduler never reads it from tool text or admits it from an opaque MCP result. A timed-out blocking wait or a claimed
mailbox update can continue without consuming or clearing an existing stagnation streak. Empty fast paths use the existing
bounded recovery path, with one instruction to use available results or continue other work. Cancelled host waits now
retain `cancelled` status through the scheduler instead of being presented to the runtime as successful operations.
The same classification applies during completion recovery: another running child cannot exempt repeated empty waits
for an already-finished child, and those waits do not consume a verification-repair allowance or clear its obligation.

The default is 120 seconds, with the existing explicit 10–300 second range. Host and model-facing entry points share the
same default and validation; non-finite, fractional, or out-of-range direct host requests now reject before mailbox access,
instead of being clamped or accidentally creating a hot timer. Explicit valid durations keep their behavior. Results,
relevant input, and cancellation wake a wait early. No timer extends the child's frozen execution timeout: the existing
`BoundedDelegationManager` still owns that deadline, and root token/cost limits remain independent. A slow child is not
declared stuck solely because one wait timed out. Terminal publication that is itself stuck remains a separate recovery risk.

| Fixed workload                                                                                           | Before this increment                         | Candidate                                                                   |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| Empty waits, `noProgressLimit: 2`, scripted turn engine capped at 20 steps                               | Exhausted all 20 steps, no stall intervention | Incomplete after 4 steps, one recovery instruction, all 4 receipts retained |
| Child publishes one result at 95 simulated seconds; default waits, real provider mailbox and fake timers | 4 wait calls                                  | 1 wait call; same result delivered; no retained timer                       |

The second fixture removes three wait/model boundaries (75% of wait calls) for this workload without delaying delivery.
The first uses a deliberately small detector limit; production continues to use the configured limit. These are deterministic
regression counts, not live API usage, elapsed-time benchmarks, or evidence of a general solve-rate improvement. NOR-48 still
needs the extension adapter for matched Copilot/Vertex evaluation. Prompt guidance was shortened and aligned with valid
repeated waits; no live prompt-quality or token-cache claim is made.

Coverage includes primary/child Task adapters, serial/selective-parallel scheduling, metadata provenance, duplicate receipts,
active waits preserving prior strikes, useful recovery, cancellation, early activity, explicit/default deadlines, invalid
host deadlines, and timer/subscription cleanup. Background/scheduled tasks share the same Task adapter; this fixture does
not claim a separate live scheduled-run acceptance. Existing mailbox persistence/reload, steering, provider, and lifecycle
suites supply adjacent coverage. No persisted mailbox or public result envelope changes.

Focused reproduction:

```sh
pnpm --dir src test -- core/task/__tests__/Task.agent-wait-progress.spec.ts core/tools/__tests__/AgentLifecycleTools.spec.ts core/agent/__tests__/ToolScheduler.progress.spec.ts core/webview/__tests__/ClineProvider.subagents.spec.ts
```

The remaining NOR-56 work includes opaque MCP outcomes, changed-result file/command reads, long cycles beyond the retained
window, stuck terminal publication, and wider crash/reload and scheduled/background acceptance. Keep these separate from
the wait-call efficiency result above.

## Reads, external uncertainty, and repair budgets, September 11, 2026

This increment addresses the remaining reproduced core-loop failures using the existing scheduler, progress detector,
completion recovery, and request allowance. It does not change providers, model routing, execution authority, or saved
tool transactions. NOR-49 is explicitly limited to Copilot's `vscode-lm` provider; Vertex edit-tool preferences are excluded.

- File reads observe the returned slice or indentation block, excluding display headers and off-page file growth. Legacy
  batches carry up to 128 separate resource observations so reordered or regrouped batches cannot manufacture progress.
  A canonical batch identity also prevents a repeated batch larger than the resource history from evicting its own
  observations and appearing new on every pass.
  Images and extracted text use the displayed content. An admitted read observation replaces argument-only novelty.
- Command-output reads observe returned bytes or matched lines. Repeated immediate reads are no longer exempt merely
  because a command is running, including during completion recovery. Actual blocking agent waits retain their exemption.
  Different empty queries or unrelated log growth cannot reset the streak. The native schema explains immediate reads and
  use of the output cursor.
- MCP resource reads have host-known read semantics. Arbitrary MCP tool responses instead carry an opaque exchange digest
  of the resolved request and displayed result. Novel opaque exchanges may continue without proving progress or clearing
  existing strikes. Identical repeated exchanges consume the existing recovery window with explicit uncertainty feedback.
  Error, denied, running, and cancelled receipts never admit this allowance. Server claims do not grant verified effects,
  completion, or authority. The scheduler also demotes observations when its output limit removes part of the observed
  content, retaining only uncertainty about the delivered exchange.
- Known failed commands with host-captured verification scope use the existing `CompletionRecovery` file-version budget.
  The generic per-operation failure counter previously blocked the fourth failed check in a fixture even when its relevant
  file had been repaired between every attempt. The repaired fixture permits 20 relevant repair/check cycles. Unrelated
  changes cannot renew the unchanged file's eight-check allowance. Unscoped failures and unknown effects retain their
  existing retry protection. `CompletionGateDecision` now exposes the durable obligations it already carries at runtime.
- A finished command's stuck verification publisher is bounded by the existing 30-second settlement window, both during
  completion and result observation. It produces a recoverable incomplete outcome, preserving the outstanding operation;
  no synthetic successful receipt or second verification command is created. Healthy running commands remain governed by
  their execution deadline, with an existing fixture continuing beyond 60 seconds without another model request.
- The Task loop already records the current API request before approval preflight. Its request counter now counts that
  entry once instead of adding it again. Direct callers retain their unrecorded-request default. Approval resets retain
  the newly approved request and its eventual cost, even if preflight inserted other messages afterward. Configured limits
  and explicit user renewal remain authoritative; no new universal task cap or 10,000-call per-task allowance is introduced.

The final failure/recovery guidance adds one shared, short paragraph permitting productive repetition and proportionate
repair. Existing objective guidance already covers sufficient exploration, relevant verification, current evidence, and
finishing; those instructions are reused instead of duplicated. This implements NOR-38's runtime-aligned guidance portion.
Prompt mechanics are covered by offline contracts; behavioral improvement still requires NOR-48's matched live samples.

Regression suites cover successful reads, off-page changes, changed results, batch regrouping, partial denial, scheduler
truncation, opaque external outcomes, primary/child tasks, both scheduling modes, scoped and unrelated repairs, stuck
publication, compaction boundaries, and exact request accounting. Each newly reproduced failure was observed before its
corresponding fix. Required final validation includes extension lint/typecheck, affected suites, exact VS Code 1.122.1
smoke, and managed-agent certification. Record final results in Linear and the generated certification evidence after the
source tree is frozen.

Bounded novelty history is not proof against cycles larger than its working set or external output that changes only in
ways the host cannot interpret. Such sequences remain subject to configured request/cost limits and child deadlines;
explicit unlimited settings retain their meaning. Do not claim universal cycle detection or a live solve-rate gain.
The broader live scheduled/background/crash-recovery matrix and matched Copilot/Vertex quality campaign remain validation
work. A separate extension adapter is needed for the existing frontier task/grader campaign; the protected CLI and shim
must not be used as a substitute for the extension harness.

### Worker settlement failure found by the final host gate

The first final managed-worker host run (`bb9dbf31-e0fa-400c-920f-82280c4c8d77`, actual VS Code 1.122.1)
failed while discarding a proposal: Windows rejected its metadata rename with `EPERM`. The failed capture is retained.
Source inspection and injected filesystem failures reproduced two defects in `ManagedSubagentWorktreeService`: no bounded
retry for atomic replacement contention, and deletion of the proposal patch before the discard decision was committed.
The latter left pending metadata referring to a missing patch when persistence failed.

The existing metadata writer now retries only the same closed temporary-file rename for `EPERM`, `EACCES`, and `EBUSY`,
with the extension persistence layer's six-attempt / 775 ms backoff allowance. Other errors propagate immediately; permanent
contention remains bounded and preserves the previous snapshot. Discard commits its decision before patch removal and
retains the patch reference until cleanup settles. Repeating a discarded operation can finish interrupted cleanup without
replaying workspace mutations. The saved shape is unchanged, and applied proposals remain protected from discard.

Seven focused tests cover transient and permanent contention, non-contention failures, retained proposal bytes, temporary
file cleanup, and resuming both cleanup and its final metadata write. The six initial cases failed before the fix. This is
an extension-owned Worker settlement repair in the shared core package; neither protected CLI/shim subtree changes.
Final certification must be rerun on this source; the earlier 1,866-test deterministic pass predates this repair.
