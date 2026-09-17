import path from "path"
import { describe, expect, it, vi } from "vitest"

import { Task, type CommandExecutionEvidence } from "../../task/Task"
import { EnvironmentContext } from "../EnvironmentContext"
import { captureEnvironmentDetails } from "../getEnvironmentDetails"

vi.mock("vscode", async (importOriginal) => {
	const vscode = await importOriginal<typeof import("vscode")>()
	return {
		...vscode,
		window: { ...vscode.window, activeTextEditor: undefined, visibleTextEditors: [], tabGroups: { all: [] } },
	}
})

vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { getTerminals: () => [], getBackgroundTerminals: () => [] },
}))

function fixture(exitCode: number | undefined) {
	const state = {
		maxWorkspaceFiles: 0,
		maxGitStatusFiles: 0,
		includeCurrentTime: false,
		includeCurrentCost: false,
		apiConfiguration: { todoListEnabled: false },
	}
	const provider = { getState: async () => state, recordParentVerificationEvidence: async () => undefined }
	const evidence: CommandExecutionEvidence = {
		toolCallId: "background-check",
		executionId: "physical-check",
		returnedInBackground: true,
		status: exitCode === 0 ? "succeeded" : "failed",
		exitCode,
		startedAt: 1,
		completedAt: 2,
	}
	const task = Object.assign(Object.create(Task.prototype, { cwd: { value: path.resolve("/command-workspace") } }), {
		taskId: "command-context",
		instanceId: "command-session",
		taskKind: "primary",
		providerRef: new WeakRef(provider),
		getTaskMode: async () => "code",
		getRequestPacingMetrics: () => undefined,
		api: { getModel: () => ({ id: "offline-fixture" }) },
		fileContextTracker: { captureRecentlyModifiedFiles: () => ({ files: [], commit() {} }) },
		commandExecutionEvidence: new Map([[evidence.toolCallId, evidence]]),
	}) as Task
	const context = new EnvironmentContext()
	return { task, evidence, context, capture: () => captureEnvironmentDetails(task, false, undefined, { context }) }
}

