import { EventEmitter } from "node:events"
import { TelemetryService } from "@alpha-code/telemetry"
import type { AlphaMessage } from "@alpha-code/types"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import { Task, type CommandExecutionEvidence } from "../../task/Task"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { createTaskToolSurface } from "../TaskToolSurface"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { commandSessionRegistry } from "../CommandSessionRegistry"
import { formatCommandToolResult } from "../BaseTool"
import { executeCommandTool } from "../ExecuteCommandTool"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { TerminalProcess } from "../../../integrations/terminal/TerminalProcess"
import { ExecaTerminalProcess } from "../../../integrations/terminal/ExecaTerminalProcess"
import type { Terminal } from "../../../integrations/terminal/Terminal"
import type { ToolCallbacks } from "../BaseTool"
import type {
	AlphaTerminal,
	AlphaTerminalCallbacks,
	AlphaTerminalProcess,
	ExitCodeDetails,
} from "../../../integrations/terminal/types"

vi.mock("node:worker_threads", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:worker_threads")>()
	const { readFileSync } = await import("node:fs")
	const { transformSync } = await import("esbuild")
	const nodePath = await import("node:path")
	const source = transformSync(
		readFileSync(nodePath.resolve(process.cwd(), "workers/searchCommandOutput.ts"), "utf8"),
		{
			loader: "ts",
			format: "cjs",
		},
	).code
	class SearchTestWorker extends original.Worker {
		constructor(filename: string | URL, options?: import("node:worker_threads").WorkerOptions) {
			// Focused source tests must not depend on a previously bundled worker.
			const isSearchWorker =
				typeof filename === "string" && nodePath.basename(filename) === "searchCommandOutput.js"
			super(isSearchWorker ? source : filename, isSearchWorker ? { ...options, eval: true } : options)
		}
	}
	return { ...original, Worker: SearchTestWorker }
})

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII="

function commandFixture(
	options: {
		taskId?: string
		globalStoragePath?: string
		mode?: "code" | "architect"
		disabledTools?: string[]
	} = {},
) {
	const cwd = process.cwd()
	const mode = options.mode ?? "code"
	const taskId = options.taskId ?? "astra-command-audit"
	const lifetime = new AbortController()
	const evidence = new Map<string, CommandExecutionEvidence>()
	const publishedMessages: AlphaMessage[] = []
	const persistedMessages: AlphaMessage[][] = []
	let resolveLaunched!: () => void
	const launched = new Promise<void>((resolve) => (resolveLaunched = resolve))
	let resolveProcess!: () => void
	const processPromise = new Promise<void>((resolve) => (resolveProcess = resolve))
	let resolveEvidence!: () => void
	const evidenceSettled = new Promise<void>((resolve) => (resolveEvidence = resolve))
	let handlers!: AlphaTerminalCallbacks
	let unreadOutput = ""
	const terminalProcess = Object.assign(new EventEmitter(), {
		isSettled: false,
		executionId: "",
		then: processPromise.then.bind(processPromise),
		catch: processPromise.catch.bind(processPromise),
		finally: processPromise.finally.bind(processPromise),
		continue: vi.fn(),
		abort: vi.fn(),
		hasUnretrievedOutput: () => unreadOutput.length > 0,
		captureUnretrievedOutput: () => ({
			output: unreadOutput,
			commit: () => {
				unreadOutput = ""
			},
			release: () => undefined,
		}),
	})
	const terminal = {
		provider: "execa",
		id: 1,
		taskId,
		running: true,
		busy: true,
		process: terminalProcess,
		getCurrentWorkingDirectory: () => cwd,
		runCommand: (_command: string, callbacks: AlphaTerminalCallbacks) => {
			handlers = callbacks
			resolveLaunched()
			return terminalProcess
		},
	}
	vi.spyOn(TerminalRegistry, "getOrCreateTerminal").mockResolvedValue(terminal as never)
	vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([terminal as never])
	const terminalSettings = { terminalShellIntegrationDisabled: true }
	const provider = {
		context: { globalStorageUri: { fsPath: options.globalStoragePath } },
		getState: vi.fn(async () => ({ ...terminalSettings })),
		getValue: vi.fn((key: string) =>
			key === "terminalShellIntegrationDisabled" ? terminalSettings.terminalShellIntegrationDisabled : undefined,
		),
		postMessageToWebview: vi.fn(),
		runWorkspaceMutation: async (_task: Task, _label: string, run: () => Promise<void>) => run(),
	}
	const task = {
		cwd,
		taskId,
		abort: false,
		consecutiveMistakeCount: 0,
		commandExecutionEvidence: evidence,
		completionRuntimeRevision: 0,
		clineMessages: [] as AlphaMessage[],
		presentApprovedCommand: Task.prototype.presentApprovedCommand,
		reserveUiMessageTimestamp: Task.prototype["reserveUiMessageTimestamp"],
		observeUiMessageTimestamps: Task.prototype["observeUiMessageTimestamps"],
		addToAlphaMessages: Task.prototype["addToAlphaMessages"],
		publishAlphaMessageCreated: vi.fn(async (message: AlphaMessage) => {
			publishedMessages.push(structuredClone(message))
		}),
		saveAlphaMessages: vi.fn(async () => {
			persistedMessages.push(structuredClone(task.clineMessages))
			return true
		}),
		providerRef: { deref: () => provider },
		getTaskLifetimeCancellationSignal: () => lifetime.signal,
		getTaskMode: async () => mode,
		getTaskToolDenialReason: Task.prototype.getTaskToolDenialReason,
		getTaskAllowedToolNames: Task.prototype.getTaskAllowedToolNames,
		say: vi.fn(async () => undefined),
		recordToolError: vi.fn(),
		beginCommandExecution: Task.prototype.beginCommandExecution,
		admitCommandExecution: async (callId: string, executionId: string, command: string, commandCwd: string) => {
			Object.assign(evidence.get(callId)!, { executionId, command, cwd: commandCwd })
		},
		completeCommandExecution: vi.fn(
			(callId: string, details: { exitCode?: number; signalName?: string }, executionId?: string) => {
				Task.prototype.completeCommandExecution.call(task, callId, details, executionId)
				resolveEvidence()
			},
		),
		failCommandExecution: Task.prototype.failCommandExecution,
		getCommandExecutionEvidence: Task.prototype.getCommandExecutionEvidence,
		markCommandExecutionBackgrounded: Task.prototype.markCommandExecutionBackgrounded,
		publishParentVerificationEvidence: vi.fn(),
		supersedePendingAsk: vi.fn(),
		suspendAfterCurrentTurn: vi.fn(),
	} as unknown as Task
	const userMessageContent: ToolExecutionHost["userMessageContent"] = []
	const host: ToolExecutionHost = {
		taskId,
		cwd,
		taskFacade: task,
		userMessageContent,
		askApproval: async () => ({ response: "yesButtonClicked" }),
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent: (result) => {
			userMessageContent.push(result)
			return true
		},
	}
	const schemas = getNativeTools({ planMode: mode === "architect" })
	const surface = createTaskToolSurface({ schemas, mode, cwd, disabledTools: options.disabledTools })
	const run = (id: string, name: string, args: Record<string, unknown>) =>
		new ToolScheduler({ executionHost: host, registry: surface.registry, policy: surface.policy, mode }).run([
			{ type: "tool_call", id, name, arguments: args },
		])
	return {
		task,
		terminalSettings,
		publishedMessages,
		persistedMessages,
		host,
		run,
		launched,
		terminalProcess,
		emitLine: (line: string) => handlers.onLine(line, terminalProcess as unknown as AlphaTerminalProcess),
		surface,
		finish: async (exit: number | ExitCodeDetails) => {
			const details = typeof exit === "number" ? { exitCode: exit } : exit
			unreadOutput = details.signalName
				? `process terminated by ${details.signalName}`
				: `process completed with ${details.exitCode ?? "unknown exit code"}`
			handlers.onShellExecutionComplete(details, terminalProcess as unknown as AlphaTerminalProcess)
			await handlers.onCompleted(unreadOutput, terminalProcess as unknown as AlphaTerminalProcess)
			await evidenceSettled
			terminalProcess.isSettled = true
			terminal.running = false
			terminal.busy = false
			terminalProcess.emit("completed", unreadOutput)
			resolveProcess()
		},
	}
}

