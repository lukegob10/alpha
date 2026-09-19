import * as fs from "node:fs/promises"
import { createHash } from "node:crypto"
import * as path from "node:path"

import { readBounded, rejectSymlinkComponents } from "./paths"
import {
	parseTaskHistoryMirrorReceipt,
	TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES,
	type TaskHistoryMirrorReceipt,
} from "./storageRestart"

export const TASK_HISTORY_CHURN_RECEIPT = "task-history-churn.json"
export const TASK_HISTORY_CHURN_MAX_RECEIPT_BYTES = 32 * 1_024

/**
 * This workload is deliberately large enough to exercise compaction while staying below the
 * canonical compatibility budget after root-only projection. Child transcripts never enter this receipt.
 */
export const TASK_HISTORY_CHURN_WORKLOAD = {
	rootCount: 16,
	childCount: 16,
	rootPromptBytes: 8 * 1_024,
	childObjectiveBytes: 2 * 1_024,
} as const

export type TaskHistoryChurnPhase = "populate" | "reload"
export type TaskHistoryChurnWindowRole = "single" | "a" | "b"

export interface TaskHistoryChurnReloadReceipt {
	rootCount: number
	childCount: number
	taskIdsSha256: string
}

/**
 * Content-free result shape returned by the host workload. Keeping this projection in the
 * evidence layer lets single-window and shared-window suites publish the same receipt without
 * reimplementing its privacy and identity checks.
 */
export interface TaskHistoryChurnRunProjection {
	phase: TaskHistoryChurnPhase
	rootTaskIds: string[]
	managedChildTaskIds: string[]
	managedChildParentTaskIds: string[]
	taskIdsSha256: string
	taskHistoryMirror: TaskHistoryMirrorReceipt
	requests?: number
}

export interface TaskHistoryChurnReceipt {
	schemaVersion: 1
	scenarioId: "task-history-churn"
	phase: TaskHistoryChurnPhase
	runId: string
	hostVersion: string
	extensionHostPid: number
	storagePath: string
	windowRole: TaskHistoryChurnWindowRole
	windowCount: 1 | 2
	workload: typeof TASK_HISTORY_CHURN_WORKLOAD
	rootTaskIds: string[]
	managedChildTaskIds: string[]
	managedChildParentTaskIds: string[]
	taskIdsSha256: string
	taskHistoryMirror: TaskHistoryMirrorReceipt
	requests?: number
	reloadedFrom?: TaskHistoryChurnReloadReceipt
}

function fail(message: string): never {
	throw new Error(message)
}

function record(value: unknown, message = "Invalid task-history churn evidence"): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(message)
	return value as Record<string, unknown>
}

function safeTaskId(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
		fail("Invalid task-history churn task identity")
	return value
}

function taskIds(value: unknown, expectedCount: number): string[] {
	if (!Array.isArray(value) || value.length !== expectedCount) fail("Invalid task-history churn task count")
	const result = value.map(safeTaskId)
	if (new Set(result).size !== result.length) fail("Duplicate task-history churn task identity")
	return result
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex")
}

export function taskHistoryChurnTaskIdsSha256(
	rootTaskIds: readonly string[],
	managedChildTaskIds: readonly string[],
): string {
	return sha256(
		[...rootTaskIds.map((id) => `root:${id}`), ...managedChildTaskIds.map((id) => `child:${id}`)].sort().join("\n"),
	)
}

function positivePid(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 2_147_483_647)
		fail("Invalid task-history churn extension-host PID")
	return Number(value)
}

function requestCount(value: unknown): number | undefined {
	if (value === undefined) return undefined
	if (
		!Number.isSafeInteger(value) ||
		Number(value) !== TASK_HISTORY_CHURN_WORKLOAD.rootCount * 3 + TASK_HISTORY_CHURN_WORKLOAD.childCount
	)
		fail("Invalid task-history churn provider request count")
	return Number(value)
}

function workload(value: unknown): typeof TASK_HISTORY_CHURN_WORKLOAD {
	const candidate = record(value, "Invalid task-history churn workload")
	if (
		candidate.rootCount !== TASK_HISTORY_CHURN_WORKLOAD.rootCount ||
		candidate.childCount !== TASK_HISTORY_CHURN_WORKLOAD.childCount ||
		candidate.rootPromptBytes !== TASK_HISTORY_CHURN_WORKLOAD.rootPromptBytes ||
		candidate.childObjectiveBytes !== TASK_HISTORY_CHURN_WORKLOAD.childObjectiveBytes
	)
		fail("Unexpected task-history churn workload")
	return TASK_HISTORY_CHURN_WORKLOAD
}

