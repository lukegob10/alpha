/**
 * Provider-neutral source information attached to a response.
 *
 * This deliberately mirrors the small common shape emitted by the providers
 * without importing any provider SDK or API-stream type.
 */
export interface GroundingSource {
	title: string
	url: string
	snippet?: string
}

/** Token and cost counters reported by a provider for one model response. */
export interface AgentResponseUsage {
	inputTokens: number
	outputTokens: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	reasoningTokens?: number
	totalCost?: number
}

/** A provider-neutral error emitted while normalizing one model response. */
export interface AgentResponseError {
	type: "error"
	message: string
	code?: string
	retryable?: boolean
	callId?: string
	toolName?: string
}

/**
 * Lifecycle state for a sampled response. The optional field on
 * `AgentResponse` keeps old response literals source-compatible while making
 * non-success terminal states explicit when a provider reports one.
 */
export type AgentResponseStatus = "completed" | "incomplete" | "failed" | "cancelled"

export interface AgentResponseOutcome {
	status: AgentResponseStatus
	reason?: string
	retryable?: boolean
}

/**
 * Canonical model output consumed by the agent turn engine.
 *
 * Provider-specific response formats are normalized at the stream boundary.
 * These items are intentionally separate from UI messages and API history.
 */
export type AgentResponseItem =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string; signature?: string }
	| { type: "tool_call"; id: string; name: string; arguments: unknown }
	| ({ type: "usage" } & AgentResponseUsage)
	| { type: "grounding"; sources: GroundingSource[] }
	| AgentResponseError

export type AgentToolCall = Extract<AgentResponseItem, { type: "tool_call" }>

export interface AgentResponse {
	/** The ordered canonical response items are the source of truth. */
	items: AgentResponseItem[]
	/** Convenience projections retained for the existing Task host boundary. */
	text: string
	reasoning: string
	toolCalls: AgentToolCall[]
	/** Present when the provider/host knows the response did not complete normally. */
	outcome?: AgentResponseOutcome
}

/**
 * Build the compatibility projections from an ordered item list.
 *
 * Keeping this operation in one place prevents callers from accidentally
 * deriving text/tool calls from a provider-specific response object. The
 * returned arrays are new snapshots, while item payloads remain untouched so
 * signatures and provider metadata are not lost.
 */
export function createAgentResponse(
	items: readonly AgentResponseItem[],
	outcome?: AgentResponseOutcome,
): AgentResponse {
	const snapshot = [...items]

	return {
		items: snapshot,
		text: snapshot
			.filter((item): item is Extract<AgentResponseItem, { type: "text" }> => item.type === "text")
			.map((item) => item.text)
			.join(""),
		reasoning: snapshot
			.filter((item): item is Extract<AgentResponseItem, { type: "reasoning" }> => item.type === "reasoning")
			.map((item) => item.text)
			.join(""),
		toolCalls: snapshot.filter((item): item is AgentToolCall => item.type === "tool_call"),
		...(outcome ? { outcome } : {}),
	}
}
