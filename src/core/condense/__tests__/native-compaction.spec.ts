import type Anthropic from "@anthropic-ai/sdk"
import type { NativeCompactionCheckpoint } from "@alpha-code/types"
import type { ApiHandler, ApiNativeCompactionCapability } from "../../../api"
import { NativeCompactionUnavailableError } from "../../../api/native-compaction"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { invalidateOpaqueProviderStateReplay } from "../../task-persistence/providerStateScope"
import { invalidPersistedApiMessages } from "../../task-persistence/validatePersistedApiMessages"
import { manageContext } from "../../context-management"
import {
	getEffectiveApiHistory,
	hasToolCallResultIntegrity,
	summarizeConversation,
	type CompactionUsageObserver,
} from "../index"

vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureContextCondensed: vi.fn() } } }))

function fixture() {
	const checkpoint: NativeCompactionCheckpoint = {
		protocol: "openai-responses",
		provider: "openai-native",
		modelId: "gpt-6.1-sol",
		responseId: "compact-1",
		output: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Keep the approved requirement." }],
			},
			{ type: "compaction", id: "checkpoint-1", encrypted_content: "opaque-native-window" },
		],
	}
	const compact = vi.fn<ApiNativeCompactionCapability["compact"]>(async (_prompt, _messages, metadata) => {
		metadata?.observeUsage?.({ type: "usage", inputTokens: 1_000, outputTokens: 100, totalCost: 0.25 })
		return checkpoint
	})
	let enabled = true
	const capability: ApiNativeCompactionCapability = {
		scope: { provider: "openai-native", modelId: "gpt-6.1-sol" },
		compact,
	}
	const createMessage = vi.fn<ApiHandler["createMessage"]>(async function* () {
		yield { type: "usage", inputTokens: 100, outputTokens: 10, totalCost: 0.125 }
		yield { type: "text", text: "Local summary retains the approved requirement." }
		yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
	})
	const handler: ApiHandler = {
		get nativeCompaction() {
			return enabled ? capability : undefined
		},
		getModel: () => ({
			id: "gpt-6.1-sol",
			info: { contextWindow: 50_000, maxTokens: 512, supportsPromptCache: false },
		}),
		countTokens: vi.fn(async (content: Anthropic.Messages.ContentBlockParam[]) =>
			content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0),
		),
		createMessage,
		streamCapabilities: { lifecycle: true, cancellation: true },
	}
	const messages: ApiMessage[] = [
		{ role: "user", content: "Approved requirement: keep the configuration. ".repeat(100), ts: 1 },
		{
			role: "assistant",
			content: [{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "config.ts" } }],
			ts: 2,
		},
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "read-1", content: "Configuration evidence. ".repeat(100) }],
			ts: 3,
		},
		{ role: "assistant", content: "Completed exploration and retained the evidence. ".repeat(100), ts: 4 },
	]
	return {
		handler,
		compact,
		createMessage,
		messages,
		checkpoint,
		disable: () => {
			enabled = false
		},
		options: {
			apiHandler: handler,
			messages,
			systemPrompt: "Current instructions",
			taskId: "native-task",
			maxContextTokens: 1_500,
			recentTailTokenBudget: 0,
		},
	}
}

const semantics = (messages: ApiMessage[]) => messages.map(({ role, content }) => ({ role, content }))