function windowIdentity(value: unknown): { role: TaskHistoryChurnWindowRole; count: 1 | 2 } {
	const candidate = record(value, "Invalid task-history churn window identity")
	if (candidate.windowRole !== "single" && candidate.windowRole !== "a" && candidate.windowRole !== "b")
		fail("Invalid task-history churn window role")
	if (candidate.windowCount !== 1 && candidate.windowCount !== 2) fail("Invalid task-history churn window count")
	if (
		(candidate.windowCount === 1 && candidate.windowRole !== "single") ||
		(candidate.windowCount === 2 && candidate.windowRole === "single")
	)
		fail("Mismatched task-history churn window identity")
	return { role: candidate.windowRole, count: candidate.windowCount }
}

function reloadReceipt(value: unknown): TaskHistoryChurnReloadReceipt | undefined {
	if (value === undefined) return undefined
	const candidate = record(value, "Invalid task-history churn reload evidence")
	if (
		!Number.isSafeInteger(candidate.rootCount) ||
		candidate.rootCount !== TASK_HISTORY_CHURN_WORKLOAD.rootCount ||
		!Number.isSafeInteger(candidate.childCount) ||
		candidate.childCount !== TASK_HISTORY_CHURN_WORKLOAD.childCount ||
		typeof candidate.taskIdsSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(candidate.taskIdsSha256)
	)
		fail("Invalid task-history churn reload evidence")
	return {
		rootCount: Number(candidate.rootCount),
		childCount: Number(candidate.childCount),
		taskIdsSha256: String(candidate.taskIdsSha256),
	}
}

export function createTaskHistoryChurnReceipt(options: {
	runId: string
	hostVersion: string
	extensionHostPid: number
	storagePath: string
	windowRole: TaskHistoryChurnWindowRole
	windowCount: 1 | 2
	result: TaskHistoryChurnRunProjection
	reloadedFrom?: TaskHistoryChurnReloadReceipt
}): TaskHistoryChurnReceipt {
	const { result } = options
	return parseTaskHistoryChurnReceipt({
		schemaVersion: 1,
		scenarioId: "task-history-churn",
		phase: result.phase,
		runId: options.runId,
		hostVersion: options.hostVersion,
		extensionHostPid: options.extensionHostPid,
		storagePath: options.storagePath,
		windowRole: options.windowRole,
		windowCount: options.windowCount,
		workload: TASK_HISTORY_CHURN_WORKLOAD,
		rootTaskIds: result.rootTaskIds,
		managedChildTaskIds: result.managedChildTaskIds,
		managedChildParentTaskIds: result.managedChildParentTaskIds,
		taskIdsSha256: result.taskIdsSha256,
		taskHistoryMirror: result.taskHistoryMirror,
		...(result.requests === undefined ? {} : { requests: result.requests }),
		...(options.reloadedFrom ? { reloadedFrom: options.reloadedFrom } : {}),
	})
}

/**
 * Validate the two content-free receipts emitted by a shared-storage pair. This proves that both
 * roles observed the same profile and disjoint task identities; the launcher remains responsible
 * for proving overlap and host ownership.
 */
export function assertTaskHistoryChurnPair(
	receipts: readonly TaskHistoryChurnReceipt[],
	expected?: { storagePath?: string; hostVersion?: string; phase?: TaskHistoryChurnPhase },
): { a: TaskHistoryChurnReceipt; b: TaskHistoryChurnReceipt } {
	if (receipts.length !== 2) fail("A task-history churn pair requires exactly two host receipts")
	const [first, second] = receipts
	if (!first || !second || first.windowCount !== 2 || second.windowCount !== 2) {
		fail("Task-history churn pair is not marked as a two-window run")
	}
	const byRole = new Map([first, second].map((receipt) => [receipt.windowRole, receipt] as const))
	const a = byRole.get("a")
	const b = byRole.get("b")
	if (!a || !b) fail("Task-history churn pair must contain one a and one b receipt")
	if (a.storagePath !== b.storagePath) fail("Task-history churn pair used different storage profiles")
	if (expected?.storagePath !== undefined && a.storagePath !== expected.storagePath) {
		fail("Task-history churn pair storage profile does not match the owned profile")
	}
	if (
		expected?.hostVersion !== undefined &&
		(a.hostVersion !== expected.hostVersion || b.hostVersion !== expected.hostVersion)
	) {
		fail("Task-history churn pair host versions do not match the owned host")
	}
	if (expected?.phase !== undefined && (a.phase !== expected.phase || b.phase !== expected.phase)) {
		fail("Task-history churn pair phases do not match the owned run")
	}
	const taskIdsA = new Set([...a.rootTaskIds, ...a.managedChildTaskIds])
	if ([...b.rootTaskIds, ...b.managedChildTaskIds].some((taskId) => taskIdsA.has(taskId))) {
		fail("Task-history churn pair reused a task identity across windows")
	}
	return { a, b }
}

