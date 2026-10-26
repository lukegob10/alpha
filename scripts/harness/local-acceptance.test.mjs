import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
	main,
	parseLocalAcceptanceArgs,
	localAcceptanceHostsStopped,
	recordLocalAcceptanceFailure,
	localAcceptanceExecution,
} from "./local-acceptance.mjs"
import { executeSteps } from "./steps.mjs"

test("a receipt write failure cannot release a build lease with unverified child cleanup", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "alpha-local-acceptance-"))
	const previousPnpmPath = process.env.npm_execpath
	process.env.npm_execpath = path.join(root, "pnpm.cjs")
	let releases = 0
	try {
		const executable = path.join(root, "Code.exe")
		const output = path.join(root, "evidence")
		await writeFile(executable, "non-executed fixture")
		await assert.rejects(
			main(["cancellation", "--output", output, "--vscode-executable", executable], {
				acquireLease: async () => async () => {
					releases++
				},
				runSteps: async (input) => {
					let saves = 0
					await executeSteps({
						...input,
						platform: "linux",
						runProcess: async () => ({ exitCode: 0, signal: null, cleanupVerified: false }),
						save: async (report) => {
							if (++saves === 2) throw new Error("fixture receipt write failure")
							await input.save(report)
						},
					})
				},
			}),
			/fixture receipt write failure/u,
		)
		const receipt = JSON.parse(await readFile(path.join(output, "result.json"), "utf8"))
		assert.equal(receipt.status, "failed")
		assert.equal(receipt.cleanupUnverified, true)
		assert.equal(receipt.cleanupVerified, false)
		assert.equal(releases, 0)
	} finally {
		if (previousPnpmPath === undefined) delete process.env.npm_execpath
		else process.env.npm_execpath = previousPnpmPath
		const resolved = await realpath(root)
		assert.equal(path.dirname(resolved), await realpath(os.tmpdir()))
		assert.match(path.basename(resolved), /^alpha-local-acceptance-/u)
		await rm(resolved, { recursive: true, force: true })
	}
})

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
