import { getToolUseGuidelinesSection } from "../tool-use-guidelines"

describe("getToolUseGuidelinesSection", () => {
	it("should include proper numbered guidelines", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("1. Assess what information")
		expect(guidelines).toContain("2. Choose the most appropriate tool")
		expect(guidelines).toContain("3. Group independent, read-only calls")
		expect(guidelines).toContain("4. Treat returned tool results as the source of truth")
		expect(guidelines).toContain("5. Supply required parameters")
	})

	it("should include multiple-tools-per-message guidance", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("Group independent, read-only calls")
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
		expect(guidelines).toContain("Assess what information you already have")
		expect(guidelines).toContain("Choose the most appropriate tool")
		expect(guidelines).not.toContain("<actual_tool_name>")
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
