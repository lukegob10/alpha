import type OpenAI from "openai"

import { customToolRegistry, formatNative } from "@alpha-code/core"

import type { ToolUse } from "../../shared/tools"
import { TOOL_ALIASES } from "../../shared/tools"
import { normalizeMcpToolName, parseMcpToolName } from "../../utils/mcp-name"
import { getNativeTools, getMcpServerTools } from "../prompts/tools/native-tools"
import { formatResponse } from "../prompts/responses"
import type { Task } from "../task/Task"

import { accessMcpResourceTool } from "./accessMcpResourceTool"
import { applyDiffTool } from "./ApplyDiffTool"
import { applyPatchTool } from "./ApplyPatchTool"
import { askFollowupQuestionTool } from "./AskFollowupQuestionTool"
import { attemptCompletionTool, type AttemptCompletionCallbacks } from "./AttemptCompletionTool"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { codebaseSearchTool } from "./CodebaseSearchTool"
import { cancelAgentTool } from "./CancelAgentTool"
import { closeAgentTool } from "./CloseAgentTool"
import { delegateTaskTool } from "./DelegateTaskTool"
import { editFileTool } from "./EditFileTool"
import { editTool } from "./EditTool"
import { executeCommandTool } from "./ExecuteCommandTool"
import { generateImageTool } from "./GenerateImageTool"
import { githubApiTool } from "./GitHubApiTool"
import { followupTaskTool } from "./FollowupTaskTool"
import { interruptAgentTool } from "./InterruptAgentTool"
import { listAgentsTool } from "./ListAgentsTool"
import { listFilesTool } from "./ListFilesTool"
import { newTaskTool } from "./NewTaskTool"
import { readCommandOutputTool } from "./ReadCommandOutputTool"
import { readFileTool } from "./ReadFileTool"
import { runSlashCommandTool } from "./RunSlashCommandTool"
import { searchFilesTool } from "./SearchFilesTool"
import { searchReplaceTool } from "./SearchReplaceTool"
import { sendMessageTool } from "./SendMessageTool"
import { skillTool } from "./SkillTool"
import { spawnAgentTool } from "./SpawnAgentTool"
import { switchModeTool } from "./SwitchModeTool"
import { updateTodoListTool } from "./UpdateTodoListTool"
import { useMcpToolTool } from "./UseMcpToolTool"
import { waitAgentTool } from "./WaitAgentTool"
import { writeToFileTool } from "./WriteToFileTool"

export type ToolConcurrency = "parallel" | "serial" | "barrier"
export type ToolSideEffects = "none" | "workspace" | "task" | "external"

export interface ToolCapabilities {
	concurrency: ToolConcurrency
	sideEffects: ToolSideEffects
	controlFlow: boolean
	requiresApproval: boolean
}

export interface ToolExecutionContext {
	task: Task
	call: ToolUse
	signal?: AbortSignal
	callbacks: ToolCallbacks
}

export interface ToolDescriptor {
	name: string
	aliases: string[]
	schema: OpenAI.Chat.ChatCompletionTool
	capabilities: ToolCapabilities
	/** Maximum text characters returned to the next model turn. */
	maxOutputChars?: number
	execute(context: ToolExecutionContext): Promise<void>
}

export interface ToolRegistryOptions {
	/** Set false for isolated registry/scheduler tests that register fixtures. */
	includeBuiltIns?: boolean
	nativeTools?: OpenAI.Chat.ChatCompletionTool[]
	mcpTools?: OpenAI.Chat.ChatCompletionTool[]
	includeCustomTools?: boolean
	supportsImages?: boolean
}

const PARALLEL_READ_TOOLS = new Set([
	"read_file",
	"list_files",
	"search_files",
	"codebase_search",
	"read_command_output",
	"list_agents",
])

const BARRIER_TOOLS = new Set([
	"new_task",
	"delegate_task",
	"attempt_completion",
	"switch_mode",
	"ask_followup_question",
])

const WORKSPACE_TOOLS = new Set([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_replace",
	"edit_file",
	"apply_patch",
	"execute_command",
	"generate_image",
])

const CHECKPOINT_TOOLS = new Set([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_replace",
	"edit_file",
	"apply_patch",
	"generate_image",
])

const TASK_TOOLS = new Set([
	"update_todo_list",
	"new_task",
	"delegate_task",
	"spawn_agent",
	"wait_agent",
	"send_message",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
	"attempt_completion",
	"switch_mode",
	"ask_followup_question",
])

