import { describe, expect, it } from "vitest"

import { getDesignHandoffPrompt, MAX_DESIGN_HANDOFF_PROMPT_CHARS } from "../design-handoff"

const handoff = {
	title: "Persisted design",
	markdown: "# Persisted design\n\n## Implementation\n\n- Keep the host boundary explicit.",
	sourceTaskId: "task-1",
	digest: "a".repeat(64),
	updatedAt: 1,
}

describe("getDesignHandoffPrompt", () => {
	it("keeps the handoff scoped to its owning primary task and records provenance", () => {
		const rendered = getDesignHandoffPrompt(handoff, { taskId: "task-1" })

		expect(rendered).toEqual({
			text: expect.stringContaining(handoff.markdown),
			source: {
				kind: "design_handoff",
				path: "task:task-1:design-handoff",
				digest: handoff.digest,
			},
		})
		expect(rendered?.text).toContain("not a new requirements source")
		expect(rendered?.text).toContain("Do not silently substitute a different design")
		expect(getDesignHandoffPrompt(handoff, { taskId: "task-2" })).toBeUndefined()
	})

	it("bounds large handoffs and explains that the complete body remains stored", () => {
		const large = { ...handoff, markdown: "x".repeat(MAX_DESIGN_HANDOFF_PROMPT_CHARS * 4) }
		const rendered = getDesignHandoffPrompt(large, { taskId: "task-1", maxChars: 2_000 })

		expect(rendered).toBeDefined()
		expect(rendered!.text.length).toBeLessThanOrEqual(2_000)
		expect(rendered!.text).toContain("complete plan is retained in the host-owned handoff")
		expect(rendered!.text).toContain(`Content digest: ${handoff.digest}`)
	})
})
