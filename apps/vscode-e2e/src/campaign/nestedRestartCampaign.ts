import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { runExtensionTests, type ExtensionTestRunResult } from "../runTest"
import { initializeRecoveryFixture } from "../evidence/storageRecovery"
import { readBounded } from "../evidence/paths"
import { requireHeldRetentionReceipt } from "./retentionReceipt"
import type { CampaignHost } from "./types"

/** Expected abrupt termination remains a failed host run; this separate experiment evaluates recovery. */
export async function runNestedRestartCampaign(options: {
	fixtureRoot: string
	host: CampaignHost
	signal?: AbortSignal
}) {
	assert.equal(options.host.version, "1.122.1")
	assert.ok(options.host.executable && path.isAbsolute(options.host.executable))
	const fixture = await initializeRecoveryFixture(options.fixtureRoot)
	const runs: ExtensionTestRunResult[] = []
	const report: { status: "running" | "passed" | "failed"; liveRequests: 0; phases: unknown[]; failure?: string } = {
		status: "running",
		liveRequests: 0,
		phases: [],
	}
	try {
		for (const phase of ["prepare", "recover"] as const) {
			const timeout = AbortSignal.timeout(150_000)
			const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
			const result = await runExtensionTests({
				initializeProfile: phase === "prepare",
				providerMode: "scripted",
				vscodeVersion: options.host.version,
				vscodeExecutablePath: options.host.executable,
				workspace: path.join(fixture.fixtureRoot, "workspace"),
				profileDir: path.join(fixture.fixtureRoot, "profile"),
				artifactsDir: path.join(fixture.fixtureRoot, "evidence"),
				runId: `nested-restart-${phase}`,
				testFile: "nested-restart.test",
				retainEvidenceForCampaign: true,
				signal,
				extensionTestsEnv: {
					ALPHA_E2E_NESTED_PHASE: phase,
					...(phase === "recover"
						? { ALPHA_E2E_NESTED_PRIOR: path.join(runs[0]!.artifactsDir, "nested-restart.json") }
						: {}),
				},
			})
			runs.push(result)
			assert.equal(signal.aborted, false, "The bounded host run did not finish before its deadline")
			assert.equal(result.execution, "extension-host")
			assert.equal(result.actualVSCodeVersion, "1.122.1")
			assert.equal(result.ownershipGate, "verified")
			assert.equal(result.hostExitObserved, true)
			for (const pid of new Set([
				result.launchedHostPid,
				result.extensionHostPid,
				result.extensionHostParentPid,
			])) {
				assert.ok(Number.isSafeInteger(pid) && pid! > 0)
				let stopped = false
				try {
					process.kill(pid!, 0)
				} catch (error) {
					stopped = (error as NodeJS.ErrnoException).code === "ESRCH"
				}
				assert.equal(stopped, true, "Every verified host PID must be gone before profile reuse")
			}
			assert.equal(result.captureComplete, true)
			await requireHeldRetentionReceipt(result.artifactsDir, result.runId, result.retentionResultPath)
			const receipt: unknown = JSON.parse(
				(await readBounded(path.join(result.artifactsDir, "nested-restart.json"), 2 * 1024 * 1024)).toString(
					"utf8",
				),
			)
			assert.ok(receipt && typeof receipt === "object" && "pid" in receipt && "phase" in receipt)
			assert.equal(receipt.pid, result.extensionHostPid)
			assert.equal(receipt.phase, phase)
			if (phase === "prepare") {
				assert.notEqual(result.exitCode, 0, "Abrupt termination must not be relabeled as a passing test")
				assert.ok("capacityDenied" in receipt && receipt.capacityDenied === true)
			} else {
				assert.equal(result.status, "passed")
				assert.equal(result.exitCode, 0)
				for (const key of [
					"identityPreserved",
					"capacityReused",
					"partialWorkerRecovered",
					"emptyWorkerRecovered",
					"nestedDiscarded",
				])
					assert.equal(Reflect.get(receipt, key), true)
			}
			report.phases.push({ result, receipt })
		}
		report.status = "passed"
	} catch (error) {
		report.status = "failed"
		report.failure = error instanceof assert.AssertionError ? "acceptance_assertion" : "host_or_evidence_failure"
		// Full run receipts remain private beneath the owned fixture, including failed attempts.
	} finally {
		fixture.controller.dispose()
		await fs.writeFile(
			path.join(fixture.fixtureRoot, "nested-restart-report.json"),
			JSON.stringify({ ...report, runs }, null, 2),
			{ flag: "wx" },
		)
	}
	return { ...report, runs }
}
