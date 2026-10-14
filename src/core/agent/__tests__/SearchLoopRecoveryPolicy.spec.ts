import { describe, expect, it } from "vitest"

import type { AgentToolCall } from "../AgentResponse"
import { SearchLoopRecoveryPolicy, formatSearchLoopRecoveryGuidance } from "../SearchLoopRecoveryPolicy"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"

vi.mock("../../../i18n", () => ({ t: vi.fn((key: string) => key) }))

const call = (name: string, args: unknown, id = name): AgentToolCall => ({
	type: "tool_call",
	id,
	name,
	arguments: args,
})

describe("SearchLoopRecoveryPolicy", () => {
	it("continues beyond nine search steps when new trusted read receipts advance exploration", () => {
		const policy = new SearchLoopRecoveryPolicy()
		const detector = new ToolRepetitionDetector()
		let observedVersion = 0
		for (let index = 0; index < 120; index++) {
			const search = call("search_files", { path: "src", regex: `symbol${index}` }, `search-${index}`)
			detector.recordOutcome({
				toolName: search.name,
				args: search.arguments,
				kind: "read",
				status: "success",
				scope: "/workspace",
				trustedProgress: {
					kind: "read",
					scope: `/workspace/file-${index}.ts`,
					stateFingerprint: `content-${index}`,
				},
			})
			const progressVersion = detector.getProgressVersion()
			expect(policy.observe([search], { madeProgress: progressVersion !== observedVersion }).action).toBe(
				"continue",
			)
			observedVersion = progressVersion
		}
	})

	it("keeps no-progress protection when query wording changes but trusted results do not", () => {
		const policy = new SearchLoopRecoveryPolicy()
		const detector = new ToolRepetitionDetector()
		let observedVersion = 0
		const actions: string[] = []
		for (let index = 0; index < 10; index++) {
			const search = call("search_files", { regex: `cosmetic-query-${index}` })
			detector.recordOutcome({
				toolName: search.name,
				args: search.arguments,
				kind: "read",
				status: "success",
				scope: "/workspace",
				trustedProgress: {
					kind: "read",
					scope: "/workspace/same-file.ts",
					stateFingerprint: "same returned lines",
				},
			})
			const progressVersion = detector.getProgressVersion()
			actions.push(policy.observe([search], { madeProgress: progressVersion !== observedVersion }).action)
			observedVersion = progressVersion
		}
		expect(actions).toEqual([
			"continue",
			"continue",
			"continue",
			"recover",
			"continue",
			"continue",
			"recover",
			"continue",
			"continue",
			"pause",
		])
	})

	it("renews exhausted recovery attempts only after admitted progress", () => {
		const policy = new SearchLoopRecoveryPolicy()
		const step = [call("search_files", { regex: "same" })]
		for (let index = 0; index < 9; index++) policy.observe(step)
		expect(policy.observe(step, { madeProgress: true })).toMatchObject({ action: "continue", recoveryAttempts: 0 })
		for (let index = 0; index < 8; index++)
			expect(policy.observe(step, { madeProgress: false }).action).not.toBe("pause")
		expect(policy.observe(step, { madeProgress: false }).action).toBe("pause")
	})

	it.each(["error", "opaque"])("does not use %s outcome novelty to renew the recovery window", (kind) => {
		const policy = new SearchLoopRecoveryPolicy()
		const detector = new ToolRepetitionDetector()
		for (let index = 0; index < 9; index++) {
			const search = call("search_files", { regex: `different${index}` })
			detector.recordOutcome({
				toolName: search.name,
				args: search.arguments,
				kind: "read",
				status: kind === "error" ? "error" : "success",
				scope: "/workspace",
				evidenceFingerprint: kind === "error" ? `not admitted-${index}` : undefined,
				opaqueResultFingerprint: kind === "opaque" ? `opaque-${index}` : undefined,
			})
			expect(detector.getProgressVersion()).toBe(0)
			expect(policy.observe([search], { madeProgress: false }).action).toBe(
				index === 8 ? "pause" : index === 2 || index === 5 ? "recover" : "continue",
			)
		}
	})

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
