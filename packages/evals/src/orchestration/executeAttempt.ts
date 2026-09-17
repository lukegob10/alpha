import type { TrialTerminalStatus } from "../lifecycle/index"
import { classifyExecutionError, HarnessExecutionError } from "./errors"
import type { AttemptExecutionPorts, AttemptObservation, AttemptSnapshot } from "./ports"

export class AttemptResumeError extends Error {
	constructor(attempt: AttemptSnapshot) {
		super(`Cannot resume attempt ${attempt.attemptNumber} from phase ${attempt.phase}`)
		this.name = "AttemptResumeError"
	}
}

export type ExecuteAttemptResult = {
	attempt: AttemptSnapshot
	status: TrialTerminalStatus
	skipped: boolean
}

export async function executeAttempt(
	input: { taskId: number; attemptNumber: number },
	ports: AttemptExecutionPorts,
): Promise<ExecuteAttemptResult> {
	let attempt = await ports.lifecycle.ensureAttempt(input.taskId, input.attemptNumber)
	if (attempt.terminalStatus) {
		await observe(ports, {
			type: "attempt_skipped",
			attemptId: attempt.id,
			attemptNumber: attempt.attemptNumber,
			detail: attempt.terminalStatus,
		})
		return { attempt, status: attempt.terminalStatus, skipped: true }
	}

	if (attempt.phase !== "created") {
		attempt = await ports.lifecycle.applyEvent(attempt.id, {
			type: "reconcile_interrupted",
			failureCode: "attempt_resume_not_supported",
			failureDetail: `attempt was re-entered in phase ${attempt.phase}`,
		})
		throw new AttemptResumeError(attempt)
	}

	let failureStatus: Extract<TrialTerminalStatus, "infrastructure_error" | "agent_error" | "grader_error"> =
		"infrastructure_error"

	try {
		attempt = await ports.lifecycle.applyEvent(attempt.id, { type: "start" })
		await observe(ports, observation("attempt_started", attempt))
		await ports.setup()
		attempt = await ports.lifecycle.applyEvent(attempt.id, { type: "setup_completed" })
		await observe(ports, observation("setup_completed", attempt))

		failureStatus = "agent_error"
		await ports.executeAgent()
		attempt = await ports.lifecycle.applyEvent(attempt.id, { type: "agent_completed" })
		await observe(ports, observation("agent_completed", attempt))

		failureStatus = "infrastructure_error"
		await ports.collectEvidence(attempt)
		attempt = await ports.lifecycle.applyEvent(attempt.id, { type: "evidence_collected" })
		await observe(ports, observation("evidence_collected", attempt))

		failureStatus = "grader_error"
		const decision = await ports.grade(attempt)
		await observe(ports, { ...observation("grade_completed", attempt), detail: decision })
		await ports.validateEvidence?.(attempt)
		attempt = await ports.lifecycle.applyEvent(attempt.id, { type: "finalize", status: decision })
		return { attempt, status: decision, skipped: false }
	} catch (error) {
		const latest = await ports.lifecycle.findAttempt(input.taskId, attempt.id)
		if (latest && !latest.terminalStatus) {
			attempt = await ports.lifecycle.applyEvent(latest.id, {
				type: "finalize",
				status: classifyExecutionError(error, failureStatus),
				failureCode:
					error instanceof HarnessExecutionError
						? error.code
						: error instanceof Error
							? error.name
							: "unknown_error",
				failureDetail: error instanceof Error ? error.message : String(error),
			})
		}
		await observe(ports, {
			...observation("attempt_failed", attempt),
			detail: error instanceof Error ? error.message : String(error),
		}).catch(() => undefined)
		throw error
	} finally {
		await ports.cleanup()
	}
}

function observation(type: AttemptObservation["type"], attempt: AttemptSnapshot): AttemptObservation {
	return { type, attemptId: attempt.id, attemptNumber: attempt.attemptNumber }
}

async function observe(ports: AttemptExecutionPorts, event: AttemptObservation): Promise<void> {
	await ports.observer?.emit(event)
}
