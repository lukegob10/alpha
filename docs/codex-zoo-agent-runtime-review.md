# Codex and Zoo Code runtime review

Reviewed September 9, 2026 (America/New_York). This is a source comparison and implementation plan, not a production
fix or a performance benchmark. Existing uncommitted Alpha changes were preserved.

Implementation follow-up: [compaction/recovery results](compaction-recovery-implementation.md) records the discovered
archive-counting bug, corrected resume hydration, passing exact-host gate and six passing live Copilot attempts.
The findings below describe the pre-implementation comparison.

## Source baseline

| Project                                                                                              | Inspected revision                                                            | Scope                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Alpha                                                                                                | `127978c916897dd532b80ddfdb789f00f5a308fb`, plus the existing working changes | Extension runtime, provider, context management, completion, verification and live-test harness        |
| [Codex CLI](https://github.com/openai/codex/commit/a62e98d18c6550e3bea152ed1b89d1e931dca961)         | `a62e98d18c6550e3bea152ed1b89d1e931dca961`                                    | Rust core compaction, history, turn execution, task finalization, tool scheduling and regression tests |
| [Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code/commit/313ca59cbf0f809cf8066f51cd44510c63c850ef) | `313ca59cbf0f809cf8066f51cd44510c63c850ef`                                    | Extension Task, VS Code LM, condensation, context thresholds, resume races and prompts                 |

The upstream commit timestamps are September 10 UTC, still September 9 locally. Sparse source checkouts are retained
outside Alpha under `F:/alpha-upstream-review-20260909/`. Upstream code was inspected, not installed or executed.
The current [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) was also read;
source at the pinned revisions is the basis for the implementation findings below.

## Decision

For the reported extension failures, use Zoo's compaction policies and recovery regressions as comparative evidence
within Alpha's existing core. Use Codex for runtime contracts and test structure. The initial review below was too
narrow on Zoo; the subsequent [patch-level Zoo review](zoo-extension-reliability-review.md) examines its fresh-summary
context versus Alpha's summary-plus-tail policy, reversible recovery, and missing resume-hydration safeguards. Broader
presentation and rendering findings are secondary. Neither repository establishes a ready-made fix for Alpha's
observed compaction failure or justifies replacing the existing kernel.

The highest-priority work is an observable, reproducible compaction failure, followed by recovery across that failure.
Further prompt instructions have lower priority: the previous live batching experiment used 45 requests against 44
for its comparison baseline, with no reduction demonstrated. The successful fixtures did not reproduce the reported
verification loop. See [efficiency evidence](task-efficiency-ux-investigation.md) and
[long-conversation evidence](long-context-recovery-testing.md).

## What the comparison establishes

### 1. Compaction needs a precise result and a durable history boundary

Codex records compaction trigger, phase, implementation, outcome, error kind, elapsed time and token counts before and
after the operation. Its history replacement records the replacement window, retained context, window identity and
context baseline together. This makes a failure distinguishable from a successful request that did not install a
usable new context. Sources: [compaction lifecycle and metrics](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/core/src/compact.rs#L450),
[history replacement](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/core/src/session/mod.rs#L3880).

Alpha already preserves original messages with condensation markers, retains complete recent steps, validates tool
transactions, checks candidate size, and has a bounded truncation fallback. However,
[`summarizeConversation`](../src/core/condense/index.ts) uses the same `condense_failed` message for several different
conditions: transaction integrity, invalid tail counts, provider terminal outcome, empty normalized summary, and an
invalid or oversized candidate count. Automatic management can then return a fallback failure carrying that message.

The live evidence narrows the problem to this operation, not its exact rejection branch. Automatic condensation failed
after 17 completed turns; manual condensation also rejected after the twelve-turn recovery workload. A raw Copilot
stream contained nonempty text and reached EOF. That does not establish what the normalized stream or final candidate
contained. The attempted tokenizer-deadline adjustment did not fix the live case and was removed.

**Apply:** extend the existing compaction result with a bounded diagnostic reason and stage. Record counts of normalized
text/reasoning/tool items, the count method used, input/tail/summary/overhead totals, target, before/after history identity,
and whether replacement committed. Keep payloads and opaque provider data out of diagnostics. Preserve existing readers
and user-facing error translation; diagnostics must not become a second lifecycle store.

Use these receipts to reproduce the failing branch before changing acceptance or fallback behavior. A rejected candidate
must leave the original history usable. Do not accept a summary merely because the request returned text.

### 2. Copilot context accounting deserves its own adapter contract

Zoo explicitly separates the live VS Code LM window from the window used for condensation. Its implementation uses a
curated input limit and has tests for missing/unknown families and invalid limits. Its context percentage calculation
also supports measuring against available input after an output reservation. Sources:
[adapter](https://github.com/Zoo-Code-Org/Zoo-Code/blob/313ca59cbf0f809cf8066f51cd44510c63c850ef/src/api/providers/vscode-lm.ts#L572),
[threshold regressions](https://github.com/Zoo-Code-Org/Zoo-Code/blob/313ca59cbf0f809cf8066f51cd44510c63c850ef/src/core/context-management/__tests__/context-management.spec.ts#L1724).

Alpha already does part of this: [`buildVsCodeLmModelInfo`](../src/api/providers/vscode-lm.ts) chooses configured/static
limits and caps them against a finite live input limit. The failing live run reported an effective 200,000-token window,
not the approximately 922,000-token native advertisement. Simply copying Zoo's smaller-window method would therefore
not explain or fix the observed rejection.

**Apply:** capture one explicit budget decision at the existing immutable step boundary: native limit, selected/static
limit and source, effective input budget, output reservation, trigger and target. Manual and automatic compaction must
resolve these consistently; unknown output limits such as `maxTokens: -1` need explicit normalized semantics. Distinguish
native tokenizer results from conservative fallback estimates rather than treating either as unexplained numbers.
Keep provider-specific capability interpretation inside the adapter and shared budget calculations provider-neutral.

### 3. A completed turn should release ownership and admit the next input

Codex checks model continuation and pending user input before continuing. Its post-sampling rollover only runs when a
follow-up is needed. Finalization emits a terminal event, clears the matching active turn, flushes the terminal record,
and checks pending work. Sources: [continuation decision](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/core/src/session/turn.rs#L527),
[finalization](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/core/src/tasks/mod.rs#L827).

Zoo contributes a useful extension-specific race test: hold history loading open, evict the task, then release the read.
The abandoned instance must not overwrite saved messages or the task title. This test addresses stale persistence,
not proof of the exact composer lockup reported in Alpha.
[Zoo regression](https://github.com/Zoo-Code-Org/Zoo-Code/blob/313ca59cbf0f809cf8066f51cd44510c63c850ef/src/core/task/__tests__/Task.resume-eviction-race.spec.ts#L171).

Alpha already has explicit [`AgentTurnEngine`](../src/core/agent/AgentTurnEngine.ts) outcomes and
[`resumeCompletedTaskFollowup`](../src/core/task/Task.ts), which claims admission, joins the previous durable lifecycle,
and persists new input before exposing Running. Its resume path also preserves summary metadata. The live probes
successfully admitted repeated follow-ups, including a question after exhausting the injected empty-response budget.
An independently unrestartable completed thread remains unproven.

**Apply:** extend existing lifecycle/registry tests with compaction failure followed by immediate input, reload during
finalization, late provider output after cancellation, and eviction during history hydration. Use controlled promises
and assert one admission, one terminal result, intact history and a usable composer. Only modify ownership logic if a
test exposes a violation; adding another set of running/completed flags would increase risk.

### 4. Fewer model requests requires measuring continuation, not merely parallel execution

Codex has a shared tool runtime that retains the step whose tool list advertised each call and gates parallel versus
exclusive execution. Alpha already has a more restrictive selective-parallel scheduler with bounded concurrency,
scope conflict checks, approval boundaries and deterministic receipts. Preserve it.
[Codex scheduler](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/core/src/tools/parallel.rs#L117),
[Alpha scheduler](../src/core/agent/ToolScheduler.ts).

Five tools in one model response can use fewer model requests than five separately requested tools, even when effects
execute serially. Parallel execution alone cannot make the model choose that response shape. Alpha's earlier prompt
experiment demonstrates this limitation on the measured workload.

Alpha also already owns durable verification obligations and content fingerprints in
[`AgentControlStore`](../src/core/agent/AgentControlStore.ts), exposes verification context to the model, and detects
unproductive outcomes in [`ToolRepetitionDetector`](../src/core/tools/ToolRepetitionDetector.ts). Novel successful reads
currently reset stagnation. That is appropriate for legitimate investigation, but a succession of different reads can
continue without closing a task requirement. This is a candidate explanation for excessive exploration, not a live
reproduction of the complaint.

**Apply:** record model requests by work stage and continuation reason, separately from tool executions and tokenizer
calls. Distinguish already-satisfied verification from stale, missing, failed or still-persisting evidence using the
existing store. Investigate an advisory measure of exploration since the last meaningful task/evidence change; do not
make every new filename reset that advisory. Preserve research workloads and explicit user-requested verification.
Do not indiscriminately cache shell commands or skip tests whose external inputs cannot be proven unchanged.

### 5. Borrow test scenarios, not an assumption that upstream is flawless

Codex has useful scripted tests for repeated manual compaction followed by new questions, compaction after resume,
switching to a smaller-context model, and context-window rejection. Its pinned source also marks a manual non-context
compaction-error test ignored because the behavior is known incorrect. This is a reason to borrow the test pattern
while retaining Alpha's own acceptance criteria.
[Compaction tests and ignored case](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/core/tests/suite/compact.rs#L3861).

Zoo still nudges a text-only response into another tool call and retains an objective asking for tools one at a time.
Alpha's primary-task implicit completion and updated objective already improve on those particular behaviors.
[Zoo continuation path](https://github.com/Zoo-Code-Org/Zoo-Code/blob/313ca59cbf0f809cf8066f51cd44510c63c850ef/src/core/task/Task.ts#L3984),
[Zoo objective](https://github.com/Zoo-Code-Org/Zoo-Code/blob/313ca59cbf0f809cf8066f51cd44510c63c850ef/src/core/prompts/sections/objective.ts).

Codex selects compaction through provider capabilities and has a separate feature-gated context-window reset path.
That path skips model summarization; it is not a drop-in reliability fix for Alpha. The official configuration reference
describes experimental context management using notes and searchable history. Alpha would need an independently tested
retention/retrieval contract before adopting that approach. Copilot's VS Code LM API must not be assumed to expose
Codex's remote compaction protocol.
[Strategy selection](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/core/src/session/turn.rs#L1377),
[window reset](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/core/src/compact_token_budget.rs).

## Proposed delivery order and acceptance

| Priority | Bounded change                                                                          | Acceptance evidence                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Add precise compaction diagnostics and a deterministic reproducer; fix the proven owner | Regression fails for the observed reason before the fix, passes afterward; rejected/cancelled candidates preserve history; no extra sampling retry added                     |
| P0       | Exercise recovery across compaction and terminal persistence                            | Immediate follow-up, two successive compactions, reload, cancellation and hydration-eviction cases preserve exactly-once admission and complete tool transactions            |
| P1       | Resolve and record one input-budget decision                                            | Manual/automatic paths agree under known, unknown, selected and capped model limits; estimate fallback is visible; unsafe candidates remain rejected                         |
| P1       | Measure unnecessary continuation and strengthen existing progress guidance              | Representative excessive-exploration/verification case reproduced; fewer requests at unchanged correctness and required verification, with legitimate investigation controls |
| P1       | Project useful runtime status into the existing chat UI                                 | Stage, elapsed time and request count are understandable; recovery shows what is happening; admission failure restores the draft; completed/failed threads can accept input  |

For the UI, use the existing canonical lifecycle projection. Examples are “Preparing conversation”, “Checking changes”
and “Reconnecting, attempt 1 of 2”. Surface a specific recovery failure instead of implying that all failures mean the
model was silent. Developer diagnostics belong in retained evidence, not the main chat. Localize new text and preserve
keyboard focus. A future “Stop and summarize” action must settle owned work and truthfully report incomplete checks.

For regression testing, reuse the current synthetic long-context workload and scripted provider infrastructure.
Reconstruct the relevant provider-part semantics, including prototypes, opaque state and response ordering, without
logging raw private provider payloads. Drive the real adapter, compaction and lifecycle boundaries; a mocked success
return from `summarizeConversation` cannot cover this failure. Cheap deterministic replay should precede another live
run, rather than spending another eighteen calls to rediscover the same generic error.

After a proven fix, run the retained 32-turn live recovery workload through actual automatic condensation, injected
empty recovery, manual condensation, a post-compaction question and the independent code grader. Also run the
twelve-turn empty-exhaustion workload through its previously failing manual-compaction stage. Keep the same Copilot
model, effort, profile and fixture for comparison; retain failed runs. One pass is a regression signal, not broad
reliability proof. Additional model/repeated samples belong to release confidence after these cases pass.

For efficiency, compare request count, requests before first edit, duplicate unchanged checks, time after last edit,
completion correctness and token usage on a small edit, bug fix, multi-file change, broad investigation and a failing
check with an external edit. Count model generation separately from tokenizer and tool calls. Do not claim faster
execution from smaller prompts, fewer displayed tools or a single successful run.

Runtime changes require affected unit/transform/persistence/cancellation tests, touched-package lint and typechecks,
and `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`. The authenticated 1.136.1 Copilot profile remains supplemental;
it does not replace the exact 1.122.1 compatibility gate. `apps/cli` and `packages/vscode-shim` remain outside scope.

## Review validation

This review checked the referenced Alpha and pinned upstream source and nearby regression tests. Only this document
was added in this turn. No production code changed, no new live Copilot requests were made, and no runtime test pass,
performance gain or fix is claimed. Markdown paths and revision references were checked locally.
