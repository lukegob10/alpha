export const attemptPhases = ["created", "setup", "agent_execution", "evidence_collection", "grading"] as const
export type AttemptPhase = (typeof attemptPhases)[number]

export const trialTerminalStatuses = [
	"passed",
	"outcome_failed",
	"safety_failed",
	"budget_exhausted",
	"agent_error",
	"infrastructure_error",
	"grader_error",
	"cancelled",
	"human_handoff",
] as const
export type TrialTerminalStatus = (typeof trialTerminalStatuses)[number]

export type AttemptLifecycleState = {
	phase: AttemptPhase
	terminalStatus?: TrialTerminalStatus
	failureCode?: string
	failureDetail?: string
	version: number
}

export type AttemptLifecycleEvent =
	| { type: "start" }
	| { type: "setup_completed" }
	| { type: "agent_completed" }
	| { type: "evidence_collected" }
	| { type: "finalize"; status: TrialTerminalStatus; failureCode?: string; failureDetail?: string }
	| {
			type: "reconcile_interrupted"
			status?: Extract<TrialTerminalStatus, "infrastructure_error" | "cancelled">
			failureCode: string
			failureDetail?: string
	  }

export type TrialDerivedResult = {
	status?: TrialTerminalStatus
	firstAttemptStatus?: TrialTerminalStatus
	retryAssisted: boolean
	attemptCount: number
	terminalAttemptCount: number
	passed: boolean | null
	finished: boolean
}
