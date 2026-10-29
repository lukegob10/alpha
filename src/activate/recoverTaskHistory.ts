import crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import type { AlphaProvider } from "../core/webview/AlphaProvider"
import { ProviderTranscriptStore } from "../core/task-persistence/ProviderTranscriptStore"
import { recoverApiMessages } from "../core/task-persistence/recoverApiMessages"
import { invalidPersistedApiMessages } from "../core/task-persistence/validatePersistedApiMessages"
import { GlobalFileNames } from "../shared/globalFileNames"
import { getTaskDirectoryPath } from "../utils/storage"
import { t } from "../i18n"

/** Only a human native command can authorize discarding selected malformed plain records. */
export async function recoverTaskHistory(
	provider: Pick<
		AlphaProvider,
		"taskHistoryStore" | "getLiveTask" | "getTaskOwner" | "contextProxy" | "runTaskHistoryRecovery"
	>,
): Promise<void> {
	try {
		const choices = provider.taskHistoryStore
			.getAll()
			.filter((item) => !provider.getLiveTask(item.id) && !provider.getTaskOwner(item.id))
			.map((item) => ({ label: item.id, description: new Date(item.ts).toLocaleString(), taskId: item.id }))
		const selected = await vscode.window.showQuickPick(choices, { title: t("common:historyRecovery.title") })
		if (!selected) return
		const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath
		const taskDirectory = await getTaskDirectoryPath(globalStoragePath, selected.taskId)
		const filePath = path.join(taskDirectory, GlobalFileNames.apiConversationHistory)
		const original = await fs.readFile(filePath)
		const parsed: unknown = JSON.parse(original.toString("utf8"))
		if (!Array.isArray(parsed)) throw new Error("History is not an array")
		const invalid = parsed.flatMap((message, index) =>
			invalidPersistedApiMessages([message])
				? [{ label: t("common:historyRecovery.record", { number: index + 1 }), index }]
				: [],
		)
		if (invalid.length === 0) {
			await vscode.window.showInformationMessage(t("common:historyRecovery.noInvalidRecords"))
			return
		}
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filePath)))
		const records = await vscode.window.showQuickPick(invalid, {
			title: t("common:historyRecovery.chooseRecords"),
			canPickMany: true,
		})
		if (!records?.length) return
		const expectedDigest = crypto.createHash("sha256").update(original).digest("hex")
		const confirm = t("common:historyRecovery.confirm")
		const answer = await vscode.window.showWarningMessage(
			t("common:historyRecovery.warning"),
			{
				modal: true,
				detail: t("common:historyRecovery.details", {
					taskId: selected.taskId,
					records: records.map((item) => item.index + 1).join(", "),
					digest: expectedDigest,
				}),
			},
			confirm,
		)
		if (answer !== confirm) return
		await provider.runTaskHistoryRecovery(selected.taskId, async () => {
			const recovered = await recoverApiMessages({
				taskId: selected.taskId,
				globalStoragePath,
				expectedDigest,
				discardMessageIndexes: records.map((item) => item.index),
			})
			await new ProviderTranscriptStore(selected.taskId, globalStoragePath).repairAuthoritativeTranscript(
				recovered.receipt,
			)
		})
		await vscode.window.showInformationMessage(t("common:historyRecovery.complete"))
	} catch {
		// Never expose malformed transcript contents through a native error or extension log.
		await vscode.window.showErrorMessage(t("common:historyRecovery.failed"))
	}
}
