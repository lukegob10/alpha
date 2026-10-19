import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import type { AlphaMessage } from "@alpha-code/types"

import { resolveExistingTaskDirectoryPathReadOnly } from "../../utils/storage"
import { atomicWriteJson, withFileLock } from "./atomicWrite"
import type { ApiMessage } from "./apiMessages"
import { invalidPersistedApiMessages } from "./validatePersistedApiMessages"

export const TASK_REWIND_FILE_NAME = "task_rewind.json"

const exclusionSchema = z.object({
	runId: z.string().min(1),
	turnId: z.string().min(1),
	toolCallIds: z.array(z.string().min(1)),
})

export type TaskRewindExclusion = z.infer<typeof exclusionSchema>

const rewindSchema = z.object({
	schemaVersion: z.literal(1),
	taskId: z.string().min(1),
	rewindId: z.string().min(1),
	exclusions: z.array(exclusionSchema),
	pending: z
		.object({
			// Preserve unknown historical UI fields and retired message variants, as the
			// existing task-message reader does. Rewind must not migrate retained rows.
			uiMessages: z.custom<AlphaMessage[]>(
				(value) =>
					Array.isArray(value) &&
					value.every(
						(message) =>
							message !== null &&
							typeof message === "object" &&
							typeof message.ts === "number" &&
							Number.isFinite(message.ts) &&
							(message.type === "say" || message.type === "ask"),
					),
			),
			apiHistory: z.custom<ApiMessage[]>((value) => invalidPersistedApiMessages(value) === undefined),
		})
		.optional(),
})

export type TaskRewindRecord = z.infer<typeof rewindSchema>

/** Write-ahead receipt for the existing UI/provider projections, not another task history. */
export class TaskRewindStore {
	constructor(
		private readonly storagePath: string,
		private readonly taskId: string,
	) {}

	private async filePath(): Promise<string> {
		const directory = await resolveExistingTaskDirectoryPathReadOnly(this.storagePath, this.taskId)
		for (const candidate of [path.dirname(directory), directory]) {
			try {
				const stat = await fs.lstat(candidate)
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid rewind storage directory")
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		return path.join(directory, TASK_REWIND_FILE_NAME)
	}

	private async readFile(file: string): Promise<TaskRewindRecord | undefined> {
		try {
			const stat = await fs.lstat(file)
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid rewind receipt file")
			const record = rewindSchema.parse(JSON.parse(await fs.readFile(file, "utf8")))
			if (record.taskId !== this.taskId) throw new Error("Rewind receipt belongs to a different task")
			return record
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return undefined
		}
	}

	async read(): Promise<TaskRewindRecord | undefined> {
		return this.readFile(await this.filePath())
	}

	/** Must commit before either projection changes; recovery retries these exact targets. */
	async begin(
		uiMessages: AlphaMessage[],
		apiHistory: ApiMessage[],
		exclusion?: TaskRewindExclusion,
	): Promise<TaskRewindRecord> {
		const file = await this.filePath()
		return withFileLock(file, async () => {
			if ((await this.filePath()) !== file) throw new Error("Rewind storage path changed")
			const previous = await this.readFile(file)
			if (previous?.pending) throw new Error("The previous conversation rewind must finish before another begins")
			const exclusions = previous?.exclusions ?? []
			if (exclusion) {
				const existing = exclusions.find(
					(item) => item.runId === exclusion.runId && item.turnId === exclusion.turnId,
				)
				if (existing) existing.toolCallIds = [...new Set([...existing.toolCallIds, ...exclusion.toolCallIds])]
				else exclusions.push(exclusion)
			}
			const record = rewindSchema.parse({
				schemaVersion: 1,
				taskId: this.taskId,
				rewindId: randomUUID(),
				exclusions,
				pending: { uiMessages, apiHistory },
			})
			await atomicWriteJson(file, record, { requireAtomicReplace: true })
			return record
		})
	}

	/** Clear bulky targets only after both projection writers returned affirmative receipts. */
	async complete(rewindId: string): Promise<void> {
		const file = await this.filePath()
		await withFileLock(file, async () => {
			if ((await this.filePath()) !== file) throw new Error("Rewind storage path changed")
			const record = await this.readFile(file)
			if (!record || record.rewindId !== rewindId) throw new Error("Conversation rewind receipt changed")
			if (!record.pending) return
			delete record.pending
			await atomicWriteJson(file, record, { requireAtomicReplace: true })
		})
	}
}
