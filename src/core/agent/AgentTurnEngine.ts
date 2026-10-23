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

/** One canonical provider response captured before transcript or tool effects. */
export interface AgentTurnSample<TStep = unknown> {
	response: AgentResponse
	/** Runtime-only adapter state for the remaining phases of this logical step. */
	step?: TStep
	status?: AgentTurnStepStatus
	reason?: string
	error?: unknown
}

/** Optional result from a host-owned persistence or effect boundary. */
export interface AgentTurnPhaseResult {
	status?: AgentTurnStepStatus
	reason?: string
	error?: unknown
}

/** The Task adapter selects concrete input; the engine owns whether to continue. */
export interface AgentTurnContinuation<TInput> {
	nextInput: TInput | "complete"
	requiresContinuation?: boolean
	status?: AgentTurnStepStatus
	reason?: string
	error?: unknown
}

/**
 * Host boundary for the first turn-engine extraction.
 *
 * Alpha's Task remains responsible for prompt construction, provider retries,
 * history persistence, tool execution, and UI events. The engine owns the
 * sequencing of these host-controlled steps and keeps the continuation state
 * out of the Task's outer loop.
 */
interface AgentTurnHostBase<TInput, TStep> {
	/** New staged boundary: sample, commit, perform effects, then select input. */
	sampleStep?(input: TInput): Promise<AgentTurnSample<TStep>>
	commitResponse?(sample: AgentTurnSample<TStep>, step: number): Promise<AgentTurnPhaseResult | void>
	executeEffects?(sample: AgentTurnSample<TStep>, step: number): Promise<AgentTurnPhaseResult | void>
	selectContinuation?(sample: AgentTurnSample<TStep>, step: number): Promise<AgentTurnContinuation<TInput>>
	/** Admit history-based recovery only after a failed sample's transaction and cleanup settle. */
	selectRecovery?(
		sample: AgentTurnSample<TStep>,
		step: number,
		failure: AgentTurnPhaseResult & { status: "failed" | "incomplete" },
	): Promise<AgentTurnContinuation<TInput> | undefined>
	/** Blocking completion checks remain inside the original turn and captured step. */
	admitCompletion?(
		outcome: Extract<AgentTurnOutcome, { status: "completed" }>,
	): Promise<AgentTurnContinuation<TInput> | undefined>
	/** Release process-local step state after every path through the staged transaction. */
	releaseStep?(sample: AgentTurnSample<TStep>, step: number): Promise<void> | void
	shouldAbort(): boolean
	/** Host-admitted idle work uses the same sequencer after the prior turn has drained. */
	selectIdleContinuation?(outcome: Extract<AgentTurnOutcome, { status: "completed" }>): Promise<TInput | undefined>
	/** Rechecked after admission so user input, pause, and cancellation win asynchronous races. */
	canContinueWhenIdle?(): boolean
	/** Hosts can retain an explicit completion contract or pending user continuation. */
	canCompleteWithoutTools?(response: AgentResponse, step: number): boolean
	onStepComplete?(
		response: AgentResponse,
		step: number,
	): Promise<AgentTurnPhaseResult | void> | AgentTurnPhaseResult | void
}

/** Legacy one-callback host retained with its original required method contract. */
export interface AgentTurnHost<TInput, TStep = unknown> extends AgentTurnHostBase<TInput, TStep> {
	runStep(input: TInput): Promise<AgentTurnStepResult<TInput>>
}

/** Task and new adapters can implement the sequenced transaction without a legacy loop callback. */
export interface AgentTurnStagedHost<TInput, TStep = unknown> extends AgentTurnHostBase<TInput, TStep> {
	sampleStep(input: TInput): Promise<AgentTurnSample<TStep>>
	runStep?: never
}

type AgentTurnHostAdapter<TInput, TStep> = AgentTurnHost<TInput, TStep> | AgentTurnStagedHost<TInput, TStep>

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

