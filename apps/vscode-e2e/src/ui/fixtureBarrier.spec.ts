import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { uiFixtureBarrier } from "./fixtureBarrier"

test("UI fixture barriers require matching external receipts and preserve reserved identity", async () => {
	const previousNonce = process.env.ALPHA_UI_ACCEPTANCE_NONCE
	const previousDirectory = process.env.ALPHA_E2E_ARTIFACTS_DIR
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ui-barrier-"))
	const nonce = "12345678-1234-1234-1234-123456789012"
	try {
		delete process.env.ALPHA_UI_ACCEPTANCE_NONCE
		await uiFixtureBarrier("inactive")
		assert.deepEqual(await fs.readdir(directory), [])
		process.env.ALPHA_UI_ACCEPTANCE_NONCE = nonce
		process.env.ALPHA_E2E_ARTIFACTS_DIR = directory
		await fs.writeFile(
			path.join(directory, "ui-done-good.json"),
			JSON.stringify({ nonce, stage: "good", status: "passed" }),
		)
		await uiFixtureBarrier("good", { nonce: "wrong", stage: "wrong", version: "1.122.1" })
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "ui-stage-good.json"), "utf8")), {
			nonce,
			stage: "good",
			version: "1.122.1",
		})
		await fs.writeFile(
			path.join(directory, "ui-done-stale.json"),
			JSON.stringify({ nonce: "stale", stage: "stale", status: "passed" }),
		)
		await assert.rejects(uiFixtureBarrier("stale"), /Expected values to be strictly equal/)
		await assert.rejects(uiFixtureBarrier("good"), /EEXIST/)
	} finally {
		if (previousNonce === undefined) delete process.env.ALPHA_UI_ACCEPTANCE_NONCE
		else process.env.ALPHA_UI_ACCEPTANCE_NONCE = previousNonce
		if (previousDirectory === undefined) delete process.env.ALPHA_E2E_ARTIFACTS_DIR
		else process.env.ALPHA_E2E_ARTIFACTS_DIR = previousDirectory
		await fs.rm(directory, { recursive: true, force: true })
	}
})
