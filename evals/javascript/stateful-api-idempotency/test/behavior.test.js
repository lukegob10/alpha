import test from "node:test"
import assert from "node:assert/strict"
import { charge } from "../src/payments.js"
test("retries return one external result", async () => {
	const store = new Map()
	let calls = 0
	const p = { charge: async () => ({ id: `p${++calls}` }) }
	assert.deepEqual(await charge(store, p, "k", 10), { id: "p1" })
	assert.deepEqual(await charge(store, p, "k", 10), { id: "p1" })
	assert.equal(calls, 1)
})

test("overlapping calls reserve the key before the provider settles", async () => {
	const store = new Map()
	const pending = Promise.withResolvers()
	const entered = Promise.withResolvers()
	let calls = 0
	const provider = {
		charge: async () => {
			calls++
			entered.resolve()
			return pending.promise
		},
	}
	const first = charge(store, provider, "same-key", 10)
	await entered.promise
	const retry = charge(store, provider, "same-key", 10)
	await Promise.resolve()
	const result = { id: "one-charge" }
	pending.resolve(result)
	assert.deepEqual(await Promise.all([first, retry]), [result, result])
	assert.equal(calls, 1)
	assert.deepEqual(await charge(store, provider, "same-key", 10), result)
	assert.equal(calls, 1)
})

test("same-key retries retain the original provider failure", async () => {
	const store = new Map()
	const pending = Promise.withResolvers()
	const entered = Promise.withResolvers()
	const reason = new Error("payment outcome unavailable")
	let calls = 0
	const provider = {
		charge: async () => {
			calls++
			entered.resolve()
			return pending.promise
		},
	}
	const first = charge(store, provider, "failed-key", 10)
	await entered.promise
	const retry = charge(store, provider, "failed-key", 10)
	const failures = Promise.all([
		assert.rejects(first, (error) => error === reason),
		assert.rejects(retry, (error) => error === reason),
	])
	pending.reject(reason)
	await failures
	await assert.rejects(charge(store, provider, "failed-key", 10), (error) => error === reason)
	assert.equal(calls, 1)
})

test("independent keys and falsey original results preserve their identities", async () => {
	const store = new Map()
	let calls = 0
	const provider = {
		charge: async (amount) => {
			calls++
			return amount === 0 ? undefined : { amount }
		},
	}
	assert.equal(await charge(store, provider, "zero", 0), undefined)
	assert.equal(await charge(store, provider, "zero", 0), undefined)
	assert.deepEqual(await charge(store, provider, "other", 10), { amount: 10 })
	assert.equal(calls, 2)
})
