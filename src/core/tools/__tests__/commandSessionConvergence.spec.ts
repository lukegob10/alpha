import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CommandSessionRegistry, commandSessionRegistry } from "../CommandSessionRegistry"
import { executeCommandTool } from "../ExecuteCommandTool"
import { formatCommandToolResult, serializeCommandToolResult } from "../BaseTool"
import { manageCommandTool } from "../ManageCommandTool"
import { ToolRegistry } from "../ToolRegistry"
import { isParallelCommandReadReady } from "../ParallelCommandRead"
import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { ExecaTerminal } from "../../../integrations/terminal/ExecaTerminal"
import { ExecaTerminalProcess } from "../../../integrations/terminal/ExecaTerminalProcess"
import { ShellIntegrationManager } from "../../../integrations/terminal/ShellIntegrationManager"
import { Terminal } from "../../../integrations/terminal/Terminal"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminalProcess } from "../../../integrations/terminal/types"
import type { NativeToolArgs, ToolUse } from "../../../shared/tools"
import type { Task } from "../../task/Task"

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }))
vi.mock("execa", () => ({ execa: execaMock, ExecaError: class extends Error {} }))

const SETTLED_SESSION_LIMIT = 64

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

class ReceiptProcess extends ExecaTerminalProcess {
	seed(output: string): void {
		this.fullOutput = output
	}
}

function settledProcess(executionId: string): AlphaTerminalProcess {
	return Object.assign(new EventEmitter(), {
		executionId,
		isSettled: true,
		hasUnretrievedOutput: () => true,
	}) as unknown as AlphaTerminalProcess
}

function inputHarness(supportsInput = false) {
	const interrupt = vi.fn()
	const process = Object.assign(new EventEmitter(), {
		executionId: "physical-command",
		isSettled: false,
		hasUnretrievedOutput: () => true,
		abort: vi.fn(),
		interrupt,
		...(supportsInput ? { writeInput: vi.fn() } : {}),
		captureUnretrievedOutput: () => ({ output: "", hasMoreOutput: false, commit: vi.fn(), release: vi.fn() }),
	}) as unknown as AlphaTerminalProcess
	const terminal = { taskId: "owner", running: true, process }
	vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([terminal as never])
	const commandEvidence: { executionId: string; status: string; exitCode?: number } = {
		executionId: "physical-command",
		status: "running",
	}
	const task = {
		taskId: "owner",
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
	return { process, terminal, task, callbacks, interrupt, commandEvidence }
}

beforeEach(() => {
	NativeToolCallParser.clearAllStreamingToolCalls()
	NativeToolCallParser.clearRawChunkState()
})

describe("command-result Unicode transport", () => {
	it.each(["native", "json"] as const)("does not split a scalar when formatting %s output", (format) => {
		const result = { wall_time_seconds: 0, exit_code: 0, output: "🚀é".repeat(64) }
		for (let budget = 0; budget < 120; budget++) {
			const output =
				format === "native"
					? formatCommandToolResult(result, budget, "unicode-fixture")
					: (JSON.parse(serializeCommandToolResult(result, budget)) as { output: string }).output
			expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output)
		}
	})
})

afterEach(() => {
	vi.restoreAllMocks()
	execaMock.mockReset()
})

