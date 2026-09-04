import type { ApiStreamChunk } from "../../api/transform/stream"
import { sanitizeToolUseId } from "../../utils/tool-id"
import {
	createAgentResponse,
	type AgentResponse,
	type AgentResponseItem,
	type AgentResponseOutcome,
} from "./AgentResponse"

interface PendingToolCall {
	id: string
	name: string
	arguments: string
	/** Provider output index, when the stream supplied one. */
	index?: number
	/** Monotonic fallback for providers which do not expose an output index. */
	order: number
	/** True until a provider gives this call a stable non-empty ID. */
	syntheticId: boolean
	/** A `tool_call` chunk was seen for this call. */
	hasCompletePayload: boolean
	ended: boolean
}

type ParsedArguments = { ok: true; value: unknown } | { ok: false }

function parseToolArguments(argumentsText: string): ParsedArguments {
	if (!argumentsText.trim()) {
		return { ok: false }
	}

	try {
		return { ok: true, value: JSON.parse(argumentsText) }
	} catch {
		return { ok: false }
	}
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : ""
}

/**
 * Accumulates the shared ApiStreamChunk transport into canonical response
 * items. Text-like items are emitted as they arrive; tool calls are held
 * until the provider response is complete. A tool call is emitted at most
 * once, even when a provider sends both partial and complete markers.
 */
export class AgentResponseAccumulator {
	private readonly items: AgentResponseItem[] = []
	private readonly pendingTools = new Map<string, PendingToolCall>()
	private readonly pendingToolIndexes = new Map<number, string>()
	private readonly emittedToolIds = new Set<string>()
	private readonly emittedNormalizedToolIds = new Map<string, string>()
	private lastReasoningIndex: number | undefined
	private nextToolOrder = 0
	private nextSyntheticId = 0
	private finished = false
	private finishPromise: Promise<AgentResponse> | undefined
	private responseOutcome: AgentResponseOutcome | undefined

