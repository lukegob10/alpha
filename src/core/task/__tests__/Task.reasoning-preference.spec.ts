import type { ModelInfo, ProviderSettings, TaskReasoningState } from "@alpha-code/types"

import type { ApiHandler } from "../../../api"
import type { ApiStream } from "../../../api/transform/stream"
import { AgentRetryPolicy } from "../../agent/AgentRetryPolicy"
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

function surface(name: string) {
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name,
		aliases: [],
		schema: {
			type: "function",
			function: { name, description: `${name} schema`, parameters: { type: "object", properties: {} } },
		},
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
		execute: vi.fn(async () => {}),
	})
	return createTaskToolSurface({ registry, applyProfile: false })
}

function reasoningState(effort: "low" | "medium" | "high"): TaskReasoningState {
	return {
		requested: { kind: "effort", effort },
		effective: { kind: "effort", effort },
		capabilities: { kind: "effort", efforts: ["low", "medium", "high"], canDisable: true },
	}
}

function handler(id: string, effort: "low" | "medium" | "high", contextWindow = 128_000) {
	return {
		getModel: () => ({
			id,
			info: {
				contextWindow,
				maxTokens: 4096,
				supportsImages: true,
				supportsReasoningEffort: ["low", "medium", "high"],
				reasoningEffort: effort,
			} as ModelInfo,
		}),
		countTokens: vi.fn(async () => 10),
		streamCapabilities: { lifecycle: true, cancellation: true },
		dispose: vi.fn(),
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
			yield { type: "text", text: `${effort} response` }
		}),
	} satisfies ApiHandler
}

async function* failBeforeFirstChunk(error: Error): ApiStream {
	yield* []
	throw error
}

