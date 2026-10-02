import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { rejectSymlinkComponents } from "./evidence/paths"
import type { ExtensionTestRunOptions, ExtensionTestRunResult } from "./runTest"

/** Publish only observed final state; callers cannot turn requested settings into host evidence. */
export async function writeHarnessReceipt(
	directory: string,
	options: ExtensionTestRunOptions,
	result: ExtensionTestRunResult,
	startedAt: string,
): Promise<void> {
	if (!path.isAbsolute(directory) || directory.includes("\0")) throw new Error("Invalid harness receipt directory")
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.runId)) throw new Error("Invalid harness receipt ID")
	await rejectSymlinkComponents(directory)
	await fs.mkdir(directory, { recursive: true })
	await rejectSymlinkComponents(directory)
	const receipt = {
		schemaVersion: 1,
		kind: "alpha-extension-test-run",
		runId: result.runId,
		startedAt,
		completedAt: new Date().toISOString(),
		testFile: options.testFile ?? (options.scenarioId ? "workflow.test" : null),
		scenarioId: options.scenarioId ?? null,
		scenarioPhase: options.scenarioPhase ?? null,
		requestedHostVersion: options.vscodeVersion,
		actualHostVersion: result.actualVSCodeVersion ?? null,
		providerMode: result.providerMode,
		actualModelId: result.actualModelId ?? null,
		actualReasoningEffort: result.actualReasoningEffort ?? null,
		profile: {
			kind: result.profileDir ? "persistent" : "disposable",
			sha256: createHash("sha256").update(result.userDataDir).digest("hex"),
		},
		status: result.status,
		exitCode: result.exitCode,
		execution: result.execution,
		hostExitObserved: result.hostExitObserved,
		ownershipGate: result.ownershipGate ?? null,
		requireAllTests: result.requireAllTests === true,
		testCounts: result.testCounts ?? null,
		captureComplete: result.captureComplete === true,
		retentionStatus: result.retention?.status ?? null,
		failure: result.failure ?? null,
	}
	await fs.writeFile(path.join(directory, `${result.runId}.json`), JSON.stringify(receipt, null, 2) + "\n", {
		flag: "wx",
		mode: 0o600,
	})
}
