import * as fs from "fs/promises"
import * as path from "path"
import { z } from "zod"

import { getTaskDirectoryPath } from "../../utils/storage"
import { atomicWriteJson, withFileLock } from "./atomicWrite"

const messageSchema = z.object({
	id: z.string().min(1).max(256),
	senderTaskId: z.string().min(1).max(256),
	text: z.string().min(1).max(64_000),
})
export type AgentMessage = z.infer<typeof messageSchema>

/** Durable input for independent tasks, separate from the editable human composer queue. */
export class AgentMessageInbox {
	private pending = 0
	private admissions = 0

	constructor(
		private readonly taskId: string,
		private readonly storagePath: string,
	) {}

	hasPending(): boolean {
		return this.pending > 0 || this.admissions > 0
	}

	private async transaction<T>(operation: (messages: AgentMessage[], file: string) => Promise<T>): Promise<T> {
		const file = path.join(await getTaskDirectoryPath(this.storagePath, this.taskId), "agent_messages.json")
		return withFileLock(file, async () => {
			let messages: AgentMessage[]
			try {
				messages = z
					.array(messageSchema)
					.max(100)
					.parse(JSON.parse(await fs.readFile(file, "utf8")))
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				messages = []
			}
			this.pending = messages.length
			return operation(messages, file)
		})
	}

	async receive(input: AgentMessage): Promise<void> {
		const message = messageSchema.parse(input)
		this.admissions++
		try {
			await this.transaction(async (messages, file) => {
				const existing = messages.find((entry) => entry.id === message.id)
				if (existing) {
					if (JSON.stringify(existing) !== JSON.stringify(message))
						throw new Error("Agent message ID conflict")
					return
				}
				if (messages.length >= 100) throw new Error("The agent inbox is full")
				await atomicWriteJson(file, [...messages, message], { requireAtomicReplace: true })
				this.pending = messages.length + 1
			})
		} finally {
			this.admissions--
		}
	}

	/** Keep the entry until the recipient's transcript is durable; failed delivery remains retryable. */
	async deliver(persist: (message: AgentMessage) => Promise<void>): Promise<void> {
		await this.transaction(async (messages, file) => {
			for (const message of messages) await persist(message)
			if (messages.length) await atomicWriteJson(file, [], { requireAtomicReplace: true })
			this.pending = 0
		})
	}
}
