import * as fs from "fs/promises"
import * as path from "path"

import { readBounded, rejectSymlinkComponents } from "./paths"
import { StorageRecoverySafetyError, type RecoveryHostRecord } from "./storageRecovery"

export const STORAGE_RESTART_RECEIPT = "storage-restart-phase.json"

// Keep this mirror-only probe aligned with the production compatibility budget in
// src/core/task-persistence/compactTaskHistoryForGlobalState.ts. The E2E package
// cannot import extension-core source without turning the host fixture into a
// second production dependency.
export const TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES = 192 * 1024

export interface TaskHistoryMirrorObservation {
	bytes: number
	items: number
	withinBudget: boolean
}

export interface TaskHistoryMirrorReceipt {
	key: "taskHistory"
	budgetBytes: typeof TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES
	before: TaskHistoryMirrorObservation
	after: TaskHistoryMirrorObservation
	samples?: TaskHistoryMirrorObservation[]
	maxBytes: number
	withinBudget: true
}

export interface StorageRestartPhaseReceipt {
	schemaVersion: 1
	scenarioId: "storage-restart"
	phase: "fault" | "healthy"
	runId: string
	hostVersion: string
	extensionHostPid: number
	storagePath: string
	taskId: string
	providerRequests: number
	terminalCount: 1
	status: "failed" | "completed"
	code: "ELOCKOWNER" | "OK"
	taskHistoryMirror?: TaskHistoryMirrorReceipt
}

interface GlobalStateReader {
	get<T>(key: string): T | undefined
}

/** Measure only the serialized compatibility mirror; never return its contents. */
export function measureTaskHistoryMirror(globalState: GlobalStateReader): TaskHistoryMirrorObservation {
	const value = globalState.get<unknown>("taskHistory")
	if (value !== undefined && !Array.isArray(value)) {
		throw new StorageRecoverySafetyError("The taskHistory global-state value is not an array")
	}
	const items = value ?? []
	const serialized = JSON.stringify(items)
	if (typeof serialized !== "string") {
		throw new StorageRecoverySafetyError("The taskHistory global-state value is not JSON serializable")
	}
	const bytes = Buffer.byteLength(serialized, "utf8")
	return {
		bytes,
		items: items.length,
		withinBudget: bytes <= TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES,
	}
}

/** Narrow structural input from the existing runner, not a second host-launch API. */
export interface StorageRestartRunProof {
	runId: string
	artifactsDir: string
	execution: "test-seam" | "extension-host"
	hostExitObserved: boolean
	ownershipGate?: "verified"
	actualVSCodeVersion?: string
	launchedHostPid?: number
	extensionHostPid?: number
	extensionHostParentPid?: number
	evidenceManifestPath?: string
	captureComplete?: boolean
}

function fail(message: string): never {
	throw new StorageRecoverySafetyError(message)
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid storage-restart evidence")
	return value as Record<string, unknown>
}

function validPid(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647
}

function validMirrorObservation(value: unknown): value is TaskHistoryMirrorObservation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const observation = value as Record<string, unknown>
	const withinBudget = Number(observation.bytes) <= TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES
	return (
		Number.isSafeInteger(observation.bytes) &&
		Number(observation.bytes) >= 0 &&
		Number.isSafeInteger(observation.items) &&
		Number(observation.items) >= 0 &&
		typeof observation.withinBudget === "boolean" &&
		observation.withinBudget === withinBudget
	)
}

function parseTaskHistoryMirror(value: unknown): TaskHistoryMirrorReceipt | undefined {
	if (value === undefined) return undefined
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid taskHistory mirror evidence")
	const mirror = value as Record<string, unknown>
	const before = mirror.before
	const after = mirror.after
	const samples = mirror.samples ?? []
	if (!Array.isArray(samples) || samples.length > 64 || !samples.every(validMirrorObservation))
		fail("Invalid taskHistory mirror samples")
	if (
		mirror.key !== "taskHistory" ||
		mirror.budgetBytes !== TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES ||
		!validMirrorObservation(before) ||
		!validMirrorObservation(after) ||
		!Number.isSafeInteger(mirror.maxBytes) ||
		Number(mirror.maxBytes) !== Math.max(before.bytes, after.bytes, ...samples.map((sample) => sample.bytes)) ||
		Number(mirror.maxBytes) < before.bytes ||
		Number(mirror.maxBytes) < after.bytes ||
		Number(mirror.maxBytes) > TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES ||
		mirror.withinBudget !== true ||
		before.withinBudget !== true ||
		after.withinBudget !== true
	)
		fail("Invalid taskHistory mirror evidence")
	return {
		key: "taskHistory",
		budgetBytes: TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES,
		before,
		after,
		...(mirror.samples === undefined ? {} : { samples }),
		maxBytes: Number(mirror.maxBytes),
		withinBudget: true,
	}
}

export function parseTaskHistoryMirrorReceipt(value: unknown): TaskHistoryMirrorReceipt {
	const parsed = parseTaskHistoryMirror(value)
	if (!parsed) fail("Missing taskHistory mirror evidence")
	return parsed
}

