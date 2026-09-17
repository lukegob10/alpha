import { createRunSchema } from "../schemas"

describe("evaluation execution method", () => {
	const request = {
		model: "test-model",
		suite: "full",
		concurrency: 1,
		timeout: 5,
		iterations: 1,
	}

	it("accepts the existing VS Code run contract", () => {
		expect(createRunSchema.parse({ ...request, executionMethod: "vscode" }).executionMethod).toBe("vscode")
	})

	it.each(["cli", "unknown"])("rejects %s execution for new runs", (executionMethod) => {
		const result = createRunSchema.safeParse({ ...request, executionMethod })
		expect(result.success).toBe(false)
		if (!result.success)
			expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["executionMethod"] }))
	})
})
