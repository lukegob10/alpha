import { describe, expect, it } from "vitest"

import {
	auditGraderControls,
	expectedGraderControlDecisions,
	graderControlKinds,
	validateGraderControlSet,
	evidenceFromText,
	type GraderControl,
} from "../index"

const result = (decision: "passed" | "outcome_failed"): Awaited<ReturnType<GraderControl["run"]>> => ({
	decision,
	results: [
		{
			graderId: "control",
			graderVersion: 1,
			type: "command",
			status: decision === "passed" ? "passed" : "failed",
			hardGate: true,
			failureClass: "outcome",
			startedAt: new Date(0).toISOString(),
			finishedAt: new Date(1).toISOString(),
			durationMs: 1,
			diagnostics: [],
			evidence: [evidenceFromText("control", "stdout", decision)],
		},
	],
})

function controls(): GraderControl[] {
	return graderControlKinds.map((kind) => ({
		id: `control-${kind}`,
		kind,
		expectedDecision: expectedGraderControlDecisions[kind],
		run: async () => result(expectedGraderControlDecisions[kind]),
	}))
}

describe("grader control audit", () => {
	it("rejects claimed control decisions without executed grader evidence", async () => {
		const audit = await auditGraderControls(
			controls().map((control) => ({
				...control,
				run: async () => ({ decision: control.expectedDecision, results: [] }),
			})),
		)
		expect(audit.passed).toBe(false)
		expect(audit.entries.every(({ actualDecision }) => actualDecision === "grader_error")).toBe(true)
	})
	it("requires reference, alternative-correct, broken, and negative controls", () => {
		const complete = controls()
		expect(() => validateGraderControlSet(complete)).not.toThrow()
		expect(() => validateGraderControlSet(complete.slice(1))).toThrow(/exactly one grader control/)
		expect(() =>
			validateGraderControlSet(complete.map((control, index) => (index === 1 ? complete[0]! : control))),
		).toThrow(/Duplicate grader control id/)
	})

	it("reports a control failure without converting it to a grader error", async () => {
		const complete = controls().map((control) =>
			control.kind === "alternative-correct"
				? { ...control, run: async () => result("outcome_failed") }
				: control,
		)
		const audit = await auditGraderControls(complete)

		expect(audit.passed).toBe(false)
		expect(audit.entries.find(({ kind }) => kind === "alternative-correct")).toMatchObject({
			actualDecision: "outcome_failed",
			passed: false,
		})
		expect(audit.entries.find(({ kind }) => kind === "broken")).toMatchObject({
			actualDecision: "outcome_failed",
			passed: true,
		})
	})
})
