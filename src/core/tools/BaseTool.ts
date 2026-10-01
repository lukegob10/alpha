import type { AlphaAsk, AlphaAskResponse, CommandToolResult, ToolName, ToolProgressStatus } from "@alpha-code/types"

import { Task } from "../task/Task"
import type { ToolUse, HandleError, PushToolResult, AskApproval, NativeToolArgs } from "../../shared/tools"
import { createToolFailure, type ToolFailureMetadata } from "./ToolFailure"

export type { ToolFailureMetadata } from "./ToolFailure"

/** A captured read grant was revoked; never turn this into an interactive parallel ask. */
export class ToolReadDeniedError extends Error {}

/**
 * Full approval response for tools whose UI supports structured decisions.
 * Most tools only need the boolean askApproval callback; batch file reads also
 * support objectResponse payloads keyed by each displayed file.
 */
export interface ToolApprovalResponse {
	response: AlphaAskResponse
	text?: string
	images?: string[]
}

export type AskApprovalResponse = (
	type: AlphaAsk,
	partialMessage?: string,
	progressStatus?: ToolProgressStatus,
	forceApproval?: boolean,
	requiresExplicitApproval?: boolean,
) => Promise<ToolApprovalResponse | undefined>

/**
 * Callbacks passed to tool execution
 */
export interface TrustedExplorationObservation {
	/** Real, workspace-contained scope captured by the execution host. */
	scope: string
	/** Stable digest of supported inspection semantics; never raw command output. */
	semanticFingerprint: string
}

/** Semantic resource state captured by a host tool after a confirmed operation, never parsed from tool text. */
export interface TrustedToolProgressObservation {
	kind: "read" | "mutation"
	/** Stable resource or collection identity, scoped to its owning workspace/service. */
	scope: string
	/** Digest of substantive returned state, excluding timestamps and execution/revision IDs. */
	stateFingerprint: string
	/** For mutations, the state protected by the operation's concurrency check; absence is not a delta. */
	previousStateFingerprint?: string
}

export const MAX_TOOL_PROGRESS_OBSERVATIONS = 128

export interface ToolResultMetadata {
	status?: "success" | "error" | "denied" | "cancelled"
	executionStatus?: "running" | "success" | "error" | "denied" | "cancelled"
	exitCode?: number
	/** Structured command outcome retained alongside the legacy user-facing content string. */
	commandResult?: CommandToolResult
	timedOut?: boolean
	/** Host-issued progress observation. This is deliberately not verification evidence. */
	trustedExploration?: TrustedExplorationObservation
	/** Progress only. Does not satisfy repository verification or widen execution authority. */
	trustedProgress?: TrustedToolProgressObservation | TrustedToolProgressObservation[]
	/** Host wait classification, independent of progress or successful task completion. */
	waitOutcome?: "active" | "idle"
	/** Host digest of an opaque external request/result. Novelty permits continuation, never proves progress. */
	opaqueResultFingerprint?: string
	/** Trusted bounded cause and recovery information; never extracted from model/tool text. */
	failure?: ToolFailureMetadata
}

export interface ToolCallbacks {
	askApproval: AskApproval
	/** Optional rich approval channel for structured UI responses (for example, batch file permissions). */
	askApprovalResponse?: AskApprovalResponse
	handleError: HandleError
	pushToolResult: PushToolResult
	/** Remaining text allowance after scheduler-owned approval feedback; read tools reserve their own framing. */
	getRemainingOutputChars?: () => number
	setResultMetadata?: (metadata: ToolResultMetadata) => void
	toolCallId?: string
	signal?: AbortSignal
	/** Recheck the captured MCP contract after approval/UI waits, immediately before dispatch. */
	beforeMcpDispatch?: (serverName: string, toolName: string, source?: "global" | "project") => void
	/** Host-captured server scope for a dynamic descriptor; never read from model arguments. */
	mcpSource?: "global" | "project"
	resolveCommandTimeoutMs?: (requestedTimeoutMs: number | null | undefined, command: string) => number
	/** Present only for exec_command and write_stdin model calls. */
	commandResultMaxOutputTokens?: number
	/** Present only for the native exec_command and write_stdin aliases. */
	commandResultFormat?: "codex"
}

