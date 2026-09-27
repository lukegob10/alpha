import type { ApiStreamChunk } from "../../api/transform/stream"
import { sanitizeToolUseId } from "../../utils/tool-id"
import {
	createAgentResponse,
	type AgentResponse,
	type AgentResponseItem,
	type AgentResponseOutcome,
	type AgentToolCall,
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
	/** A complete, validated call arrived before a terminal provider outcome. */
	accepted: boolean
	ended: boolean
	preflightAnnounced: boolean
	slot: ToolSlot
}

interface ToolSlot {
	kind: "tool_slot"
	id: string
	active: boolean
}

type OrderedResponseEntry = AgentResponseItem | ToolSlot

type ParsedArguments = { ok: true; value: unknown } | { ok: false }

function parseToolArguments(argumentsText: string, toolName?: string): ParsedArguments {
	if (!argumentsText.trim()) {
		return { ok: false }
	}

	try {
		return { ok: true, value: JSON.parse(argumentsText) }
	} catch {
		// Codex's apply_patch transport is a freeform patch string rather than a
		// JSON object. Keep provider adapters on their existing function-call
		// contract and normalize that native payload at the shared stream boundary.
		if (
			toolName === "apply_patch" &&
			(argumentsText.startsWith("*** Begin Patch\n") || argumentsText.startsWith("*** Begin Patch\r\n"))
		) {
			return { ok: true, value: { patch: argumentsText } }
		}

		return { ok: false }
	}
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : ""
}

/**
 * Accumulates the shared ApiStreamChunk transport into canonical response
 * items. Text-like items are emitted as they arrive. Complete tool calls can
 * be reported to preflight and completion observers while streaming, but
 * canonical tool-call items remain buffered until the provider response ends.
 * If the provider terminates unsuccessfully, only stable calls accepted before
 * that outcome remain available for transcript reconciliation; the host still
 * owns the decision to suppress their effects. Reserved positions preserve
 * their place among text and reasoning items in the final response.
 */
export class AgentResponseAccumulator {
	private readonly orderedEntries: OrderedResponseEntry[] = []
	private readonly pendingTools = new Map<string, PendingToolCall>()
	private readonly flushedToolItems = new Map<string, AgentResponseItem>()
	private readonly pendingToolIndexes = new Map<number, string>()
	private readonly emittedToolIds = new Set<string>()
	private readonly emittedNormalizedToolIds = new Map<string, string>()
	private readonly completedToolCallIds = new Set<string>()
	private lastReasoningItem: Extract<AgentResponseItem, { type: "reasoning" }> | undefined
	private nextToolOrder = 0
	private nextSyntheticId = 0
	private finished = false
	private finishPromise: Promise<AgentResponse> | undefined
	private responseOutcome: AgentResponseOutcome | undefined

	async add(
		chunk: ApiStreamChunk,
		onItem?: (item: AgentResponseItem) => Promise<void> | void,
		onToolCallReadyForPreflight?: (call: AgentToolCall) => Promise<void> | void,
		onToolCallCompleted?: (call: AgentToolCall) => Promise<void> | void,
	): Promise<void> {
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
				this.lastReasoningItem = item
				return this.emit(item, onItem)
			}

			case "thinking_complete": {
				if (this.lastReasoningItem) {
					// Keep an empty signature too: an explicitly supplied signature is
					// different from a provider which did not report one.
					this.lastReasoningItem.signature = chunk.signature
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
					...(chunk.requiresContinuation !== undefined
						? { requiresContinuation: chunk.requiresContinuation }
						: {}),
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
					pending.preflightAnnounced = false
				}

				const incomingArguments = asString(chunk.arguments)
				const current = parseToolArguments(pending.arguments, pending.name)
				const incoming = parseToolArguments(incomingArguments, chunk.name || pending.name)
				// A complete marker is authoritative when it repairs an incomplete
				// partial payload. Duplicate complete markers leave the first valid
				// payload untouched, which makes duplicate handling deterministic.
				if (
					!pending.arguments.trim() ||
					(!current.ok && incoming.ok) ||
					(!pending.hasCompletePayload && incomingArguments.length > 0)
				) {
					pending.arguments = incomingArguments
					pending.preflightAnnounced = false
				}
				pending.hasCompletePayload = true
				this.acceptPendingToolCall(pending)
				return this.announceToolCallNotifications(pending, onToolCallReadyForPreflight, onToolCallCompleted)
			}

