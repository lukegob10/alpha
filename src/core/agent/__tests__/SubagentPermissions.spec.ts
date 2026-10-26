import { describe, expect, it } from "vitest"
import { getInheritedSubagentToolNames } from "../SubagentPermissions"

const policy = { execute: true, mutate: true, delegate: true, network: true, externalSideEffects: true }

describe("inherited subagent tool permissions", () => {
	it("keeps only captured tools and canonicalizes MCP names", () => {
		expect(
			getInheritedSubagentToolNames(["mcp__docs__search", "apply_patch", "create_ticket"], policy, false),
		).toEqual(["mcp--docs--search", "apply_patch", "create_ticket"])
	})

	it.each(["network", "externalSideEffects"] as const)("retains a narrower parent %s ceiling", (key) => {
		expect(
			getInheritedSubagentToolNames(
				["mcp__docs__search", "mcp--docs--search", "use_mcp_tool", "read_mcp_resource", "exec_command"],
				{ ...policy, [key]: false },
				false,
			),
		).toEqual(["exec_command"])
	})

	it("retains write, delegation, skill and command-session ceilings", () => {
		expect(
			getInheritedSubagentToolNames(
				[
					"apply_patch",
					"create_ticket",
					"spawn_agent",
					"followup_task",
					"manage_command",
					"skill",
					"list_agents",
					"send_message",
				],
				{ ...policy, mutate: false, delegate: false, execute: false },
				false,
			),
		).toEqual(["list_agents", "send_message"])
	})

	it("keeps independent task creation outside managed-child ownership", () => {
		expect(
			getInheritedSubagentToolNames(
				["create_task", "create_thread", "fork_thread", "new_task", "spawn_agent"],
				policy,
				false,
			),
		).toEqual(["spawn_agent"])
	})

	it("narrows every lifecycle control with delegation authority while retaining passive communication", () => {
		const tools = [
			"spawn_agent",
			"wait_agent",
			"followup_task",
			"interrupt_agent",
			"cancel_agent",
			"close_agent",
			"list_agents",
			"send_message",
		]

		expect(getInheritedSubagentToolNames(tools, { ...policy, delegate: false }, false)).toEqual([
			"list_agents",
			"send_message",
		])
		expect(getInheritedSubagentToolNames(tools, policy, false)).toEqual(tools)
	})
})
