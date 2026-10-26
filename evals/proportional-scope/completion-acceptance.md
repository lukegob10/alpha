# Final-stage acceptance protocol

This fixture measures completion settlement in actual API-created Tasks. Its offline provider fixes model decisions;
model strategy and physical verification quality require separate observations. Preserve the workload, settlement
schedule, and quality oracle when comparing source revisions.

## Fixed workloads and provider policy

Use `apps/vscode-e2e/src/suite/proportional-completion.test.ts` on exact VS Code 1.138.0. Each revision runs
three fresh Tasks per scenario in one shared host, using identical fixture source, input, configuration, conditional
provider policy, and settlement schedule. Record each source revision and loaded extension bundle digest. Run builds
and host measurements serially.

It uses structural adapters for existing runtime observation methods so the identical compiled fixture can run against
the reference bundle, which lacks the metrics getter. No production code from the candidate may enter the reference build.

After the centrally owned build and source/bundle provenance declaration described in the main fixture README, select
`ALPHA_COMPLETION_EXPECTATION=reference` or `candidate`. This role changes assertions and report labeling only; it never
changes the provider policy or settlement timing. Compile the same fixture for both runs, then invoke from
`apps/vscode-e2e` in the directory without spaces:

```sh
node ./out/runTest.js --vscode-version 1.138.0 --provider scripted --file proportional-completion.test
```

Require matching reported fixture and policy digests for the pair. The fixture digest covers the loaded test JavaScript
and its shared cleanup/provenance helper. Source/build metadata also covers the checkout and actual extension bundle.

The fixed Task input is: "This workspace needs no changes. An existing verification operation is already in progress;
finish once its terminal receipt is durable. Do not start another command."

The offline provider returns the ordinary-text candidate "No further workspace changes are needed." It emits no tool
calls. If the runtime requests recovery after that candidate, the same provider policy waits for the existing operation's
durable-settlement promise, then returns exactly the same text. It never starts another operation. The recovery branch is
present in both revisions; do not shorten scripts, change input, or condition behavior on revision or metrics availability.
An unexpected third request fails the fixture safety bound rather than yielding an unbounded stream of candidates.

The on-screen host also has a user review boundary after the native completion gate succeeds. The fixture acknowledges
only an observed `taskAsk.ask === "completion_result"`, once per sample, using the Task's standard `approveAsk()` path.
It never acknowledges Resume, command, tool, or follow-up asks. In settlement scenarios that review must occur after the
original operation settles. This simulated user acknowledgment is identical in both roles, counted separately in
`completionReviewAcknowledgements`, and is neither a model request nor a tool call. The final visible answer can use the
canonical `say:completion_result` row produced when ordinary streamed text is promoted for final presentation.

Two scenarios isolate distinct runtime boundaries:

1. **Running command and evidence publication.** Before the first candidate, a controlled terminal adapter registers one
   operation through the real Task's `beginCommandExecution`. Its first completion-gate decision must reject completion
   while that operation is running. At 1,000 ms after this observed decision, the adapter supplies one successful terminal
   outcome through `completeCommandExecution`. The provider's publication wrapper waits until 1,500 ms after the same
   decision, then invokes the original `recordParentVerificationEvidence` method and resolves the settlement promise only
   after it succeeds. The wrapper affects only the measured Task. This scenario models terminal delivery; it does not
   launch a physical command or establish that a workspace check passed.
2. **Durable no-op mutation receipt.** Before the first candidate, use the real provider's `reservePrimaryMutation` to
   reserve one no-op operation. Its first completion-gate decision must reject completion. At 1,000 ms after that observed
   decision, use `releasePrimaryMutation` and resolve settlement only after the durable release succeeds. No changed-file
   debt is invented or waived: this operation has no file changes.

Observe the gate with a pass-through wrapper that calls the original method exactly once per runtime invocation. Never
probe it separately: baseline gate reads consume rejection allowance. Start the settlement schedule once, from the first
resolved disallowed decision, independently of later requests. Keep publication work outside the workspace mutation gate
owned by the finalizer. Gate results, evidence, and persistence remain production-owned. Timer delays define a controlled
workload; they are not a measured speedup or substitutes for state/barrier assertions.

After the first delayed publication settles, later provider reconciliation must call the original publisher without
reopening the delay. Subscribe to Task completion before starting; retain event-handler failures for the sample oracle.
Flush transcript persistence before inspecting final evidence. For the no-op case, inspect the real obligation state to
confirm empty changed-file scope and removal of the exact reservation, rather than treating reservation release as a
successful verification result.

