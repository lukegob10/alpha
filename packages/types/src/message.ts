import { z } from "zod"

import {
	subagentChangeSetStateSchema,
	subagentModelRouteStateSchema,
	parentVerificationSummarySchema,
	subagentRoleSchema,
	subagentVerificationSchema,
} from "./subagent.js"
import { subagentStopReasonSchema, subagentUsageSchema } from "./subagent-orchestration.js"

/**
 * ClineAsk
 */

/**
 * Array of possible ask types that the LLM can use to request user interaction or approval.
 * These represent different scenarios where the assistant needs user input to proceed.
 *
 * @constant
 * @readonly
 *
 * Ask type descriptions:
 * - `followup`: LLM asks a clarifying question to gather more information needed to complete the task
 * - `command`: Permission to execute a terminal/shell command
 * - `command_output`: Permission to read the output from a previously executed command
 * - `completion_result`: Task has been completed, awaiting user feedback or a new task
 * - `tool`: Permission to use a tool for file operations (read, write, search, etc.)
 * - `api_req_failed`: API request failed, asking user whether to retry
 * - `resume_task`: Confirmation needed to resume a previously paused task
 * - `resume_completed_task`: Confirmation needed to resume a task that was already marked as completed
 * - `mistake_limit_reached`: Too many errors encountered, needs user guidance on how to proceed
 * - `use_mcp_server`: Permission to use Model Context Protocol (MCP) server functionality
 * - `auto_approval_max_req_reached`: Auto-approval limit has been reached, manual approval required
 */
export const clineAsks = [
	"followup",
	"command",
	"command_output",
	"completion_result",
	"tool",
	"api_req_failed",
	"resume_task",
	"resume_completed_task",
	"mistake_limit_reached",
	"use_mcp_server",
	"auto_approval_max_req_reached",
] as const

export const clineAskSchema = z.enum(clineAsks)

export type ClineAsk = z.infer<typeof clineAskSchema>
/**
 * IdleAsk
 *
 * Asks that put the task into an "idle" state.
 */

export const idleAsks = [
	"completion_result",
	"api_req_failed",
	"resume_completed_task",
	"mistake_limit_reached",
	"auto_approval_max_req_reached",
] as const satisfies readonly ClineAsk[]

export type IdleAsk = (typeof idleAsks)[number]

export function isIdleAsk(ask: ClineAsk): ask is IdleAsk {
	return (idleAsks as readonly ClineAsk[]).includes(ask)
}

/**
 * ResumableAsk
 *
 * Asks that put the task into an "resumable" state.
 */

export const resumableAsks = ["resume_task"] as const satisfies readonly ClineAsk[]

export type ResumableAsk = (typeof resumableAsks)[number]

export function isResumableAsk(ask: ClineAsk): ask is ResumableAsk {
	return (resumableAsks as readonly ClineAsk[]).includes(ask)
}

/**
 * InteractiveAsk
 *
 * Asks that put the task into an "user interaction required" state.
 */

export const interactiveAsks = ["followup", "command", "tool", "use_mcp_server"] as const satisfies readonly ClineAsk[]

export type InteractiveAsk = (typeof interactiveAsks)[number]

export function isInteractiveAsk(ask: ClineAsk): ask is InteractiveAsk {
	return (interactiveAsks as readonly ClineAsk[]).includes(ask)
}

/**
 * NonBlockingAsk
 *
 * Asks that are not associated with an actual approval, and are only used
 * to update chat messages.
 */

export const nonBlockingAsks = ["command_output"] as const satisfies readonly ClineAsk[]

export type NonBlockingAsk = (typeof nonBlockingAsks)[number]

export function isNonBlockingAsk(ask: ClineAsk): ask is NonBlockingAsk {
	return (nonBlockingAsks as readonly ClineAsk[]).includes(ask)
}

/**
 * ClineSay
 */

