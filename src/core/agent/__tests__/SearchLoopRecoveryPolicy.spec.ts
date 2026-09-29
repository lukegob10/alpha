import { describe, expect, it } from "vitest"

import type { AgentToolCall } from "../AgentResponse"
import { SearchLoopRecoveryPolicy, formatSearchLoopRecoveryGuidance } from "../SearchLoopRecoveryPolicy"

const call = (name: string, args: unknown, id = name): AgentToolCall => ({
	type: "tool_call",
	id,
	name,
	arguments: args,
})

describe("SearchLoopRecoveryPolicy", () => {
	it("issues two recovery checkpoints before a recoverable pause", () => {
		const policy = new SearchLoopRecoveryPolicy({ searchOnlyStepLimit: 3, maxAutomaticRecoveries: 2 })
		const searchStep = [call("exec_command", { cmd: "rg -n needle src" })]

		expect(policy.observe(searchStep).action).toBe("continue")
		expect(policy.observe(searchStep).action).toBe("continue")
		expect(policy.observe(searchStep)).toMatchObject({ action: "recover", attempt: 1, recoveryAttempts: 1 })
		expect(policy.observe(searchStep).action).toBe("continue")
		expect(policy.observe(searchStep).action).toBe("continue")
		expect(policy.observe(searchStep)).toMatchObject({ action: "recover", attempt: 2, recoveryAttempts: 2 })
		expect(policy.observe(searchStep).action).toBe("continue")
		expect(policy.observe(searchStep).action).toBe("continue")
		expect(policy.observe(searchStep)).toMatchObject({
			action: "pause",
			consecutiveSearchOnlySteps: 9,
			recoveryAttempts: 2,
		})
	})

	it("counts a large parallel search batch as one model step", () => {
		const policy = new SearchLoopRecoveryPolicy({ searchOnlyStepLimit: 2 })
		const parallelSearches = Array.from({ length: 40 }, (_, index) =>
			call("execute_command", { command: `rg --files --glob file-${index}.ts` }, `search-${index}`),
		)

		expect(policy.observe(parallelSearches)).toMatchObject({
			action: "continue",
			consecutiveSearchOnlySteps: 1,
		})
	})

	it("recognizes native searches and cross-platform command aliases", () => {
		const cases: AgentToolCall[][] = [
			[call("search_files", { regex: "first", path: "src" })],
			[call("codebase_search", { query: "second" })],
			[call("shell", { command: "grep -R third src | head -20" })],
			[call("execute_command", { command: "git grep fourth -- src" })],
			[call("exec_command", { cmd: '"C:\\tools\\RG.EXE" -n fifth src' })],
		]

		for (const step of cases) {
			const policy = new SearchLoopRecoveryPolicy({ searchOnlyStepLimit: 1, maxAutomaticRecoveries: 1 })
			expect(policy.observe(step)).toMatchObject({ action: "recover", attempt: 1 })
		}
	})

	it("resets after a mixed or non-search model step", () => {
		const policy = new SearchLoopRecoveryPolicy({ searchOnlyStepLimit: 2 })
		const search = call("exec_command", { cmd: "rg -n needle src" })

		expect(policy.observe([search]).action).toBe("continue")
		expect(policy.observe([search, call("read_file", { path: "src/target.ts" })])).toMatchObject({
			action: "continue",
			consecutiveSearchOnlySteps: 0,
			recoveryAttempts: 0,
		})
		expect(policy.observe([search]).action).toBe("continue")
		expect(policy.observe([call("edit", { patch: "*** Begin Patch" })])).toMatchObject({
			action: "continue",
			consecutiveSearchOnlySteps: 0,
		})
	})

	it("keeps state isolated and supports an explicit reset", () => {
		const first = new SearchLoopRecoveryPolicy({ searchOnlyStepLimit: 1 })
		const second = new SearchLoopRecoveryPolicy({ searchOnlyStepLimit: 2 })
		const search = [call("exec_command", { cmd: "rg needle src" })]

		expect(first.observe(search).action).toBe("recover")
		expect(second.observe(search)).toMatchObject({ action: "continue", consecutiveSearchOnlySteps: 1 })
		first.reset()
		expect(first.observe([])).toMatchObject({
			action: "continue",
			consecutiveSearchOnlySteps: 0,
			recoveryAttempts: 0,
		})
	})

	it("keeps recovery guidance focused on evidence and a concrete next action", () => {
		expect(formatSearchLoopRecoveryGuidance(1)).toContain("consolidate what the returned evidence establishes")
		expect(formatSearchLoopRecoveryGuidance(1)).toContain("Rewording a query alone is not progress")
		expect(formatSearchLoopRecoveryGuidance(2)).toContain("final automatic attempt")
		expect(formatSearchLoopRecoveryGuidance(2)).toContain("concrete action")
	})
})
