import * as fs from "node:fs/promises"
import * as path from "node:path"
import { z } from "zod"

import { resolveExistingTaskDirectoryPathReadOnly } from "../../../utils/storage"
import { atomicWriteJson, withFileLock } from "../../task-persistence/atomicWrite"
import type { GoalAccountingBinding } from "../GoalStepAccounting"

export const GOAL_ACCOUNTING_OWNER_FILE = "task_goal_owner.json"

const ownerSchema = z
	.object({
		goalTaskId: z.string().min(1).max(256),
		goalId: z.string().min(1).max(256),
		controlVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		/** Receipts from older children permit late billing only, across every reload. */
		drainOnly: z.boolean().default(false),
	})
	.strict()

const envelopeSchema = z
	.object({
		schemaVersion: z.literal(1),
		taskId: z.string().min(1).max(256),
		owner: ownerSchema.nullable(),
	})
	.strict()

export type GoalAccountingOwner = z.infer<typeof ownerSchema>
export type GoalAccountingOwnerEnvelope = z.infer<typeof envelopeSchema>

/** Immutable admission metadata prevents restored children from adopting a later root goal. */
export class GoalAccountingBindingStore {
	constructor(
		private readonly storagePath: string,
		private readonly taskId: string,
	) {}

	private async filePath(): Promise<string> {
		const directory = await resolveExistingTaskDirectoryPathReadOnly(this.storagePath, this.taskId)
		for (const candidate of [path.dirname(directory), directory]) {
			try {
				const stat = await fs.lstat(candidate)
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid goal owner directory")
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		return path.join(directory, GOAL_ACCOUNTING_OWNER_FILE)
	}

	private async readFile(file: string): Promise<GoalAccountingOwnerEnvelope | undefined> {
		try {
			const stat = await fs.lstat(file)
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid goal owner file")
			const envelope = envelopeSchema.parse(JSON.parse(await fs.readFile(file, "utf8")))
			if (envelope.taskId !== this.taskId) throw new Error("Goal owner belongs to another child task")
			return envelope
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
			throw error
		}
	}

	async read(): Promise<GoalAccountingOwnerEnvelope | undefined> {
		return this.readFile(await this.filePath())
	}

	async save(
		binding:
			| (Pick<GoalAccountingBinding, "goalTaskId" | "goalId" | "controlVersion"> & { drainOnly?: boolean })
			| undefined,
	): Promise<void> {
		const owner = binding
			? ownerSchema.parse({
					goalTaskId: binding.goalTaskId,
					goalId: binding.goalId,
					controlVersion: binding.controlVersion,
					drainOnly: binding.drainOnly,
				})
			: null
		const file = await this.filePath()
		await withFileLock(file, async () => {
			if ((await this.filePath()) !== file) throw new Error("Goal owner path changed while acquiring its lock")
			const existing = await this.readFile(file)
			if (existing) {
				if (JSON.stringify(existing.owner) !== JSON.stringify(owner))
					throw new Error("A child's goal owner cannot be replaced")
				return
			}
			await atomicWriteJson(
				file,
				{ schemaVersion: 1, taskId: this.taskId, owner },
				{ requireAtomicReplace: true },
			)
		})
	}
}
