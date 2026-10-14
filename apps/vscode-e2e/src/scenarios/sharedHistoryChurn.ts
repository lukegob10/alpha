import * as assert from "node:assert/strict"
import type { AlphaCodeAPI } from "@alpha-code/types"
import {
	runTaskHistoryChurnWorkload,
	type TaskHistoryChurnProvider,
	type TaskHistoryChurnGlobalState,
} from "./taskHistoryChurn"
import {
	assertTaskHistoryChurnStoragePath,
	createTaskHistoryChurnReceipt,
	readTaskHistoryChurnReceiptAt,
} from "../evidence/taskHistoryChurn"
import { publish, type PairManifest, type HostIdentity } from "../evidence/sharedStorageProtocol"

export async function exerciseSharedHistoryChurn(options: {
	api: AlphaCodeAPI
	provider: TaskHistoryChurnProvider
	globalState: TaskHistoryChurnGlobalState
	manifest: PairManifest
	identity: HostIdentity
	directory: string
}) {
	const { manifest, identity, api, provider, globalState, directory } = options
	const churn = manifest.taskHistoryChurn
	assert.ok(churn)
	await provider.taskHistoryStoreReady
	let reloadedFrom
	if (churn.phase === "reload") {
		const prior = await readTaskHistoryChurnReceiptAt(churn.priorReceipts![identity.role], {
			phase: "populate",
			hostVersion: identity.hostVersion,
		})
		await assertTaskHistoryChurnStoragePath(prior, identity.storagePath)
		assert.equal(prior.windowRole, identity.role)
		assert.equal(prior.windowCount, 2)
		for (const id of prior.rootTaskIds) {
			const { historyItem } = await provider.getTaskWithId(id)
			assert.equal(historyItem.id, id)
			assert.equal(historyItem.taskKind, "primary")
			assert.equal(historyItem.status, "completed")
		}
		for (const [index, id] of prior.managedChildTaskIds.entries()) {
			const { historyItem } = await provider.getTaskWithId(id)
			assert.equal(historyItem.id, id)
			assert.equal(historyItem.taskKind, "subagent")
			assert.equal(historyItem.parentTaskId, prior.managedChildParentTaskIds[index])
			assert.equal(historyItem.rootTaskId, prior.managedChildParentTaskIds[index])
			assert.equal(historyItem.status, "completed")
		}
		reloadedFrom = {
			rootCount: prior.rootTaskIds.length,
			childCount: prior.managedChildTaskIds.length,
			taskIdsSha256: prior.taskIdsSha256,
		}
	}
	const result = await runTaskHistoryChurnWorkload({ phase: churn.phase, api, provider, globalState })
	const receipt = createTaskHistoryChurnReceipt({
		runId: manifest.runId,
		hostVersion: identity.hostVersion,
		extensionHostPid: identity.pid,
		storagePath: identity.storagePath,
		windowRole: identity.role,
		windowCount: 2,
		result,
		reloadedFrom,
	})
	await publish(directory, `task-history-churn-${identity.role}.json`, receipt)
	await publish(directory, `churn-${identity.role}.json`, { runId: manifest.runId, nonce: manifest.nonce, receipt })
}
