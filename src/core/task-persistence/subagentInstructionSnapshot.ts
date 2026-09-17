import * as fs from "fs/promises"
import * as path from "path"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { fileExistsAtPath } from "../../utils/fs"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { getTaskDirectoryPath } from "../../utils/storage"
import { digestValue } from "../agent/StepContext"

const SUBAGENT_INSTRUCTION_SNAPSHOT_VERSION = 1 as const

interface SubagentInstructionSnapshot {
	version: typeof SUBAGENT_INSTRUCTION_SNAPSHOT_VERSION
	digest: string
	instructions: string
}

export function assertFrozenSubagentInstructions(instructions: string, expectedDigest: string): void {
	if (!instructions.trim() || digestValue(instructions) !== expectedDigest) {
		throw new Error("Managed child frozen instruction snapshot failed integrity validation")
	}
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
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.subagentInstructionSnapshot)
	const snapshot: SubagentInstructionSnapshot = {
		version: SUBAGENT_INSTRUCTION_SNAPSHOT_VERSION,
		digest: expectedDigest,
		instructions,
	}
	await safeWriteJson(filePath, snapshot)
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
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.subagentInstructionSnapshot)
	if (!(await fileExistsAtPath(filePath))) return undefined

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
