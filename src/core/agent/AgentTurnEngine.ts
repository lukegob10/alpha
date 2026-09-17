import type { AgentResponse } from "./AgentResponse"

export type { AgentResponse, AgentResponseItem, AgentToolCall } from "./AgentResponse"
export { AgentResponseAccumulator, collectAgentResponse } from "./AgentResponseAccumulator"

/**
 * The lifecycle state of one host-controlled step.  `completed` is the only
 * successful terminal state; the remaining states are deliberately explicit
 * so a provider/host failure cannot accidentally fall through to ordinary
 * assistant-text completion.
 */
export type AgentTurnStepStatus = "completed" | "aborted" | "failed" | "incomplete" | "exhausted" | "awaiting-user"

export interface AgentTurnStepResult<TInput> {
	response: AgentResponse
	nextInput: TInput | "complete"
	/** Explicit host result. Omitted only by legacy hosts; the engine derives it. */
	status?: AgentTurnStepStatus
	reason?: string
	error?: unknown
	/** The host selected concrete follow-up input that must run before implicit completion. */
	requiresContinuation?: boolean
}

/**
 * Host boundary for the first turn-engine extraction.
 *
 * Alpha's Task remains responsible for prompt construction, provider retries,
 * history persistence, tool execution, and UI events. The engine owns the
 * sequencing of these host-controlled steps and keeps the continuation state
 * out of the Task's outer loop.
 */
export interface AgentTurnHost<TInput> {
	runStep(input: TInput): Promise<AgentTurnStepResult<TInput>>
	shouldAbort(): boolean
	/** Hosts can retain an explicit completion contract or pending user continuation. */
	canCompleteWithoutTools?(response: AgentResponse, step: number): boolean
	onStepComplete?(response: AgentResponse, step: number): Promise<void> | void
}

export type AgentTurnOutcome =
	| {
			status: "completed"
			steps: number
			response: AgentResponse
			/** Whether the host ended explicitly or an ordinary assistant response ended the turn. */
			completionReason: "host" | "assistant"
	  }
	| { status: "aborted"; steps: number; reason?: string; response?: AgentResponse }
	| { status: "failed"; steps: number; reason: string; error?: unknown; response?: AgentResponse }
	| { status: "incomplete"; steps: number; reason?: string; response?: AgentResponse }
	| { status: "exhausted"; steps: number; reason?: string; response?: AgentResponse }
	| { status: "awaiting-user"; steps: number; reason?: string; response?: AgentResponse }

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function outcomeStatus(response: AgentResponse): AgentTurnStepStatus | undefined {
	switch (response.outcome?.status) {
		case "failed":
			return "failed"
		case "incomplete":
			return "incomplete"
		case "cancelled":
			return "aborted"
		default:
			return response.items.some((item) => item.type === "error") ? "failed" : undefined
	}
}

function terminalOutcome(
	status: Exclude<AgentTurnStepStatus, "completed">,
	steps: number,
	response: AgentResponse | undefined,
	reason?: string,
	error?: unknown,
): AgentTurnOutcome {
	const resolvedReason =
		reason ?? response?.outcome?.reason ?? response?.items.find((item) => item.type === "error")?.message
	if (status === "aborted") {
		return {
			status,
			steps,
			...(resolvedReason ? { reason: resolvedReason } : {}),
			...(response ? { response } : {}),
		}
	}
	if (status === "failed") {
		return {
			status,
			steps,
			reason: resolvedReason ?? "Agent turn failed.",
			...(error !== undefined ? { error } : {}),
			...(response ? { response } : {}),
		}
	}
	return {
		status,
		steps,
		...(resolvedReason ? { reason: resolvedReason } : {}),
		...(response ? { response } : {}),
	}
}

/**
 * Provider-neutral agent turn sequencer.
 *
 * The host still owns the current tool policy. The engine owns the turn
 * boundary, including ordinary assistant completion when the response has
 * visible text and no pending tool calls.
 */
export class AgentTurnEngine<TInput> {
	constructor(private readonly host: AgentTurnHost<TInput>) {}

	async run(initialInput: TInput): Promise<AgentTurnOutcome> {
		let input = initialInput
		let steps = 0

		try {
			while (!this.host.shouldAbort()) {
				let result: AgentTurnStepResult<TInput>
				try {
					result = await this.host.runStep(input)
				} catch (error) {
					return terminalOutcome("failed", steps, undefined, errorMessage(error), error)
				}
				steps += 1

				try {
					await this.host.onStepComplete?.(result.response, steps)
				} catch (error) {
					return terminalOutcome("failed", steps, result.response, errorMessage(error), error)
				}

				if (this.host.shouldAbort()) {
					// Preserve the historical post-step abort shape (the response is not
					// considered a completed turn once the host has cancelled it).
					return terminalOutcome("aborted", steps, undefined, result.reason)
				}

				// A host status is authoritative. This lets Task report an exhausted
				// retry budget or an awaiting-user boundary without relying on a
				// sentinel input or visible text.
				if (result.status && result.status !== "completed") {
					return terminalOutcome(
						result.status as Exclude<AgentTurnStepStatus, "completed">,
						steps,
						result.response,
						result.reason,
						result.error,
					)
				}

				// Provider lifecycle status is equally authoritative. In particular,
				// failed/incomplete/cancelled responses must never become an ordinary
				// text completion merely because text arrived before the terminal mark.
				const providerStatus = outcomeStatus(result.response)
				if (providerStatus) {
					return terminalOutcome(
						providerStatus as Exclude<AgentTurnStepStatus, "completed">,
						steps,
						result.response,
						result.reason,
					)
				}

				const isVisibleNoToolResponse =
					result.response.toolCalls.length === 0 && result.response.text.trim().length > 0
				const completedWithoutTools =
					isVisibleNoToolResponse &&
					!result.requiresContinuation &&
					(this.host.canCompleteWithoutTools?.(result.response, steps) ?? true)

				if (result.nextInput === "complete" || completedWithoutTools) {
					if (this.host.shouldAbort()) return terminalOutcome("aborted", steps, result.response)
					return {
						status: "completed",
						steps,
						response: result.response,
						completionReason: result.nextInput === "complete" ? "host" : "assistant",
					}
				}

				input = result.nextInput
			}
		} catch (error) {
			// shouldAbort/callback failures are host failures, never successful
			// completion. Preserve the error for callers that need diagnostics.
			return terminalOutcome("failed", steps, undefined, errorMessage(error), error)
		}

		return terminalOutcome("aborted", steps, undefined)
	}
}
