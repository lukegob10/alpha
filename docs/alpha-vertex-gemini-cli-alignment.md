# Alpha Vertex Alignment With Gemini CLI

Date: 2026-05-08

## Scope

This note compares Alpha/Roo's current Vertex AI behavior with the public Gemini CLI implementation, focusing on Vertex setup, model streaming, tool calling, function response handling, and orchestration.

Primary Gemini CLI references:

- [`contentGenerator.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/core/contentGenerator.ts)
- [`geminiChat.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/core/geminiChat.ts)
- [`client.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/core/client.ts)
- [`turn.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/core/turn.ts)
- [`scheduler.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/scheduler/scheduler.ts)
- [`tools.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/tools.ts)
- [`tool-registry.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/tool-registry.ts)
- [`mcp-tool.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/mcp-tool.ts)
- [`useGeminiStream.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/hooks/useGeminiStream.ts)
- [`nonInteractiveCli.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/nonInteractiveCli.ts)
- [`configuration.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)

Primary Alpha references:

- [`src/api/providers/gemini.ts`](../src/api/providers/gemini.ts)
- [`src/api/providers/vertex.ts`](../src/api/providers/vertex.ts)
- [`src/api/providers/anthropic-vertex.ts`](../src/api/providers/anthropic-vertex.ts)
- [`src/api/providers/vertex-gateway.ts`](../src/api/providers/vertex-gateway.ts)
- [`src/api/transform/gemini-format.ts`](../src/api/transform/gemini-format.ts)
- [`src/core/task/Task.ts`](../src/core/task/Task.ts)
- [`src/core/task/build-tools.ts`](../src/core/task/build-tools.ts)
- [`src/core/task/validateToolResultIds.ts`](../src/core/task/validateToolResultIds.ts)
- [`src/core/assistant-message/NativeToolCallParser.ts`](../src/core/assistant-message/NativeToolCallParser.ts)
- [`src/core/assistant-message/presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts)

## Executive Summary

Gemini CLI's main advantage is not only its Vertex authentication path. It runs a provider-native Gemini loop that preserves function call IDs, immediately sends function responses after tool calls, retries malformed or incomplete streams, validates tool calls before execution, and uses a central scheduler to return exactly one structured response per tool call.

Alpha already has useful pieces: Google GenAI is used for Gemini and Vertex Gemini, Anthropic Vertex SDK is used for Claude-on-Vertex, thought signatures are round-tripped, tool result IDs are repaired defensively, and the Vertex Gemini gateway supports custom base URLs, Helix OAuth refresh, custom CA bundles, and model routing.

The main alignment gaps are:

1. Vertex Gemini does not get the same restricted-tool `allowedFunctionNames` path as direct Gemini.
2. Gemini function call IDs are not preserved through Alpha's Gemini stream and `functionResponse` conversion.
3. Vertex gateway support is stronger for Gemini than for Anthropic Vertex.
4. Alpha repairs malformed tool histories reactively, while Gemini CLI prevents many failures through a scheduler and structured function responses.
5. Alpha does not yet expose Vertex routing headers equivalent to Gemini CLI's request type and shared request type configuration.

## Gemini CLI Patterns To Adopt

### Vertex Configuration

Gemini CLI uses `GOOGLE_GENAI_USE_VERTEXAI=true` to select Vertex mode, then configures `GoogleGenAI` with `vertexai: true`. It supports project/location auth, API keys, custom base URLs through `GOOGLE_VERTEX_BASE_URL`, custom headers, bearer auth, and API version overrides.

It also supports two Vertex routing headers:

- `X-Vertex-AI-LLM-Request-Type`
- `X-Vertex-AI-LLM-Shared-Request-Type`

Alpha's Vertex Gemini gateway currently supports base URL, model routing, OAuth refresh, CA bundle configuration, and `x-r2d2-soeid`, but it does not expose the two Vertex routing headers.

### Provider-Native Function Call Loop

