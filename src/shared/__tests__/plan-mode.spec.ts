import { ensureProposedPlanBlock, hasCompleteProposedPlan, parsePlanModeCommand, parseProposedPlan } from "../plan-mode"

describe("Plan collaboration helpers", () => {
	it("parses /plan with an optional inline multi-line prompt", () => {
		expect(parsePlanModeCommand("/plan")).toEqual({ prompt: "", rewrittenText: "" })
		expect(parsePlanModeCommand("/plan inspect auth\nand cover retries")).toEqual({
			prompt: "inspect auth\nand cover retries",
			rewrittenText: "inspect auth\nand cover retries",
		})
	})

	it("preserves the user-message envelope for extension-side parsing", () => {
		expect(parsePlanModeCommand("<user_message>\n/plan inspect auth\n</user_message>")).toEqual({
			prompt: "inspect auth",
			rewrittenText: "<user_message>\ninspect auth\n</user_message>",
		})
		expect(parsePlanModeCommand("/planner inspect auth")).toBeUndefined()
	})

	it("recognizes only an exact non-empty proposed-plan handoff", () => {
		expect(parseProposedPlan("<proposed_plan>\n# Plan\n</proposed_plan>")).toEqual({
			content: "# Plan",
			complete: true,
		})
		expect(hasCompleteProposedPlan("before\n<proposed_plan>Plan</proposed_plan>")).toBe(false)
		expect(hasCompleteProposedPlan("<proposed_plan></proposed_plan>")).toBe(false)
		expect(parseProposedPlan("<proposed_plan>\n# Streaming", true)).toEqual({
			content: "# Streaming",
			complete: false,
		})
	})

	it.each([
		"<proposed_plan>outer<proposed_plan>inner</proposed_plan>",
		"<proposed_plan><proposed_plan>inner</proposed_plan></proposed_plan>",
		"<proposed_plan>one</proposed_plan><proposed_plan>two</proposed_plan>",
		"<proposed_plan>outer</proposed_plan></proposed_plan>",
	])("rejects multiple or nested proposed-plan wrappers", (value) => {
		expect(parseProposedPlan(value)).toBeUndefined()
		expect(hasCompleteProposedPlan(value)).toBe(false)
	})

	it("rejects nested wrappers in incomplete streaming content", () => {
		expect(parseProposedPlan("<proposed_plan>outer<proposed_plan>inner", true)).toBeUndefined()
	})

	it("normalizes plain provider text to one exact handoff block", () => {
		expect(ensureProposedPlanBlock("# Plan\n- Change the parser")).toBe(
			"<proposed_plan>\n# Plan\n- Change the parser\n</proposed_plan>",
		)
		expect(ensureProposedPlanBlock("<proposed_plan>Plan</proposed_plan>")).toBe(
			"<proposed_plan>\nPlan\n</proposed_plan>",
		)
	})

	it("extracts one clean handoff when a provider adds prose or nested wrappers", () => {
		expect(
			ensureProposedPlanBlock(
				"Here is the result:\n<proposed_plan>\n# Plan\n<proposed_plan>- Inspect</proposed_plan>\n</proposed_plan>\nDone.",
			),
		).toBe("<proposed_plan>\n# Plan\n- Inspect\n</proposed_plan>")
		expect(ensureProposedPlanBlock("<proposed_plan></proposed_plan>")).toContain(
			"No implementation plan was provided",
		)
	})
})
