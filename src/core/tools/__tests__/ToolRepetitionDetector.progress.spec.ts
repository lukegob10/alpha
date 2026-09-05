import { ToolRepetitionDetector, type ToolProgressObservation } from "../ToolRepetitionDetector"

vi.mock("../../../i18n", () => ({ t: vi.fn((key: string) => key) }))

const failedCheck: ToolProgressObservation = {
	toolName: "execute_command",
	args: { command: "pnpm test" },
	kind: "check",
	status: "error",
	scope: "/workspace",
	stateFingerprint: "content-v1",
}

describe("outcome-aware tool progress", () => {
	it("changes strategy once, then stops repeated failed checks within the configured bound", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 3 })
		const actions = Array.from(
			{ length: 7 },
			(_, index) =>
				detector.recordOutcome({ ...failedCheck, evidenceFingerprint: `different failure output ${index}` })
					.action,
		)

		expect(actions).toEqual(["continue", "continue", "change-strategy", "continue", "continue", "stop", "stop"])
	})

	it("counts alternating calls and successful handlers without outcome evidence as stagnation", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 3 })
		const actions = Array.from(
			{ length: 6 },
			(_, index) =>
				detector.recordOutcome({
					toolName: index % 2 === 0 ? "execute_command" : "use_mcp_tool",
					args: { command: index % 2 === 0 ? "pnpm test" : "pnpm test --run" },
					kind: "other",
					status: "success",
				}).action,
		)

		expect(actions.filter((action) => action === "change-strategy")).toHaveLength(1)
		expect(actions.at(-1)).toBe("stop")
	})

	it.each(["error", "denied", "cancelled"] as const)("does not accept novel evidence from a %s outcome", (status) => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		for (let index = 0; index < 4; index++) {
			const result = detector.recordOutcome({
				...failedCheck,
				status,
				evidenceFingerprint: `new output ${index}`,
			})
			expect(result.stagnantCalls).toBe(index + 1)
		}
	})

	it("accepts fresh successful evidence once and counts an unchanged passing check again", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		detector.recordOutcome(failedCheck)
		expect(detector.recordOutcome(failedCheck).action).toBe("change-strategy")

		const passingCheck: ToolProgressObservation = {
			...failedCheck,
			status: "success",
			evidenceFingerprint: "content-v1:required-test:passed",
		}
		expect(detector.recordOutcome(passingCheck)).toMatchObject({ action: "continue", stagnantCalls: 0 })
		expect(detector.recordOutcome(passingCheck).stagnantCalls).toBe(1)
		expect(detector.recordOutcome(passingCheck).action).toBe("change-strategy")
	})

	it("requires a content delta and detects returning to previously observed states", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const mutation: ToolProgressObservation = {
			toolName: "apply_patch",
			kind: "mutation",
			status: "success",
			scope: "/workspace",
			stateFingerprint: "A",
		}
		expect(detector.recordOutcome(mutation).stagnantCalls).toBe(1)
		expect(detector.recordOutcome({ ...mutation, stateFingerprint: "B" }).stagnantCalls).toBe(0)
		expect(detector.recordOutcome(mutation).stagnantCalls).toBe(1)
		expect(detector.recordOutcome({ ...mutation, stateFingerprint: "B" }).action).toBe("change-strategy")
	})

	it("accepts an actual state delta even when a mutation reports partial failure", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		detector.recordOutcome(failedCheck)
		expect(
			detector.recordOutcome({ ...failedCheck, kind: "mutation", stateFingerprint: "content-v2" }).stagnantCalls,
		).toBe(0)
	})

	it("keeps productive exploration of different files and ranges running", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		for (let index = 0; index < 40; index++) {
			expect(
				detector.recordOutcome({
					toolName: "read_file",
					args: { path: `/workspace/file-${Math.floor(index / 2)}.ts`, start_line: (index % 2) * 100 },
					scope: `/workspace/file-${Math.floor(index / 2)}.ts`,
					kind: "read",
					status: "success",
				}),
			).toMatchObject({ action: "continue", stagnantCalls: 0 })
		}
	})

	it("does not renew read novelty after the retained-history boundary is cycled", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 3, historyLimit: 8 })
		const read = (index: number): ToolProgressObservation => ({
			toolName: "read_file",
			args: { path: `/workspace/file-${index}.ts` },
			scope: "/workspace",
			kind: "read",
			status: "success",
		})

		for (let index = 0; index < 8; index++) {
			expect(detector.recordOutcome(read(index))).toMatchObject({ action: "continue", stagnantCalls: 0 })
		}
		expect([8, 0, 1, 2, 3, 4].map((index) => detector.recordOutcome(read(index)).action)).toEqual([
			"continue",
			"continue",
			"change-strategy",
			"continue",
			"continue",
			"stop",
		])

		detector.resetProgress()
		expect(detector.recordOutcome(read(0))).toMatchObject({ action: "continue", stagnantCalls: 0 })
	})

	it.each(["state", "evidence"] as const)("does not renew %s novelty after its bounded memory fills", (novelty) => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 3, historyLimit: 8 })
		const observe = (index: number): ToolProgressObservation => ({
			toolName: novelty === "state" ? "apply_patch" : "execute_command",
			kind: novelty === "state" ? "mutation" : "check",
			status: "success",
			scope: "/workspace",
			...(novelty === "state"
				? { stateFingerprint: `state-${index}` }
				: { evidenceFingerprint: `evidence-${index}` }),
		})

		for (let index = 0; index < 8; index++) detector.recordOutcome(observe(index))
		expect(detector.recordOutcome(observe(8)).stagnantCalls).toBe(1)
		expect(detector.recordOutcome(observe(0)).stagnantCalls).toBe(2)
		expect(detector.recordOutcome(observe(1)).action).toBe("change-strategy")
	})

	it("keeps forty distinct trusted shell inspections running like dedicated reads", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		for (let index = 0; index < 40; index++) {
			expect(
				detector.recordOutcome({
					toolName: "execute_command",
					args: { command: `rg --files --glob file-${index}.ts` },
					kind: "read",
					status: "success",
					scope: "/workspace",
					explorationFingerprint: `semantic-inspection-${index}`,
				}),
			).toMatchObject({ action: "continue", stagnantCalls: 0 })
		}
	})

	it("bounds alternating unchanged shell inspections by their host-issued semantic identity", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const actions = Array.from(
			{ length: 6 },
			(_, index) =>
				detector.recordOutcome({
					toolName: "execute_command",
					args: {
						command: index % 2 === 0 ? `rg${" ".repeat(index + 1)}--files src` : `rg.exe --files "tests"`,
					},
					kind: "read",
					status: "success",
					scope: "/workspace",
					explorationFingerprint: index % 2 === 0 ? "inspection-a" : "inspection-b",
				}).action,
		)

		expect(actions).toEqual(["continue", "continue", "continue", "change-strategy", "continue", "stop"])
	})

	it("does not let command spelling or timestamp output replace a trusted semantic identity", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const actions = Array.from(
			{ length: 4 },
			(_, index) =>
				detector.recordOutcome({
					toolName: "execute_command",
					args: { command: `rg --files src ${" ".repeat(index)}`, output: `finished at ${index}` },
					kind: "read",
					status: "success",
					scope: "/workspace",
					explorationFingerprint: "same-supported-inspection",
				}).action,
		)

		expect(actions).toEqual(["continue", "continue", "change-strategy", "continue"])
		expect(
			detector.recordOutcome({
				toolName: "execute_command",
				args: { command: "echo 2026-09-04T22:14:53Z" },
				kind: "other",
				status: "success",
				scope: "/workspace",
			}).action,
		).toBe("stop")
	})

	it("stops alternating rereads of the same unchanged scoped evidence", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const read = (path: string): ToolProgressObservation => ({
			toolName: "read_file",
			args: { path },
			scope: path,
			kind: "read",
			status: "success",
		})
		const actions = Array.from(
			{ length: 6 },
			(_, index) => detector.recordOutcome(read(index % 2 === 0 ? "/workspace/a.ts" : "/workspace/b.ts")).action,
		)
		expect(actions).toEqual(["continue", "continue", "continue", "change-strategy", "continue", "stop"])
	})

	it("does not confuse the same successful evidence across distinct scopes", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const check: ToolProgressObservation = {
			...failedCheck,
			status: "success",
			evidenceFingerprint: "required:passed",
		}
		expect(detector.recordOutcome(check).stagnantCalls).toBe(0)
		expect(detector.recordOutcome({ ...check, scope: "/workspace/other" }).stagnantCalls).toBe(0)
		expect(detector.recordOutcome(check).stagnantCalls).toBe(1)
	})

	it("exempts unchanged polling without clearing strikes or evicting prior evidence", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2, historyLimit: 8 })
		detector.recordOutcome(failedCheck)
		for (let index = 0; index < 100; index++) {
			expect(
				detector.recordOutcome({
					toolName: "wait_agent",
					args: { cursor: `poll-${index}` },
					kind: "poll",
					status: "success",
				}),
			).toMatchObject({ action: "continue", stagnantCalls: 1, retainedOutcomes: 1 })
		}
		expect(detector.recordOutcome(failedCheck).action).toBe("change-strategy")
	})

	it("does not exempt failed polling or unscoped read labels", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		expect(detector.recordOutcome({ ...failedCheck, kind: "poll" }).stagnantCalls).toBe(1)
		expect(detector.recordOutcome({ toolName: "read_file", kind: "read", status: "success" }).action).toBe(
			"change-strategy",
		)
	})

	it("preserves a stop until explicit user guidance resets the progress window", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 1 })
		detector.recordOutcome(failedCheck)
		expect(detector.recordOutcome(failedCheck).action).toBe("stop")
		expect(
			detector.recordOutcome({ ...failedCheck, status: "success", evidenceFingerprint: "late:passed" }).action,
		).toBe("stop")
		detector.resetProgress()
		expect(detector.recordOutcome(failedCheck)).toMatchObject({ action: "change-strategy", stagnantCalls: 1 })
	})

	it("bounds retained outcomes and exposes only redacted counts", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2, historyLimit: 8 })
		let result
		for (let index = 0; index < 8; index++) {
			result = detector.recordOutcome({
				toolName: "read_file",
				args: { path: `/secret/file-${index}.ts`, content: "private-content".repeat(1000) },
				scope: `/secret/file-${index}.ts`,
				kind: "read",
				status: "success",
			})
		}
		expect(result).toEqual({ action: "continue", stagnantCalls: 0, retainedOutcomes: 8 })
	})

	it("hard caps both the stagnation budget and retained outcomes for excessive configuration", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 10_000, historyLimit: 10_000 })
		for (let index = 0; index < 127; index++) {
			expect(detector.recordOutcome(failedCheck).action).not.toBe("stop")
		}
		expect(detector.recordOutcome(failedCheck)).toEqual({
			action: "stop",
			stagnantCalls: 128,
			retainedOutcomes: 128,
			reason: "no-progress",
		})
	})

	it.each([0, -1])("preserves unlimited mode for limit %s", (limit) => {
		const detector = new ToolRepetitionDetector(limit)
		for (let index = 0; index < 100; index++) {
			expect(detector.recordOutcome(failedCheck)).toEqual({
				action: "continue",
				stagnantCalls: 0,
				retainedOutcomes: 0,
			})
		}
	})
})