Gemini CLI keeps tool calls and tool responses in Gemini's native shape. When the model returns `functionCall`, the next continuation sends `functionResponse` parts directly back to Gemini. It also avoids inserting unrelated user context between a model `functionCall` and its corresponding function response.

Alpha converts Anthropic-style history into Gemini `Content`. This is workable, but it increases the need for strict invariants:

- Every assistant `tool_use` for Vertex Gemini must map to exactly one user `tool_result`.
- Every Gemini `functionResponse` should include the provider's function call `id` when available.
- Condense, IDE context, or system/user injections must not be inserted between a Gemini function call and its function response.

### Function Call IDs

Gemini CLI preserves `functionCall.id` when present and creates collision-resistant synthetic IDs when missing.

Alpha currently creates Gemini tool call IDs as `${name}-${counter}` in `GeminiHandler.createMessage()`. That discards provider IDs and is weaker across retries, resumed streams, and mixed tool batches. `gemini-format.ts` also maps tool results back by name, but does not include `functionResponse.id`.

### Stream Hardening

Gemini CLI validates streamed model responses and classifies invalid streams, including malformed function calls, unexpected tool calls, missing finish reasons, and empty text. It retries recoverable content errors with a cap.

Alpha streams Gemini chunks directly into the native tool call parser and finalizes incomplete tool calls at stream end. This is good for resilience, but it lacks provider-aware retry and telemetry for malformed Gemini streams.

### Tool Scheduler

Gemini CLI centralizes tool execution in a scheduler:

- Unknown tool names become structured function responses.
- Invalid tool arguments become structured function responses before execution.
- Approval and policy checks happen before execution.
- Contiguous independent calls can run in parallel.
- `wait_for_previous` lets the model force serialization when a later call depends on earlier output.
- Each tool call gets exactly one response part.

Alpha currently processes tool calls mainly through `presentAssistantMessage`. It has good defensive behavior, including rejected-tool handling and `validateToolResultIds`, but validation and repair are distributed across parsing, presentation, task history, and provider conversion.

### Gemini-Safe Tool Names

Gemini CLI sanitizes MCP tool names to satisfy Gemini function-name rules and a 64-character limit, while keeping a mapping back to the original MCP server and tool.

Alpha supports dynamic MCP names such as `mcp--server--tool`, but Vertex/Gemini compatibility would be stronger with explicit sanitization, truncation, and reverse mapping before function declarations are sent.

## Priority Recommendations

### P0

1. Enable `allowedFunctionNames` for Vertex Gemini.

    In `Task.ts`, Alpha currently enables the include-all-tools-with-restrictions behavior only for `apiProvider === "gemini"`. Vertex Gemini should use the same path when the selected Vertex model is Gemini, not Claude. This keeps full tool schemas available while still restricting the current turn's allowed tools.

2. Preserve Gemini function call IDs.

    In `GeminiHandler.createMessage()`, use `part.functionCall.id` when present. Only synthesize an ID when the provider omits one, and include enough scope to avoid collisions. In `gemini-format.ts`, include that ID in the outgoing `functionResponse`.

3. Add invalid-stream classification and retry for Gemini and Vertex Gemini.

    Classify malformed function calls, unexpected tool calls, missing finish reasons, and empty/no-text streams. Retry only recoverable content errors with a bounded attempt count. Add telemetry by provider, resolved model, gateway route, and error type.

4. Add Anthropic Vertex gateway support.

    Alpha's Gemini Vertex handler supports `vertexGatewayBaseUrl`, gateway headers, Helix token refresh, custom CA bundles, and model routing. `AnthropicVertexHandler` does not currently have equivalent gateway wiring. Since the company gateway fronts both Gemini and Anthropic through Vertex AI, gateway concerns should be shared or duplicated intentionally.

5. Add Vertex routing header settings.

    Mirror Gemini CLI's `X-Vertex-AI-LLM-Request-Type` and `X-Vertex-AI-LLM-Shared-Request-Type`. Extend `getVertexGatewayHeaders()` and provider settings. If Settings UI is touched, bind inputs to `cachedState`, not live extension state.