export function parseTaskHistoryChurnReceipt(
	value: unknown,
	expected?: { runId?: string; hostVersion?: string; phase?: TaskHistoryChurnPhase },
): TaskHistoryChurnReceipt {
	const candidate = record(value)
	if (
		candidate.schemaVersion !== 1 ||
		candidate.scenarioId !== "task-history-churn" ||
		(expected?.runId !== undefined && candidate.runId !== expected.runId) ||
		(expected?.hostVersion !== undefined && candidate.hostVersion !== expected.hostVersion) ||
		(expected?.phase !== undefined && candidate.phase !== expected.phase) ||
		typeof candidate.runId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate.runId) ||
		typeof candidate.hostVersion !== "string" ||
		!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(candidate.hostVersion)
	)
		fail("Task-history churn evidence does not match the owned run")
	const identity = windowIdentity(candidate)
	if (candidate.phase !== "populate" && candidate.phase !== "reload") fail("Invalid task-history churn phase")
	if (
		typeof candidate.storagePath !== "string" ||
		!path.isAbsolute(candidate.storagePath) ||
		candidate.storagePath.includes("\0")
	)
		fail("Invalid task-history churn storage path")
	const configuredWorkload = workload(candidate.workload)
	const rootTaskIds = taskIds(candidate.rootTaskIds, configuredWorkload.rootCount)
	const managedChildTaskIds = taskIds(candidate.managedChildTaskIds, configuredWorkload.childCount)
	const managedChildParentTaskIds = taskIds(candidate.managedChildParentTaskIds, configuredWorkload.childCount)
	if (
		managedChildParentTaskIds.some((parentTaskId) => !rootTaskIds.includes(parentTaskId)) ||
		new Set(managedChildParentTaskIds).size !== rootTaskIds.length
	)
		fail("Task-history churn child parent identity is not in the current root set")
	if (new Set([...rootTaskIds, ...managedChildTaskIds]).size !== rootTaskIds.length + managedChildTaskIds.length)
		fail("Overlapping task-history churn identities")
	if (
		typeof candidate.taskIdsSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(candidate.taskIdsSha256) ||
		candidate.taskIdsSha256 !== taskHistoryChurnTaskIdsSha256(rootTaskIds, managedChildTaskIds)
	)
		fail("Task-history churn task identity digest does not match")
	const reloadedFrom = reloadReceipt(candidate.reloadedFrom)
	if ((candidate.phase === "reload") !== (reloadedFrom !== undefined))
		fail("Task-history churn reload evidence is incomplete")
	const taskHistoryMirror = parseTaskHistoryMirrorReceipt(candidate.taskHistoryMirror)
	const requests = requestCount(candidate.requests)
	return {
		schemaVersion: 1,
		scenarioId: "task-history-churn",
		phase: candidate.phase,
		runId: candidate.runId,
		hostVersion: candidate.hostVersion,
		extensionHostPid: positivePid(candidate.extensionHostPid),
		storagePath: candidate.storagePath,
		windowRole: identity.role,
		windowCount: identity.count,
		workload: configuredWorkload,
		rootTaskIds,
		managedChildTaskIds,
		managedChildParentTaskIds,
		taskIdsSha256: candidate.taskIdsSha256,
		taskHistoryMirror,
		...(requests === undefined ? {} : { requests }),
		...(reloadedFrom ? { reloadedFrom } : {}),
	}
}

export async function readTaskHistoryChurnReceipt(
	artifactsDir: string,
	expected?: { runId?: string; hostVersion?: string; phase?: TaskHistoryChurnPhase },
): Promise<TaskHistoryChurnReceipt> {
	return readTaskHistoryChurnReceiptAt(path.join(artifactsDir, TASK_HISTORY_CHURN_RECEIPT), expected)
}

export async function readTaskHistoryChurnReceiptAt(
	receiptPath: string,
	expected?: { runId?: string; hostVersion?: string; phase?: TaskHistoryChurnPhase },
): Promise<TaskHistoryChurnReceipt> {
	if (!path.isAbsolute(receiptPath) || receiptPath.includes("\0")) fail("Invalid task-history churn receipt path")
	await rejectSymlinkComponents(receiptPath)
	return parseTaskHistoryChurnReceipt(
		JSON.parse((await readBounded(receiptPath, TASK_HISTORY_CHURN_MAX_RECEIPT_BYTES)).toString("utf8")),
		expected,
	)
}

export async function assertTaskHistoryChurnStoragePath(
	receipt: TaskHistoryChurnReceipt,
	expectedStoragePath: string,
): Promise<TaskHistoryChurnReceipt> {
	await rejectSymlinkComponents(expectedStoragePath)
	const storagePath = await fs.realpath(expectedStoragePath)
	if (receipt.storagePath !== storagePath) fail("Task-history churn storage belongs to another profile")
	return receipt
}

export const TASK_HISTORY_CHURN_BUDGET_BYTES = TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES
