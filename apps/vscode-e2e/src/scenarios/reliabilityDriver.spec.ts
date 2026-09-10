import { strict as assert } from "node:assert"
import { test } from "node:test"
import { WorkflowFailure } from "./contracts"
import type { ExtensionWorkflowHost } from "./extensionWorkflowHost"
import { runReliabilityScenario } from "./reliabilityDriver"
import { WorkflowRequestBudget } from "./requestBudget"
import type { WorkflowDependencies } from "./workflowDriver"
import { LONG_CONTEXT_SCENARIO_IDS } from "./longContextProbe"

const options = {
	runId: "reliability-unit",
	scenarioId: "completion-admission" as const,
	phase: "run" as const,
	workspace: "fixture",
	hostVersion: "1.122.1",
	providerMode: "live-copilot",
	model: { id: "model" },
	turns: 6,
}

for (const scenarioId of LONG_CONTEXT_SCENARIO_IDS)
	test(`${scenarioId} keeps one retained task across recovery and a graded code fix`, async () => {
		const exhaustEmpty = scenarioId === "long-context-empty-exhaustion"
		const budget = new WorkflowRequestBudget(100)
		const actions: string[] = []
		const receipts = new Map<string, unknown>()
		let starts = 0
		const host = {
			start: async () => {
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
			"contextProbe:1",
			"contextProbe:2",
			"contextProbe:3",
			"contextProbe:4",
			...(exhaustEmpty ? ["exhausted", "contextProbe:4"] : ["retry"]),
			"condense",
			"reopen",
			"contextProbe:5",
			"grade:baseline",
			"enhance:fix",
			"grade:enhanced",
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