describe("background command outcome context", () => {
	it.each([0, 1])("delivers exit code %s without terminal output or another tool call", async (exitCode) => {
		const { capture } = fixture(exitCode)
		const completed = await capture()
		expect(completed.details).toContain("# Background Command Outcomes")
		expect(completed.details).toContain(`"exit_code":${exitCode}`)
		expect(completed.details).toContain('"tool_call_id":"background-check"')
		completed.commit()
		const unchanged = await capture()
		expect(unchanged.details).toBe("")
		unchanged.release()
	})

	it("delivers completion of a silent command after its running context was committed", async () => {
		const { task, evidence, capture } = fixture(undefined)
		evidence.status = "running"
		const running = await capture()
		expect(running.details).toContain('"status":"running"')
		running.commit()

		task.completeCommandExecution(evidence.toolCallId, { exitCode: 1 }, evidence.executionId)
		const completed = await capture()
		expect(completed.details).toContain("# Environment Changes")
		expect(completed.details).toContain('"status":"failed","exit_code":1')
		expect(completed.details).not.toContain("New Output")
		completed.commit()
		const unchanged = await capture()
		expect(unchanged.details).toBe("")
		unchanged.release()
	})

	it("retains an undelivered outcome on release and restores it after context reset", async () => {
		const { capture, context } = fixture(0)
		const abandoned = await capture()
		abandoned.release()
		const retried = await capture()
		expect(retried.details).toBe(abandoned.details)
		retried.commit()
		context.reset()
		const restored = await capture()
		expect(restored.details).toContain("# Environment Snapshot")
		expect(restored.details).toContain('"status":"succeeded","exit_code":0')
		restored.release()
	})

	it("omits foreground commands and does not fabricate evidence for an empty resumed task", async () => {
		const { task, evidence, capture } = fixture(0)
		evidence.returnedInBackground = false
		const foreground = await capture()
		expect(foreground.details).not.toContain("# Background Command Outcomes")
		foreground.commit()
		Object.assign(task, { commandExecutionEvidence: new Map() })
		expect(task.getBackgroundCommandContext()).toBeUndefined()
	})

	it("fences background marking and late completion by physical execution identity", () => {
		const { task, evidence } = fixture(0)
		evidence.returnedInBackground = false
		task.markCommandExecutionBackgrounded(evidence.toolCallId, "old-execution")
		expect(task.getBackgroundCommandContext()).toBeUndefined()
		// Completion can win the race with returning the partial tool result.
		task.markCommandExecutionBackgrounded(evidence.toolCallId, evidence.executionId)
		expect(task.getBackgroundCommandContext()).toContain('"status":"succeeded"')
		task.completeCommandExecution(evidence.toolCallId, { exitCode: 1 }, "old-execution")
		expect(task.getBackgroundCommandContext()).toContain('"exit_code":0')
	})

	it("does not publish success when cancellation wins a zero exit code", async () => {
		const { task, evidence, capture } = fixture(undefined)
		evidence.status = "running"
		task.abort = true
		task.completeCommandExecution(evidence.toolCallId, { exitCode: 0 }, evidence.executionId)
		const cancelled = await capture()
		expect(cancelled.details).toContain('"status":"cancelled","exit_code":0')
		expect(cancelled.details).not.toContain('"status":"succeeded"')
		cancelled.release()
	})

	it("projects only the owning task and also serves managed workers", async () => {
		const first = fixture(0)
		const second = fixture(1)
		Object.assign(second.task, { taskKind: "subagent", subagentRole: "worker" })
		second.evidence.toolCallId = "worker-command"
		const primary = await first.capture()
		const worker = await second.capture()
		expect(primary.details).not.toContain("worker-command")
		expect(worker.details).toContain('"tool_call_id":"worker-command"')
		expect(worker.details).toContain('"status":"failed","exit_code":1')
		expect(worker.details).not.toContain('"tool_call_id":"background-check"')
		primary.release()
		worker.release()
	})

	it("removes evicted observations from the committed context", async () => {
		const { task, capture } = fixture(0)
		const initial = await capture()
		initial.commit()
		Object.assign(task, { commandExecutionEvidence: new Map() })
		const cleared = await capture()
		expect(cleared.details).toContain("# Background Command Outcomes\n(none; previous value no longer applies)")
		cleared.commit()
	})

	it("delivers an older command's completion after newer starts pushed it out of the context window", async () => {
		const { task, evidence, capture } = fixture(undefined)
		evidence.status = "running"
		delete evidence.completedAt
		const newer = Array.from(
			{ length: 8 },
			(_, index): CommandExecutionEvidence => ({
				...evidence,
				toolCallId: `newer-${index}`,
				executionId: `execution-${index}`,
				startedAt: index + 2,
			}),
		)
		Object.assign(task, {
			commandExecutionEvidence: new Map([evidence, ...newer].map((item) => [item.toolCallId, item])),
		})
		const initial = await capture()
		expect(initial.details).not.toContain('"tool_call_id":"background-check"')
		initial.commit()

		const clock = vi.spyOn(Date, "now").mockReturnValue(20)
		try {
			task.completeCommandExecution(evidence.toolCallId, { exitCode: 1 }, evidence.executionId)
		} finally {
			clock.mockRestore()
		}
		const completed = await capture()
		expect(completed.details).toContain('"tool_call_id":"background-check"')
		expect(completed.details).toContain('"status":"failed","exit_code":1')
		completed.commit()
	})

	it.each(["physical-check", "replacement-check"])(
		"preserves background delivery only when an inspection receipt matches execution %s",
		async (executionId) => {
			const { task, evidence } = fixture(undefined)
			evidence.status = "running"
			await task.recordCommandInspectionResult({
				toolCallId: evidence.toolCallId,
				executionId,
				status: "succeeded",
				exitCode: 0,
				startedAt: 1,
				completedAt: 2,
			})
			if (executionId === "physical-check") {
				expect(task.getBackgroundCommandContext()).toContain('"status":"succeeded","exit_code":0')
			} else {
				expect(task.getBackgroundCommandContext()).toBeUndefined()
			}
		},
	)
})
