import type {
	AgentLifecycleEvent,
	AgentLifecycleSnapshot,
	AgentLifecycleToolCallItem,
	AgentLifecycleToolResultItem,
} from "@alpha-code/types"

import {
	AgentLifecycleReducerError,
	createAgentLifecycleSnapshot,
	reduceAgentLifecycleEvent,
	tryReduceAgentLifecycleEvent,
} from "../index.js"

const ids = {
	taskId: "task-1",
	runId: "run-1",
	turnId: "turn-1",
}

const baseEvent = (sequence: number, eventId: string, type: AgentLifecycleEvent["type"] = "phase_changed") => ({
	version: 1 as const,
	eventId,
	sequence,
	...ids,
	turnId: ids.turnId,
	occurredAt: sequence,
	type,
	payload: { phase: "working" as const },
})

function event(
	sequence: number,
	eventId: string,
	payload: AgentLifecycleEvent["payload"] = { phase: "working" },
): AgentLifecycleEvent {
	return {
		version: 1,
		eventId,
		sequence,
		...ids,
		occurredAt: sequence,
		type: "phase_changed",
		payload,
	} as AgentLifecycleEvent
}

function reduceAll(snapshot: AgentLifecycleSnapshot, events: readonly AgentLifecycleEvent[]): AgentLifecycleSnapshot {
	return events.reduce((current, next) => reduceAgentLifecycleEvent(current, next), snapshot)
}

function toolCall(itemId = "call-item-1", toolCallId = "call-1"): AgentLifecycleToolCallItem {
	return {
		itemId,
		type: "tool_call",
		toolCallId,
		name: "read_file",
		arguments: { path: "README.md" },
		status: "accepted",
	}
}

function toolResult(itemId = "result-item-1", toolCallId = "call-1"): AgentLifecycleToolResultItem {
	return {
		itemId,
		type: "tool_result",
		toolCallId,
		status: "completed",
		output: "contents",
	}
}

