import assert from "node:assert/strict"
import test from "node:test"
import { getEventListeners } from "node:events"

import { runPersistentLiveSetup, type LiveSetupAction, type LiveSetupState } from "../suite/liveCopilot"

type Check = { ready: boolean; failure?: string }

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function setup(
	check: (signal: AbortSignal) => Promise<Check>,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
	let dispatch!: (action: LiveSetupAction) => void
	let disposed = 0
	let completed = false
	const states: LiveSetupState<Check>[] = []
	const result = runPersistentLiveSetup(check, {
		...options,
		render: (state) => states.push(state),
		onAction: (handler) => {
			dispatch = handler
			return { dispose: () => disposed++ }
		},
	})
	void result.then(
		() => (completed = true),
		() => (completed = true),
	)
	return {
		result,
		dispatch: (action: LiveSetupAction) => dispatch(action),
		states,
		disposed: () => disposed,
		completed: () => completed,
	}
}

test("dismissal, premature Finish, and elapsed time leave setup open without requests", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	let requests = 0
	const session = setup(async () => {
		requests++
		return { ready: true }
	})
	session.dispatch(undefined)
	session.dispatch("finish")
	context.mock.timers.tick(24 * 60 * 60 * 1_000)
	await Promise.resolve()
	assert.equal(requests, 0)
	assert.equal(session.completed(), false)
	assert.deepEqual(session.states, [{ phase: "waiting" }])
	session.dispatch("cancel")
	assert.deepEqual(await session.result, { status: "cancelled" })
	assert.equal(session.disposed(), 1)
})

test("empty catalog and unready authentication permit explicit retry, not automatic requests", async () => {
	const responses: Check[] = [
		{ ready: false, failure: "model-unavailable" },
		{ ready: false, failure: "authentication-required" },
		{ ready: false, failure: "authentication-unknown" },
		{ ready: true },
	]
	let requests = 0
	const session = setup(async () => responses[requests++]!)
	for (const response of responses) {
		session.dispatch("continue")
		await Promise.resolve()
		assert.deepEqual(session.states.at(-1), { phase: response.ready ? "ready" : "waiting", check: response })
		session.dispatch(undefined)
		assert.equal(session.completed(), false)
		if (!response.ready) session.dispatch("finish")
	}
	assert.equal(requests, 4)
	assert.equal(session.completed(), false, "readiness alone does not close the host")
	session.dispatch("finish")
	assert.deepEqual(await session.result, { status: "finished", check: { ready: true } })
	assert.equal(session.disposed(), 1)
	session.dispatch("continue")
	assert.equal(requests, 4, "stale control callbacks cannot issue requests after Finish")
})

test("Continue is single-flight and Finish cannot race an in-flight check", async () => {
	const check = deferred<Check>()
	let requests = 0
	const session = setup(() => {
		requests++
		return check.promise
	})
	session.dispatch("continue")
	session.dispatch("continue")
	session.dispatch("finish")
	assert.equal(requests, 1)
	assert.equal(session.states.at(-1)?.phase, "checking")
	check.resolve({ ready: true })
	await Promise.resolve()
	assert.equal(session.completed(), false)
	session.dispatch("finish")
	assert.equal((await session.result).status, "finished")
})

test("retry invalidates earlier readiness; an unsuccessful retry cannot Finish", async () => {
	let ready = true
	const session = setup(async () => ({ ready }))
	session.dispatch("continue")
	await Promise.resolve()
	ready = false
	session.dispatch("continue")
	session.dispatch("finish")
	await Promise.resolve()
	session.dispatch("finish")
	assert.equal(session.completed(), false)
	assert.equal(session.states.at(-1)?.phase, "waiting")
	session.dispatch("cancel")
	await session.result
})

test("Cancel aborts and drains an in-flight check without publishing late readiness", async () => {
	const check = deferred<Check>()
	let checkSignal: AbortSignal | undefined
	const session = setup((signal) => {
		checkSignal = signal
		return check.promise
	})
	session.dispatch("continue")
	session.dispatch("cancel")
	session.dispatch("cancel")
	assert.equal(checkSignal?.aborted, true)
	await Promise.resolve()
	assert.equal(session.completed(), false, "terminal capture must wait for check-owned artifact writes")
	check.resolve({ ready: true })
	assert.deepEqual(await session.result, { status: "cancelled" })
	assert.equal(session.states.at(-1)?.phase, "checking", "late check result cannot reopen setup")
	assert.equal(session.disposed(), 1)
})

test("host lifetime abort cancels setup and removes the listener", async () => {
	const lifetime = new AbortController()
	const session = setup(async () => ({ ready: true }), { signal: lifetime.signal })
	assert.equal(getEventListeners(lifetime.signal, "abort").length, 1)
	lifetime.abort()
	assert.deepEqual(await session.result, { status: "cancelled" })
	assert.equal(getEventListeners(lifetime.signal, "abort").length, 0)
	assert.equal(session.disposed(), 1)
})

test("a pre-cancelled host does not render controls or issue requests", async () => {
	const lifetime = new AbortController()
	lifetime.abort()
	const result = await runPersistentLiveSetup(async () => assert.fail("no request"), {
		signal: lifetime.signal,
		render: () => assert.fail("no render"),
		onAction: () => assert.fail("no subscription"),
	})
	assert.deepEqual(result, { status: "cancelled" })
	assert.equal(getEventListeners(lifetime.signal, "abort").length, 0)
})

test("only an explicit deadline ends waiting setup, with a typed timeout", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const session = setup(async () => assert.fail("no automatic request"), { timeoutMs: 500 })
	context.mock.timers.tick(499)
	await Promise.resolve()
	assert.equal(session.completed(), false)
	context.mock.timers.tick(1)
	assert.deepEqual(await session.result, { status: "timed-out" })
	assert.equal(session.disposed(), 1)
})

test("explicit timeout aborts an active check and cannot become a late success", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const check = deferred<Check>()
	let checkSignal: AbortSignal | undefined
	const session = setup(
		(signal) => {
			checkSignal = signal
			return check.promise
		},
		{ timeoutMs: 500 },
	)
	session.dispatch("continue")
	context.mock.timers.tick(500)
	assert.equal(checkSignal?.aborted, true)
	check.resolve({ ready: true })
	assert.deepEqual(await session.result, { status: "timed-out" })
})

test("unexpected check failure is surfaced, not retried or swallowed", async () => {
	const failure = new Error("synthetic artifact failure")
	const session = setup(async () => {
		throw failure
	})
	session.dispatch("continue")
	await assert.rejects(session.result, (error) => error === failure)
	assert.equal(session.disposed(), 1)
})