### P1

6. Introduce a central tool-call preflight/scheduler layer.

    Move toward Gemini CLI's model: normalize tool names, validate schema, check policy/approval, execute, and emit exactly one structured result for each tool call. This should reduce reactive history repair and provider-specific tool-result failures.

7. Add `wait_for_previous` to tool schemas and execution semantics.

    Alpha currently advertises `parallelToolCalls: true`, but tool execution is effectively sequential through the assistant message presenter. A scheduler can let the model choose parallel execution for independent calls and serialization for dependent calls.

8. Sanitize MCP tool names for Gemini.

    Add a Vertex/Gemini-safe tool declaration name layer with length and character validation, plus a reverse mapping to Alpha's MCP server/tool identity.

9. Enforce Gemini function-response adjacency.

    Add a Vertex Gemini invariant that no injected context, condense message, or extra user message can appear between an assistant function call and the corresponding user function response.

10. Normalize tool errors.

    Return structured tool errors such as `{ error, errorType }` for unknown tools, invalid params, rejected tools, execution failures, and interrupted execution. Avoid free-form text repairs when a provider-native tool response is required.

11. Harden Vertex Gemini history curation.

    Before converting to Gemini content, drop or repair empty assistant messages, malformed tool calls, duplicate tool IDs, and orphaned tool results. Alpha already has `validateToolResultIds`; this should become part of a provider-aware history preparation step.

12. Add Vertex/gateway observability.

    Log the selected provider path, resolved model ID, gateway route, auth mode, function-call finish reason, invalid-stream type, tool validation error type, and any duplicate/missing tool ID repair count.

### P2

13. Make tool schemas model-aware.

    Alpha already excludes `apply_diff` and includes `edit` for Gemini/Vertex. Extend this into a model-aware schema layer similar to Gemini CLI's `getFunctionDeclarations(modelId)`.

14. Add Vertex-specific context tests.

    Cover condense/truncation behavior when recent history contains pending or completed tool calls, especially for Gemini function-response adjacency.

15. Add provider evals around tool calling.

    Use targeted cases for Vertex Gemini restricted modes, parallel tool requests, rejected tools, malformed args, missing call IDs, duplicate IDs, Anthropic Vertex gateway routing, and MCP tools with long names.

## Suggested Implementation Sequence

### Phase 1: Low-Risk Compatibility Fixes

- Treat Vertex Gemini like direct Gemini for `allowedFunctionNames`.
- Preserve provider function call IDs and include `functionResponse.id`.
- Add Vertex request type and shared request type headers.
- Add focused tests for Gemini conversion, Vertex provider tool restrictions, and gateway headers.

### Phase 2: Gateway And Stream Robustness

- Add Anthropic Vertex gateway support or a shared Vertex gateway transport/auth abstraction.
- Add invalid-stream classification, bounded retry, and telemetry for Gemini/Vertex Gemini.
- Add Gemini-safe MCP function-name mapping.

### Phase 3: Orchestration Alignment

- Introduce a central tool-call preflight/scheduler.
- Add `wait_for_previous` to schemas and execution.
- Enforce provider-specific history invariants before each request.
- Add evals that compare Gemini direct, Vertex Gemini, and Anthropic Vertex behavior.

## Acceptance Criteria

- Vertex Gemini restricted modes behave the same as direct Gemini for tool declarations and `allowedFunctionNames`.
- Gemini function call IDs are stable across stream parsing, execution, history storage, and `functionResponse` conversion.
- Anthropic models behind the Vertex gateway can use the same gateway base URL, auth refresh, custom headers, and CA bundle behavior expected by Gemini Vertex.
- Malformed Gemini streams produce classified retry/telemetry instead of generic tool-call failures.
- Every provider-native tool call produces exactly one provider-native tool response.
- Gemini/Vertex requests never place unrelated user content between a model function call and its function response.
- MCP tools sent to Vertex Gemini satisfy Gemini function-name constraints and still resolve to the original MCP server/tool.
