import * as fs from "node:fs/promises"
import * as path from "node:path"
import { z } from "zod"

import { taskGoalSchema } from "@alpha-code/types"

import { resolveExistingTaskDirectoryPathReadOnly } from "../../utils/storage"
import { atomicWriteJson, withFileLock } from "./atomicWrite"

export const TASK_GOAL_FILE_NAME = "task_goal.json"
export const MAX_TASK_GOAL_USAGE_RECEIPTS = 8_192
const MAX_TASK_GOAL_FILE_BYTES = 8 * 1_024 * 1_024

const usageReceiptSchema = z
	.object({
		eventId: z.string().min(1).max(256),
		tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		timeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	})
	.strict()

export const taskGoalEnvelopeSchema = z
	.object({
		schemaVersion: z.literal(1),
		taskId: z.string().min(1).max(256),
		goal: taskGoalSchema.optional(),
		usageReceipts: z.array(usageReceiptSchema).max(MAX_TASK_GOAL_USAGE_RECEIPTS),
	})
	.strict()
	.refine((state) => !state.goal || state.goal.taskId === state.taskId, "Goal belongs to a different task")
export type TaskGoalEnvelope = z.infer<typeof taskGoalEnvelopeSchema>

export interface GoalStateStore {
	read(): Promise<TaskGoalEnvelope>
	transact<T>(operation: (state: TaskGoalEnvelope) => T): Promise<T>
}

/** Shares the existing task-file lock and atomic writer; no second task history or runtime is introduced. */
export class TaskGoalStore implements GoalStateStore {
	constructor(
		private readonly storagePath: string,
		private readonly taskId: string,
	) {}

	private async filePath(): Promise<string> {
		const directory = await resolveExistingTaskDirectoryPathReadOnly(this.storagePath, this.taskId)
		// The existing read-only resolver also checks a present task's realpath. Check
		// its parent independently before the lock can create a missing task directory.
		for (const candidate of [path.dirname(directory), directory]) {
			try {
				const stat = await fs.lstat(candidate)
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid goal storage directory")
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		return path.join(directory, TASK_GOAL_FILE_NAME)
	}

	private async readFile(file: string): Promise<TaskGoalEnvelope> {
		try {
			const stat = await fs.lstat(file)
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TASK_GOAL_FILE_BYTES) {
				throw new Error("Invalid goal state file")
			}
			const state = taskGoalEnvelopeSchema.parse(JSON.parse(await fs.readFile(file, "utf8")))
			if (state.taskId !== this.taskId) throw new Error("Goal state belongs to a different task")
			return state
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return { schemaVersion: 1, taskId: this.taskId, usageReceipts: [] }
		}
	}

	async read(): Promise<TaskGoalEnvelope> {
		return this.readFile(await this.filePath())
	}

	async transact<T>(operation: (state: TaskGoalEnvelope) => T): Promise<T> {
		const file = await this.filePath()
		return withFileLock(file, async () => {
			if ((await this.filePath()) !== file) throw new Error("Goal storage path changed while acquiring its lock")
			const state = await this.readFile(file)
			const before = JSON.stringify(state)
			const result = operation(state)
			const validated = taskGoalEnvelopeSchema.parse(state)
			if (validated.taskId !== this.taskId) throw new Error("Goal state belongs to a different task")
			if (before !== JSON.stringify(validated)) {
				await atomicWriteJson(file, validated, { requireAtomicReplace: true })
			}
			return result
		})
	}
}
