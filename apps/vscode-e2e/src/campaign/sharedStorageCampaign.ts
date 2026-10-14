import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"

import { runOwnedProcess, type OwnedProcessResult } from "./ownedProcess"
import { runSharedWorkerMailboxController } from "./sharedWorkerMailboxController"
import { validateSharedWorkerControl, type SharedWorkerMailboxReport } from "../evidence/sharedWorkerMailbox"
import { openCampaignRoot } from "./reportStore"
import { HOST_VERSIONS, type CampaignHost } from "./types"
import { acquireProfileLease, assertRunnerAncestry } from "../hostOwnership"
import { assertOwnedTestRoot, prepareTestProfile } from "../testProfile"
import { captureRunEvidence } from "../evidence/capture"
import { auditRetainedStorage, type RetainedStorageBudgetResult } from "../evidence/retainedStorageBudget"
import { isWithin, prepareEvidenceRun, readBounded, rejectSymlinkComponents } from "../evidence/paths"
import {
	assertTaskHistoryChurnPair,
	parseTaskHistoryChurnReceipt,
	type TaskHistoryChurnReceipt,
} from "../evidence/taskHistoryChurn"
import {
	failureCode,
	mailboxEventId,
	validateMailboxClaims,
	validateMailboxVerification,
	ROLES,
	publish,
	readOptional,
	record,
	requireNonce,
	validateIdentities,
	validateIdentity,
	validateTaskIdentity,
	validateDone,
	waitUntil,
	type PairManifest,
	type HostIdentity,
	type HostDone,
} from "../evidence/sharedStorageProtocol"

const RUNTIME_BUDGET_MS = 180_000
export interface SharedStorageCampaignOptions {
	fixtureRoot: string
	host: CampaignHost
	signal?: AbortSignal
	taskHistoryChurn?: PairManifest["taskHistoryChurn"]
	sharedWorkerMailbox?: boolean
	/** Only reuse an owned profile beneath this campaign root, after its preceding family has exited. */
	reuseProfileRoot?: string
}
export interface SharedStorageCampaignReport {
	schemaVersion: 1
	execution: "extension-host" | "test-seam"
	runId: string
	hostVersion: CampaignHost["version"]
	status: "passed" | "failed" | "blocked" | "cancelled" | "timed_out"
	stopReason?: string
	failure?: { stage: string; code: string }
	storageAdmission: RetainedStorageBudgetResult | null
	cleanupVerified: boolean
	leaseReleased: boolean
	mailboxClaimsVerified?: boolean
	identitiesVerified: boolean
	readyHostCount: number
	doneHostCount: number
	taskIds: string[]
	requests: number | null
	bundleHashBefore: string | null
	bundleHashAfter: string | null
	artifactDirectory?: string
	captureComplete: boolean
	retention: "held"
	reportPath: string
	profileRoot?: string
	taskHistoryChurn?: TaskHistoryChurnReceipt[]
	sharedWorkerMailbox?: SharedWorkerMailboxReport
	sharedWorkerMailboxVerified?: boolean
}
interface SharedStorageDependencies {
	runProcess?: typeof runOwnedProcess
	assertAncestry?: typeof assertRunnerAncestry
	capture?: typeof captureRunEvidence
	auditStorage?: typeof auditRetainedStorage
	monotonicNow?: () => number
	extensionPath?: string
	hostEntry?: string
}
const bundleHash = async (bundlePath: string) =>
	createHash("sha256")
		.update(await readBounded(bundlePath, 512 * 1_024 * 1_024))
		.digest("hex")

