import { browserToolNames } from "@alpha-code/types"
import { canonicalizeToolName } from "../tools/ToolRegistry"
import type { InternalTaskPolicy } from "./InternalTaskEnvelope"
import { isMcpTool } from "../../utils/mcp-name"

const delegationTools = new Set(["spawn_agent", "wait_agent", "followup_task", "interrupt_agent", "close_agent"])
const editTools = new Set([
	"apply_patch",
	"write_to_file",
	"apply_diff",
	"edit",
	"edit_file",
	"search_replace",
	"create_ticket",
	"update_ticket",
	"delete_ticket",
])

/** Roles describe work. The captured parent catalog and policy determine authority. */
export function getInheritedSubagentToolNames(
	parentTools: readonly string[],
	policy: Pick<InternalTaskPolicy, "execute" | "mutate" | "delegate" | "network" | "externalSideEffects">,
	hasInheritedSkills: boolean,
): string[] {
	return [...new Set(parentTools.map(canonicalizeToolName))].filter((name) => {
		// These host operations create independent task ownership rather than managed descendants.
		if (
			["new_task", "delegate_task", "create_task", "create_thread", "fork_thread", "run_slash_command"].includes(
				name,
			)
		)
			return false
		if (!policy.delegate && delegationTools.has(name)) return false
		if (!policy.mutate && editTools.has(name)) return false
		if (!policy.execute && name === "manage_command") return false
		if (!hasInheritedSkills && name === "skill") return false
		if (
			(!policy.network || !policy.externalSideEffects) &&
			(isMcpTool(name) ||
				[
					"use_mcp_tool",
					"access_mcp_resource",
					"list_mcp_resources",
					"list_mcp_resource_templates",
					"read_mcp_resource",
					"custom_tool",
					"generate_image",
				].includes(name) ||
				(browserToolNames as readonly string[]).includes(name))
		)
			return false
		return true
	})
}
