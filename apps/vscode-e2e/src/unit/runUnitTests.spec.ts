import * as assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "node:test"

import { unitTestEnvironment } from "../runUnitTests"

test("unit subprocesses cannot export host receipts and preserve their structured test receipt destination", async () => {
	const env = {
		...process.env,
		ALPHA_HARNESS_EVIDENCE_DIR: "host-receipt-destination",
		ALPHA_HARNESS_EVIDENCE_FILE: "unit-receipt-destination",
		ALPHA_HARNESS_REPOSITORY_ROOT: "repository-root",
	}
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[
			"-e",
			"process.stdout.write(JSON.stringify({ host: process.env.ALPHA_HARNESS_EVIDENCE_DIR ?? null, unit: process.env.ALPHA_HARNESS_EVIDENCE_FILE, root: process.env.ALPHA_HARNESS_REPOSITORY_ROOT }))",
		],
		{ env: unitTestEnvironment(env), windowsHide: true, timeout: 5_000 },
	)
	assert.deepEqual(JSON.parse(stdout), { host: null, unit: "unit-receipt-destination", root: "repository-root" })
	assert.equal(env.ALPHA_HARNESS_EVIDENCE_DIR, "host-receipt-destination")
})
