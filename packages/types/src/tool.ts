import { z } from "zod"

import { browserToolNames } from "./browser.js"

/**
 * ToolGroup
 */

export const toolGroups = ["read", "edit", "command", "mcp", "modes", "agents", "browser"] as const

export const toolGroupsSchema = z.enum(toolGroups)

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
	"shell",
	"exec_command",
	"execute_command",
	"manage_command",
	"write_stdin",
	"read_file",
	"view_image",
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
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
	"read_diagnostic_evidence",
	"discover_tools",
	"tool_search",
	"ask_followup_question",
	"request_user_input",
	"request_user_input_async",
	"attempt_completion",
	"new_task",
	"delegate_task",
	"spawn_agent",
	"create_task",
	"list_tasks",
	"wait_task",
	"send_task_message",
	"steer_task",
	"stop_task",
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
	"update_plan",
	"run_slash_command",
	"skill",
	"generate_image",
	...browserToolNames,
	"custom_tool",
] as const

export const toolNamesSchema = z.enum(toolNames)

export type ToolName = z.infer<typeof toolNamesSchema>

/** Canonical sidecar for results from the newer command tools. */
export interface CommandToolResult {
	wall_time_seconds: number
	output: string
	exit_code?: number
	session_id?: number
	original_token_count?: number
	/** Preserves the read handle when large command output was spilled to an artifact. */
	artifact_id?: string
}

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
