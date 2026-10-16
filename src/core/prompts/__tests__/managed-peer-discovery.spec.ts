import { describe, expect, it } from "vitest"

import { getRulesSection } from "../sections/rules"
import { getSharedToolUseSection } from "../sections/tool-use"

describe("managed-agent discovery guidance", () => {
	it.each(["explore", "review", "worker"] as const)(
		"describes read-only same-tree discovery for a nondelegating %s child",
		(role) => {
			const prompt = getSharedToolUseSection(role, false, false)
			const authority = prompt.split("\n\n").find((paragraph) => paragraph.startsWith("You have only"))

			expect(authority).toContain("list_agents")
			expect(prompt).toMatch(/(?:read-only[^\n]*list_agents|list_agents[^\n]*read-only)/)
			expect(prompt).toMatch(/(?:same root task tree|(?:this|same) managed tree)/)
			expect(prompt).not.toContain("lifecycle controls list_agents,")
			expect(prompt).not.toContain("plus spawn_agent")
		},
	)

	it.each(["explore", "review", "worker"] as const)(
		"separates %s discovery from descendant-only delegated lifecycle control",
		(role) => {
			const prompt = getSharedToolUseSection(role, false, true, "explicit-only")
			const rules = getRulesSection("F:/workspace", {
				todoListEnabled: false,
				useAgentRules: false,
				newTaskRequireTodos: false,
				subagentRole: role,
				subagentCanDelegate: true,
				subagentDelegationPolicy: "explicit-only",
				commandShell: "powershell",
			})

			expect(prompt).toContain("list_agents")
			expect(prompt).not.toContain("lifecycle controls list_agents,")
			expect(prompt).toContain("retained descendant subtree")
			expect(rules).toContain(
				"Use list_agents for read-only identity and status discovery within the same root task tree.",
			)
			expect(rules).toContain(
				"Use wait_agent, followup_task, and interrupt_agent only for your retained descendant subtree.",
			)
			expect(rules).not.toContain(
				"Use list_agents, wait_agent, followup_task, and interrupt_agent only for your retained descendant subtree.",
			)
			expect(rules).toContain("Never control a parent, ancestor, sibling, or foreign branch.")
		},
	)
})
