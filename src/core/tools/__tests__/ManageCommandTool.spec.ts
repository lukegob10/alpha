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

it.each([false, true])("collects chatty output until the wait deadline (buffered initially: %s)", async (buffered) => {
	vi.useFakeTimers()
	const { process } = harness()
	process.hasUnretrievedOutput = vi.fn(() => buffered)
	let returned = false
	const waiting = waitForCommand(process, 30_000).then(() => {
		returned = true
	})
	for (let elapsed = 0; elapsed < 30_000; elapsed += 1_000) {
		process.emit("output_available")
		await vi.advanceTimersByTimeAsync(999)
		expect(returned).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
	}
	await waiting
	expect(returned).toBe(true)
	expect(process.isSettled).toBe(false)
	expect(process.listenerCount("completed")).toBe(0)
	expect(process.listenerCount("error")).toBe(0)
	expect(vi.getTimerCount()).toBe(0)
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
	const { task, callbacks, process, terminal, commandEvidence } = harness()
	process.isSettled = true
	terminal.running = false
	commandEvidence.status = "failed"
	commandEvidence.exitCode = 7
	await manageCommandTool.execute({ execution_id: "execution", action: "wait", timeout_ms: 0 }, task, {
		...callbacks,
		commandResultMaxOutputTokens: 256,
		commandResultFormat: "codex",
		toolCallId: "write-stdin-call",
	})

	const sidecar = callbacks.setResultMetadata.mock.calls[0]?.[0].commandResult
	expect(callbacks.setResultMetadata).toHaveBeenCalledWith(
		expect.objectContaining({ status: "success", executionStatus: "error", exitCode: 7 }),
	)
	expect(sidecar).toMatchObject({ exit_code: 7, output: "ready at http://localhost:1234" })
	expect(sidecar).not.toHaveProperty("session_id")
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(
		expect.stringMatching(
			/^Chunk ID: write-stdin-call\nWall time: \d+\.\d{4} seconds\nProcess exited with code 7\nOutput:\nready at http:\/\/localhost:1234$/,
		),
	)
})

it.each(["deadline", "completion"] as const)(
	"keeps native session output flowing until %s without returning a result for each chunk",
	async (outcome) => {
		vi.useFakeTimers()
		const { task, callbacks, process, terminal, commandEvidence } = harness()
		let output = "buffered progress\n"
		process.hasUnretrievedOutput = vi.fn(() => output.length > 0)
		const commit = vi.fn(() => {
			output = ""
		})
		process.captureUnretrievedOutput = vi.fn(() => ({ output, commit, release: vi.fn() }))
		const backgroundOutput = vi.fn()
		process.on("output_available", backgroundOutput)
		const sessionId = commandSessionRegistry.register(task, process)
		const poll = new ToolRegistry().resolve("write_stdin")!.execute({
			task,
			call: {
				type: "tool_use",
				id: "chatty-poll",
				name: "write_stdin",
				params: {},
				partial: false,
				nativeArgs: { session_id: sessionId, yield_time_ms: 30_000 },
			},
			callbacks,
		})
		for (let chunk = 1; chunk <= 3; chunk++) {
			await vi.advanceTimersByTimeAsync(1_000)
			output += `progress ${chunk}\n`
			process.emit("output_available")
			await vi.advanceTimersByTimeAsync(0)
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		}
		if (outcome === "completion") {
			process.isSettled = true
			terminal.running = false
			commandEvidence.status = "succeeded"
			commandEvidence.exitCode = 0
			process.emit("completed", output)
		} else await vi.advanceTimersByTimeAsync(27_000)
		await poll

		expect(backgroundOutput).toHaveBeenCalledTimes(3)
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("buffered progress\nprogress 1\nprogress 2\nprogress 3\n"),
		)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining(
				outcome === "completion"
					? "Process exited with code 0"
					: `Process running with session ID ${sessionId}`,
			),
		)
		expect(commandSessionRegistry.resolve(task, sessionId)).toEqual(
			outcome === "completion" ? undefined : expect.objectContaining({ process }),
		)
		expect(commit).toHaveBeenCalledOnce()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	},
)

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
	vi.useFakeTimers()
	const { task, callbacks, process } = harness()
	process.hasUnretrievedOutput = vi.fn(() => true)
	const waiting = manageCommandTool.execute(
		{ execution_id: "execution", action: "wait", timeout_ms: 300_000 },
		task,
		callbacks,
	)
	await vi.advanceTimersByTimeAsync(299_999)
	expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	await waiting
	expect(callbacks.handleError).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"status":"running"'))
})

it("cannot operate another task's command", async () => {
	const { task, callbacks, process } = harness()
	await manageCommandTool.execute({ execution_id: "other", action: "stop" }, task, callbacks)
	expect(callbacks.handleError).toHaveBeenCalled()
	expect(process.abort).not.toHaveBeenCalled()
})

