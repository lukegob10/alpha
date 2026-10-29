import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { EventEmitter } from "node:events"

import { TelemetryService } from "@alpha-code/telemetry"
import type { ProviderSettings } from "@alpha-code/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { buildApiHandler, type ApiHandler } from "../../../api"
import { getApiRequestTimeout } from "../../../api/providers/utils/timeout-config"
import {
	ApiStreamDeadlineError,
	createApiStreamError,
	createApiStreamOutcome,
	type ApiStream,
	type ApiStreamChunk,
} from "../../../api/transform/stream"
import { AgentRetryPolicy } from "../../agent/AgentRetryPolicy"
import { createAgentResponse } from "../../agent/AgentResponse"
import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import type { AgentStepSnapshot } from "../../agent/AgentStepContextBuilder"
import type { AgentTurnEvent } from "../../agent/AgentTurnEvents"
import { AgentLifecycleJournal, type AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { readApiMessages, saveApiMessages, type ApiMessage } from "../../task-persistence/apiMessages"
import { ProviderTranscriptStoreError } from "../../task-persistence/ProviderTranscriptStore"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { commandSessionRegistry } from "../../tools/CommandSessionRegistry"
import type { AlphaTerminalProcess } from "../../../integrations/terminal/types"
import { OutputInterceptor } from "../../../integrations/terminal/OutputInterceptor"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import type { AlphaProvider } from "../../webview/AlphaProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { Task } from "../Task"

vi.mock("../../../api", async (original) => ({
	...(await original<typeof import("../../../api")>()),
	buildApiHandler: vi.fn(),
}))
vi.mock("../../../api/providers/utils/timeout-config", async (original) => {
	const actual = await original<typeof import("../../../api/providers/utils/timeout-config")>()
	return { ...actual, getApiRequestTimeout: vi.fn(actual.getApiRequestTimeout) }
})
vi.mock("../../task-persistence/apiMessages", async (original) => {
	const actual = await original<typeof import("../../task-persistence/apiMessages")>()
	return { ...actual, saveApiMessages: vi.fn(actual.saveApiMessages) }
})
vi.mock("../../ignore/AlphaIgnoreController", () => ({
	AlphaIgnoreController: class {
		async initialize() {}
		dispose() {}
	},
}))
vi.mock("../../protect/AlphaProtectedController", () => ({ AlphaProtectedController: class {} }))
vi.mock("../../context-tracking/FileContextTracker", () => ({
	FileContextTracker: class {
		dispose() {}
	},
}))
vi.mock("../../../integrations/editor/DiffViewProvider", () => ({
	DiffViewProvider: class {
		isEditing = false
		async reset() {}
		async revertChanges() {}
	},
}))
vi.mock("../../mentions/processUserContentMentions", () => ({
	processUserContentMentions: vi.fn(async ({ userContent }) => ({ content: userContent })),
}))
vi.mock("../../environment/getEnvironmentDetails", async (original) => ({
	...(await original<typeof import("../../environment/getEnvironmentDetails")>()),
	captureEnvironmentDetails: vi.fn(async () => ({ details: "", commit() {}, release() {} })),
}))
vi.mock("../../agent/CompletionHooks", async (original) => ({
	...(await original<typeof import("../../agent/CompletionHooks")>()),
	readCompletionHookConfig: vi.fn(() => ({ stop: [], subagentStop: [] })),
}))
vi.mock("../build-tools", async (original) => ({
	...(await original<typeof import("../build-tools")>()),
	buildNativeToolsArrayWithRestrictions: vi.fn(),
}))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => (resolve = finish))
	return { promise, resolve }
}

const opaqueState = "opaque-reasoning+/=\r\n"
const partialText = "The answer is partly available."
const transportFailure = (extra: Record<string, unknown> = {}) =>
	Object.assign(new Error("Connection reset during provider streaming."), {
		retryable: true,
		retryCategory: "transport",
		...extra,
	})
type Script = (attempt: number, task: Task) => ApiStream
type TaskHooks = {
	getSystemPrompt: Task["getSystemPrompt"]
	updateAlphaMessage: Task["updateAlphaMessage"]
	scheduleStreamingPreview: Task["scheduleStreamingPreview"]
	deliverAgentMessages: Task["deliverAgentMessages"]
	maybeWaitForProviderRateLimit: Task["maybeWaitForProviderRateLimit"]
	maybeCompactAfterTurn: Task["maybeCompactAfterTurn"]
	saveAlphaMessages: Task["saveAlphaMessages"]
	retrySaveApiConversationHistory: Task["retrySaveApiConversationHistory"]
	summarizeReasoning: Task["summarizeReasoning"]
	appendAgentTurnEvent: Task["appendAgentTurnEvent"]
	flushAgentTurnEvents: Task["flushAgentTurnEvents"]
	waitForRetryDecision: Task["waitForRetryDecision"]
	persistAssistantResponseBeforeEffects: Task["persistAssistantResponseBeforeEffects"]
}
const fixtures: Array<{ cleanup: () => Promise<void> }> = []

async function harness(
	script: Script,
	policy: ConstructorParameters<typeof AgentRetryPolicy>[0] = {},
	options: {
		realCompletion?: boolean
		taskKind?: Task["taskKind"]
		apiProvider?: ProviderSettings["apiProvider"]
		onReadEffect?: () => void
		finalizeEarlyRead?: (callId: string) => Promise<void>
	} = {},
) {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	const storage = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "alpha-stream-recovery-"))
	const cwd = path.join(storage, "workspace")
	await fs.mkdir(cwd)
	const taskId = "stream-recovery"
	const journal = await AgentLifecycleJournal.open(taskId, storage)
	const effectSettled = deferred()
	const effect = vi.fn<ToolDescriptor["execute"]>(async ({ callbacks }) => {
		callbacks.pushToolResult("read completed")
		effectSettled.resolve()
		options.onReadEffect?.()
	})
	const registry = new ToolRegistry({ includeBuiltIns: false })
	for (const name of ["read_file", "apply_patch"] as const) {
		registry.register({
			name,
			aliases: [],
			schema: { type: "function", function: { name, description: name, parameters: { type: "object" } } },
			capabilities: {
				concurrency: "serial",
				sideEffects: name === "read_file" ? "none" : "workspace",
				controlFlow: false,
				requiresApproval: true,
			},
			execute: effect,
		})
	}
	registry.register({
		name: "exec_command",
		aliases: [],
		schema: {
			type: "function",
			function: {
				name: "exec_command",
				description: "An approved isolated command read",
				parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
			},
		},
		capabilities: {
			concurrency: "serial",
			sideEffects: "workspace",
			controlFlow: false,
			requiresApproval: true,
			parallelCommandRead: true,
		},
		prepareParallelCommand: async (context) => {
			if (!(await context.callbacks.askApproval("command", "git status --short"))) return undefined
			return {
				scope: cwd,
				run: async (approvedCallbacks) => {
					await effect({ ...context, callbacks: { ...context.callbacks, ...approvedCallbacks } })
					return async () => options.finalizeEarlyRead?.(context.call.id!)
				},
			}
		},
		isParallelCommandReadReady: async () => true,
		execute: effect,
	})
	const initialSurface = createTaskToolSurface({
		registry,
		mode: "code",
		applyProfile: false,
		approvalMode: "ask",
		autoApprovalEnabled: false,
		readGrant: { enabled: false, workspaceRoot: cwd, showIgnoredFiles: false },
		execution: { workspaceRoots: [cwd] },
	})
	const live = { mode: "code", prompt: "Original system instructions.", autoApprovalEnabled: false }
	const events: AgentTurnEvent[] = []
	const snapshots: Array<Pick<AgentStepSnapshot<ApiHandler>, "context" | "digests">> = []
	const capturedRequests: Array<{ getRequest(): unknown; hasRetainedRequest?: () => boolean }> = []
	const provider = {
		context: { globalStorageUri: { fsPath: storage } },
		getState: async () => ({ ...live, autoCondenseContext: false, requestDelaySeconds: 0, customModes: [] }),
		getValues: () => ({ ...live }),
		getSkillsManager: async () => undefined,
		getAgentLifecycleSnapshot: () => journal.getSnapshot(),
		replayAgentLifecycle: () => journal.replay(),
		publishAgentLifecycleEvent: async (input: AgentLifecycleEventInput, options?: { durable?: boolean }) => ({
			accepted: true,
			...(await journal.append(input, options)),
		}),
		postStateToWebview: vi.fn(async () => undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
		postMessageToWebview: vi.fn(async () => undefined),
		postTaskQueueToWebview: vi.fn(async () => undefined),
		prepareTaskCompletionLifecycle: vi.fn(async () => undefined),
		rollbackTaskCompletionLifecycle: vi.fn(async () => undefined),
		log: vi.fn(),
	}
	const configuration: ProviderSettings = {
		apiProvider: options.apiProvider ?? "openai",
		openAiModelId: "original-model",
		openAiApiKey: "synthetic-test-key",
	}
	let task!: Task
	let attempts = 0
	const createMessage = vi.fn<ApiHandler["createMessage"]>(async function* () {
		const step = task["currentAgentStep"]!
		const snapshot = step.snapshot
		snapshots.push({ context: snapshot.context, digests: snapshot.digests })
		capturedRequests.push(step)
		yield* script(++attempts, task)
	})
	const originalDispose = vi.fn()
	const replacementDispose = vi.fn()
	const original: ApiHandler = {
		getModel: () => ({
			id: "original-model",
			info: { contextWindow: 128_000, maxTokens: 4096, supportsPromptCache: false },
		}),
		countTokens: vi.fn(async () => 0),
		createMessage,
		streamCapabilities: { lifecycle: true, cancellation: true },
		dispose: originalDispose,
	}
	const replacement: ApiHandler = {
		...original,
		getModel: () => ({ ...original.getModel(), id: "replacement-model" }),
		dispose: replacementDispose,
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
			yield { type: "text", text: "A replacement provider must not handle recovery." }
			yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
		}),
	}
	vi.mocked(buildApiHandler).mockReturnValue(original)
	task = new Task({
		provider: provider as unknown as AlphaProvider,
		apiConfiguration: configuration,
		taskId,
		task: "Finish the answer safely.",
		taskMode: "code",
		taskKind: options.taskKind,
		taskApprovalMode: "ask",
		taskApiConfigName: "recovery-fixture",
		workspacePath: cwd,
		startTask: false,
		enableCheckpoints: false,
		toolApprovalReviewer: async () => ({ decision: "approve" }),
	})
	const hooks = task as unknown as TaskHooks
	task.api = original
	Object.defineProperty(task, "agentRetryPolicy", {
		value: new AgentRetryPolicy({
			maxAttempts: 2,
			baseDelayMs: 0,
			jitter: "none",
			...policy,
		}),
	})
	vi.mocked(buildNativeToolsArrayWithRestrictions).mockImplementation(async () => ({
		tools: structuredClone([...initialSurface.schemas]),
		allowedFunctionNames: [...initialSurface.allowedFunctionNames],
		surface: initialSurface,
	}))
	vi.spyOn(task, "getTaskMode").mockImplementation(async () => live.mode)
	vi.spyOn(hooks, "getSystemPrompt").mockImplementation(async () => live.prompt)
	vi.spyOn(task, "getTokenUsage").mockReturnValue({
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCost: 0,
		contextTokens: 0,
	})
	vi.spyOn(task, "say").mockImplementation(async (say, text, _images, partial) => {
		task.alphaMessages.push({ ts: task.alphaMessages.length + 1, type: "say", say, text, partial })
	})
	vi.spyOn(task, "emitFinalTokenUsageUpdate").mockImplementation(() => undefined)
	vi.spyOn(task, "ask").mockImplementation(async () => {
		task.abort = true
		return { response: "noButtonClicked" }
	})
	vi.spyOn(task, "recordCompletionCandidate").mockImplementation(() => undefined)
	vi.spyOn(task, "waitForCompletionGateDecision").mockResolvedValue({ allowed: true, modelCanResolveRejection: true })
	vi.spyOn(task, "presentCompletionResult").mockResolvedValue(undefined)
	if (options.realCompletion) {
		vi.spyOn(task, "getCompletionGateDecision").mockResolvedValue({
			allowed: true,
			modelCanResolveRejection: true,
		})
	} else {
		vi.spyOn(task, "finalizeTaskCompletion").mockImplementation(async () => {
			task.markCompleted()
			return true
		})
	}
	for (const method of [
		"updateAlphaMessage",
		"scheduleStreamingPreview",
		"deliverAgentMessages",
		"maybeWaitForProviderRateLimit",
		"maybeCompactAfterTurn",
	] as const) {
		vi.spyOn(hooks, method).mockImplementation(async () => undefined)
	}
	vi.spyOn(hooks, "saveAlphaMessages").mockResolvedValue(true)
	vi.spyOn(hooks, "retrySaveApiConversationHistory").mockResolvedValue(false)
	vi.spyOn(hooks, "summarizeReasoning").mockImplementation(() => undefined)
	vi.spyOn(hooks, "appendAgentTurnEvent").mockImplementation(async (event) => {
		events.push(event)
	})
	vi.spyOn(hooks, "flushAgentTurnEvents").mockResolvedValue(undefined)
	let running: Promise<void> | undefined
	const run = () => {
		// Native start/create owns this promise before model work can resume after its first await.
		running = task["ownBackgroundLifecycle"](
			"start",
			task["initiateTaskLoop"]([{ type: "text", text: "Finish the answer safely." }]),
		)
		return running
	}
	fixtures.push({
		cleanup: async () => {
			effectSettled.resolve()
			await task.abortTask(true).catch(() => undefined)
			await running?.catch(() => undefined)
			await task.waitForTermination().catch(() => undefined)
			await journal.close()
			await fs.rm(storage, { recursive: true, force: true })
		},
	})
	return {
		task,
		provider,
		hooks,
		live,
		original,
		replacement,
		originalDispose,
		replacementDispose,
		replaceProfile: () => {
			vi.mocked(buildApiHandler).mockReturnValue(replacement)
			task.updateApiConfiguration({ ...configuration, openAiModelId: "replacement-model" })
		},
		createMessage,
		snapshots,
		capturedRequests,
		events,
		journal,
		effect,
		effectSettled: effectSettled.promise,
		run,
		history: () => readApiMessages({ taskId, globalStoragePath: storage }),
	}
}

beforeEach(() => vi.clearAllMocks())
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	vi.restoreAllMocks()
})

