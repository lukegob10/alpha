import fs from "fs/promises"
import path from "path"

import { agentLifecycleEventSchema, type AgentLifecycleEvent } from "@alpha-code/types"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { resolveExistingTaskDirectoryPathReadOnly } from "../../utils/storage"

const MAX_TAIL_BYTES = 128 * 1_024
const MAX_EVENTS = 256
const MAX_LINE_BYTES = 32 * 1_024

export interface RecentIncidentEvents {
	events: AgentLifecycleEvent[]
	status: "captured" | "absent" | "incomplete"
}

/** A bounded, best-effort presentation read. The canonical journal owns recovery. */
export async function readRecentIncidentEvents(
	globalStoragePath: string,
	taskId: string,
): Promise<RecentIncidentEvents> {
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined
	try {
		const directory = await resolveExistingTaskDirectoryPathReadOnly(globalStoragePath, taskId)
		const filePath = path.join(directory, GlobalFileNames.agentLifecycleEvents)
		const before = await fs.lstat(filePath)
		if (!before.isFile() || before.isSymbolicLink()) return { events: [], status: "incomplete" }
		handle = await fs.open(filePath, "r")
		const opened = await handle.stat()
		if (!opened.isFile() || before.ino !== opened.ino || before.size !== opened.size)
			return { events: [], status: "incomplete" }
		const length = Math.min(opened.size, MAX_TAIL_BYTES)
		const buffer = Buffer.alloc(length)
		const { bytesRead } = await handle.read(buffer, 0, length, opened.size - length)
		const after = await handle.stat()
		if (bytesRead !== length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
			return { events: [], status: "incomplete" }
		let text = buffer.subarray(0, bytesRead).toString("utf8")
		const tailTruncated = opened.size > length
		if (tailTruncated) {
			const firstNewline = text.indexOf("\n")
			text = firstNewline === -1 ? "" : text.slice(firstNewline + 1)
		}
		const lines = text.split("\n")
		const unfinishedLine = lines.pop() // Only newline-terminated records have been fully appended.
		let invalid = tailTruncated || lines.length > MAX_EVENTS || unfinishedLine !== ""
		const events = lines.slice(-MAX_EVENTS).flatMap((line) => {
			if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
				invalid = true
				return []
			}
			try {
				const result = agentLifecycleEventSchema.safeParse(JSON.parse(line))
				if (result.success && result.data.taskId === taskId) return [result.data]
			} catch {
				// Malformed records are omitted from the bounded presentation view.
			}
			invalid = true
			return []
		})
		return { events, status: invalid ? "incomplete" : events.length > 0 ? "captured" : "absent" }
	} catch (error) {
		return { events: [], status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "incomplete" }
	} finally {
		await handle?.close()
	}
}
