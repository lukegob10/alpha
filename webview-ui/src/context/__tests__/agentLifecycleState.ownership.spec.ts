import {
	agentLifecycleEventSchema,
	agentLifecycleSnapshotSchema,
	type AgentLifecycleSnapshot,
	type ExtensionState,
	type LiveTaskMetadata,
	TaskLifecycleState,
	TaskStatus,
} from "@alpha-code/types"
import { experimentDefault } from "@alpha/experiments"

import { mergeExtensionState } from "../ExtensionStateContext"
import { applyLifecycleEventToExtensionState, applyLifecycleSnapshotToExtensionState } from "../agentLifecycleState"

const metadata = (id: string): LiveTaskMetadata => ({
	id,
	status: TaskStatus.Running,
	lifecycle: TaskLifecycleState.Running,
	isActive: false,
	isStreaming: false,
	isWaitingForInput: false,
	lastUpdatedAt: 1,
	queueCount: 0,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
})

const snapshot = (taskId: string, overrides: Partial<AgentLifecycleSnapshot> = {}) =>
	agentLifecycleSnapshotSchema.parse({
		version: 1,
		taskId,
		runId: `run-${taskId}`,
		turnId: `turn-${taskId}`,
		status: "in_progress",
		phase: "working",
		lastSequence: 1,
		items: [],
		steps: [],
		acceptedToolCallIds: [],
		terminalToolCallIds: [],
		processedEvents: Array.from({ length: overrides.lastSequence ?? 1 }, (_, index) => ({
			eventId: `event-${index + 1}`,
			sequence: index + 1,
			fingerprint: `event-${index + 1}`,
		})),
		...overrides,
	})

const state = (): ExtensionState => ({
	version: "",
	mcpEnabled: false,
	experiments: experimentDefault,
	clineMessages: [],
	taskHistory: [],
	shouldShowAnnouncement: false,
	enableCheckpoints: true,
	writeDelayMs: 1000,
	maxConcurrentTasks: 3,
	mode: "code",
	customModes: [],
	maxOpenTabsContext: 20,
	maxWorkspaceFiles: 100,
	apiConfiguration: {},
	telemetrySetting: "unset",
	showRooIgnoredFiles: true,
	enableSubfolderRules: false,
	renderContext: "sidebar",
	autoCondenseContext: true,
	autoCondenseContextPercent: 100,
	profileThresholds: {},
	hasOpenedModeSelector: false,
	maxImageFileSize: 5,
	maxTotalImageSize: 20,
	checkpointTimeout: 30,
	maxReadFileLine: -1,
})

const terminal = (taskId: string, status: "completed" | "failed" | "interrupted") =>
	agentLifecycleEventSchema.parse({
		version: 1,
		taskId,
		runId: `run-${taskId}`,
		turnId: `turn-${taskId}`,
		eventId: "event-2",
		sequence: 2,
		occurredAt: 2,
		type: "turn_terminal",
		payload: { status },
	})

