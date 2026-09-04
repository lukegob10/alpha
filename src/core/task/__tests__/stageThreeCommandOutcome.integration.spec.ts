import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Anthropic } from "@anthropic-ai/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentTurnEvent } from "../../agent/AgentTurnEvents"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { Task } from "../Task"
import type {
	ExitCodeDetails,
	RooTerminal,
	RooTerminalCallbacks,
	RooTerminalProcess,
	RooTerminalProcessResultPromise,
} from "../../../integrations/terminal/types"

const terminalRegistryMock = vi.hoisted(() => ({
	getOrCreateTerminal: vi.fn(),
	getTerminals: vi.fn(() => []),
	releaseTerminalsForTask: vi.fn(),
}))

vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: terminalRegistryMock,
}))

const temporaryDirectories = new Set<string>()

async function removeTemporaryDirectory(directory: string): Promise<void> {
	temporaryDirectories.delete(directory)
	await rm(directory, { recursive: true, force: true })
}

async function createFixtureDirectories(): Promise<{
	workspacePath: string
	storagePath: string
	cleanup: () => Promise<void>
}> {
	let fixtureRoot: string | undefined
	try {
		fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "alpha-stage-three-"))
		temporaryDirectories.add(fixtureRoot)
		const workspacePath = path.join(fixtureRoot, "workspace")
		const storagePath = path.join(fixtureRoot, "storage")
		await Promise.all([mkdir(workspacePath), mkdir(storagePath)])
		await writeFile(path.join(workspacePath, "fixture.txt"), "stage-three fixture\n", "utf8")

		return {
			workspacePath,
			storagePath,
			cleanup: async () => removeTemporaryDirectory(fixtureRoot!),
		}
	} catch (error) {
		if (fixtureRoot) await removeTemporaryDirectory(fixtureRoot)
		throw error
	}
}

afterEach(async () => {
	const directories = [...temporaryDirectories]
	temporaryDirectories.clear()
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

type ToolResultBlock = Anthropic.ToolResultBlockParam

type CompletionGate = {
	promise: Promise<void>
	resolve: () => void
}

function completionGate(): CompletionGate {
	let resolvePromise: (() => void) | undefined
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve
	})
	return {
		promise,
		resolve: () => {
			if (!resolvePromise) throw new Error("Completion gate was already resolved")
			const resolve = resolvePromise
			resolvePromise = undefined
			resolve()
		},
	}
}

function response(callId: string, command: string, verificationChangeSetIds: string[] = []) {
	const argumentsValue = {
		command,
		...(verificationChangeSetIds.length > 0 ? { verification: { change_set_ids: verificationChangeSetIds } } : {}),
	}
	return {
		items: [
			{
				type: "tool_call" as const,
				id: callId,
				name: "execute_command",
				arguments: argumentsValue,
			},
		],
		text: "",
		reasoning: "",
		toolCalls: [
			{
				type: "tool_call" as const,
				id: callId,
				name: "execute_command",
				arguments: argumentsValue,
			},
		],
	}
}

class ControlledProcess extends EventEmitter {
	readonly command: string
	readonly isHot = true
	private readonly completion: Promise<void>
	private resolveCompletion!: () => void
	private readonly callbacks: RooTerminalCallbacks
	private completionStarted = false
	private backgrounded = false
	private aborted = false
	private _isSettled = false

	constructor(command: string, callbacks: RooTerminalCallbacks) {
		super()
		this.command = command
		this.callbacks = callbacks
		this.completion = new Promise<void>((resolve) => {
			this.resolveCompletion = resolve
		})
	}

	get isSettled(): boolean {
		return this._isSettled
	}

	continue = vi.fn(() => {
		this.backgrounded = true
		this.resolveCompletion()
		this.emit("continue")
	})

	abort = vi.fn(() => {
		this.aborted = true
		this.emit("aborted")
	})

	hasUnretrievedOutput = () => false
	getUnretrievedOutput = () => ""
	captureUnretrievedOutput = () => ({ commit: () => undefined, release: () => undefined, output: "" })
	trimRetrievedOutput = () => undefined

	then<TResult1 = void, TResult2 = never>(
		onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this.completion.then(onfulfilled, onrejected)
	}

	catch<TResult = never>(
		onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
	): Promise<void | TResult> {
		return this.completion.catch(onrejected)
	}

