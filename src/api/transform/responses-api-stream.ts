import type { ApiStream, ApiStreamUsageChunk } from "./stream"

type PendingToolCallIdentity = {
	callId: string
	name?: string
	outputIndex: number
}

/**
 * Processes Responses API stream events and yields ApiStreamChunks.
 *
 * This is a shared utility for providers that use OpenAI's Responses API
 * (POST /v1/responses with stream: true). It handles the core event types:
 *
 * - Text deltas (response.output_text.delta)
 * - Reasoning deltas (response.reasoning_text.delta, response.reasoning_summary_text.delta)
 * - Tool/function calls (response.output_item.done with function_call type)
 * - Usage data (response.completed)
 *
 * Provider-specific concerns such as WebSocket mode and SSE fallback are intentionally
 * left to individual providers.
 *
 * @param stream - AsyncIterable of Responses API stream events
 * @param normalizeUsage - Provider-specific function to normalize usage data into ApiStreamUsageChunk
 */
export async function* processResponsesApiStream(
	stream: AsyncIterable<any>,
	normalizeUsage: (usage: any) => ApiStreamUsageChunk | undefined,
): ApiStream {
	const pendingToolCallsByItemId = new Map<string, PendingToolCallIdentity>()
	const pendingToolCallsByOutputIndex = new Map<number, PendingToolCallIdentity>()
	const streamedToolCallIds = new Set<string>()
	let lastPendingToolCall: PendingToolCallIdentity | undefined

	for await (const event of stream) {
		// Text content deltas
		if (event?.type === "response.output_text.delta" || event?.type === "response.text.delta") {
			if (event?.delta) {
				yield { type: "text", text: event.delta }
			}
			continue
		}

		// Reasoning deltas
		if (
			event?.type === "response.reasoning_text.delta" ||
			event?.type === "response.reasoning.delta" ||
			event?.type === "response.reasoning_summary_text.delta" ||
			event?.type === "response.reasoning_summary.delta"
		) {
			if (event?.delta) {
				yield { type: "reasoning", text: event.delta }
			}
			continue
		}

		// Output item events establish the item_id/output_index -> call_id/name mapping.
		if (event?.type === "response.output_item.added" || event?.type === "response.output_item.done") {
			const item = event?.item
			if (item?.type === "function_call" || item?.type === "tool_call") {
				const callId = item.call_id || item.tool_call_id || item.id
				const name = item.name || item.function?.name
				const outputIndex =
					typeof event.output_index === "number"
						? event.output_index
						: typeof event.index === "number"
							? event.index
							: undefined
				if (typeof callId === "string" && callId.length > 0) {
					const identity: PendingToolCallIdentity = {
						callId,
						name: typeof name === "string" ? name : undefined,
						outputIndex: outputIndex ?? 0,
					}
					const itemId = item.id || event.item_id
					if (typeof itemId === "string" && itemId.length > 0) {
						pendingToolCallsByItemId.set(itemId, identity)
					}
					if (outputIndex !== undefined) {
						pendingToolCallsByOutputIndex.set(outputIndex, identity)
					}
					lastPendingToolCall = identity
				}
				const argsRaw = item.arguments || item.function?.arguments || item.input
				const args =
					typeof argsRaw === "string"
						? argsRaw
						: argsRaw && typeof argsRaw === "object"
							? JSON.stringify(argsRaw)
							: ""

				if (
					event.type === "response.output_item.done" &&
					typeof callId === "string" &&
					callId.length > 0 &&
					typeof name === "string" &&
					name.length > 0 &&
					!streamedToolCallIds.has(callId)
				) {
					yield {
						type: "tool_call",
						id: callId,
						name,
						arguments: args,
					}
				}
			}
			continue
		}

		// Function call argument deltas (for streaming tool calls)
		if (
			event?.type === "response.function_call_arguments.delta" ||
			event?.type === "response.tool_call_arguments.delta"
		) {
			const outputIndex =
				typeof event.output_index === "number"
					? event.output_index
					: typeof event.index === "number"
						? event.index
						: undefined
			const correlated =
				(typeof event.item_id === "string" ? pendingToolCallsByItemId.get(event.item_id) : undefined) ??
				(outputIndex !== undefined ? pendingToolCallsByOutputIndex.get(outputIndex) : undefined)
			const hasCorrelationFields =
				(typeof event.item_id === "string" && event.item_id.length > 0) || outputIndex !== undefined
			const callId =
				event.call_id ||
				event.tool_call_id ||
				correlated?.callId ||
				(!hasCorrelationFields ? event.id || lastPendingToolCall?.callId : undefined)
			const name =
				event.name ||
				event.function_name ||
				correlated?.name ||
				(!hasCorrelationFields ? lastPendingToolCall?.name : undefined)
			if (typeof callId === "string" && callId.length > 0 && typeof name === "string" && name.length > 0) {
				streamedToolCallIds.add(callId)
				yield {
					type: "tool_call_partial",
					index: outputIndex ?? correlated?.outputIndex ?? 0,
					id: callId,
					name,
					arguments: typeof event.delta === "string" ? event.delta : "",
				}
			}
			continue
		}

		// Completion events — extract usage
		if (event?.type === "response.completed" || event?.type === "response.done") {
			const usage = event?.response?.usage || event?.usage
			const usageData = normalizeUsage(usage)
			if (usageData) {
				yield usageData
			}
			continue
		}
	}
}

/**
 * Creates a standard usage normalizer for providers with per-token pricing.
 * Extracts input/output tokens, cache tokens, reasoning tokens, and computes cost.
 *
 * @param calculateCost - Optional function to compute total cost from token counts
 */
export function createUsageNormalizer(
	calculateCost?: (inputTokens: number, outputTokens: number, cacheReadTokens: number) => number,
): (usage: any) => ApiStreamUsageChunk | undefined {
	return (usage: any): ApiStreamUsageChunk | undefined => {
		if (!usage) return undefined

		const inputDetails = usage.input_tokens_details ?? usage.prompt_tokens_details
		const cachedTokens = inputDetails?.cached_tokens ?? 0

		const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0
		const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0
		const cacheReadTokens = usage.cache_read_input_tokens ?? cachedTokens ?? 0
		const cacheWriteTokens = usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0

		const reasoningTokens =
			typeof usage.output_tokens_details?.reasoning_tokens === "number"
				? usage.output_tokens_details.reasoning_tokens
				: undefined

		const totalCost = calculateCost ? calculateCost(inputTokens, outputTokens, cacheReadTokens) : undefined

		return {
			type: "usage",
			inputTokens,
			outputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
			...(typeof totalCost === "number" ? { totalCost } : {}),
		}
	}
}