describe("lifecycle task ownership", () => {
	it.each([
		["in_progress", {}],
		["completed", {}],
		["completed", undefined],
	] as const)("keeps a removed %s task absent with replacement snapshots %j", (status, incomingSnapshots) => {
		const background = metadata("background")
		const initial: ExtensionState = {
			...state(),
			taskStateSeq: 1,
			liveTaskIds: ["removed", "background"],
			liveTasksById: { removed: metadata("removed"), background },
			agentLifecycleSnapshots: {
				removed: snapshot(
					"removed",
					status === "completed" ? { status, terminalEventId: "event-1", terminalAt: 1 } : {},
				),
				background: snapshot("background"),
			},
		}
		const removed = mergeExtensionState(initial, {
			taskStateSeq: 2,
			liveTaskIds: ["background"],
			liveTasksById: { background },
			...(incomingSnapshots ? { agentLifecycleSnapshots: incomingSnapshots } : {}),
		})
		expect(removed.liveTaskIds).toEqual(["background"])
		expect(removed.liveTasksById?.removed).toBeUndefined()
		expect(removed.agentLifecycleSnapshots?.removed).toBeUndefined()
		expect(removed.liveTasksById?.background).toBeDefined()
		expect(removed.agentLifecycleSnapshots?.background).toEqual(
			incomingSnapshots ? undefined : initial.agentLifecycleSnapshots?.background,
		)

		const afterLateSnapshot = applyLifecycleSnapshotToExtensionState(removed, snapshot("removed"))
		const afterLateEvent = applyLifecycleEventToExtensionState(afterLateSnapshot, terminal("removed", "completed"))
		const afterPartialState = mergeExtensionState(afterLateEvent, {
			taskStateSeq: 3,
			agentLifecycleSnapshots: { removed: snapshot("removed") },
		})
		expect(afterPartialState.liveTaskIds).toEqual(["background"])
		expect(afterPartialState.liveTasksById?.removed).toBeUndefined()
		expect(afterPartialState.agentLifecycleSnapshots?.removed).toBeUndefined()
	})

	it("merges partial lifecycle deltas without losing background snapshots or membership", () => {
		const initial: ExtensionState = {
			...state(),
			taskStateSeq: 1,
			liveTaskIds: ["current", "background"],
			liveTasksById: { current: metadata("current"), background: metadata("background") },
			agentLifecycleSnapshots: { current: snapshot("current"), background: snapshot("background") },
		}
		const partial = applyLifecycleSnapshotToExtensionState(
			initial,
			snapshot("current", { phase: "waiting", lastSequence: 2 }),
		)
		expect(partial.agentLifecycleSnapshots?.background).toEqual(initial.agentLifecycleSnapshots?.background)
		expect(partial.liveTaskIds).toEqual(["current", "background"])
		expect(partial.liveTasksById?.current?.isWaitingForInput).toBe(true)
		expect(partial.liveTasksById?.background?.lifecycle).toBe(TaskLifecycleState.Running)
		const partialState = mergeExtensionState(partial, {
			taskStateSeq: 2,
			agentLifecycleSnapshots: { current: snapshot("current", { phase: "waiting", lastSequence: 2 }) },
		})
		expect(partialState.agentLifecycleSnapshots?.background).toEqual(initial.agentLifecycleSnapshots?.background)
		expect(partialState.liveTaskIds).toEqual(["current", "background"])
	})

	it("filters cached host snapshots for tasks excluded from authoritative membership", () => {
		const fresh = mergeExtensionState(state(), {
			taskStateSeq: 1,
			liveTaskIds: ["background"],
			liveTasksById: { background: metadata("background") },
			agentLifecycleSnapshots: { removed: snapshot("removed"), background: snapshot("background") },
		})
		expect(fresh.agentLifecycleSnapshots?.removed).toBeUndefined()
		expect(fresh.liveTaskIds).toEqual(["background"])
		expect(fresh.agentLifecycleSnapshots?.background).toBeDefined()
	})

	it("allows legacy event-only updates without sequenced host membership", () => {
		const legacy = mergeExtensionState(state(), { liveTasksById: {}, liveTaskIds: [] })
		const resumed = applyLifecycleSnapshotToExtensionState(legacy, snapshot("legacy-task"))
		expect(resumed.liveTaskIds).toEqual(["legacy-task"])
	})

	it("ignores stale membership replacements and accepts a fresh host re-admission", () => {
		const initial: ExtensionState = {
			...state(),
			taskStateSeq: 2,
			liveTaskIds: ["background"],
			liveTasksById: { background: metadata("background") },
			agentLifecycleSnapshots: { background: snapshot("background") },
		}
		const stale = mergeExtensionState(initial, {
			taskStateSeq: 1,
			liveTaskIds: [],
			liveTasksById: {},
			agentLifecycleSnapshots: {},
		})
		expect(stale.liveTaskIds).toEqual(["background"])
		expect(stale.agentLifecycleSnapshots?.background).toEqual(initial.agentLifecycleSnapshots?.background)
		const readmitted = mergeExtensionState(stale, {
			taskStateSeq: 3,
			liveTaskIds: ["background", "readmitted"],
			liveTasksById: { ...stale.liveTasksById, readmitted: metadata("readmitted") },
			agentLifecycleSnapshots: { ...stale.agentLifecycleSnapshots, readmitted: snapshot("readmitted") },
		})
		expect(readmitted.liveTaskIds).toEqual(["background", "readmitted"])
		expect(readmitted.agentLifecycleSnapshots?.readmitted?.status).toBe("in_progress")
	})

	it("allows lifecycle bootstrap before the first sequenced membership publication", () => {
		const bootstrapped = applyLifecycleSnapshotToExtensionState(
			{ ...state(), liveTasksById: {}, liveTaskIds: [] },
			snapshot("early-task"),
		)
		expect(bootstrapped.liveTaskIds).toEqual(["early-task"])
		expect(bootstrapped.liveTasksById?.["early-task"]?.lifecycle).toBe(TaskLifecycleState.Running)
	})

	it.each(["completed", "failed", "interrupted"] as const)(
		"preserves generic terminal status %s for event-only and attached snapshot delivery",
		(status) => {
			const initial: ExtensionState = {
				...state(),
				liveTasksById: { current: metadata("current") },
				agentLifecycleSnapshots: { current: snapshot("current") },
			}
			const event = terminal("current", status)
			const reduced = applyLifecycleEventToExtensionState(initial, event)
			expect(reduced.agentLifecycleSnapshots?.current?.status).toBe(status)
			expect(reduced.liveTasksById?.current?.isTurnActive).toBe(false)
			const attached = snapshot("current", {
				status,
				lastSequence: 2,
				terminalEventId: event.eventId,
				terminalAt: event.occurredAt,
			})
			const projected = applyLifecycleEventToExtensionState(initial, {
				type: "agentLifecycleEvent",
				taskId: "current",
				payload: event,
				agentLifecycleSnapshot: attached,
			})
			expect(projected.agentLifecycleSnapshots?.current?.status).toBe(status)
		},
	)
})
