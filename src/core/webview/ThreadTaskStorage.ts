import fs from "node:fs/promises"
import path from "node:path"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { resolveExistingTaskDirectoryPathReadOnly } from "../../utils/storage"
import type { ApiMessage } from "../task-persistence/apiMessages"
import { invalidPersistedApiMessages } from "../task-persistence/validatePersistedApiMessages"
import { digestProviderTranscript, providerTranscriptEnvelopeSchema } from "../task-persistence/ProviderTranscriptStore"

/** Inspect saved evidence without creating directories or migrating the source conversation. */
export async function readThreadApiMessages(
	taskId: string,
	storagePath: string,
	signal?: AbortSignal,
): Promise<ApiMessage[]> {
	signal?.throwIfAborted()
	const directory = await resolveExistingTaskDirectoryPathReadOnly(storagePath, taskId)
	signal?.throwIfAborted()
	for (const name of [
		GlobalFileNames.apiConversationHistory,
		"claude_messages.json",
		GlobalFileNames.providerTranscript,
	]) {
		signal?.throwIfAborted()
		const file = path.join(directory, name)
		try {
			const stats = await fs.lstat(file)
			signal?.throwIfAborted()
			if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Thread history is not a regular file")
			if (stats.size > 128 * 1024 * 1024) throw new Error("Thread history exceeds the supported read size")
			const contents = await fs.readFile(file, { encoding: "utf8", signal })
			signal?.throwIfAborted()
			let value: unknown
			try {
				value = JSON.parse(contents)
			} catch {
				throw new Error("The saved thread conversation contains invalid JSON")
			}
			let messages: unknown = value
			if (name === GlobalFileNames.providerTranscript) {
				const envelope = providerTranscriptEnvelopeSchema.safeParse(value)
				if (!envelope.success || envelope.data.taskId !== taskId)
					throw new Error("The saved provider transcript has no valid conversation for this thread")
				messages = envelope.data.messages
				if (
					!invalidPersistedApiMessages(messages) &&
					digestProviderTranscript(messages as ApiMessage[]) !== envelope.data.digest
				)
					throw new Error("The saved provider transcript digest does not match its conversation")
			}
			const error = invalidPersistedApiMessages(messages)
			if (error) throw new Error(`Unable to inspect saved thread history: ${error}`)
			return messages as ApiMessage[]
		} catch (error) {
			signal?.throwIfAborted()
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
			throw error
		}
	}
	throw new Error("The thread has no saved conversation history")
}
