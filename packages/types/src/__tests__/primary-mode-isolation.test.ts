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

	it("defines Plan as a read-only collaboration contract with a single handoff block", () => {
		const planMode = DEFAULT_MODES.find((mode) => mode.slug === "architect")

		expect(planMode?.groups).toEqual(["read", "command", "agents"])
		expect(planMode?.customInstructions).toContain("strict Plan collaboration mode")
		expect(planMode?.customInstructions).toContain("Explore or Review")
		expect(planMode?.customInstructions).toContain("host-approved inspection or source-non-mutating verification")
		expect(planMode?.customInstructions).toContain("cannot target output, temp, cache, config, or plugin paths")
		expect(planMode?.customInstructions).toContain("<proposed_plan>")
		expect(planMode?.customInstructions).not.toContain("update_todo_list")
		expect(planMode?.customInstructions).not.toContain("switch_mode")
	})
})