describe("bounded settled command sessions", () => {
	it.each(["shell end", "terminal close"] as const)(
		"finalizes failed-reader output once and retains the physical handle until later %s",
		async (physicalEnd) => {
			const registry = new CommandSessionRegistry()
			const owner = { taskId: "failed-reader-owner" } as Task
			const outputAccepted = deferred<void>()
			const failReader = deferred<void>()
			const closeEntered = deferred<void>()
			const releaseClose = deferred<void>()
			const finalized = deferred<void>()
			const failure = new Error("synthetic VS Code output reader failure")
			const onCompleted = vi.fn()
			let sinkClosed = false
			const onClosed = vi.fn(async () => {
				closeEntered.resolve()
				await releaseClose.promise
				sinkClosed = true
			})
			vi.spyOn(console, "error").mockImplementation(() => undefined)
			vi.spyOn(ShellIntegrationManager, "zshCleanupTmpDir").mockReturnValue(false)
			const terminal = new Terminal(
				3,
				{
					exitStatus: undefined,
					shellIntegration: {
						executeCommand: () => {
							terminal.setActiveStream(
								(async function* () {
									yield "\x1b]633;C\x07READY_WITHOUT_NEWLINE"
									await failReader.promise
									throw failure
								})(),
							)
						},
					},
				} as never,
				"/test",
			)
			terminal.taskId = owner.taskId
			vi.spyOn(TerminalRegistry, "getTerminals").mockImplementation((_busy, taskId) =>
				taskId === owner.taskId ? [terminal] : [],
			)
			const process = terminal.runCommand("synthetic failed reader", {
				onLine: vi.fn(),
				onOutput: () => outputAccepted.resolve(),
				onOutputClosed: onClosed,
				onCompleted,
				onShellExecutionStarted: vi.fn(),
				onShellExecutionComplete: vi.fn(),
			})
			process.executionId = "failed-reader-finalization"
			process.once("finalized", () => finalized.resolve())
			const errors = vi.fn()
			process.on("error", errors)
			const outcome = process.then(
				() => ({ status: "success" as const }),
				(error: unknown) => ({ status: "error" as const, error }),
			)
			registry.trackTaskOutput(owner, process, "failed-reader-finalization", {
				archiveExecutionId: "1000",
				isClosed: () => sinkClosed,
			})
			const id = registry.register(owner, process)
			try {
				await outputAccepted.promise
				failReader.resolve()
				await closeEntered.promise
				expect(await outcome).toEqual({ status: "error", error: failure })
				expect(process.isSettled).toBe(true)
				expect(process.isOutputFinalized).toBe(false)
				expect(terminal.running).toBe(true)
				expect(registry.ownsOutput(process)).toBe(true)
				releaseClose.resolve()
				await finalized.promise
				if (!process.waitForOutputFinalization) {
					throw new Error("Native terminal fixture requires output finalization")
				}
				await process.waitForOutputFinalization()
				expect(onClosed).toHaveBeenCalledOnce()
				expect(process.outputArchiveInterrupted).toBe(true)
				expect(process.outputArtifactId).toBeUndefined()
				expect(onCompleted).not.toHaveBeenCalled()
				expect(errors).toHaveBeenCalledExactlyOnceWith(failure)
				for (let index = 0; index < SETTLED_SESSION_LIMIT; index++) {
					registry.register(owner, settledProcess(`late-exit-pressure-${index}`))
				}
				expect(registry.ownsOutput(process)).toBe(true)
				expect(registry.isRunning(owner, id, process)).toBe(true)
				if (physicalEnd === "shell end") terminal.shellExecutionComplete({ exitCode: 0 })
				else terminal.notifyTerminalClosed()
				expect(registry.isRunning(owner, id, process)).toBe(false)
				expect(registry.ownsOutput(process)).toBe(false)
				expect(registry.resolve(owner, id)).toBeUndefined()
				expect(registry.getExpiredReceipt(owner, id)?.executionId).toBe("failed-reader-finalization")
				expect(onCompleted).not.toHaveBeenCalled()
				expect(errors).toHaveBeenCalledOnce()
			} finally {
				failReader.resolve()
				releaseClose.resolve()
				await outcome
				if (terminal.running) terminal.shellExecutionComplete({ exitCode: 0 })
				registry.releaseForTask(owner)
			}
		},
	)

	it("keeps physical running ownership after a settled output-reader failure under retention pressure", () => {
		const registry = new CommandSessionRegistry()
		const owner = { taskId: "owner" } as Task
		const process = Object.assign(new EventEmitter(), {
			executionId: "failed-reader-live-command",
			isSettled: true,
			isOutputFinalized: true,
			hasUnretrievedOutput: () => true,
		}) as unknown as AlphaTerminalProcess
		const terminal = { taskId: owner.taskId, running: true, process }
		vi.spyOn(TerminalRegistry, "getTerminals").mockImplementation((_busy, taskId) =>
			taskId === owner.taskId ? [terminal as never] : [],
		)
		const detach =
			"releaseCompletedProcess" in TerminalRegistry
				? vi.spyOn(TerminalRegistry, "releaseCompletedProcess")
				: undefined
		const id = registry.register(owner, process)
		for (let index = 0; index < SETTLED_SESSION_LIMIT + 8; index++) {
			registry.register(owner, settledProcess(`failed-reader-pressure-${index}`))
		}
		expect(registry.resolve(owner, id)?.process).toBe(process)
		expect(registry.ownsOutput(process)).toBe(true)
		expect(terminal.process).toBe(process)
		if (detach) expect(detach).not.toHaveBeenCalledWith(process)
		registry.releaseForTask(owner)
	})

	it("prunes old settled handles while keeping active commands and task instances isolated", () => {
		const registry = new CommandSessionRegistry()
		const owner = { taskId: "owner" } as Task
		const restored = { taskId: "owner" } as Task
		const active = Object.assign(new EventEmitter(), {
			executionId: "still-running",
			isSettled: false,
		}) as unknown as AlphaTerminalProcess
		vi.spyOn(TerminalRegistry, "getTerminals").mockImplementation((_busy, taskId) =>
			taskId === owner.taskId ? [{ taskId: owner.taskId, process: active, running: true } as never] : [],
		)
		const activeId = registry.register(owner, active)
		const handles = Array.from({ length: SETTLED_SESSION_LIMIT + 8 }, (_, index) => {
			const process = settledProcess(`completed-${index}`)
			return { process, id: registry.register(owner, process) }
		})

		expect(registry.resolve(owner, activeId)?.process).toBe(active)
		expect(registry.isCurrent(owner, activeId, active)).toBe(true)
		expect(registry.resolve(restored, activeId)).toBeUndefined()
		for (const { process, id } of handles.slice(0, 8)) {
			expect(registry.resolve(owner, id)).toBeUndefined()
			expect(registry.ownsOutput(process)).toBe(false)
		}
		for (const { process, id } of handles.slice(8)) expect(registry.resolve(owner, id)?.process).toBe(process)
		registry.releaseForTask(owner)
		expect(registry.ownsOutput(active)).toBe(false)
	})

	it("does not prune an outstanding delivery reservation under settled-session pressure", async () => {
		const registry = new CommandSessionRegistry()
		const owner = { taskId: "owner" } as Task
		const terminal = new ExecaTerminal(1, "/test")
		const process = new ReceiptProcess(terminal)
		terminal.process = process
		process.executionId = "reserved-completion"
		process.seed("UNDELIVERED_FINAL_RECEIPT")
		process.emit("completed")
		registry.trackTaskOutput(owner, process, "reserved-completion", {
			archiveExecutionId: "1001",
			isClosed: () => true,
		})
		const id = registry.register(owner, process)
		await process.finalizeOutput()
		await process.waitForOutputFinalization()
		const receipt = process.captureUnretrievedOutput()
		for (let index = 0; index < SETTLED_SESSION_LIMIT + 8; index++) {
			registry.register(owner, settledProcess(`pressure-${index}`))
		}

		expect(registry.resolve(owner, id)?.process).toBe(process)
		expect(registry.ownsOutput(process)).toBe(true)
		receipt.release()
		const retry = process.captureUnretrievedOutput()
		expect(retry.output).toBe("UNDELIVERED_FINAL_RECEIPT")
		retry.commit()
		registry.releaseForTask(owner)
	})

	it("protects a settled process until its async completion observer finishes", async () => {
		const registry = new CommandSessionRegistry()
		const owner = { taskId: "owner" } as Task
		const completedEntered = deferred<void>()
		const releaseCompletion = deferred<void>()
		const exit = deferred<{ exitCode: number }>()
		execaMock.mockImplementation(
			() => () =>
				Object.assign(exit.promise, {
					all: new EventEmitter(),
					iterable: () =>
						(async function* () {
							yield "FINAL\n"
						})(),
				}),
		)
		const terminal = new ExecaTerminal(2, "/test")
		const process = new ExecaTerminalProcess(terminal)
		terminal.process = process
		process.executionId = "finalizing-completion"
		process.on("completed", async () => {
			completedEntered.resolve()
			await releaseCompletion.promise
		})
		registry.trackTaskOutput(owner, process, "finalizing-completion", {
			archiveExecutionId: "1002",
			isClosed: () => true,
		})
		const id = registry.register(owner, process)
		const run = process.run("synthetic completion barrier")
		try {
			exit.resolve({ exitCode: 0 })
			await completedEntered.promise
			for (let index = 0; index < SETTLED_SESSION_LIMIT + 8; index++) {
				registry.register(owner, settledProcess(`finalization-pressure-${index}`))
			}
			expect(registry.resolve(owner, id)?.process).toBe(process)
			expect(registry.ownsOutput(process)).toBe(true)
		} finally {
			releaseCompletion.resolve()
			await run
			await process.waitForOutputFinalization()
			registry.releaseForTask(owner)
		}
	})
})

