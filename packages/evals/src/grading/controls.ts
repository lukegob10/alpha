import type { GraderRunResult } from "./types"

export const graderControlKinds = ["reference", "alternative-correct", "broken", "negative"] as const
export type GraderControlKind = (typeof graderControlKinds)[number]

export const expectedGraderControlDecisions = {
	reference: "passed",
	"alternative-correct": "passed",
	broken: "outcome_failed",
	negative: "outcome_failed",
} as const satisfies Record<GraderControlKind, GraderRunResult["decision"]>

export type GraderControl = {
	id: string
	kind: GraderControlKind
	expectedDecision: GraderRunResult["decision"]
	run: () => Promise<GraderRunResult>
}

export type GraderControlAuditEntry = {
	id: string
	kind: GraderControlKind
	expectedDecision: GraderRunResult["decision"]
	actualDecision: GraderRunResult["decision"]
	passed: boolean
	result: GraderRunResult
}

export type GraderControlAudit = {
	passed: boolean
	entries: GraderControlAuditEntry[]
}

/**
 * Run the small control set that protects a grader from accepting only its
 * preferred implementation or an empty patch. Controls run serially so each
 * caller can decide how to isolate mutable workspaces and process state.
 */
export async function auditGraderControls(controls: readonly GraderControl[]): Promise<GraderControlAudit> {
	validateGraderControlSet(controls)

	const entries: GraderControlAuditEntry[] = []
	for (const control of controls) {
		const result = await control.run()
		entries.push({
			id: control.id,
			kind: control.kind,
			expectedDecision: control.expectedDecision,
			actualDecision: result.decision,
			passed: result.decision === control.expectedDecision,
			result,
		})
	}

	return { passed: entries.every(({ passed }) => passed), entries }
}

export function validateGraderControlSet(controls: readonly GraderControl[]): void {
	if (controls.length !== graderControlKinds.length) {
		throw new Error(`Expected exactly one grader control for each of: ${graderControlKinds.join(", ")}`)
	}

	const ids = new Set<string>()
	const kinds = new Set<GraderControlKind>()
	for (const control of controls) {
		if (!control.id.trim()) throw new Error("Grader control ids must be non-empty")
		if (ids.has(control.id)) throw new Error(`Duplicate grader control id: ${control.id}`)
		if (kinds.has(control.kind)) throw new Error(`Duplicate grader control kind: ${control.kind}`)
		if (control.expectedDecision !== expectedGraderControlDecisions[control.kind]) {
			throw new Error(
				`Grader control ${control.id} (${control.kind}) must expect ${expectedGraderControlDecisions[control.kind]}`,
			)
		}
		ids.add(control.id)
		kinds.add(control.kind)
	}

	for (const kind of graderControlKinds) {
		if (!kinds.has(kind)) throw new Error(`Missing grader control kind: ${kind}`)
	}
}
