import assert from "node:assert/strict"
import { test } from "node:test"

import { ManagedAgentBudgetAI } from "./managedAgentBudgetFixture"

test("budget fixture emits synthetic usage and observes cancellation", async () => {
	const model = new ManagedAgentBudgetAI()
	const controller = new AbortController()
	model.registerRole("output-child", "output")
	const iterator = model.createMessage("", [], { taskId: "output-child", signal: controller.signal })
	const firstPending = iterator.next()
	await new Promise((resolve) => setImmediate(resolve))
	model.releaseUsage("output-child")
	assert.deepEqual(await firstPending, { value: { type: "text", text: "budget-fixture-usage" }, done: false })
	assert.deepEqual(await iterator.next(), {
		value: { type: "usage", inputTokens: 2, outputTokens: 8, totalCost: 0 },
		done: false,
	})
	assert.equal(model.observations.get("output-child")?.usageEmitted, true)
	const completion = iterator.next()
	controller.abort()
	model.releaseCompletion("output-child")
	assert.equal((await completion).done, true)
	assert.equal(model.observations.get("output-child")?.abortObserved, true)
})

test("budget Worker fixture leaves its tool continuation held until cancellation", async () => {
	const model = new ManagedAgentBudgetAI("node .alpha-cancellation/command.cjs")
	const controller = new AbortController()
	model.registerRole("worker-child", "process")
	const first = model.createMessage("", [], { taskId: "worker-child", signal: controller.signal })
	model.releaseUsage("worker-child")
	assert.equal((await first.next()).value?.type, "tool_call")
	assert.equal((await first.next()).value?.type, "usage")
	const continuation = model.createMessage("", [], { taskId: "worker-child", signal: controller.signal })
	const pending = continuation.next()
	await new Promise((resolve) => setImmediate(resolve))
	controller.abort()
	assert.equal((await pending).done, true)
	assert.equal((await continuation.next()).done, true)
	assert.equal(model.observations.get("worker-child")?.abortObserved, true)
})

test("root budget fixture uses wait_agent before its held continuation", async () => {
	const model = new ManagedAgentBudgetAI()
	const controller = new AbortController()
	model.registerRole("root-child", "root")
	const first = model.createMessage("", [], { taskId: "root-child", signal: controller.signal })
	model.releaseUsage("root-child")
	const call = (await first.next()).value
	assert.equal(call?.type, "tool_call")
	assert.ok(call?.type === "tool_call")
	assert.deepEqual(JSON.parse(call.arguments), { timeout_ms: 10_000 })
	assert.equal((await first.next()).value?.type, "usage")
	assert.equal((await first.next()).done, true)
	const continuation = model.createMessage("", [], { taskId: "root-child", signal: controller.signal })
	const pending = continuation.next()
	await new Promise((resolve) => setImmediate(resolve))
	controller.abort()
	assert.equal((await pending).done, true)
	assert.equal((await continuation.next()).done, true)
})
