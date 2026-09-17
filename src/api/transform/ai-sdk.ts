/**
 * AI SDK conversion utilities for transforming between Anthropic/OpenAI formats and Vercel AI SDK formats.
 * These utilities are designed to be reused across different AI SDK providers.
 */

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { tool as createTool, jsonSchema, type ModelMessage, type TextStreamPart } from "ai"
import type {
	ApiStream,
	ApiStreamChunk,
	ApiStreamError,
	ApiStreamRequestMetadata,
	ApiStreamOutcomeChunk,
} from "./stream"
import {
	createApiStreamOutcome,
	getApiStreamErrorMessage,
	iterateApiStreamWithAbort,
	isApiStreamSemanticChunk,
	normalizeApiStreamErrorMetadata,
} from "./stream"

/**
 * Convert Anthropic messages to AI SDK ModelMessage format.
 * Handles text, images, tool uses, and tool results.
 *
 * @param messages - Array of Anthropic message parameters
 * @returns Array of AI SDK ModelMessage objects
 */
export function convertToAiSdkMessages(messages: Anthropic.Messages.MessageParam[]): ModelMessage[] {
	const modelMessages: ModelMessage[] = []

	// First pass: build a map of tool call IDs to tool names from assistant messages
	const toolCallIdToName = new Map<string, string>()
	for (const message of messages) {
		if (message.role === "assistant" && typeof message.content !== "string") {
			for (const part of message.content) {
				if (part.type === "tool_use") {
					toolCallIdToName.set(part.id, part.name)
				}
			}
		}
	}

	for (const message of messages) {
		if (typeof message.content === "string") {
			modelMessages.push({
				role: message.role,
				content: message.content,
			})
		} else {
			if (message.role === "user") {
				const parts: Array<
					{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }
				> = []
				const toolResults: Array<{
					type: "tool-result"
					toolCallId: string
					toolName: string
					output: { type: "text"; value: string }
				}> = []

				for (const part of message.content) {
					if (part.type === "text") {
						parts.push({ type: "text", text: part.text })
					} else if (part.type === "image") {
						// Handle both base64 and URL source types
						const source = part.source as { type: string; media_type?: string; data?: string; url?: string }
						if (source.type === "base64" && source.media_type && source.data) {
							parts.push({
								type: "image",
								image: `data:${source.media_type};base64,${source.data}`,
								mimeType: source.media_type,
							})
						} else if (source.type === "url" && source.url) {
							parts.push({
								type: "image",
								image: source.url,
							})
						}
					} else if (part.type === "tool_result") {
						// Convert tool results to string content
						let content: string
						if (typeof part.content === "string") {
							content = part.content
						} else {
							content =
								part.content
									?.map((c) => {
										if (c.type === "text") return c.text
										if (c.type === "image") return "(image)"
										return ""
									})
									.join("\n") ?? ""
						}
						// Look up the tool name from the tool call ID
						const toolName = toolCallIdToName.get(part.tool_use_id) ?? "unknown_tool"
						toolResults.push({
							type: "tool-result",
							toolCallId: part.tool_use_id,
							toolName,
							output: { type: "text", value: content || "(empty)" },
						})
					}
				}

				// AI SDK requires tool results in separate "tool" role messages
				// UserContent only supports: string | Array<TextPart | ImagePart | FilePart>
				// ToolContent (for role: "tool") supports: Array<ToolResultPart | ToolApprovalResponse>
				if (toolResults.length > 0) {
					modelMessages.push({
						role: "tool",
						content: toolResults,
					} as ModelMessage)
				}

				// Add user message with only text/image content (no tool results)
				if (parts.length > 0) {
					modelMessages.push({
						role: "user",
						content: parts,
					} as ModelMessage)
				}
			} else if (message.role === "assistant") {
				const textParts: string[] = []
				const toolCalls: Array<{
					type: "tool-call"
					toolCallId: string
					toolName: string
					input: unknown
				}> = []

				for (const part of message.content) {
					if (part.type === "text") {
						textParts.push(part.text)
					} else if (part.type === "tool_use") {
						toolCalls.push({
							type: "tool-call",
							toolCallId: part.id,
							toolName: part.name,
							input: part.input,
						})
					}
				}

				const content: Array<
					| { type: "text"; text: string }
					| { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
				> = []

				if (textParts.length > 0) {
					content.push({ type: "text", text: textParts.join("\n") })
				}
				content.push(...toolCalls)

				modelMessages.push({
					role: "assistant",
					content: content.length > 0 ? content : [{ type: "text", text: "" }],
				} as ModelMessage)
			}
		}
	}

	return modelMessages
}

/**
 * Convert OpenAI-style function tool definitions to AI SDK tool format.
 *
 * @param tools - Array of OpenAI tool definitions
 * @returns Record of AI SDK tools keyed by tool name, or undefined if no tools
 */
export function convertToolsForAiSdk(
	tools: OpenAI.Chat.ChatCompletionTool[] | undefined,
): Record<string, ReturnType<typeof createTool>> | undefined {
	if (!tools || tools.length === 0) {
		return undefined
	}

	const toolSet: Record<string, ReturnType<typeof createTool>> = {}

	for (const t of tools) {
		if (t.type === "function") {
			toolSet[t.function.name] = createTool({
				description: t.function.description,
				inputSchema: jsonSchema(t.function.parameters as any),
			})
		}
	}

	return toolSet
}

/**
 * Extended stream part type that includes additional fullStream event types
 * that are emitted at runtime but not included in the AI SDK TextStreamPart type definitions.
 */
export type ExtendedStreamPart =
	| TextStreamPart<any>
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }

