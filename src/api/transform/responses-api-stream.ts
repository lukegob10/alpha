import type {
	ApiStream,
	ApiStreamChunk,
	ApiStreamError,
	ApiStreamOutcomeChunk,
	ApiStreamRequestMetadata,
	ApiStreamUsageChunk,
} from "./stream"
import {
	createApiStreamOutcome,
	getApiStreamErrorMessage,
	isApiStreamSemanticChunk,
	iterateApiStreamWithAbort,
	normalizeApiStreamErrorMetadata,
} from "./stream"

type PendingToolCallIdentity = {
	callId: string
	name?: string
	outputIndex: number
}

/**
 * Lifecycle behavior is opt-in for this low-level transform. This keeps the
 * many legacy Responses adapters source-compatible while allowing native
 * providers to require explicit terminal outcomes and abort behavior.
 */
export interface ProcessResponsesApiStreamOptions extends ApiStreamRequestMetadata {
	/** Emit error/outcome chunks instead of exposing only a thrown error. */
	emitLifecycle?: boolean
	/** Throw after yielding a failed outcome (legacy provider compatibility). */
	throwOnError?: boolean
	/** Provider phase used when the event has no phase of its own. */
	phase?: string
}

export type ResponsesTerminal = {
	status: "completed" | "failed" | "incomplete" | "cancelled"
	reason?: string
	error?: unknown
	phase?: string
	eventType?: string
}

function statusFromValue(value: unknown): ResponsesTerminal["status"] | undefined {
	if (value === "completed" || value === "complete" || value === "done" || value === "succeeded") {
		return "completed"
	}
	if (value === "failed" || value === "error") return "failed"
	if (value === "cancelled" || value === "canceled") return "cancelled"
	if (value === "incomplete") return "incomplete"
	return undefined
}

/** Normalize the known Responses terminal events, including status-bearing done events. */
export function getResponsesApiTerminal(event: any): ResponsesTerminal | undefined {
	const type = typeof event?.type === "string" ? event.type : ""
	const responseStatus = statusFromValue(event?.response?.status ?? event?.status)
	if (type === "response.failed" || type === "response.error" || type === "error") {
		return {
			status: "failed",
			reason: getApiStreamErrorMessage(event?.error ?? event?.response?.error ?? event, "Unknown error"),
			error: event?.error ?? event?.response?.error ?? event,
			phase: event?.phase,
			eventType: type,
		}
	}
	if (type === "response.incomplete") {
		const details = event?.response?.incomplete_details ?? event?.incomplete_details
		return {
			status: "incomplete",
			reason:
				typeof event?.reason === "string"
					? event.reason
					: typeof details?.reason === "string"
						? details.reason
						: "Response incomplete",
			phase: event?.phase,
		}
	}
	if (type === "response.completed" || type === "response.done") {
		const status = responseStatus ?? "completed"
		return {
			status,
			reason:
				status === "failed"
					? getApiStreamErrorMessage(event?.error ?? event?.response?.error ?? event, "Unknown error")
					: status === "incomplete"
						? getApiStreamErrorMessage(
								event?.response?.incomplete_details ?? event?.incomplete_details,
								"Response incomplete",
							)
						: undefined,
			phase: event?.phase,
		}
	}
	return undefined
}

function formatTerminalError(terminal: ResponsesTerminal): string {
	const reason = terminal.reason || "Unknown error"
	if (terminal.status === "failed") {
		// Keep the historical distinction used by existing callers/tests.
		return terminal.eventType === "response.failed"
			? `Response failed: ${reason}`
			: `Responses API error: ${reason}`
	}
	return reason
}

function errorChunkForTerminal(
	terminal: ResponsesTerminal,
	options: ProcessResponsesApiStreamOptions,
	semanticOutputObserved: boolean,
	eventType?: string,
): ApiStreamError {
	const raw = terminal.error
	const metadata = normalizeApiStreamErrorMetadata(
		raw,
		{ requestId: options.requestId, attemptId: options.attemptId },
		{ phase: terminal.phase ?? options.phase, semanticOutputObserved },
	)
	return {
		type: "error",
		error:
			metadata.code ??
			(eventType === "response.failed"
				? "ResponseFailed"
				: terminal.status === "failed"
					? "ResponseError"
					: "ResponseIncomplete"),
		message: terminal.reason || (terminal.status === "failed" ? "Unknown error" : "Response incomplete"),
		...(metadata.code !== undefined ? { code: metadata.code } : {}),
		...(metadata.status !== undefined ? { status: metadata.status } : {}),
		...(metadata.statusCode !== undefined ? { statusCode: metadata.statusCode } : {}),
		...(metadata.retryable !== undefined ? { retryable: metadata.retryable } : {}),
		...(metadata.phase !== undefined ? { phase: metadata.phase } : {}),
		...(metadata.requestId !== undefined ? { requestId: metadata.requestId } : {}),
		...(metadata.attemptId !== undefined ? { attemptId: metadata.attemptId } : {}),
		semanticOutputObserved,
		...(metadata.metadata !== undefined ? { metadata: metadata.metadata } : {}),
	}
}

