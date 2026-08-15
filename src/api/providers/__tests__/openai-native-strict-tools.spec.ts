import { delegate_task } from "../../../core/prompts/tools/native-tools/delegate_task"
import type { ApiHandlerOptions } from "../../../shared/api"
import { OpenAiNativeHandler } from "../openai-native"

describe("OpenAiNativeHandler strict tool schemas", () => {
	it("sends delegate_task as one valid strict task shape", async () => {
		let capturedRequestBody: any
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.6-luna",
		} as ApiHandlerOptions)
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockImplementation((body: any) => {
					capturedRequestBody = body
					return {
						[Symbol.asyncIterator]: async function* () {
							yield {
								type: "response.done",
								response: {
									output: [],
									usage: { input_tokens: 10, output_tokens: 5 },
								},
							}
						},
					}
				}),
			},
		}

		for await (const _ of handler.createMessage("system prompt", [], {
			taskId: "test-task-id",
			tools: [delegate_task],
		})) {
			// Consume the stream.
		}

		const tool = capturedRequestBody.tools[0]
		const task = tool.parameters.properties.tasks.items
		expect(tool.name).toBe("delegate_task")
		expect(tool.strict).toBe(true)
		expect(task).not.toHaveProperty("anyOf")
		expect(task.required).toEqual(["objective", "agent_kind", "write_scope", "expected_output"])
		expect(task.properties.agent_kind.enum).toEqual(["explore", "review", "worker"])
		expect(task.properties.write_scope.anyOf).toEqual([
			expect.objectContaining({ type: "array", minItems: 1, maxItems: 12 }),
			{ type: "null" },
		])
		expect(task.properties.expected_output.type).toEqual(["array", "null"])
		expect(task.additionalProperties).toBe(false)
	})
})
