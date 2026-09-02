import path from "path"

import type OpenAI from "openai"

import type { ProviderSettings, ModeConfig, ModelInfo, ToolName } from "@alpha-code/types"
import { customToolRegistry, formatNative } from "@alpha-code/core"

import type { ClineProvider } from "../webview/ClineProvider"
import { getRooDirectoriesForCwd } from "../../services/roo-config/index.js"
import { getAvailableVSCodeBrowserToolNames } from "../../services/browser/VSCodeBrowserTools"
import { planModeSlug } from "../../shared/modes"

import { getNativeTools, getMcpServerTools } from "../prompts/tools/native-tools"
import {
	filterNativeToolsForMode,
	filterMcpToolsForMode,
	resolveToolAlias,
} from "../prompts/tools/filter-tools-for-mode"
import { buildTaskToolSurface as captureTaskToolSurface, type TaskToolSurface } from "../tools/TaskToolSurface"
import { ToolRegistry } from "../tools/ToolRegistry"
import type { ToolPolicySnapshot } from "../agent/ToolPolicy"

export interface BuildToolsOptions {
	provider: ClineProvider
	cwd: string
	mode: string | undefined
	customModes: ModeConfig[] | undefined
	experiments: Record<string, boolean> | undefined
	apiConfiguration: ProviderSettings | undefined
	disabledTools?: string[]
	modelInfo?: ModelInfo
	/**
	 * If true, returns all tools without mode filtering, but also includes
	 * the list of allowed tool names for use with allowedFunctionNames.
	 * This enables providers that support function call restrictions (e.g., Gemini)
	 * to pass all tool definitions while restricting callable tools.
	 */
	includeAllToolsWithRestrictions?: boolean
	/** Optional task-lane authority cap applied after mode filtering. */
	allowedToolNames?: readonly ToolName[]
	/** Selects role-specific schemas for primary and managed-child tasks. */
	taskKind?: "primary" | "subagent"
	/** Stable primary-task lifecycle catalog; managed children remain allow-list constrained. */
	enableAgentLifecycleTools?: boolean
	/** Optional caller policy values used when exposing the unified surface. */
	policy?: ToolPolicySnapshot
	autoApprovalEnabled?: boolean
}

export interface BuildToolsResult {
	/**
	 * The tools to pass to the model.
	 * If includeAllToolsWithRestrictions is true, this includes ALL tools.
	 * Otherwise, it includes only mode-filtered tools.
	 */
	tools: OpenAI.Chat.ChatCompletionTool[]
	/**
	 * The names of tools that are allowed to be called based on mode restrictions.
	 * Only populated when includeAllToolsWithRestrictions is true.
	 * Use this with allowedFunctionNames in providers that support it.
	 */
	allowedFunctionNames?: string[]
	/** Unified registry/policy snapshot retained for new callers. */
	registry?: ToolRegistry
	schemas?: OpenAI.Chat.ChatCompletionTool[]
	policy?: ToolPolicySnapshot
	digest?: string
	surface?: TaskToolSurface
}

/**
 * Extracts the function name from a tool definition.
 */
function getToolName(tool: OpenAI.Chat.ChatCompletionTool): string {
	return (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name
}

const AGENT_LIFECYCLE_TOOLS = new Set([
	"list_agents",
	"wait_agent",
	"send_message",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
])

const CHILD_SCOPED_AGENT_TOOLS = new Set(["spawn_agent", "report_progress", ...AGENT_LIFECYCLE_TOOLS])

/**
 * Builds the complete tools array for native protocol requests.
 * Combines native tools and MCP tools, filtered by mode restrictions.
 *
 * @param options - Configuration options for building the tools
 * @returns Array of filtered native and MCP tools
 */
export async function buildNativeToolsArray(options: BuildToolsOptions): Promise<OpenAI.Chat.ChatCompletionTool[]> {
	const result = await buildNativeToolsArrayWithRestrictions(options)
	return result.tools
}

/**
 * Builds the complete tools array for native protocol requests with optional mode restrictions.
 * When includeAllToolsWithRestrictions is true, returns ALL tools but also provides
 * the list of allowed tool names for use with allowedFunctionNames.
 *
 * This enables providers like Gemini to pass all tool definitions to the model
 * (so it can reference historical tool calls) while restricting which tools
 * can actually be invoked via allowedFunctionNames in toolConfig.
 *
 * @param options - Configuration options for building the tools
 * @returns BuildToolsResult with tools array and optional allowedFunctionNames
 */
async function buildToolCatalog(options: BuildToolsOptions): Promise<BuildToolsResult> {
	const {
		provider,
		cwd,
		mode,
		customModes,
		experiments,
		apiConfiguration,
		disabledTools: requestedDisabledTools,
		modelInfo,
		includeAllToolsWithRestrictions,
		allowedToolNames,
		taskKind = "primary",
		enableAgentLifecycleTools = taskKind === "primary",
	} = options
	const disabledTools = [...new Set([...(requestedDisabledTools ?? []), ...(options.policy?.disabledTools ?? [])])]

	const mcpHub = provider.getMcpHub()

	// Get CodeIndexManager for feature checking.
	const { CodeIndexManager } = await import("../../services/code-index/manager")
	const codeIndexManager = CodeIndexManager.getInstance(provider.context, cwd)

	// Build settings object for tool filtering.
	const filterSettings = {
		todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
		disabledTools,
		modelInfo,
	}

	// Check if the model supports images for read_file tool description.
	const supportsImages = modelInfo?.supportsImages ?? false

	// Build native tools with dynamic read_file tool based on settings.
	const nativeTools = getNativeTools({
		supportsImages,
		availableBrowserToolNames: getAvailableVSCodeBrowserToolNames(),
		taskKind,
		agentKinds: mode === planModeSlug ? ["explore", "review"] : undefined,
		planMode: mode === planModeSlug,
	})
	// Managed child lanes provide a frozen authority allow-list. Retain only the
	// orchestration schemas explicitly granted there; report_progress is the one
	// host-safe upward capability added to legacy managed-child grants by Task.
	const explicitlyAllowedTools = allowedToolNames
		? new Set(allowedToolNames.map((name) => resolveToolAlias(name)))
		: undefined
	const taskNativeTools = nativeTools.filter((tool) => {
		const name = getToolName(tool)
		if (explicitlyAllowedTools) {
			return !CHILD_SCOPED_AGENT_TOOLS.has(name) || explicitlyAllowedTools.has(name)
		}
		// Upward progress reporting is meaningful only for a managed child. Keep a
		// stable primary lifecycle catalog so transcript compaction or reload cannot
		// hide controls for descendants and mailbox state retained by the host.
		if (name === "report_progress") return false
		if (AGENT_LIFECYCLE_TOOLS.has(name)) return enableAgentLifecycleTools
		return true
	})

	// Filter native tools based on mode restrictions.
	const filteredNativeTools = filterNativeToolsForMode(
		taskNativeTools,
		mode,
		customModes,
		experiments,
		codeIndexManager,
		filterSettings,
		mcpHub,
	)

	// Filter MCP tools based on mode restrictions.
	const mcpTools = getMcpServerTools(mcpHub)
	const filteredMcpTools = filterMcpToolsForMode(mcpTools, mode, customModes, experiments)

	// Add custom tools if they are available and the experiment is enabled.
	let nativeCustomTools: OpenAI.Chat.ChatCompletionFunctionTool[] = []

	if (experiments?.customTools && mode !== planModeSlug) {
		const toolDirs = getRooDirectoriesForCwd(cwd).map((dir) => path.join(dir, "tools"))
		await customToolRegistry.loadFromDirectoriesIfStale(toolDirs)
		const customTools = customToolRegistry.getAllSerialized()

		if (customTools.length > 0) {
			nativeCustomTools = customTools.map(formatNative)
		}
	}

	// Combine filtered tools (for backward compatibility and for allowedFunctionNames)
	const taskAllowedNames = allowedToolNames
		? new Set(allowedToolNames.map((name) => resolveToolAlias(name)))
		: undefined
	const filteredTools = [...filteredNativeTools, ...filteredMcpTools, ...nativeCustomTools].filter(
		(tool) => !taskAllowedNames || taskAllowedNames.has(resolveToolAlias(getToolName(tool)) as ToolName),
	)

	// If includeAllToolsWithRestrictions is true, return ALL tools but provide
	// allowed names based on mode filtering
	if (includeAllToolsWithRestrictions) {
		// Combine ALL tools (unfiltered native + all MCP + custom)
		const allTools = [...taskNativeTools, ...mcpTools, ...nativeCustomTools]

		// Extract names of tools that are allowed based on mode filtering.
		// Resolve any alias names to canonical names to ensure consistency with allTools
		// (which uses canonical names). This prevents Gemini errors when tools are renamed
		// to aliases in filteredTools but allTools contains the original canonical names.
		const allowedFunctionNames = filteredTools.map((tool) => resolveToolAlias(getToolName(tool)))

		const surface = createCapturedToolSurface({
			options,
			disabledTools,
			registry: createToolRegistry(taskNativeTools, mcpTools, nativeCustomTools),
			schemas: allTools,
			allowedFunctionNames,
			includeAllToolsWithRestrictions: true,
		})
		return {
			tools: allTools,
			allowedFunctionNames,
			registry: surface.registry,
			schemas: [...surface.schemas],
			policy: surface.policy,
			digest: surface.digest,
			surface,
		}
	}

	// Default behavior: return only filtered tools
	const surface = createCapturedToolSurface({
		options,
		disabledTools,
		registry: createToolRegistry(taskNativeTools, mcpTools, nativeCustomTools),
		schemas: filteredTools,
		allowedFunctionNames: filteredTools.map((tool) => resolveToolAlias(getToolName(tool))),
		includeAllToolsWithRestrictions: false,
	})
	return {
		tools: filteredTools,
		registry: surface.registry,
		schemas: [...surface.schemas],
		policy: surface.policy,
		digest: surface.digest,
		surface,
	}
}

function createToolRegistry(
	nativeTools: readonly OpenAI.Chat.ChatCompletionTool[],
	mcpTools: readonly OpenAI.Chat.ChatCompletionTool[],
	nativeCustomTools: readonly OpenAI.Chat.ChatCompletionTool[],
): ToolRegistry {
	return new ToolRegistry({
		nativeTools,
		mcpTools,
		// Custom schemas are loaded into the shared registry before capture. The
		// registry reads the same serialized definitions used by the provider.
		includeCustomTools: nativeCustomTools.length > 0,
	})
}

function createCapturedToolSurface(input: {
	options: BuildToolsOptions
	disabledTools: readonly string[]
	registry: ToolRegistry
	schemas: readonly OpenAI.Chat.ChatCompletionTool[]
	allowedFunctionNames: readonly string[]
	includeAllToolsWithRestrictions: boolean
}): TaskToolSurface {
	const { options, disabledTools, registry, schemas, allowedFunctionNames, includeAllToolsWithRestrictions } = input
	return captureTaskToolSurface({
		registry,
		schemas,
		visibleToolNames: schemas
			.filter((tool): tool is OpenAI.Chat.ChatCompletionFunctionTool => tool.type === "function")
			.map((tool) => resolveToolAlias(tool.function.name)),
		allowedToolNames: allowedFunctionNames,
		disabledTools,
		policy: options.policy,
		autoApprovalEnabled: options.autoApprovalEnabled,
		mode: options.mode,
		cwd: options.cwd,
		includeAllToolsWithRestrictions,
		// `filterNativeToolsForMode` already applied legacy mode, task authority,
		// lifecycle, and feature restrictions exactly once. The compatibility
		// surface only captures that result and must not narrow it a second time.
		applyProfile: false,
	})
}

/** Build the unified registry/schema/policy capture for a provider request. */
export async function buildTaskToolSurface(options: BuildToolsOptions): Promise<TaskToolSurface> {
	const result = await buildToolCatalog(options)
	if (!result.surface) {
		throw new Error("Tool catalog did not produce a unified task surface.")
	}
	return result.surface
}

/**
 * Backwards-compatible wrapper retaining the historical `{ tools, allowedFunctionNames }`
 * shape while exposing the unified capture fields for newer callers.
 */
export async function buildNativeToolsArrayWithRestrictions(options: BuildToolsOptions): Promise<BuildToolsResult> {
	return buildToolCatalog(options)
}