async function startBackgroundCommand(fixture: ReturnType<typeof commandFixture>) {
	const execution = fixture.run("start", "exec_command", { cmd: 'node -e "process.exit(7)"' })
	expect(await Promise.race([fixture.launched.then(() => "launched"), execution])).toBe("launched")
	await vi.advanceTimersByTimeAsync(10_100)
	const initial = await execution
	const sessionId = initial.results[0].commandResult?.session_id
	expect(initial.results[0]).toMatchObject({ status: "success", executionStatus: "running" })
	expect(sessionId).toEqual(expect.any(Number))
	return sessionId!
}

async function completedReceiptFixture(provider: "vscode" | "execa", output: string) {
	const fixture = commandFixture()
	const terminal = {
		provider,
		id: 2,
		busy: false,
		running: false,
		isStreamClosed: true,
		getCurrentWorkingDirectory: () => fixture.task.cwd,
		isClosed: () => false,
	}
	const command =
		provider === "vscode"
			? new TerminalProcess(terminal as unknown as Terminal)
			: new ExecaTerminalProcess(terminal as unknown as AlphaTerminal)
	command.executionId = "retained-execution"
	Reflect.set(command, "fullOutput", output)
	command.emit("completed")
	// Adapters join output closure before a settled command becomes releasable.
	await command.finalizeOutput()
	expect(command.isOutputFinalized).toBe(true)
	fixture.task.beginCommandExecution("retained", command.executionId)
	fixture.task.completeCommandExecution("retained", { exitCode: 0 }, command.executionId)
	vi.mocked(TerminalRegistry.getTerminals).mockReturnValue([])
	const sessionId = commandSessionRegistry.register(fixture.task, command)
	return { ...fixture, command, terminal, sessionId }
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe.each(["vscode", "execa"] as const)("completed %s command receipts", (provider) => {
	it("advertises and drains the retained tail without implying the process is still running", async () => {
		const output = `${"build progress\n".repeat(600)}final diagnostic`
		const fixture = await completedReceiptFixture(provider, output)
		const first = (await fixture.run("first", "write_stdin", { session_id: fixture.sessionId })).results[0]
		expect(first).toMatchObject({
			status: "success",
			executionStatus: "success",
			truncated: true,
			commandResult: { exit_code: 0, session_id: fixture.sessionId, has_more_output: true },
		})
		expect(first.content).toContain("Process exited with code 0")
		expect(first.content).not.toContain("Process running")
		const guidance = String(first.content).match(/Read remaining output with write_stdin using (\{[^\n]*\})\./)
		expect(guidance).not.toBeNull()
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeDefined()
		const second = (await fixture.run("second", "write_stdin", JSON.parse(guidance![1]))).results[0]
		expect(first.commandResult!.output + second.commandResult!.output).toBe(output)
		expect(second.truncated).toBe(false)
		expect(second.commandResult).not.toHaveProperty("session_id")
		expect(second.commandResult).not.toHaveProperty("has_more_output")
		expect(fixture.command.hasUnretrievedOutput()).toBe(false)
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeUndefined()
	})

	it("does not lose JSON-sensitive text when bounded native receipts commit", async () => {
		const output = `${'"\\'.repeat(600)}final diagnostic`
		const fixture = await completedReceiptFixture(provider, output)
		let delivered = ""
		for (let index = 0; index < 10; index++) {
			const result = (
				await fixture.run(`escaped-${index}`, "write_stdin", {
					session_id: fixture.sessionId,
					max_output_tokens: 256,
				})
			).results[0]
			expect(result.status).toBe("success")
			expect(result.commandResult!.output.length).toBeLessThanOrEqual(1_024)
			delivered += result.commandResult!.output
			if (!result.commandResult!.has_more_output) break
		}
		expect(delivered).toBe(output)
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeUndefined()
	})

	it.each([0, 100])("retains truthful continuation metadata for a %s-token budget", async (maxOutputTokens) => {
		const fixture = await completedReceiptFixture(provider, "final diagnostic")
		const first = (
			await fixture.run("tiny", "write_stdin", {
				session_id: fixture.sessionId,
				max_output_tokens: maxOutputTokens,
			})
		).results[0]
		expect(first).toMatchObject({
			status: "success",
			truncated: true,
			commandResult: { output: "", exit_code: 0, session_id: fixture.sessionId, has_more_output: true },
		})
		expect(Reflect.get(fixture.command, "lastRetrievedIndex")).toBe(0)
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeDefined()
		const retry = (await fixture.run("retry", "write_stdin", { session_id: fixture.sessionId })).results[0]
		expect(retry.commandResult?.output).toBe("final diagnostic")
		expect(retry.truncated).toBe(false)
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeUndefined()
	})

	it("retains structured continuation when the host cap cannot fit the text hint", async () => {
		const fixture = await completedReceiptFixture(provider, "final diagnostic")
		const surface = createTaskToolSurface({
			schemas: fixture.surface.schemas,
			mode: "code",
			cwd: fixture.task.cwd,
			outputLimits: { write_stdin: 64 },
		})
		const outcome = await new ToolScheduler({
			executionHost: fixture.host,
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
		}).run([
			{
				type: "tool_call",
				id: "host-capped",
				name: "write_stdin",
				arguments: { session_id: fixture.sessionId },
			},
		])
		expect(outcome.results[0]).toMatchObject({
			status: "success",
			truncated: true,
			commandResult: { output: "", exit_code: 0, session_id: fixture.sessionId, has_more_output: true },
		})
		expect(String(outcome.results[0].content)).toHaveLength(64)
		expect(Reflect.get(fixture.command, "lastRetrievedIndex")).toBe(0)
		const retry = (await fixture.run("retry-host-cap", "write_stdin", { session_id: fixture.sessionId })).results[0]
		expect(retry.commandResult?.output).toBe("final diagnostic")
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeUndefined()
	})

	it("releases a failed delivery reservation without consuming output or retiring its session", async () => {
		const release = vi.spyOn(commandSessionRegistry, "release")
		const fixture = await completedReceiptFixture(provider, "final diagnostic")
		const callbacks: ToolCallbacks = {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(() => {
				throw new Error("delivery failed")
			}),
			setResultMetadata: vi.fn(),
		}
		await fixture.surface.resolve("write_stdin")!.execute({
			task: fixture.task,
			call: {
				type: "tool_use",
				id: "failed-delivery",
				name: "write_stdin",
				params: {},
				partial: false,
				nativeArgs: { session_id: fixture.sessionId },
			},
			callbacks,
		})
		expect(callbacks.handleError).toHaveBeenCalledWith("controlling command", expect.any(Error))
		expect(release).not.toHaveBeenCalled()
		expect(Reflect.get(fixture.command, "lastRetrievedIndex")).toBe(0)
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeDefined()
		const retry = (await fixture.run("retry-delivery", "write_stdin", { session_id: fixture.sessionId })).results[0]
		expect(retry.commandResult?.output).toBe("final diagnostic")
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeUndefined()
		expect(release).toHaveBeenCalledExactlyOnceWith(fixture.task, fixture.sessionId)
		const retired = await fixture.run("already-retired", "write_stdin", { session_id: fixture.sessionId })
		expect(retired.results[0].status).toBe("error")
		expect(release).toHaveBeenCalledOnce()
	})
})

describe("native command transaction consistency", () => {
	it("retains a normal nonzero exec_command exit as a successful transaction", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const fixture = commandFixture()
		const execution = fixture.run("start", "exec_command", { cmd: 'node -e "process.exit(7)"' })
		expect(await Promise.race([fixture.launched.then(() => "launched"), execution])).toBe("launched")
		await fixture.finish(7)
		await vi.advanceTimersByTimeAsync(100)
		const outcome = await execution

		expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({ status: "failed", exitCode: 7 })
		expect(outcome.results[0]).toMatchObject({ status: "success", executionStatus: "error", exitCode: 7 })
		expect(outcome.results[0].failure).toBeUndefined()
		expect(fixture.host.userMessageContent.at(-1)).toMatchObject({ type: "tool_result", is_error: false })
	})

	it.each(["before", "during"] as const)(
		"retains a normal nonzero exit %s write_stdin as a successful transaction",
		async (completion) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
			const fixture = commandFixture()
			const sessionId = await startBackgroundCommand(fixture)
			if (completion === "before") await fixture.finish(7)
			const poll = fixture.run("poll", "write_stdin", { session_id: sessionId, yield_time_ms: 30_000 })
			if (completion === "during") {
				await vi.advanceTimersByTimeAsync(0)
				expect(fixture.terminalProcess.listenerCount("output_available")).toBe(1)
				await fixture.finish(7)
			}
			const outcome = await poll

			expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({ status: "failed", exitCode: 7 })
			expect.soft(outcome.results[0]).toMatchObject({ status: "success", executionStatus: "error", exitCode: 7 })
			expect.soft(outcome.results[0].failure).toBeUndefined()
			expect.soft(outcome.results[0].content).toContain("Process exited with code 7")
			expect.soft(outcome.results[0].commandResult).toMatchObject({
				exit_code: 7,
				output: "process completed with 7",
			})
			expect(outcome.results[0].commandResult).not.toHaveProperty("session_id")
			expect.soft(fixture.host.userMessageContent.at(-1)).toMatchObject({ type: "tool_result", is_error: false })
			expect(fixture.host.userMessageContent.filter((item) => item.type === "tool_result")).toHaveLength(2)
			expect(commandSessionRegistry.resolve(fixture.task, sessionId)).toBeUndefined()
			expect(fixture.terminalProcess.listenerCount("output_available")).toBe(0)
		},
	)

	it.each([
		{ cause: "signal", details: { exitCode: 7, signalName: "SIGTERM" } },
		{ cause: "unknown exit", details: { exitCode: undefined } },
	])("keeps a $cause as a tool error after yielding", async ({ details }) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const fixture = commandFixture()
		const sessionId = await startBackgroundCommand(fixture)
		await fixture.finish(details)
		const outcome = await fixture.run("poll", "write_stdin", { session_id: sessionId })

		expect(outcome.results[0]).toMatchObject({ status: "error", executionStatus: "error" })
		expect(fixture.host.userMessageContent.at(-1)).toMatchObject({ type: "tool_result", is_error: true })
		expect(commandSessionRegistry.resolve(fixture.task, sessionId)).toBeUndefined()
	})

	it.each([
		{ cause: "timed_out", status: "error", executionStatus: "error" },
		{ cause: "cancelled", status: "cancelled", executionStatus: "cancelled" },
		{ cause: "denied", status: "denied", executionStatus: "denied" },
		{ cause: "failed", status: "error", executionStatus: "error" },
	] as const)("preserves $cause evidence even if the process later exits", async ({ cause, ...expected }) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const fixture = commandFixture()
		const sessionId = await startBackgroundCommand(fixture)
		fixture.task.failCommandExecution("start", cause)
		await fixture.finish(7)
		const outcome = await fixture.run("poll", "write_stdin", { session_id: sessionId })

		expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({ status: cause })
		expect(outcome.results[0]).toMatchObject(expected)
		expect(outcome.results[0].commandResult).not.toHaveProperty("exit_code")
		expect(fixture.host.userMessageContent.at(-1)).toMatchObject({ type: "tool_result", is_error: true })
		expect(commandSessionRegistry.resolve(fixture.task, sessionId)).toBeUndefined()
	})

	it("retains unread output for retry when receipt capture fails", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const fixture = commandFixture()
		const sessionId = await startBackgroundCommand(fixture)
		await fixture.finish(7)
		vi.spyOn(fixture.terminalProcess, "captureUnretrievedOutput").mockImplementationOnce(() => {
			throw new Error("Output capture failed")
		})
		const failed = await fixture.run("failed-poll", "write_stdin", { session_id: sessionId })
		expect(failed.results[0]).toMatchObject({
			status: "error",
			content: expect.stringContaining("Output capture failed"),
		})
		expect(commandSessionRegistry.resolve(fixture.task, sessionId)).toBeDefined()
		expect(fixture.terminalProcess.hasUnretrievedOutput()).toBe(true)

		const retry = await fixture.run("retry-poll", "write_stdin", { session_id: sessionId })
		expect(retry.results[0]).toMatchObject({ status: "success", executionStatus: "error", exitCode: 7 })
		expect(retry.results[0].content).toContain("process completed with 7")
		expect(commandSessionRegistry.resolve(fixture.task, sessionId)).toBeUndefined()
	})

	it("returns a tool error if a live command session is no longer available", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const fixture = commandFixture()
		const sessionId = await startBackgroundCommand(fixture)
		vi.mocked(TerminalRegistry.getTerminals).mockReturnValue([])
		const outcome = await fixture.run("poll", "write_stdin", { session_id: sessionId })

		expect(outcome.results[0]).toMatchObject({
			status: "error",
			content: expect.stringContaining("Command session is unavailable for this task"),
		})
		expect(fixture.host.userMessageContent.at(-1)).toMatchObject({ type: "tool_result", is_error: true })
		await fixture.finish(7)
	})

	it.each(["code", "architect"] as const)(
		"directs truncated output to a bounded task artifact read in %s",
		async (mode) => {
			const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-audit-"))
			try {
				const fixture = commandFixture({ globalStoragePath, mode })
				const artifactId = "cmd-1706119234567.txt"
				const artifactDirectory = path.join(globalStoragePath, "tasks", fixture.task.taskId, "command-output")
				await fs.mkdir(artifactDirectory, { recursive: true })
				await fs.writeFile(
					path.join(artifactDirectory, artifactId),
					`${"retained output\n".repeat(1_000)}tail marker`,
				)
				const receipt = formatCommandToolResult(
					{ wall_time_seconds: 1, output: "preview", exit_code: 0, artifact_id: artifactId },
					1_000,
					"artifact-command",
				)
				const guidance = receipt.match(/Read artifact [^\n]* with (\w+) using (\{[^\n]*\})\./)
				expect(receipt).toContain("Output truncated")
				expect(guidance?.[1]).toBe("write_stdin")
				const args = JSON.parse(guidance![2]) as Record<string, unknown>
				expect(args).toEqual({ artifact_id: artifactId })
				expect(fixture.surface.isCallable("write_stdin")).toBe(true)
				expect(fixture.surface.resolve("write_stdin")?.capabilities).toMatchObject({
					concurrency: "serial",
					sideEffects: "workspace",
				})
				const outcome = await fixture.run("follow-guidance", guidance![1], { ...args, limit: 512 })
				expect(outcome.results[0]).toMatchObject({
					status: "success",
					content: expect.stringContaining("retained output"),
				})
				expect(Buffer.byteLength(outcome.results[0].content as string)).toBeLessThanOrEqual(512)
				expect(outcome.results[0].content).not.toContain("tail marker")
				expect(fixture.host.userMessageContent.at(-1)).toMatchObject({ type: "tool_result", is_error: false })
				const strictRead = await fixture.run("strict-read", "write_stdin", {
					artifact_id: artifactId,
					search: "tail marker",
					offset: null,
					limit: null,
					session_id: null,
					chars: null,
					yield_time_ms: null,
					max_output_tokens: null,
				})
				expect(strictRead.results[0]).toMatchObject({
					status: "success",
					content: expect.stringContaining("tail marker"),
				})

				const otherTask = commandFixture({ globalStoragePath, taskId: "another-task", mode })
				const foreignRead = await otherTask.run("foreign-read", guidance![1], args)
				expect(foreignRead.results[0]).toMatchObject({
					status: "error",
					content: expect.stringContaining("Artifact not found"),
				})
				expect(foreignRead.results[0].content).not.toContain("retained output")
			} finally {
				await fs.rm(globalStoragePath, { recursive: true, force: true })
			}
		},
	)

	it.each(["code", "architect"] as const)(
		"rejects missing or mixed artifact targets in %s before touching a session",
		async (mode) => {
			const fixture = commandFixture({ mode })
			for (const args of [
				{},
				{ artifact_id: "cmd-1.txt", session_id: 1 },
				{ artifact_id: "cmd-1.txt", chars: "" },
				{ artifact_id: "cmd-1.txt", yield_time_ms: 1 },
				{ artifact_id: "cmd-1.txt", max_output_tokens: 1 },
				{ artifact_id: "cmd-1.txt", action: "stop" },
			]) {
				const outcome = await fixture.run("invalid", "write_stdin", args)
				expect(outcome.results[0].status).not.toBe("success")
				expect(outcome.results[0].content).toMatch(mode === "code" ? /Supply either/ : /not allowed/)
			}
			expect(TerminalRegistry.getTerminals).not.toHaveBeenCalled()
		},
	)

	it.each(["review", "worker"] as const)(
		"keeps captured execute=false %s authority confined to artifact reads",
		async (role) => {
			const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-audit-"))
			try {
				const fixture = commandFixture({ globalStoragePath })
				Object.setPrototypeOf(fixture.task, Task.prototype)
				Object.assign(fixture.task, {
					taskKind: "subagent",
					subagentRole: role,
					subagentContextManifest: {
						skills: [],
						runtimePolicy: { role, execute: false, allowedTools: ["write_stdin", "attempt_completion"] },
					},
				})
				const artifactId = "cmd-1706119234567.txt"
				const artifactDirectory = path.join(globalStoragePath, "tasks", fixture.task.taskId, "command-output")
				await fs.mkdir(artifactDirectory, { recursive: true })
				await fs.writeFile(path.join(artifactDirectory, artifactId), "retained child output")
				const read = await fixture.run("child-read", "write_stdin", { artifact_id: artifactId })
				expect(read.results[0]).toMatchObject({
					status: "success",
					content: expect.stringContaining("retained child output"),
				})
				for (const args of [{ session_id: 1 }, { session_id: 1, chars: "yes\n" }]) {
					const session = await fixture.run("child-session", "write_stdin", args)
					expect(session.results[0]).toMatchObject({
						status: "denied",
						content: expect.stringContaining("cannot control command sessions"),
					})
				}
				Object.assign(fixture.task, {
					subagentContextManifest: {
						skills: [],
						runtimePolicy: { role, execute: false, allowedTools: ["attempt_completion"] },
					},
				})
				const ungranted = await fixture.run("ungranted-read", "write_stdin", { artifact_id: artifactId })
				expect(ungranted.results[0]).toMatchObject({
					status: "denied",
					content: expect.stringContaining("not allowed"),
				})
				expect(TerminalRegistry.getTerminals).not.toHaveBeenCalled()
			} finally {
				await fs.rm(globalStoragePath, { recursive: true, force: true })
			}
		},
	)

	it("rejects artifact traversal and disabled artifact readers", async () => {
		const fixture = commandFixture()
		const traversal = await fixture.run("traversal", "write_stdin", { artifact_id: "../other/cmd-1.txt" })
		expect(traversal.results[0]).toMatchObject({
			status: "error",
			content: expect.stringContaining("Invalid artifact_id"),
		})
		const disabled = commandFixture({ disabledTools: ["write_stdin"] })
		const denied = await disabled.run("disabled", "write_stdin", { artifact_id: "cmd-1.txt" })
		expect(disabled.surface.isCallable("write_stdin")).toBe(false)
		expect(denied.results[0].status).not.toBe("success")
		expect(TerminalRegistry.getTerminals).not.toHaveBeenCalled()
	})

	it("rejects session polls and input in Plan even with a captured Code schema", async () => {
		const fixture = commandFixture()
		for (const args of [{ session_id: 1 }, { session_id: 1, chars: "yes\n" }]) {
			const outcome = await new ToolScheduler({
				executionHost: fixture.host,
				registry: fixture.surface.registry,
				policy: fixture.surface.policy,
				mode: "architect",
			}).run([{ type: "tool_call", id: "plan-session", name: "write_stdin", arguments: args }])
			expect(outcome.results[0].status).not.toBe("success")
			expect(outcome.results[0].content).toContain("not allowed")
		}
		expect(TerminalRegistry.getTerminals).not.toHaveBeenCalled()
	})
})

