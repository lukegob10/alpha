import { OpenAiHandler } from "../openai"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"

const { create } = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("openai", () => {
	const constructor = vi.fn(function () {
		return { chat: { completions: { create } } }
	})
	return { default: constructor, AzureOpenAI: constructor }
})

// Codex ac558e2a32, session/turn.rs:3396: completed sampling can end a
// turn; stream_no_completed.rs requires recovery after a missing terminal.
// Chat's supported equivalent is its explicit finish_reason (OpenAI API
// streaming-events reference, retrieved 2026-11-03), never inference from EOF.
describe.each([false, true])("Chat terminal continuity streaming=%s", (streaming) => {
	beforeEach(() => create.mockReset())

	it.each([
		{
			name: "clean empty stop",
			finish: "stop",
			call: false,
			status: "completed",
			continuation: false,
			terminal: true,
		},
		{
			name: "completed tool call",
			finish: "tool_calls",
			call: true,
			status: "completed",
			continuation: true,
			terminal: true,
		},
		{
			name: "output limit",
			finish: "length",
			call: false,
			status: "incomplete",
			continuation: undefined,
			terminal: true,
		},
		{
			name: "missing finish reason",
			finish: null,
			call: false,
			status: "incomplete",
			continuation: undefined,
			terminal: !streaming,
		},
		{
			name: "stop with unfinished tool intent",
			finish: "stop",
			call: true,
			status: "incomplete",
			continuation: undefined,
			terminal: true,
		},
	])("preserves $name", async ({ finish, call, status, continuation, terminal }) => {
		const tool = {
			id: "read-call",
			type: "function",
			function: { name: "read_file", arguments: '{"path":"a.ts"}' },
		}
		create.mockResolvedValueOnce(
			streaming
				? {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [
									{
										delta: {
											content: "",
											...(call ? { tool_calls: [{ index: 0, ...tool }] } : {}),
										},
										finish_reason: finish,
									},
								],
							}
						},
					}
				: {
						choices: [
							{
								message: { content: "", ...(call ? { tool_calls: [tool] } : {}) },
								finish_reason: finish,
							},
						],
					},
		)
		const handler = new OpenAiHandler({
			openAiApiKey: "fixture",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://compatible.example/v1",
			openAiStreamingEnabled: streaming,
		})
		const accumulator = new AgentResponseAccumulator()
		for await (const chunk of handler.createMessage("Instructions", [])) {
			if (chunk.type === "outcome") expect(chunk).toMatchObject({ status, terminal })
			await accumulator.add(chunk)
		}
		const response = await accumulator.finish()
		expect(response.outcome).toMatchObject({ status })
		expect(response.outcome?.requiresContinuation).toBe(continuation)
		expect(response.text).toBe("")
		if (status === "completed" && call) {
			expect(response.toolCalls).toEqual([
				{ type: "tool_call", id: "read-call", name: "read_file", arguments: { path: "a.ts" } },
			])
		} else {
			expect(response.toolCalls).toEqual([])
		}
		expect(create).toHaveBeenCalledOnce()
	})
})
