import assert from "node:assert/strict"
import test from "node:test"

import {
	assertClaudeThinkingPersisted,
	assertClaudeThinkingRoundTrip,
	observeClaudeRequest,
	observeClaudeThinkingEmission,
	persistedClaudeThinkingDigests,
	type ClaudeRequestObservation,
	type ClaudeThinkingEmission,
} from "../suite/claude-copilot-support"
import { guardTaskApi, WorkflowRequestBudget } from "../scenarios/requestBudget"

const encrypted = {
	value: "",
	id: "claude-encrypted-1",
	metadata: { encrypted_content: "opaque-native-state", vscode_thinking_origin_api: "messages" },
}
const done = { value: "", id: "", metadata: { vscode_reasoning_done: true } }
const identity = { modelId: "opaque/copilot/model", family: "claude-sonnet-5.5" }

test("Claude replay compares opaque native metadata after JSON persistence without retaining provider state", () => {
	const history = [
		{
			role: "assistant",
			content: [
				{ type: "text", text: "visible answer" },
				{ type: "vscode_lm_thinking", ...encrypted, modelId: identity.modelId, modelVendor: "copilot" },
				{ type: "vscode_lm_thinking", ...done },
			],
		},
		{ role: "user", content: [{ type: "vscode_lm_thinking", ...encrypted }] },
	]
	const digests = persistedClaudeThinkingDigests(history)
	assert.equal(digests.length, 2)
	assert.deepEqual(persistedClaudeThinkingDigests(JSON.parse(JSON.stringify(history))), digests)
	assert.ok(digests.every((digest) => /^[a-f0-9]{64}$/.test(digest)))
	assert.notEqual(digests[0], digests[1])
	const changed = structuredClone(history)
	const content = changed[0]!.content as Array<Record<string, unknown>>
	content[1]!.metadata = { ...encrypted.metadata, encrypted_content: "different-state" }
	assert.notEqual(persistedClaudeThinkingDigests(changed)[0], digests[0])
})

test("Claude request observation keeps the frozen host receiver and exact thinking replay wire payload", async () => {
	const response = { stream: {} }
	let sends = 0
	const client = Object.freeze({
		id: identity.modelId,
		family: identity.family,
		vendor: "copilot",
		sendRequest(this: unknown) {
			assert.equal(this, client)
			sends++
			return response
		},
	})
	const handler = {
		async getClient() {
			return client
		},
	}
	const original = handler.getClient
	const observations: ClaudeRequestObservation[] = []
	const budget = new WorkflowRequestBudget(12, identity.modelId, "disable")
	budget.onTaskRequest = (client, messages, options) =>
		observeClaudeRequest(identity, observations, client, messages, options)
	const restore = guardTaskApi({ api: handler }, budget)
	try {
		const observed = await handler.getClient()
		const send = observed.sendRequest as (...args: unknown[]) => unknown
		assert.equal(
			send([{ role: 2, content: [encrypted, done, { value: "visible text" }] }], {
				includeEncryptedThinking: true,
				tools: [{ name: "exec_command" }, { name: "apply_patch" }],
			}),
			response,
		)
		assert.equal(sends, 1)
		assert.deepEqual(observations[0], {
			...identity,
			vendor: "copilot",
			includeEncryptedThinking: true,
			tools: ["exec_command", "apply_patch"],
			thinkingDigests: persistedClaudeThinkingDigests([
				{
					role: "assistant",
					content: [
						{ type: "vscode_lm_thinking", ...encrypted },
						{ type: "vscode_lm_thinking", ...done },
					],
				},
			]),
		})
		assert.doesNotMatch(JSON.stringify(observations), /opaque-native-state|visible text/)
	} finally {
		restore()
	}
	assert.equal(handler.getClient, original)
})

