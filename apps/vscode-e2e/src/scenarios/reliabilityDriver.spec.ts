import { strict as assert } from "node:assert"
import { test } from "node:test"
import { WorkflowFailure } from "./contracts"
import type { ExtensionWorkflowHost } from "./extensionWorkflowHost"
import { runReliabilityScenario } from "./reliabilityDriver"
import { WorkflowRequestBudget } from "./requestBudget"
import type { WorkflowDependencies } from "./workflowDriver"
import {
	CONTEXT_PROBE_CHALLENGE_RESULT,
	CONTEXT_PROBE_CHALLENGE_STEP,
	LONG_CONTEXT_SCENARIO_IDS,
} from "./longContextProbe"

const options = {
	runId: "reliability-unit",
	scenarioId: "completion-admission" as const,
	phase: "run" as const,
	workspace: "fixture",
	hostVersion: "1.138.0",
	providerMode: "live-copilot",
	model: { id: "model" },
	turns: 6,
}

for (const providerCode of [undefined, "request_timeout"] as const)
	test(`reliability failures retain the primary shape with attribution ${providerCode ?? "absent"}`, async () => {
		const repository = {
			create: async () => {
				throw new WorkflowFailure("lifecycle", "unexpected_resume_task", false, providerCode)
			},
		} as unknown as WorkflowDependencies["repository"]
		const result = await runReliabilityScenario(
			options,
			{} as ExtensionWorkflowHost,
			new WorkflowRequestBudget(40),
			repository,
			async () => {},
		)
		assert.deepEqual(result.failure, {
			category: "lifecycle",
			code: "unexpected_resume_task",
			...(providerCode ? { providerCode } : {}),
		})
	})

for (const scenarioId of LONG_CONTEXT_SCENARIO_IDS)
	test(`${scenarioId} keeps one retained task across recovery and a graded requirement follow-up`, async () => {
		const exhaustEmpty = scenarioId === "long-context-empty-exhaustion"
		const budget = new WorkflowRequestBudget(100)
		const actions: string[] = []
		const receipts = new Map<string, unknown>()
		let starts = 0
		const host = {
			start: async (phase: string) => {
				assert.equal(phase, "enhance")
				starts++
				budget.consume()
				return "retained"
			},
			followup: async (id: string, phase: string, step?: number) => {
				assert.equal(id, "retained")
				actions.push(`${phase}:${step ?? "fix"}`)
				budget.consume()
				if (budget.transformResponse) {
					const transformed = budget.transformResponse({
						stream: (async function* () {
							yield "real-boundary-fixture"
						})(),
					}) as { stream: AsyncIterable<unknown> }
					for await (const _part of transformed.stream) {
						/* consume the injected response */
					}
				}
			},
			complete: async () => {},
			inspect: async () => ({ errors: [], callCount: 1, resultCount: 1, completedTurns: 1 }),
			admissionsAreUnique: () => true,
			inspectContext: () => ({
				apiMessages: budget.used * 2,
				apiHistoryBytes: budget.used * 17_000,
				summaries: 0,
				emptyWarnings: exhaustEmpty ? 1 : 0,
				receiptPresent: true,
			}),
			inspectCompactionEvidence: () => ({ summaryRetainedFact: true }),
			waitForFault: async (condition: () => boolean) => {
				if (!condition() && exhaustEmpty) {
					budget.consume()
					const response = budget.transformResponse!({
						stream: (async function* () {
							yield "retry-output"
						})(),
					}) as { stream: AsyncIterable<unknown> }
					for await (const _part of response.stream) {
						/* consume the second empty fault */
					}
				}
				assert.ok(condition())
			},
			waitForResumeBoundary: async () => {
				actions.push("exhausted")
			},
			recoverProviderError: async (_id: string, before: number) => {
				assert.equal(budget.used, before + 1)
				actions.push("retry")
				budget.consume()
			},
			condense: async () => {
				actions.push("condense")
				budget.consume()
				return true
			},
			resume: async (id: string, phase: string, step: number, resumeOptions: { reopen: boolean }) => {
				assert.equal(id, "retained")
				assert.equal(resumeOptions.reopen, true)
				actions.push("reopen")
				actions.push(`${phase}:${step}`)
				budget.consume()
			},
		} as unknown as ExtensionWorkflowHost
		const repository = {
			create: async () => ({ initialCommit: "abc" }),
			verify: async (phase: string) => {
				actions.push(`grade:${phase}`)
				return [{ name: "fixture", passed: true }]
			},
			test: async () => ({ exitCode: 0 }),
			readCommit: async () => "committed-setup",
		} as unknown as WorkflowDependencies["repository"]
		const result = await runReliabilityScenario(
			{ ...options, scenarioId, turns: 4 },
			host,
			budget,
			repository,
			async (name, value) => {
				receipts.set(name, value)
			},
		)
		assert.equal(result.status, "passed")
		assert.equal(starts, 1)
		assert.ok(actions.indexOf("reopen") > actions.indexOf("condense"))
		assert.deepEqual(actions, [
			"grade:baseline",
			"grade:enhanced",
			"commit:fix",
			"grade:committed",
			"contextProbe:0",
			"contextProbe:1",
			"contextProbe:2",
			"contextProbe:3",
			"contextProbe:4",
			...(exhaustEmpty ? ["exhausted", "contextProbe:4"] : ["retry"]),
			"condense",
			"reopen",
			`contextProbe:${CONTEXT_PROBE_CHALLENGE_STEP}`,
			"grade:committed",
			"followup:fix",
			"grade:followup",
		])
		assert.equal(budget.transformResponse, undefined)
		assert.ok(receipts.has("reliability-observations.json"))
	})

