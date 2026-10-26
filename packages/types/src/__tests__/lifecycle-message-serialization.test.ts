import { describe, expect, it, vi } from "vitest"

import {
	agentLifecycleDegradedMessageSchema,
	agentLifecycleEventMessageSchema,
	agentLifecycleSnapshotMessageSchema,
} from "../vscode-extension-host.js"

function toolEvent(argumentsValue: unknown) {
	return {
		version: 1,
		eventId: "event-1",
		sequence: 1,
		taskId: "task-1",
		runId: "run-1",
		turnId: "turn-1",
		occurredAt: 100,
		type: "tool_call_accepted",
		payload: {
			item: {
				itemId: "item-1",
				type: "tool_call",
				toolCallId: "call-1",
				name: "read_file",
				arguments: argumentsValue,
			},
		},
	}
}

function snapshot(argumentsValue: unknown) {
	return {
		version: 1,
		taskId: "task-1",
		runId: "run-1",
		turnId: "turn-1",
		status: "in_progress",
		phase: "working",
		lastSequence: 1,
		items: [toolEvent(argumentsValue).payload.item],
		steps: [],
		acceptedToolCallIds: ["call-1"],
		terminalToolCallIds: [],
		processedEvents: [{ eventId: "event-1", sequence: 1, fingerprint: "digest" }],
	}
}

describe("lifecycle message JSON boundary", () => {
	it("preserves ordinary JSON tool data and matching compatibility aliases", () => {
		const data = { path: "README.md", metadata: { ids: ["one", "two"], enabled: true, count: 0, value: null } }
		const event = toolEvent(data)
		const eventResult = agentLifecycleEventMessageSchema.safeParse({
			type: "agentLifecycleEvent",
			payload: event,
			event,
		})
		expect(eventResult.success).toBe(true)
		if (!eventResult.success) throw new Error("Expected a JSON lifecycle event")
		expect(eventResult.data.payload).toMatchObject({ payload: { item: { arguments: data } } })
		const state = snapshot(data)
		expect(
			agentLifecycleSnapshotMessageSchema.safeParse({
				type: "agentLifecycleSnapshot",
				payload: state,
				snapshot: state,
			}).success,
		).toBe(true)
	})

	it.each([{ value: BigInt(1) }, { value: Number.NaN }, { value: Infinity }, { value: () => "not JSON" }])(
		"rejects non-JSON tool data without throwing during alias validation",
		({ value }) => {
			const event = toolEvent({ value })
			for (const aliases of [{ payload: event }, { payload: event, event }]) {
				const result = agentLifecycleEventMessageSchema.safeParse({ type: "agentLifecycleEvent", ...aliases })
				expect(result.success).toBe(false)
			}
			const state = snapshot({ value })
			for (const aliases of [{ payload: state }, { payload: state, snapshot: state }]) {
				const result = agentLifecycleSnapshotMessageSchema.safeParse({
					type: "agentLifecycleSnapshot",
					...aliases,
				})
				expect(result.success).toBe(false)
			}
		},
	)

	it("rejects cyclic data and bounds excessive depth and sparse arrays", () => {
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		let deep: unknown = "leaf"
		for (let depth = 0; depth < 100; depth++) deep = { child: deep }
		for (const value of [cycle, deep, new Array(1_000_000)]) {
			const event = toolEvent(value)
			expect(
				agentLifecycleEventMessageSchema.safeParse({ type: "agentLifecycleEvent", payload: event, event })
					.success,
			).toBe(false)
		}
	})

	it("does not invoke unknown serialization hooks or getters", () => {
		const toJSON = vi.fn(() => "rewritten")
		const getter = vi.fn(() => "hidden")
		const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: getter })
		for (const value of [{ toJSON }, accessor]) {
			expect(
				agentLifecycleEventMessageSchema.safeParse({ type: "agentLifecycleEvent", payload: toolEvent(value) })
					.success,
			).toBe(false)
		}
		expect(toJSON).not.toHaveBeenCalled()
		expect(getter).not.toHaveBeenCalled()
	})

	it("validates attached snapshots and passthrough fields as part of the wire envelope", () => {
		expect(
			agentLifecycleEventMessageSchema.safeParse({
				type: "agentLifecycleEvent",
				payload: toolEvent({ path: "README.md" }),
				agentLifecycleSnapshot: snapshot({ value: BigInt(1) }),
			}).success,
		).toBe(false)
		expect(
			agentLifecycleDegradedMessageSchema.safeParse({
				type: "agentLifecycleDegraded",
				payload: { version: 1, taskId: "task-1", degraded: true, occurredAt: 100, reason: "invalid_snapshot" },
				unknownProviderData: BigInt(1),
			}).success,
		).toBe(false)
	})
})