/** Two real EHs in one owned Code family, sharing its actual profile storage. No live provider or UI driving. */
export async function runSharedStorageCampaign(
	options: SharedStorageCampaignOptions,
	dependencies: SharedStorageDependencies = {},
): Promise<SharedStorageCampaignReport> {
	assert.ok(HOST_VERSIONS.includes(options.host.version), "unsupported_host")
	assert.ok(options.sharedWorkerMailbox === undefined || typeof options.sharedWorkerMailbox === "boolean")
	const executable = options.host.executable
	assert.ok(executable && path.isAbsolute(executable) && !executable.includes("\0"), "explicit_host_required")
	const extensionPath = dependencies.extensionPath ?? path.resolve(__dirname, "../../../../src")
	const hostEntry = dependencies.hostEntry ?? path.resolve(__dirname, "../suite/shared-storage.entry.js")
	for (const candidate of [executable, extensionPath, hostEntry]) {
		assert.ok(path.isAbsolute(candidate))
		await rejectSymlinkComponents(candidate)
		await fs.access(candidate)
	}
	const root = await openCampaignRoot(options.fixtureRoot, true)
	const runId = randomUUID()
	const reportName = `shared-storage-${runId}.json`
	const report: SharedStorageCampaignReport = {
		schemaVersion: 1,
		execution: Object.keys(dependencies).length ? "test-seam" : "extension-host",
		runId,
		hostVersion: options.host.version,
		status: "blocked",
		storageAdmission: null,
		cleanupVerified: false,
		leaseReleased: false,
		mailboxClaimsVerified: false,
		identitiesVerified: false,
		readyHostCount: 0,
		doneHostCount: 0,
		taskIds: [],
		requests: null,
		bundleHashBefore: null,
		bundleHashAfter: null,
		captureComplete: false,
		retention: "held",
		reportPath: path.join(root, reportName),
	}
	const now = dependencies.monotonicNow ?? (() => performance.now())
	const runtimeBudgetMs = options.taskHistoryChurn
		? 600_000
		: options.sharedWorkerMailbox
			? 300_000
			: RUNTIME_BUDGET_MS
	const deadline = now() + runtimeBudgetMs
	let budgetExceeded = false
	const abort = new AbortController()
	const onAbort = () => abort.abort()
	options.signal?.addEventListener("abort", onAbort, { once: true })
	if (options.signal?.aborted) onAbort()
	const timer = setTimeout(() => {
		budgetExceeded = true
		onAbort()
	}, runtimeBudgetMs)
	const checkBudget = () => {
		if (options.signal?.aborted) throw new Error("runtime_closed")
		if (abort.signal.aborted || now() >= deadline) throw new Error("controller_timeout")
	}
	const startedAt = new Date().toISOString()
	const runRoot = path.join(root, `shared-storage-${runId}`)
	const profileRoot = options.reuseProfileRoot ?? path.join(runRoot, "profile")
	report.profileRoot = profileRoot
	const artifactsRoot = path.join(runRoot, "artifacts")
	const bundlePath = path.join(extensionPath, "dist", "extension.js")
	let releaseLease: (() => Promise<void>) | undefined
	let launchAttempted = false
	let ended = false
	let processResult: OwnedProcessResult | undefined
	let processPromise: Promise<void> | undefined
	let manifest: PairManifest | undefined
	let identities: HostIdentity[] = []
	let done: HostDone[] = []
	let stage = "setup"
	let profile: Awaited<ReturnType<typeof prepareTestProfile>> | undefined
	const fail = (code: string) => {
		report.failure ??= { stage, code }
	}
	try {
		checkBudget()
		if (options.reuseProfileRoot) {
			assert.ok(isWithin(root, profileRoot) && profileRoot !== root, "profile_outside_campaign")
			await rejectSymlinkComponents(profileRoot)
			await assertOwnedTestRoot(profileRoot, "profile")
		}
		report.bundleHashBefore = await bundleHash(bundlePath)
		const extension = record(
			JSON.parse((await readBounded(path.join(extensionPath, "package.json"), 1_048_576)).toString()),
		)
		assert.ok(typeof extension.publisher === "string" && typeof extension.name === "string")
		await fs.mkdir(runRoot, { mode: 0o700 })
		const roles = {} as PairManifest["roles"]
		for (const role of ROLES) {
			profile = await prepareTestProfile({
				profileDir: profileRoot,
				workspace: path.join(runRoot, `workspace-${role}`),
				artifactsDir: artifactsRoot,
				vscodeVersion: options.host.version,
				initializeProfile: true,
			})
			const workspaceFile = path.join(runRoot, `${role}.code-workspace`)
			await fs.writeFile(
				workspaceFile,
				JSON.stringify({ folders: [{ path: profile.workspace }], settings: {} }),
				{ flag: "wx" },
			)
			roles[role] = {
				workspace: await fs.realpath(profile.workspace),
				workspaceFile: await fs.realpath(workspaceFile),
			}
		}
		assert.ok(profile)
		report.artifactDirectory = (await prepareEvidenceRun({ artifactsRoot, runId })).artifactDirectory
		// Admission includes every prior run and retained profile, not merely this fresh UUID directory.
		stage = "storage_admission"
		report.storageAdmission = await (dependencies.auditStorage ?? auditRetainedStorage)({
			roots: [{ path: root, label: "shared-storage" }],
			signal: abort.signal,
			assertOwned: async (candidate) => assert.equal(await openCampaignRoot(candidate, false), root),
		})
		if (!report.storageAdmission.complete || report.storageAdmission.status !== "within_budget") {
			report.stopReason = report.storageAdmission.status === "over_budget" ? "storage_budget" : "scan_incomplete"
			throw new Error("storage_admission_failed")
		}
		checkBudget()
		manifest = {
			mailboxClaimRace: 1,
			...(options.sharedWorkerMailbox ? { sharedWorkerMailbox: 1 as const } : {}),
			...(options.taskHistoryChurn ? { taskHistoryChurn: options.taskHistoryChurn } : {}),
			runId,
			nonce: randomUUID(),
			hostVersion: options.host.version,
			controllerPid: process.pid,
			profileRoot: await fs.realpath(profileRoot),
			artifactsRoot: await fs.realpath(artifactsRoot),
			// Wall time is only a cross-process backstop; controller admission uses the monotonic deadline.
			deadline: Date.now() + Math.max(1, deadline - now()),
			roles,
		}
		await publish(report.artifactDirectory, "pair-manifest.json", manifest)
		releaseLease = await acquireProfileLease(profile.userDataDir)
		checkBudget()
		const env: NodeJS.ProcessEnv = {
			...process.env,
			ALPHA_PAIR_RUN_ID: runId,
			ALPHA_PAIR_NONCE: manifest.nonce,
			ALPHA_PAIR_ARTIFACTS: manifest.artifactsRoot,
			ALPHA_PAIR_EXTENSION_ID: `${extension.publisher}.${extension.name}`,
		}
		delete env.ELECTRON_RUN_AS_NODE
		delete env.VSCODE_PORTABLE
		delete env.VSCODE_IPC_HOOK_CLI
		stage = "ready"
		launchAttempted = true
		processPromise = (dependencies.runProcess ?? runOwnedProcess)(
			{
				executable,
				cwd: runRoot,
				env,
				args: [
					roles.a.workspaceFile,
					roles.b.workspaceFile,
					`--user-data-dir=${profile.userDataDir}`,
					`--extensions-dir=${profile.extensionsDir}`,
					`--extensionDevelopmentPath=${extensionPath}`,
					`--extensionTestsPath=${hostEntry}`,
					"--new-window",
					"--no-sandbox",
					"--disable-gpu-sandbox",
					"--disable-updates",
					"--skip-welcome",
					"--skip-release-notes",
					"--disable-workspace-trust",
					"--disable-telemetry",
					"--disable-extension=vscode.git",
					"--skip-add-to-recently-opened",
				],
			},
			{ signal: abort.signal, killGraceMs: 6_000, maxOutputBytes: 32_768 },
		)
			.then((result) => {
				processResult = result
			})
			.catch(() => {
				fail("process_failed")
			})
			.finally(() => {
				ended = true
			})
		const pair = manifest
		const directory = report.artifactDirectory
		const awaitPair = async (phase: string) => {
			let values: unknown[] = []
			await waitUntil(
				async () => {
					checkBudget()
					if (ended) throw new Error("runtime_closed")
					for (const role of ROLES) {
						const failure = await readOptional(directory, `failed-${role}.json`)
						if (failure !== undefined) {
							requireNonce(failure, pair)
							throw new Error("host_failed")
						}
					}
					values = await Promise.all(ROLES.map((role) => readOptional(directory, `${phase}-${role}.json`)))
					return values.every((value) => value !== undefined)
				},
				deadline,
				"controller_timeout",
				now,
			)
			return values
		}
		const verifyLive = async () => {
			for (const identity of identities) {
				checkBudget()
				await (dependencies.assertAncestry ?? assertRunnerAncestry)(process.pid, identity.pid)
				await rejectSymlinkComponents(identity.persistenceFile)
				assert.equal(await fs.realpath(identity.storagePath), identity.storagePath)
			}
			checkBudget()
		}
		identities = validateIdentities(await awaitPair("ready"), pair)
		await verifyLive()
		report.identitiesVerified = true
		await publish(directory, "start.json", { runId, nonce: pair.nonce })
		stage = "entered"
		assert.deepEqual(validateIdentities(await awaitPair("entered"), pair), identities)
		const started = (await awaitPair("task")).map((value, index) =>
			validateTaskIdentity(value, pair, ROLES[index]!),
		)
		assert.deepEqual(validateIdentities(started, pair), identities)
		assert.notEqual(started[0]!.taskId, started[1]!.taskId)
		report.taskIds = started.map((item) => item.taskId)
		await verifyLive()
		await publish(directory, "overlap.json", {
			runId,
			nonce: pair.nonce,
			taskIds: report.taskIds,
			pids: identities.map((item) => item.pid),
		})
		await publish(directory, "respond.json", { runId, nonce: pair.nonce })
		stage = "done"
		const receipts = await awaitPair("done")
		assert.deepEqual(validateIdentities(receipts, pair), identities)
		done = receipts.map((value, index) => validateDone(value, pair, ROLES[index]!, report.taskIds[index]!))
		report.requests = done.reduce((sum, item) => sum + item.requests, 0)
		await verifyLive()
		stage = "mailbox_claim_race"
		await publish(directory, "mailbox-start.json", { runId, nonce: pair.nonce })
		const mailboxReady = await awaitPair("mailbox-ready")
		assert.deepEqual(validateIdentities(mailboxReady, pair), identities)
		for (const value of mailboxReady) {
			const receipt = requireNonce(value, pair)
			assert.equal(receipt.mailboxClaimRace, 1)
			assert.equal(receipt.recipientTaskId, report.taskIds[0])
			assert.equal(receipt.eventId, mailboxEventId(pair))
		}
		await publish(directory, "mailbox-claim.json", { runId, nonce: pair.nonce })
		const claims = validateMailboxClaims(await awaitPair("mailbox-claimed"), pair, report.taskIds[0]!)
		assert.deepEqual(validateIdentities(claims, pair), identities)
		const winner = claims.find((claim) => claim.outcome === "claimed")!.role
		await publish(directory, "mailbox-ack.json", { runId, nonce: pair.nonce })
		const verified = (await awaitPair("mailbox-verified")).map((value, index) =>
			validateMailboxVerification(value, pair, ROLES[index]!, report.taskIds[0]!, winner),
		)
		assert.deepEqual(verified, identities)
		await verifyLive()
		if (pair.sharedWorkerMailbox) {
			stage = "shared_worker_mailbox"
			report.sharedWorkerMailboxVerified = false
			try {
				report.sharedWorkerMailbox = await runSharedWorkerMailboxController({
					manifest: pair,
					identities,
					directory,
					awaitPair,
					verifyLive,
				})
				report.requests = (report.requests ?? 0) + report.sharedWorkerMailbox.requests
			} catch (error) {
				report.requests = null
				throw error
			}
		}
		if (pair.taskHistoryChurn) {
			stage = "task_history_churn"
			await publish(directory, "churn-start.json", { runId, nonce: pair.nonce })
			const values = await awaitPair("churn")
			report.taskHistoryChurn = values.map((value, index) => {
				const envelope = requireNonce(value, pair)
				const receipt = parseTaskHistoryChurnReceipt(envelope.receipt, {
					runId,
					hostVersion: options.host.version,
					phase: pair.taskHistoryChurn!.phase,
				})
				assert.equal(receipt.extensionHostPid, identities[index]!.pid)
				assert.equal(receipt.storagePath, identities[index]!.storagePath)
				assert.equal(receipt.windowRole, ROLES[index])
				assert.equal(receipt.windowCount, 2)
				assert.equal(receipt.requests, 64)
				return receipt
			})
			const ids = report.taskHistoryChurn.flatMap((receipt) => [
				...receipt.rootTaskIds,
				...receipt.managedChildTaskIds,
			])
			assertTaskHistoryChurnPair(report.taskHistoryChurn, {
				storagePath: identities[0]!.storagePath,
				hostVersion: options.host.version,
				phase: pair.taskHistoryChurn.phase,
			})
			report.taskIds.push(...ids)
			report.requests! += report.taskHistoryChurn.reduce((sum, receipt) => sum + receipt.requests!, 0)
			await verifyLive()
		}
	} catch (error) {
		fail(failureCode(error))
	} finally {
		// Entry promises stay pending so the family can be killed while descendant ownership is still provable.
		abort.abort()
		await processPromise
		clearTimeout(timer)
		options.signal?.removeEventListener("abort", onAbort)
	}
	report.cleanupVerified = processResult?.cleanupVerified === true
	if (launchAttempted && !report.cleanupVerified) report.stopReason = "cleanup_unverified"
	stage = "receipts"
	if (manifest && report.artifactDirectory) {
		// A corrupt done receipt must not hide a peer's valid ready receipt or prevent the final bundle audit.
		for (const phase of ["ready", "done"] as const)
			for (const role of ROLES) {
				try {
					const receipt = await readOptional(report.artifactDirectory, `${phase}-${role}.json`)
					if (receipt === undefined) continue
					if (phase === "ready") {
						validateIdentity(receipt, manifest, role)
						report.readyHostCount++
					} else {
						const task = validateTaskIdentity(receipt, manifest, role)
						validateDone(receipt, manifest, role, task.taskId)
						report.doneHostCount++
					}
				} catch (error) {
					fail(failureCode(error))
				}
			}
	}
	try {
		stage = "bundle"
		report.bundleHashAfter = await bundleHash(bundlePath)
		if (report.bundleHashAfter !== report.bundleHashBefore) fail("bundle_changed")
		if (report.cleanupVerified) {
			stage = "shared_control"
			if (!report.failure) {
				// Churn intentionally retains both generations of root/child records.
				const controlLimit = manifest!.taskHistoryChurn ? 4 * 1_024 * 1_024 : 1_048_576
				const control = record(
					JSON.parse((await readBounded(done[0]!.persistenceFile, controlLimit)).toString()),
				)
				assert.ok(Array.isArray(control.agents))
				const agents = control.agents.map(record)
				for (const receipt of done)
					assert.equal(agents.find((agent) => agent.taskId === receipt.taskId)?.status, "completed")
				assert.ok(Array.isArray(control.mailbox))
				const events = control.mailbox
					.map(record)
					.filter((event) => event.eventId === mailboxEventId(manifest!))
				assert.equal(events.length, 1)
				const event = events[0]!
				assert.equal(event.recipientTaskId, report.taskIds[0])
				assert.equal(event.rootTaskId, report.taskIds[0])
				assert.ok(typeof event.acknowledgedAt === "number" && Number.isFinite(event.acknowledgedAt))
				assert.equal(event.deliveredAt, event.acknowledgedAt)
				const claims = validateMailboxClaims(
					await Promise.all(
						ROLES.map((role) => readOptional(report.artifactDirectory!, `mailbox-claimed-${role}.json`)),
					),
					manifest!,
					report.taskIds[0]!,
				)
				assert.equal(event.claimId, claims.find((claim) => claim.outcome === "claimed")!.claimId)
				report.mailboxClaimsVerified = true
				if (manifest!.sharedWorkerMailbox) {
					assert.ok(report.sharedWorkerMailbox)
					validateSharedWorkerControl(control, report.sharedWorkerMailbox)
					report.sharedWorkerMailboxVerified = true
				}
			}
		}
	} catch (error) {
		fail(failureCode(error))
	}
	const runtimeStatus = (): SharedStorageCampaignReport["status"] => {
		// Cleanup and offline capture must finish safely, but cannot turn an over-budget run into a pass.
		budgetExceeded ||= now() >= deadline
		if (budgetExceeded) report.failure ??= { stage: "controller_budget", code: "controller_timeout" }
		if (options.signal?.aborted) return "cancelled"
		if (budgetExceeded || report.failure?.code === "controller_timeout") return "timed_out"
		if (report.stopReason) return "blocked"
		return report.failure ? "failed" : "passed"
	}
	report.status = runtimeStatus()
	try {
		if (report.cleanupVerified && report.artifactDirectory && profile) {
			stage = "capture"
			const captured = await (dependencies.capture ?? captureRunEvidence)({
				...(manifest?.taskHistoryChurn ? { limits: { maxTaskIds: 100 } } : {}),
				artifactsRoot,
				runId,
				bundlePath,
				metadata: {
					scenarioId: "shared-storage-pair",
					hostVersion: report.identitiesVerified ? options.host.version : null,
					requestedHostVersion: options.host.version,
					provider: "scripted",
					modelId: "paired-host-scripted",
					taskIds: [...report.taskIds, ...(report.sharedWorkerMailbox?.taskIds ?? [])],
					startedAt,
					finishedAt: new Date().toISOString(),
					outcome: report.status,
				},
				storagePath: report.identitiesVerified ? identities[0]!.storagePath : undefined,
				logsPath: path.join(profile.userDataDir, "logs"),
				assertSourceOwned: async (source) => {
					await assertOwnedTestRoot(profileRoot, "profile")
					assert.ok(isWithin(await fs.realpath(profileRoot), source) && source !== profileRoot)
				},
				failure: report.failure ? { phase: "assertion", code: report.failure.code } : undefined,
			})
			report.captureComplete = captured.captureComplete
			if (!captured.captureComplete) fail("capture_incomplete")
		}
	} catch (error) {
		fail(failureCode(error))
	} finally {
		// No retention-eligible marker: all profiles/evidence remain held; later admission counts all of them.
		if (releaseLease && (!launchAttempted || report.cleanupVerified)) {
			try {
				await releaseLease()
				report.leaseReleased = true
			} catch {
				stage = "lease_release"
				fail("lease_release_failed")
			}
		}
	}
	report.status = runtimeStatus()
	await publish(root, reportName, report)
	return report
}