	finally(onfinally?: (() => void) | null): Promise<void> {
		return this.completion.finally(onfinally)
	}

	async complete(
		details: ExitCodeDetails,
		output = "receipt without a machine-readable outcome marker",
	): Promise<void> {
		if (this.completionStarted) throw new Error("Controlled process completed more than once")
		this.completionStarted = true
		await this.callbacks.onCompleted(output, this as unknown as RooTerminalProcess)
		this.callbacks.onShellExecutionComplete(details, this as unknown as RooTerminalProcess)
		this._isSettled = true
		this.emit("completed", output)
		this.resolveCompletion()
	}

	wasBackgrounded(): boolean {
		return this.backgrounded
	}

	wasAborted(): boolean {
		return this.aborted
	}
}

type ControlledTerminal = Omit<RooTerminal, "runCommand"> & {
	processForTest?: ControlledProcess
	runStarted: CompletionGate
	runCommand: ReturnType<typeof vi.fn>
}

function controlledTerminal(
	workspacePath: string,
	onRun?: (process: ControlledProcess, callbacks: RooTerminalCallbacks) => void,
): ControlledTerminal {
	const runStarted = completionGate()
	const terminal = {
		provider: "execa" as const,
		id: 1,
		busy: false,
		running: false,
		getCurrentWorkingDirectory: vi.fn(() => workspacePath),
		isClosed: vi.fn(() => false),
		setActiveStream: vi.fn(),
		shellExecutionComplete: vi.fn(),
		getProcessesWithOutput: vi.fn(() => []),
		getUnretrievedOutput: vi.fn(() => ""),
		getLastCommand: vi.fn(() => ""),
		cleanCompletedProcessQueue: vi.fn(),
		runStarted,
		runCommand: vi.fn((command: string, callbacks: RooTerminalCallbacks) => {
			const process = new ControlledProcess(command, callbacks)
			terminal.processForTest = process
			terminal.busy = true
			terminal.running = true
			callbacks.onShellExecutionStarted(1234, process as unknown as RooTerminalProcess)
			runStarted.resolve()
			onRun?.(process, callbacks)
			return process as unknown as RooTerminalProcessResultPromise
		}),
	} as ControlledTerminal

	return terminal
}

type TaskHarness = {
	task: Task
	workspacePath: string
	provider: {
		context: { globalStorageUri: { fsPath: string } }
		getState: ReturnType<typeof vi.fn>
		postMessageToWebview: ReturnType<typeof vi.fn>
		runWorkspaceMutation: ReturnType<typeof vi.fn>
		recordParentVerificationEvidence: ReturnType<typeof vi.fn>
		reservePrimaryMutation: ReturnType<typeof vi.fn>
		releasePrimaryMutation: ReturnType<typeof vi.fn>
		recordPrimaryMutation: ReturnType<typeof vi.fn>
		captureCommandVerification: ReturnType<typeof vi.fn>
	}
	toolResults: () => ToolResultBlock[]
	cleanup: () => Promise<void>
}

