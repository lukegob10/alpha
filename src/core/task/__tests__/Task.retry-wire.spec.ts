import type { ModelInfo, ProviderSettings } from "@alpha-code/types"

import type { ApiHandler } from "../../../api"
import type { ApiStream } from "../../../api/transform/stream"
import { AgentStepContextBuilder, type AgentStepSnapshot } from "../../agent/AgentStepContextBuilder"
import { AgentRetryPolicy } from "../../agent/AgentRetryPolicy"
import type { AgentTurnOutcome } from "../../agent/AgentTurnEngine"
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
		execute: async () => {},
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
	return { task, live, originalHandler, getSystemPrompt }
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
