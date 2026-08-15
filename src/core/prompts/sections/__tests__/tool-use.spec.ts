import { getSharedToolUseSection } from "../tool-use"

describe("getSharedToolUseSection", () => {
	it("should include native tool-calling instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("provider-native tool-calling mechanism")
		expect(section).toContain("Do not include XML markup or examples")
	})

	it("should align batching with action dependencies", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("Batch independent reads, searches, and diagnostics")
		expect(section).toContain(
			"Serialize dependent actions, workspace mutations, approvals, and control-flow operations",
		)
		expect(section).not.toContain("You must call at least one tool per assistant response")
		expect(section).not.toContain("as many tools as are reasonably needed")
	})

	it("should call out delegation tools as batching exceptions", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("new_task and delegate_task are blocking delegation boundaries")
		expect(section).toContain("must each be called alone")
		expect(section).toContain("multiple independent spawn_agent calls may share a batch")
	})

	it("should NOT include single tool per message restriction", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("You must use exactly one tool call per assistant response")
		expect(section).not.toContain("Do not call zero tools or more than one tool")
	})

	it("does not require a token tool call when established context is sufficient", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("does not require a token tool call")
	})

	it("should NOT include XML formatting instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("<actual_tool_name>")
		expect(section).not.toContain("</actual_tool_name>")
	})
})