	async add(chunk: ApiStreamChunk, onItem?: (item: AgentResponseItem) => Promise<void> | void): Promise<void> {
		if (this.finished) {
			throw new Error("Cannot add a response chunk after the accumulator has finished.")
		}

		switch (chunk.type) {
			case "text":
				return this.emit({ type: "text", text: chunk.text }, onItem)

			case "reasoning": {
				const item: Extract<AgentResponseItem, { type: "reasoning" }> = {
					type: "reasoning",
					text: chunk.text,
					...(chunk.signature !== undefined ? { signature: chunk.signature } : {}),
				}
				this.lastReasoningIndex = this.items.length
				return this.emit(item, onItem)
			}

			case "thinking_complete": {
				const reasoningIndex = this.lastReasoningIndex
				const reasoning = reasoningIndex === undefined ? undefined : this.items[reasoningIndex]
				if (reasoning?.type === "reasoning") {
					// Keep an empty signature too: an explicitly supplied signature is
					// different from a provider which did not report one.
					reasoning.signature = chunk.signature
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
				return this.emit(
					{
						type: "grounding",
						sources: chunk.sources.map((source) => ({ ...source })),
					},
					onItem,
				)

			case "error":
				this.recordOutcome({
					status: "failed",
					reason: chunk.message || chunk.error || "Provider error",
					...(chunk.retryable !== undefined ? { retryable: chunk.retryable } : {}),
				})
				return this.emit(
					{
						type: "error",
						message: chunk.message || chunk.error || "Provider returned an unspecified error.",
						...(chunk.code !== undefined ? { code: chunk.code } : {}),
						...(chunk.retryable !== undefined ? { retryable: chunk.retryable } : {}),
					},
					onItem,
				)

			case "outcome":
				this.recordOutcome({
					status: chunk.status,
					...(chunk.reason !== undefined ? { reason: chunk.reason } : {}),
					...(chunk.retryable !== undefined ? { retryable: chunk.retryable } : {}),
				})
				return

			case "tool_call": {
				const id = asString(chunk.id)
				let pending = id ? this.pendingTools.get(id) : undefined
				if (!pending) {
					pending = this.createPending(id || this.createSyntheticId(), chunk.name, undefined, !id)
				} else if (!pending.name && chunk.name) {
					pending.name = chunk.name
				}

				const incomingArguments = asString(chunk.arguments)
				const current = parseToolArguments(pending.arguments)
				const incoming = parseToolArguments(incomingArguments)
				// A complete marker is authoritative when it repairs an incomplete
				// partial payload. Duplicate complete markers leave the first valid
				// payload untouched, which makes duplicate handling deterministic.
				if (
					!pending.arguments.trim() ||
					(!current.ok && incoming.ok) ||
					(!pending.hasCompletePayload && incomingArguments.length > 0)
				) {
					pending.arguments = incomingArguments
				}
				pending.hasCompletePayload = true
				return
			}

			case "tool_call_start": {
				const id = asString(chunk.id)
				const pending =
					(id ? this.pendingTools.get(id) : undefined) ??
					this.createPending(id || this.createSyntheticId(), chunk.name, undefined, !id)
				if (!pending.name && chunk.name) {
					pending.name = chunk.name
				}
				return
			}

			case "tool_call_delta": {
				const id = asString(chunk.id)
				const pending =
					(id ? this.pendingTools.get(id) : undefined) ??
					this.createPending(id || this.createSyntheticId(), "", undefined, !id)
				const delta = asString(chunk.delta)
				// Some providers repeat a complete payload as deltas. Do not corrupt
				// a valid payload, but allow invalid/empty complete payloads to heal.
				if (!pending.hasCompletePayload || !parseToolArguments(pending.arguments).ok) {
					pending.arguments += delta
				}
				return
			}

			case "tool_call_end": {
				const pending = this.pendingTools.get(asString(chunk.id))
				if (pending) {
					pending.ended = true
				}
				return
			}

			case "tool_call_partial": {
				const idFromChunk = asString(chunk.id)
				const idFromIndex = this.pendingToolIndexes.get(chunk.index)
				let pending = idFromChunk ? this.pendingTools.get(idFromChunk) : undefined
				if (!pending && idFromIndex) {
					pending = this.pendingTools.get(idFromIndex)
				}

				if (!pending) {
					pending = this.createPending(
						idFromChunk || this.createSyntheticId(chunk.index),
						asString(chunk.name),
						chunk.index,
						!idFromChunk,
					)
				} else if (idFromChunk && pending.id !== idFromChunk) {
					pending = this.migratePendingId(pending, idFromChunk)
				}

				if (pending.index === undefined) {
					pending.index = chunk.index
				} else {
					pending.index = Math.min(pending.index, chunk.index)
				}
				if (chunk.name && !pending.name) {
					pending.name = chunk.name
				}
				if (typeof chunk.arguments === "string" && chunk.arguments.length > 0) {
					if (!pending.hasCompletePayload || !parseToolArguments(pending.arguments).ok) {
						pending.arguments += chunk.arguments
					}
				}

				this.pendingToolIndexes.set(chunk.index, pending.id)
				return
			}
		}
	}

	async finish(
		onItem?: (item: AgentResponseItem) => Promise<void> | void,
		outcome?: AgentResponseOutcome,
	): Promise<AgentResponse> {
		if (this.finishPromise) {
			return this.finishPromise
		}

		this.finished = true
		if (outcome) this.recordOutcome(outcome)
		this.finishPromise = this.flushPendingTools(onItem)
		return this.finishPromise
	}

	private recordOutcome(outcome: AgentResponseOutcome): void {
		// Error chunks are semantic terminal evidence. Some provider adapters can
		// still surface a trailing finish marker; never let that nominal success
		// erase an already-observed failure, cancellation, or incomplete response.
		if (outcome.status === "completed" && this.responseOutcome && this.responseOutcome.status !== "completed") {
			return
		}
		this.responseOutcome = outcome
	}

	private async flushPendingTools(
		onItem?: (item: AgentResponseItem) => Promise<void> | void,
	): Promise<AgentResponse> {
		const pendingTools = [...this.pendingTools.values()].sort((left, right) => {
			if (left.index !== undefined && right.index !== undefined && left.index !== right.index) {
				return left.index - right.index
			}
			if (left.index !== undefined && right.index === undefined) return -1
			if (left.index === undefined && right.index !== undefined) return 1
			return left.order - right.order
		})

		for (const pending of pendingTools) {
			await this.emitToolCall(pending, onItem)
		}

		this.pendingTools.clear()
		this.pendingToolIndexes.clear()
		return createAgentResponse(this.items, this.responseOutcome)
	}

	private createPending(id: string, name: string, index?: number, syntheticId = false): PendingToolCall {
		const existing = this.pendingTools.get(id)
		if (existing) {
			if (!existing.name && name) existing.name = name
			if (index !== undefined) {
				existing.index = existing.index === undefined ? index : Math.min(existing.index, index)
				this.pendingToolIndexes.set(index, existing.id)
			}
			return existing
		}

		const pending: PendingToolCall = {
			id,
			name,
			arguments: "",
			index,
			order: this.nextToolOrder++,
			syntheticId,
			hasCompletePayload: false,
			ended: false,
		}
		this.pendingTools.set(id, pending)
		if (index !== undefined) {
			this.pendingToolIndexes.set(index, id)
		}
		return pending
	}

	private migratePendingId(pending: PendingToolCall, newId: string): PendingToolCall {
		if (pending.id === newId) return pending

		const existing = this.pendingTools.get(newId)
		if (existing && existing !== pending) {
			// A duplicate ID can be observed through two output indexes. Keep the
			// earliest record and only fill missing identity/payload fields.
			const pendingOldId = pending.id
			const existingId = existing.id
			const primary = existing.order <= pending.order ? existing : pending
			const secondary = primary === existing ? pending : existing
			if (!primary.name) primary.name = secondary.name
			if (!primary.arguments.trim()) primary.arguments = secondary.arguments
			primary.hasCompletePayload ||= secondary.hasCompletePayload
			primary.ended ||= secondary.ended
			if (secondary.index !== undefined) {
				primary.index = primary.index === undefined ? secondary.index : Math.min(primary.index, secondary.index)
			}
			this.pendingTools.delete(secondary.id)
			if (primary.id !== newId) {
				const oldPrimaryId = primary.id
				this.pendingTools.delete(oldPrimaryId)
				primary.id = newId
				primary.syntheticId = false
				this.pendingTools.set(newId, primary)
			}
			for (const [index, mappedId] of this.pendingToolIndexes) {
				if (mappedId === pendingOldId || mappedId === existingId || mappedId === secondary.id) {
					this.pendingToolIndexes.set(index, primary.id)
				}
			}
			return primary
		}

		const oldId = pending.id
		this.pendingTools.delete(oldId)
		pending.id = newId
		pending.syntheticId = false
		this.pendingTools.set(newId, pending)
		for (const [index, mappedId] of this.pendingToolIndexes) {
			if (mappedId === oldId) this.pendingToolIndexes.set(index, newId)
		}
		return pending
	}

	private createSyntheticId(index?: number): string {
		const base = index === undefined ? `stream-tool-${this.nextSyntheticId}` : `stream-tool-${index}`
		let candidate = base
		while (this.pendingTools.has(candidate)) {
			candidate = `${base}-${++this.nextSyntheticId}`
		}
		this.nextSyntheticId += 1
		return candidate
	}

	private async emitToolCall(
		pending: PendingToolCall,
		onItem?: (item: AgentResponseItem) => Promise<void> | void,
	): Promise<void> {
		if (this.emittedToolIds.has(pending.id)) {
			return
		}

		this.emittedToolIds.add(pending.id)
		const parsed = parseToolArguments(pending.arguments)
		if (pending.syntheticId) {
			const message = `Tool call "${pending.name}" (${pending.id}) did not provide a stable call ID.`
			this.recordOutcome({ status: "failed", reason: message, retryable: false })
			await this.emit(
				{
					type: "error",
					message,
					callId: pending.id,
					toolName: pending.name,
					retryable: false,
				},
				onItem,
			)
			return
		}
		if (!pending.name.trim()) {
			const message = `Tool call "${pending.id}" did not provide a tool name.`
			this.recordOutcome({ status: "failed", reason: message, retryable: false })
			await this.emit(
				{
					type: "error",
					message,
					callId: pending.id,
					retryable: false,
				},
				onItem,
			)
			return
		}
		if (!parsed.ok) {
			const message = pending.arguments.trim()
				? `Unable to parse arguments for tool call "${pending.name}" (${pending.id}).`
				: `Tool call "${pending.name}" (${pending.id}) did not provide complete arguments.`
			this.recordOutcome({ status: "failed", reason: message, retryable: false })
			await this.emit(
				{
					type: "error",
					message,
					callId: pending.id,
					toolName: pending.name,
					retryable: false,
				},
				onItem,
			)
			return
		}

		const normalizedId = sanitizeToolUseId(pending.id)
		const conflictingId = this.emittedNormalizedToolIds.get(normalizedId)
		if (conflictingId && conflictingId !== pending.id) {
			const message =
				`Tool call IDs "${conflictingId}" and "${pending.id}" normalize to the same persisted ID ` +
				`"${normalizedId}".`
			this.recordOutcome({ status: "failed", reason: message, retryable: false })
			await this.emit(
				{
					type: "error",
					message,
					callId: pending.id,
					toolName: pending.name,
					retryable: false,
				},
				onItem,
			)
			return
		}
		this.emittedNormalizedToolIds.set(normalizedId, pending.id)

		await this.emit({ type: "tool_call", id: pending.id, name: pending.name, arguments: parsed.value }, onItem)
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
