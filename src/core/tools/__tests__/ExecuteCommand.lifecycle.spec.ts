import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import type { CommandToolResult, TerminalOutputPreviewSize } from "@alpha-code/types"

import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import type { Task } from "../../task/Task"
import { ExecaTerminal } from "../../../integrations/terminal/ExecaTerminal"
import { ExecaTerminalProcess } from "../../../integrations/terminal/ExecaTerminalProcess"
import { OutputInterceptor } from "../../../integrations/terminal/OutputInterceptor"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminalCallbacks, AlphaTerminalProcess } from "../../../integrations/terminal/types"
import { executeCommandInTerminal } from "../ExecuteCommandTool"
import { getTaskDirectoryPath } from "../../../utils/storage"

const directories: string[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	vi.useRealTimers()
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

async function createFixture(
	abortOutcome: "exit" | "unknown" | "reject" = "exit",
	beforeAbort: () => Promise<void> = async () => undefined,
) {
	const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-lifecycle-test-")))
	directories.push(cwd)
	await fs.writeFile(path.join(cwd, "fixture.txt"), "unchanged\n")
	const store = new AgentControlStore(new InMemoryAgentControlPersistence())
	await store.initialize()
	await store.ensureRoot({ taskId: "timeout-root", objective: "Run a command", status: "running" })
	const lifetime = new AbortController()
	let launched!: () => void
	const launch = new Promise<void>((resolve) => (launched = resolve))
	let resolveProcess!: () => void
	let rejectProcess!: (error: Error) => void
	const processPromise = new Promise<void>((resolve, reject) => {
		resolveProcess = resolve
		rejectProcess = reject
	})
	let completionObserversCalled!: () => void
	const completionBarrier = new Promise<void>((resolve) => (completionObserversCalled = resolve))
	let callbacks!: AlphaTerminalCallbacks
	const process = Object.assign(new EventEmitter(), {
		isSettled: false,
		then: processPromise.then.bind(processPromise),
		catch: processPromise.catch.bind(processPromise),
		finally: processPromise.finally.bind(processPromise),
		continue: vi.fn(),
		abort: vi.fn(async () => {
			if (!terminal.running) return
			await beforeAbort()
			if (abortOutcome === "reject") throw new Error("physical cleanup failed")
			if (abortOutcome === "exit") {
				terminal.running = false
				callbacks.onShellExecutionComplete(
					{ exitCode: 130, signalName: "SIGINT" },
					process as unknown as AlphaTerminalProcess,
				)
				process.emit("shell_execution_complete", { exitCode: 130, signalName: "SIGINT" })
			}
			await callbacks.onCompleted("stopped", process as unknown as AlphaTerminalProcess)
			process.isSettled = true
			terminal.busy = false
			terminal.running = false
			process.emit("completed", "stopped")
			resolveProcess()
		}),
	})
	const terminal = {
		provider: "execa",
		id: 1,
		taskId: "timeout-root",
		busy: true,
		running: true,
		process,
		getCurrentWorkingDirectory: () => cwd,
		runCommand: (_command: string, handlers: AlphaTerminalCallbacks) => {
			callbacks = handlers
			launched()
			return process
		},
	}
	vi.spyOn(TerminalRegistry, "getOrCreateTerminal").mockResolvedValue(terminal as never)
	vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([terminal as never])
	const provider = {
		postMessageToWebview: vi.fn(),
		getValue: vi.fn((_key: string): unknown => undefined),
		getState: vi.fn(async () => ({ terminalShellIntegrationDisabled: true })),
		reservePrimaryMutation: vi.fn(async (_task: Task, token: string) => {
			await store.reservePrimaryMutation("timeout-root", "timeout-root", cwd, token)
		}),
		releasePrimaryMutation: vi.fn(async (_task: Task, token: string, incomplete = false) => {
			await store.releasePrimaryMutation("timeout-root", "timeout-root", token, incomplete)
		}),
		recordPrimaryMutation: vi.fn(
			async (_task: Task, files: Record<string, string>, unresolved: boolean, token: string) => {
				return Boolean(
					await store.recordPrimaryMutation({
						rootTaskId: "timeout-root",
						parentTaskId: "timeout-root",
						workspacePath: cwd,
						fileVersions: files,
						scopeUnresolved: unresolved,
						reservationToken: token,
					}),
				)
			},
		),
	}
	const task = {
		cwd,
		taskId: "timeout-root",
		taskKind: "primary",
		abort: false,
		providerRef: { deref: () => provider },
		getTaskLifetimeCancellationSignal: () => lifetime.signal,
		say: vi.fn(async () => undefined),
		admitCommandExecution: vi.fn(async () => undefined),
		completeCommandExecution: vi.fn(),
		markCommandExecutionBackgrounded: vi.fn(),
		failCommandExecution: vi.fn(),
		supersedePendingAsk: vi.fn(),
		suspendAfterCurrentTurn: vi.fn(),
	} as unknown as Task
	return {
		cwd,
		task,
		process,
		terminal,
		store,
		provider,
		launch,
		completionBarrier,
		releaseProcess: resolveProcess,
		failReader: (error: Error) => {
			process.isSettled = true
			process.emit("error", error)
			rejectProcess(error)
		},
		reportArchiveOutput: (chunk: string) =>
			callbacks.onOutput?.(chunk, process as unknown as AlphaTerminalProcess, lifetime.signal),
		reportOutput: (line: string) => callbacks.onLine(line, process as unknown as AlphaTerminalProcess),
		reportShellIntegrationFailure: () =>
			callbacks.onNoShellIntegration?.("command output unavailable", process as unknown as AlphaTerminalProcess),
		finishProcess: async (joinObservers = false) => {
			terminal.running = false
			callbacks.onShellExecutionComplete({ exitCode: 0 }, process as unknown as AlphaTerminalProcess)
			process.emit("shell_execution_complete", { exitCode: 0 })
			await callbacks.onCompleted("finished", process as unknown as AlphaTerminalProcess)
			process.isSettled = true
			terminal.busy = false
			if (joinObservers) {
				const pending = process.rawListeners("completed").map((listener) => listener.call(process, "finished"))
				completionObserversCalled()
				await Promise.all(pending)
			} else {
				process.emit("completed", "finished")
			}
			resolveProcess()
		},
		reportShellExit: () => {
			terminal.running = false
			callbacks.onShellExecutionComplete({ exitCode: 0 }, process as unknown as AlphaTerminalProcess)
			process.emit("shell_execution_complete", { exitCode: 0 })
		},
	}
}

describe("command launch failure ownership", () => {
	it("joins the original archive and releases a proven prelaunch reservation", async () => {
		const fixture = await createFixture()
		const terminal = new ExecaTerminal(1, fixture.cwd)
		terminal.taskId = fixture.task.taskId
		vi.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValue(terminal)
		const spawn = vi.spyOn(ExecaTerminalProcess.prototype, "run").mockImplementation(() => {
			throw new Error("unexpected process launch")
		})
		Object.assign(fixture.provider, { context: { globalStorageUri: { fsPath: fixture.cwd } } })
		let archiveStarted!: () => void
		const archiveEntered = new Promise<void>((resolve) => (archiveStarted = resolve))
		let closeArchive!: () => void
		const archiveGate = new Promise<void>((resolve) => (closeArchive = resolve))
		const finalize = OutputInterceptor.prototype.finalize
		let archiveClosed = false
		vi.spyOn(OutputInterceptor.prototype, "finalize").mockImplementationOnce(async function (
			this: OutputInterceptor,
			signal,
		) {
			archiveStarted()
			await archiveGate
			const result = await finalize.call(this, signal)
			archiveClosed = true
			return result
		})
		const release = fixture.provider.releasePrimaryMutation.getMockImplementation()!
		fixture.provider.releasePrimaryMutation.mockImplementation((...args) => {
			expect(archiveClosed).toBe(true)
			return release(...args)
		})
		const creationFailure = new Error("archive owner rejected process creation")
		const onExecutionState = vi.fn()
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "creation-hook-failure",
			toolCallId: "creation-hook-call",
			command: "echo should-not-run",
			onExecutionState,
			onProcessCreated: () => {
				throw creationFailure
			},
		}).catch((error: unknown) => error)
		try {
			await archiveEntered
			expect(fixture.provider.reservePrimaryMutation).toHaveBeenCalledOnce()
			expect(fixture.provider.releasePrimaryMutation).not.toHaveBeenCalled()
		} finally {
			closeArchive()
			await execution
		}
		expect(await execution).toMatchObject({ phase: "launch-command", cause: creationFailure })
		expect(spawn).not.toHaveBeenCalled()
		expect(onExecutionState).toHaveBeenLastCalledWith("no")
		expect(fixture.provider.releasePrimaryMutation.mock.calls).toEqual(
			fixture.provider.reservePrimaryMutation.mock.calls,
		)
		expect(fixture.provider.recordPrimaryMutation).not.toHaveBeenCalled()
		expect(fixture.task.suspendAfterCurrentTurn).not.toHaveBeenCalled()
		expect(fixture.store.getVerificationObligations()).toEqual([])
	})

	it("retains unresolved mutation debt when the transport cannot prove non-submission", async () => {
		const fixture = await createFixture()
		const launchFailure = new Error("transport lost the launch response")
		vi.spyOn(fixture.terminal, "runCommand").mockImplementation(() => {
			throw launchFailure
		})
		const onExecutionState = vi.fn()
		await expect(
			executeCommandInTerminal(fixture.task, {
				executionId: "unknown-launch-failure",
				command: "command with an effect",
				onExecutionState,
			}),
		).rejects.toMatchObject({ phase: "launch-command", cause: launchFailure })
		expect(onExecutionState).toHaveBeenLastCalledWith("unknown")
		expect(fixture.provider.releasePrimaryMutation).not.toHaveBeenCalled()
		expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledExactlyOnceWith(
			fixture.task,
			{ __unobserved_command_scope__: expect.any(String) },
			true,
			expect.any(String),
		)
		expect(fixture.task.suspendAfterCurrentTurn).toHaveBeenCalledOnce()
	})
})