describe("Task canonical response admission", () => {
	const thinking = {
		value: "",
		id: "retained-thinking",
		metadata: { signature: "retained-signature", complete: true },
		modelId: "original-model",
		modelVendor: "copilot",
		modelVersion: "original-model",
	}
	const reasoningCases: Array<{
		name: string
		chunk: Extract<ApiStreamChunk, { type: "reasoning" }>
		taskKind?: Task["taskKind"]
		apiProvider?: ProviderSettings["apiProvider"]
	}> = [
		{ name: "visible reasoning", chunk: { type: "reasoning", text: "Inspecting the requested module." } },
		{
			name: "visible host thinking",
			chunk: { type: "reasoning", text: "Inspecting the requested module.", vscodeLmThinking: thinking },
			apiProvider: "vscode-lm",
		},
		{
			name: "empty host thinking",
			chunk: { type: "reasoning", text: "", vscodeLmThinking: thinking },
			apiProvider: "vscode-lm",
		},
		{
			name: "managed-child thinking",
			chunk: { type: "reasoning", text: "", vscodeLmThinking: thinking },
			taskKind: "subagent",
			apiProvider: "vscode-lm",
		},
		{
			name: "opaque reasoning",
			chunk: {
				type: "reasoning",
				text: "",
				encryptedContent: opaqueState,
				id: "retained-reasoning",
				summary: [],
			},
		},
		{ name: "sealed empty reasoning", chunk: { type: "reasoning", text: "", signature: "retained-signature" } },
		{
			name: "Gemini replay state",
			chunk: {
				type: "reasoning",
				text: "",
				geminiResponse: { modelId: "original-model", parts: [{ thoughtSignature: "retained-signature" }] },
			},
			apiProvider: "gemini",
		},
	]

	it.each(reasoningCases)(
		"commits completed $name before continuing the real Task turn",
		async ({ chunk, taskKind, apiProvider }) => {
			let fixture!: Awaited<ReturnType<typeof harness>>
			fixture = await harness(
				async function* (attempt) {
					if (attempt === 1) {
						yield chunk
						yield createApiStreamOutcome({
							status: "completed",
							semanticOutputObserved: chunk.text.length > 0,
						})
						return
					}
					expect(attempt).toBe(2)
					expect((await fixture.history()).at(-1)?.agentResponseItems).toEqual([chunk])
					yield { type: "text", text: "The answer after retained reasoning." }
					yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
				},
				{},
				{ taskKind, apiProvider },
			)

			await fixture.run()

			expect(fixture.task.isCompleted()).toBe(true)
			expect(fixture.createMessage).toHaveBeenCalledTimes(2)
			expect(fixture.task.ask).not.toHaveBeenCalled()
			expect(fixture.effect).not.toHaveBeenCalled()
			const assistant = (await fixture.history()).filter((message) => message.role === "assistant")
			expect(assistant).toHaveLength(2)
			expect(assistant[0].agentResponseItems).toEqual([chunk])
			expect(assistant[0].agentResponseOutcome).toEqual({ status: "completed" })
			expect(fixture.createMessage.mock.calls[1][1].filter((message) => message.role === "user")).toHaveLength(1)
			expect(JSON.stringify(fixture.createMessage.mock.calls[1][1])).not.toContain("You did not use a tool")
			if (chunk.vscodeLmThinking || chunk.geminiResponse) {
				expect(JSON.stringify(fixture.createMessage.mock.calls[1][1])).toContain("retained-signature")
			}
			if (chunk.encryptedContent) {
				expect(JSON.stringify(fixture.createMessage.mock.calls[1][1])).toContain("opaque-reasoning+/=")
			}
			expect(fixture.events.filter((event) => event.type === "retry")).toHaveLength(0)
			expect(fixture.events.filter((event) => event.type === "response_terminal")).toEqual([
				{ type: "response_terminal", status: "completed" },
				{ type: "response_terminal", status: "completed" },
			])
			expect(fixture.events.filter((event) => event.type === "turn_completed")).toHaveLength(1)
			expect(fixture.task.finalizeTaskCompletion).toHaveBeenCalledOnce()
		},
	)

	it("commits a successful continuation-only boundary without empty-response recovery", async () => {
		const fixture = await harness(async function* (attempt) {
			if (attempt === 1) {
				yield createApiStreamOutcome({ status: "completed", requiresContinuation: true })
				return
			}
			expect(attempt).toBe(2)
			yield { type: "text", text: "The requested continuation completed." }
			yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
		})

		await fixture.run()

		expect(fixture.task.isCompleted()).toBe(true)
		expect(fixture.createMessage).toHaveBeenCalledTimes(2)
		expect(fixture.task.ask).not.toHaveBeenCalled()
		const assistant = (await fixture.history()).filter((message) => message.role === "assistant")
		expect(assistant).toHaveLength(2)
		expect(assistant[0]).toMatchObject({
			content: [],
			agentResponseItems: [],
			agentResponseOutcome: { status: "completed", requiresContinuation: true },
		})
		expect(fixture.events.filter((event) => event.type === "retry")).toHaveLength(0)
		expect(fixture.events.filter((event) => event.type === "response_terminal")).toHaveLength(2)
		expect(fixture.events.filter((event) => event.type === "turn_completed")).toHaveLength(1)
		expect(fixture.task.finalizeTaskCompletion).toHaveBeenCalledOnce()
	})

	it.each(["failed", "incomplete", "cancelled"] as const)(
		"persists replay state from an explicit %s reasoning-only response without continuing",
		async (status) => {
			const chunk = { type: "reasoning" as const, text: "", vscodeLmThinking: thinking }
			const fixture = await harness(async function* () {
				yield chunk
				yield createApiStreamOutcome({ status, reason: "Provider terminal boundary.", retryable: false })
			})

			await fixture.run()

			expect(fixture.task.isCompleted()).toBe(false)
			expect(fixture.createMessage).toHaveBeenCalledOnce()
			expect(fixture.effect).not.toHaveBeenCalled()
			const assistant = (await fixture.history()).filter((message) => message.role === "assistant")
			expect(assistant).toHaveLength(1)
			expect(assistant[0].agentResponseItems).toEqual([chunk])
			expect(assistant[0].agentResponseOutcome).toMatchObject({ status, retryable: false })
			expect(fixture.events.filter((event) => event.type === "response_terminal")).toHaveLength(1)
			expect(fixture.events.filter((event) => event.type === "retry")).toHaveLength(0)
			expect(fixture.task.finalizeTaskCompletion).not.toHaveBeenCalled()
		},
	)

	it("keeps a genuinely empty completed response on the existing bounded retry path", async () => {
		const fixture = await harness(async function* (attempt) {
			if (attempt === 1) {
				yield { type: "usage", inputTokens: 10, outputTokens: 0 }
				yield createApiStreamOutcome({ status: "completed" })
				return
			}
			expect(attempt).toBe(2)
			yield { type: "text", text: "The recovered answer." }
			yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
		})
		fixture.live.autoApprovalEnabled = true

		await fixture.run()

		expect(fixture.task.isCompleted()).toBe(true)
		expect(fixture.createMessage).toHaveBeenCalledTimes(2)
		expect(fixture.task.ask).not.toHaveBeenCalled()
		expect(fixture.events.filter((event) => event.type === "retry")).toHaveLength(1)
		expect((await fixture.history()).filter((message) => message.role === "assistant")).toHaveLength(1)
		expect(fixture.task.finalizeTaskCompletion).toHaveBeenCalledOnce()
	})
})