function enrichThrownResponsesError(error: unknown, chunk: ApiStreamError): Error {
	const enriched = (error instanceof Error ? error : new Error(chunk.message)) as Error &
		Partial<ApiStreamError> & { reason?: string; terminal?: boolean; errorCode?: string }
	Object.assign(enriched, {
		terminal: true,
		reason: chunk.message,
		errorCode: chunk.error,
		...(chunk.code !== undefined ? { code: chunk.code } : {}),
		...(chunk.status !== undefined ? { status: chunk.status } : {}),
		...(chunk.statusCode !== undefined ? { statusCode: chunk.statusCode } : {}),
		...(chunk.retryable !== undefined ? { retryable: chunk.retryable } : {}),
		...(chunk.phase !== undefined ? { phase: chunk.phase } : {}),
		...(chunk.requestId !== undefined ? { requestId: chunk.requestId } : {}),
		...(chunk.attemptId !== undefined ? { attemptId: chunk.attemptId } : {}),
		...(chunk.semanticOutputObserved !== undefined ? { semanticOutputObserved: chunk.semanticOutputObserved } : {}),
		...(chunk.metadata !== undefined ? { metadata: chunk.metadata } : {}),
	})
	return enriched
}

/**
 * Processes Responses API stream events and yields ApiStreamChunks.
 *
 * In compatibility mode (the default), this retains the historical behavior:
 * usage is normalized, failed events throw, and EOF is silent. With
 * `emitLifecycle`, exactly one outcome is emitted for explicit terminal events
 * and terminal-less EOF; errors can either be yielded and returned or yielded
 * then rethrown via `throwOnError: true`.
 */