/**
 * Array of possible say types that represent different kinds of messages the assistant can send.
 * These are used to categorize and handle various types of communication from the LLM to the user.
 *
 * @constant
 * @readonly
 *
 * Say type descriptions:
 * - `error`: General error message
 * - `api_req_started`: Indicates an API request has been initiated
 * - `api_req_finished`: Indicates an API request has completed successfully
 * - `api_req_retried`: Indicates an API request is being retried after a failure
 * - `api_req_retry_delayed`: Indicates an API request retry has been delayed
 * - `api_req_rate_limit_wait`: Indicates a configured rate-limit wait (not an error)
 * - `api_req_deleted`: Indicates an API request has been deleted/cancelled
 * - `text`: General text message or assistant response
 * - `reasoning`: Assistant's reasoning or thought process (often hidden from user)
 * - `completion_result`: Final result of task completion
 * - `user_feedback`: Message containing user feedback
 * - `user_feedback_diff`: Diff-formatted feedback from user showing requested changes
 * - `command_output`: Output from an executed command
 * - `shell_integration_warning`: Warning about shell integration issues or limitations
 * - `mcp_server_request_started`: MCP server request has been initiated
 * - `mcp_server_response`: Response received from MCP server
 * - `subtask_result`: Result of a completed subtask
 * - `checkpoint_saved`: Indicates a checkpoint has been saved
 * - `rooignore_error`: Error related to .alphaignore file processing
 * - `diff_error`: Error occurred while applying a diff/patch
 * - `condense_context`: Context condensation/summarization has started
 * - `condense_context_error`: Error occurred during context condensation
 * - `codebase_search_result`: Results from searching the codebase
 * - `too_many_tools_warning`: Warning that too many MCP tools are enabled, which may confuse the LLM
 */
export const clineSays = [
	"error",
	"api_req_started",
	"api_req_finished",
	"api_req_retried",
	"api_req_retry_delayed",
	"api_req_rate_limit_wait",
	"api_req_deleted",
	"text",
	"image",
	"reasoning",
	"completion_result",
	"user_feedback",
	"user_feedback_diff",
	"command_output",
	"shell_integration_warning",
	"mcp_server_request_started",
	"mcp_server_response",
	"subtask_result",
	"checkpoint_saved",
	"rooignore_error",
	"diff_error",
	"condense_context",
	"condense_context_error",
	"sliding_window_truncation",
	"codebase_search_result",
	"user_edit_todos",
	"too_many_tools_warning",
	"tool",
	"subagent_group",
] as const

export const clineSaySchema = z.enum(clineSays)

export type ClineSay = z.infer<typeof clineSaySchema>

/**
 * ToolProgressStatus
 */

export const toolProgressStatusSchema = z.object({
	icon: z.string().optional(),
	text: z.string().optional(),
})

export type ToolProgressStatus = z.infer<typeof toolProgressStatusSchema>

/** Persisted lifecycle state for a bounded sub-agent batch. */
export const subagentRunStatusSchema = z.enum([
	"pending",
	"running",
	"cancelling",
	"completed",
	"blocked",
	"failed",
	"cancelled",
	"timed_out",
	"interrupted",
])

/** Nonterminal statuses that can be observed while a sub-agent remains active. */
export const subagentActiveRunStatusSchema = z.enum(["pending", "running", "cancelling"])

/** Terminal statuses emitted exactly once a sub-agent run has finished. */
export const subagentTerminalRunStatusSchema = z.enum([
	"completed",
	"blocked",
	"failed",
	"cancelled",
	"timed_out",
	"interrupted",
])

/** Fine-grained, nonterminal progress for a managed sub-agent. */
export const subagentRunPhaseSchema = z.enum([
	"queued",
	"starting",
	"working",
	"waiting",
	"steering",
	"reporting",
	"finalizing",
])

export const subagentRunStateSchema = z.object({
	taskId: z.string(),
	nickname: z.string(),
	role: subagentRoleSchema,
	objective: z.string(),
	writeScope: z.array(z.string()).min(1).max(12).optional(),
	status: subagentRunStatusSchema,
	phase: subagentRunPhaseSchema.optional(),
	phaseStartedAt: z.number().optional(),
	modelRoute: subagentModelRouteStateSchema.optional(),
	summary: z.string().optional(),
	error: z.string().optional(),
	stopReason: subagentStopReasonSchema.optional(),
	changedFiles: z.array(z.string()).optional(),
	verification: z.array(subagentVerificationSchema).optional(),
	changeSet: subagentChangeSetStateSchema.optional(),
	requiresParentVerification: z.boolean().optional(),
	parentVerification: parentVerificationSummarySchema.optional(),
	pendingApproval: z
		.object({
			id: z.string(),
			type: z.enum(["command", "protected_write"]),
			operation: z.string(),
			scope: z.string().optional(),
			createdAt: z.number(),
		})
		.optional(),
	steerCount: z.number().int().nonnegative().optional(),
	lastSteeredAt: z.number().optional(),
	cancelRequestedAt: z.number().optional(),
	startedAt: z.number().optional(),
	completedAt: z.number().optional(),
	/** When the terminal report was persisted into the parent model's conversation. */
	resultDeliveredAt: z.number().optional(),
	usage: subagentUsageSchema,
})