			case "tool_call_start": {
				const id = asString(chunk.id)
				const pending =
					(id ? this.pendingTools.get(id) : undefined) ??
					this.createPending(id || this.createSyntheticId(), chunk.name, undefined, !id)
				if (!pending.name && chunk.name) {
					pending.name = chunk.name
					pending.preflightAnnounced = false
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
				if (!pending.hasCompletePayload || !parseToolArguments(pending.arguments, pending.name).ok) {
					pending.arguments += delta
					pending.preflightAnnounced = false
				}
				if (pending.ended) this.acceptPendingToolCall(pending)
				return pending.ended
					? this.announceToolCallNotifications(pending, onToolCallReadyForPreflight, onToolCallCompleted)
					: undefined
			}

			case "tool_call_end": {
				const pending = this.pendingTools.get(asString(chunk.id))
				if (pending) {
					pending.ended = true
					this.acceptPendingToolCall(pending)
					return this.announceToolCallNotifications(pending, onToolCallReadyForPreflight, onToolCallCompleted)
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
					pending.preflightAnnounced = false
				}
				if (typeof chunk.arguments === "string" && chunk.arguments.length > 0) {
					if (!pending.hasCompletePayload || !parseToolArguments(pending.arguments, pending.name).ok) {
						pending.arguments += chunk.arguments
						pending.preflightAnnounced = false
					}
				}

				this.pendingToolIndexes.set(chunk.index, pending.id)
				if (pending.ended) this.acceptPendingToolCall(pending)
				return pending.ended
					? this.announceToolCallNotifications(pending, onToolCallReadyForPreflight, onToolCallCompleted)
					: undefined
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
		const exposeAllToolCalls = this.responseOutcome === undefined
		const exposedTools = exposeAllToolCalls ? pendingTools : pendingTools.filter((pending) => pending.accepted)

		for (const pending of exposedTools) {
			await this.emitToolCall(pending, onItem)
		}

		const exposedToolIds = new Set(exposedTools.map((pending) => pending.id))
		const toolItems = exposedTools.flatMap((pending) => {
			const item = this.flushedToolItems.get(pending.id)
			return item ? [item] : []
		})
		let nextToolItem = 0
		const orderedItems: AgentResponseItem[] = []
		for (const entry of this.orderedEntries) {
			if ("kind" in entry) {
				if (!entry.active) continue
				if (!exposeAllToolCalls && !exposedToolIds.has(entry.id)) continue
				const item = toolItems[nextToolItem++]
				if (item) orderedItems.push(item)
			} else {
				orderedItems.push(entry)
			}
		}
		orderedItems.push(...toolItems.slice(nextToolItem))
		this.pendingTools.clear()
		this.pendingToolIndexes.clear()
		return createAgentResponse(orderedItems, this.responseOutcome)
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

		const slot: ToolSlot = { kind: "tool_slot", id, active: true }
		const pending: PendingToolCall = {
			id,
			name,
			arguments: "",
			index,
			order: this.nextToolOrder++,
			syntheticId,
			hasCompletePayload: false,
			accepted: false,
			ended: false,
			preflightAnnounced: false,
			slot,
		}
		this.pendingTools.set(id, pending)
		this.orderedEntries.push(slot)
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
			secondary.slot.active = false
			primary.preflightAnnounced = false
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
			primary.slot.id = primary.id
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
		pending.slot.id = newId
		pending.syntheticId = false
		pending.preflightAnnounced = false
		this.pendingTools.set(newId, pending)
		for (const [index, mappedId] of this.pendingToolIndexes) {
			if (mappedId === oldId) this.pendingToolIndexes.set(index, newId)
		}
		return pending
	}

	private acceptPendingToolCall(pending: PendingToolCall): void {
		if (pending.accepted || this.responseOutcome || pending.syntheticId || !pending.id.trim()) return
		if (sanitizeToolUseId(pending.id) !== pending.id || !pending.name.trim()) return
		if (!parseToolArguments(pending.arguments, pending.name).ok) return

		const normalizedId = sanitizeToolUseId(pending.id)
		const conflictingPending = [...this.pendingTools.values()].find(
			(candidate) => candidate !== pending && sanitizeToolUseId(candidate.id) === normalizedId,
		)
		if (!conflictingPending) pending.accepted = true
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

	private async announceToolCallNotifications(
		pending: PendingToolCall,
		onToolCallReadyForPreflight?: (call: AgentToolCall) => Promise<void> | void,
		onToolCallCompleted?: (call: AgentToolCall) => Promise<void> | void,
	): Promise<void> {
		await this.announceToolCallForPreflight(pending, onToolCallReadyForPreflight)
		await this.announceToolCallCompleted(pending, onToolCallCompleted)
	}

	/**
	 * Notify a separate observer once a provider completion marker has yielded a
	 * valid call with a stable persisted ID. This reports stream state only; it
	 * does not authorize or execute the tool, and canonical items remain buffered
	 * until finish().
	 */
	private async announceToolCallCompleted(
		pending: PendingToolCall,
		onToolCallCompleted?: (call: AgentToolCall) => Promise<void> | void,
	): Promise<void> {
		if (
			!onToolCallCompleted ||
			this.completedToolCallIds.has(pending.id) ||
			!pending.ended ||
			this.responseOutcome?.status === "failed" ||
			this.responseOutcome?.status === "incomplete" ||
			this.responseOutcome?.status === "cancelled" ||
			pending.syntheticId ||
			!pending.id.trim() ||
			sanitizeToolUseId(pending.id) !== pending.id ||
			!pending.name.trim()
		) {
			return
		}

		const parsed = parseToolArguments(pending.arguments, pending.name)
		if (!parsed.ok) return

		const normalizedId = sanitizeToolUseId(pending.id)
		const conflictingPending = [...this.pendingTools.values()].find(
			(candidate) => candidate !== pending && sanitizeToolUseId(candidate.id) === normalizedId,
		)
		const conflictingEmittedId = this.emittedNormalizedToolIds.get(normalizedId)
		if (conflictingPending || (conflictingEmittedId && conflictingEmittedId !== pending.id)) return

		this.completedToolCallIds.add(pending.id)
		await onToolCallCompleted({
			type: "tool_call",
			id: pending.id,
			name: pending.name,
			arguments: parsed.value,
		})
	}

	/**
	 * Expose only stable, complete calls to pure host preflight while the provider
	 * is still streaming. This notification is provisional: callers must wait for
	 * successful stream completion and the persisted assistant boundary before
	 * scheduling any tool effect.
	 */
	private async announceToolCallForPreflight(
		pending: PendingToolCall,
		onToolCallReadyForPreflight?: (call: AgentToolCall) => Promise<void> | void,
	): Promise<void> {
		if (
			!onToolCallReadyForPreflight ||
			pending.preflightAnnounced ||
			this.responseOutcome?.status === "failed" ||
			this.responseOutcome?.status === "incomplete" ||
			this.responseOutcome?.status === "cancelled" ||
			pending.syntheticId ||
			!pending.id.trim() ||
			!pending.name.trim()
		) {
			return
		}

		const parsed = parseToolArguments(pending.arguments, pending.name)
		if (!parsed.ok) return

		const normalizedId = sanitizeToolUseId(pending.id)
		const conflictingPending = [...this.pendingTools.values()].find(
			(candidate) => candidate !== pending && sanitizeToolUseId(candidate.id) === normalizedId,
		)
		const conflictingEmittedId = this.emittedNormalizedToolIds.get(normalizedId)
		if (conflictingPending || (conflictingEmittedId && conflictingEmittedId !== pending.id)) return

		pending.preflightAnnounced = true
		await onToolCallReadyForPreflight({
			type: "tool_call",
			id: pending.id,
			name: pending.name,
			arguments: parsed.value,
		})
	}

	private async emitToolCall(
		pending: PendingToolCall,
		onItem?: (item: AgentResponseItem) => Promise<void> | void,
	): Promise<void> {
		if (this.emittedToolIds.has(pending.id)) {
			return
		}

		this.emittedToolIds.add(pending.id)
		const parsed = parseToolArguments(pending.arguments, pending.name)
		if (pending.syntheticId) {
			const message = `Tool call "${pending.name}" (${pending.id}) did not provide a stable call ID.`
			this.recordOutcome({ status: "failed", reason: message, retryable: false })
			await this.emitBufferedToolItem(
				pending,
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
			await this.emitBufferedToolItem(
				pending,
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
			await this.emitBufferedToolItem(
				pending,
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
			await this.emitBufferedToolItem(
				pending,
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

		await this.emitBufferedToolItem(
			pending,
			{ type: "tool_call", id: pending.id, name: pending.name, arguments: parsed.value },
			onItem,
		)
	}

	private async emitBufferedToolItem(
		pending: PendingToolCall,
		item: AgentResponseItem,
		onItem?: (item: AgentResponseItem) => Promise<void> | void,
	): Promise<void> {
		this.flushedToolItems.set(pending.id, item)
		await this.emit(item, onItem, false)
	}

	private async emit(
		item: AgentResponseItem,
		onItem?: (item: AgentResponseItem) => Promise<void> | void,
		recordOrder = true,
	) {
		if (recordOrder) this.orderedEntries.push(item)
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
