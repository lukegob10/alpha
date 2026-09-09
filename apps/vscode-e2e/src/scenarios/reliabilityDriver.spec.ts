import { strict as assert } from "node:assert"
import { test } from "node:test"
import { WorkflowFailure } from "./contracts"
import type { ExtensionWorkflowHost } from "./extensionWorkflowHost"
import { runReliabilityScenario } from "./reliabilityDriver"
import { WorkflowRequestBudget } from "./requestBudget"
import type { WorkflowDependencies } from "./workflowDriver"

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