const TOOL_NAMES = [
	"access_mcp_resource",
	"apply_diff",
	"apply_patch",
	"ask_followup_question",
	"attempt_completion",
	"codebase_search",
	"delegate_task",
	"spawn_agent",
	"list_agents",
	"wait_agent",
	"send_message",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
	"edit",
	"edit_file",
	"execute_command",
	"generate_image",
	"github_api",
	"list_files",
	"new_task",
	"read_command_output",
	"read_file",
	"run_slash_command",
	"search_files",
	"search_replace",
	"skill",
	"switch_mode",
	"update_todo_list",
	"use_mcp_tool",
	"write_to_file",
] as const

type BuiltInToolName = (typeof TOOL_NAMES)[number]

const legacyMcpSchema: OpenAI.Chat.ChatCompletionFunctionTool = {
	type: "function",
	function: {
		name: "use_mcp_tool",
		description: "Call a tool exposed by a connected MCP server.",
		parameters: {
			type: "object",
			properties: {
				server_name: { type: "string" },
				tool_name: { type: "string" },
				arguments: { type: "object", additionalProperties: true },
			},
			required: ["server_name", "tool_name"],
			additionalProperties: false,
		},
	},
}

function getSchemaMap(tools: OpenAI.Chat.ChatCompletionTool[]): Map<string, OpenAI.Chat.ChatCompletionTool> {
	const result = new Map<string, OpenAI.Chat.ChatCompletionTool>()
	for (const tool of tools) {
		if (tool.type === "function") {
			result.set(tool.function.name, tool)
		}
	}
	return result
}

export function getToolCapabilities(name: string): ToolCapabilities {
	const concurrency: ToolConcurrency = BARRIER_TOOLS.has(name)
		? "barrier"
		: PARALLEL_READ_TOOLS.has(name)
			? "parallel"
			: "serial"

	const sideEffects: ToolSideEffects = WORKSPACE_TOOLS.has(name)
		? "workspace"
		: TASK_TOOLS.has(name)
			? "task"
			: name === "github_api" || name === "use_mcp_tool" || name.startsWith("mcp") || name === "custom_tool"
				? "external"
				: "none"

	return {
		concurrency,
		sideEffects,
		controlFlow: BARRIER_TOOLS.has(name) || name === "run_slash_command" || name === "skill",
		// Individual tool handlers own the exact approval prompt. This flag is
		// metadata for scheduling and future policy decisions, not a second prompt.
		requiresApproval: true,
	}
}

function getToolDescription(call: ToolUse): string {
	const params = call.nativeArgs ?? call.params ?? {}
	const value = (key: string) => (params as Record<string, unknown>)[key]

	switch (call.name) {
		case "execute_command":
			return `[${call.name} for '${value("command") ?? ""}']`
		case "read_file":
			return `[${call.name} for '${value("path") ?? ""}']`
		case "write_to_file":
		case "edit":
		case "search_and_replace":
		case "search_replace":
		case "edit_file":
			return `[${call.name} for '${value("path") ?? value("file_path") ?? ""}']`
		case "list_files":
			return `[${call.name} for '${value("path") ?? ""}']`
		case "search_files":
			return `[${call.name} for '${value("regex") ?? ""}']`
		case "codebase_search":
			return `[${call.name} for '${value("query") ?? ""}']`
		case "use_mcp_tool":
			return `[${call.name} for '${value("server_name") ?? ""}']`
		case "access_mcp_resource":
			return `[${call.name} for '${value("server_name") ?? ""}']`
		case "ask_followup_question":
			return `[${call.name} for '${value("question") ?? ""}']`
		case "switch_mode":
			return `[${call.name} to '${value("mode_slug") ?? ""}']`
		case "new_task":
			return `[${call.name} in '${value("mode") ?? ""}' mode]`
		default:
			return `[${call.name}]`
	}
}

async function runWorkspaceMutation(task: Task, label: string, run: () => Promise<void>): Promise<void> {
	const provider = task.providerRef.deref()
	if (provider) {
		await provider.runWorkspaceMutation(task, label, run)
		return
	}
	await run()
}

async function checkpointBeforeMutation(task: Task): Promise<void> {
	if (task.currentStreamingDidCheckpoint) {
		return
	}

	try {
		await task.checkpointSave(true)
		task.currentStreamingDidCheckpoint = true
	} catch (error) {
		console.error(`[ToolRegistry] Error saving checkpoint before tool execution`, error)
	}
}

