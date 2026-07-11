import type { ApiStreamChunk, GroundingSource } from "../../api/transform/stream"

/**
 * Provider-neutral items emitted by a model response.
 *
 * Provider adapters remain responsible for converting their native response
 * shape into ApiStreamChunk. The turn engine only deals with these normalized
 * response items and never imports provider-specific message types.
 */
export type AgentResponseItem =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string; signature?: string }
	| { type: "tool_call"; id: string; name: string; arguments: unknown }
	| {
			type: "usage"
			inputTokens: number
			outputTokens: number
			cacheWriteTokens?: number
			cacheReadTokens?: number
			totalCost?: number
	  }
	| { type: "grounding"; sources: GroundingSource[] }
	| { type: "error"; message: string }

export type AgentToolCall = Extract<AgentResponseItem, { type: "tool_call" }>

export interface AgentResponse {
	items: AgentResponseItem[]
	text: string
	reasoning: string
	toolCalls: AgentToolCall[]
}

export interface AgentTurnStepResult<TInput> {
	response: AgentResponse
	nextInput: TInput | "complete"
}

/**
 * Host boundary for the first turn-engine extraction.
 *
 * Alpha's Task remains responsible for prompt construction, provider retries,
 * history persistence, tool execution, and UI events. The engine owns the
 * sequencing of these host-controlled steps and keeps the continuation state
 * out of the Task's outer loop.
 */
export interface AgentTurnHost<TInput> {
	runStep(input: TInput): Promise<AgentTurnStepResult<TInput>>
	shouldAbort(): boolean
	onStepComplete?(response: AgentResponse, step: number): Promise<void> | void
}

export interface AgentTurnOutcome {
	status: "completed" | "aborted"
	steps: number
}

/**
 * Provider-neutral agent turn sequencer.
 *
 * This intentionally does not implement tool scheduling yet. The host owns
 * the current tool policy for this first extraction; a later step can replace
 * that host callback with a typed scheduler without changing the loop.
 */
export class AgentTurnEngine<TInput> {
	constructor(private readonly host: AgentTurnHost<TInput>) {}

	async run(initialInput: TInput): Promise<AgentTurnOutcome> {
		let input = initialInput
		let steps = 0

		while (!this.host.shouldAbort()) {
			const result = await this.host.runStep(input)
			steps += 1

			await this.host.onStepComplete?.(result.response, steps)

			if (result.nextInput === "complete") {
				return {
					status: this.host.shouldAbort() ? "aborted" : "completed",
					steps,
				}
			}

			input = result.nextInput
		}

		return { status: "aborted", steps }
	}
}

interface PendingToolCall {
	id: string
	name: string
	arguments: string
	index?: number
}

function parseToolArguments(argumentsText: string): unknown {
	if (!argumentsText.trim()) {
		return {}
	}

	try {
		return JSON.parse(argumentsText)
	} catch {
		return undefined
	}
}

/**
 * Accumulates a provider stream into a normalized response.
 *
 * Text and reasoning chunks are forwarded as soon as they arrive. Tool calls
 * are held until their end marker (or stream completion) so consumers cannot
 * accidentally execute an incomplete call.
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
						...(chunk.totalCost !== undefined ? { totalCost: chunk.totalCost } : {}),
					},
					onItem,
				)

			case "grounding":
				return this.emit({ type: "grounding", sources: chunk.sources }, onItem)

			case "error":
				return this.emit({ type: "error", message: chunk.message || chunk.error }, onItem)

			case "tool_call":
				return this.emitToolCall(chunk.id, chunk.name, chunk.arguments, onItem)

			case "tool_call_start":
				this.pendingTools.set(chunk.id, { id: chunk.id, name: chunk.name, arguments: "" })
				return

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

			case "tool_call_end":
				return this.finalizeToolCall(chunk.id, onItem)

			case "tool_call_partial": {
				const id = chunk.id ?? this.pendingToolIndexes.get(chunk.index) ?? `stream-tool-${chunk.index}`
				const pending = this.pendingTools.get(id) ?? {
					id,
					name: chunk.name ?? "",
					arguments: "",
					index: chunk.index,
				}

				if (chunk.name) {
					pending.name = chunk.name
				}
				if (chunk.arguments) {
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

	private async finalizeToolCall(
		id: string,
		onItem?: (item: AgentResponseItem) => Promise<void> | void,
	): Promise<void> {
		const pending = this.pendingTools.get(id)
		if (!pending) {
			return
		}

		this.pendingTools.delete(id)
		await this.emitToolCall(pending.id, pending.name, pending.arguments, onItem)
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
				{ type: "error", message: `Unable to parse arguments for tool call "${name}" (${id}).` },
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
