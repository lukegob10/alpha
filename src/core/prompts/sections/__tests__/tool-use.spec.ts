import { getSharedToolUseSection } from "../tool-use"

describe("getSharedToolUseSection", () => {
	it("should include native tool-calling instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("provider-native tool-calling mechanism")
		expect(section).toContain("Tool schemas and runtime policy are authoritative")
	})

	it("does not duplicate scheduler or completion mechanics in prose", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("normal final answer")
		expect(section).not.toContain("Independent read-only inspections")
		expect(section).not.toContain("Keep edits and commands ordered")
		expect(section).not.toContain("new_task is a delegation boundary")
		expect(section).not.toContain("attempt_completion")
	})

	it("should NOT include single tool per message restriction", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("You must use exactly one tool call per assistant response")
		expect(section).not.toContain("Do not call zero tools or more than one tool")
	})

	it("should NOT include XML formatting instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("<actual_tool_name>")
		expect(section).not.toContain("</actual_tool_name>")
	})
})
