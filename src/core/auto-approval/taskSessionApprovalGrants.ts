import { createHash } from "crypto"
import stringify from "safe-stable-stringify"

import type { AlphaAsk } from "@alpha-code/types"

const MAX_TASK_SESSION_APPROVAL_GRANTS = 128
const MAX_APPROVAL_IDENTITY_BYTES = 64 * 1024

export interface TaskSessionApprovalIdentity {
	taskId: string
	toolName: string
	askType: AlphaAsk
	description?: string
	argumentsValue: unknown
	cwd?: string
	policyDigest?: string
}

const grants = new Map<string, string>()

/**
 * Build an opaque task-session key for one exact reviewed tool request.
 * The key binds the command text, complete tool arguments, and working directory.
 */
export function createTaskSessionApprovalKey(identity: TaskSessionApprovalIdentity): string | undefined {
	if (
		!identity.taskId ||
		identity.taskId.length > 512 ||
		!identity.toolName ||
		identity.toolName.length > 128 ||
		!identity.cwd ||
		(identity.description?.length ?? 0) > 100_000 ||
		(identity.cwd?.length ?? 0) > 4096
	) {
		return undefined
	}

	const serialized = stringify([
		identity.taskId,
		identity.toolName,
		identity.askType,
		identity.description ?? null,
		identity.argumentsValue,
		identity.cwd ?? null,
		identity.policyDigest ?? null,
	])
	if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_APPROVAL_IDENTITY_BYTES) return undefined

	return createHash("sha256").update(serialized).digest("hex")
}

export function hasTaskSessionApproval(key: string): boolean {
	if (!grants.has(key)) return false
	const taskId = grants.get(key)!
	grants.delete(key)
	grants.set(key, taskId)
	return true
}

/** Save only while the approval is still live; command text is never retained. */
export function grantTaskSessionApproval(key: string, taskId: string, signal: AbortSignal): boolean {
	if (signal.aborted || !/^[a-f0-9]{64}$/.test(key) || !taskId || taskId.length > 512) return false

	grants.delete(key)
	grants.set(key, taskId)
	while (grants.size > MAX_TASK_SESSION_APPROVAL_GRANTS) {
		const oldestKey = grants.keys().next().value
		if (oldestKey === undefined) break
		grants.delete(oldestKey)
	}
	return true
}

export function clearTaskSessionApprovalGrants(taskId: string): void {
	for (const [key, grantTaskId] of grants) {
		if (grantTaskId === taskId) grants.delete(key)
	}
}
