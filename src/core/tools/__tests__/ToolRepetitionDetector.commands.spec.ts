import { ToolRepetitionDetector, type ToolProgressObservation } from "../ToolRepetitionDetector"
import { createToolFailure } from "../ToolFailure"

vi.mock("../../../i18n", () => ({ t: vi.fn((key: string) => key) }))

function command(command: string): ToolProgressObservation {
	return {
		toolName: "execute_command",
		args: { command },
		kind: "check",
		status: "success",
		executionStatus: "success",
		scope: "/workspace",
		stateFingerprint: "unchanged-workspace",
	}
}

describe("commands without semantic progress instrumentation", () => {
	it("shares artifact-read retry blocks across the historical name without blocking command controls", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const failure = createToolFailure({
			reason: "execution_failed",
			scopeKind: "operation",
			scopeIdentity: ["artifact", "cmd-123.txt"],
			effectsStarted: "no",
			outcome: "known",
			recovery: { kind: "repair" },
		})
		for (let index = 0; index < 4; index++) {
			detector.recordOutcome({
				toolName: "manage_command",
				args: { action: "read", artifact_id: "cmd-123.txt", offset: 0 },
				kind: "read",
				status: "error",
				failure,
			})
		}
		expect(detector.getRetryBlock("read_command_output", { artifact_id: "cmd-123.txt", offset: 0 })).toEqual(
			failure,
		)
		expect(detector.getRetryBlock("manage_command", { action: "wait", execution_id: "123" })).toBeUndefined()
	})

	it("does not renew command progress by alternating the canonical and historical tool names", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const actions = ["shell", "execute_command", "shell", "execute_command", "shell"].map(
			(toolName, index) =>
				detector.recordOutcome({
					...command("pnpm check-types"),
					toolName,
					args: { command: "pnpm check-types", timeout: index },
				}).action,
		)
		expect(actions).toEqual(["continue", "continue", "change-strategy", "continue", "stop"])
	})

	it("does not infer stagnation from distinct successful commands, including after history rollover", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2, historyLimit: 8 })
		detector.recordOutcome({ toolName: "no-op", kind: "other", status: "success" })
		for (let index = 0; index < 200; index++) {
			expect(
				detector.recordOutcome(command(`Get-Content file-${index}.ts | Select-Object -First 20`)),
			).toMatchObject({
				action: "continue",
				stagnantCalls: 1,
			})
		}
	})

	it("still bounds repeated successful commands despite changed timeouts or verification associations", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const actions = Array.from(
			{ length: 6 },
			(_, index) =>
				detector.recordOutcome({
					...command("pnpm check-types"),
					args: {
						command: ` ${index % 2 ? "pnpm check-types" : "pnpm lint"} `,
						timeout: index,
						verification: { change_set_ids: [`changed-association-${index}`] },
					},
				}).action,
		)
		expect(actions).toEqual(["continue", "continue", "continue", "change-strategy", "continue", "stop"])
	})

	it("does not replace a trusted inspection identity with the raw command", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		const actions = Array.from(
			{ length: 5 },
			(_, index) =>
				detector.recordOutcome({
					...command(`git${" ".repeat(index + 1)}status`),
					kind: "read",
					explorationFingerprint: "same-inspection",
				}).action,
		)
		expect(actions).toEqual(["continue", "continue", "change-strategy", "continue", "stop"])
	})

	it.each(["error", "denied", "cancelled", "running", "unconfirmed"] as const)(
		"does not exempt commands with %s execution",
		(status) => {
			const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
			for (let index = 0; index < 4; index++) {
				expect(
					detector.recordOutcome({
						...command(`node inspect-${index}.js`),
						status: status === "running" || status === "unconfirmed" ? "success" : status,
						executionStatus: status === "unconfirmed" ? undefined : status,
					}).stagnantCalls,
				).toBe(index + 1)
			}
		},
	)

	it("retains command repetition across unrelated work and renews it only for explicit user recovery", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		detector.recordOutcome(command("pnpm check-types"))
		for (let index = 0; index < 40; index++) {
			detector.recordOutcome({
				toolName: "read_file",
				kind: "read",
				status: "success",
				scope: `/workspace/new-${index}.ts`,
			})
			expect(detector.recordOutcome(command("pnpm check-types")).stagnantCalls).toBe(1)
		}
		detector.resetProgress()
		expect(detector.recordOutcome(command("pnpm check-types")).stagnantCalls).toBe(0)
	})
})
