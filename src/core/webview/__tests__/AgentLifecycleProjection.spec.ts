import { describe, expect, it } from "vitest"
import {
	agentLifecycleEventMessageSchema,
	agentLifecycleEventSchema,
	agentLifecycleSnapshotMessageSchema,
	agentLifecycleSnapshotSchema,
	type AgentLifecycleEvent,
	type AgentLifecycleSnapshot,
	TaskLifecycleState,
} from "@alpha-code/types"

import {
	AgentLifecycleProjector,
	projectAgentLifecycleSnapshot,
	projectClineMessageStatus,
} from "../AgentLifecycleProjection"

const ids = { taskId: "task-projection", runId: "run-1", turnId: "turn-1" }

function phaseEvent(
	eventId: string,
	sequence: number,
	phase: "planning" | "working" | "waiting" = "working",
	taskId = ids.taskId,
): AgentLifecycleEvent {
	return agentLifecycleEventSchema.parse({
		version: 1,
		eventId,
		sequence,
		taskId,
		runId: ids.runId,
		turnId: ids.turnId,
		occurredAt: sequence,
		type: "phase_changed",
		payload: { phase },
	})
}

function emptySnapshot(overrides: Partial<AgentLifecycleSnapshot> = {}): AgentLifecycleSnapshot {
	return agentLifecycleSnapshotSchema.parse({
		version: 1,
		...ids,
		status: "in_progress",
		phase: "working",
		lastSequence: 0,
		items: [],
		steps: [],
		acceptedToolCallIds: [],
		terminalToolCallIds: [],
		processedEvents: [],
		...overrides,
	})
}

describe("AgentLifecycleProjector", () => {
	it("validates lifecycle envelopes and rejects conflicting aliases", () => {
		const event = phaseEvent("event-1", 1)
		const snapshot = emptySnapshot()

		expect(
			agentLifecycleEventMessageSchema.safeParse({ type: "agentLifecycleEvent", payload: event }).success,
		).toBe(true)
		expect(
			agentLifecycleEventMessageSchema.safeParse({
				type: "agentLifecycleEvent",
				payload: event,
				event: { ...event, eventId: "different-event" },
			}).success,
		).toBe(false)
		expect(
			agentLifecycleSnapshotMessageSchema.safeParse({
				type: "agentLifecycleSnapshot",
				taskId: ids.taskId,
				payload: snapshot,
			}).success,
		).toBe(true)
		expect(
			agentLifecycleSnapshotMessageSchema.safeParse({
				type: "agentLifecycleSnapshot",
				taskId: "other-task",
				payload: snapshot,
			}).success,
		).toBe(false)
	})

	it("freezes deltas after a sequence gap until a trusted snapshot resync", () => {
		const requests: Array<{ taskId: string; reason: string }> = []
		const projector = new AgentLifecycleProjector({
			onSnapshotResyncRequired: (request) => {
				requests.push({ taskId: request.taskId, reason: request.reason })
			},
		})

		expect(projector.ingestEvent(phaseEvent("event-1", 1)).kind).toBe("applied")
		const gap = projector.ingestEvent(phaseEvent("event-3", 3, "waiting"))
		expect(gap.kind).toBe("resync_required")
		expect(gap.request).toMatchObject({
			taskId: ids.taskId,
			expectedSequence: 2,
			receivedSequence: 3,
			reason: "sequence_gap",
		})
		expect(projector.needsSnapshotResync(ids.taskId)).toBe(true)
		expect(requests).toEqual([{ taskId: ids.taskId, reason: "sequence_gap" }])

		// A late delta cannot silently fill the gap or move the trusted state.
		expect(projector.ingestEvent(phaseEvent("event-2", 2, "planning")).kind).toBe("resync_required")
		expect(projector.getSnapshot(ids.taskId)?.lastSequence).toBe(1)

		const source = new AgentLifecycleProjector()
		source.ingestEvent(phaseEvent("event-1", 1))
		source.ingestEvent(phaseEvent("event-2", 2, "planning"))
		const resynced = projector.ingestSnapshot(source.getSnapshot(ids.taskId))
		expect(resynced.kind).toBe("snapshot_applied")
		expect(projector.needsSnapshotResync(ids.taskId)).toBe(false)
		expect(projector.ingestEvent(phaseEvent("event-3", 3, "waiting")).kind).toBe("applied")
		expect(projector.getSnapshot(ids.taskId)).toMatchObject({ phase: "waiting", lastSequence: 3 })
	})

	it("keeps task streams correlated independently", () => {
		const projector = new AgentLifecycleProjector()
		const taskB = "task-b"

		expect(projector.ingestEvent(phaseEvent("a-1", 1)).kind).toBe("applied")
		expect(projector.ingestEvent(phaseEvent("b-1", 1, "planning", taskB)).kind).toBe("applied")
		expect(projector.ingestEvent(phaseEvent("a-3", 3, "waiting")).kind).toBe("resync_required")
		expect(projector.ingestEvent(phaseEvent("b-2", 2, "waiting", taskB)).kind).toBe("applied")

		expect(projector.getSnapshot(ids.taskId)).toMatchObject({ lastSequence: 1, phase: "working" })
		expect(projector.getSnapshot(taskB)).toMatchObject({ lastSequence: 2, phase: "waiting" })
	})

	it("classifies exact replays and conflicting duplicates without inferring from transcript messages", () => {
		const projector = new AgentLifecycleProjector()
		const first = phaseEvent("event-1", 1)

		expect(projector.ingestEvent(first).kind).toBe("applied")
		expect(projector.ingestEvent(first).kind).toBe("replayed")
		expect(projector.ingestEvent({ ...first, payload: { phase: "planning" } }).kind).toBe("resync_required")
		expect(projector.getSnapshot(ids.taskId)?.phase).toBe("working")

		const messages = [{ ts: 1, type: "say", say: "text", text: "stale transcript" }] as const
		expect(projectClineMessageStatus(messages).source).toBe("legacy")
	})
})

describe("lifecycle status projection", () => {
	it("projects active turn phases without promoting a terminal turn to terminal task state", () => {
		const waiting = projectAgentLifecycleSnapshot(emptySnapshot({ phase: "awaiting_approval" }))
		expect(waiting).toMatchObject({
			source: "lifecycle",
			lifecycle: TaskLifecycleState.Waiting,
			historyStatus: "active",
			isWaitingForInput: true,
		})

		const completed = projectAgentLifecycleSnapshot(
			emptySnapshot({
				status: "completed",
				lastSequence: 1,
				terminalEventId: "event-complete",
				terminalAt: 10,
				processedEvents: [{ eventId: "event-complete", sequence: 1, fingerprint: "digest" }],
			}),
		)
		expect(completed).toMatchObject({
			lifecycle: TaskLifecycleState.Running,
			historyStatus: "active",
			isTerminal: false,
			isWaitingForInput: false,
		})
	})
})
