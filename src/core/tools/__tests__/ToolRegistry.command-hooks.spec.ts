import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Task } from "../../task/Task"
import type { AlphaTerminalProcess } from "../../../integrations/terminal/types"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { ToolCallbacks, ToolResultMetadata } from "../BaseTool"
import { commandSessionRegistry } from "../CommandSessionRegistry"
import { executeCommandTool } from "../ExecuteCommandTool"
import { manageCommandTool } from "../ManageCommandTool"
import { ToolRegistry } from "../ToolRegistry"

afterEach(() => vi.restoreAllMocks())

function fixture() {
	const task = {
		taskId: "command-hook-origin",
		cwd: process.cwd(),
		taskKind: "subagent",
		subagentRole: "worker",
		providerRef: { deref: () => undefined },
	} as unknown as Task
	const metadata: ToolResultMetadata[] = []
	const registry = new ToolRegistry()
	const execute = async (name: "exec_command" | "write_stdin", id: string, args: Record<string, unknown>) => {
		metadata.length = 0
		await registry.resolve(name)!.execute({
			task,
			call: { type: "tool_use", id, name, params: {}, nativeArgs: args, partial: false },
			callbacks: {
				capturePostToolUse: true,
				toolCallId: id,
				askApproval: async () => true,
				pushToolResult: vi.fn(),
				handleError: async (_action, error) => {
					throw error
				},
				setResultMetadata: (value) => metadata.push(value),
			} satisfies ToolCallbacks,
		})
		return metadata.at(-1)
	}
	return { task, execute }
}

describe("native command post-hook origins", () => {
	it("retains a completed nonzero process as the original command invocation", async () => {
		vi.spyOn(executeCommandTool, "execute").mockImplementation(async (_params, _task, callbacks) => {
			callbacks.pushToolResult("Failed assertion")
			callbacks.setResultMetadata?.({ status: "success", executionStatus: "error", exitCode: 1 })
		})
		const { execute } = fixture()
		expect(await execute("exec_command", "launch", { cmd: "pnpm test", tty: false })).toMatchObject({
			executionStatus: "error",
			exitCode: 1,
			postToolUse: { callId: "launch", name: "exec_command", arguments: { cmd: "pnpm test", tty: false } },
		})
	})

	it("defers running commands and emits their original post hook once from the final stdin poll", async () => {
		const { task, execute } = fixture()
		const process = Object.assign(new EventEmitter(), {
			executionId: "physical-command",
			isSettled: false,
			hasUnretrievedOutput: () => true,
		}) as unknown as AlphaTerminalProcess
		const terminal = { taskId: task.taskId, process, running: true }
		vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([terminal as never])
		let sessionId = 0
		vi.spyOn(executeCommandTool, "execute").mockImplementation(async (_params, _task, callbacks) => {
			sessionId = commandSessionRegistry.register(task, process)
			callbacks.pushToolResult("Process is running")
			callbacks.setResultMetadata?.({
				status: "success",
				executionStatus: "running",
				commandResult: { wall_time_seconds: 0.1, output: "", session_id: sessionId },
			})
		})
		vi.spyOn(manageCommandTool, "execute").mockImplementation(async (_params, _task, callbacks) => {
			callbacks.pushToolResult("Final failed assertion")
			callbacks.setResultMetadata?.({ status: "success", executionStatus: "error", exitCode: 2 })
		})
		expect(await execute("exec_command", "launch", { cmd: "pnpm test" })).toMatchObject({
			executionStatus: "running",
			postToolUse: null,
		})
		Object.assign(process, { isSettled: true })
		terminal.running = false
		expect(await execute("write_stdin", "poll-1", { session_id: sessionId, chars: "" })).toMatchObject({
			executionStatus: "error",
			exitCode: 2,
			postToolUse: { callId: "launch", name: "exec_command", arguments: { cmd: "pnpm test" } },
		})
		expect(await execute("write_stdin", "poll-2", { session_id: sessionId, chars: "" })).toMatchObject({
			postToolUse: null,
		})
		commandSessionRegistry.releaseForTask(task)
	})
})
