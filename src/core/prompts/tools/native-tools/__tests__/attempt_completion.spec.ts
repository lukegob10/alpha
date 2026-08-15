import attemptCompletion from "../attempt_completion"

describe("attempt_completion native tool", () => {
	it("uses harness evidence and one bounded final review", () => {
		expect(attemptCompletion.type).toBe("function")
		if (attemptCompletion.type !== "function") return

		const description = attemptCompletion.function.description ?? ""

		expect(description).toContain("intended outcome has been handled end to end")
		expect(description).toContain("one bounded review")
		expect(description).toContain("Optional polish is not a completion blocker")
		expect(description).toContain("separate user confirmation of each intermediate tool is not required")
		expect(description).toContain("outcome")
		expect(description).not.toContain("CANNOT be used until")
		expect(description).not.toContain("code corruption and system failure")
		expect(attemptCompletion.function.parameters.properties.outcome).toMatchObject({
			enum: ["completed", "blocked"],
		})
		expect(attemptCompletion.function.parameters.required).toEqual(["result"])
	})
})
