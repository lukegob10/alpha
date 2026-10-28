import type { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { OpenRouterHandler } from "../openrouter"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiStream, ApiStreamChunk } from "../../transform/stream"

const { create, responsesCreate } = vi.hoisted(() => ({ create: vi.fn(), responsesCreate: vi.fn() }))

const reasoningFamilyModelIds = ["moonshotai/kimi-k3.1-pro"] as const
const modelDefaults = [
	["openai/gpt-6-astra", "medium"],
	["openai/gpt-6.1-sol", "medium"],
	["anthropic/claude-opus-5.5", "high"],
	["anthropic/claude-sonnet-5.5", "high"],
	["anthropic/claude-fable-5.1", "high"],
	["google/gemini-4-argon", "medium"],
	["x-ai/grok-4.7", "high"],
	["meta/muse-wonder", "high"],
	["moonshotai/kimi-k3.1-pro", "max"],
] as const
const retiredModelIds = [
	"openai/gpt-6-luna",
	"openai/gpt-5.6-sol",
	"openai/gpt-5.6-terra",
	"openai/gpt-5.6-luna",
	"anthropic/claude-haiku-5.5",
	"x-ai/grok-4.6",
	"google/gemini-3.8-flash",
	"moonshotai/kimi-k3",
	"z-ai/glm-5.3",
	"z-ai/glm-5.3-flash",
] as const

vi.mock("openai", () => {
	const constructor = vi.fn(function () {
		return { chat: { completions: { create } }, responses: { create: responsesCreate } }
	})
	return { default: constructor, AzureOpenAI: constructor }
})

const usage = {
	prompt_tokens: 120,
	completion_tokens: 30,
	prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 },
	completion_tokens_details: { reasoning_tokens: 10 },
	cost: 0.002,
}

function textResponse() {
	return { choices: [{ message: { content: "Done." }, finish_reason: "stop" }], usage }
}

