import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { executeSteps, recordHarnessFailure } from "./steps.mjs"

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

test("a surviving POSIX process group blocks evidence, subsequent steps, and build lease release", async () => {
	for (const platform of ["linux", "darwin"]) {
		let calls = 0
		const input = fixture({
			platform,
			runProcess: async () => {
				calls++
				return { exitCode: 0, signal: null, cleanupVerified: false }
			},
			verify: async () => assert.fail("must not inspect evidence while the process group survives"),
		})
		await executeSteps(input)
		assert.equal(calls, 1)
		assert.equal(input.report.status, "failed")
		assert.equal(input.report.steps[0].error, "cleanup_failed")
		assert.equal(input.report.steps[0].evidence, undefined)
		assert.equal(input.report.steps[1].status, "not_started")
		assert.equal(input.report.cleanupUnverified, true)
	}
})

test("ordinary Windows process closure retains its uncertain cleanup without failing successful commands", async () => {
	let calls = 0
	const input = fixture({
		platform: "win32",
		runProcess: async () => {
			calls++
			return { exitCode: 0, signal: null, cleanupVerified: false }
		},
		verify: async () => ({ status: "passed" }),
	})
	await executeSteps(input)
	assert.equal(calls, 2)
	assert.equal(input.report.status, "passed")
	assert.equal(input.report.steps[0].cleanupVerified, false)
	assert.equal(input.report.cleanupUnverified, undefined)
})

test("missing owned host shutdown evidence preserves the build lease even after an ordinary Windows exit", async () => {
	const input = fixture({
		platform: "win32",
		runProcess: async () => ({ exitCode: 0, signal: null, cleanupVerified: false }),
		verify: async () => ({ status: "failed", stage: "host-receipts", cleanupVerified: false }),
	})
	await executeSteps(input)
	assert.equal(input.report.status, "failed")
	assert.equal(input.report.cleanupUnverified, true)
	assert.equal(input.report.steps[1].status, "not_started")
})

test("a failed assertion with verified owned closure fails acceptance without leaking the build lease", async () => {
	const input = fixture({
		platform: "win32",
		runProcess: async () => ({ exitCode: 1, signal: null, cleanupVerified: false }),
		verify: async () => ({ status: "failed", reason: "invalid_host_receipt", cleanupVerified: true }),
	})
	await executeSteps(input)
	assert.equal(input.report.status, "failed")
	assert.equal(input.report.steps[0].evidence.cleanupVerified, true)
	assert.equal(input.report.cleanupUnverified, undefined)
	assert.equal(input.report.steps[1].status, "not_started")
})

test("a signalled Windows root with uncertain descendant cleanup retains the build lease", async () => {
	let calls = 0
	const input = fixture({
		platform: "win32",
		runProcess: async () => {
			calls++
			return { exitCode: null, signal: "SIGTERM", cleanupVerified: false }
		},
		verify: async () => assert.fail("must not inspect evidence with unknown descendant ownership"),
	})
	await executeSteps(input)
	assert.equal(calls, 1)
	assert.equal(input.report.status, "failed")
	assert.equal(input.report.steps[0].error, "cleanup_failed")
	assert.equal(input.report.steps[1].status, "not_started")
	assert.equal(input.report.cleanupUnverified, true)
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

test("final provenance exceptions persist a sanitized failure without replacing the original error", async () => {
	const report = { status: "passed" }
	let saved
	await recordHarnessFailure(report, "source-finalization", async (value) => {
		saved = structuredClone(value)
	})
	assert.equal(saved.status, "failed")
	assert.deepEqual(saved.failure, { code: "harness_exception", stage: "source-finalization" })
	await recordHarnessFailure(report, "source-finalization", async () => {
		throw new Error("private write diagnostic")
	})
	assert.equal(JSON.stringify(report).includes("private"), false)
})

test("an exit-zero hard gate cannot pass when its execution receipt is missing or skipped", async () => {
	for (const reason of ["missing_test_receipt", "skipped_hard_gate"]) {
		let calls = 0
		const input = fixture({
			runProcess: async () => {
				calls++
				return { exitCode: 0, signal: null, cleanupVerified: true }
			},
			verify: async () => ({ status: "failed", reason }),
		})
		await executeSteps(input)
		assert.equal(calls, 1)
		assert.equal(input.report.status, "failed")
		assert.equal(input.report.steps[0].evidence.reason, reason)
		assert.equal(input.report.steps[1].status, "not_started")
	}
})

test("the harness bounds Vitest 4 workers even when the parent requests more", async () => {
	const previous = process.env.VITEST_MAX_WORKERS
	process.env.VITEST_MAX_WORKERS = "8"
	try {
		const workers = []
		const input = fixture({
			runProcess: async (command) => {
				workers.push(command.env.VITEST_MAX_WORKERS)
				return { exitCode: 0, signal: null, cleanupVerified: true }
			},
		})
		await executeSteps(input)
		assert.deepEqual(workers, ["2", "2"])
	} finally {
		if (previous === undefined) delete process.env.VITEST_MAX_WORKERS
		else process.env.VITEST_MAX_WORKERS = previous
	}
})
