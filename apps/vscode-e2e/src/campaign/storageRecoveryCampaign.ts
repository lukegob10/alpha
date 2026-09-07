import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createHash } from "node:crypto"

import { runExtensionTests } from "../runTest"
import { prepareTestProfile } from "../testProfile"
import { readBounded, rejectSymlinkComponents } from "../evidence/paths"
import { auditRetainedStorage, type RetainedStorageBudgetResult } from "../evidence/retainedStorageBudget"
import {
	AGENT_CONTROL_TRANSACTION_LOCK,
	initializeRecoveryFixture,
	quarantineOfflineAgentControlLock,
} from "../evidence/storageRecovery"
import {
	assertStorageRestartQuiescence,
	readStorageRestartPhaseReceipt,
	type StorageRestartPhaseReceipt,
} from "../evidence/storageRestart"
import { HOST_VERSIONS, type CampaignHost } from "./types"
import { requireHeldRetentionReceipt } from "./retentionReceipt"

export interface StorageRecoveryCampaignReport {
	schemaVersion: 1
	hostVersion: CampaignHost["version"]
	status: "running" | "passed" | "blocked"
	stopReason?:
		| "cancelled"
		| "host_or_evidence_unverified"
		| "recovery_unverified"
		| "storage_budget"
		| "scan_incomplete"
		| "retention_failed"
	storageAdmission?: RetainedStorageBudgetResult
	phases: StorageRestartPhaseReceipt[]
	evidence: string[]
	quarantine?: string
	storagePreservation?: { before: StorageSnapshot; after?: StorageSnapshot; unchanged?: true }
}

type StorageSnapshot = { controlSha256: string | null; taskFiles: { path: string; sha256: string }[] }

