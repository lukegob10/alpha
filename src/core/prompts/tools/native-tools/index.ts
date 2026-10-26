import { ticketTools } from "./tickets"
import type OpenAI from "openai"
import accessMcpResource from "./access_mcp_resource"
import { mcpResourceTools } from "./mcp_resources"
import readDiagnosticEvidence from "./read_diagnostic_evidence"
import applyPatch from "./apply_patch"
import requestUserInput from "./request_user_input"
import requestUserInputAsync from "./request_user_input_async"
import codebaseSearch from "./codebase_search"
import { createExecCommandTool } from "./execute_command"
import { browserTools } from "./browser"
import listFiles from "./list_files"
import type { ManagedAgentKind } from "./delegate_task"
import { createSpawnAgentTool } from "./spawn_agent"
import { list_agents as listAgents } from "./list_agents"
import { wait_agent as waitAgent } from "./wait_agent"
import { send_message as sendMessage } from "./send_message"
import { followup_task as followupTask } from "./followup_task"
import { interrupt_agent as interruptAgent } from "./interrupt_agent"
import { crossTaskOrchestrationTools } from "./cross_task_orchestration"
import { threadOrchestrationTools } from "./thread_orchestration"
import { createWriteStdinTool } from "./manage_command"
import { createReadFileTool } from "./read_file"
import { viewImageToolSchema } from "./view_image"
import runSlashCommand from "./run_slash_command"
import skill from "./skill"
import searchFiles from "./search_files"
import updatePlan from "./update_plan"
import { goalTools } from "./goals"
import { memoryTools } from "./memories"

export { getMcpServerTools } from "./mcp_server"
export { convertOpenAIToolToAnthropic, convertOpenAIToolsToAnthropic } from "./converters"
export type { ReadFileToolOptions } from "./read_file"

/**
 * Options for customizing the native tools array.
 */
export interface NativeToolsOptions {
	/** Expose only the redacted diagnostic evidence reader for a host-created diagnostic task. */
	diagnosticSession?: boolean
	/** Captured, opt-in root-task authority to access the host-local memory namespace. */
	memoryToolsEnabled?: boolean
	/** Whether the model supports image processing (default: false) */
	supportsImages?: boolean
	/** Browser tools currently registered by VS Code. Omit to include the full catalog (primarily for tests). */
	availableBrowserToolNames?: readonly string[]
	/** Selects role-specific tool contracts without exposing managed-child fields to primary tasks. */
	taskKind?: "primary" | "subagent"
	/** Narrows managed-agent roles advertised to the model. Runtime policy validates them independently. */
	agentKinds?: readonly ManagedAgentKind[]
	/** Configured names shown in the spawn schema at the captured step boundary. */
	namedAgentTypes?: readonly { name: string; description: string }[]
	/** Advertise the host-enforced non-mutating command contract used by strict Plan mode. */
	planMode?: boolean
	/** Include the blocking question tool for primary Code and Plan tasks. */
	includeRequestUserInput?: boolean
	/** Include the nonblocking user question tool for catalog-capable root tasks. */
	includeRequestUserInputAsync?: boolean
	/** MCP resources are exposed only when at least one enabled server is configured. */
	mcpResourcesAvailable?: boolean
	/** Retain the retired resource declaration for provider history, without granting a new call. */
	includeLegacyMcpResource?: boolean
	/** Independent primary tasks can inspect and coordinate peer conversations; managed children cannot. */
	crossTaskRole?: "root" | "child" | "none"
	/** Historical spelling for includeCreateThreadSchema. */
	includeCreateTaskSchema?: boolean
	/** Include create_thread only when the latest human request authorizes a separate task. */
	includeCreateThreadSchema?: boolean
	/** Include fork_thread only for an explicit request to retain conversation history. */
	includeForkThreadSchema?: boolean
	/** Retain declarations required by saved provider history without advertising them on fresh tasks. */
	legacyCrossTaskToolNames?: readonly string[]
}

/** Schemas kept only for decoding and dispatching tool calls saved by older tasks. */
export function getLegacyFileToolSchemas(options: Pick<NativeToolsOptions, "supportsImages"> = {}) {
	return [listFiles, createReadFileTool({ supportsImages: options.supportsImages }), searchFiles]
}

/**
 * Get native tools array, optionally customizing based on settings.
 *
 * @param options - Configuration options for the tools
 * @returns Array of native tool definitions
 */
export function getNativeTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	if (options.diagnosticSession) return [readDiagnosticEvidence]

	const {
		memoryToolsEnabled = false,
		supportsImages = false,
		availableBrowserToolNames,
		taskKind = "primary",
		agentKinds,
		namedAgentTypes,
		planMode = false,
		includeRequestUserInput = taskKind === "primary",
		includeRequestUserInputAsync = false,
		mcpResourcesAvailable = false,
		includeLegacyMcpResource = false,
		crossTaskRole = "none",
		includeCreateTaskSchema = false,
		includeCreateThreadSchema = includeCreateTaskSchema,
		includeForkThreadSchema = false,
		legacyCrossTaskToolNames = [],
	} = options

	const availableBrowserTools = browserTools.filter((tool) => {
		const name = tool.function.name
		if (availableBrowserToolNames && !availableBrowserToolNames.includes(name)) return false
		// Production model requests pass the live VS Code catalog and can then omit
		// image-returning tools for text-only models.
		return !availableBrowserToolNames || supportsImages || name !== "screenshot_page"
	})

	return [
		...ticketTools,
		...(memoryToolsEnabled && taskKind === "primary" && crossTaskRole !== "child"
			? memoryTools.filter((tool) => !planMode || tool.function.name !== "memories_add_ad_hoc_note")
			: []),
		...(taskKind === "primary" && crossTaskRole !== "child"
			? goalTools.filter((tool) => !planMode || tool.function.name === "get_goal")
			: []),
		...(mcpResourcesAvailable ? mcpResourceTools : []),
		...(includeLegacyMcpResource ? [accessMcpResource] : []),
		applyPatch,
		codebaseSearch,
		...(includeRequestUserInput ? [requestUserInput] : []),
		...(includeRequestUserInputAsync && taskKind === "primary" ? [requestUserInputAsync] : []),
		createExecCommandTool(planMode),
		...(supportsImages ? [viewImageToolSchema] : []),
		...availableBrowserTools,
		createSpawnAgentTool(agentKinds, namedAgentTypes),
		...(taskKind === "primary" && crossTaskRole !== "none"
			? [
					...threadOrchestrationTools.filter(
						(tool) =>
							(tool.function.name !== "create_thread" || includeCreateThreadSchema) &&
							(tool.function.name !== "fork_thread" || includeForkThreadSchema),
					),
					...crossTaskOrchestrationTools.filter(
						(tool) =>
							tool.function.name === "steer_task" ||
							tool.function.name === "stop_task" ||
							legacyCrossTaskToolNames.includes(tool.function.name),
					),
				]
			: []),
		listAgents,
		waitAgent,
		sendMessage,
		followupTask,
		interruptAgent,
		createWriteStdinTool(planMode),
		runSlashCommand,
		skill,
		...(taskKind === "primary" && !planMode ? [updatePlan] : []),
	] satisfies OpenAI.Chat.ChatCompletionTool[]
}

// Backward compatibility: export default tools with line ranges enabled
export const nativeTools = getNativeTools()
