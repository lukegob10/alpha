import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ExecaError } from "execa"
import type { AlphaAsk, AlphaMessage } from "@alpha-code/types"

import { Task, type CommandExecutionEvidence } from "../../task/Task"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { ToolScheduler, type ToolExecutionHost, type ToolSchedulerOutcome } from "../../agent/ToolScheduler"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { createTaskToolSurface } from "../TaskToolSurface"
import { commandSessionRegistry } from "../CommandSessionRegistry"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { BaseTerminal } from "../../../integrations/terminal/BaseTerminal"
import { BaseTerminalProcess } from "../../../integrations/terminal/BaseTerminalProcess"
import { mergePromise } from "../../../integrations/terminal/mergePromise"
import { getRipgrepPathOverlay } from "../../../integrations/terminal/ripgrepEnvironment"
import type { AlphaTerminalCallbacks } from "../../../integrations/terminal/types"
import { AlphaIgnoreController } from "../../ignore/AlphaIgnoreController"
import { AlphaProtectedController } from "../../protect/AlphaProtectedController"

const platform = vi.hoisted(() => ({ launch: vi.fn(), resolveRipgrep: vi.fn() }))
vi.mock("execa", () => ({ execa: platform.launch, ExecaError: class extends Error {} }))
vi.mock("../../../services/ripgrep", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../services/ripgrep")>()),
	resolveRipgrepBinary: platform.resolveRipgrep,
}))
vi.mock("vscode", async (importOriginal) => ({
	...(await importOriginal<typeof import("vscode")>()),
	RelativePattern: class {
		constructor(
			readonly base: string,
			readonly pattern: string,
		) {}
	},
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

/** Only the child transport is synthetic. The collector, archive, session and Task evidence owners are real. */
function controlledChild() {
	type Record =
		| { kind: "chunk"; text: string; accepted: ReturnType<typeof deferred<void>> }
		| { kind: "error"; error: Error }
		| { kind: "end" }
	const records: Record[] = []
	const readers: Array<(record: Record) => void> = []
	const started = deferred<void>()
	const readerClosed = deferred<void>()
	const settlement = deferred<{ exitCode: number; signal?: string }>()
	let settled = false
	const send = (record: Record) => {
		const reader = readers.shift()
		if (reader) reader(record)
		else records.push(record)
	}
	const child = Object.assign(settlement.promise, {
		// No PID: these tests never stand in for an operating-system cancellation proof.
		all: new EventEmitter(),
		iterable: () =>
			(async function* () {
				started.resolve()
				try {
					while (true) {
						const record =
							records.shift() ?? (await new Promise<Record>((resolve) => readers.push(resolve)))
						if (record.kind === "end") return
						if (record.kind === "error") throw record.error
						yield record.text
						// The next pull follows the real raw writer and line observer joins.
						record.accepted.resolve()
					}
				} finally {
					readerClosed.resolve()
				}
			})(),
		kill: vi.fn(),
	})
	return {
		child,
		started: started.promise,
		readerClosed: readerClosed.promise,
		write(text: string) {
			const accepted = deferred<void>()
			send({ kind: "chunk", text, accepted })
			return accepted.promise
		},
		failOutput(error: Error) {
			send({ kind: "error", error })
		},
		finish(exitCode = 0, signal?: string) {
			if (settled) return
			settled = true
			send({ kind: "end" })
			if (exitCode === 0 && !signal) settlement.resolve({ exitCode })
			else settlement.reject(Object.assign(new ExecaError(), { exitCode, signal }))
		},
	}
}

/** GREEN-only platform owner retaining line delivery after yield; it is not an OS-process fixture. */
class HeldOwnerProcess extends BaseTerminalProcess {
	abortCalls = 0
	readonly started = deferred<void>()
	readonly abortObserved = deferred<void>()
	readonly physicalEnd = deferred<void>()
	readonly physicalObserved = deferred<void>()
	readonly archiveRelease = deferred<void>()
	readonly archiveClosed = deferred<void>()
	readonly readerFailure = deferred<Error>()
	readonly readerFailureEmitted = deferred<void>()

	constructor(
		readonly terminal: HeldOwnerTerminal,
		readonly abortReason: unknown,
		readonly scenario: { failReader?: boolean; abortSucceeds?: boolean } = {},
	) {
		super()
	}

	async run(command: string): Promise<void> {
		this.command = command
		this.terminal.setActiveStream((async function* () {})())
		await this.write("1:needle owned observer\n")
		this.started.resolve()
		if (this.scenario.failReader) {
			const error = await this.readerFailure.promise
			this.outputArchiveInterrupted = true
			this.emit("error", error)
			this.readerFailureEmitted.resolve()
		}
		await this.physicalEnd.promise
		this.terminal.shellExecutionComplete({ exitCode: 137, signalName: "SIGKILL" })
		this.physicalObserved.resolve()
		try {
			if (!this.scenario.failReader) await this.emitCompletedAndWait(this.getOutputTranscript())
		} finally {
			await this.finalizeOutput()
			this.continue()
		}
	}

	async write(text: string): Promise<void> {
		await this.appendOutput(text)
		this.emit("line", text)
	}

	continue(): void {
		this.emit("continue")
	}
	abort(): Promise<void> {
		this.abortCalls += 1
		this.abortObserved.resolve()
		if (this.scenario.abortSucceeds) return this.physicalObserved.promise
		return Promise.reject(this.abortReason)
	}
	hasUnretrievedOutput(): boolean {
		return this.lastRetrievedIndex < this.fullOutput.length
	}
	protected getUnretrievedOutputRange(maxCharacters: number): { endIndex: number; output: string } {
		const endIndex = this.safeOutputRangeEnd(
			Math.min(this.fullOutput.length, this.lastRetrievedIndex + maxCharacters),
		)
		return { endIndex, output: this.fullOutput.slice(this.lastRetrievedIndex, endIndex) }
	}
}

class HeldOwnerTerminal extends BaseTerminal {
	readonly ownedProcess: HeldOwnerProcess
	runCalls = 0
	runCompletion: Promise<void> = Promise.resolve()

	constructor(
		cwd: string,
		readonly commandEnv: Record<string, string>,
		abortReason: unknown,
		scenario: { failReader?: boolean; abortSucceeds?: boolean } = {},
	) {
		super("execa", 92, cwd)
		this.ownedProcess = new HeldOwnerProcess(this, abortReason, scenario)
	}
	isClosed(): boolean {
		return false
	}
	runCommand(command: string, callbacks: AlphaTerminalCallbacks) {
		this.runCalls += 1
		this.busy = true
		const process = this.ownedProcess
		this.process = process
		if (callbacks.onOutput) process.setOutputWriter((chunk, signal) => callbacks.onOutput!(chunk, process, signal))
		process.setOutputFinalizer(async () => {
			await callbacks.onOutputClosed?.(process)
			process.archiveClosed.resolve()
			await process.archiveRelease.promise
		})
		callbacks.onProcessCreated?.(process)
		process.on("line", (line) => callbacks.onLine(line, process))
		process.once("completed", (output) => callbacks.onCompleted(output, process))
		process.once("shell_execution_started", (pid) => callbacks.onShellExecutionStarted(pid, process))
		process.once("shell_execution_complete", (details) => callbacks.onShellExecutionComplete(details, process))
		const visible = new Promise<void>((resolve, reject) => {
			process.once("continue", resolve)
			process.once("error", reject)
		})
		this.runCompletion = process.run(command)
		void this.runCompletion.catch(() => undefined)
		return mergePromise(process, visible)
	}
}

/** Supplied platform adapter through the same public acquisition and scoped inventory ports. */
function provideHeldTerminal(terminal: HeldOwnerTerminal): void {
	const getTerminals = TerminalRegistry.getTerminals.bind(TerminalRegistry)
	vi.spyOn(TerminalRegistry, "getOrCreateTerminal").mockImplementation(async (cwd, taskId, provider = "vscode") => {
		if (
			path.resolve(cwd) !== path.resolve(terminal.getCurrentWorkingDirectory()) ||
			provider !== terminal.provider ||
			terminal.busy ||
			terminal.running
		) {
			throw new Error("Supplied platform terminal is unavailable for this command")
		}
		terminal.taskId = taskId
		terminal.busy = true
		return terminal
	})
	vi.spyOn(TerminalRegistry, "getTerminals").mockImplementation((busy, taskId) => {
		const retained = getTerminals(busy, taskId)
		if (
			terminal.busy === busy &&
			(taskId === undefined || terminal.taskId === taskId) &&
			!retained.includes(terminal)
		) {
			retained.push(terminal)
		}
		return retained
	})
}

async function fixture(
	root: string,
	storage: string,
	taskId: string,
	publish: Task["say"] = async () => undefined,
	deferResultCommit = true,
	userTimeoutMs = 0,
) {
	const state = {
		disabledTools: [] as string[],
		allowedCommands: [],
		deniedCommands: [],
		terminalShellIntegrationDisabled: true,
		terminalOutputPreviewSize: "small" as const,
	}
	const store = new AgentControlStore(new InMemoryAgentControlPersistence())
	await store.initialize()
	await store.ensureRoot({ taskId, objective: "Inspect controlled command output", status: "running" })
	const lifetime = new AbortController()
	let currentLifetime = lifetime
	const ignoreController = new AlphaIgnoreController(root)
	await ignoreController.initialize()
	const provider = {
		getValues: () => state,
		getState: async () => state,
		context: { globalStorageUri: { fsPath: storage } },
		postMessageToWebview: vi.fn(),
		runWorkspaceMutation: async <T>(_task: Task, _label: string, run: () => Promise<T>) => run(),
		reservePrimaryMutation: vi.fn(async (_task: Task, token: string) => {
			await store.reservePrimaryMutation(taskId, taskId, root, token)
		}),
		releasePrimaryMutation: vi.fn(async (_task: Task, token: string, incomplete = false) => {
			await store.releasePrimaryMutation(taskId, taskId, token, incomplete)
		}),
		recordPrimaryMutation: vi.fn(
			async (_task: Task, files: Record<string, string>, unresolved: boolean, token: string) =>
				Boolean(
					await store.recordPrimaryMutation({
						rootTaskId: taskId,
						parentTaskId: taskId,
						workspacePath: root,
						fileVersions: files,
						scopeUnresolved: unresolved,
						reservationToken: token,
					}),
				),
		),
	}
	const verificationPublications = vi.fn()
	const commandCompletion = deferred<Parameters<Task["completeCommandExecution"]>>()
	void commandCompletion.promise.catch(() => undefined)
	const task = {
		taskId,
		taskKind: "primary",
		cwd: root,
		taskMode: "code",
		abort: false,
		getTaskMode: async () => "code",
		getTaskLifetimeCancellationSignal: () => currentLifetime.signal,
		providerRef: { deref: () => provider },
		lastMessageTs: 1_000,
		clineMessages: [],
		consecutiveMistakeCount: 0,
		commandExecutionEvidence: new Map<string, CommandExecutionEvidence>(),
		pendingCommandVerification: Promise.resolve(),
		completionRuntimeRevision: 0,
		alphaIgnoreController: ignoreController,
		alphaProtectedController: new AlphaProtectedController(root),
		beginCommandExecution: Task.prototype.beginCommandExecution,
		admitCommandExecution: vi.fn(Task.prototype.admitCommandExecution),
		completeCommandExecution: vi.fn<Task["completeCommandExecution"]>((...args) => {
			try {
				Task.prototype.completeCommandExecution.call(task, ...args)
				commandCompletion.resolve(args)
			} catch (error) {
				commandCompletion.reject(error)
				throw error
			}
		}),
		failCommandExecution: Task.prototype.failCommandExecution,
		getCommandExecutionEvidence: Task.prototype.getCommandExecutionEvidence,
		markCommandExecutionBackgrounded: Task.prototype.markCommandExecutionBackgrounded,
		presentApprovedCommand: Task.prototype.presentApprovedCommand,
		reserveUiMessageTimestamp: Task.prototype["reserveUiMessageTimestamp"],
		observeUiMessageTimestamps: Task.prototype["observeUiMessageTimestamps"],
		addToAlphaMessages: async (message: AlphaMessage) => {
			task["observeUiMessageTimestamps"]([message])
			task.clineMessages.push(message)
		},
		prepareCommandEvidenceSlot: Task.prototype["prepareCommandEvidenceSlot"],
		enqueueCommandEvidence: Task.prototype["enqueueCommandEvidence"],
		publishParentVerificationEvidence: verificationPublications,
		suspendAfterCurrentTurn: vi.fn(),
		recordToolError: vi.fn(),
		supersedePendingAsk: vi.fn(),
		ask: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
		say: vi.fn<Task["say"]>(publish),
	} as unknown as Task
	const host: ToolExecutionHost = {
		taskId,
		cwd: root,
		taskFacade: task,
		userMessageContent: [],
		say: async () => {},
		recordToolUsage: vi.fn(),
		askApproval: vi.fn(async (type: AlphaAsk, command?: string) => {
			expect(type).toBe("command")
			task.lastMessageTs = (task.lastMessageTs ?? 0) + 1
			task.clineMessages.push({ ts: task.lastMessageTs, type: "ask", ask: "command", text: command })
			return { response: "yesButtonClicked" as const, commandExecutionId: task.lastMessageTs.toString() }
		}),
		pushToolResultToUserContent(result) {
			if (
				host.userMessageContent.some(
					(item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id,
				)
			) {
				return false
			}
			host.userMessageContent.push(result)
			return true
		},
	}
	const surface = createTaskToolSurface({
		schemas: getNativeTools(),
		mode: "code",
		cwd: root,
		execution: { workspaceRoots: [root], command: { userTimeoutMs } },
	})
	const effects = vi.fn()
	const events: string[] = []
	const finishedBatches: string[] = []
	const scheduler = new ToolScheduler({
		executionHost: host,
		registry: surface.registry,
		policy: surface.policy,
		mode: "code",
		executionMode: "selective-parallel",
		...(deferResultCommit ? { requirePreparedCommandRead: true } : {}),
		deferResultCommit,
		signal: lifetime.signal,
		onEffectStart: effects,
		onEvent: async (event) => {
			if (event.type === "tool_result") events.push(event.callId)
			if (event.type === "tool_batch_finished") finishedBatches.push(event.status)
		},
	})
	return {
		task,
		host,
		provider,
		lifetime,
		scheduler,
		surface,
		effects,
		events,
		finishedBatches,
		verificationPublications,
		commandCompletion: commandCompletion.promise,
		replaceLifetimePort() {
			currentLifetime = new AbortController()
			return currentLifetime.signal
		},
		run(id: string, command = "rg -n needle src/sample.txt", yieldTime = 10_000, maxOutputTokens = 2_000) {
			return scheduler.run([
				{
					type: "tool_call",
					id,
					name: "exec_command",
					arguments: { cmd: command, yield_time_ms: yieldTime, max_output_tokens: maxOutputTokens },
				},
			])
		},
		assertHeld() {
			expect(vi.mocked(task.say).mock.calls.filter(([type]) => type === "command_output")).toEqual([])
			expect(task.ask).not.toHaveBeenCalled()
			expect(task.supersedePendingAsk).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
			expect(task.completeCommandExecution).not.toHaveBeenCalled()
			expect(host.userMessageContent).toEqual([])
			expect(events).toEqual([])
		},
		async dispose() {
			const outputs = commandSessionRegistry.capturePendingTaskOutput(task)
			for (const terminal of TerminalRegistry.getTerminals(true, taskId)) await terminal.process?.abort()
			await Promise.allSettled(outputs.map(({ completion }) => completion))
			commandSessionRegistry.releaseForTask(task)
			TerminalRegistry.releaseTerminalsForTask(taskId)
			ignoreController.dispose()
		},
	}
}

describe("prepared commands through the shared collector", () => {
	let directory: string
	let root: string
	let storage: string
	const children: Array<ReturnType<typeof controlledChild>> = []
	const fixtures: Array<Awaited<ReturnType<typeof fixture>>> = []

	beforeEach(async () => {
		platform.launch.mockReset()
		platform.resolveRipgrep.mockReset()
		for (const key of [
			"RIPGREP_CONFIG_PATH",
			"GIT_CONFIG_PARAMETERS",
			"GIT_TRACE",
			"GIT_REDIRECT_STDOUT",
			"GIT_PAGER",
		]) {
			vi.stubEnv(key, undefined)
		}
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-prepared-collector-")))
		root = path.join(directory, "workspace")
		storage = path.join(directory, "storage")
		await fs.mkdir(path.join(root, "src"), { recursive: true })
		await fs.writeFile(path.join(root, "src", "sample.txt"), "needle first\nneedle second\n")
		const executable = path.join(directory, process.platform === "win32" ? "rg.exe" : "rg")
		await fs.writeFile(executable, "controlled trusted executable metadata\n")
		await fs.chmod(executable, 0o755)
		platform.resolveRipgrep.mockResolvedValue({
			path: executable,
			source: "bundled",
			reason: "controlled transport",
		})
		let nextChild = 0
		platform.launch.mockImplementation((first: unknown) => {
			const launch = () => {
				const next = children[nextChild++]
				if (!next) throw new Error("Unexpected child launch")
				return next.child
			}
			return typeof first === "string" ? launch() : launch
		})
	})

	afterEach(async () => {
		for (const child of children) child.finish()
		for (const owner of fixtures) await owner.dispose()
		children.length = 0
		fixtures.length = 0
		vi.useRealTimers()
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		await fs.rm(directory, { recursive: true, force: true })
	})

	async function owner(id: string, publish?: Task["say"], deferResultCommit = true, userTimeoutMs = 0) {
		const created = await fixture(root, storage, id, publish, deferResultCommit, userTimeoutMs)
		fixtures.push(created)
		return created
	}

	async function expectSpawn(child: ReturnType<typeof controlledChild>, run: Promise<ToolSchedulerOutcome>) {
		const first = await Promise.race([child.started.then(() => "spawned"), run.then(() => "returned-before-spawn")])
		// A baseline denial/fallback is an assertion failure, never a missing-method or timeout oracle.
		expect(first).toBe("spawned")
	}

	it.each([0, 2_000])(
		"retains a yielded collector and its partial line with stdout budget %s until the final native poll",
		async (budget) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const child = controlledChild()
			children.push(child)
			const current = await owner("prepared-yield")
			const run = current.run("yielded-rg", "rg -n needle src/sample.txt", 1, budget)
			await expectSpawn(child, run)
			await child.write("1:needle without newline")
			await vi.advanceTimersByTimeAsync(11_000)
			const outcome = await run
			if (budget === 0) expect(outcome.results[0].commandResult?.output).toBe("")
			const sessionId = outcome.results[0]?.commandResult?.session_id
			expect(sessionId).toBeTypeOf("number")
			if (sessionId === undefined) throw new Error("Yielded command returned no numeric session")
			const original = commandSessionRegistry.resolve(current.task, sessionId)
			expect(original).toBeDefined()
			expect(original?.process.isSettled).toBe(false)
			current.assertHeld()
			await current.scheduler.commitDeferredResults()
			expect(current.host.userMessageContent).toHaveLength(1)
			expect(current.events).toEqual(["yielded-rg"])
			child.finish(1)
			await original?.process.waitForOutputFinalization?.()
			const completion = await current.commandCompletion
			expect(completion[0]).toBe("yielded-rg")
			expect(completion[1]).toMatchObject({ exitCode: 1 })
			expect(completion[2]).toBe(original?.executionId)
			expect(original?.executionId).toMatch(/^1001:[0-9a-f-]{36}$/)
			expect(current.task.getCommandExecutionEvidence()).toContainEqual(
				expect.objectContaining({
					toolCallId: "yielded-rg",
					executionId: original?.executionId,
					status: "failed",
					exitCode: 1,
				}),
			)
			const poll = new ToolScheduler({
				executionHost: current.host,
				registry: createTaskToolSurface({ schemas: getNativeTools(), mode: "code", cwd: root }).registry,
				mode: "code",
			})
			const polled = await poll.run([
				{
					type: "tool_call",
					id: "final-poll",
					name: "write_stdin",
					arguments: { session_id: sessionId, chars: "", yield_time_ms: 0, max_output_tokens: 2_000 },
				},
			])
			expect(polled.results[0]).toMatchObject({ status: "success", exitCode: 1 })
			expect(polled.results[0].commandResult?.session_id).toBeUndefined()
			expect(
				JSON.stringify(outcome.results[0].commandResult) + JSON.stringify(polled.results[0].commandResult),
			).toContain("needle without newline")
			expect(commandSessionRegistry.resolve(current.task, sessionId)).toBeUndefined()
			expect(current.host.askApproval).toHaveBeenCalledOnce()
		},
	)

	it("preserves rg no-match exit one as a numeric shared-collector result", async () => {
		const child = controlledChild()
		children.push(child)
		const current = await owner("prepared-exit-one")
		const run = current.run("no-match", "rg -n absent src/sample.txt")
		await expectSpawn(child, run)
		child.finish(1)
		const outcome = await run
		expect(outcome.results[0]).toMatchObject({ status: "success", exitCode: 1 })
		expect(outcome.results[0].commandResult).toMatchObject({ exit_code: 1, output: "" })
		current.assertHeld()
		await current.scheduler.commitDeferredResults()
		await current.scheduler.commitDeferredResults()
		expect(current.host.userMessageContent).toEqual([
			expect.objectContaining({ tool_use_id: "no-match", is_error: false }),
		])
		expect(current.events).toEqual(["no-match"])
		expect(current.task.completeCommandExecution).toHaveBeenCalledOnce()
	})

	it("joins a failed raw reader before publishing one truthful terminal error", async () => {
		const child = controlledChild()
		children.push(child)
		const current = await owner("prepared-output-error")
		const run = current.run("reader-error")
		await expectSpawn(child, run)
		await child.write("1:needle prefix\n")
		const failure = new Error("controlled raw reader failed")
		child.failOutput(failure)
		expect(await Promise.race([child.readerClosed.then(() => "reader-closed"), run.then(() => "returned")])).toBe(
			"reader-closed",
		)
		current.assertHeld()
		child.finish()
		const outcome = await run
		expect(outcome.results[0].status).toBe("error")
		expect(outcome.results[0].commandResult?.artifact_id).toBeUndefined()
		await current.scheduler.commitDeferredResults()
		await current.scheduler.commitDeferredResults()
		expect(current.host.userMessageContent).toEqual([
			expect.objectContaining({ tool_use_id: "reader-error", is_error: true }),
		])
		expect(current.events).toEqual(["reader-error"])
		expect(JSON.stringify(outcome.results[0].content)).toContain("controlled raw reader failed")
		expect(
			current.task.getCommandExecutionEvidence().find(({ toolCallId }) => toolCallId === "reader-error")?.status,
		).not.toBe("succeeded")
	})

	it("observes a held completion projection failure as one terminal error after the shared collector has closed", async () => {
		const child = controlledChild()
		children.push(child)
		const current = await owner("prepared-completion-projection-error")
		const run = current.run("completion-projection-error")
		await expectSpawn(child, run)
		const original = TerminalRegistry.getTerminals(true, current.task.taskId)[0]?.process
		expect(original).toBeDefined()
		await child.write("1:needle completed before projection\n")
		child.finish()
		const outcome = await run
		await original?.waitForOutputFinalization?.()
		current.assertHeld()
		const projectionFailure = new Error("prepared completion projection unavailable")
		vi.mocked(current.task.completeCommandExecution).mockImplementation(() => {
			throw projectionFailure
		})
		await current.scheduler.commitDeferredResults()
		await current.scheduler.commitDeferredResults()
		expect(outcome.results[0].status).toBe("error")
		expect(JSON.stringify(outcome.results[0].content)).toContain(projectionFailure.message)
		expect(current.host.userMessageContent).toEqual([
			expect.objectContaining({ tool_use_id: "completion-projection-error", is_error: true }),
		])
		expect(current.events).toEqual(["completion-projection-error"])
		expect(current.task.completeCommandExecution).toHaveBeenCalledExactlyOnceWith(
			"completion-projection-error",
			expect.objectContaining({ exitCode: 0 }),
			original?.executionId,
		)
		expect(
			current.task
				.getCommandExecutionEvidence()
				.find(({ toolCallId }) => toolCallId === "completion-projection-error")?.status,
		).not.toBe("succeeded")
		expect(original?.isSettled).toBe(true)
		expect(original?.isOutputFinalized).toBe(true)
		expect(commandSessionRegistry.capturePendingTaskOutput(current.task)).toEqual([])
		expect(child.child.kill).not.toHaveBeenCalled()
	})

	it("commits reverse-completing collectors in model order with one receipt and final output each", async () => {
		const first = controlledChild()
		const second = controlledChild()
		children.push(first, second)
		const pendingByPattern = new Map([
			["first", first],
			["second", second],
		])
		platform.launch.mockImplementation(() => (executable: string, args: readonly string[]) => {
			if (
				executable !== path.join(directory, process.platform === "win32" ? "rg.exe" : "rg") ||
				args.length !== 4 ||
				args[0] !== "--no-config" ||
				args[1] !== "-n" ||
				args[3] !== "src/sample.txt"
			) {
				throw new Error("Unexpected reverse-order direct command")
			}
			const child = pendingByPattern.get(args[2])
			if (!child) throw new Error("Unknown or duplicate reverse-order command pattern")
			pendingByPattern.delete(args[2])
			return child.child
		})
		const current = await owner("prepared-reverse-order")
		const run = current.scheduler.run([
			{ type: "tool_call", id: "first", name: "exec_command", arguments: { cmd: "rg -n first src/sample.txt" } },
			{
				type: "tool_call",
				id: "second",
				name: "exec_command",
				arguments: { cmd: "rg -n second src/sample.txt" },
			},
		])
		await expectSpawn(first, run)
		await expectSpawn(second, run)
		expect(pendingByPattern.size).toBe(0)
		await second.write("2:needle second\n")
		second.finish()
		await first.write("1:needle first\n")
		first.finish()
		const outcome = await run
		expect(outcome.results.map(({ callId, status, exitCode }) => [callId, status, exitCode])).toEqual([
			["first", "success", 0],
			["second", "success", 0],
		])
		current.assertHeld()
		await current.scheduler.commitDeferredResults()
		await current.scheduler.commitDeferredResults()
		expect(current.events).toEqual(["first", "second"])
		expect(
			current.host.userMessageContent.map((item) => (item.type === "tool_result" ? item.tool_use_id : undefined)),
		).toEqual(["first", "second"])
		const finals = vi
			.mocked(current.task.say)
			.mock.calls.filter((args) => args[0] === "command_output" && args[3] === false)
		expect(finals.map((args) => args[6]?.commandExecutionId)).toEqual(["1001", "1002"])
		expect(finals[0][1]).toContain("needle first")
		expect(finals[1][1]).toContain("needle second")
		expect(current.host.askApproval).toHaveBeenCalledTimes(2)
		expect(current.task.completeCommandExecution).toHaveBeenCalledTimes(2)
	})

	it.each([
		{ physical: "completed", action: "discard" },
		{ physical: "completed", action: "cancelled commit" },
		{ physical: "yielded", action: "discard" },
		{ physical: "yielded", action: "cancelled commit" },
	] as const)("cleans only the original $physical collector on $action", async ({ physical, action }) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const originalChild = controlledChild()
		const siblingChild = controlledChild()
		children.push(originalChild, siblingChild)
		const current = await owner(`prepared-${physical}-${action}`)
		const sibling = await owner(`sibling-${physical}-${action}`)
		const run = current.run("original", "rg -n first src/sample.txt", physical === "yielded" ? 1 : 10_000)
		await expectSpawn(originalChild, run)
		const original = TerminalRegistry.getTerminals(true, current.task.taskId)[0]?.process
		expect(original).toBeDefined()
		await originalChild.write("1:needle original\n")
		if (physical === "completed") originalChild.finish()
		else await vi.advanceTimersByTimeAsync(11_000)
		const outcome = await run
		current.assertHeld()
		expect(original?.isSettled).toBe(physical === "completed")

		const siblingRun = sibling.run("sibling", "rg -n second src/sample.txt", 1)
		await expectSpawn(siblingChild, siblingRun)
		await siblingChild.write("2:needle sibling\n")
		await vi.advanceTimersByTimeAsync(11_000)
		const siblingOutcome = await siblingRun
		const siblingId = siblingOutcome.results[0].commandResult?.session_id
		expect(siblingId).toBeTypeOf("number")
		if (siblingId === undefined) throw new Error("Sibling returned no numeric session")
		const siblingSession = commandSessionRegistry.resolve(sibling.task, siblingId)
		expect(siblingSession?.process.isSettled).toBe(false)

		if (action === "cancelled commit") current.lifetime.abort()
		const cleanup =
			action === "discard"
				? current.scheduler.discardDeferredResults()
				: current.scheduler.commitDeferredResults()
		if (physical === "yielded") {
			// Progress by a different actual collector is the barrier; no timer/microtask guess proves the join.
			expect(
				await Promise.race([
					Promise.resolve(cleanup).then(() => "cleanup-returned"),
					siblingChild.write("3:needle sibling still owned\n").then(() => "sibling-progress"),
				]),
			).toBe("sibling-progress")
			originalChild.finish(137, "SIGKILL")
		}
		await cleanup
		await original?.waitForOutputFinalization?.()
		expect(commandSessionRegistry.resolve(sibling.task, siblingId)?.process).toBe(siblingSession?.process)
		expect(sibling.task.terminalProcess).toBeUndefined()
		expect(siblingSession?.process.isSettled).toBe(false)
		expect(commandSessionRegistry.ownsOutput(siblingSession!.process)).toBe(true)
		const originalId = outcome.results[0].commandResult?.session_id
		if (originalId !== undefined) expect(commandSessionRegistry.resolve(current.task, originalId)).toBeUndefined()
		expect(vi.mocked(current.task.say).mock.calls.filter(([type]) => type === "command_output")).toEqual([])
		expect(current.provider.postMessageToWebview).not.toHaveBeenCalled()
		expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
		if (action === "discard") {
			await current.scheduler.commitDeferredResults()
			expect(current.host.userMessageContent).toEqual([])
			expect(current.events).toEqual([])
		} else {
			await current.scheduler.commitDeferredResults()
			expect(current.host.userMessageContent).toEqual([
				expect.objectContaining({ tool_use_id: "original", is_error: true }),
			])
			expect(current.events).toEqual(["original"])
			expect(outcome.results[0].status).toBe("cancelled")
		}
		siblingChild.finish()
		await siblingSession?.process.waitForOutputFinalization?.()
		await sibling.scheduler.commitDeferredResults()
		expect(sibling.events).toEqual(["sibling"])
	})

	it("preserves a replacement process on the same Task when an older completed collector is discarded", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const first = controlledChild()
		const replacementChild = controlledChild()
		children.push(first, replacementChild)
		const current = await owner("prepared-replacement")
		const oldRun = current.run("old", "rg -n first src/sample.txt")
		await expectSpawn(first, oldRun)
		await first.write("1:needle old\n")
		first.finish()
		await oldRun
		const replacementScheduler = new ToolScheduler({
			executionHost: current.host,
			registry: current.surface.registry,
			policy: current.surface.policy,
			mode: "code",
			executionMode: "selective-parallel",
			deferResultCommit: true,
			requirePreparedCommandRead: true,
		})
		const replacementRun = replacementScheduler.run([
			{
				type: "tool_call",
				id: "replacement",
				name: "exec_command",
				arguments: { cmd: "rg -n second src/sample.txt", yield_time_ms: 1 },
			},
		])
		await expectSpawn(replacementChild, replacementRun)
		const replacement = TerminalRegistry.getTerminals(true, current.task.taskId)[0]?.process
		expect(current.task.terminalProcess).toBe(replacement)
		await replacementChild.write("2:needle replacement\n")
		await current.scheduler.discardDeferredResults()
		expect(current.task.terminalProcess).toBe(replacement)
		expect(replacement?.isSettled).toBe(false)
		expect(TerminalRegistry.getTerminals(true, current.task.taskId)[0]?.process).toBe(replacement)
		await vi.advanceTimersByTimeAsync(11_000)
		const outcome = await replacementRun
		const id = outcome.results[0].commandResult?.session_id
		if (id === undefined) throw new Error("Replacement returned no numeric session")
		expect(commandSessionRegistry.resolve(current.task, id)?.process).toBe(replacement)
		expect(replacement?.isSettled).toBe(false)
		expect(TerminalRegistry.getTerminals(true, current.task.taskId)[0]?.process).toBe(replacement)
		expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
		replacementChild.finish()
		await replacement?.waitForOutputFinalization?.()
		await replacementScheduler.commitDeferredResults()
		expect(current.host.userMessageContent).toEqual([
			expect.objectContaining({ tool_use_id: "replacement", is_error: false }),
		])
	})

	it("checks ownership inside the queued command-output publication before admitting Task.say", async () => {
		const child = controlledChild()
		children.push(child)
		const current = await owner("prepared-queued-publication")
		const run = current.run("queued-publication")
		await expectSpawn(child, run)
		await child.write("1:needle queued before replacement\n")
		child.finish()
		await run
		current.assertHeld()
		let ownsTurn = true
		let armed = false
		let scheduled = false
		const stale = new Error("Replacement turn owns queued publication")
		current.provider.postMessageToWebview.mockImplementation((message: { type: string; text?: string }) => {
			if (
				message.type === "commandExecutionStatus" &&
				message.text &&
				JSON.parse(message.text).status === "output"
			) {
				armed = true
			}
		})
		const observed = current.scheduler
			.commitDeferredResults({
				assertOwnership: () => {
					if (!ownsTurn) throw stale
					if (armed && !scheduled) {
						scheduled = true
						// The public output-status publication selects this boundary,
						// then revocation precedes the queued command-output .then.
						queueMicrotask(() => {
							ownsTurn = false
						})
					}
				},
			})
			.then(
				() => ({ status: "fulfilled" as const }),
				(reason: unknown) => ({ status: "rejected" as const, reason }),
			)
		const result = await observed
		expect(armed).toBe(true)
		expect(scheduled).toBe(true)
		expect(ownsTurn).toBe(false)
		expect(result.status).toBe("rejected")
		if (result.status === "rejected") expect(result.reason).toBe(stale)
		expect(vi.mocked(current.task.say).mock.calls.filter(([type]) => type === "command_output")).toEqual([])
		expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
		expect(current.host.userMessageContent).toEqual([])
		expect(current.events).toEqual([])
		expect(commandSessionRegistry.capturePendingTaskOutput(current.task)).toEqual([])
	})

	it("stops a held presentation finalizer after ownership changes during its first awaited publication", async () => {
		const child = controlledChild()
		children.push(child)
		const entered = deferred<void>()
		const release = deferred<void>()
		const current = await owner("prepared-stale-finalizer", async (type) => {
			if (type === "command_output") {
				entered.resolve()
				await release.promise
			}
			return undefined
		})
		const run = current.run("stale-finalizer")
		await expectSpawn(child, run)
		await child.write("1:needle before replacement\n")
		child.finish()
		await run
		current.assertHeld()
		let ownsTurn = true
		const stale = new Error("Replacement turn owns publication")
		const commit = current.scheduler.commitDeferredResults({
			assertOwnership: () => {
				if (!ownsTurn) throw stale
			},
		})
		const observed = commit.then(
			() => ({ status: "fulfilled" as const }),
			(reason: unknown) => ({ status: "rejected" as const, reason }),
		)
		try {
			expect(
				await Promise.race([entered.promise.then(() => "publication"), observed.then(() => "finished")]),
			).toBe("publication")
			const published = current.provider.postMessageToWebview.mock.calls.length
			const outputCalls = vi.mocked(current.task.say).mock.calls.length
			ownsTurn = false
			release.resolve()
			const result = await observed
			expect(result.status).toBe("rejected")
			if (result.status === "rejected") expect(result.reason).toBe(stale)
			expect(vi.mocked(current.task.say).mock.calls).toHaveLength(outputCalls)
			expect(current.provider.postMessageToWebview.mock.calls).toHaveLength(published)
			expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
			expect(current.host.userMessageContent).toEqual([])
		} finally {
			release.resolve()
			await observed
		}
	})

	it.each([undefined, null])(
		"retains all unsettled cleanup pins after a bounded rejection with reason %s and permits a late retry",
		async (reason) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const terminal = new HeldOwnerTerminal(root, await getRipgrepPathOverlay(), reason)
			provideHeldTerminal(terminal)
			const current = await owner(`prepared-bounded-${String(reason)}`)
			const run = current.run("bounded-cleanup", "rg -n needle src/sample.txt", 1)
			const process = terminal.ownedProcess
			try {
				expect(
					await Promise.race([process.started.promise.then(() => "started"), run.then(() => "returned")]),
				).toBe("started")
				await vi.advanceTimersByTimeAsync(11_000)
				const outcome = await run
				const id = outcome.results[0].commandResult?.session_id
				if (id === undefined) throw new Error("Held owner returned no numeric session")
				current.assertHeld()
				const pending = commandSessionRegistry.capturePendingTaskOutput(current.task)
				expect(pending).toEqual([expect.objectContaining({ process, archiveExecutionId: "1001" })])
				expect(pending[0].executionId).not.toBe(pending[0].archiveExecutionId)
				expect(pending[0].isCleanupSafe()).toBe(false)
				let returned = false
				const first = Promise.resolve(current.scheduler.discardDeferredResults())
					.then(
						() => ({ status: "fulfilled" as const }),
						(rejection: unknown) => ({ status: "rejected" as const, reason: rejection }),
					)
					.then((result) => {
						returned = true
						return result
					})
				await process.abortObserved.promise
				await vi.advanceTimersByTimeAsync(14_999)
				expect(returned).toBe(false)
				expect(process.isOutputFinalized).toBe(false)
				await vi.advanceTimersByTimeAsync(1)
				const result = await first
				expect(result.status).toBe("rejected")
				if (result.status === "rejected") expect(result.reason).toBe(reason)
				expect(commandSessionRegistry.resolve(current.task, id)?.process).toBe(process)
				expect(commandSessionRegistry.ownsOutput(process)).toBe(true)
				expect(commandSessionRegistry.capturePendingTaskOutput(current.task)[0].isCleanupSafe()).toBe(false)
				current.assertHeld()
				process.physicalEnd.resolve()
				process.archiveRelease.resolve()
				await terminal.runCompletion
				await current.scheduler.discardDeferredResults()
				expect(process.abortCalls).toBe(1)
				expect(terminal.runCalls).toBe(1)
				expect(commandSessionRegistry.resolve(current.task, id)).toBeUndefined()
				expect(commandSessionRegistry.ownsOutput(process)).toBe(false)
				expect(commandSessionRegistry.capturePendingTaskOutput(current.task)).toEqual([])
				current.assertHeld()
			} finally {
				process.physicalEnd.resolve()
				process.archiveRelease.resolve()
				await terminal.runCompletion
			}
		},
	)

	it("publishes one cancelled receipt when cancellation wins during the first awaited presentation", async () => {
		const child = controlledChild()
		children.push(child)
		const entered = deferred<void>()
		const release = deferred<void>()
		const current = await owner("prepared-cancel-opening", async (type) => {
			if (type === "command_output") {
				entered.resolve()
				await release.promise
			}
			return undefined
		})
		const run = current.run("cancel-opening")
		await expectSpawn(child, run)
		await child.write("1:needle before cancellation\n")
		child.finish()
		const outcome = await run
		current.assertHeld()
		const commit = current.scheduler.commitDeferredResults()
		const observed = commit.then(
			() => ({ status: "fulfilled" as const }),
			(reason: unknown) => ({ status: "rejected" as const, reason }),
		)
		try {
			expect(
				await Promise.race([entered.promise.then(() => "publication"), observed.then(() => "finished")]),
			).toBe("publication")
			const published = current.provider.postMessageToWebview.mock.calls.length
			const outputCalls = vi.mocked(current.task.say).mock.calls.length
			current.lifetime.abort()
			release.resolve()
			expect(await observed).toEqual({ status: "fulfilled" })
			await current.scheduler.commitDeferredResults()
			expect(outcome.results[0].status).toBe("cancelled")
			expect(current.host.userMessageContent).toEqual([
				expect.objectContaining({ tool_use_id: "cancel-opening", is_error: true }),
			])
			expect(current.events).toEqual(["cancel-opening"])
			expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
			expect(vi.mocked(current.task.say).mock.calls).toHaveLength(outputCalls)
			expect(current.provider.postMessageToWebview.mock.calls).toHaveLength(published)
		} finally {
			release.resolve()
			await observed
		}
	})

	it.each([undefined, null])(
		"stages one cancelled receipt and rejects the exact cleanup reason %s while its original owner remains pinned",
		async (reason) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const terminal = new HeldOwnerTerminal(root, await getRipgrepPathOverlay(), reason)
			provideHeldTerminal(terminal)
			const process = terminal.ownedProcess
			const entered = deferred<void>()
			const release = deferred<void>()
			const current = await owner(`prepared-cancelled-cleanup-${String(reason)}`, async (type) => {
				if (type === "command_output") {
					entered.resolve()
					await release.promise
				}
				return undefined
			})
			const run = current.run("cancelled-cleanup", "rg -n needle src/sample.txt", 1)
			let observed: Promise<{ status: "fulfilled" } | { status: "rejected"; reason: unknown }> | undefined
			try {
				expect(
					await Promise.race([process.started.promise.then(() => "started"), run.then(() => "returned")]),
				).toBe("started")
				await vi.advanceTimersByTimeAsync(11_000)
				const outcome = await run
				const id = outcome.results[0].commandResult?.session_id
				if (id === undefined) throw new Error("Held cleanup owner returned no numeric session")
				current.assertHeld()
				let returned = false
				observed = current.scheduler
					.commitDeferredResults()
					.then(
						() => ({ status: "fulfilled" as const }),
						(rejection: unknown) => ({ status: "rejected" as const, reason: rejection }),
					)
					.then((result) => {
						returned = true
						return result
					})
				expect(
					await Promise.race([entered.promise.then(() => "publication"), observed.then(() => "finished")]),
				).toBe("publication")
				const published = current.provider.postMessageToWebview.mock.calls.length
				const outputCalls = vi.mocked(current.task.say).mock.calls.length
				current.lifetime.abort()
				release.resolve()
				await process.abortObserved.promise
				await vi.advanceTimersByTimeAsync(14_999)
				expect(returned).toBe(false)
				expect(process.isOutputFinalized).toBe(false)
				await vi.advanceTimersByTimeAsync(1)
				const result = await observed
				expect(result.status).toBe("rejected")
				if (result.status === "rejected") expect(result.reason).toBe(reason)
				expect(outcome.results[0].status).toBe("cancelled")
				expect(current.host.userMessageContent).toEqual([
					expect.objectContaining({ tool_use_id: "cancelled-cleanup", is_error: true }),
				])
				expect(current.events).toEqual(["cancelled-cleanup"])
				expect(current.finishedBatches).toEqual([])
				expect(commandSessionRegistry.resolve(current.task, id)?.process).toBe(process)
				expect(commandSessionRegistry.ownsOutput(process)).toBe(true)
				expect(commandSessionRegistry.capturePendingTaskOutput(current.task)[0].isCleanupSafe()).toBe(false)
				expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
				expect(vi.mocked(current.task.say).mock.calls).toHaveLength(outputCalls)
				expect(current.provider.postMessageToWebview.mock.calls).toHaveLength(published)
				process.physicalEnd.resolve()
				process.archiveRelease.resolve()
				await terminal.runCompletion
				await current.scheduler.discardDeferredResults()
				await current.scheduler.commitDeferredResults()
				expect(process.abortCalls).toBe(1)
				expect(terminal.runCalls).toBe(1)
				expect(commandSessionRegistry.resolve(current.task, id)).toBeUndefined()
				expect(commandSessionRegistry.capturePendingTaskOutput(current.task)).toEqual([])
				expect(current.events).toEqual(["cancelled-cleanup"])
				expect(current.host.userMessageContent).toHaveLength(1)
				expect(current.finishedBatches).toEqual([])
			} finally {
				release.resolve()
				process.physicalEnd.resolve()
				process.archiveRelease.resolve()
				await terminal.runCompletion
				await observed
			}
		},
	)

	it.each([undefined, null])(
		"returns a failed nondeferred outcome for cleanup reason %s without losing its accepted-call receipt or adding a second deadline",
		async (reason) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const terminal = new HeldOwnerTerminal(root, await getRipgrepPathOverlay(), reason)
			provideHeldTerminal(terminal)
			const process = terminal.ownedProcess
			const entered = deferred<void>()
			const release = deferred<void>()
			const current = await owner(
				`prepared-immediate-cleanup-${String(reason)}`,
				async (type) => {
					if (type === "command_output") {
						entered.resolve()
						await release.promise
					}
					return undefined
				},
				false,
			)
			let returned = false
			const observed = current
				.run("immediate-cleanup", "rg -n needle src/sample.txt", 1)
				.then(
					(outcome) => ({ status: "fulfilled" as const, outcome }),
					(rejection: unknown) => ({ status: "rejected" as const, reason: rejection }),
				)
				.then((result) => {
					returned = true
					return result
				})
			try {
				expect(
					await Promise.race([
						process.started.promise.then(() => "started"),
						observed.then(() => "returned"),
					]),
				).toBe("started")
				await vi.advanceTimersByTimeAsync(11_000)
				expect(
					await Promise.race([entered.promise.then(() => "publication"), observed.then(() => "finished")]),
				).toBe("publication")
				const original = commandSessionRegistry.capturePendingTaskOutput(current.task)
				expect(original).toEqual([expect.objectContaining({ process, archiveExecutionId: "1001" })])
				expect(commandSessionRegistry.ownsOutput(process)).toBe(true)
				const outputCalls = vi.mocked(current.task.say).mock.calls.length
				current.lifetime.abort()
				release.resolve()
				await process.abortObserved.promise
				await vi.advanceTimersByTimeAsync(14_999)
				expect(returned).toBe(false)
				await vi.advanceTimersByTimeAsync(1)
				// A run-finally cleanup retry must not add another15s before the
				// first actual observer's failed outcome is surfaced to its caller.
				expect(returned).toBe(true)
				const result = await observed
				expect(result.status).toBe("fulfilled")
				if (result.status === "fulfilled") {
					expect(result.outcome.status).toBe("failed")
					expect(result.outcome.failure).toEqual(
						expect.objectContaining({
							kind: "command_cleanup",
							callId: "immediate-cleanup",
							message: "Prepared command cleanup remains unconfirmed",
						}),
					)
					expect(result.outcome.results).toEqual([
						expect.objectContaining({ callId: "immediate-cleanup", status: "cancelled" }),
					])
				}
				expect(current.host.userMessageContent).toEqual([
					expect.objectContaining({ tool_use_id: "immediate-cleanup", is_error: true }),
				])
				expect(current.events).toEqual(["immediate-cleanup"])
				expect(current.finishedBatches).not.toContain("completed")
				expect(commandSessionRegistry.capturePendingTaskOutput(current.task)).toEqual(original)
				expect(commandSessionRegistry.ownsOutput(process)).toBe(true)
				expect(original[0].isCleanupSafe()).toBe(false)
				expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
				expect(vi.mocked(current.task.say).mock.calls).toHaveLength(outputCalls)
				process.physicalEnd.resolve()
				process.archiveRelease.resolve()
				await terminal.runCompletion
				await current.scheduler.discardDeferredResults()
				expect(commandSessionRegistry.capturePendingTaskOutput(current.task)).toEqual([])
				expect(commandSessionRegistry.ownsOutput(process)).toBe(false)
				expect(process.abortCalls).toBe(1)
				expect(terminal.runCalls).toBe(1)
				expect(current.events).toEqual(["immediate-cleanup"])
			} finally {
				release.resolve()
				process.physicalEnd.resolve()
				process.archiveRelease.resolve()
				await terminal.runCompletion
				await observed
			}
		},
	)

	it.each([
		{ lane: "normal", deferred: false, reasonName: "undefined", reason: undefined },
		{ lane: "normal", deferred: false, reasonName: "null", reason: null },
		{ lane: "deferred", deferred: true, reasonName: "undefined", reason: undefined },
		{ lane: "deferred", deferred: true, reasonName: "null", reason: null },
	])(
		"joins a rejected shared collector in the $lane lane before publishing when cleanup rejects $reasonName",
		async ({ lane, deferred: deferCommit, reason }) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const terminal = new HeldOwnerTerminal(root, await getRipgrepPathOverlay(), reason, { failReader: true })
			provideHeldTerminal(terminal)
			const process = terminal.ownedProcess
			const current = await owner(`prepared-run-error-${lane}-${String(reason)}`, undefined, deferCommit)
			const runError = new Error("Original controlled shared-collector reader rejection")
			let returned = false
			const observed = current
				.run("rejected-collector")
				.then(
					(outcome) => ({ status: "fulfilled" as const, outcome }),
					(rejection: unknown) => ({ status: "rejected" as const, reason: rejection }),
				)
				.then((result) => {
					returned = true
					return result
				})
			try {
				expect(
					await Promise.race([
						process.started.promise.then(() => "started"),
						observed.then(() => "returned"),
					]),
				).toBe("started")
				expect(current.effects).toHaveBeenCalledOnce()
				process.readerFailure.resolve(runError)
				await process.readerFailureEmitted.promise
				await process.abortObserved.promise
				// Even the normal lane must join this owner BEFORE a terminal receipt
				// or a later command window. Old run-finally cleanup is too late.
				expect(current.host.userMessageContent).toEqual([])
				expect(current.events).toEqual([])
				expect(current.finishedBatches).toEqual([])
				const original = commandSessionRegistry.capturePendingTaskOutput(current.task)
				expect(original).toEqual([expect.objectContaining({ process, archiveExecutionId: "1001" })])
				expect(original[0].isCleanupSafe()).toBe(false)
				await vi.advanceTimersByTimeAsync(14_999)
				expect(returned).toBe(false)
				await vi.advanceTimersByTimeAsync(1)
				expect(returned).toBe(true)
				const result = await observed
				expect(result.status).toBe("fulfilled")
				if (result.status !== "fulfilled")
					throw new Error("The normal scheduler boundary threw instead of returning its actual result")
				expect(result.outcome.status).toBe("failed")
				expect(result.outcome.failure).toEqual(
					expect.objectContaining({ kind: "command_cleanup", callId: "rejected-collector" }),
				)
				expect(result.outcome.results[0].status).toBe("error")
				expect(JSON.stringify(result.outcome.results[0].content)).toContain(runError.message)
				expect(JSON.stringify(result.outcome.results[0].content)).not.toContain("not executed")
				if (deferCommit) {
					current.assertHeld()
					expect(current.task.getCommandExecutionEvidence()).toEqual([
						expect.objectContaining({ toolCallId: "rejected-collector", status: "running" }),
					])
					expect(current.verificationPublications).not.toHaveBeenCalled()
					const timers = vi.spyOn(globalThis, "setTimeout")
					const committed = await current.scheduler.commitDeferredResults().then(
						() => ({ status: "fulfilled" as const }),
						(rejection: unknown) => ({ status: "rejected" as const, reason: rejection }),
					)
					expect(committed.status).toBe("rejected")
					if (committed.status === "rejected") expect(committed.reason).toBe(reason)
					expect(timers.mock.calls.filter(([, milliseconds]) => milliseconds === 15_000)).toEqual([])
				} else {
					const explicitRetry = current.scheduler.discardDeferredResults().then(
						() => ({ status: "fulfilled" as const }),
						(rejection: unknown) => ({ status: "rejected" as const, reason: rejection }),
					)
					// This is a NEW explicit observer, unlike an automatic run-finally
					// second deadline. The original passive/physical gates stay held.
					await vi.advanceTimersByTimeAsync(15_000)
					const retried = await explicitRetry
					expect(retried.status).toBe("rejected")
					if (retried.status === "rejected") expect(retried.reason).toBe(reason)
				}
				expect(current.host.userMessageContent).toEqual([
					expect.objectContaining({ tool_use_id: "rejected-collector", is_error: true }),
				])
				expect(JSON.stringify(current.host.userMessageContent)).toContain(runError.message)
				expect(current.task.getCommandExecutionEvidence()).toEqual([
					expect.objectContaining({ toolCallId: "rejected-collector", status: "failed" }),
				])
				expect(current.verificationPublications).toHaveBeenCalledOnce()
				expect(current.events).toEqual(["rejected-collector"])
				expect(current.finishedBatches).not.toContain("completed")
				expect(commandSessionRegistry.capturePendingTaskOutput(current.task)).toEqual(original)
				expect(terminal.running).toBe(true)
				expect(process.isOutputFinalized).toBe(false)
				expect(process.outputArtifactId).toBeUndefined()
				process.physicalEnd.resolve()
				process.archiveRelease.resolve()
				await terminal.runCompletion
				await current.scheduler.discardDeferredResults()
				expect(commandSessionRegistry.capturePendingTaskOutput(current.task)).toEqual([])
				expect(process.abortCalls).toBe(1)
				expect(terminal.runCalls).toBe(1)
				expect(process.outputArtifactId).toBeUndefined()
				expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
				expect(current.verificationPublications).toHaveBeenCalledOnce()
				expect(current.events).toEqual(["rejected-collector"])
			} finally {
				process.readerFailure.resolve(runError)
				process.physicalEnd.resolve()
				process.archiveRelease.resolve()
				await terminal.runCompletion
				await observed
			}
		},
	)

	it.each([
		{ lane: "normal", deferred: false },
		{ lane: "deferred", deferred: true },
	])(
		"preserves the actual rejected collector result in the $lane lane after its physical and archive cleanup join successfully",
		async ({ lane, deferred: deferCommit }) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const terminal = new HeldOwnerTerminal(root, await getRipgrepPathOverlay(), undefined, {
				failReader: true,
				abortSucceeds: true,
			})
			provideHeldTerminal(terminal)
			const process = terminal.ownedProcess
			const current = await owner(`prepared-run-error-joined-${lane}`, undefined, deferCommit)
			const runError = new Error("Original reader failure survived successful cleanup")
			let returned = false
			const observed = current
				.run("joined-reader-error")
				.then(
					(outcome) => ({ status: "fulfilled" as const, outcome }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				)
				.then((result) => {
					returned = true
					return result
				})
			try {
				expect(
					await Promise.race([
						process.started.promise.then(() => "started"),
						observed.then(() => "returned"),
					]),
				).toBe("started")
				process.readerFailure.resolve(runError)
				await process.readerFailureEmitted.promise
				await process.abortObserved.promise
				expect(returned).toBe(false)
				expect(current.host.userMessageContent).toEqual([])
				process.physicalEnd.resolve()
				await process.physicalObserved.promise
				await process.archiveClosed.promise
				expect(returned).toBe(false)
				expect(process.isOutputFinalized).toBe(false)
				expect(current.host.userMessageContent).toEqual([])
				process.archiveRelease.resolve()
				await terminal.runCompletion
				const result = await observed
				expect(result.status).toBe("fulfilled")
				if (result.status !== "fulfilled")
					throw new Error("Joined cleanup replaced the original collector result with a thrown failure")
				expect(result.outcome.status).toBe("completed")
				expect(result.outcome.failure).toBeUndefined()
				expect(result.outcome.results[0].status).toBe("error")
				expect(JSON.stringify(result.outcome.results[0].content)).toContain(runError.message)
				if (deferCommit) {
					current.assertHeld()
					expect(current.task.getCommandExecutionEvidence()).toEqual([
						expect.objectContaining({ toolCallId: "joined-reader-error", status: "running" }),
					])
					expect(current.verificationPublications).not.toHaveBeenCalled()
					await current.scheduler.commitDeferredResults()
					await current.scheduler.commitDeferredResults()
				}
				expect(current.host.userMessageContent).toEqual([
					expect.objectContaining({ tool_use_id: "joined-reader-error", is_error: true }),
				])
				expect(JSON.stringify(current.host.userMessageContent)).toContain(runError.message)
				expect(current.task.getCommandExecutionEvidence()).toEqual([
					expect.objectContaining({ toolCallId: "joined-reader-error", status: "failed" }),
				])
				expect(current.verificationPublications).toHaveBeenCalledOnce()
				expect(current.events).toEqual(["joined-reader-error"])
				expect(current.finishedBatches).toEqual(["completed"])
				expect(commandSessionRegistry.capturePendingTaskOutput(current.task)).toEqual([])
				expect(process.abortCalls).toBe(1)
				expect(process.isOutputFinalized).toBe(true)
				expect(process.outputArtifactId).toBeUndefined()
				expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
			} finally {
				process.readerFailure.resolve(runError)
				process.physicalEnd.resolve()
				process.archiveRelease.resolve()
				await terminal.runCompletion
				await observed
			}
		},
	)

	it("does not mutate replacement failure state after a timed-out collector's held error publication loses its original owner", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const terminal = new HeldOwnerTerminal(root, await getRipgrepPathOverlay(), undefined, { abortSucceeds: true })
		provideHeldTerminal(terminal)
		const process = terminal.ownedProcess
		const entered = deferred<void>()
		const release = deferred<void>()
		const current = await owner(
			"prepared-timeout-held-error",
			async (type) => {
				if (type === "error") {
					entered.resolve()
					await release.promise
				}
				return undefined
			},
			true,
			1_000,
		)
		const run = current.run("timeout-held-error")
		let observed: Promise<{ status: "fulfilled" } | { status: "rejected"; reason: unknown }> | undefined
		try {
			expect(
				await Promise.race([process.started.promise.then(() => "started"), run.then(() => "returned")]),
			).toBe("started")
			await vi.advanceTimersByTimeAsync(1_000)
			await process.abortObserved.promise
			process.physicalEnd.resolve()
			process.archiveRelease.resolve()
			await terminal.runCompletion
			await run
			current.assertHeld()
			observed = current.scheduler.commitDeferredResults().then(
				() => ({ status: "fulfilled" as const }),
				(reason: unknown) => ({ status: "rejected" as const, reason }),
			)
			expect(
				await Promise.race([entered.promise.then(() => "error-publication"), observed.then(() => "finished")]),
			).toBe("error-publication")
			const evidence = current.task.getCommandExecutionEvidence()
			const publications = current.verificationPublications.mock.calls.length
			const sayCalls = vi.mocked(current.task.say).mock.calls.length
			current.lifetime.abort()
			// Reset only this supplied public flag while the original error say
			// remains held. This does not simulate a complete Task lifecycle reset.
			current.task.didToolFailInCurrentTurn = false
			release.resolve()
			expect(await observed).toEqual({ status: "fulfilled" })
			expect(current.task.didToolFailInCurrentTurn).toBe(false)
			expect(current.task.getCommandExecutionEvidence()).toEqual(evidence)
			expect(current.verificationPublications.mock.calls).toHaveLength(publications)
			expect(vi.mocked(current.task.say).mock.calls).toHaveLength(sayCalls)
			expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
			expect(current.host.userMessageContent).toEqual([
				expect.objectContaining({ tool_use_id: "timeout-held-error", is_error: true }),
			])
			expect(current.events).toEqual(["timeout-held-error"])
			expect(process.abortCalls).toBe(1)
		} finally {
			release.resolve()
			process.physicalEnd.resolve()
			process.archiveRelease.resolve()
			await terminal.runCompletion
			await observed
		}
	})

	it.each(["owned", "revoked"] as const)(
		"observes an after-ack background I/O failure with %s captured lifetime without mutating an unrelated owner",
		async (ownership) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const terminal = new HeldOwnerTerminal(root, await getRipgrepPathOverlay(), undefined)
			provideHeldTerminal(terminal)
			const process = terminal.ownedProcess
			const current = await owner(`prepared-background-failure-${ownership}`)
			const run = current.run("background-failure", "rg -n needle src/sample.txt", 1)
			const entered = deferred<void>()
			const failPublication = deferred<void>()
			const failureObserved = deferred<void>()
			const failure = new Error("Controlled command status persistence failure")
			void failPublication.promise.catch(() => undefined)
			try {
				expect(
					await Promise.race([process.started.promise.then(() => "started"), run.then(() => "returned")]),
				).toBe("started")
				await vi.advanceTimersByTimeAsync(11_000)
				const outcome = await run
				const id = outcome.results[0].commandResult?.session_id
				if (id === undefined) throw new Error("Background owner returned no numeric session")
				current.assertHeld()
				await current.scheduler.commitDeferredResults()
				expect(current.events).toEqual(["background-failure"])
				const evidenceBefore = current.task.getCommandExecutionEvidence()
				expect(evidenceBefore).toEqual([
					expect.objectContaining({ toolCallId: "background-failure", status: "running" }),
				])
				const sayCalls = vi.mocked(current.task.say).mock.calls.length
				vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
					// The existing diagnostic follows the actual background failure
					// callback; it observes completion rather than replacing that owner.
					if (
						args[0] === "[ExecuteCommandTool] Background command projection failed" &&
						args[1] === failure
					) {
						failureObserved.resolve()
					}
				})
				current.provider.postMessageToWebview.mockImplementation((message: { type: string; text?: string }) => {
					if (message.type === "commandExecutionStatus" && message.text?.includes("background I/O barrier")) {
						entered.resolve()
						return failPublication.promise
					}
					return undefined
				})
				await process.write("2:needle background I/O barrier\n")
				await entered.promise
				if (ownership === "revoked") {
					current.lifetime.abort()
					// Reuse only the supplied fixture's current lifetime port. This is
					// not a full Task reset; the old owner must retain its captured signal.
					const fresh = current.replaceLifetimePort()
					expect(fresh.aborted).toBe(false)
					expect(current.task.getTaskLifetimeCancellationSignal()).toBe(fresh)
					expect(current.task.abort).toBe(false)
				}
				failPublication.reject(failure)
				await failureObserved.promise
				if (ownership === "owned") {
					expect(current.task.getCommandExecutionEvidence()).toEqual([
						expect.objectContaining({ toolCallId: "background-failure", status: "failed" }),
					])
					expect(current.task.didToolFailInCurrentTurn).toBe(true)
					expect(current.task.suspendAfterCurrentTurn).toHaveBeenCalledOnce()
				} else {
					expect(current.task.getCommandExecutionEvidence()).toEqual(evidenceBefore)
					expect(current.task.didToolFailInCurrentTurn).not.toBe(true)
					expect(current.task.suspendAfterCurrentTurn).not.toHaveBeenCalled()
				}
				const statuses = current.provider.postMessageToWebview.mock.calls.length
				await process.write("3:needle raw output still has its original owner\n")
				expect(current.provider.postMessageToWebview.mock.calls).toHaveLength(statuses)
				expect(vi.mocked(current.task.say).mock.calls).toHaveLength(sayCalls)
				expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
				expect(current.host.userMessageContent).toHaveLength(1)
				expect(current.events).toEqual(["background-failure"])
				expect(commandSessionRegistry.resolve(current.task, id)?.process).toBe(process)
				expect(process.isSettled).toBe(false)
				expect(process.abortCalls).toBe(0)
			} finally {
				failPublication.reject(failure)
				process.physicalEnd.resolve()
				process.archiveRelease.resolve()
				await terminal.runCompletion
			}
		},
	)

	it("finishes the durability commit while the same live collector keeps replenishing presentation", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		let now = Date.now()
		vi.spyOn(Date, "now").mockImplementation(() => {
			now += 200
			return now
		})
		const terminal = new HeldOwnerTerminal(root, await getRipgrepPathOverlay(), undefined)
		provideHeldTerminal(terminal)
		const process = terminal.ownedProcess
		const exhausted = deferred<void>()
		let replenish = true
		let generations = 0
		const current = await owner("prepared-opening-liveness", async (type) => {
			if (type === "command_output" && replenish) {
				generations += 1
				if (generations === 32) exhausted.resolve()
				else await process.write(`needle replenished generation ${generations}\n`)
			}
			return undefined
		})
		const run = current.run("opening-live", "rg -n needle src/sample.txt", 1)
		let commit: Promise<void> | undefined
		let original: ReturnType<typeof commandSessionRegistry.resolve>
		try {
			expect(
				await Promise.race([process.started.promise.then(() => "started"), run.then(() => "returned")]),
			).toBe("started")
			await vi.advanceTimersByTimeAsync(11_000)
			const outcome = await run
			const id = outcome.results[0].commandResult?.session_id
			if (id === undefined) throw new Error("Continuing collector returned no numeric session")
			original = commandSessionRegistry.resolve(current.task, id)
			// This supplied platform contract keeps line delivery after continue();
			// Execa removes it, so Execa cannot establish this replenishment oracle.
			expect(process.listenerCount("line")).toBeGreaterThan(0)
			current.assertHeld()
			commit = current.scheduler.commitDeferredResults()
			// The finite producer limit makes an unbounded drain fail an ordering assertion, not a timeout.
			expect(
				await Promise.race([
					commit.then(() => "committed"),
					exhausted.promise.then(() => "producer-exhausted"),
				]),
			).toBe("committed")
			expect(generations).toBeGreaterThan(0)
			expect(original?.process.isSettled).toBe(false)
			expect(commandSessionRegistry.resolve(current.task, id)?.process).toBe(original?.process)
			expect(current.host.userMessageContent).toHaveLength(1)
			expect(current.events).toEqual(["opening-live"])
			expect(current.task.completeCommandExecution).not.toHaveBeenCalled()
		} finally {
			replenish = false
			process.physicalEnd.resolve()
			process.archiveRelease.resolve()
			await terminal.runCompletion
			await commit?.catch(() => undefined)
		}
	})
})
