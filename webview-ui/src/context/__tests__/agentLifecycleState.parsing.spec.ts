import {
	parseAgentLifecycleDegraded,
	parseAgentLifecycleEvent,
	parseAgentLifecycleSnapshot,
} from "../agentLifecycleState"

const eventWithArguments = (argumentsValue: unknown) => ({
	version: 1,
	type: "tool_call_accepted",
	taskId: "task-1",
	runId: "run-1",
	turnId: "turn-1",
	eventId: "event-1",
	sequence: 1,
	occurredAt: 1,
	payload: {
		item: {
			itemId: "item-1",
			type: "tool_call",
			toolCallId: "call-1",
			name: "read_file",
			arguments: argumentsValue,
		},
	},
})

const snapshotWithOutput = (output: unknown) => ({
	version: 1,
	taskId: "task-1",
	runId: "run-1",
	turnId: "turn-1",
	status: "in_progress",
	phase: "working",
	lastSequence: 0,
	items: [{ itemId: "result-1", type: "tool_result", toolCallId: "call-1", status: "completed", output }],
	steps: [],
	acceptedToolCallIds: [],
	effectStartedToolCallIds: [],
	terminalToolCallIds: [],
	processedEvents: [],
})

const signal = { version: 1, taskId: "task-1", degraded: true, occurredAt: 1, reason: "append_rejected" }

describe("lifecycle ingress parsing", () => {
	it.each([
		{ label: "BigInt", value: () => 1n },
		{
			label: "cyclic objects",
			value: () => {
				const cyclic: Record<string, unknown> = {}
				cyclic.self = cyclic
				return cyclic
			},
		},
	])("rejects $label without stringifying unvalidated duplicate aliases", ({ value }) => {
		const event = eventWithArguments(value())
		expect(
			parseAgentLifecycleEvent({ type: "agentLifecycleEvent", payload: event, agentLifecycleEvent: event }),
		).toBeUndefined()
		expect(parseAgentLifecycleEvent(event)).toBeUndefined()

		const snapshot = snapshotWithOutput(value())
		expect(
			parseAgentLifecycleSnapshot({ type: "agentLifecycleSnapshot", payload: snapshot, snapshot }),
		).toBeUndefined()
		expect(parseAgentLifecycleSnapshot(snapshot)).toBeUndefined()

		const malformedSignal = { ...signal, unexpected: value() }
		expect(
			parseAgentLifecycleDegraded({
				type: "agentLifecycleDegraded",
				payload: malformedSignal,
				signal: malformedSignal,
			}),
		).toBeUndefined()
	})

	it("keeps valid direct records and equivalent legacy aliases readable", () => {
		const event = eventWithArguments({ path: "README.md" })
		const parsedEvent = parseAgentLifecycleEvent(event)
		expect(parsedEvent?.type).toBe("tool_call_accepted")
		expect(parseAgentLifecycleEvent({ type: "agentLifecycleEvent", payload: event, event })).toEqual(parsedEvent)

		const snapshot = snapshotWithOutput("file contents")
		const parsedSnapshot = parseAgentLifecycleSnapshot(snapshot)
		expect(parsedSnapshot?.taskId).toBe("task-1")
		expect(parseAgentLifecycleSnapshot({ type: "agentLifecycleSnapshot", payload: snapshot, snapshot })).toEqual(
			parsedSnapshot,
		)
		expect(parseAgentLifecycleDegraded(signal)).toEqual(signal)
		expect(parseAgentLifecycleDegraded({ type: "agentLifecycleDegraded", payload: signal, signal })).toEqual(signal)
	})

	it("rejects conflicting aliases through the shared message schemas", () => {
		const event = eventWithArguments({ path: "README.md" })
		expect(
			parseAgentLifecycleEvent({
				type: "agentLifecycleEvent",
				payload: event,
				event: eventWithArguments({ path: "package.json" }),
			}),
		).toBeUndefined()
		expect(
			parseAgentLifecycleSnapshot({
				type: "agentLifecycleSnapshot",
				payload: snapshotWithOutput("first"),
				snapshot: snapshotWithOutput("second"),
			}),
		).toBeUndefined()
		expect(
			parseAgentLifecycleDegraded({
				type: "agentLifecycleDegraded",
				payload: signal,
				signal: { ...signal, degraded: false },
			}),
		).toBeUndefined()
	})
})
