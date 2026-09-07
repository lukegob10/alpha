import * as path from "node:path"
import { readBounded } from "../evidence/paths"
import type { RunRetentionReport } from "../runEvidence"

/** A successful host receipt alone does not prove its post-run retention completed. */
export async function requireHeldRetentionReceipt(
	artifactsDir: string,
	runId: string,
	recordedPath: unknown,
): Promise<void> {
	const expected = path.join(artifactsDir, "retention-result.json")
	if (recordedPath !== expected) throw new Error("Missing campaign retention receipt")
	const receipt = JSON.parse(
		(await readBounded(expected, 1_048_576)).toString("utf8"),
	) as Partial<RunRetentionReport> | null
	if (
		!receipt ||
		receipt.schemaVersion !== 1 ||
		receipt.runId !== runId ||
		receipt.status !== "complete" ||
		receipt.eligibility !== "held" ||
		receipt.failure !== undefined ||
		(receipt.maintenance === "campaign-owned"
			? receipt.result !== undefined
			: receipt.maintenance !== undefined ||
				receipt.result?.complete !== true ||
				receipt.result.overBudget !== false)
	)
		throw new Error("Campaign retention incomplete")
}
