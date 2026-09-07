import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { setImmediate as nextTurn } from "node:timers/promises"
import test from "node:test"

import type { LanguageModelChat } from "vscode"
import type { RooCodeAPI } from "@alpha-code/types"

import {
	configureLiveCopilot,
	discoverLiveCopilotModels,
	LIVE_COPILOT_DISCOVERY_TIMEOUT_MS,
} from "../liveModelSelection"

const model = { vendor: "copilot", family: "gpt-5.5", id: "copilot-gpt-5.5" } as LanguageModelChat

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function fixture(
	options: {
		active?: boolean
		missing?: boolean
		activate?: () => Promise<void> | void
		select?: (query: number) => PromiseLike<LanguageModelChat[]> | LanguageModelChat[]
	} = {},
) {
	const listeners = new Set<() => void>()
	let disposed = 0
	let activations = 0
	let queries = 0
	let inFlight = 0
	let maxInFlight = 0
	let configurations = 0
	let authChecks = 0
	const vscode = {
		extensions: {
			getExtension: (id: string) => {
				assert.equal(id, "GitHub.copilot-chat")
				return options.missing
					? undefined
					: {
							isActive: options.active ?? false,
							activate: () => {
								activations++
								assert.equal(listeners.size, 1, "subscribe before activation")
								return options.activate?.()
							},
						}
			},
		},
		lm: {
			onDidChangeChatModels: (listener: () => void) => {
				listeners.add(listener)
				return {
					dispose: () => {
						disposed++
						listeners.delete(listener)
					},
				}
			},
			selectChatModels: (selector: object) => {
				assert.deepEqual(selector, { vendor: "copilot" })
				assert.equal(listeners.size, 1, "subscribe before discovery")
				queries++
				inFlight++
				maxInFlight = Math.max(maxInFlight, inFlight)
				// Keep synchronous throws synchronous; production must handle both forms.
				const result = options.select ? options.select(queries) : [model]
				return Promise.resolve(result).finally(() => inFlight--)
			},
		},
	} as unknown as typeof import("vscode")
	const api = {
		getConfiguration: () => ({}),
		setConfiguration: async () => configurations++,
	} as unknown as RooCodeAPI
	return {
		vscode,
		api,
		dependencies: {
			loadVsCode: async () => vscode,
			canSendRequest: () => {
				authChecks++
				return true
			},
		},
		emit: () => listeners.forEach((listener) => listener()),
		state: () => ({
			listeners: listeners.size,
			disposed,
			activations,
			queries,
			maxInFlight,
			configurations,
			authChecks,
		}),
	}
}

test("discovery-only setup shares activation readiness without probing or configuring", async () => {
	const activation = deferred<void>()
	const host = fixture({ activate: () => activation.promise })
	const result = discoverLiveCopilotModels({ setup: true }, host.dependencies)
	await nextTurn()
	assert.equal(host.state().activations, 1)
	assert.equal(host.state().queries, 0)
	host.emit()
	activation.resolve()
	const metadata = await result
	assert.equal(metadata.status, "available")
	assert.equal(metadata.setup, true)
	assert.deepEqual(metadata.readiness, {
		status: "ready",
		activation: "completed",
		queryCount: 1,
		modelChangeObserved: true,
	})
	assert.equal(host.state().authChecks, 0)
	assert.equal(host.state().configurations, 0)
	assert.equal(host.state().disposed, 1)
})

test("an active ready provider needs one query and no activation", async () => {
	const host = fixture({ active: true })
	const metadata = await discoverLiveCopilotModels({}, host.dependencies)
	assert.equal(metadata.readiness?.activation, "already-active")
	assert.equal(host.state().activations, 0)
	assert.equal(host.state().queries, 1)
	host.emit()
	await nextTurn()
	assert.equal(host.state().queries, 1)
	assert.equal(host.state().listeners, 0)
})