it.each(["task ownership", "process reference", "execution identity", "running status"] as const)(
	"rechecks %s after approval",
	async (change) => {
		const { task, callbacks, process, terminal } = harness()
		callbacks.askApproval.mockImplementation(async () => {
			if (change === "task ownership") terminal.taskId = "other"
			else if (change === "process reference") terminal.process = Object.assign(new EventEmitter(), process)
			else if (change === "execution identity") process.executionId = "replacement"
			else terminal.running = false
			return true
		})
		await manageCommandTool.execute({ execution_id: "execution", action: "stop" }, task, callbacks)
		expect(process.abort).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledWith(
			"controlling command",
			expect.objectContaining({ message: "Command changed while approval was pending" }),
		)
	},
)

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

it.each(["task ownership", "process reference", "execution identity", "running status"] as const)(
	"rechecks %s inside the mutation gate before writing input",
	async (change) => {
		const { task, callbacks, process, terminal } = harness()
		vi.spyOn(task.providerRef, "deref").mockReturnValue({
			runWorkspaceMutation: async (_task: unknown, _label: string, run: () => Promise<void>) => {
				if (change === "task ownership") terminal.taskId = "other"
				else if (change === "process reference") terminal.process = Object.assign(new EventEmitter(), process)
				else if (change === "execution identity") process.executionId = "replacement"
				else terminal.running = false
				await run()
			},
		} as never)

		await manageCommandTool.execute(
			{ execution_id: "execution", action: "input", input: "yes\n", timeout_ms: 0 },
			task,
			callbacks,
		)

		expect(callbacks.askApproval).toHaveBeenCalledExactlyOnceWith("command", "input command execution\nyes\n")
		expect(process.writeInput).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledWith(
			"controlling command",
			expect.objectContaining({ message: "Command is no longer accepting input" }),
		)
	},
)

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
	vi.useFakeTimers()
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

	const poll = descriptor.execute({ task, call: call(), callbacks })
	await vi.advanceTimersByTimeAsync(5_000)
	await poll
	expect(callbacks.askApproval).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(
		expect.stringContaining(`Process running with session ID ${sessionId}`),
	)

	const input = descriptor.execute({ task, call: call("yes\n"), callbacks })
	await vi.advanceTimersByTimeAsync(250)
	await input
	expect(callbacks.askApproval).toHaveBeenCalledWith("command", "input command execution\nyes\n")
	expect(process.writeInput).toHaveBeenCalledExactlyOnceWith("yes\n")
	expect(callbacks.handleError).not.toHaveBeenCalled()
})

it.each(["released", "reused"] as const)(
	"returns a completed command receipt after its terminal was %s",
	async (state) => {
		const { task, callbacks, process, terminal, commandEvidence } = harness()
		const sessionId = commandSessionRegistry.register(task, process)
		process.isSettled = true
		commandEvidence.status = "succeeded"
		commandEvidence.exitCode = 0
		if (state === "reused") {
			terminal.taskId = "another-task"
			terminal.process = { executionId: "next-command" } as never
		} else {
			terminal.process = undefined as never
			terminal.running = false
		}
		const descriptor = new ToolRegistry().resolve("write_stdin")!
		await descriptor.execute({
			task,
			call: {
				type: "tool_use",
				id: "settled-poll",
				name: "write_stdin",
				params: {},
				partial: false,
				nativeArgs: { session_id: sessionId, yield_time_ms: 0 },
			},
			callbacks,
		})

		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Process exited with code 0"))
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("ready at http://localhost:1234"))
		expect(process.writeInput).not.toHaveBeenCalled()
		expect(commandSessionRegistry.resolve(task, sessionId)).toBeUndefined()
	},
)

it("rejects input to a settled session before approval", async () => {
	const { task, callbacks, process, terminal, commandEvidence } = harness()
	const sessionId = commandSessionRegistry.register(task, process)
	process.isSettled = true
	commandEvidence.status = "succeeded"
	terminal.process = undefined as never
	terminal.running = false
	await new ToolRegistry().resolve("write_stdin")!.execute({
		task,
		call: {
			type: "tool_use",
			id: "settled-input",
			name: "write_stdin",
			params: {},
			partial: false,
			nativeArgs: { session_id: sessionId, chars: "yes\n" },
		},
		callbacks,
	})
	expect(callbacks.askApproval).not.toHaveBeenCalled()
	expect(callbacks.handleError).toHaveBeenCalledWith(
		"controlling command",
		expect.objectContaining({ message: "Command is no longer running" }),
	)
	expect(process.writeInput).not.toHaveBeenCalled()
})

it("does not expose a settled command session to another task instance", async () => {
	const { task, callbacks, process, terminal } = harness()
	const sessionId = commandSessionRegistry.register(task, process)
	process.isSettled = true
	terminal.process = undefined as never
	terminal.running = false
	await new ToolRegistry().resolve("write_stdin")!.execute({
		task: { ...task } as Task,
		call: {
			type: "tool_use",
			id: "foreign-poll",
			name: "write_stdin",
			params: {},
			partial: false,
			nativeArgs: { session_id: sessionId },
		},
		callbacks,
	})
	expect(callbacks.handleError).toHaveBeenCalledWith(
		"controlling command",
		expect.objectContaining({ message: "Command session is unavailable for this task" }),
	)
	expect(callbacks.pushToolResult).not.toHaveBeenCalled()
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
