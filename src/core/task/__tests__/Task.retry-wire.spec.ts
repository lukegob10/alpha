import type { ModelInfo, ProviderSettings } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"
import * as vscode from "vscode"

import type { ApiHandler } from "../../../api"
import { FakeAIHandler } from "../../../api/providers/fake-ai"
import type { ApiStream } from "../../../api/transform/stream"
import { AgentStepContextBuilder, type AgentStepSnapshot } from "../../agent/AgentStepContextBuilder"
import { AgentRetryPolicy } from "../../agent/AgentRetryPolicy"
import type { AgentTurnOutcome } from "../../agent/AgentTurnEngine"
import { getEffectiveApiHistory, summarizeConversation } from "../../condense"
import { manageContext, willManageContext } from "../../context-management"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { Task } from "../Task"

vi.mock("../build-tools", () => ({ buildNativeToolsArrayWithRestrictions: vi.fn() }))
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

function handler(id: string) {
	return {
		getModel: () => ({ id, info: { contextWindow: 128_000, maxTokens: 4096, supportsImages: true } as ModelInfo }),
		countTokens: vi.fn(async () => 10),
		streamCapabilities: { lifecycle: true, cancellation: true },
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
			yield { type: "text", text: "response" }
		}),
	} satisfies ApiHandler
}

async function* failBeforeFirstChunk(error: Error): ApiStream {
	yield* []
	throw error
}

function harness() {
	const originalHandler = handler("original-model")
	const live = {
		mode: "code",
		prompt: "Original system prompt",
		contextTokens: 0,
		autoApprovalEnabled: false,
		surface: surface("read_file"),
		allowedFunctionNames: undefined as string[] | undefined,
	}
	const history: ApiMessage[] = [
		{ role: "user", content: "original request" },
		{
			role: "assistant",
			content: [{ type: "tool_use", id: "old-call", name: "read_file", input: { password: "literal fixture" } }],
			reasoning_details: [
				{ type: "reasoning.encrypted", data: "opaque provider state", continuation_token: "opaque" },
			],
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: "read result" }] },
	]
	const getSystemPrompt = vi.fn(async () => live.prompt)
	const provider = {
		getState: vi.fn(async () => ({
			mode: live.mode,
			autoCondenseContext: false,
			autoApprovalEnabled: live.autoApprovalEnabled,
		})),
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "retry-wire-task",
		instanceId: "retry-wire-instance",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		api: originalHandler,
		apiConfiguration: { apiProvider: "gemini", apiModelId: "original-model" } satisfies ProviderSettings,
		providerRef: { deref: () => provider },
		apiConversationHistory: history,
		clineMessages: [],
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		agentRetryPolicy: new AgentRetryPolicy({ maxAttempts: 2, jitter: "none", baseDelayMs: 0 }),
		getTaskMode: vi.fn(async () => live.mode),
		getSystemPrompt,
		getCurrentProfileId: vi.fn(async () => "profile"),
		getTokenUsage: vi.fn(() => ({ contextTokens: live.contextTokens })),
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
	vi.mocked(buildNativeToolsArrayWithRestrictions).mockImplementation(async () => ({
		tools: structuredClone([...live.surface.schemas]),
		allowedFunctionNames: live.allowedFunctionNames,
		surface: live.surface,
	}))
	vi.mocked(manageContext).mockImplementation(async ({ messages }) => ({
		messages,
		summary: "",
		cost: 0,
		prevContextTokens: 0,
	}))
	return { task, live, originalHandler, getSystemPrompt, provider }
}

function capturedStep(task: Task) {
	return Reflect.get(task, "currentAgentStep") as {
		snapshot: AgentStepSnapshot<ApiHandler, unknown>
		requestId: string
		attemptId: string
		getRequest: () => { messages: unknown[] }
	}
}

function logicalRequest(call: Parameters<ApiHandler["createMessage"]>) {
	const [prompt, messages, metadata] = call
	const {
		signal: _signal,
		deadline: _deadline,
		requestId: _requestId,
		attemptId: _attemptId,
		streamCapabilities: _capabilities,
		...logicalMetadata
	} = metadata!
	return structuredClone({ prompt, messages, metadata: logicalMetadata })
}

