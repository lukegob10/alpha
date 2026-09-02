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

	it("adapts execution depth to the task", () => {
		const objective = getObjectiveSection()

		expect(objective).toContain("Handle narrow, well-scoped requests directly")
		expect(objective).toContain("For substantial or multi-part work")
		expect(objective).toContain("proportionate verification")
		expect(objective).not.toContain("one at a time")
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
