import { evidenceFromText } from "../evidence"
import type { GraderContext, GraderPlugin, GraderResult, TraceAssertionGraderSpec } from "../types"

export class TraceAssertionGrader implements GraderPlugin<TraceAssertionGraderSpec> {
	readonly type = "trace-assertion" as const

	async execute(
		spec: TraceAssertionGraderSpec,
		context: GraderContext,
	): Promise<Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs">> {
		const diagnostics: GraderResult["diagnostics"] = []
		for (const assertion of spec.assertions) {
			const matching = context.trace.filter(
				({ type }) => type === ("eventType" in assertion ? assertion.eventType : ""),
			)
			let passed: boolean
			switch (assertion.kind) {
				case "present":
					passed = matching.length > 0
					break
				case "absent":
					passed = matching.length === 0
					break
				case "count-max":
					passed = matching.length <= assertion.max
					break
				case "ordered": {
					const before = context.trace.find(({ type }) => type === assertion.before)
					const after = context.trace.find(({ type }) => type === assertion.after)
					passed = !!before && !!after && before.sequence < after.sequence
					break
				}
			}
			if (!passed) {
				diagnostics.push({
					code: `trace_${assertion.kind}_failed`,
					message: `Trace assertion failed: ${JSON.stringify(assertion)}`,
					severity: "error",
				})
			}
		}
		return {
			graderId: spec.id,
			graderVersion: spec.version,
			type: spec.type,
			status: diagnostics.length === 0 ? "passed" : "failed",
			hardGate: spec.hardGate,
			failureClass: spec.failureClass,
			diagnostics,
			evidence: [
				evidenceFromText(`${spec.id}:trace`, "trace", JSON.stringify(context.trace), "application/json"),
			],
		}
	}
}
