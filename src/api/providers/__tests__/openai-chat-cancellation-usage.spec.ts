import type { ApiStreamChunk } from "../../transform/stream"
import { OpenAiHandler } from "../openai"
import { OpenRouterHandler } from "../openrouter"
import { StellarHandler } from "../stellar"

const { chatCreate } = vi.hoisted(() => ({ chatCreate: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(function () {
		return { chat: { completions: { create: chatCreate } } }
	})
	return { default: constructor, AzureOpenAI: constructor }
})
vi.mock("../utils/helix-token-manager", () => ({
	HelixTokenManager: {
		getOrCreate: () => ({ getToken: async () => "fixture-token" }),
	},
}))
vi.mock("../utils/vertex-gateway-transport", () => ({
	configurePemCaTransport: vi.fn().mockResolvedValue("fixture.pem"),
}))

const routes = [
	{
		name: "compatible Chat",
		create: (streaming = true) =>
			new OpenAiHandler({ openAiModelId: "gpt-4.1", openAiStreamingEnabled: streaming }),
	},
	{
		name: "reasoning-family Chat",
		create: (streaming = true) => new OpenAiHandler({ openAiModelId: "o3", openAiStreamingEnabled: streaming }),
	},
	{
		name: "OpenRouter",
		create: (streaming = true) =>
			new OpenRouterHandler({ openRouterApiKey: "fixture-key", openRouterStreamingEnabled: streaming }),
	},
	{
		name: "Stellar",
		wrapsErrors: true,
		create: (streaming = true) =>
			new StellarHandler({
				stellarBaseUrl: "https://gateway.example.test/v1",
				stellarPemCaBundlePath: "fixture.pem",
				stellarStreamingEnabled: streaming,
			}),
	},
]

const usage = {
	prompt_tokens: 17,
	completion_tokens: 5,
	prompt_tokens_details: { cached_tokens: 3 },
	completion_tokens_details: { reasoning_tokens: 2 },
}
const expectedUsage = {
	type: "usage",
	inputTokens: 17,
	outputTokens: 5,
	cacheReadTokens: 3,
	reasoningTokens: 2,
}
const toolCall = {
	id: "fixture-call",
	type: "function",
	function: { name: "read_file", arguments: '{"path":"main.ts"}' },
}

function stream(...chunks: unknown[]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk
		},
	}
}

async function cancelOn(
	handler: OpenAiHandler,
	shouldCancel: (chunk: ApiStreamChunk) => boolean,
	wrapsErrors = false,
): Promise<ApiStreamChunk[]> {
	const controller = new AbortController()
	const reason = Object.assign(new Error("fixture caller stopped"), { name: "AbortError" })
	const chunks: ApiStreamChunk[] = []
	const consume = async () => {
		for await (const chunk of handler.createMessage("System", [], {
			taskId: "usage-cancellation-fixture",
			signal: controller.signal,
		})) {
			chunks.push(chunk)
			if (shouldCancel(chunk)) controller.abort(reason)
		}
	}

	if (wrapsErrors) {
		await expect(consume()).rejects.toMatchObject({ name: "AbortError" })
	} else {
		await expect(consume()).rejects.toBe(reason)
	}
	expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([expect.objectContaining(expectedUsage)])
	expect(chunks.some((chunk) => chunk.type === "outcome" && chunk.status === "completed")).toBe(false)
	expect(chatCreate).toHaveBeenCalledOnce()
	return chunks
}

describe.each(routes)("$name cancellation usage", ({ create, wrapsErrors }) => {
	beforeEach(() => chatCreate.mockReset())

	it.each([false, true])(
		"retains received usage when text delivery triggers cancellation (same chunk=%s)",
		async (sameChunk) => {
			chatCreate.mockResolvedValueOnce(
				stream(
					{ choices: [{ delta: { content: "First" } }], ...(!sameChunk ? { usage } : {}) },
					{
						choices: [{ delta: { content: "Second" }, finish_reason: "stop" }],
						...(sameChunk ? { usage } : {}),
					},
				),
			)

			await cancelOn(create(), (chunk) => chunk.type === "text" && chunk.text === "Second", wrapsErrors)
		},
	)

	it.each([false, true])(
		"retains usage when an accepted tool triggers cancellation (streaming=%s)",
		async (streaming) => {
			chatCreate.mockResolvedValueOnce(
				streaming
					? stream({
							choices: [
								{ delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: "tool_calls" },
							],
							usage,
						})
					: { choices: [{ message: { tool_calls: [toolCall] }, finish_reason: "tool_calls" }], usage },
			)

			await cancelOn(create(streaming), (chunk) => chunk.type === "tool_call_end", wrapsErrors)
		},
	)

	it.each([false, true])(
		"does not duplicate usage when cancellation follows its delivery (streaming=%s)",
		async (streaming) => {
			chatCreate.mockResolvedValueOnce(
				streaming
					? stream({ choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }], usage })
					: { choices: [{ message: { content: "Answer" }, finish_reason: "stop" }], usage },
			)

			await cancelOn(create(streaming), (chunk) => chunk.type === "usage", wrapsErrors)
		},
	)

	it("does not emit pending usage after the consumer closes the generator", async () => {
		chatCreate.mockResolvedValueOnce(
			stream({ choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }], usage }),
		)
		const response = create().createMessage("System", [])

		await expect(response.next()).resolves.toMatchObject({ done: false, value: { type: "text", text: "Answer" } })
		await expect(response.return(undefined)).resolves.toEqual({ done: true, value: undefined })
		await expect(response.next()).resolves.toEqual({ done: true, value: undefined })
	})
})
