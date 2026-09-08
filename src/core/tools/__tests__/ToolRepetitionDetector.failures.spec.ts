import { ToolRepetitionDetector } from "../ToolRepetitionDetector"

vi.mock("../../../i18n", () => ({ t: vi.fn((key: string) => key) }))

const failure = {
	reason: "pre_launch_rejected" as const,
	affectedScope: { kind: "capability" as const, fingerprint: "a".repeat(64) },
	effectsStarted: "no" as const,
	outcome: "known" as const,
	recovery: { kind: "repair" as const },
}
const rejected = {
	toolName: "execute_command",
	args: { command: "configure-project" },
	status: "error" as const,
	kind: "other" as const,
	failure,
}

describe("trusted tool failure recovery", () => {
	it("does not replenish the same blocker through unrelated successful reads or writes", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		for (let index = 0; index < 4; index++) {
			detector.recordOutcome(rejected)
			detector.recordOutcome({
				toolName: "read_file",
				args: { path: `unrelated-${index}.ts` },
				status: "success",
				kind: "read",
				scope: "/workspace",
				stateFingerprint: `unrelated-state-${index}`,
			})
		}
		expect(detector.getRetryBlock(rejected.toolName, rejected.args)).toEqual(failure)
	})

	it("keeps an optional failed operation from stopping independent supported work", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 1 })
		detector.recordOutcome(rejected)
		detector.recordOutcome(rejected)
		expect(detector.getRetryBlock("github_api", { operation: "get_repository" })).toBeUndefined()
		expect(
			detector.recordOutcome({ toolName: "github_api", status: "success", kind: "read", scope: "/repository" })
				.action,
		).toBe("continue")
		expect(detector.getRetryBlock(rejected.toolName, rejected.args)).toEqual(failure)
	})

	it("renews allowance after the formerly failing operation actually succeeds following repair", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
		detector.recordOutcome(rejected)
		detector.recordOutcome(rejected)
		detector.recordOutcome({ ...rejected, failure: undefined, status: "success" })
		expect(detector.recordOutcome(rejected).action).toBe("continue")
		expect(detector.getRetryBlock(rejected.toolName, rejected.args)).toBeUndefined()
	})

	it("blocks an unknown mutation outcome immediately but leaves inspection available", () => {
		const detector = new ToolRepetitionDetector(3)
		const unknown = {
			...failure,
			reason: "outcome_unknown" as const,
			effectsStarted: "unknown" as const,
			outcome: "unknown" as const,
			recovery: { kind: "verify-outcome" as const },
		}
		detector.recordOutcome({ ...rejected, failure: unknown })
		expect(
			detector.getRetryBlock("execute_command", {
				command: " configure-project ",
				timeout: 12,
				verification: null,
			}),
		).toEqual(unknown)
		expect(detector.getRetryBlock("read_file", { path: "configuration.json" })).toBeUndefined()
		expect(detector.getRetryBlock("execute_command", { command: "inspect-project" })).toBeUndefined()
	})

	it("keeps quoted command contents distinct and resets only for explicit guidance", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 1 })
		const spaced = { ...rejected, args: { command: 'write-setting "a  b"' } }
		detector.recordOutcome(spaced)
		detector.recordOutcome(spaced)
		expect(detector.getRetryBlock("execute_command", { command: 'write-setting "a b"' })).toBeUndefined()
		expect(detector.getRetryBlock("execute_command", spaced.args)).toEqual(failure)
		detector.resetProgress()
		expect(detector.getRetryBlock("execute_command", spaced.args)).toBeUndefined()
	})

	it("retains a later unknown outcome even if subsequent known failures suggest recovery", () => {
		const detector = new ToolRepetitionDetector(3)
		detector.recordOutcome(rejected)
		const unknown = {
			...failure,
			effectsStarted: "unknown" as const,
			outcome: "unknown" as const,
			recovery: { kind: "verify-outcome" as const },
		}
		detector.recordOutcome({ ...rejected, failure: unknown })
		expect(detector.getRetryBlock(rejected.toolName, rejected.args)).toEqual(unknown)
		detector.recordOutcome(rejected)
		expect(detector.getRetryBlock(rejected.toolName, rejected.args)).toEqual(unknown)
	})

	it("does not count a still-running handler as successful recovery", () => {
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 1 })
		detector.recordOutcome(rejected)
		detector.recordOutcome({ ...rejected, failure: undefined, status: "success", executionStatus: "running" })
		detector.recordOutcome(rejected)
		expect(detector.getRetryBlock(rejected.toolName, rejected.args)).toEqual(failure)
	})

	it.each(["scopes", "operations"] as const)(
		"fails closed instead of dropping an unknown outcome when bounded %s fill",
		(dimension) => {
			const detector = new ToolRepetitionDetector(3, { historyLimit: 8, noProgressLimit: 2 })
			for (let index = 0; index < 8; index++) {
				detector.recordOutcome({
					...rejected,
					args: { command: `operation-${index}` },
					failure: {
						...failure,
						affectedScope: {
							...failure.affectedScope,
							fingerprint:
								dimension === "scopes"
									? index.toString(16).padStart(64, "0")
									: failure.affectedScope.fingerprint,
						},
					},
				})
			}
			const unknown = {
				...failure,
				outcome: "unknown" as const,
				effectsStarted: "unknown" as const,
				recovery: { kind: "verify-outcome" as const },
			}
			const outcome = detector.recordOutcome({
				...rejected,
				args: { command: "overflowing-operation" },
				failure: unknown,
			})
			expect(outcome).toMatchObject({ action: "stop", reason: "failure-capacity", failure: unknown })
			expect(detector.getRetryBlock("execute_command", { command: "overflowing-operation" })).toEqual(unknown)
		},
	)

	it("preserves unknown-outcome safety when ordinary repetition limits are disabled", () => {
		const detector = new ToolRepetitionDetector(0)
		const unknown = { ...failure, outcome: "unknown" as const, recovery: { kind: "verify-outcome" as const } }
		detector.recordOutcome({ ...rejected, failure: unknown })
		expect(detector.getRetryBlock(rejected.toolName, rejected.args)).toEqual(unknown)
	})
})