describe("primary command timeout mutation receipts", () => {
	it.each([false, true, undefined])(
		"preserves shell observation failure ownership (submitted: %s)",
		async (submitted) => {
			const fixture = await createFixture()
			Object.assign(fixture.process, { hasSubmittedCommand: submitted })
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
			const execution = executeCommandInTerminal(fixture.task, {
				executionId: "shell-observation-failure",
				toolCallId: "shell-observation-failure-call",
				command: "command with an effect",
				terminalShellIntegrationDisabled: false,
			}).catch((error: unknown) => error)
			await fixture.launch
			fixture.reportShellIntegrationFailure()
			fixture.releaseProcess()
			await vi.advanceTimersByTimeAsync(100)
			expect(await execution).toMatchObject({
				commandNotSubmitted: submitted === false,
				outcomeKnown: submitted === false,
			})
			if (submitted === false) {
				expect(fixture.provider.releasePrimaryMutation).toHaveBeenCalledOnce()
				expect(fixture.provider.recordPrimaryMutation).not.toHaveBeenCalled()
				expect(fixture.task.suspendAfterCurrentTurn).not.toHaveBeenCalled()
			} else {
				expect(fixture.provider.releasePrimaryMutation).not.toHaveBeenCalled()
				expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledExactlyOnceWith(
					fixture.task,
					expect.objectContaining({ __unobserved_command_scope__: expect.any(String) }),
					true,
					expect.any(String),
				)
				expect(fixture.task.suspendAfterCurrentTurn).toHaveBeenCalledOnce()
			}
		},
	)

	it("publishes bounded background progress without consuming session output or reopening a user ask", async () => {
		const fixture = await createFixture()
		vi.useFakeTimers()
		let preview = ""
		const getOutputPreview = vi.fn(() => preview)
		const captureUnretrievedOutput = vi.fn()
		Object.assign(fixture.process, { getOutputPreview, captureUnretrievedOutput })
		fixture.task.ask = vi.fn()
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "background-progress",
			command: "command",
			agentTimeout: 1_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		fixture.provider.postMessageToWebview.mockClear()
		for (let index = 0; index < 100; index++) {
			preview = `progress ${index}`
			fixture.process.emit("output_available")
		}
		await vi.advanceTimersByTimeAsync(150)
		const progress = fixture.provider.postMessageToWebview.mock.calls
			.map(([message]) => message)
			.filter((message) => message.type === "commandExecutionStatus")
		expect(progress).toHaveLength(1)
		expect(JSON.parse(progress[0].text)).toMatchObject({ status: "output", output: "progress 99" })
		expect(getOutputPreview).toHaveBeenCalledOnce()
		expect(captureUnretrievedOutput).not.toHaveBeenCalled()
		expect(fixture.task.ask).not.toHaveBeenCalled()
		await fixture.finishProcess()
		expect(fixture.process.listenerCount("output_available")).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("finishes archival and terminal evidence while background UI publication is blocked", async () => {
		const fixture = await createFixture()
		vi.useFakeTimers()
		const getOutputPreview = vi.fn(() => "background progress")
		Object.assign(fixture.process, { getOutputPreview })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "blocked-background-progress",
			toolCallId: "blocked-progress-call",
			command: "command",
			agentTimeout: 1_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		let releaseUi!: () => void
		const blockedUi = new Promise<void>((resolve) => (releaseUi = resolve))
		fixture.provider.postMessageToWebview.mockImplementation((message: { text?: string }) =>
			message.text?.includes("background progress") ? blockedUi : undefined,
		)
		const evidencePublished = new Promise<void>((resolve) => {
			vi.mocked(fixture.task.completeCommandExecution).mockImplementation(() => resolve())
		})
		try {
			fixture.process.emit("output_available")
			await vi.advanceTimersByTimeAsync(150)
			for (let index = 0; index < 1_000; index++) fixture.process.emit("output_available")
			await vi.advanceTimersByTimeAsync(1_500)
			expect(getOutputPreview).toHaveBeenCalledOnce()
			await fixture.finishProcess()
			await evidencePublished
			expect(fixture.task.completeCommandExecution).toHaveBeenCalledOnce()
			expect(fixture.process.listenerCount("output_available")).toBe(0)
			const messageCount = vi.mocked(fixture.task.say).mock.calls.length
			releaseUi()
			await vi.advanceTimersByTimeAsync(0)
			expect(vi.mocked(fixture.task.say).mock.calls).toHaveLength(messageCount)
		} finally {
			releaseUi()
			fixture.releaseProcess()
		}
	})

	it.each(["explore", "review"] as const)(
		"records an inherited-permission %s's shared-workspace command changes",
		async (role) => {
			const fixture = await createFixture()
			Object.assign(fixture.task, {
				taskKind: "subagent",
				subagentRole: role,
				subagentContextManifest: { runtimePolicy: { authorityModel: "parent", execute: true, mutate: true } },
			})
			const execution = executeCommandInTerminal(fixture.task, {
				executionId: "shared-command",
				toolCallId: "shared-command-call",
				command: "command",
				terminalShellIntegrationDisabled: true,
			})
			try {
				await fixture.launch
				await fs.writeFile(path.join(fixture.cwd, "fixture.txt"), "changed by managed child\n")
				await fixture.finishProcess()
				await execution
				expect(fixture.provider.reservePrimaryMutation).toHaveBeenCalledOnce()
				expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledOnce()
				expect(fixture.store.getVerificationObligations()[0]).toMatchObject({
					changedFiles: ["fixture.txt"],
					mutationReservations: [],
				})
			} finally {
				if (!fixture.process.isSettled) await fixture.finishProcess()
				await execution.catch(() => undefined)
			}
		},
	)

	it.each<{
		savedPreview: TerminalOutputPreviewSize | undefined
		outputBytes: number
		spills: boolean
	}>([
		{ savedPreview: "small", outputBytes: 6 * 1024, spills: false },
		{ savedPreview: "small", outputBytes: 12 * 1024, spills: true },
		{ savedPreview: "large", outputBytes: 6 * 1024, spills: false },
		{ savedPreview: "large", outputBytes: 12 * 1024, spills: true },
		{ savedPreview: undefined, outputBytes: 6 * 1024, spills: false },
		{ savedPreview: undefined, outputBytes: 12 * 1024, spills: true },
	])(
		"keeps the standard 10 KB preview for $outputBytes bytes with legacy saved size $savedPreview",
		async ({ savedPreview, outputBytes, spills }) => {
			const fixture = await createFixture()
			const storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-preview-test-"))
			directories.push(storage)
			Object.assign(fixture.provider, { context: { globalStorageUri: { fsPath: storage } } })
			fixture.provider.getValue.mockImplementation((key) =>
				key === "terminalOutputPreviewSize" ? savedPreview : undefined,
			)
			const onCommandResult = vi.fn<(result: CommandToolResult) => void>()
			const output = "HEAD\n" + "x".repeat(outputBytes - 10) + "\nTAIL"
			const execution = executeCommandInTerminal(fixture.task, {
				executionId: "standard-preview",
				toolCallId: "standard-preview-call",
				command: "command",
				terminalShellIntegrationDisabled: true,
				onCommandResult,
			})
			try {
				await fixture.launch
				await fixture.reportArchiveOutput(output)
				await fixture.finishProcess()
				await execution
				expect(fixture.provider.getState).not.toHaveBeenCalled()
				expect(onCommandResult).toHaveBeenCalledOnce()
				const result = onCommandResult.mock.calls[0]?.[0]
				if (spills) {
					if (!result?.artifact_id) throw new Error("Missing full command-output artifact")
					expect(result.output).toMatch(/^HEAD\n/)
					expect(result.output).toContain("[...2048 bytes omitted...]")
					expect(result.output).toMatch(/\nTAIL$/)
					const taskDirectory = await getTaskDirectoryPath(storage, fixture.task.taskId)
					expect(
						await fs.readFile(path.join(taskDirectory, "command-output", result.artifact_id), "utf8"),
					).toBe(output)
				} else {
					expect(result?.artifact_id).toBeUndefined()
					expect("outputArtifactId" in fixture.process).toBe(false)
				}
			} finally {
				if (!fixture.process.isSettled) await fixture.finishProcess()
				await execution.catch(() => undefined)
			}
		},
	)

	it("completes an exited thenable process before the foreground yield timer", async () => {
		const fixture = await createFixture()
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "early-exit",
			toolCallId: "early-exit-call",
			command: "command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 10_000,
			commandExecutionTimeout: 0,
		})
		await fixture.launch
		let completionSettled = false
		const completion = fixture.finishProcess(true).then(() => {
			completionSettled = true
		})
		try {
			await fixture.completionBarrier
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(completionSettled).toBe(true)
			await completion
			expect(await execution).toEqual([false, expect.stringContaining("Exit code: 0")])
			expect(fixture.task.completeCommandExecution).toHaveBeenCalledOnce()
			expect(fixture.process.continue).not.toHaveBeenCalled()
		} finally {
			fixture.releaseProcess()
			await completion
			await execution
		}
	})

	it("finishes command output bookkeeping without waiting for the held user question", async () => {
		const fixture = await createFixture()
		let resolveQuestion!: (answer: Awaited<ReturnType<Task["ask"]>>) => void
		const question = new Promise<Awaited<ReturnType<Task["ask"]>>>((resolve) => (resolveQuestion = resolve))
		fixture.task.ask = vi.fn(() => question)
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "held-question",
			toolCallId: "held-question-call",
			command: "command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 0,
			commandExecutionTimeout: 0,
		})
		let outputSettled = false
		try {
			await fixture.launch
			const outputCompletion = Promise.resolve(fixture.reportOutput("ready\n")).then(() => {
				outputSettled = true
			})
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(fixture.task.ask).toHaveBeenCalledExactlyOnceWith("command_output", "")
			expect(outputSettled).toBe(true)
			await fixture.finishProcess()
			await outputCompletion
			expect(await execution).toEqual([false, expect.stringContaining("Exit code: 0")])
			expect(fixture.task.completeCommandExecution).toHaveBeenCalledOnce()
			expect(fixture.task.failCommandExecution).not.toHaveBeenCalled()
		} finally {
			resolveQuestion({ response: "yesButtonClicked" })
			if (!fixture.process.isSettled) await fixture.finishProcess()
			await execution.catch(() => undefined)
		}
	})

	it("settles output ownership once when a yielded command's terminal closes after shell exit", async () => {
		const fixture = await createFixture()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "closed-output",
			toolCallId: "closed-output-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
			commandExecutionTimeout: 0,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		fixture.reportShellExit()
		fixture.process.isSettled = true
		fixture.process.emit("error", new Error("terminal output reader closed"))
		await vi.advanceTimersByTimeAsync(0)
		await vi.waitFor(() => expect(fixture.provider.releasePrimaryMutation).toHaveBeenCalledOnce())
		await vi.advanceTimersByTimeAsync(0)
		expect(fixture.task.failCommandExecution).toHaveBeenCalledExactlyOnceWith(
			"closed-output-call",
			"failed",
			expect.stringMatching(/^closed-output:/),
		)
		expect(fixture.task.completeCommandExecution).not.toHaveBeenCalled()
		expect(fixture.task.suspendAfterCurrentTurn).toHaveBeenCalledOnce()
		expect(
			fixture.store.getVerificationObligations().flatMap((obligation) => obligation.mutationReservations),
		).toEqual([])
	})

	it("preserves unresolved mutation debt when a yielded command loses its terminal", async () => {
		const fixture = await createFixture()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "closed-background",
			toolCallId: "closed-background-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
			commandExecutionTimeout: 0,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		fixture.process.on("error", () => {})
		fixture.process.isSettled = true
		fixture.process.emit("error", new Error("command terminal closed"))
		await vi.advanceTimersByTimeAsync(0)
		expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledOnce()
		expect(fixture.store.getVerificationObligations()[0]?.mutationReservations).toEqual([])
		expect(fixture.store.getParentCompletionDecision("timeout-root").allowed).toBe(false)
		expect(fixture.task.failCommandExecution).toHaveBeenCalledExactlyOnceWith(
			"closed-background-call",
			"failed",
			expect.stringMatching(/^closed-background:/),
		)
		fixture.reportShellExit()
		await vi.advanceTimersByTimeAsync(0)
		expect(fixture.task.completeCommandExecution).not.toHaveBeenCalled()
		expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledOnce()
	})

	it("settles the physical reservation when the hard timeout fires after the command yielded", async () => {
		const fixture = await createFixture()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "background-timeout",
			toolCallId: "background-timeout-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
			commandExecutionTimeout: 2_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		expect(fixture.process.abort).not.toHaveBeenCalled()
		expect(fixture.store.getVerificationObligations()[0]?.mutationReservations).toHaveLength(1)
		try {
			await vi.advanceTimersByTimeAsync(1_000)
			expect(fixture.process.abort).toHaveBeenCalledOnce()
			expect(fixture.task.failCommandExecution).toHaveBeenCalledWith(
				"background-timeout-call",
				"timed_out",
				expect.stringMatching(/^background-timeout:/),
			)
			await vi.waitFor(() =>
				expect(
					fixture.store.getVerificationObligations().flatMap((item) => item.mutationReservations ?? []),
					"The exited background command must publish its final no-op receipt",
				).toEqual([]),
			)
		} finally {
			await fixture.process.abort()
		}
	})

	it.each(["before", "after"] as const)(
		"keeps the hard timeout when the output reader fails %s yielding",
		async (readerFailureTime) => {
			const fixture = await createFixture()
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
			const execution = executeCommandInTerminal(fixture.task, {
				executionId: "reader-failure",
				toolCallId: "reader-failure-call",
				command: "long-running-command",
				terminalShellIntegrationDisabled: true,
				agentTimeout: 1_000,
				commandExecutionTimeout: 2_000,
			}).catch((error: unknown) => error)
			try {
				await fixture.launch
				if (readerFailureTime === "after") {
					await vi.advanceTimersByTimeAsync(1_100)
					await execution
				}
				fixture.failReader(new Error("output reader failed while shell is running"))
				await execution
				await vi.waitFor(() => expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledOnce())
				expect(fixture.terminal.running).toBe(true)
				expect(fixture.process.abort).not.toHaveBeenCalled()
				const shellListeners = fixture.process.listenerCount("shell_execution_complete")
				const closeListeners = fixture.process.listenerCount("terminal_closed")
				await vi.advanceTimersByTimeAsync(2_000)
				expect(fixture.process.abort).toHaveBeenCalledOnce()
				expect(fixture.terminal.running).toBe(false)
				expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledOnce()
				expect(fixture.task.completeCommandExecution).not.toHaveBeenCalled()
				expect(fixture.process.listenerCount("shell_execution_complete")).toBe(shellListeners - 1)
				expect(fixture.process.listenerCount("terminal_closed")).toBe(closeListeners - 1)
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				if (fixture.terminal.running) await fixture.process.abort()
				await execution
			}
		},
	)

	it.each(["shell exit", "terminal close"] as const)(
		"clears a failed reader's hard timeout on physical %s",
		async (completion) => {
			const fixture = await createFixture()
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
			const execution = executeCommandInTerminal(fixture.task, {
				executionId: "reader-completion",
				toolCallId: "reader-completion-call",
				command: "long-running-command",
				terminalShellIntegrationDisabled: true,
				agentTimeout: 1_000,
				commandExecutionTimeout: 2_000,
			}).catch((error: unknown) => error)
			await fixture.launch
			fixture.failReader(new Error("output reader failed"))
			await execution
			if (completion === "shell exit") fixture.reportShellExit()
			else {
				fixture.terminal.running = false
				fixture.process.emit("terminal_closed")
			}
			await vi.advanceTimersByTimeAsync(3_000)
			expect(fixture.process.abort).not.toHaveBeenCalled()
			expect(fixture.process.listenerCount("shell_execution_complete")).toBe(0)
			expect(fixture.process.listenerCount("terminal_closed")).toBe(0)
		},
	)

	it("keeps late output and file changes on the command's captured turn", async () => {
		const fixture = await createFixture()
		let acknowledgeCompletion!: () => void
		const completion = new Promise<void>((resolve) => (acknowledgeCompletion = resolve))
		vi.mocked(fixture.task.completeCommandExecution).mockImplementation(() => acknowledgeCompletion())
		let acknowledgeFileChanges!: () => void
		const fileChanges = new Promise<void>((resolve) => (acknowledgeFileChanges = resolve))
		vi.mocked(fixture.task.say).mockImplementation(async (type, text) => {
			if (type === "tool" && text?.includes("appliedDiff")) acknowledgeFileChanges()
		})
		let turn = { runId: "original-run", turnId: "original-turn" }
		fixture.task.captureMessageTurn = vi.fn(() => ({ ...turn }))
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "captured-turn",
			toolCallId: "captured-turn-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		turn = { runId: "later-run", turnId: "later-turn" }
		await fs.writeFile(path.join(fixture.cwd, "fixture.txt"), "changed\n")
		fixture.reportOutput("late output")
		await fixture.finishProcess()
		await Promise.all([completion, fileChanges])
		expect(fixture.task.completeCommandExecution).toHaveBeenCalledOnce()
		expect(fixture.task.captureMessageTurn).toHaveBeenCalledOnce()
		const calls = vi
			.mocked(fixture.task.say)
			.mock.calls.filter(([type]) => type === "command_output" || type === "tool")
		expect(calls.length).toBeGreaterThan(1)
		for (const call of calls)
			expect(call[6]).toMatchObject({ turn: { runId: "original-run", turnId: "original-turn" } })
	})

	it("keeps a background timeout notice on the command's captured turn", async () => {
		const fixture = await createFixture()
		let turn = { runId: "original-run", turnId: "original-turn" }
		fixture.task.captureMessageTurn = vi.fn(() => ({ ...turn }))
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "captured-timeout-turn",
			toolCallId: "captured-timeout-turn-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
			commandExecutionTimeout: 2_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		turn = { runId: "later-run", turnId: "later-turn" }
		await vi.advanceTimersByTimeAsync(1_000)
		const notices = vi.mocked(fixture.task.say).mock.calls.filter(([type]) => type === "error")
		expect(notices).toHaveLength(1)
		expect(notices[0][6]).toEqual({ turn: { runId: "original-run", turnId: "original-turn" } })
		expect(fixture.task.captureMessageTurn).toHaveBeenCalledOnce()
	})

	it("settles the same no-op receipt when the hard timeout occurs before foreground return", async () => {
		const fixture = await createFixture()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "foreground-timeout",
			toolCallId: "foreground-timeout-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 2_000,
			commandExecutionTimeout: 1_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		expect(fixture.process.abort).toHaveBeenCalledOnce()
		expect(fixture.provider.releasePrimaryMutation).toHaveBeenCalledOnce()
		expect(fixture.store.getVerificationObligations().flatMap((item) => item.mutationReservations ?? [])).toEqual(
			[],
		)
		expect(fixture.store.getParentCompletionDecision("timeout-root").allowed).toBe(true)
	})

	it("retains the reservation until timeout cleanup physically settles", async () => {
		let finishAbort!: () => void
		const abortBarrier = new Promise<void>((resolve) => (finishAbort = resolve))
		const fixture = await createFixture("exit", () => abortBarrier)
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "pending-cleanup",
			toolCallId: "pending-cleanup-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
			commandExecutionTimeout: 2_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		await vi.advanceTimersByTimeAsync(1_000)
		expect(fixture.process.abort).toHaveBeenCalledOnce()
		expect(fixture.provider.releasePrimaryMutation).not.toHaveBeenCalled()
		expect(fixture.store.getVerificationObligations()[0]?.mutationReservations).toHaveLength(1)
		expect(fixture.task.completeCommandExecution).not.toHaveBeenCalled()
		finishAbort()
		await vi.waitFor(() =>
			expect(
				fixture.store.getVerificationObligations().flatMap((item) => item.mutationReservations ?? []),
			).toEqual([]),
		)
	})

	it("retains unresolved ownership when a background timeout receipt cannot be persisted", async () => {
		const fixture = await createFixture()
		fixture.provider.releasePrimaryMutation.mockRejectedValueOnce(new Error("receipt storage unavailable"))
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "failed-receipt",
			toolCallId: "failed-receipt-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
			commandExecutionTimeout: 2_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		await vi.advanceTimersByTimeAsync(1_000)
		await vi.waitFor(() => expect(fixture.task.suspendAfterCurrentTurn).toHaveBeenCalledOnce())
		expect(fixture.provider.releasePrimaryMutation).toHaveBeenCalledOnce()
		expect(fixture.store.getVerificationObligations()[0]?.mutationReservations).toHaveLength(1)
		expect(fixture.store.getParentCompletionDecision("timeout-root").allowed).toBe(false)
		expect(fixture.task.completeCommandExecution).not.toHaveBeenCalled()
	})

	it("records a changed workspace exactly once after the background hard timeout", async () => {
		const fixture = await createFixture()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "changed-timeout",
			toolCallId: "changed-timeout-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
			commandExecutionTimeout: 2_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		await fs.writeFile(path.join(fixture.cwd, "fixture.txt"), "changed by command\n")
		await vi.advanceTimersByTimeAsync(1_000)
		await vi.waitFor(() => expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledOnce())
		expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledWith(
			fixture.task,
			expect.objectContaining({ "fixture.txt": expect.any(String) }),
			false,
			expect.stringMatching(/^changed-timeout:/),
		)
		expect(fixture.task.completeCommandExecution).not.toHaveBeenCalled()
		expect(fixture.store.getVerificationObligations()[0]?.mutationReservations).toEqual([])
		expect(fixture.store.getVerificationObligations()[0]?.changedFiles).toContain("fixture.txt")
	})

	it.each(["unknown", "reject"] as const)(
		"persists unresolved debt after a background timeout with %s process outcome",
		async (abortOutcome) => {
			const fixture = await createFixture(abortOutcome)
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
			const execution = executeCommandInTerminal(fixture.task, {
				executionId: "unknown-timeout",
				toolCallId: "unknown-timeout-call",
				command: "long-running-command",
				terminalShellIntegrationDisabled: true,
				agentTimeout: 1_000,
				commandExecutionTimeout: 2_000,
			})
			await fixture.launch
			await vi.advanceTimersByTimeAsync(1_100)
			await execution
			await vi.advanceTimersByTimeAsync(1_000)
			if (abortOutcome === "unknown") {
				// An adapter's successful abort return is not physical-exit evidence.
				expect(fixture.provider.recordPrimaryMutation).not.toHaveBeenCalled()
				expect(fixture.store.getVerificationObligations()[0]?.mutationReservations).toHaveLength(1)
				await vi.advanceTimersByTimeAsync(11_000)
			}
			await vi.waitFor(() => expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledOnce())
			expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledWith(
				fixture.task,
				expect.objectContaining({
					__unobserved_command_scope__: expect.stringMatching(/^unknown-timeout:/),
				}),
				true,
				expect.stringMatching(/^unknown-timeout:/),
			)
			expect(fixture.store.getVerificationObligations()[0]?.mutationReservations).toEqual([])
			expect(fixture.store.getParentCompletionDecision("timeout-root").allowed).toBe(false)
			expect(fixture.task.completeCommandExecution).not.toHaveBeenCalled()
		},
	)

	it("starts physical cleanup even when timeout projection fails", async () => {
		const fixture = await createFixture()
		const projectionFailure = new Error("lifecycle projection unavailable")
		const diagnostics = vi.spyOn(console, "error")
		vi.mocked(fixture.task.failCommandExecution).mockImplementationOnce(() => {
			throw projectionFailure
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "projection-timeout",
			toolCallId: "projection-timeout-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
			commandExecutionTimeout: 2_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		await vi.advanceTimersByTimeAsync(1_000)
		await vi.waitFor(() => expect(fixture.provider.releasePrimaryMutation).toHaveBeenCalledOnce())
		expect(fixture.process.abort).toHaveBeenCalledOnce()
		expect(fixture.store.getVerificationObligations().flatMap((item) => item.mutationReservations ?? [])).toEqual(
			[],
		)
		expect(diagnostics).toHaveBeenCalledExactlyOnceWith("Failed to project a command timeout:", projectionFailure)
		expect(fixture.task.failCommandExecution).toHaveBeenCalledExactlyOnceWith(
			"projection-timeout-call",
			"timed_out",
			expect.stringMatching(/^projection-timeout:/),
		)
		expect(fixture.process.isSettled).toBe(true)
		expect(fixture.task.completeCommandExecution).not.toHaveBeenCalled()
		expect(fixture.task.say).toHaveBeenCalledWith(
			"error",
			expect.any(String),
			undefined,
			undefined,
			undefined,
			undefined,
			{
				turn: null,
			},
		)
	})

	it.each(["cancelled", "denied"] as const)(
		"propagates the original %s evidence failure before acquiring a terminal",
		async (status) => {
			const fixture = await createFixture()
			const projectionFailure = new Error(`early ${status} projection unavailable`)
			fixture.task.abort = status === "cancelled"
			vi.mocked(fixture.task.failCommandExecution).mockImplementation(() => {
				throw projectionFailure
			})
			await expect(
				executeCommandInTerminal(fixture.task, {
					executionId: "early-projection",
					toolCallId: "early-projection-call",
					command: "command",
					tty: status === "denied" ? true : undefined,
					capturedExecutionMode: status === "denied" ? "architect" : "code",
				}),
			).rejects.toBe(projectionFailure)
			expect(fixture.task.failCommandExecution).toHaveBeenCalledExactlyOnceWith("early-projection-call", status)
			expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
			expect(fixture.provider.reservePrimaryMutation).not.toHaveBeenCalled()
			expect(fixture.process.abort).not.toHaveBeenCalled()
			expect(fixture.task.completeCommandExecution).not.toHaveBeenCalled()
		},
	)

	it("preserves an outside-workspace denial when its evidence projection throws the original error", async () => {
		const fixture = await createFixture()
		const projectionFailure = new Error("outside-workspace projection unavailable")
		const failures = vi.fn()
		vi.mocked(fixture.task.failCommandExecution).mockImplementationOnce(() => {
			throw projectionFailure
		})
		await expect(
			executeCommandInTerminal(fixture.task, {
				executionId: "outside-projection",
				toolCallId: "outside-projection-call",
				command: "command",
				customCwd: "..",
				capturedExecutionMode: "architect",
				onFailure: failures,
			}),
		).rejects.toBe(projectionFailure)
		expect(failures).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				reason: "policy_denied",
				effectsStarted: "no",
				outcome: "known",
				recovery: { kind: "user-action" },
			}),
		)
		expect(fixture.task.failCommandExecution).toHaveBeenCalledExactlyOnceWith("outside-projection-call")
		expect(TerminalRegistry.getOrCreateTerminal).not.toHaveBeenCalled()
		expect(fixture.provider.reservePrimaryMutation).not.toHaveBeenCalled()
		expect(fixture.process.abort).not.toHaveBeenCalled()
	})

	it("observes the original background bookkeeping projection error after physical mutation cleanup settles", async () => {
		const fixture = await createFixture()
		const projectionFailure = new Error("background bookkeeping projection unavailable")
		const diagnostics = vi.spyOn(console, "error")
		let projectionAttempted!: () => void
		const projectionAttempt = new Promise<void>((resolve) => (projectionAttempted = resolve))
		vi.mocked(fixture.task.failCommandExecution).mockImplementationOnce(() => {
			projectionAttempted()
			throw projectionFailure
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "background-projection",
			toolCallId: "background-projection-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
			commandExecutionTimeout: 0,
		})
		try {
			await fixture.launch
			await vi.advanceTimersByTimeAsync(1_100)
			await execution
			fixture.reportShellExit()
			// This is the collector's missing-completion timer, not a delay for log delivery.
			await vi.advanceTimersByTimeAsync(0)
			await projectionAttempt
			await vi.advanceTimersByTimeAsync(0)
			await vi.waitFor(() => expect(fixture.provider.releasePrimaryMutation).toHaveBeenCalledOnce())
			expect(diagnostics).toHaveBeenCalledExactlyOnceWith(
				"[ExecuteCommandTool] Failed to preserve background output bookkeeping failure",
				projectionFailure,
			)
			expect(fixture.task.failCommandExecution).toHaveBeenCalledExactlyOnceWith(
				"background-projection-call",
				"failed",
				expect.stringMatching(/^background-projection:/),
			)
			expect(fixture.task.completeCommandExecution).not.toHaveBeenCalled()
			expect(fixture.process.abort).not.toHaveBeenCalled()
			expect(
				fixture.store.getVerificationObligations().flatMap((item) => item.mutationReservations ?? []),
			).toEqual([])
		} finally {
			fixture.releaseProcess()
			await execution
		}
	})
})