async function createTask(approval: "approve" | "deny" = "approve"): Promise<TaskHarness> {
	const fixture = await createFixtureDirectories()
	const lifetimeController = new AbortController()
	const provider = {
		context: { globalStorageUri: { fsPath: fixture.storagePath } },
		getState: vi.fn().mockResolvedValue({ terminalShellIntegrationDisabled: true }),
		postMessageToWebview: vi.fn(),
		runWorkspaceMutation: vi.fn(async (_task: Task, _label: string, run: () => Promise<void>) => run()),
		recordParentVerificationEvidence: vi.fn().mockResolvedValue(undefined),
		reservePrimaryMutation: vi.fn().mockResolvedValue(undefined),
		releasePrimaryMutation: vi.fn().mockResolvedValue(undefined),
		recordPrimaryMutation: vi.fn().mockResolvedValue(undefined),
		captureCommandVerification: vi.fn().mockResolvedValue(undefined),
	}
	const userMessageContent: ToolResultBlock[] = []

	try {
		const task = Object.assign(Object.create(Task.prototype), {
			abort: false,
			taskId: "stage-three-command-outcome",
			taskKind: "primary",
			subagentRole: undefined,
			workspacePath: fixture.workspacePath,
			lastMessageTs: 1_700_000_000_000,
			didRejectTool: false,
			didToolFailInCurrentTurn: false,
			consecutiveMistakeCount: 0,
			userMessageContent,
			userMessageContentReady: false,
			currentStreamingDidCheckpoint: true,
			commandExecutionEvidence: new Map(),
			persistedToolResultIds: new Set<string>(),
			pendingCommandVerification: Promise.resolve(),
			checkpointSave: vi.fn(async () => undefined),
			providerRef: new WeakRef(provider),
			rooIgnoreController: { validateCommand: vi.fn(() => undefined) },
			getTaskMode: vi.fn(async () => "code"),
			shouldStopRepeatedToolCall: vi.fn(() => false),
			toolRepetitionDetector: {
				recordOutcome: vi.fn(() => ({ action: "continue" as const })),
			},
			getTaskLifetimeCancellationSignal: vi.fn(() => lifetimeController.signal),
			ask: vi.fn(async (type: string) =>
				type === "command_output"
					? { response: "messageResponse", text: "Continue in the background." }
					: { response: approval === "approve" ? "yesButtonClicked" : "noButtonClicked" },
			),
			say: vi.fn(async () => undefined),
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			supersedePendingAsk: vi.fn(),
			terminalProcess: undefined,
			pushToolResultToUserContent(result: ToolResultBlock) {
				if (userMessageContent.some((item) => item.tool_use_id === result.tool_use_id)) return false
				userMessageContent.push(result)
				return true
			},
			// These are the narrow lifecycle seams needed to call the real Task abort
			// method on a prototype harness without constructing a full extension Task.
			waitForOwnedLifecycle: vi.fn(async () => undefined),
			flushApiConversationHistoryPersistence: vi.fn(async () => undefined),
			invalidateStreamingPreviewEpoch: vi.fn(),
			drainStreamingPreviews: vi.fn(async () => undefined),
			releaseSubagentReviewBarrierIfSettled: vi.fn(),
			emitFinalTokenUsageUpdate: vi.fn(),
			emit: vi.fn(),
			dispose: vi.fn(() => lifetimeController.abort()),
			saveClineMessages: vi.fn(async () => undefined),
			appendAgentTurnEvent: vi.fn(async () => undefined),
			flushAgentTurnEvents: vi.fn(async () => undefined),
			finishCanonicalLifecycleCancellation: vi.fn(async () => undefined),
			canonicalLifecycleQueue: Promise.resolve(),
		}) as Task

		return {
			task,
			workspacePath: fixture.workspacePath,
			provider,
			toolResults: () => userMessageContent,
			cleanup: fixture.cleanup,
		}
	} catch (error) {
		await fixture.cleanup()
		throw error
	}
}

async function withTaskHarness<T>(
	testBody: (harness: TaskHarness) => Promise<T>,
	approval: "approve" | "deny" = "approve",
): Promise<T> {
	const harness = await createTask(approval)
	try {
		return await testBody(harness)
	} finally {
		await harness.cleanup()
	}
}

function createScheduler(
	harness: TaskHarness,
	events: AgentTurnEvent[],
	options: { preserveAbortedResults?: boolean } = {},
): ToolScheduler {
	const registry = new ToolRegistry()
	const executionHost = harness.task as unknown as ToolExecutionHost
	return new ToolScheduler({
		task: harness.task,
		executionHost,
		registry,
		mode: "code",
		validateCall: () => undefined,
		preserveAbortedResults: options.preserveAbortedResults,
		onEvent: (event) => {
			events.push(event)
		},
	})
}

function installTerminal(terminal: ControlledTerminal): void {
	terminalRegistryMock.getOrCreateTerminal.mockResolvedValue(terminal)
}

function toolResultEvents(events: AgentTurnEvent[]) {
	return events.filter((event) => event.type === "tool_result")
}

function verificationEvents(events: AgentTurnEvent[]) {
	return events.filter((event) => event.type === "verification_result")
}

function resultIds(harness: TaskHarness): string[] {
	return harness.toolResults().map((result) => result.tool_use_id)
}

