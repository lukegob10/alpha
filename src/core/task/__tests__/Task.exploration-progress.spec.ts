import type { ToolSchedulerResult } from "../../agent/ToolScheduler"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { Task } from "../Task"

function schedulerResult(index: number, semanticFingerprint = `inspection-${index}`): ToolSchedulerResult {
	return {
		callId: `command-${index}`,
		name: "execute_command",
		status: "success",
		content: "inspection complete",
		executionStatus: "success",
		exitCode: 0,
		durationMs: 1,
		trustedExploration: {
			scope: "/workspace",
			semanticFingerprint,
		},
	}
}

function createTask(detector: ToolRepetitionDetector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })) {
	const suspendAfterCurrentTurn = vi.fn()
	const task = Object.assign(Object.create(Task.prototype), {
		workspacePath: "/workspace",
		pendingCommandVerification: Promise.resolve(),
		commandExecutionEvidence: new Map(),
		toolRepetitionDetector: detector,
		userMessageContent: [],
		providerRef: {
			deref: () => ({
				getVerificationProgressState: () => ({
					stateFingerprint: "unchanged-workspace",
					evidenceFingerprint: "unchanged-verification-evidence",
				}),
			}),
		},
		suspendAfterCurrentTurn,
	}) as Task
	return { task, suspendAfterCurrentTurn }
}

describe("Task trusted exploration progress", () => {
	it("lets forty distinct successful shell inspections continue through the real Task adapter", async () => {
		const { task, suspendAfterCurrentTurn } = createTask()

		for (let index = 0; index < 40; index++) {
			await task.recordToolCallForStopping(
				"execute_command",
				{ command: `rg --files --glob file-${index}.ts` },
				"success",
				"read",
				schedulerResult(index),
			)
		}

		expect(suspendAfterCurrentTurn).not.toHaveBeenCalled()
		expect(Reflect.get(task, "userMessageContent")).toEqual([])
	})

	it("keeps exploration identity separate from verification evidence", async () => {
		const recordOutcome = vi.fn(() => ({ action: "continue", stagnantCalls: 0, retainedOutcomes: 1 }))
		const detector = { recordOutcome } as unknown as ToolRepetitionDetector
		const { task } = createTask(detector)

		await task.recordToolCallForStopping(
			"execute_command",
			{ command: "rg --files src" },
			"success",
			"read",
			schedulerResult(1, "trusted-shell-inspection"),
		)

		expect(recordOutcome).toHaveBeenCalledWith({
			toolName: "execute_command",
			args: { command: "rg --files src" },
			status: "success",
			kind: "read",
			scope: "/workspace",
			stateFingerprint: "unchanged-workspace",
			evidenceFingerprint: "unchanged-verification-evidence",
			explorationFingerprint: "trusted-shell-inspection",
		})
	})

	it("still bounds repeated inspection identities despite command spelling changes", async () => {
		const { task, suspendAfterCurrentTurn } = createTask()

		for (let index = 0; index < 5; index++) {
			await task.recordToolCallForStopping(
				"execute_command",
				{ command: `rg${" ".repeat(index + 1)}--files src`, output: `timestamp-${index}` },
				"success",
				"read",
				schedulerResult(index, "same-semantic-inspection"),
			)
		}

		expect(suspendAfterCurrentTurn).toHaveBeenCalledOnce()
		expect(Reflect.get(task, "userMessageContent")).toHaveLength(1)
	})
})