describe("agent lifecycle reducer", () => {
	it("is deterministic and does not mutate the input snapshot", () => {
		const initial = createAgentLifecycleSnapshot(ids)
		const first = reduceAgentLifecycleEvent(initial, event(1, "event-1"))

		expect(initial.lastSequence).toBe(0)
		expect(initial.items).toEqual([])
		expect(first.lastSequence).toBe(1)
		expect(first.phase).toBe("working")
		expect(reduceAgentLifecycleEvent(initial, event(1, "event-1"))).toEqual(first)
	})

	it("rejects sequence gaps and new events that reuse an old sequence", () => {
		const initial = createAgentLifecycleSnapshot(ids)
		expect(() => reduceAgentLifecycleEvent(initial, event(2, "event-2"))).toThrowError(
			expect.objectContaining<Partial<AgentLifecycleReducerError>>({ code: "sequence_gap" }),
		)

		const one = reduceAgentLifecycleEvent(initial, event(1, "event-1"))
		expect(() => reduceAgentLifecycleEvent(one, event(1, "other-event"))).toThrowError(
			expect.objectContaining<Partial<AgentLifecycleReducerError>>({ code: "duplicate_sequence" }),
		)
	})

	it("allows exact replay but rejects an event ID reused with different content", () => {
		const initial = createAgentLifecycleSnapshot(ids)
		const firstEvent = event(1, "event-1", { phase: "working" })
		const first = reduceAgentLifecycleEvent(initial, firstEvent)
		const replay = reduceAgentLifecycleEvent(first, firstEvent)

		expect(replay).toEqual(first)
		expect(() => reduceAgentLifecycleEvent(first, event(1, "event-1", { phase: "planning" }))).toThrowError(
			expect.objectContaining<Partial<AgentLifecycleReducerError>>({ code: "duplicate_event_conflict" }),
		)
	})

	it("tracks item transitions and keeps assistant streaming monotonic", () => {
		const initial = createAgentLifecycleSnapshot(ids)
		const assistant = {
			version: 1 as const,
			eventId: "event-1",
			sequence: 1,
			...ids,
			occurredAt: 1,
			type: "item_added" as const,
			payload: { item: { itemId: "assistant-1", type: "assistant_text" as const, text: "I" } },
		}
		const updated = {
			...assistant,
			eventId: "event-2",
			sequence: 2,
			occurredAt: 2,
			type: "item_updated" as const,
			payload: { item: { itemId: "assistant-1", type: "assistant_text" as const, text: "I will inspect" } },
		}
		const after = reduceAll(initial, [assistant, updated] as AgentLifecycleEvent[])

		expect(after.items).toMatchObject([{ itemId: "assistant-1", text: "I will inspect" }])
		expect(() =>
			reduceAgentLifecycleEvent(after, {
				...updated,
				eventId: "event-3",
				sequence: 3,
				occurredAt: 3,
				payload: { item: { itemId: "assistant-1", type: "assistant_text", text: "reset" } },
			} as AgentLifecycleEvent),
		).toThrowError(expect.objectContaining<Partial<AgentLifecycleReducerError>>({ code: "invalid_transition" }))
	})

	it("requires accepted tool calls before results and exactly one result per call", () => {
		const initial = createAgentLifecycleSnapshot(ids)
		const callEvent = {
			version: 1 as const,
			eventId: "event-1",
			sequence: 1,
			...ids,
			occurredAt: 1,
			type: "tool_call_accepted" as const,
			payload: { item: toolCall() },
		}
		const resultEvent = {
			version: 1 as const,
			eventId: "event-2",
			sequence: 2,
			...ids,
			occurredAt: 2,
			type: "tool_result_recorded" as const,
			payload: { item: toolResult() },
		}
		const afterCall = reduceAgentLifecycleEvent(initial, callEvent)
		expect(() =>
			reduceAgentLifecycleEvent(afterCall, {
				...resultEvent,
				sequence: 3,
				eventId: "event-3",
			} as AgentLifecycleEvent),
		).toThrowError(expect.objectContaining<Partial<AgentLifecycleReducerError>>({ code: "sequence_gap" }))

		const afterResult = reduceAgentLifecycleEvent(afterCall, resultEvent)
		expect(afterResult.acceptedToolCallIds).toEqual(["call-1"])
		expect(afterResult.terminalToolCallIds).toEqual(["call-1"])
		expect(() =>
			reduceAgentLifecycleEvent(afterResult, {
				...resultEvent,
				eventId: "event-3",
				sequence: 3,
			} as AgentLifecycleEvent),
		).toThrowError(expect.objectContaining<Partial<AgentLifecycleReducerError>>({ code: "duplicate_tool_result" }))
	})

	it("does not allow a terminal turn with unresolved tools and enforces one terminal state", () => {
		const initial = createAgentLifecycleSnapshot(ids)
		const callEvent = {
			version: 1 as const,
			eventId: "event-1",
			sequence: 1,
			...ids,
			occurredAt: 1,
			type: "tool_call_accepted" as const,
			payload: { item: toolCall() },
		}
		const completionEvent = {
			version: 1 as const,
			eventId: "event-2",
			sequence: 2,
			...ids,
			occurredAt: 2,
			type: "turn_completed" as const,
			payload: { status: "completed" as const },
		}
		const afterCall = reduceAgentLifecycleEvent(initial, callEvent)
		expect(() => reduceAgentLifecycleEvent(afterCall, completionEvent)).toThrowError(
			expect.objectContaining<Partial<AgentLifecycleReducerError>>({ code: "unresolved_tool_calls" }),
		)

		const withResult = reduceAgentLifecycleEvent(afterCall, {
			version: 1,
			eventId: "event-2",
			sequence: 2,
			...ids,
			occurredAt: 2,
			type: "tool_result_recorded",
			payload: { item: toolResult() },
		})
		const completed = reduceAgentLifecycleEvent(withResult, { ...completionEvent, sequence: 3, eventId: "event-3" })
		expect(completed.status).toBe("completed")
		expect(() =>
			reduceAgentLifecycleEvent(completed, {
				...completionEvent,
				sequence: 4,
				eventId: "event-4",
			} as AgentLifecycleEvent),
		).toThrowError(expect.objectContaining<Partial<AgentLifecycleReducerError>>({ code: "terminal_turn" }))
	})

	it("supports interruption/cancellation and reports safe failures", () => {
		const initial = createAgentLifecycleSnapshot(ids)
		const interrupted = reduceAgentLifecycleEvent(initial, {
			version: 1,
			eventId: "event-1",
			sequence: 1,
			...ids,
			occurredAt: 1,
			type: "turn_cancelled",
			payload: { reason: "user requested cancellation" },
		})
		expect(interrupted.status).toBe("interrupted")

		const result = tryReduceAgentLifecycleEvent(interrupted, {
			version: 1,
			eventId: "event-2",
			sequence: 2,
			...ids,
			occurredAt: 2,
			type: "phase_changed",
			payload: { phase: "working" },
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe("terminal_turn")
	})
})
