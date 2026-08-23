import { delegate_task } from "../../../core/prompts/tools/native-tools/delegate_task"
import { createAttemptCompletionTool } from "../../../core/prompts/tools/native-tools/attempt_completion"
import { toOpenAiStrictToolSchema } from "../openai-strict-tool-schema"

describe("toOpenAiStrictToolSchema", () => {
	it("marks every object property required while preserving optionality with null", () => {
		const input = {
			type: "object",
			properties: {
				query: { type: "string" },
				path: { type: "string" },
				options: {
					type: "object",
					properties: {
						limit: { type: "number" },
						labels: { type: "array", items: { type: "string" } },
					},
					required: ["limit"],
				},
			},
			required: ["query"],
		}

		const strict = toOpenAiStrictToolSchema(input) as any

		expect(strict).toMatchObject({ additionalProperties: false, required: ["query", "path", "options"] })
		expect(strict.properties.query.type).toBe("string")
		expect(strict.properties.path.type).toEqual(["string", "null"])
		expect(strict.properties.options.type).toEqual(["object", "null"])
		expect(strict.properties.options).toMatchObject({
			additionalProperties: false,
			required: ["limit", "labels"],
		})
		expect(strict.properties.options.properties.limit.type).toBe("number")
		expect(strict.properties.options.properties.labels.type).toEqual(["array", "null"])
		expect(input).toEqual({
			type: "object",
			properties: {
				query: { type: "string" },
				path: { type: "string" },
				options: {
					type: "object",
					properties: {
						limit: { type: "number" },
						labels: { type: "array", items: { type: "string" } },
					},
					required: ["limit"],
				},
			},
			required: ["query"],
		})
	})

	it("makes the flat delegate_task shape strict without competing role branches", () => {
		const strict = toOpenAiStrictToolSchema(delegate_task.function.parameters) as any
		const task = strict.properties.tasks.items

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

	it("makes the optional attempt_completion outcome nullable for strict providers", () => {
		const subagentCompletion = createAttemptCompletionTool("subagent")
		const strict = toOpenAiStrictToolSchema(subagentCompletion.function.parameters) as any

		expect(strict.required).toEqual(["result", "outcome"])
		expect(strict.properties.outcome).toMatchObject({
			type: ["string", "null"],
			enum: ["completed", "blocked", null],
		})
	})
})
