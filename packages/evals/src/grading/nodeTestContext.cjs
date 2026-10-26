/* global require, module, process, __filename */
/* eslint-disable @typescript-eslint/no-require-imports -- Shared by ESM and CommonJS test imports without a build step. */
const { AsyncLocalStorage } = require("node:async_hooks")
const { Buffer } = require("node:buffer")
const { createHmac, randomBytes } = require("node:crypto")
const { getCallSites } = require("node:util")
const { pathToFileURL } = require("node:url")
const nativeTest = require("node:test")
const nativeAssert = require("node:assert/strict")

const active = new AsyncLocalStorage()
const expected = JSON.parse(process.env.ALPHA_EXPECTED_NODE_TESTS)
const AssertionError = nativeAssert.AssertionError
const stringify = JSON.stringify.bind(JSON)
const helperUrl = pathToFileURL(__filename).href
const failureKey = randomBytes(32)
// The preload runs before model imports. Its first worker output transfers this
// private capability to the supervisor, which withholds it from retained output.
process.stdout.write(
	stringify({ kind: "alpha-original-assertion-key", file: process.argv[1], key: failureKey.toString("hex") }) + "\n",
)
const originals = Object.fromEntries(
	Object.keys(nativeAssert)
		.filter((name) => typeof nativeAssert[name] === "function")
		.map((name) => [name, nativeAssert[name].bind(nativeAssert)]),
)
const methods = Object.fromEntries(Object.keys(originals).map((name) => [name, (...args) => assertion(name, args)]))

function assertion(name, args) {
	const state = active.getStore()
	if (!state) throw new Error("Assertion executed outside its owned test context")
	const caller = originalCaller()
	const ownedCall = Boolean(caller?.scriptId && caller.scriptId === state.scriptId)
	try {
		// Node's custom test assertion registry is mutable by imported solution
		// modules. Its functions may account for a plan, but never grade semantics.
		const value = originals[name](...args)
		if (value && typeof value.then === "function")
			return value.then(
				(result) => {
					state.context.assert.ok(true)
					state.completed++
					return result
				},
				(error) => {
					state.failed = true
					recordFailure(state, name, error, ownedCall)
					throw transportableFailure(error)
				},
			)
		state.context.assert.ok(true)
		state.completed++
		return value
	} catch (error) {
		state.failed = true
		recordFailure(state, name, error, ownedCall)
		throw transportableFailure(error)
	}
}

function transportableFailure(error) {
	if (!(error instanceof AssertionError)) return error
	// Node's test IPC cannot serialize functions or symbols nested in compared
	// values. Keep the authenticated diagnostic and original stack, while leaving
	// arbitrary candidate objects out of the error sent to the supervisor.
	const failure = new AssertionError({ message: String(error.message), operator: String(error.operator) })
	// AssertionError may append its own comparison diff to a supplied message.
	failure.message = String(error.message)
	failure.stack = String(error.stack)
	return failure
}

function originalCaller() {
	// Native script identity distinguishes the immutable fixture from a solution
	// that imports this helper or forges a matching eval sourceURL.
	// Node 24.21.0 contract checked 2026-10-23: https://nodejs.org/download/release/v24.21.0/docs/api/util.html#utilgetcallsitesframecount-options
	const sites = getCallSites(8, { sourceMap: false })
	for (let index = 0; index < sites.length; index++) {
		const site = sites[index]
		if (site.scriptName !== __filename && site.scriptName !== helperUrl) return site
	}
}

function recordFailure(state, assertion, error, ownedCall) {
	if (!ownedCall || !(error instanceof AssertionError)) return
	const proof = {
		file: state.file,
		name: state.name,
		assertion,
		code: "ERR_ASSERTION",
		message: Buffer.from(String(error.message)).subarray(0, 4_096).toString("utf8"),
	}
	const signature = createHmac("sha256", failureKey).update(stringify(proof)).digest("hex")
	state.context.diagnostic(stringify({ kind: "alpha-original-assertion-failure", ...proof, signature }))
}

const assert = Object.freeze(Object.assign((...args) => assertion("ok", args), methods))

function register(method, args) {
	const callback = args.at(-1)
	if (typeof args[0] !== "string" || typeof callback !== "function")
		throw new Error("Expected named Node test with a callback")
	const registration = originalCaller()
	return method(...args.slice(0, -1), async (context) => {
		const match = expected.find((item) => item.file === context.filePath && item.name === context.name)
		if (!match) throw new Error("Test has no independently captured assertion contract")
		// Node 24 test plans count only TestContext assertions. The extra assertion
		// proves that the original callback returned after its final assertion.
		// https://nodejs.org/download/release/v24.21.0/docs/api/test.html#contextplancountoptions
		context.plan(match.assertions + 1)
		const state = {
			context,
			file: match.file,
			name: match.name,
			scriptId: registration?.scriptId,
			completed: 0,
			failed: false,
		}
		await active.run(state, () => callback(context))
		if (state.failed || state.completed !== match.assertions)
			throw new Error("Original assertion execution did not complete its expected contract")
		context.assert.ok(true)
		context.diagnostic(
			JSON.stringify({ kind: "alpha-original-assertions", file: context.filePath, name: context.name }),
		)
	})
}

const test = (...args) => register(nativeTest, args)
for (const variant of ["skip", "todo", "only"]) test[variant] = (...args) => register(nativeTest[variant], args)
module.exports = test
module.exports.test = test
module.exports.it = test
module.exports.assert = assert
Object.freeze(module.exports)
