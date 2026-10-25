import { trialTerminalStatuses, type TrialTerminalStatus } from "./types"

export type RunTaskOutcome = {
	id: number
	finishedAt: Date | null
	benchmarkTaskIdentity?: string | null
	trial?: {
		status: string
		finishedAt: Date | null
		attempts: Array<{
			terminalStatus: TrialTerminalStatus | null
			evidenceStatus?: string
			evidenceBundleDigest?: string | null
			failureCode?: string | null
		}>
	} | null
}

export type RunOutcomeSummary = {
	total: number
	counts: Record<TrialTerminalStatus, number>
	incompleteTaskIds: number[]
	invalid: number
	invalidEvidenceTaskIds: number[]
}

export function summarizeRunOutcomes(tasks: RunTaskOutcome[]): RunOutcomeSummary {
	const counts: Record<TrialTerminalStatus, number> = {
		passed: 0,
		outcome_failed: 0,
		safety_failed: 0,
		budget_exhausted: 0,
		agent_error: 0,
		infrastructure_error: 0,
		grader_error: 0,
		cancelled: 0,
		human_handoff: 0,
	}
	const incompleteTaskIds: number[] = []
	const invalidEvidenceTaskIds: number[] = []
	let invalid = 0
	for (const task of tasks) {
		const trial = task.trial
		const terminalStatus = trialTerminalStatuses.find((status) => status === trial?.status)
		if (
			!task.finishedAt ||
			!trial?.finishedAt ||
			!terminalStatus ||
			!trial.attempts.length ||
			trial.attempts.some(({ terminalStatus }) => !terminalStatus)
		) {
			incompleteTaskIds.push(task.id)
			continue
		}
		counts[terminalStatus]++
		const missingEvidence = Boolean(
			task.benchmarkTaskIdentity &&
				trial.attempts.some(
					(attempt) =>
						["passed", "outcome_failed", "safety_failed", "budget_exhausted"].includes(
							attempt.terminalStatus!,
						) &&
						// A task that was never dispatched cannot have runtime evidence.
						attempt.failureCode !== "campaign_budget_unavailable" &&
						(attempt.evidenceStatus !== "valid" ||
							!/^sha256:[a-f0-9]{64}$/.test(attempt.evidenceBundleDigest ?? "")),
				),
		)
		if (missingEvidence) invalidEvidenceTaskIds.push(task.id)
		if (missingEvidence || terminalStatus === "infrastructure_error" || terminalStatus === "grader_error") invalid++
	}
	return {
		total: tasks.length,
		counts,
		incompleteTaskIds,
		invalid,
		invalidEvidenceTaskIds,
	}
}

export function assertCompleteRun(summary: RunOutcomeSummary): void {
	if (!summary.total || summary.incompleteTaskIds.length) {
		throw new Error(`Evaluation run is incomplete: ${summary.incompleteTaskIds.join(", ") || "no tasks"}`)
	}
}

export function assertRunAcceptance(summary: RunOutcomeSummary, policy: { minimumPassRate: number }): void {
	assertCompleteRun(summary)
	if (!Number.isFinite(policy.minimumPassRate) || policy.minimumPassRate < 0 || policy.minimumPassRate > 1)
		throw new Error("Evaluation minimum pass rate must be between zero and one")
	if (summary.invalid || summary.counts.passed / summary.total < policy.minimumPassRate)
		throw new Error(`Evaluation acceptance failed: ${JSON.stringify(summary)}`)
}
