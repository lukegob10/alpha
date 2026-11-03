import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiHandler } from "../../../api"
import type { ApiStream, ApiStreamChunk } from "../../../api/transform/stream"
import { AgentStepContextBuilder } from "../../agent/AgentStepContextBuilder"
import { AgentRetryPolicy } from "../../agent/AgentRetryPolicy"
import { HookCommandCleanupError, runLifecycleHooks, type CompletionHookConfig } from "../../agent/CompletionHooks"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { Task } from "../Task"

vi.mock("../../agent/CompletionHooks", async (original) => ({
	...(await original<typeof import("../../agent/CompletionHooks")>()),
	runLifecycleHooks: vi.fn(),
}))

const command = { command: process.execPath, args: ["request-observer"] }
const chunks = (values: ApiStreamChunk[] = [{ type: "text", text: "Provider answer" }]): ApiStream =>
	(async function* () {
		yield* values
	})()
const collect = async (stream: ApiStream) => {
	const values: ApiStreamChunk[] = []
	for await (const value of stream) values.push(value)
	return values
}
const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture() {
	const configuration: CompletionHookConfig = {
		stop: [],
		subagentStop: [],
		preModelRequest: [structuredClone(command)],
		postModelRequest: [structuredClone(command)],
	}
	const api: ApiHandler = {
		getModel: () => ({
			id: "captured-model",
			info: { contextWindow: 128_000, maxTokens: 4_096, supportsPromptCache: false },
		}),
		countTokens: vi.fn(async () => 0),
		createMessage: vi.fn(() => chunks()),
	}
	const surface = createTaskToolSurface({
		registry: new ToolRegistry({ includeBuiltIns: false }),
		mode: "code",
		applyProfile: false,
		approvalMode: "ask",
		autoApprovalEnabled: false,
		readGrant: { enabled: false, workspaceRoot: process.cwd(), showIgnoredFiles: false },
		execution: { workspaceRoots: [process.cwd()] },
	})
	const builder = new AgentStepContextBuilder<ApiHandler>()
	const request = {
		systemPrompt: "System fixture",
		messages: [{ role: "user" as const, content: "Human fixture" }],
		metadata: { taskId: "request-hook-task" },
	}
	const snapshot = builder.build({
		kind: "agent",
		retryAttempt: 0,
		task: { taskId: "request-hook-task", cwd: process.cwd() },
		mode: { slug: "code" },
		provider: { modelId: "captured-model", modelInfo: api.getModel().info, options: {} },
		instructions: { systemPrompt: request.systemPrompt, sources: [] },
		environment: { roots: [], capabilities: [] },
		transcript: {
			messages: request.messages,
			boundary: { startIndex: 0, endIndex: 1, messageCount: 1, digest: "fixture" },
		},
		tools: { schemas: [], parallelToolCalls: false, digest: "fixture" },
		policy: surface.policy,
		budget: { contextWindow: 128_000, compaction: { action: "none", attempted: false } },
		request: { metadata: request.metadata },
		handler: api,
	})
	const step = {
		snapshot,
		surface,
		turnId: "captured-turn",
		stepId: "captured-step",
		requestId: "captured-request",
		attemptId: "first-attempt",
		getRequest: () => structuredClone(request),
		releaseRequest() {},
		createReasoningSummaryHandler: () => api,
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "request-hook-task",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		taskCancellationController: new AbortController(),
		apiConversationHistoryOwnerGeneration: 42,
		isCurrentApiConversationHistoryOwner: vi.fn(() => true),
		providerRef: { deref: () => undefined },
		agentRunId: "captured-run",
		agentTurnId: "captured-turn",
		agentTurnStep: 1,
		currentAgentStep: step,
		currentTaskToolSurface: surface,
		agentStepContextBuilder: builder,
		completionHookConfig: configuration,
		completionHookTranscriptPath: vi.fn(async () => null),
		apiConversationHistory: structuredClone(request.messages),
		alphaMessages: [],
		userMessageContent: [],
		pendingLifecycleHookContexts: [],
		api,
		apiConfiguration: { apiProvider: "openai", openAiModelId: "captured-model" },
		getTokenUsage: vi.fn(() => ({ contextTokens: 0 })),
		autoApprovalHandler: { checkAutoApprovalLimits: vi.fn(async () => ({ shouldProceed: true })) },
		combineMessages: vi.fn((messages) => messages),
		ensureCanonicalLifecycleStepStarted: vi.fn(async () => undefined),
		publishCanonicalLifecyclePhase: vi.fn(async () => undefined),
		appendAgentTurnEvent: vi.fn(async () => undefined),
		backoffAndAnnounce: vi.fn(async () => undefined),
		agentRetryPolicy: new AgentRetryPolicy({ baseDelayMs: 0, jitter: "none" }),
		publishLifecycleHookMessage: vi.fn(),
		queueLifecycleHookContext: vi.fn(),
		say: vi.fn(),
	}) as Task
	const attempt = (ownerHandlesRetry = true, interruptionSignal?: AbortSignal) =>
		task["attemptCapturedApiRequest"](
			0,
			{
				state: { autoApprovalEnabled: true } as Parameters<Task["attemptCapturedApiRequest"]>[1]["state"],
				retryCategory: "transport",
				skipProviderRateLimit: true,
				ownerHandlesRetry,
				interruptionSignal,
			},
			{ apiHandler: api, apiConfiguration: { apiProvider: "openai", openAiModelId: "captured-model" } },
		)
	return { task, api, configuration, attempt }
}

