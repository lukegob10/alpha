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
	| {
			type: "usage"
			inputTokens: number
			outputTokens: number
			cacheWriteTokens?: number
			cacheReadTokens?: number
			reasoningTokens?: number
			totalCost?: number
	  }
	| { type: "grounding"; sources: GroundingSource[] }
	| {
			type: "error"
			message: string
			code?: string
			retryable?: boolean
			callId?: string
			toolName?: string
	  }

export type AgentToolCall = Extract<AgentResponseItem, { type: "tool_call" }>

export interface AgentResponse {
	/** The ordered canonical response items are the source of truth. */
	items: AgentResponseItem[]
	/** Convenience projections retained for the existing Task host boundary. */
	text: string
	reasoning: string
	toolCalls: AgentToolCall[]
}
