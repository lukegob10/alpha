import { toOpenAiStrictToolSchema } from "../../../../../api/transform/openai-strict-tool-schema"
import updateTodoList from "../update_todo_list"

describe("update_todo_list native tool", () => {
	it("offers optional tracking without adding unrequested work", () => {
		const description = updateTodoList.function.description ?? ""

		expect(description).toContain("Optional tracking")
		expect(description).toContain("not a prerequisite")
		expect(description).toContain("requested coverage or a concrete dependency")
		expect(description).toContain("successful shell call")
		expect(description).not.toContain("execute_command")
		expect(description).not.toContain("Add new actionable items as they're discovered")
	})

	it("forbids the tool on simple or single-step queries", () => {
		const description = updateTodoList.function.description ?? ""

		expect(description).toContain("Do not call this tool for questions, lookups, or single-file/single-step edits")
		expect(description).toContain("Do not use plans for simple or single-step queries")
		expect(description).toContain("Never attach acceptance checks to a lookup")
		expect(description).not.toContain("Codex")
	})

	it("preserves the replacement checklist contract", () => {
		expect(updateTodoList.function.description).toContain("Always provide the full list")
		expect(updateTodoList.function.description).toContain(
			"Keep all unfinished tasks unless explicitly instructed to remove",
		)
		expect(updateTodoList.function.parameters.required).toEqual(["todos"])
		expect(updateTodoList.function.parameters.properties.work_plan.type).toEqual(["object", "null"])
		expect(updateTodoList.function.parameters.additionalProperties).toBe(false)
	})

	it("lets native calls omit work_plan while OpenAI strict conversion requires it as null", () => {
		const strict = toOpenAiStrictToolSchema(updateTodoList.function.parameters) as {
			required: string[]
			properties: { work_plan: { type: unknown } }
		}

		expect(updateTodoList.function.parameters.required).toEqual(["todos"])
		expect(strict.required).toEqual(["todos", "work_plan"])
		expect(strict.properties.work_plan.type).toEqual(["object", "null"])
	})
})
