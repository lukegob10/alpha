# Agent turn path trace

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