test("an empty catalog waits for a real event without polling", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const host = fixture({ select: (query) => (query === 1 ? [] : [model]) })
	let completed = false
	const result = discoverLiveCopilotModels({}, host.dependencies).then((value) => {
		completed = true
		return value
	})
	await nextTurn()
	context.mock.timers.tick(10_000)
	await nextTurn()
	assert.equal(completed, false)
	assert.equal(host.state().queries, 1)
	host.emit()
	assert.equal((await result).status, "available")
	assert.equal(host.state().queries, 2)
	assert.equal(host.state().disposed, 1)
	context.mock.timers.tick(LIVE_COPILOT_DISCOVERY_TIMEOUT_MS)
	assert.equal(host.state().queries, 2)
})

test("events during an in-flight query coalesce into one refresh without losing the change", async () => {
	const firstQuery = deferred<LanguageModelChat[]>()
	const host = fixture({ select: (query) => (query === 1 ? firstQuery.promise : [model]) })
	const result = discoverLiveCopilotModels({}, host.dependencies)
	await nextTurn()
	for (let index = 0; index < 1_000; index++) host.emit()
	assert.equal(host.state().queries, 1)
	firstQuery.resolve([])
	assert.equal((await result).status, "available")
	assert.equal(host.state().queries, 2)
	assert.equal(host.state().maxInFlight, 1)
	assert.equal(host.state().listeners, 0)
})

for (const stage of ["load", "activation", "query", "empty"] as const) {
	test(`one deadline bounds ${stage} and ignores late completion`, async (context) => {
		context.mock.timers.enable({ apis: ["setTimeout"] })
		const load = deferred<typeof import("vscode")>()
		const activation = deferred<void>()
		const query = deferred<LanguageModelChat[]>()
		const host = fixture({
			activate: stage === "activation" ? () => activation.promise : undefined,
			select: stage === "query" ? () => query.promise : stage === "empty" ? () => [] : undefined,
		})
		const result = configureLiveCopilot(
			host.api,
			{ modelId: model.id, setup: true },
			{ ...host.dependencies, ...(stage === "load" ? { loadVsCode: () => load.promise } : {}) },
		)
		await nextTurn()
		context.mock.timers.tick(LIVE_COPILOT_DISCOVERY_TIMEOUT_MS)
		const metadata = await result
		assert.equal(metadata.ready, false)
		assert.equal(metadata.error?.code, "discovery-unavailable")
		assert.equal(metadata.discovery.readiness?.status, "timed-out")
		assert.equal(host.state().listeners, 0)
		const atDeadline = host.state()
		load.resolve(host.vscode)
		activation.resolve()
		query.resolve([model])
		host.emit()
		await nextTurn()
		assert.equal(host.state().queries, atDeadline.queries)
		assert.equal(host.state().activations, atDeadline.activations)
		assert.equal(host.state().configurations, 0)
		assert.equal(host.state().authChecks, 0)
	})
}

test("activation and discovery share a deadline that catalog events cannot renew", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const activation = deferred<void>()
	const host = fixture({ activate: () => activation.promise, select: () => [] })
	const result = discoverLiveCopilotModels({}, host.dependencies)
	await nextTurn()
	context.mock.timers.tick(10_000)
	activation.resolve()
	await nextTurn()
	host.emit()
	await nextTurn()
	context.mock.timers.tick(5_000)
	const metadata = await result
	assert.equal(metadata.readiness?.status, "timed-out")
	assert.equal(metadata.readiness?.activation, "completed")
	assert.equal(host.state().queries, 2)
})

test("a provider emitting a change on every empty query cannot starve the deadline", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const host = fixture({
		select: () => {
			host.emit()
			return []
		},
	})
	const result = discoverLiveCopilotModels({}, host.dependencies)
	await nextTurn()
	await nextTurn()
	assert.ok(host.state().queries >= 2)
	context.mock.timers.tick(LIVE_COPILOT_DISCOVERY_TIMEOUT_MS)
	assert.equal((await result).readiness?.status, "timed-out")
	const queries = host.state().queries
	await nextTurn()
	assert.equal(host.state().queries, queries)
	assert.equal(host.state().maxInFlight, 1)
	assert.equal(host.state().disposed, 1)
})