describe("expired command receipts", () => {
	function expire(artifactId?: string) {
		const evidence = { executionId: "expired-command", status: "failed", exitCode: 7 }
		const task = { taskId: "receipt-owner", getCommandExecutionEvidence: () => [evidence] } as unknown as Task
		let unread = true
		const process = Object.assign(new EventEmitter(), {
			executionId: evidence.executionId,
			isSettled: true,
			...(artifactId ? { outputArtifactId: artifactId } : {}),
			hasUnretrievedOutput: () => unread,
			captureUnretrievedOutput: () => ({
				output: "UNDELIVERED",
				hasMoreOutput: false,
				commit: () => {
					unread = false
				},
				release: vi.fn(),
			}),
		}) as unknown as AlphaTerminalProcess
		const id = commandSessionRegistry.register(task, process)
		for (let index = 0; index < SETTLED_SESSION_LIMIT; index++) {
			commandSessionRegistry.register(task, settledProcess(`expiry-pressure-${index}`))
		}
		return { task, id }
	}

	it.each([
		{ artifact: "cmd-1706119234567.txt", budget: 256 },
		{ artifact: "cmd-1706119234567.txt", budget: 0 },
		{ artifact: undefined, budget: 256 },
		{ artifact: undefined, budget: 0 },
	])("returns bounded host evidence after expiry: %j", async ({ artifact, budget }) => {
		const { task, id } = expire(artifact)
		const callbacks = {
			askApproval: vi.fn(),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		try {
			await new ToolRegistry().resolve("write_stdin")!.execute({
				task,
				call: {
					type: "tool_use",
					id: "expired-poll",
					name: "write_stdin",
					params: {},
					partial: false,
					nativeArgs: { session_id: id, max_output_tokens: budget },
				},
				callbacks,
			})
			expect(callbacks.setResultMetadata).toHaveBeenCalledWith(
				expect.objectContaining({ status: "error", commandResult: expect.objectContaining({ exit_code: 7 }) }),
			)
			const result = callbacks.setResultMetadata.mock.calls[0]?.[0].commandResult
			expect(result).not.toHaveProperty("session_id")
			expect(result).not.toHaveProperty("has_more_output")
			if (artifact) expect(result).toHaveProperty("artifact_id", artifact)
			else expect(result).not.toHaveProperty("artifact_id")
			const text = callbacks.pushToolResult.mock.calls[0]?.[0]
			expect(text).toContain("Process exited with code 7")
			expect(text).not.toContain("Process running with session ID")
			if (budget === 0) expect(text).toContain("Output:\n")
			expect(callbacks.askApproval).not.toHaveBeenCalled()
			expect(callbacks.handleError).not.toHaveBeenCalled()
		} finally {
			commandSessionRegistry.releaseForTask(task)
		}
	})

	it("does not expose another task instance's expired artifact or exit evidence", async () => {
		const { task, id } = expire("cmd-1706119234567.txt")
		const callbacks = {
			askApproval: vi.fn(),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		try {
			await new ToolRegistry().resolve("write_stdin")!.execute({
				task: { taskId: task.taskId } as Task,
				call: {
					type: "tool_use",
					id: "other-instance-poll",
					name: "write_stdin",
					params: {},
					partial: false,
					nativeArgs: { session_id: id },
				},
				callbacks,
			})
			expect(callbacks.handleError).toHaveBeenCalledWith("controlling command", expect.any(Error))
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "error" })
		} finally {
			commandSessionRegistry.releaseForTask(task)
		}
	})

	it("returns a retained artifact on the final poll before releasing the session handle", async () => {
		const { process, terminal, task, callbacks, commandEvidence } = inputHarness()
		process.isSettled = true
		terminal.running = false
		process.hasUnretrievedOutput = () => false
		Object.assign(process, { outputArtifactId: "cmd-1706119234567.txt" })
		commandEvidence.status = "succeeded"
		commandEvidence.exitCode = 0
		const id = commandSessionRegistry.register(task, process)
		try {
			await new ToolRegistry().resolve("write_stdin")!.execute({
				task,
				call: {
					type: "tool_use",
					id: "final-artifact-poll",
					name: "write_stdin",
					params: {},
					partial: false,
					nativeArgs: { session_id: id, max_output_tokens: 0 },
				},
				callbacks,
			})
			expect(callbacks.setResultMetadata).toHaveBeenCalledWith(
				expect.objectContaining({
					commandResult: expect.objectContaining({ exit_code: 0, artifact_id: "cmd-1706119234567.txt" }),
				}),
			)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("cmd-1706119234567.txt"))
			expect(commandSessionRegistry.resolve(task, id)).toBeUndefined()
		} finally {
			commandSessionRegistry.releaseForTask(task)
		}
	})
})

