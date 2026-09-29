# Agent turn path trace

## Current Codex CLI alignment audit

Reviewed 2026-09-29 against `openai/codex` commit
[`65c3f40b`](https://github.com/openai/codex/commit/65c3f40befaa213788ca7f97cc955ba996ffa3f5). The audit used the
current [turn loop](https://github.com/openai/codex/blob/65c3f40befaa213788ca7f97cc955ba996ffa3f5/codex-rs/core/src/session/turn.rs),
[tool-result adapter](https://github.com/openai/codex/blob/65c3f40befaa213788ca7f97cc955ba996ffa3f5/codex-rs/core/src/tools/context.rs),
[Plan tool handler](https://github.com/openai/codex/blob/65c3f40befaa213788ca7f97cc955ba996ffa3f5/codex-rs/core/src/tools/handlers/plan.rs).
Embedded model and runtime prompt byte identity was verified separately against the
[model catalog at `4994306e`](https://github.com/openai/codex/blob/4994306e9f80448bde85e770a0b0c93d3fee5665/codex-rs/models-manager/models.json),
also retrieved 2026-09-29; that is the provenance pinned in the prompt source files.

- The ordinary turn loop is aligned. A model tool call executes and its result becomes the next model input. A response
  with visible assistant text and no pending tool or host continuation completes the turn. Alpha's `AgentTurnEngine` and
  `Task` use that same boundary; completion, cancellation, errors, pending user input, hooks, and child work remain
  explicit host states.
- Alpha's embedded GPT-5.6 and GPT-6 model instructions remain byte-identical to the current catalog values. Prompt
  assembly preserves the authority order: model base instructions, runtime collaboration/approval and Alpha's
  host-enforced tool overlay, environment facts, user/project instructions, then the active Plan transition when present.
  Alpha's overlay is an intentional VS Code adapter for its tool, approval, workspace, and persistence contracts.
- One Plan-mode divergence was found and fixed. Codex rejects `update_plan` while the collaboration mode is Plan because
  it is a Code-mode TODO/checklist tool. Alpha's Plan prompt already prohibited todo tools, but its catalog and validator
  still advertised and executed `update_plan`. Plan now omits both the current name and saved alias and rejects either at
  runtime; Code mode keeps the existing checklist and saved-history compatibility.
- Investigation guidance is proportional in both prompts: use existing context, batch independent reads, skip a formal
  plan for simple work, and stop reconnaissance once enough evidence exists. Alpha additionally has an outcome-aware
  repetition detector that advises a strategy change for unchanged results. Neither current Codex nor Alpha imposes a
  global command-count cutoff. Alpha's bounded search-loop recovery is a VS Code host recovery mechanism at the model-step
  boundary, not a tool-admission rule.
- A completed command is now separated from its process outcome in the same way as Codex. A numeric nonzero exit remains
  failed execution and verification evidence, but the tool transaction delivered to the model is successful and retains
  the exit code and output. Policy denials, launch failures, cancellation, timeouts, unknown outcomes, and bookkeeping
  failures remain tool errors.
- The current Codex catalog defaults GPT-5.6 Sol to Low reasoning and GPT-6 Sol to Medium. Max is a supported explicit
  override, so a Max run can produce materially more reasoning and latency than the default. Reasoning blocks alone do
  not show an orchestration loop; request/tool trace events are needed to distinguish model exploration, retries,
  completion rejection, and host waits on the reported computer.

The reported 30–40 minute run was not available as a trace, so this audit establishes the code and prompt contracts and
fixes the demonstrated Plan mismatch; it does not assign every command in that external run to a specific cause.

## Ripgrep search audit (2026-09-29)

`rg` is the ripgrep executable, not a competing search engine. Alpha resolves `@vscode/ripgrep@1.17.0`, the official
VS Code package, and the packaged Windows binary reports ripgrep 15.0.0 with PCRE2 JIT and runtime AVX2 support. OpenAI's
[current model guidance](https://developers.openai.com/api/docs/guides/latest-model) continues to recommend `rg` and
`rg --files` for text and file searches. The current upstream release is
[ripgrep 15.2.0](https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0); its published fixes do not explain a model
issuing dozens of different search queries.

The loop-policy defect was that every novel supported `rg` query received fresh-read credit. A first proposed fix counted
individual searches and rejected later calls. That approach was removed: it did not match Codex's tool loop, turned a
strategy problem into synthetic tool errors, and overfit raw call count (including useful parallel batches).

Alpha now observes completed **model steps**. Three consecutive steps whose tool calls are all repository searches add a
recovery checkpoint to the next model input. It asks the model to consolidate returned evidence, identify the unresolved
hypothesis, and inspect, act, or request the specific missing information. If the model ignores two checkpoints and
continues for a third three-step interval, the task reaches the existing recoverable pause/resume boundary without being
failed. One step containing 40 parallel searches counts once; any mixed or non-search step resets the window. The
classification covers native searches plus `rg`/`ripgrep`, `grep` variants, `Select-String`, and `git grep` through command
aliases and common path/case variants. There is no query-term budget, total tool-call cap, or scheduler admission block.
This stays close to Codex's normal tool-result feedback loop while adding the requested bounded recovery behavior.

## Historical trace (2026-09-22)

Date: 2026-09-22  
Checkpoint inspected: `8a6f4cfd` (`codex/harness-improvement-cycle`)  
Outcome: no production change. The trace did not establish a dominant, bounded runtime bottleneck with a task-level baseline.

## Representative task path

1. `Task.initiateTaskLoop` starts the shared `AgentTurnEngine`. Its host calls `Task.runAgentRequests` once per logical model step. The request loop parses mentions, consumes pending steering, merges staged tool results, and attaches `captureEnvironmentDetails` before the user message is persisted. `EnvironmentContext` sends a full snapshot after an identity change and only changed fields afterward. Workspace listing runs only for the initial/full snapshot or an explicit `includeFileDetails` input.
2. `Task.attemptCapturedApiRequest` captures provider settings and the current mode, constructs the system prompt through `Task.getSystemPrompt` and `SYSTEM_PROMPT`, prepares context management, then builds the task's native and MCP tool surface. `TaskToolCatalogCache` retains a task-local catalog and defers sufficiently large MCP catalogs. Context-management tool metadata is prepared only if compaction needs it.
3. `Task.captureAgentStep` captures the request, transcript, tool schemas and policy in the immutable step snapshot. Transport retries derive a retry snapshot. The captured request is sent through the provider adapter.
4. `AgentResponseAccumulator` normalizes streamed text, reasoning, usage, grounding and complete tool calls into ordered `AgentResponse` items. `Task.persistAssistantResponseBeforeEffects` saves the assistant response and canonical items before any tool effect.
5. `Task.executeCanonicalToolCallsForTurn` checks the durable transcript receipt, then uses the captured `TaskToolSurface` and `ToolScheduler`. The scheduler enforces the captured policy, serializes mutations and approvals, and runs audited independent reads with a concurrency limit of four. It preserves deterministic result order and terminal results for cancellation and failure.
6. Tool results are staged as user content and saved with the next user input by `persistUserContentWithEnvironment`. Terminal, cancellation and delegation paths use `flushPendingToolResultsToHistory` to close the transaction before ending or handing off. The next engine step receives the results. A visible response with no pending continuation reaches the same durable completion gate as `attempt_completion`; verification obligations, child work and task persistence settle before completion.

The necessary extra model round trip is the one that consumes tool results and decides what to do next. The engine returns after one completed provider/tool step and owns the continuation decision, so this trace found no duplicate orchestration loop or avoidable completion request.

## Work observed on each step

- The environment baseline already avoids repeating workspace listings and avoids sending unchanged environment fields. The focused environment test confirms one `listFiles` call across its baseline and unchanged captures.
- Tool surface capture already reuses task-local catalog state. Compaction avoids building full tool metadata until a compaction path needs it.
- `getSystemPrompt` regenerates the instruction prompt for each fresh model step, and custom instruction assembly rereads applicable instruction files. A retained transport retry reuses its captured prompt. Fresh reads preserve changes made while a task is running. No timing data here shows that this is a material cost.
- `Task.getTokenUsage` and environment's `getApiMetrics` both aggregate task messages. A deterministic Node 24.14.1 probe of the shared `consolidateTokenUsage` routine used 100 calls per sample and seven samples per size. Median time per call was 0.0074 ms for 256 messages (16 request records), 0.0261 ms for 1,024 messages (64 request records), and 0.0954 ms for 4,096 messages (256 request records). Even at 4,096 messages, twelve such calls would total about 1.15 ms. That local scan is too small to justify a production cache or invalidation mechanism on its own.
- Step capture also clones request/history data for the raw provider request and the diagnostic snapshot, then computes snapshot digests. This is an obvious measurement candidate for unusually long histories, but changing it without timing and recovery evidence risks weakening snapshot isolation.

The environment measurement test reports bytes, tokens and `listFiles` call count usefully. Its preflight duration uses `Date.now()` while Vitest fake timers are active, so those values are not wall-clock latency evidence. No per-phase trace in this investigation separated prompt construction, request preflight, step snapshot, provider streaming, tool execution and persistence on a real coding task. Therefore I cannot attribute end-to-end time or token use to one local phase or claim an improvement.

## Next measurement

Use an immutable build and the same visible, non-holdout local task subset on the same host, model, effort and repetitions before and after one candidate change. Add bounded phase timings to the existing task trace for prompt assembly, history/token preflight, tool-surface capture, step snapshot, provider stream, scheduler, persistence and completion. Compare verified grader outcomes first, then model requests, input/output tokens, retries, tool batches and phase wall time. The next candidate is snapshot cost on long transcripts only if that trace shows it is material; preserve the current separate raw request and diagnostic snapshot contracts.

No holdout task fixtures or oracle outputs were used. The existing dirty evaluation documentation and untracked generated artifacts were left unchanged. Focused existing checks run for this trace: AgentTurnEngine (12 tests), environment measurements (2 tests), and tool-result persistence (8 tests), all passed. The VS Code 1.122.1 smoke gate was not run because this trace made no extension behavior or API change.