describe("Task committed partial stream recovery", () => {
	it.each([undefined, 1_000])(
		"recovers a long initial response from committed history with an explicit recovery allowance of %s",
		async (maxElapsedMs) => {
			let elapsed = 0
			vi.spyOn(performance, "now").mockImplementation(() => elapsed)
			const fixture = await harness(
				async function* (attempt) {
					if (attempt === 1) {
						yield { type: "text", text: partialText }
						elapsed = 600_000
						throw transportFailure()
					}
					yield { type: "text", text: "Recovered after the long response." }
					yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
				},
				{ ...(maxElapsedMs !== undefined ? { maxElapsedMs } : {}) },
			)
			await fixture.run()
			expect(fixture.task.isCompleted()).toBe(true)
			expect(fixture.createMessage).toHaveBeenCalledTimes(2)
			const failed = (await fixture.history()).filter(
				(message) => message.agentResponseOutcome?.status === "failed",
			)
			expect(failed).toHaveLength(1)
			expect(fixture.effect).not.toHaveBeenCalled()
		},
	)

	it("keeps rejected complete tool arguments out of task diagnostics", async () => {
		const canary = "CANARYt8"
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const fixture = await harness(async function* (attempt) {
			if (attempt === 1) {
				yield { type: "tool_call", id: "private-call", name: "read_file", arguments: canary }
			} else {
				yield { type: "text", text: "Recovered from invalid tool arguments." }
			}
			yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
		})

		await fixture.run()

		expect(errors).toHaveBeenCalled()
		expect(
			errors.mock.calls
				.flat()
				.map((value) => (value instanceof Error ? value.message : JSON.stringify(value)))
				.join("\n"),
		).not.toContain(canary)
		expect(fixture.effect).not.toHaveBeenCalled()
	})

	it("recovers from committed text and opaque reasoning using history and the captured provider contract", async () => {
		let fixture!: Awaited<ReturnType<typeof harness>>
		fixture = await harness(async function* (attempt, task) {
			if (attempt === 1) {
				yield { type: "text", text: partialText, id: "partial-text" }
				yield { type: "reasoning", text: "", encryptedContent: opaqueState, id: "reasoning-state", summary: [] }
				task.api = fixture.replacement
				task.apiConfiguration = { apiProvider: "vertex", apiModelId: "replacement-model" }
				task["effectiveApiConfiguration"] = { ...task.apiConfiguration }
				fixture.live.mode = "architect"
				fixture.live.prompt = "Changed live instructions."
				fixture.live.autoApprovalEnabled = true
				throw transportFailure()
			}
			const committed = await fixture.history()
			expect(committed.some((message) => message.agentResponseOutcome?.status === "failed")).toBe(true)
			yield { type: "text", text: "Recovered answer." }
			yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
		})

		await fixture.run()

		expect(fixture.task.isCompleted()).toBe(true)
		expect(fixture.createMessage).toHaveBeenCalledTimes(2)
		expect(fixture.replacement.createMessage).not.toHaveBeenCalled()
		const [first, second] = fixture.createMessage.mock.calls
		expect(second[0]).toBe(first[0])
		expect(second[2]?.tools).toEqual(first[2]?.tools)
		expect(second[2]?.allowedFunctionNames).toEqual(first[2]?.allowedFunctionNames)
		expect(second[2]?.suppressPreviousResponseId).toBe(true)
		expect(second[2]?.requestId).not.toBe(first[2]?.requestId)
		expect(second[2]?.attemptId).not.toBe(first[2]?.attemptId)
		expect(JSON.stringify(second[1])).toContain(partialText)
		expect(JSON.stringify(second[1])).toContain("opaque-reasoning+/=")
		expect(JSON.stringify(first[1])).not.toContain(partialText)
		expect(fixture.snapshots).toHaveLength(2)
		expect(fixture.snapshots[1].context.contextId).not.toBe(fixture.snapshots[0].context.contextId)
		expect(fixture.snapshots[1].context.mode.slug).toBe("code")
		expect(fixture.snapshots[1].context.provider.apiProvider).toBe("openai")
		expect(fixture.snapshots[1].context.provider.modelId).toBe("original-model")
		expect(fixture.snapshots[1].digests.policy).toBe(fixture.snapshots[0].digests.policy)
		expect(fixture.snapshots[1].digests.instructions).toBe(fixture.snapshots[0].digests.instructions)
		expect(fixture.snapshots[1].digests.tools).toBe(fixture.snapshots[0].digests.tools)
		const history = await fixture.history()
		expect(history.filter((message) => message.agentResponseOutcome?.status === "failed")).toHaveLength(1)
		expect(history.filter((message) => message.agentResponseOutcome?.status === "completed")).toHaveLength(1)
		expect(history.flatMap((message) => message.agentResponseItems ?? [])).toContainEqual(
			expect.objectContaining({ type: "reasoning", encryptedContent: opaqueState }),
		)
		expect(fixture.task.ask).not.toHaveBeenCalled()
	})

	it("continues from a committed lifecycle stream that reaches EOF without a terminal outcome", async () => {
		const fixture = await harness(async function* (attempt) {
			yield { type: "text", text: attempt === 1 ? partialText : "Recovered after EOF." }
			if (attempt === 2) yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
		})
		await fixture.run()
		expect(fixture.task.isCompleted()).toBe(true)
		expect(fixture.createMessage).toHaveBeenCalledTimes(2)
		expect(JSON.stringify(fixture.createMessage.mock.calls[1][1])).toContain(partialText)
		expect(
			(await fixture.history()).filter((message) => message.agentResponseOutcome?.status === "incomplete"),
		).toHaveLength(1)
	})

	it("preserves sealed opaque reasoning when recovering before visible text has arrived", async () => {
		const fixture = await harness(async function* (attempt) {
			if (attempt === 1) {
				yield {
					type: "reasoning",
					text: "",
					encryptedContent: opaqueState,
					id: "sealed-reasoning",
					summary: [],
				}
				throw transportFailure()
			}
			yield { type: "text", text: "The answer after retained reasoning." }
			yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
		})
		await fixture.run()
		expect(fixture.task.isCompleted()).toBe(true)
		expect(fixture.createMessage).toHaveBeenCalledTimes(2)
		expect(JSON.stringify(fixture.createMessage.mock.calls[1][1])).toContain("opaque-reasoning+/=")
		expect((await fixture.history()).flatMap((message) => message.agentResponseItems ?? [])).toContainEqual(
			expect.objectContaining({ type: "reasoning", encryptedContent: opaqueState }),
		)
	})

	it.each(["explicit incomplete", "nonretryable error", "quota error"] as const)(
		"preserves %s as terminal despite partial visible text",
		async (failure) => {
			const fixture = await harness(async function* () {
				yield { type: "text", text: partialText }
				if (failure === "explicit incomplete") {
					yield createApiStreamOutcome({
						status: "incomplete",
						semanticOutputObserved: true,
						reason: "Output token limit reached.",
						retryable: true,
					})
				} else if (failure === "quota error") {
					yield createApiStreamError({
						message: "Quota exhausted.",
						code: "insufficient_quota",
						retryable: false,
						semanticOutputObserved: true,
					})
				} else {
					throw transportFailure({ retryable: false })
				}
			})
			await fixture.run()
			expect(fixture.task.isCompleted()).toBe(false)
			expect(fixture.createMessage).toHaveBeenCalledOnce()
			expect(fixture.task.ask).toHaveBeenCalledWith("resume_task")
		},
	)

	it.each([
		{ code: "rate_limit_exceeded", status: 429 },
		{ code: "context_length_exceeded", status: 400 },
	])("keeps streamed $code errors terminal when their full retry metadata cannot be retained", async (metadata) => {
		const fixture = await harness(async function* () {
			yield { type: "text", text: partialText }
			yield createApiStreamError({
				message: "A provider-reported error requires its own retry semantics.",
				...metadata,
				retryable: true,
				semanticOutputObserved: true,
			})
		})
		await fixture.run()
		expect(fixture.task.isCompleted()).toBe(false)
		expect(fixture.createMessage).toHaveBeenCalledOnce()
		expect(fixture.task.ask).toHaveBeenCalledWith("resume_task")
	})

	it.each(["read_file", "apply_patch"] as const)(
		"settles an accepted %s call once and never blindly retries its failed response",
		async (name) => {
			const fixture = await harness(async function* () {
				yield { type: "text", text: partialText }
				yield { type: "tool_call", id: "accepted-call", name, arguments: "{}" }
				yield { type: "tool_call_end", id: "accepted-call" }
				throw transportFailure()
			})
			await fixture.run()
			expect(fixture.task.isCompleted()).toBe(false)
			expect(fixture.createMessage).toHaveBeenCalledOnce()
			expect(fixture.effect).not.toHaveBeenCalled()
			const results = (await fixture.history()).flatMap((message) =>
				Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_result") : [],
			)
			expect(results).toEqual([expect.objectContaining({ tool_use_id: "accepted-call", is_error: true })])
			expect((await fixture.journal.replay())?.terminalToolCallIds).toEqual(["accepted-call"])
		},
	)

	it.each(["throw", "EOF"] as const)(
		"refuses recovery after unfinished tool intent followed by %s even when no canonical call survives",
		async (boundary) => {
			const fixture = await harness(async function* () {
				yield { type: "text", text: partialText }
				yield { type: "tool_call_start", id: "unfinished-call", name: "apply_patch" }
				yield { type: "tool_call_delta", id: "unfinished-call", delta: "{}" }
				if (boundary === "throw") throw transportFailure()
			})
			await fixture.run()
			expect(fixture.task.isCompleted()).toBe(false)
			expect(fixture.createMessage).toHaveBeenCalledOnce()
			expect(fixture.effect).not.toHaveBeenCalled()
			expect(fixture.task.ask).toHaveBeenCalledWith("resume_task")
		},
	)

	it.each(
		(["throw", "EOF"] as const).flatMap((boundary) =>
			(["none", "identified", "anonymous"] as const).map((trailing) => ({ boundary, trailing })),
		),
	)(
		"settles a completed read once after $boundary with $trailing trailing intent",
		async ({ boundary, trailing }) => {
			let fixture!: Awaited<ReturnType<typeof harness>>
			fixture = await harness(async function* (attempt) {
				if (attempt > 1) {
					yield { type: "text", text: "The read result is available; the answer is complete." }
					yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
					return
				}
				yield { type: "text", text: partialText }
				yield {
					type: "tool_call",
					id: "early-read",
					name: "exec_command",
					arguments: '{"cmd":"git status --short"}',
				}
				yield { type: "tool_call_end", id: "early-read" }
				await fixture.effectSettled
				if (trailing !== "none") {
					yield {
						type: "tool_call_start",
						id: trailing === "identified" ? "unfinished-after-read" : "",
						name: "apply_patch",
					}
				}
				if (boundary === "throw") throw transportFailure()
			})
			await fixture.run()
			expect(fixture.task.isCompleted()).toBe(trailing === "none")
			expect(fixture.createMessage).toHaveBeenCalledTimes(trailing === "none" ? 2 : 1)
			expect(fixture.effect).toHaveBeenCalledOnce()
			const results = (await fixture.history()).flatMap((message) =>
				Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_result") : [],
			)
			expect(results).toEqual([
				expect.objectContaining({ tool_use_id: "early-read", is_error: false, content: "read completed" }),
			])
			if (trailing === "none") {
				const continuation = fixture.createMessage.mock.calls[1]![1]
				expect(
					continuation.flatMap((message) =>
						Array.isArray(message.content)
							? message.content.filter((block) => block.type === "tool_result")
							: [],
					),
				).toEqual(results)
			}
			expect((await fixture.journal.replay())?.terminalToolCallIds).toEqual(["early-read"])
		},
	)

	it("carries the attempt budget across failed samples instead of starting a new allowance per recovery", async () => {
		const fixture = await harness(async function* (attempt) {
			yield { type: "text", text: `Partial answer ${attempt}.` }
			throw transportFailure()
		})
		await fixture.run()
		expect(fixture.task.isCompleted()).toBe(false)
		expect(fixture.createMessage).toHaveBeenCalledTimes(2)
		expect(
			(await fixture.history()).filter((message) => message.agentResponseOutcome?.status === "failed"),
		).toHaveLength(2)
		expect(fixture.events).toContainEqual(
			expect.objectContaining({ type: "turn_failed", reason: expect.stringContaining("attempts") }),
		)
	})

	it("refuses server advice beyond the remaining elapsed retry budget", async () => {
		const fixture = await harness(
			async function* () {
				yield { type: "text", text: partialText }
				throw transportFailure({ retryAfterMs: 60_000 })
			},
			{ maxElapsedMs: 30_000 },
		)
		await fixture.run()
		expect(fixture.task.isCompleted()).toBe(false)
		expect(fixture.createMessage).toHaveBeenCalledOnce()
		expect(fixture.events).toContainEqual(
			expect.objectContaining({ type: "turn_failed", reason: expect.stringContaining("elapsed-budget") }),
		)
	})

	it("cancels during recovery admission without dispatching a replacement request", async () => {
		const fixture = await harness(async function* () {
			yield { type: "text", text: partialText }
			throw transportFailure()
		})
		const entered = deferred()
		const release = deferred()
		vi.spyOn(fixture.hooks, "waitForRetryDecision").mockImplementation(async () => {
			entered.resolve()
			await release.promise
		})
		const running = fixture.run()
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
		} finally {
			fixture.task.abort = true
			fixture.task["taskCancellationController"].abort(new Error("user cancelled"))
			release.resolve()
		}
		await running
		expect(fixture.createMessage).toHaveBeenCalledOnce()
		expect(fixture.task.isCompleted()).toBe(false)
		expect((await fixture.journal.replay())?.status).toBe("interrupted")
	})

	it("does not request recovery when the committed partial response cannot be persisted", async () => {
		const fixture = await harness(async function* () {
			yield { type: "text", text: partialText }
			throw transportFailure()
		})
		vi.spyOn(fixture.hooks, "persistAssistantResponseBeforeEffects").mockResolvedValue(false)
		await fixture.run()
		expect(fixture.createMessage).toHaveBeenCalledOnce()
		expect(fixture.task.isCompleted()).toBe(false)
		expect(fixture.task.ask).toHaveBeenCalledWith("resume_task")
	})

	it.each([
		{ code: "rate_limit_exceeded", status: 429 },
		{ code: "context_length_exceeded", status: 400 },
	])("keeps streamed $code errors terminal after a later retryable transport throw", async (metadata) => {
		const providerMessage = "The provider reported a terminal error before transport closed."
		const fixture = await harness(async function* () {
			yield { type: "text", text: partialText }
			yield createApiStreamError({
				message: providerMessage,
				...metadata,
				retryable: true,
				semanticOutputObserved: true,
			})
			throw transportFailure()
		})
		await fixture.run()
		expect(fixture.createMessage).toHaveBeenCalledOnce()
		expect(fixture.task.isCompleted()).toBe(false)
		expect(fixture.task.ask).toHaveBeenCalledWith("resume_task")
		const history = await fixture.history()
		expect(history.filter((message) => message.agentResponseOutcome?.status === "failed")).toHaveLength(1)
		expect(history.some((message) => message.agentResponseOutcome?.status === "completed")).toBe(false)
		const failed = history.find((message) => message.agentResponseOutcome?.status === "failed")
		expect(failed?.agentResponseOutcome).toMatchObject({
			reason: providerMessage,
		})
		expect(JSON.stringify(history)).toContain(partialText)
		expect(history.flatMap((message) => message.agentResponseItems ?? [])).toContainEqual(
			expect.objectContaining({
				type: "error",
				message: providerMessage,
				code: metadata.code,
				retryable: true,
			}),
		)
	})

	it("retains the original handler through recovery and disposes it once after real completion", async () => {
		let fixture!: Awaited<ReturnType<typeof harness>>
		fixture = await harness(
			async function* (attempt) {
				if (attempt === 1) {
					yield { type: "text", text: partialText }
					fixture.replaceProfile()
					throw transportFailure()
				}
				expect(fixture.originalDispose).not.toHaveBeenCalled()
				yield { type: "text", text: "Recovered with the still-owned original handler." }
				yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
			},
			{},
			{ realCompletion: true },
		)
		await fixture.run()
		expect(fixture.task.api).toBe(fixture.replacement)
		expect(fixture.createMessage).toHaveBeenCalledTimes(2)
		expect(fixture.replacement.createMessage).not.toHaveBeenCalled()
		expect(fixture.task.isCompleted()).toBe(true)
		expect(fixture.provider.prepareTaskCompletionLifecycle).toHaveBeenCalledOnce()
		expect((await fixture.journal.replay())?.status).toBe("completed")
		const history = await fixture.history()
		expect(history.filter((message) => message.agentResponseOutcome?.status === "failed")).toHaveLength(1)
		expect(history.filter((message) => message.agentResponseOutcome?.status === "completed")).toHaveLength(1)
		expect(JSON.stringify(fixture.createMessage.mock.calls[1][1])).toContain(partialText)
		expect(fixture.originalDispose).toHaveBeenCalledOnce()
		expect(fixture.replacementDispose).not.toHaveBeenCalled()
		expect(fixture.capturedRequests).toHaveLength(2)
		for (const request of fixture.capturedRequests) {
			expect(request.hasRetainedRequest?.()).toBe(false)
			expect(() => request.getRequest()).toThrow(/released/)
		}
	})

	it("stops held recovery after profile replacement without double disposal", async () => {
		const fixture = await harness(async function* () {
			yield { type: "text", text: partialText }
			throw transportFailure()
		})
		const entered = deferred()
		const release = deferred()
		vi.spyOn(fixture.hooks, "waitForRetryDecision").mockImplementation(async () => {
			entered.resolve()
			await release.promise
		})
		const running = fixture.run()
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
			expect(fixture.capturedRequests).toHaveLength(1)
			expect(fixture.capturedRequests[0].hasRetainedRequest?.()).toBe(true)
			fixture.replaceProfile()
			expect(fixture.task.api).toBe(fixture.replacement)
			expect(fixture.originalDispose).not.toHaveBeenCalled()
			await fixture.task.abortTask()
			expect(fixture.capturedRequests[0].hasRetainedRequest?.()).toBe(false)
			expect(() => fixture.capturedRequests[0].getRequest()).toThrow(/released/)
			expect(fixture.originalDispose).toHaveBeenCalledOnce()
			expect(fixture.replacementDispose).toHaveBeenCalledOnce()
		} finally {
			release.resolve()
			await running
		}
		await fixture.task.waitForTermination()
		expect(fixture.createMessage).toHaveBeenCalledOnce()
		expect(fixture.replacement.createMessage).not.toHaveBeenCalled()
		expect(fixture.task.isCompleted()).toBe(false)
		const failed = (await fixture.history()).filter((message) => message.agentResponseOutcome?.status === "failed")
		expect(failed).toHaveLength(1)
		expect(fixture.capturedRequests).toHaveLength(1)
		expect(fixture.capturedRequests[0].hasRetainedRequest?.()).toBe(false)
		expect(() => fixture.capturedRequests[0].getRequest()).toThrow(/released/)
		fixture.task.dispose()
		await fixture.task.abortTask()
		expect(fixture.originalDispose).toHaveBeenCalledOnce()
		expect(fixture.replacementDispose).toHaveBeenCalledOnce()
	})

	it("stops an active reasoning admission after profile replacement without double disposal", async () => {
		const fixture = await harness(() => {
			throw new Error("Admission must not sample a provider response.")
		})
		const entered = deferred()
		const release = deferred()
		const prepareModel = vi.fn(async () => {
			entered.resolve()
			await release.promise
		})
		fixture.original.prepareModel = prepareModel
		const admission = fixture.task.prepareReasoningForAdmission()
		const settled = admission.then(
			() => ({ status: "fulfilled" as const }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		)
		try {
			expect(await Promise.race([entered.promise.then(() => true), settled.then(() => false)])).toBe(true)
			fixture.replaceProfile()
			expect(fixture.task.api).toBe(fixture.replacement)
			expect(fixture.originalDispose).not.toHaveBeenCalled()
			await fixture.task.abortTask()
			expect(fixture.originalDispose).toHaveBeenCalledOnce()
			expect(fixture.replacementDispose).toHaveBeenCalledOnce()
		} finally {
			release.resolve()
			await settled
		}
		expect(await settled).toMatchObject({
			status: "rejected",
			error: expect.objectContaining({ name: "AbortError" }),
		})
		await fixture.task.waitForTermination()
		expect(prepareModel).toHaveBeenCalledOnce()
		expect(fixture.createMessage).not.toHaveBeenCalled()
		expect(fixture.replacement.createMessage).not.toHaveBeenCalled()
		fixture.task.dispose()
		await fixture.task.abortTask()
		expect(fixture.originalDispose).toHaveBeenCalledOnce()
		expect(fixture.replacementDispose).toHaveBeenCalledOnce()
	})
})

