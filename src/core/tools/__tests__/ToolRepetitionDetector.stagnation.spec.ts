import type { ToolUse } from "../../../shared/tools"
import { ToolRepetitionDetector, type ToolProgressObservation } from "../ToolRepetitionDetector"

vi.mock("../../../i18n", () => ({ t: vi.fn((key: string) => key) }))

type FixtureOutcome = "completed" | "incomplete" | "exhausted"

interface FixtureResult {
	toolCalls: number
	modelRounds: number
	outcome: FixtureOutcome
	strategyChanges: number
}

interface FixtureWorkload {
	name: string
	next: (modelRound: number, toolCalls: number) => ToolProgressObservation | "complete"
	before: FixtureResult
	after: FixtureResult
}

const failedCheck: ToolProgressObservation = {
	toolName: "execute_command",
	args: { command: "pnpm test" },
	scope: "/workspace",
	stateFingerprint: "content-v1",
	kind: "check",
	status: "error",
}

/**
 * Offline scripted provider fixture: one ordered call or visible final answer per
 * model round, actual effects counted separately from legacy suppressed calls.
 * The baseline path is the unchanged check() used by Task at 1a8e38dfb971.
 * Both paths use the same script, a 24-round budget, and legacy limit 3; the new
 * policy defaults to strategy change after 6 stagnant effects and stop after 12.
 * Counts measure these workloads, not latency or general live-model behavior.
 */
async function runFixture(workload: FixtureWorkload, policy: "before" | "after"): Promise<FixtureResult> {
	const detector = new ToolRepetitionDetector(3)
	const result: FixtureResult = { modelRounds: 0, toolCalls: 0, outcome: "exhausted", strategyChanges: 0 }
	while (result.modelRounds < 24) {
		result.modelRounds += 1
		const observation = workload.next(result.modelRounds, result.toolCalls)
		if (observation === "complete") return { ...result, outcome: "completed" }
		if (
			policy === "before" &&
			!detector.check({
				type: "tool_use",
				name: observation.toolName as ToolUse["name"],
				params: {},
				nativeArgs: observation.args as ToolUse["nativeArgs"],
				partial: false,
			}).allowExecution
		) {
			continue
		}

		// Scheduler observations arrive after the effect has actually completed.
		const completed = await Promise.resolve(observation)
		result.toolCalls += 1
		if (policy === "after") {
			const decision = detector.recordOutcome(completed)
			if (decision.action === "change-strategy") result.strategyChanges += 1
			if (decision.action === "stop") return { ...result, outcome: "incomplete" }
		}
	}
	return result
}

const workloads: FixtureWorkload[] = [
	{
		name: "repeated unsuccessful check",
		next: () => failedCheck,
		before: { toolCalls: 18, modelRounds: 24, outcome: "exhausted", strategyChanges: 0 },
		after: { toolCalls: 12, modelRounds: 12, outcome: "incomplete", strategyChanges: 1 },
	},
	{
		name: "alternating unsuccessful checks with equivalent outcomes",
		next: (round) => ({
			...failedCheck,
			args: { command: round % 2 === 0 ? "pnpm test" : "pnpm test --run" },
			evidenceFingerprint: `unrelated failure timestamp ${round}`,
		}),
		before: { toolCalls: 24, modelRounds: 24, outcome: "exhausted", strategyChanges: 0 },
		after: { toolCalls: 12, modelRounds: 12, outcome: "incomplete", strategyChanges: 1 },
	},
	{
		name: "alternating successful calls without new evidence",
		next: (round) => ({
			toolName: "execute_command",
			args: { command: round % 2 === 0 ? "echo still working" : "echo continuing" },
			kind: "other",
			status: "success",
		}),
		before: { toolCalls: 24, modelRounds: 24, outcome: "exhausted", strategyChanges: 0 },
		after: { toolCalls: 12, modelRounds: 12, outcome: "incomplete", strategyChanges: 1 },
	},
	{
		name: "productive exploration across twelve files",
		next: (_round, toolCalls) =>
			toolCalls >= 12
				? "complete"
				: {
						toolName: "read_file",
						args: { path: `/workspace/file-${toolCalls}.ts` },
						scope: `/workspace/file-${toolCalls}.ts`,
						kind: "read",
						status: "success",
					},
		before: { toolCalls: 12, modelRounds: 13, outcome: "completed", strategyChanges: 0 },
		after: { toolCalls: 12, modelRounds: 13, outcome: "completed", strategyChanges: 0 },
	},
	{
		name: "legitimate polling completes after twelve external observations",
		next: (_round, toolCalls) =>
			toolCalls >= 12
				? "complete"
				: { toolName: "wait_agent", args: { agent_id: "worker" }, kind: "poll", status: "success" },
		before: { toolCalls: 12, modelRounds: 16, outcome: "completed", strategyChanges: 0 },
		after: { toolCalls: 12, modelRounds: 13, outcome: "completed", strategyChanges: 0 },
	},
	{
		name: "successful repair with an observed mutation and current passing evidence",
		next: (_round, toolCalls) => {
			if (toolCalls < 5) return failedCheck
			if (toolCalls === 5) {
				return {
					toolName: "apply_patch",
					args: { patch: "fixture repair" },
					scope: "/workspace",
					kind: "mutation",
					status: "success",
					stateFingerprint: "content-v2",
				}
			}
			if (toolCalls === 6) {
				return {
					...failedCheck,
					status: "success",
					stateFingerprint: "content-v2",
					evidenceFingerprint: "content-v2:required-test:passed",
				}
			}
			return "complete"
		},
		before: { toolCalls: 7, modelRounds: 9, outcome: "completed", strategyChanges: 0 },
		after: { toolCalls: 7, modelRounds: 8, outcome: "completed", strategyChanges: 0 },
	},
]

describe("deterministic stagnation fixtures", () => {
	it.each(workloads)("$name", async (workload) => {
		const before = await runFixture(workload, "before")
		const after = await runFixture(workload, "after")
		expect(before).toEqual(workload.before)
		expect(after).toEqual(workload.after)
		expect(after.outcome === "completed").toBe(before.outcome === "completed")
	})
})