/**
 * Serialize a command result while keeping its JSON envelope intact within the available character budget.
 * The tool output is trimmed before the returned string is serialized for the model.
 */
export function serializeCommandToolResult(result: CommandToolResult, maxCharacters: number): string {
	const budget = Math.max(0, Math.floor(maxCharacters))
	const serialize = (output: string) => JSON.stringify({ ...result, output })
	const complete = serialize(result.output)
	if (complete.length <= budget) return complete

	const empty = serialize("")
	// The envelope itself is the minimum valid representation. Keep it intact
	// when a host supplies a budget too small to fit the metadata.
	if (empty.length > budget) return empty
	if (result.output.length === 0) return empty

	const marker = "\n[output truncated]"
	let low = 0
	let high = result.output.length
	let best = empty
	while (low <= high) {
		const length = Math.floor((low + high) / 2)
		const output = `${result.output.slice(0, length)}${marker}`
		const candidate = serialize(output)
		if (candidate.length <= budget) {
			best = candidate
			low = length + 1
		} else {
			high = length - 1
		}
	}
	return best
}

export function getCommandToolResultLimit(callbacks: ToolCallbacks): number {
	const requestedLimit =
		callbacks.commandResultMaxOutputTokens !== undefined
			? Math.max(0, Math.floor(callbacks.commandResultMaxOutputTokens * 4))
			: Number.MAX_SAFE_INTEGER
	return Math.min(requestedLimit, callbacks.getRemainingOutputChars?.() ?? requestedLimit)
}

export function boundCommandToolResult(result: CommandToolResult, maxCharacters: number): CommandToolResult {
	return JSON.parse(serializeCommandToolResult(result, maxCharacters)) as CommandToolResult
}

/** Format native command aliases like Codex; the cap applies to command output, not the headers. */
export function formatCommandToolResult(result: CommandToolResult, maxCharacters: number, chunkId?: string): string {
	const lines = [
		...(chunkId ? [`Chunk ID: ${chunkId}`] : []),
		`Wall time: ${result.wall_time_seconds.toFixed(4)} seconds`,
		...(typeof result.exit_code === "number" ? [`Process exited with code ${result.exit_code}`] : []),
		...(result.session_id ? [`Process running with session ID ${result.session_id}`] : []),
		...(typeof result.original_token_count === "number"
			? [`Original token count: ${result.original_token_count}`]
			: []),
		"Output:",
	]
	const prefix = `${lines.join("\n")}\n`
	const artifactNote = result.artifact_id
		? `\nOutput truncated. Read artifact ${result.artifact_id} with read_command_output.`
		: ""
	const budget = Math.max(0, Math.floor(maxCharacters))
	const marker = "\n[output truncated]"
	const output =
		result.output.length <= budget
			? result.output
			: budget <= marker.length
				? result.output.slice(0, budget)
				: `${result.output.slice(0, budget - marker.length)}${marker}`
	return `${prefix}${output}${artifactNote}`
}

/**
 * Helper type to extract the parameter type for a tool based on its name.
 * If the tool has native args defined in NativeToolArgs, use those; otherwise fall back to any.
 */
type ToolParams<TName extends ToolName> = TName extends keyof NativeToolArgs ? NativeToolArgs[TName] : any

/**
 * Abstract base class for all tools.
 *
 * Tools receive typed arguments from native tool calling via `ToolUse.nativeArgs`.
 *
 * @template TName - The specific tool name, which determines native arg types
 */
export abstract class BaseTool<TName extends ToolName> {
	/**
	 * The tool's name (must match ToolName type)
	 */
	abstract readonly name: TName

	/**
	 * Track the last seen path during streaming to detect when the path has stabilized.
	 * Used by hasPathStabilized() to prevent displaying truncated paths from partial-json parsing.
	 */
	protected lastSeenPartialPath: string | undefined = undefined

	/**
	 * Execute the tool with typed parameters.
	 *
	 * Receives typed parameters from native tool calling via `ToolUse.nativeArgs`.
	 *
	 * @param params - Typed parameters
	 * @param task - Task instance with state and API access
	 * @param callbacks - Tool execution callbacks (approval, error handling, results)
	 */
	abstract execute(params: ToolParams<TName>, task: Task, callbacks: ToolCallbacks): Promise<void>

