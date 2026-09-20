import { afterEach, describe, expect, it, vi } from "vitest"

import { createAgentResponse } from "../AgentResponse"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"
import { ToolRegistry } from "../../tools/ToolRegistry"
import type { Task } from "../../task/Task"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"

function taskFixture(): Task {
	const provider = {
		runWorkspaceMutation: async (_task: Task, _label: string, run: () => Promise<void>) => run(),
	}

	return {
		abort: false,
		cwd: "/workspace",
		taskId: "manage-read-task",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		say: vi.fn().mockResolvedValue(undefined),
		recordToolError: vi.fn(),
		providerRef: { deref: () => provider },
	} as unknown as Task
}

function hostFixture(task: Task): ToolExecutionHost {
	const userMessageContent: ToolExecutionHost["userMessageContent"] = []
	const host: ToolExecutionHost = {
		taskId: task.taskId,
		cwd: task.cwd,
		userMessageContent,
		say: vi.fn().mockResolvedValue(undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(result) {
			userMessageContent.push(result)
			return true
		},
		taskFacade: task,
	}
	return host
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("ToolScheduler manage command artifact reads", () => {
	it("dispatches the historical read alias through manage_command as a read action", async () => {
		const task = taskFixture()
		const host = hostFixture(task)
		const observe = vi.fn()
		host.recordToolCallForStopping = observe

		const outcome = await new ToolScheduler({
			executionHost: host,
			registry: new ToolRegistry(),
			mode: "code",
			validateCall: () => {},
		}).run(
			createAgentResponse([
				{
					type: "tool_call",
					id: "legacy-read",
					name: "read_command_output",
					arguments: {
						action: "stop",
						execution_id: "forged-execution",
						artifact_id: "invalid-artifact",
					},
				},
			]),
		)

		expect(outcome.results[0]).toMatchObject({
			name: "read_command_output",
			status: "error",
			content: expect.stringContaining("Invalid artifact_id format"),
		})
		expect(observe).toHaveBeenCalledWith(
			"manage_command",
			{
				action: "read",
				execution_id: "forged-execution",
				artifact_id: "invalid-artifact",
			},
			"error",
			undefined,
			expect.any(Object),
		)
		expect(task.recordToolError).toHaveBeenCalledWith("read_command_output")
	})

	it("does not execute a forged stop from the historical read alias", async () => {
		const task = taskFixture()
		const host = hostFixture(task)
		const observe = vi.fn()
		host.recordToolCallForStopping = observe
		const terminalLookup = vi.spyOn(TerminalRegistry, "getTerminals")

		const outcome = await new ToolScheduler({
			executionHost: host,
			registry: new ToolRegistry(),
			mode: "code",
			validateCall: () => {},
		}).run(
			createAgentResponse([
				{
					type: "tool_call",
					id: "forged-stop",
					name: "read_command_output",
					arguments: { action: "stop", execution_id: "forged-execution" },
				},
			]),
		)

		expect(outcome.results[0]).toMatchObject({
			name: "read_command_output",
			status: "error",
		})
		expect(terminalLookup).not.toHaveBeenCalled()
		expect(observe).toHaveBeenCalledWith(
			"manage_command",
			{ action: "read", execution_id: "forged-execution" },
			"error",
			undefined,
			expect.any(Object),
		)
	})
})
