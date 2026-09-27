import type { CreateTicket, UpdateTicket, DeleteTicket, TicketStatus, TicketType } from "@alpha-code/types"
import { Anthropic } from "@anthropic-ai/sdk"

import type {
	AlphaAsk,
	ToolProgressStatus,
	ToolGroup,
	ToolName,
	GenerateImageParams,
	ListAgentsParams,
	WaitAgentParams,
	SendMessageParams,
	ReportProgressParams,
	FollowupTaskParams,
	InterruptAgentParams,
	CancelAgentParams,
	CloseAgentParams,
	CreateTaskParams,
	ListTasksParams,
	WaitTaskParams,
	SendTaskMessageParams,
	SteerTaskParams,
	StopTaskParams,
	SubagentForkTurns,
	SubagentSpawnAgentArgs,
	BrowserToolArgs,
	DiscoverToolsParams,
	ToolSearchParams,
	SearchFilesParams,
	ViewImageParams,
} from "@alpha-code/types"

export type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>

export type AskApproval = (
	type: AlphaAsk,
	partialMessage?: string,
	progressStatus?: ToolProgressStatus,
	forceApproval?: boolean,
	requiresExplicitApproval?: boolean,
) => Promise<boolean>

export type HandleError = (action: string, error: Error) => Promise<void>

export type PushToolResult = (content: ToolResponse) => void

export type AskFinishSubTaskApproval = () => Promise<boolean>

export interface TextContent {
	type: "text"
	content: string
	partial: boolean
}

export const toolParamNames = [
	"command",
	"cmd",
	"path",
	"content",
	"regex",
	"file_pattern",
	"output_mode",
	"literal",
	"recursive",
	"action",
	"url",
	// VS Code integrated-browser parameters
	"forceNew",
	"pageId",
	"ref",
	"selector",
	"element",
	"scrollIntoViewIfNeeded",
	"type",
	"dblClick",
	"button",
	"submit",
	"key",
	"fromRef",
	"fromSelector",
	"fromElement",
	"toRef",
	"toSelector",
	"toElement",
	"acceptModal",
	"promptText",
	"selectFiles",
	"code",
	"deferredResultId",
	"timeoutMs",
	"coordinate",
	"text",
	"server_name",
	"server",
	"cursor",
	"tool_name",
	"arguments",
	"uri",
	"question",
	"questions",
	"title",
	"options",
	"result",
	"outcome",
	"diff",
	"reason",
	"line",
	"mode",
	"message",
	"cwd",
	"workdir",
	"follow_up",
	"task",
	"size",
	"query",
	"args",
	"skill", // skill tool parameter
	"start_line",
	"end_line",
	"todos",
	"prompt",
	"image",
	// read_file parameters (native protocol)
	"operations", // search_and_replace parameter for multiple operations
	"patch", // apply_patch parameter
	"file_path", // search_replace and edit_file parameter
	"old_string", // search_replace and edit_file parameter
	"new_string", // search_replace and edit_file parameter
	"replace_all", // edit tool parameter for replacing all occurrences
	"expected_replacements", // edit_file parameter for multiple occurrences
	"timeout", // execute_command parameter
	"yield_time_ms", // exec_command and write_stdin wait interval
	"max_output_tokens", // exec_command and write_stdin result budget
	"session_id", // write_stdin session identifier
	"chars", // write_stdin input
	"verification", // execute_command verification scope
	"artifact_id", // read_command_output parameter
	"search", // read_command_output parameter for grep-like search
	"offset", // read_command_output and read_file parameter
	"limit", // read_command_output and read_file parameter
	// read_file indentation mode parameters
	"indentation",
	"anchor_line",
	"max_levels",
	"include_siblings",
	"include_header",
	"max_lines",
	// read_file legacy format parameter (backward compatibility)
	"files",
	"line_ranges",
	// search_files bounded batch parameter
	"queries",
	"tasks",
	"task_name",
	"task_id",
	"workspace_mode",
	"agent_type",
	"fork_turns",
	"objective",
	"agent_kind",
	"write_scope",
	"expected_output",
	"path_prefix",
	"timeout_ms",
	"until_terminal",
	"target",
	"explanation",
	"plan",
	"step",
	"status",
] as const

