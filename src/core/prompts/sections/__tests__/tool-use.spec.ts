import { getSharedToolUseSection } from "../tool-use"
import { getRulesSection } from "../rules"

describe("getSharedToolUseSection", () => {
	it("should include native tool-calling instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("provider-native tool-calling mechanism")
		expect(section).toContain("Do not include XML markup or examples")
	})

	it("should align batching with action dependencies", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("Status narration is not execution")
		expect(section).toContain("call an actual mutation tool")
		expect(section).toContain("Never claim that an edit was applied unless a mutation tool returned success")
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
		expect(section).toContain("put all of their spawn_agent calls in the same response")
		expect(section).toContain("wait_agent is blocking and must be called alone")
		expect(section).toContain("execute sequentially in provider order")
		expect(section).toContain("spawn_agent followed by send_message")
		expect(section).toContain("stable task_name")
	})

	it("keeps root work local under explicit-only delegation unless the user requested it", () => {
		const explicitOnly = getSharedToolUseSection(undefined, false, false, "explicit-only")
		const proactive = getSharedToolUseSection(undefined, false, false, "proactive")

		expect(explicitOnly).toContain("frozen delegation policy is explicit-only")
		expect(explicitOnly).toContain("Your own judgment that delegation would be useful is not authorization")
		expect(proactive).toContain("frozen delegation policy is proactive")
	})

	it("permits only bounded descendant control when frozen child authority allows delegation", () => {
		const rules = getRulesSection("F:/workspace", {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			subagentRole: "review",
			subagentCanDelegate: true,
			subagentDelegationPolicy: "proactive",
		})
		const toolUse = getSharedToolUseSection("review", false, true, "proactive")

		expect(rules).not.toContain("Do not create tasks or delegate")
		expect(rules).toContain("create only managed descendants with spawn_agent")
		expect(rules).toContain("frozen depth, root-wide capacity, timeout, token, and cost limits")
		expect(toolUse).toContain("managed-agent lifecycle controls for your retained descendant subtree")
		expect(toolUse).toContain("Do not control ancestors, siblings, or foreign branches")
	})

	it("retains the delegation prohibition for explicit false and legacy child prompt settings", () => {
		const baseSettings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			subagentRole: "review" as const,
		}
		const explicitFalse = getRulesSection("F:/workspace", {
			...baseSettings,
			subagentCanDelegate: false,
		})
		const legacy = getRulesSection("F:/workspace", baseSettings)
		const toolUse = getSharedToolUseSection("review")

		expect(explicitFalse).toContain("Do not create tasks or delegate")
		expect(legacy).toContain("Do not create tasks or delegate")
		expect(toolUse).not.toContain("spawn_agent")
		expect(toolUse).not.toContain("descendant subtree")
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