export interface ProcessAiSdkStreamOptions extends ApiStreamRequestMetadata {
	/** Emit canonical outcome records for finish/error/abort events. */
	emitLifecycle?: boolean
	/** Throw after a failed outcome for callers preserving legacy error semantics. */
	throwOnError?: boolean
	/** Current semantic-output state when processing one part in isolation. */
	semanticOutputObserved?: boolean
	phase?: string
}

type AiSdkFinishOutcome = {
	status: "completed" | "failed" | "incomplete"
	reason?: string
	retryable?: boolean
}

/** Normalize finish and finish-step reasons through one terminal-status contract. */
function normalizeAiSdkFinishOutcome(reasonValue: unknown): AiSdkFinishOutcome & { finishReason: string } {
	const finishReason = String(reasonValue ?? "stop")
	const normalizedReason = finishReason.toLowerCase().replace(/_/g, "-")
	const status =
		normalizedReason === "error" || normalizedReason === "failed" || normalizedReason === "failure"
			? "failed"
			: normalizedReason === "length" ||
				  normalizedReason === "max-tokens" ||
				  normalizedReason === "content-filter" ||
				  normalizedReason === "content-filtered"
				? "incomplete"
				: "completed"
	return {
		finishReason,
		status,
		reason: status === "completed" ? undefined : finishReason,
		retryable: status === "failed" ? true : undefined,
	}
}