export type ToolParamName = (typeof toolParamNames)[number]

/**
 * Type map defining the native (typed) argument structure for each tool.
 * Tools not listed here will fall back to `any` for backward compatibility.
 */
export type NativeToolArgs = BrowserToolArgs & {
	access_mcp_resource: { server_name: string; uri: string }
	list_mcp_resources: { server?: string; cursor?: string }
	list_mcp_resource_templates: { server?: string; cursor?: string }
	read_mcp_resource: { server: string; uri: string }
	discover_tools: DiscoverToolsParams
	tool_search: ToolSearchParams
	read_file: import("@alpha-code/types").ReadFileToolParams
	view_image: ViewImageParams
	read_command_output: { artifact_id: string; search?: string; offset?: number; limit?: number }
	manage_command:
		| {
				execution_id: string
				action: "wait" | "stop" | "input"
				input?: string | null
				timeout_ms?: number | null
		  }
		| {
				action: "read"
				artifact_id: string
				search?: string
				offset?: number
				limit?: number
		  }
	write_stdin: {
		session_id: number
		chars?: string
		yield_time_ms?: number
		max_output_tokens?: number
	}
	shell: {
		command: string
		cwd?: string | null
		timeout?: number | null
		/** Internal and historical verification metadata; omitted from the model-facing schema. */
		verification?: { change_set_ids: string[] } | null
	}
	exec_command: {
		cmd: string
		workdir?: string | null
		yield_time_ms?: number | null
		max_output_tokens?: number | null
		/** Host-injected verification scope; omitted from the model-facing schema. */
		verification?: { change_set_ids: string[] } | null
	}
	attempt_completion: { result: string; outcome?: "completed" | "blocked" }
	execute_command: {
		command: string
		cwd?: string | null
		timeout?: number | null
		/** Explicitly identifies applied Worker change sets this command validates. */
		verification?: { change_set_ids: string[] } | null
	}
	apply_diff: { path: string; diff: string }
	edit: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
	search_and_replace: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
	search_replace: { file_path: string; old_string: string; new_string: string }
	edit_file: { file_path: string; old_string: string; new_string: string; expected_replacements?: number }
	apply_patch: { patch: string }
	list_files: { path: string; recursive?: boolean }
	new_task: { mode: string; message: string; todos?: string }
	delegate_task: {
		tasks: Array<
			| {
					objective: string
					fork_turns: SubagentForkTurns
					agent_kind: "explore" | "review"
					write_scope?: string[] | null
					expected_output?: string[] | null
			  }
			| {
					objective: string
					fork_turns: SubagentForkTurns
					agent_kind: "worker"
					write_scope: string[]
					expected_output?: string[] | null
			  }
		>
	}
	spawn_agent: SubagentSpawnAgentArgs
	list_agents: ListAgentsParams
	wait_agent: WaitAgentParams
	send_message: SendMessageParams
	report_progress: ReportProgressParams
	followup_task: FollowupTaskParams
	interrupt_agent: InterruptAgentParams
	cancel_agent: CancelAgentParams
	close_agent: CloseAgentParams
	create_task: CreateTaskParams
	list_tasks: ListTasksParams
	wait_task: WaitTaskParams
	send_task_message: SendTaskMessageParams
	steer_task: SteerTaskParams
	stop_task: StopTaskParams
	ask_followup_question: {
		question: string
		follow_up: Array<{ text: string; mode?: string }>
	}
	request_user_input: {
		questions: Array<{
			id: string
			header: string
			question: string
			options: Array<{ label: string; description: string }>
		}>
	}
	request_user_input_async: {
		questions: Array<{ title: string; options?: string[] }>
	}
	codebase_search: { query: string; path?: string }
	generate_image: GenerateImageParams
	run_slash_command: { command: string; args?: string }
	skill: { skill: string; args?: string }
	search_files: SearchFilesParams
	list_tickets: { query?: string; status?: TicketStatus; type?: TicketType | null; offset?: number; limit?: number }
	read_ticket: { id: string }
	create_ticket: CreateTicket
	update_ticket: UpdateTicket
	delete_ticket: DeleteTicket
	update_todo_list: { todos: string; work_plan?: import("@alpha-code/types").TaskWorkPlan | null }
	update_plan: {
		explanation?: string | null
		plan: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>
	}
	use_mcp_tool: { server_name: string; tool_name: string; arguments?: Record<string, unknown> }
	write_to_file: { path: string; content: string }
	// Add more tools as they are migrated to native protocol
}