test("live acceptance rejects a scripted provider before touching a fixture or task", async () => {
	const forbidden = new Proxy(
		{},
		{
			get() {
				assert.fail("must not touch fixture or host")
			},
		},
	)
	const receipts: string[] = []
	const result = await runReliabilityScenario(
		{ ...options, providerMode: "scripted" },
		forbidden as ExtensionWorkflowHost,
		new WorkflowRequestBudget(10),
		forbidden as WorkflowDependencies["repository"],
		async (name) => {
			receipts.push(name)
		},
	)
	assert.equal(result.status, "blocked")
	assert.equal(result.failure?.code, "reliability_requires_live_copilot")
	assert.equal(result.requestsUsed, 0)
	assert.deepEqual(receipts, ["reliability-observations.json"])
})

test("a live admission failure retains its task snapshot and is never projected as a pass", async () => {
	const state = { currentTaskId: "task", liveTasksById: {} }
	const host = {
		start: async () => "task",
		complete: async () => {
			throw new WorkflowFailure("lifecycle", "message_admission_timeout")
		},
		captureTaskState: async () => state,
	} as unknown as ExtensionWorkflowHost
	const repository = {
		create: async () => ({ initialCommit: "abc" }),
		verify: async () => [{ name: "fixture", passed: true }],
	} as unknown as WorkflowDependencies["repository"]
	const receipts = new Map<string, unknown>()
	const result = await runReliabilityScenario(
		options,
		host,
		new WorkflowRequestBudget(10),
		repository,
		async (name, value) => {
			receipts.set(name, value)
		},
	)
	assert.equal(result.status, "failed")
	assert.equal(result.failure?.code, "message_admission_timeout")
	assert.deepEqual(result.taskIds, ["task"])
	assert.equal(receipts.get("reliability-failure-state.json"), state)
	assert.ok(receipts.has("reliability-observations.json"))
})

