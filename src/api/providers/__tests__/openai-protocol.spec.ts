import { OpenAiHandler } from "../openai"
import type { ApiHandlerOptions } from "../../../shared/api"
import * as modelCapabilities from "../utils/openai-model-capabilities"

const { chatCreate, responsesCreate } = vi.hoisted(() => ({ chatCreate: vi.fn(), responsesCreate: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(() => ({
		chat: { completions: { create: chatCreate } },
		responses: { create: responsesCreate },
	}))
	return { default: constructor, AzureOpenAI: constructor }
})

describe("native OpenAI protocol capabilities", () => {
	const options: ApiHandlerOptions = {
		openAiModelId: "gpt-6.1-sol",
		openAiApiKey: "test-key",
		openAiBaseUrl: "https://api.openai.com/v1",
		openAiStreamingEnabled: false,
	}
	const tools = [
		{
			type: "function" as const,
			function: { name: "read_file", parameters: { type: "object", properties: {} } },
		},
	]

	beforeEach(() => {
		vi.restoreAllMocks()
		chatCreate.mockReset().mockResolvedValue({
			choices: [{ message: { content: "Done." }, finish_reason: "stop" }],
			usage: null,
		})
		responsesCreate.mockReset().mockResolvedValue({
			id: "response-protocol",
			status: "completed",
			output: [
				{
					id: "message-protocol",
					type: "message",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Done." }],
				},
			],
			usage: null,
		})
	})

	it("selects Responses independently of the model's freeform patch capability", async () => {
		vi.spyOn(modelCapabilities, "getNativeOpenAiModelCapabilities").mockReturnValue({
			responses: true,
			freeformApplyPatch: false,
		})
		const provider = new OpenAiHandler(options)
		const patchTool = {
			type: "function" as const,
			function: {
				name: "apply_patch",
				parameters: { type: "object", properties: { patch: { type: "string" } } },
			},
		}
		const history = [
			{
				role: "assistant" as const,
				content: [
					{ type: "tool_use" as const, id: "patch-call", name: "apply_patch", input: { patch: "patch" } },
				],
			},
			{
				role: "user" as const,
				content: [{ type: "tool_result" as const, tool_use_id: "patch-call", content: "Applied" }],
			},
		]
		for await (const _chunk of provider.createMessage("system", history, {
			taskId: "protocol",
			tools: [...tools, patchTool],
			tool_choice: { type: "function", function: { name: "apply_patch" } },
		})) {
			// Consume the full response.
		}

		expect(responsesCreate).toHaveBeenCalledOnce()
		expect(chatCreate).not.toHaveBeenCalled()
		const request = responsesCreate.mock.calls[0][0]
		expect(request.tools).toEqual([
			expect.objectContaining({ type: "function", name: "read_file" }),
			expect.objectContaining({ type: "function", name: "apply_patch" }),
		])
		expect(request.tool_choice).toEqual({ type: "function", name: "apply_patch" })
		expect(request.input.slice(1)).toEqual([
			{ type: "function_call", call_id: "patch-call", name: "apply_patch", arguments: '{"patch":"patch"}' },
			{ type: "function_call_output", call_id: "patch-call", output: "Applied" },
		])
	})

	it.each([{ tools: undefined }, { tools: [] }, { tools }])(
		"uses Responses for GPT-6.1 Sol independently of captured tools ($tools)",
		async ({ tools }) => {
			const provider = new OpenAiHandler(options)
			for await (const _chunk of provider.createMessage("system", [], { taskId: "protocol", tools })) {
				// Consume the full response.
			}

			expect(responsesCreate).toHaveBeenCalledOnce()
			expect(responsesCreate.mock.calls[0]?.[0].model).toBe("gpt-6.1-sol")
			expect(responsesCreate.mock.calls[0]?.[0].tools?.length).toBe(tools?.length)
			expect(chatCreate).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ openAiModelId: "gpt-6.1-sol-preview" },
		{ openAiModelId: "gpt-6.2-sol" },
		{ openAiModelId: " gpt-6.1-sol " },
		{ openAiBaseUrl: "https://compatible.example/v1" },
		{ openAiBaseUrl: "https://api.openai.com/v1/chat/completions" },
		{ openAiUseAzure: true },
		{ openAiR1FormatEnabled: true },
	])("preserves compatibility routing for %j", async (overrides) => {
		const provider = new OpenAiHandler({ ...options, ...overrides })
		for await (const _chunk of provider.createMessage("system", [], { taskId: "protocol", tools })) {
			// Consume the full response.
		}

		expect(chatCreate).toHaveBeenCalledOnce()
		expect(responsesCreate).not.toHaveBeenCalled()
	})

	it.each([
		"http://api.openai.com/v1",
		"https://api.openai.com:8443/v1",
		"https://user:password@api.openai.com/v1",
		"https://api.openai.com/v1?compat=true",
		"https://api.openai.com/v1#compatible",
	])("keeps non-native origins on Chat Completions (%s)", async (openAiBaseUrl) => {
		const provider = new OpenAiHandler({ ...options, openAiModelId: "gpt-6-sol", openAiBaseUrl })
		for await (const _chunk of provider.createMessage("system", [], { taskId: "protocol", tools })) {
			// Consume the full response.
		}

		expect(chatCreate).toHaveBeenCalledOnce()
		expect(responsesCreate).not.toHaveBeenCalled()
	})

	it("keeps text-only completions on the supported Chat Completions endpoint", async () => {
		const provider = new OpenAiHandler(options)
		expect(await provider.completePrompt("Summarize this task")).toBe("Done.")
		expect(chatCreate).toHaveBeenCalledOnce()
		expect(responsesCreate).not.toHaveBeenCalled()
	})
})