function enrichThrownStreamError(error: unknown, chunk: ApiStreamError): Error {
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
 * Process a single AI SDK stream part and yield the appropriate ApiStreamChunk(s).
 * This generator handles all TextStreamPart types and converts them to the
 * ApiStreamChunk format used by the application.
 *
 * @param part - The AI SDK TextStreamPart to process (including fullStream event types)
 * @yields ApiStreamChunk objects corresponding to the stream part
 */
export function* processAiSdkStreamPart(
	part: ExtendedStreamPart,
	options: ProcessAiSdkStreamOptions = {},
): Generator<ApiStreamChunk> {
	const emitLifecycle = options.emitLifecycle === true
	const semanticOutputObserved = options.semanticOutputObserved === true
	const yieldOutcome = (
		status: "completed" | "failed" | "incomplete" | "cancelled",
		terminal = true,
		reason?: string,
		retryable?: boolean,
	) =>
		emitLifecycle
			? createApiStreamOutcome({
					status,
					terminal,
					semanticOutputObserved,
					reason,
					retryable,
					phase: options.phase ?? "stream",
					requestId: options.requestId,
					attemptId: options.attemptId,
				})
			: undefined

	switch (part.type) {
		case "text":
		case "text-delta":
			yield { type: "text", text: (part as { text: string }).text }
			break

		case "reasoning":
		case "reasoning-delta":
			yield { type: "reasoning", text: (part as { text: string }).text }
			break

		case "tool-input-start":
			yield {
				type: "tool_call_start",
				id: part.id,
				name: part.toolName,
			}
			break

		case "tool-input-delta":
			yield {
				type: "tool_call_delta",
				id: part.id,
				delta: part.delta,
			}
			break

		case "tool-input-end":
			yield {
				type: "tool_call_end",
				id: part.id,
			}
			break

		case "tool-call":
			// Complete tool call - emit for compatibility
			yield {
				type: "tool_call",
				id: part.toolCallId,
				name: part.toolName,
				arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
			}
			break

		case "source":
			// Handle both URL and document source types
			if ("url" in part) {
				yield {
					type: "grounding",
					sources: [
						{
							title: part.title || "Source",
							url: part.url,
							snippet: undefined,
						},
					],
				}
			}
			break

		case "error":
			{
				const rawError = (part as any).error
				const metadata = normalizeApiStreamErrorMetadata(
					rawError,
					{ requestId: options.requestId, attemptId: options.attemptId },
					{ phase: options.phase ?? "stream", semanticOutputObserved },
				)
				const errorMessage = getApiStreamErrorMessage(rawError)
				// Keep the historical low-level shape when no lifecycle metadata was
				// requested. Native providers opt into the enriched shape so retry and
				// cancellation decisions retain their correlation context.
				const includeMetadata =
					emitLifecycle ||
					options.requestId !== undefined ||
					options.attemptId !== undefined ||
					options.phase !== undefined ||
					Object.prototype.hasOwnProperty.call(options, "semanticOutputObserved")
				const errorChunk: ApiStreamError = includeMetadata
					? {
							type: "error",
							error: metadata.code ?? "StreamError",
							message: errorMessage,
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
					: { type: "error", error: "StreamError", message: errorMessage }
				yield errorChunk
				const outcome = yieldOutcome("failed", true, errorChunk.message, errorChunk.retryable)
				if (outcome) yield outcome
				if (emitLifecycle && (options.throwOnError ?? false)) {
					throw enrichThrownStreamError(rawError, errorChunk)
				}
			}
			break

		case "finish": {
			const normalized = normalizeAiSdkFinishOutcome((part as any).finishReason ?? (part as any).reason)
			const outcome = yieldOutcome(normalized.status, true, normalized.reason, normalized.retryable)
			if (outcome) yield outcome
			break
		}

		case "abort": {
			const outcome = yieldOutcome(
				"cancelled",
				true,
				getApiStreamErrorMessage((part as any).reason, "Request cancelled"),
				false,
			)
			if (outcome) yield outcome
			break
		}

		case "finish-step": {
			// Some AI SDK versions only expose the terminal reason on finish-step.
			if (emitLifecycle && ((part as any).finishReason !== undefined || (part as any).reason !== undefined)) {
				const normalized = normalizeAiSdkFinishOutcome((part as any).finishReason ?? (part as any).reason)
				const outcome = yieldOutcome(normalized.status, true, normalized.reason, normalized.retryable)
				if (outcome) yield outcome
			}
			break
		}

		/*
		 * Keep this branch next to the old error mapping so adding lifecycle
		 * fields does not change legacy `processAiSdkStreamPart` output.
		 */
		/* istanbul ignore next */
		default:
			break
	}
}

/** Normalize a complete AI SDK fullStream with terminal-less EOF detection. */
export async function* processAiSdkStream(
	stream: AsyncIterable<ExtendedStreamPart>,
	options: ProcessAiSdkStreamOptions = {},
): ApiStream {
	let semanticOutputObserved = false
	let terminalSeen = false
	const emitLifecycle = options.emitLifecycle === true

	try {
		for await (const part of iterateApiStreamWithAbort(stream, options.signal)) {
			// A fullStream may repeat finish/abort markers. Once one terminal
			// outcome has been emitted, ignore all subsequent parts so the first
			// terminal status remains authoritative.
			if (terminalSeen) break

			if (options.signal?.aborted) break
			for (const chunk of processAiSdkStreamPart(part, { ...options, semanticOutputObserved })) {
				if (isApiStreamSemanticChunk(chunk)) semanticOutputObserved = true
				if (chunk.type === "outcome") terminalSeen = true
				yield chunk
			}
			if (part.type === "finish" || part.type === "abort") terminalSeen = true
		}
	} catch (error) {
		if (options.signal?.aborted) {
			if (emitLifecycle && !terminalSeen) {
				terminalSeen = true
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
				return
			}
			return
		}
		if (emitLifecycle && !terminalSeen) {
			// Preserve an abrupt SDK iterator failure as a canonical failed outcome
			// rather than silently classifying it as terminal-less EOF.
			terminalSeen = true
			const errorChunks = processAiSdkStreamPart({ type: "error", error } as ExtendedStreamPart, {
				...options,
				emitLifecycle: true,
				throwOnError: false,
				semanticOutputObserved,
			})
			let normalizedError: ApiStreamError | undefined
			for (const chunk of errorChunks) {
				if (chunk.type === "error") normalizedError = chunk
				yield chunk
			}
			if (options.throwOnError) {
				throw normalizedError ? enrichThrownStreamError(error, normalizedError) : error
			}
			return
		}
		throw error
	} finally {
		if (emitLifecycle && !terminalSeen) {
			yield createApiStreamOutcome({
				status: options.signal?.aborted ? "cancelled" : "incomplete",
				terminal: options.signal?.aborted ? true : false,
				semanticOutputObserved,
				reason: options.signal?.aborted
					? getApiStreamErrorMessage(options.signal.reason, "Request cancelled")
					: "AI SDK stream ended without a terminal event",
				retryable: options.signal?.aborted ? false : true,
				phase: options.phase ?? "stream",
				requestId: options.requestId,
				attemptId: options.attemptId,
			})
		}
	}
}
