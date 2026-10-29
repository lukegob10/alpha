import type {
	HistoryItem,
	ModelInfo,
	ProviderSettings,
	SubagentModelRouteState,
	TaskReasoningPreference,
} from "@alpha-code/types"
import { isDeepStrictEqual } from "node:util"

import { buildApiHandler, type ApiHandler } from "../../../api"
import { saveTaskMessages, taskMetadata, type ApiMessage } from "../../task-persistence"
import { resolveTaskReasoning } from "../../agent/TaskReasoning"
import { Task } from "../Task"

vi.mock("../../../api", () => ({ buildApiHandler: vi.fn() }))

vi.mock("../../task-persistence", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task-persistence")>()),
	saveTaskMessages: vi.fn(async () => undefined),
	taskMetadata: vi.fn(),
}))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const info: ModelInfo = {
	contextWindow: 128_000,
	maxTokens: 4096,
	supportsPromptCache: false,
	supportsReasoningEffort: ["none", "low", "medium", "high"],
	reasoningEffort: "medium",
}

function makeHandler(id: string, modelInfo = info) {
	return {
		getModel: () => ({ id, info: modelInfo }),
		countTokens: vi.fn(async () => 1),
		createMessage: vi.fn(async function* () {
			yield { type: "text" as const, text: "response" }
		}),
		dispose: vi.fn<() => void>(),
	} satisfies ApiHandler
}

function route(modelId = "selected-model", profileId = "selected-profile"): SubagentModelRouteState {
	return {
		source: "spawn",
		resolution: "selected",
		profileId,
		profileName: profileId,
		provider: "vertex",
		modelId,
		requestedModelId: modelId,
	}
}

function harness() {
	const configuration: ProviderSettings = {
		apiProvider: "vertex",
		apiModelId: "original-model",
		vertexProjectId: "original-account",
	}
	const preference: TaskReasoningPreference = { kind: "effort", effort: "high" }
	const original = makeHandler("original-model")
	const initial = resolveTaskReasoning(configuration, preference, original.getModel())
	const handlers: ReturnType<typeof makeHandler>[] = []
	vi.mocked(buildApiHandler).mockImplementation((settings) => {
		if (settings.apiModelId === "invalid-model") throw new Error("Unsupported selected model")
		const handler = makeHandler(settings.apiModelId ?? "default-model")
		handlers.push(handler)
		return handler
	})
	let history: HistoryItem = {
		id: "model-route-task",
		number: 1,
		ts: 1,
		task: "Original request",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		apiConfigName: "original-profile",
		reasoningPreference: preference,
		reasoningState: initial.state,
		threadModelOverride: "original-model",
		threadModelRoute: route("original-model", "original-profile"),
	}
	const events: string[] = []
	const selectedFields = (item: HistoryItem) => ({
		apiConfigName: item.apiConfigName,
		threadModelOverride: item.threadModelOverride,
		threadModelRoute: item.threadModelRoute,
		reasoningPreference: item.reasoningPreference,
		reasoningState: item.reasoningState,
	})
	const store = {
		get: vi.fn(() => history),
		upsert: vi.fn(async (item: HistoryItem) => {
			events.push("rollback-history")
			history = { ...history, ...item }
			return [history]
		}),
		restoreModelRoute: vi.fn(
			async (_taskId: string, expected: HistoryItem, previous: HistoryItem, guard?: () => boolean) => {
				if ((guard && !guard()) || !isDeepStrictEqual(selectedFields(history), selectedFields(expected))) {
					return false
				}
				events.push("rollback-history")
				history = { ...history, ...selectedFields(previous) }
				return true
			},
		),
	}
	const provider = {
		taskHistoryStore: store,
		updateTaskHistory: vi.fn(async (item: HistoryItem) => {
			events.push("route-history")
			history = { ...history, ...item }
			return [history]
		}),
	}
	vi.mocked(taskMetadata).mockImplementation(async (options) => ({
		historyItem: {
			...history,
			apiConfigName: options.apiConfigName,
			reasoningPreference: options.reasoningPreference,
			reasoningState: options.reasoningState,
		},
		tokenUsage: { totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, contextTokens: 0 },
	}))
	const canonicalHistory: ApiMessage[] = [
		{ role: "user", content: "Original request" },
		{ role: "assistant", content: "Visible answer", encrypted_content: "original-account-ciphertext" },
	]
	let savedApiHistory = structuredClone(canonicalHistory)
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: history.id,
		taskNumber: 1,
		taskKind: "primary",
		instanceId: "original-instance",
		abort: false,
		abandoned: false,
		isStreaming: false,
		isWaitingForFirstChunk: false,
		isTaskLoopActive: false,
		isAgentTurnEngineActive: false,
		taskCancellationController: new AbortController(),
		api: original,
		apiConfiguration: configuration,
		effectiveApiConfiguration: initial.configuration,
		reasoningPreference: preference,
		reasoningState: initial.state,
		reasoningByHandler: new WeakMap([[original, initial.state]]),
		retainedReasoningHandlers: new Set(),
		reasoningHandlerUsers: new Map(),
		providerRef: { deref: () => provider },
		apiConversationHistory: canonicalHistory,
		alphaMessages: [],
		alphaMessagesHydrated: true,
		alphaMessagesSaveQueue: Promise.resolve(),
		_taskApiConfigName: "original-profile",
		taskApiConfigReady: Promise.resolve(),
		debouncedEmitTokenUsage: vi.fn(),
		toolUsage: {},
		messageQueueService: { hasUnconsumedInput: () => false, isEmpty: () => true },
		hasActiveCommandExecutions: () => false,
		hasPendingAgentMessages: () => false,
		isCurrentApiConversationHistoryOwner: () => true,
		saveApiConversationHistory: vi.fn(async (guard?: () => boolean, snapshot?: ApiMessage[]) => {
			if (guard && !guard()) return false
			events.push("provider-history")
			savedApiHistory = structuredClone(snapshot ?? task.apiConversationHistory)
			return true
		}),
	}) as Task
	return {
		task,
		configuration,
		preference,
		original,
		handlers,
		provider,
		events,
		getHistory: () => structuredClone(history),
		getSavedApiHistory: () => structuredClone(savedApiHistory),
	}
}

