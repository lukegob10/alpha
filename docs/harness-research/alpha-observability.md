# Alpha observability and diagnosis

Research date: **2026-09-18**. This note is source inspection of the current Alpha worktree at the time of review.
It is a durable map of the existing observability owners, their boundaries, and the smallest useful joins between them.
It does not claim that a test, live provider request, or VS Code host run was executed for this review. The historical
documents cited below are context only; current code and schemas are the evidence for current behavior.

## Findings at a glance

Alpha already has the pieces of a useful trace, with deliberately different authority levels:

- `AgentResponse.items` is the provider-neutral ordered response. The accumulator preserves response item order,
  holds streaming tool calls until they are complete, and keeps a provider error/incomplete/cancelled outcome from
  being erased by a later nominal success marker. The `AgentTurnEngine` then makes explicit terminal states rather
  than treating visible text as proof of success.
- The canonical lifecycle journal is the durable state machine. It stores validated JSONL events plus atomic snapshots,
  replays them through a strict reducer, rejects gaps/conflicting duplicates/illegal transitions, and requires every
  accepted tool call to have a terminal result before a turn can close. The extension projector treats a gap as a
  resync condition and preserves its last trusted snapshot.
- `AgentTurnEventLog` is a separate, additive diagnostic stream. It contains useful request, retry, usage, tool,
  approval, verification, timing, and terminal events, with bounded redaction. Its writes are intentionally
  best-effort so a telemetry write cannot turn a successful model or tool step into a task failure. It is therefore
  evidence when present, not the authority for lifecycle correctness.
- The E2E evidence capture path is the strongest existing bounded export pattern. It validates owned source roots,
  limits files/bytes/events, hashes source bytes, projects journals and transcripts, records incomplete evidence, and
  retains failed or uncertain runs. It is a good extension point for a user-facing diagnosis bundle.

The primary current weakness is a join problem. A `Task` knows stable `runId`, `turnId`, `stepId`, `requestId`, and
`attemptId`, but those identities do not travel together through all evidence surfaces. The canonical lifecycle schema
already has optional `correlationId` and `causationId`, yet the Task producer does not populate them. The additive event
log persists only `taskId`, `runId`, a per-run sequence, timestamp, and optional `StepContext` IDs. Telemetry is keyed
by `taskId` plus provider/model and usage. E2E projections deliberately remove most event identities. That is enough
to inspect one stream, but it makes a retry, a late usage drain, a child task, or a concurrent run hard to distinguish
across streams.

The second clear weakness is diagnosis export. The user-requested error report reads and writes the complete
`api_conversation_history.json`, while the E2E evidence path already proves that role/tool-shape and hashed IDs are
enough for a bounded first pass. A raw transcript can contain prompts, workspace content, tool arguments, tool output,
and provider data with no byte or redaction ceiling in this path.

The third weakness is attribution and timing. The scheduler records rich per-batch/per-call results and durations, and
the lifecycle journal records state transitions, but the canonical lifecycle tool result currently keeps only status and
output. The usage event has request index and token counters but no stable request or attempt ID, cost, cache-write, or
reasoning fields. Telemetry records aggregate LLM tokens/cost but has no run/turn/step/request join. There is no
end-to-end span from model admission through stream completion, tool effects, transcript commit, lifecycle append, and
webview projection. The mechanisms exist; the cross-layer evidence needed to explain latency or cost is incomplete.

## Evidence owners and authority

