# General task efficiency: research and proposed design

Date: September 5, 2026. Status: researched proposal, not implemented.

## Desired behavior

Alpha should use the smallest complete workflow that satisfies the user's requested outcome and required verification.
The user wants two broad approaches: direct handling for narrow requests and comprehensive handling for broad work.
Both must avoid redundant calls. Git is one motivating trace, not a routing rule or a dedicated feature.

Use the existing execution kernel. Effort is separate from execution mode, approval, tool authority, and model choice.
A comprehensive explanation can be read-only; a one-line destructive request can need substantial safety checks.
Message length, command name, file extension, and the mere occurrence of an error cannot determine task difficulty.

The [reviewed trace](nor-36-local-git-trace-review-2026-09-05.md) ended because the user pressed Stop. Its duration is an
observed lower bound on the continuing attempt, not evidence that an automatic stopping policy worked.

## Upstream evidence

The following primary sources were retrieved on September 5, 2026. Source patterns establish implementation choices,
not a measured speed ranking. No equivalent live task was run across these products.

| Reference                     | Revision / retrieval                          | Relevant behavior                                                                                                                                   | Implication for Alpha                                                                             |
| ----------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Codex CLI                     | `588b781ab4924ce7352488394028e63d74cf807f`    | The base prompt skips plans for simple requests, avoids rereading successful edits, and starts validation narrowly.                                 | Put proportionate work into the normal agent workflow.                                            |
| Codex CLI turn implementation | Same revision                                 | Continuation depends on pending model work/input; stop hooks can also request continuation.                                                         | Ordinary completion is a normal exit, with explicit continuation causes.                          |
| Pi                            | `da840b6216578c2a571d0374ac6a2091a83f9d91`    | A small default tool surface and optional workflow extensions; its loop exits when no tools or queued messages remain, subject to configured hooks. | Avoid mandatory orchestration overhead on direct requests.                                        |
| Oh My Pi                      | `feba7f113fd041542afac0f44c0d3529b81c50a6`    | Optional automatic thinking classifies each prompt using a small online model or a local model, then maps difficulty to supported effort.           | Adaptive reasoning is feasible, but classification itself costs time and sometimes a remote call. |
| Cursor CLI                    | Official documentation, retrieved September 5 | Ask, Plan, and Agent modes; planning documentation recommends direct Agent use for quick changes.                                                   | Support intent-sensitive workflow depth without making every task a planning exercise.            |

Codex is the closest architectural reference. Its
[base instructions](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/protocol/src/prompts/base_instructions/default.md)
and [turn loop](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/session/turn.rs)
show prompt-directed judgment coupled with runtime-controlled continuation. These inspected paths do not establish a
universal automatic small/large classifier. Model-specific instructions and extensions can change behavior.

Pi's [default workflow](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/coding-agent/README.md)
uses four default tools and leaves plans and subagents to extensions. Its
[agent loop](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/agent/src/agent-loop.ts)
processes tool calls and steering, checks queued follow-ups, and ends when no continuation remains. Alpha should retain
its own approval, verification, and persistence guarantees rather than copy Pi's different security assumptions.

