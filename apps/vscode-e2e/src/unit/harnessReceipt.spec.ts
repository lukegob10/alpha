import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { writeHarnessReceipt } from "../harnessReceipt"
import type { ExtensionTestRunResult } from "../runTest"

test("harness receipts project final observed state and omit raw locations and error text", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-harness-receipt-")))
	try {
		const result: ExtensionTestRunResult = {
			runId: "receipt-test",
			providerMode: "scripted",
			vscodeVersion: "1.125.0",
			workspace: "PRIVATE_WORKSPACE",
			userDataDir: "PRIVATE_PROFILE",
			extensionsDir: "PRIVATE_EXTENSIONS",
			artifactsDir: "PRIVATE_ARTIFACTS",
			profileDir: "PRIVATE_PROFILE_ROOT",
			status: "blocked",
			exitCode: 1,
			retained: true,
			execution: "test-seam",
			hostExitObserved: false,
			failure: "evidence-retention-failed",
			guidance: "PRIVATE_ERROR",
			actualVSCodeVersion: "1.125.0",
			captureComplete: true,
			retention: { schemaVersion: 1, runId: "receipt-test", status: "failed", eligibility: "not-eligible" },
		}
		await writeHarnessReceipt(
			root,
			{ providerMode: "scripted", vscodeVersion: "1.125.0", testFile: "extension.test", requireAllTests: true },
			result,
			"2026-10-02T00:00:00Z",
		)
		const bytes = await fs.readFile(path.join(root, "receipt-test.json"), "utf8")
		const receipt = JSON.parse(bytes)
		assert.equal(receipt.kind, "alpha-extension-test-run")
		assert.equal(receipt.schemaVersion, 1)
		assert.equal(receipt.actualHostVersion, "1.125.0")
		assert.equal(receipt.status, "blocked")
		assert.equal(receipt.execution, "test-seam")
		assert.equal(receipt.requireAllTests, false, "requested strict mode cannot replace an observed host receipt")
		assert.equal(receipt.testCounts, null)
		assert.equal(receipt.actualModelId, null)
		assert.equal(receipt.actualReasoningEffort, null)
		assert.equal(receipt.retentionStatus, "failed")
		assert.equal(receipt.profile.kind, "persistent")
		assert.match(receipt.profile.sha256, /^[a-f0-9]{64}$/)
		assert.doesNotMatch(bytes, /PRIVATE/)
		await assert.rejects(
			writeHarnessReceipt(root, { providerMode: "scripted", vscodeVersion: "1.125.0" }, result, "same"),
			{ code: "EEXIST" },
		)
		assert.equal(await fs.readFile(path.join(root, "receipt-test.json"), "utf8"), bytes)
	} finally {
		assert.equal(await fs.realpath(path.dirname(root)), await fs.realpath(os.tmpdir()))
		assert.match(path.basename(root), /^alpha-harness-receipt-/)
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("harness receipt output rejects relative paths and traversal in run IDs", async () => {
	await assert.rejects(
		writeHarnessReceipt("relative", {} as never, {} as never, ""),
		/Invalid harness receipt directory/,
	)
	await assert.rejects(
		writeHarnessReceipt(os.tmpdir(), {} as never, { runId: "../outside" } as never, ""),
		/Invalid harness receipt ID/,
	)
})
