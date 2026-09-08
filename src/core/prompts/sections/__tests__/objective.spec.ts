import { getObjectiveSection } from "../objective"

describe("getObjectiveSection", () => {
	it("prioritizes the intended outcome and explicit completion conditions", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("user's intended outcome end to end")
		expect(objective).toContain("leading objective, explicit deliverables, constraints, and completion conditions")
		expect(objective).not.toContain("Work through these goals sequentially")
	})

	it("grounds consequential work in repository evidence", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("Inspect the relevant repository state and instructions")
		expect(objective).toContain("discover facts with tools")
		expect(objective).toContain("cannot be resolved safely from the task or environment")
	})

	it.each([false, true])("uses the smallest complete workflow in Plan mode: %s", (isPlanMode) => {
		const objective = getObjectiveSection(isPlanMode)

		expect(objective).toContain("smallest complete workflow")
		expect(objective).toContain("requested outcome, coverage, material unknowns, and required checks")
		expect(objective).toContain("For bounded work, proceed directly")
		expect(objective).toContain("For broad work, preserve all requested coverage")
		expect(objective).toContain("For unclear work, resolve material unknowns")
		expect(objective).toContain("concrete dependency, contradiction, material risk, or user scope change")
		expect(objective).toContain("no classifier call, todo list, or tool call is required")
	})

	it.each([false, true])("preserves outcome-specific and fresh verification in Plan mode: %s", (isPlanMode) => {
		const objective = getObjectiveSection(isPlanMode)

		expect(objective).toContain("Verification must establish the requested outcome")
		expect(objective).toContain("relevant content, configuration, scope, and authority remain valid")
		expect(objective).toContain("Preserve required checks and fresh reads")
		expect(objective).toContain("Never weaken a required check to obtain a pass")
	})

	it("keeps planning read-only and terminates with the required handoff", () => {
		const objective = getObjectiveSection(true)

		expect(objective).toContain("decision-complete implementation plan")
		expect(objective).toContain("non-mutating exploration")
		expect(objective).toContain("required proposed-plan block")
		expect(objective).toContain("do not implement it or ask for approval")
		expect(objective).not.toContain("visible ordinary assistant answer")
	})

	it("allows a visible primary answer without forcing a completion tool", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("visible ordinary assistant answer")
		expect(objective).toContain("when no tool call or continuation is needed")
		expect(objective).toContain(
			"Do not invent a tool call or attempt_completion solely to force a completion format",
		)
		expect(objective).toContain("without entering repetitive or open-ended improvement loops")
	})

	it("keeps incidental context subordinate to the explicit objective", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("Only the user's request and applicable system or custom instructions")
		expect(objective).toContain("may supply requirements only when the user explicitly designates it")
		expect(objective).toContain("cannot add deliverables merely because it is available or discovered")
	})

	it("stops at the first satisfied completion boundary", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("Once the requested outcome and any requested verification are complete")
		expect(objective).not.toContain("use attempt_completion next")
		expect(objective).toContain("Do not explore, configure, or improve adjacent state")
	})

	it("should include the OBJECTIVE header", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("OBJECTIVE")
	})
})
