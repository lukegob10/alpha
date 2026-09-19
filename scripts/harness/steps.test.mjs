import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { executeSteps } from "./steps.mjs"

function fixture(overrides = {}) {
	return {
		commands: [["lint"], ["check-types"]],
		root: process.cwd(),
		pnpmPath: path.resolve("pnpm.cjs"),
		report: { status: "running", steps: [{ status: "not_started" }, { status: "not_started" }] },
		signal: new AbortController().signal,
		save: async () => {},
		...overrides,
	}
}

test("cancellation is forwarded and prevents a successful child from admitting the next step", async () => {
	const abort = new AbortController()
	let calls = 0
	const input = fixture({
		signal: abort.signal,
		runProcess: async (_command, options) => {
			calls++
			assert.equal(options.signal, abort.signal)
			abort.abort()
			return { exitCode: 0, signal: null, cleanupVerified: true }
		},
	})
	await executeSteps(input)
	assert.equal(calls, 1)
	assert.equal(input.report.status, "cancelled")
	assert.equal(input.report.steps[1].status, "not_started")
})

test("a failed command is terminal and leaves later commands unstarted", async () => {
	let calls = 0
	const saved = []
	const input = fixture({
		save: async (report) => saved.push(structuredClone(report)),
		runProcess: async () => {
			calls++
			return { exitCode: 7, signal: null, cleanupVerified: true }
		},
	})
	await executeSteps(input)
	assert.equal(calls, 1)
	assert.equal(input.report.status, "failed")
	assert.equal(input.report.steps[0].exitCode, 7)
	assert.equal(input.report.steps[1].status, "not_started")
	assert.equal(saved.at(-1).status, "failed")
})

test("pre-cancelled runs do not launch, and cancellation with uncertain cleanup retains the lease", async () => {
	const before = fixture({ signal: AbortSignal.abort(), runProcess: async () => assert.fail("must not launch") })
	await executeSteps(before)
	assert.equal(before.report.status, "cancelled")
	assert.equal(before.report.cleanupUnverified, undefined)
	const abort = new AbortController()
	const during = fixture({
		signal: abort.signal,
		runProcess: async () => {
			abort.abort()
			return { exitCode: null, signal: "SIGTERM", cleanupVerified: false }
		},
	})
	await executeSteps(during)
	assert.equal(during.report.status, "cancelled")
	assert.equal(during.report.cleanupUnverified, true)
})

test("launch and cleanup exceptions are recorded without copying sensitive error messages", async () => {
	for (const cleanup of [false, true]) {
		const input = fixture({
			runProcess: async () => {
				throw Object.assign(new Error("private child output"), cleanup ? { cleanupVerified: false } : {})
			},
		})
		await executeSteps(input)
		assert.equal(input.report.status, "failed")
		assert.equal(input.report.steps[0].error, cleanup ? "cleanup_failed" : "process_failed")
		assert.equal(Boolean(input.report.cleanupUnverified), cleanup)
		assert.equal(JSON.stringify(input.report).includes("private child output"), false)
	}
})
