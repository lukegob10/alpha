import type { Anthropic } from "@anthropic-ai/sdk"
import { OpenAiHandler } from "../openai"
import { getNativeTools } from "../../../core/prompts/tools/native-tools"

const mockCreate = vi.fn()

vi.mock("openai", () => ({
	default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
}))

describe("OpenAI compatible reasoning details transport", () => {
	const tool = getNativeTools().find(
		(candidate) => "function" in candidate && candidate.function.name === "exec_command",
	)!
	const detail = { type: "reasoning.encrypted", data: "opaque-provider-state", format: "xai-responses-v1" }

	beforeEach(() => mockCreate.mockReset())

	it.each([false, true])("replays response state and the matching tool result (streaming=%s)", async (streaming) => {
		mockCreate.mockImplementationOnce(async () =>
			streaming
				? {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [
									{
										delta: {
											reasoning_details: [detail],
											tool_calls: [
												{
													index: 0,
													id: "call-1",
													function: {
														name: "exec_command",
														arguments: '{"cmd":"Get-Content a.ts"}',
													},
												},
											],
										},
										finish_reason: "tool_calls",
									},
								],
							}
						},
					}
				: {
						choices: [
							{
								message: {
									content: null,
									reasoning_details: [detail],
									tool_calls: [
										{
											type: "function",
											id: "call-1",
											function: { name: "exec_command", arguments: '{"cmd":"Get-Content a.ts"}' },
										},
									],
								},
							},
						],
					},
		)
		const handler = new OpenAiHandler({ openAiModelId: "gpt-4", openAiStreamingEnabled: streaming })
		const firstChunks = []
		for await (const chunk of handler.createMessage(
			"assembled instructions",
			[{ role: "user", content: "Read a.ts" }],
			{ taskId: "first", tools: [tool] },
		)) {
			firstChunks.push(chunk)
		}
		expect(firstChunks.some((chunk) => chunk.type === "tool_call" || chunk.type === "tool_call_partial")).toBe(true)
		expect(handler.getReasoningDetails()).toEqual([detail])

		const history: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-1", name: "exec_command", input: { cmd: "Get-Content a.ts" } }],
				reasoning_details: handler.getReasoningDetails(),
			} as Anthropic.Messages.MessageParam,
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents" }] },
		]
		mockCreate.mockImplementationOnce(async () =>
			streaming
				? {
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: { content: "done" } }] }
						},
					}
				: { choices: [{ message: { content: "done" } }] },
		)
		for await (const _chunk of handler.createMessage("assembled instructions", history, {
			taskId: "second",
			tools: [tool],
		})) {
			// Consume the request to capture the transport body.
		}
		const request = mockCreate.mock.calls[1][0]
		expect(request.messages[0]).toMatchObject({ role: "system", content: "assembled instructions" })
		expect(request.messages[1]).toMatchObject({
			role: "assistant",
			reasoning_details: [detail],
			tool_calls: [{ id: "call-1" }],
		})
		expect(request.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call-1", content: "file contents" })
		expect(request.tools).toEqual([
			expect.objectContaining({ function: expect.objectContaining({ name: "exec_command" }) }),
		])
		expect(handler.getReasoningDetails()).toBeUndefined()
	})
})