describe("Task retained retry wire inputs", () => {
	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.restoreAllMocks())

	it("keeps the runtime FakeAI implementation out of diagnostic options without changing dispatch or retry", async () => {
		const { task } = harness()
		const scripted = handler("scripted-model")
		class ScriptedAI {
			readonly id = "retry-wire-scripted-provider"
			removeFromCache?: () => void
			createMessage(...args: Parameters<ApiHandler["createMessage"]>) {
				return scripted.createMessage(...args)
			}
			getModel() {
				return scripted.getModel()
			}
			countTokens() {
				return scripted.countTokens()
			}
			async completePrompt() {
				return ""
			}
		}
		const fakeAi = new ScriptedAI()
		task.apiConfiguration = { apiProvider: "fake-ai", fakeAi, apiKey: "diagnostic credential fixture" }
		task.api = new FakeAIHandler(task.apiConfiguration)
		const runtimeHandler = task.api
		scripted.createMessage.mockImplementationOnce(() =>
			failBeforeFirstChunk(new Error("scripted first-chunk failure")),
		)
		try {
			expect(typeof fakeAi.removeFromCache).toBe("function")
			await expect(
				task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next(),
			).rejects.toThrow("scripted first-chunk failure")
			const first = capturedStep(task)
			expect(first.snapshot.runtime.getHandler()).toBe(runtimeHandler)
			expect(first.snapshot.context.provider.options).not.toHaveProperty("fakeAi")
			expect(first.snapshot.context.provider.options?.apiKey).toBe("[redacted]")
			expect(task.apiConfiguration.fakeAi).toBe(fakeAi)
			const firstCall = scripted.createMessage.mock.calls[0]
			expect(firstCall[2]).toMatchObject({ taskId: task.taskId, mode: "code" })
			expect(JSON.stringify(firstCall[1])).toContain("literal fixture")
			expect(JSON.stringify(firstCall[1])).toContain("opaque provider state")
			const retry = task.attemptApiRequest(1, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				retryCategory: "transport",
			})
			expect(await retry.next()).toEqual({ done: false, value: { type: "text", text: "response" } })
			expect(await retry.next()).toEqual({ done: true, value: undefined })
			expect(scripted.createMessage).toHaveBeenCalledTimes(2)
			expect(logicalRequest(scripted.createMessage.mock.calls[1])).toEqual(logicalRequest(firstCall))
			expect(capturedStep(task).snapshot.context.contextId).toBe(first.snapshot.context.contextId)
			expect(capturedStep(task).snapshot.runtime.getHandler()).toBe(runtimeHandler)
		} finally {
			fakeAi.removeFromCache?.()
		}
	})

	it.each(["transport", "rate-limit"] as const)(
		"retains the actual logical request and handler across a %s retry, with fresh attempt cancellation",
		async (retryCategory) => {
			const { task, live, originalHandler } = harness()
			if (retryCategory === "rate-limit") live.allowedFunctionNames = ["read_file"]
			Object.assign(task, { skipPrevResponseIdOnce: true })
			const now = vi.spyOn(Date, "now").mockReturnValue(1000)
			const firstStepController = new AbortController()
			originalHandler.createMessage.mockImplementationOnce(() =>
				failBeforeFirstChunk(new Error("first chunk failed")),
			)
			await expect(
				task
					.attemptApiRequest(0, {
						skipProviderRateLimit: true,
						ownerHandlesRetry: true,
						interruptionSignal: firstStepController.signal,
					})
					.next(),
			).rejects.toThrow("first chunk failed")
			const firstStep = capturedStep(task)
			const firstSurface = live.surface
			const firstCall = originalHandler.createMessage.mock.calls[0]
			const expectedRequest = logicalRequest(firstCall)
			const initialMetadata = firstCall[2]!
			expect(JSON.stringify(firstStep.snapshot.context.transcript.messages)).not.toContain("literal fixture")
			expect(JSON.stringify(expectedRequest.messages)).toContain("literal fixture")

			// Neither external edits nor adapter mutation of a previous attempt may alter the capture.
			firstCall[1][0].content = "adapter-mutated request"
			task.apiConversationHistory = [{ role: "user", content: "changed live history" }]
			live.prompt = "Changed system prompt"
			live.mode = "architect"
			live.surface = surface("mcp--new--tool")
			live.allowedFunctionNames = ["mcp--new--tool"]
			task.apiConfiguration = { apiProvider: "openai", apiModelId: "replacement-model" }
			const replacementHandler = handler("replacement-model")
			Object.assign(replacementHandler.streamCapabilities, { cancellation: false })
			Object.assign(originalHandler.streamCapabilities, { lifecycle: false })
			task.api = replacementHandler
			now.mockReturnValue(2000)

			let markStarted!: () => void
			const started = new Promise<void>((resolve) => {
				markStarted = resolve
			})
			originalHandler.createMessage.mockImplementationOnce(async function* (_prompt, _messages, metadata) {
				markStarted()
				await new Promise<void>((resolve) =>
					metadata!.signal!.addEventListener("abort", () => resolve(), { once: true }),
				)
				yield* failBeforeFirstChunk(new Error("cancelled fixture stream"))
			})
			const retryController = new AbortController()
			const retry = task.attemptApiRequest(1, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				retryCategory,
				interruptionSignal: retryController.signal,
			})
			const next = retry.next()
			try {
				// Observe the call without waiting forever if the obsolete implementation picks the new handler.
				await vi.waitFor(() => expect(originalHandler.createMessage).toHaveBeenCalledTimes(2))
				await started
				const retryCall = originalHandler.createMessage.mock.calls[1]
				const retryMetadata = retryCall[2]!
				expect(replacementHandler.createMessage).not.toHaveBeenCalled()
				expect(logicalRequest(retryCall)).toEqual(expectedRequest)
				expect(capturedStep(task).snapshot.context.contextId).toBe(firstStep.snapshot.context.contextId)
				expect(capturedStep(task).snapshot.context.retryAttempt).toBe(1)
				expect(capturedStep(task).snapshot.context.provider.modelId).toBe("original-model")
				expect(capturedStep(task).snapshot.context.provider.apiProvider).toBe("gemini")
				expect(Reflect.get(task, "currentTaskToolSurface")).toBe(firstSurface)
				expect(retryMetadata.streamCapabilities).toEqual({ lifecycle: false, cancellation: true })
				expect(retryMetadata.requestId).toBe(initialMetadata.requestId)
				expect(retryMetadata.attemptId).not.toBe(initialMetadata.attemptId)
				expect(retryMetadata.deadline).toBe(Number(initialMetadata.deadline) + 1000)
				expect(retryMetadata.signal).not.toBe(initialMetadata.signal)
				firstStepController.abort()
				expect(retryMetadata.signal!.aborted).toBe(false)
				retryController.abort()
				await expect(next).rejects.toThrow("Request cancelled by user")
				expect(retryMetadata.signal!.aborted).toBe(true)
				expect(task.currentRequestAbortController).toBeUndefined()
			} finally {
				retryController.abort()
				await next.catch(() => undefined)
				await retry.return(undefined)
			}
		},
	)

	it("clamps a policy-approved retry to its remaining absolute budget and releases request ownership", async () => {
		const { task, originalHandler } = harness()
		vi.spyOn(Date, "now").mockReturnValue(2_000)

		const retry = task.attemptApiRequest(1, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
			retryCategory: "transport",
			retryDeadline: 2_500,
		})
		expect(await retry.next()).toEqual({ done: false, value: { type: "text", text: "response" } })
		expect(originalHandler.createMessage.mock.calls[0][2]?.deadline).toBe(2_500)
		expect(await retry.next()).toEqual({ done: true, value: undefined })
		expect(task.currentRequestAbortController).toBeUndefined()
		expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
	})

	it("releases request ownership when a consumer closes the stream after its first chunk", async () => {
		const { task } = harness()
		const request = task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})

		expect(await request.next()).toMatchObject({ value: { type: "text", text: "response" } })
		expect(task.currentRequestAbortController).toBeDefined()
		expect(Reflect.get(task, "currentRequestSignal")).toBeDefined()
		await request.return(undefined)

		expect(task.currentRequestAbortController).toBeUndefined()
		expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
	})

	it("does not install request ownership when the retry budget expires during preflight", async () => {
		const { task, originalHandler, getSystemPrompt } = harness()
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
		getSystemPrompt.mockImplementationOnce(async () => {
			now.mockReturnValue(1_501)
			return "Original system prompt"
		})

		await expect(
			task
				.attemptApiRequest(1, {
					skipProviderRateLimit: true,
					ownerHandlesRetry: true,
					retryCategory: "transport",
					retryDeadline: 1_500,
				})
				.next(),
		).rejects.toThrow("Automatic retry deadline exceeded")
		expect(originalHandler.createMessage).not.toHaveBeenCalled()
		expect(task.currentRequestAbortController).toBeUndefined()
		expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()

		now.mockReturnValue(2_000)
		const followUp = task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})
		expect(await followUp.next()).toMatchObject({ value: { type: "text", text: "response" } })
		expect(await followUp.next()).toEqual({ done: true, value: undefined })
	})

	it.each(["state", "mode", "system-prompt", "tool-surface", "auto-approval", "context-management"] as const)(
		"does not dispatch after the %s preflight stage returns beyond the retry deadline",
		async (stage) => {
			const { task, live, originalHandler, getSystemPrompt, provider } = harness()
			let nowMs = 1_000
			vi.spyOn(Date, "now").mockImplementation(() => nowMs)
			const expireBudget = () => {
				nowMs = 1_101
			}

			switch (stage) {
				case "state":
					provider.getState.mockImplementationOnce(async () => {
						expireBudget()
						return { mode: "code", autoCondenseContext: false, autoApprovalEnabled: false }
					})
					break
				case "mode":
					vi.mocked(task.getTaskMode).mockImplementationOnce(async () => {
						expireBudget()
						return "code"
					})
					break
				case "system-prompt":
					getSystemPrompt.mockImplementationOnce(async () => {
						expireBudget()
						return "Original system prompt"
					})
					break
				case "tool-surface":
					vi.mocked(buildNativeToolsArrayWithRestrictions).mockImplementationOnce(async () => {
						expireBudget()
						return {
							tools: structuredClone([...live.surface.schemas]),
							allowedFunctionNames: live.allowedFunctionNames,
							surface: live.surface,
						}
					})
					break
				case "auto-approval":
					vi.mocked(task["autoApprovalHandler"].checkAutoApprovalLimits).mockImplementationOnce(async () => {
						expireBudget()
						return { shouldProceed: true, requiresApproval: false }
					})
					break
				case "context-management":
					live.contextTokens = 1
					vi.mocked(manageContext).mockImplementationOnce(async ({ messages }) => {
						expireBudget()
						return { messages, summary: "", cost: 0, prevContextTokens: 1 }
					})
					break
			}

			await expect(
				task
					.attemptApiRequest(1, {
						skipProviderRateLimit: true,
						ownerHandlesRetry: true,
						retryCategory: "context",
						retryDeadline: 1_100,
					})
					.next(),
			).rejects.toThrow("Automatic retry deadline exceeded")
			expect(originalHandler.createMessage).not.toHaveBeenCalled()
			expect(task.currentRequestAbortController).toBeUndefined()
			expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
		},
	)

	it("interrupts a stalled read-only preflight without waiting for its late result", async () => {
		const { task, originalHandler, provider } = harness()
		let markStateStarted!: () => void
		let releaseState!: () => void
		const stateStarted = new Promise<void>((resolve) => {
			markStateStarted = resolve
		})
		const stateRelease = new Promise<void>((resolve) => {
			releaseState = resolve
		})
		provider.getState.mockImplementationOnce(async () => {
			markStateStarted()
			await stateRelease
			return { mode: "code", autoCondenseContext: false, autoApprovalEnabled: false }
		})
		const controller = new AbortController()
		const pending = task
			.attemptApiRequest(0, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				interruptionSignal: controller.signal,
			})
			.next()
		await stateStarted

		controller.abort(new Error("preflight cancelled"))
		await expect(pending).rejects.toThrow("preflight cancelled")
		expect(originalHandler.createMessage).not.toHaveBeenCalled()
		expect(task.currentRequestAbortController).toBeUndefined()

		releaseState()
		await Promise.resolve()
		const followUp = task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})
		expect(await followUp.next()).toMatchObject({ value: { type: "text", text: "response" } })
		expect(await followUp.next()).toEqual({ done: true, value: undefined })
	})

	it.each([
		"auto-approval",
		"context-start",
		"post-start-tool-surface",
		"context-finish",
		"condense-message",
	] as const)("bounds a stalled %s acknowledgement without admitting the provider", async (stage) => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(1_000)
			const { task, live, originalHandler, provider } = harness()
			let markStageStarted!: () => void
			const stageStarted = new Promise<void>((resolve) => {
				markStageStarted = resolve
			})
			const never = async () => {
				markStageStarted()
				await new Promise<void>(() => undefined)
			}

			if (stage === "auto-approval") {
				vi.mocked(task["autoApprovalHandler"].checkAutoApprovalLimits).mockImplementationOnce(async () => {
					await never()
					return { shouldProceed: true, requiresApproval: false }
				})
			} else {
				live.contextTokens = 1
				vi.mocked(willManageContext).mockReturnValueOnce(true)
				if (stage === "context-start" || stage === "post-start-tool-surface") {
					provider.getState.mockResolvedValueOnce({
						mode: "code",
						autoCondenseContext: true,
						autoApprovalEnabled: false,
					})
					Object.assign(provider, {
						postMessageToWebview: stage === "context-start" ? vi.fn(never) : vi.fn(async () => undefined),
					})
					if (stage === "post-start-tool-surface") {
						vi.mocked(buildNativeToolsArrayWithRestrictions).mockImplementationOnce(async () => {
							await never()
							return {
								tools: [],
								allowedFunctionNames: undefined,
								surface: live.surface,
							}
						})
					}
				} else if (stage === "context-finish") {
					provider.getState.mockResolvedValueOnce({
						mode: "code",
						autoCondenseContext: true,
						autoApprovalEnabled: false,
					})
					Object.assign(provider, {
						postMessageToWebview: vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(never),
					})
				} else {
					Object.assign(provider, { postMessageToWebview: vi.fn(async () => undefined) })
					vi.mocked(manageContext).mockImplementationOnce(async ({ messages }) => ({
						messages,
						summary: "bounded summary",
						cost: 0,
						prevContextTokens: 1,
					}))
					Object.assign(task, { say: vi.fn(never) })
				}
			}

			const pending = task
				.attemptApiRequest(1, {
					skipProviderRateLimit: true,
					ownerHandlesRetry: true,
					retryCategory: "context",
					retryDeadline: 1_100,
				})
				.next()
			const rejected = expect(pending).rejects.toThrow("Automatic retry deadline exceeded")
			await stageStarted
			await vi.advanceTimersByTimeAsync(100)
			await rejected

			expect(originalHandler.createMessage).not.toHaveBeenCalled()
			expect(task.currentRequestAbortController).toBeUndefined()
			expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
			if (stage === "context-start" || stage === "post-start-tool-surface") {
				expect(Reflect.get(provider, "postMessageToWebview")).toHaveBeenLastCalledWith({
					type: "condenseTaskContextResponse",
					text: task.taskId,
				})
			}
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it("cancels during lifecycle preflight without retaining request ownership and recovers", async () => {
		const { task, originalHandler } = harness()
		let markLifecycleStarted!: () => void
		let markLifecycleFinished!: () => void
		let releaseLifecycle!: () => void
		const lifecycleStarted = new Promise<void>((resolve) => {
			markLifecycleStarted = resolve
		})
		const lifecycleFinished = new Promise<void>((resolve) => {
			markLifecycleFinished = resolve
		})
		const lifecycleRelease = new Promise<void>((resolve) => {
			releaseLifecycle = resolve
		})
		const ensureLifecycle = Reflect.get(task, "ensureCanonicalLifecycleStepStarted") as {
			mockImplementationOnce(implementation: () => Promise<void>): void
		}
		ensureLifecycle.mockImplementationOnce(async () => {
			markLifecycleStarted()
			await lifecycleRelease
			markLifecycleFinished()
		})
		const publishPhase = Reflect.get(task, "publishCanonicalLifecyclePhase") as ReturnType<typeof vi.fn>
		const appendEvent = Reflect.get(task, "appendAgentTurnEvent") as ReturnType<typeof vi.fn>
		const controller = new AbortController()
		const pending = task
			.attemptApiRequest(0, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				interruptionSignal: controller.signal,
			})
			.next()
		await lifecycleStarted

		controller.abort(new Error("lifecycle preflight cancelled"))
		await expect(pending).rejects.toThrow("lifecycle preflight cancelled")
		expect(originalHandler.createMessage).not.toHaveBeenCalled()
		expect(publishPhase).not.toHaveBeenCalled()
		expect(appendEvent).not.toHaveBeenCalled()
		expect(task.currentRequestAbortController).toBeUndefined()
		expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()

		// The abandoned lifecycle operation may settle later, but its guard prevents
		// it from committing any of the remaining stale preflight events.
		releaseLifecycle()
		await lifecycleFinished
		await Promise.resolve()
		expect(publishPhase).not.toHaveBeenCalled()
		expect(appendEvent).not.toHaveBeenCalled()

		const followUp = task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})
		expect(await followUp.next()).toMatchObject({ value: { type: "text", text: "response" } })
		expect(await followUp.next()).toEqual({ done: true, value: undefined })
	})

	it("expires a stalled lifecycle preflight at its absolute retry deadline without late commits", async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(1_000)
			const { task, originalHandler } = harness()
			let markLifecycleStarted!: () => void
			let releaseLifecycle!: () => void
			const lifecycleStarted = new Promise<void>((resolve) => {
				markLifecycleStarted = resolve
			})
			const lifecycleRelease = new Promise<void>((resolve) => {
				releaseLifecycle = resolve
			})
			const ensureLifecycle = Reflect.get(task, "ensureCanonicalLifecycleStepStarted") as {
				mockImplementationOnce(implementation: () => Promise<void>): void
			}
			ensureLifecycle.mockImplementationOnce(async () => {
				markLifecycleStarted()
				await lifecycleRelease
			})
			const publishPhase = Reflect.get(task, "publishCanonicalLifecyclePhase") as ReturnType<typeof vi.fn>
			const appendEvent = Reflect.get(task, "appendAgentTurnEvent") as ReturnType<typeof vi.fn>
			const pending = task
				.attemptApiRequest(1, {
					skipProviderRateLimit: true,
					ownerHandlesRetry: true,
					retryCategory: "transport",
					retryDeadline: 1_100,
				})
				.next()
			await lifecycleStarted

			const rejected = expect(pending).rejects.toThrow("Automatic retry deadline exceeded")
			await vi.advanceTimersByTimeAsync(100)
			await rejected
			expect(originalHandler.createMessage).not.toHaveBeenCalled()
			expect(task.currentRequestAbortController).toBeUndefined()
			expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()

			releaseLifecycle()
			await Promise.resolve()
			await Promise.resolve()
			expect(publishPhase).not.toHaveBeenCalled()
			expect(appendEvent).not.toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it("drops a queued canonical lifecycle event after its request guard becomes stale", async () => {
		const { task, provider } = harness()
		let releaseQueue!: () => void
		const heldQueue = new Promise<void>((resolve) => {
			releaseQueue = resolve
		})
		const publishLifecycleEvent = vi.fn(async () => ({ accepted: true }))
		Object.assign(provider, { publishAgentLifecycleEvent: publishLifecycleEvent })
		Object.assign(task, {
			agentRunId: "old-run",
			agentTurnId: "old-turn",
			canonicalLifecycleQueue: heldQueue,
			canonicalLifecyclePersistenceFailure: undefined,
		})
		let current = true
		const pending = (Task.prototype as any).enqueueCanonicalLifecycleEvent.call(
			task,
			"phase_changed",
			{ phase: "working" },
			undefined,
			() => current,
		)

		current = false
		Object.assign(task, { agentRunId: "new-run", agentTurnId: "new-turn" })
		releaseQueue()
		await pending

		expect(publishLifecycleEvent).not.toHaveBeenCalled()
	})

	it("does not apply a late lifecycle rejection to the replacement turn", async () => {
		const { task, provider } = harness()
		let rejectPublish!: (error: Error) => void
		const publishLifecycleEvent = vi.fn(
			() =>
				new Promise<{ accepted: boolean; error: Error }>((_resolve, reject) => {
					rejectPublish = reject
				}),
		)
		const markLifecycleDegraded = vi.fn()
		Object.assign(provider, {
			publishAgentLifecycleEvent: publishLifecycleEvent,
			markAgentLifecycleDegraded: markLifecycleDegraded,
		})
		Object.assign(task, {
			agentRunId: "old-run",
			agentTurnId: "old-turn",
			canonicalLifecycleQueue: Promise.resolve(),
			canonicalLifecyclePersistenceFailure: undefined,
		})
		let current = true
		const pending = (Task.prototype as any).enqueueCanonicalLifecycleEvent.call(
			task,
			"phase_changed",
			{ phase: "working" },
			undefined,
			() => current,
		)
		await vi.waitFor(() => expect(publishLifecycleEvent).toHaveBeenCalledOnce())

		current = false
		Object.assign(task, { agentRunId: "new-run", agentTurnId: "new-turn" })
		rejectPublish(new Error("late rejected append"))
		await pending

		expect(Reflect.get(task, "canonicalLifecyclePersistenceFailure")).toBeUndefined()
		expect(markLifecycleDegraded).not.toHaveBeenCalled()
	})

	it("fences background usage ownership from a replacement request and transcript message", () => {
		const { task } = harness()
		const oldRequestController = new AbortController()
		const followUpController = new AbortController()
		const oldMessage = { ts: 1, type: "say", say: "api_req_started", text: "{}" } as const
		const replacementMessage = { ...oldMessage }
		Object.assign(task, {
			clineMessages: [oldMessage],
			backgroundUsageDrainEpoch: 0,
			backgroundUsageDrainAbortController: undefined,
			abandoned: false,
		})
		const owner = (task as any).beginBackgroundUsageDrain(oldRequestController, 0, oldMessage)

		expect((task as any).isBackgroundUsageDrainCurrent(owner)).toBe(true)
		task.currentRequestAbortController = followUpController
		task.clineMessages = [replacementMessage]
		expect((task as any).isBackgroundUsageDrainCurrent(owner)).toBe(false)
		;(task as any).invalidateBackgroundUsageDrain("replacement request")
		expect(owner.controller.signal.aborted).toBe(true)
		// A late timeout belongs to the captured old controller, never the mutable
		// current-request field now owned by the follow-up.
		owner.requestController?.abort(new Error("old usage timeout"))
		expect(oldRequestController.signal.aborted).toBe(true)
		expect(followUpController.signal.aborted).toBe(false)
		expect((task as any).isBackgroundUsageDrainCurrent(owner)).toBe(false)
	})

	it("bounds provider-lane pacing by the retry deadline before request ownership", async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(2_000)
			vi.spyOn(performance, "now").mockReturnValue(0)
			const { task, originalHandler } = harness()
			task.apiConfiguration = { ...task.apiConfiguration, rateLimitSeconds: 1 }
			Object.assign(task, { getProviderRateLimitLaneKey: vi.fn(async () => "deadline-lane") })
			const lanes = Reflect.get(Task, "providerRateLimitLanes") as Map<
				string,
				{ queue: Promise<void>; lastRequestTime?: number }
			>
			lanes.set("deadline-lane", { queue: Promise.resolve(), lastRequestTime: 0 })

			const pending = task
				.attemptApiRequest(1, {
					ownerHandlesRetry: true,
					retryCategory: "transport",
					retryDeadline: 2_100,
				})
				.next()
			const rejected = expect(pending).rejects.toThrow("Automatic retry deadline exceeded")
			await vi.advanceTimersByTimeAsync(100)
			await rejected

			expect(originalHandler.createMessage).not.toHaveBeenCalled()
			expect(lanes.get("deadline-lane")?.lastRequestTime).toBe(0)
			expect(task.currentRequestAbortController).toBeUndefined()
			expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			Task.resetGlobalApiRequestTime()
			vi.useRealTimers()
		}
	})

	it("releases the provider lane when cancelled cleanup acknowledgement stalls and permits a healthy follow-up", async () => {
		let now = 0
		vi.spyOn(performance, "now").mockImplementation(() => now)
		const { task, originalHandler } = harness()
		task.apiConfiguration = { ...task.apiConfiguration, rateLimitSeconds: 1 }
		Object.assign(task, { getProviderRateLimitLaneKey: vi.fn(async () => "cleanup-lane") })
		const lanes = Reflect.get(Task, "providerRateLimitLanes") as Map<
			string,
			{ queue: Promise<void>; lastRequestTime?: number }
		>
		lanes.set("cleanup-lane", { queue: Promise.resolve(), lastRequestTime: 0 })
		let markCountdownStarted!: () => void
		let markCleanupStarted!: () => void
		const countdownStarted = new Promise<void>((resolve) => {
			markCountdownStarted = resolve
		})
		const cleanupStarted = new Promise<void>((resolve) => {
			markCleanupStarted = resolve
		})
		const cleanupNeverSettles = new Promise<void>(() => undefined)
		const say = vi.fn(async (_type: string, _text?: string, _images?: string[], partial?: boolean) => {
			if (partial === true) {
				markCountdownStarted()
				return
			}
			markCleanupStarted()
			await cleanupNeverSettles
		})
		Object.assign(task, { say })
		const controller = new AbortController()

		try {
			const pending = (task as any).maybeWaitForProviderRateLimit(
				0,
				undefined,
				controller.signal,
				Date.now() + 10_000,
			) as Promise<void>
			await countdownStarted
			controller.abort(new Error("rate-limit wait cancelled"))
			await cleanupStarted
			await expect(pending).rejects.toThrow("rate-limit wait cancelled")
			await expect(lanes.get("cleanup-lane")?.queue).resolves.toBeUndefined()
			expect(lanes.get("cleanup-lane")?.lastRequestTime).toBe(0)
			expect(originalHandler.createMessage).not.toHaveBeenCalled()

			now = 1_001
			Object.assign(task, { say: vi.fn(async () => undefined) })
			const followUp = task.attemptApiRequest(0, { ownerHandlesRetry: true })
			expect(await followUp.next()).toMatchObject({ value: { type: "text", text: "response" } })
			expect(await followUp.next()).toEqual({ done: true, value: undefined })
			expect(originalHandler.createMessage).toHaveBeenCalledOnce()
			expect(task.currentRequestAbortController).toBeUndefined()
			expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
		} finally {
			Task.resetGlobalApiRequestTime()
		}
	})

	it.each(["context", "empty-response", undefined] as const)(
		"does not compact retained retries, but a new %s boundary sends changed inputs",
		async (retryCategory) => {
			const { task, live, originalHandler, getSystemPrompt } = harness()
			originalHandler.createMessage.mockImplementationOnce(() =>
				failBeforeFirstChunk(new Error("first chunk failed")),
			)
			await expect(
				task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next(),
			).rejects.toThrow("first chunk failed")
			const initial = capturedStep(task)
			live.contextTokens = 120_000
			live.prompt = "Recovered system prompt"
			live.mode = "architect"
			live.surface = surface("list_files")
			live.allowedFunctionNames = ["list_files"]
			task.apiConversationHistory = [{ role: "user", content: "recovered history" }]
			const retry = task.attemptApiRequest(1, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				retryCategory: "transport",
			})
			await retry.next()
			await retry.next()
			expect(manageContext).not.toHaveBeenCalled()
			expect(willManageContext).not.toHaveBeenCalled()
			expect(getSystemPrompt).toHaveBeenCalledOnce()

			const replacementHandler = handler("recovery-model")
			task.api = replacementHandler
			task.apiConfiguration = { apiProvider: "gemini", apiModelId: "recovery-model" }
			const recovery = task.attemptApiRequest(2, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				retryCategory,
			})
			await recovery.next()
			await recovery.next()
			const recovered = capturedStep(task)
			expect(recovered.snapshot.context.contextId).not.toBe(initial.snapshot.context.contextId)
			expect(recovered.requestId).not.toBe(initial.requestId)
			expect(() => initial.getRequest()).toThrow("released")
			expect(manageContext).toHaveBeenCalledOnce()
			expect(replacementHandler.createMessage).toHaveBeenCalledWith(
				"Recovered system prompt",
				[{ role: "user", content: "recovered history" }],
				expect.objectContaining({
					mode: "architect",
					tools: live.surface.schemas,
					allowedFunctionNames: ["list_files"],
				}),
			)
		},
	)

	it.each(["openai-native", "gemini", "vscode-lm"] as const)(
		"retains recent %s provider state through real compaction and a transport retry",
		async (apiProvider) => {
			if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
			const { task, live, originalHandler } = harness()
			task.apiConfiguration = { apiProvider, apiModelId: "original-model" }
			const execute = live.surface.registry.resolve("read_file")!.execute
			const toolCall = {
				type: "tool_use" as const,
				id: "recent-read",
				name: "read_file",
				input: { path: "recent.ts", password: "literal retained fixture" },
			}
			const toolResult = {
				type: "tool_result" as const,
				tool_use_id: toolCall.id,
				content: "recent exact read result",
				is_error: false,
			}
			const encryptedReasoning = {
				type: "reasoning" as const,
				id: "recent-reasoning-id",
				encrypted_content: "opaque encrypted continuation",
				summary: [{ type: "summary_text", text: "recent reasoning summary" }],
			}
			const assistant = {
				role: "assistant" as const,
				content: [toolCall],
				...(apiProvider === "gemini"
					? {
							reasoning_details: [
								{
									type: "reasoning.encrypted",
									data: "opaque Gemini state",
									continuation_token: "opaque cursor",
								},
							],
						}
					: {}),
				...(apiProvider === "vscode-lm"
					? { vscodeLmStatefulMarker: Buffer.from("opaque VS Code state").toString("base64") }
					: {}),
			}
			const result = { role: "user" as const, content: [toolResult] }
			const summaryHandler = {
				...handler("summary-model"),
				countTokens: vi.fn<ApiHandler["countTokens"]>(async (content) =>
					Math.ceil(Buffer.byteLength(JSON.stringify(content), "utf8") / 4),
				),
			}
			summaryHandler.createMessage.mockImplementation(async function* () {
				yield { type: "text", text: "Older work is complete. Continue from the recent read." }
				yield {
					type: "outcome",
					status: "completed",
					terminal: true,
					semanticOutputObserved: true,
				}
			})
			// Keep the recent transaction small; either older message alone exceeds the tail budget.
			const messages: ApiMessage[] = [
				{ role: "user", content: "superseded request ".repeat(512) },
				{ role: "assistant", content: "obsolete investigation ".repeat(512) },
				{ role: "user", content: "Use the recent read and preserve my correction." },
				...(apiProvider === "openai-native"
					? [{ role: "assistant" as const, content: [], ...encryptedReasoning }]
					: []),
				assistant,
				result,
			]
			const options = {
				messages,
				apiHandler: summaryHandler,
				systemPrompt: live.prompt,
				taskId: task.taskId,
				recentTailTokenBudget: 1_024,
				maxContextTokens: 2_048,
				metadata: { taskId: task.taskId, tools: [...live.surface.schemas] },
			}
			const compacted = await summarizeConversation(options)
			expect(compacted.error).toBeUndefined()
			task.apiConversationHistory = compacted.messages
			live.contextTokens = compacted.newContextTokens!
			originalHandler.createMessage.mockImplementationOnce(() =>
				failBeforeFirstChunk(new Error("post-compaction transport failure")),
			)
			await expect(
				task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next(),
			).rejects.toThrow("post-compaction transport failure")
			const firstStep = capturedStep(task)
			const firstCall = originalHandler.createMessage.mock.calls[0]
			const expectedRequest = logicalRequest(firstCall)
			const wireTail = [...(apiProvider === "openai-native" ? [encryptedReasoning] : []), assistant, result]
			expect(expectedRequest.messages.slice(-wireTail.length)).toEqual(wireTail)
			expect(getEffectiveApiHistory(compacted.messages)).toContainEqual(assistant)
			expect(JSON.stringify(expectedRequest.messages)).not.toContain("obsolete investigation")
			const blocks = expectedRequest.messages.flatMap((message) =>
				Array.isArray(message.content) ? message.content : [],
			)
			expect(blocks.filter((block) => block.type === "tool_use")).toEqual([toolCall])
			expect(blocks.filter((block) => block.type === "tool_result")).toEqual([toolResult])
			// The already compacted step captures only its dispatch surface.
			// A retained transport retry must not rebuild that captured surface.
			const toolBuildsBeforeRetry = vi.mocked(buildNativeToolsArrayWithRestrictions).mock.calls.length
			expect(toolBuildsBeforeRetry).toBe(1)

			firstCall[1].at(-2)!.content = "adapter-mutated recent turn"
			task.apiConversationHistory = [{ role: "user", content: "changed live history" }]
			live.contextTokens = 120_000
			live.prompt = "changed live prompt"
			live.mode = "architect"
			live.surface = surface("list_files")
			const replacementHandler = handler("replacement-model")
			task.api = replacementHandler
			task.apiConfiguration = { apiProvider: "anthropic", apiModelId: "replacement-model" }
			const retry = task.attemptApiRequest(1, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				retryCategory: "transport",
			})
			await expect(retry.next()).resolves.toMatchObject({ value: { type: "text", text: "response" } })
			await expect(retry.next()).resolves.toEqual({ value: undefined, done: true })
			const secondCall = originalHandler.createMessage.mock.calls[1]
			expect(logicalRequest(secondCall)).toEqual(expectedRequest)
			expect(secondCall[2]!.requestId).toBe(firstCall[2]!.requestId)
			expect(secondCall[2]!.attemptId).not.toBe(firstCall[2]!.attemptId)
			expect(secondCall[2]!.signal).not.toBe(firstCall[2]!.signal)
			expect(capturedStep(task).snapshot.context.contextId).toBe(firstStep.snapshot.context.contextId)
			expect(originalHandler.createMessage).toHaveBeenCalledTimes(2)
			expect(replacementHandler.createMessage).not.toHaveBeenCalled()
			expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledTimes(toolBuildsBeforeRetry)
			expect(manageContext).toHaveBeenCalledOnce()
			expect(summaryHandler.createMessage).toHaveBeenCalledOnce()
			expect(summaryHandler.createMessage.mock.calls[0][2]).toMatchObject({ tools: [], tool_choice: "none" })
			expect(execute).not.toHaveBeenCalled()
		},
	)

	it("retains raw wire input and the handler in the bounded direct-caller retry path", async () => {
		const { task, live, originalHandler } = harness()
		live.autoApprovalEnabled = true
		const replacementHandler = handler("replacement-model")
		Object.assign(task, {
			backoffAndAnnounce: vi.fn(async () => {
				task.api = replacementHandler
				live.prompt = "changed while backing off"
				task.apiConversationHistory = [{ role: "user", content: "changed live history" }]
			}),
		})
		originalHandler.createMessage.mockImplementationOnce(() =>
			failBeforeFirstChunk(new Error("first chunk failed")),
		)
		const request = task.attemptApiRequest(0, { skipProviderRateLimit: true })
		await expect(request.next()).resolves.toMatchObject({ value: { type: "text", text: "response" } })
		await request.next()
		expect(originalHandler.createMessage).toHaveBeenCalledTimes(2)
		expect(replacementHandler.createMessage).not.toHaveBeenCalled()
		const [first, second] = originalHandler.createMessage.mock.calls
		expect(logicalRequest(second)).toEqual(logicalRequest(first))
		expect(second[2]!.requestId).toBe(first[2]!.requestId)
		expect(second[2]!.attemptId).not.toBe(first[2]!.attemptId)
		expect(second[2]!.signal).not.toBe(first[2]!.signal)
		expect(capturedStep(task).snapshot.context.retryAttempt).toBe(1)
	})

	it("does not retry a direct-caller first-chunk failure after the logical elapsed budget", async () => {
		const { task, live, originalHandler } = harness()
		live.autoApprovalEnabled = true
		let elapsedMs = 0
		vi.spyOn(performance, "now").mockImplementation(() => elapsedMs)
		const backoff = vi.fn(async () => {})
		Object.assign(task, { backoffAndAnnounce: backoff })
		originalHandler.createMessage.mockImplementationOnce(async function* () {
			elapsedMs = 90_001
			yield* []
			throw new Error("long first-chunk deadline exhausted")
		})

		await expect(task.attemptApiRequest(0, { skipProviderRateLimit: true }).next()).rejects.toThrow(
			"long first-chunk deadline exhausted",
		)

		expect(originalHandler.createMessage).toHaveBeenCalledOnce()
		expect(backoff).not.toHaveBeenCalled()
		expect(task.currentRequestAbortController).toBeUndefined()
		expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
	})

	it.each(["retry-event", "announcement", "countdown"] as const)(
		"bounds a stalled main-loop %s by its absolute retry deadline",
		async (stage) => {
			vi.useFakeTimers()
			try {
				vi.setSystemTime(3_000)
				const { task } = harness()
				const never = () => new Promise<void>(() => undefined)
				const appendEvent = vi.fn(stage === "retry-event" ? never : async () => undefined)
				const say = vi.fn(stage === "announcement" ? never : async () => undefined)
				Object.assign(task, { appendAgentTurnEvent: appendEvent, say })
				const controller = new AbortController()
				const pending = (task as any).waitForRetryDecision(
					{ shouldRetry: true, attempt: 1, nextAttempt: 2, delayMs: 1_000 },
					new Error("retryable failure"),
					controller.signal,
					3_100,
				)
				if (stage !== "countdown") {
					await vi.waitFor(() => expect(stage === "retry-event" ? appendEvent : say).toHaveBeenCalledOnce())
				}

				const rejected = expect(pending).rejects.toThrow("Automatic retry deadline exceeded")
				await vi.advanceTimersByTimeAsync(100)
				await rejected
				expect(vi.getTimerCount()).toBe(0)
				if (stage === "retry-event") expect(say).not.toHaveBeenCalled()
				if (stage === "countdown") expect(say).toHaveBeenCalledOnce()
			} finally {
				vi.useRealTimers()
			}
		},
	)

	it("bounds a direct compatibility retry wait by the tighter supplied deadline", async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(4_000)
			const { task, live, originalHandler } = harness()
			live.autoApprovalEnabled = true
			originalHandler.createMessage.mockImplementationOnce(() =>
				failBeforeFirstChunk(new Error("retryable first-chunk failure")),
			)
			const backoff = vi.fn(
				(_retryAttempt: number, _error: unknown, _retryDeadline?: number) => new Promise<void>(() => undefined),
			)
			Object.assign(task, { backoffAndAnnounce: backoff })

			const pending = task
				.attemptApiRequest(0, {
					skipProviderRateLimit: true,
					retryDeadline: 4_100,
				})
				.next()
			await vi.waitFor(() => expect(backoff).toHaveBeenCalledOnce())
			const rejected = expect(pending).rejects.toThrow("Automatic retry deadline exceeded")
			await vi.advanceTimersByTimeAsync(100)
			await rejected

			expect(backoff.mock.calls[0]?.[2]).toBe(4_100)
			expect(originalHandler.createMessage).toHaveBeenCalledOnce()
			expect(task.currentRequestAbortController).toBeUndefined()
			expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it("stops the direct compatibility countdown when its UI acknowledgement outlives the retry deadline", async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(5_000)
			const { task, live, originalHandler } = harness()
			live.autoApprovalEnabled = true
			Object.assign(task, {
				agentRetryPolicy: new AgentRetryPolicy({ maxAttempts: 2, jitter: "none", baseDelayMs: 1_000 }),
			})
			originalHandler.createMessage.mockImplementationOnce(() =>
				failBeforeFirstChunk(new Error("retryable first-chunk failure")),
			)
			const say = vi.fn(() => new Promise<void>(() => undefined))
			Object.assign(task, { say })

			const pending = task
				.attemptApiRequest(0, {
					skipProviderRateLimit: true,
					retryDeadline: 5_100,
				})
				.next()
			await vi.waitFor(() => expect(say).toHaveBeenCalledOnce())
			const rejected = expect(pending).rejects.toThrow("Automatic retry deadline exceeded")
			await vi.advanceTimersByTimeAsync(100)
			await rejected

			expect(originalHandler.createMessage).toHaveBeenCalledOnce()
			expect(task.currentRequestAbortController).toBeUndefined()
			expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it("interrupts a stalled compatibility stream, closes its iterator, and permits a healthy follow-up", async () => {
		const { task, live, originalHandler } = harness()
		live.autoApprovalEnabled = true
		const closeCompatibilityIterator = vi.fn(async () => ({ done: true as const, value: undefined }))
		const stalledCompatibilityStream = {
			[Symbol.asyncIterator]() {
				return this
			},
			next: vi.fn(() => new Promise<IteratorResult<never>>(() => undefined)),
			return: closeCompatibilityIterator,
		} as unknown as ApiStream
		originalHandler.createMessage
			.mockImplementationOnce(() => failBeforeFirstChunk(new Error("initial transport failure")))
			.mockImplementationOnce(() => stalledCompatibilityStream)
		const backoff = vi.fn(async () => undefined)
		Object.assign(task, { backoffAndAnnounce: backoff })
		const controller = new AbortController()
		const pending = task
			.attemptApiRequest(0, {
				skipProviderRateLimit: true,
				interruptionSignal: controller.signal,
			})
			.next()
		await vi.waitFor(() => expect(originalHandler.createMessage).toHaveBeenCalledTimes(2))
		const compatibilityMetadata = originalHandler.createMessage.mock.calls[1]?.[2]

		controller.abort(new Error("compatibility retry cancelled"))
		await expect(pending).rejects.toThrow("compatibility retry cancelled")
		expect(compatibilityMetadata?.signal?.aborted).toBe(true)
		expect(closeCompatibilityIterator).toHaveBeenCalledOnce()
		expect(task.currentRequestAbortController).toBeUndefined()
		expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()

		originalHandler.createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "healthy follow-up" }
		})
		const followUp = task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})
		expect(await followUp.next()).toMatchObject({ value: { type: "text", text: "healthy follow-up" } })
		expect(await followUp.next()).toEqual({ done: true, value: undefined })
		expect(originalHandler.createMessage).toHaveBeenCalledTimes(3)
	})

	it("lets the outer retry deadline stop a stalled compatibility read when API timeout is disabled", async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(6_000)
			vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
				get: (key: string, defaultValue: unknown) => (key === "apiRequestTimeout" ? 0 : defaultValue),
			} as any)
			const { task, live, originalHandler } = harness()
			live.autoApprovalEnabled = true
			const closeCompatibilityIterator = vi.fn(async () => ({ done: true as const, value: undefined }))
			const stalledCompatibilityStream = {
				[Symbol.asyncIterator]() {
					return this
				},
				next: vi.fn(() => new Promise<IteratorResult<never>>(() => undefined)),
				return: closeCompatibilityIterator,
			} as unknown as ApiStream
			originalHandler.createMessage
				.mockImplementationOnce(() => failBeforeFirstChunk(new Error("initial transport failure")))
				.mockImplementationOnce(() => stalledCompatibilityStream)
			Object.assign(task, { backoffAndAnnounce: vi.fn(async () => undefined) })

			const pending = task
				.attemptApiRequest(0, {
					skipProviderRateLimit: true,
					retryDeadline: 6_100,
				})
				.next()
			const rejected = expect(pending).rejects.toMatchObject({ name: "ApiStreamDeadlineError" })
			await vi.waitFor(() => expect(originalHandler.createMessage).toHaveBeenCalledTimes(2))
			const compatibilityMetadata = originalHandler.createMessage.mock.calls[1]?.[2]

			await vi.advanceTimersByTimeAsync(100)
			await rejected
			expect(compatibilityMetadata?.deadline).toBe(6_100)
			expect(compatibilityMetadata?.signal?.aborted).toBe(true)
			expect(closeCompatibilityIterator).toHaveBeenCalledOnce()
			expect(originalHandler.createMessage).toHaveBeenCalledTimes(2)
			expect(task.currentRequestAbortController).toBeUndefined()
			expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it("returns context errors to the direct caller instead of replaying obsolete captured input", async () => {
		const { task, live, originalHandler } = harness()
		live.autoApprovalEnabled = true
		const backoff = vi.fn(async () => {})
		Object.assign(task, { backoffAndAnnounce: backoff })
		originalHandler.createMessage.mockImplementationOnce(() =>
			failBeforeFirstChunk(Object.assign(new Error("context recovery required"), { retryCategory: "context" })),
		)
		await expect(task.attemptApiRequest(0, { skipProviderRateLimit: true }).next()).rejects.toThrow(
			"context recovery required",
		)
		expect(originalHandler.createMessage).toHaveBeenCalledOnce()
		expect(backoff).not.toHaveBeenCalled()
	})

	it("settles an empty compatibility response without another retained retry", async () => {
		const { task, live, originalHandler } = harness()
		live.autoApprovalEnabled = true
		// Fail fast if the old loop retries EOF without advancing its attempt budget.
		const backoff = vi
			.fn(async (): Promise<void> => {
				throw new Error("Unexpected retry after empty response")
			})
			.mockResolvedValueOnce(undefined)
		Object.assign(task, { backoffAndAnnounce: backoff })
		originalHandler.createMessage
			.mockImplementation(async function* () {
				yield* []
			})
			.mockImplementationOnce(() => failBeforeFirstChunk(new Error("initial transport failure")))
		const request = task.attemptApiRequest(0, { skipProviderRateLimit: true })
		await expect(request.next()).rejects.toMatchObject({
			message: "Provider returned an empty response",
			retryCategory: "empty-response",
			firstChunkFailure: true,
		})
		await expect(request.next()).resolves.toEqual({ value: undefined, done: true })
		expect(originalHandler.createMessage).toHaveBeenCalledTimes(2)
		expect(backoff).toHaveBeenCalledOnce()
		expect(task.isWaitingForFirstChunk).toBe(false)
		expect(task.currentRequestAbortController).toBeUndefined()
		expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
	})

	it.each(["context", "transport", "rate-limit"] as const)(
		"propagates the latest %s compatibility failure to the direct caller",
		async (retryCategory) => {
			const { task, live, originalHandler } = harness()
			live.autoApprovalEnabled = true
			const backoff = vi.fn(async () => {})
			Object.assign(task, { backoffAndAnnounce: backoff })
			const latestError = Object.assign(new Error("latest compatibility failure"), { retryCategory })
			originalHandler.createMessage
				.mockImplementationOnce(() => failBeforeFirstChunk(new Error("initial transport failure")))
				.mockImplementationOnce(() => failBeforeFirstChunk(latestError))
			const request = task.attemptApiRequest(0, { skipProviderRateLimit: true })
			await expect(request.next()).rejects.toBe(latestError)
			await expect(request.next()).resolves.toEqual({ value: undefined, done: true })
			expect(originalHandler.createMessage).toHaveBeenCalledTimes(2)
			expect(backoff).toHaveBeenCalledOnce()
			expect(task.isWaitingForFirstChunk).toBe(false)
			expect(task.currentRequestAbortController).toBeUndefined()
		},
	)

	it.each(["completed", "aborted", "exhausted"] as const)(
		"releases only raw retry input after %s lifecycle finalization",
		async (status) => {
			const { task, originalHandler } = harness()
			originalHandler.createMessage.mockImplementationOnce(() =>
				failBeforeFirstChunk(new Error("first chunk failed")),
			)
			await expect(
				task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next(),
			).rejects.toThrow("first chunk failed")
			const original = capturedStep(task)
			const request = task.attemptApiRequest(1, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				retryCategory: "transport",
			})
			await request.next()
			await request.next()
			const retained = capturedStep(task)
			expect(original.getRequest()).toEqual(retained.getRequest())
			const publish = vi.fn(async () => {
				expect(() => retained.getRequest()).not.toThrow()
			})
			Object.assign(task, { enqueueCanonicalLifecycleEvent: publish })
			const finalize = Reflect.get(task, "finishCanonicalLifecycleTurn") as (
				outcome: AgentTurnOutcome,
			) => Promise<void>
			await finalize.call(task, { status } as AgentTurnOutcome)
			expect(publish.mock.calls).toHaveLength(2)
			expect(capturedStep(task).snapshot).toBe(retained.snapshot)
			expect(() => original.getRequest()).toThrow("released")
			expect(() => retained.getRequest()).toThrow("released")
		},
	)

	it.each(["anthropic", "gemini", "openai-native", "vscode-lm", "summary"] as const)(
		"persists a successful retry's %s response state from the captured handler and protocol",
		async (kind) => {
			const { task, originalHandler } = harness()
			task.apiConfiguration = { apiProvider: kind === "summary" ? "openai" : kind, apiModelId: "original-model" }
			const hasSignature = kind === "anthropic" || kind === "gemini"
			const reasoning = kind === "anthropic" || kind === "summary" ? "captured reasoning" : undefined
			Object.assign(originalHandler, {
				getResponseId: () => "original-response",
				getThoughtSignature: () => (hasSignature ? "original-signature" : undefined),
				getEncryptedContent: () =>
					kind === "openai-native"
						? { encrypted_content: "original-encrypted", id: "original-reasoning" }
						: undefined,
				getSummary: () => (kind === "summary" ? [{ text: "original-summary" }] : undefined),
				getReasoningDetails: () =>
					kind === "gemini" ? [{ type: "reasoning.encrypted", data: "original-details" }] : undefined,
				getStatefulMarker: () => (kind === "vscode-lm" ? "original-stateful-marker" : undefined),
			})
			originalHandler.createMessage.mockImplementationOnce(() =>
				failBeforeFirstChunk(new Error("first chunk failed")),
			)
			await expect(
				task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next(),
			).rejects.toThrow("first chunk failed")
			const replacementMetadata = {
				getResponseId: vi.fn(() => "replacement-response"),
				getThoughtSignature: vi.fn(() => "replacement-signature"),
				getEncryptedContent: vi.fn(() => ({ encrypted_content: "replacement-encrypted" })),
				getSummary: vi.fn(() => [{ text: "replacement-summary" }]),
				getReasoningDetails: vi.fn(() => [{ type: "reasoning.encrypted", data: "replacement-details" }]),
				getStatefulMarker: vi.fn(() => "replacement-stateful-marker"),
			}
			task.api = Object.assign(handler("replacement-model"), replacementMetadata)
			task.apiConfiguration = {
				apiProvider: kind === "anthropic" ? "gemini" : "anthropic",
				apiModelId: "replacement-model",
			}
			const request = task.attemptApiRequest(1, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				retryCategory: "transport",
			})
			await expect(request.next()).resolves.toMatchObject({ value: { type: "text", text: "response" } })
			await request.next()
			const persist = Reflect.get(task, "persistAssistantResponseBeforeEffects") as (
				message: ApiMessage,
				reasoning?: string,
			) => Promise<boolean>
			await expect(
				persist.call(task, { role: "assistant", content: [{ type: "text", text: "response" }] }, reasoning),
			).resolves.toBe(true)
			const persisted = task.apiConversationHistory.at(-1)
			expect(persisted).toMatchObject({ role: "assistant", id: "original-response" })
			expect(Reflect.get(task, "saveApiConversationHistory")).toHaveBeenCalledOnce()
			const text = { type: "text", text: "response" }
			if (kind === "anthropic") {
				expect(persisted!.content).toEqual([
					{ type: "thinking", thinking: "captured reasoning", signature: "original-signature" },
					text,
				])
			} else if (kind === "gemini") {
				expect(persisted!.reasoning_details).toEqual([
					{ type: "reasoning.encrypted", data: "original-details" },
				])
				expect(persisted!.content).toEqual([
					text,
					{ type: "thoughtSignature", thoughtSignature: "original-signature" },
				])
			} else if (kind === "openai-native") {
				expect(persisted!.content).toEqual([
					{
						type: "reasoning",
						summary: [],
						encrypted_content: "original-encrypted",
						id: "original-reasoning",
					},
					text,
				])
			} else if (kind === "vscode-lm") {
				expect(persisted).toMatchObject({ vscodeLmStatefulMarker: "original-stateful-marker", content: [text] })
			} else {
				expect(persisted!.content).toEqual([
					{ type: "reasoning", text: "captured reasoning", summary: [{ text: "original-summary" }] },
					text,
				])
			}
			for (const getter of Object.values(replacementMetadata)) expect(getter).not.toHaveBeenCalled()
			expect(() => capturedStep(task).getRequest()).not.toThrow()
		},
	)
})
