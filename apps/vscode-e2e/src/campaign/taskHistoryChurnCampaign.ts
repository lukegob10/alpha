import * as assert from "node:assert/strict"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { runSharedStorageCampaign, type SharedStorageCampaignReport } from "./sharedStorageCampaign"
import type { CampaignHost } from "./types"
import { rejectSymlinkComponents } from "../evidence/paths"

const verifiedPhase = (phase: SharedStorageCampaignReport) =>
	phase.status === "passed" &&
	phase.execution === "extension-host" &&
	phase.hostVersion === "1.122.1" &&
	phase.cleanupVerified === true &&
	phase.leaseReleased === true &&
	phase.captureComplete === true &&
	phase.taskHistoryChurn?.length === 2

/** Assemble retained, already verified phase receipts without rerunning either host family. */
export function assembleTaskHistoryChurnReport(phases: SharedStorageCampaignReport[]) {
	const complete =
		phases.length === 2 &&
		phases.every(verifiedPhase) &&
		phases[0]!.runId !== phases[1]!.runId &&
		!!phases[0]!.profileRoot &&
		phases[0]!.profileRoot === phases[1]!.profileRoot &&
		phases.every((phase, index) =>
			phase.taskHistoryChurn!.every((receipt) => receipt.phase === (index === 0 ? "populate" : "reload")),
		)
	return {
		schemaVersion: 1,
		execution:
			phases.length > 0 && phases.every((phase) => phase.execution === "extension-host")
				? "extension-host"
				: "test-seam",
		status: complete ? "passed" : "failed",
		liveRequests: 0,
		cleanupVerified: phases.length > 0 && phases.every((phase) => phase.cleanupVerified === true),
		phases,
	}
}

/** Aggregate reports exceed the small barrier receipt limit; keep their own explicit bound and no-overwrite rule. */
export async function writeTaskHistoryChurnReport(directory: string, phases: SharedStorageCampaignReport[]) {
	const report = assembleTaskHistoryChurnReport(phases)
	const serialized = JSON.stringify(report)
	assert.ok(Buffer.byteLength(serialized) <= 128 * 1_024, "churn_report_too_large")
	await rejectSymlinkComponents(directory)
	await fs.writeFile(path.join(directory, "task-history-churn-report.json"), serialized, { flag: "wx", mode: 0o600 })
	return report
}

/** Reopen the same owned profile only after both writers and their process family have stopped. */
export async function runTaskHistoryChurnCampaign(options: {
	fixtureRoot: string
	host: CampaignHost
	signal?: AbortSignal
}) {
	assert.equal(options.host.version, "1.122.1")
	const phases: SharedStorageCampaignReport[] = []
	for (const phase of ["populate", "reload"] as const) {
		const previous = phases[0]
		const report = await runSharedStorageCampaign({
			...options,
			taskHistoryChurn:
				phase === "populate"
					? { phase }
					: {
							phase,
							priorReceipts: {
								a: path.join(previous!.artifactDirectory!, "task-history-churn-a.json"),
								b: path.join(previous!.artifactDirectory!, "task-history-churn-b.json"),
							},
						},
			...(previous ? { reuseProfileRoot: previous.profileRoot } : {}),
		})
		phases.push(report)
		if (
			report.status !== "passed" ||
			report.execution !== "extension-host" ||
			!report.cleanupVerified ||
			!report.leaseReleased ||
			!report.captureComplete ||
			report.taskHistoryChurn?.length !== 2
		)
			break
	}
	return writeTaskHistoryChurnReport(options.fixtureRoot, phases)
}
