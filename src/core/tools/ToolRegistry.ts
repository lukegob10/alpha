import type OpenAI from "openai"
import { randomUUID } from "crypto"

import { customToolRegistry, formatNative } from "@alpha-code/core"
import {
	browserToolNames,
	discoverToolsParamsSchema,
	type CustomToolDefinition,
	type DiscoverToolsParams,
} from "@alpha-code/types"

import type { ToolResponse, ToolUse } from "../../shared/tools"
import type { ToolPolicySnapshot } from "../agent/ToolPolicy"
import { captureVerificationContent, extractMutationPaths } from "../agent/VerificationScope"
import { TOOL_ALIASES } from "../../shared/tools"
import { normalizeMcpToolName, parseMcpToolName } from "../../utils/mcp-name"
import { getNativeTools } from "../prompts/tools/native-tools"
import { discoverTools } from "../prompts/tools/native-tools/discover_tools"
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
import { reportProgressTool } from "./ReportProgressTool"
import { skillTool } from "./SkillTool"
import { spawnAgentTool } from "./SpawnAgentTool"
import { switchModeTool } from "./SwitchModeTool"
import { updateTodoListTool } from "./UpdateTodoListTool"
import { useMcpToolTool } from "./UseMcpToolTool"
import { waitAgentTool } from "./WaitAgentTool"
import { writeToFileTool } from "./WriteToFileTool"
import {
	clickElementTool,
	dragElementTool,
	handleDialogTool,
	hoverElementTool,
	listBrowserPagesTool,
	navigatePageTool,
	openBrowserPageTool,
	readPageTool,
	runPlaywrightCodeTool,
	screenshotPageTool,
	typeInPageTool,
} from "./VSCodeBrowserTool"

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

export interface TaskReadGrant {
	readonly enabled: boolean
	readonly workspaceRoot: string
	readonly showIgnoredFiles: boolean
}

/** Only the read runs concurrently. Presentation and Task state updates are joined and ordered. */
export interface PreparedToolRead {
	readonly scope: string
	run(signal?: AbortSignal): Promise<() => Promise<ToolResponse>>
}

export interface ToolDescriptor {
	name: string
	/** Alternate model-facing names. All entries resolve to `name`. */
	aliases: readonly string[]
	schema: OpenAI.Chat.ChatCompletionTool
	capabilities: ToolCapabilities
	/** Maximum text characters returned to the next model turn. */
	maxOutputChars?: number
	/** Explicit independent resource scope for approval-free kernel executors. Unknown scope is serial. */
	getConcurrencyScope?: (call: ToolUse, cwd: string) => string | undefined
	/** Audited alternative to the legacy approval/UI path, authorized by a captured step grant. */
	prepareParallelRead?: (
		task: Task,
		call: ToolUse,
		grant: TaskReadGrant,
		policy: ToolPolicySnapshot,
		signal?: AbortSignal,
	) => Promise<PreparedToolRead | undefined>
	execute(context: ToolExecutionContext): Promise<void>
}

export interface ToolRegistryOptions {
	/** Set false for isolated registry/scheduler tests that register fixtures. */
	includeBuiltIns?: boolean
	nativeTools?: readonly OpenAI.Chat.ChatCompletionTool[]
	mcpTools?: readonly OpenAI.Chat.ChatCompletionTool[]
	/** Original targets owned by the same captured schemas, including sanitized-name collisions. */
	mcpToolTargets?: ReadonlyMap<string, { serverName: string; toolName: string; source?: "global" | "project" }>
	includeCustomTools?: boolean
	/** Captured custom definitions and schemas from one catalog boundary. */
	customTools?: readonly { definition: CustomToolDefinition; schema: OpenAI.Chat.ChatCompletionTool }[]
	discovery?: { execute: (params: DiscoverToolsParams, signal?: AbortSignal) => string; maxOutputChars: number }
	/** Fail closed if the original target, source, connection or schema changes before dispatch. */
	isMcpToolCurrent?: (name: string, serverName?: string, toolName?: string, source?: "global" | "project") => boolean
	supportsImages?: boolean
}