async function snapshotStorage(storagePath: string): Promise<StorageSnapshot> {
	let remaining = 16 * 1_048_576
	const hashFile = async (file: string) => {
		const bytes = await readBounded(file, Math.min(2 * 1_048_576, remaining))
		remaining -= bytes.length
		return createHash("sha256").update(bytes).digest("hex")
	}
	const snapshot: StorageSnapshot = { controlSha256: null, taskFiles: [] }
	try {
		snapshot.controlSha256 = await hashFile(path.join(storagePath, "agent_control.json"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	let directories = 0
	const visit = async (directory: string, depth: number) => {
		if (depth > 6 || ++directories > 256) throw new Error("Storage preservation snapshot limit")
		await rejectSymlinkComponents(directory)
		let entries
		try {
			entries = await fs.readdir(directory, { withFileTypes: true })
		} catch (error) {
			if (depth === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return
			throw error
		}
		if (entries.length > 256) throw new Error("Storage preservation snapshot limit")
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const file = path.join(directory, entry.name)
			if (entry.isDirectory()) await visit(file, depth + 1)
			else if (entry.isFile() && snapshot.taskFiles.length < 256) {
				snapshot.taskFiles.push({ path: path.relative(storagePath, file), sha256: await hashFile(file) })
			} else throw new Error("Unsafe or oversized storage preservation snapshot")
		}
	}
	await visit(path.join(storagePath, "tasks"), 0)
	return snapshot
}

/** A separate two-launch, shell-free fixture. Never invoke this against an existing user profile. */
export async function runStorageRecoveryCampaign(
	options: { fixtureRoot: string; host: CampaignHost; signal?: AbortSignal },
	dependencies: {
		runTests?: typeof runExtensionTests
		assertQuiescence?: typeof assertStorageRestartQuiescence
		quarantine?: typeof quarantineOfflineAgentControlLock
	} = {},
): Promise<StorageRecoveryCampaignReport> {
	if (!HOST_VERSIONS.includes(options.host.version)) throw new Error("Unsupported storage-restart host")
	if (!options.host.executable || !path.isAbsolute(options.host.executable))
		throw new Error("Storage-restart requires an explicit installed VS Code executable")
	if (options.signal?.aborted) throw new Error("Storage-restart campaign cancelled")
	// Recovery fixture initialization itself refuses existing/nonempty or orphaned roots.
	const fixture = await initializeRecoveryFixture(options.fixtureRoot)
	const report: StorageRecoveryCampaignReport = {
		schemaVersion: 1,
		hostVersion: options.host.version,
		status: "running",
		phases: [],
		evidence: [],
	}
	let checkpointNumber = 0
	const checkpoint = async () => {
		const file = path.join(
			fixture.fixtureRoot,
			`storage-restart-${String(++checkpointNumber).padStart(4, "0")}.json`,
		)
		const handle = await fs.open(file, "wx", 0o600)
		try {
			await handle.writeFile(JSON.stringify(report, null, 2) + "\n")
			await handle.sync()
		} finally {
			await handle.close()
		}
	}
	const runTests = dependencies.runTests ?? runExtensionTests
	const assertQuiescence = dependencies.assertQuiescence ?? assertStorageRestartQuiescence
	const quarantine = dependencies.quarantine ?? quarantineOfflineAgentControlLock
	const auditStorage = async () => {
		report.storageAdmission = await auditRetainedStorage({
			roots: [{ path: fixture.fixtureRoot, label: "storage-restart" }],
			signal: options.signal,
			assertOwned: async (candidate) => {
				if (
					candidate !== fixture.fixtureRoot ||
					(await initializeRecoveryFixture(candidate)).controller !== fixture.controller
				)
					throw new Error("Unknown recovery fixture owner")
			},
		})
		if (options.signal?.aborted) report.stopReason = "cancelled"
		else if (report.storageAdmission.status !== "within_budget") {
			report.stopReason = report.storageAdmission.status === "over_budget" ? "storage_budget" : "scan_incomplete"
		}
		await checkpoint()
	}
	try {
		await checkpoint()
		const profileDir = path.join(fixture.fixtureRoot, "profile")
		const workspace = path.join(fixture.fixtureRoot, "workspace")
		const artifactsDir = path.join(fixture.fixtureRoot, "evidence")
		const profile = await prepareTestProfile({
			profileDir,
			workspace,
			artifactsDir,
			vscodeVersion: options.host.version,
			initializeProfile: true,
		})
		const manifestPath = path.resolve(__dirname, "../../../../src/package.json")
		const manifest = JSON.parse((await readBounded(manifestPath, 1_048_576)).toString("utf8")) as Record<
			string,
			unknown
		>
		if (
			typeof manifest.publisher !== "string" ||
			typeof manifest.name !== "string" ||
			!manifest.publisher.match(/^[A-Za-z0-9_-]+$/) ||
			!manifest.name.match(/^[A-Za-z0-9_-]+$/)
		) {
			throw new Error("Invalid extension identity")
		}
		const storagePath = path.join(
			profile.userDataDir,
			"User",
			"globalStorage",
			`${manifest.publisher}.${manifest.name}`.toLowerCase(),
		)
		await rejectSymlinkComponents(storagePath)
		await fs.mkdir(storagePath, { recursive: true })
		const lockPath = path.join(storagePath, AGENT_CONTROL_TRANSACTION_LOCK)
		await fs.mkdir(lockPath)
		await fs.writeFile(path.join(lockPath, "owner.json"), "", { flag: "wx", mode: 0o600 })
		for (const phase of ["fault", "healthy"] as const) {
			if (options.signal?.aborted) {
				report.stopReason = "cancelled"
				break
			}
			await auditStorage()
			if (report.stopReason) break
			const runId = `storage-restart-${phase}`
			let phaseVerified = false
			const result = await runTests(
				{
					signal: options.signal,
					retainEvidenceForCampaign: true,
					providerMode: "scripted",
					vscodeVersion: options.host.version,
					vscodeExecutablePath: options.host.executable,
					profileDir,
					workspace,
					artifactsDir,
					runId,
					scenarioId: "storage-restart",
					testFile: "storage-restart.test",
					requestLimit: 1,
					extensionTestsEnv: { ALPHA_E2E_STORAGE_RESTART_PHASE: phase },
				},
				{
					// Existing runner invokes this after capture/Code close, before releasing the profile lease.
					afterRun: async (runResult) => {
						const receipt = await readStorageRestartPhaseReceipt(runResult.artifactsDir, {
							runId,
							hostVersion: options.host.version,
							phase,
							storagePath,
						})
						const hosts = await assertQuiescence(runResult, receipt)
						report.phases.push(receipt)
						report.evidence.push(path.relative(fixture.fixtureRoot, runResult.evidenceManifestPath!))
						await checkpoint()
						if (options.signal?.aborted) {
							report.stopReason = "cancelled"
							return
						}
						if (phase === "fault") {
							const before = await snapshotStorage(storagePath)
							report.storagePreservation = { before }
							await checkpoint()
							if (options.signal?.aborted) {
								report.stopReason = "cancelled"
								return
							}
							// Register only verified actual writer ancestry; arbitrary process scans are forbidden.
							for (const host of hosts) fixture.controller.openHost(host.pid).close()
							const seal = fixture.controller.sealForOfflineRecovery()
							const outcome = await quarantine({
								fixtureRoot: fixture.fixtureRoot,
								storagePath,
								hosts,
								fixtureController: fixture.controller,
								registrySeal: seal,
							})
							if (outcome.outcome !== "quarantined") {
								report.stopReason = "recovery_unverified"
								return
							}
							report.quarantine = path.relative(fixture.fixtureRoot, outcome.quarantinePath)
							const after = await snapshotStorage(storagePath)
							if (JSON.stringify(before) !== JSON.stringify(after)) {
								report.stopReason = "recovery_unverified"
								return
							}
							report.storagePreservation = { before, after, unchanged: true }
							await checkpoint()
							fixture.controller.resumeAfterOfflineRecovery(seal)
						}
						phaseVerified = true
					},
				},
			)
			try {
				await requireHeldRetentionReceipt(result.artifactsDir, runId, result.retentionResultPath)
			} catch {
				report.stopReason ??= "retention_failed"
			}
			if (result.status !== "passed" || result.exitCode !== 0 || !phaseVerified || report.stopReason) {
				report.stopReason ??= "host_or_evidence_unverified"
				break
			}
		}
		// Held host receipts delegate maintenance to this controller, including the final launch's growth.
		if (!report.stopReason) await auditStorage()
		report.status = report.phases.length === 2 && report.quarantine && !report.stopReason ? "passed" : "blocked"
	} catch {
		report.status = "blocked"
		report.stopReason ??= options.signal?.aborted ? "cancelled" : "host_or_evidence_unverified"
	} finally {
		fixture.controller.dispose()
	}
	await checkpoint()
	return report
}