describe("Task request error provenance", () => {
	async function openRequest(fixture: Awaited<ReturnType<typeof harness>>) {
		await fixture.task["beginCanonicalLifecycleTurn"]()
		return fixture.task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
	}

	async function nextRacingRequestSignal(request: ApiStream, signal: AbortSignal) {
		const reading = request.next()
		let removeAbortListener: () => void = () => undefined
		const interrupted = new Promise<never>((_, reject) => {
			const onAbort = () => reject(signal.reason)
			if (signal.aborted) onAbort()
			else {
				signal.addEventListener("abort", onAbort, { once: true })
				removeAbortListener = () => signal.removeEventListener("abort", onAbort)
			}
		})
		try {
			return await Promise.race([reading, interrupted])
		} finally {
			removeAbortListener()
		}
	}

	it("preserves the original tagged Error when source rejection races the captured request signal", async () => {
		const failure = Object.assign(new Error("Original tagged provider rejection."), {
			code: "TransportDisconnected",
			retryable: true,
			retryCategory: "transport",
			retryAfterMs: 73,
		})
		const fixture = await harness(async function* () {
			yield { type: "text", text: partialText }
			throw failure
		})
		const request = await openRequest(fixture)
		expect(await request.next()).toMatchObject({ done: false, value: { type: "text", text: partialText } })
		const signal = fixture.createMessage.mock.calls[0][2]!.signal!
		expect(signal.aborted).toBe(false)
		await expect(nextRacingRequestSignal(request, signal)).rejects.toBe(failure)
		expect(signal.aborted).toBe(true)
		expect(signal.reason).toBe(failure)
		expect(signal.reason).toMatchObject({
			code: "TransportDisconnected",
			retryable: true,
			retryCategory: "transport",
			retryAfterMs: 73,
		})
		expect(failure).not.toHaveProperty("firstChunkFailure")
		expect(fixture.task.currentRequestAbortController).toBeUndefined()
		expect(fixture.task["currentRequestSignal"]).toBeUndefined()
		expect(await request.next()).toEqual({ done: true, value: undefined })
		expect(fixture.createMessage).toHaveBeenCalledOnce()
	})

	it("releases ordinary source EOF without synthesizing request cancellation or retry", async () => {
		const fixture = await harness(async function* () {
			yield { type: "text", text: partialText }
		})
		const request = await openRequest(fixture)
		await request.next()
		const signal = fixture.createMessage.mock.calls[0][2]!.signal!
		expect(await request.next()).toEqual({ done: true, value: undefined })
		expect(signal.aborted).toBe(false)
		expect(fixture.task.currentRequestAbortController).toBeUndefined()
		expect(fixture.task["currentRequestSignal"]).toBeUndefined()
		expect(fixture.createMessage).toHaveBeenCalledOnce()
	})

	it("keeps consumer return as cleanup cancellation and closes the source without retry", async () => {
		const closed = vi.fn()
		const fixture = await harness(async function* () {
			try {
				yield { type: "text", text: partialText }
				throw new Error("Consumer return must not request another source chunk.")
			} finally {
				closed()
			}
		})
		const request = await openRequest(fixture)
		await request.next()
		const signal = fixture.createMessage.mock.calls[0][2]!.signal!
		expect(await request.return(undefined)).toEqual({ done: true, value: undefined })
		expect(signal.aborted).toBe(true)
		expect(signal.reason).toBeInstanceOf(Error)
		expect(signal.reason.message).toBe("Provider request closed")
		expect(signal.reason).not.toHaveProperty("retryable")
		expect(closed).toHaveBeenCalledOnce()
		expect(fixture.task.currentRequestAbortController).toBeUndefined()
		expect(fixture.task["currentRequestSignal"]).toBeUndefined()
		expect(fixture.createMessage).toHaveBeenCalledOnce()
	})

	it.each(["real Stop", "captured deadline"] as const)(
		"retains %s priority over a later source rejection without dispatching another request",
		async (interrupt) => {
			const entered = deferred()
			const release = deferred()
			const sourceSettled = deferred()
			const lateFailure = transportFailure()
			const fixture = await harness(async function* () {
				try {
					yield { type: "text", text: partialText }
					entered.resolve()
					await release.promise
					throw lateFailure
				} finally {
					sourceSettled.resolve()
				}
			})
			const request = await openRequest(fixture)
			await request.next()
			const signal = fixture.createMessage.mock.calls[0][2]!.signal!
			const controller = fixture.task.currentRequestAbortController!
			const reading = nextRacingRequestSignal(request, signal).then(
				(value) => ({ status: "fulfilled" as const, value }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			)
			try {
				expect(await Promise.race([entered.promise.then(() => true), reading.then(() => false)])).toBe(true)
				let reason: Error
				if (interrupt === "real Stop") {
					const stopping = fixture.task.abortTask()
					reason = signal.reason
					expect(reason).toBeInstanceOf(Error)
					expect(reason.message).toBe("Current task request was cancelled")
					await stopping
				} else {
					reason = new ApiStreamDeadlineError("Captured provider deadline exceeded")
					controller.abort(reason)
				}
				expect(signal.aborted).toBe(true)
				expect(signal.reason).toBe(reason)
				const result = await reading
				expect(result.status).toBe("rejected")
				if (result.status === "rejected") expect(result.error).toBe(reason)
				expect(signal.reason).not.toBe(lateFailure)
				release.resolve()
				await sourceSettled.promise
				expect(signal.reason).toBe(reason)
				expect(await request.next()).toEqual({ done: true, value: undefined })
				expect(fixture.task.currentRequestAbortController).toBeUndefined()
				expect(fixture.task["currentRequestSignal"]).toBeUndefined()
				expect(fixture.createMessage).toHaveBeenCalledOnce()
			} finally {
				release.resolve()
				await reading
				await request.return(undefined)
				await sourceSettled.promise
			}
		},
	)
})

describe("Task terminal early-read receipts", () => {
	it.each(["failed", "incomplete"] as const)(
		"keeps a completed approved early read truthful after an explicit %s provider outcome",
		async (status) => {
			let fixture!: Awaited<ReturnType<typeof harness>>
			fixture = await harness(async function* () {
				yield { type: "text", text: partialText }
				yield {
					type: "tool_call",
					id: "terminal-early-read",
					name: "exec_command",
					arguments: '{"cmd":"git status --short"}',
				}
				yield { type: "tool_call_end", id: "terminal-early-read" }
				await fixture.effectSettled
				yield createApiStreamOutcome({ status, semanticOutputObserved: true, retryable: false })
			})
			await fixture.run()
			expect(fixture.task.isCompleted()).toBe(false)
			expect(fixture.createMessage).toHaveBeenCalledOnce()
			expect(fixture.effect).toHaveBeenCalledOnce()
			const history = await fixture.history()
			expect(history.filter((message) => message.agentResponseOutcome?.status === status)).toHaveLength(1)
			const receipts = history
				.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
				.filter((block) => block.type === "tool_result")
			expect(receipts).toEqual([
				expect.objectContaining({
					tool_use_id: "terminal-early-read",
					is_error: false,
					content: "read completed",
				}),
			])
			expect(fixture.events.filter((event) => event.type === "tool_result")).toEqual([
				expect.objectContaining({ callId: "terminal-early-read", status: "success", output: "read completed" }),
			])
			expect(fixture.events.findIndex((event) => event.type === "assistant_committed")).toBeLessThan(
				fixture.events.findIndex((event) => event.type === "tool_result"),
			)
			expect((await fixture.journal.replay())?.terminalToolCallIds).toEqual(["terminal-early-read"])
		},
	)

	it("keeps real Stop authoritative during an owned finalizer and withholds the later settled dispatch", async () => {
		const bothEffectsSettled = deferred()
		const finalizerEntered = deferred()
		const releaseFinalizer = deferred()
		const finalized: string[] = []
		let effects = 0
		const fixture = await harness(
			async function* () {
				for (const [id, workdir] of [
					["owned-read", "."],
					["later-read", "src"],
				] as const) {
					yield {
						type: "tool_call",
						id,
						name: "exec_command",
						arguments: JSON.stringify({ cmd: "git status --short", workdir }),
					}
					yield { type: "tool_call_end", id }
				}
				await bothEffectsSettled.promise
				yield createApiStreamOutcome({ status: "failed", semanticOutputObserved: true, retryable: false })
			},
			{},
			{
				onReadEffect: () => {
					if (++effects === 2) bothEffectsSettled.resolve()
				},
				finalizeEarlyRead: async (callId) => {
					finalized.push(callId)
					if (callId === "owned-read") {
						finalizerEntered.resolve()
						await releaseFinalizer.promise
					}
				},
			},
		)
		const running = fixture.run()
		try {
			expect(await Promise.race([finalizerEntered.promise.then(() => true), running.then(() => false)])).toBe(
				true,
			)
			const stopping = fixture.task.abortTask()
			releaseFinalizer.resolve()
			await stopping
			await running
			await fixture.task.waitForTermination()
			expect(fixture.task.abort).toBe(true)
			expect(fixture.task.isCompleted()).toBe(false)
			expect(fixture.events.some((event) => event.type === "cancelled")).toBe(true)
			expect(fixture.createMessage).toHaveBeenCalledOnce()
			expect(fixture.effect).toHaveBeenCalledTimes(2)
			expect(finalized).toEqual(["owned-read"])
			const receipts = (await fixture.history()).flatMap((message) =>
				Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_result") : [],
			)
			expect(receipts).toHaveLength(2)
			const cancelledReceipt = JSON.stringify({
				status: "cancelled",
				message:
					"Tool execution was cancelled after it may have started. Its outcome is unknown; verify the current state before retrying.",
			})
			expect(receipts).toContainEqual(
				expect.objectContaining({ tool_use_id: "owned-read", content: cancelledReceipt, is_error: true }),
			)
			expect(receipts).toContainEqual(expect.objectContaining({ tool_use_id: "later-read", is_error: true }))
			expect(
				fixture.events.filter((event) => event.type === "tool_result" && event.callId === "owned-read"),
			).toEqual([expect.objectContaining({ status: "cancelled", output: cancelledReceipt })])
			const lifecycle = await fixture.journal.replay()
			expect(lifecycle?.terminalToolCallIds).toEqual(["owned-read", "later-read"])
			expect(
				lifecycle?.items.filter((item) => item.type === "tool_result" && item.toolCallId === "owned-read"),
			).toEqual([expect.objectContaining({ status: "indeterminate", output: cancelledReceipt })])
		} finally {
			bothEffectsSettled.resolve()
			releaseFinalizer.resolve()
			await running
		}
	})
})

describe("Task omitted-read repair ownership", () => {
	it.each(["failed salvage", "incomplete salvage", "healthy"] as const)(
		"fences %s omission repair after its real journal publication loses the captured owner",
		async (ending) => {
			const entered = deferred()
			const release = deferred()
			const fixture = await omittedReadRepair(ending, async () => {
				entered.resolve()
				await release.promise
			})
			const running = fixture.run()
			try {
				expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
				const replacement = await replaceOmissionOwner(fixture)
				release.resolve()
				await running
				await expectOmissionReplacementUnchanged(fixture, replacement)
			} finally {
				release.resolve()
				fixture.releaseSource()
				await running.catch(() => undefined)
				fixture.restoreFinish()
			}
		},
	)

	it("fences a primitive identity change while omission repair waits on its real canonical queue", async () => {
		const entered = deferred()
		const release = deferred()
		const queue = new Proxy(release.promise, {
			get(target, key) {
				if (key === "then") {
					return (fulfilled?: (value: void) => unknown, rejected?: (error: unknown) => unknown) => {
						entered.resolve()
						return target.then(fulfilled, rejected)
					}
				}
				const value = Reflect.get(target, key, target)
				return typeof value === "function" ? value.bind(target) : value
			},
		})
		const fixture = await omittedReadRepair("failed salvage", (task) => {
			task["canonicalLifecycleQueue"] = queue
		})
		const running = fixture.run()
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
			const replacement = await replaceOmissionOwner(fixture, "primitive identity")
			release.resolve()
			await running
			await expectOmissionReplacementUnchanged(fixture, replacement)
		} finally {
			release.resolve()
			fixture.releaseSource()
			await running.catch(() => undefined)
			fixture.restoreFinish()
		}
	})

	it("fences step replacement while healthy omission repair awaits the real journal replay", async () => {
		const entered = deferred()
		const release = deferred()
		let omissionPublished = false
		let held = false
		const fixture = await omittedReadRepair("healthy", () => {
			omissionPublished = true
		})
		const replay = fixture.provider.replayAgentLifecycle.bind(fixture.provider)
		vi.spyOn(fixture.provider, "replayAgentLifecycle").mockImplementation(async () => {
			const snapshot = await replay()
			if (omissionPublished && !held) {
				held = true
				entered.resolve()
				await release.promise
			}
			return snapshot
		})
		const running = fixture.run()
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
			const replacement = await replaceOmissionOwner(fixture, "step object")
			release.resolve()
			await running
			await expectOmissionReplacementUnchanged(fixture, replacement)
		} finally {
			release.resolve()
			fixture.releaseSource()
			await running.catch(() => undefined)
			fixture.restoreFinish()
		}
	})

	it("preserves replacement memory and disk when real omission overwrite loses ownership during its flush", async () => {
		const entered = deferred()
		const release = deferred()
		const fixture = await omittedReadRepair("failed salvage")
		let repairOverwrite = false
		let claimed = false
		let held = false
		const overwrite = fixture.task.overwriteApiConversationHistory.bind(fixture.task)
		vi.spyOn(fixture.task, "overwriteApiConversationHistory").mockImplementation(async (...args) => {
			const originalRepair = fixture.omissions() > 0 && !claimed
			if (originalRepair) {
				claimed = true
				repairOverwrite = true
			}
			try {
				return await overwrite(...args)
			} finally {
				if (originalRepair) repairOverwrite = false
			}
		})
		const flush = fixture.task.flushApiConversationHistoryPersistence.bind(fixture.task)
		vi.spyOn(fixture.task, "flushApiConversationHistoryPersistence").mockImplementation(async () => {
			await flush()
			if (repairOverwrite && !held) {
				held = true
				entered.resolve()
				await release.promise
			}
		})
		const reset = vi.spyOn(fixture.task["environmentContext"], "reset")
		const acknowledge = vi.spyOn(fixture.task.messageQueueService, "acknowledgeMessages")
		const claim = vi.spyOn(fixture.task.messageQueueService, "claimMessage")
		const saves = vi.mocked(saveApiMessages)
		const running = fixture.run()
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
			const replacement = await replaceOmissionOwner(fixture)
			reset.mockClear()
			acknowledge.mockClear()
			claim.mockClear()
			saves.mockClear()
			release.resolve()
			await running
			await expectOmissionReplacementUnchanged(fixture, replacement)
			expect(reset).not.toHaveBeenCalled()
			expect(acknowledge).not.toHaveBeenCalled()
			expect(claim).not.toHaveBeenCalled()
			expect(saves).not.toHaveBeenCalled()
		} finally {
			release.resolve()
			fixture.releaseSource()
			await running.catch(() => undefined)
			fixture.restoreFinish()
		}
	})

	it("refuses a stale omission snapshot before its real queued authoritative write starts", async () => {
		const entered = deferred()
		const release = deferred()
		const operationSettled = deferred()
		const releaseQueue = deferred()
		const fixture = await omittedReadRepair("healthy")
		let repairOverwrite = false
		let claimed = false
		let held = false
		const overwrite = fixture.task.overwriteApiConversationHistory.bind(fixture.task)
		vi.spyOn(fixture.task, "overwriteApiConversationHistory").mockImplementation(async (...args) => {
			const originalRepair = fixture.omissions() > 0 && !claimed
			if (originalRepair) {
				claimed = true
				repairOverwrite = true
			}
			try {
				return await overwrite(...args)
			} finally {
				if (originalRepair) repairOverwrite = false
			}
		})
		const persistence = fixture.task as unknown as {
			enqueueApiConversationHistoryPersistence: Task["enqueueApiConversationHistoryPersistence"]
		}
		const enqueue: Task["enqueueApiConversationHistoryPersistence"] =
			persistence.enqueueApiConversationHistoryPersistence.bind(fixture.task)
		vi.spyOn(persistence, "enqueueApiConversationHistoryPersistence").mockImplementation(function <T>(
			operation: () => Promise<T>,
		): Promise<T> {
			const holdOperation = repairOverwrite && !held
			if (holdOperation) held = true
			return enqueue(async () => {
				if (!holdOperation) return operation()
				entered.resolve()
				await release.promise
				try {
					return await operation()
				} finally {
					operationSettled.resolve()
					await releaseQueue.promise
				}
			})
		})
		const saves = vi.mocked(saveApiMessages)
		const writer = saves.getMockImplementation()!
		const admissions: WriterAdmission[] = []
		saves.mockImplementation(async (input) => {
			admissions.push(captureWriterAdmission(fixture.task, input.messages))
			return writer(input)
		})
		const running = fixture.run()
		let sentinelWrite: Promise<boolean> | undefined
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
			const { pending, sentinel } = stageOmissionReplacement(fixture.task)
			const staged = await captureOmissionReplacement(fixture, pending)
			saves.mockClear()
			admissions.length = 0
			sentinelWrite = fixture.task.overwriteApiConversationHistory(sentinel)
			const observedWrite = sentinelWrite.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			)
			release.resolve()
			await operationSettled.promise
			await expectQueuedReplacementBeforeWrite(fixture, staged)
			expect(saves).not.toHaveBeenCalled()
			expect(admissions).toEqual([])
			releaseQueue.resolve()
			expect(await observedWrite).toEqual({ value: true })
			await running
			const replacement = {
				...staged,
				historyReference: fixture.task.apiConversationHistory,
				disk: await fixture.history(),
			}
			expect(replacement.history).toEqual(sentinel)
			expect(replacement.disk).toEqual(sentinel)
			await expectOmissionReplacementUnchanged(fixture, replacement)
			expect(saves).toHaveBeenCalledOnce()
			expect(saves.mock.calls[0][0].messages).toEqual(sentinel)
			expect(admissions).toEqual([expect.objectContaining({ messages: sentinel, liveHistory: sentinel })])
		} finally {
			release.resolve()
			releaseQueue.resolve()
			fixture.releaseSource()
			await running.catch(() => undefined)
			await sentinelWrite?.catch(() => undefined)
			fixture.restoreFinish()
			saves.mockImplementation(writer)
		}
	})

	it("repairs an owned omitted read durably without promoting its withheld output or replaying it", async () => {
		const fixture = await omittedReadRepair("healthy")
		const running = fixture.run()
		try {
			await running
			const history = await fixture.history()
			const uses = history.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.filter((block) => block.type === "tool_use" && block.id === omittedReadId)
					: [],
			)
			const receipts = history.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.filter(
							(block) => block.type === "tool_result" && block.tool_use_id === omittedReadId,
						)
					: [],
			)
			expect(uses).toHaveLength(1)
			expect(receipts).toEqual([
				expect.objectContaining({ is_error: true, content: expect.stringContaining("omitted") }),
			])
			expect(JSON.stringify(receipts)).not.toContain("read completed")
			expect((await fixture.journal.replay())?.terminalToolCallIds).toEqual([omittedReadId])
			expect(fixture.createMessage).toHaveBeenCalledOnce()
			expect(fixture.effect).toHaveBeenCalledOnce()
			expect(fixture.finalizer).not.toHaveBeenCalled()
			expect(fixture.omissions()).toBe(1)
		} finally {
			fixture.releaseSource()
			await running.catch(() => undefined)
			fixture.restoreFinish()
		}
	})
})