const BARRIER_TOOLS = new Set([
	"new_task",
	"delegate_task",
	"wait_agent",
	"attempt_completion",
	"switch_mode",
	"ask_followup_question",
])

// Read-like metadata alone never grants parallel execution. The scheduler also
// requires an explicit independent scope and an approval-free execution path.
const PARALLEL_READ_TOOLS = new Set([
	"read_file",
	"list_files",
	"search_files",
	"codebase_search",
	"read_command_output",
	"list_agents",
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
	"report_progress",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
	"attempt_completion",
	"switch_mode",
	"ask_followup_question",
])

const BROWSER_TOOLS = new Set<string>(browserToolNames)

/**
 * Canonicalize a model-facing name before it enters any policy or dispatch
 * lookup. Keep this helper here rather than duplicating alias handling in the
 * scheduler, prompt builder, and validators.
 *
 * MCP providers sometimes return `mcp__server__tool` while the provider
 * schema uses `mcp--server--tool`. Both spellings are the same executable
 * descriptor and are normalized before ordinary aliases are applied.
 */
export function canonicalizeToolName(name: string): string {
	let current = name
	const seen = new Set<string>()

	while (!seen.has(current)) {
		seen.add(current)
		const normalized =
			current.startsWith("mcp__") || current.startsWith("mcp--") ? normalizeMcpToolName(current) : current
		const canonical = TOOL_ALIASES[normalized] ?? normalized
		if (canonical === current) return canonical
		current = canonical
	}

	// A malformed alias cycle should not make policy lookup recurse forever.
	return current
}

/** Backwards-friendly spelling for callers that use “canonical name”. */
export const canonicalToolName = canonicalizeToolName

function canonicalizeSchema(schema: OpenAI.Chat.ChatCompletionTool): OpenAI.Chat.ChatCompletionTool {
	if (schema.type !== "function") return schema
	const canonical = canonicalizeToolName(schema.function.name)
	if (canonical === schema.function.name) return schema
	return {
		...schema,
		function: {
			...schema.function,
			name: canonical,
		},
	}
}

function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
	if (!value || typeof value !== "object" || seen.has(value as object)) return value
	seen.add(value as object)
	for (const child of Object.values(value as Record<string, unknown>)) {
		freezeValue(child, seen)
	}
	return Object.freeze(value)
}

function cloneAndFreeze<T>(value: T): T {
	return freezeValue(structuredClone(value))
}

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
	"report_progress",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
	"edit",
	"edit_file",
	"execute_command",
	"generate_image",
	"github_api",
	...browserToolNames,
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

function getSchemaMap(tools: readonly OpenAI.Chat.ChatCompletionTool[]): Map<string, OpenAI.Chat.ChatCompletionTool> {
	const result = new Map<string, OpenAI.Chat.ChatCompletionTool>()
	for (const tool of tools) {
		if (tool.type === "function") {
			const canonical = canonicalizeToolName(tool.function.name)
			const normalized = canonicalizeSchema(tool)
			// Prefer a schema already named canonically over a legacy alias when a
			// provider sends both variants.
			if (!result.has(canonical) || tool.function.name === canonical) {
				result.set(canonical, normalized)
			}
		}
	}
	return result
}

export interface ToolCapabilityOptions {
	/**
	 * Parallel execution is deliberately opt-in. The registry defaults to a
	 * serial/barrier surface until a tool has an audited dependency contract.
	 */
	parallelExecutionEnabled?: boolean
}

/**
 * Return conservative scheduler metadata for a tool. Approval metadata describes
 * the legacy handler; audited read admission is a separate captured contract.
 */
