import { AnthropicHandler } from "../anthropic"

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
	const original = await importOriginal<typeof import("@anthropic-ai/sdk")>()
	return {
		...original,
		Anthropic: class extends original.Anthropic {
			constructor(options: ConstructorParameters<typeof original.Anthropic>[0]) {
				super({ ...options, fetch: mockFetch })
			}
		},
	}
})

describe("Claude frontier wire compatibility", () => {
	it("serializes adaptive thinking, effort, and Fable binding controls through the installed SDK", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "claude-fable-5-1",
					content: [{ type: "text", text: "Done" }],
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		)
		const handler = new AnthropicHandler({
			apiKey: "test-api-key",
			apiModelId: "claude-fable-5-1",
			reasoningEffort: "max",
		})

		expect(await handler.completePrompt("Hello")).toBe("Done")
		const [url, request] = mockFetch.mock.calls[0]
		expect(url).toBe("https://api.anthropic.com/v1/messages")
		expect(JSON.parse(request.body)).toMatchObject({
			model: "claude-fable-5-1",
			output_config: { effort: "max" },
			thinking: {
				type: "adaptive",
				display: "summarized",
				block_binding: { prefix_mismatch_behavior: "drop_block" },
			},
		})
		expect(JSON.parse(request.body)).not.toHaveProperty("temperature")
		expect(request.headers["anthropic-beta"]).toContain("thinking-binding-controls-2026-08-01")
	})
})
