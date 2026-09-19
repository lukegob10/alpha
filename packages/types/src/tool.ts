import { z } from "zod"

import { browserToolNames } from "./browser.js"

/**
 * ToolGroup
 */

export const toolGroups = ["read", "edit", "command", "mcp", "modes", "agents", "browser"] as const

export const toolGroupsSchema = z.enum(toolGroups)

/**
 * Tool groups that have been removed but may still exist in user config files.
 * Used by schema preprocessing to silently strip these before validation,
 * preventing errors for users with older configs.
 */
export const deprecatedToolGroups: readonly string[] = ["github"]

export type ToolGroup = z.infer<typeof toolGroupsSchema>

/**
 * ToolName
 */

export const toolNames = [
	"list_tickets",
	"read_ticket",
	"create_ticket",
	"update_ticket",
	"delete_ticket",
	"execute_command",
	"manage_command",
	"read_file",
	"read_command_output",
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"search_files",
	"list_files",
	"use_mcp_tool",
	"access_mcp_resource",
	"discover_tools",
	"ask_followup_question",
	"attempt_completion",
	"new_task",
	"delegate_task",
	"spawn_agent",
	"list_agents",
	"wait_agent",
	"send_message",
	"report_progress",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
	"codebase_search",
	"update_todo_list",
	"run_slash_command",
	"skill",
	"generate_image",
	// Retained so historical settings and tool usage records remain readable.
	"github_api",
	...browserToolNames,
	"custom_tool",
] as const

export const toolNamesSchema = z.enum(toolNames)

export type ToolName = z.infer<typeof toolNamesSchema>

/**
 * ToolUsage
 */

// Historical usage remains readable after a tool is retired; it does not register executable tools.
export const toolUsageSchema = z.record(
	z.enum([...toolNames, "switch_mode"]),
	z.object({
		attempts: z.number(),
		failures: z.number(),
	}),
)

export type ToolUsage = z.infer<typeof toolUsageSchema>