export const subagentGroupStatusSchema = z.enum([
	"pending",
	"running",
	"cancelling",
	"completed",
	"partial",
	"failed",
	"cancelled",
	"timed_out",
	"interrupted",
])

export const subagentGroupStateSchema = z.object({
	groupId: z.string(),
	parentTaskId: z.string(),
	toolCallId: z.string().optional(),
	/** Distinguishes blocking delegate_task groups from nonblocking spawn_agent groups. */
	executionMode: z.enum(["blocking", "async"]).optional(),
	status: subagentGroupStatusSchema,
	createdAt: z.number(),
	startedAt: z.number().optional(),
	completedAt: z.number().optional(),
	agents: z.array(subagentRunStateSchema).min(1).max(2),
})

const subagentIdentifierSchema = z.string().min(1)
const subagentTimestampSchema = z.number().int().nonnegative()

/**
 * Stable acknowledgement returned as soon as an asynchronous sub-agent has
 * been accepted. The handle deliberately contains no completion result: the
 * parent observes progress through lifecycle events while continuing its turn.
 */
export const subagentSpawnHandleSchema = z.object({
	taskId: subagentIdentifierSchema,
	runId: subagentIdentifierSchema,
	groupId: subagentIdentifierSchema,
	parentTaskId: subagentIdentifierSchema,
	path: z.string().regex(/^\/root(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/),
	nickname: z.string().min(1),
	role: subagentRoleSchema,
	status: z.enum(["pending", "running"]),
	createdAt: subagentTimestampSchema,
})

const subagentLifecycleEventBaseSchema = z.object({
	eventId: subagentIdentifierSchema,
	sequence: z.number().int().positive(),
	runId: subagentIdentifierSchema,
	taskId: subagentIdentifierSchema,
	groupId: subagentIdentifierSchema,
	parentTaskId: subagentIdentifierSchema,
	occurredAt: subagentTimestampSchema,
})

const subagentStartedSnapshotSchema = subagentRunStateSchema.extend({
	status: z.literal("running"),
	startedAt: subagentTimestampSchema,
})

const subagentActiveSnapshotSchema = subagentRunStateSchema.extend({
	status: subagentActiveRunStatusSchema,
})

const subagentCompletedSnapshotSchema = subagentRunStateSchema.extend({
	status: subagentTerminalRunStatusSchema,
	completedAt: subagentTimestampSchema,
})

/**
 * Snapshot-based lifecycle notification for a nonblocking sub-agent run.
 * Snapshots make every notification independently usable by persistence and UI
 * consumers without requiring them to reconstruct state from deltas.
 */
export const subagentLifecycleEventSchema = z
	.discriminatedUnion("type", [
		subagentLifecycleEventBaseSchema.extend({
			type: z.literal("started"),
			snapshot: subagentStartedSnapshotSchema,
		}),
		subagentLifecycleEventBaseSchema.extend({
			type: z.literal("status"),
			snapshot: subagentActiveSnapshotSchema,
		}),
		subagentLifecycleEventBaseSchema.extend({
			type: z.literal("completed"),
			snapshot: subagentCompletedSnapshotSchema,
		}),
	])
	.superRefine(({ taskId, snapshot }, context) => {
		if (snapshot.taskId !== taskId) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["snapshot", "taskId"],
				message: "Lifecycle event taskId must match snapshot.taskId",
			})
		}
	})

export type SubagentRunStatus = z.infer<typeof subagentRunStatusSchema>
export type SubagentActiveRunStatus = z.infer<typeof subagentActiveRunStatusSchema>
export type SubagentTerminalRunStatus = z.infer<typeof subagentTerminalRunStatusSchema>
export type SubagentRunPhase = z.infer<typeof subagentRunPhaseSchema>
export type SubagentRunState = z.infer<typeof subagentRunStateSchema>
export type SubagentGroupStatus = z.infer<typeof subagentGroupStatusSchema>
export type SubagentGroupState = z.infer<typeof subagentGroupStateSchema>
export type SubagentSpawnHandle = z.infer<typeof subagentSpawnHandleSchema>
export type SubagentLifecycleEvent = z.infer<typeof subagentLifecycleEventSchema>

