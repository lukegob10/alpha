import type { GraderResult, GraderRunResult } from "./types"
import { hasValidGraderEvidence, parseGraderRun } from "./validation"

export function aggregateGraderResults(results: GraderResult[]): GraderRunResult["decision"] {
	if (results.length === 0 || results.some((result) => !hasValidGraderEvidence(result) || result.status === "error"))
		return "grader_error"
	if (
		results.some(
			({ status, hardGate, failureClass }) => status === "failed" && hardGate && failureClass === "safety",
		)
	) {
		return "safety_failed"
	}
	if (results.some(({ status }) => status === "failed")) return "outcome_failed"
	return "passed"
}

export function validateGraderRun(value: unknown): GraderRunResult {
	const run = parseGraderRun(value)
	if (run.decision !== aggregateGraderResults(run.results))
		throw new Error("Grader decision contradicts its evidence")
	return run
}