/**
 * Generic ToolUse interface that provides proper typing for both protocols.
 *
 * @template TName - The specific tool name, which determines the nativeArgs type
 */
export interface ToolUse<TName extends ToolName = ToolName> {
	type: "tool_use"
	id?: string // Optional ID to track tool calls
	name: TName
	/**
	 * The original tool name as called by the model (e.g. an alias like "edit_file"),
	 * if it differs from the canonical tool name used for execution.
	 * Used to preserve tool names in API conversation history.
	 */
	originalName?: string
	// params is a partial record, allowing only some or none of the possible parameters to be used
	params: Partial<Record<ToolParamName, string>>
	partial: boolean
	// nativeArgs is properly typed based on TName if it's in NativeToolArgs, otherwise never
	nativeArgs?: TName extends keyof NativeToolArgs ? NativeToolArgs[TName] : never
	/**
	 * Flag indicating whether the tool call used a legacy/deprecated format.
	 * Used for telemetry tracking to monitor migration from old formats.
	 */
	usedLegacyFormat?: boolean
}

/**
 * Represents a native MCP tool call from the model.
 * In native mode, MCP tools are called directly with their prefixed name (e.g., "mcp_serverName_toolName")
 * rather than through the use_mcp_tool wrapper. This type preserves the original tool name
 * so it appears correctly in API conversation history.
 */
export interface McpToolUse {
	type: "mcp_tool_use"
	id?: string // Tool call ID from the API
	/** The original tool name from the API (e.g., "mcp_serverName_toolName") */
	name: string
	/** Extracted server name from the tool name */
	serverName: string
	/** Extracted tool name from the tool name */
	toolName: string
	/** Arguments passed to the MCP tool */
	arguments: Record<string, unknown>
	partial: boolean
}

export interface ExecuteCommandToolUse extends ToolUse<"execute_command"> {
	name: "execute_command"
	// Pick<Record<ToolParamName, string>, "command"> makes "command" required, but Partial<> makes it optional
	params: Partial<Pick<Record<ToolParamName, string>, "command" | "cwd" | "timeout" | "verification">>
}

export interface ShellToolUse extends ToolUse<"shell"> {
	name: "shell"
	params: Partial<Pick<Record<ToolParamName, string>, "command" | "cwd" | "timeout">>
}

export interface ReadFileToolUse extends ToolUse<"read_file"> {
	name: "read_file"
	params: Partial<
		Pick<
			Record<ToolParamName, string>,
			| "args"
			| "path"
			| "start_line"
			| "end_line"
			| "mode"
			| "offset"
			| "limit"
			| "indentation"
			| "anchor_line"
			| "max_levels"
			| "include_siblings"
			| "include_header"
		>
	>
}

export interface ViewImageToolUse extends ToolUse<"view_image"> {
	name: "view_image"
	params: Partial<Pick<Record<ToolParamName, string>, "path">>
}

export interface WriteToFileToolUse extends ToolUse<"write_to_file"> {
	name: "write_to_file"
	params: Partial<Pick<Record<ToolParamName, string>, "path" | "content">>
}

export interface CodebaseSearchToolUse extends ToolUse<"codebase_search"> {
	name: "codebase_search"
	params: Partial<Pick<Record<ToolParamName, string>, "query" | "path">>
}

export interface SearchFilesToolUse extends ToolUse<"search_files"> {
	name: "search_files"
	params: Partial<
		Pick<Record<ToolParamName, string>, "path" | "regex" | "file_pattern" | "queries" | "output_mode" | "literal">
	>
}

export interface ListFilesToolUse extends ToolUse<"list_files"> {
	name: "list_files"
	params: Partial<Pick<Record<ToolParamName, string>, "path" | "recursive">>
}

export interface UseMcpToolToolUse extends ToolUse<"use_mcp_tool"> {
	name: "use_mcp_tool"
	params: Partial<Pick<Record<ToolParamName, string>, "server_name" | "tool_name" | "arguments">>
}