describe("Task real captured request ownership", () => {
	it("completes ordinary text with the installed captured surface and one durable assistant boundary", async () => {
		const fixture = await harness(async function* (_attempt, task) {
			expect(task["currentTaskToolSurface"]).toBe(task["currentAgentStep"]?.surface)
			expect(task["currentTaskToolSurface"]).toBeDefined()
			yield { type: "text", text: "A healthy owned final answer." }
			yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
		})
		await fixture.run()
		expect(fixture.task.isCompleted()).toBe(true)
		expect(fixture.createMessage).toHaveBeenCalledOnce()
		expect(fixture.task.ask).not.toHaveBeenCalled()
		const assistant = (await fixture.history()).filter((message) => message.role === "assistant")
		expect(assistant).toHaveLength(1)
		expect(assistant[0].agentResponseOutcome?.status).toBe("completed")
		expect(JSON.stringify(assistant)).toContain("A healthy owned final answer.")
		expect(fixture.events).toContainEqual(expect.objectContaining({ type: "turn_completed", status: "completed" }))
		expect(fixture.events).not.toContainEqual(
			expect.objectContaining({ type: "turn_completed", status: "aborted" }),
		)
		expect(fixture.events).not.toContainEqual(expect.objectContaining({ type: "turn_failed" }))
		expect((await fixture.journal.replay())?.status).toBe("completed")
		expect(fixture.capturedRequests[0].hasRetainedRequest?.()).toBe(false)
	})

	it.each(["deadline exhaustion", "replacement"] as const)(
		"settles a real held lifecycle preflight after %s without inventing a new owner",
		async (ending) => {
			const entered = deferred()
			const release = deferred()
			let captured: NonNullable<Task["currentAgentStep"]> | undefined
			const fixture = await harness(
				async function* () {
					yield { type: "text", text: "A closed preflight must not reach this provider." }
					yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
				},
				{ maxAttempts: 1, maxElapsedMs: ending === "deadline exhaustion" ? 1_000 : 30_000 },
			)
			const publications: AgentLifecycleEventInput[] = []
			const publish = fixture.provider.publishAgentLifecycleEvent.bind(fixture.provider)
			vi.spyOn(fixture.provider, "publishAgentLifecycleEvent").mockImplementation(async (input, options) => {
				publications.push(structuredClone(input))
				const receipt = await publish(input, options)
				if (input.type === "step_started") {
					captured = fixture.task["currentAgentStep"]
					entered.resolve()
					await release.promise
				}
				return receipt
			})
			const observed = { ...fixture, publications }
			const controls = fixture.task as unknown as { waitForRequestControl: Task["waitForRequestControl"] }
			const waits = vi.spyOn(controls, "waitForRequestControl")
			const configuredTimeout = vi.mocked(getApiRequestTimeout)
			const originalTimeout = configuredTimeout.getMockImplementation()!
			if (ending === "deadline exhaustion") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
			if (ending === "deadline exhaustion") configuredTimeout.mockReturnValue(1_000)
			const startedAt = Date.now()
			const running = fixture.run()
			try {
				expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
				expect(captured).toBeDefined()
				expect(fixture.task["currentTaskToolSurface"]).toBe(captured!.surface)
				expect(captured!.surface).toBeDefined()
				expect(fixture.task.currentRequestAbortController).toBeUndefined()
				expect(fixture.task["currentRequestSignal"]).toBeUndefined()
				if (ending === "deadline exhaustion") {
					expect(waits.mock.calls.at(-1)?.[2]).toBe(startedAt + 1_000)
					await vi.advanceTimersByTimeAsync(2_000)
					release.resolve()
					await running
					expect(fixture.events).toContainEqual(
						expect.objectContaining({
							type: "model_request_failed",
							code: "ProviderTimeout",
						}),
					)
					expect(fixture.events).toContainEqual(
						expect.objectContaining({
							type: "turn_failed",
							reason: "Provider retry budget exhausted (attempts).",
						}),
					)
					expect(fixture.events).not.toContainEqual(
						expect.objectContaining({ type: "turn_completed", status: "aborted" }),
					)
					expect(fixture.task.ask).toHaveBeenCalledWith("resume_task")
				} else {
					const { pending, sentinel } = stageZeroEarlyReplacement(fixture.task)
					expect(await fixture.task.overwriteApiConversationHistory(sentinel)).toBe(true)
					const replacement = await captureOmissionReplacement(observed, pending)
					release.resolve()
					await running
					await expectQueuedReplacementBeforeWrite(observed, replacement)
					expect(replacement.step?.releaseRequest).not.toHaveBeenCalled()
					expect(fixture.task.ask).not.toHaveBeenCalled()
					expect(fixture.task.abort).toBe(false)
				}
				expect(fixture.task.isCompleted()).toBe(false)
				expect(fixture.createMessage).not.toHaveBeenCalled()
				expect(fixture.effect).not.toHaveBeenCalled()
				expect(captured!.hasRetainedRequest?.()).toBe(false)
				expect(fixture.task.currentRequestAbortController).toBeUndefined()
				expect(fixture.task["currentRequestSignal"]).toBeUndefined()
			} finally {
				release.resolve()
				await running.catch(() => undefined)
				if (ending === "deadline exhaustion") vi.useRealTimers()
				configuredTimeout.mockImplementation(originalTimeout)
			}
		},
	)

	it.each(["transport", "rate-limit"] as const)(
		"keeps the real captured request owned across a retained %s attempt",
		async (category) => {
			const captured: Array<{ stepId: string; surface: unknown }> = []
			let fixture!: Awaited<ReturnType<typeof harness>>
			fixture = await harness(async function* (attempt, task) {
				const step = task["currentAgentStep"]!
				expect(task["currentTaskToolSurface"]).toBe(step.surface)
				captured.push({ stepId: step.stepId, surface: step.surface })
				if (attempt === 1) {
					fixture.replaceProfile()
					throw transportFailure({
						retryCategory: category,
						...(category === "rate-limit" ? { status: 429, retryAfterMs: 0 } : {}),
					})
				}
				expect(attempt).toBe(2)
				expect(fixture.originalDispose).not.toHaveBeenCalled()
				yield { type: "text", text: "The retained request completed safely." }
				yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
			})
			const pacing = fixture.task as unknown as {
				getProviderRateLimitRemainingSeconds: Task["getProviderRateLimitRemainingSeconds"]
			}
			vi.spyOn(pacing, "getProviderRateLimitRemainingSeconds").mockResolvedValue(0)
			await fixture.run()
			expect(fixture.createMessage).toHaveBeenCalledTimes(2)
			expect(fixture.replacement.createMessage).not.toHaveBeenCalled()
			expect(captured).toHaveLength(2)
			expect(captured[1].surface).toBe(captured[0].surface)
			expect(captured[1].stepId).toBe(captured[0].stepId)
			const [first, second] = fixture.createMessage.mock.calls
			expect(second[0]).toBe(first[0])
			expect(second[1]).toEqual(first[1])
			expect(second[2]?.tools).toEqual(first[2]?.tools)
			expect(second[2]?.requestId).toBe(first[2]?.requestId)
			expect(second[2]?.attemptId).not.toBe(first[2]?.attemptId)
			expect(second[2]?.signal).not.toBe(first[2]?.signal)
			expect(fixture.snapshots[1].context.contextId).toBe(fixture.snapshots[0].context.contextId)
			expect(fixture.task.isCompleted()).toBe(true)
			expect(fixture.task.ask).not.toHaveBeenCalled()
			const assistant = (await fixture.history()).filter((message) => message.role === "assistant")
			expect(assistant).toHaveLength(1)
			expect(assistant[0].agentResponseOutcome?.status).toBe("completed")
			expect(fixture.originalDispose).toHaveBeenCalledOnce()
			for (const request of fixture.capturedRequests) expect(request.hasRetainedRequest?.()).toBe(false)
		},
	)
})

describe("Task captured ownership with a degraded journal", () => {
	it("preserves the owned provider failure when a later best-effort step start is not journaled", async () => {
		const journalFailure = new Error("The second step header could not be persisted.")
		const sourceFailure = transportFailure({ retryable: false, code: "OWNED_PROVIDER_FAILURE" })
		let firstStepId: string | undefined
		let skippedStepId: string | undefined
		let stepStarts = 0
		let fixture!: Awaited<ReturnType<typeof harness>>
		fixture = await harness(async function* (attempt, task) {
			const step = task["currentAgentStep"]!
			if (attempt === 1) {
				firstStepId = step.stepId
				yield { type: "text", text: "The first response requires another model step." }
				yield createApiStreamOutcome({
					status: "completed",
					semanticOutputObserved: true,
					requiresContinuation: true,
				})
				return
			}
			expect(attempt).toBe(2)
			const projected = fixture.journal.getSnapshot()!
			expect(projected.currentStepId).toBe(firstStepId)
			expect(step.stepId).toBe(skippedStepId)
			expect(step.stepId).not.toBe(firstStepId)
			expect(task["currentAgentStep"]).toBe(fixture.capturedRequests[1])
			expect(task["agentRunId"]).toBe(projected.runId)
			expect(task["agentTurnId"]).toBe(projected.turnId)
			yield { type: "text", text: partialText }
			throw sourceFailure
		})
		const publish = fixture.provider.publishAgentLifecycleEvent.bind(fixture.provider)
		vi.spyOn(fixture.provider, "publishAgentLifecycleEvent").mockImplementation(async (input, options) => {
			if (input.type === "step_started" && ++stepStarts === 2) {
				const projected = fixture.journal.getSnapshot()
				expect(projected?.currentStepId).toBe(firstStepId)
				expect(projected?.steps).toEqual([
					expect.objectContaining({ stepId: firstStepId, status: "completed" }),
				])
				skippedStepId = input.stepId
				throw journalFailure
			}
			// A status for the omitted header cannot enter the real reducer either.
			if (input.type === "step_status_changed" && input.stepId === skippedStepId) throw journalFailure
			return publish(input, options)
		})

		await fixture.run()

		expect(stepStarts).toBe(2)
		expect(fixture.createMessage).toHaveBeenCalledTimes(2)
		expect(fixture.task.isCompleted()).toBe(false)
		expect(fixture.task.ask).toHaveBeenCalledWith("resume_task")
		expect(fixture.task["canonicalLifecyclePersistenceFailure"]).toMatchObject({
			type: "step_started",
			error: journalFailure,
		})
		const history = await fixture.history()
		expect(history.filter((message) => message.agentResponseOutcome?.status === "completed")).toHaveLength(1)
		const failed = history.filter((message) => message.agentResponseOutcome?.status === "failed")
		expect(failed).toHaveLength(1)
		expect(failed[0].agentResponseOutcome).toMatchObject({ reason: sourceFailure.message, retryable: false })
		expect(JSON.stringify(failed)).toContain(partialText)
		expect(fixture.events).toContainEqual(
			expect.objectContaining({
				type: "turn_failed",
				reason: sourceFailure.message,
				error: sourceFailure.message,
			}),
		)
		expect(fixture.events).not.toContainEqual(
			expect.objectContaining({ type: "turn_completed", status: "aborted" }),
		)
		const projected = await fixture.journal.replay()
		expect(projected?.status).toBe("failed")
		expect(projected?.currentStepId).toBe(firstStepId)
		expect(projected?.steps.map((step) => step.stepId)).toEqual([firstStepId])
		for (const request of fixture.capturedRequests) expect(request.hasRetainedRequest?.()).toBe(false)
	})
})

describe("Task terminal fallback without an early dispatch", () => {
	it.each([
		{ boundary: "canonical queue", status: "failed" },
		{ boundary: "assistant event", status: "incomplete" },
	] as const)("fences zero-early $status receipt fallback across a held $boundary", async ({ boundary, status }) => {
		const entered = deferred()
		const release = deferred()
		const queue = new Proxy(release.promise, {
			get(target, key) {
				if (key === "then") {
					return (fulfilled?: (value: void) => unknown, rejected?: (error: unknown) => unknown) => {
						entered.resolve()
						return target.then(fulfilled, rejected)
					}
				}
				const value = Reflect.get(target, key, target)
				return typeof value === "function" ? value.bind(target) : value
			},
		})
		const fixture = await terminalCallWithoutEarlyDispatch(status)
		const append = vi.mocked(fixture.hooks.appendAgentTurnEvent).getMockImplementation()!
		vi.mocked(fixture.hooks.appendAgentTurnEvent).mockImplementation(async (...args) => {
			await append(...args)
			if (args[0].type !== "assistant_committed") return
			if (boundary === "canonical queue") {
				fixture.task["canonicalLifecycleQueue"] = queue
			} else {
				entered.resolve()
				await release.promise
			}
		})
		const saves = vi.mocked(saveApiMessages)
		const running = fixture.run()
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
			expect(JSON.stringify(await fixture.history())).toContain(unexecutedTerminalCallId)
			expect(fixture.effect).not.toHaveBeenCalled()
			const replacement = await replaceZeroEarlyOwner(fixture)
			saves.mockClear()
			fixture.stagedResults.mockClear()
			release.resolve()
			await running
			await expectTerminalReplacementUnchanged(fixture, replacement)
			expect(saves).not.toHaveBeenCalled()
		} finally {
			release.resolve()
			await running.catch(() => undefined)
		}
	})

	it("fences a zero-early receipt snapshot before its real queued authoritative write starts", async () => {
		const entered = deferred()
		const release = deferred()
		const operationSettled = deferred()
		const releaseQueue = deferred()
		const fixture = await terminalCallWithoutEarlyDispatch("failed")
		let receiptFlush = false
		let held = false
		const flush = fixture.task.flushPendingToolResultsToHistory.bind(fixture.task)
		vi.spyOn(fixture.task, "flushPendingToolResultsToHistory").mockImplementation(async (...args) => {
			receiptFlush = true
			try {
				return await flush(...args)
			} finally {
				receiptFlush = false
			}
		})
		const persistence = fixture.task as unknown as {
			enqueueApiConversationHistoryPersistence: Task["enqueueApiConversationHistoryPersistence"]
		}
		const enqueue: Task["enqueueApiConversationHistoryPersistence"] =
			persistence.enqueueApiConversationHistoryPersistence.bind(fixture.task)
		vi.spyOn(persistence, "enqueueApiConversationHistoryPersistence").mockImplementation(function <T>(
			operation: () => Promise<T>,
		): Promise<T> {
			const holdOperation = receiptFlush && !held
			if (holdOperation) held = true
			return enqueue(async () => {
				if (!holdOperation) return operation()
				entered.resolve()
				await release.promise
				try {
					return await operation()
				} finally {
					operationSettled.resolve()
					await releaseQueue.promise
				}
			})
		})
		const saves = vi.mocked(saveApiMessages)
		const writer = saves.getMockImplementation()!
		const admissions: WriterAdmission[] = []
		saves.mockImplementation(async (input) => {
			admissions.push(captureWriterAdmission(fixture.task, input.messages))
			return writer(input)
		})
		const acknowledge = vi.spyOn(fixture.task.messageQueueService, "acknowledgeMessages")
		const running = fixture.run()
		let sentinelWrite: Promise<boolean> | undefined
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
			expect(fixture.stagedResults).toHaveBeenCalledWith(
				expect.objectContaining({ tool_use_id: unexecutedTerminalCallId, is_error: true }),
			)
			const { pending, sentinel, persistedIds } = stageZeroEarlyReplacement(fixture.task)
			const staged = { ...(await captureOmissionReplacement(fixture, pending)), persistedIds }
			saves.mockClear()
			admissions.length = 0
			fixture.stagedResults.mockClear()
			acknowledge.mockClear()
			sentinelWrite = fixture.task.overwriteApiConversationHistory(sentinel)
			const observedWrite = sentinelWrite.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			)
			release.resolve()
			await operationSettled.promise
			await expectQueuedReplacementBeforeWrite(fixture, staged)
			expect(saves).not.toHaveBeenCalled()
			expect(admissions).toEqual([])
			releaseQueue.resolve()
			expect(await observedWrite).toEqual({ value: true })
			await running
			const replacement = {
				...staged,
				historyReference: fixture.task.apiConversationHistory,
				disk: await fixture.history(),
			}
			expect(replacement.history).toEqual(sentinel)
			expect(replacement.disk).toEqual(sentinel)
			await expectTerminalReplacementUnchanged(fixture, replacement)
			expect(saves).toHaveBeenCalledOnce()
			expect(saves.mock.calls[0][0].messages).toEqual(sentinel)
			expect(admissions).toEqual([expect.objectContaining({ messages: sentinel, liveHistory: sentinel })])
			expect(acknowledge).toHaveBeenCalledOnce()
			expect(acknowledge).toHaveBeenCalledWith([])
		} finally {
			release.resolve()
			releaseQueue.resolve()
			await running.catch(() => undefined)
			await sentinelWrite?.catch(() => undefined)
			saves.mockImplementation(writer)
		}
	})
})

