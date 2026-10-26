import { strict as assert } from "node:assert"
import { test } from "node:test"
import type { ThreadWaitResult } from "@alpha-code/types"

import { COLLECT_CHILD_RESULTS, ConcurrentThreadsAI, type ScriptChunk } from "./concurrentThreadsFixture"

const tools = ["create_thread", "wait_threads"].map((name) => ({ function: { name } }))
const result = (value: unknown) => [
	{ role: "user", content: [{ type: "tool_result", content: JSON.stringify(value) }] },
]

async function request(scripted: ConcurrentThreadsAI, messages: unknown[] = []): Promise<ScriptChunk[]> {
	const chunks: ScriptChunk[] = []
	for await (const chunk of scripted.createMessage("", messages, { taskId: "root", tools })) chunks.push(chunk)
	return chunks
}

test("the native coordinator explicitly waits for results after a human follow-up", async () => {
	const scripted = new ConcurrentThreadsAI(2)
	await request(scripted)
	await request(scripted, result({ threadId: "child-1" }))
	await request(scripted, result({ threadId: "child-2" }))
	const followup = [{ role: "user", content: COLLECT_CHILD_RESULTS }]
	const chunks = await request(scripted, followup)
	const wait = chunks.find((chunk) => chunk.type === "tool_call")
	assert.ok(wait)
	assert.equal(wait?.name, "wait_threads")
	assert.deepEqual(JSON.parse(wait.arguments), {
		targets: [{ threadId: "child-1" }, { threadId: "child-2" }],
		timeoutMs: 0,
	})
})

test("explicit collection reads all ten results in bounded batches without duplicate targets", async () => {
	const scripted = new ConcurrentThreadsAI(10)
	await request(scripted)
	const children = Array.from({ length: 10 }, (_, index) => `child-${index + 1}`)
	for (const threadId of children) await request(scripted, result({ threadId }))
	assert.equal(scripted.coordinatorRequests, 11)
	assert.equal(scripted.receivedResults.size, 0)
	const messages: unknown[] = [{ role: "user", content: COLLECT_CHILD_RESULTS }]
	let chunks = await request(scripted, messages)
	for (const [index, threadId] of children.entries()) {
		const wait = chunks.find((chunk) => chunk.type === "tool_call")
		assert.ok(wait)
		assert.equal(wait.name, "wait_threads")
		const { targets } = JSON.parse(wait.arguments) as { targets: Array<{ threadId: string }> }
		assert.ok(targets.length <= 8)
		assert.deepEqual(
			targets.map((target) => target.threadId),
			children.slice(index, index + 8),
		)
		const waited: ThreadWaitResult = {
			timedOut: false,
			wake: { threadId, reason: "turnCompleted", turnId: `turn:${threadId}` },
			polls: [
				{
					schemaVersion: 1,
					thread: { id: threadId, status: { type: "idle" } },
					cursor: `cursor:${threadId}`,
					revision: 1,
					changed: true,
					latestTurn: { id: `turn:${threadId}`, status: "completed" },
					latestAssistantMessageId: `message:${threadId}`,
					latestAssistantMessage: {
						id: `message:${threadId}`,
						turnId: `turn:${threadId}`,
						text: `Concurrent child ${threadId} completed.`,
					},
					latestToolMarkerId: null,
					latestToolMarker: null,
				},
			],
		}
		messages.push(...result(waited))
		chunks = await request(scripted, messages)
		assert.equal(scripted.receivedResults.size, index + 1)
	}
	assert.equal(
		chunks.some((chunk) => chunk.type === "tool_call"),
		false,
	)
	assert.deepEqual(scripted.receivedResults, new Set(children))
	assert.equal(scripted.coordinatorRequests, 22)
})

test("host notifications complete all ten results without an explicit collection turn", async () => {
	const scripted = new ConcurrentThreadsAI(10, "host")
	let launchSettled = false
	const launched = request(scripted).then((chunks) => {
		launchSettled = true
		return chunks
	})
	await Promise.resolve()
	assert.equal(launchSettled, false)
	const children = Array.from({ length: 10 }, (_, index) => `child-${index + 1}`)
	scripted.registerHostChildren(children)
	assert.equal(
		(await launched).some((chunk) => chunk.type === "tool_call"),
		false,
	)
	const messages: unknown[] = []
	for (const [index, childId] of children.entries()) {
		messages.push({
			role: "user",
			agent_message_id: `receipt:${childId}`,
			content: `Concurrent child ${childId} completed.`,
		})
		const chunks = await request(scripted, messages)
		assert.equal(
			chunks.some((chunk) => chunk.type === "tool_call"),
			false,
		)
		assert.equal(scripted.receivedResults.size, index + 1)
	}
	assert.deepEqual(scripted.receivedResults, new Set(children))
	await assert.rejects(request(scripted, messages), /duplicate wake loops/)
})

test("a held worker settles cancellation without emitting a completion", async () => {
	const scripted = new ConcurrentThreadsAI()
	const controller = new AbortController()
	const stream = scripted.createMessage("", [], { taskId: "child", signal: controller.signal })
	const next = stream.next()
	assert.equal(scripted.started.has("child"), true)
	controller.abort()
	assert.equal((await next).done, true)
})
