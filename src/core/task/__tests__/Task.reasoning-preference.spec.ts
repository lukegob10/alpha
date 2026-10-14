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

function handler(id: string, effort: "low" | "medium" | "high") {
	return {
		getModel: () => ({
			id,
			info: {
				contextWindow: 128_000,
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
		clineMessages: [],
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
	afterEach(() => {
		vi.restoreAllMocks()
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockReset()
		vi.mocked(manageContext).mockReset()
		vi.mocked(willManageContext).mockReturnValue(false)
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
})