for (const model of [
	{ id: "another-claude", family: identity.family, vendor: "copilot" },
	{ id: identity.modelId, family: "gpt-5.6", vendor: "copilot" },
	{ id: identity.modelId, family: identity.family, vendor: "anthropic" },
]) {
	test(`Claude observation rejects a changed ${JSON.stringify(model)} before dispatch`, async () => {
		let sent = false
		const handler = {
			async getClient() {
				return {
					...model,
					sendRequest() {
						sent = true
					},
				}
			},
		}
		const budget = new WorkflowRequestBudget(12, identity.modelId, "disable")
		budget.onTaskRequest = (client, messages, options) =>
			observeClaudeRequest(identity, [], client, messages, options)
		const restore = guardTaskApi({ api: handler }, budget)
		try {
			await assert.rejects(async () => {
				const client = await handler.getClient()
				const send = client.sendRequest as (...args: unknown[]) => unknown
				send([], {
					tools: [],
					includeEncryptedThinking: true,
				})
			})
			assert.equal(sent, false)
			assert.equal(budget.used, 0)
		} finally {
			restore()
		}
	})
}

test("Claude observation fails before dispatch when encrypted thinking was not requested", async () => {
	let sent = false
	const handler = {
		async getClient() {
			return {
				id: identity.modelId,
				family: identity.family,
				vendor: "copilot",
				sendRequest() {
					sent = true
				},
			}
		},
	}
	const observations: ClaudeRequestObservation[] = []
	const budget = new WorkflowRequestBudget(12, identity.modelId, "disable")
	budget.onTaskRequest = (client, messages, options) =>
		observeClaudeRequest(identity, observations, client, messages, options)
	const restore = guardTaskApi({ api: handler }, budget)
	try {
		const client = await handler.getClient()
		assert.throws(() => (client.sendRequest as (...args: unknown[]) => unknown)([], { tools: [] }), /opt in/)
		assert.equal(sent, false)
		assert.deepEqual(observations, [])
		assert.equal(budget.used, 0)
	} finally {
		restore()
	}
})

test("zero native thinking emission reports replay unexercised even when a high-effort task completed", () => {
	const emissions: ClaudeThinkingEmission[] = []
	observeClaudeThinkingEmission(emissions, 1, { value: "visible final answer" })
	observeClaudeThinkingEmission(emissions, 1, { callId: "read", name: "exec_command", input: {} })
	const history = [{ role: "assistant", content: [{ type: "text", text: "visible final answer" }] }]
	assert.deepEqual(emissions, [])
	assertClaudeThinkingPersisted(emissions, history)
	assert.equal(assertClaudeThinkingRoundTrip(emissions, history, []), "not-emitted")
	assert.throws(
		() =>
			assertClaudeThinkingPersisted(emissions, [
				{ role: "assistant", content: [{ type: "vscode_lm_thinking", ...encrypted }] },
			]),
		/provider-emitted/,
	)
})

test("native incoming thinking is compared independently with persisted and outgoing replay payloads", () => {
	const emissions: ClaudeThinkingEmission[] = []
	observeClaudeThinkingEmission(emissions, 1, encrypted)
	observeClaudeThinkingEmission(emissions, 1, done)
	const history = [
		{
			role: "assistant",
			content: [
				{ type: "vscode_lm_thinking", ...encrypted, modelId: identity.modelId },
				{ type: "vscode_lm_thinking", ...done },
			],
		},
	]
	const digests = persistedClaudeThinkingDigests(history)
	assert.equal(emissions[0]?.nativeThinkingDigests.length, 1)
	assert.equal(assertClaudeThinkingRoundTrip(emissions, history, digests), "verified")
	assert.throws(
		() =>
			assertClaudeThinkingPersisted(emissions, [
				{ role: "assistant", content: [{ type: "vscode_lm_thinking", ...done }] },
			]),
		/survive persistence/,
	)
	const changed = structuredClone(history)
	changed[0]!.content[0]!.metadata = { ...encrypted.metadata, encrypted_content: "changed" }
	assert.throws(() => assertClaudeThinkingPersisted(emissions, changed), /survive persistence/)
	assert.throws(() => assertClaudeThinkingRoundTrip(emissions, history, digests.slice(1)), /replayed unchanged/)
	assert.throws(() => assertClaudeThinkingRoundTrip(emissions, history, [...digests].reverse()), /replayed unchanged/)
})