export function getToolCapabilities(name: string, options: ToolCapabilityOptions = {}): ToolCapabilities {
	const concurrency: ToolConcurrency = BARRIER_TOOLS.has(name)
		? "barrier"
		: PARALLEL_READ_TOOLS.has(name) && options.parallelExecutionEnabled !== false
			? "parallel"
			: "serial"

	const sideEffects: ToolSideEffects = WORKSPACE_TOOLS.has(name)
		? "workspace"
		: TASK_TOOLS.has(name)
			? "task"
			: name === "github_api" ||
				  name === "use_mcp_tool" ||
				  name.startsWith("mcp") ||
				  name === "custom_tool" ||
				  BROWSER_TOOLS.has(name)
				? "external"
				: "none"

	return {
		concurrency,
		sideEffects,
		controlFlow: BARRIER_TOOLS.has(name) || name === "run_slash_command" || name === "skill",
		// Individual tool handlers own the exact approval prompt. This flag is
		// metadata for scheduling and future policy decisions, not a second prompt.
		requiresApproval: name !== "report_progress",
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
				if (task.abort || (task.canMutateWorkspace && !task.canMutateWorkspace())) return
				if (CHECKPOINT_TOOLS.has(name) || name === "new_task") {
					await checkpointBeforeMutation(task)
				}
				const paths = task.taskKind === "primary" ? extractMutationPaths(call) : undefined
				const before = paths ? await captureVerificationContent(task.cwd, paths) : undefined
				const mutationOwner = task.providerRef.deref()
				const reservation = callbacks.toolCallId ?? randomUUID()
				if (before) {
					if (!mutationOwner) throw new Error("Primary mutation ledger is unavailable")
					await mutationOwner.reservePrimaryMutation(task, reservation)
				}
				let executionFailed = false
				let executionError: unknown
				try {
					await run()
				} catch (error) {
					executionFailed = true
					executionError = error
				}
				try {
					if (before && paths) {
						let after: Record<string, string>
						try {
							after = await captureVerificationContent(task.cwd, paths)
						} catch (error) {
							await task.providerRef
								.deref()
								?.recordPrimaryMutation(
									task,
									Object.fromEntries(Object.keys(before).map((file) => [file, "unavailable"])),
									true,
								)
							throw error
						}
						const changes = Object.fromEntries(
							Object.entries(after).filter(([file, version]) => before[file] !== version),
						)
						if (Object.keys(changes).length > 0)
							await task.providerRef.deref()?.recordPrimaryMutation(task, changes)
						await mutationOwner!.releasePrimaryMutation(task, reservation)
					}
				} catch (error) {
					if (executionFailed)
						throw new AggregateError(
							[executionError, error],
							"Tool execution and mutation observation failed",
						)
					throw error
				}
				if (executionFailed) throw executionError
			})
			return
		}
		await run()
	}
}

export class ToolRegistry {
	private readonly descriptors = new Map<string, ToolDescriptor>()
	private readonly aliases = new Map<string, string>()
	private sealed = false

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
		this.registerBuiltIn("report_progress", reportProgressTool, schemas)
		this.registerBuiltIn("followup_task", followupTaskTool, schemas)
		this.registerBuiltIn("interrupt_agent", interruptAgentTool, schemas)
		this.registerBuiltIn("cancel_agent", cancelAgentTool, schemas)
		this.registerBuiltIn("close_agent", closeAgentTool, schemas)
		this.registerBuiltIn("edit", editTool, schemas)
		this.registerBuiltIn("edit_file", editFileTool, schemas)
		this.registerBuiltIn("execute_command", executeCommandTool, schemas)
		this.registerBuiltIn("generate_image", generateImageTool, schemas)
		this.registerBuiltIn("github_api", githubApiTool, schemas)
		this.registerBuiltIn("open_browser_page", openBrowserPageTool, schemas)
		this.registerBuiltIn("list_browser_pages", listBrowserPagesTool, schemas)
		this.registerBuiltIn("read_page", readPageTool, schemas)
		this.registerBuiltIn("screenshot_page", screenshotPageTool, schemas)
		this.registerBuiltIn("navigate_page", navigatePageTool, schemas)
		this.registerBuiltIn("click_element", clickElementTool, schemas)
		this.registerBuiltIn("type_in_page", typeInPageTool, schemas)
		this.registerBuiltIn("hover_element", hoverElementTool, schemas)
		this.registerBuiltIn("drag_element", dragElementTool, schemas)
		this.registerBuiltIn("handle_dialog", handleDialogTool, schemas)
		this.registerBuiltIn("run_playwright_code", runPlaywrightCodeTool, schemas)
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
		if (schemas.has("discover_tools")) {
			const discovery = options.discovery
			this.register({
				name: "discover_tools",
				aliases: [],
				schema: discoverTools,
				capabilities: getToolCapabilities("discover_tools"),
				maxOutputChars: discovery?.maxOutputChars,
				execute: async ({ call, signal, callbacks }) => {
					signal?.throwIfAborted()
					if (!discovery) throw new Error("Tool discovery is unavailable for this catalog.")
					const parsed = discoverToolsParamsSchema.safeParse(call.nativeArgs)
					if (!parsed.success) throw new Error("Invalid tool discovery arguments.")
					callbacks.pushToolResult(discovery.execute(parsed.data, signal))
				},
			})
		}