	/**
	 * Handle partial (streaming) tool messages.
	 *
	 * Default implementation does nothing. Tools that support streaming
	 * partial messages should override this.
	 *
	 * @param task - Task instance
	 * @param block - Partial ToolUse block
	 */
	async handlePartial(task: Task, block: ToolUse<TName>): Promise<void> {
		// Default: no-op for partial messages
		// Tools can override to show streaming UI updates
	}

	/**
	 * Check if a path parameter has stabilized during streaming.
	 *
	 * During native tool call streaming, the partial-json library may return truncated
	 * string values when chunk boundaries fall mid-value. This method tracks the path
	 * value between consecutive handlePartial() calls and returns true only when the
	 * path has stopped changing (stabilized).
	 *
	 * Usage in handlePartial():
	 * ```typescript
	 * if (!this.hasPathStabilized(block.params.path)) {
	 *     return // Path still changing, wait for it to stabilize
	 * }
	 * // Path is stable, proceed with UI updates
	 * ```
	 *
	 * @param path - The current path value from the partial block
	 * @returns true if path has stabilized (same value seen twice) and is non-empty, false otherwise
	 */
	protected hasPathStabilized(path: string | undefined): boolean {
		const pathHasStabilized = this.lastSeenPartialPath !== undefined && this.lastSeenPartialPath === path
		this.lastSeenPartialPath = path
		return pathHasStabilized && !!path
	}

	/**
	 * Reset the partial state tracking.
	 *
	 * Should be called at the end of execute() (both success and error paths)
	 * to ensure clean state for the next tool invocation.
	 */
	resetPartialState(): void {
		this.lastSeenPartialPath = undefined
	}

	/**
	 * Main entry point for tool execution.
	 *
	 * Handles the complete flow:
	 * 1. Partial message handling (if partial)
	 * 2. Parameter parsing (nativeArgs only)
	 * 3. Core execution (execute)
	 *
	 * @param task - Task instance
	 * @param block - ToolUse block from assistant message
	 * @param callbacks - Tool execution callbacks
	 */
	async handle(task: Task, block: ToolUse<TName>, callbacks: ToolCallbacks): Promise<void> {
		// Handle partial messages
		if (block.partial) {
			try {
				await this.handlePartial(task, block)
			} catch (error) {
				console.error(`Error in handlePartial:`, error)
				await callbacks.handleError(
					`handling partial ${this.name}`,
					error instanceof Error ? error : new Error(String(error)),
				)
			}
			return
		}

		// Native-only: obtain typed parameters from `nativeArgs`.
		let params: ToolParams<TName>
		try {
			if (block.nativeArgs !== undefined) {
				// Native: typed args provided by NativeToolCallParser.
				params = block.nativeArgs as ToolParams<TName>
			} else {
				// If legacy/XML markup was provided via params, surface a clear error.
				const paramsText = (() => {
					try {
						return JSON.stringify(block.params ?? {})
					} catch {
						return ""
					}
				})()
				if (paramsText.includes("<") && paramsText.includes(">")) {
					throw new Error(
						"XML tool calls are no longer supported. Use native tool calling (nativeArgs) instead.",
					)
				}
				throw new Error("Tool call is missing native arguments (nativeArgs).")
			}
		} catch (error) {
			console.error(`Error parsing parameters:`, error)
			callbacks.setResultMetadata?.({
				status: "error",
				failure: createToolFailure({
					reason: "invalid_arguments",
					scopeKind: "operation",
					scopeIdentity: [this.name, block.nativeArgs ?? block.params],
					effectsStarted: "no",
					outcome: "known",
					recovery: { kind: "repair" },
				}),
			})
			const errorMessage = `Failed to parse ${this.name} parameters: ${error instanceof Error ? error.message : String(error)}`
			await callbacks.handleError(`parsing ${this.name} args`, new Error(errorMessage))
			// Note: handleError already emits a tool_result via formatResponse.toolError in the caller.
			// Do NOT call pushToolResult here to avoid duplicate tool_result payloads.
			return
		}

		// Execute with typed parameters
		const toolCallId = callbacks.toolCallId || block.id
		const execute = () => this.execute(params, task, toolCallId ? { ...callbacks, toolCallId } : callbacks)
		if (toolCallId && typeof task.withToolInputContext === "function")
			await task.withToolInputContext(toolCallId, execute)
		else await execute()
	}
}