describe("Task terminal receipt persistence ownership", () => {
	it("refuses an unadmitted early-read receipt save without touching replacement state", async () => {
		const entered = deferred()
		const release = deferred()
		const operationSettled = deferred()
		const releaseQueue = deferred()
		const fixture = await terminalEarlyReadForPersistence()
		let receiptFlush = false
		let held = false
		const flush = fixture.task.flushPendingToolResultsToHistory.bind(fixture.task)
		vi.spyOn(fixture.task, "flushPendingToolResultsToHistory").mockImplementation(async (...args) => {
			receiptFlush = true
			try {
				return await flush(...args)
			} finally {
				receiptFlush = false
			}
		})
		const persistence = fixture.task as unknown as {
			enqueueApiConversationHistoryPersistence: Task["enqueueApiConversationHistoryPersistence"]
		}
		const enqueue: Task["enqueueApiConversationHistoryPersistence"] =
			persistence.enqueueApiConversationHistoryPersistence.bind(fixture.task)
		vi.spyOn(persistence, "enqueueApiConversationHistoryPersistence").mockImplementation(function <T>(
			operation: () => Promise<T>,
		): Promise<T> {
			const holdOperation = receiptFlush && !held
			if (holdOperation) held = true
			return enqueue(async () => {
				if (!holdOperation) return operation()
				entered.resolve()
				await release.promise
				try {
					return await operation()
				} finally {
					operationSettled.resolve()
					await releaseQueue.promise
				}
			})
		})
		const saves = vi.mocked(saveApiMessages)
		const writer = saves.getMockImplementation()!
		const admissions: WriterAdmission[] = []
		saves.mockImplementation(async (input) => {
			admissions.push(captureWriterAdmission(fixture.task, input.messages))
			return writer(input)
		})
		const retryParent = vi.fn()
		Object.assign(fixture.provider, { retryIndependentTaskCompletionsForParent: retryParent })
		const store = fixture.task["providerTranscriptStore"]
		const commit = vi.spyOn(store, "commitAuthoritativeTranscript")
		const repair = vi.spyOn(store, "repairAuthoritativeTranscript")
		const assertReceipt = vi.spyOn(store, "assertCommitReceipt")
		const running = fixture.run()
		let sentinelWrite: Promise<boolean> | undefined
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
			expect(fixture.effect).toHaveBeenCalledOnce()
			expect(fixture.finalizer).toHaveBeenCalledOnce()
			const { pending, sentinel, persistedIds } = stageZeroEarlyReplacement(fixture.task)
			const staged = { ...(await captureOmissionReplacement(fixture, pending)), persistedIds }
			const receiptBefore = fixture.task["providerTranscriptCommitReceipt"]
			const replacementFailure = new ProviderTranscriptStoreError(
				"write_failed",
				"Replacement transcript failure sentinel.",
				fixture.task.taskId,
			)
			fixture.task["providerTranscriptSidecarFailure"] = replacementFailure
			saves.mockClear()
			admissions.length = 0
			commit.mockClear()
			repair.mockClear()
			assertReceipt.mockClear()
			retryParent.mockClear()
			fixture.stagedResults.mockClear()
			sentinelWrite = fixture.task.overwriteApiConversationHistory(sentinel)
			const observedWrite = sentinelWrite.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			)
			release.resolve()
			await operationSettled.promise
			await expectQueuedReplacementBeforeWrite(fixture, staged)
			expect(saves).not.toHaveBeenCalled()
			expect(admissions).toEqual([])
			expect(commit).not.toHaveBeenCalled()
			expect(repair).not.toHaveBeenCalled()
			expect(assertReceipt).not.toHaveBeenCalled()
			expect(fixture.task["providerTranscriptCommitReceipt"]).toBe(receiptBefore)
			expect(fixture.task["providerTranscriptSidecarFailure"]).toBe(replacementFailure)
			expect(retryParent).not.toHaveBeenCalled()
			// The replacement resolves only the failure marker injected by this test.
			fixture.task["providerTranscriptSidecarFailure"] = undefined
			releaseQueue.resolve()
			expect(await observedWrite).toEqual({ value: true })
			await running
			const replacement = {
				...staged,
				historyReference: fixture.task.apiConversationHistory,
				disk: await fixture.history(),
			}
			expect(replacement.history).toEqual(sentinel)
			expect(replacement.disk).toEqual(sentinel)
			await expectTerminalReplacementUnchanged(fixture, replacement, 1)
			expect(fixture.finalizer).toHaveBeenCalledOnce()
			expect(saves).toHaveBeenCalledOnce()
			expect(admissions).toEqual([expect.objectContaining({ messages: sentinel, liveHistory: sentinel })])
		} finally {
			release.resolve()
			releaseQueue.resolve()
			fixture.releaseSource()
			await running.catch(() => undefined)
			await sentinelWrite?.catch(() => undefined)
			saves.mockImplementation(writer)
		}
	})

	it.each(["legacy receipt", "sidecar assertion"] as const)(
		"finishes an admitted early-read transaction held at its %s without acknowledging replacement state",
		async (boundary) => {
			const entered = deferred()
			const release = deferred()
			const operationSettled = deferred()
			const releaseQueue = deferred()
			const fixture = await terminalEarlyReadForPersistence()
			const store = fixture.task["providerTranscriptStore"]
			const retryParent = vi.fn()
			Object.assign(fixture.provider, { retryIndependentTaskCompletionsForParent: retryParent })
			const saves = vi.mocked(saveApiMessages)
			const writer = saves.getMockImplementation()!
			const admissions: WriterAdmission[] = []
			let legacyReceipt: Awaited<ReturnType<typeof saveApiMessages>> | undefined
			let admittedMessages: ApiMessage[] | undefined
			let terminalReceipt: Parameters<typeof store.assertCommitReceipt>[0] | undefined
			let receiptFlush = false
			let held = false
			saves.mockImplementation(async (input) => {
				admissions.push(captureWriterAdmission(fixture.task, input.messages))
				const receipt = await writer(input)
				if (hasProviderToolReceipt(input.messages, fixture.callId)) {
					legacyReceipt = receipt
					admittedMessages = structuredClone(input.messages)
					if (boundary === "legacy receipt") {
						entered.resolve()
						await release.promise
					}
				}
				return receipt
			})
			const commit = store.commitAuthoritativeTranscript.bind(store)
			const commits = vi.spyOn(store, "commitAuthoritativeTranscript").mockImplementation(async (receipt) => {
				const result = await commit(receipt)
				if (receipt === legacyReceipt) terminalReceipt = result
				return result
			})
			const assertReceipt = store.assertCommitReceipt.bind(store)
			const assertions = vi.spyOn(store, "assertCommitReceipt").mockImplementation(async (receipt) => {
				if (boundary === "sidecar assertion" && receipt === terminalReceipt) {
					entered.resolve()
					await release.promise
				}
				return assertReceipt(receipt)
			})
			const flush = fixture.task.flushPendingToolResultsToHistory.bind(fixture.task)
			vi.spyOn(fixture.task, "flushPendingToolResultsToHistory").mockImplementation(async (...args) => {
				receiptFlush = true
				try {
					return await flush(...args)
				} finally {
					receiptFlush = false
				}
			})
			const persistence = fixture.task as unknown as {
				enqueueApiConversationHistoryPersistence: Task["enqueueApiConversationHistoryPersistence"]
			}
			const enqueue: Task["enqueueApiConversationHistoryPersistence"] =
				persistence.enqueueApiConversationHistoryPersistence.bind(fixture.task)
			vi.spyOn(persistence, "enqueueApiConversationHistoryPersistence").mockImplementation(function <T>(
				operation: () => Promise<T>,
			): Promise<T> {
				const holdOperation = receiptFlush && !held
				if (holdOperation) held = true
				return enqueue(async () => {
					try {
						return await operation()
					} finally {
						if (holdOperation) {
							operationSettled.resolve()
							await releaseQueue.promise
						}
					}
				})
			})
			const acknowledge = vi.spyOn(fixture.task.messageQueueService, "acknowledgeMessages")
			const running = fixture.run()
			let sentinelWrite: Promise<boolean> | undefined
			try {
				expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
				expect(legacyReceipt).toBeDefined()
				expect(admittedMessages).toBeDefined()
				const { pending, sentinel, persistedIds } = stageZeroEarlyReplacement(fixture.task)
				const staged = { ...(await captureOmissionReplacement(fixture, pending)), persistedIds }
				const replacementFailure = new ProviderTranscriptStoreError(
					"write_failed",
					"Replacement transcript failure sentinel.",
					fixture.task.taskId,
				)
				fixture.task["providerTranscriptSidecarFailure"] = replacementFailure
				const receiptBefore = fixture.task["providerTranscriptCommitReceipt"]
				const admissionCountBefore = admissions.length
				retryParent.mockClear()
				acknowledge.mockClear()
				fixture.stagedResults.mockClear()
				sentinelWrite = fixture.task.overwriteApiConversationHistory(sentinel)
				const observedWrite = sentinelWrite.then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				)
				release.resolve()
				await operationSettled.promise
				await expectQueuedReplacementBeforeWrite(fixture, staged)
				expect(await fixture.history()).toEqual(admittedMessages)
				expect(commits).toHaveBeenCalledWith(legacyReceipt)
				expect(commits.mock.calls.filter(([receipt]) => receipt === legacyReceipt)).toHaveLength(1)
				expect(terminalReceipt).toBeDefined()
				expect(assertions).toHaveBeenCalledWith(terminalReceipt)
				expect(admissions).toHaveLength(admissionCountBefore)
				const sidecar = await store.read()
				expect(sidecar.messages).toEqual(admittedMessages)
				expect(sidecar.digest).toBe(legacyReceipt!.digest)
				expect(fixture.task["providerTranscriptCommitReceipt"]).toBe(receiptBefore)
				expect(fixture.task["providerTranscriptSidecarFailure"]).toBe(replacementFailure)
				expect(acknowledge).not.toHaveBeenCalled()
				expect(retryParent).not.toHaveBeenCalled()
				// The replacement resolves only the failure marker injected by this test.
				fixture.task["providerTranscriptSidecarFailure"] = undefined
				releaseQueue.resolve()
				expect(await observedWrite).toEqual({ value: true })
				await running
				const replacement = {
					...staged,
					historyReference: fixture.task.apiConversationHistory,
					disk: await fixture.history(),
				}
				expect(replacement.history).toEqual(sentinel)
				expect(replacement.disk).toEqual(sentinel)
				await expectTerminalReplacementUnchanged(fixture, replacement, 1)
				expect(fixture.finalizer).toHaveBeenCalledOnce()
				expect(admissions).toHaveLength(admissionCountBefore + 1)
				expect(admissions.at(-1)).toEqual(
					expect.objectContaining({ messages: sentinel, liveHistory: sentinel }),
				)
			} finally {
				release.resolve()
				releaseQueue.resolve()
				fixture.releaseSource()
				await running.catch(() => undefined)
				await sentinelWrite?.catch(() => undefined)
				saves.mockImplementation(writer)
			}
		},
	)
})

describe("Task canonical response projection ownership", () => {
	it.each(
		(["cancelled", "failed", "incomplete", "completed", "missing terminal text"] as const).flatMap((status) =>
			(["fulfilled", "rejected"] as const).map((settlement) => ({ status, settlement })),
		),
	)("fences a $status response across a $settlement real preview drain", async ({ status, settlement }) => {
		const entered = deferred()
		const release = deferred()
		const fixture = await terminalCallWithoutEarlyDispatch(status)
		const previews = fixture.task as unknown as { drainStreamingPreviews: Task["drainStreamingPreviews"] }
		const drain = previews.drainStreamingPreviews.bind(fixture.task)
		vi.spyOn(previews, "drainStreamingPreviews").mockImplementation(async (...args) => {
			await drain(...args)
			if (args[0] === "canonical response") {
				entered.resolve()
				await release.promise
				if (settlement === "rejected") throw new Error("The old preview drain rejected after handoff.")
			}
		})
		const saves = vi.mocked(saveApiMessages)
		const running = fixture.run()
		let stopping: Promise<void> | undefined
		try {
			if (status === "cancelled") {
				expect(await Promise.race([fixture.sourceReady.then(() => true), running.then(() => false)])).toBe(true)
				stopping = fixture.task.abortTask()
				void stopping.catch(() => undefined)
			}
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
			await stopping
			const replacement = await replaceZeroEarlyOwner(fixture)
			const projected = createAgentResponse([{ type: "text", text: "Replacement canonical response sentinel." }])
			fixture.task["currentAgentResponse"] = projected
			const preview: Task["assistantMessageContent"] = [
				{ type: "text", content: "Replacement preview sentinel.", partial: false },
			]
			fixture.task.assistantMessageContent = preview
			fixture.task.currentStreamingContentIndex = 73
			fixture.task["isTaskLoopActive"] = true
			saves.mockClear()
			fixture.stagedResults.mockClear()
			release.resolve()
			fixture.releaseSource()
			await running
			await expectTerminalReplacementUnchanged(fixture, replacement, 0, status === "cancelled")
			expect(fixture.task["currentAgentResponse"]).toBe(projected)
			expect(fixture.task.assistantMessageContent).toBe(preview)
			expect(fixture.task.assistantMessageContent).toEqual([
				{ type: "text", content: "Replacement preview sentinel.", partial: false },
			])
			expect(fixture.task.currentStreamingContentIndex).toBe(73)
			expect(fixture.task["isTaskLoopActive"]).toBe(true)
			expect(saves).not.toHaveBeenCalled()
		} finally {
			release.resolve()
			fixture.releaseSource()
			await stopping?.catch(() => undefined)
			await running.catch(() => undefined)
		}
	})
})