describe("approved interactive command control", () => {
	it("retains the numeric handle after a failed reader poll while its physical command runs", async () => {
		const { process, task, callbacks, commandEvidence } = inputHarness()
		process.isSettled = true
		process.hasUnretrievedOutput = () => false
		commandEvidence.status = "failed"
		const id = commandSessionRegistry.register(task, process)
		try {
			await new ToolRegistry().resolve("write_stdin")!.execute({
				task,
				call: {
					type: "tool_use",
					id: "failed-reader-poll",
					name: "write_stdin",
					params: {},
					partial: false,
					nativeArgs: { session_id: id, max_output_tokens: 0 },
				},
				callbacks,
			})
			expect(commandSessionRegistry.resolve(task, id)?.process).toBe(process)
			expect(commandSessionRegistry.ownsOutput(process)).toBe(true)
			expect(callbacks.askApproval).not.toHaveBeenCalled()
		} finally {
			commandSessionRegistry.releaseForTask(task)
		}
	})

	it.each(["approved", "denied", "replaced"] as const)(
		"controls a physical command after reader failure only when %s authority permits it",
		async (authority) => {
			const { process, task, callbacks, interrupt } = inputHarness()
			process.isSettled = true
			callbacks.askApproval.mockImplementation(async () => {
				if (authority === "replaced") process.executionId = "replacement-command"
				return authority !== "denied"
			})
			const id = commandSessionRegistry.register(task, process)
			try {
				await new ToolRegistry().resolve("write_stdin")!.execute({
					task,
					call: {
						type: "tool_use",
						id: "failed-reader-interrupt",
						name: "write_stdin",
						params: {},
						partial: false,
						nativeArgs: { session_id: id, chars: "\u0003", yield_time_ms: 250 },
					},
					callbacks,
				})
				expect(callbacks.askApproval).toHaveBeenCalledOnce()
				expect(interrupt).toHaveBeenCalledTimes(authority === "approved" ? 1 : 0)
				expect(process.abort).not.toHaveBeenCalled()
				if (authority === "replaced") expect(callbacks.handleError).toHaveBeenCalled()
				else expect(callbacks.handleError).not.toHaveBeenCalled()
			} finally {
				commandSessionRegistry.releaseForTask(task)
			}
		},
	)

	it("does not restore literal stdin authority when the output reader has failed", async () => {
		const { process, task, callbacks, interrupt } = inputHarness(true)
		process.isSettled = true
		await manageCommandTool.execute(
			{ execution_id: "physical-command", action: "input", input: "yes\n", timeout_ms: 0 },
			task,
			callbacks,
		)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(process.writeInput).not.toHaveBeenCalled()
		expect(interrupt).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalled()
	})

	it.each([false, true])(
		"interrupts a session with Ctrl-C using provider control (literal input: %s)",
		async (input) => {
			const { process, task, callbacks, interrupt } = inputHarness(input)
			const id = commandSessionRegistry.register(task, process)
			try {
				await new ToolRegistry().resolve("write_stdin")!.execute({
					task,
					call: {
						type: "tool_use",
						id: "interrupt-call",
						name: "write_stdin",
						params: {},
						partial: false,
						nativeArgs: { session_id: id, chars: "\u0003", yield_time_ms: 250 },
					},
					callbacks,
				})
				expect(callbacks.askApproval).toHaveBeenCalledOnce()
				expect(interrupt).toHaveBeenCalledOnce()
				expect(process.abort).not.toHaveBeenCalled()
				if (process.writeInput) expect(process.writeInput).not.toHaveBeenCalled()
				expect(callbacks.handleError).not.toHaveBeenCalled()
			} finally {
				commandSessionRegistry.releaseForTask(task)
			}
		},
	)

	it("keeps an interrupt denial inside the existing approval boundary", async () => {
		const { process, task, callbacks, interrupt } = inputHarness()
		callbacks.askApproval.mockResolvedValue(false)
		await manageCommandTool.execute(
			{ execution_id: "physical-command", action: "input", input: "\u0003", timeout_ms: 0 },
			task,
			callbacks,
		)
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		expect(process.abort).not.toHaveBeenCalled()
		expect(interrupt).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith(expect.objectContaining({ status: "denied" }))
	})

	it("revalidates the physical command after interrupt approval", async () => {
		const { process, task, callbacks, interrupt } = inputHarness()
		callbacks.askApproval.mockImplementation(async () => {
			process.executionId = "replacement-command"
			return true
		})
		await manageCommandTool.execute(
			{ execution_id: "physical-command", action: "input", input: "\u0003", timeout_ms: 0 },
			task,
			callbacks,
		)
		expect(process.abort).not.toHaveBeenCalled()
		expect(interrupt).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledWith("controlling command", expect.any(Error))
	})

	it("does not reinterpret literal mixed control text as an interrupt for a pipe session", async () => {
		const { process, task, callbacks } = inputHarness()
		await manageCommandTool.execute(
			{ execution_id: "physical-command", action: "input", input: "prefix\u0003", timeout_ms: 0 },
			task,
			callbacks,
		)
		expect(process.abort).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledWith("controlling command", expect.any(Error))
	})
})

