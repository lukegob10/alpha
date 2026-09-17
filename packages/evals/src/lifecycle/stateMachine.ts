import type {
	AttemptLifecycleEvent,
	AttemptLifecycleState,
	AttemptPhase,
	TrialDerivedResult,
	TrialTerminalStatus,
} from "./types"

export class InvalidLifecycleTransitionError extends Error {
	constructor(
		readonly state: AttemptLifecycleState,
		readonly event: AttemptLifecycleEvent,
	) {
		super(`Invalid attempt lifecycle transition: ${describeState(state)} -> ${event.type}`)
		this.name = "InvalidLifecycleTransitionError"
	}
}

const nextPhaseByEvent: Partial<Record<AttemptLifecycleEvent["type"], [AttemptPhase, AttemptPhase]>> = {
	start: ["created", "setup"],
	setup_completed: ["setup", "agent_execution"],
	agent_completed: ["agent_execution", "evidence_collection"],
	evidence_collected: ["evidence_collection", "grading"],
}

export function initialAttemptState(): AttemptLifecycleState {
	return { phase: "created", version: 0 }
}

export function transitionAttempt(state: AttemptLifecycleState, event: AttemptLifecycleEvent): AttemptLifecycleState {
	if (state.terminalStatus) {
		throw new InvalidLifecycleTransitionError(state, event)
	}

	if (event.type === "finalize") {
		if (event.status === "passed" || event.status === "outcome_failed") {
			if (state.phase !== "grading") throw new InvalidLifecycleTransitionError(state, event)
		}

		return {
			...state,
			terminalStatus: event.status,
			failureCode: event.failureCode,
			failureDetail: event.failureDetail,
			version: state.version + 1,
		}
	}

	if (event.type === "reconcile_interrupted") {
		return {
			...state,
			terminalStatus: event.status ?? "infrastructure_error",
			failureCode: event.failureCode,
			failureDetail: event.failureDetail,
			version: state.version + 1,
		}
	}

	const transition = nextPhaseByEvent[event.type]
	if (!transition || transition[0] !== state.phase) {
		throw new InvalidLifecycleTransitionError(state, event)
	}

	return { ...state, phase: transition[1], version: state.version + 1 }
}

export function isRetryableStatus(status: TrialTerminalStatus): boolean {
	return status === "agent_error" || status === "infrastructure_error" || status === "grader_error"
}

export function deriveTrialResult(
	statuses: Array<TrialTerminalStatus | undefined>,
	options: { retryPolicyExhausted?: boolean } = {},
): TrialDerivedResult {
	const terminalStatuses = statuses.filter((status): status is TrialTerminalStatus => status !== undefined)
	const firstAttemptStatus = statuses[0]
	const passingIndex = statuses.findIndex((status) => status === "passed")
	const allAttemptsTerminal = statuses.length > 0 && terminalStatuses.length === statuses.length
	const lastStatus = terminalStatuses.at(-1)
	const retryPossible = lastStatus ? isRetryableStatus(lastStatus) : false
	const finished =
		passingIndex >= 0 || (allAttemptsTerminal && (!retryPossible || options.retryPolicyExhausted === true))
	const status = passingIndex >= 0 ? "passed" : lastStatus

	return {
		status,
		firstAttemptStatus,
		retryAssisted: passingIndex > 0,
		attemptCount: statuses.length,
		terminalAttemptCount: terminalStatuses.length,
		passed: status === "passed" ? true : finished && isScoredOutcome(status) ? false : null,
		finished,
	}
}

export function isScoredOutcome(status: TrialTerminalStatus | undefined): boolean {
	return (
		status === "passed" ||
		status === "outcome_failed" ||
		status === "safety_failed" ||
		status === "budget_exhausted"
	)
}

function describeState(state: AttemptLifecycleState): string {
	return state.terminalStatus ? `${state.phase}/${state.terminalStatus}` : state.phase
}