describe("Stage Three command outcome integration", () => {
	it("reports exit 0 as canonical success through the real registry tool", async () => {
		await withTaskHarness(async (harness) => {
			const events: AgentTurnEvent[] = []
			const terminal = controlledTerminal(harness.workspacePath)
			installTerminal(terminal)

			const run = createScheduler(harness, events).run(response("exit-zero", "pnpm test"))
			await terminal.runStarted.promise
			await terminal.processForTest!.complete({ exitCode: 0 })
			const outcome = await run

			expect(outcome.status).toBe("completed")
			expect(outcome.results).toEqual([
				expect.objectContaining({
					callId: "exit-zero",
					name: "execute_command",
					status: "success",
					executionStatus: "success",
					exitCode: 0,
				}),
			])
			expect(toolResultEvents(events)).toEqual([
				expect.objectContaining({ callId: "exit-zero", name: "execute_command", status: "success" }),
			])
			expect(verificationEvents(events)).toEqual([
				expect.objectContaining({
					commandCategory: "test",
					toolName: "execute_command",
					status: "success",
					exitCode: 0,
				}),
			])
			expect(harness.task.getCommandExecutionEvidence()).toEqual([
				expect.objectContaining({
					toolCallId: "exit-zero",
					status: "succeeded",
					exitCode: 0,
					command: "pnpm test",
				}),
			])
			expect(resultIds(harness)).toEqual(["exit-zero"])
		})
	})

	it("reports a nonzero exit as failed even when receipt text is otherwise positive", async () => {
		await withTaskHarness(async (harness) => {
			const events: AgentTurnEvent[] = []
			const terminal = controlledTerminal(harness.workspacePath)
			installTerminal(terminal)

			const run = createScheduler(harness, events).run(response("exit-nonzero", "pnpm test"))
			await terminal.runStarted.promise
			await terminal.processForTest!.complete({ exitCode: 17 }, "PASS: all checks passed in the output stream")
			const outcome = await run

			expect(outcome.results[0]).toMatchObject({
				callId: "exit-nonzero",
				status: "error",
				executionStatus: "error",
				exitCode: 17,
			})
			expect(toolResultEvents(events)).toEqual([
				expect.objectContaining({ callId: "exit-nonzero", status: "error" }),
			])
			expect(verificationEvents(events)).toEqual([
				expect.objectContaining({ commandCategory: "test", status: "error", exitCode: 17 }),
			])
			expect(harness.task.getCommandExecutionEvidence()).toEqual([
				expect.objectContaining({ toolCallId: "exit-nonzero", status: "failed", exitCode: 17 }),
			])
			expect(resultIds(harness)).toEqual(["exit-nonzero"])
		})
	})

	it("records denied approval as denied evidence without admitting a terminal process", async () => {
		await withTaskHarness(async (harness) => {
			const events: AgentTurnEvent[] = []
			const terminal = controlledTerminal(harness.workspacePath)
			installTerminal(terminal)

			const outcome = await createScheduler(harness, events).run(response("denied", "pnpm test"))

			expect(outcome.results[0]).toMatchObject({ callId: "denied", status: "denied" })
			expect(terminal.runCommand).not.toHaveBeenCalled()
			expect(toolResultEvents(events)).toEqual([expect.objectContaining({ callId: "denied", status: "denied" })])
			expect(verificationEvents(events)).toEqual([
				expect.objectContaining({ commandCategory: "test", status: "denied" }),
			])
			expect(harness.task.getCommandExecutionEvidence()).toEqual([
				expect.objectContaining({ toolCallId: "denied", status: "denied" }),
			])
			expect(resultIds(harness)).toEqual(["denied"])
		}, "deny")
	})

	it("surfaces command-admission failures without treating them as shell integration fallback", async () => {
		await withTaskHarness(async (harness) => {
			harness.provider.captureCommandVerification.mockRejectedValue(new Error("verification admission failed"))
			const events: AgentTurnEvent[] = []
			const terminal = controlledTerminal(harness.workspacePath)
			installTerminal(terminal)

			const outcome = await createScheduler(harness, events).run(
				response("admission-failure", "pnpm test", ["change-set-1"]),
			)
			const result = outcome.results[0]

			expect(outcome.status).toBe("completed")
			expect(result).toMatchObject({
				callId: "admission-failure",
				name: "execute_command",
				status: "error",
				executionStatus: "error",
			})
			expect(result?.content).toEqual(expect.stringContaining("verification admission failed"))
			expect(toolResultEvents(events)).toEqual([
				expect.objectContaining({ callId: "admission-failure", status: "error" }),
			])
			expect(verificationEvents(events)).toEqual([
				expect.objectContaining({ commandCategory: "test", status: "error" }),
			])
			expect(terminal.runCommand).not.toHaveBeenCalled()
			expect(harness.provider.postMessageToWebview).not.toHaveBeenCalled()
			expect(harness.task.say).not.toHaveBeenCalledWith("shell_integration_warning")
			expect(harness.task.supersedePendingAsk).not.toHaveBeenCalled()
			expect(harness.task.getCommandExecutionEvidence()).toEqual([
				expect.objectContaining({ toolCallId: "admission-failure", status: "failed" }),
			])
			expect(resultIds(harness)).toEqual(["admission-failure"])
		})
	})

	it("classifies a backgrounded still-running command as running, not passing progress", async () => {
		await withTaskHarness(async (harness) => {
			const events: AgentTurnEvent[] = []
			const backgrounded = completionGate()
			const terminal = controlledTerminal(harness.workspacePath)
			// Produce output through the real ExecuteCommandTool callback path. The
			// approval response for command output moves the process to the background
			// without fabricating a terminal completion event.
			terminal.runCommand.mockImplementation((command: string, callbacks: RooTerminalCallbacks) => {
				const process = new ControlledProcess(command, callbacks)
				terminal.processForTest = process
				terminal.busy = true
				terminal.running = true
				callbacks.onShellExecutionStarted(1234, process as unknown as RooTerminalProcess)
				terminal.runStarted.resolve()
				void Promise.resolve(
					callbacks.onLine("background output\n", process as unknown as RooTerminalProcess),
				).then(() => {
					backgrounded.resolve()
				})
				return process as unknown as RooTerminalProcessResultPromise
			})
			installTerminal(terminal)

			const outcome = await createScheduler(harness, events).run(response("still-running", "pnpm test"))
			await backgrounded.promise

			expect(outcome.status).toBe("completed")
			expect(outcome.results[0]).toMatchObject({ callId: "still-running", status: "success" })
			expect(outcome.results[0]?.executionStatus).toBe("running")
			expect(toolResultEvents(events)).toEqual([
				expect.objectContaining({ callId: "still-running", status: "success" }),
			])
			expect(verificationEvents(events)).toHaveLength(0)
			expect(harness.task.getCommandExecutionEvidence()).toEqual([
				expect.objectContaining({ toolCallId: "still-running", status: "running" }),
			])
			expect(resultIds(harness)).toEqual(["still-running"])
			expect(terminal.processForTest?.isSettled).toBe(false)
			// The process was deliberately left running for the assertions above. Join
			// the real Task cancellation path before the harness removes its workspace.
			await harness.task.abortTask()
		})
	})

	it("keeps primary command evidence cancelled when a late exit 0 arrives", async () => {
		await withTaskHarness(async (harness) => {
			const events: AgentTurnEvent[] = []
			const terminal = controlledTerminal(harness.workspacePath)
			installTerminal(terminal)

			const run = createScheduler(harness, events, { preserveAbortedResults: true }).run(
				response("cancelled-late-close", "pnpm test"),
			)
			await terminal.runStarted.promise

			// This calls the real Task abort path on a prototype harness. The narrow
			// lifecycle seams in createTask keep persistence/UI teardown inert while
			// preserving the command-evidence transition that cancellation owns.
			await harness.task.abortTask()
			await terminal.processForTest!.complete({ exitCode: 0 }, "late successful close after cancellation")
			const outcome = await run

			expect(outcome.status).toBe("aborted")
			expect(outcome.results[0]).toMatchObject({
				callId: "cancelled-late-close",
				status: "cancelled",
				executionStatus: "cancelled",
			})
			expect(toolResultEvents(events)).toEqual([
				expect.objectContaining({ callId: "cancelled-late-close", status: "cancelled" }),
			])
			expect(verificationEvents(events)).toEqual([
				expect.objectContaining({ commandCategory: "test", status: "cancelled" }),
			])
			const evidence = harness.task.getCommandExecutionEvidence()
			expect(evidence).toEqual([
				expect.objectContaining({ toolCallId: "cancelled-late-close", status: "cancelled" }),
			])
			expect(evidence[0]?.exitCode).toBeUndefined()
			expect(resultIds(harness)).toEqual(["cancelled-late-close"])
		})
	})
})