async function collect(stream: ApiStream): Promise<ApiStreamChunk[]> {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

function makeHandler(options: ApiHandlerOptions = {}): OpenRouterHandler {
	return new OpenRouterHandler({ openRouterApiKey: "router-key", ...options })
}

describe("curated OpenRouter provider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		create.mockReset().mockImplementation(async (request) =>
			request.stream
				? (async function* () {
						yield { choices: [{ delta: { content: "Done." }, finish_reason: "stop" }], usage }
					})()
				: textResponse(),
		)
		responsesCreate.mockReset()
	})

	it("isolates credentials, endpoint and transport settings from other provider fields", async () => {
		const provider = makeHandler({
			openAiApiKey: "other-key",
			openAiBaseUrl: "https://untrusted.example/v1",
			openAiHeaders: { Authorization: "untrusted", "X-Custom": "foreign" },
			openAiUseAzure: true,
			openAiR1FormatEnabled: true,
			openAiModelId: "other-model",
			taskReasoningCustomEffort: "foreign-effort",
		})
		expect(vi.mocked(OpenAI)).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://openrouter.ai/api/v1", apiKey: "router-key" }),
		)
		const configuration = vi.mocked(OpenAI).mock.calls[0][0]
		expect(configuration?.defaultHeaders).not.toHaveProperty("Authorization")
		expect(configuration?.defaultHeaders).not.toHaveProperty("X-Custom")
		await collect(provider.createMessage("instructions", [], { taskId: "isolation" }))
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ model: "openai/gpt-6.1-sol", reasoning: { effort: "medium" } }),
			expect.any(Object),
		)
		expect(responsesCreate).not.toHaveBeenCalled()
	})

	it.each(modelDefaults)("uses verified reasoning defaults for %s", async (apiModelId, effort) => {
		const provider = makeHandler({ apiModelId })
		await collect(provider.createMessage("instructions", [], { taskId: "default" }))
		const request = create.mock.calls[0][0]
		expect(request).toMatchObject({
			model: apiModelId,
			reasoning: { effort },
			provider: { require_parameters: true },
		})
		expect(request).not.toHaveProperty("reasoning_effort")
		expect(request).not.toHaveProperty("parallel_tool_calls")
	})

	it.each(retiredModelIds)(
		"rejects retired model %s before SDK admission even with saved Off settings",
		(apiModelId) => {
			for (const settings of [
				{ enableReasoningEffort: false, reasoningEffort: "max" as const },
				{ reasoningEffort: "disable" as const },
				{ reasoningEffort: "none" as const },
			]) {
				expect(() => makeHandler({ apiModelId, ...settings })).toThrow("Unsupported OpenRouter model")
			}
			expect(OpenAI).not.toHaveBeenCalled()
			expect(create).not.toHaveBeenCalled()
			expect(responsesCreate).not.toHaveBeenCalled()
		},
	)

	it.each(modelDefaults)(
		"keeps required reasoning active for %s when a saved Off setting is carried over",
		async (apiModelId, effort) => {
			await collect(
				makeHandler({ apiModelId, enableReasoningEffort: false, reasoningEffort: "none" }).createMessage(
					"instructions",
					[],
					{ taskId: "mandatory-reasoning" },
				),
			)
			expect(create.mock.calls[0][0]).toHaveProperty("reasoning", { effort })
			await makeHandler({ apiModelId, enableReasoningEffort: false, reasoningEffort: "none" }).completePrompt(
				"Improve this prompt",
			)
			expect(create.mock.lastCall?.[0]).toHaveProperty("reasoning", { effort })
		},
	)

	it.each(reasoningFamilyModelIds)(
		"uses %s's required Max default in task and auxiliary requests",
		async (apiModelId) => {
			for (const settings of [
				{},
				{ enableReasoningEffort: false, reasoningEffort: "none" as const },
				{ reasoningEffort: "medium" as const },
			]) {
				for (const openRouterStreamingEnabled of [true, false]) {
					await collect(
						makeHandler({ apiModelId, ...settings, openRouterStreamingEnabled }).createMessage(
							"instructions",
							[],
							{ taskId: "required-model-reasoning" },
						),
					)
					expect(create.mock.lastCall?.[0]).toMatchObject({
						model: apiModelId,
						reasoning: { effort: "max" },
						provider: { require_parameters: true },
					})
				}
				await makeHandler({ apiModelId, ...settings }).completePrompt("Improve this prompt")
				expect(create.mock.lastCall?.[0]).toHaveProperty("reasoning", { effort: "max" })
			}
		},
	)

	it.each(reasoningFamilyModelIds)(
		"forwards only verified effort levels for %s on every request path",
		async (apiModelId) => {
			for (const reasoningEffort of ["low", "high", "max", "medium", "xhigh"] as const) {
				const effort = reasoningEffort === "medium" || reasoningEffort === "xhigh" ? "max" : reasoningEffort
				for (const openRouterStreamingEnabled of [true, false]) {
					await collect(
						makeHandler({ apiModelId, reasoningEffort, openRouterStreamingEnabled }).createMessage(
							"instructions",
							[],
							{ taskId: "model-reasoning-level" },
						),
					)
					expect(create.mock.lastCall?.[0]).toMatchObject({
						model: apiModelId,
						reasoning: { effort },
						provider: { require_parameters: true },
					})
					expect(create.mock.lastCall?.[0]).not.toHaveProperty("reasoning_effort")
				}
				await makeHandler({ apiModelId, reasoningEffort }).completePrompt("Improve this prompt")
				expect(create.mock.lastCall?.[0]).toMatchObject({ model: apiModelId, reasoning: { effort } })
			}
		},
	)

	it.each(modelDefaults.map(([modelId]) => modelId))(
		"encodes explicit output limits using the router parameter accepted by %s",
		async (apiModelId) => {
			await collect(
				makeHandler({ apiModelId, includeMaxTokens: true, modelMaxTokens: 4096 }).createMessage(
					"instructions",
					[],
					{
						taskId: "output-limit",
					},
				),
			)
			expect(create.mock.calls[0][0]).toHaveProperty("max_tokens", 4096)
			expect(create.mock.calls[0][0]).not.toHaveProperty("max_completion_tokens")
		},
	)

	it.each([true, false])("maps task-only effort to the router API (stream=%s)", async (streaming) => {
		const provider = makeHandler({ reasoningEffort: "max", openRouterStreamingEnabled: streaming })
		const chunks = await collect(provider.createMessage("instructions", [], { taskId: "selected-effort" }))
		expect(create.mock.calls[0][0]).toMatchObject({ reasoning: { effort: "max" } })
		expect(Boolean(create.mock.calls[0][0].stream)).toBe(streaming)
		expect(chunks.filter((chunk) => chunk.type === "outcome")).toEqual([
			expect.objectContaining({ status: "completed" }),
		])
	})

	it.each([
		{ reasoningEffort: "max" as const },
		{ reasoningEffort: "none" as const },
		{ enableReasoningEffort: false },
	])("resolves unsupported or disabled reasoning to the required model default (%j)", async (options) => {
		await collect(
			makeHandler({ apiModelId: "google/gemini-4-argon", ...options }).createMessage("instructions", [], {
				taskId: "required-reasoning",
			}),
		)
		expect(create.mock.calls[0][0]).toHaveProperty("reasoning", { effort: "medium" })
	})

	it("preserves the legacy model field only when the canonical model field is absent", () => {
		expect(makeHandler({ openRouterModelId: "google/gemini-4-argon" }).getModel().id).toBe("google/gemini-4-argon")
		expect(
			makeHandler({ apiModelId: "openai/gpt-6.1-sol", openRouterModelId: "google/gemini-4-argon" }).getModel().id,
		).toBe("openai/gpt-6.1-sol")
		expect(() => makeHandler({ apiModelId: "", openRouterModelId: "google/gemini-4-argon" })).toThrow(
			"Unsupported OpenRouter model",
		)
	})

	it.each(retiredModelIds)("rejects retired legacy model field %s without remapping it", (openRouterModelId) => {
		expect(() => makeHandler({ openRouterModelId })).toThrow("Unsupported OpenRouter model")
		expect(OpenAI).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
		expect(responsesCreate).not.toHaveBeenCalled()
		expect(makeHandler({ apiModelId: "openai/gpt-6.1-sol", openRouterModelId }).getModel().id).toBe(
			"openai/gpt-6.1-sol",
		)
	})

	it.each([
		{ openRouterApiKey: "" },
		{ apiModelId: "openrouter/auto" },
		{ apiModelId: "toString" },
		{ apiModelId: "openai/gpt-5.6-codex" },
		{ apiModelId: "xai/grok-4.7" },
		{ apiModelId: "anthropic/claude-haiku-5-5" },
		{ openRouterBaseUrl: "https://untrusted.example/api/v1" },
		{ openRouterSpecificProvider: "unexpected-provider" },
	])("rejects unsupported model, credentials or routing without a request (%j)", (options) => {
		expect(() => makeHandler(options)).toThrow()
		expect(create).not.toHaveBeenCalled()
		expect(responsesCreate).not.toHaveBeenCalled()
	})

	it("forwards only the selected model's sampling and verbosity controls", async () => {
		await collect(
			makeHandler({ modelTemperature: 0.7, verbosity: "low" }).createMessage("instructions", [], {
				taskId: "openai",
			}),
		)
		expect(create.mock.calls[0][0]).not.toHaveProperty("temperature")
		expect(create.mock.calls[0][0]).toHaveProperty("verbosity", "low")
		await collect(
			makeHandler({
				apiModelId: "google/gemini-4-argon",
				modelTemperature: 0.7,
				verbosity: "high",
			}).createMessage("instructions", [], { taskId: "gemini" }),
		)
		expect(create.mock.calls[1][0]).toHaveProperty("temperature", 0.7)
		expect(create.mock.calls[1][0]).not.toHaveProperty("verbosity")
	})

	it.each(reasoningFamilyModelIds)(
		"respects %s sampling capabilities on task and auxiliary requests",
		async (apiModelId) => {
			const provider = makeHandler({ apiModelId, modelTemperature: 0.7, verbosity: "high" })
			await collect(provider.createMessage("instructions", [], { taskId: "model-sampling" }))
			await provider.completePrompt("Improve this prompt")
			for (const [request] of create.mock.calls) {
				expect(request).not.toHaveProperty("temperature")
				expect(request).not.toHaveProperty("verbosity")
			}
		},
	)

	it("accounts for cache writes and reasoning without counting reasoning twice", async () => {
		const chunks = await collect(makeHandler().createMessage("instructions", [], { taskId: "usage" }))
		expect(chunks.find((chunk) => chunk.type === "usage")).toMatchObject({
			inputTokens: 120,
			outputTokens: 30,
			cacheReadTokens: 100,
			cacheWriteTokens: 20,
			reasoningTokens: 10,
			totalCost: 0.002,
		})
	})

	it.each(
		["openai/gpt-6.1-sol", ...reasoningFamilyModelIds].flatMap((apiModelId) =>
			[true, false].map((streaming) => ({ apiModelId, streaming })),
		),
	)(
		"keeps reasoning details intact through a tool continuation ($apiModelId, stream=$streaming)",
		async ({ apiModelId, streaming }) => {
			const details = [
				{
					type: "reasoning.summary",
					summary: "Read the file",
					id: "rs-1",
					format: "openai-responses-v1",
					index: 0,
				},
				{ type: "reasoning.encrypted", data: "opaque", id: "rs-2", format: "openai-responses-v1", index: 1 },
			]
			const call = {
				id: "call-1",
				type: "function",
				function: { name: "read_file", arguments: '{"path":"a.ts"}' },
			}
			create.mockImplementationOnce(async () =>
				streaming
					? (async function* () {
							yield { choices: [{ delta: { reasoning_details: [details[0]] } }] }
							yield {
								choices: [
									{
										delta: { reasoning_details: [details[1]], tool_calls: [{ ...call, index: 0 }] },
										finish_reason: "tool_calls",
									},
								],
							}
						})()
					: {
							choices: [
								{
									message: { content: null, reasoning_details: details, tool_calls: [call] },
									finish_reason: "tool_calls",
								},
							],
						},
			)
			const provider = makeHandler({ apiModelId, openRouterStreamingEnabled: streaming })
			const chunks = await collect(provider.createMessage("instructions", [], { taskId: "tool" }))
			expect(chunks.filter((chunk) => chunk.type === "reasoning")).toEqual([
				{ type: "reasoning", text: "Read the file" },
			])
			expect(JSON.stringify(chunks.filter((chunk) => chunk.type === "reasoning"))).not.toContain("opaque")
			expect(provider.getReasoningDetails()).toEqual(details)
			const history: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } }],
					reasoning_details: provider.getReasoningDetails(),
				} as Anthropic.Messages.MessageParam,
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "contents" }] },
			]
			// A new adapter models task reload; provider-local state is not needed to replay.
			await collect(
				makeHandler({ apiModelId, openRouterStreamingEnabled: streaming }).createMessage(
					"instructions",
					history,
					{
						taskId: "reloaded",
					},
				),
			)
			expect(create.mock.calls[1][0].messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: "assistant", reasoning_details: details, tool_calls: [call] }),
					expect.objectContaining({ role: "tool", tool_call_id: "call-1", content: "contents" }),
				]),
			)
		},
	)

	it("does not duplicate visible reasoning when both router fields are returned", async () => {
		create.mockImplementationOnce(async () =>
			(async function* () {
				yield {
					choices: [
						{
							delta: {
								reasoning: "Read it",
								reasoning_details: [{ type: "reasoning.text", text: "Read it", index: 0 }],
							},
						},
					],
				}
				yield { choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }
			})(),
		)
		const chunks = await collect(makeHandler().createMessage("instructions", [], { taskId: "reasoning" }))
		expect(chunks.filter((chunk) => chunk.type === "reasoning")).toEqual([{ type: "reasoning", text: "Read it" }])
	})

	it("reports output exhaustion as incomplete", async () => {
		create.mockImplementationOnce(async () =>
			(async function* () {
				yield { choices: [{ delta: { reasoning: "Thinking" }, finish_reason: "length" }], usage }
			})(),
		)
		const chunks = await collect(makeHandler().createMessage("instructions", [], { taskId: "exhausted" }))
		expect(chunks.find((chunk) => chunk.type === "outcome")).toMatchObject({ status: "incomplete" })
	})

	it("preserves actionable transport errors", async () => {
		create.mockRejectedValueOnce(
			Object.assign(new Error("Rate limited"), { status: 429, headers: new Headers({ "retry-after": "30" }) }),
		)
		await expect(
			collect(makeHandler().createMessage("instructions", [], { taskId: "rate-limit" })),
		).rejects.toMatchObject({
			status: 429,
			retryAfterMs: 30_000,
		})
	})

	it("cancels an unfinished request and forwards its signal", async () => {
		let requestStarted!: () => void
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve
		})
		create.mockImplementationOnce(() => {
			requestStarted()
			return new Promise<never>(() => {})
		})
		const controller = new AbortController()
		const pending = collect(
			makeHandler().createMessage("instructions", [], { taskId: "cancelled", signal: controller.signal }),
		)
		await started
		controller.abort()
		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		expect(create.mock.calls[0][1].signal.aborted).toBe(true)
	})

	it.each([false, true])(
		"retains only sealed reasoning if cancellation interrupts the stream (sealed=%s)",
		async (sealed) => {
			const details = [
				{
					type: "reasoning.encrypted",
					data: "signed-state",
					id: "rs-1",
					format: "openai-responses-v1",
					index: 0,
				},
			]
			let reachedBarrier!: () => void
			let releaseStream!: () => void
			const reached = new Promise<void>((resolve) => {
				reachedBarrier = resolve
			})
			const released = new Promise<void>((resolve) => {
				releaseStream = resolve
			})
			create.mockImplementationOnce(async () =>
				(async function* () {
					yield {
						choices: [
							{
								delta: {
									reasoning_details: details,
									tool_calls: [
										{
											index: 0,
											id: "call-1",
											function: { name: "read_file", arguments: '{"path":"a.ts"}' },
										},
									],
								},
								finish_reason: sealed ? "tool_calls" : null,
							},
						],
					}
					reachedBarrier()
					await released
				})(),
			)
			const provider = makeHandler()
			const controller = new AbortController()
			const pending = collect(
				provider.createMessage("instructions", [], { taskId: "cancel-state", signal: controller.signal }),
			)
			await reached
			controller.abort()
			try {
				await expect(pending).rejects.toMatchObject({ name: "AbortError" })
				expect(provider.getReasoningDetails()).toEqual(sealed ? details : undefined)
			} finally {
				releaseStream()
			}
		},
	)

	it("returns defensive snapshots of sealed reasoning and clears them for the next request", async () => {
		const details = [{ type: "reasoning.encrypted", data: "signed-state", format: "openai-responses-v1", index: 0 }]
		create.mockImplementationOnce(async () =>
			(async function* () {
				yield { choices: [{ delta: { reasoning_details: details, content: "Done." }, finish_reason: "stop" }] }
			})(),
		)
		const provider = makeHandler()
		await collect(provider.createMessage("instructions", [], { taskId: "snapshot" }))
		const snapshot = provider.getReasoningDetails()
		expect(snapshot).toEqual(details)
		expect(snapshot).not.toBe(details)
		Object.assign(snapshot?.[0] ?? {}, { data: "changed" })
		expect(provider.getReasoningDetails()).toEqual([{ ...details[0], data: "signed-state" }])
		await collect(provider.createMessage("instructions", [], { taskId: "next-request" }))
		expect(provider.getReasoningDetails()).toBeUndefined()
	})

	it("uses the router reasoning contract for auxiliary completions", async () => {
		await expect(
			makeHandler({ reasoningEffort: "high", verbosity: "low" }).completePrompt("Improve this prompt"),
		).resolves.toBe("Done.")
		expect(create.mock.calls[0][0]).toMatchObject({
			model: "openai/gpt-6.1-sol",
			reasoning: { effort: "high" },
			provider: { require_parameters: true },
			verbosity: "low",
		})
		expect(create.mock.calls[0][0]).not.toHaveProperty("reasoning_effort")
		expect(responsesCreate).not.toHaveBeenCalled()
	})

	it.each(["length", "content_filter", "tool_calls", undefined])(
		"rejects an unfinished auxiliary completion (%s)",
		async (finish_reason) => {
			create.mockResolvedValueOnce({ choices: [{ message: { content: "partial" }, finish_reason }] })
			await expect(makeHandler().completePrompt("Improve this prompt")).rejects.toThrow("complete text response")
		},
	)
})
