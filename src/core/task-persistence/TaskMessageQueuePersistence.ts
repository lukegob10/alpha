import * as fs from "fs/promises"
import * as path from "path"

import { queuedMessageSchema, type QueuedMessage } from "@alpha-code/types"

import { getTaskDirectoryPath } from "../../utils/storage"
import {
	assertMessageQueueBounds,
	MAX_QUEUED_MESSAGES,
	MAX_QUEUED_MESSAGE_BYTES,
	type MessageQueuePersistence,
} from "../message-queue/MessageQueueService"
import { readApiMessages } from "./apiMessages"
import { atomicWriteJson, withFileLock } from "./atomicWrite"

/** Pending human input remains recoverable until the authoritative transcript contains its IDs. */
export class TaskMessageQueuePersistence implements MessageQueuePersistence {
	constructor(
		private readonly taskId: string,
		private readonly globalStoragePath: string,
	) {}

	private async filePath(): Promise<string> {
		return path.join(await getTaskDirectoryPath(this.globalStoragePath, this.taskId), "pending_queue.json")
	}

	async load(): Promise<QueuedMessage[]> {
		const file = await this.filePath()
		return withFileLock(file, async () => {
			let messages: QueuedMessage[]
			try {
				if ((await fs.stat(file)).size > MAX_QUEUED_MESSAGE_BYTES + 1) {
					throw new Error("The persisted message queue exceeds its 32 MiB storage limit")
				}
				messages = queuedMessageSchema
					.array()
					.max(MAX_QUEUED_MESSAGES)
					.parse(JSON.parse(await fs.readFile(file, "utf8")))
				assertMessageQueueBounds(messages)
				if (new Set(messages.map((message) => message.id)).size !== messages.length) {
					throw new Error("The persisted message queue contains duplicate identities")
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				return []
			}
			const history = await readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
			const consumed = new Set(history.flatMap((message) => message.queued_message_ids ?? []))
			const pending = messages.filter((message) => !consumed.has(message.id))
			// Repair the stale snapshot before a later compaction can remove the
			// transcript receipts that proved consumption. Failed repair blocks replay.
			if (pending.length !== messages.length) {
				await atomicWriteJson(file, pending, { requireAtomicReplace: true })
			}
			return pending
		})
	}

	async save(messages: readonly QueuedMessage[]): Promise<void> {
		assertMessageQueueBounds(messages)
		const file = await this.filePath()
		await withFileLock(file, () => atomicWriteJson(file, messages, { requireAtomicReplace: true }))
	}
}