Oh My Pi's [auto-thinking implementation](https://github.com/can1357/oh-my-pi/blob/feba7f113fd041542afac0f44c0d3529b81c50a6/packages/coding-agent/src/auto-thinking/classifier.ts)
selects effort, not an investigation call budget. Its online backend resolves a tiny/small model and makes a completion
request; a local backend uses coarser difficulty buckets. It clamps the result to supported effort levels, reports usage,
and documents caller fallback on failure. Its
[system prompt](https://github.com/can1357/oh-my-pi/blob/feba7f113fd041542afac0f44c0d3529b81c50a6/packages/coding-agent/src/prompts/system/system-prompt.md)
also skips trivial todos and makes some orchestration conditional. These capabilities are useful references, not proof
that adopting its full workflow would reduce Alpha's calls.

Cursor documents [CLI modes](https://cursor.com/docs/cli/using) and
[planning guidance](https://cursor.com/docs/agent/plan-mode), including suggestions based on complex-task keywords.
Its private scheduler, prompt, stopping heuristics, and token budgets were not available for source inspection. Do not
invent a hidden Cursor classifier or claim measured superiority from documentation.

OpenAI's [reasoning-effort guidance](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort) distinguishes
effort from tool use: lower effort generally favors latency/token cost, while higher effort serves harder reasoning.
That is a separate tuning axis from how many operations the harness asks the model to perform.

## Why Alpha wastes work

1. **Broad persistence guidance has a weak operational boundary.** The objective already requests proportionate work,
   but generic recovery can turn an unavailable operation into repeated alternative activity. More adjectives in the
   objective alone will not fix this.
2. **New activity can count as progress without resolving the blocker.** `ToolRepetitionDetector.recordOutcome()` resets
   stagnation on fresh state, evidence, or a novel read. These can be useful signals, but a new file/read does not prove
   that an infrastructure failure was repaired. Recovery of a stable failure needs separate accounting.
3. **Task evidence and runtime capability failures are conflated.** Missing factual evidence can justify investigation.
   A denied operation, unavailable observer, or failed persistence service requires a different response. The recorded
   command error loses this distinction.
4. **Some required checks do not express the requested outcome.** An administrative operation's observable postcondition
   and a source edit's applicable test coverage are different forms of evidence. A universal requirement for a test/lint
   command can produce irrelevant checks. Generalize result/receipt semantics while preserving stronger requirements
   where they apply.
5. **Runtime cost amplifies every unnecessary request.** The trace's serial lifecycle publication delays tools and Stop.
   Fewer calls help, but the same overhead also penalizes necessary calls in comprehensive work.

Owning paths: [`objective.ts`](../src/core/prompts/sections/objective.ts),
[`ToolRepetitionDetector.ts`](../src/core/tools/ToolRepetitionDetector.ts),
[`ExecuteCommandTool.ts`](../src/core/tools/ExecuteCommandTool.ts),
[`VerificationScope.ts`](../src/core/agent/VerificationScope.ts),
[`StepContext.ts`](../src/core/agent/StepContext.ts), and the existing lifecycle publication path in
[`Task.ts`](../src/core/task/Task.ts).

## Recommended policy

### One loop, two approaches

| Dimension       | Direct                                                                                   | Comprehensive                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Typical request | Answer a fact, inspect a known item, make a bounded change                               | Inventory all relevant items, audit, diagnose across components, implement a substantial feature |
| Investigation   | Use existing evidence first; resolve only missing facts that affect the answer or action | Establish coverage and pursue relevant hypotheses across the requested surface                   |
| Planning        | No mandatory plan/todo call                                                              | Plan meaningful dependencies and coverage when useful                                            |
| Execution       | Perform the required operation and inspect its outcome                                   | Work through dependent stages; batch independent read-only work                                  |
| Verification    | The smallest sufficient check for the actual outcome and risk                            | Required checks across affected surfaces; reuse still-valid results                              |
| Stopping        | Stop when the requested outcome and applicable checks are satisfied                      | Stop when requested coverage/outcomes are satisfied, not after arbitrary extra polish            |

The model chooses this approach in its existing request, using user intent, known scope, uncertainty, and consequence.
The first implementation does not add a separate classification model call, a mandatory planning tool, or a new engine.
Replace overlapping prompt rules with a concise decision rule; do not append another large process checklist.

Initially this remains model-directed judgment, not a hard classifier pretending to understand every request. Runtime
controls below enforce observable invariants regardless of the chosen approach. If explicit automatic effort selection
is later added, capture its value/provenance in the immutable `StepContext`, preserve it for retries, and derive a new
snapshot on subsequent steps. Fixed user-selected effort remains fixed; provider capability checks stay in adapters.

### Expand because the evidence warrants it

Direct work can expand when evidence reveals a materially broader dependency, contradictory results, concurrency/stale
content, or a correctness/security risk necessary to the original outcome. An explicit user request for comprehensive
coverage selects that approach immediately. Expansion needs a concrete reason and does not add unrelated deliverables.

An unavailable tool is not itself evidence that the user's objective grew. Keep the original outcome stable while
deciding whether the obstacle has an authorized, supported repair.

### Make continuation and recovery explicit

At existing step/tool boundaries, use one continuation decision derived from canonical state:

| State                                                                          | Next action                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Required work remains and a useful supported action is available               | Continue with that action                                    |
| An accepted operation is still running or its receipt is being persisted       | Runtime waits under its cancellation/timeout contract        |
| A tool returned a correctable argument or stale-context error                  | Use the supplied correction or refresh the affected evidence |
| A transient transport failure has retry allowance                              | Existing retry policy handles it                             |
| A stable capability, authority, or persistence blocker has no supported repair | Report the blocker and end the attempt incomplete            |
| Outcome and applicable verification are satisfied                              | Finalize through the existing completion path                |

Extend the existing structured tool-result contract with bounded failure metadata as needed: reason code, retryability,
operation-started state, affected scope, and supported recovery. Preserve `success`, `error`, `denied`, and `cancelled`.
Generic error text must not invite a different tool to bypass the same restriction. If failure occurred after launch,
preserve unknown-outcome debt and resolve it before retrying any mutation.

Track recovery against the unresolved reason and its relevant capability/content/configuration version. Unrelated reads
or edits cannot refresh that recovery allowance. A genuinely repaired dependency or new user instruction can allow a
fresh attempt. Use existing retry/progress/completion mechanisms, with one owner for each failure class.

Prefer an actionable terminal blocker to an unbounded series of creative workarounds. Ending incomplete must never be
presented as task success, and it must retain the information needed to resume safely.

### Avoid redundant evidence and validation work

Before another read or check, distinguish new coverage, changed content, changed configuration, and still-valid evidence.
Use existing current read/write receipts and verification records where they prove what is needed. Do not introduce a
path-only read cache or suppress a necessary fresh read. Reuse requires available content/ranges plus valid versions,
authority, configuration, and scope; compaction or external changes can invalidate it.

An accepted edit receipt is evidence that the edit applied. It is not a substitute for a requested behavioral test.
A successful test for an unchanged affected surface need not run again merely because the model is preparing its final
answer. Comprehensive work needs a coverage record, not repeated full-repository rediscovery after each stage.

### Keep runtime overhead proportional to the data

Batch durable lifecycle response publication with bounded event/byte sizes, preserving response order, IDs, reasoning
metadata, tool transactions, replay, and before-effect durability. Check cancellation between batches. Reuse the existing
journal and reducer; do not create a parallel lifecycle store. This benefits every task size independently of policy.

## Implementation order

1. **General failure/continuation contract:** expose reasons, distinguish pre-launch rejection from unknown outcome,
   and prevent unchanged infrastructure failures from acquiring fresh repair allowance through unrelated activity.
2. **Lifecycle publication and Stop:** reproduce the trace's fragment distribution in a deterministic benchmark, then
   remove per-fragment transaction overhead without weakening the durability barrier.
3. **Proportionate workflow instructions and evidence reuse:** consolidate existing instructions into the direct/broad
   rule, preserve requested coverage, and address only demonstrated redundant reads/checks at their owning layer.
4. **Optional automatic reasoning effort:** compare fixed effort with adaptive alternatives, including classifier
   latency, retries, and tokens. Adopt only if total task quality/cost improves. Do not silently change the selected
   provider/model or make effort control a permission mechanism.

Steps 1 and 2 fix demonstrated cross-task defects. Step 3 needs live strategy measurements as well as deterministic
mechanism tests. Step 4 is a separate measured decision, not a prerequisite for the earlier improvements.

## Concrete implementation plan

### Decision rule and ownership

Scope and execution condition are independent. The model judges what the user is asking for; the runtime supplies
trustworthy operation state and enforces its existing policy and lifecycle contracts. A runtime error must not silently
change the requested deliverables. A short request can still require broad work, and a long request can specify one
bounded operation precisely.

The normal model request should support this sequence without an extra classifier or planning round trip:

1. Identify the requested outcome and explicit coverage, using the current conversation and applicable instructions.
2. Use direct handling when available evidence supports a bounded path. Use comprehensive handling when the requested
   coverage or known dependencies require it. If scope is uncertain, make the narrowest useful discovery before expanding.
3. Choose an action that resolves a necessary unknown, advances the requested outcome, or verifies a required condition.
   Runtime recovery follows the failure contract below; it does not add deliverables.
4. Reassess after results. Expand only for a concrete dependency, contradiction, material risk, or changed user request.
5. Finish when the outcome and applicable verification are satisfied, or explain an unresolved blocker when no supported
   route remains. Do not add activity merely to demonstrate persistence.

These are concise strategy instructions, not a mandatory visible checklist or a tool call before each action. Version one
does not add a persisted `small`/`large` label: a label would not itself make judgment accurate. Existing step snapshots
capture the instructions and effective capabilities used for that decision. Model choice and user-selected reasoning
effort remain unchanged. Evaluate actual behavior before adding a structured scope field or another policy surface.

### Change 1: Make failure recovery bounded and actionable

Extend the existing tool metadata in [`BaseTool.ts`](../src/core/tools/BaseTool.ts) and its scheduler projection in
[`ToolScheduler.ts`](../src/core/agent/ToolScheduler.ts). Add optional, validated failure information with a stable reason,
whether effects started, whether the outcome is known, affected scope, and a supported recovery category. Older results
remain readable; missing metadata means unknown, not safe-to-retry. Generate this metadata at the trusted tool/runtime
boundary, never by accepting arbitrary command output as recovery authority.

Start with the demonstrated command-observation failure, then cover equivalent admission, stale-context, and process
outcome cases through shared contracts. Preserve the underlying failure category instead of discarding it in
`ExecuteCommandTool`. Replace generic continuation guidance in `Task` with guidance derived from these outcomes. Keep
the decision logic in focused agent modules and the integration wiring in `Task`.

Use the existing retry policy for transient transport failures. For a correctable operation error, allow a targeted repair
and reevaluate the relevant dependency. The same unchanged blocker cannot gain a new recovery allowance from unrelated
reads or writes; successful repair of that dependency can reopen it. Non-retryable rejection with no supported repair
requires no speculative retry. Unknown mutation outcomes must be resolved before repeating the effect.

Blocking one operation does not necessarily block the whole task. An independently supported, authorized alternative can
still satisfy the original outcome. The runtime enforces the actual failed capability or authority boundary; it must not
infer that every different tool is a bypass, or that every different tool is safe. Semantic task sufficiency remains model
judgment, with canonical verification evidence used wherever the runtime has an explicit contract.

Regression coverage belongs in scheduler, repetition/progress, command-tool, and real `Task` tests. Assert exact effect
counts and terminal outcomes: rejected operations never launch, unrelated novelty never renews unchanged recovery,
relevant repairs permit another attempt, optional failures do not prevent an otherwise complete answer, and blocked work
is never reported as success. Reconcile this change with the current shared completion implementation before editing it;
do not introduce another completion engine.

### Change 2: Remove lifecycle amplification

Use the recorded distribution of 2,150 reasoning fragments as a deterministic persistence workload. Benchmark journal
transactions, publication time, and cancellation latency separately from model and tool time. Replace per-fragment
publication transactions with bounded batches in the existing journal path, keeping canonical item order and all
durable-before-effect barriers. Cancellation must be observed between bounded units of work.

Extend [`Task.persistence.spec.ts`](../src/core/task/__tests__/Task.persistence.spec.ts) and the existing lifecycle journal
tests to compare canonical replay and tool transactions before and after batching, including cancellation and failed
writes. This change improves both direct and comprehensive tasks independently of model strategy.

### Change 3: Consolidate strategy and expose usable evidence

Replace overlapping proportional-work instructions in `objective.ts` and the relevant mode/tool guidance with the decision
rule above. Apply the same scope principle to planning requests: a narrow plan should not require a repository audit.
Preserve instruction authority and explicit user requirements. Prompt tests check the intended contract, but cannot prove
that a live model follows it.

Before adding evidence caching, inspect what current tool results and verification records already supply to the next
step. Improve those receipts only where a measured redundant call comes from missing information. Reuse current content
and validation with their scope/version/configuration identity; invalidate them on relevant edits, external changes, or
lost content after compaction. Do not equate an applied edit with a passing behavioral test.

The expected behaviors are concrete:

| Workload                                | Expected behavior                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Answer already grounded in conversation | Answer with no forced tool, todo, or classifier call                                                       |
| Inspect one known setting               | Read the relevant source if needed; answer without broad discovery                                         |
| Make one bounded change                 | Inspect necessary context, apply it, verify the applicable outcome, finish                                 |
| Perform a local administrative action   | Check necessary preconditions, perform the supported operation, verify its postcondition, finish           |
| Inventory all of a requested surface    | Establish and satisfy coverage; reuse evidence across stages                                               |
| Investigate a cross-component failure   | Pursue relevant hypotheses and dependencies; expand when evidence requires it                              |
| Small request encounters a blocker      | Keep the outcome stable, use supported bounded recovery, then complete or explain the remaining limitation |

These are workload contracts, not fixed production tool-count limits. Required instructions and newly discovered risk
can justify additional work. Deterministic fixtures can assert exact counts because their necessary work is known;
arbitrary live tasks cannot be safely governed by the same exact counts.

### Change 4: Evaluate and decide on adaptive reasoning separately

Run the existing proportional-scope fixtures and paired live workloads against each change independently, then together.
Keep direct and comprehensive results separate. Count every request, including classification if later tested, and include
failures and interruptions. Reject apparent savings caused by omitted deliverables, incomplete coverage, skipped required
checks, or weakened admission policy.

Ship runtime fixes based on their correctness and measured local effects. Treat prompt-driven call reductions as an
empirical result requiring repeated live samples. Consider automatic reasoning effort only after this baseline; it solves
a different problem and must beat fixed effort after its own overhead is included.

## Validation and acceptance

Extend the existing NOR-36 workload families rather than create a competing evaluation harness. Include conversation-only
answers, known-item lookups, tiny edits, local setup/administrative work, broad inventories, cross-component bugs, security
work, and deceptively simple tasks that correctly expand. Cover non-Git examples of the same failure classes: denied
file writes, unavailable package/runtime tools, oversized command observation, stale reads, and persistence failures.

Mechanism tests should prove that:

- Direct answers can complete without an obligatory tool, classifier, or plan call.
- Non-retryable pre-launch failures do not execute effects; unknown outcomes cannot be blindly retried.
- Relevant state changes allow recovery; unrelated activity does not reset an unchanged blocker.
- Healthy runtime waits do not create model polling requests.
- A passed check is reused only while its full evidence contract remains valid.
- A small request expands when required by discovered risk, while explicit broad requests preserve coverage.
- Batched lifecycle publication preserves canonical output/replay and stops promptly on cancellation.

Use real `Task` tests in addition to kernel fixtures. Fixed scripted actions prove runtime behavior, not improved model
judgment. For strategy comparisons, pair the same requests, model/provider, settings, cache condition, and fixture with
multiple live samples. Include unsuccessful and user-interrupted runs instead of dropping them from performance results.

Report model requests, tool calls, physical commands, rejected calls, recovery calls, repeated evidence/checks, recorded
input/cache/output tokens, useful-answer latency, durable completion latency, cancellation latency, outcome correctness,
and requested coverage. Keep tool time separate from provider and lifecycle-publication intervals. Count any classifier
calls in the total. The existing 25% tool/command and 20% input-token reduction targets remain unproven goals; evaluate
direct and comprehensive work separately so a cheaper but incomplete broad answer cannot pass.

Validation for implementation follows the repository matrix: focused affected tests and package lint/typecheck, then the
exact VS Code 1.122.1 gate for lifecycle, cancellation, tool, and persistence changes. No protected CLI/shim changes,
production dependency additions, provider-state loss, approval weakening, or fabricated successful completion.

## Current deliverable

This pass produced a source-backed general design and corrected the earlier operation-specific recommendation. No
runtime policy, model setting, tool authority, or user project file changed. There is no measured improvement claim yet.
