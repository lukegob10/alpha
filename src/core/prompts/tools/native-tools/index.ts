import type OpenAI from "openai"
import accessMcpResource from "./access_mcp_resource"
import { apply_diff } from "./apply_diff"
import applyPatch from "./apply_patch"
import askFollowupQuestion from "./ask_followup_question"
import { createAttemptCompletionTool } from "./attempt_completion"
import codebaseSearch from "./codebase_search"
import editTool from "./edit"
import executeCommand from "./execute_command"
import generateImage from "./generate_image"
import githubApi from "./github_api"
import { browserTools } from "./browser"
import listFiles from "./list_files"
import newTask from "./new_task"
import { delegate_task as delegateTask } from "./delegate_task"
import { spawn_agent as spawnAgent } from "./spawn_agent"
import { list_agents as listAgents } from "./list_agents"
import { wait_agent as waitAgent } from "./wait_agent"
import { send_message as sendMessage } from "./send_message"
import { report_progress as reportProgress } from "./report_progress"
import { followup_task as followupTask } from "./followup_task"
import { interrupt_agent as interruptAgent } from "./interrupt_agent"
import { cancel_agent as cancelAgent } from "./cancel_agent"
import { close_agent as closeAgent } from "./close_agent"
import readCommandOutput from "./read_command_output"
import { createReadFileTool, type ReadFileToolOptions } from "./read_file"
import runSlashCommand from "./run_slash_command"
import skill from "./skill"
import searchReplace from "./search_replace"
import edit_file from "./edit_file"
import searchFiles from "./search_files"
import switchMode from "./switch_mode"
import updateTodoList from "./update_todo_list"
import writeToFile from "./write_to_file"

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
}

/**
 * Get native tools array, optionally customizing based on settings.
 *
 * @param options - Configuration options for the tools
 * @returns Array of native tool definitions
 */
export function getNativeTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	const { supportsImages = false, availableBrowserToolNames, taskKind = "primary" } = options

	const readFileOptions: ReadFileToolOptions = {
		supportsImages,
	}
	const availableBrowserTools = browserTools.filter((tool) => {
		const name = tool.function.name
		if (availableBrowserToolNames && !availableBrowserToolNames.includes(name)) return false
		// The runtime registry builds from the full static catalog when availability
		// is omitted. Production model requests pass the live VS Code catalog and can
		// then omit image-returning tools for text-only models.
		return !availableBrowserToolNames || supportsImages || name !== "screenshot_page"
	})

	return [
		accessMcpResource,
		apply_diff,
		applyPatch,
		askFollowupQuestion,
		createAttemptCompletionTool(taskKind),
		codebaseSearch,
		executeCommand,
		generateImage,
		githubApi,
		...availableBrowserTools,
		listFiles,
		newTask,
		delegateTask,
		spawnAgent,
		listAgents,
		waitAgent,
		sendMessage,
		reportProgress,
		followupTask,
		interruptAgent,
		cancelAgent,
		closeAgent,
		readCommandOutput,
		createReadFileTool(readFileOptions),
		runSlashCommand,
		skill,
		searchReplace,
		edit_file,
		editTool,
		searchFiles,
		switchMode,
		updateTodoList,
		writeToFile,
	] satisfies OpenAI.Chat.ChatCompletionTool[]
}

// Backward compatibility: export default tools with line ranges enabled
export const nativeTools = getNativeTools()
