import { getToolUseGuidelinesSection } from "../tool-use-guidelines"

describe("getToolUseGuidelinesSection", () => {
	it("should include proper numbered guidelines", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("1. Choose the most appropriate tool")
		expect(guidelines).toContain("2. Group independent, read-only calls")
		expect(guidelines).toContain("3. Treat returned tool results as evidence")
		expect(guidelines).toContain("4. Supply required parameters")
	})

	it("should include multiple-tools-per-message guidance", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("Group independent, read-only calls")
		expect(guidelines).toContain("when policy permits")
		expect(guidelines).toContain(
			"Serialize dependent actions, workspace mutations, approvals, and control-flow operations",
		)
		expect(guidelines).not.toContain("use one tool at a time per message")
	})

	it("uses harness results without waiting for separate user confirmation", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("no separate user confirmation is required")
		expect(guidelines).not.toContain("considering the user's response after tool executions")
		expect(guidelines).not.toContain("wait for user confirmation")
	})

	it("should include common guidance", () => {
		const guidelines = getToolUseGuidelinesSection()
		expect(guidelines).toContain("next unresolved need")
		expect(guidelines).toContain("Choose the most appropriate tool")
		expect(guidelines).not.toContain("<actual_tool_name>")
	})

	it.each(["explore", "review", "worker"] as const)(
		"retains incomplete-result protection for %s children",
		(role) => {
			expect(getToolUseGuidelinesSection(role)).toContain(
				"Never assume success from missing or incomplete output",
			)
		},
	)

	it("keeps Plan evidence distinct from authority and assumptions", () => {
		const guidelines = getToolUseGuidelinesSection(undefined, true)

		expect(guidelines).toContain("host-approved inspection or verification")
		expect(guidelines).toContain("Missing or incomplete output does not establish success")
		expect(guidelines).not.toContain("evidence as authoritative")
	})

	it("should not include per-tool confirmation guidelines", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).not.toContain("After each tool use, the user will respond with the result")
	})

	it("does not infer success from incomplete command output", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("Never assume success")
		expect(guidelines).toContain("output is missing or incomplete")
		expect(guidelines).toContain("bounded follow-up check")
	})
})
