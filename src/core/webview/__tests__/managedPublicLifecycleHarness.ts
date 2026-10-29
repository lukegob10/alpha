import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import * as vscode from "vscode"
import { vi, type Mock } from "vitest"
import { AlphaCodeEventName, type AlphaCodeSettings, type ProviderSettings } from "@alpha-code/types"

import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ApiStreamChunk, ApiStreamRequestMetadata } from "../../../api/transform/stream"
import { ContextProxy } from "../../config/ContextProxy"
import { Task } from "../../task/Task"
import type { AgentControlStore } from "../../agent/AgentControlStore"
import type { AsyncSubagentRunManager } from "../../agent/AsyncSubagentRunManager"
import type { InternalTaskResult } from "../../agent/BoundedDelegationManager"
import { AlphaProvider } from "../AlphaProvider"
import type { TaskSessionRegistry } from "../TaskSessionRegistry"

// Only transport, discovery and presentation adapters are isolated. The provider
// constructor, Task constructor/loop, journals, transcripts, history, managers,
// reservations, restoration and resource-release methods remain production code.
const apiBoundary = vi.hoisted(() => ({
	build: undefined as ((configuration: ProviderSettings) => ApiHandler) | undefined,
}))

vi.mock("../../../api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../api")>()
	return {
		...actual,
		buildApiHandler: (configuration: ProviderSettings) => {
			if (!apiBoundary.build) throw new Error("Public lifecycle scripted transport is not installed")
			return apiBoundary.build(configuration)
		},
	}
})
vi.mock("delay", () => ({ default: () => Promise.resolve() }))
vi.mock("@alpha-code/telemetry", () => {
	const methods = new Map<string, ReturnType<typeof vi.fn>>()
	const instance = new Proxy(
		{},
		{
			get: (_target, name: string) => {
				if (!methods.has(name)) methods.set(name, vi.fn())
				return methods.get(name)
			},
		},
	)
	return { TelemetryService: { instance, hasInstance: () => true } }
})
vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: class {
		dispose() {}
	},
}))
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))
vi.mock("../../../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		getInstance: async () => ({
			registerClient() {},
			getServers: () => [],
			getAllServers: () => [],
		}),
		unregisterProvider: async () => undefined,
	},
}))
vi.mock("../../../services/marketplace", () => ({
	MarketplaceManager: class {
		cleanup() {}
	},
}))
vi.mock("../../../services/skills/SkillsManager", () => ({
	SkillsManager: class {
		async initialize() {}
		async dispose() {}
		getSkillsForMode() {
			return []
		}
		async getSkillContent() {
			return null
		}
		async getSkillContentByPath() {
			return null
		}
	},
}))
vi.mock("../../config/CustomModesManager", () => ({
	CustomModesManager: class {
		async getCustomModes() {
			return []
		}
		dispose() {}
	},
}))
vi.mock("../../config/ProviderSettingsManager", () => ({
	ProviderProfileRenameError: class extends Error {},
	ProviderProfileSaveError: class extends Error {},
	ProviderSettingsManager: class {
		async getAvailableProfile() {
			return { apiProvider: "openai", openAiModelId: "ws08-scripted" }
		}
		async getProfile() {
			return { id: "scripted", name: "Scripted", apiProvider: "openai", openAiModelId: "ws08-scripted" }
		}
		async listConfig() {
			return [{ id: "scripted", name: "Scripted" }]
		}
		async getModeConfigId() {
			return undefined
		}
	},
}))
vi.mock("../../ignore/AlphaIgnoreController", () => ({
	AlphaIgnoreController: class {
		async initialize() {}
		getInstructions() {
			return ""
		}
		validateAccess() {
			return true
		}
		filterPaths(paths: string[]) {
			return paths
		}
		dispose() {}
	},
}))
vi.mock("../../protect/AlphaProtectedController")
vi.mock("../../context-tracking/FileContextTracker")
vi.mock("../../../integrations/editor/DiffViewProvider")
vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: async () => "",
	captureEnvironmentDetails: async () => ({ details: "", commit() {}, release() {} }),
}))
vi.mock("../../mentions", () => ({
	parseMentions: async (text: string) => ({ text, mode: undefined, contentBlocks: [] }),
	openMention: async () => undefined,
	getLatestTerminalOutput: async () => "",
}))
vi.mock("../../prompts/sections/custom-instructions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../prompts/sections/custom-instructions")>()
	return {
		...actual,
		loadApplicableAgentInstructionSources: async () => [],
		addCustomInstructions: async () => "WS08_FROZEN_REPOSITORY_INSTRUCTIONS",
	}
})
vi.mock("../../prompts/system", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../prompts/system")>()
	return {
		...actual,
		SYSTEM_PROMPT_FRAGMENTS: async () => ({
			systemPrefix: "Offline scripted lifecycle fixture.",
			userContext: "",
			systemSuffix: "",
			instructionParts: [],
		}),
	}
})