describe("Task real preview drain ownership", () => {
	it.each([
		...(["deadline", "cancellation"] as const).flatMap((ending) =>
			(["retained", "replaced"] as const).map((owner) => ({ ending, owner })),
		),
		{ ending: "queue fulfillment", owner: "replaced" },
		{ ending: "queue rejection", owner: "replaced" },
	] as const)("settles a $ending preview drain with its owner $owner", async ({ ending, owner }) => {
		const fixture = await harness(async function* () {
			yield { type: "text", text: "A real captured request precedes the preview boundary." }
			yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
		})
		await fixture.task["beginCanonicalLifecycleTurn"]()
		const request = fixture.task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
		const queued = deferred()
		let rejectQueued!: (error: Error) => void
		const queuedPromise = new Promise<void>((resolve, reject) => {
			void queued.promise.then(resolve)
			rejectQueued = reject
		})
		const replacementQueue = deferred()
		let captured: NonNullable<Task["currentAgentStep"]> | undefined
		try {
			expect(await request.next()).toMatchObject({ done: false, value: { type: "text" } })
			captured = fixture.task["currentAgentStep"]!
			const stepId = captured.stepId
			const surface = captured.surface
			const runId = fixture.task["agentRunId"]
			const turnId = fixture.task["agentTurnId"]
			expect(fixture.task["currentTaskToolSurface"]).toBe(surface)
			const ownsCapturedStep = () =>
				fixture.task["currentAgentStep"] === captured &&
				captured?.stepId === stepId &&
				fixture.task["currentTaskToolSurface"] === surface &&
				fixture.task["agentRunId"] === runId &&
				fixture.task["agentTurnId"] === turnId
			const initialEpoch = fixture.task["streamingPreviewEpoch"]
			fixture.task["streamingPreviewQueue"] = queuedPromise
			fixture.task["streamingPreviewPumpOwner"] = Symbol("original preview pump")
			fixture.task.presentAssistantMessageLocked = true
			fixture.task.presentAssistantMessageHasPendingUpdates = true
			Reflect.set(fixture.task, "presentAssistantMessageLockOwner", { epoch: initialEpoch })
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const signal = fixture.task["getTaskLifetimeCancellationSignal"]()
			const listen = vi.spyOn(signal, "addEventListener")
			const removeListener = vi.spyOn(signal, "removeEventListener")
			const draining = fixture.task["drainStreamingPreviews"]("controlled owned boundary", ownsCapturedStep)
			const settled = draining.then(
				() => ({ status: "fulfilled" as const }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			)
			const releaseReplacement = vi.fn<NonNullable<Task["currentAgentStep"]>["releaseRequest"]>()
			const replacementEpoch = initialEpoch + 7
			const replacementPump = Symbol("replacement preview pump")
			const replacementLock = { epoch: replacementEpoch }
			if (owner === "replaced") {
				fixture.task["currentAgentStep"] = {
					...captured,
					stepId: `${stepId}:replacement`,
					releaseRequest: releaseReplacement,
				}
				fixture.task["streamingPreviewEpoch"] = replacementEpoch
				fixture.task["streamingPreviewPumpOwner"] = replacementPump
				fixture.task["streamingPreviewQueue"] = replacementQueue.promise
				Reflect.set(fixture.task, "presentAssistantMessageLockOwner", replacementLock)
			}
			const queueFailure = new Error("The old preview queue rejected after handoff.")
			if (ending === "deadline") await vi.advanceTimersByTimeAsync(1_000)
			else if (ending === "cancellation")
				fixture.task["taskCancellationController"].abort(new Error("Controlled preview drain cancellation."))
			else if (ending === "queue fulfillment") queued.resolve()
			else {
				// The real helper observes this rejection; its finally still owns only local resources.
				rejectQueued(queueFailure)
			}
			const result = await settled
			if (ending === "queue rejection") expect(result).toEqual({ status: "rejected", error: queueFailure })
			else expect(result).toEqual({ status: "fulfilled" })
			if (owner === "replaced") {
				expect(fixture.task["streamingPreviewEpoch"]).toBe(replacementEpoch)
				expect(fixture.task["streamingPreviewPumpOwner"]).toBe(replacementPump)
				expect(fixture.task["streamingPreviewQueue"]).toBe(replacementQueue.promise)
				expect(fixture.task.presentAssistantMessageLocked).toBe(true)
				expect(fixture.task.presentAssistantMessageHasPendingUpdates).toBe(true)
				expect(Reflect.get(fixture.task, "presentAssistantMessageLockOwner")).toBe(replacementLock)
			} else {
				expect(fixture.task["streamingPreviewEpoch"]).toBeGreaterThan(initialEpoch)
				expect(fixture.task["streamingPreviewPumpOwner"]).toBeUndefined()
				expect(fixture.task["streamingPreviewQueue"]).not.toBe(queuedPromise)
				expect(fixture.task.presentAssistantMessageLocked).toBe(false)
				expect(fixture.task.presentAssistantMessageHasPendingUpdates).toBe(false)
				expect(Reflect.has(fixture.task, "presentAssistantMessageLockOwner")).toBe(false)
			}
			expect(releaseReplacement).not.toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
			const abortListener = listen.mock.calls.find(([type]) => type === "abort")?.[1]
			expect(abortListener).toBeDefined()
			expect(removeListener).toHaveBeenCalledWith("abort", abortListener)
			expect(fixture.createMessage).toHaveBeenCalledOnce()
			expect(fixture.effect).not.toHaveBeenCalled()
		} finally {
			queued.resolve()
			replacementQueue.resolve()
			vi.useRealTimers()
			await request.return(undefined)
			captured?.releaseRequest?.()
		}
	})

	it("returns from an already stale real drain without allocating a deadline or cancellation listener", async () => {
		const fixture = await harness(async function* () {
			yield { type: "text", text: "A captured owner is replaced before drain entry." }
		})
		await fixture.task["beginCanonicalLifecycleTurn"]()
		const request = fixture.task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
		const replacementQueue = deferred()
		let captured: NonNullable<Task["currentAgentStep"]> | undefined
		try {
			await request.next()
			captured = fixture.task["currentAgentStep"]!
			const releaseReplacement = vi.fn<typeof captured.releaseRequest>()
			const replacement = {
				...captured,
				stepId: `${captured.stepId}:replacement`,
				releaseRequest: releaseReplacement,
			}
			const epoch = fixture.task["streamingPreviewEpoch"] + 9
			const pump = Symbol("stale-entry replacement pump")
			const lock = { epoch }
			fixture.task["currentAgentStep"] = replacement
			fixture.task["streamingPreviewEpoch"] = epoch
			fixture.task["streamingPreviewPumpOwner"] = pump
			fixture.task["streamingPreviewQueue"] = replacementQueue.promise
			fixture.task.presentAssistantMessageLocked = true
			fixture.task.presentAssistantMessageHasPendingUpdates = true
			Reflect.set(fixture.task, "presentAssistantMessageLockOwner", lock)
			const signal = fixture.task["getTaskLifetimeCancellationSignal"]()
			const listen = vi.spyOn(signal, "addEventListener")
			const removeListener = vi.spyOn(signal, "removeEventListener")
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			await fixture.task["drainStreamingPreviews"](
				"already superseded boundary",
				() => fixture.task["currentAgentStep"] === captured,
			)
			expect(vi.getTimerCount()).toBe(0)
			expect(listen).not.toHaveBeenCalled()
			expect(removeListener).not.toHaveBeenCalled()
			expect(fixture.task["currentAgentStep"]).toBe(replacement)
			expect(fixture.task["streamingPreviewEpoch"]).toBe(epoch)
			expect(fixture.task["streamingPreviewPumpOwner"]).toBe(pump)
			expect(fixture.task["streamingPreviewQueue"]).toBe(replacementQueue.promise)
			expect(fixture.task.presentAssistantMessageLocked).toBe(true)
			expect(fixture.task.presentAssistantMessageHasPendingUpdates).toBe(true)
			expect(Reflect.get(fixture.task, "presentAssistantMessageLockOwner")).toBe(lock)
			expect(releaseReplacement).not.toHaveBeenCalled()
			expect(fixture.createMessage).toHaveBeenCalledOnce()
			expect(fixture.effect).not.toHaveBeenCalled()
		} finally {
			replacementQueue.resolve()
			vi.useRealTimers()
			await request.return(undefined)
			captured?.releaseRequest?.()
		}
	})
})

describe("Task native tool execution ownership", () => {
	it("refuses scheduler admission after its real executing-phase wait loses the original response owner", async () => {
		const entered = deferred()
		const release = deferred()
		const fixture = await terminalCallWithoutEarlyDispatch("completed")
		const publish = vi.mocked(fixture.provider.publishAgentLifecycleEvent).getMockImplementation()!
		vi.mocked(fixture.provider.publishAgentLifecycleEvent).mockImplementation(async (input, options) => {
			const receipt = await publish(input, options)
			if (input.type === "phase_changed" && "phase" in input.payload && input.payload.phase === "executing") {
				entered.resolve()
				await release.promise
			}
			return receipt
		})
		const execution = fixture.task as unknown as {
			executeCanonicalToolCallsForTurn: Task["executeCanonicalToolCallsForTurn"]
		}
		const schedule = vi.spyOn(execution, "executeCanonicalToolCallsForTurn")
		const saves = vi.mocked(saveApiMessages)
		const running = fixture.run()
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
			expect(JSON.stringify(await fixture.history())).toContain(fixture.callId)
			expect(schedule).not.toHaveBeenCalled()
			expect(fixture.effect).not.toHaveBeenCalled()
			const { pending, sentinel } = stageOmissionReplacement(fixture.task, "run and step")
			const persistedIds = new Set(["replacement-receipt"])
			fixture.task["persistedToolResultIds"] = persistedIds
			fixture.task.userMessageContentReady = true
			expect(await fixture.task.overwriteApiConversationHistory(sentinel)).toBe(true)
			const replacement = { ...(await captureOmissionReplacement(fixture, pending)), persistedIds }
			saves.mockClear()
			fixture.stagedResults.mockClear()
			release.resolve()
			await running
			expect(schedule).not.toHaveBeenCalled()
			await expectTerminalReplacementUnchanged(fixture, replacement)
			expect(saves).not.toHaveBeenCalled()
		} finally {
			release.resolve()
			fixture.releaseSource()
			await running.catch(() => undefined)
		}
	})
})

const unexecutedTerminalCallId = "unexecuted-terminal-call"

async function terminalEarlyReadForPersistence() {
	const dispatchSettled = deferred()
	const finalizer = vi.fn(async () => undefined)
	const callId = "terminal-persistence-read"
	const fixture = await harness(
		async function* (attempt) {
			if (attempt !== 1)
				throw new Error("A superseded completed read must not request another provider response.")
			yield { type: "text", text: "An approved read has completed before provider failure." }
			yield { type: "tool_call", id: callId, name: "exec_command", arguments: '{"cmd":"git status --short"}' }
			yield { type: "tool_call_end", id: callId }
			await dispatchSettled.promise
			yield createApiStreamOutcome({ status: "failed", semanticOutputObserved: true, retryable: false })
		},
		{},
		{ finalizeEarlyRead: finalizer },
	)
	const execution = fixture.task as unknown as { executeCanonicalToolCalls: Task["executeCanonicalToolCalls"] }
	const execute = execution.executeCanonicalToolCalls.bind(fixture.task)
	vi.spyOn(execution, "executeCanonicalToolCalls").mockImplementation(async (...args) => {
		const result = await execute(...args)
		if (args[5]?.deferResultCommit) dispatchSettled.resolve()
		return result
	})
	const publications: AgentLifecycleEventInput[] = []
	const publish = fixture.provider.publishAgentLifecycleEvent.bind(fixture.provider)
	vi.spyOn(fixture.provider, "publishAgentLifecycleEvent").mockImplementation(async (input, options) => {
		publications.push(structuredClone(input))
		return publish(input, options)
	})
	const stagedResults = vi.spyOn(fixture.task, "pushToolResultToUserContent")
	return {
		...fixture,
		publications,
		stagedResults,
		callId,
		finalizer,
		releaseSource: () => dispatchSettled.resolve(),
	}
}

function hasProviderToolReceipt(messages: readonly ApiMessage[], callId: string): boolean {
	return messages.some(
		(message) =>
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "tool_result" && block.tool_use_id === callId),
	)
}

describe("Task passive archives with an owned foreground producer", () => {
	it.each(["archive succeeds", "archive rejects"] as const)(
		"joins the captured engine finalizer, manual and goal boundaries when %s",
		async (ending) => {
			const effectSettled = deferred()
			const finalizerEntered = deferred()
			const releaseFinalizer = deferred()
			const manual = deferred()
			const goal = deferred()
			let releaseArchive!: () => void
			let rejectArchive!: (reason: unknown) => void
			const archive = new Promise<void>((resolve, reject) => {
				releaseArchive = resolve
				rejectArchive = reject
			})
			const archiveFailure = new Error("Original foreground command archive failed")
			type Settlement = { status: "fulfilled" } | { status: "rejected"; reason: unknown }
			const observe = (promise: Promise<void>) => {
				const state: { settlement?: Settlement } = {}
				const settled = promise.then(
					() => (state.settlement = { status: "fulfilled" as const }),
					(reason: unknown) => (state.settlement = { status: "rejected" as const, reason }),
				)
				return { state, settled }
			}
			const archiveObserved = observe(archive)
			let closed = false
			const process = Object.assign(new EventEmitter(), {
				executionId: "20000000-0000-4000-8000-000000000001",
				isSettled: true,
				isOutputFinalized: false,
				abort: vi.fn(async () => undefined),
				waitForOutputFinalization: vi.fn(() => archive),
				cancelPendingOutputWrite: vi.fn(),
				finalizeOutput: vi.fn(async () => {
					throw new Error("Task must not force the owned output finalizer")
				}),
			})
			const archiveExecutionId = "30000000-0000-4000-8000-000000000001"
			const callId = "archive-held-foreground-read"
			const fixture = await harness(
				async function* (attempt) {
					if (attempt !== 1) throw new Error("A cancelled archive join cannot start another provider request")
					yield {
						type: "tool_call",
						id: callId,
						name: "exec_command",
						arguments: '{"cmd":"git status --short"}',
					}
					yield { type: "tool_call_end", id: callId }
					await effectSettled.promise
					yield createApiStreamOutcome({ status: "failed", semanticOutputObserved: true, retryable: false })
				},
				{},
				{
					onReadEffect: () => effectSettled.resolve(),
					finalizeEarlyRead: async () => {
						finalizerEntered.resolve()
						await releaseFinalizer.promise
					},
				},
			)
			commandSessionRegistry.trackTaskOutput(
				fixture.task,
				process as unknown as AlphaTerminalProcess,
				process.executionId,
				{ archiveExecutionId, isClosed: () => closed },
			)
			const cleanup = vi.spyOn(OutputInterceptor, "cleanupByIds").mockResolvedValue(undefined)
			const broadCleanup = vi.spyOn(OutputInterceptor, "cleanup").mockResolvedValue(undefined)
			const dispose = vi.spyOn(fixture.task, "dispose")
			const running = fixture.run()
			let abort: ReturnType<typeof observe> | undefined
			let termination: ReturnType<typeof observe> | undefined
			let clockControlled = false
			try {
				expect(await Promise.race([finalizerEntered.promise.then(() => true), running.then(() => false)])).toBe(
					true,
				)
				const originalStep = fixture.capturedRequests[0]
				expect(originalStep.hasRetainedRequest?.()).toBe(true)
				fixture.task["manualContextCondenseSettlement"] = manual.promise
				fixture.task["goalShutdownPromise"] = goal.promise
				const originalHistory = await fixture.history()
				expect(hasProviderToolReceipt(originalHistory, callId)).toBe(false)
				vi.useFakeTimers()
				clockControlled = true
				const receipt = fixture.task.beginTaskCancellation()
				abort = observe(receipt.abort)
				termination = observe(receipt.termination)
				if (ending === "archive succeeds") {
					closed = true
					process.isOutputFinalized = true
					releaseArchive()
					await vi.advanceTimersByTimeAsync(20_000)
					expect(termination.state.settlement).toBeUndefined()
					expect(vi.getTimerCount()).toBe(0)
					goal.resolve()
					await vi.advanceTimersByTimeAsync(0)
					expect(await abort.settled).toEqual({ status: "fulfilled" })
					expect(termination.state.settlement).toBeUndefined()
					releaseFinalizer.resolve()
					await vi.advanceTimersByTimeAsync(0)
					await running
					expect(termination.state.settlement).toBeUndefined()
					manual.resolve()
					await vi.advanceTimersByTimeAsync(0)
					expect(await termination.settled).toEqual({ status: "fulfilled" })
					const receipts = (await fixture.history()).flatMap((message) =>
						Array.isArray(message.content)
							? message.content.filter((block) => block.type === "tool_result")
							: [],
					)
					const cancelledReceipt = JSON.stringify({
						status: "cancelled",
						message:
							"Tool execution was cancelled after it may have started. Its outcome is unknown; verify the current state before retrying.",
					})
					expect(receipts).toEqual([
						expect.objectContaining({ tool_use_id: callId, content: cancelledReceipt, is_error: true }),
					])
					expect(
						fixture.events.filter((event) => event.type === "tool_result" && event.callId === callId),
					).toEqual([expect.objectContaining({ status: "cancelled", output: cancelledReceipt })])
					const lifecycle = await fixture.journal.replay()
					expect(lifecycle?.terminalToolCallIds).toEqual([callId])
					expect(
						lifecycle?.items.filter((item) => item.type === "tool_result" && item.toolCallId === callId),
					).toEqual([expect.objectContaining({ status: "indeterminate", output: cancelledReceipt })])
				} else {
					rejectArchive(archiveFailure)
					await vi.advanceTimersByTimeAsync(0)
					expect(await abort.settled).toEqual({ status: "rejected", reason: archiveFailure })
					await vi.advanceTimersByTimeAsync(9_999)
					expect(termination.state.settlement).toBeUndefined()
					expect(dispose).not.toHaveBeenCalled()
					expect(originalStep.hasRetainedRequest?.()).toBe(true)
					expect(hasProviderToolReceipt(await fixture.history(), callId)).toBe(false)
					await vi.advanceTimersByTimeAsync(1)
					expect(await termination.settled).toEqual({ status: "rejected", reason: archiveFailure })
					expect(dispose).not.toHaveBeenCalled()
					expect(fixture.originalDispose).not.toHaveBeenCalled()
					expect(originalStep.hasRetainedRequest?.()).toBe(true)
					expect(fixture.task["userMessageContent"]).toEqual([])
					expect(hasProviderToolReceipt(await fixture.history(), callId)).toBe(false)
					expect((await fixture.journal.replay())?.terminalToolCallIds).not.toContain(callId)
					expect(commandSessionRegistry.capturePendingTaskOutput(fixture.task)).toContainEqual(
						expect.objectContaining({ archiveExecutionId, process }),
					)
					expect(cleanup).not.toHaveBeenCalled()
					// Producer truth may finish later; the failed receipt itself must never become success.
					releaseFinalizer.resolve()
					manual.resolve()
					goal.resolve()
					await vi.advanceTimersByTimeAsync(0)
					await running
					expect(await termination.settled).toEqual({ status: "rejected", reason: archiveFailure })
					const receipts = (await fixture.history()).flatMap((message) =>
						Array.isArray(message.content)
							? message.content.filter((block) => block.type === "tool_result")
							: [],
					)
					expect(receipts.filter((block) => block.tool_use_id === callId).length).toBeLessThanOrEqual(1)
				}
				expect(originalStep.hasRetainedRequest?.()).toBe(false)
				expect(fixture.createMessage).toHaveBeenCalledOnce()
				expect(fixture.effect).toHaveBeenCalledOnce()
				expect(process.abort).not.toHaveBeenCalled()
				expect(process.finalizeOutput).not.toHaveBeenCalled()
				expect(broadCleanup).not.toHaveBeenCalled()
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				effectSettled.resolve()
				releaseFinalizer.resolve()
				manual.resolve()
				goal.resolve()
				closed = true
				process.isOutputFinalized = true
				releaseArchive()
				try {
					if (clockControlled) await vi.advanceTimersByTimeAsync(0)
					await running
					if (abort) await abort.settled
					if (termination) await termination.settled
					await archiveObserved.settled
				} finally {
					cleanup.mockRestore()
					broadCleanup.mockRestore()
					if (clockControlled) vi.useRealTimers()
				}
			}
		},
	)
})

