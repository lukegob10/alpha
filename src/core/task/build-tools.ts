import path from "path"

import type OpenAI from "openai"

import {
	openAiModelInfoSaneDefaults,
	restoreTaskMode,
	type ProviderSettings,
	type ModeConfig,
	type ModelInfo,
	type ApprovalMode,
	type ToolName,
	type McpServer,
} from "@alpha-code/types"
import { customToolRegistry, formatNative } from "@alpha-code/core"

import type { AlphaProvider } from "../webview/AlphaProvider"
import { getLegacyConfigDirectoriesForCwd } from "../../services/config-paths/index.js"
import { getAvailableVSCodeBrowserToolNames } from "../../services/browser/VSCodeBrowserTools"
import { planModeSlug } from "../../shared/modes"

import { getNativeTools } from "../prompts/tools/native-tools"
import { buildMcpServerTools } from "../prompts/tools/native-tools/mcp_server"
import { discoverTools, toolSearch } from "../prompts/tools/native-tools/discover_tools"
import {
	filterNativeToolsForMode,
	filterMcpToolsForMode,
	resolveToolAlias,
} from "../prompts/tools/filter-tools-for-mode"
import { buildTaskToolSurface as captureTaskToolSurface, type TaskToolSurface } from "../tools/TaskToolSurface"
import { canonicalizeToolName, ToolRegistry, type ToolRegistryOptions, type TaskReadGrant } from "../tools/ToolRegistry"
import type { ToolPolicySnapshot } from "../agent/ToolPolicy"
import { digestValue } from "../agent/StepContext"
import { classifyRequestWorkClass, type RequestWorkClassDecision } from "../agent/requestWorkClass"
import { isExplicitIndependentTaskRequest } from "../agent/independentTaskAuthorization"
import {
	requestWorkClassCacheKey,
	resolveLookupToolNames,
	toolNamesReferencedInHistory,
} from "../agent/lookupToolCatalog"
import type { ApiMessage } from "../task-persistence/apiMessages"
import type { McpHub } from "../../services/mcp/McpHub"
import { buildMcpToolName } from "../../utils/mcp-name"
import { DISCOVERY_OUTPUT_LIMIT, type ToolSearch, type TaskToolCatalogCache } from "./TaskToolCatalogCache"
import { availableCustomTools } from "./customToolCatalog"
import {
	applyModelToolPreferences,
	getModelSurgicalEditTool,
	type ModelToolIdentity,
} from "../../api/providers/utils/router-tool-preferences"

export interface BuildToolsOptions {
	provider: AlphaProvider
	cwd: string
	mode: string | undefined
	customModes: ModeConfig[] | undefined
	experiments: Record<string, boolean> | undefined
	apiConfiguration: ProviderSettings | undefined
	disabledTools?: string[]
	modelInfo?: ModelInfo
	/** Resolved provider/model identity used to gate host-specific schemas. */
	modelIdentity?: ModelToolIdentity
	/**
	 * If true, returns a history-compatible schema superset plus allowedFunctionNames.
	 * Lookup steps still omit unused workflow names so Vertex/Gemini cannot see them.
	 */
	includeAllToolsWithRestrictions?: boolean
	/** Optional task-lane authority cap applied after mode filtering. */
	allowedToolNames?: readonly ToolName[]
	/** Selects role-specific schemas for primary and managed-child tasks. */
	taskKind?: "primary" | "subagent"
	/** Restricts the task to the host-owned diagnostic evidence reader. */
	diagnosticSession?: boolean
	diagnosticSourceTaskId?: string
	/** Stable primary-task lifecycle catalog; managed children remain allow-list constrained. */
	enableAgentLifecycleTools?: boolean
	/** Root tasks control direct children; an independent child can only message its recorded parent. */
	crossTaskRole?: "root" | "child" | "none"
	/** Optional caller policy values used when exposing the unified surface. */
	policy?: ToolPolicySnapshot
	approvalMode?: ApprovalMode
	autoApprovalEnabled?: boolean
	readGrant?: TaskReadGrant
	/** Task-owned cache, used only at a real new step boundary (never during a transport retry). */
	catalogCache?: TaskToolCatalogCache
	/** Existing persisted call/result transactions; text alone cannot promote a deferred tool. */
	discoveryHistory?: readonly ApiMessage[]
	/** Cancels this caller's wait without cancelling shared custom-tool loading. */
	signal?: AbortSignal
	/**
	 * Latest user request text used to classify lookup vs full catalogs.
	 * Uncertain or omitted text keeps the full authorized surface.
	 */
	userRequestText?: string
}

