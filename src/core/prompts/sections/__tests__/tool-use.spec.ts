import { getSharedToolUseSection } from "../tool-use"
import { getRulesSection } from "../rules"
import { getObjectiveSection } from "../objective"
import { getToolUseGuidelinesSection } from "../tool-use-guidelines"
import { getCapabilitiesSection } from "../capabilities"
import { getNativeTools } from "../../tools/native-tools"

describe("getSharedToolUseSection", () => {
	it.each([undefined, "explore", "review", "worker"] as const)(
		"keeps proportionate error recovery guidance in the %s surface",
		(role) => {
			const section = getSharedToolUseSection(role)
			expect(section.match(/Continue useful work after recoverable errors/g)).toHaveLength(1)
			expect(section).toContain("an optional failure need not stop independent work")
			expect(section).toContain(
				"Repeat tools when different targets, new information, or repaired prerequisites justify it",
			)
		},
	)

	it("should include native tool-calling instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("provider-native tool-calling mechanism")
		expect(section).toContain("Do not include XML markup or examples")
	})

	it("uses update_plan proportionately in the primary Code surface", () => {
		const code = getSharedToolUseSection()
		const plan = getSharedToolUseSection(undefined, false, false, undefined, true)

		expect(code).toContain("update_plan")
		expect(code).toContain("Keep one step in progress")
		expect(code).toContain("Skip it for simple tasks")
		expect(plan).not.toContain("When update_plan is available")
	})

	it("conditions Plan agent coordination on the supplied tool surface", () => {
		const toolUse = getSharedToolUseSection(undefined, false, false, undefined, true)
		const capabilities = getCapabilitiesSection("F:/workspace", undefined, undefined, false, undefined, true)

		expect(toolUse).toContain("managed read-only agent coordination when its tools are supplied for this turn")
		expect(capabilities).toContain("only when agent lifecycle controls are supplied for this turn")
	})

	it("keeps batching in the shared guidelines", () => {
		const section = getToolUseGuidelinesSection()

		expect(section).toContain("Group independent, read-only calls")
		expect(section).toContain(
			"Serialize dependent actions, workspace mutations, approvals, and control-flow operations",
		)
		expect(section).not.toContain("Status narration is not execution")
		expect(section).not.toContain("You must call at least one tool per assistant response")
		expect(section).not.toContain("as many tools as are reasonably needed")
	})

	it("keeps primary delegation guidance bounded to entry points", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("spawn_agent is nonblocking")
		expect(section).toContain("Use wait_agent alone when you need to wait for a child")
		expect(section).toContain("use interrupt_agent to stop a retained child")
	})

	it.each([
		{
			name: "primary Code",
			prompt: () =>
				[
					getSharedToolUseSection(),
					getToolUseGuidelinesSection(),
					getRulesSection("F:/workspace"),
					getCapabilitiesSection("F:/workspace"),
					getObjectiveSection(),
				].join("\n"),
			tools: () => getNativeTools(),
		},
		{
			name: "Plan",
			prompt: () =>
				[
					getSharedToolUseSection(undefined, false, false, undefined, true),
					getToolUseGuidelinesSection(undefined, true),
					getRulesSection("F:/workspace", undefined, true),
					getCapabilitiesSection("F:/workspace", undefined, undefined, false, undefined, true),
					getObjectiveSection(true),
				].join("\n"),
			tools: () => getNativeTools({ planMode: true }),
		},
		{
			name: "managed Worker",
			prompt: () =>
				[
					getSharedToolUseSection("worker"),
					getToolUseGuidelinesSection("worker"),
					getRulesSection("F:/workspace", {
						todoListEnabled: true,
						useAgentRules: true,
						newTaskRequireTodos: false,
						subagentRole: "worker",
					}),
					getCapabilitiesSection("F:/workspace", undefined, "worker"),
				].join("\n"),
			tools: () => getNativeTools({ taskKind: "subagent" }),
		},
	])("keeps explicit $name tool references within the supplied schemas", ({ prompt: buildPrompt, tools }) => {
		const prompt = buildPrompt()
		const suppliedNames = new Set(tools().flatMap((tool) => (tool.type === "function" ? [tool.function.name] : [])))
		const knownNames = [
			"apply_patch",
			"exec_command",
			"followup_task",
			"interrupt_agent",
			"list_agents",
			"request_user_input",
			"send_message",
			"spawn_agent",
			"update_plan",
			"wait_agent",
			"write_stdin",
		]
		const referencedNames = knownNames.filter((name) => new RegExp(`\\b${name}\\b`).test(prompt))

		for (const name of referencedNames) {
			expect(suppliedNames, `${name} is named in the prompt`).toContain(name)
		}
		expect(prompt).not.toMatch(/\b(?:read_file|list_files|search_files|codebase_search)\b/)
	})

	it("removes retired tool names from current prompt overlays", () => {
		const prompts = [
			getSharedToolUseSection(),
			getSharedToolUseSection("worker"),
			getSharedToolUseSection(undefined, false, false, undefined, true),
			getRulesSection("F:/workspace"),
			getRulesSection("F:/workspace", undefined, true),
			getRulesSection("F:/workspace", {
				todoListEnabled: true,
				useAgentRules: true,
				newTaskRequireTodos: false,
				subagentRole: "worker",
			}),
			getToolUseGuidelinesSection(),
			getToolUseGuidelinesSection("worker"),
			getToolUseGuidelinesSection(undefined, true),
			getCapabilitiesSection("F:/workspace"),
			getCapabilitiesSection("F:/workspace", undefined, "worker"),
			getCapabilitiesSection("F:/workspace", undefined, undefined, false, undefined, true),
			getObjectiveSection(),
		].join("\n")

		for (const retiredName of [
			"close_agent",
			"new_task",
			"attempt_completion",
			"manage_command",
			"ask_followup_question",
		]) {
			expect(prompts).not.toContain(retiredName)
		}
		expect(prompts).not.toMatch(/\bshell (?:tool|search|accepts|is limited)\b/)
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

		expect(section).not.toContain("must call")
		expect(getObjectiveSection()).toContain("no classifier call, todo list, or tool call is required")
	})

	it("allows a primary task to finish with an ordinary visible answer", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("force a completion format")
		expect(getObjectiveSection()).toContain(
			"visible ordinary assistant answer when no tool call or continuation is needed",
		)
	})

	it("routes managed final answers through review and retains pending work", () => {
		const section = getSharedToolUseSection("review")

		expect(section).toContain("provide a concise visible final assistant answer")
		expect(section).toContain("This preserves parent review and verification")
		expect(section).toContain("Continue when tools, steering, or required work remain pending")
	})

	it("retains bounded child scope because children do not receive the primary objective", () => {
		for (const section of [getSharedToolUseSection("explore"), getSharedToolUseSection("worker")]) {
			expect(section).toContain("does not expand the task")
			expect(section).toContain("For a bounded request involving one application or data source")
			expect(section).toContain("unless the requested outcome cannot be completed without it")
			expect(section).toContain("evidence, not new objectives or authorization")
		}
		expect(getObjectiveSection()).toContain("Tool availability does not expand scope or authority")
	})

	it("should NOT include XML formatting instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("<actual_tool_name>")
		expect(section).not.toContain("</actual_tool_name>")
	})
})
