import { describe, expect, it } from "vitest"

import {
	auditGraderControls,
	expectedGraderControlDecisions,
	graderControlKinds,
	validateGraderControlSet,
	type GraderControl,
} from "../index"

const result = (decision: "passed" | "outcome_failed") =>
	({ decision, results: [] }) as Awaited<ReturnType<GraderControl["run"]>>

function controls(): GraderControl[] {
	return graderControlKinds.map((kind) => ({
		id: `control-${kind}`,
		kind,
		expectedDecision: expectedGraderControlDecisions[kind],
		run: async () => result(expectedGraderControlDecisions[kind]),
	}))
}

describe("grader control audit", () => {
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