export interface BuildToolsResult {
	/**
	 * The tools to pass to the model.
	 * Provider-facing schemas. Restricted providers send a history-compatible
	 * superset; lookup steps still omit unused workflow names.
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

function historyContainsToolName(history: readonly ApiMessage[] | undefined, name: string): boolean {
	return (
		history?.some(
			(message) =>
				message.role === "assistant" &&
				Array.isArray(message.content) &&
				message.content.some(
					(block) =>
						!!block &&
						typeof block === "object" &&
						"type" in block &&
						block.type === "tool_use" &&
						"name" in block &&
						block.name === name,
				),
		) ?? false
	)
}

const AGENT_LIFECYCLE_TOOLS = new Set(["list_agents", "wait_agent", "send_message", "followup_task", "interrupt_agent"])

const CHILD_SCOPED_AGENT_TOOLS = new Set(["spawn_agent", ...AGENT_LIFECYCLE_TOOLS])

// Bump when native schemas or provider projection rules change. Dynamic schemas are fingerprinted below.
const TOOL_CATALOG_SCHEMA_VERSION = 14

const ASYNC_USER_INPUT_CATALOG_NAMES = new Set(["request_user_input_async", "send_user_message_async"])

function supportsAsyncUserInput(modelInfo: ModelInfo | undefined): boolean {
	return modelInfo?.experimental_supported_tools?.some((name) => ASYNC_USER_INPUT_CATALOG_NAMES.has(name)) ?? false
}

const orderedNames = (names: readonly string[] | undefined) =>
	names ? [...new Set(names.map(canonicalizeToolName))].sort() : undefined

export function createModelToolIdentity(
	apiConfiguration: ProviderSettings | undefined,
	model: { id: string; toolIdentity?: ModelToolIdentity },
): ModelToolIdentity {
	if (model.toolIdentity) return model.toolIdentity
	return {
		provider: apiConfiguration?.apiProvider,
		id: model.id,
	}
}

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

const MCP_TOOL_ANNOTATION_KEYS = new Set([
	"title",
	"audience",
	"priority",
	"lastModified",
	"readOnlyHint",
	"destructiveHint",
	"idempotentHint",
	"openWorldHint",
])

function isMcpReadOnlyHint(annotations: unknown): boolean {
	if (!annotations || typeof annotations !== "object" || Array.isArray(annotations)) return false
	const values = annotations as Record<string, unknown>
	if (Object.keys(values).some((key) => !MCP_TOOL_ANNOTATION_KEYS.has(key))) return false
	if (values.title !== undefined && typeof values.title !== "string") return false
	if (
		values.audience !== undefined &&
		(!Array.isArray(values.audience) || values.audience.some((item) => item !== "user" && item !== "assistant"))
	)
		return false
	if (values.priority !== undefined && (typeof values.priority !== "number" || !Number.isFinite(values.priority)))
		return false
	if (values.lastModified !== undefined && typeof values.lastModified !== "string") return false
	if (
		["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].some(
			(key) => values[key] !== undefined && typeof values[key] !== "boolean",
		)
	)
		return false
	return values.readOnlyHint === true && values.destructiveHint !== true
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
	provider: AlphaProvider,
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
			parallelRead: boolean
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
				parallelRead: isMcpReadOnlyHint(tool.annotations),
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
			return (
				!!schema &&
				digestValue(schema) === expected.schemaDigest &&
				isMcpReadOnlyHint(tool.annotations) === expected.parallelRead
			)
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
		modelInfo: rawModelInfo,
		includeAllToolsWithRestrictions: requestedIncludeAllToolsWithRestrictions,
		allowedToolNames,
		taskKind = "primary",
		enableAgentLifecycleTools = taskKind === "primary",
		crossTaskRole = "none",
	} = options
	const diagnosticSession = options.diagnosticSession === true
	const includeAllToolsWithRestrictions = !diagnosticSession && requestedIncludeAllToolsWithRestrictions === true
	const modelIdentity = options.modelIdentity ?? { provider: apiConfiguration?.apiProvider }
	const modelPreference = getModelSurgicalEditTool(modelIdentity)
	const modelInfo = rawModelInfo
		? applyModelToolPreferences(modelIdentity, rawModelInfo)
		: modelPreference === "apply_patch"
			? applyModelToolPreferences(modelIdentity, openAiModelInfoSaneDefaults)
			: undefined
	const catalogModelInfo: ModelInfo | undefined =
		restoreTaskMode(mode) === "code"
			? {
					...(modelInfo ?? openAiModelInfoSaneDefaults),
					// Supply required metadata while preserving no-model-info image behavior.
					supportsImages: modelInfo?.supportsImages ?? false,
					includedTools: [
						...new Set([
							...(modelInfo?.includedTools ?? []).filter(
								(name) => canonicalizeToolName(name) !== "apply_patch",
							),
							"apply_patch",
						]),
					],
					excludedTools: modelInfo?.excludedTools?.filter(
						(name) => canonicalizeToolName(name) !== "apply_patch",
					),
				}
			: modelInfo
	const disabledTools = orderedNames([...(requestedDisabledTools ?? []), ...(options.policy?.disabledTools ?? [])])!
	const requestWorkClass = requestWorkClassCacheKey(options.userRequestText, taskKind)
	const allowIndependentTaskCreation =
		!diagnosticSession && crossTaskRole === "root" && isExplicitIndependentTaskRequest(options.userRequestText)
	const retainHistoricalCreateTaskSchema =
		includeAllToolsWithRestrictions === true && historyContainsToolName(options.discoveryHistory, "create_task")

	const codeIndexManager = diagnosticSession
		? undefined
		: await (async () => {
				const { CodeIndexManager } = await awaitCatalogInput(
					import("../../services/code-index/manager"),
					options.signal,
				)
				options.signal?.throwIfAborted()
				return CodeIndexManager.getInstance(provider.context, cwd)
			})()
	let customTools: NonNullable<ToolRegistryOptions["customTools"]> = []
	if (!diagnosticSession && experiments?.customTools && mode !== planModeSlug) {
		const toolDirs = getLegacyConfigDirectoriesForCwd(cwd).map((dir) => path.join(dir, "tools"))
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
	customTools = availableCustomTools(customTools)
	// All live reads precede this synchronous capture. No await may split key construction from its factory.
	const mcpHub = diagnosticSession ? undefined : provider.getMcpHub()
	const servers = diagnosticSession
		? []
		: [...(mcpHub?.getServers() ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	const availableBrowserToolNames = diagnosticSession ? [] : [...getAvailableVSCodeBrowserToolNames()].sort()
	const namedAgentTypes = diagnosticSession
		? []
		: Object.entries(provider.contextProxy?.getValues?.().subagentAgentTypes ?? {})
				.map(([name, definition]) => ({ name, description: definition.description }))
				.sort((a, b) => a.name.localeCompare(b.name))
	const cache = options.catalogCache
	const providerName = apiConfiguration?.apiProvider
	const canDiscover =
		!diagnosticSession &&
		!!cache &&
		!includeAllToolsWithRestrictions &&
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
				diagnosticSession,
				diagnosticSourceTaskId: options.diagnosticSourceTaskId,
				enableAgentLifecycleTools,
				crossTaskRole,
				allowIndependentTaskCreation,
				retainHistoricalCreateTaskSchema,
				namedAgentTypes,
				todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
				modelSchema: {
					supportsImages: catalogModelInfo?.supportsImages ?? false,
					includedTools: orderedNames(catalogModelInfo?.includedTools),
					excludedTools: orderedNames(catalogModelInfo?.excludedTools),
					experimentalSupportedTools: orderedNames(catalogModelInfo?.experimental_supported_tools),
				},
				modelIdentity,
				modelPreference,
				approvalMode: options.approvalMode,
				autoApprovalEnabled: options.autoApprovalEnabled,
				readGrant: options.readGrant,
				policy: options.policy,
				requestWorkClass,
				historicalToolNames: includeAllToolsWithRestrictions
					? toolNamesReferencedInHistory(options.discoveryHistory)
					: undefined,
				legacyDiscoverToolsInHistory: historyContainsToolName(options.discoveryHistory, "discover_tools"),
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

	const build = (search?: ToolSearch): TaskToolSurface => {
		// Build settings object for tool filtering.
		const filterSettings = {
			todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
			disabledTools,
			modelInfo: catalogModelInfo,
		}

		// Check if the model supports images for read_file tool description.
		const supportsImages = catalogModelInfo?.supportsImages ?? false

		// Build native tools with dynamic read_file tool based on settings.
		const nativeTools = getNativeTools({
			diagnosticSession,
			supportsImages,
			availableBrowserToolNames,
			taskKind,
			mcpResourcesAvailable: servers.length > 0,
			includeLegacyMcpResource:
				includeAllToolsWithRestrictions === true &&
				historyContainsToolName(options.discoveryHistory, "access_mcp_resource"),
			crossTaskRole,
			includeCreateTaskSchema: allowIndependentTaskCreation || retainHistoricalCreateTaskSchema,
			agentKinds: mode === planModeSlug ? ["explore", "review"] : undefined,
			namedAgentTypes,
			planMode: mode === planModeSlug,
			includeRequestUserInputAsync: taskKind === "primary" && supportsAsyncUserInput(catalogModelInfo),
		})
		// Restricted provider supersets retain discovery definitions only when saved history requires them.
		const legacyDiscoveryInHistory = historyContainsToolName(options.discoveryHistory, "discover_tools")
		const discoveryInHistory =
			legacyDiscoveryInHistory || historyContainsToolName(options.discoveryHistory, "tool_search")
		if (!diagnosticSession && (canDiscover || (includeAllToolsWithRestrictions && discoveryInHistory)))
			nativeTools.push(toolSearch)
		if (!diagnosticSession && legacyDiscoveryInHistory) nativeTools.push(discoverTools)
		// Managed child lanes provide a frozen authority allow-list. Retain only the
		// orchestration schemas explicitly granted there.
		const explicitlyAllowedTools = allowedToolNames
			? new Set(allowedToolNames.map((name) => resolveToolAlias(name)))
			: undefined
		const taskNativeTools = nativeTools.filter((tool) => {
			const name = getToolName(tool)
			if (explicitlyAllowedTools) {
				return !CHILD_SCOPED_AGENT_TOOLS.has(name) || explicitlyAllowedTools.has(name)
			}
			// Keep a stable primary lifecycle catalog so transcript compaction or reload cannot
			// hide controls for descendants and mailbox state retained by the host.
			if (AGENT_LIFECYCLE_TOOLS.has(name)) return enableAgentLifecycleTools
			return true
		})
		// Filter native tools based on mode restrictions.
		const modeFilteredNativeTools = (
			diagnosticSession
				? taskNativeTools
				: filterNativeToolsForMode(
						taskNativeTools,
						mode,
						customModes,
						experiments,
						codeIndexManager,
						filterSettings,
						mcpHub,
					)
		).filter((tool) => {
			const name = getToolName(tool)
			return (
				(name !== "create_task" || allowIndependentTaskCreation) &&
				name !== "access_mcp_resource" &&
				(canDiscover || (name !== "tool_search" && name !== "discover_tools"))
			)
		})
		const filteredNativeTools = [
			...modeFilteredNativeTools,
			...(canDiscover && historyContainsToolName(options.discoveryHistory, "discover_tools")
				? [discoverTools]
				: []),
		]

		// Filter MCP tools based on mode restrictions.
		const mcpTools = buildMcpServerTools(servers, includeAllToolsWithRestrictions)
		const connectedMcpTools = includeAllToolsWithRestrictions ? buildMcpServerTools(servers) : mcpTools
		const filteredMcpTools = disabledTools.includes("use_mcp_tool")
			? []
			: filterMcpToolsForMode(connectedMcpTools, mode, customModes, experiments)
		const nativeCustomTools = customTools.map((tool) => tool.schema)

		// Combine filtered native, MCP, and custom tools into one captured surface.
		const taskAllowedNames = allowedToolNames ? new Set(allowedToolNames.map(canonicalizeToolName)) : undefined
		const requestClass: RequestWorkClassDecision = diagnosticSession
			? {
					class: "full",
					reason: "uncertain",
					includeSkill: false,
					includeTickets: false,
					includeMcpResources: false,
				}
			: classifyRequestWorkClass(options.userRequestText, { taskKind })
		const filteredTools = applyLookupCatalogNarrowing(
			[...filteredNativeTools, ...filteredMcpTools, ...nativeCustomTools].filter(
				(tool) => !taskAllowedNames || taskAllowedNames.has(canonicalizeToolName(getToolName(tool))),
			),
			requestClass,
		)
		const mcpCapture = captureMcpAvailability(provider, servers, mcpHub, connectedMcpTools)
		const registry = new ToolRegistry({
			nativeTools: taskNativeTools,
			mcpTools,
			customTools,
			mcpToolTargets: mcpCapture.targets,
			isMcpToolCurrent: mcpCapture.isCurrent,
			...(canDiscover && search
				? { discovery: { execute: search, maxOutputChars: DISCOVERY_OUTPUT_LIMIT } }
				: {}),
		})

		// Restricted providers keep historical declarations callable-only via
		// allowedFunctionNames. Lookup steps still omit unused workflow names.
		if (includeAllToolsWithRestrictions) {
			const allTools = [...taskNativeTools, ...mcpTools, ...nativeCustomTools]
			const allowedFunctionNames = filteredTools.map((tool) => resolveToolAlias(getToolName(tool)))

			return createCapturedToolSurface({
				options,
				disabledTools,
				registry,
				schemas: advertiseRestrictedCatalog(allTools, filteredTools, requestClass, options.discoveryHistory),
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
		...(surface.includeAllToolsWithRestrictions
			? { allowedFunctionNames: getProviderAllowedFunctionNames(surface) }
			: {}),
		registry: surface.registry,
		schemas: [...surface.schemas],
		policy: surface.policy,
		digest: surface.digest,
		surface,
	}
}

function applyLookupCatalogNarrowing(
	tools: OpenAI.Chat.ChatCompletionTool[],
	decision: RequestWorkClassDecision,
): OpenAI.Chat.ChatCompletionTool[] {
	const allowed = resolveLookupToolNames(decision)
	if (!allowed) return tools
	return tools.filter((tool) => allowed.has(canonicalizeToolName(getToolName(tool))))
}

function advertiseRestrictedCatalog(
	allTools: OpenAI.Chat.ChatCompletionTool[],
	filteredTools: OpenAI.Chat.ChatCompletionTool[],
	decision: RequestWorkClassDecision,
	history: readonly ApiMessage[] | undefined,
): OpenAI.Chat.ChatCompletionTool[] {
	if (decision.class !== "lookup") return allTools
	const advertised = new Set(filteredTools.map((tool) => canonicalizeToolName(getToolName(tool))))
	for (const name of toolNamesReferencedInHistory(history)) advertised.add(name)
	return allTools.filter((tool) => advertised.has(canonicalizeToolName(getToolName(tool))))
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
		approvalMode: options.approvalMode,
		autoApprovalEnabled: options.autoApprovalEnabled,
		readGrant: options.readGrant,
		diagnosticSession: options.diagnosticSession,
		diagnosticSourceTaskId: options.diagnosticSourceTaskId,
		mode: options.mode,
		cwd: options.cwd,
		taskKind: options.taskKind ?? "primary",
		includeAllToolsWithRestrictions,
		// `filterNativeToolsForMode` already applied legacy mode, task authority,
		// lifecycle, and feature restrictions exactly once. The compatibility
		// surface only captures that result and must not narrow it a second time.
		applyProfile: false,
	})
}

/** Match provider function allow-lists to the exact names in the captured schema catalog. */
function getProviderAllowedFunctionNames(surface: TaskToolSurface): string[] {
	const schemaNamesByCanonical = new Map<string, string>()
	for (const schema of surface.schemas) {
		if (schema.type !== "function") continue
		const name = schema.function.name
		const canonical = canonicalizeToolName(name)
		const preferred = canonical
		const existing = schemaNamesByCanonical.get(canonical)
		if (!existing || (name === preferred && existing !== preferred)) schemaNamesByCanonical.set(canonical, name)
	}
	return surface.allowedFunctionNames.map((name) => schemaNamesByCanonical.get(canonicalizeToolName(name)) ?? name)
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
