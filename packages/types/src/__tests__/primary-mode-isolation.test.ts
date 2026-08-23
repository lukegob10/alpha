import { describe, expect, it } from "vitest"

import { DEFAULT_MODES } from "../mode.js"

describe("primary Code mode isolation", () => {
	it("keeps managed-agent operations out of the primary behavioral instructions", () => {
		const codeMode = DEFAULT_MODES.find((mode) => mode.slug === "code")

		expect(codeMode?.customInstructions).toBeDefined()
		expect(codeMode?.customInstructions).not.toContain("spawn_agent")
		expect(codeMode?.customInstructions).not.toContain("delegate_task")
		expect(codeMode?.customInstructions).not.toContain("write_scope")
		expect(codeMode?.customInstructions).not.toContain("terminal report is automatically included")
	})
})
