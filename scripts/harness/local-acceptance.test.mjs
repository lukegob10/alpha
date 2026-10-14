import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import {
	parseLocalAcceptanceArgs,
	localAcceptanceHostsStopped,
	recordLocalAcceptanceFailure,
	localAcceptanceExecution,
} from "./local-acceptance.mjs"

test("driver exceptions retain a sanitized failed receipt even if saving fails", async () => {
	const report = { status: "running" }
	await recordLocalAcceptanceFailure(report, "host", false, async () => {
		throw new Error("private connection")
	})
	assert.equal(report.status, "failed")
	assert.equal(report.cleanupVerified, false)
	assert.deepEqual(report.failure, { stage: "host", code: "local_acceptance_exception" })
	assert.equal(JSON.stringify(report).includes("private"), false)
})

test("local evidence does not promote injected or absent execution receipts", () => {
	assert.equal(localAcceptanceExecution({ phases: [{ execution: "test-seam" }] }), "test-seam")
	assert.equal(localAcceptanceExecution({ phases: [{ status: "passed" }] }), "unverified")
	assert.equal(localAcceptanceExecution({ host: { execution: "extension-host" } }), "extension-host")
})

test("local acceptance rejects ambiguous or missing inputs before side effects", () => {
	for (const args of [
		[],
		["live"],
		["cancellation"],
		["budgets", "--output", "relative"],
		["budgets", "--output", path.resolve("out"), "--output", path.resolve("again")],
	])
		assert.throws(() => parseLocalAcceptanceArgs(args))
	assert.equal(
		parseLocalAcceptanceArgs([
			"cancellation",
			"--output",
			path.resolve("out"),
			"--vscode-executable",
			path.resolve("Code.exe"),
		]).scenario,
		"cancellation",
	)
})

test("unknown shutdown cannot release the shared build lease", () => {
	assert.equal(localAcceptanceHostsStopped({ cleanupVerified: true, leaseReleased: true }), true)
	assert.equal(localAcceptanceHostsStopped({ cleanupVerified: true, leaseReleased: false }), false)
	assert.equal(localAcceptanceHostsStopped({ cleanupVerified: false, runs: [{ hostExitObserved: true }] }), false)
	assert.equal(localAcceptanceHostsStopped({ phases: [{ cleanupVerified: true, leaseReleased: true }] }), true)
	assert.equal(localAcceptanceHostsStopped({ phases: [{ cleanupVerified: true, leaseReleased: false }] }), false)
	assert.equal(localAcceptanceHostsStopped({ status: "passed" }), false)
	assert.equal(localAcceptanceHostsStopped({ runs: [] }), false)
	assert.equal(
		localAcceptanceHostsStopped({ runs: [{ hostExitObserved: true }, { hostExitObserved: false }] }),
		false,
	)
	assert.equal(localAcceptanceHostsStopped({ host: { hostExitObserved: true } }), true)
	assert.equal(localAcceptanceHostsStopped({ runs: [{ hostExitObserved: true }, { hostExitObserved: true }] }), true)
})
