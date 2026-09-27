import { describe, expect, it } from "vitest"

import { PLAN_MODE_INSTRUCTIONS } from "../mode.js"

describe("Plan mode instructions", () => {
	it("conditions managed-agent guidance on the supplied tool surface", () => {
		expect(PLAN_MODE_INSTRUCTIONS).toContain("When agent lifecycle tools are supplied for this turn")
		expect(PLAN_MODE_INSTRUCTIONS).toContain("Never launch or advance a Worker")
		expect(PLAN_MODE_INSTRUCTIONS).not.toContain("You may coordinate managed Explore or Review sub-agents")
	})
})
