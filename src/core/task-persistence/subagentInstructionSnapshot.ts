import * as fs from "fs/promises"
import * as path from "path"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { resolveExistingTaskDirectoryPathReadOnly } from "../../utils/storage"
import { digestValue } from "../agent/StepContext"
import { atomicWriteJson, withFileLock } from "./atomicWrite"

const SUBAGENT_INSTRUCTION_SNAPSHOT_VERSION = 1 as const

interface SubagentInstructionSnapshot {
	version: typeof SUBAGENT_INSTRUCTION_SNAPSHOT_VERSION
	digest: string
	instructions: string
}

export function assertFrozenSubagentInstructions(instructions: string, expectedDigest: string): void {
	if (typeof instructions !== "string" || digestValue(instructions) !== expectedDigest) {
		throw new Error("Managed child frozen instruction snapshot failed integrity validation")
	}
}

async function resolveSnapshotFilePath(globalStoragePath: string, taskId: string): Promise<string> {
	const taskDir = await resolveExistingTaskDirectoryPathReadOnly(globalStoragePath, taskId)
	// The shared resolver validates existing task directories. A missing child
	// also needs its parent checked before the writer creates any directories.
	try {
		const tasksRoot = await fs.lstat(path.dirname(taskDir))
		if (!tasksRoot.isDirectory() || tasksRoot.isSymbolicLink()) {
			throw new Error("Task storage path is not a regular directory")
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	return path.join(taskDir, GlobalFileNames.subagentInstructionSnapshot)
}

export async function saveSubagentInstructionSnapshot({
	taskId,
	globalStoragePath,
	instructions,
	expectedDigest,
}: {
	taskId: string
	globalStoragePath: string
	instructions: string
	expectedDigest: string
}): Promise<void> {
	assertFrozenSubagentInstructions(instructions, expectedDigest)
	const filePath = await resolveSnapshotFilePath(globalStoragePath, taskId)
	const snapshot: SubagentInstructionSnapshot = {
		version: SUBAGENT_INSTRUCTION_SNAPSHOT_VERSION,
		digest: expectedDigest,
		instructions,
	}
	await withFileLock(filePath, async () => {
		const existing = await readSnapshotFromPath(filePath, expectedDigest)
		// The first durable boundary owns this child. Launch retries validate
		// that boundary rather than silently replacing it or repairing corruption.
		if (existing !== undefined) {
			if (existing !== instructions) {
				throw new Error("Managed child frozen instruction snapshot failed integrity validation")
			}
			return
		}
		await atomicWriteJson(filePath, snapshot, { requireAtomicReplace: true })
	})
}

export async function readSubagentInstructionSnapshot({
	taskId,
	globalStoragePath,
	expectedDigest,
}: {
	taskId: string
	globalStoragePath: string
	expectedDigest: string
}): Promise<string | undefined> {
	const filePath = await resolveSnapshotFilePath(globalStoragePath, taskId)
	return readSnapshotFromPath(filePath, expectedDigest)
}

async function readSnapshotFromPath(filePath: string, expectedDigest: string): Promise<string | undefined> {
	let stats: Awaited<ReturnType<typeof fs.lstat>>
	try {
		stats = await fs.lstat(filePath)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw new Error("Managed child frozen instruction snapshot is unreadable")
	}
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error("Managed child frozen instruction snapshot is invalid")
	}

	let value: unknown
	try {
		value = JSON.parse(await fs.readFile(filePath, "utf8"))
	} catch {
		throw new Error("Managed child frozen instruction snapshot is unreadable")
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Managed child frozen instruction snapshot is invalid")
	}
	const snapshot = value as Record<string, unknown>
	if (
		Object.keys(snapshot).some((key) => !["version", "digest", "instructions"].includes(key)) ||
		snapshot.version !== SUBAGENT_INSTRUCTION_SNAPSHOT_VERSION ||
		typeof snapshot.digest !== "string" ||
		typeof snapshot.instructions !== "string" ||
		snapshot.digest !== expectedDigest
	) {
		throw new Error("Managed child frozen instruction snapshot is invalid")
	}

	assertFrozenSubagentInstructions(snapshot.instructions, expectedDigest)
	return snapshot.instructions
}