function selection(configuration: ProviderSettings) {
	return {
		apiConfiguration: { ...configuration, apiModelId: "selected-model" },
		apiConfigName: "selected-profile",
		reasoningPreference: { kind: "default" } as const,
		threadModelOverride: "selected-model",
		threadModelRoute: route(),
	}
}

describe("Task atomic model route updates", () => {
	afterEach(() => vi.clearAllMocks())

	it("stages the full selection and adopts it only after durable history succeeds", async () => {
		const h = harness()
		const saving = deferred()
		const started = deferred()
		const persist = h.provider.updateTaskHistory.getMockImplementation()!
		h.provider.updateTaskHistory.mockImplementationOnce(async (item) => {
			started.resolve()
			await saving.promise
			return persist(item)
		})
		const next = selection(h.configuration)
		const updating = h.task.updateModelRoute(next)
		await started.promise
		expect(h.task.apiConfiguration).toEqual(h.configuration)
		expect(h.task.reasoningPreference).toEqual(h.preference)
		expect(h.task.taskApiConfigName).toBe("original-profile")
		expect(h.task.api).toBe(h.original)
		expect(Reflect.get(h.task, "externalMutationLease")).toBeDefined()
		saving.resolve()
		await updating

		expect(h.task.apiConfiguration).toEqual(next.apiConfiguration)
		expect(h.task.reasoningPreference).toEqual({ kind: "default" })
		expect(h.task.taskApiConfigName).toBe(next.apiConfigName)
		expect(h.task.api.getModel().id).toBe("selected-model")
		expect(h.task.getReasoningState().effective).toEqual({ kind: "effort", effort: "medium" })
		expect(h.getHistory()).toMatchObject({
			apiConfigName: next.apiConfigName,
			threadModelOverride: next.threadModelOverride,
			threadModelRoute: next.threadModelRoute,
			reasoningPreference: next.reasoningPreference,
		})
		expect(h.original.dispose).toHaveBeenCalledOnce()
		expect(Reflect.get(h.task, "externalMutationLease")).toBeUndefined()
	})

	it("validates the handler before changing any saved or live selection", async () => {
		const h = harness()
		const before = h.getHistory()
		const next = selection(h.configuration)
		next.apiConfiguration.apiModelId = "invalid-model"
		next.threadModelOverride = "invalid-model"
		next.threadModelRoute = route("invalid-model")
		await expect(h.task.updateModelRoute(next)).rejects.toThrow("Unsupported selected model")
		expect(h.getHistory()).toEqual(before)
		expect(h.task.api).toBe(h.original)
		expect(h.task.apiConfiguration).toEqual(h.configuration)
		expect(h.provider.updateTaskHistory).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
		expect(h.events).toEqual([])
		expect(Reflect.get(h.task, "externalMutationLease")).toBeUndefined()
	})

	it("rolls back durable route fields when the host rejects a persisted update", async () => {
		const h = harness()
		const before = h.getHistory()
		const persist = h.provider.updateTaskHistory.getMockImplementation()!
		h.provider.updateTaskHistory.mockImplementationOnce(async (item) => {
			await persist(item)
			throw new Error("Host projection failed after save")
		})
		await expect(h.task.updateModelRoute(selection(h.configuration))).rejects.toThrow(/persist/i)
		expect(h.getHistory()).toEqual(before)
		expect(h.task.api).toBe(h.original)
		expect(h.task.apiConfiguration).toEqual(h.configuration)
		expect(h.task.taskApiConfigName).toBe("original-profile")
		expect(h.task.reasoningPreference).toEqual(h.preference)
		expect(h.provider.taskHistoryStore.restoreModelRoute).toHaveBeenCalledOnce()
		expect(h.provider.taskHistoryStore.upsert).not.toHaveBeenCalled()
		expect(h.handlers.at(-1)?.dispose).toHaveBeenCalledOnce()
		expect(h.original.dispose).not.toHaveBeenCalled()
	})

	it("does not install a staged route when Stop wins during persistence", async () => {
		const h = harness()
		const before = h.getHistory()
		const saving = deferred()
		const started = deferred()
		const persist = h.provider.updateTaskHistory.getMockImplementation()!
		h.provider.updateTaskHistory.mockImplementationOnce(async (item) => {
			started.resolve()
			await saving.promise
			return persist(item)
		})
		const updating = h.task.updateModelRoute(selection(h.configuration))
		await started.promise
		h.task.abort = true
		saving.resolve()
		await expect(updating).rejects.toThrow(/persist|unavailable|stopp/i)
		expect(h.getHistory()).toEqual(before)
		expect(h.task.api).toBe(h.original)
		expect(h.task.reasoningPreference).toEqual(h.preference)
		expect(h.handlers.at(-1)?.dispose).toHaveBeenCalledOnce()
		expect(Reflect.get(h.task, "externalMutationLease")).toBeUndefined()
	})

	it.each([
		"isStreaming",
		"isWaitingForFirstChunk",
		"isTaskLoopActive",
		"isAgentTurnEngineActive",
		"contextCondenseAbortController",
		"manualContextCondenseSettlement",
		"postTurnCompactionAbortController",
		"ownedLifecyclePromise",
		"queuedInputWakePromise",
		"externalMutationLease",
	])("rejects a busy target before constructing a handler (%s)", async (property) => {
		const h = harness()
		Reflect.set(h.task, property, true)
		await expect(h.task.updateModelRoute(selection(h.configuration))).rejects.toThrow(/progress|busy|idle/i)
		expect(buildApiHandler).not.toHaveBeenCalled()
		expect(h.provider.updateTaskHistory).not.toHaveBeenCalled()
	})

	it("persists replay invalidation before selecting another account on the same provider and model", async () => {
		const h = harness()
		const next = {
			...selection(h.configuration),
			apiConfiguration: { ...h.configuration, vertexProjectId: "selected-account" },
			threadModelOverride: "original-model",
			threadModelRoute: route("original-model"),
		}
		await h.task.updateModelRoute(next)
		expect(h.events).toEqual(["provider-history", "route-history"])
		expect(h.getSavedApiHistory()[1]).toMatchObject({
			content: "Visible answer",
			encrypted_content: "original-account-ciphertext",
			provider_state_replay_disabled: true,
		})
		expect(h.task.apiConversationHistory).toEqual(h.getSavedApiHistory())
		expect(h.task.skipPrevResponseIdOnce).toBe(true)
	})

	it("keeps conservative replay invalidation when route persistence fails", async () => {
		const h = harness()
		h.provider.updateTaskHistory.mockRejectedValueOnce(new Error("History write unavailable"))
		await expect(h.task.updateModelRoute(selection(h.configuration))).rejects.toThrow(/persist/i)
		expect(h.task.api).toBe(h.original)
		expect(h.task.apiConfiguration).toEqual(h.configuration)
		expect(h.getSavedApiHistory()[1]).toHaveProperty("provider_state_replay_disabled", true)
		expect(h.getHistory().apiConfigName).toBe("original-profile")
	})

	it("does not change replay provenance for a reasoning-only update in the same route", async () => {
		const h = harness()
		await h.task.updateModelRoute({
			apiConfiguration: h.configuration,
			apiConfigName: "original-profile",
			reasoningPreference: { kind: "effort", effort: "low" },
			threadModelOverride: "original-model",
			threadModelRoute: route("original-model", "original-profile"),
		})
		expect(h.events).toEqual(["route-history"])
		expect(h.task.apiConversationHistory[1]).not.toHaveProperty("provider_state_replay_disabled")
		expect(h.task.getReasoningState().effective).toEqual({ kind: "effort", effort: "low" })
	})

	it("clears the old explicit model when the selected profile uses its adapter default", async () => {
		const h = harness()
		const { apiModelId: _oldModel, ...configuration } = h.configuration
		await h.task.updateModelRoute({
			apiConfiguration: configuration,
			apiConfigName: "selected-profile",
			reasoningPreference: { kind: "default" },
			threadModelOverride: undefined,
			threadModelRoute: {
				source: "spawn",
				resolution: "selected",
				profileId: "selected-profile",
				profileName: "selected-profile",
				provider: "vertex",
			},
		})
		expect(h.task.api.getModel().id).toBe("default-model")
		expect(h.getHistory().threadModelOverride).toBeUndefined()
		expect(JSON.parse(JSON.stringify(h.getHistory()))).not.toHaveProperty("threadModelOverride")
		expect(h.getHistory().threadModelRoute?.modelId).toBeUndefined()
	})

	it("clears old captured profile metadata for a legacy route with no saved binding", async () => {
		const h = harness()
		await h.task.updateModelRoute({
			apiConfiguration: { ...h.configuration, apiModelId: "selected-model" },
			apiConfigName: undefined,
			reasoningPreference: { kind: "default" },
			threadModelOverride: "selected-model",
			threadModelRoute: undefined,
		})
		expect(h.task.taskApiConfigName).toBeUndefined()
		expect(h.getHistory().apiConfigName).toBeUndefined()
		expect(h.getHistory().threadModelOverride).toBe("selected-model")
		expect(h.getHistory().threadModelRoute).toBeUndefined()
	})

	it("rejects a carried effort that the selected model cannot accept", async () => {
		const h = harness()
		vi.mocked(buildApiHandler).mockImplementation(() => {
			const handler = makeHandler("selected-model", {
				...info,
				supportsReasoningEffort: ["low", "medium"],
			})
			h.handlers.push(handler)
			return handler
		})
		await expect(
			h.task.updateModelRoute({ ...selection(h.configuration), reasoningPreference: h.preference }),
		).rejects.toThrow(/reasoning|effort/i)
		expect(h.task.api).toBe(h.original)
		expect(h.provider.updateTaskHistory).not.toHaveBeenCalled()
		expect(h.events).toEqual([])
	})

	it("loads dormant saved transcripts before persisting the route and never starts inference", async () => {
		const h = harness()
		const savedMessages = [{ ts: 17, type: "say", say: "text", text: "Saved visible history" }]
		const savedApiHistory = structuredClone(h.task.apiConversationHistory)
		h.task.alphaMessages = []
		h.task.apiConversationHistory = []
		Reflect.set(h.task, "alphaMessagesHydrated", false)
		Reflect.set(
			h.task,
			"flushApiConversationHistoryPersistence",
			vi.fn(async () => undefined),
		)
		Reflect.set(
			h.task,
			"recoverConversationRewind",
			vi.fn(async () => undefined),
		)
		Reflect.set(
			h.task,
			"getSavedAlphaMessages",
			vi.fn(async () => structuredClone(savedMessages)),
		)
		Reflect.set(
			h.task,
			"getSavedApiConversationHistory",
			vi.fn(async () => structuredClone(savedApiHistory)),
		)

		await h.task.updateModelRoute(selection(h.configuration))

		expect(h.task.alphaMessages).toEqual(savedMessages)
		expect(saveTaskMessages).toHaveBeenCalledWith(expect.objectContaining({ messages: savedMessages }))
		expect(h.getSavedApiHistory()).toHaveLength(savedApiHistory.length)
		expect(h.getSavedApiHistory()[1]).toHaveProperty("provider_state_replay_disabled", true)
		for (const handler of h.handlers) expect(handler.createMessage).not.toHaveBeenCalled()
	})

	it("rejects explicit none when the selected model requires reasoning without that named level", async () => {
		const h = harness()
		vi.mocked(buildApiHandler).mockImplementation(() => {
			const handler = makeHandler("selected-model", {
				...info,
				supportsReasoningEffort: ["medium", "high"],
				requiredReasoningEffort: true,
			})
			h.handlers.push(handler)
			return handler
		})
		const next = selection(h.configuration)
		const apiConfiguration: ProviderSettings = {
			...next.apiConfiguration,
			enableReasoningEffort: false,
			reasoningEffort: "none",
		}
		await expect(
			h.task.updateModelRoute({
				...next,
				apiConfiguration,
				threadModelRoute: { ...next.threadModelRoute, requestedReasoningEffort: "none" },
			}),
		).rejects.toThrow(/reasoning|effort/i)
		expect(h.task.api).toBe(h.original)
		expect(h.provider.updateTaskHistory).not.toHaveBeenCalled()
		expect(h.events).toEqual([])
	})

	it("uses the required model default when only a profile with legacy disabled reasoning is selected", async () => {
		const h = harness()
		vi.mocked(buildApiHandler).mockImplementation(() => {
			const handler = makeHandler("selected-model", {
				...info,
				supportsReasoningEffort: ["medium", "high"],
				requiredReasoningEffort: true,
			})
			h.handlers.push(handler)
			return handler
		})
		const next = selection(h.configuration)
		const apiConfiguration: ProviderSettings = {
			...next.apiConfiguration,
			enableReasoningEffort: false,
			reasoningEffort: "none",
		}
		await h.task.updateModelRoute({ ...next, apiConfiguration })
		expect(h.task.getReasoningState().effective).toEqual({ kind: "effort", effort: "medium" })
		expect(h.task.apiConfiguration).toEqual(apiConfiguration)
		expect(h.getHistory().threadModelRoute).not.toHaveProperty("requestedReasoningEffort")
		expect(h.getHistory().reasoningPreference).toEqual({ kind: "default" })
	})

	it("prepares selected host metadata before validating a supported effort", async () => {
		const h = harness()
		const prepare = vi.fn(async () => undefined)
		const options = vi.fn()
		vi.mocked(buildApiHandler).mockImplementation(() => {
			let live = false
			const handler = {
				...makeHandler("selected-model"),
				getModel: () => ({
					id: "selected-model",
					info: live ? info : { ...info, supportsReasoningEffort: false },
				}),
				prepareModel: async () => {
					await prepare()
					live = true
				},
				setReasoningOptions: options,
			}
			h.handlers.push(handler)
			return handler
		})

		await h.task.updateModelRoute({ ...selection(h.configuration), reasoningPreference: h.preference })

		expect(prepare).toHaveBeenCalledOnce()
		expect(options).toHaveBeenCalledWith(
			expect.objectContaining({ enableReasoningEffort: true, reasoningEffort: "high" }),
		)
		expect(h.task.getReasoningState().effective).toEqual(h.preference)
		for (const handler of h.handlers) expect(handler.createMessage).not.toHaveBeenCalled()
	})

	it("cancels metadata preparation without installing or persisting its route", async () => {
		const h = harness()
		const prepare = deferred()
		const started = deferred()
		vi.mocked(buildApiHandler).mockImplementation(() => {
			const handler = {
				...makeHandler("selected-model"),
				prepareModel: async () => {
					started.resolve()
					await prepare.promise
				},
				setReasoningOptions: vi.fn(),
			}
			h.handlers.push(handler)
			return handler
		})
		const updating = h.task.updateModelRoute(selection(h.configuration))
		await started.promise
		h.task.abort = true
		Reflect.get(h.task, "taskCancellationController").abort(new Error("Stopped during model preparation"))
		await expect(updating).rejects.toThrow("Stopped during model preparation")
		prepare.resolve()
		expect(h.task.api).toBe(h.original)
		expect(h.task.reasoningPreference).toEqual(h.preference)
		expect(h.provider.updateTaskHistory).not.toHaveBeenCalled()
		expect(h.handlers.at(-1)?.dispose).toHaveBeenCalledOnce()
		expect(h.events).toEqual([])
	})

	it("rejects an already cancelled request while the recipient task remains available", async () => {
		const h = harness()
		const request = new AbortController()
		request.abort(new Error("The sender cancelled its model selection"))
		await expect(
			h.task.updateModelRoute({ ...selection(h.configuration), signal: request.signal }),
		).rejects.toThrow("The sender cancelled its model selection")
		expect(buildApiHandler).not.toHaveBeenCalled()
		expect(h.task.abort).toBe(false)
		expect(Reflect.get(h.task, "taskCancellationController").signal.aborted).toBe(false)
		expect(h.task.api).toBe(h.original)
		expect(h.events).toEqual([])
	})

	it("cancels a sender's metadata request without stopping or rerouting the recipient", async () => {
		const h = harness()
		const before = h.getHistory()
		const request = new AbortController()
		const prepare = deferred()
		const started = deferred()
		vi.mocked(buildApiHandler).mockImplementation(() => {
			const handler = {
				...makeHandler("selected-model"),
				prepareModel: async () => {
					started.resolve()
					await prepare.promise
				},
				setReasoningOptions: vi.fn(),
			}
			h.handlers.push(handler)
			return handler
		})
		const updating = h.task.updateModelRoute({ ...selection(h.configuration), signal: request.signal })
		await started.promise
		request.abort(new Error("The sender cancelled metadata preparation"))
		prepare.resolve()
		await expect(updating).rejects.toThrow("The sender cancelled metadata preparation")
		expect(h.task.abort).toBe(false)
		expect(Reflect.get(h.task, "taskCancellationController").signal.aborted).toBe(false)
		expect(h.task.api).toBe(h.original)
		expect(h.task.apiConfiguration).toEqual(h.configuration)
		expect(h.task.reasoningPreference).toEqual(h.preference)
		expect(h.getHistory()).toEqual(before)
		expect(h.provider.updateTaskHistory).not.toHaveBeenCalled()
		expect(h.handlers.at(-1)?.dispose).toHaveBeenCalledOnce()
		expect(Reflect.get(h.task, "externalMutationLease")).toBeUndefined()
		expect(h.events).toEqual([])
	})

	it("restores the recipient's prior route when the sender cancels during durable history publication", async () => {
		const h = harness()
		const before = h.getHistory()
		const request = new AbortController()
		const saving = deferred()
		const started = deferred()
		const persist = h.provider.updateTaskHistory.getMockImplementation()!
		h.provider.updateTaskHistory.mockImplementationOnce(async (item) => {
			started.resolve()
			await saving.promise
			return persist(item)
		})
		const updating = h.task.updateModelRoute({ ...selection(h.configuration), signal: request.signal })
		await started.promise
		request.abort(new Error("The sender cancelled route publication"))
		saving.resolve()
		await expect(updating).rejects.toThrow(/persist|cancel/i)
		expect(h.task.abort).toBe(false)
		expect(Reflect.get(h.task, "taskCancellationController").signal.aborted).toBe(false)
		expect(h.task.api).toBe(h.original)
		expect(h.task.apiConfiguration).toEqual(h.configuration)
		expect(h.task.taskApiConfigName).toBe("original-profile")
		expect(h.task.reasoningPreference).toEqual(h.preference)
		expect(h.getHistory()).toEqual(before)
		expect(h.provider.taskHistoryStore.restoreModelRoute).toHaveBeenCalledOnce()
		expect(h.handlers.at(-1)?.dispose).toHaveBeenCalledOnce()
		expect(Reflect.get(h.task, "externalMutationLease")).toBeUndefined()
	})

	it("preserves a newer human selection when a rejected host update needs rollback", async () => {
		const h = harness()
		const persist = h.provider.updateTaskHistory.getMockImplementation()!
		h.provider.updateTaskHistory.mockImplementationOnce(async (item) => {
			await persist(item)
			await h.provider.taskHistoryStore.upsert({
				...item,
				apiConfigName: "newer-human-profile",
				reasoningPreference: { kind: "effort", effort: "low" },
			})
			throw new Error("Old host projection failed")
		})
		await expect(h.task.updateModelRoute(selection(h.configuration))).rejects.toThrow(/persist/i)
		expect(h.getHistory()).toMatchObject({
			apiConfigName: "newer-human-profile",
			reasoningPreference: { kind: "effort", effort: "low" },
		})
		expect(h.provider.taskHistoryStore.upsert).toHaveBeenCalledOnce()
	})

	it("does not roll back the route after a replacement Task takes transcript ownership", async () => {
		const h = harness()
		const persist = h.provider.updateTaskHistory.getMockImplementation()!
		h.provider.updateTaskHistory.mockImplementationOnce(async (item) => {
			await persist(item)
			// A replacement now owns this same selected route. The retiring Task
			// must not compensate its old projection error over the successor.
			Reflect.set(h.task, "isCurrentApiConversationHistoryOwner", () => false)
			throw new Error("Retired host projection failed")
		})
		await expect(h.task.updateModelRoute(selection(h.configuration))).rejects.toThrow(/persist/i)
		expect(h.getHistory()).toMatchObject({
			apiConfigName: "selected-profile",
			threadModelOverride: "selected-model",
			reasoningPreference: { kind: "default" },
		})
		expect(h.provider.taskHistoryStore.restoreModelRoute).toHaveBeenCalledOnce()
		const guard = h.provider.taskHistoryStore.restoreModelRoute.mock.calls[0]?.[3]
		expect(guard?.()).toBe(false)
		expect(h.provider.taskHistoryStore.upsert).not.toHaveBeenCalled()
		expect(h.task.api).toBe(h.original)
	})

	it("reports handler teardown separately after a successful durable selection", async () => {
		const h = harness()
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
		h.original.dispose.mockImplementationOnce(() => {
			throw new Error("Old handler disposal failed")
		})
		try {
			await expect(h.task.updateModelRoute(selection(h.configuration))).resolves.toBeUndefined()
			expect(h.task.api.getModel().id).toBe("selected-model")
			expect(h.getHistory().threadModelOverride).toBe("selected-model")
			expect(error).toHaveBeenCalledWith(
				"Failed to dispose the previous task model route handler:",
				expect.objectContaining({ message: "Old handler disposal failed" }),
			)
		} finally {
			error.mockRestore()
		}
	})

	it("releases the mutation lease even when a rejected candidate fails disposal", async () => {
		const h = harness()
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
		vi.mocked(buildApiHandler).mockImplementation(() => {
			const handler = makeHandler("selected-model", { ...info, supportsReasoningEffort: ["medium"] })
			if (h.handlers.length > 0) {
				handler.dispose.mockImplementationOnce(() => {
					throw new Error("Candidate disposal failed")
				})
			}
			h.handlers.push(handler)
			return handler
		})
		try {
			await expect(
				h.task.updateModelRoute({
					...selection(h.configuration),
					reasoningPreference: h.preference,
				}),
			).rejects.toThrow(/reasoning|effort/i)
			expect(Reflect.get(h.task, "externalMutationLease")).toBeUndefined()
			expect(h.task.api).toBe(h.original)
			expect(h.provider.updateTaskHistory).not.toHaveBeenCalled()
		} finally {
			error.mockRestore()
		}
	})

	it.each(["provider", "modelId", "profileName"])("rejects inconsistent captured %s metadata", async (field) => {
		const h = harness()
		const next = selection(h.configuration)
		Reflect.set(next.threadModelRoute, field, "different")
		await expect(h.task.updateModelRoute(next)).rejects.toThrow(/captured.*route/i)
		expect(buildApiHandler).not.toHaveBeenCalled()
		expect(h.events).toEqual([])
	})
})
