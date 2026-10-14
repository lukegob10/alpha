import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

import {
	assertTaskHistoryChurnStoragePath,
	createTaskHistoryChurnReceipt,
	readTaskHistoryChurnReceiptAt,
	TASK_HISTORY_CHURN_RECEIPT,
	TASK_HISTORY_CHURN_WORKLOAD,
	type TaskHistoryChurnPhase,
	type TaskHistoryChurnReceipt,
	type TaskHistoryChurnWindowRole,
} from "../evidence/taskHistoryChurn"
import { readBounded, rejectSymlinkComponents } from "../evidence/paths"
import { runTaskHistoryChurnWorkload, type TaskHistoryChurnProvider } from "../scenarios/taskHistoryChurn"

function windowIdentity(): { role: TaskHistoryChurnWindowRole; count: 1 | 2 } {
	const role = process.env.ALPHA_E2E_TASK_HISTORY_CHURN_WINDOW_ROLE ?? "single"
	const count = process.env.ALPHA_E2E_TASK_HISTORY_CHURN_WINDOW_COUNT ?? "1"
	assert.ok(role === "single" || role === "a" || role === "b")
	assert.ok(count === "1" || count === "2")
	if (count === "1") assert.equal(role, "single")
	else assert.ok(role === "a" || role === "b")
	return { role, count: count === "1" ? 1 : 2 }
}

function historyIds(receipt: TaskHistoryChurnReceipt): string[] {
	return [...receipt.rootTaskIds, ...receipt.managedChildTaskIds]
}

suite("Actual task-history compatibility churn", function () {
	this.timeout(10 * 60_000)
	test("persists repeated managed-child history through a host reopen", async function () {
		const phase = process.env.ALPHA_E2E_TASK_HISTORY_CHURN_PHASE
		if (!phase) {
			this.skip()
			return
		}
		assert.ok(phase === "populate" || phase === "reload")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		assert.equal(process.env.ALPHA_E2E_SCENARIO_ID, "task-history-churn")
		const artifactsDir = process.env.ALPHA_E2E_ARTIFACTS_DIR
		const runId = process.env.ALPHA_E2E_RUN_ID
		assert.ok(artifactsDir && runId)
		const api = globalThis.api
		const context = (api as unknown as { context: vscode.ExtensionContext }).context
		assert.ok(context?.globalState, "Alpha must expose its real extension context")
		const provider = (api as unknown as { sidebarProvider: TaskHistoryChurnProvider }).sidebarProvider
		const persistenceFile = provider.agentControlStore.persistence.filePath
		await rejectSymlinkComponents(persistenceFile)
		const storagePath = await fs.realpath(path.dirname(persistenceFile))
		const { role: windowRole, count: windowCount } = windowIdentity()

		let reloadedFrom: TaskHistoryChurnReceipt | undefined
		if (phase === "reload") {
			const priorReceiptPath = process.env.ALPHA_E2E_TASK_HISTORY_CHURN_PRIOR_RECEIPT_PATH
			assert.ok(priorReceiptPath, "Reload phase requires the retained populate receipt path")
			reloadedFrom = await readTaskHistoryChurnReceiptAt(priorReceiptPath, {
				phase: "populate",
				hostVersion: vscode.version,
			})
			await assertTaskHistoryChurnStoragePath(reloadedFrom, storagePath)
			assert.equal(reloadedFrom.windowRole, windowRole)
			assert.equal(reloadedFrom.windowCount, windowCount)
			for (const taskId of reloadedFrom.rootTaskIds) {
				const history = await provider.getTaskWithId(taskId)
				assert.equal(history.historyItem.id, taskId)
				assert.equal(history.historyItem.taskKind, "primary")
				assert.equal(history.historyItem.status, "completed")
			}
			for (const [index, childTaskId] of reloadedFrom.managedChildTaskIds.entries()) {
				const history = await provider.getTaskWithId(childTaskId)
				assert.equal(history.historyItem.taskKind, "subagent")
				assert.equal(history.historyItem.parentTaskId, reloadedFrom.managedChildParentTaskIds[index])
				assert.equal(history.historyItem.rootTaskId, reloadedFrom.managedChildParentTaskIds[index])
				assert.equal(history.historyItem.status, "completed")
			}
		}

		const result = await runTaskHistoryChurnWorkload({
			phase: phase as TaskHistoryChurnPhase,
			api,
			provider,
			globalState: context.globalState,
		})
		assert.equal(
			result.requests,
			TASK_HISTORY_CHURN_WORKLOAD.rootCount * 3 + TASK_HISTORY_CHURN_WORKLOAD.childCount,
			"Each bounded root must make three requests and each child one request",
		)
		const receipt: TaskHistoryChurnReceipt = createTaskHistoryChurnReceipt({
			runId,
			hostVersion: vscode.version,
			extensionHostPid: process.pid,
			storagePath,
			windowRole,
			windowCount,
			result,
			reloadedFrom: reloadedFrom
				? {
						rootCount: reloadedFrom.rootTaskIds.length,
						childCount: reloadedFrom.managedChildTaskIds.length,
						taskIdsSha256: reloadedFrom.taskIdsSha256,
					}
				: undefined,
		})
		assert.equal(receipt.taskHistoryMirror.withinBudget, true)
		await fs.writeFile(path.join(artifactsDir, TASK_HISTORY_CHURN_RECEIPT), JSON.stringify(receipt, null, 2), {
			flag: "wx",
			mode: 0o600,
		})
		const scenarioResultPath = process.env.ALPHA_E2E_SCENARIO_RESULT_PATH
		if (scenarioResultPath) {
			await fs.writeFile(scenarioResultPath, JSON.stringify({ runId, taskIds: historyIds(receipt) }), {
				flag: "wx",
				mode: 0o600,
			})
		}
		// Keep the receipt file bounded and ensure the capture cannot be an accidentally oversized raw transcript.
		assert.ok(
			(await readBounded(path.join(artifactsDir, TASK_HISTORY_CHURN_RECEIPT), 32 * 1_024)).length <= 32 * 1_024,
		)
	})
})