		for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
			this.addAlias(alias, canonical)
		}

		for (const schema of options.mcpTools ?? []) {
			if (schema.type !== "function") {
				continue
			}
			const name = canonicalizeToolName(schema.function.name)
			const capturedTarget = options.mcpToolTargets?.get(name)
			if (this.descriptors.has(name)) {
				continue
			}
			this.register({
				name,
				aliases: [],
				schema: canonicalizeSchema(schema),
				capabilities: getToolCapabilities(name),
				execute: async ({ task, call, callbacks, signal }) => {
					const assertCurrent = (serverName?: string, toolName?: string, source?: "global" | "project") => {
						signal?.throwIfAborted()
						if (options.isMcpToolCurrent && !options.isMcpToolCurrent(name, serverName, toolName, source)) {
							throw new Error(
								`MCP tool "${name}" is no longer available with the captured connection and schema.`,
							)
						}
					}
					assertCurrent()
					const parsed = capturedTarget ?? parseMcpToolName(name)
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
					await useMcpToolTool.handle(task, mcpCall, {
						...callbacks,
						beforeMcpDispatch: assertCurrent,
						mcpSource: capturedTarget?.source,
						askApproval: async (...args) => {
							const approved = await callbacks.askApproval(...args)
							if (approved) assertCurrent()
							return approved
						},
					})
				},
			})
		}

		this.registerCustomTools(options)
	}

	private registerCustomTools(options: ToolRegistryOptions): void {
		if (options.customTools || options.includeCustomTools) {
			const serializedTools = options.customTools ? [] : customToolRegistry.getAllSerialized()
			const captured =
				options.customTools ??
				customToolRegistry.getAll().flatMap((definition) => {
					const serialized = serializedTools.find((tool) => tool.name === definition.name)
					return serialized ? [{ definition, schema: formatNative(serialized) }] : []
				})
			for (const { definition: customTool, schema } of captured) {
				if (this.descriptors.has(customTool.name)) {
					continue
				}
				const { execute, parameters } = customTool

				this.register({
					name: customTool.name,
					aliases: [],
					schema,
					capabilities: getToolCapabilities("custom_tool"),
					execute: async ({ task, call, callbacks }) => {
						try {
							const args = parameters?.parse(call.nativeArgs ?? {}) ?? call.nativeArgs ?? {}
							const result = await execute(args, {
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
			// Provider catalogs can be intentionally narrowed (for example, a
			// text-only browser catalog or a replay fixture). A missing schema is
			// not an executable tool for this registry, so fail closed instead of
			// inventing a model-visible contract.
			return
		}

		this.register({
			name,
			aliases: [],
			schema: canonicalizeSchema(schema),
			capabilities: getToolCapabilities(name),
			...(name === "list_files"
				? { prepareParallelRead: listFilesTool.prepareParallelRead.bind(listFilesTool) }
				: {}),
			execute: customExecute ?? executeBaseTool(tool, name),
		})
	}

	register(descriptor: ToolDescriptor): void {
		if (this.sealed) {
			throw new Error("Tool registry is sealed and cannot be changed.")
		}

		const name = canonicalizeToolName(descriptor.name)
		if (!name) {
			throw new Error("Tool descriptor name must not be empty.")
		}
		const existingAliasTarget = this.aliases.get(name)
		if (existingAliasTarget && existingAliasTarget !== name) {
			throw new Error(`Tool name "${name}" is already an alias for "${existingAliasTarget}".`)
		}
		if (this.descriptors.has(name)) {
			throw new Error(`Tool "${name}" is already registered.`)
		}
		if (descriptor.schema.type !== "function") {
			throw new Error(`Tool "${name}" must have a function schema.`)
		}
		const schemaName = canonicalizeToolName(descriptor.schema.function.name)
		if (schemaName !== name) {
			throw new Error(
				`Tool descriptor "${name}" schema resolves to "${schemaName}"; one descriptor must own both names.`,
			)
		}

		const aliases = [
			...new Set(descriptor.aliases.map((alias) => canonicalizeAlias(alias)).filter((alias) => alias !== name)),
		]
		const frozenDescriptor: ToolDescriptor = {
			...descriptor,
			name,
			aliases: Object.freeze(aliases),
			schema: cloneAndFreeze(canonicalizeSchema(descriptor.schema)),
			capabilities: Object.freeze({ ...descriptor.capabilities }),
		}
		this.descriptors.set(name, Object.freeze(frozenDescriptor))
		for (const alias of aliases) {
			this.addAlias(alias, name)
		}
	}

	resolve(name: string): ToolDescriptor | undefined {
		const canonical = canonicalizeToolName(name)
		return this.descriptors.get(this.aliases.get(canonical) ?? canonical)
	}

	canonicalName(name: string): string {
		const canonical = canonicalizeToolName(name)
		return this.aliases.get(canonical) ?? canonical
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

	/** Return a stable copy of the alias map for surface snapshots and telemetry. */
	getAliases(): Readonly<Record<string, string>> {
		return Object.freeze(Object.fromEntries(this.aliases.entries()))
	}

	/**
	 * Prevent later registration from changing a captured surface. Existing
	 * callers that build fixture registries can continue registering until they
	 * explicitly seal the registry.
	 */
	seal(): this {
		this.sealed = true
		return this
	}

	isSealed(): boolean {
		return this.sealed
	}

	private addAlias(alias: string, canonical: string): void {
		const normalizedAlias = canonicalizeAlias(alias)
		const normalizedCanonical = canonicalizeToolName(canonical)
		if (!normalizedAlias || normalizedAlias === normalizedCanonical) return
		const descriptorConflict = this.descriptors.has(normalizedAlias)
		if (descriptorConflict && normalizedAlias !== normalizedCanonical) {
			throw new Error(`Tool alias "${normalizedAlias}" conflicts with an executable descriptor of the same name.`)
		}

		const existing = this.aliases.get(normalizedAlias)
		if (existing && existing !== normalizedCanonical) {
			throw new Error(
				`Tool alias "${normalizedAlias}" is already assigned to "${existing}" and cannot resolve to "${normalizedCanonical}".`,
			)
		}
		this.aliases.set(normalizedAlias, normalizedCanonical)

		const descriptor = this.descriptors.get(normalizedCanonical)
		if (descriptor && !descriptor.aliases.includes(normalizedAlias)) {
			// Descriptors are frozen after registration. Re-registering the small
			// alias list keeps the public descriptor immutable while allowing the
			// central alias catalog to be applied after built-ins are registered.
			const aliases = Object.freeze([...descriptor.aliases, normalizedAlias])
			const nextDescriptor = Object.freeze({ ...descriptor, aliases })
			this.descriptors.set(normalizedCanonical, nextDescriptor)
		}
	}
}

function canonicalizeAlias(alias: string): string {
	return canonicalizeToolName(alias)
}