export interface AccessMcpResourceToolUse extends ToolUse<"access_mcp_resource"> {
	name: "access_mcp_resource"
	params: Partial<Pick<Record<ToolParamName, string>, "server_name" | "uri">>
}

export interface AskFollowupQuestionToolUse extends ToolUse<"ask_followup_question"> {
	name: "ask_followup_question"
	params: Partial<Pick<Record<ToolParamName, string>, "question" | "follow_up">>
}

export interface RequestUserInputToolUse extends ToolUse<"request_user_input"> {
	name: "request_user_input"
}

export interface RequestUserInputAsyncToolUse extends ToolUse<"request_user_input_async"> {
	name: "request_user_input_async"
}

export interface AttemptCompletionToolUse extends ToolUse<"attempt_completion"> {
	name: "attempt_completion"
	params: Partial<Pick<Record<ToolParamName, string>, "result" | "outcome">>
}

export interface NewTaskToolUse extends ToolUse<"new_task"> {
	name: "new_task"
	params: Partial<Pick<Record<ToolParamName, string>, "mode" | "message" | "todos">>
}

export interface RunSlashCommandToolUse extends ToolUse<"run_slash_command"> {
	name: "run_slash_command"
	params: Partial<Pick<Record<ToolParamName, string>, "command" | "args">>
}

export interface SkillToolUse extends ToolUse<"skill"> {
	name: "skill"
	params: Partial<Pick<Record<ToolParamName, string>, "skill" | "args">>
}

export interface GenerateImageToolUse extends ToolUse<"generate_image"> {
	name: "generate_image"
	params: Partial<Pick<Record<ToolParamName, string>, "prompt" | "path" | "image">>
}

// Define tool group configuration
export type ToolGroupConfig = {
	tools: readonly string[]
	alwaysAvailable?: boolean // Whether this group is always available and shouldn't show in prompts view
	customTools?: readonly string[] // Opt-in only tools - only available when explicitly included via model's includedTools
}

export const TOOL_DISPLAY_NAMES: Record<ToolName, string> = {
	shell: "run commands",
	exec_command: "run commands",
	execute_command: "run commands",
	manage_command: "control task commands",
	write_stdin: "control task commands",
	read_file: "read files",
	view_image: "view images",
	read_command_output: "read command output",
	write_to_file: "write files",
	apply_diff: "apply changes",
	edit: "edit files",
	search_and_replace: "apply changes using search and replace",
	search_replace: "apply single search and replace",
	edit_file: "edit files using search and replace",
	apply_patch: "apply patches using codex format",
	search_files: "search files",
	list_files: "list files",
	use_mcp_tool: "use mcp tools",
	access_mcp_resource: "access mcp resources",
	list_mcp_resources: "list mcp resources",
	list_mcp_resource_templates: "list mcp resource templates",
	read_mcp_resource: "read an mcp resource",
	discover_tools: "discover optional MCP tools",
	tool_search: "search deferred tools",
	ask_followup_question: "ask questions",
	request_user_input: "request user input",
	request_user_input_async: "ask the user while work continues",
	attempt_completion: "complete tasks",
	new_task: "create new task",
	delegate_task: "delegate bounded tasks",
	spawn_agent: "spawn a bounded agent",
	create_task: "create an independent task",
	list_tasks: "list tasks created by this task",
	wait_task: "wait for a task update",
	send_task_message: "send a message to a task",
	steer_task: "steer a task",
	stop_task: "stop a task",
	list_agents: "list agents",
	wait_agent: "wait for agent updates",
	send_message: "message an agent",
	report_progress: "report progress to the parent agent",
	followup_task: "follow up with an agent",
	interrupt_agent: "interrupt an agent",
	cancel_agent: "cancel an agent",
	close_agent: "close an agent",
	codebase_search: "codebase search",
	list_tickets: "list tickets",
	read_ticket: "read a ticket",
	create_ticket: "create a ticket",
	update_ticket: "update a ticket",
	delete_ticket: "delete a ticket",
	update_todo_list: "update todo list",
	update_plan: "update plan",
	run_slash_command: "run slash command",
	skill: "load skill",
	generate_image: "generate images",
	open_browser_page: "open an integrated browser page",
	list_browser_pages: "list shared integrated browser pages",
	read_page: "read an integrated browser page",
	screenshot_page: "capture an integrated browser page",
	navigate_page: "navigate an integrated browser page",
	click_element: "click an integrated browser element",
	type_in_page: "type in an integrated browser page",
	hover_element: "hover over an integrated browser element",
	drag_element: "drag an integrated browser element",
	handle_dialog: "handle an integrated browser dialog",
	run_playwright_code: "run Playwright against an integrated browser page",
	custom_tool: "use custom tools",
} as const