The Task completion event precedes the owning loop's terminal journal flush. After the event, await the public
`Task.waitForTermination()` boundary with a 30-second fixture deadline before flushing transcript persistence and reading
final state. Preserve the assertion that the AgentControlStore root is completed; a completed event alone cannot satisfy
the durable quality oracle.

## Quality oracle and declared cost threshold

Every admitted sample must satisfy all of these conditions:

- The first real gate decision is disallowed and completion has not occurred before settlement.
- The original publication or no-op release succeeds; the running-command scenario retains the same execution identity
  and exactly one terminal success record. No replacement command or model-emitted tool call occurs.
- The Task completes, emits exactly one `TaskCompleted` event, preserves the ordinary answer in its visible transcript,
  and reaches no `resume_task` boundary. The native final completion gate succeeds. Pending or failed runs remain quality
  failures and cannot enter a completed-task cost or latency comparison.
- Cleanup releases every owned barrier/timer, restores instrumented methods and configuration, clears the Task and fake
  provider cache, and preserves primary failures. A report is emitted only after cleanup succeeds.

Cleanup releases its controlled barriers before attempting Task cancellation, then restores patched methods before joining
publication. Each cancellation, join, reservation release, and configuration restoration has an independent five-second
cleanup deadline. Deadline failures preserve the original test failure and cannot skip later cleanup actions. A controlled
host-independent regression expires injected deadlines for stuck publication and cancellation promises without sleeps,
checks method/cache cleanup continues, and verifies late promise rejection remains observed. A failed cleanup invalidates
the sample and stops subsequent samples; it is never admitted as a measurement.

The candidate threshold is **one provider request, zero recovery requests, and zero model-emitted tool calls** in every
sample. When metrics are available, require `candidateCount: 1`, `rejectionCount: 0`, `repairToolCount: 0`, and a positive
`runtimeWaitMs`. First-candidate, persistence-settled, and completed timestamps must be ordered. These counters are
Task-lifetime observations, not exclusive phase measurements.

The expected paired baseline is two requests: one candidate plus one conditional recovery. A baseline must actually
observe at least two requests while meeting the same quality oracle before claiming a reduction. If baseline already
finishes in one request, record unchanged optimal behavior. If baseline blocks, report a completion-correctness difference
and its observed wasted requests separately; do not turn an incomplete run into a latency or equal-quality cost baseline.
Require all three paired samples per scenario to meet quality before reporting scenario-level savings. This narrow
runtime regression can support a request-count improvement attributed to the tested completion change. Whole-task
tool/command improvements require a separate workload and comparison.

## Measurement and attribution

Capture every actual `fake-ai.createMessage` invocation with request ordinal and UTF-8 system-prompt bytes, JSON message
bytes, JSON tool-schema bytes, and emitted assistant-text bytes. Report full-request and post-first-candidate request
counts. Environment bytes are a subset of messages and must not be added again. Preserve source/build/configuration,
fixture/policy digests, scenario sample index, shared-host sample index, and declared host/cache state. Keep raw prompts,
messages, paths, commands, IDs, and operation fingerprints out of reports.

Count terminal evidence registration separately from physical command launches and model-emitted tools. The controlled
command scenario has one evidence registration, zero physical command launches, and zero model-emitted tool calls. Do not
describe zero physical launches as a tool reduction.

The optional runtime metrics getter returns cumulative Task-lifetime counters, first-candidate usage, persistence-settled time, and
completed or blocked usage snapshots. User-guidance recovery can reset its allowance without resetting these metrics.
Retain this provenance separately from canonical per-request event usage. An absent getter on baseline is unavailable,
not zero. Do not infer per-phase usage from timestamp order or subtract noncumulative `contextTokens` values.

The scripted provider has no measured provider usage. Synthetic `countTokens` values only prevent fixture compaction;
zero aggregate Task usage does not establish zero cost. Provider input/output/cache token measurements and the proposed
20% whole-task input-token target remain **unavailable**. Actual request bytes may be compared as bytes, never relabeled as
tokens. First-candidate-to-completion and runtime-wait durations are diagnostic only until a separately authorized,
uncontended paired timing experiment is declared.

Conversation-only and narrow-lookup fixtures retain their existing one- and two-request thresholds. Their counts may
already be optimal. Do not add exploration classifications, caching, or prompt policy to manufacture further savings.
