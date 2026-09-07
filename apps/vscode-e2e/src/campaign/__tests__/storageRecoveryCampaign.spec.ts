import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { runStorageRecoveryCampaign } from "../storageRecoveryCampaign"
import { prepareEvidenceRun } from "../../evidence/paths"
import { assertStorageRestartQuiescence, STORAGE_RESTART_RECEIPT } from "../../evidence/storageRestart"
import { quarantineOfflineAgentControlLock, AGENT_CONTROL_TRANSACTION_LOCK } from "../../evidence/storageRecovery"
import type { ExtensionTestRunResult } from "../../runTest"

test("dedicated restart sequence requires evidence and quiescence before quarantine and healthy launch", async (context) => {
	for (const condition of ["complete", "incomplete", "late-unsafe-storage"]) {
		const complete = condition !== "incomplete"
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-restart-campaign-"))
		context.after(() => fs.rm(root, { recursive: true, force: true }))
		const events: string[] = []
		const manifest = JSON.parse(
			await fs.readFile(path.resolve(__dirname, "../../../../../src/package.json"), "utf8"),
		)
		const report = await runStorageRecoveryCampaign(
			{ fixtureRoot: root, host: { version: "1.122.1", executable: process.execPath } },
			{
				assertQuiescence: async (proof, receipt) => {
					events.push(`gate:${receipt.phase}`)
					return assertStorageRestartQuiescence(proof, receipt, () => false)
				},
				quarantine: async (options) => {
					events.push("quarantine")
					const checkpoints = (await fs.readdir(root))
						.filter((entry) => /^storage-restart-\d+\.json$/.test(entry))
						.sort()
					const previousReport = JSON.parse(await fs.readFile(path.join(root, checkpoints.at(-1)!), "utf8"))
					assert.equal(previousReport.phases[0].phase, "fault")
					return quarantineOfflineAgentControlLock({ ...options, isProcessLive: () => false })
				},
				runTests: async (options, dependencies) => {
					const phase = options.extensionTestsEnv!.ALPHA_E2E_STORAGE_RESTART_PHASE
					events.push(`launch:${phase}`)
					assert.equal(options.providerMode, "scripted")
					assert.equal(options.retainEvidenceForCampaign, true)
					assert.equal(options.requestLimit, 1)
					const userDataDir = path.join(options.profileDir!, options.vscodeVersion, "user-data")
					const storagePath = await fs.realpath(
						path.join(
							userDataDir,
							"User",
							"globalStorage",
							`${manifest.publisher}.${manifest.name}`.toLowerCase(),
						),
					)
					const lockPath = path.join(storagePath, AGENT_CONTROL_TRANSACTION_LOCK)
					if (phase === "fault") {
						assert.equal((await fs.readFile(path.join(lockPath, "owner.json"))).length, 0)
						await fs.writeFile(path.join(storagePath, "agent_control.json"), '{"test":"sentinel"}')
						await fs.mkdir(path.join(storagePath, "tasks", "task-fault"), { recursive: true })
						await fs.writeFile(
							path.join(storagePath, "tasks", "task-fault", "api_conversation_history.json"),
							"[]",
						)
					} else {
						await assert.rejects(fs.stat(lockPath), { code: "ENOENT" })
						assert.ok((await fs.stat(`${lockPath}.offline-quarantine`)).isDirectory())
					}
					const evidence = await prepareEvidenceRun({
						artifactsRoot: options.artifactsDir!,
						runId: options.runId!,
					})
					const receipt = {
						schemaVersion: 1,
						scenarioId: "storage-restart",
						phase,
						runId: options.runId,
						hostVersion: options.vscodeVersion,
						extensionHostPid: 222222,
						storagePath,
						taskId: `task-${phase}`,
						providerRequests: phase === "fault" ? 0 : 1,
						terminalCount: 1,
						status: phase === "fault" ? "failed" : "completed",
						code: phase === "fault" ? "ELOCKOWNER" : "OK",
					}
					await fs.writeFile(
						path.join(evidence.artifactDirectory, STORAGE_RESTART_RECEIPT),
						JSON.stringify(receipt),
					)
					await fs.writeFile(
						evidence.manifestPath,
						JSON.stringify({
							kind: "alpha-vscode-e2e-run-evidence",
							version: 1,
							runId: options.runId,
							finalized: true,
							captureComplete: complete,
							bundleSha256: "a".repeat(64),
							metadata: {
								hostVersion: options.vscodeVersion,
								scenarioId: "storage-restart",
								provider: "scripted",
								taskIds: [receipt.taskId],
							},
						}),
					)
					const result: ExtensionTestRunResult = {
						runId: options.runId!,
						retentionResultPath: path.join(evidence.artifactDirectory, "retention-result.json"),
						exitCode: 0,
						providerMode: "scripted",
						vscodeVersion: options.vscodeVersion,
						workspace: options.workspace!,
						userDataDir,
						extensionsDir: "unused",
						artifactsDir: evidence.artifactDirectory,
						profileDir: options.profileDir,
						retained: true,
						actualVSCodeVersion: options.vscodeVersion,
						evidenceManifestPath: evidence.manifestPath,
						captureComplete: complete,
						status: "passed",
						execution: "extension-host",
						hostExitObserved: true,
						ownershipGate: "verified",
						launchedHostPid: 111111,
						extensionHostPid: 222222,
						extensionHostParentPid: 333333,
					}
					await dependencies?.afterRun?.(result)
					await fs.writeFile(
						result.retentionResultPath!,
						JSON.stringify({
							schemaVersion: 1,
							runId: result.runId,
							status: "complete",
							eligibility: "held",
							result: { complete: true, overBudget: false },
						}),
					)
					if (condition === "late-unsafe-storage" && phase === "healthy") {
						await fs.symlink(options.workspace!, path.join(root, "late-junction"), "junction")
					}
					return result
				},
			},
		)
		assert.equal(report.status, condition === "complete" ? "passed" : "blocked")
		if (condition === "late-unsafe-storage") assert.equal(report.stopReason, "scan_incomplete")
		assert.deepEqual(
			events,
			complete
				? ["launch:fault", "gate:fault", "quarantine", "launch:healthy", "gate:healthy"]
				: ["launch:fault", "gate:fault"],
		)
		if (!complete) assert.equal(report.quarantine, undefined)
		else {
			assert.equal(report.storagePreservation?.unchanged, true)
			assert.equal(report.storagePreservation?.before.taskFiles.length, 1)
		}
	}
})
