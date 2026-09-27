import requestUserInput from "../request_user_input"

describe("request_user_input native tool", () => {
	it("matches the Codex question and option contract", () => {
		expect(requestUserInput.function.name).toBe("request_user_input")
		expect(requestUserInput.function.strict).toBe(false)
		expect(requestUserInput.function.parameters).toMatchObject({
			type: "object",
			required: ["questions"],
			additionalProperties: false,
			properties: {
				questions: {
					type: "array",
					minItems: 1,
					maxItems: 3,
					items: {
						type: "object",
						required: ["id", "header", "question", "options"],
						additionalProperties: false,
						properties: {
							id: { type: "string" },
							header: { type: "string" },
							question: { type: "string" },
							options: {
								type: "array",
								minItems: 2,
								maxItems: 3,
								items: {
									type: "object",
									required: ["label", "description"],
									additionalProperties: false,
								},
							},
						},
					},
				},
			},
		})
		expect(requestUserInput.function.description).toContain("Plan mode")
	})
})
