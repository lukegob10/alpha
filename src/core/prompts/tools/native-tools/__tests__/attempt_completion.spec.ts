import attemptCompletion, { createAttemptCompletionTool } from "../attempt_completion"

describe("attempt_completion native tool", () => {
	it("keeps the primary completion contract focused on the user result", () => {
		expect(attemptCompletion.type).toBe("function")
		if (attemptCompletion.type !== "function") return

		const description = attemptCompletion.function.description ?? ""

		expect(description).toContain("intended outcome has been handled end to end")
		expect(description).toContain("one bounded review")
		expect(description).toContain("Optional polish is not a completion blocker")
		expect(description).toContain("separate user confirmation of each intermediate tool is not required")
		expect(description).toContain("latest tool result establishes the explicit requested outcome")
		expect(description).toContain("call this tool next")
		expect(description).toContain("Do not explore, configure, or improve adjacent state")
		expect(description).toContain("This does not mark the task completed")
		expect(description).not.toContain("CANNOT be used until")
		expect(description).not.toContain("code corruption and system failure")
		expect(attemptCompletion.function.parameters.properties.outcome).toMatchObject({
			enum: ["completed", "blocked"],
		})
		expect(attemptCompletion.function.parameters.required).toEqual(["result"])
	})

	it("retains managed-child outcome reporting in the sub-agent contract", () => {
		const subagentCompletion = createAttemptCompletionTool("subagent")

		expect(subagentCompletion.function.description).toContain("outcome")
		expect(subagentCompletion.function.parameters.properties.outcome).toMatchObject({
			enum: ["completed", "blocked"],
		})
		expect(subagentCompletion.function.parameters.required).toEqual(["result"])
	})
})