describe("native compaction at the shared compactor", () => {
	it("persists a complete native window while retaining original transactions for rewind and fallback", async () => {
		const { options, compact, createMessage, messages } = fixture()
		const before = structuredClone(messages)
		const observeCost = vi.fn()
		const result = await summarizeConversation({ ...options, observeCost })
		expect(result.status).toBe("reduced")
		expect(compact).toHaveBeenCalledOnce()
		expect(createMessage).not.toHaveBeenCalled()
		expect(observeCost).toHaveBeenCalledWith(0.25)
		expect(result.summary).not.toContain("opaque-native-window")
		const reloaded: ApiMessage[] = JSON.parse(JSON.stringify(result.messages))
		expect(invalidPersistedApiMessages(reloaded)).toBeUndefined()
		expect(getEffectiveApiHistory(reloaded)).toHaveLength(1)
		const restored = getEffectiveApiHistory(reloaded, null)
		expect(semantics(restored)).toEqual(semantics(messages))
		expect(hasToolCallResultIntegrity(restored)).toBe(true)
		expect(semantics(getEffectiveApiHistory(result.messages.slice(0, -1)))).toEqual(semantics(messages))
		expect(messages).toEqual(before)
	})

	it("restores archived source on model, provider, or durable account/profile revocation", async () => {
		const { options, messages } = fixture()
		const result = await summarizeConversation(options)
		const otherModel = getEffectiveApiHistory(result.messages, {
			provider: "openai-native",
			modelId: "gpt-6-astra",
		})
		const revoked = getEffectiveApiHistory(invalidateOpaqueProviderStateReplay(result.messages))
		for (const restored of [otherModel, revoked, getEffectiveApiHistory(result.messages, null)]) {
			expect(semantics(restored)).toEqual(semantics(messages))
			expect(JSON.stringify(restored)).not.toContain("opaque-native-window")
			expect(hasToolCallResultIntegrity(restored)).toBe(true)
		}
	})

	it("uses one admitted local fallback with restored source when the native route refuses compaction", async () => {
		const { options, compact, createMessage, disable } = fixture()
		const first = await summarizeConversation(options)
		compact.mockImplementationOnce(async () => {
			disable()
			throw new NativeCompactionUnavailableError()
		})
		const beforeCompact = vi.fn(async () => {})
		const recovered = await summarizeConversation({
			...options,
			messages: first.messages,
			forceCompaction: true,
			beforeCompact,
		})
		expect(recovered.status).toBe("reduced")
		expect(createMessage).toHaveBeenCalledOnce()
		expect(beforeCompact).toHaveBeenCalledOnce()
		const request = JSON.stringify(createMessage.mock.calls[0]?.[1])
		expect(request).toContain("Approved requirement")
		expect(request).toContain("Configuration evidence")
		expect(request).not.toContain("opaque-native-window")
	})

	it.each(["malformed", "over-target", "oversized", "non-reducing"])(
		"falls back once from a %s native window and retains both request charges",
		async (failure) => {
			const { options, compact, createMessage, checkpoint } = fixture()
			compact.mockImplementationOnce(async (_prompt, _messages, metadata) => {
				metadata?.observeUsage?.({ type: "usage", inputTokens: 1_000, outputTokens: 100, totalCost: 0.25 })
				return {
					...checkpoint,
					output:
						failure === "malformed"
							? []
							: [
									{
										type: "compaction",
										encrypted_content: "x".repeat(
											failure === "oversized"
												? 8 * 1024 * 1024 + 1
												: failure === "non-reducing"
													? 30_000
													: 2_000,
										),
									},
								],
				}
			})
			const beforeCompact = vi.fn(async () => {})
			const observeCost = vi.fn()

			const result = await summarizeConversation({ ...options, beforeCompact, observeCost })

			expect(result.status).toBe("reduced")
			expect(compact).toHaveBeenCalledOnce()
			expect(createMessage).toHaveBeenCalledOnce()
			expect(beforeCompact).toHaveBeenCalledOnce()
			expect(result.cost).toBe(0.375)
			expect(observeCost.mock.calls.map(([cost]) => cost)).toEqual([0.25, 0.375])
			expect(JSON.stringify(createMessage.mock.calls[0]?.[1])).toContain("Approved requirement")
		},
	)

	it.each(["transcript", "model", "cancel"])("rejects a late native checkpoint after %s changes", async (change) => {
		const { options, compact, handler, messages, createMessage } = fixture()
		const controller = new AbortController()
		compact.mockImplementationOnce(async () => {
			if (change === "transcript") messages.push({ role: "user", content: "New external guidance" })
			if (change === "model") {
				const previous = handler.getModel()
				vi.spyOn(handler, "getModel").mockReturnValue({ ...previous, id: "gpt-6-astra" })
			}
			if (change === "cancel") controller.abort(new Error("Stop compaction"))
			return {
				protocol: "openai-responses",
				provider: "openai-native",
				modelId: "gpt-6.1-sol",
				responseId: "late",
				output: [{ type: "compaction", encrypted_content: "late-opaque" }],
			}
		})
		const pending = summarizeConversation({
			...options,
			metadata: { taskId: "native-task", signal: controller.signal },
		})
		if (change === "cancel") await expect(pending).rejects.toThrow("Stop compaction")
		else {
			const result = await pending
			expect(result.status).toBe("no_progress")
			expect(result.messages).toBe(messages)
			expect(JSON.stringify(result.messages)).not.toContain("late-opaque")
		}
		expect(createMessage).not.toHaveBeenCalled()
	})
})