describe("equivalent command execution paths", () => {
	it.each([
		{
			label: "native PTY exec",
			args: { cmd: "rg -n needle .", tty: true, yield_time_ms: 10_000, max_output_tokens: 0 },
		},
		{ label: "historical exec", args: { command: "rg -n needle .", timeout: 10 } },
	])("keeps $label transport on ordinary approval before isolated filesystem inspection", async ({ args }) => {
		const realpath = vi
			.spyOn(fs, "realpath")
			.mockRejectedValue(new Error("Command-session execution must bypass isolated-read preparation"))
		const callbacks = {
			toolCallId: "equivalent-command",
			askApproval: vi.fn(),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		}
		const task = { taskId: "owner", cwd: "/workspace" } as Task
		const policy = createToolPolicySnapshot({ visibleTools: ["exec_command"] })
		const call = {
			type: "tool_use",
			id: "equivalent-command",
			name: "exec_command",
			params: {},
			partial: false,
			nativeArgs: args,
		} as ToolUse

		await expect(isParallelCommandReadReady(task, args, policy)).resolves.toBe(false)
		const descriptor = new ToolRegistry().resolve("exec_command")
		if (!descriptor?.prepareParallelCommand) throw new Error("Command preparation descriptor is unavailable")
		await expect(descriptor.prepareParallelCommand({ task, call, callbacks }, policy)).resolves.toBeUndefined()
		expect(realpath).not.toHaveBeenCalled()
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(execaMock).not.toHaveBeenCalled()
	})
})

