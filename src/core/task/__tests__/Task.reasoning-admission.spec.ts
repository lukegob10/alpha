import type { ModelInfo, ProviderSettings, TaskReasoningState } from "@alpha-code/types"

import type { ApiHandler } from "../../../api"
import { summarizeConversation } from "../../condense"
import { AgentStepContextBuilder, type AgentStepSnapshot } from "../../agent/AgentStepContextBuilder"
import { manageContext, willManageContext } from "../../context-management"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { Task } from "../Task"

vi.mock("../build-tools", async (importOriginal) => ({
	...(await importOriginal<typeof import("../build-tools")>()),
	buildNativeToolsArrayWithRestrictions: vi.fn(),
}))

vi.mock("../../context-management", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../context-management")>()),
	manageContext: vi.fn(),
	willManageContext: vi.fn(() => false),
}))

vi.mock("../../condense", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../condense")>()),
	summarizeConversation: vi.fn(),
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function surface() {
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "read_file",
		aliases: [],
		schema: {
			type: "function",
			function: { name: "read_file", description: "read file", parameters: { type: "object", properties: {} } },
		},
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
		execute: vi.fn(async () => {}),
	})
	return createTaskToolSurface({ registry, applyProfile: false })
}

function reasoningState(effort: "low" | "high"): TaskReasoningState {
	return {
		requested: { kind: "effort", effort: "high" },
		effective: { kind: "effort", effort },
		capabilities: { kind: "effort", efforts: [effort], canDisable: true },
		...(effort === "low" ? { fallbackReason: "unsupported" as const } : {}),
	}
}

function modelInfo(effort: "low" | "high"): ModelInfo {
	return {
		contextWindow: 128_000,
		maxTokens: 4096,
		supportsImages: true,
		supportsPromptCache: false,
		supportsReasoningEffort: [effort],
		reasoningEffort: effort,
	}
}

function dynamicHandler() {
	let live = false
	const streamStarted = deferred<void>()
	const releaseStream = deferred<void>()
	const setReasoningOptions = vi.fn()
	const prepareModel = vi.fn(async () => {
		live = true
	})
	const createMessage = vi.fn<ApiHandler["createMessage"]>(async function* () {
		streamStarted.resolve()
		await releaseStream.promise
		yield { type: "text", text: "response" }
	})
	const api = {
		getModel: () => ({ id: live ? "live-low-model" : "static-high-model", info: modelInfo(live ? "low" : "high") }),
		countTokens: vi.fn(async () => 1),
		createMessage,
		prepareModel,
		setReasoningOptions,
		streamCapabilities: { lifecycle: true, cancellation: true },
	} as ApiHandler & { setReasoningOptions: ReturnType<typeof vi.fn> }
	return { api, createMessage, prepareModel, setReasoningOptions, streamStarted, releaseStream }
}

