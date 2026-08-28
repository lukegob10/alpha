import type { AgentResponse } from "./AgentResponse"

export type { AgentResponse, AgentResponseItem, AgentToolCall } from "./AgentResponse"
export { AgentResponseAccumulator, collectAgentResponse } from "./AgentResponseAccumulator"

export interface AgentTurnStepResult<TInput> {
	response: AgentResponse
	nextInput: TInput | "complete"
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
	| { status: "aborted"; steps: number }

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

		while (!this.host.shouldAbort()) {
			const result = await this.host.runStep(input)
			steps += 1

			await this.host.onStepComplete?.(result.response, steps)

			const isVisibleNoToolResponse =
				result.response.toolCalls.length === 0 && result.response.text.trim().length > 0
			const completedWithoutTools =
				isVisibleNoToolResponse &&
				!result.requiresContinuation &&
				(this.host.canCompleteWithoutTools?.(result.response, steps) ?? true)

			if (result.nextInput === "complete" || completedWithoutTools) {
				if (this.host.shouldAbort()) return { status: "aborted", steps }
				return {
					status: "completed",
					steps,
					response: result.response,
					completionReason: result.nextInput === "complete" ? "host" : "assistant",
				}
			}

			input = result.nextInput
		}

		return { status: "aborted", steps }
	}
}
