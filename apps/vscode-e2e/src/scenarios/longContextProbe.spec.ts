import { strict as assert } from "node:assert"
import { test } from "node:test"
import { contextProbePrompt, contextProbeReceipt, MAX_CONTEXT_PROBE_TURNS } from "./longContextProbe"
import { readWorkflowSelection } from "./contracts"
import { workflowCommands, workflowPrompt } from "./prompts"

test("long-context probes grow real history without restating the retained answer", () => {
	const first = workflowPrompt("contextProbe")
	const next = workflowPrompt("contextProbe", 1)
	assert.ok(first.includes("ALPHA-CONTEXT-ANCHOR-7f3a"))
	assert.ok(!next.includes("ALPHA-CONTEXT-ANCHOR-7f3a"))
	assert.ok(next.length > 16_000 && next.length < 18_000)
	assert.notEqual(next, workflowPrompt("contextProbe", 2))
	assert.equal(next, contextProbePrompt(1))
	assert.equal(contextProbeReceipt(1), "ALPHA-CONTEXT-ANCHOR-7f3a receipt-1")
	assert.deepEqual(workflowCommands("contextProbe"), [])
})

test("long-context budgets extend only the new scenario and remain bounded", () => {
	const env = { ALPHA_E2E_SCENARIO_ID: "long-context-recovery" }
	assert.equal(readWorkflowSelection(env).turns, 32)
	assert.equal(readWorkflowSelection({ ALPHA_E2E_SCENARIO_ID: "long-context-empty-exhaustion" }).turns, 12)
	assert.equal(readWorkflowSelection({ ...env, ALPHA_E2E_SCENARIO_TURNS: String(MAX_CONTEXT_PROBE_TURNS) }).turns, 64)
	assert.throws(() => readWorkflowSelection({ ...env, ALPHA_E2E_SCENARIO_TURNS: "65" }))
	assert.throws(() =>
		readWorkflowSelection({ ...env, ALPHA_E2E_SCENARIO_ID: "long-thread", ALPHA_E2E_SCENARIO_TURNS: "32" }),
	)
	for (const value of [-1, 1.5, Infinity, MAX_CONTEXT_PROBE_TURNS + 3]) assert.throws(() => contextProbePrompt(value))
})
