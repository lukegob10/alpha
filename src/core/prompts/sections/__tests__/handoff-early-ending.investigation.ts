import { createDesignHandoff } from "../../../task-persistence/designHandoff"
import { getDesignHandoffPrompt, MAX_DESIGN_HANDOFF_PROMPT_CHARS } from "../design-handoff"

describe("large design handoff visibility observations", () => {
	it("retains a small complete handoff in the next model prompt", () => {
		const markdown = "# Implementation\n\n- Requirement A\n- Requirement B"
		const handoff = createDesignHandoff(`<proposed_plan>\n${markdown}\n</proposed_plan>`, "task-1")!
		expect(handoff).toBeDefined()
		expect(getDesignHandoffPrompt(handoff, { taskId: "task-1" })?.text).toContain(markdown)
	})

	it("stores the complete large handoff while repeatedly attaching only its prefix", () => {
		const tailRequirement = "FINAL REQUIREMENT: Implement and verify the remaining nine integrations."
		const markdown = `# Large implementation\n\n${"Implementation detail.\n".repeat(2_000)}\n${tailRequirement}`
		const handoff = createDesignHandoff(`<proposed_plan>\n${markdown}\n</proposed_plan>`, "task-1")!
		expect(handoff.markdown).toContain(tailRequirement)
		const first = getDesignHandoffPrompt(handoff, { taskId: "task-1" })!
		const afterReload = getDesignHandoffPrompt(structuredClone(handoff), { taskId: "task-1" })!
		expect(first.text.length).toBeLessThanOrEqual(MAX_DESIGN_HANDOFF_PROMPT_CHARS)
		expect(first.text).not.toContain(tailRequirement)
		expect(first.text).toContain("Only this bounded excerpt is attached")
		expect(afterReload).toEqual(first)
		expect(first.source.path).toBe("task:task-1:design-handoff")
	})

	it("can omit most of a valid handoff at the smallest Task prompt allowance", () => {
		const markdown = `# Large implementation\n\n${"Detail.\n".repeat(1_000)}\nTAIL REQUIREMENT`
		const handoff = createDesignHandoff(`<proposed_plan>\n${markdown}\n</proposed_plan>`, "task-1")!
		const prompt = getDesignHandoffPrompt(handoff, { taskId: "task-1", maxChars: 4_096 })!
		expect(handoff.markdown).toContain("TAIL REQUIREMENT")
		expect(prompt.text.length).toBeLessThanOrEqual(4_096)
		expect(prompt.text).not.toContain("TAIL REQUIREMENT")
	})
})
