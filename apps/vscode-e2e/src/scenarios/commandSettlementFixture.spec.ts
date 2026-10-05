import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

import {
	cleanupTestProfile,
	prepareTestProfile,
	TEST_ROOT_OWNERSHIP_MARKER,
	TEST_ROOT_OWNERSHIP_PURPOSE,
} from "../testProfile"
import { settlementScript, SETTLEMENT_ORACLE } from "./commandSettlement"
import { CommandSettlementFixture } from "./commandSettlementFixture"
import { applyFixturePatch } from "./fixturePatchTestHelper"

async function createOwnedProfile() {
	const profile = await prepareTestProfile({ vscodeVersion: "1.125.0" })
	try {
		await fs.writeFile(
			path.join(profile.workspace, TEST_ROOT_OWNERSHIP_MARKER),
			JSON.stringify({ schemaVersion: 1, purpose: TEST_ROOT_OWNERSHIP_PURPOSE, kind: "workspace" }),
			{ flag: "wx" },
		)
		return profile
	} catch (error) {
		await cleanupTestProfile(profile, true)
		throw error
	}
}

test("three settlement cases share exclusive host files and retain independent real oracle receipts", async () => {
	const profile = await createOwnedProfile()
	const fixture = new CommandSettlementFixture(profile.workspace, profile.artifactsDir)
	try {
		await fs.writeFile(path.join(profile.workspace, "unrelated.txt"), "preserve this", { flag: "wx" })
		for (const phase of ["receipt-fault", "execa", "vscode"] as const) {
			await fixture.prepareCase()
			await assert.rejects(fs.stat(path.join(profile.workspace, "build-receipt.json")), { code: "ENOENT" })
			if (phase === "receipt-fault") {
				await fs.writeFile(path.join(profile.workspace, "index.html"), "partial first edit", { flag: "wx" })
			} else {
				for (const call of settlementScript(1, profile.workspace))
					if (call.name === "apply_patch") await applyFixturePatch(profile.workspace, call.arguments.patch)
				await promisify(execFile)(process.execPath, [".alpha-receipt-oracle.cjs", "1"], {
					cwd: profile.workspace,
					windowsHide: true,
					timeout: 10_000,
					maxBuffer: 512 * 1024,
				})
				const receipt = JSON.parse(
					await fs.readFile(path.join(profile.workspace, "build-receipt.json"), "utf8"),
				)
				assert.deepEqual(receipt, { revision: 1, checks: 5, passed: true })
				await fs.writeFile(fixture.resultPath(phase), JSON.stringify({ phase, receipt }), { flag: "wx" })
			}
			await fixture.finishCase()
			assert.equal(
				await fs.readFile(path.join(profile.workspace, ".alpha-receipt-oracle.cjs"), "utf8"),
				SETTLEMENT_ORACLE,
			)
		}
		for (const phase of ["execa", "vscode"] as const) {
			const result = JSON.parse(await fs.readFile(fixture.resultPath(phase), "utf8"))
			assert.equal(result.phase, phase)
			assert.deepEqual(result.receipt, { revision: 1, checks: 5, passed: true })
			await assert.rejects(fs.writeFile(fixture.resultPath(phase), "overwrite", { flag: "wx" }), {
				code: "EEXIST",
			})
		}
		assert.equal(await fs.readFile(path.join(profile.workspace, "unrelated.txt"), "utf8"), "preserve this")
	} finally {
		await cleanupTestProfile(profile, true)
	}
})

test("settlement fixtures reject pre-existing workspace content instead of adopting it", async () => {
	for (const file of [".alphaignore", "index.html"]) {
		const profile = await createOwnedProfile()
		try {
			await fs.writeFile(path.join(profile.workspace, file), "original content", { flag: "wx" })
			const fixture = new CommandSettlementFixture(profile.workspace, profile.artifactsDir)
			await assert.rejects(
				fixture.prepareCase(),
				file === ".alphaignore" ? { code: "EEXIST" } : /Settlement file already exists/,
			)
			assert.equal(await fs.readFile(path.join(profile.workspace, file), "utf8"), "original content")
			await assert.rejects(fixture.finishCase(), /No settlement case owns this workspace/)
		} finally {
			await cleanupTestProfile(profile, true)
		}
	}
})

test("settlement reuse waits for release and fails closed on altered host files or non-file workload paths", async () => {
	const profile = await createOwnedProfile()
	const fixture = new CommandSettlementFixture(profile.workspace, profile.artifactsDir)
	try {
		await fixture.prepareCase()
		await assert.rejects(fixture.prepareCase(), /previous settlement task must be disposed/)
		await fs.writeFile(path.join(profile.workspace, ".alphaignore"), "altered")
		await assert.rejects(fixture.finishCase(), /Host fixture was changed/)
		await fs.writeFile(path.join(profile.workspace, ".alphaignore"), ".alpha-*\n")
		await fixture.finishCase()
		await fs.mkdir(path.join(profile.workspace, "app.js"))
		await assert.rejects(fixture.prepareCase(), /Refusing to remove a non-file settlement fixture/)
		assert.equal((await fs.stat(path.join(profile.workspace, "app.js"))).isDirectory(), true)
	} finally {
		await cleanupTestProfile(profile, true)
	}
})
