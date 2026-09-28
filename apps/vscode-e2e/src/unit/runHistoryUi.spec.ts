import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { completeHistoryUiRun } from "../runHistoryUi"

const verifiedHost = {
	status: "passed",
	execution: "extension-host",
	ownershipGate: "verified",
	captureComplete: true,
	hostExitObserved: true,
	actualVSCodeVersion: "1.122.1",
} as const

test("history UI accepts only a complete result from its owned exact-version host", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-history-ui-outcome-"))
	try {
		const evidence = path.join(root, "evidence")
		const output = path.join(root, "output")
		await fs.mkdir(evidence)
		await fs.mkdir(output)
		const nonce = "00000000-0000-4000-8000-000000000001"
		for (const stage of ["chats-small", "chats-dark", "chats-light", "chats-contrast"]) {
			await fs.writeFile(
				path.join(evidence, `ui-done-${stage}.json`),
				JSON.stringify({ nonce, stage, status: "passed" }),
			)
		}

		const accepted = await completeHistoryUiRun(verifiedHost, evidence, output, "verified")
		assert.equal(accepted.status, "passed")
		assert.deepEqual(accepted.host, verifiedHost)

		const comparative = await completeHistoryUiRun(
			{ ...verifiedHost, actualVSCodeVersion: "1.139.1" },
			evidence,
			output,
			"comparative-139",
			"1.139.1",
		)
		assert.equal(comparative.status, "passed")
		assert.equal(comparative.host.actualVSCodeVersion, "1.139.1")

		for (const [name, change] of [
			["failed", { status: "failed" }],
			["blocked", { status: "blocked" }],
			["test-seam", { execution: "test-seam" }],
			["unowned", { ownershipGate: undefined }],
			["incomplete", { captureComplete: false }],
			["host-open", { hostExitObserved: false }],
			["wrong-version", { actualVSCodeVersion: "1.123.0" }],
		] as const) {
			const runId = `invalid-${name}`
			await assert.rejects(
				completeHistoryUiRun({ ...verifiedHost, ...change }, evidence, output, runId),
				/History UI host validation failed/,
				`${name} host result must not pass even after every renderer stage was acknowledged`,
			)
			assert.equal(
				JSON.parse(await fs.readFile(path.join(output, runId, "ui-done-chats-contrast.json"), "utf8")).status,
				"passed",
				`Renderer receipts remain available for the ${name} failure`,
			)
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
