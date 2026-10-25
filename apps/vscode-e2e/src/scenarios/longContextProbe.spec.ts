import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
	contextProbePrompt,
	contextProbeReceipt,
	CONTEXT_PROBE_CHALLENGE_STEP,
	CONTEXT_PROBE_CHALLENGE_RESULT,
	CONTEXT_PROBE_RETAINED_FACTS,
	MAX_CONTEXT_PROBE_TURNS,
} from "./longContextProbe"
import { readWorkflowSelection } from "./contracts"
import { workflowCommands, workflowPrompt } from "./prompts"

test("long-context probes retire once-only facts and corrections without echoing them in recent receipts", () => {
	const first = workflowPrompt("contextProbe")
	const next = workflowPrompt("contextProbe", 1)
	assert.ok(first.includes("ALPHA-CONTEXT-ANCHOR-7f3a"))
	assert.ok(!next.includes("ALPHA-CONTEXT-ANCHOR-7f3a"))
	assert.ok(next.length > 16_000 && next.length < 18_000)
	assert.notEqual(next, workflowPrompt("contextProbe", 2))
	assert.equal(next, contextProbePrompt(1))
	assert.ok(first.includes("window=9"))
	assert.ok(next.includes("window=17"))
	assert.equal(contextProbeReceipt(1), "receipt-1")
	for (let step = 2; step <= MAX_CONTEXT_PROBE_TURNS; step++) {
		const prompt = contextProbePrompt(step)
		assert.ok(!prompt.includes("attempt_completion"), "Probe must use the current ordinary-response contract")
		for (const fact of [...CONTEXT_PROBE_RETAINED_FACTS, "window=9", "window=17"])
			assert.ok(!prompt.includes(fact), `Filler ${step} repeats ${fact}`)
		assert.equal(contextProbeReceipt(step), `receipt-${step}`)
	}
	const challenge = contextProbePrompt(CONTEXT_PROBE_CHALLENGE_STEP)
	assert.ok(!first.includes("attempt_completion"))
	assert.ok(!next.includes("attempt_completion"))
	assert.ok(!challenge.includes("attempt_completion"))
	for (const fact of [...CONTEXT_PROBE_RETAINED_FACTS, "window=9", "window=17"])
		assert.ok(!challenge.includes(fact), `Challenge leaks ${fact}`)
	assert.equal(contextProbeReceipt(CONTEXT_PROBE_CHALLENGE_STEP), CONTEXT_PROBE_CHALLENGE_RESULT)
	assert.ok(challenge.includes("latest delivery window"))
	assert.ok(challenge.includes("Do not inspect files"))
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