for (const stage of ["load", "activation", "query", "empty", "queued"] as const) {
	test(`abort during ${stage} cleans up and prohibits late auth/configuration`, async () => {
		const cancellation = new AbortController()
		const load = deferred<typeof import("vscode")>()
		const activation = deferred<void>()
		const query = deferred<LanguageModelChat[]>()
		const host = fixture({
			activate: stage === "activation" ? () => activation.promise : undefined,
			select: stage === "query" ? () => query.promise : () => [],
		})
		const result = configureLiveCopilot(
			host.api,
			{ modelId: model.id, setup: true },
			{
				...host.dependencies,
				signal: cancellation.signal,
				...(stage === "load" ? { loadVsCode: () => load.promise } : {}),
			},
		)
		await nextTurn()
		if (stage === "queued") host.emit()
		cancellation.abort()
		await assert.rejects(result, { name: "AbortError" })
		assert.equal(getEventListeners(cancellation.signal, "abort").length, 0)
		assert.equal(host.state().listeners, 0)
		const queries = host.state().queries
		load.resolve(host.vscode)
		activation.resolve()
		query.resolve([model])
		await nextTurn()
		assert.equal(host.state().queries, queries)
		assert.equal(host.state().authChecks, 0)
		assert.equal(host.state().configurations, 0)
	})
}

test("pre-aborted discovery-only setup does not load the host API", async () => {
	const cancellation = new AbortController()
	cancellation.abort()
	await assert.rejects(
		discoverLiveCopilotModels(
			{ setup: true },
			{ signal: cancellation.signal, loadVsCode: async () => assert.fail("must not load") },
		),
		{ name: "AbortError" },
	)
})

for (const stage of ["load", "activation", "query"] as const) {
	for (const rejection of [false, true]) {
		test(`${stage} ${rejection ? "rejection" : "throw"} is redacted and never retried`, async () => {
			const fail = (): never | Promise<never> => {
				const error = new Error("sensitive provider detail")
				if (rejection) return Promise.reject(error)
				throw error
			}
			const host = fixture({
				activate: stage === "activation" ? fail : undefined,
				select: stage === "query" ? fail : undefined,
			})
			const result = await configureLiveCopilot(
				host.api,
				{ modelId: model.id, setup: true },
				{ ...host.dependencies, ...(stage === "load" ? { loadVsCode: fail } : {}) },
			)
			assert.equal(result.error?.code, "discovery-unavailable")
			assert.equal(result.discovery.readiness?.status, "failed")
			assert.equal(JSON.stringify(result).includes("sensitive provider detail"), false)
			host.emit()
			await nextTurn()
			assert.equal(host.state().activations, stage === "load" ? 0 : 1)
			assert.equal(host.state().queries, stage === "query" ? 1 : 0)
			assert.equal(host.state().authChecks, 0)
			assert.equal(host.state().configurations, 0)
			assert.equal(host.state().listeners, 0)
		})
	}
}

test("a missing or disabled provider is not installed, enabled, or queried", async () => {
	const host = fixture({ missing: true })
	const result = await discoverLiveCopilotModels({}, host.dependencies)
	assert.equal(result.readiness?.status, "provider-unavailable")
	assert.equal(host.state().activations, 0)
	assert.equal(host.state().queries, 0)
	assert.equal(host.state().disposed, 1)
})

test("nonempty catalogs still fail closed for wrong identity, ambiguity, and unsupported effort", async () => {
	for (const request of [
		{ modelId: "display-name-or-alias", expected: "model-unavailable" },
		{ modelId: model.id, modelFamily: "wrong-family", expected: "model-unavailable" },
		{ modelId: model.id, reasoningEffort: "invalid-effort", expected: "effort-unavailable" },
		{ modelId: model.id, duplicate: true, expected: "model-selection-ambiguous" },
	]) {
		const host = fixture({ select: () => (request.duplicate ? [model, model] : [model]) })
		const result = await configureLiveCopilot(host.api, request, host.dependencies)
		assert.equal(result.error?.code, request.expected)
		assert.equal(host.state().queries, 1)
		assert.equal(host.state().authChecks, 0)
		assert.equal(host.state().configurations, 0)
		assert.equal(host.state().listeners, 0)
	}
})
