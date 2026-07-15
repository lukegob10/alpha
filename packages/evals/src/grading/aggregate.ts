import type { GraderResult, GraderRunResult } from "./types"

export function aggregateGraderResults(results: GraderResult[]): GraderRunResult["decision"] {
	if (results.some(({ status }) => status === "error")) return "grader_error"
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
