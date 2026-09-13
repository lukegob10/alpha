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
	it("bounds repeated batches larger than resource history, including reordered batches", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2, historyLimit: 8 })
		const resources = Array.from({ length: 16 }, (_, index) => ({
			kind: "read" as const,
			scope: `file-${index}`,
			stateFingerprint: "same content",
		}))
		const read = (reverse: boolean) =>
			detector.recordOutcome({
				toolName: "read_file",
				kind: "read",
				status: "success",
				trustedProgress: reverse ? [...resources].reverse() : resources,
			})
		expect(read(false).stagnantCalls).toBe(0)
		expect(read(true).stagnantCalls).toBe(1)
		expect(read(false).action).toBe("change-strategy")
		expect(read(true).stagnantCalls).toBe(3)
		expect(read(false).action).toBe("stop")
	})

	it("allows novel opaque outcomes without declaring progress or clearing prior strikes", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		detector.recordOutcome({ toolName: "no-op", kind: "other", status: "success" })
		for (let index = 0; index < 200; index++) {
			expect(
				detector.recordOutcome({
					toolName: "use_mcp_tool",
					kind: "other",
					status: "success",
					opaqueResultFingerprint: `result-${index}`,
				}),
			).toMatchObject({ action: "continue", stagnantCalls: 1 })
		}
		expect(
			detector.recordOutcome({
				toolName: "use_mcp_tool",
				kind: "other",
				status: "success",
				opaqueResultFingerprint: "result-199",
			}),
		).toMatchObject({ action: "change-strategy", reason: "unconfirmed-progress", stagnantCalls: 2 })
	})

	it("bounds alternating identical opaque outcomes and does not admit opaque errors", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const outcomes = Array.from({ length: 6 }, (_, index) =>
			detector.recordOutcome({
				toolName: "use_mcp_tool",
				kind: "other",
				status: "success",
				opaqueResultFingerprint: String(index % 2),
			}),
		)
		expect(outcomes.at(-1)).toMatchObject({ action: "stop", reason: "unconfirmed-progress" })
		const failures = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		for (let index = 0; index < 4; index++)
			expect(
				failures.recordOutcome({
					toolName: "use_mcp_tool",
					kind: "other",
					status: "error",
					opaqueResultFingerprint: String(index),
				}).stagnantCalls,
			).toBe(index + 1)
	})

	it("remembers every read in a batch independently of ordering and regrouping", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const read = (files: string[]): ToolProgressObservation => ({
			toolName: "read_file",
			args: { files },
			kind: "read",
			status: "success",
			scope: "/workspace",
			trustedProgress: files.map((scope) => ({ kind: "read", scope, stateFingerprint: "contents" })),
		})
		expect(detector.recordOutcome(read(["a", "b"])).stagnantCalls).toBe(0)
		expect(detector.recordOutcome(read(["b"])).stagnantCalls).toBe(1)
		expect(detector.recordOutcome(read(["b", "a"])).action).toBe("change-strategy")
		expect(detector.recordOutcome(read(["b", "c"])).stagnantCalls).toBe(0)
	})

	it("uses returned read state instead of cosmetic argument changes", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const read = (limit: number, stateFingerprint = "same lines"): ToolProgressObservation => ({
			toolName: "read_file",
			args: { path: "file.ts", limit },
			kind: "read",
			status: "success",
			scope: "/workspace",
			trustedProgress: { kind: "read", scope: "/workspace/file.ts", stateFingerprint },
		})
		expect(detector.recordOutcome(read(100)).stagnantCalls).toBe(0)
		expect(detector.recordOutcome(read(200)).stagnantCalls).toBe(1)
		expect(detector.recordOutcome(read(300)).action).toBe("change-strategy")
		expect(detector.recordOutcome(read(300, "changed lines")).stagnantCalls).toBe(0)
	})

	it.each(["error", "denied", "cancelled", "running"] as const)(
		"does not credit resource progress for %s results",
		(status) => {
			const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
			for (let index = 0; index < 4; index++) {
				const result = detector.recordOutcome({
					toolName: "update_ticket",
					kind: "other",
					status: status === "running" ? "success" : status,
					...(status === "running" ? { executionStatus: "running" as const } : {}),
					trustedProgress: {
						kind: "mutation",
						scope: "ticket",
						previousStateFingerprint: "before",
						stateFingerprint: `after-${index}`,
					},
				})
				expect(result.stagnantCalls).toBe(index + 1)
			}
		},
	)

	it("requires confirmed deltas and retains alternating resource states after rollover", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2, historyLimit: 8 })
		const mutation = (before: string | undefined, after: string): ToolProgressObservation => ({
			toolName: "update_ticket",
			kind: "other",
			status: "success",
			trustedProgress: {
				kind: "mutation",
				scope: "ticket",
				previousStateFingerprint: before,
				stateFingerprint: after,
			},
		})
		expect(detector.recordOutcome(mutation(undefined, "0")).stagnantCalls).toBe(1)
		for (let index = 1; index < 40; index++) {
			expect(detector.recordOutcome(mutation(String(index - 1), String(index)))).toMatchObject({
				action: "continue",
				stagnantCalls: 0,
			})
		}
		expect(
			[38, 39, 38, 39].map(
				(state, index) => detector.recordOutcome(mutation(index % 2 ? "38" : "39", String(state))).action,
			),
		).toEqual(["continue", "change-strategy", "continue", "stop"])
		detector.resetProgress()
		expect(detector.recordOutcome(mutation("before", "after")).stagnantCalls).toBe(0)
	})

	it("keeps frequently revisited reads in memory while new work rotates through the window", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2, historyLimit: 8 })
		const read = (path: string): ToolProgressObservation => ({
			toolName: "read_file",
			args: { path },
			kind: "read",
			status: "success",
			scope: "/workspace",
		})
		detector.recordOutcome(read("same-file"))
		for (let index = 0; index < 40; index++) {
			expect(detector.recordOutcome(read(`new-file-${index}`)).stagnantCalls).toBe(0)
			expect(detector.recordOutcome(read("same-file")).stagnantCalls).toBe(1)
		}
	})

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
		for (let index = 0; index < 200; index++) {
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

	it("continues beyond history rollover while retaining recent alternating reads", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 3, historyLimit: 8 })
		const read = (index: number): ToolProgressObservation => ({
			toolName: "read_file",
			args: { path: `/workspace/file-${index}.ts` },
			scope: "/workspace",
			kind: "read",
			status: "success",
		})

		for (let index = 0; index < 40; index++) {
			expect(detector.recordOutcome(read(index))).toMatchObject({ action: "continue", stagnantCalls: 0 })
		}
		expect([38, 39, 38, 39, 38, 39].map((index) => detector.recordOutcome(read(index)).action)).toEqual([
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

	it.each(["state", "evidence"] as const)("retains recent %s while admitting new work after rollover", (novelty) => {
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

		detector.recordOutcome(observe(0))
		for (let index = 1; index < 40; index++) {
			expect(detector.recordOutcome(observe(index))).toMatchObject({
				action: "continue",
				stagnantCalls: 0,
				retainedOutcomes: Math.min(8, index + 1),
			})
		}
		const actions = [38, 39, 38, 39, 38, 39].map((index) => detector.recordOutcome(observe(index)).action)
		expect(actions).toEqual(["continue", "continue", "change-strategy", "continue", "continue", "stop"])
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
