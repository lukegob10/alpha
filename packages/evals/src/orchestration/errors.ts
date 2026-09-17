import type { TrialTerminalStatus } from "../lifecycle/index"

export type OperationalErrorStatus = Extract<
	TrialTerminalStatus,
	"agent_error" | "infrastructure_error" | "grader_error" | "safety_failed" | "budget_exhausted" | "cancelled"
>

export class HarnessExecutionError extends Error {
	constructor(
		message: string,
		readonly terminalStatus: OperationalErrorStatus,
		readonly code: string,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = "HarnessExecutionError"
	}
}

export function classifyExecutionError(
	error: unknown,
	fallback: Extract<OperationalErrorStatus, "agent_error" | "infrastructure_error" | "grader_error">,
): OperationalErrorStatus {
	return error instanceof HarnessExecutionError ? error.terminalStatus : fallback
}
