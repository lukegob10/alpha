import { strict as assert } from "node:assert"
import { test } from "node:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { requireHeldRetentionReceipt } from "../retentionReceipt"

test("held receipts explicitly transfer maintenance to the campaign and reject incomplete or contradictory claims", async (context) => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-held-receipt-")))
	context.after(async () => {
		assert.equal(await fs.realpath(root), root)
		assert.match(path.basename(root), /^alpha-held-receipt-/)
		await fs.rm(root, { recursive: true, force: true })
	})
	const file = path.join(root, "retention-result.json")
	const receipt = {
		schemaVersion: 1,
		runId: "held-run",
		status: "complete",
		eligibility: "held",
		maintenance: "campaign-owned",
	}
	await fs.writeFile(file, JSON.stringify(receipt))
	await requireHeldRetentionReceipt(root, "held-run", file)
	for (const mutation of [
		{ maintenance: undefined },
		{ maintenance: "unknown" },
		{ status: "blocked" },
		{ eligibility: "pending-release" },
		{ runId: "other" },
		{ failure: "evidence-retention-failed" },
		{ result: { complete: false, overBudget: true } },
	]) {
		await fs.writeFile(file, JSON.stringify({ ...receipt, ...mutation }))
		await assert.rejects(requireHeldRetentionReceipt(root, "held-run", file))
	}
	await fs.writeFile(
		file,
		JSON.stringify({ ...receipt, maintenance: undefined, result: { complete: true, overBudget: false } }),
	)
	await requireHeldRetentionReceipt(root, "held-run", file)
})