describe("native exec transport selection", () => {
	it.each([undefined, null, false, true])("preserves tty=%s through complete and streaming parsing", (tty) => {
		const args = { cmd: "node script.cjs", ...(tty === undefined ? {} : { tty }) }
		const parsed = NativeToolCallParser.parseToolCall({
			id: "exec-transport",
			name: "exec_command",
			arguments: JSON.stringify(args),
		})
		expect(parsed).toMatchObject({ name: "exec_command", nativeArgs: args, partial: false })
		NativeToolCallParser.startStreamingToolCall("stream-transport", "exec_command")
		expect(NativeToolCallParser.processStreamingChunk("stream-transport", JSON.stringify(args))).toMatchObject({
			name: "exec_command",
			nativeArgs: args,
			partial: true,
		})
		expect(NativeToolCallParser.finalizeStreamingToolCall("stream-transport")).toMatchObject({
			name: "exec_command",
			nativeArgs: args,
			partial: false,
		})
	})

	it.each([{ tty: "true" }, { tty: 1 }, { tty: {} }, { tty: true, unsafe: true }])(
		"rejects invalid tty and unknown execution arguments: %j",
		(extra) => {
			vi.spyOn(console, "error").mockImplementation(() => undefined)
			const args = { cmd: "node script.cjs", ...extra }
			expect(
				NativeToolCallParser.parseToolCall({
					id: "invalid-transport",
					name: "exec_command",
					arguments: JSON.stringify(args),
				}),
			).toBeNull()
			NativeToolCallParser.startStreamingToolCall("invalid-stream", "exec_command")
			NativeToolCallParser.processStreamingChunk("invalid-stream", JSON.stringify(args))
			expect(NativeToolCallParser.finalizeStreamingToolCall("invalid-stream")).toBeNull()
		},
	)

	it("advertises per-command PTY selection", () => {
		const schema = new ToolRegistry().resolve("exec_command")!.schema
		expect(schema.type).toBe("function")
		if (schema.type !== "function") throw new Error("exec_command must remain a function tool")
		expect(schema.function.parameters).toMatchObject({ properties: { tty: { type: "boolean" } } })
	})

	function transportTask(): Task {
		const provider = {
			runWorkspaceMutation: async (_task: Task, _label: string, run: () => Promise<void>) => {
				await run()
			},
		}
		return {
			taskId: "transport-owner",
			abort: false,
			providerRef: { deref: () => provider },
		} as unknown as Task
	}

	it.each([undefined, null, false, true])(
		"selects a pipe by default and preserves an explicit native tty=%s",
		async (tty) => {
			const execute = vi.spyOn(executeCommandTool, "execute").mockResolvedValue(undefined)
			const args = { cmd: "node script.cjs", ...(tty === undefined ? {} : { tty }) }
			const callbacks = { askApproval: vi.fn(), pushToolResult: vi.fn(), handleError: vi.fn() }
			await new ToolRegistry().resolve("exec_command")!.execute({
				task: transportTask(),
				call: {
					type: "tool_use",
					id: "native-transport",
					name: "exec_command",
					params: {},
					partial: false,
					nativeArgs: args,
				},
				callbacks,
			})
			expect(execute).toHaveBeenCalledWith(
				expect.objectContaining({ tty: tty === true }),
				expect.any(Object),
				expect.any(Object),
			)
		},
	)

	it("retains configured transport for historical execute_command arguments", async () => {
		const execute = vi.spyOn(executeCommandTool, "execute").mockResolvedValue(undefined)
		const callbacks = { askApproval: vi.fn(), pushToolResult: vi.fn(), handleError: vi.fn() }
		await new ToolRegistry().resolve("execute_command")!.execute({
			task: transportTask(),
			call: {
				type: "tool_use",
				id: "legacy-transport",
				name: "execute_command",
				params: {},
				partial: false,
				nativeArgs: { command: "node script.cjs" } as NativeToolArgs["execute_command"],
			} as ToolUse,
			callbacks,
		})
		expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("tty")
	})
})