function mergePhaseResult(current: AgentTurnPhaseResult, next: AgentTurnPhaseResult | void): AgentTurnPhaseResult {
	// Completion and cleanup still run after a fault, but cannot replace the
	// first terminal phase or its diagnostics with a secondary failure.
	if (!next || (current.status && current.status !== "completed")) return current
	return {
		status: next.status ?? current.status,
		reason: next.reason ?? current.reason,
		error: next.error ?? current.error,
	}
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

function captureResponsePhase(phase: AgentTurnPhaseResult, response: AgentResponse): AgentTurnPhaseResult {
	if (phase.status && phase.status !== "completed") return phase
	const status = outcomeStatus(response)
	if (!status) return phase
	return {
		...phase,
		status,
		reason:
			phase.reason ?? response.outcome?.reason ?? response.items.find((item) => item.type === "error")?.message,
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
export class AgentTurnEngine<TInput, TStep = unknown> {
	private running = false
	private readonly consideredIdleOutcomes = new WeakSet<object>()

	constructor(private readonly host: AgentTurnHostAdapter<TInput, TStep>) {}

	async run(initialInput: TInput): Promise<AgentTurnOutcome> {
		if (this.running) return terminalOutcome("failed", 0, undefined, "Agent turn is already running.")
		this.running = true
		try {
			return this.host.sampleStep ? await this.runStaged(initialInput) : await this.runLegacy(initialInput)
		} finally {
			this.running = false
		}
	}

	/**
	 * Admit at most one automatic continuation for a completed turn. The Task
	 * adapter calls this only after its terminal journal and persistence drain;
	 * the returned input starts a new turn through run(), never a second loop.
	 */
	async continueIfIdle(outcome: AgentTurnOutcome): Promise<TInput | undefined> {
		if (
			outcome.status !== "completed" ||
			this.running ||
			this.consideredIdleOutcomes.has(outcome) ||
			this.host.shouldAbort() ||
			!(this.host.canContinueWhenIdle?.() ?? true)
		) {
			return undefined
		}
		this.consideredIdleOutcomes.add(outcome)
		const input = await this.host.selectIdleContinuation?.(outcome)
		if (this.running || this.host.shouldAbort() || !(this.host.canContinueWhenIdle?.() ?? true)) return undefined
		return input
	}

	private async runLegacy(initialInput: TInput): Promise<AgentTurnOutcome> {
		let input = initialInput
		let steps = 0
		const host = this.host as AgentTurnHost<TInput, TStep>

		try {
			while (!host.shouldAbort()) {
				let result: AgentTurnStepResult<TInput>
				try {
					result = await host.runStep(input)
				} catch (error) {
					return terminalOutcome(
						host.shouldAbort() ? "aborted" : "failed",
						steps,
						undefined,
						errorMessage(error),
						error,
					)
				}
				steps += 1
				result = { ...result, ...captureResponsePhase(result, result.response) }

				try {
					const completed = await this.host.onStepComplete?.(result.response, steps)
					result = { ...result, ...mergePhaseResult(result, completed) }
				} catch (error) {
					result = {
						...result,
						...mergePhaseResult(result, { status: "failed", reason: errorMessage(error), error }),
					}
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
					!result.response.outcome?.requiresContinuation &&
					(this.host.canCompleteWithoutTools?.(result.response, steps) ?? true)

				const requiresContinuation =
					result.requiresContinuation || result.response.outcome?.requiresContinuation
				if (result.nextInput === "complete" && requiresContinuation) {
					return terminalOutcome(
						"incomplete",
						steps,
						result.response,
						"Agent turn requires continuation input but the host marked the step complete.",
					)
				}
				if (result.nextInput === "complete" || completedWithoutTools) {
					if (this.host.shouldAbort()) return terminalOutcome("aborted", steps, result.response)
					const outcome: Extract<AgentTurnOutcome, { status: "completed" }> = {
						status: "completed",
						steps,
						response: result.response,
						completionReason: result.nextInput === "complete" ? "host" : "assistant",
					}
					let admission: AgentTurnContinuation<TInput> | undefined
					try {
						admission = await this.host.admitCompletion?.(outcome)
					} catch (admissionError) {
						return terminalOutcome(
							this.host.shouldAbort() ? "aborted" : "failed",
							steps,
							result.response,
							errorMessage(admissionError),
							admissionError,
						)
					}
					if (this.host.shouldAbort()) return terminalOutcome("aborted", steps, result.response)
					if (admission?.status && admission.status !== "completed") {
						return terminalOutcome(
							admission.status,
							steps,
							result.response,
							admission.reason,
							admission.error,
						)
					}
					if (admission && admission.nextInput !== "complete") {
						input = admission.nextInput
						continue
					}
					if (admission?.requiresContinuation) {
						return terminalOutcome(
							"incomplete",
							steps,
							result.response,
							"Completion requires continuation input.",
						)
					}
					return outcome
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

	private async runStaged(initialInput: TInput): Promise<AgentTurnOutcome> {
		let input = initialInput
		let steps = 0

		try {
			while (!this.host.shouldAbort()) {
				let sample: AgentTurnSample<TStep>
				try {
					sample = await this.host.sampleStep!(input)
				} catch (error) {
					return terminalOutcome(
						this.host.shouldAbort() ? "aborted" : "failed",
						steps,
						undefined,
						errorMessage(error),
						error,
					)
				}
				steps += 1

				let { status, reason, error } = captureResponsePhase(sample, sample.response)
				let recoveryEligible = status === "failed" || status === "incomplete"
				let outcome: AgentTurnOutcome | undefined
				let continuationInput: TInput | undefined
				let hasContinuation = false
				const absorbPhase = (result: AgentTurnPhaseResult | void) => {
					const merged = mergePhaseResult({ status, reason, error }, result)
					status = merged.status
					reason = merged.reason
					error = merged.error
				}

				try {
					// The host owns the transcript format, but the shared engine enforces
					// that the response commit settles before any effect can begin.
					const commitResult = await this.host.commitResponse?.(sample, steps)
					if (
						commitResult &&
						((commitResult.status && commitResult.status !== "completed") ||
							commitResult.error !== undefined)
					) {
						recoveryEligible = false
					}
					absorbPhase(commitResult)

					const sampleTerminal = status && status !== "completed" ? status : undefined
					const providerTerminal = outcomeStatus(sample.response)
					if (!sampleTerminal && !providerTerminal) {
						// After sampling starts, finish the effect transaction even if Stop
						// arrives during commit. Task settles cancelled tool receipts here.
						absorbPhase(await this.host.executeEffects?.(sample, steps))
					}
				} catch (phaseError) {
					recoveryEligible = false
					absorbPhase({ status: "failed", reason: errorMessage(phaseError), error: phaseError })
				}

				try {
					const completed = await this.host.onStepComplete?.(sample.response, steps)
					if ((completed?.status && completed.status !== "completed") || completed?.error !== undefined) {
						recoveryEligible = false
					}
					absorbPhase(completed)
				} catch (callbackError) {
					recoveryEligible = false
					absorbPhase({ status: "failed", reason: errorMessage(callbackError), error: callbackError })
				}

				try {
					if (this.host.shouldAbort()) {
						outcome = terminalOutcome("aborted", steps, undefined, reason)
					} else if (status && status !== "completed") {
						outcome = terminalOutcome(status, steps, sample.response, reason, error)
					} else {
						const providerStatus = outcomeStatus(sample.response)
						if (providerStatus) {
							outcome = terminalOutcome(
								providerStatus as Exclude<AgentTurnStepStatus, "completed">,
								steps,
								sample.response,
								reason,
							)
						} else {
							const continuation = await this.host.selectContinuation?.(sample, steps)
							if (this.host.shouldAbort()) {
								outcome = terminalOutcome("aborted", steps, sample.response, reason)
							} else if (!continuation) {
								outcome = terminalOutcome(
									"incomplete",
									steps,
									sample.response,
									"Agent turn host did not select continuation input.",
								)
							} else if (continuation.status && continuation.status !== "completed") {
								outcome = terminalOutcome(
									continuation.status,
									steps,
									sample.response,
									continuation.reason,
									continuation.error,
								)
							} else {
								const isVisibleNoToolResponse =
									sample.response.toolCalls.length === 0 && sample.response.text.trim().length > 0
								const completedWithoutTools =
									isVisibleNoToolResponse &&
									!continuation.requiresContinuation &&
									!sample.response.outcome?.requiresContinuation &&
									(this.host.canCompleteWithoutTools?.(sample.response, steps) ?? true)
								const requiresContinuation =
									continuation.requiresContinuation || sample.response.outcome?.requiresContinuation
								if (continuation.nextInput === "complete" && requiresContinuation) {
									outcome = terminalOutcome(
										"incomplete",
										steps,
										sample.response,
										"Agent turn requires continuation input but the host marked the step complete.",
									)
								} else if (continuation.nextInput === "complete" || completedWithoutTools) {
									outcome = this.host.shouldAbort()
										? terminalOutcome("aborted", steps, sample.response)
										: {
												status: "completed",
												steps,
												response: sample.response,
												completionReason:
													continuation.nextInput === "complete" ? "host" : "assistant",
											}
								} else {
									continuationInput = continuation.nextInput
									hasContinuation = true
								}
							}
						}
					}
					if (outcome?.status === "completed") {
						const admission = await this.host.admitCompletion?.(outcome)
						if (this.host.shouldAbort()) {
							outcome = terminalOutcome("aborted", steps, sample.response)
						} else if (admission?.status && admission.status !== "completed") {
							outcome = terminalOutcome(
								admission.status,
								steps,
								sample.response,
								admission.reason,
								admission.error,
							)
						} else if (admission && admission.nextInput !== "complete") {
							continuationInput = admission.nextInput
							hasContinuation = true
							outcome = undefined
						} else if (admission?.requiresContinuation) {
							outcome = terminalOutcome(
								"incomplete",
								steps,
								sample.response,
								"Completion requires continuation input.",
							)
						}
					}
				} catch (decisionError) {
					recoveryEligible = false
					outcome = terminalOutcome(
						this.host.shouldAbort() ? "aborted" : "failed",
						steps,
						sample.response,
						errorMessage(decisionError),
						decisionError,
					)
				}

				try {
					await this.host.releaseStep?.(sample, steps)
				} catch (releaseError) {
					recoveryEligible = false
					if (!outcome || outcome.status === "completed") {
						outcome = terminalOutcome(
							"failed",
							steps,
							sample.response,
							errorMessage(releaseError),
							releaseError,
						)
					}
				}

				// Cleanup is part of the step boundary and can yield to a late Stop.
				// Do not publish the completion candidate captured before that drain.
				if (outcome?.status === "completed" && this.host.shouldAbort()) {
					return terminalOutcome("aborted", steps, sample.response, reason)
				}
				if (recoveryEligible && (outcome?.status === "failed" || outcome?.status === "incomplete")) {
					if (this.host.shouldAbort()) return terminalOutcome("aborted", steps, sample.response, reason)
					// A secondary admission failure cannot hide the original failed attempt.
					let recovery: AgentTurnContinuation<TInput> | undefined
					try {
						recovery = await this.host.selectRecovery?.(sample, steps, {
							status: outcome.status,
							...(reason ? { reason } : {}),
							...(error !== undefined ? { error } : {}),
						})
					} catch {
						return this.host.shouldAbort()
							? terminalOutcome("aborted", steps, sample.response, reason)
							: outcome
					}
					if (this.host.shouldAbort()) return terminalOutcome("aborted", steps, sample.response, reason)
					if (recovery?.status && recovery.status !== "completed") {
						outcome = terminalOutcome(
							recovery.status,
							steps,
							sample.response,
							recovery.reason ?? reason,
							error ?? recovery.error,
						)
					}
					if (
						recovery &&
						recovery.nextInput !== "complete" &&
						(!recovery.status || recovery.status === "completed")
					) {
						continuationInput = recovery.nextInput
						hasContinuation = true
						outcome = undefined
					}
				}
				if (outcome) return outcome
				if (!hasContinuation) {
					return terminalOutcome(
						"incomplete",
						steps,
						sample.response,
						"Agent turn continuation input was missing.",
					)
				}
				input = continuationInput!
			}
		} catch (error) {
			return terminalOutcome("failed", steps, undefined, errorMessage(error), error)
		}

		return terminalOutcome("aborted", steps, undefined)
	}
}
