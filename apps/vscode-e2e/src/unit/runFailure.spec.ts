import { test } from "node:test"
import * as assert from "node:assert/strict"
import { spawnSync } from "child_process"
import * as path from "path"
import * as os from "os"
import Mocha from "mocha"
import { TestRunError, describeTestRunFailure, TEST_RUN_FAILURE_CODES, testSuiteOutcome } from "../runFailure"

test("closed failure guidance covers every code and never publishes arbitrary exception fields", () => {
	for (const code of TEST_RUN_FAILURE_CODES) {
		const result = describeTestRunFailure({ code, message: "PRIVATE_SENTINEL", guidance: "PRIVATE_SENTINEL" })
		assert.equal(result.failure, code)
		assert.ok(result.guidance.length > 20)
		assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"))
	}
	assert.equal(describeTestRunFailure({ code: "PRIVATE_SENTINEL" }).failure, "invalid-options")
})

test("trusted configuration diagnostics explain the missing path group without exposing input paths", () => {
	const result = describeTestRunFailure(
		new TestRunError("profile-invalid", "PRIVATE_SENTINEL", "profile-paths-required"),
	)
	assert.equal(result.diagnostic, "profile-paths-required")
	assert.match(result.guidance, /--profile-dir, --workspace, and --artifacts-dir together/)
	assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"))
})

test("actual CLI reports malformed options and incomplete path groups without an uncaught stack", () => {
	const runner = path.resolve(__dirname, "../runTest.js")
	for (const args of [
		["--PRIVATE_SENTINEL"],
		["--provider", "scripted", "--artifacts-dir", path.join(os.tmpdir(), "PRIVATE_SENTINEL")],
	]) {
		const child = spawnSync(process.execPath, [runner, ...args], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 10_000,
		})
		assert.equal(child.status, 1)
		assert.ok(!child.stderr.includes("PRIVATE_SENTINEL"))
		const result = JSON.parse(child.stderr.trim())
		assert.equal(result.status, "blocked")
		assert.ok(result.guidance.length > 20)
		if (args.includes("--artifacts-dir")) assert.equal(result.diagnostic, "profile-paths-required")
	}
})

async function runMochaCase(variant: "zero-match" | "pending" | "runtime-skip" | "passed" | "failed" | "hook-failed") {
	const mocha = new Mocha({ reporter: class extends Mocha.reporters.Base {} })
	const suite = Mocha.Suite.create(mocha.suite, "selected suite")
	if (variant === "zero-match") mocha.grep("no-such-test")
	if (variant === "hook-failed")
		suite.beforeAll(() => {
			throw new Error("expected hook failure")
		})
	suite.addTest(
		new Mocha.Test(
			"example",
			variant === "pending"
				? undefined
				: function (this: Mocha.Context) {
						if (variant === "runtime-skip") this.skip()
						if (variant === "failed") throw new Error("expected assertion failure")
					},
		),
	)
	return new Promise<ReturnType<typeof testSuiteOutcome>>((resolve) => {
		const runner = mocha.run((failures) => resolve(testSuiteOutcome(failures, runner.stats)))
	})
}

test("real Mocha zero matches and entirely pending/skipped tests cannot produce a passing gate", async () => {
	for (const variant of ["zero-match", "pending", "runtime-skip"] as const) {
		const outcome = await runMochaCase(variant)
		assert.equal(outcome.counts.failed, 0, "the previous failures-only gate falsely accepted this case")
		assert.equal(outcome.counts.executed, 0)
		assert.equal(outcome.failure, "no-tests-executed")
		assert.equal(outcome.counts.pending, variant === "zero-match" ? 0 : 1)
	}
})

test("real Mocha passing execution passes, and assertion/hook failures retain their original failure", async () => {
	const passing = await runMochaCase("passed")
	assert.equal(passing.failure, undefined)
	assert.deepEqual(passing.counts, { total: 1, passed: 1, pending: 0, executed: 1, failed: 0 })
	for (const variant of ["failed", "hook-failed"] as const) {
		const outcome = await runMochaCase(variant)
		assert.equal(outcome.failure, "host-failed")
		assert.equal(outcome.counts.failed, 1)
	}
	assert.equal(testSuiteOutcome(0).failure, "no-tests-executed")
})
