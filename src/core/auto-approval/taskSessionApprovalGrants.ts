import { createHash } from "crypto"
import stringify from "safe-stable-stringify"
import path from "path"

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
	/** Host-captured path or other execution authority beyond model arguments. */
	authorityValue?: unknown
}

const grants = new Map<string, string>()

function reviewedArguments(identity: TaskSessionApprovalIdentity): unknown {
	const value = identity.argumentsValue
	if (
		identity.askType !== "command" ||
		(identity.toolName !== "exec_command" && identity.toolName !== "execute_command") ||
		!value ||
		typeof value !== "object" ||
		Array.isArray(value)
	)
		return value
	const args = value as Record<string, unknown>
	if (typeof args.cmd !== "string" && typeof args.command !== "string") return value
	// Ambiguous historical/malformed shapes retain their complete reviewed identity.
	if ((args.cmd != null && args.command != null) || (args.workdir != null && args.cwd != null)) return value
	if (
		(args.workdir != null && typeof args.workdir !== "string") ||
		(args.cwd != null && typeof args.cwd !== "string")
	)
		return value
	const normalized = { ...args }
	// Codex UnifiedExecApprovalKey excludes output/wait controls; authority remains exact.
	delete normalized.yield_time_ms
	delete normalized.max_output_tokens
	delete normalized.workdir
	delete normalized.cwd
	return {
		...normalized,
		cwd: path.resolve(identity.cwd!, (args.workdir ?? args.cwd ?? ".") as string),
		tty: args.tty ?? false,
	}
}

/**
 * Build an opaque task-session key for one exact reviewed tool request.
 * Command keys omit presentation controls; other tools bind their complete arguments.
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
		reviewedArguments(identity),
		identity.cwd ?? null,
		identity.policyDigest ?? null,
		identity.authorityValue ?? null,
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
