import updateTodoList from "../update_todo_list"

describe("update_todo_list native tool", () => {
	it("offers optional tracking without adding unrequested work", () => {
		const description = updateTodoList.function.description ?? ""

		expect(description).toContain("Optional tracking")
		expect(description).toContain("not a prerequisite")
		expect(description).toContain("requested coverage or a concrete dependency")
		expect(description).not.toContain("Add new actionable items as they're discovered")
	})

	it("preserves the replacement checklist contract", () => {
		expect(updateTodoList.function.description).toContain("Always provide the full list")
		expect(updateTodoList.function.description).toContain(
			"Keep all unfinished tasks unless explicitly instructed to remove",
		)
		expect(updateTodoList.function.parameters.required).toEqual(["todos"])
		expect(updateTodoList.function.parameters.additionalProperties).toBe(false)
	})
})