function harness() {
	const baseConfiguration: ProviderSettings = {
		apiProvider: "vscode-lm",
		vsCodeLmModelSelector: { vendor: "copilot", family: "static-high" },
		enableReasoningEffort: true,
		reasoningEffort: "high",
	}
	const activeHandler = dynamicHandler()
	const currentSurface = surface()
	const provider = {
		getState: vi.fn(async () => ({
			mode: "code",
			autoCondenseContext: false,
			autoApprovalEnabled: false,
		})),
		postMessageToWebview: vi.fn(async () => {}),
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "reasoning-admission",
		instanceId: "reasoning-admission-instance",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		abandoned: false,
		isStreaming: false,
		isWaitingForFirstChunk: false,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		externalMutationLease: undefined,
		taskCancellationController: new AbortController(),
		pendingCommandVerification: Promise.resolve(),
		api: activeHandler.api,
		apiConfiguration: baseConfiguration,
		effectiveApiConfiguration: { ...baseConfiguration },
		reasoningPreference: { kind: "effort", effort: "high" },
		reasoningState: reasoningState("high"),
		reasoningByHandler: new WeakMap([[activeHandler.api, reasoningState("high")]]),
		retainedReasoningHandlers: new Set(),
		reasoningHandlerUsers: new Map(),
		providerRef: { deref: () => provider },
		apiConversationHistory: [{ role: "user", content: "original request" }],
		clineMessages: [],
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		currentTaskToolSurface: currentSurface,
		getTaskMode: vi.fn(async () => "code"),
		getSystemPrompt: vi.fn(async () => "System prompt"),
		getCurrentProfileId: vi.fn(async () => "profile"),
		getTokenUsage: vi.fn(() => ({ contextTokens: 0 })),
		getTaskAllowedToolNames: () => undefined,
		shouldExposeAgentLifecycleTools: () => false,
		autoApprovalHandler: { checkAutoApprovalLimits: vi.fn(async () => ({ shouldProceed: true })) },
		ensureCanonicalLifecycleStepStarted: vi.fn(async () => {}),
		publishCanonicalLifecyclePhase: vi.fn(async () => {}),
		appendAgentTurnEvent: vi.fn(async () => {}),
		publishCanonicalLifecyclePendingToolResults: vi.fn(async () => {}),
		saveApiConversationHistory: vi.fn(async () => true),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => {}),
		flushPendingToolResultsToHistory: vi.fn(async () => true),
		getFilesReadByAlphaSafely: vi.fn(async () => undefined),
		environmentContext: { reset: vi.fn() },
		refreshEnvironmentContext: vi.fn(async () => {}),
		say: vi.fn(async () => undefined),
		processQueuedMessages: vi.fn(),
		alphaIgnoreController: {},
		toolCatalogCache: undefined,
	}) as Task

	vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({
		tools: structuredClone([...currentSurface.schemas]),
		surface: currentSurface,
	})
	vi.mocked(manageContext).mockImplementation(async ({ messages }) => ({
		messages,
		summary: "",
		cost: 0,
		prevContextTokens: 0,
	}))
	vi.mocked(willManageContext).mockReturnValue(false)
	vi.mocked(summarizeConversation).mockResolvedValue({
		messages: task.apiConversationHistory,
		summary: "",
		cost: 0,
		status: "unchanged",
	})

	return { task, activeHandler, baseConfiguration }
}

function capturedStep(task: Task) {
	return Reflect.get(task, "currentAgentStep") as {
		snapshot: AgentStepSnapshot<ApiHandler, unknown>
	}
}

describe("Task reasoning admission", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockReset()
		vi.mocked(manageContext).mockReset()
		vi.mocked(willManageContext).mockReturnValue(false)
		vi.mocked(summarizeConversation).mockReset()
	})

	it("re-resolves a static high preference after live model preparation and captures low for the wire step", async () => {
		const { task, activeHandler, baseConfiguration } = harness()
		const request = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
		const firstChunk = request.next()
		await activeHandler.streamStarted.promise

		expect(activeHandler.prepareModel).toHaveBeenCalledOnce()
		expect(activeHandler.setReasoningOptions).toHaveBeenCalledWith(
			expect.objectContaining({ enableReasoningEffort: true, reasoningEffort: "low" }),
		)
		expect(capturedStep(task).snapshot.context.provider.options).toMatchObject({
			enableReasoningEffort: true,
			reasoningEffort: "low",
		})
		expect(task.getReasoningState()).toMatchObject({
			effective: { kind: "effort", effort: "low" },
			current: { effective: { kind: "effort", effort: "low" } },
			pending: false,
			fallbackReason: "unsupported",
		})
		expect(task.apiConfiguration).toEqual(baseConfiguration)
		expect(Reflect.get(task, "effectiveApiConfiguration")).toMatchObject({ reasoningEffort: "low" })

		activeHandler.releaseStream.resolve()
		expect(await firstChunk).toMatchObject({ done: false, value: { type: "text", text: "response" } })
		expect(await request.next()).toEqual({ done: true, value: undefined })
	})

	it("prepares the live model at manual compaction admission before building the summary request", async () => {
		const { task, activeHandler } = harness()

		await task.condenseContext()

		expect(activeHandler.prepareModel).toHaveBeenCalledOnce()
		expect(activeHandler.setReasoningOptions).toHaveBeenCalledWith(
			expect.objectContaining({ enableReasoningEffort: true, reasoningEffort: "low" }),
		)
		expect(task.getReasoningState()).toMatchObject({
			effective: { kind: "effort", effort: "low" },
			fallbackReason: "unsupported",
		})
		expect(Reflect.get(task, "getSystemPrompt")).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ apiConfiguration: expect.objectContaining({ reasoningEffort: "low" }) }),
		)
	})
})