function harness(initialEffort: "low" | "medium" | "high" = "high") {
	const baseConfiguration: ProviderSettings = {
		apiProvider: "vertex",
		apiModelId: "reasoning-model",
		reasoningEffort: "medium",
	}
	const effectiveConfiguration: ProviderSettings = {
		...baseConfiguration,
		reasoningEffort: initialEffort,
	}
	const currentSurface = surface("read_file")
	const activeHandler = handler("reasoning-model", initialEffort)
	const provider = {
		getState: vi.fn(async () => ({
			mode: "code",
			autoCondenseContext: false,
			autoApprovalEnabled: false,
		})),
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: `reasoning-${initialEffort}`,
		instanceId: `instance-${initialEffort}`,
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		abandoned: false,
		isStreaming: false,
		taskCancellationController: new AbortController(),
		api: activeHandler,
		apiConfiguration: baseConfiguration,
		effectiveApiConfiguration: effectiveConfiguration,
		reasoningPreference: { kind: "effort", effort: initialEffort },
		reasoningState: reasoningState(initialEffort),
		reasoningByHandler: new WeakMap(),
		retainedReasoningHandlers: new Set(),
		reasoningHandlerUsers: new Map(),
		providerRef: { deref: () => provider },
		apiConversationHistory: [{ role: "user", content: "original request" }],
		alphaMessages: [],
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		agentRetryPolicy: new AgentRetryPolicy({ maxAttempts: 2, jitter: "none", baseDelayMs: 0 }),
		currentTaskToolSurface: currentSurface,
		getTaskMode: vi.fn(async () => "code"),
		getSystemPrompt: vi.fn(async () => "Original system prompt"),
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

	return { task, provider, activeHandler, currentSurface, baseConfiguration }
}

function capturedStep(task: Task) {
	return Reflect.get(task, "currentAgentStep") as {
		snapshot: AgentStepSnapshot<ApiHandler, unknown>
	}
}

describe("Task reasoning preference runtime boundaries", () => {
	it.each(["requested", "capabilities", "fallback", "property-order"])(
		"does not mark an unchanged effective reasoning level pending after a %s change",
		(change) => {
			const { task, activeHandler } = harness("high")
			const current = reasoningState("high")
			if (change === "requested") current.requested = { kind: "default" }
			if (change === "capabilities") current.capabilities.efforts = ["high", "low"]
			if (change === "fallback") current.fallbackReason = "required"
			if (change === "property-order") current.effective = { effort: "high", kind: "effort" }
			Reflect.get(task, "reasoningByHandler").set(activeHandler, current)
			Reflect.get(task, "reasoningHandlerUsers").set(activeHandler, 1)

			expect(task.getReasoningState()).toMatchObject({
				effective: { kind: "effort", effort: "high" },
				current,
				pending: false,
			})
		},
	)

	it("shows a genuine queued level change only until the captured request is released", () => {
		const { task, activeHandler } = harness("high")
		const current = reasoningState("high")
		Reflect.get(task, "reasoningByHandler").set(activeHandler, current)
		const users = Reflect.get(task, "reasoningHandlerUsers") as Map<ApiHandler, number>
		users.set(activeHandler, 1)
		Reflect.set(task, "reasoningState", reasoningState("low"))

		expect(task.getReasoningState()).toMatchObject({
			effective: { kind: "effort", effort: "low" },
			current: { effective: { kind: "effort", effort: "high" } },
			pending: true,
		})
		users.delete(activeHandler)
		expect(task.getReasoningState()).toMatchObject({ pending: false })
		expect(task.getReasoningState()).not.toHaveProperty("current")
	})

	it.each([false, true])("only queues a changed token budget when reasoning is enabled (%s)", (enabled) => {
		const { task, activeHandler } = harness()
		const current: TaskReasoningState = {
			requested: { kind: enabled ? "on" : "off" },
			effective: { kind: enabled ? "on" : "off" },
			capabilities: { kind: "budget", canDisable: true, budgetTokens: 1024 },
		}
		Reflect.get(task, "reasoningByHandler").set(activeHandler, current)
		Reflect.get(task, "reasoningHandlerUsers").set(activeHandler, 1)
		Reflect.set(task, "reasoningState", {
			...current,
			capabilities: { ...current.capabilities, budgetTokens: 2048 },
		})

		expect(task.getReasoningState().pending).toBe(enabled)
	})

	it("keeps a changed custom reasoning token pending for the next request", () => {
		const { task, activeHandler } = harness()
		const current: TaskReasoningState = {
			requested: { kind: "custom", value: "balanced" },
			effective: { kind: "custom", value: "balanced" },
			capabilities: { kind: "custom", canDisable: true },
		}
		Reflect.get(task, "reasoningByHandler").set(activeHandler, current)
		Reflect.get(task, "reasoningHandlerUsers").set(activeHandler, 1)
		Reflect.set(task, "reasoningState", { ...current, effective: { kind: "custom", value: "deliberate" } })

		expect(task.getReasoningState().pending).toBe(true)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockReset()
		vi.mocked(manageContext).mockReset()
		vi.mocked(willManageContext).mockReturnValue(false)
	})

	it.each([false, true])("retains a downshift summary handler until request cleanup (failure: %s)", async (fails) => {
		const { task, activeHandler, baseConfiguration } = harness("high")
		Reflect.set(task, "getTokenUsage", () => ({ contextTokens: 100 }))
		vi.mocked(willManageContext).mockReturnValue(true)
		const small = handler("small-model", "high", 256_000)
		const resolvedModel = { ...small.getModel(), info: { ...small.getModel().info, contextWindow: 32_000 } }
		Object.assign(small, {
			prepareModel: vi.fn(async () => {
				small.getModel = () => resolvedModel
			}),
		})
		const configuration = { ...baseConfiguration, apiModelId: "small-model" }
		Reflect.set(task, "prepareReasoningConfiguration", () => ({
			api: small,
			configuration,
			state: reasoningState("high"),
		}))
		task.updateApiConfiguration(configuration)
		expect(activeHandler.dispose).not.toHaveBeenCalled()
		if (fails) vi.mocked(manageContext).mockRejectedValueOnce(new Error("summary unavailable"))
		const request = async () => {
			for await (const _chunk of task.attemptApiRequest(0, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
			})) {
			}
		}
		if (fails) await expect(request()).rejects.toThrow("summary unavailable")
		else await request()
		expect(manageContext).toHaveBeenCalledWith(
			expect.objectContaining({
				apiHandler: small,
				compactionApiHandler: activeHandler,
			}),
		)
		if (!fails) {
			// The request projection remains owned until the turn engine finishes
			// processing its successful response. Model that terminal cleanup here.
			expect(activeHandler.dispose).not.toHaveBeenCalled()
			Reflect.get(task, "currentAgentStep").releaseRequest()
		}
		expect(activeHandler.dispose).toHaveBeenCalledOnce()
		expect(small.dispose).not.toHaveBeenCalled()
	})

	it("does not reuse a previous account when changing model and credentials together", async () => {
		const { task, activeHandler, baseConfiguration } = harness("high")
		Reflect.set(task, "getTokenUsage", () => ({ contextTokens: 100 }))
		vi.mocked(willManageContext).mockReturnValue(true)
		const small = handler("small-model", "high", 32_000)
		const configuration = { ...baseConfiguration, apiModelId: "small-model", vertexProjectId: "different-account" }
		Reflect.set(task, "prepareReasoningConfiguration", () => ({
			api: small,
			configuration,
			state: reasoningState("high"),
		}))
		task.updateApiConfiguration(configuration)
		expect(activeHandler.dispose).toHaveBeenCalledOnce()
		for await (const _chunk of task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})) {
		}
		expect(manageContext).toHaveBeenCalledWith(
			expect.objectContaining({
				apiHandler: small,
				compactionApiHandler: undefined,
			}),
		)
	})

	it("keeps the captured effective settings across an in-flight transport retry and adopts new settings on the next step", async () => {
		const { task, activeHandler, baseConfiguration } = harness("high")
		const lowHandler = handler("reasoning-model", "low")
		Reflect.set(
			task,
			"prepareReasoningConfiguration",
			vi.fn(() => ({
				api: lowHandler,
				configuration: { ...baseConfiguration, reasoningEffort: "low" },
				state: reasoningState("low"),
			})),
		)
		Reflect.set(
			task,
			"enqueueAlphaMessagesSave",
			vi.fn(async (...args: any[]) => {
				await args[1]()
				return true
			}),
		)
		const highResponse = activeHandler.createMessage
			.mockImplementationOnce(() => failBeforeFirstChunk(new Error("first chunk failed")))
			.mockImplementationOnce(async function* () {
				yield { type: "text", text: "high retry response" }
			})

		await expect(
			task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next(),
		).rejects.toThrow("first chunk failed")

		expect(capturedStep(task).snapshot.context.provider.options).toMatchObject({ reasoningEffort: "high" })
		expect(task.apiConfiguration).toEqual(baseConfiguration)

		// A preference update may replace the live handler while the original step is
		// still retryable. The transport retry must retain the old handler and settings.
		await task.updateReasoningPreference({ kind: "effort", effort: "low" })
		expect(task.api).toBe(lowHandler)

		for await (const _chunk of task.attemptApiRequest(1, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
			retryCategory: "transport",
		})) {
			// consume the retained retry
		}

		expect(highResponse).toHaveBeenCalledTimes(2)
		expect(lowHandler.createMessage).not.toHaveBeenCalled()
		expect(capturedStep(task).snapshot.context.provider.options).toMatchObject({ reasoningEffort: "high" })

		// A fresh logical step captures the new effective settings and dispatches to
		// the replacement handler, while the base profile remains unchanged.
		for await (const _chunk of task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})) {
			// consume the new step
		}

		expect(lowHandler.createMessage).toHaveBeenCalledOnce()
		expect(capturedStep(task).snapshot.context.provider.options).toMatchObject({ reasoningEffort: "low" })
		expect(task.apiConfiguration).toEqual(baseConfiguration)
	})

	it("applies a preference only after its durable save succeeds and leaves the base profile untouched", async () => {
		const { task, baseConfiguration } = harness("low")
		const nextHandler = handler("reasoning-model", "high")
		const nextState = reasoningState("high")
		const persist = vi.fn(async (...args: any[]) => {
			expect(args[3]).toEqual({
				preference: { kind: "effort", effort: "high" },
				state: nextState,
			})
			await args[1]()
			return true
		})
		Reflect.set(
			task,
			"prepareReasoningConfiguration",
			vi.fn(() => ({
				api: nextHandler,
				configuration: { ...baseConfiguration, reasoningEffort: "high" },
				state: nextState,
			})),
		)
		Reflect.set(task, "enqueueAlphaMessagesSave", persist)

		await task.updateReasoningPreference({ kind: "effort", effort: "high" })

		expect(task.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
		expect(task.getReasoningState()).toMatchObject({
			requested: { kind: "effort", effort: "high" },
			effective: { kind: "effort", effort: "high" },
		})
		expect(task.apiConfiguration).toEqual(baseConfiguration)
		expect(Reflect.get(task, "effectiveApiConfiguration")).toEqual({
			...baseConfiguration,
			reasoningEffort: "high",
		})
		expect(task.api).toBe(nextHandler)
	})

	it("retains the old preference and effective handler when persistence fails", async () => {
		const { task, activeHandler, baseConfiguration } = harness("low")
		const oldPreference = { kind: "effort", effort: "low" } as const
		const oldState = structuredClone(task.getReasoningState())
		const nextHandler = handler("reasoning-model", "high")
		Reflect.set(
			task,
			"prepareReasoningConfiguration",
			vi.fn(() => ({
				api: nextHandler,
				configuration: { ...baseConfiguration, reasoningEffort: "high" },
				state: reasoningState("high"),
			})),
		)
		Reflect.set(
			task,
			"enqueueAlphaMessagesSave",
			vi.fn(async () => false),
		)

		await expect(task.updateReasoningPreference({ kind: "effort", effort: "high" })).rejects.toThrow(
			"Unable to persist task reasoning preference",
		)

		expect(task.reasoningPreference).toEqual(oldPreference)
		expect(task.getReasoningState()).toMatchObject(oldState)
		expect(task.api).toBe(activeHandler)
		expect(Reflect.get(task, "effectiveApiConfiguration")).toEqual({
			...baseConfiguration,
			reasoningEffort: "low",
		})
	})

	it("does not install a staged handler after the task aborts during persistence", async () => {
		const { task, activeHandler, baseConfiguration } = harness("low")
		const nextHandler = handler("reasoning-model", "high")
		const nextState = reasoningState("high")
		let releaseSave!: () => void
		const persist = vi.fn(
			(...args: any[]) =>
				new Promise<boolean>((resolve) => {
					releaseSave = () => {
						// Persistence has completed, but the task stopped while it was pending.
						try {
							args[1]?.()
							resolve(true)
						} catch {
							resolve(false)
						}
					}
				}),
		)

		Reflect.set(
			task,
			"prepareReasoningConfiguration",
			vi.fn(() => ({
				api: nextHandler,
				configuration: { ...baseConfiguration, reasoningEffort: "high" },
				state: nextState,
			})),
		)
		Reflect.set(task, "enqueueAlphaMessagesSave", persist)

		const update = task.updateReasoningPreference({ kind: "effort", effort: "high" })
		await Promise.resolve()
		task.abort = true
		releaseSave()
		await expect(update).rejects.toThrow("Unable to persist task reasoning preference")

		expect(task.api).toBe(activeHandler)
		expect(task.reasoningPreference).toEqual({ kind: "effort", effort: "low" })
		expect(nextHandler.dispose).toHaveBeenCalledOnce()
	})

	it("keeps task lanes isolated when their effective reasoning choices differ", async () => {
		const first = harness("high")
		const second = harness("low")

		for await (const _chunk of first.task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})) {
			// consume first lane
		}
		for await (const _chunk of second.task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})) {
			// consume second lane
		}

		expect(capturedStep(first.task).snapshot.context.provider.options).toMatchObject({ reasoningEffort: "high" })
		expect(capturedStep(second.task).snapshot.context.provider.options).toMatchObject({ reasoningEffort: "low" })
		expect(first.task.apiConfiguration).toEqual(second.task.apiConfiguration)
	})

	it("keeps the invoking profile identity across a concurrent profile change and a transport retry", async () => {
		const { task, provider, baseConfiguration } = harness("high")
		const spawnSurface = surface("spawn_agent")
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({
			tools: structuredClone([...spawnSurface.schemas]),
			surface: spawnSurface,
		})
		let selectedRoute = {
			profileId: "profile-a",
			profileName: "Profile A",
			provider: "vertex",
		}
		Object.assign(provider, { taskHistoryStore: { get: () => ({ threadModelRoute: selectedRoute }) } })
		task.setTaskApiConfigName("Profile A")
		let releaseState!: () => void
		let observeState!: () => void
		const stateStarted = new Promise<void>((resolve) => {
			observeState = resolve
		})
		const statePending = new Promise<void>((resolve) => {
			releaseState = resolve
		})
		provider.getState.mockImplementationOnce(async () => {
			observeState()
			await statePending
			return { mode: "code", autoCondenseContext: false, autoApprovalEnabled: false }
		})
		const request = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
		const firstChunk = request.next()
		await stateStarted

		const nextHandler = handler("model-b", "high")
		const nextConfiguration = { ...baseConfiguration, apiModelId: "model-b", vertexProjectId: "account-b" }
		Reflect.set(task, "prepareReasoningConfiguration", () => ({
			api: nextHandler,
			configuration: nextConfiguration,
			state: reasoningState("high"),
		}))
		task.updateApiConfiguration(nextConfiguration)
		task.setTaskApiConfigName("Profile B")
		selectedRoute = { profileId: "profile-b", profileName: "Profile B", provider: "vertex" }
		releaseState()
		await firstChunk
		for await (const _chunk of request) {
		}

		const invocation = () => Reflect.get(task, "currentAgentStep").getSubagentInvocationContext()
		expect(invocation()).toMatchObject({
			apiConfigName: "Profile A",
			apiConfiguration: baseConfiguration,
			modelRoute: { profileId: "profile-a", profileName: "Profile A", modelId: "reasoning-model" },
		})
		for await (const _chunk of task.attemptApiRequest(1, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
			retryCategory: "transport",
		})) {
		}
		expect(invocation().modelRoute.profileId).toBe("profile-a")

		for await (const _chunk of task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})) {
		}
		expect(invocation()).toMatchObject({
			apiConfigName: "Profile B",
			modelRoute: { profileId: "profile-b", profileName: "Profile B", modelId: "model-b" },
		})
	})
})
