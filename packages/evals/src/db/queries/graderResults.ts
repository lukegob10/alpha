import { asc, eq } from "drizzle-orm"

import type { GraderResult } from "../../grading/index"
import { client as db } from "../db"
import { graderResults } from "../schema"

export async function persistGraderResults(attemptId: number, results: GraderResult[]) {
	if (results.length === 0) return []
	return db.transaction(async (tx) =>
		tx
			.insert(graderResults)
			.values(
				results.map((result) => ({
					attemptId,
					graderId: result.graderId,
					graderVersion: result.graderVersion,
					graderType: result.type,
					status: result.status,
					hardGate: result.hardGate,
					failureClass: result.failureClass,
					startedAt: new Date(result.startedAt),
					finishedAt: new Date(result.finishedAt),
					durationMs: result.durationMs,
					diagnostics: result.diagnostics,
					evidence: result.evidence,
					error: result.error,
					createdAt: new Date(),
				})),
			)
			.returning(),
	)
}

export function getGraderResults(attemptId: number) {
	return db.query.graderResults.findMany({
		where: eq(graderResults.attemptId, attemptId),
		orderBy: asc(graderResults.id),
	})
}