for (const mutation of ["none", "forgotten-fact", "stale-constraint", "recent-receipt", "repeated-commit"] as const)
	test(`context compaction independently grades retired facts and completed effects (${mutation})`, async () => {
		const budget = new WorkflowRequestBudget(30)
		const actions: string[] = []
		let commitReads = 0
		const host = {
			start: async (phase: string) => {
				assert.equal(phase, "enhance")
				budget.consume()
				return "retained"
			},
			complete: async () => {},
			followup: async (id: string, phase: string, step?: number) => {
				assert.equal(id, "retained")
				assert.ok(phase === "contextProbe" || phase === "commit")
				actions.push(`${phase}:${step ?? "setup"}`)
				budget.consume()
			},
			resume: async (id: string, phase: string, step: number, options: { reopen: boolean }) => {
				assert.equal(id, "retained")
				assert.equal(phase, "contextProbe")
				assert.equal(step, CONTEXT_PROBE_CHALLENGE_STEP)
				assert.equal(options.reopen, true)
				actions.push("reopen")
				budget.consume()
			},
			condense: async () => {
				actions.push("condense")
				budget.consume()
				return true
			},
			inspectCompactionEvidence: (_id: string, fact: string) => ({
				summaryId: "summary-1",
				receiptId: "summary-1",
				summaryRetainedFact: mutation !== "forgotten-fact" || fact !== "north-2",
				previousTokens: 900,
				currentTokens: 450,
			}),
			inspectContext: (_id: string, receipt: string) => {
				actions.push(`receipt:${receipt}`)
				const finalReport =
					mutation === "stale-constraint"
						? CONTEXT_PROBE_CHALLENGE_RESULT.replace("window=17", "window=9")
						: mutation === "recent-receipt"
							? "receipt-5"
							: CONTEXT_PROBE_CHALLENGE_RESULT
				return { receiptPresent: receipt !== CONTEXT_PROBE_CHALLENGE_RESULT || receipt === finalReport }
			},
			inspect: async () => ({ errors: [], callCount: 1, resultCount: 1, completedTurns: 1 }),
			admissionsAreUnique: () => true,
		} as unknown as ExtensionWorkflowHost
		const repository = {
			create: async () => ({ initialCommit: "abc" }),
			verify: async (phase: string) => {
				actions.push(`grade:${phase}`)
				return [{ name: "fixture", passed: true }]
			},
			readCommit: async () => {
				commitReads++
				return mutation === "repeated-commit" && commitReads >= 3 ? "repeated-commit" : "committed-setup"
			},
		} as unknown as WorkflowDependencies["repository"]
		const result = await runReliabilityScenario(
			{ ...options, scenarioId: "context-compaction" },
			host,
			budget,
			repository,
			async () => {},
		)
		if (mutation !== "none") {
			assert.equal(result.status, "failed")
			assert.equal(result.failure?.category, "assertion")
			assert.equal(
				result.failure?.code,
				mutation === "forgotten-fact"
					? "summary_retained_fact_1"
					: mutation === "repeated-commit"
						? "committed_effect_not_repeated"
						: "retired_context_challenge_passed",
			)
			return
		}
		assert.equal(result.status, "passed")
		assert.ok(actions.indexOf("reopen") > actions.indexOf("condense"))
		assert.equal(actions.filter((action) => action === "reopen").length, 1)
		assert.deepEqual(
			actions.filter((action) => action.startsWith("contextProbe:")),
			[
				"contextProbe:0",
				"contextProbe:1",
				"contextProbe:2",
				"contextProbe:3",
				"contextProbe:4",
				"contextProbe:5",
			],
		)
		assert.equal(actions.filter((action) => action.startsWith("receipt:")).length, 7)
		assert.equal(actions.filter((action) => action === "grade:baseline").length, 1)
		assert.equal(actions.filter((action) => action === "grade:committed").length, 3)
		assert.ok(result.checks.some((check) => check.name === "compaction_receipt_reduced_context" && check.passed))
		assert.ok(result.checks.some((check) => check.name === "retired_context_challenge_passed" && check.passed))
	})