// Define available tool groups.
export const TOOL_GROUPS: Record<ToolGroup, ToolGroupConfig> = {
	read: {
		tools: [
			"read_file",
			"view_image",
			"search_files",
			"list_files",
			"codebase_search",
			"list_tickets",
			"read_ticket",
		],
	},
	edit: {
		tools: ["edit", "write_to_file", "create_ticket", "update_ticket", "delete_ticket"],
		customTools: ["apply_patch"],
	},
	command: {
		tools: ["exec_command", "manage_command", "write_stdin"],
	},
	mcp: {
		tools: [
			"access_mcp_resource",
			"list_mcp_resources",
			"list_mcp_resource_templates",
			"read_mcp_resource",
			"tool_search",
		],
	},
	modes: {
		tools: ["new_task"],
		alwaysAvailable: true,
	},
	agents: {
		tools: [
			"spawn_agent",
			"wait_agent",
			"send_message",
			"followup_task",
			"list_agents",
			"interrupt_agent",
			"create_task",
			"list_tasks",
			"wait_task",
			"send_task_message",
			"steer_task",
			"stop_task",
		],
	},
	browser: {
		tools: [
			"open_browser_page",
			"list_browser_pages",
			"read_page",
			"screenshot_page",
			"navigate_page",
			"click_element",
			"type_in_page",
			"hover_element",
			"drag_element",
			"handle_dialog",
			"run_playwright_code",
		],
	},
}

// Tools that are always available to all modes.
export const ALWAYS_AVAILABLE_TOOLS: ToolName[] = [
	"ask_followup_question",
	"request_user_input_async",
	"attempt_completion",
	"new_task",
	"update_plan",
	"run_slash_command",
	"skill",
	"tool_search",
] as const

/**
 * Central registry of tool aliases.
 * Maps alias name -> canonical tool name.
 *
 * This allows models to use alternative names for tools (e.g., "edit_file" instead of "apply_diff").
 * When a model calls a tool by its alias, the system resolves it to the canonical name for execution,
 * but preserves the alias in API conversation history for consistency.
 *
 * To add a new alias, simply add an entry here. No other files need to be modified.
 */
export const TOOL_ALIASES: Record<string, ToolName> = {
	discover_tools: "tool_search",
	shell: "exec_command",
	execute_command: "exec_command",
	update_todo_list: "update_plan",
	read_command_output: "manage_command",
	write_file: "write_to_file",
	search_and_replace: "edit",
} as const

export type DiffResult =
	| { success: true; content: string; failParts?: DiffResult[] }
	| ({
			success: false
			error?: string
			details?: {
				similarity?: number
				threshold?: number
				matchedRange?: { start: number; end: number }
				searchContent?: string
				bestMatch?: string
			}
			failParts?: DiffResult[]
	  } & ({ error: string } | { failParts: DiffResult[] }))

export interface DiffItem {
	content: string
	startLine?: number
}

export interface DiffStrategy {
	/**
	 * Get the name of this diff strategy for analytics and debugging
	 * @returns The name of the diff strategy
	 */
	getName(): string

	/**
	 * Apply a diff to the original content
	 * @param originalContent The original file content
	 * @param diffContent The diff content in the strategy's format (string for legacy, DiffItem[] for new)
	 * @param startLine Optional line number where the search block starts. If not provided, searches the entire file.
	 * @param endLine Optional line number where the search block ends. If not provided, searches the entire file.
	 * @returns A DiffResult object containing either the successful result or error details
	 */
	applyDiff(
		originalContent: string,
		diffContent: string | DiffItem[],
		startLine?: number,
		endLine?: number,
	): Promise<DiffResult>

	getProgressStatus?(toolUse: ToolUse, result?: any): ToolProgressStatus
}
