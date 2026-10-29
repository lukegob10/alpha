import path from "path"

import type { ToolName, ModeConfig, ExperimentId, GroupOptions, GroupEntry } from "@alpha-code/types"
import { toolNames as validToolNames } from "@alpha-code/types"
import { customToolRegistry } from "@alpha-code/core"

import { type Mode, FileRestrictionError, getModeBySlug, getGroupName, planModeSlug } from "../../shared/modes"
import { EXPERIMENT_IDS } from "../../shared/experiments"
import { isPlanCommandAllowed, isPlanCommandCwdAllowed } from "../../shared/plan-command"
import {
	TOOL_GROUPS,
	ALWAYS_AVAILABLE_TOOLS,
	TOOL_ALIASES,
	isCommandArtifactRead,
	expandLegacyThreadToolDisables,
} from "../../shared/tools"
import { parseMcpToolName } from "../../utils/mcp-name"
import { getPatchPaths } from "./apply-patch/parser"

const executableNativeToolNames: readonly string[] = validToolNames

function hasCustomTool(toolName: string, capturedCustomToolNames?: ReadonlySet<string>): boolean {
	// A supplied empty catalog is authoritative; only legacy callers consult the live registry.
	return capturedCustomToolNames !== undefined
		? capturedCustomToolNames.has(toolName)
		: customToolRegistry.has(toolName)
}

const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	"get_goal",
	"list_tickets",
	"read_ticket",
	"memories_list",
	"memories_read",
	"memories_search",
	"read_file",
	"view_image",
	"search_files",
	"list_files",
	"codebase_search",
	"request_user_input",
	"request_user_input_async",
	"exec_command",
	"write_stdin",
	"spawn_agent",
	"list_provider_profiles",
	"list_agents",
	"wait_agent",
	"send_message",
	"followup_task",
	"interrupt_agent",
	"list_tasks",
	"wait_task",
	"list_threads",
	"list_archived_threads",
	"read_thread",
	"wait_threads",
])

/**
 * Checks if a tool name is a valid, known tool.
 * Note: This does NOT check if the tool is allowed for a specific mode,
 * only that the tool actually exists.
 */
export function isValidToolName(
	toolName: string,
	experiments?: Record<string, boolean>,
	capturedCustomToolNames?: ReadonlySet<string>,
): toolName is ToolName {
	// Check if it's a valid static tool
	if ((executableNativeToolNames as readonly string[]).includes(toolName)) {
		return true
	}

	if (experiments?.customTools && hasCustomTool(toolName, capturedCustomToolNames)) {
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
	capturedCustomToolNames?: ReadonlySet<string>,
): void {
	// First, check if the tool name is actually a valid/known tool
	if (!isValidToolName(toolName, experiments, capturedCustomToolNames)) {
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
			capturedCustomToolNames,
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
	capturedCustomToolNames?: ReadonlySet<string>,
): boolean {
	// Resolve alias to canonical name (e.g., "search_and_replace" → "edit")
	const resolvedTool = TOOL_ALIASES[tool] ?? tool
	const resolvedIncludedTools = includedTools?.map((t) => TOOL_ALIASES[t] ?? t)

	// Check tool requirements first — explicit disabling takes priority over everything,
	// including ALWAYS_AVAILABLE_TOOLS. This ensures disabledTools works consistently
	// at both the filtering layer and the execution-time validation layer.
	if (toolRequirements && typeof toolRequirements === "object") {
		const disabledNames = expandLegacyThreadToolDisables(
			Object.keys(toolRequirements).filter((name) => toolRequirements[name] === false),
		)
		if (disabledNames.includes(resolvedTool)) return false
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

	if (modeSlug === planModeSlug && resolvedTool === "exec_command" && toolParams) {
		const command = typeof toolParams.command === "string" ? toolParams.command : toolParams.cmd
		const cwd = typeof toolParams.cwd === "string" ? toolParams.cwd : toolParams.workdir
		if (typeof command !== "string" || !isPlanCommandAllowed(command)) return false
		if (!isPlanCommandCwdAllowed(cwd)) return false
		if (toolParams.verification != null) return false
	}
	if (
		modeSlug === planModeSlug &&
		resolvedTool === "write_stdin" &&
		toolParams &&
		!isCommandArtifactRead(toolParams)
	) {
		return false
	}

	// Plan's allowed set is canonical and cannot be weakened or expanded by a
	// persisted custom mode that reuses the historical `architect` slug.
	if (modeSlug === planModeSlug) return true

	// Always allow these tools (unless explicitly disabled above)
	if (ALWAYS_AVAILABLE_TOOLS.includes(tool as any) || ALWAYS_AVAILABLE_TOOLS.includes(resolvedTool as any)) {
		return true
	}

	// Custom definitions retain their captured authority after Plan and explicit deny checks.
	if (experiments?.customTools && hasCustomTool(tool, capturedCustomToolNames)) {
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
				const patchFilePaths = getPatchPaths(toolParams.patch)
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