export async function* processResponsesApiStream(
	stream: AsyncIterable<any>,
	normalizeUsage: (usage: any) => ApiStreamUsageChunk | undefined,
	options: ProcessResponsesApiStreamOptions = {},
): ApiStream {
	const pendingToolCallsByItemId = new Map<string, PendingToolCallIdentity>()
	const pendingToolCallsByOutputIndex = new Map<number, PendingToolCallIdentity>()
	const streamedToolCallIds = new Set<string>()
	let lastPendingToolCall: PendingToolCallIdentity | undefined
	let semanticOutputObserved = false
	let terminalSeen = false
	const emitLifecycle = options.emitLifecycle === true
	const throwOnError = options.throwOnError ?? !emitLifecycle

	const yieldChunk = function* (chunk: ApiStreamChunk): Generator<ApiStreamChunk> {
		if (isApiStreamSemanticChunk(chunk)) semanticOutputObserved = true
		yield chunk
	}

	try {
		for await (const event of iterateApiStreamWithAbort(stream, options.signal)) {
			if (options.signal?.aborted) {
				terminalSeen = true
				if (emitLifecycle) {
					yield createApiStreamOutcome({
						status: "cancelled",
						terminal: true,
						semanticOutputObserved,
						reason: getApiStreamErrorMessage(options.signal.reason, "Request cancelled"),
						retryable: false,
						phase: options.phase ?? "stream",
						requestId: options.requestId,
						attemptId: options.attemptId,
					})
				}
				break
			}

			const terminal = getResponsesApiTerminal(event)
			if (terminal) {
				terminalSeen = true
				const eventType = typeof event?.type === "string" ? event.type : undefined
				if (terminal.status === "failed") {
					let errorChunk: ApiStreamError | undefined
					if (emitLifecycle) {
						errorChunk = errorChunkForTerminal(terminal, options, semanticOutputObserved, eventType)
						yield* yieldChunk(errorChunk)
						yield createApiStreamOutcome({
							status: "failed",
							terminal: true,
							semanticOutputObserved,
							reason: terminal.reason,
							retryable: errorChunk.retryable,
							phase: terminal.phase ?? options.phase ?? "stream",
							requestId: options.requestId,
							attemptId: options.attemptId,
						})
					}
					if (throwOnError) {
						const formatted = new Error(formatTerminalError({ ...terminal, eventType }))
						throw errorChunk ? enrichThrownResponsesError(formatted, errorChunk) : formatted
					}
					break
				}

				// Completion/incompletion can carry usage. Usage remains non-semantic.
				const usage = event?.response?.usage || event?.usage
				const usageData = normalizeUsage(usage)
				if (usageData) yield* yieldChunk(usageData)
				if (emitLifecycle) {
					yield createApiStreamOutcome({
						status: terminal.status,
						terminal: true,
						semanticOutputObserved,
						reason: terminal.reason,
						phase: terminal.phase ?? options.phase ?? "stream",
						requestId: options.requestId,
						attemptId: options.attemptId,
					})
				}
				break
			}

			// Text content deltas
			if (event?.type === "response.output_text.delta" || event?.type === "response.text.delta") {
				if (event?.delta) yield* yieldChunk({ type: "text", text: event.delta })
				continue
			}

			// Reasoning deltas
			if (
				event?.type === "response.reasoning_text.delta" ||
				event?.type === "response.reasoning.delta" ||
				event?.type === "response.reasoning_summary_text.delta" ||
				event?.type === "response.reasoning_summary.delta"
			) {
				if (event?.delta) yield* yieldChunk({ type: "reasoning", text: event.delta })
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
						if (outputIndex !== undefined) pendingToolCallsByOutputIndex.set(outputIndex, identity)
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
						yield* yieldChunk({ type: "tool_call", id: callId, name, arguments: args })
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
					yield* yieldChunk({
						type: "tool_call_partial",
						index: outputIndex ?? correlated?.outputIndex ?? 0,
						id: callId,
						name,
						arguments: typeof event.delta === "string" ? event.delta : "",
					})
				}
				continue
			}
		}

		if (!terminalSeen && options.signal?.aborted) {
			if (emitLifecycle) {
				yield createApiStreamOutcome({
					status: "cancelled",
					terminal: true,
					semanticOutputObserved,
					reason: getApiStreamErrorMessage(options.signal.reason, "Request cancelled"),
					retryable: false,
					phase: options.phase ?? "stream",
					requestId: options.requestId,
					attemptId: options.attemptId,
				})
			}
		} else if (!terminalSeen && emitLifecycle) {
			yield createApiStreamOutcome({
				status: "incomplete",
				terminal: false,
				semanticOutputObserved,
				reason: "Responses API stream ended without a terminal event",
				retryable: true,
				phase: options.phase ?? "stream",
				requestId: options.requestId,
				attemptId: options.attemptId,
			})
		}
	} catch (error) {
		if (options.signal?.aborted) {
			if (emitLifecycle && !terminalSeen) {
				yield createApiStreamOutcome({
					status: "cancelled",
					terminal: true,
					semanticOutputObserved,
					reason: getApiStreamErrorMessage(options.signal.reason, "Request cancelled"),
					retryable: false,
					phase: options.phase ?? "stream",
					requestId: options.requestId,
					attemptId: options.attemptId,
				})
			}
			return
		}
		if (emitLifecycle && !terminalSeen) {
			// A transport/iterator failure has no Responses terminal event, but it
			// still needs a canonical failed outcome so callers do not mistake an
			// abrupt stream for an incomplete response. Keep the legacy throw
			// behavior configurable for hosts that use exceptions for retries.
			const metadata = normalizeApiStreamErrorMetadata(
				error,
				{ requestId: options.requestId, attemptId: options.attemptId },
				{ phase: options.phase ?? "stream", semanticOutputObserved },
			)
			const errorChunk: ApiStreamError = {
				type: "error",
				error: metadata.code ?? "StreamError",
				message: getApiStreamErrorMessage(error),
				...(metadata.code !== undefined ? { code: metadata.code } : {}),
				...(metadata.status !== undefined ? { status: metadata.status } : {}),
				...(metadata.statusCode !== undefined ? { statusCode: metadata.statusCode } : {}),
				...(metadata.retryable !== undefined ? { retryable: metadata.retryable } : {}),
				...(metadata.phase !== undefined ? { phase: metadata.phase } : {}),
				...(metadata.requestId !== undefined ? { requestId: metadata.requestId } : {}),
				...(metadata.attemptId !== undefined ? { attemptId: metadata.attemptId } : {}),
				semanticOutputObserved,
				...(metadata.metadata !== undefined ? { metadata: metadata.metadata } : {}),
			}
			terminalSeen = true
			yield errorChunk
			yield createApiStreamOutcome({
				status: "failed",
				terminal: true,
				semanticOutputObserved,
				reason: errorChunk.message,
				retryable: errorChunk.retryable,
				phase: errorChunk.phase ?? options.phase ?? "stream",
				requestId: options.requestId,
				attemptId: options.attemptId,
			})
			if (throwOnError) throw enrichThrownResponsesError(error, errorChunk)
			return
		}
		throw error
	}
}

/** Creates a standard usage normalizer for providers with per-token pricing. */
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