function schedulerFor(fixture: ReturnType<typeof commandFixture>, limit: number) {
	const surface = createTaskToolSurface({
		registry: fixture.surface.registry,
		mode: "code",
		cwd: fixture.task.cwd,
		outputLimits: { exec_command: limit },
	})
	return new ToolScheduler({
		executionHost: fixture.host,
		registry: surface.registry,
		policy: surface.policy,
		mode: "code",
	})
}
describe("command-session publication is possible before effects", () => {
	it.each(["native", "legacy"])(
		"rejects insufficient host framing for %s arguments before any launch",
		async (syntax) => {
			vi.useFakeTimers()
			const fixture = commandFixture()
			const arguments_ =
				syntax === "native"
					? { cmd: 'node -e "process.exit(7)"' }
					: { command: 'node -e "process.exit(7)"', timeout: 10 }
			const execution = schedulerFor(fixture, 64).run([
				{
					type: "tool_call",
					id: "publication",
					name: "exec_command",
					arguments: arguments_,
				},
			])
			const boundary = await Promise.race([
				fixture.launched.then(() => "launched"),
				execution.then(() => "settled"),
			])
			if (boundary === "launched") await vi.advanceTimersByTimeAsync(10_100)
			const outcome = await execution
			try {
				expect(boundary).toBe("settled")
				expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
				expect(outcome.results).toHaveLength(1)
				expect(outcome.results[0]).toMatchObject({
					status: "error",
					failure: {
						reason: "pre_launch_rejected",
						effectsStarted: "no",
						outcome: "known",
					},
				})
				expect(outcome.results[0].commandResult).toBeUndefined()
				expect(String(outcome.results[0].content).length).toBeLessThanOrEqual(64)
				expect(fixture.host.userMessageContent).toHaveLength(1)
				expect(fixture.host.userMessageContent[0]).toMatchObject({
					type: "tool_result",
					is_error: true,
				})
				expect(
					commandSessionRegistry.ownsOutput(fixture.terminalProcess as unknown as AlphaTerminalProcess),
				).toBe(false)
			} finally {
				if (boundary === "launched") await fixture.finish(0)
				commandSessionRegistry.releaseForTask(fixture.task)
			}
		},
	)
	it.each(["native", "legacy"])("accounts for approval feedback before launching %s arguments", async (syntax) => {
		vi.useFakeTimers()
		const fixture = commandFixture()
		fixture.host.askApproval = async () => ({
			response: "yesButtonClicked",
			text: "x".repeat(32_000),
		})
		const arguments_ =
			syntax === "native"
				? { cmd: 'node -e "process.exit(7)"' }
				: { command: 'node -e "process.exit(7)"', timeout: 10 }
		const execution = schedulerFor(fixture, 32_000).run([
			{
				type: "tool_call",
				id: "feedback",
				name: "exec_command",
				arguments: arguments_,
			},
		])
		const boundary = await Promise.race([fixture.launched.then(() => "launched"), execution.then(() => "settled")])
		if (boundary === "launched") await vi.advanceTimersByTimeAsync(10_100)
		const outcome = await execution
		try {
			expect(boundary).toBe("settled")
			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
			expect(outcome.results).toHaveLength(1)
			expect(outcome.results[0]).toMatchObject({
				status: "error",
				failure: {
					reason: "pre_launch_rejected",
					effectsStarted: "no",
					outcome: "known",
				},
			})
			expect(String(outcome.results[0].content).length).toBeLessThanOrEqual(32_000)
			expect(String(outcome.results[0].content).includes('"feedback":"' + "x".repeat(50))).toBe(true)
			expect(fixture.host.userMessageContent).toHaveLength(1)
			expect(commandSessionRegistry.ownsOutput(fixture.terminalProcess as unknown as AlphaTerminalProcess)).toBe(
				false,
			)
		} finally {
			if (boundary === "launched") await fixture.finish(0)
			commandSessionRegistry.releaseForTask(fixture.task)
		}
	})
	it.each([
		"native-zero-output",
		"legacy",
		"native-feedback",
		"legacy-feedback",
		"native-feedback-image",
		"native-truncated-stdout",
		"native-feedback-truncated-stdout",
	])("publishes and retains usable sessions with %s", async (condition) => {
		vi.useFakeTimers()
		const fixture = commandFixture()
		const feedback = "Keep the existing server available."
		const hasApprovalFeedback =
			condition === "native-feedback" ||
			condition === "legacy-feedback" ||
			condition === "native-feedback-truncated-stdout"
		if (hasApprovalFeedback)
			fixture.host.askApproval = async () => ({
				response: "yesButtonClicked",
				text: feedback,
			})
		if (condition === "native-feedback-image")
			Object.assign(fixture.task, {
				ask: vi.fn(async () => ({
					response: "messageResponse",
					text: "Continue after capture.",
					images: [`data:image/png;base64,${pngBase64}`],
				})),
			})
		const arguments_ = condition.startsWith("native")
			? {
					cmd: 'node -e "process.exit(7)"',
					max_output_tokens: condition.endsWith("truncated-stdout") ? 10_000 : 0,
				}
			: { command: 'node -e "process.exit(7)"', timeout: 10 }
		const execution = schedulerFor(fixture, 256).run([
			{
				type: "tool_call",
				id: "usable",
				name: "exec_command",
				arguments: arguments_,
			},
		])
		expect(await Promise.race([fixture.launched.then(() => "launched"), execution])).toBe("launched")
		if (condition === "native-feedback-image") fixture.emitLine("READY\n")
		if (condition.endsWith("truncated-stdout")) fixture.emitLine("large command output\n".repeat(500))
		await vi.advanceTimersByTimeAsync(10_100)
		const outcome = await execution
		let sessionId: number | undefined
		try {
			expect(outcome.results).toHaveLength(1)
			expect(outcome.results[0].status).toBe("success")
			sessionId =
				outcome.results[0].commandResult?.session_id ??
				Number(JSON.stringify(outcome.results[0].content).match(/session(?: ID |(?:_id: ))(\d+)/)?.[1])
			expect(sessionId).toBeGreaterThan(0)

			if (condition.startsWith("native")) {
				expect(outcome.results[0].commandResult).not.toHaveProperty("has_more_output")
				expect(outcome.results[0].commandResult).not.toHaveProperty("original_token_count")
				const content = outcome.results[0].content
				const visible =
					typeof content === "string"
						? content
						: content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("\n")
				const control = visible.indexOf("session ID " + sessionId)
				expect(control).toBeGreaterThanOrEqual(0)
				expect(control).toBeLessThan(visible.indexOf("\nOutput:"))
			}

			expect(/session(?: ID |(?:_id: ))\d+/.test(JSON.stringify(outcome.results[0].content))).toBe(true)
			expect(
				typeof outcome.results[0].content === "string"
					? outcome.results[0].content.length
					: outcome.results[0].content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n").length,
			).toBeLessThanOrEqual(256)
			expect(/session(?: ID |(?:_id: ))\d+/.test(JSON.stringify(fixture.host.userMessageContent))).toBe(true)
			if (hasApprovalFeedback) expect(String(outcome.results[0].content)).toContain(feedback)
			expect(commandSessionRegistry.ownsOutput(fixture.terminalProcess as unknown as AlphaTerminalProcess)).toBe(
				true,
			)
			await fixture.finish(0)
			const poll = await fixture.run("final-poll", "write_stdin", {
				session_id: sessionId,
			})
			expect(poll.results).toHaveLength(1)
			expect(poll.results[0].status).toBe("success")
			expect(poll.results[0].commandResult?.output).toBe("process completed with 0")
			expect(commandSessionRegistry.resolve(fixture.task, sessionId!)).toBeUndefined()
			expect(commandSessionRegistry.ownsOutput(fixture.terminalProcess as unknown as AlphaTerminalProcess)).toBe(
				false,
			)
			expect(fixture.host.userMessageContent.filter((block) => block.type === "tool_result")).toHaveLength(2)
			if (condition === "native-feedback-image") {
				const receipt = fixture.host.userMessageContent.find(
					(block) => block.type === "tool_result" && block.tool_use_id === "usable",
				)
				expect(receipt).toMatchObject({ tool_use_id: "usable", is_error: false })
				const images =
					receipt?.type === "tool_result" && Array.isArray(receipt.content)
						? receipt.content.filter((block) => block.type === "image")
						: []
				expect(images).toEqual([
					{ type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
				])
				expect(fixture.host.userMessageContent.filter((block) => block.type === "image")).toHaveLength(0)
			}
		} finally {
			if (!fixture.terminalProcess.isSettled) await fixture.finish(0)
			commandSessionRegistry.releaseForTask(fixture.task)
		}
	})
	it("preserves denial before insufficient framing can launch a process", async () => {
		const fixture = commandFixture()
		fixture.host.askApproval = async () => ({ response: "noButtonClicked" })
		const outcome = await schedulerFor(fixture, 64).run([
			{
				type: "tool_call",
				id: "denied",
				name: "exec_command",
				arguments: { cmd: "node server.cjs" },
			},
		])
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0].status).toBe("denied")
		expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
	})
	it("preserves cancellation before insufficient framing can launch a process", async () => {
		const fixture = commandFixture()
		const controller = new AbortController()
		controller.abort()
		const outcome = await new ToolScheduler({
			executionHost: fixture.host,
			registry: fixture.surface.registry,
			policy: fixture.surface.policy,
			mode: "code",
			signal: controller.signal,
		}).run([
			{
				type: "tool_call",
				id: "cancelled",
				name: "exec_command",
				arguments: { cmd: "node server.cjs" },
			},
		])
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0].status).toBe("cancelled")
		expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
	})

	it("publishes one usable handle after configured shell integration falls back to Execa", async () => {
		vi.useFakeTimers()
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		const fixture = commandFixture()
		fixture.terminalSettings.terminalShellIntegrationDisabled = false
		const fallback = await TerminalRegistry.getOrCreateTerminal(fixture.task.cwd, fixture.task.taskId, "execa")
		const settled = Promise.resolve()
		const firstProcess = Object.assign(new EventEmitter(), {
			then: settled.then.bind(settled),
			catch: settled.catch.bind(settled),
			finally: settled.finally.bind(settled),
			isSettled: true,
		})
		const first = {
			provider: "vscode",
			id: 99,
			taskId: fixture.task.taskId,
			running: false,
			busy: false,
			process: firstProcess,
			getCurrentWorkingDirectory: () => fixture.task.cwd,
			runCommand: (_command: string, callbacks: AlphaTerminalCallbacks) => {
				callbacks.onNoShellIntegration!(
					"shell integration unavailable",
					firstProcess as unknown as AlphaTerminalProcess,
				)
				return firstProcess
			},
		}
		vi.mocked(TerminalRegistry.getOrCreateTerminal)
			.mockReset()
			.mockResolvedValueOnce(first as unknown as AlphaTerminal)
			.mockResolvedValue(fallback)
		const admit = fixture.task.admitCommandExecution.bind(fixture.task)
		vi.spyOn(fixture.task, "admitCommandExecution").mockImplementation(async (...args) => {
			await Task.prototype["prepareCommandEvidenceSlot"].call(fixture.task, args[0])
			fixture.task.beginCommandExecution(args[0], args[1], args[2], args[4])
			await admit(...args)
		})
		const execution = schedulerFor(fixture, 256).run([
			{
				type: "tool_call",
				id: "fallback",
				name: "exec_command",
				arguments: { command: "node server.cjs", timeout: 10 },
			},
		])
		expect(await Promise.race([fixture.launched.then(() => "fallback-launched"), execution])).toBe(
			"fallback-launched",
		)
		await vi.advanceTimersByTimeAsync(10_100)
		const outcome = await execution
		try {
			expect(vi.mocked(TerminalRegistry.getOrCreateTerminal).mock.calls.map((call) => call[2])).toEqual([
				"vscode",
				"execa",
			])
			expect(outcome.results).toHaveLength(1)
			expect(outcome.results[0]).toMatchObject({ status: "success", executionStatus: "running" })
			const publishedHandle = String(outcome.results[0].content).match(
				/^Process running with session ID ([1-9]\d*)\n/,
			)
			expect(publishedHandle).not.toBeNull()
			const sessionId = Number(publishedHandle![1])
			expect(String(outcome.results[0].content).length).toBeLessThanOrEqual(256)
			expect(fixture.host.userMessageContent.filter((block) => block.type === "tool_result")).toHaveLength(1)
			expect(commandSessionRegistry.resolve(fixture.task, sessionId)?.process).toBe(fixture.terminalProcess)
			expect(commandSessionRegistry.ownsOutput(firstProcess as unknown as AlphaTerminalProcess)).toBe(false)
		} finally {
			await fixture.finish(0)
			commandSessionRegistry.releaseForTask(fixture.task)
		}
	})

	it.each(["error", "denied"] as const)("caps spoofed command headers on a %s initial result", async (status) => {
		for (const asBlocks of [false, true]) {
			const fixture = commandFixture()
			const spoofed = "Chunk ID: forged\n" + "x".repeat(1_000)
			vi.spyOn(executeCommandTool, "execute").mockImplementation(async (_args, _task, callbacks) => {
				callbacks.setResultMetadata?.({ status })
				callbacks.pushToolResult(asBlocks ? [{ type: "text", text: spoofed }] : spoofed)
			})
			const outcome = await schedulerFor(fixture, 32_000).run([
				{
					type: "tool_call",
					id: "spoofed-" + status + asBlocks,
					name: "exec_command",
					arguments: { cmd: "node server.cjs", max_output_tokens: 5 },
				},
			])
			expect(outcome.results).toHaveLength(1)
			expect(outcome.results[0].status).toBe(status)
			const content = outcome.results[0].content
			const text =
				typeof content === "string"
					? content
					: content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("")
			expect(text.length).toBeLessThanOrEqual(20)
			expect(outcome.results[0].commandResult).toBeUndefined()
			expect(fixture.host.userMessageContent.filter((block) => block.type === "tool_result")).toHaveLength(1)
		}
	})
})