async function terminalCallWithoutEarlyDispatch(
	status: "failed" | "incomplete" | "completed" | "cancelled" | "missing terminal text",
) {
	const sourceReady = deferred()
	const releaseSource = deferred()
	const fixture = await harness(async function* (attempt) {
		if (attempt !== 1) throw new Error("A superseded terminal call must not request another provider response.")
		yield { type: "text", text: "An accepted write intent never reaches execution." }
		if (status === "missing terminal text") return
		yield { type: "tool_call", id: unexecutedTerminalCallId, name: "apply_patch", arguments: "{}" }
		yield { type: "tool_call_end", id: unexecutedTerminalCallId }
		if (status === "cancelled") {
			sourceReady.resolve()
			await releaseSource.promise
			return
		}
		if (status !== "failed") {
			yield createApiStreamOutcome({ status, semanticOutputObserved: true, retryable: false })
			return
		}
		throw transportFailure({ retryable: false })
	})
	const publications: AgentLifecycleEventInput[] = []
	const publish = fixture.provider.publishAgentLifecycleEvent.bind(fixture.provider)
	vi.spyOn(fixture.provider, "publishAgentLifecycleEvent").mockImplementation(async (input, options) => {
		publications.push(structuredClone(input))
		return publish(input, options)
	})
	const stagedResults = vi.spyOn(fixture.task, "pushToolResultToUserContent")
	return {
		...fixture,
		publications,
		stagedResults,
		callId: unexecutedTerminalCallId,
		sourceReady: sourceReady.promise,
		releaseSource: () => releaseSource.resolve(),
	}
}

function stageZeroEarlyReplacement(task: Task) {
	const replacement = stageOmissionReplacement(task, "step object")
	const persistedIds = new Set(["replacement-receipt"])
	task["persistedToolResultIds"] = persistedIds
	task.userMessageContentReady = true
	return { ...replacement, persistedIds }
}

async function replaceZeroEarlyOwner(fixture: Awaited<ReturnType<typeof terminalCallWithoutEarlyDispatch>>) {
	const { pending, sentinel, persistedIds } = stageZeroEarlyReplacement(fixture.task)
	expect(await fixture.task.overwriteApiConversationHistory(sentinel)).toBe(true)
	expect(await fixture.history()).toEqual(sentinel)
	return { ...(await captureOmissionReplacement(fixture, pending)), persistedIds }
}

async function expectTerminalReplacementUnchanged(
	fixture: Omit<Awaited<ReturnType<typeof terminalCallWithoutEarlyDispatch>>, "sourceReady" | "releaseSource">,
	replacement: Awaited<ReturnType<typeof replaceZeroEarlyOwner>>,
	effectCount = 0,
	expectedAbort = false,
) {
	expect(fixture.task["currentAgentStep"]).toBe(replacement.step)
	expect({
		runId: fixture.task["agentRunId"],
		turnId: fixture.task["agentTurnId"],
		stepId: fixture.task["currentAgentStep"]?.stepId,
		requestId: fixture.task["currentAgentStep"]?.requestId,
		attemptId: fixture.task["currentAgentStep"]?.attemptId,
		surface: fixture.task["currentTaskToolSurface"],
	}).toEqual(replacement.identity)
	expect(fixture.task.apiConversationHistory).toBe(replacement.historyReference)
	expect(fixture.task.apiConversationHistory).toEqual(replacement.history)
	expect(await fixture.history()).toEqual(replacement.disk)
	expect(fixture.task.userMessageContent).toBe(replacement.pending)
	expect(fixture.task.userMessageContent).toEqual([{ type: "text", text: "Replacement pending sentinel." }])
	expect(fixture.task.userMessageContentReady).toBe(true)
	expect(fixture.task["persistedToolResultIds"]).toBe(replacement.persistedIds)
	expect([...fixture.task["persistedToolResultIds"]]).toEqual(["replacement-receipt"])
	expect(fixture.publications.slice(replacement.publicationCount)).toEqual([])
	expect(await fixture.journal.replay()).toEqual(replacement.journal)
	expect(fixture.task["canonicalLifecyclePersistenceFailure"]).toBe(replacement.lifecycleFailure)
	expect(fixture.task.isCompleted()).toBe(false)
	expect(fixture.task.abort).toBe(expectedAbort)
	expect(fixture.task.ask).not.toHaveBeenCalled()
	expect(fixture.createMessage).toHaveBeenCalledOnce()
	expect(fixture.effect).toHaveBeenCalledTimes(effectCount)
	expect(fixture.stagedResults).not.toHaveBeenCalled()
	expect(fixture.capturedRequests[0].hasRetainedRequest?.()).toBe(false)
	expect(replacement.step?.releaseRequest).not.toHaveBeenCalled()
	expect(JSON.stringify(fixture.task.apiConversationHistory)).not.toContain(fixture.callId)
	expect(JSON.stringify(fixture.task.userMessageContent)).not.toContain(fixture.callId)
}

const omittedReadId = "omitted-approved-read"
type OmissionEnding = "failed salvage" | "incomplete salvage" | "healthy"

async function omittedReadRepair(ending: OmissionEnding, onOmissionPublished?: (task: Task) => void | Promise<void>) {
	const dispatchSettled = deferred()
	const finalizer = vi.fn(async () => undefined)
	const fixture = await harness(
		async function* (attempt) {
			if (attempt !== 1) throw new Error("An omitted read must not cause another provider request.")
			yield { type: "text", text: "The finalized answer omits an accepted read envelope." }
			yield {
				type: "tool_call",
				id: omittedReadId,
				name: "exec_command",
				arguments: '{"cmd":"git status --short"}',
			}
			yield { type: "tool_call_end", id: omittedReadId }
			await dispatchSettled.promise
			if (ending === "healthy") {
				yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
				return
			}
			if (ending === "incomplete salvage") {
				yield createApiStreamOutcome({ status: "incomplete", semanticOutputObserved: true, retryable: false })
			}
			throw transportFailure({ retryable: false })
		},
		{},
		{ finalizeEarlyRead: finalizer },
	)
	const execution = fixture.task as unknown as {
		executeCanonicalToolCalls: Task["executeCanonicalToolCalls"]
	}
	const execute = execution.executeCanonicalToolCalls.bind(fixture.task)
	vi.spyOn(execution, "executeCanonicalToolCalls").mockImplementation(async (...args) => {
		const outcome = await execute(...args)
		if (args[5]?.deferResultCommit) dispatchSettled.resolve()
		return outcome
	})
	const finish = AgentResponseAccumulator.prototype.finish
	const finishSpy = vi.spyOn(AgentResponseAccumulator.prototype, "finish").mockImplementation(async function (
		this: AgentResponseAccumulator,
		...args: Parameters<AgentResponseAccumulator["finish"]>
	) {
		const response = await finish.apply(this, args)
		return createAgentResponse(
			response.items.filter((item) => item.type !== "tool_call"),
			response.outcome,
		)
	})
	const publications: AgentLifecycleEventInput[] = []
	let omissions = 0
	const publish = fixture.provider.publishAgentLifecycleEvent.bind(fixture.provider)
	vi.spyOn(fixture.provider, "publishAgentLifecycleEvent").mockImplementation(async (input, options) => {
		publications.push(structuredClone(input))
		const result = await publish(input, options)
		const item = "item" in input.payload ? input.payload.item : undefined
		if (
			input.type === "tool_result_recorded" &&
			item !== undefined &&
			item !== null &&
			typeof item === "object" &&
			"toolCallId" in item &&
			item.toolCallId === omittedReadId &&
			"output" in item &&
			typeof item.output === "string" &&
			item.output.includes("omitted a durably accepted read call")
		) {
			omissions += 1
			await onOmissionPublished?.(fixture.task)
		}
		return result
	})
	return {
		...fixture,
		finalizer,
		publications,
		omissions: () => omissions,
		releaseSource: () => dispatchSettled.resolve(),
		restoreFinish: () => finishSpy.mockRestore(),
	}
}

type OmissionFixture = Awaited<ReturnType<typeof omittedReadRepair>>
type TranscriptOwnerFixture = Pick<OmissionFixture, "task" | "history" | "journal" | "publications">
type WriterAdmission = { messages: ApiMessage[]; liveHistory: ApiMessage[] }

function captureWriterAdmission(task: Task, messages: readonly ApiMessage[]): WriterAdmission {
	return { messages: structuredClone([...messages]), liveHistory: structuredClone(task.apiConversationHistory) }
}

async function expectQueuedReplacementBeforeWrite(
	fixture: TranscriptOwnerFixture,
	replacement: Awaited<ReturnType<typeof captureOmissionReplacement>>,
) {
	expect(fixture.task["currentAgentStep"]).toBe(replacement.step)
	expect({
		runId: fixture.task["agentRunId"],
		turnId: fixture.task["agentTurnId"],
		stepId: fixture.task["currentAgentStep"]?.stepId,
		requestId: fixture.task["currentAgentStep"]?.requestId,
		attemptId: fixture.task["currentAgentStep"]?.attemptId,
		surface: fixture.task["currentTaskToolSurface"],
	}).toEqual(replacement.identity)
	expect(fixture.task.apiConversationHistory).toBe(replacement.historyReference)
	expect(fixture.task.apiConversationHistory).toEqual(replacement.history)
	expect(await fixture.history()).toEqual(replacement.disk)
	expect(fixture.task.userMessageContent).toBe(replacement.pending)
	expect(fixture.task.userMessageContent).toEqual([{ type: "text", text: "Replacement pending sentinel." }])
	expect(fixture.publications.slice(replacement.publicationCount)).toEqual([])
	expect(await fixture.journal.replay()).toEqual(replacement.journal)
	expect(fixture.task["canonicalLifecyclePersistenceFailure"]).toBe(replacement.lifecycleFailure)
}

function stageOmissionReplacement(
	task: Task,
	change: "run and step" | "primitive identity" | "step object" = "run and step",
) {
	const step = task["currentAgentStep"]!
	expect(step).toBeDefined()
	const replacementRelease = vi.fn<typeof step.releaseRequest>()
	if (change === "primitive identity") {
		Object.assign(step, {
			stepId: `${step.stepId}-replacement`,
			requestId: `${step.requestId}-replacement`,
			attemptId: `${step.attemptId}-replacement`,
		})
	} else if (change === "step object") {
		task["currentAgentStep"] = { ...step, stepId: `${step.stepId}-replacement`, releaseRequest: replacementRelease }
	} else {
		const turnId = `${step.turnId}-replacement`
		const surface = createTaskToolSurface({ registry: step.surface!.registry, mode: "code" })
		task["agentRunId"] = `${task["agentRunId"]}-replacement`
		task["agentTurnId"] = turnId
		task["currentTaskToolSurface"] = surface
		task["currentAgentStep"] = {
			...step,
			releaseRequest: replacementRelease,
			surface,
			turnId,
			stepId: `${step.stepId}-replacement`,
			requestId: `${step.requestId}-replacement`,
			attemptId: `${step.attemptId}-replacement`,
		}
	}
	const pending: Task["userMessageContent"] = [{ type: "text", text: "Replacement pending sentinel." }]
	task.userMessageContent = pending
	const sentinel: ApiMessage[] = [
		{ role: "user", content: [{ type: "text", text: "Replacement provider history sentinel." }], ts: 1 },
	]
	task.apiConversationHistory = sentinel
	return { pending, sentinel }
}

async function captureOmissionReplacement(fixture: TranscriptOwnerFixture, pending: Task["userMessageContent"]) {
	const task = fixture.task
	return {
		pending,
		step: task["currentAgentStep"],
		identity: {
			runId: task["agentRunId"],
			turnId: task["agentTurnId"],
			stepId: task["currentAgentStep"]?.stepId,
			requestId: task["currentAgentStep"]?.requestId,
			attemptId: task["currentAgentStep"]?.attemptId,
			surface: task["currentTaskToolSurface"],
		},
		historyReference: task.apiConversationHistory,
		history: structuredClone(task.apiConversationHistory),
		disk: await fixture.history(),
		journal: structuredClone(fixture.journal.getSnapshot()),
		publicationCount: fixture.publications.length,
		lifecycleFailure: task["canonicalLifecyclePersistenceFailure"],
	}
}

async function replaceOmissionOwner(
	fixture: OmissionFixture,
	change: "run and step" | "primitive identity" | "step object" = "run and step",
) {
	const { pending, sentinel } = stageOmissionReplacement(fixture.task, change)
	const task = fixture.task
	expect(await task.overwriteApiConversationHistory(sentinel)).toBe(true)
	expect(await fixture.history()).toEqual(sentinel)
	return captureOmissionReplacement(fixture, pending)
}

async function expectOmissionReplacementUnchanged(
	fixture: OmissionFixture,
	replacement: Awaited<ReturnType<typeof replaceOmissionOwner>>,
) {
	expect(fixture.task["currentAgentStep"]).toBe(replacement.step)
	expect({
		runId: fixture.task["agentRunId"],
		turnId: fixture.task["agentTurnId"],
		stepId: fixture.task["currentAgentStep"]?.stepId,
		requestId: fixture.task["currentAgentStep"]?.requestId,
		attemptId: fixture.task["currentAgentStep"]?.attemptId,
		surface: fixture.task["currentTaskToolSurface"],
	}).toEqual(replacement.identity)
	expect(fixture.task.apiConversationHistory).toBe(replacement.historyReference)
	expect(fixture.task.apiConversationHistory).toEqual(replacement.history)
	expect(await fixture.history()).toEqual(replacement.disk)
	expect(fixture.task.userMessageContent).toBe(replacement.pending)
	expect(fixture.task.userMessageContent).toEqual([{ type: "text", text: "Replacement pending sentinel." }])
	expect(fixture.publications.slice(replacement.publicationCount)).toEqual([])
	expect(await fixture.journal.replay()).toEqual(replacement.journal)
	expect(fixture.task["canonicalLifecyclePersistenceFailure"]).toBe(replacement.lifecycleFailure)
	expect(fixture.task.isCompleted()).toBe(false)
	expect(fixture.task.abort).toBe(false)
	expect(fixture.task.ask).not.toHaveBeenCalled()
	expect(fixture.createMessage).toHaveBeenCalledOnce()
	expect(fixture.capturedRequests[0].hasRetainedRequest?.()).toBe(false)
	if (replacement.step !== fixture.capturedRequests[0])
		expect(replacement.step?.releaseRequest).not.toHaveBeenCalled()
	expect(fixture.effect).toHaveBeenCalledOnce()
	expect(fixture.finalizer).not.toHaveBeenCalled()
	expect(fixture.omissions()).toBe(1)
}
