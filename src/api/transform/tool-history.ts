import { isDeepStrictEqual } from "node:util"

import { getToolCallId, getToolResultId, ToolHistoryError } from "../../utils/tool-id"

type ToolTransaction = { result?: Record<string, unknown> }

/**
 * Canonical request projection for accepted saved tool formats. Stored history
 * stays untouched, including opaque metadata, reasoning and terminal statuses.
 * Recovery owns missing calls/results; this never executes or invents a tool.
 */
export function normalizeToolHistory<T>(messages: readonly T[]): T[] {
	const transactions = new Map<string, ToolTransaction>()
	return messages.map((message) => {
		if (!isRecord(message) || !Array.isArray(message.content)) return message
		let changed = false
		const content: unknown[] = []
		for (const block of message.content) {
			if (!isRecord(block)) {
				content.push(block)
				continue
			}
			const callId = getToolCallId(block)
			if (callId !== undefined) {
				if (transactions.has(callId) && transactions.get(callId)?.result === undefined) {
					throw new ToolHistoryError("duplicate_open_tool_call")
				}
				// A later call is a new occurrence, even when an old provider reused its ID.
				transactions.set(callId, {})
				const call = normalizeToolCall(block, callId)
				content.push(call)
				changed ||= call !== block
				continue
			}
			if (block.type === "tool_use" || block.type === "tool_call") {
				throw new ToolHistoryError("invalid_tool_call")
			}
			if (block.type !== "tool_result") {
				content.push(block)
				continue
			}
			const resultId = getToolResultId(block)
			if (resultId === undefined) throw new ToolHistoryError("invalid_tool_result_id")
			const { tool_call_id: _legacyId, ...fields } = block
			const result = { ...fields, tool_use_id: resultId }
			const transaction = transactions.get(resultId)
			if (transaction?.result !== undefined) {
				if (!isDeepStrictEqual(transaction.result, result)) {
					throw new ToolHistoryError("conflicting_tool_results")
				}
				changed = true
				continue
			}
			if (transaction) transaction.result = result
			content.push(result)
			changed ||= block.tool_use_id !== resultId || "tool_call_id" in block
		}
		return changed ? ({ ...message, content } as T) : message
	})
}

function normalizeToolCall(block: Record<string, unknown>, id: string): Record<string, unknown> {
	if (block.type === "tool_use") return block.id === id ? block : { ...block, id }
	const definition = isRecord(block.function) ? block.function : undefined
	const name = typeof block.name === "string" ? block.name : definition?.name
	if (typeof name !== "string" || name.length === 0) throw new ToolHistoryError("invalid_tool_call")
	let input: unknown
	if ("input" in block) {
		input = block.input
	} else if ("arguments" in block) {
		input = legacyToolArguments(name, block.arguments)
	} else if (definition && "arguments" in definition) {
		input = legacyToolArguments(name, definition.arguments)
	} else {
		throw new ToolHistoryError("invalid_tool_call")
	}
	// Keep legacy function metadata available to later projections; only routing
	// fields change. Providers select the fields supported by their own protocol.
	return { ...block, type: "tool_use", id, name, input }
}

function legacyToolArguments(name: string, value: unknown): unknown {
	if (typeof value !== "string") return value
	try {
		return JSON.parse(value)
	} catch {
		if (name === "apply_patch") return value
		throw new ToolHistoryError("invalid_tool_call")
	}
}

/** Project freeform patch bytes into the canonical JSON tool schema when required. */
export function toFunctionToolInput(name: string, input: unknown): unknown {
	return name === "apply_patch" && typeof input === "string" ? { patch: input } : input
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}
