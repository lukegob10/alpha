import type { AgentResponse } from "./AgentResponse"

/**
 * Internal lifecycle records for the harness. These are not UI messages,
 * persisted API history, or extension IPC records.
 */
export type AgentTurnEvent =
	| { type: "assistant_committed"; response: AgentResponse }
	| {
			type: "tool_result"
			callId: string
			name: string
			status: "success" | "error" | "denied" | "cancelled"
			output: unknown
			truncated?: boolean
			timedOut?: boolean
	  }
	| { type: "tool_batch_started"; batchSize: number }
	| {
			type: "tool_batch_finished"
			status: "completed" | "aborted"
			batchSize: number
			parallelBatchCount: number
			parallelToolCount: number
			durationMs: number
			truncatedResultCount: number
	  }
	| {
			type: "approval_request"
			requestId: string
			callId?: string
			toolName?: string
			reason?: string
	  }
	| {
			type: "approval_result"
			requestId: string
			decision: "approved" | "denied" | "cancelled"
			reason?: string
	  }
	| { type: "progress"; callId?: string; icon?: string; text?: string }
	| { type: "retry"; attempt: number; reason: string; delayMs?: number }
	| { type: "model_request_started"; attempt: number }
	| {
			type: "request_usage"
			requestIndex: number
			retry: boolean
			inputTokens: number
			outputTokens: number
			cacheReadTokens: number
	  }
	| {
			type: "context_refreshed"
			stableDigest: string
			volatileDigest: string
	  }
	| {
			type: "policy_snapshot"
			digest: string
			toolCount: number
	  }
	| {
			type: "profile_resolved"
			sourceMode: string
			profileId: "work" | "plan"
			legacyAdapter: boolean
	  }
	| {
			type: "turn_completed"
			status: "completed" | "aborted"
			toolCallCount: number
			retryCount: number
	  }
	| {
			type: "task_completed"
			status: "completed" | "aborted"
			toolCallCount: number
			retryCount: number
	  }
	| {
			type: "compaction_completed"
			action: "summary" | "truncation" | "none"
			messagesRemoved?: number
			previousTokens?: number
			newTokens?: number
	  }
	| {
			type: "verification_result"
			commandCategory: "test" | "build" | "lint" | "typecheck"
			toolName: string
			status: "success" | "error" | "denied" | "cancelled"
			durationMs: number
			exitCode?: number
			output: unknown
	  }
	| { type: "cancelled"; reason?: string }
	| {
			type: "internal_task_started"
			envelopeId: string
			childTaskId: string
			agentKind?: string
			modelRouteId: string
	  }
	| {
			type: "internal_task_completed"
			envelopeId: string
			childTaskId: string
			status: "completed" | "blocked" | "failed" | "denied" | "cancelled" | "timed_out"
			inputTokens?: number
			outputTokens?: number
	  }