export async function readStorageRestartPhaseReceipt(
	artifactsDir: string,
	expected: { runId: string; hostVersion: string; phase: "fault" | "healthy"; storagePath: string },
): Promise<StorageRestartPhaseReceipt> {
	const value = record(
		JSON.parse((await readBounded(path.join(artifactsDir, STORAGE_RESTART_RECEIPT), 8_192)).toString("utf8")),
	)
	await rejectSymlinkComponents(expected.storagePath)
	const storagePath = await fs.realpath(expected.storagePath)
	if (
		value.schemaVersion !== 1 ||
		value.scenarioId !== "storage-restart" ||
		value.runId !== expected.runId ||
		value.hostVersion !== expected.hostVersion ||
		value.phase !== expected.phase ||
		value.storagePath !== storagePath ||
		!validPid(value.extensionHostPid) ||
		typeof value.taskId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.taskId) ||
		value.terminalCount !== 1 ||
		(expected.phase === "fault"
			? value.providerRequests !== 0 || value.status !== "failed" || value.code !== "ELOCKOWNER"
			: value.providerRequests !== 1 || value.status !== "completed" || value.code !== "OK")
	)
		fail("Storage-restart phase evidence does not match the owned run")
	return {
		schemaVersion: 1,
		scenarioId: "storage-restart",
		phase: expected.phase,
		runId: expected.runId,
		hostVersion: expected.hostVersion,
		extensionHostPid: value.extensionHostPid,
		storagePath,
		taskId: value.taskId,
		providerRequests: Number(value.providerRequests),
		terminalCount: 1,
		status: expected.phase === "fault" ? "failed" : "completed",
		code: expected.phase === "fault" ? "ELOCKOWNER" : "OK",
		...(value.taskHistoryMirror === undefined
			? {}
			: { taskHistoryMirror: parseTaskHistoryMirror(value.taskHistoryMirror) }),
	}
}

/**
 * Call only inside runExtensionTests.afterRun, while its exclusive profile lease is held.
 * The dedicated shell-free suite permits one extension host; missing/changed receipts,
 * a second startup, uncertain exit, or a live/reused PID must block the offline operation.
 * This proof does not authorize recovery for arbitrary/live-model campaigns.
 */
export async function assertStorageRestartQuiescence(
	proof: StorageRestartRunProof,
	receipt: StorageRestartPhaseReceipt,
	isProcessLive: (pid: number) => boolean | undefined | Promise<boolean | undefined> = processIsLive,
): Promise<RecoveryHostRecord[]> {
	if (
		proof.execution !== "extension-host" ||
		!proof.hostExitObserved ||
		proof.ownershipGate !== "verified" ||
		proof.runId !== receipt.runId ||
		proof.actualVSCodeVersion !== receipt.hostVersion ||
		proof.extensionHostPid !== receipt.extensionHostPid ||
		!proof.captureComplete ||
		!proof.evidenceManifestPath ||
		![proof.launchedHostPid, proof.extensionHostPid, proof.extensionHostParentPid].every(validPid)
	)
		fail("Storage-restart host ownership, exit, or evidence is unverified")
	await rejectSymlinkComponents(proof.artifactsDir)
	const artifactsDir = await fs.realpath(proof.artifactsDir)
	if (path.resolve(proof.evidenceManifestPath) !== path.join(artifactsDir, "manifest.json")) {
		fail("Storage-restart manifest is outside its run")
	}
	const manifest = record(
		JSON.parse((await readBounded(proof.evidenceManifestPath, 2 * 1_024 * 1_024)).toString("utf8")),
	)
	const metadata = record(manifest.metadata)
	if (
		manifest.kind !== "alpha-vscode-e2e-run-evidence" ||
		manifest.version !== 1 ||
		manifest.finalized !== true ||
		manifest.runId !== proof.runId ||
		manifest.captureComplete !== true ||
		typeof manifest.bundleSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(manifest.bundleSha256) ||
		metadata.hostVersion !== receipt.hostVersion ||
		metadata.scenarioId !== "storage-restart" ||
		metadata.provider !== "scripted" ||
		!Array.isArray(metadata.taskIds) ||
		metadata.taskIds.length !== 1 ||
		metadata.taskIds[0] !== receipt.taskId
	)
		fail("Storage-restart failure evidence is incomplete or belongs to another run")
	const hosts = [...new Set([proof.launchedHostPid!, proof.extensionHostPid!, proof.extensionHostParentPid!])]
	for (const pid of hosts) {
		let live: boolean | undefined
		try {
			live = await isProcessLive(pid)
		} catch {
			fail("Storage-restart process liveness is unavailable")
		}
		if (live !== false) fail("A storage-restart process is live or its liveness is unknown")
	}
	return hosts.map((pid) => ({ pid }))
}

function processIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ESRCH") return false
		if (code === "EPERM") return true
		throw error
	}
}