export function deferred<T = void>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((complete, fail) => {
		resolve = complete
		reject = fail
	})
	return { promise, resolve, reject }
}

export interface ScriptedTurn {
	taskId: string
	summary: string
	chunks?: ApiStreamChunk[]
	entered: Promise<void>
	progressed: Promise<void>
	request?: ApiHandlerCreateMessageMetadata
	messages?: Parameters<ApiHandler["createMessage"]>[1]
	release(): void
}

export type ScriptedApiHandler = ApiHandler & {
	modelId: string
	dispose: Mock<() => void>
	prepareModel: Mock<(metadata?: ApiStreamRequestMetadata) => Promise<void>>
}

export interface PublicChild {
	task: Task
	taskId: string
	path: string
	handle: { taskId: string; runId: string; path: string; groupId: string }
	turn: ScriptedTurn
	finalization: Promise<void>
	result?: InternalTaskResult
}

export async function createManagedPublicLifecycleHarness(
	options: { maxLiveTasks?: number; rootObjective?: string } = {},
) {
	const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ws08-public-"))
	const workspacePath = path.join(storagePath, "workspace")
	await fs.mkdir(workspacePath)
	const turns = new Map<
		string,
		Array<
			ScriptedTurn & {
				permit: ReturnType<typeof deferred<void>>
				start: ReturnType<typeof deferred<void>>
				progress: ReturnType<typeof deferred<void>>
				beforeHold: ApiStreamChunk[]
			}
		>
	>()
	const allTurns: ScriptedTurn[] = []
	const handlers: ScriptedApiHandler[] = []
	const replacements = new Map<string, ScriptedApiHandler>()
	const childrenCaptured: Task[] = []
	const settings: AlphaCodeSettings = {
		mode: "code",
		apiProvider: "openai",
		openAiModelId: "ws08-scripted",
		currentApiConfigName: "Scripted",
		maxConcurrentTasks: options.maxLiveTasks ?? 3,
		maxConcurrentSubagents: 2,
		subagentMaxDepth: 1,
		subagentDelegationPolicy: "proactive",
		subagentMaxInputTokens: 250_000,
		subagentMaxOutputTokens: 16_000,
		subagentRootTokenBudget: 1_000_000,
		subagentRootCostBudget: 10,
		approvalMode: "auto",
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowSubagents: true,
		enableCheckpoints: false,
		rateLimitSeconds: 0,
		customInstructions: "WS08_FROZEN_REPOSITORY_INSTRUCTIONS",
	}
	const makeMemento = () => {
		const values = new Map<string, unknown>()
		return {
			get: <T>(key: string, fallback?: T): T => (values.has(key) ? values.get(key) : fallback) as T,
			update: async (key: string, value: unknown) => {
				values.set(key, value)
			},
			keys: () => [...values.keys()],
			setKeysForSync() {},
		}
	}
	const context = {
		globalStorageUri: vscode.Uri.file(storagePath),
		extensionUri: vscode.Uri.file(workspacePath),
		globalState: makeMemento(),
		workspaceState: makeMemento(),
		secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
		subscriptions: [],
		extension: { packageJSON: { version: "0.0.0-test" } },
		// The normal-config vscode adapter omits the enum; VS Code's Test value is 3.
		extensionMode: 3 as vscode.ExtensionMode,
		asAbsolutePath: (relative: string) => path.join(workspacePath, relative),
	} as unknown as vscode.ExtensionContext
	const contextProxy = new ContextProxy(context)
	await contextProxy.initialize()
	vi.spyOn(contextProxy, "getValues").mockImplementation(() => ({ ...settings }))
	vi.spyOn(contextProxy, "getValue").mockImplementation((key) => settings[key])
	vi.spyOn(contextProxy, "getProviderSettings").mockImplementation(() => ({
		apiProvider: "openai",
		openAiModelId: settings.openAiModelId,
	}))
	const queueTurn = (
		taskId: string,
		summary: string,
		chunks?: ApiStreamChunk[],
		options: { beforeHold?: ApiStreamChunk[] } = {},
	): ScriptedTurn => {
		const start = deferred()
		const permit = deferred()
		const progress = deferred()
		const turn = {
			taskId,
			summary,
			chunks,
			entered: start.promise,
			progressed: progress.promise,
			beforeHold: options.beforeHold ?? [],
			permit,
			start,
			progress,
			release: () => permit.resolve(),
		}
		const pending = turns.get(taskId) ?? []
		pending.push(turn)
		turns.set(taskId, pending)
		allTurns.push(turn)
		return turn
	}
	const makeHandler = (modelId: string): ScriptedApiHandler => {
		const handler: ScriptedApiHandler = {
			modelId,
			streamCapabilities: { lifecycle: true, cancellation: true },
			dispose: vi.fn(),
			prepareModel: vi.fn<(metadata?: ApiStreamRequestMetadata) => Promise<void>>(async () => undefined),
			getModel: () => ({
				id: modelId,
				info: {
					contextWindow: 128_000,
					maxTokens: 8_000,
					supportsImages: false,
					supportsPromptCache: false,
					inputPrice: 0,
					outputPrice: 0,
				},
			}),
			countTokens: async (content) => Math.ceil(JSON.stringify(content).length / 4),
			async *createMessage(_system, _messages, metadata) {
				if (!metadata) throw new Error("Scripted transport requires real request metadata")
				// Title generation shares the task ID, but must not consume a held agent turn.
				if (metadata.attemptId === "title") {
					yield { type: "text", text: "Verify lifecycle ownership" }
					yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
					return
				}
				const turn = turns.get(metadata.taskId)?.shift()
				if (!turn) throw new Error(`No scripted response for ${metadata.taskId}`)
				turn.request = metadata
				turn.messages = structuredClone(_messages)
				turn.start.resolve()
				const cancelled = deferred<never>()
				const onAbort = () => cancelled.reject(metadata.signal?.reason ?? new Error("Task cancelled"))
				metadata.signal?.addEventListener("abort", onAbort, { once: true })
				try {
					if (metadata.signal?.aborted) onAbort()
					for (const chunk of turn.beforeHold) yield chunk
					// The consumer requested another chunk after observing all progress.
					turn.progress.resolve()
					await Promise.race([turn.permit.promise, cancelled.promise])
				} finally {
					metadata.signal?.removeEventListener("abort", onAbort)
				}
				yield { type: "usage", inputTokens: 2, outputTokens: 3, totalCost: 0.001 }
				for (const chunk of turn.chunks ?? [{ type: "text" as const, text: turn.summary }]) yield chunk
				yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
			},
		}
		handlers.push(handler)
		return handler
	}
	apiBoundary.build = (configuration) =>
		replacements.get(configuration.openAiModelId ?? "") ??
		makeHandler(configuration.openAiModelId ?? "ws08-scripted")
	const output = {
		appendLine: vi.fn(),
		append: vi.fn(),
		clear: vi.fn(),
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn(),
	}
	const provider = new AlphaProvider(context, output as unknown as vscode.OutputChannel, "sidebar", contextProxy)
	provider.on(AlphaCodeEventName.TaskCreated, (task) => {
		if (task.taskKind !== "subagent") return
		if (!(task instanceof Task)) throw new Error("Public lifecycle fixture requires an actual subagent Task")
		childrenCaptured.push(task)
	})
	vi.spyOn(provider, "getState").mockImplementation(
		async () =>
			({
				...settings,
				apiConfiguration: contextProxy.getProviderSettings(),
				customModes: [],
				experiments: {},
			}) as Awaited<ReturnType<AlphaProvider["getState"]>>,
	)
	for (const name of [
		"postTaskStateToWebview",
		"postTaskSessionStateToWebview",
		"postStateToWebview",
		"postStateToWebviewWithoutTaskHistory",
		"postStateToWebviewWithoutAlphaMessages",
		"postTaskQueueToWebview",
		"postMessageToWebview",
	] as const) {
		vi.spyOn(provider, name).mockResolvedValue(undefined)
	}
	await Promise.all([
		Reflect.get(provider, "agentControlStoreReady"),
		Reflect.get(provider, "taskHistoryStoreReady"),
		Reflect.get(provider, "mcpHubInitialization"),
	])
	const root = await provider.createTask(
		options.rootObjective ?? "Integrate and verify the short child reports.",
		undefined,
		undefined,
		{
			startTask: false,
			taskMode: "code",
			workspacePath,
			enableCheckpoints: false,
		},
	)
	const taskSessions = Reflect.get(provider, "taskSessions") as TaskSessionRegistry
	const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
	const runs = Reflect.get(provider, "asyncSubagentRunManager") as AsyncSubagentRunManager
	type Finalization = Promise<void> | { readonly promise: Promise<void> }
	const finalizations = () => Reflect.get(provider, "subagentRunFinalizations") as Map<string, Finalization>
	const finalizationPromise = (entry: Finalization) => ("promise" in entry ? entry.promise : entry)
	const settleFinalizations = async (options: { includeResidency?: boolean } = {}) => {
		for (;;) {
			const pending = [...finalizations().values()].map(finalizationPromise)
			if (!pending.length) break
			await Promise.all(pending)
		}
		if (options.includeResidency) await Reflect.get(provider, "subagentResidencyPrune")
	}
	const spawnChild = async (label: string): Promise<PublicChild> => {
		const prepared = await provider.prepareSubagentGroup(root, [
			{
				task_name: label.replaceAll("-", "_"),
				objective: `Review ${label} without changing files.`,
				agent_kind: "review",
				fork_turns: "none",
				expected_output: ["A short verified report"],
			},
		])
		const taskId = prepared.envelopes[0].id
		const turn = queueTurn(taskId, `Verified report for ${label}.`)
		const handle = await provider.launchPreparedSubagentGroup(
			root,
			prepared,
			root.getTaskLifetimeCancellationSignal(),
		)
		const entry = finalizations().get(taskId)
		if (!entry) throw new Error("Public launch did not expose its owned finalization")
		const finalization = finalizationPromise(entry)
		await turn.entered
		const task = provider.getLiveTask(taskId)
		if (!task) throw new Error("Public launch did not register its actual Task")
		return { task, taskId, path: handle.path, handle, turn, finalization }
	}
	const spawnCompletedChild = async (label: string): Promise<PublicChild> => {
		const child = await spawnChild(label)
		child.turn.release()
		child.result = await runs.waitForResult(child.taskId)
		await child.finalization
		await child.task.waitForTermination()
		return child
	}
	const createReplacementHandler = (modelId: string) => {
		const handler = makeHandler(modelId)
		replacements.set(modelId, handler)
		return handler
	}
	const cleanup = async () => {
		for (const turn of allTurns) turn.release()
		const failures: unknown[] = []
		try {
			await provider.dispose()
		} catch (error) {
			failures.push(error)
		}
		const queues = new Set([root, ...childrenCaptured].map((task) => task.messageQueueService))
		for (const queue of queues) {
			try {
				await queue.flush()
			} catch (error) {
				failures.push(error)
			}
		}
		try {
			await store.shutdown()
		} catch (error) {
			failures.push(error)
		} finally {
			apiBoundary.build = undefined
		}
		const relative = path.relative(os.tmpdir(), storagePath)
		if (path.isAbsolute(relative) || relative.startsWith("..") || !relative.startsWith("alpha-ws08-public-")) {
			throw new Error("Refusing to remove a fixture path outside its temporary root")
		}
		if (failures.length)
			throw new AggregateError(
				failures,
				"Actual public lifecycle fixture cleanup failed; temporary evidence retained",
			)
		await fs.rm(storagePath, { recursive: true, force: true })
	}
	return {
		provider,
		root,
		taskSessions,
		store,
		runs,
		settings,
		storagePath,
		childrenCaptured,
		handlers,
		queueTurn,
		spawnChild,
		spawnCompletedChild,
		settleFinalizations,
		createReplacementHandler,
		cleanup,
	}
}