| Owner                                                                                                                                                                                                                               | Current behavior                                                                                                                                                                         | What it establishes                                                                                                             | Important limit                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AgentResponse.ts](../../src/core/agent/AgentResponse.ts#L13) and [AgentResponseAccumulator.ts](../../src/core/agent/AgentResponseAccumulator.ts#L43)                                                                               | Normalize provider chunks into ordered text, reasoning, tool-call, usage, grounding, and error items; keep an explicit response outcome.                                                 | What the provider-neutral response contained and whether the provider reported completed, incomplete, failed, or cancelled.     | It is an in-memory response boundary. It does not itself identify a model request, retry, persistence commit, or UI projection.                                                                |
| [AgentTurnEngine.ts](../../src/core/agent/AgentTurnEngine.ts#L6) and [AgentTurnEngine.ts](../../src/core/agent/AgentTurnEngine.ts#L116)                                                                                             | Host errors, explicit host status, provider status, post-step abort, ordinary visible text, and continuation are separate paths.                                                         | A turn outcome is explicit; failed/incomplete/cancelled provider responses cannot silently become ordinary text completion.     | The host still owns provider retries, transcript persistence, tools, and UI events.                                                                                                            |
| [AgentTurnEvents.ts](../../src/core/agent/AgentTurnEvents.ts#L15)                                                                                                                                                                   | Defines internal records for assistant commit/terminal, tool results/batches, approvals, retries, requests, usage, compaction, verification, child tasks, and task/turn terminal states. | A rich event vocabulary exists for local diagnosis, including durations, truncation, exit codes, and failure classes.           | The file explicitly says these are not UI messages, API history, or IPC records. The event union has no common task/run/turn/step/request envelope.                                            |
| [AgentTurnEventLog.ts](../../src/core/agent/AgentTurnEventLog.ts#L10) and [AgentTurnEventLog.ts](../../src/core/agent/AgentTurnEventLog.ts#L169)                                                                                    | Appends bounded/redacted JSONL records to `agent_turn_events.jsonl`; allocates a run ID and per-run sequence; enqueues writes without blocking the caller.                               | Present event records, their local order, timestamp, run, and optional step-context relationship.                               | The log is intentionally additive and best-effort. Task catches append errors, and the persisted wrapper lacks turn/request/attempt/correlation/causation IDs.                                 |
| [packages/types/src/agent-lifecycle.ts](../../packages/types/src/agent-lifecycle.ts#L4) and [packages/types/src/agent-lifecycle.ts](../../packages/types/src/agent-lifecycle.ts#L307)                                               | Canonical envelopes carry task/run/turn/event identities, optional step, timestamp, and optional correlation/causation references.                                                       | The intended provider-neutral lifecycle identity and event contract.                                                            | Correlation and causation are optional for compatibility, and current Task production omits both.                                                                                              |
| [AgentLifecycleJournal.ts](../../src/core/agent/lifecycle/AgentLifecycleJournal.ts#L140) and [AgentLifecycleJournal.ts](../../src/core/agent/lifecycle/AgentLifecycleJournal.ts#L242)                                               | Uses append-only JSONL, atomic snapshots, file locks, schema validation, reducer application before write, duplicate replay, and typed recovery errors.                                  | Durable lifecycle state and deterministic reload/replay.                                                                        | It is a state journal rather than a full trace. It does not retain provider request payloads or scheduler timing metadata unless the event payload carries them.                               |
| [reducer.ts](../../src/core/agent/lifecycle/reducer.ts#L554) and [agent-lifecycle.ts](../../packages/types/src/agent-lifecycle.ts#L606)                                                                                             | Enforces contiguous sequences, exact duplicate fingerprints, unique IDs, accepted-to-terminal tool-result ownership, and terminal metadata invariants.                                   | Whether the canonical event stream is internally coherent and whether a turn closed with all accepted calls settled.            | A coherent lifecycle stream does not prove a tool's process output was correct or that the provider usage was complete.                                                                        |
| [Task.ts](../../src/core/task/Task.ts#L3060), [Task.ts](../../src/core/task/Task.ts#L3161), and [Task.ts](../../src/core/task/Task.ts#L3260)                                                                                        | Captures run/turn identity, replays/resumes in-progress turns, produces lifecycle events, maps canonical response items, and closes tool results on cancellation.                        | The Task is the owner that can join canonical lifecycle state to step context and tool-call boundaries.                         | Its lifecycle envelope omits `correlationId`/`causationId`; tool-result projection carries output/status but not scheduler duration, exit code, timeout, truncation, or effect-fence metadata. |
| [AlphaProvider.ts](../../src/core/webview/AlphaProvider.ts#L2530) and [AlphaProvider.ts](../../src/core/webview/AlphaProvider.ts#L2687) plus [AgentLifecycleProjection.ts](../../src/core/webview/AgentLifecycleProjection.ts#L222) | Journals before projecting, detects gaps/conflicts, requests snapshots, marks one task degraded, and lets legacy transcript/session state remain usable.                                 | Whether extension-side UI state is based on durable lifecycle state or has fallen back to a degraded compatibility path.        | Projection recovery is visible as a task-scoped degraded signal, but that signal is not joined to an event-log sequence or request/attempt identity.                                           |
| [ProviderTranscriptStore.ts](../../src/core/task-persistence/ProviderTranscriptStore.ts#L152) and [ProviderTranscriptStore.ts](../../src/core/task-persistence/ProviderTranscriptStore.ts#L242)                                     | Stores revisioned, digest-checked transcript receipts and uses locks/atomic writes; Task verifies the authoritative history before effects.                                              | Whether the provider transcript boundary was durably committed and still matches before tool effects.                           | It proves transcript integrity, not lifecycle projection or provider cost attribution.                                                                                                         |
| [ToolScheduler.ts](../../src/core/agent/ToolScheduler.ts#L141), [ToolScheduler.ts](../../src/core/agent/ToolScheduler.ts#L297), and [ToolScheduler.ts](../../src/core/agent/ToolScheduler.ts#L1901)                                 | Returns structured call status, execution status, exit code, truncation, timeout, fingerprints, failure metadata, and duration; emits tool/batch/verification events.                    | A truthful result set, bounded output, per-call duration, and whether a verification-class command produced an observed result. | The detailed result is emitted through the additive event callback. The canonical lifecycle bridge currently retains only a bounded output/status projection.                                  |
| [TelemetryService.ts](../../packages/telemetry/src/TelemetryService.ts#L93), [BaseTelemetryClient.ts](../../packages/telemetry/src/BaseTelemetryClient.ts#L28), and [telemetry.ts](../../packages/types/src/telemetry.ts#L108)      | Captures task events and LLM input/output/cache/cost; merges provider/app/task properties and applies client filters.                                                                    | Aggregate product telemetry and usage/cost totals when telemetry is enabled.                                                    | Properties include task/provider/model but no run/turn/step/request/attempt/correlation identity. It is not a replayable local trace and may be disabled.                                      |
| [SettlementDiagnostics.ts](../../src/core/agent/SettlementDiagnostics.ts#L1) and [Task.ts](../../src/core/task/Task.ts#L5089)                                                                                                       | Returns bounded completion counters, command execution evidence, obligations, reservations, and truncation state.                                                                        | Why the completion gate accepted/rejected/waited and which bounded command/obligation evidence was available.                   | It is an in-memory projection of settlement state; it does not include the lifecycle journal or event-log timeline.                                                                            |
| [capture.ts](../../apps/vscode-e2e/src/evidence/capture.ts#L28), [capture.ts](../../apps/vscode-e2e/src/evidence/capture.ts#L290), and [capture.ts](../../apps/vscode-e2e/src/evidence/capture.ts#L447)                             | Captures bounded projected lifecycle/event/transcript evidence, source hashes, task evidence status, warnings, and file identity.                                                        | A reproducible, privacy-bounded E2E artifact with explicit incomplete/absent states.                                            | `projectJournalEvent` strips most IDs and payloads; the projection cannot currently stitch canonical and additive records beyond task/file context and hashed tool IDs.                        |

## What the current design already fixes or protects

The response path has a meaningful correctness boundary. `AgentResponse` makes the ordered item list authoritative,
while compatibility text and tool-call projections are derived from it. `AgentResponseAccumulator` emits text and
reasoning as chunks arrive, holds tool calls until completion, emits a tool call at most once, and carries usage/cost
and semantic errors into the finished response. Its outcome guard prevents a trailing provider finish marker from
erasing an earlier failure, cancellation, or incomplete state ([AgentResponseAccumulator.ts](../../src/core/agent/AgentResponseAccumulator.ts#L237)).
The engine then catches host failures, honors explicit host/provider status, checks post-step cancellation, and only
uses ordinary visible text with no pending continuation as an assistant completion ([AgentTurnEngine.ts](../../src/core/agent/AgentTurnEngine.ts#L120)).

The durable lifecycle path protects reload and UI convergence. `AgentLifecycleJournal` validates and redacts before
writing, reduces before appending, assigns the next sequence while holding the file lock, writes snapshots atomically,
and replays the journal on open ([AgentLifecycleJournal.ts](../../src/core/agent/lifecycle/AgentLifecycleJournal.ts#L242)).
The reducer is pure and rejects a gap, conflicting duplicate, or illegal transition ([reducer.ts](../../src/core/agent/lifecycle/reducer.ts#L554)).
The lifecycle snapshot keeps accepted and terminal tool-call IDs and processed event receipts, and the schema checks
their uniqueness and relationship ([agent-lifecycle.ts](../../packages/types/src/agent-lifecycle.ts#L606)).

Task-side cancellation and persistence repair the other common half of the transaction. The scheduler produces a result
for every accepted call, including deterministic cancelled or fence-failure results, while Task publishes terminal
canonical receipts before allowing the turn to close ([Task.ts](../../src/core/task/Task.ts#L3415),
[Task.ts](../../src/core/task/Task.ts#L9693)). The assistant provider boundary is committed before tool effects,
and the provider transcript receipt is rechecked immediately before effects ([Task.ts](../../src/core/task/Task.ts#L9585),
[Task.ts](../../src/core/task/Task.ts#L3035)). These are strong transaction guarantees even though the
diagnostic streams do not yet expose every scheduler field.

The extension bridge handles partial observability explicitly. An async production lifecycle publish persists through
the journal before projecting; a failed append or replay marks only that task degraded, and the session registry can
continue using the legacy transcript/session state ([AlphaProvider.ts](../../src/core/webview/AlphaProvider.ts#L2597)).
The projector holds the last trusted snapshot after a gap and accepts later deltas only after a complete snapshot
resync ([AgentLifecycleProjection.ts](../../src/core/webview/AgentLifecycleProjection.ts#L262)). This is a
useful distinction for triage: “lifecycle degraded” is an observability/presentation failure, not evidence that the
provider task itself succeeded or failed.

The E2E capture path supplies a concrete privacy and retention baseline. Defaults cap files at 1,000, one file at
256 KiB, task sources at 4 MiB, one JSONL line at 256 KiB, total output at 8 MiB, task IDs at 20, and events at 2,000
([capture.ts](../../apps/vscode-e2e/src/evidence/capture.ts#L28)). It requires the runner's ownership validator,
rejects source/evidence overlap, hashes bounded source bytes, and records warnings instead of treating incomplete
evidence as a pass ([capture.ts](../../apps/vscode-e2e/src/evidence/capture.ts#L344)). Journal projection accepts
only a closed set of event types and exports safe numeric/status fields and hashed call IDs; conversation projection
keeps roles plus hashed tool-call/result IDs and error bits, not text or arguments
([capture.ts](../../apps/vscode-e2e/src/evidence/capture.ts#L290)). Failed or uncertain runs are retained; only a
complete passed run with an observed owned host close can be marked inactive ([retention.ts](../../apps/vscode-e2e/src/evidence/retention.ts#L62)).

These protections are current source behavior. This review did not rerun their tests or a 1.122.1 host gate. The
historical [turn-completion investigation](../../docs/turn-completion-investigation.md) reports prior deterministic
regressions and test counts, but also says no affected user-task trace was available. It should therefore motivate
better evidence joins, not be treated as proof of the current worktree or of a particular incident.

## Verified observability gaps and their limits

**1. Cross-layer correlation is incomplete.** The `Task` creates `turnId`, `requestId`, and `attemptId` when it captures
the model-visible step ([Task.ts](../../src/core/task/Task.ts#L3561)); it also owns `runId` and the step number
([Task.ts](../../src/core/task/Task.ts#L758)). Those values are not consistently attached to evidence:

- `enqueueCanonicalLifecycleEvent` emits `version`, event ID, task ID, run ID, turn ID, time, optional step ID, type,
  and payload, but no correlation or causation reference ([Task.ts](../../src/core/task/Task.ts#L3060)).
- The additive log's durable wrapper has task ID, run ID, sequence, timestamp, and optional step-context IDs only
  ([AgentTurnEventLog.ts](../../src/core/agent/AgentTurnEventLog.ts#L21), [AgentTurnEventLog.ts](../../src/core/agent/AgentTurnEventLog.ts#L199)).
- The `request_usage` event uses `requestIndex` and a retry boolean, and carries input/output/cache-read counters;
  the producer does not add cost, cache-write/reasoning counters, request ID, or attempt ID
  ([AgentTurnEvents.ts](../../src/core/agent/AgentTurnEvents.ts#L60), [Task.ts](../../src/core/task/Task.ts#L8757)).
- Telemetry captures LLM counters and cost under task ID plus provider/model properties, with no run/turn/step/request
  identity ([TelemetryService.ts](../../packages/telemetry/src/TelemetryService.ts#L93), [telemetry.ts](../../packages/types/src/telemetry.ts#L108)).
- E2E projection intentionally drops raw IDs except hashed call IDs, so it cannot join two source streams by event or
  lifecycle identity ([capture.ts](../../apps/vscode-e2e/src/evidence/capture.ts#L290)).

This is a verified missing join, not evidence that the underlying IDs are unstable. It is most consequential when one
task has retries or late usage collection, when a background task overlaps a foreground task, or when parent/child
events are inspected together. `StepContext` does retain a sanitized diagnostic snapshot and request metadata in
memory, which is a useful owner boundary; the gap is that its IDs are not carried into every durable/exported signal.

**2. The detailed stream is best-effort and structurally weaker than the canonical journal.** Task deliberately catches
`AgentTurnEventLog.append` failures and says telemetry must not turn a successful step into a task failure
([Task.ts](../../src/core/task/Task.ts#L3044)). That is the correct authority choice, but a missing event can
make the local event stream look like a failed or incomplete action unless its missingness is recorded separately.
The event log writer bounds and redacts values ([AgentTurnEventLog.ts](../../src/core/agent/AgentTurnEventLog.ts#L83)),
but its reader validates only the outer task/run/sequence/timestamp and that `event.type` is a string
([AgentTurnEventLog.ts](../../src/core/agent/AgentTurnEventLog.ts#L297)); it does not enforce a contiguous sequence,
per-event schema, or one terminal result per call. That is acceptable for an additive diagnostic log but not for replay
or a claim that an event was durably observed.

There is also an information mismatch inside the existing streams. `ToolSchedulerResult` contains execution status,
exit code, truncation, timeout, fingerprints, failure metadata, and duration, and `tool_batch_finished` reports batch
parallelism and duration ([ToolScheduler.ts](../../src/core/agent/ToolScheduler.ts#L141), [ToolScheduler.ts](../../src/core/agent/ToolScheduler.ts#L1958)).
The canonical lifecycle bridge sends only call ID, status, and content to `tool_result_recorded`
([Task.ts](../../src/core/task/Task.ts#L3357)). This means the authoritative state can prove closure, while
the scheduler diagnostic stream can explain performance or process outcome only if its best-effort write survived.

**3. User diagnostics are not yet privacy-bounded by the existing evidence policy.** `generateErrorDiagnostics` reads
`api_conversation_history.json`, parses it, and writes `history` into a temporary JSON file; it has no history byte
ceiling or event projection ([diagnosticsHandler.ts](../../src/core/webview/diagnosticsHandler.ts#L21)). The
header asks the user to review the file, which is a useful human check, but the file is still generated and opened with
raw conversation contents. The E2E capture path demonstrates a safer default: bounded sources, hashed IDs, role/tool
shape projection, explicit incomplete warnings, and no raw logs in the artifact
([capture.ts](../../apps/vscode-e2e/src/evidence/capture.ts#L447)).

This gap does not mean the redaction policy is absent. Both lifecycle and additive event persistence have key-based and
string-pattern secret redaction and bounded values. The gap is that the diagnostics handler bypasses those policies by
reading the provider transcript directly. It also means raw prompt/tool-output disclosure is a user-support risk even
when no credential-like field is present.

**4. Cost and latency cannot be explained end to end.** The response accumulator carries usage and cost, Task aggregates
usage into the request message, and a late background usage drain updates the same request under an owner fence and
captures telemetry ([Task.ts](../../src/core/task/Task.ts#L8487), [Task.ts](../../src/core/task/Task.ts#L8898)).
That protects correctness against a newer request taking ownership, but the event/telemetry records do not say which
stable request/attempt they belong to. A `request_usage` record has only request index, retry flag, and partial token
counters. There is no single local trace that measures request admission, first/last stream chunk, late drain, tool
effects, transcript commit, lifecycle append, and webview delivery. Therefore a cost or latency discrepancy should be
reported as “unattributed/partial” when the join is absent, not inferred from aggregate task totals.

`buildAgentTurnTelemetryProperties` computes useful tool/retry/coercion metrics, but source search found it defined and
unit-tested without a production call site. That is a verified instrumentation disconnect, not evidence that its
metrics are wrong ([AgentTurnTelemetry.ts](../../src/core/agent/AgentTurnTelemetry.ts#L1); the only current
references are the implementation and [AgentTurnTelemetry.spec.ts](../../src/core/agent/__tests__/AgentTurnTelemetry.spec.ts)).

## Minimal evidence bundle that extends the current owners

The smallest useful bundle should be a projection, not a second runtime trace. Let the canonical lifecycle journal remain
the authoritative state and let the additive event log remain detailed best-effort telemetry. Add one bounded join layer
when a diagnosis or E2E capture is requested:

```text
bundle metadata:
  scenario/run/task IDs, actual host version, provider/model/effort, start/finish, outcome
  evidence completeness: captured | absent | incomplete, warning codes, source byte/hash metadata

per task/run/turn/step:
  taskId, parentTaskId/rootTaskId, runId, turnId, stepId
  requestId, attemptId, stepContextId, correlationId, causationId
  parent/child relation and local sequence/event IDs

per model request:
  started/first-chunk/last-chunk/committed times, attempt/retry, provider/model
  input/output/cache-read/cache-write/reasoning/cost, usage source, late-collection flag

per tool transaction:
  toolCallId, name/category, approval relation, accepted/result event IDs
  status/executionStatus, duration, exitCode, timedOut, truncated, failure code, bounded output hash/length

terminal diagnosis:
  lifecycle status/phase, completion-gate code and blocker, persistence/lifecycle degraded state
  transcript commit receipt status, journal sequence/recovery status, settlement counters and evidence completeness
```

The identity fields should be added at the owners that already have them. The canonical lifecycle envelope already
provides `correlationId` and `causationId`; producers should populate them for derived events such as tool results,
approval resolution, cancellation recovery, and the terminal event. The current `requestId` and `attemptId` should be
carried as bounded optional metadata on the step/request lifecycle records or in a small request event, rather than
reconstructing them from timestamps. Existing readers must continue to accept records without those fields.

The additive event wrapper can gain optional `turnId`, `stepId`, `requestId`, `attemptId`, `correlationId`, and
`causationId` fields while retaining old records. The Task already supplies the relevant IDs at append sites and can
mark an append as `durable`, `failed`, or `unknown` in a separate bounded diagnostic counter without changing the
success path. Do not make the best-effort log a prerequisite for lifecycle completion.

For tool details, either add optional bounded metrics to the canonical lifecycle tool-result item or include a
cross-linked scheduler projection in the diagnosis bundle. The latter is the smaller compatibility step: preserve the
current lifecycle item contract and project `durationMs`, `exitCode`, `timedOut`, `truncated`, and failure code from
the existing `ToolSchedulerResult`/`tool_result` event when it is present. Mark the field absent when the additive write
was lost; do not treat absence as success.

Usage and telemetry should use the same opaque local request/attempt join. Keep external telemetry free of prompts,
arguments, output, and raw IDs; a per-bundle pseudonym or a bounded one-way identifier is sufficient to join local
records. Cost and late usage should be represented as source-qualified observations, allowing a diagnosis reader to
distinguish provider-reported cost, calculated cost, late collection, and unknown.

The safe diagnosis export should reuse the E2E capture rules: owned source roots, explicit byte/event caps, symlink and
source-change checks, JSONL projection, hashed tool IDs, and a manifest that records incomplete evidence. Apply
user-only access controls appropriate to the platform; POSIX mode `0600` does not establish a Windows user-only DACL.
Verify the Windows access policy for any raw support export and report it as unverified if that check has not occurred.
Include lifecycle snapshots/journal projections, additive event projections, provider transcript receipt metadata,
settlement diagnostics, and telemetry summary. Keep raw conversation history out of the default bundle; if support
needs it, make that a separate explicit user-reviewed export with its own size ceiling and the same source marker.

## Failure triage path

Triage should classify the first broken boundary before interpreting text:

1. Start with the canonical lifecycle journal and snapshot. Replay it through the reducer; a recovery code such as a gap,
   identity mismatch, conflicting duplicate, or unresolved accepted call identifies a durable state problem. If replay
   succeeds, use the lifecycle status/phase and terminal item as the authoritative task boundary.
2. Join the same task/run/turn/step to the additive event projection. Use tool-batch durations, per-call status,
   verification result, approval decision, retry, request usage, and event-log write status to explain how the boundary
   was reached. A missing additive record is missing evidence, not a successful or failed event.
3. Check the provider transcript receipt and effect fence before attributing a tool failure to the provider. A missing
   or stale receipt means the Task intentionally blocked effects or could not durably save them; a lifecycle terminal
   event alone does not replace that transaction evidence.
4. Reconcile usage from the canonical response, request message, and late usage drain. If no request/attempt join is
   present, report token/cost totals as task-level aggregates and mark per-request attribution unknown.
5. Compare extension projection state with the journal. A degraded signal, resync request, or legacy fallback explains
   why the UI may differ from durable state; it should not be used to infer a model or tool outcome.
6. For completion issues, attach `SettlementDiagnostics` and the completion-gate reason/blocker/evidence state. This
   gives the model-repair and operator paths the same bounded explanation without exporting the raw transcript.
7. For E2E runs, treat `captureComplete`, task evidence status, warning codes, actual host version, and retention
   eligibility as evidence coverage. An absent or incomplete journal must remain visible as an evidence failure.

This path also answers “what changed, why, and did it help?” without overclaiming. The canonical response and lifecycle
reducers establish what the runtime accepted. The provider receipt establishes the persistence fence. The scheduler and
event log explain tool/provider mechanics when present. The bounded bundle establishes what can be independently
reviewed. A later green run is not proof of an earlier missing trace; the failed/partial bundle remains the evidence.

## Smallest implementation sequence

1. Add a backward-compatible correlation adapter at the Task lifecycle producer. Populate the existing lifecycle
   `correlationId`/`causationId`, and carry `requestId`/`attemptId` in bounded request/step metadata. Add the same IDs as
   optional fields to additive event-log records.
2. Add a local join projection that reads the canonical journal first, then joins additive events, transcript receipts,
   scheduler summaries, settlement diagnostics, and usage by the IDs already owned by Task. Record missing-source
   warnings and never synthesize successful outcomes.
3. Make the safe diagnosis path call that projection with the E2E caps. Keep raw history out by default and preserve the
   current explicit review affordance only for a separately bounded export.
4. Extend E2E `projectJournalEvent` to retain bundle-scoped opaque identities for event/run/turn/step/request/attempt
   and correlation/causation. Preserve its existing hashed tool IDs and incomplete evidence warnings.
5. Connect `buildAgentTurnTelemetryProperties` at the existing Task turn boundary if those metrics are wanted. Give the
   resulting event the same opaque turn/request join and measure capture coverage; do not assume a defined helper is an
   exported metric.

This is an extension of the existing response, lifecycle, persistence, scheduler, telemetry, settlement, and E2E
owners. It does not require a parallel tracing engine, a new hosted telemetry service, or raw prompt capture.
