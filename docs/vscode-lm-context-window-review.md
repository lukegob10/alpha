# VS Code LM Context Window Review

Branch: `codex/review-vscode-lm-context`

## Scope

Review how Alpha determines and uses the context window for VS Code LM / GitHub Copilot models, with emphasis on GPT-5.5 and GPT-5.3-Codex, and identify why conversations can grow past the practical limit instead of condensing safely.

## Current Behavior

- VS Code LM model metadata is built in `src/api/providers/vscode-lm.ts`.
- Static Copilot model metadata is defined in `packages/types/src/providers/vscode-llm.ts`.
- Context management runs in `src/core/context-management/index.ts`, called from `src/core/task/Task.ts` before each API request.
- Successful condensation is implemented in `src/core/condense/index.ts` by tagging old messages with `condenseParent` and appending one summary user message.
- The effective API history is later filtered with `getEffectiveApiHistory()`.

## Findings

### 1. GPT-5.5 and GPT-5.3-Codex were statically configured as 128K

`packages/types/src/providers/vscode-llm.ts` defaulted Copilot models to `COPILOT_DEFAULT_CONTEXT_WINDOW = 128_000`. Neither `gpt-5.5` nor `gpt-5.3-codex` overrode that value.

The VS Code LM provider previously preferred the live VS Code `client.maxInputTokens` over static metadata:

```ts
contextWindow: typeof client.maxInputTokens === "number"
	? Math.max(0, client.maxInputTokens)
	: (staticInfo?.contextWindow ?? openAiModelInfoSaneDefaults.contextWindow)
```

The previous tests intentionally asserted 128K when Copilot GPT-5.5 and GPT-5.3-Codex report `maxInputTokens: 128_000`.

Decision: GPT-5.5 and GPT-5.3-Codex should be treated as 400K-token context models. The static metadata must set both to 400K, and known static metadata must not be reduced by a lower live `client.maxInputTokens` report.

### 2. Public VS Code documentation treats compaction as expected behavior

The VS Code docs define the context window as including the system prompt, custom instructions, conversation history, file contents, tool outputs, current message, and thinking tokens. They also state that VS Code automatically summarizes older conversation content when the context window fills, and that thinking tokens count toward the window.

Alpha does its own context management for this provider. It should therefore reserve enough budget for provider overhead, tool schemas, and invisible reasoning/thinking usage, not only visible history tokens.

### 3. The default automatic threshold is too late

`ClineProvider` defaults `autoCondenseContextPercent` to `100`, and `Task.attemptApiRequest()` passes that into `willManageContext()` / `manageContext()`.

Context management currently triggers when:

- `contextPercent >= effectiveThreshold`, or
- `prevContextTokens > contextWindow * 0.9 - reservedOutputTokens`.

With the default 100% threshold, the practical trigger is usually the hard safety calculation. That leaves little margin for:

- VS Code/Copilot provider-side prompt assembly overhead.
- Tool schema tokens.
- Hidden thinking tokens.
- Token counter undercounting.
- The current turn's environment details and tool output growth.

Impact: condensation can start too close to the provider limit.

### 4. Condensation itself sends the uncondensed history

When the threshold is reached, `summarizeConversation()` calls `apiHandler.createMessage()` with the messages to summarize. For automatic condensation this can include the same oversized history that is about to fail.

If the local calculation triggers after the provider's true request limit has already been crossed, the condensation call can fail before it can shrink anything.

Impact: a late condense trigger can be self-defeating.

### 5. Fallback truncation only runs when local accounting says the request is over limit

If summarization fails, `manageContext()` falls back to sliding-window truncation only when `prevContextTokens > allowedTokens`.

If the provider rejects due to uncounted overhead but Alpha's local accounting is still below `allowedTokens`, `manageContext()` returns the original messages plus an error instead of forcing truncation.

Impact: a condense failure caused by provider-side overhead may not reduce context.

### 6. VS Code LM context-window errors may not be detected

