import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { normalizeVitestEvidence } from "./execution-evidence.mjs"
import { configureLaneEvidence } from "./lane-evidence.mjs"
import { hostReceipt } from "./fixtures/evidence.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const prefix = "alpha-vitest-diagnostics-"

async function verifyRaw(raw, runner = "vitest") {
	const temporaryRoot = await realpath(os.tmpdir())
	const directory = await mkdtemp(path.join(temporaryRoot, prefix))
	const args = ["--dir", "src", "test"]
	try {
		const collector = await configureLaneEvidence({
			lane: { commands: [args], receipts: [{ runner, packageDir: "src" }] },
			name: "unit",
			root,
			directory,
			id: "diagnostic-unit-control",
		})
		const rawFile = path.join(directory, runner === "vitest" ? "step-0.raw.json" : "step-0.execution.json")
		await writeFile(rawFile, JSON.stringify(raw))
		const evidence = await collector.verify({ index: 0, args, step: {} })
		if (runner === "vitest") await assert.rejects(readFile(rawFile), { code: "ENOENT" })
		return evidence
	} finally {
		assert.equal(path.dirname(path.resolve(directory)), path.resolve(temporaryRoot))
		assert.ok(path.basename(directory).startsWith(prefix))
		await rm(directory, { recursive: true, force: true })
	}
}

function failedVitest() {
	return {
		success: false,
		numTotalTests: 2,
		numPassedTests: 1,
		numFailedTests: 1,
		numPendingTests: 0,
		numTodoTests: 0,
		testResults: [
			{
				name: path.join(root, "src/diagnostic-control.spec.ts"),
				assertionResults: [
					{ status: "passed", fullName: "PRIVATE_LANE_NAME" },
					{
						status: "failed",
						duration: 20_001,
						title: "PRIVATE_LANE_NAME",
						failureMessages: ["Error: Hook timed out in 20000ms.\nPRIVATE_LANE_STACK_AND_PROMPT"],
					},
				],
			},
		],
	}
}

test("Vitest diagnostics reach failed step evidence before raw deletion without changing its receipt", async () => {
	const raw = failedVitest()
	const evidence = await verifyRaw(raw)
	assert.equal(evidence.status, "failed")
	assert.equal(evidence.reason, "test_execution_failed")
	assert.deepEqual(evidence.receipt, normalizeVitestEvidence(raw, root))
	assert.deepEqual(evidence.failureDiagnostics, {
		schemaVersion: 1,
		kind: "alpha-vitest-failure-diagnostics",
		maxFailures: 64,
		totalFailures: 1,
		retainedFailures: 1,
		truncated: false,
		failures: [
			{
				path: "src/diagnostic-control.spec.ts",
				assertionOrdinal: 2,
				durationMs: 20_001,
				classification: "hook_timeout",
			},
		],
	})
	assert.equal(JSON.stringify(evidence).includes("PRIVATE_LANE"), false)
})

test("Vitest diagnostics never survive invalid raw receipt validation and raw data is still deleted", async () => {
	const raw = failedVitest()
	raw.numFailedTests = 2
	const evidence = await verifyRaw(raw)
	assert.deepEqual(evidence, {
		status: "failed",
		stage: "test-execution",
		reason: "missing_or_invalid_execution_receipt",
	})
	assert.equal(JSON.stringify(evidence).includes("PRIVATE_LANE"), false)
})

test("Vitest diagnostics leave the existing failed Node receipt shape unchanged", async () => {
	const counts = { total: 1, passed: 0, failed: 1, skipped: 0, todo: 0, cancelled: 0 }
	const receipt = {
		schemaVersion: 1,
		kind: "alpha-test-execution",
		runner: "node",
		complete: true,
		success: false,
		counts,
		files: [{ path: "scripts/harness/control.test.mjs", counts }],
	}
	const evidence = await verifyRaw(receipt, "node")
	assert.deepEqual(evidence, { status: "failed", reason: "test_execution_failed", receipt })
	assert.equal(Object.hasOwn(evidence, "failureDiagnostics"), false)
})

test("missing host receipts cannot establish shutdown or release the shared build lease", async () => {
	const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "alpha-missing-host-"))
	try {
		const collector = await configureLaneEvidence({
			lane: { commands: [["harness:stress"]], receipts: [{ runner: "extension-host", suite: "stress" }] },
			name: "stress",
			root,
			directory,
			id: "missing-host-control",
		})
		const verdict = await collector.verify({
			index: 0,
			args: ["harness:stress"],
			step: { startedAt: new Date().toISOString() },
		})
		assert.equal(verdict.status, "failed")
		assert.equal(verdict.stage, "host-receipts")
		assert.equal(verdict.cleanupVerified, false)
	} finally {
		assert.ok(path.basename(directory).startsWith("alpha-missing-host-"))
		await rm(directory, { recursive: true, force: true })
	}
})

test("failed host acceptance retains known closure while incomplete or unclosed launches remain unknown", async () => {
	for (const scenario of ["closed-failure", "missing-next-receipt", "unclosed-failure"]) {
		const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "alpha-failed-host-"))
		try {
			const collector = await configureLaneEvidence({
				lane: { commands: [["test:smoke:1380"]], receipts: [{ runner: "extension-host", suite: "smoke" }] },
				name: "host",
				root,
				directory,
				id: "failed-host-control",
			})
			const first = {
				...hostReceipt("extension.test"),
				startedAt: "2026-10-02T10:00:01Z",
				completedAt: "2026-10-02T10:00:02Z",
			}
			const failed = {
				...hostReceipt("modes.test"),
				startedAt: "2026-10-02T10:00:03Z",
				completedAt: "2026-10-02T10:00:04Z",
				status: "failed",
				exitCode: 1,
				failure: "host-failed",
				testCounts: { total: 1, passed: 0, pending: 0, executed: 1, failed: 1 },
			}
			await writeFile(path.join(directory, "step-0-hosts", `${first.runId}.json`), JSON.stringify(first))
			if (scenario !== "missing-next-receipt") {
				if (scenario === "unclosed-failure") failed.hostExitObserved = false
				await writeFile(path.join(directory, "step-0-hosts", `${failed.runId}.json`), JSON.stringify(failed))
			}
			const verdict = await collector.verify({
				index: 0,
				args: ["test:smoke:1380"],
				step: { startedAt: "2026-10-02T10:00:00Z", exitCode: 1 },
			})
			assert.equal(verdict.status, "failed")
			assert.equal(verdict.cleanupVerified, scenario === "closed-failure")
		} finally {
			assert.ok(path.basename(directory).startsWith("alpha-failed-host-"))
			await rm(directory, { recursive: true, force: true })
		}
	}
})
