import { EventEmitter } from "events"
import { manageCommandTool, waitForCommand } from "../ManageCommandTool"
import { commandSessionRegistry } from "../CommandSessionRegistry"
import { ToolRegistry } from "../ToolRegistry"
import { readCommandOutputTool } from "../ReadCommandOutputTool"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminalProcess } from "../../../integrations/terminal/types"
import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"

function harness() {
	const process = Object.assign(new EventEmitter(), {
		executionId: "execution",
		isSettled: false,
		hasUnretrievedOutput: vi.fn(() => false),
		abort: vi.fn(),
		writeInput: vi.fn(),
		captureUnretrievedOutput: vi.fn(() => ({
			output: "ready at http://localhost:1234",
			commit: vi.fn(),
			release: vi.fn(),
		})),
	}) as unknown as AlphaTerminalProcess
	const terminal = { taskId: "task", process, running: true }
	vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([terminal as never])
	const commandEvidence: { executionId: string; status: string; exitCode?: number } = {
		executionId: "execution",
		status: "running",
	}
	const task = {
		taskId: "task",
		getCommandExecutionEvidence: () => [commandEvidence],
		providerRef: {
			deref: () => ({
				runWorkspaceMutation: async (_task: unknown, _name: string, run: () => Promise<void>) => run(),
			}),
		},
	} as unknown as Task
	const callbacks = {
		askApproval: vi.fn().mockResolvedValue(true),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
		setResultMetadata: vi.fn(),
	}
	return { process, terminal, task, callbacks, commandEvidence }
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

it("waits inside the host for output, then removes listeners", async () => {
	const { process } = harness()
	const waiting = waitForCommand(process, 30_000)
	expect(process.listenerCount("output_available")).toBe(1)
	process.emit("output_available")
	await waiting
	expect(process.listenerCount("output_available")).toBe(0)
	expect(process.listenerCount("completed")).toBe(0)
})

it.each(["timeout", "cancel", "completed", "error"])("cleans up a %s wait", async (cause) => {
	vi.useFakeTimers()
	const { process } = harness()
	const controller = new AbortController()
	const waiting = waitForCommand(process, 50, controller.signal).catch((error: unknown) => error)
	if (cause === "timeout") await vi.advanceTimersByTimeAsync(50)
	else if (cause === "cancel") controller.abort(new Error("cancelled"))
	else if (cause === "error") process.emit("error", new Error("failed"))
	else process.emit("completed")
	const result = await waiting
	if (cause === "cancel") expect(result).toEqual(new Error("cancelled"))
	expect(process.listenerCount("output_available")).toBe(0)
	expect(vi.getTimerCount()).toBe(0)
})

it("does not require a model poll or approval for a bounded wait", async () => {
	const { task, callbacks } = harness()
	await manageCommandTool.execute({ execution_id: "execution", action: "wait", timeout_ms: 0 }, task, callbacks)
	expect(callbacks.askApproval).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"status":"running"'))
	expect(callbacks.pushToolResult.mock.calls[0][0]).toContain('"execution_id":"execution"')
	expect(callbacks.pushToolResult.mock.calls[0][0]).not.toContain("Chunk ID:")
})

it("formats a native running wait with the process session", async () => {
	const { task, callbacks, process } = harness()
	const sessionId = commandSessionRegistry.register(task, process)
	await manageCommandTool.execute(
		{ execution_id: "execution", action: "wait", timeout_ms: 0 },
		task,
		{
			...callbacks,
			commandResultMaxOutputTokens: 256,
			commandResultFormat: "codex",
			toolCallId: "write-stdin-call",
		},
		undefined,
		sessionId,
	)

	const sidecar = callbacks.setResultMetadata.mock.calls[0]?.[0].commandResult
	expect(sidecar).toMatchObject({ session_id: sessionId, output: "ready at http://localhost:1234" })
	expect(sidecar).not.toHaveProperty("exit_code")
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(
		expect.stringMatching(
			new RegExp(
				`^Chunk ID: write-stdin-call\\nWall time: \\d+\\.\\d{4} seconds\\nProcess running with session ID ${sessionId}\\nOutput:\\nready at http://localhost:1234$`,
			),
		),
	)
})

it("formats a completed native wait with its exit code", async () => {
	const { task, callbacks, process, commandEvidence } = harness()
	process.isSettled = true
	commandEvidence.status = "succeeded"
	commandEvidence.exitCode = 7
	await manageCommandTool.execute({ execution_id: "execution", action: "wait", timeout_ms: 0 }, task, {
		...callbacks,
		commandResultMaxOutputTokens: 256,
		commandResultFormat: "codex",
		toolCallId: "write-stdin-call",
	})

	const sidecar = callbacks.setResultMetadata.mock.calls[0]?.[0].commandResult
	expect(sidecar).toMatchObject({ exit_code: 7, output: "ready at http://localhost:1234" })
	expect(sidecar).not.toHaveProperty("session_id")
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(
		expect.stringMatching(
			/^Chunk ID: write-stdin-call\nWall time: \d+\.\d{4} seconds\nProcess exited with code 7\nOutput:\nready at http:\/\/localhost:1234$/,
		),
	)
})

it("delegates artifact reads through the manage command host", async () => {
	const { task, callbacks } = harness()
	const read = vi.spyOn(readCommandOutputTool, "execute").mockResolvedValue(undefined)
	const params = {
		action: "read" as const,
		artifact_id: "cmd-1706119234567.txt",
		search: "error",
		offset: 512,
		limit: 2048,
	}

	await manageCommandTool.execute(params, task, callbacks)

	expect(read).toHaveBeenCalledWith(params, task, callbacks)
	expect(callbacks.askApproval).not.toHaveBeenCalled()
})

it("checks cancellation before dispatching an artifact read", async () => {
	const { task, callbacks } = harness()
	const read = vi.spyOn(readCommandOutputTool, "execute").mockResolvedValue(undefined)
	const controller = new AbortController()
	controller.abort(new Error("cancelled before read"))

	await expect(
		manageCommandTool.execute({ action: "read", artifact_id: "cmd-1706119234567.txt" }, task, {
			...callbacks,
			signal: controller.signal,
		}),
	).rejects.toThrow("cancelled before read")
	expect(read).not.toHaveBeenCalled()
})

it("rejects null optional artifact read fields before dispatch", async () => {
	const { task, callbacks } = harness()
	const read = vi.spyOn(readCommandOutputTool, "execute").mockResolvedValue(undefined)

	await manageCommandTool.execute(
		{
			action: "read",
			artifact_id: "cmd-1706119234567.txt",
			offset: null,
		} as never,
		task,
		callbacks,
	)

	expect(read).not.toHaveBeenCalled()
	expect(callbacks.handleError).toHaveBeenCalledWith("controlling command", expect.any(Error))
})

it("accepts long managed-command waits within the host limit", async () => {
	const { task, callbacks, process } = harness()
	process.hasUnretrievedOutput = vi.fn(() => true)
	await manageCommandTool.execute({ execution_id: "execution", action: "wait", timeout_ms: 300_000 }, task, callbacks)
	expect(callbacks.handleError).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"status":"running"'))
})

it("cannot operate another task's command", async () => {
	const { task, callbacks, process } = harness()
	await manageCommandTool.execute({ execution_id: "other", action: "stop" }, task, callbacks)
	expect(callbacks.handleError).toHaveBeenCalled()
	expect(process.abort).not.toHaveBeenCalled()
})

it("rechecks process identity after approval", async () => {
	const { task, callbacks, process, terminal } = harness()
	callbacks.askApproval.mockImplementation(async () => {
		terminal.taskId = "other"
		return true
	})
	await manageCommandTool.execute({ execution_id: "execution", action: "stop" }, task, callbacks)
	expect(process.abort).not.toHaveBeenCalled()
	expect(callbacks.handleError).toHaveBeenCalled()
})

it("rejects input if the same process receives a new execution identity during approval", async () => {
	const { task, callbacks, process } = harness()
	callbacks.askApproval.mockImplementation(async () => {
		process.executionId = "replacement"
		return true
	})
	await manageCommandTool.execute(
		{ execution_id: "execution", action: "input", input: "yes\n", timeout_ms: 0 },
		task,
		callbacks,
	)
	expect(process.writeInput).not.toHaveBeenCalled()
	expect(callbacks.handleError).toHaveBeenCalledWith("controlling command", expect.any(Error))
})

it("rechecks a session binding inside the mutation gate before writing input", async () => {
	const { task, callbacks, process } = harness()
	let current = true
	vi.spyOn(task.providerRef, "deref").mockReturnValue({
		runWorkspaceMutation: async (_task: unknown, _label: string, run: () => Promise<void>) => {
			current = false
			await run()
		},
	} as never)
	await manageCommandTool.execute(
		{ execution_id: "execution", action: "input", input: "yes\n", timeout_ms: 0 },
		task,
		callbacks,
		() => {
			if (!current) throw new Error("Session changed while approval was pending")
		},
	)
	expect(process.writeInput).not.toHaveBeenCalled()
	expect(callbacks.handleError).toHaveBeenCalledWith("controlling command", expect.any(Error))
})

it("preserves denied input and sends only literal approved input", async () => {
	const { task, callbacks, process } = harness()
	callbacks.askApproval.mockResolvedValueOnce(false)
	const args = { execution_id: "execution", action: "input" as const, input: "yes\n", timeout_ms: 0 }
	await manageCommandTool.execute(args, task, callbacks)
	expect(process.writeInput).not.toHaveBeenCalled()
	await manageCommandTool.execute(args, task, callbacks)
	expect(process.writeInput).toHaveBeenCalledWith("yes\n")
})

it("uses the numeric exec session to poll and send approved input through the tool registry", async () => {
	const { task, callbacks, process } = harness()
	process.hasUnretrievedOutput = vi.fn(() => true)
	const sessionId = commandSessionRegistry.register(task, process)
	const descriptor = new ToolRegistry().resolve("write_stdin")!
	const call = (chars?: string): ToolUse<"write_stdin"> => ({
		type: "tool_use",
		id: "write-call",
		name: "write_stdin",
		params: {},
		partial: false,
		nativeArgs: { session_id: sessionId, ...(chars === undefined ? {} : { chars }), yield_time_ms: 0 },
	})

	await descriptor.execute({ task, call: call(), callbacks })
	expect(callbacks.askApproval).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(
		expect.stringContaining(`Process running with session ID ${sessionId}`),
	)

	await descriptor.execute({ task, call: call("yes\n"), callbacks })
	expect(callbacks.askApproval).toHaveBeenCalledWith("command", "input command execution\nyes\n")
	expect(process.writeInput).toHaveBeenCalledExactlyOnceWith("yes\n")
	expect(callbacks.handleError).not.toHaveBeenCalled()
})

it("rejects a numeric session when approval resumes after its process identity changes", async () => {
	const { task, callbacks, process } = harness()
	const sessionId = commandSessionRegistry.register(task, process)
	callbacks.askApproval.mockImplementation(async () => {
		process.executionId = "replacement"
		return true
	})
	const descriptor = new ToolRegistry().resolve("write_stdin")!
	await descriptor.execute({
		task,
		call: {
			type: "tool_use",
			id: "write-call",
			name: "write_stdin",
			params: {},
			partial: false,
			nativeArgs: { session_id: sessionId, chars: "yes\n", yield_time_ms: 0 },
		},
		callbacks,
	})
	expect(process.writeInput).not.toHaveBeenCalled()
	expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
	expect(callbacks.handleError).toHaveBeenCalledWith("controlling command", expect.any(Error))
})