test("later Claude emissions must also survive final persistence without retroactively establishing earlier replay", () => {
	const before: ClaudeThinkingEmission[] = []
	const beforeHistory = [{ role: "assistant", content: [{ type: "text", text: "first turn" }] }]
	const replay = assertClaudeThinkingRoundTrip(before, beforeHistory, [])
	const after = structuredClone(before)
	observeClaudeThinkingEmission(after, 2, encrypted)
	assert.throws(() => assertClaudeThinkingPersisted(after, beforeHistory), /survive persistence/)
	assertClaudeThinkingPersisted(after, [
		...beforeHistory,
		{ role: "assistant", content: [{ type: "vscode_lm_thinking", ...encrypted }] },
	])
	assert.equal(replay, "not-emitted")
})

test("malformed incoming or persisted Claude thinking fails evidence instead of disappearing into empty digests", () => {
	const malformed = { value: "", id: "bad-native", metadata: { encrypted_content: Number.NaN } }
	const emissions: ClaudeThinkingEmission[] = []
	assert.throws(() => observeClaudeThinkingEmission(emissions, 1, malformed), /Provider-emitted/)
	assert.deepEqual(emissions, [])
	assert.throws(
		() =>
			persistedClaudeThinkingDigests([
				{ role: "assistant", content: [{ type: "vscode_lm_thinking", ...malformed }] },
			]),
		/Persisted Claude/,
	)
	assert.throws(() => observeClaudeThinkingEmission(emissions, 1, { value: 42 }, true), /Provider-emitted/)
})

test("Claude dispatch observations follow replaced task handlers and already prepared clients", async () => {
	let sends = 0
	const client = Object.freeze({
		id: identity.modelId,
		family: identity.family,
		vendor: "copilot",
		sendRequest(this: unknown) {
			assert.equal(this, client)
			sends++
		},
	})
	const makeHandler = () => ({
		preparedClient: undefined as typeof client | undefined,
		async getClient() {
			return client
		},
		async prepareModel() {
			this.preparedClient = await this.getClient()
		},
		async dispatch() {
			const prepared = this.preparedClient ?? (await this.getClient())
			return (prepared.sendRequest as (...args: unknown[]) => unknown)(
				[{ role: 2, content: [encrypted, done] }],
				{ tools: [{ name: "apply_patch" }], includeEncryptedThinking: true },
			)
		},
	})
	const first = makeHandler()
	const next = makeHandler()
	const firstGetClient = first.getClient
	const nextGetClient = next.getClient
	const task = { api: first }
	const observations: ClaudeRequestObservation[] = []
	const budget = new WorkflowRequestBudget(12, identity.modelId, "disable")
	budget.onTaskRequest = (client, messages, options) =>
		observeClaudeRequest(identity, observations, client, messages, options)
	const restore = guardTaskApi(task, budget)
	try {
		await task.api.dispatch()
		task.api = next
		assert.equal(first.getClient, firstGetClient, "Retired handlers must release their request guard")
		await task.api.prepareModel()
		await task.api.dispatch()
		assert.equal(sends, 2)
		assert.equal(budget.used, 2)
		assert.equal(observations.length, 2)
		assert.deepEqual(observations[1], observations[0])
		assert.equal(observations[1]!.thinkingDigests.length, 2)
	} finally {
		restore()
	}
	assert.equal(next.getClient, nextGetClient)
	assert.equal(task.api, next)
	assert.equal(Object.getOwnPropertyDescriptor(task, "api")?.get, undefined)
})
