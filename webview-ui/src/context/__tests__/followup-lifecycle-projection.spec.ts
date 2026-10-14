import {
	agentLifecycleSnapshotSchema,
	TaskLifecycleState,
	TaskStatus,
	type AlphaAsk,
	type ExtensionState,
	type LiveTaskMetadata,
} from "@alpha-code/types"

import { mergeExtensionState } from "../ExtensionStateContext"
import { projectLegacyLiveTaskMetadata } from "../agentLifecycleState"

const taskId = "followup-projection-task"
const metadata: LiveTaskMetadata = {
	id: taskId,
	lifecycle: TaskLifecycleState.Running,
	status: TaskStatus.Running,
	isActive: true,
	isStreaming: true,
	isTurnActive: true,
	isWaitingForInput: false,
	lastUpdatedAt: 20,
	queueCount: 0,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}

const snapshot = (turnId: string, lastSequence: number) =>
	agentLifecycleSnapshotSchema.parse({
		version: 1,
		taskId,
		runId: `run-${turnId}`,
		turnId,
		status: "in_progress",
		phase: "working",
		lastSequence,
		items: [],
		steps: [],
		acceptedToolCallIds: [],
		terminalToolCallIds: [],
		processedEvents: Array.from({ length: lastSequence }, (_, index) => ({
			eventId: `${turnId}-event-${index + 1}`,
			sequence: index + 1,
			fingerprint: `${turnId}-event-${index + 1}`,
		})),
	})

const state = (turnId: string, sequence: number, taskStateSeq: number): ExtensionState => ({
	version: "investigation",
	mcpEnabled: false,
	apiConfiguration: { apiProvider: "openai" },
	shouldShowAnnouncement: false,
	taskHistory: [],
	writeDelayMs: 1000,
	maxConcurrentTasks: 3,
	enableCheckpoints: false,
	checkpointTimeout: 15,
	maxOpenTabsContext: 20,
	maxWorkspaceFiles: 100,
	showRooIgnoredFiles: false,
	enableSubfolderRules: false,
	maxImageFileSize: 5,
	maxTotalImageSize: 20,
	experiments: { preventFocusDisruption: false, runSlashCommand: false, customTools: false },
	mode: "code",
	customModes: [],
	telemetrySetting: "unset",
	renderContext: "sidebar",
	autoCondenseContext: false,
	autoCondenseContextPercent: 100,
	profileThresholds: {},
	hasOpenedModeSelector: true,
	currentTaskId: taskId,
	activeTaskId: taskId,
	currentView: { type: "task", taskId },
	taskStateSeq,
	clineMessages: [],
	liveTaskIds: [taskId],
	liveTasksById: { [taskId]: metadata },
	agentLifecycleSnapshots: { [taskId]: snapshot(turnId, sequence) },
})

describe("follow-up lifecycle projection", () => {
	it("accepts the new host turn even when the previous long turn's terminal packet was lost", () => {
		const merged = mergeExtensionState(state("old-turn", 100, 10), {
			taskStateSeq: 11,
			liveTasksById: { [taskId]: metadata },
			agentLifecycleSnapshots: { [taskId]: snapshot("new-turn", 1) },
		})
		expect(merged.agentLifecycleSnapshots?.[taskId]?.turnId).toBe("new-turn")
	})

	it("does not roll the new turn back when an older host state arrives with a larger turn-local counter", () => {
		const merged = mergeExtensionState(state("new-turn", 1, 11), {
			taskStateSeq: 10,
			agentLifecycleSnapshots: { [taskId]: snapshot("old-turn", 100) },
		})
		expect(merged.agentLifecycleSnapshots?.[taskId]?.turnId).toBe("new-turn")
	})

	it("does not use an unsequenced patch to replace an unfinished turn", () => {
		const merged = mergeExtensionState(state("current-turn", 3, 11), {
			messageQueueSeq: 4,
			agentLifecycleSnapshots: { [taskId]: snapshot("other-turn", 100) },
		})
		expect(merged.agentLifecycleSnapshots?.[taskId]?.turnId).toBe("current-turn")
	})

	it("keeps turn-local ordering within a newer task-state envelope", () => {
		const merged = mergeExtensionState(state("current-turn", 10, 11), {
			taskStateSeq: 12,
			agentLifecycleSnapshots: { [taskId]: snapshot("current-turn", 3) },
		})
		expect(merged.agentLifecycleSnapshots?.[taskId]?.lastSequence).toBe(10)
	})

	it.each<AlphaAsk>(["resume_completed_task", "completion_result", "followup", "tool"])(
		"does not resurrect an answered historical %s after the next user/API boundary",
		(askType) => {
			const projected = projectLegacyLiveTaskMetadata(
				{
					currentTaskId: taskId,
					activeTaskId: taskId,
					clineMessages: [
						{ ts: 1, type: "say", say: "text", text: "Original task" },
						{ ts: 2, type: "ask", ask: askType, text: "Previous boundary", isAnswered: true },
						{ ts: 3, type: "say", say: "user_feedback", text: "Continue" },
						{ ts: 4, type: "say", say: "api_req_started", text: "{}" },
					],
				},
				taskId,
				metadata,
			)
			expect(projected?.lifecycle).toBe(TaskLifecycleState.Running)
			expect(projected?.isWaitingForInput).toBe(false)
		},
	)

	it("keeps a newly published unanswered follow-up waiting for the user", () => {
		const projected = projectLegacyLiveTaskMetadata(
			{
				currentTaskId: taskId,
				activeTaskId: taskId,
				clineMessages: [
					{ ts: 1, type: "say", say: "api_req_started", text: "{}" },
					{ ts: 2, type: "ask", ask: "followup", text: "What should happen next?" },
				],
			},
			taskId,
			metadata,
		)
		expect(projected?.lifecycle).toBe(TaskLifecycleState.Waiting)
		expect(projected?.isWaitingForInput).toBe(true)
	})

	it("uses the admitted follow-up boundary over a stale completed history record", () => {
		const projected = projectLegacyLiveTaskMetadata(
			{
				currentTaskId: taskId,
				currentTaskItem: {
					id: taskId,
					ts: 1,
					task: "Original request",
					status: "completed",
					number: 1,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
				clineMessages: [
					{ ts: 2, type: "ask", ask: "resume_completed_task", isAnswered: true },
					{ ts: 3, type: "say", say: "user_feedback", text: "Continue" },
					{ ts: 4, type: "say", say: "api_req_started", text: "{}" },
				],
			},
			taskId,
			metadata,
		)
		expect(projected?.lifecycle).toBe(TaskLifecycleState.Running)
	})
})
