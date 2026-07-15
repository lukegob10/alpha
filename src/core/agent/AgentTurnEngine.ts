import type { AgentResponse } from "./AgentResponse"

export type { AgentResponse, AgentResponseItem, AgentToolCall, GroundingSource } from "./AgentResponse"
export { AgentResponseAccumulator, collectAgentResponse } from "./AgentResponseAccumulator"
export type { AgentTurnEvent } from "./AgentTurnEvents"
import type { StepContext } from "./StepContext"

export interface AgentTurnStepResult<TInput> {
	response: AgentResponse
	context: StepContext
	nextInput: TInput | "complete"
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
	onStepComplete?(response: AgentResponse, step: number, context: StepContext): Promise<void> | void
}

export interface AgentTurnOutcome {
	status: "completed" | "aborted"
	steps: number
}

/**
 * Provider-neutral agent turn sequencer.
 *
 * Tool scheduling is performed by the Task host after each response has been
 * normalized and committed. The engine remains focused on turn sequencing;
 * the scheduler owns capability policy and tool-result persistence.
 */
export class AgentTurnEngine<TInput> {
	constructor(private readonly host: AgentTurnHost<TInput>) {}

	async run(initialInput: TInput): Promise<AgentTurnOutcome> {
		let input = initialInput
		let steps = 0

		while (!this.host.shouldAbort()) {
			const result = await this.host.runStep(input)
			steps += 1

			await this.host.onStepComplete?.(result.response, steps, result.context)

			if (result.nextInput === "complete") {
				return {
					status: this.host.shouldAbort() ? "aborted" : "completed",
					steps,
				}
			}

			input = result.nextInput
		}

		return { status: "aborted", steps }
	}
}
