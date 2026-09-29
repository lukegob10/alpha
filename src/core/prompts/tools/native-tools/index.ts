import { ticketTools } from "./tickets"
import type OpenAI from "openai"
import accessMcpResource from "./access_mcp_resource"
import { mcpResourceTools } from "./mcp_resources"
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
import { createWriteStdinTool } from "./manage_command"
import { createReadFileTool } from "./read_file"
import { viewImageToolSchema } from "./view_image"
import runSlashCommand from "./run_slash_command"
import skill from "./skill"
import searchFiles from "./search_files"
import updatePlan from "./update_plan"

export { getMcpServerTools } from "./mcp_server"
export { convertOpenAIToolToAnthropic, convertOpenAIToolsToAnthropic } from "./converters"
export type { ReadFileToolOptions } from "./read_file"

/**
 * Options for customizing the native tools array.
 */
export interface NativeToolsOptions {
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
	/** Root tasks control direct children; an independent child can only message its parent. */
	crossTaskRole?: "root" | "child" | "none"
	/** Include the create_task declaration; the captured policy decides whether it is callable. */
	includeCreateTaskSchema?: boolean
}

/** Schemas kept only for decoding and dispatching tool calls saved by older tasks. */
export function getLegacyFileToolSchemas(options: Pick<NativeToolsOptions, "supportsImages"> = {}) {
	return [codebaseSearch, listFiles, createReadFileTool({ supportsImages: options.supportsImages }), searchFiles]
}

/**
 * Get native tools array, optionally customizing based on settings.
 *
 * @param options - Configuration options for the tools
 * @returns Array of native tool definitions
 */
export function getNativeTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	const {
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
		...(mcpResourcesAvailable ? mcpResourceTools : []),
		...(includeLegacyMcpResource ? [accessMcpResource] : []),
		applyPatch,
		...(includeRequestUserInput ? [requestUserInput] : []),
		...(includeRequestUserInputAsync && taskKind === "primary" ? [requestUserInputAsync] : []),
		createExecCommandTool(planMode),
		...(supportsImages ? [viewImageToolSchema] : []),
		...availableBrowserTools,
		createSpawnAgentTool(agentKinds, namedAgentTypes),
		...(crossTaskRole === "root"
			? crossTaskOrchestrationTools.filter(
					(tool) => tool.function.name !== "create_task" || includeCreateTaskSchema,
				)
			: crossTaskRole === "child"
				? [crossTaskOrchestrationTools[3]]
				: []),
		listAgents,
		waitAgent,
		sendMessage,
		followupTask,
		interruptAgent,
		...(!planMode ? [createWriteStdinTool()] : []),
		runSlashCommand,
		skill,
		...(taskKind === "primary" ? [updatePlan] : []),
	] satisfies OpenAI.Chat.ChatCompletionTool[]
}

// Backward compatibility: export default tools with line ranges enabled
export const nativeTools = getNativeTools()
