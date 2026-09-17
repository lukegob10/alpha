import { strict as assert } from "node:assert"
import { test } from "node:test"

import { MAX_WORKFLOW_TURNS, readWorkflowSelection, WorkflowFailure } from "./contracts"

test("workflow selection rejects unknown IDs, ambiguous phases, and unbounded budgets", () => {
	for (const env of [
		{},
		{ ALPHA_E2E_SCENARIO_ID: "anything" },
		{ ALPHA_E2E_SCENARIO_ID: "cancel-resume", ALPHA_E2E_SCENARIO_PHASE: "continue" },
		{ ALPHA_E2E_SCENARIO_ID: "reload-continuation", ALPHA_E2E_SCENARIO_PHASE: "run" },
		{ ALPHA_E2E_SCENARIO_ID: "long-thread", ALPHA_E2E_SCENARIO_TURNS: "100000" },
		{ ALPHA_E2E_SCENARIO_ID: "long-thread", ALPHA_E2E_REQUEST_LIMIT: "0" },
		{ ALPHA_E2E_SCENARIO_ID: "long-thread", ALPHA_E2E_REQUEST_LIMIT: "1e2" },
	]) {
		assert.throws(() => readWorkflowSelection(env), WorkflowFailure)
	}
})

test("reload defaults to prepare and budgets are explicit and bounded", () => {
	assert.deepEqual(readWorkflowSelection({ ALPHA_E2E_SCENARIO_ID: "reload-continuation" }), {
		scenarioId: "reload-continuation",
		phase: "prepare",
		turns: 6,
		requestCap: 60,
		timeoutMs: 300_000,
	})
	assert.equal(
		readWorkflowSelection({ ALPHA_E2E_SCENARIO_ID: "long-thread", ALPHA_E2E_SCENARIO_TURNS: "12" }).turns,
		12,
	)
})

test("turn selection accepts both supported endpoints and rejects the adjacent unsupported values", () => {
	for (const turns of [4, MAX_WORKFLOW_TURNS])
		assert.equal(
			readWorkflowSelection({ ALPHA_E2E_SCENARIO_ID: "long-thread", ALPHA_E2E_SCENARIO_TURNS: String(turns) })
				.turns,
			turns,
		)
	for (const turns of [3, MAX_WORKFLOW_TURNS + 1])
		assert.throws(
			() =>
				readWorkflowSelection({
					ALPHA_E2E_SCENARIO_ID: "long-thread",
					ALPHA_E2E_SCENARIO_TURNS: String(turns),
				}),
			WorkflowFailure,
		)
})
