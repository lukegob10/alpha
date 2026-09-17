import { strict as assert } from "node:assert"
import { test } from "node:test"

import { guardTaskApi, guardVsCodeLmHandler, WorkflowRequestBudget } from "./requestBudget"

test("fault hooks only receive resolved real responses and never bypass the request budget", async () => {
	let resolveResponse!: (value: object) => void
	let sends = 0
	let interceptions = 0
	const actual = Object.freeze({ stream: "opaque" })
	const client = {
		id: "model",
		sendRequest: () => {
			sends++
			return new Promise<object>((resolve) => {
				resolveResponse = resolve
			})
		},
	}
	const handler = { getClient: async () => client }
	const budget = new WorkflowRequestBudget(1, "model")
	budget.transformResponse = (response) => {
		assert.equal(response, actual)
		interceptions++
		return response
	}
	const restore = guardVsCodeLmHandler(handler, budget)
	try {
		const guarded = await handler.getClient()
		const pending = guarded.sendRequest()
		assert.equal(sends, 1)
		assert.equal(interceptions, 0)
		resolveResponse(actual)
		assert.equal(await pending, actual)
		assert.equal(interceptions, 1)
		assert.throws(() => guarded.sendRequest(), /request_limit_reached/)
		assert.equal(sends, 1)
	} finally {
		restore()
	}
})

test("request budget fences actual sends including retries and completions without mutating the shared client", async () => {
	let sends = 0
	const client = {
		id: "model-a",
		family: "family-a",
		sendRequest() {
			assert.equal(this, client)
			sends++
			return Promise.resolve("response")
		},
		countTokens() {
			assert.equal(this, client)
			return 3
		},
	}
	const originalSend = client.sendRequest
	const handler = {
		async getClient() {
			return client
		},
	}
	const budget = new WorkflowRequestBudget(2, "model-a")
	const restore = guardVsCodeLmHandler(handler, budget)
	try {
		const guarded = await handler.getClient()
		assert.notEqual(guarded, client)
		assert.equal(guarded.countTokens(), 3)
		assert.equal(budget.used, 0)
		await guarded.sendRequest()
		await (await handler.getClient()).sendRequest()
		assert.throws(() => guarded.sendRequest(), /request_limit_reached/)
		assert.equal(budget.used, 2)
		assert.equal(budget.exhausted, true)
		assert.equal(sends, 2)
		assert.equal(client.sendRequest, originalSend)
	} finally {
		restore()
	}
	assert.equal(await handler.getClient(), client)
})

test("unknown handler shape and wrong real model fail closed before dispatch", async () => {
	assert.throws(() => guardVsCodeLmHandler({}, new WorkflowRequestBudget(1)), /unsupported_handler/)
	const handler = {
		async getClient() {
			return {
				id: "wrong",
				sendRequest() {
					throw new Error("must not dispatch")
				},
			}
		},
	}
	const restore = guardVsCodeLmHandler(handler, new WorkflowRequestBudget(1, "wanted"))
	try {
		await assert.rejects(handler.getClient(), /actual_model_mismatch/)
	} finally {
		restore()
	}
})

test("frozen host clients preserve receivers, arguments, responses and errors behind the request fence", async () => {
	const messages = [{ role: "user", content: "fixture" }]
	const options = { modelOptions: { reasoningEffort: "high" } }
	const token = { isCancellationRequested: false }
	const response = Promise.resolve({ stream: Symbol("opaque-stream") })
	const providerError = new Error("provider failure")
	const opaqueKey = Symbol("provider-state")
	const opaqueState = {}
	let sends = 0
	const client = Object.freeze({
		id: "frozen-model",
		[opaqueKey]: opaqueState,
		get family() {
			assert.equal(this, client)
			return "frozen-family"
		},
		countTokens() {
			assert.equal(this, client)
			return 7
		},
		sendRequest(...args: unknown[]) {
			assert.equal(this, client)
			assert.equal(args[0], messages)
			assert.equal(args[1], options)
			assert.equal(args[2], token)
			if (++sends === 2) throw providerError
			return response
		},
	})
	const descriptors = Object.getOwnPropertyDescriptors(client)
	const handler = { getClient: async () => client }
	const originalGetClient = handler.getClient
	const budget = new WorkflowRequestBudget(2, "frozen-model")
	const restore = guardVsCodeLmHandler(handler, budget)
	try {
		const guarded = await handler.getClient()
		assert.equal(await handler.getClient(), guarded)
		assert.equal(guarded.family, "frozen-family")
		assert.equal(guarded[opaqueKey], opaqueState)
		assert.equal(guarded.countTokens(), 7)
		assert.equal(budget.used, 0)
		assert.equal(guarded.sendRequest(messages, options, token), response)
		assert.throws(
			() => guarded.sendRequest(messages, options, token),
			(error) => error === providerError,
		)
		assert.throws(() => guarded.sendRequest(messages, options, token), /request_limit_reached/)
		assert.equal(sends, 2)
		assert.equal(budget.used, 2)
		assert.deepEqual(Object.getOwnPropertyDescriptors(client), descriptors)
	} finally {
		restore()
		restore()
	}
	assert.equal(handler.getClient, originalGetClient)
	assert.equal(await handler.getClient(), client)
})

test("task API replacement cannot escape the shared predispatch budget", async () => {
	const makeHandler = () => ({
		async getClient() {
			return {
				id: "model",
				sendRequest() {
					return "ok"
				},
			}
		},
	})
	const task = { api: makeHandler() }
	const restore = guardTaskApi(task, new WorkflowRequestBudget(1, "model"))
	try {
		assert.equal((await task.api.getClient()).sendRequest(), "ok")
		task.api = makeHandler()
		assert.throws(() => (task.api = {} as ReturnType<typeof makeHandler>), /unsupported_handler/)
		const client = await task.api.getClient()
		assert.throws(() => client.sendRequest(), /request_limit_reached/)
	} finally {
		restore()
	}
	assert.equal(Object.getOwnPropertyDescriptor(task, "api")?.get, undefined)
})