describe("compaction attempt usage boundaries", () => {
	it("aggregates local token/cache deltas while retaining the latest per-request cost", async () => {
		const { options, disable, createMessage } = fixture()
		disable()
		createMessage.mockImplementationOnce(async function* () {
			yield {
				type: "usage",
				usageSource: "provider",
				inputTokens: 100,
				outputTokens: 10,
				cacheWriteTokens: 3,
				cacheReadTokens: 5,
				totalCost: 0.1,
			}
			yield {
				type: "usage",
				usageSource: "provider",
				inputTokens: 20,
				outputTokens: 4,
				cacheWriteTokens: 2,
				cacheReadTokens: 1,
				totalCost: 0.14,
			}
			yield { type: "text", text: "Complete local summary." }
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
		})
		const observeUsage = vi.fn<CompactionUsageObserver>(async () => {})

		const result = await summarizeConversation({ ...options, observeUsage, inputIncludesCache: false })

		expect(result.status).toBe("reduced")
		expect(observeUsage).toHaveBeenCalledOnce()
		expect(observeUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				inputTokens: 120,
				outputTokens: 14,
				cacheWriteTokens: 5,
				cacheReadTokens: 6,
				totalCost: 0.14,
			}),
			expect.any(String),
			false,
		)
	})

	it("settles a failed attempt before admitting its retry and uses distinct receipt identities", async () => {
		const { options, disable, createMessage } = fixture()
		disable()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "usage", inputTokens: 50, outputTokens: 2, totalCost: 0.1 }
			yield { type: "error", error: "context_length_exceeded", message: "maximum context length exceeded" }
		})
		const events: string[] = []
		const observeUsage = vi.fn<CompactionUsageObserver>(async (usage: { inputTokens: number }) => {
			events.push(`usage:${usage.inputTokens}`)
		})
		const beforeAttempt = vi.fn(async () => {
			events.push("admit")
		})

		const result = await summarizeConversation({ ...options, observeUsage, beforeAttempt })

		expect(result.status).toBe("reduced")
		expect(events).toEqual(["admit", "usage:50", "admit", "usage:100"])
		expect(observeUsage).toHaveBeenCalledTimes(2)
		expect(observeUsage.mock.calls[0]?.[1]).not.toBe(observeUsage.mock.calls[1]?.[1])
	})

	it("settles delivered usage when cancellation interrupts a local attempt", async () => {
		const { options, disable, createMessage } = fixture()
		disable()
		const controller = new AbortController()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "usage", inputTokens: 50, outputTokens: 2, totalCost: 0.1 }
			controller.abort(new Error("Stop after delivered usage"))
			yield { type: "usage", inputTokens: 999, outputTokens: 999, totalCost: 999 }
		})
		const observeUsage = vi.fn<CompactionUsageObserver>(async () => {})

		await expect(
			summarizeConversation({
				...options,
				observeUsage,
				metadata: { taskId: "task", signal: controller.signal },
			}),
		).rejects.toThrow("Stop after delivered usage")
		expect(observeUsage).toHaveBeenCalledOnce()
		expect(observeUsage).toHaveBeenCalledWith(
			expect.objectContaining({ inputTokens: 50, outputTokens: 2 }),
			expect.any(String),
			true,
		)
	})

	it("does not retry a provider when its usage receipt cannot be persisted", async () => {
		const { options, disable, createMessage } = fixture()
		disable()
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "usage", inputTokens: 50, outputTokens: 2, totalCost: 0.1 }
			yield { type: "error", error: "context_length_exceeded", message: "maximum context length exceeded" }
		})
		const failure = new Error("Unable to persist compaction usage")
		const observeUsage = vi.fn<CompactionUsageObserver>(async () => {
			throw failure
		})

		await expect(summarizeConversation({ ...options, observeUsage })).rejects.toBe(failure)
		expect(createMessage).toHaveBeenCalledOnce()
	})

	it("charges native usage before checking whether a local fallback is still admitted", async () => {
		const { options, compact, checkpoint, createMessage } = fixture()
		compact.mockImplementationOnce(async (_prompt, _messages, metadata) => {
			metadata?.observeUsage?.({ type: "usage", inputTokens: 100, outputTokens: 10, totalCost: 0.25 })
			return { ...checkpoint, output: [] }
		})
		let remainingTokens = 100
		const observeUsage = vi.fn<CompactionUsageObserver>(
			async (usage: { inputTokens: number; outputTokens: number }) => {
				remainingTokens -= usage.inputTokens + usage.outputTokens
			},
		)
		const beforeAttempt = vi.fn(async () => {
			if (remainingTokens <= 0) throw new Error("Captured goal budget exhausted")
		})

		await expect(summarizeConversation({ ...options, observeUsage, beforeAttempt })).rejects.toThrow(
			"Captured goal budget exhausted",
		)
		expect(compact).toHaveBeenCalledOnce()
		expect(createMessage).not.toHaveBeenCalled()
		expect(observeUsage).toHaveBeenCalledOnce()
		expect(beforeAttempt).toHaveBeenCalledTimes(2)
	})

	it("forwards native admission and actual usage through context management", async () => {
		const { options } = fixture()
		const observeUsage = vi.fn<CompactionUsageObserver>(async () => {})
		const beforeAttempt = vi.fn(async () => {})

		const result = await manageContext({
			...options,
			contextWindow: 50_000,
			totalTokens: 12_000,
			maxTokens: 512,
			autoCondenseContext: true,
			autoCondenseContextPercent: 10,
			observeUsage,
			beforeAttempt,
		})

		expect(result.status).toBe("reduced")
		expect(beforeAttempt).toHaveBeenCalledOnce()
		expect(observeUsage).toHaveBeenCalledWith(
			expect.objectContaining({ inputTokens: 1_000, outputTokens: 100 }),
			expect.any(String),
			true,
		)
	})
	it.each(["native", "local"])(
		"finalizes an admitted %s network failure without inventing reported zero usage",
		async (route) => {
			const { options, compact, disable, createMessage } = fixture()
			if (route === "native") compact.mockRejectedValueOnce(new Error("Connection failed before usage"))
			else {
				disable()
				createMessage.mockImplementationOnce(async function* () {
					yield* []
					throw new Error("Connection failed before usage")
				})
			}
			const observeUsage = vi.fn<CompactionUsageObserver>(async () => {})

			const result = await summarizeConversation({ ...options, observeUsage })

			expect(result.status).toBe("no_progress")
			expect(observeUsage).toHaveBeenCalledOnce()
			expect(observeUsage).toHaveBeenCalledWith(
				{ type: "usage", usageSource: "unknown", inputTokens: 0, outputTokens: 0 },
				expect.any(String),
				true,
			)
		},
	)

	it.each(["native", "local"])("finalizes an admitted %s Stop without usage", async (route) => {
		const { options, compact, disable, createMessage } = fixture()
		const controller = new AbortController()
		const reason = new Error("Stop before usage arrives")
		if (route === "native")
			compact.mockImplementationOnce(async () => {
				controller.abort(reason)
				throw reason
			})
		else {
			disable()
			createMessage.mockImplementationOnce(async function* () {
				yield* []
				controller.abort(reason)
				throw reason
			})
		}
		const observeUsage = vi.fn<CompactionUsageObserver>(async () => {})

		await expect(
			summarizeConversation({
				...options,
				observeUsage,
				metadata: { taskId: "task", signal: controller.signal },
			}),
		).rejects.toBe(reason)
		expect(observeUsage).toHaveBeenCalledOnce()
		expect(observeUsage).toHaveBeenCalledWith(
			{ type: "usage", usageSource: "unknown", inputTokens: 0, outputTokens: 0 },
			expect.any(String),
			true,
		)
	})

	it.each(["native", "local"])("does not create an attempt receipt when %s admission is denied", async (route) => {
		const { options, compact, disable, createMessage } = fixture()
		if (route === "local") disable()
		const reason = new Error("Captured goal admission denied")
		const beforeAttempt = vi.fn(async () => {
			throw reason
		})
		const observeUsage = vi.fn<CompactionUsageObserver>(async () => {})

		await expect(summarizeConversation({ ...options, observeUsage, beforeAttempt })).rejects.toBe(reason)
		expect(compact).not.toHaveBeenCalled()
		expect(createMessage).not.toHaveBeenCalled()
		expect(observeUsage).not.toHaveBeenCalled()
	})
})
