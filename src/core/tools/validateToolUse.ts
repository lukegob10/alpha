import path from "path"

import type { ToolName, ModeConfig, ExperimentId, GroupOptions, GroupEntry } from "@alpha-code/types"
import { toolNames as validToolNames } from "@alpha-code/types"
import { customToolRegistry } from "@alpha-code/core"

import { type Mode, FileRestrictionError, getModeBySlug, getGroupName, planModeSlug } from "../../shared/modes"
import { EXPERIMENT_IDS } from "../../shared/experiments"
import { isPlanCommandAllowed, isPlanCommandCwdAllowed } from "../../shared/plan-command"
import { TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS, TOOL_ALIASES } from "../../shared/tools"
import { parseMcpToolName } from "../../utils/mcp-name"

const executableNativeToolNames = validToolNames

const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	"read_file",
	"search_files",
	"list_files",
	"codebase_search",
	"ask_followup_question",
	"attempt_completion",
	"execute_command",
	"read_command_output",
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
])

/**
 * Checks if a tool name is a valid, known tool.
 * Note: This does NOT check if the tool is allowed for a specific mode,
 * only that the tool actually exists.
 */
export function isValidToolName(toolName: string, experiments?: Record<string, boolean>): toolName is ToolName {
	// Check if it's a valid static tool
	if ((executableNativeToolNames as readonly string[]).includes(toolName)) {
		return true
	}

	if (experiments?.customTools && customToolRegistry.has(toolName)) {
		return true
	}

	// Check if it's a dynamic MCP tool (mcp_serverName_toolName format).
	if (toolName.startsWith("mcp_") || parseMcpToolName(toolName)) {
		return true
	}

	return false
}

export function validateToolUse(
	toolName: ToolName,
	mode: Mode,
	customModes?: ModeConfig[],
	toolRequirements?: Record<string, boolean>,
	toolParams?: Record<string, unknown>,
	experiments?: Record<string, boolean>,
	includedTools?: string[],
): void {
	// First, check if the tool name is actually a valid/known tool
	// This catches completely invalid tool names like "edit_file" that don't exist
	if (!isValidToolName(toolName, experiments)) {
		throw new Error(
			`Unknown tool "${toolName}". This tool does not exist. Please use one of the available tools: ${executableNativeToolNames.join(", ")}.`,
		)
	}

	// Then check if the tool is allowed for the current mode
	if (
		!isToolAllowedForMode(
			toolName,
			mode,
			customModes ?? [],
			toolRequirements,
			toolParams,
			experiments,
			includedTools,
		)
	) {
		throw new Error(`Tool "${toolName}" is not allowed in ${mode} mode.`)
	}
}

const EDIT_OPERATION_PARAMS = [
	"diff",
	"content",
	"operations",
	"search",
	"replace",
	"args",
	"line",
	"patch", // Used by apply_patch
	"old_string", // Used by search_replace and edit_file
	"new_string", // Used by search_replace and edit_file
] as const

// Markers used in apply_patch format to identify file operations
const PATCH_FILE_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: ", "*** Move to: "] as const

/**
 * Extract file paths from apply_patch content.
 * The patch format uses add, delete, update, and move markers followed by a file path.
 * @param patchContent The patch content string
 * @returns Array of file paths found in the patch
 */
function extractFilePathsFromPatch(patchContent: string): string[] {
	const filePaths: string[] = []
	const lines = patchContent.split("\n")

	for (const line of lines) {
		for (const marker of PATCH_FILE_MARKERS) {
			if (line.startsWith(marker)) {
				const path = line.substring(marker.length).trim()
				if (path) {
					filePaths.push(path)
				}
				break
			}
		}
	}

	return filePaths
}

function getGroupOptions(group: GroupEntry): GroupOptions | undefined {
	return Array.isArray(group) ? group[1] : undefined
}

function doesFileMatchRegex(filePath: string, pattern: string): boolean {
	try {
		const regex = new RegExp(pattern)
		return regex.test(filePath)
	} catch (error) {
		console.error(`Invalid regex pattern: ${pattern}`, error)
		return false
	}
}

