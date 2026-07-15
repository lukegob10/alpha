# Alpha Core Harness Rebuild

## Scope

This document compares the problem-solving core of four coding-agent harnesses:

- [Pi](https://github.com/earendil-works/pi)
- [Oh My Pi](https://github.com/can1357/oh-my-pi), included because it is a Pi-derived harness and is currently benchmarked separately
- [OpenCode](https://github.com/anomalyco/opencode)
- [Codex CLI](https://github.com/openai/codex)

The focus is deliberately narrow: how an agent turns a user objective into model calls, tool calls, workspace changes, verification, and a completed result. This excludes memory systems, account and contract behavior, UI polish, cloud coordination, restart/resume features, and product-specific workflow scaffolding unless they directly affect the core loop.

The source review was performed against the following benchmark-era snapshots:

| Harness   | Benchmark version | Pinned source commit                       |
| --------- | ----------------: | ------------------------------------------ |
| Pi        |           v0.79.6 | `31bfb2f16f7a1dd707876e970f0f80caa61f8435` |
| Oh My Pi  |          v16.1.15 | `58b3c41ed19c5e6a220e0cdb779b48d588f85aa5` |
| OpenCode  |           v1.17.9 | `5c23e88419c4743b9be42cea132f2fb1e6cb63ff` |
| Codex CLI |          v0.130.0 | `58573da43ab697e8b79f152c53df4b42230395a8` |

Alpha was inspected on the `codex/agent-harness-experiment` branch. The `main` branch remains untouched.

> **Implementation status (July 2026):** This document began as a gap analysis. The experiment branch now implements the shared turn engine, provider-neutral response items, multi-tool scheduling, immutable step context, centralized execution policy, safe-boundary compaction, replayable event telemetry, structured tool outcomes, and normal final-response completion. The legacy mode/profile system has not been replaced. Internal delegation, objective-driven child task definitions, model routing for child work, prompt consolidation, and advanced hash/anchor edit recovery remain future work. The remaining implementation sequence is defined in [`core-harness-comparison-final-phases.md`](./core-harness-comparison-final-phases.md).

## Executive conclusion

Alpha does not primarily need a larger mode prompt or a more elaborate orchestrator prompt. It needs a stronger agent kernel.

The leading harnesses have converged on the same basic shape:

```text
objective
  -> prepare a stable step context
  -> sample the model with typed, available tools
  -> collect the complete assistant response
  -> validate and schedule its tool calls
  -> execute a coherent batch
  -> persist tool results
  -> verify, compact, continue, or complete
```

At the start of the experiment, Alpha had a chat-oriented streaming presenter in the middle of this process. It began executing tool calls while the assistant response was still being assembled, interrupted the response after a tool, and effectively limited each response to one tool. Phases 1â€“3 replaced that live path with a provider-neutral turn engine and scheduler. The remaining architectural mismatch is now above the kernel: Alpha still exposes the legacy Code, Architect, Ask, Debug, and Orchestrator mode topology, and Orchestrator remains a prompt-driven delegator rather than a bounded runtime capability.

The target should be a hybrid of the strongest ideas:

| Borrow from | What Alpha should take                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi          | A small, understandable canonical loop; complete assistant response before tool execution; clean termination when no more work is requested; extension-friendly tools               |
| Oh My Pi    | Reliable edit mechanics, hash/anchor validation, tool-result recovery, live context synchronization, and robust stream/tool-call handling                                           |
| OpenCode    | An explicit primary Build agent, restricted Plan/Explore/General subagents, a first-class internal task tool, and granular policy around tools                                      |
| Codex CLI   | Request-scoped immutable step context, a provider-neutral response-item model, centralized tool routing, real parallel tool execution, safe compaction, and bounded internal agents |

The highest-value change is therefore not “make Orchestrator smarter.” It is:

> Replace Alpha’s streaming, single-tool presentation path with a provider-neutral turn engine that collects model responses, schedules typed tool invocations, executes safe batches, persists results, and continues until the model reaches a verified terminal state.

## What the benchmark says — and does not say

The current HarnessRank page reports a same-model GPT-5.5 medium comparison with the following ordering:

| Rank | Harness           |       Score | Cost per task |
| ---: | ----------------- | ----------: | ------------: |
|    1 | Pi v0.79.6        | 76.0% ± 3.9 |       $0.3454 |
|    2 | Oh My Pi v16.1.15 | 74.2% ± 3.6 |       $0.7907 |
|    3 | OpenCode v1.17.9  | 72.7% ± 3.9 |       $0.5361 |
|    4 | Codex v0.130.0    | 71.2% ± 1.3 |       $0.6877 |

Source: [HarnessRank](https://harnessrank.net/).

This is useful evidence that harness mechanics can move coding performance materially even when the model is held constant. It is not proof that Pi is universally the best harness. The page currently notes that full benchmark rows are not yet published, and a benchmark score is an aggregate over many hidden choices: prompts, tool definitions, default model options, context handling, edit behavior, and stopping rules.

Other public comparisons are not clean harness-only experiments. For example, [Artificial Analysis](https://artificialanalysis.ai/agents/coding-agents/comparisons) compares complete agent configurations, and [SWE-Together](https://togetherbench.com/) uses OpenCode for all runs. Those sources are useful for capability signals, but they should not be used to attribute every score difference to orchestration alone.

The practical conclusion is stronger than the exact ranking: a compact, coherent harness can outperform a more feature-rich one when its core loop gives the model good observation, action, and verification mechanics.

## The common core across the best systems

Despite different products and languages, the four systems share the following mechanics.

### 1. The model is sampled in steps, not treated as a one-shot answer generator

Each step has a model-visible context, tool definitions, a model response, and zero or more tool results. Tool results become input to the next model sampling request. The agent is not “streaming text and occasionally performing an action”; it is executing a state machine whose natural unit is a turn/step.

### 2. Tool calls are structured data

The model emits named calls with arguments. The harness validates them, applies policy, invokes the implementation, captures a structured result, and feeds that result back. Tool names, argument schemas, result limits, mutability, parallelism, and approval behavior are explicit runtime data.

### 3. The full assistant response is collected before the batch is executed

Pi and Codex make this especially clear. They consume the assistant response, collect all function calls, then run the calls in sequence or in parallel according to tool metadata. OpenCode persists tool-call parts through its session processor. This prevents a tool call from corrupting or truncating the assistant response that produced it.

### 4. Parallelism is selective, not universal

Read/search/inspection work can often run concurrently. Workspace mutations, interactive commands, and dependent calls need ordering. The correct abstraction is not a global “parallel tools” boolean; it is a scheduler operating on tool metadata and dependencies.

### 5. Completion is a state transition

The turn ends when the assistant produces a final response with no outstanding tool calls, or when the harness reaches a bounded stop condition such as cancellation, error, context exhaustion, or policy denial. A terminal tool is not required for the model to finish.

### 6. Context is managed at step boundaries

The strongest implementations snapshot the environment and tool surface for a sampling request, persist the resulting items, and compact only at safe points. This makes retries, debugging, cancellation, and continuation much more reliable.

### 7. Verification is part of the loop

A coding agent needs a way to inspect its own changes, run tests or diagnostics, and decide whether the result is good enough. Verification does not need to be a separate product mode; it is an expected stage in the same tool-driven loop.

## Harness-by-harness findings

### Pi: the clean minimal baseline

Pi is the clearest reference implementation for the smallest useful agent kernel. Its repository separates the runtime into `pi-agent-core`, provider abstraction in `pi-ai`, the coding-agent shell, and TUI components. Its default coding tools are `read`, `write`, `edit`, and `bash`.

The important behavior is in [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts):

1. Start or continue a run.
2. Stream the assistant response.
3. Wait for the complete assistant message.
4. Extract all tool calls from that message.
5. Execute them sequentially or in parallel according to configuration and per-tool execution mode.
6. Emit tool results and continue sampling.
7. Stop cleanly when there are no tool calls or follow-up requests.

The low-level state and transcript ownership live in [`packages/agent/src/agent.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts). A newer harness layer in [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/agent-harness.ts) adds explicit turn snapshots, phases, persistence, save points, and queue semantics.

Pi’s useful lesson is not that Alpha should copy its UI. It is that the kernel can remain small if its contracts are clean:

- assistant output and tool calls are separate structured items;
- execution begins after response collection;
- tool results are appended as first-class messages;
- the loop naturally continues or stops;
- extensions add capability without rewriting the loop.

Pi’s limitation for Alpha is that the baseline is intentionally permissive and comparatively light on policy and coding-specific repair. The repository’s own documentation says it has no built-in permission system and expects isolation to come from the environment. Alpha still needs a policy boundary appropriate to its extension host.

### Oh My Pi: stronger coding mechanics on the Pi loop

Oh My Pi is the most relevant source for improving the reliability of coding operations. It retains Pi’s basic architecture but adds a much more ambitious execution layer: LSP and DAP support, persistent kernels, first-class subagents, a large tool set, and hashline editing.

Its agent loop in [`packages/agent/src/agent-loop.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/agent/src/agent-loop.ts) adds several mechanics Alpha should study:

- synchronize live context before every model call;
- maintain deadlines and yield points so the loop cannot busy-wait;
- support tool-choice directives and soft tool-requirement escalation;
- recover from malformed or leaked streamed output;
- preserve tool-call/result pairing during aborts;
- run all tool calls from a response with stable result ordering;
- emit explicit turn-end and telemetry events.

The [hashline implementation](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline) is particularly relevant. It combines content hashes, line anchors, parsing, and recovery so an edit can be rejected or repaired when the file changed underneath the model’s proposed patch. This is materially different from merely giving the model a larger edit prompt.

Oh My Pi’s lesson for Alpha is:

> Coding reliability comes from making tool operations self-checking and recoverable, not from asking the model to be more careful.

Its tradeoff is complexity. Alpha should adopt the edit-validation and recovery principles first, without importing every runtime, language server, debugger, or provider feature at once.

### OpenCode: explicit agent roles and task delegation

OpenCode provides the clearest model for a primary coding agent that can delegate bounded work internally. Its built-in agents in [`packages/opencode/src/agent/agent.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/agent/agent.ts) distinguish:

- `build`: the primary coding agent with the broad tool surface;
- `plan`: a restricted primary mode that can inspect and plan but cannot edit;
- `general`: a subagent for complex research or multi-step work;
- `explore`: a read/search-oriented subagent;
- hidden compaction, title, and summary agents.

The core loop in [`packages/opencode/src/session/prompt.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/prompt.ts) is explicit about steps, max-step boundaries, compaction, task handling, dynamic tool resolution, and continuing until the processor says to stop. [`packages/opencode/src/session/processor.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/processor.ts) persists tool-call parts and state transitions rather than treating the tool invocation as a presentation side effect.

The [`task` tool](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/tool/task.ts) is the important orchestration primitive. It creates or resumes a child session, chooses a subagent type, derives permissions, supports foreground/background execution, and returns a structured task result. The parent remains responsible for integrating the result.

OpenCode’s policy layer in [`packages/opencode/src/permission/index.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/permission/index.ts) is also instructive: permissions are data with `allow`, `ask`, and `deny` outcomes, pattern matching, and agent-specific scope. This is useful because tool availability, tool approval, and agent role are separate concerns.

OpenCode’s lesson for Alpha is:

> Keep one capable primary coding agent, then make planning, exploration, and delegation specialized subagent configurations rather than unrelated top-level personalities.

OpenCode’s tradeoff is that its product surface is broad. Alpha should copy the agent topology and task boundary, not blindly copy every session, provider, or UI abstraction.

### Codex CLI: the strongest execution substrate

Codex CLI is the clearest reference for a production-grade request/step boundary. The core loop is in [`codex-rs/core/src/session/turn.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs). Its central model is simple: the model returns function calls or an assistant message; function calls execute and their outputs feed the next sampling request; an assistant message with no follow-up ends the turn.

The implementation makes that model reliable through several layers:

- [`step_context.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/step_context.rs) captures request-scoped environment, capability roots, loaded instructions, and an MCP runtime snapshot;
- the [tool router and registry](https://github.com/openai/codex/tree/main/codex-rs/core/src/tools) separate model-visible tool schemas from dispatch and execution metadata;
- [parallelism tests](https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/tool_parallelism.rs) prove that independent shell, read, and mixed calls can execute concurrently;
- the [context manager](https://github.com/openai/codex/tree/main/codex-rs/core/src/context_manager) and [`compact.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs) compact at controlled boundaries;
- multi-agent modules provide bounded child execution rather than unconstrained recursion.

Codex’s strongest lesson for Alpha is:

> Treat the exact model request, visible tools, environment, policy, and instruction set as one immutable step context, then record the response and results as an event stream.

This is the foundation needed for provider changes, retries, cancellation, parallel execution, and reproducible debugging. It is more valuable than copying the Codex prompt text.

Codex’s tradeoff is implementation weight. Alpha is TypeScript and extension-host oriented, so the target should preserve these boundaries without requiring a Rust rewrite.

## What Alpha does today

### Current execution shape

Alpha’s main task loop is in [`src/core/task/Task.ts`](../src/core/task/Task.ts). `initiateTaskLoop` repeatedly calls `recursivelyMakeClineRequests`, while the streaming response is presented through [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts).

Before the Phase 2 scheduler change, the execution path had four important characteristics:

1. The response presenter began tool handling while the assistant response was still being assembled.
2. `didAlreadyUseTool` and the interruption path effectively enforced one tool per assistant response.
3. The loop injected `formatResponse.noToolsUsed()` when a response did not use a tool, coercing the model toward tool use.
4. `parallelToolCalls: true` appeared in request/configuration paths, but the execution path was still sequential/single-tool in practice.

Phase 2 now collects the complete response before scheduling, so the live path no longer uses those single-tool and no-tool coercion behaviors. The legacy presenter remains only for compatibility with isolated presentation helpers.

This was the central contradiction:

```text
Prompt: “Prefer calling as many tools as reasonably needed in a single response.”
Runtime: “Only one tool may be used at a time and it must be at the end of the message.”
```

No system prompt can reliably repair a contradiction at this level.

### Current modes

Alpha’s mode definitions are in [`packages/types/src/mode.ts`](../packages/types/src/mode.ts). Code has the broad coding tool groups. Orchestrator has no direct tools and is instructed to break work down, create subtasks through `new_task`, track them, and synthesize their results.

That makes Orchestrator a delegator, not a second capable problem-solving agent. It cannot inspect, edit, or run the workspace itself. A delegated child must do the actual work, and the parent has less direct evidence with which to reason about the result.

The better model is not to delete delegation. It is to give the primary coding agent a complete tool environment and make delegation an internal capability available when useful.

### Current tool surface

Alpha has a large and overlapping native tool surface: `read_file`, `list_files`, `search_files`, `codebase_search`, `edit_file`, `apply_diff`, `apply_patch`, `write_to_file`, `execute_command`, `read_command_output`, `new_task`, MCP tools, GitHub tools, skills, mode switching, todo updates, and others.

The problem is not the existence of these capabilities. The problem is that tool identity, execution semantics, and scheduling are spread across prompt text, mode groups, presenter logic, and shared type definitions. The model sees “parallel” guidance, while the runtime does not expose one central scheduler that can enforce dependencies, mutation ordering, cancellation, and result limits.

## Gap analysis

| Core capability                          | Pi                           | Oh My Pi                            | OpenCode                                 | Codex CLI                   | Alpha today                                          |
| ---------------------------------------- | ---------------------------- | ----------------------------------- | ---------------------------------------- | --------------------------- | ---------------------------------------------------- |
| Complete response before executing calls | Yes                          | Yes                                 | Effectively yes through processor        | Yes                         | No; presenter interrupts the response                |
| Multiple calls per response              | Yes                          | Yes                                 | Yes                                      | Yes                         | Effectively no                                       |
| Central tool metadata                    | Basic execution modes        | Richer execution/recovery metadata  | Tool registry + policy wrapper           | Router/registry metadata    | Distributed across prompts and handlers              |
| Selective parallel execution             | Yes                          | Yes                                 | Supported through tool/session machinery | Explicit and tested         | Configuration says yes; runtime path is sequential   |
| Stable step context                      | Harness layer                | Live synchronization + context mode | Dynamic session context                  | Explicit `StepContext`      | No single immutable request snapshot                 |
| Native structured response items         | Yes                          | Yes                                 | Persisted session parts                  | Yes                         | Primarily message/presenter coupling                 |
| No-tool completion                       | Yes                          | Yes                                 | Yes                                      | Yes                         | Coerced into another request                         |
| Robust edit validation/recovery          | Basic edit tool              | Hashline and recovery               | Patch/edit tooling                       | Apply/patch tooling         | Model-dependent edit paths                           |
| Primary agent can solve directly         | Yes                          | Yes                                 | Build agent                              | Yes                         | Code can; Orchestrator cannot                        |
| Internal bounded subagents               | Extensions / harness support | First-class subagents               | First-class task tool                    | Bounded multi-agent runtime | `new_task` is a mode-facing delegation path          |
| Context compaction at safe boundaries    | Emerging harness support     | Supported/enhanced                  | Processor/session loop                   | Explicit context manager    | Existing behavior is not the central kernel contract |

## Target architecture for Alpha

### 1. Build an `AgentTurnEngine`

Introduce one provider-neutral engine behind the existing task/UI façade. Its public responsibility should be to advance a task from one stable state to the next.

```text
prepareStep
  -> build StepContext
  -> sampleModel
  -> collect AssistantItems
  -> persist assistant items
  -> validate ToolInvocations
  -> apply policy and approval
  -> schedule executable batch
  -> execute tools
  -> persist ToolResults
  -> verify / compact / continue / complete
```

The engine should own the loop. Streaming should be an event transport for UI responsiveness, not the place where business logic decides which tool to run.

### 2. Define a provider-neutral response item model

Do not make the engine depend on one provider’s message shape. Normalize model output into items such as:

```ts
type AssistantItem =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool_call"; call: ToolInvocation }
	| { type: "provider_event"; provider: string; data: unknown }

type ToolInvocation = {
	id: string
	name: string
	arguments: unknown
	dependsOn?: string[]
}

type ToolResult = {
	callId: string
	name: string
	status: "success" | "error" | "denied" | "cancelled"
	output: unknown
	truncated?: boolean
}
```

The exact type names are not important. The separation is: assistant text, reasoning, tool calls, and tool results must not be conflated with UI messages.

### 3. Create a real tool registry and scheduler

Every tool should declare metadata in one place:

```ts
type ToolMetadata = {
	name: string
	supportsParallel: boolean
	mutatesWorkspace: boolean
	requiresApproval: boolean | "always" | "on-risk"
	supportsCancellation: boolean
	outputLimit: { bytes: number; lines: number }
	sideEffects: "none" | "workspace" | "external"
}
```

The scheduler should:

- preserve model order when dependencies are present;
- run independent read/search calls concurrently;
- serialize conflicting mutations;
- prevent a read from racing a mutation of the same path;
- retain stable result ordering for the next model call;
- cancel remaining work when the task is cancelled;
- return explicit errors and denials as tool results rather than corrupting the transcript.

Start with read/search parallelism. Add mutation parallelism only when the dependency model is proven.

### 4. Introduce immutable `StepContext`

Before each model sampling request, capture:

- task identifier and current working directory;
- relevant instruction files and mode/profile;
- provider/model/options;
- model-visible tool schemas;
- tool policy and approval state;
- environment/capability roots;
- current transcript boundary;
- compaction and token budget metadata.

Do not silently mutate this object while the request is in flight. If the environment changes, create the next step context. This makes retries and provider adapters predictable.

### 5. Make Code the capable primary profile

The default coding profile should directly expose read, search, edit, write, command, diagnostics, and completion/verification capabilities. It should not require the user to enter a special orchestrator mode to get a full problem-solving loop.

Orchestrator can remain as a compatibility mode, but its implementation should become a profile that has the same turn engine and may use the `delegate_task` capability. It should not be a no-tools persona that can only emit `new_task`.

### 6. Make delegation an internal bounded capability

Add a first-class internal task operation with:

- a child objective and explicit expected output;
- selected profile (`explore`, `plan`, `build`, or custom);
- isolated or shared workspace policy;
- bounded depth and concurrency;
- cancellation propagation;
- structured result and changed-file summary;
- parent-side verification before claiming completion.

Keep `new_task` as a compatibility adapter during migration. The new turn engine, not the prompt, should own child lifecycle and result integration.

### 7. Make verification explicit but lightweight

Completion should carry evidence. A task can finish with a final assistant message, but the engine should track whether the model inspected the resulting files, ran a requested test, or received a tool error.

This does not require a rigid “must run tests” contract for every task. It requires the harness to make verification easy and observable. A profile or project policy can then require a test/diagnostic step when appropriate.

### 8. Compact only at safe boundaries

When context is near its limit:

1. finish or cancel in-flight tool calls;
2. persist assistant items and tool results;
3. summarize at a known transcript boundary;
4. retain current objective, changed files, failures, pending verification, and active child tasks;
5. begin the next step with a new `StepContext`.

Do not compact halfway through a streamed response or while tool-call pairing is incomplete.

## Prompt and mode guidance after the kernel change

Prompt work still matters, but it should become smaller and more operational after the runtime is fixed.

The system/profile prompt should answer only:

- what role the agent has;
- what objective it is solving;
- what tools mean and when to use them;
- what evidence is required before claiming success;
- what constraints are non-negotiable.

The runtime should enforce:

- schemas and argument validity;
- tool availability;
- permissions;
- parallelism and mutation ordering;
- output truncation;
- cancellation;
- step limits and compaction;
- child-agent bounds.

Before Phase 2, the shared Alpha tool instruction said to prefer as many tools as reasonably needed in one response, but the runtime interrupted after one. The Phase 2 scheduler makes the targeted batching instruction truthful; broad prompt changes remain out of scope.

Recommended user-facing modes:

| Mode | Direct capability                                                            | Typical use                                                                  |
| ---- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Work | Full problem-solving loop with policy-governed tools and optional delegation | Default questions, diagnosis, implementation, verification, and general work |
| Plan | Read/search/inspect plus a plan artifact; no workspace or external mutation  | Design and review before implementation                                      |

Model choice is a separate axis. Work and Plan may each remember a default model, reasoning level, and cost setting, while the user can override the model per task. Internal children receive an explicit model route in their task envelope.

Explore, Diagnose, Design, Implement, Verify, Review, Document, Operate, and Analyze are internal task roles, not user-facing modes. Skills and workflows attach to those roles as reusable procedures. Orchestrator is not part of the target product surface.

## Implementation sequence on the experiment branch

### Phase 0 — Instrument the current behavior

Before changing semantics, record:

- model request and response boundaries;
- number and names of tool calls per assistant response;
- interruption frequency;
- no-tool coercion frequency;
- tool latency and output size;
- retries, errors, and cancellations;
- whether a task ended through a final response or a synthetic completion path.

This creates an Alpha baseline and lets the experiment demonstrate whether each kernel change improves actual task completion.

### Phase 1 — Extract the loop without changing tools

Create the `AgentTurnEngine` behind the current `Task` façade. Initially adapt existing tools into the new registry, preserve the current UI events, and run one call at a time if necessary. The first success criterion is that the engine owns turn boundaries and produces the same visible behavior for existing tasks.

### Phase 2 — Remove the single-tool contradiction

The experiment branch now collects complete assistant responses, normalizes all tool calls, and executes multiple calls in one batch. It removes the `noToolsUsed` re-prompt and preserves `attempt_completion` only as a compatibility tool; it is not required for a normal final response.

Acceptance tests:

- two independent reads execute and both results reach the next model call;
- a read plus a search can execute concurrently;
- two conflicting edits execute in deterministic order;
- a malformed second call does not discard the first valid call;
- a no-tool assistant response completes without a synthetic follow-up;
- streamed UI output still renders incrementally without triggering execution early.

### Phase 3 — Add step context, policy, and safe compaction

Centralize request-scoped context, tool visibility, approval, output limits, cancellation, and compaction. Add replayable event logging for one task run. Keep the implementation provider-neutral.

### Phase 4 — Improve coding tools

Harden file operations with stale-file detection, bounded output, clear failure results, and patch recovery. A hash/anchor approach inspired by Oh My Pi should be evaluated for edits that are currently vulnerable to line drift or stale context.

### Phase 5 — Add internal delegation

Expose a `delegate_task` operation to the Build engine. Add Explore, Plan, and General profiles with separate tool policies. Bound child depth, concurrency, time, and output. Require parent-side integration and verification.

### Phase 6 — Simplify prompts and modes

After runtime behavior is stable, reduce duplicated mode prompt instructions and move enforceable behavior into schemas, registry metadata, and the engine. Keep prompts focused on role, objective, strategy, and evidence.

## What not to do first

- Do not begin by writing a much larger Orchestrator prompt.
- Do not build a memory system as a substitute for better step/context handling.
- Do not expose every tool to every mode without a central registry and policy.
- Do not add global parallel execution before modeling mutations and dependencies.
- Do not make `attempt_completion` mandatory for every successful task.
- Do not rewrite Alpha’s UI, extension protocol, or all tools before extracting the kernel.
- Do not copy a competitor’s prompt verbatim; copy the runtime contracts that make the prompt true.

## Final target state

Alpha should feel like one capable coding agent with a disciplined internal loop:

```text
User objective
  -> Build profile understands the repository
  -> model requests the tools it needs
  -> Alpha executes a safe, coherent batch
  -> results return with exact provenance
  -> model inspects, edits, runs checks, and verifies
  -> optional bounded subagents handle isolated work
  -> Alpha reports what changed and what evidence supports completion
```

The decisive shift is from “a mode prompt drives a streaming chat presenter” to “a turn engine executes a structured agent state machine.” That is the common core behind the strongest open harnesses, and it is the change most likely to close Alpha’s gap.

## Source map

### Alpha

- [`src/core/task/Task.ts`](../src/core/task/Task.ts)
- [`src/core/agent/AgentTurnEngine.ts`](../src/core/agent/AgentTurnEngine.ts)
- [`src/core/agent/StepContext.ts`](../src/core/agent/StepContext.ts)
- [`src/core/agent/ToolPolicy.ts`](../src/core/agent/ToolPolicy.ts)
- [`src/core/agent/ToolScheduler.ts`](../src/core/agent/ToolScheduler.ts)
- [`src/core/tools/ToolRegistry.ts`](../src/core/tools/ToolRegistry.ts)
- [`src/core/assistant-message/presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts)
- [`src/core/prompts/system.ts`](../src/core/prompts/system.ts)
- [`src/core/prompts/sections/tool-use.ts`](../src/core/prompts/sections/tool-use.ts)
- [`packages/types/src/mode.ts`](../packages/types/src/mode.ts)
- [`src/core/prompts/tools/native-tools/index.ts`](../src/core/prompts/tools/native-tools/index.ts)

### Pi

- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/agent.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts)
- [`packages/agent/src/harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/agent-harness.ts)
- [`packages/coding-agent/src/core/system-prompt.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts)
- [`packages/coding-agent/src/core/tools/index.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/index.ts)

### Oh My Pi

- [`packages/agent/src/agent-loop.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/agent/src/agent-loop.ts)
- [`packages/agent/src/agent.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/agent/src/agent.ts)
- [`packages/hashline`](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline)
- [`packages/coding-agent`](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent)

### OpenCode

- [`packages/opencode/src/agent/agent.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/agent/agent.ts)
- [`packages/opencode/src/session/prompt.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/prompt.ts)
- [`packages/opencode/src/session/processor.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/processor.ts)
- [`packages/opencode/src/session/llm/request.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/llm/request.ts)
- [`packages/opencode/src/session/tools.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/tools.ts)
- [`packages/opencode/src/tool/task.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/tool/task.ts)
- [`packages/opencode/src/permission/index.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/permission/index.ts)

### Codex CLI

- [`codex-rs/core/src/session/turn.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs)
- [`codex-rs/core/src/session/step_context.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/step_context.rs)
- [`codex-rs/core/src/tools`](https://github.com/openai/codex/tree/main/codex-rs/core/src/tools)
- [`codex-rs/core/src/tools/registry.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/registry.rs)
- [`codex-rs/core/src/compact.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)
- [`codex-rs/core/tests/suite/tool_parallelism.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/tool_parallelism.rs)

### Frontier orchestration direction

- [OpenAI: A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
- [OpenAI: Symphony orchestration specification](https://openai.com/index/open-source-codex-orchestration-symphony/)
- [Anthropic: Building Effective AI Agents](https://resources.anthropic.com/building-effective-ai-agents)
