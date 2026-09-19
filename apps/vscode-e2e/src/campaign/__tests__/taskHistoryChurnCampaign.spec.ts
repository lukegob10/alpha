import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { assembleTaskHistoryChurnReport, writeTaskHistoryChurnReport } from "../taskHistoryChurnCampaign"
import type { SharedStorageCampaignReport } from "../sharedStorageCampaign"

function phases(): SharedStorageCampaignReport[] {
	return ["populate", "reload"].map(
		(phase, index) =>
			({
				runId: `run-${index}`,
				profileRoot: "same-owned-profile",
				status: "passed",
				execution: "extension-host",
				hostVersion: "1.122.1",
				cleanupVerified: true,
				leaseReleased: true,
				captureComplete: true,
				taskHistoryChurn: [{ phase }, { phase }],
				artifactDirectory: "x".repeat(10_000),
			}) as SharedStorageCampaignReport,
	)
}

test("aggregate writes full phase reports above16KiB without overwriting retained results", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "churn-report-"))
	try {
		const report = await writeTaskHistoryChurnReport(directory, phases())
		assert.equal(report.status, "passed")
		const bytes = await fs.readFile(path.join(directory, "task-history-churn-report.json"))
		assert.ok(bytes.length > 16 * 1024)
		await assert.rejects(writeTaskHistoryChurnReport(directory, phases()), { code: "EEXIST" })
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
})

test("oversize aggregate fails before writing and incomplete verification cannot pass", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "churn-report-"))
	try {
		const oversized = phases()
		oversized[0]!.artifactDirectory = "x".repeat(128 * 1024)
		await assert.rejects(writeTaskHistoryChurnReport(directory, oversized), /churn_report_too_large/)
		assert.deepEqual(await fs.readdir(directory), [])
		for (const field of ["captureComplete", "cleanupVerified", "leaseReleased"] as const) {
			const invalid = phases()
			invalid[1]![field] = false
			assert.equal(assembleTaskHistoryChurnReport(invalid).status, "failed")
		}
		const seam = phases()
		seam[1]!.execution = "test-seam"
		assert.equal(assembleTaskHistoryChurnReport(seam).status, "failed")
		const missing = phases()
		missing[1]!.taskHistoryChurn = []
		assert.equal(assembleTaskHistoryChurnReport(missing).status, "failed")
		assert.equal(assembleTaskHistoryChurnReport(phases().reverse()).status, "failed")
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
})