function normalizeRestrictedFilePath(filePath: string): string | undefined {
	const normalizedPath = path.posix.normalize(filePath.replace(/\\/g, "/"))
	if (
		path.posix.isAbsolute(normalizedPath) ||
		/^[A-Za-z]:\//.test(normalizedPath) ||
		normalizedPath === ".." ||
		normalizedPath.startsWith("../")
	) {
		return undefined
	}

	return normalizedPath.replace(/^\.\//, "")
}

export function isToolAllowedForMode(
	tool: string,
	modeSlug: string,
	customModes: ModeConfig[],
	toolRequirements?: Record<string, boolean>,
	toolParams?: Record<string, any>, // All tool parameters
	experiments?: Record<string, boolean>,
	includedTools?: string[], // Opt-in tools explicitly included (e.g., from modelInfo)
): boolean {
	// Resolve alias to canonical name (e.g., "search_and_replace" → "edit")
	const resolvedTool = TOOL_ALIASES[tool] ?? tool
	const resolvedIncludedTools = includedTools?.map((t) => TOOL_ALIASES[t] ?? t)

	// Check tool requirements first — explicit disabling takes priority over everything,
	// including ALWAYS_AVAILABLE_TOOLS. This ensures disabledTools works consistently
	// at both the filtering layer and the execution-time validation layer.
	if (toolRequirements && typeof toolRequirements === "object") {
		if (
			(tool in toolRequirements && !toolRequirements[tool]) ||
			(resolvedTool in toolRequirements && !toolRequirements[resolvedTool])
		) {
			return false
		}
	} else if (toolRequirements === false) {
		// If toolRequirements is a boolean false, all tools are disabled
		return false
	}

	// The built-in Plan mode is a host-enforced collaboration state, not a
	// customizable file-restriction preset. Fail closed before the global and
	// custom-tool shortcuts so stale settings cannot restore mutating authority.
	if (modeSlug === planModeSlug && !PLAN_MODE_ALLOWED_TOOLS.has(resolvedTool)) {
		return false
	}

	if (modeSlug === planModeSlug && resolvedTool === "spawn_agent") {
		if (toolParams?.agent_kind && !["explore", "review"].includes(toolParams.agent_kind)) return false
		if (toolParams?.write_scope != null) return false
	}

	if (modeSlug === planModeSlug && resolvedTool === "delegate_task" && Array.isArray(toolParams?.tasks)) {
		for (const task of toolParams.tasks) {
			if (!task || typeof task !== "object") continue
			if (task.agent_kind && !["explore", "review"].includes(task.agent_kind)) return false
			if (task.write_scope != null) return false
		}
	}

	if (modeSlug === planModeSlug && resolvedTool === "execute_command" && toolParams) {
		if (typeof toolParams.command !== "string" || !isPlanCommandAllowed(toolParams.command)) return false
		if (!isPlanCommandCwdAllowed(toolParams.cwd)) return false
		if (toolParams.verification != null) return false
	}

	// Plan's allowed set is canonical and cannot be weakened or expanded by a
	// persisted custom mode that reuses the historical `architect` slug.
	if (modeSlug === planModeSlug) return true

	// Always allow these tools (unless explicitly disabled above)
	if (ALWAYS_AVAILABLE_TOOLS.includes(tool as any)) {
		return true
	}

	// For now, allow all custom tools in any mode.
	// As a follow-up we should expand the custom tool definition to include mode restrictions.
	if (experiments?.customTools && customToolRegistry.has(tool)) {
		return true
	}

	// Check if this is a dynamic MCP tool (mcp_serverName_toolName)
	// These should be allowed if the mcp group is allowed for the mode
	const isDynamicMcpTool = tool.startsWith("mcp_") || !!parseMcpToolName(tool)

	if (experiments && Object.values(EXPERIMENT_IDS).includes(tool as ExperimentId)) {
		if (!experiments[tool]) {
			return false
		}
	}

	const mode = getModeBySlug(modeSlug, customModes)

	if (!mode) {
		return false
	}

	// Check if tool is in any of the mode's groups and respects any group options
	for (const group of mode.groups) {
		const groupName = getGroupName(group)
		const options = getGroupOptions(group)

		const groupConfig = TOOL_GROUPS[groupName]

		// Check if this is a dynamic MCP tool and the mcp group is allowed
		if (isDynamicMcpTool && groupName === "mcp") {
			// Dynamic MCP tools are allowed if the mcp group is in the mode's groups
			return true
		}

		// Check if the tool is in the group's regular tools
		const isRegularTool = groupConfig.tools.includes(resolvedTool)

		// Check if the tool is a custom tool that has been explicitly included
		const isCustomTool =
			groupConfig.customTools?.includes(resolvedTool) && resolvedIncludedTools?.includes(resolvedTool)

		// If the tool isn't in regular tools and isn't an included custom tool, continue to next group
		if (!isRegularTool && !isCustomTool) {
			continue
		}

		// If there are no options, allow the tool
		if (!options) {
			return true
		}

		// For the edit group, check file regex if specified
		if (groupName === "edit" && options.fileRegex) {
			const filePath = toolParams?.path || toolParams?.file_path
			// Check if this is an actual edit operation (not just path-only for streaming)
			const isEditOperation = EDIT_OPERATION_PARAMS.some(
				(param) =>
					Object.prototype.hasOwnProperty.call(toolParams ?? {}, param) && toolParams?.[param] !== undefined,
			)

			// Handle single file path validation
			const normalizedFilePath = typeof filePath === "string" ? normalizeRestrictedFilePath(filePath) : undefined
			if (
				filePath &&
				isEditOperation &&
				(!normalizedFilePath || !doesFileMatchRegex(normalizedFilePath, options.fileRegex))
			) {
				throw new FileRestrictionError(mode.name, options.fileRegex, options.description, filePath, tool)
			}

			// Handle apply_patch: extract file paths from patch content and validate each
			if (tool === "apply_patch" && typeof toolParams?.patch === "string") {
				const patchFilePaths = extractFilePathsFromPatch(toolParams.patch)
				for (const patchFilePath of patchFilePaths) {
					const normalizedPatchPath = normalizeRestrictedFilePath(patchFilePath)
					if (!normalizedPatchPath || !doesFileMatchRegex(normalizedPatchPath, options.fileRegex)) {
						throw new FileRestrictionError(
							mode.name,
							options.fileRegex,
							options.description,
							patchFilePath,
							tool,
						)
					}
				}
			}

			// Native-only: multi-file edits provide structured params; no legacy XML args parsing.
		}

		return true
	}

	return false
}
