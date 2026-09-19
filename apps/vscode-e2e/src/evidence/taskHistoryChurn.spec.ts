import * as assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"

import {
	assertTaskHistoryChurnPair,
	createTaskHistoryChurnReceipt,
	parseTaskHistoryChurnReceipt,
	taskHistoryChurnTaskIdsSha256,
	TASK_HISTORY_CHURN_WORKLOAD,
} from "./taskHistoryChurn"

const rootTaskIds = Array.from({ length: TASK_HISTORY_CHURN_WORKLOAD.rootCount }, (_, index) => `root-${index}`)
const managedChildTaskIds = Array.from(
	{ length: TASK_HISTORY_CHURN_WORKLOAD.childCount },
	(_, index) => `child-${index}`,
)
const managedChildParentTaskIds = [...rootTaskIds]
const mirror = {
	key: "taskHistory" as const,
	budgetBytes: 192 * 1_024,
	before: { bytes: 2, items: 0, withinBudget: true },
	after: { bytes: 128_000, items: TASK_HISTORY_CHURN_WORKLOAD.rootCount, withinBudget: true },
	maxBytes: 128_000,
	withinBudget: true as const,
}

function receipt(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		scenarioId: "task-history-churn" as const,
		phase: "populate" as const,
		runId: "task-history-churn-run",
		hostVersion: "1.122.1",
		extensionHostPid: 1234,
		storagePath: path.resolve("task-history-churn-storage"),
		windowRole: "single" as const,
		windowCount: 1 as const,
		workload: TASK_HISTORY_CHURN_WORKLOAD,
		rootTaskIds,
		managedChildTaskIds,
		managedChildParentTaskIds,
		taskIdsSha256: taskHistoryChurnTaskIdsSha256(rootTaskIds, managedChildTaskIds),
		taskHistoryMirror: mirror,
		...overrides,
	}
}

test("projects bounded churn evidence without retaining task content", () => {
	const parsed = parseTaskHistoryChurnReceipt({ ...receipt(), privatePrompt: "do not retain" })
	assert.deepEqual(parsed.rootTaskIds, rootTaskIds)
	assert.deepEqual(parsed.managedChildTaskIds, managedChildTaskIds)
	assert.equal(parsed.taskHistoryMirror.after.bytes, 128_000)
	assert.equal("privatePrompt" in parsed, false)
})

test("creates one validated projection for single and shared-window hosts", () => {
	const result = {
		phase: "populate" as const,
		rootTaskIds,
		managedChildTaskIds,
		managedChildParentTaskIds,
		taskIdsSha256: taskHistoryChurnTaskIdsSha256(rootTaskIds, managedChildTaskIds),
		taskHistoryMirror: mirror,
	}
	const parsed = createTaskHistoryChurnReceipt({
		runId: "shared-window-a",
		hostVersion: "1.122.1",
		extensionHostPid: 1234,
		storagePath: path.resolve("task-history-churn-storage"),
		windowRole: "a",
		windowCount: 2,
		result,
	})
	assert.equal(parsed.windowRole, "a")
	assert.equal(parsed.windowCount, 2)
	assert.equal(parsed.taskIdsSha256, result.taskIdsSha256)
})

test("requires shared-window receipts to prove one profile and disjoint task identities", () => {
	const result = {
		phase: "populate" as const,
		rootTaskIds,
		managedChildTaskIds,
		managedChildParentTaskIds,
		taskIdsSha256: taskHistoryChurnTaskIdsSha256(rootTaskIds, managedChildTaskIds),
		taskHistoryMirror: mirror,
	}
	const a = createTaskHistoryChurnReceipt({
		runId: "shared-window-a",
		hostVersion: "1.122.1",
		extensionHostPid: 1234,
		storagePath: path.resolve("task-history-churn-storage"),
		windowRole: "a",
		windowCount: 2,
		result,
	})
	const bRootTaskIds = rootTaskIds.map((id) => `b-${id}`)
	const bChildTaskIds = managedChildTaskIds.map((id) => `b-${id}`)
	const b = createTaskHistoryChurnReceipt({
		...a,
		runId: "shared-window-b",
		extensionHostPid: 1235,
		windowRole: "b",
		result: {
			...result,
			rootTaskIds: bRootTaskIds,
			managedChildTaskIds: bChildTaskIds,
			managedChildParentTaskIds: bRootTaskIds,
			taskIdsSha256: taskHistoryChurnTaskIdsSha256(bRootTaskIds, bChildTaskIds),
		},
	})
	assert.deepEqual(assertTaskHistoryChurnPair([a, b]), { a, b })
	assert.throws(() => assertTaskHistoryChurnPair([a, { ...b, storagePath: path.resolve("other") }]))
	assert.throws(() => assertTaskHistoryChurnPair([a, { ...b, windowRole: "a" }]))
})

test("requires reload evidence to identify the retained prior churn set", () => {
	const parsed = parseTaskHistoryChurnReceipt({
		...receipt({
			phase: "reload",
			reloadedFrom: {
				rootCount: TASK_HISTORY_CHURN_WORKLOAD.rootCount,
				childCount: TASK_HISTORY_CHURN_WORKLOAD.childCount,
				taskIdsSha256: taskHistoryChurnTaskIdsSha256(rootTaskIds, managedChildTaskIds),
			},
		}),
	})
	assert.equal(parsed.phase, "reload")
	assert.equal(parsed.reloadedFrom?.taskIdsSha256, parsed.taskIdsSha256)
	assert.throws(() => parseTaskHistoryChurnReceipt(receipt({ phase: "reload" })))
})

test("rejects forged identity, workload, budget, and digest facts", () => {
	for (const mutation of [
		{ taskIdsSha256: "0".repeat(64) },
		{ windowRole: "single" as const, windowCount: 2 as const },
		{ workload: { ...TASK_HISTORY_CHURN_WORKLOAD, rootCount: 1 } },
		{
			taskHistoryMirror: {
				...mirror,
				after: { ...mirror.after, bytes: mirror.budgetBytes + 1, withinBudget: false },
			},
		},
	]) {
		assert.throws(() => parseTaskHistoryChurnReceipt({ ...receipt(), ...mutation }))
	}
})
