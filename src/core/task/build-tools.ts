import path from "path"

import type OpenAI from "openai"

import type { ProviderSettings, ModeConfig, ModelInfo, ToolName, McpServer } from "@alpha-code/types"
import { customToolRegistry, formatNative } from "@alpha-code/core"

import type { ClineProvider } from "../webview/ClineProvider"
import { getRooDirectoriesForCwd } from "../../services/roo-config/index.js"
import { getAvailableVSCodeBrowserToolNames } from "../../services/browser/VSCodeBrowserTools"
import { planModeSlug } from "../../shared/modes"

import { getNativeTools } from "../prompts/tools/native-tools"
import { buildMcpServerTools } from "../prompts/tools/native-tools/mcp_server"
import { discoverTools } from "../prompts/tools/native-tools/discover_tools"
import {
	filterNativeToolsForMode,
	filterMcpToolsForMode,
	resolveToolAlias,
} from "../prompts/tools/filter-tools-for-mode"
import { buildTaskToolSurface as captureTaskToolSurface, type TaskToolSurface } from "../tools/TaskToolSurface"
import { canonicalizeToolName, ToolRegistry, type ToolRegistryOptions } from "../tools/ToolRegistry"
import type { ToolPolicySnapshot } from "../agent/ToolPolicy"
import { digestValue } from "../agent/StepContext"
import type { ApiMessage } from "../task-persistence/apiMessages"
import type { McpHub } from "../../services/mcp/McpHub"
import { buildMcpToolName } from "../../utils/mcp-name"
import { DISCOVERY_OUTPUT_LIMIT, type DiscoverTools, type TaskToolCatalogCache } from "./TaskToolCatalogCache"

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
	/** Task-owned cache, used only at a real new step boundary (never during a transport retry). */
	catalogCache?: TaskToolCatalogCache
	/** Existing persisted call/result transactions; text alone cannot promote a deferred tool. */
	discoveryHistory?: readonly ApiMessage[]
	/** Cancels this caller's wait without cancelling shared custom-tool loading. */
	signal?: AbortSignal
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

// Bump when native schemas or provider projection rules change. Dynamic schemas are fingerprinted below.
const TOOL_CATALOG_SCHEMA_VERSION = 1

const orderedNames = (names: readonly string[] | undefined) =>
	names ? [...new Set(names.map(canonicalizeToolName))].sort() : undefined

async function awaitCatalogInput<T>(input: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return input
	let onAbort!: () => void
	try {
		return await new Promise<T>((resolve, reject) => {
			onAbort = () => reject(signal.reason)
			signal.addEventListener("abort", onAbort, { once: true })
			// Observe both late outcomes even when cancellation has already settled this caller.
			input.then(resolve, reject)
			if (signal.aborted) onAbort()
		})
	} finally {
		signal.removeEventListener("abort", onAbort)
	}
}

function connectionFor(mcpHub: McpHub | undefined, server: McpServer) {
	return mcpHub?.connections?.find((connection) => connection.server === server)
}

function serverState(servers: readonly McpServer[], mcpHub?: McpHub, cache?: TaskToolCatalogCache) {
	return servers.map((server) => {
		const connection = connectionFor(mcpHub, server)
		return {
			name: server.name,
			source: server.source,
			status: server.status,
			disabled: server.disabled === true,
			connection: connection && cache ? cache.identity(connection) : undefined,
			client: connection?.client && cache ? cache.identity(connection.client) : undefined,
			tools: server.tools
				? [...server.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
				: [],
			hasResources: (server.resources?.length ?? 0) > 0,
		}
	})
}

function captureMcpAvailability(
	provider: ClineProvider,
	servers: readonly McpServer[],
	mcpHub: McpHub | undefined,
	schemas: readonly OpenAI.Chat.ChatCompletionTool[],
) {
	const schemasByName = new Map(
		schemas.filter((schema) => schema.type === "function").map((schema) => [schema.function.name, schema]),
	)
	const captured = new Map<
		string,
		{
			serverName: string
			toolName: string
			source: McpServer["source"]
			connection: ReturnType<typeof connectionFor>
			client: unknown
			schemaDigest: string
		}
	>()
	for (const server of servers) {
		if (server.status !== "connected" || server.disabled) continue
		const connection = connectionFor(mcpHub, server)
		for (const tool of [...(server.tools ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const name = canonicalizeToolName(buildMcpToolName(server.name, tool.name))
			const schema = schemasByName.get(name)
			if (!schema || tool.enabledForPrompt === false || captured.has(name)) continue
			captured.set(name, {
				serverName: server.name,
				toolName: tool.name,
				source: server.source,
				connection,
				client: connection?.client,
				schemaDigest: digestValue(schema),
			})
		}
	}
	const isCurrent: NonNullable<ToolRegistryOptions["isMcpToolCurrent"]> = (
		name,
		dispatchedServerName,
		dispatchedToolName,
		dispatchedSource,
	) => {
		const expected = captured.get(name)
		if (!expected) return false
		if (
			dispatchedServerName !== undefined &&
			(dispatchedServerName !== expected.serverName ||
				dispatchedToolName !== expected.toolName ||
				dispatchedSource !== expected.source)
		)
			return false
		try {
			if (!mcpHub || provider.getMcpHub() !== mcpHub) return false
			const server = mcpHub
				.getServers()
				.find((item) => item.name === expected.serverName && item.source === expected.source)
			if (!server || server.disabled || server.status !== "connected") return false
			const connection = connectionFor(mcpHub, server)
			if (connection !== expected.connection || connection?.client !== expected.client) return false
			const tool = server.tools?.find(
				(item) => item.name === expected.toolName && item.enabledForPrompt !== false,
			)
			if (!tool) return false
			const schema = buildMcpServerTools([{ ...server, tools: [tool] }])[0]
			return !!schema && digestValue(schema) === expected.schemaDigest
		} catch {
			return false
		}
	}
	return { targets: captured, isCurrent }
}

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
	options.signal?.throwIfAborted()
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
	const disabledTools = orderedNames([...(requestedDisabledTools ?? []), ...(options.policy?.disabledTools ?? [])])!

	// Get CodeIndexManager for feature checking.
	const { CodeIndexManager } = await awaitCatalogInput(import("../../services/code-index/manager"), options.signal)
	options.signal?.throwIfAborted()
	const codeIndexManager = CodeIndexManager.getInstance(provider.context, cwd)
	let customTools: NonNullable<ToolRegistryOptions["customTools"]> = []
	if (experiments?.customTools && mode !== planModeSlug) {
		const toolDirs = getRooDirectoriesForCwd(cwd).map((dir) => path.join(dir, "tools"))
		await awaitCatalogInput(customToolRegistry.loadFromDirectoriesIfStale(toolDirs), options.signal)
		options.signal?.throwIfAborted()
		const serialized = new Map(customToolRegistry.getAllSerialized().map((tool) => [tool.name, tool]))
		customTools = customToolRegistry
			.getAll()
			.flatMap((definition) => {
				const schema = serialized.get(definition.name)
				return schema ? [{ definition, schema: formatNative(schema) }] : []
			})
			.sort((a, b) =>
				a.definition.name < b.definition.name ? -1 : a.definition.name > b.definition.name ? 1 : 0,
			)
	}
	// All live reads precede this synchronous capture. No await may split key construction from its factory.
	const mcpHub = provider.getMcpHub()
	const servers = [...(mcpHub?.getServers() ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	const availableBrowserToolNames = [...getAvailableVSCodeBrowserToolNames()].sort()
	const cache = options.catalogCache
	const providerName = apiConfiguration?.apiProvider
	const canDiscover =
		!!cache &&
		!includeAllToolsWithRestrictions &&
		providerName !== "gemini" &&
		providerName !== "vertex" &&
		providerName !== "vscode-lm"
	const key = cache
		? digestValue({
				schemaVersion: TOOL_CATALOG_SCHEMA_VERSION,
				provider: cache.identity(provider),
				mcpHub: mcpHub ? cache.identity(mcpHub) : undefined,
				providerTransformation: providerName,
				includeAllToolsWithRestrictions: includeAllToolsWithRestrictions === true,
				canDiscover,
				cwd,
				mode,
				customModes,
				experiments,
				disabledTools,
				allowedToolNames: orderedNames(allowedToolNames),
				taskKind,
				enableAgentLifecycleTools,
				todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
				modelSchema: {
					supportsImages: modelInfo?.supportsImages ?? false,
					includedTools: orderedNames(modelInfo?.includedTools),
					excludedTools: orderedNames(modelInfo?.excludedTools),
				},
				autoApprovalEnabled: options.autoApprovalEnabled,
				policy: options.policy,
				availableBrowserToolNames,
				codeIndex: [
					codeIndexManager?.isFeatureEnabled,
					codeIndexManager?.isFeatureConfigured,
					codeIndexManager?.isInitialized,
				],
				servers: serverState(servers, mcpHub, cache),
				customTools: customTools.map(({ definition, schema }) => ({
					schema,
					execute: cache.identity(definition.execute),
					parameters: definition.parameters ? cache.identity(definition.parameters) : undefined,
				})),
			})
		: ""

	const build = (discover?: DiscoverTools): TaskToolSurface => {
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
			availableBrowserToolNames,
			taskKind,
			agentKinds: mode === planModeSlug ? ["explore", "review"] : undefined,
			planMode: mode === planModeSlug,
		})
		// Restricted provider supersets retain definitions used by earlier ordinary-provider history.
		if (canDiscover || includeAllToolsWithRestrictions) nativeTools.push(discoverTools)
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
		).filter((tool) => canDiscover || getToolName(tool) !== "discover_tools")

		// Filter MCP tools based on mode restrictions.
		const mcpTools = buildMcpServerTools(servers, includeAllToolsWithRestrictions)
		const connectedMcpTools = includeAllToolsWithRestrictions ? buildMcpServerTools(servers) : mcpTools
		const filteredMcpTools = disabledTools.includes("use_mcp_tool")
			? []
			: filterMcpToolsForMode(connectedMcpTools, mode, customModes, experiments)
		const nativeCustomTools = customTools.map((tool) => tool.schema)

		// Combine filtered tools (for backward compatibility and for allowedFunctionNames)
		const taskAllowedNames = allowedToolNames ? new Set(allowedToolNames.map(canonicalizeToolName)) : undefined
		const filteredTools = [...filteredNativeTools, ...filteredMcpTools, ...nativeCustomTools].filter(
			(tool) => !taskAllowedNames || taskAllowedNames.has(canonicalizeToolName(getToolName(tool))),
		)
		const mcpCapture = captureMcpAvailability(provider, servers, mcpHub, connectedMcpTools)
		const registry = new ToolRegistry({
			nativeTools: taskNativeTools,
			mcpTools,
			customTools,
			mcpToolTargets: mcpCapture.targets,
			isMcpToolCurrent: mcpCapture.isCurrent,
			...(canDiscover && discover
				? { discovery: { execute: discover, maxOutputChars: DISCOVERY_OUTPUT_LIMIT } }
				: {}),
		})

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

			return createCapturedToolSurface({
				options,
				disabledTools,
				registry,
				schemas: allTools,
				allowedFunctionNames,
				includeAllToolsWithRestrictions: true,
			})
		}

		// Default behavior: return only filtered tools
		return createCapturedToolSurface({
			options,
			disabledTools,
			registry,
			schemas: filteredTools,
			allowedFunctionNames: filteredTools.map((tool) => resolveToolAlias(getToolName(tool))),
			includeAllToolsWithRestrictions: false,
		})
	}
	const surface = cache ? cache.capture(key, build, options.discoveryHistory) : build()
	return {
		tools: [...surface.schemas],
		...(surface.includeAllToolsWithRestrictions ? { allowedFunctionNames: [...surface.allowedFunctionNames] } : {}),
		registry: surface.registry,
		schemas: [...surface.schemas],
		policy: surface.policy,
		digest: surface.digest,
		surface,
	}
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