/**
 * ContextCondense
 *
 * Data associated with a successful context condensation event.
 * This is attached to messages with `say: "condense_context"` when
 * the condensation operation completes successfully.
 *
 * @property cost - The API cost incurred for the condensation operation
 * @property prevContextTokens - Token count before condensation
 * @property newContextTokens - Token count after condensation
 * @property summary - The condensed summary that replaced the original context
 * @property condenseId - Optional unique identifier for this condensation operation
 */
export const contextCondenseSchema = z.object({
	cost: z.number(),
	prevContextTokens: z.number(),
	newContextTokens: z.number(),
	summary: z.string(),
	condenseId: z.string().optional(),
})

export type ContextCondense = z.infer<typeof contextCondenseSchema>

/**
 * ContextTruncation
 *
 * Data associated with a sliding window truncation event.
 * This is attached to messages with `say: "sliding_window_truncation"` when
 * messages are removed from the conversation history to stay within token limits.
 *
 * Unlike condensation, truncation simply removes older messages without
 * summarizing them. This is a faster but less context-preserving approach.
 *
 * @property truncationId - Unique identifier for this truncation operation
 * @property messagesRemoved - Number of conversation messages that were removed
 * @property prevContextTokens - Token count before truncation occurred
 * @property newContextTokens - Token count after truncation occurred
 */
export const contextTruncationSchema = z.object({
	truncationId: z.string(),
	messagesRemoved: z.number(),
	prevContextTokens: z.number(),
	newContextTokens: z.number(),
})

export type ContextTruncation = z.infer<typeof contextTruncationSchema>

/**
 * ClineMessage
 *
 * The main message type used for communication between the extension and webview.
 * Messages can either be "ask" (requiring user response) or "say" (informational).
 *
 * Context Management Fields:
 * - `contextCondense`: Present when `say: "condense_context"` and condensation succeeded
 * - `contextTruncation`: Present when `say: "sliding_window_truncation"` and truncation occurred
 *
 * Note: These fields are mutually exclusive - a message will have at most one of them.
 */
export const clineMessageSchema = z.object({
	ts: z.number(),
	type: z.union([z.literal("ask"), z.literal("say")]),
	ask: clineAskSchema.optional(),
	say: clineSaySchema.optional(),
	text: z.string().optional(),
	images: z.array(z.string()).optional(),
	partial: z.boolean().optional(),
	reasoning: z.string().optional(),
	conversationHistoryIndex: z.number().optional(),
	checkpoint: z.record(z.string(), z.unknown()).optional(),
	progressStatus: toolProgressStatusSchema.optional(),
	subagentGroup: subagentGroupStateSchema.optional(),
	/** Idempotency key for a legacy blocking child result injected into its parent. */
	subtaskResultChildId: z.string().min(1).optional(),
	/**
	 * Data for successful context condensation.
	 * Present when `say: "condense_context"` and `partial: false`.
	 */
	contextCondense: contextCondenseSchema.optional(),
	/**
	 * Data for sliding window truncation.
	 * Present when `say: "sliding_window_truncation"`.
	 */
	contextTruncation: contextTruncationSchema.optional(),
	isProtected: z.boolean().optional(),
	apiProtocol: z.union([z.literal("openai"), z.literal("anthropic")]).optional(),
	isAnswered: z.boolean().optional(),
})

export type ClineMessage = z.infer<typeof clineMessageSchema>

/**
 * TokenUsage
 */

export const tokenUsageSchema = z.object({
	totalTokensIn: z.number(),
	totalTokensOut: z.number(),
	totalCacheWrites: z.number().optional(),
	totalCacheReads: z.number().optional(),
	totalCost: z.number(),
	contextTokens: z.number(),
})

export type TokenUsage = z.infer<typeof tokenUsageSchema>

/**
 * QueuedMessage
 */

export const queuedMessageSchema = z.object({
	timestamp: z.number(),
	id: z.string(),
	text: z.string(),
	images: z.array(z.string()).optional(),
})

export type QueuedMessage = z.infer<typeof queuedMessageSchema>