function executeBaseTool<TName extends BuiltInToolName>(tool: BaseTool<TName>, name: TName) {
	return async ({ task, call, callbacks }: ToolExecutionContext): Promise<void> => {
		const run = () => tool.handle(task, call as ToolUse<TName>, callbacks)
		if (WORKSPACE_TOOLS.has(name) || name === "new_task") {
			await runWorkspaceMutation(task, name === "new_task" ? "new_task_checkpoint" : name, async () => {
				if (CHECKPOINT_TOOLS.has(name) || name === "new_task") {
					await checkpointBeforeMutation(task)
				}
				await run()
			})
			return
		}
		await run()
	}
}

export class ToolRegistry {
	private readonly descriptors = new Map<string, ToolDescriptor>()
	private readonly aliases = new Map<string, string>()

	constructor(options: ToolRegistryOptions = {}) {
		const nativeTools = options.nativeTools ?? getNativeTools({ supportsImages: options.supportsImages })
		const schemas = getSchemaMap(nativeTools)

		if (options.includeBuiltIns === false) {
			this.registerCustomTools(options)
			return
		}

		this.registerBuiltIn("access_mcp_resource", accessMcpResourceTool, schemas)
		this.registerBuiltIn("apply_diff", applyDiffTool, schemas)
		this.registerBuiltIn("apply_patch", applyPatchTool, schemas)
		this.registerBuiltIn("ask_followup_question", askFollowupQuestionTool, schemas)
		this.registerBuiltIn("attempt_completion", attemptCompletionTool, schemas, async (context) => {
			const callbacks: AttemptCompletionCallbacks = {
				...context.callbacks,
				askFinishSubTaskApproval: () =>
					context.callbacks.askApproval("tool", JSON.stringify({ tool: "finishTask" })),
				toolDescription: () => getToolDescription(context.call),
			}
			await attemptCompletionTool.handle(context.task, context.call as ToolUse<"attempt_completion">, callbacks)
		})
		this.registerBuiltIn("codebase_search", codebaseSearchTool, schemas)
		this.registerBuiltIn("delegate_task", delegateTaskTool, schemas)
		this.registerBuiltIn("spawn_agent", spawnAgentTool, schemas)
		this.registerBuiltIn("list_agents", listAgentsTool, schemas)
		this.registerBuiltIn("wait_agent", waitAgentTool, schemas)
		this.registerBuiltIn("send_message", sendMessageTool, schemas)
		this.registerBuiltIn("followup_task", followupTaskTool, schemas)
		this.registerBuiltIn("interrupt_agent", interruptAgentTool, schemas)
		this.registerBuiltIn("cancel_agent", cancelAgentTool, schemas)
		this.registerBuiltIn("close_agent", closeAgentTool, schemas)
		this.registerBuiltIn("edit", editTool, schemas)
		this.registerBuiltIn("edit_file", editFileTool, schemas)
		this.registerBuiltIn("execute_command", executeCommandTool, schemas)
		this.registerBuiltIn("generate_image", generateImageTool, schemas)
		this.registerBuiltIn("github_api", githubApiTool, schemas)
		this.registerBuiltIn("list_files", listFilesTool, schemas)
		this.registerBuiltIn("new_task", newTaskTool, schemas)
		this.registerBuiltIn("read_command_output", readCommandOutputTool, schemas)
		this.registerBuiltIn("read_file", readFileTool, schemas)
		this.registerBuiltIn("run_slash_command", runSlashCommandTool, schemas)
		this.registerBuiltIn("search_files", searchFilesTool, schemas)
		this.registerBuiltIn("search_replace", searchReplaceTool, schemas)
		this.registerBuiltIn("skill", skillTool, schemas)
		this.registerBuiltIn("switch_mode", switchModeTool, schemas)
		this.registerBuiltIn("update_todo_list", updateTodoListTool, schemas)
		this.registerBuiltIn("use_mcp_tool", useMcpToolTool, schemas, undefined, legacyMcpSchema)
		this.registerBuiltIn("write_to_file", writeToFileTool, schemas)

		for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
			this.aliases.set(alias, canonical)
			const descriptor = this.descriptors.get(canonical)
			if (descriptor && !descriptor.aliases.includes(alias)) {
				descriptor.aliases.push(alias)
			}
		}

