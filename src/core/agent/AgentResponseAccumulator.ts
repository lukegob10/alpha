import type { ApiStreamChunk } from "../../api/transform/stream"
import type { AgentResponse, AgentResponseItem, AgentToolCall } from "./AgentResponse"

interface PendingToolCall {
	id: string
	name: string
	arguments: string
	index?: number
}

function parseToolArguments(argumentsText: string): unknown {
	if (!argumentsText.trim()) {
		return undefined
	}

	try {
		return JSON.parse(argumentsText)
	} catch {
		return undefined
	}
}

/**
 * Accumulates the shared ApiStreamChunk transport into canonical response
 * items. Text-like items are emitted immediately; tool calls are held until
 * the provider stream completes. Keeping tool calls in their first-seen map
 * order also prevents out-of-order end markers from changing model order.
 */
export class AgentResponseAccumulator {
	private readonly items: AgentResponseItem[] = []
	private readonly pendingTools = new Map<string, PendingToolCall>()
	private readonly pendingToolIndexes = new Map<number, string>()
	private readonly emittedToolIds = new Set<string>()

	async add(chunk: ApiStreamChunk, onItem?: (item: AgentResponseItem) => Promise<void> | void): Promise<void> {
		switch (chunk.type) {
			case "text":
				return this.emit({ type: "text", text: chunk.text }, onItem)

			case "reasoning":
				return this.emit(
					{ type: "reasoning", text: chunk.text, ...(chunk.signature ? { signature: chunk.signature } : {}) },
					onItem,
				)

			case "thinking_complete": {
				const lastReasoning = [...this.items].reverse().find((item) => item.type === "reasoning")
				if (lastReasoning?.type === "reasoning") {
					lastReasoning.signature = chunk.signature
				}
				return
			}

			case "usage":
				return this.emit(
					{
						type: "usage",
						inputTokens: chunk.inputTokens,
						outputTokens: chunk.outputTokens,
						...(chunk.cacheWriteTokens !== undefined ? { cacheWriteTokens: chunk.cacheWriteTokens } : {}),
						...(chunk.cacheReadTokens !== undefined ? { cacheReadTokens: chunk.cacheReadTokens } : {}),
						...(chunk.reasoningTokens !== undefined ? { reasoningTokens: chunk.reasoningTokens } : {}),
						...(chunk.totalCost !== undefined ? { totalCost: chunk.totalCost } : {}),
					},
					onItem,
				)

			case "grounding":
				return this.emit({ type: "grounding", sources: chunk.sources }, onItem)

			case "error":
				return this.emit({ type: "error", message: chunk.message || chunk.error }, onItem)

			case "tool_call": {
				const pending = this.pendingTools.get(chunk.id)
				if (pending) {
					if (!pending.name) {
						pending.name = chunk.name
					}
					if (!pending.arguments.trim()) {
						pending.arguments = chunk.arguments
					}
					return
				}

				this.pendingTools.set(chunk.id, {
					id: chunk.id,
					name: chunk.name,
					arguments: chunk.arguments,
				})
				return
			}

			case "tool_call_start": {
				const pending = this.pendingTools.get(chunk.id)
				if (pending) {
					if (!pending.name) {
						pending.name = chunk.name
					}
					return
				}

				this.pendingTools.set(chunk.id, { id: chunk.id, name: chunk.name, arguments: "" })
				return
			}

			case "tool_call_delta": {
				const pending = this.pendingTools.get(chunk.id) ?? {
					id: chunk.id,
					name: "",
					arguments: "",
				}
				pending.arguments += chunk.delta
				this.pendingTools.set(chunk.id, pending)
				return
			}

			case "tool_call_end": {
				return
			}

			case "tool_call_partial": {
				const indexedId = this.pendingToolIndexes.get(chunk.index)
				let id = indexedId ?? chunk.id ?? `stream-tool-${chunk.index}`
				let pending = this.pendingTools.get(id)

				// Some Responses API streams emit argument deltas before the stable
				// call ID. Migrate the index placeholder when that ID arrives.
				if (pending && chunk.id && id !== chunk.id) {
					this.pendingTools.delete(id)
					pending.id = chunk.id
					this.pendingTools.set(chunk.id, pending)
					id = chunk.id
				}

				pending ??= {
					id,
					name: chunk.name ?? "",
					arguments: "",
					index: chunk.index,
				}

				if (chunk.name && !pending.name) {
					pending.name = chunk.name
				}
				if (typeof chunk.arguments === "string" && chunk.arguments.length > 0) {
					pending.arguments += chunk.arguments
				}

				this.pendingTools.set(id, pending)
				this.pendingToolIndexes.set(chunk.index, id)
				return
			}
		}
	}

	async finish(onItem?: (item: AgentResponseItem) => Promise<void> | void): Promise<AgentResponse> {
		for (const pending of this.pendingTools.values()) {
			await this.emitToolCall(pending.id, pending.name, pending.arguments, onItem)
		}

		this.pendingTools.clear()
		this.pendingToolIndexes.clear()

		return {
			items: [...this.items],
			text: this.items
				.filter((item): item is Extract<AgentResponseItem, { type: "text" }> => item.type === "text")
				.map((item) => item.text)
				.join(""),
			reasoning: this.items
				.filter((item): item is Extract<AgentResponseItem, { type: "reasoning" }> => item.type === "reasoning")
				.map((item) => item.text)
				.join(""),
			toolCalls: this.items.filter((item): item is AgentToolCall => item.type === "tool_call"),
		}
	}

	private async emitToolCall(
		id: string,
		name: string,
		argumentsText: string,
		onItem?: (item: AgentResponseItem) => Promise<void> | void,
	): Promise<void> {
		if (this.emittedToolIds.has(id)) {
			return
		}

		this.emittedToolIds.add(id)
		const argumentsValue = parseToolArguments(argumentsText)
		if (argumentsValue === undefined) {
			await this.emit(
				{
					type: "error",
					message: argumentsText.trim()
						? `Unable to parse arguments for tool call "${name}" (${id}).`
						: `Tool call "${name}" (${id}) did not provide complete arguments.`,
					callId: id,
					toolName: name,
				},
				onItem,
			)
			return
		}

		await this.emit({ type: "tool_call", id, name, arguments: argumentsValue }, onItem)
	}

	private async emit(item: AgentResponseItem, onItem?: (item: AgentResponseItem) => Promise<void> | void) {
		this.items.push(item)
		await onItem?.(item)
	}
}

export async function collectAgentResponse(
	stream: AsyncIterable<ApiStreamChunk>,
	onItem?: (item: AgentResponseItem) => Promise<void> | void,
): Promise<AgentResponse> {
	const accumulator = new AgentResponseAccumulator()
	for await (const chunk of stream) {
		await accumulator.add(chunk, onItem)
	}
	return accumulator.finish(onItem)
}