`checkContextWindowExceededError()` handles OpenAI `APIError`, OpenRouter-style objects, and Anthropic-style nested errors. It does not have a VS Code LM / Copilot plain-error path.

`VsCodeLmHandler` rethrows plain `Error` objects from `client.sendRequest()` unchanged.

Impact: if VS Code LM throws a plain error such as "prompt exceeds max input tokens" or similar, `Task.attemptApiRequest()` may skip the special context-window retry path and surface a normal API failure instead of forcing context reduction.

### 7. Context usage is based on previous request usage, not a fresh full preflight

`Task.getTokenUsage()` derives `contextTokens` from the last `api_req_started` or `condense_context` message. It is not a fresh count of the exact next request payload after history filtering, merge logic, tool selection, image cleanup, and provider conversion.

The current request adds `lastMessageTokens`, but the accounting can still differ from the final VS Code LM request, especially with tool definitions and conversion overhead.

Impact: the condense decision can lag behind the actual request size.

## Fix Plan

1. Confirm VS Code LM model budget semantics.

    - Treat `client.maxInputTokens` as the authoritative effective input budget for VS Code LM requests.
    - Keep static metadata as fallback only.
    - Rename or document this path as an effective input window, not necessarily the upstream model's total context.
    - Add telemetry/debug logging for `client.id`, `family`, `version`, `maxInputTokens`, static fallback, selected context window, output reserve, and condense threshold.

2. Keep GPT-5.5 and GPT-5.3-Codex static metadata at 400K.

    - Known static metadata now acts as the floor for VS Code LM context-window selection.
    - Unknown models still use the live VS Code `client.maxInputTokens` value when present.

3. Lower the default automatic condensation threshold for VS Code LM profiles.

    - Use a provider-specific default around 70-80% for VS Code LM.
    - Keep user/profile overrides respected.
    - This gives room for hidden thinking tokens, tool schemas, environment details, and provider overhead.

4. Add a provider-aware emergency reduction path.

    - If automatic condensation fails with any context-like error, force sliding-window truncation even if local `prevContextTokens` is below `allowedTokens`.
    - Prefer a bounded loop that repeats truncation until a fresh count is under a target such as 60-70% of the effective input window.

5. Extend context-window error detection for VS Code LM / Copilot.

    - Detect plain `Error` messages containing patterns such as `max input tokens`, `prompt is too long`, `too many tokens`, `context window`, `context length`, and `exceeds`.
    - Add tests for VS Code LM plain errors and ensure `attemptApiRequest()` retries through `handleContextWindowExceededError()`.

6. Add an exact preflight count for VS Code LM before `sendRequest()`.

    - Count the converted VS Code LM messages plus serialized tool schemas.
    - If the preflight exceeds a provider-specific target, return/throw a typed context-window error before sending.
    - This lets `Task` condense/truncate before the provider request fails.

7. Make condensation bounded.

    - Before calling the summarizer, choose only the oldest reducible slice that fits within a summarizer input budget.
    - Keep the newest messages and active tool-call adjacency safe.
    - If even that slice is too large, skip summarization and perform truncation first.

8. Tighten post-condense verification.

    - After condensation or truncation, recount the effective next request payload.
    - If it still exceeds the target budget, repeat reduction or surface a clear failure with actual counted tokens and selected window.

9. Add regression tests.
    - VS Code LM model info: live `maxInputTokens` wins; static fallback remains deterministic.
    - GPT-5.5 and GPT-5.3-Codex metadata expectations are explicit.
    - `willManageContext()` triggers early for VS Code LM defaults.
    - Condense failure caused by context overflow forces truncation.
    - VS Code LM plain context errors trigger the retry path.
    - Post-condense effective history excludes condensed messages and stays below target.

## Recommended First Patch

Start with the safest narrow patch:

1. Add VS Code LM plain-error context detection.
2. Force truncation when `summarizeConversation()` returns a context-window error.
3. Lower VS Code LM default auto-condense threshold to 75% when no user/profile threshold is set.
4. Add tests around those paths.

This addresses the observed failure mode without gambling on undocumented larger context windows.
