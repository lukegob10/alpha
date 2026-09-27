import * as assert from "node:assert/strict"
import { test } from "node:test"
import type { ExtensionTestRunResult } from "../../runTest"
import { assertTicketsUiHostResult } from "../../runTicketsUi"

const passed: ExtensionTestRunResult = {
	runId: "tickets-fixture",
	exitCode: 0,
	providerMode: "scripted",
	vscodeVersion: "1.122.1",
	actualVSCodeVersion: "1.122.1",
	workspace: "owned-workspace",
	userDataDir: "owned-user-data",
	extensionsDir: "owned-extensions",
	artifactsDir: "owned-artifacts",
	retained: true,
	status: "passed",
	execution: "extension-host",
	ownershipGate: "verified",
	captureComplete: true,
	hostExitObserved: true,
}

test("Tickets renderer accepts complete exact-host evidence", () => {
	assert.doesNotThrow(() => assertTicketsUiHostResult(passed))
})

const invalid: [string, Partial<ExtensionTestRunResult>][] = [
	["failed", { status: "failed" }],
	["blocked", { status: "blocked" }],
	["test seam", { execution: "test-seam" }],
	["unverified ownership", { ownershipGate: undefined }],
	["incomplete capture", { captureComplete: false }],
	["missing capture", { captureComplete: undefined }],
	["unobserved exit", { hostExitObserved: false }],
	["wrong host", { actualVSCodeVersion: "1.123.0" }],
	["missing host version", { actualVSCodeVersion: undefined }],
	["failed exit", { exitCode: 1 }],
]

for (const [condition, patch] of invalid) {
	test(`Tickets renderer rejects ${condition} evidence`, () => {
		assert.throws(() => assertTicketsUiHostResult({ ...passed, ...patch }), /passing, verified, complete/)
	})
}