beforeEach(() => {
	vi.mocked(runLifecycleHooks).mockReset().mockResolvedValue({ warnings: [] })
	vi.spyOn(console, "warn").mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe("Task model request observations", () => {
	it("wraps the normal request with captured metadata/config and never publishes observer controls or context", async () => {
		const { task, configuration, api, attempt } = fixture()
		const before = structuredClone(task.apiConversationHistory)
		vi.mocked(runLifecycleHooks).mockImplementation(async (_config, request) => {
			if (request.hook_event_name === "PreModelRequest") {
				configuration.postModelRequest![0].timeoutMs = 12
				task["completionHookConfig"] = { stop: [], subagentStop: [] }
			}
			return {
				warnings: ["Diagnostic"],
				shouldStop: true,
				shouldBlock: true,
				additionalContext: [{ hook_run_id: "observer", text: "Injected" }],
			}
		})
		expect(await collect(attempt())).toEqual([{ type: "text", text: "Provider answer" }])
		expect(api.createMessage).toHaveBeenCalledOnce()
		const requests = vi.mocked(runLifecycleHooks).mock.calls.map(([, request]) => request)
		expect(requests.map(({ hook_event_name }) => hook_event_name)).toEqual(["PreModelRequest", "PostModelRequest"])
		for (const request of requests) {
			expect(request).toMatchObject({
				session_id: task.taskId,
				turn_id: "captured-turn",
				model: "captured-model",
				transcript_path: null,
			})
			expect(request).not.toHaveProperty("permission_mode")
		}
		expect(vi.mocked(runLifecycleHooks).mock.calls[1][0].postModelRequest![0]).not.toHaveProperty("timeoutMs")
		expect(task.apiConversationHistory).toEqual(before)
		expect(task.userMessageContent).toEqual([])
		expect(task["publishLifecycleHookMessage"]).not.toHaveBeenCalled()
		expect(task["queueLifecycleHookContext"]).not.toHaveBeenCalled()
		expect(task["lifecycleHookStoppedThisTurn"]).not.toBe(true)
	})

	it("wraps each direct compatibility retry without letting an observer failure create a retry", async () => {
		const { api, task, attempt } = fixture()
		const failure = new Error("Provider unavailable")
		vi.mocked(api.createMessage).mockImplementationOnce(() =>
			(async function* (): ApiStream {
				yield* []
				throw failure
			})(),
		)
		vi.mocked(runLifecycleHooks).mockRejectedValue(new Error("Observer failed"))
		expect(await collect(attempt(false))).toEqual([{ type: "text", text: "Provider answer" }])
		expect(api.createMessage).toHaveBeenCalledTimes(2)
		expect(task["backoffAndAnnounce"]).toHaveBeenCalledOnce()
		const requests = vi.mocked(runLifecycleHooks).mock.calls.map(([, request]) => request)
		expect(requests.map(({ hook_event_name }) => hook_event_name)).toEqual([
			"PreModelRequest",
			"PostModelRequest",
			"PreModelRequest",
			"PostModelRequest",
		])
		expect(requests[1]).toMatchObject({ status: "failed", error: "Model request failed." })
		expect(requests[3]).toMatchObject({ status: "completed", error: null })
	})

	it("preserves the original provider failure when the owner handles retry", async () => {
		const { api, task, attempt } = fixture()
		const failure = new Error("Provider failure")
		vi.mocked(api.createMessage).mockImplementation(() =>
			(async function* (): ApiStream {
				yield* []
				throw failure
			})(),
		)
		vi.mocked(runLifecycleHooks).mockRejectedValue(new Error("Observer failed"))
		await expect(collect(attempt())).rejects.toBe(failure)
		expect(api.createMessage).toHaveBeenCalledOnce()
		expect(task["backoffAndAnnounce"]).not.toHaveBeenCalled()
	})

	it("holds ordinary EOF until the synchronous Post observation finishes", async () => {
		const { attempt } = fixture()
		const entered = barrier(),
			release = barrier()
		vi.mocked(runLifecycleHooks).mockImplementation(async (_config, request) => {
			if (request.hook_event_name === "PostModelRequest") {
				entered.resolve()
				await release.promise
			}
			return { warnings: [] }
		})
		let finished = false
		const collecting = collect(attempt()).then(() => {
			finished = true
		})
		await entered.promise
		expect(finished).toBe(false)
		release.resolve()
		await collecting
		expect(finished).toBe(true)
	})

	it("keeps cancelled Post owned across a delayed transcript lookup and same-instance step handoff", async () => {
		const { task, api, attempt } = fixture()
		const entered = barrier(),
			release = barrier(),
			postEntered = barrier(),
			postRelease = barrier()
		Object.assign(task, {
			completionHookTranscriptPath: vi.fn(async () => {
				entered.resolve()
				await release.promise
				return null
			}),
		})
		vi.mocked(runLifecycleHooks).mockImplementation(async (_config, request) => {
			if (request.hook_event_name === "PostModelRequest") {
				postEntered.resolve()
				await postRelease.promise
			}
			return { warnings: [] }
		})
		const interruption = new AbortController()
		const collecting = collect(attempt(true, interruption.signal))
		const cancelled = expect(collecting).rejects.toThrow("cancelled")
		await entered.promise
		interruption.abort(new Error("Request cancelled by user"))
		task["currentAgentStep"] = { ...task["currentAgentStep"]!, stepId: "new-step" }
		await postEntered.promise
		let joined = false
		const joining = task["joinModelRequestObservers"]().then(() => {
			joined = true
		})
		await Promise.resolve()
		expect(joined).toBe(false)
		postRelease.resolve()
		await joining
		await cancelled
		release.resolve()
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(vi.mocked(runLifecycleHooks).mock.calls.map(([, request]) => request)).toEqual([
			expect.objectContaining({
				hook_event_name: "PreModelRequest",
				turn_id: "captured-turn",
				model: "captured-model",
			}),
			expect.objectContaining({
				hook_event_name: "PostModelRequest",
				status: "cancelled",
				turn_id: "captured-turn",
				model: "captured-model",
			}),
		])
		expect(task["pendingModelRequestObservers"]?.size).toBe(0)
	})

	it("retains cancelled observer cleanup after step handoff and prevents child unloading", async () => {
		const { task } = fixture()
		const entered = barrier(),
			release = barrier()
		const retry = vi.fn(async () => undefined)
		const cleanup = new HookCommandCleanupError("PostModelRequest", retry, new Error("Unconfirmed"))
		vi.mocked(runLifecycleHooks).mockImplementation(async (_config, request) => {
			if (request.hook_event_name === "PostModelRequest") {
				entered.resolve()
				await release.promise
				throw cleanup
			}
			return { warnings: [] }
		})
		const controller = new AbortController()
		const observed = task["observeModelRequest"](() => chunks(), controller.signal)
		await observed.next()
		controller.abort()
		await entered.promise
		task["currentAgentStep"] = { ...task["currentAgentStep"]!, stepId: "next-step" }
		expect(task.canUnloadSubagentRuntime()).toBe(false)
		const joining = task["joinModelRequestObservers"]()
		release.resolve()
		await joining
		expect(task["pendingHookCleanupFailures"]?.has(cleanup)).toBe(true)
		expect(task.canUnloadSubagentRuntime()).toBe(false)
		await task["awaitLifecycleHookCleanup"]()
		expect(retry).toHaveBeenCalledOnce()
		await observed.return(undefined)
		expect(
			vi
				.mocked(runLifecycleHooks)
				.mock.calls.filter(([, request]) => request.hook_event_name === "PostModelRequest"),
		).toHaveLength(1)
	})

	it("checks asynchronous cleanup failures without delivering or consuming hook context", async () => {
		const { task, attempt, api } = fixture()
		const retry = vi.fn(async () => {
			throw new Error("Still running")
		})
		const cleanup = new HookCommandCleanupError("PostModelRequest", retry, new Error("Unconfirmed"))
		const checkCleanupFailures = vi.fn(() => {
			throw cleanup
		})
		const drain = vi.fn()
		Object.assign(task, {
			asyncLifecycleHooks: { checkCleanupFailures, drain, shutdown: vi.fn(async () => undefined) },
		})
		await expect(collect(attempt(false))).rejects.toBe(cleanup)
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(drain).not.toHaveBeenCalled()
		expect(task["pendingHookCleanupFailures"]?.has(cleanup)).toBe(true)
	})

	it("fences direct compatibility retry admission even with no configured model observers", async () => {
		const { task, api, attempt } = fixture()
		task["completionHookConfig"] = { stop: [], subagentStop: [] }
		const cleanup = new HookCommandCleanupError(
			"PostToolUse",
			async () => {
				throw new Error("Still running")
			},
			new Error("Unconfirmed"),
		)
		vi.mocked(api.createMessage).mockImplementationOnce(() =>
			(async function* (): ApiStream {
				yield* []
				throw new Error("Transport failed")
			})(),
		)
		vi.mocked(task["backoffAndAnnounce"]).mockImplementation(async () => {
			task["retainHookCleanupFailures"](cleanup)
		})
		await expect(collect(attempt(false))).rejects.toBe(cleanup)
		expect(api.createMessage).toHaveBeenCalledOnce()
		expect(task["backoffAndAnnounce"]).toHaveBeenCalledOnce()
		expect(runLifecycleHooks).not.toHaveBeenCalled()
	})

	it.each([true, false])(
		"revalidates the original request owner after a Pre await (retry owner: %s)",
		async (ownerHandlesRetry) => {
			const { task, api, attempt } = fixture()
			vi.mocked(runLifecycleHooks).mockImplementation(async (_config, request) => {
				if (request.hook_event_name === "PreModelRequest")
					task["currentAgentStep"] = { ...task["currentAgentStep"]!, stepId: "replacement-step" }
				return { warnings: [] }
			})
			await expect(collect(attempt(ownerHandlesRetry))).rejects.toThrow(
				"Request lifecycle preflight was superseded by a newer agent step",
			)
			expect(api.createMessage).not.toHaveBeenCalled()
			expect(task["backoffAndAnnounce"]).not.toHaveBeenCalled()
		},
	)

	it("revalidates ownership synchronously at dispatch after cleanup promise reactions", async () => {
		const { task, api } = fixture()
		const originalStep = task["currentAgentStep"]
		vi.mocked(api.createMessage).mockImplementation(() => {
			expect(task["currentAgentStep"]).toBe(originalStep)
			return chunks()
		})
		const entered = barrier()
		const cleanup = barrier()
		task["awaitLifecycleHookCleanup"] = vi.fn(() => {
			entered.resolve()
			return cleanup.promise
		})
		const observation = collect(
			task["observeModelRequest"](() => api.createMessage("System fixture", []), new AbortController().signal),
		)
		await entered.promise
		void cleanup.promise.then(() => {
			task["currentAgentStep"] = { ...task["currentAgentStep"]!, stepId: "replacement-step" }
		})
		cleanup.resolve()
		await expect(observation).resolves.toEqual([{ type: "text", text: "Provider answer" }])
		expect(api.createMessage).toHaveBeenCalledOnce()
		expect(task["backoffAndAnnounce"]).not.toHaveBeenCalled()
	})

	it("fences provider admission and ordinary effects while physical observer cleanup is unconfirmed", async () => {
		const { task, api, attempt } = fixture()
		let confirmed = false
		const retry = vi.fn(async () => {
			if (!confirmed) throw new Error("Still running")
		})
		const cleanup = new HookCommandCleanupError("PostModelRequest", retry, new Error("Unconfirmed"))
		task["retainHookCleanupFailures"](cleanup)
		await expect(collect(attempt(false))).rejects.toBe(cleanup)
		await expect(task["assertCurrentProviderTranscriptBeforeEffects"]()).rejects.toBe(cleanup)
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(task["backoffAndAnnounce"]).not.toHaveBeenCalled()
		expect(runLifecycleHooks).not.toHaveBeenCalled()
		confirmed = true
		await collect(attempt())
		expect(api.createMessage).toHaveBeenCalledOnce()
		expect(task["pendingHookCleanupFailures"]?.size).toBe(0)
	})
})