		for (const schema of options.mcpTools ?? []) {
			if (schema.type !== "function") {
				continue
			}
			const name = schema.function.name
			if (this.descriptors.has(name)) {
				continue
			}
			this.register({
				name,
				aliases: [],
				schema,
				capabilities: getToolCapabilities(name),
				execute: async ({ task, call, callbacks }) => {
					const parsed = parseMcpToolName(name)
					if (!parsed) {
						callbacks.pushToolResult(formatResponse.toolError(`Invalid MCP tool name "${name}".`))
						return
					}

					const mcpCall: ToolUse<"use_mcp_tool"> = {
						type: "tool_use",
						id: call.id,
						name: "use_mcp_tool",
						params: {},
						partial: false,
						nativeArgs: {
							server_name: parsed.serverName,
							tool_name: parsed.toolName,
							arguments:
								call.nativeArgs && typeof call.nativeArgs === "object"
									? (call.nativeArgs as Record<string, unknown>)
									: undefined,
						},
					}
					await useMcpToolTool.handle(task, mcpCall, callbacks)
				},
			})
		}

		this.registerCustomTools(options)
	}

	private registerCustomTools(options: ToolRegistryOptions): void {
		if (options.includeCustomTools) {
			const serializedTools = customToolRegistry.getAllSerialized()
			for (const customTool of customToolRegistry.getAll()) {
				const serialized = serializedTools.find((tool) => tool.name === customTool.name)
				if (!serialized || this.descriptors.has(customTool.name)) {
					continue
				}

				this.register({
					name: customTool.name,
					aliases: [],
					schema: formatNative(serialized),
					capabilities: getToolCapabilities("custom_tool"),
					execute: async ({ task, call, callbacks }) => {
						try {
							const args = customTool.parameters?.parse(call.nativeArgs ?? {}) ?? call.nativeArgs ?? {}
							const result = await customTool.execute(args, {
								mode: await task.getTaskMode(),
								task,
							})
							callbacks.pushToolResult(result)
						} catch (error) {
							callbacks.pushToolResult(
								formatResponse.toolError(
									`Error executing custom tool "${customTool.name}": ${error instanceof Error ? error.message : String(error)}`,
								),
							)
						}
					},
				})
			}
		}
	}

	private registerBuiltIn<TName extends BuiltInToolName>(
		name: TName,
		tool: BaseTool<TName>,
		schemas: Map<string, OpenAI.Chat.ChatCompletionTool>,
		customExecute?: (context: ToolExecutionContext) => Promise<void>,
		fallbackSchema?: OpenAI.Chat.ChatCompletionTool,
	): void {
		const schema = schemas.get(name) ?? fallbackSchema
		if (!schema) {
			throw new Error(`No provider-facing schema registered for built-in tool "${name}".`)
		}

		this.register({
			name,
			aliases: [],
			schema,
			capabilities: getToolCapabilities(name),
			execute: customExecute ?? executeBaseTool(tool, name),
		})
	}

	register(descriptor: ToolDescriptor): void {
		if (this.descriptors.has(descriptor.name)) {
			throw new Error(`Tool "${descriptor.name}" is already registered.`)
		}
		this.descriptors.set(descriptor.name, descriptor)
		for (const alias of descriptor.aliases) {
			this.aliases.set(alias, descriptor.name)
		}
	}

	resolve(name: string): ToolDescriptor | undefined {
		const normalizedName = name.startsWith("mcp__") ? normalizeMcpToolName(name) : name
		return this.descriptors.get(this.aliases.get(normalizedName) ?? normalizedName)
	}

	canonicalName(name: string): string {
		const normalizedName = name.startsWith("mcp__") ? normalizeMcpToolName(name) : name
		return this.aliases.get(normalizedName) ?? normalizedName
	}

	has(name: string): boolean {
		return this.resolve(name) !== undefined
	}

	getSchema(name: string): OpenAI.Chat.ChatCompletionTool | undefined {
		return this.resolve(name)?.schema
	}

	list(): ToolDescriptor[] {
		return Array.from(this.descriptors.values())
	}

	getSchemas(): OpenAI.Chat.ChatCompletionTool[] {
		return this.list().map((descriptor) => descriptor.schema)
	}
}

/**
 * Construct the runtime registry using the same provider-facing definitions
 * used to build the model request. This keeps execution and prompting aligned
 * while allowing the registry to be tested independently with fixture schemas.
 */
export async function createTaskToolRegistry(task: Task): Promise<ToolRegistry> {
	const provider = task.providerRef.deref()
	const state = provider ? await provider.getState() : undefined
	const model = task.api.getModel()

	return new ToolRegistry({
		nativeTools: getNativeTools({ supportsImages: model.info.supportsImages ?? false }),
		mcpTools: getMcpServerTools(provider?.getMcpHub()),
		includeCustomTools: state?.experiments?.customTools === true,
	})
}
