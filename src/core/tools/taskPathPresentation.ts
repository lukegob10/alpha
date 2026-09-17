import * as path from "path"

import { getReadablePath } from "../../utils/path"
import { isPathWithinRoot } from "./pathSafety"

type TaskPathContext = {
	taskKind?: "primary" | "subagent"
	subagentRole?: string
	cwd: string
	historyWorkspacePath?: string
	subagentPrivateWorkspaceRoot?: string
}

function isManagedWorker(task: TaskPathContext): boolean {
	return task.taskKind === "subagent" && task.subagentRole === "worker"
}

function isWithin(root: string, candidate: string): boolean {
	return isPathWithinRoot(root, candidate)
}

/**
 * Present managed-worker paths as logical workspace paths. The private worktree is
 * an execution detail and must never become part of the persisted transcript.
 */
export function getTaskReadablePath(task: TaskPathContext, relPath?: string): string {
	if (isManagedWorker(task) && relPath !== undefined) {
		const absolutePath = path.resolve(task.cwd, relPath)
		if (isWithin(task.cwd, absolutePath)) {
			const relative = path.relative(task.cwd, absolutePath)
			return relative ? relative.toPosix() : "."
		}
	}

	return getReadablePath(task.cwd, relPath)
}

/** Scope approvals to this task, including junctions, independently of the foreground VS Code workspace. */
export function isTaskPathOutsideWorkspace(task: TaskPathContext, absolutePath: string): boolean {
	return !isWithin(task.cwd, absolutePath)
}

/** Map a private worktree path to the corresponding user-workspace path for UI navigation. */
export function getTaskDisplayPath(task: TaskPathContext, absolutePath: string): string {
	if (isManagedWorker(task) && task.historyWorkspacePath && isWithin(task.cwd, absolutePath)) {
		return path.resolve(task.historyWorkspacePath, path.relative(task.cwd, absolutePath))
	}
	return absolutePath
}

function replaceLiteral(value: string, search: string, replacement: string): string {
	if (!search) return value
	const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	return value.replace(new RegExp(escaped, process.platform === "win32" ? "gi" : "g"), replacement)
}

/** Defense in depth for errors and command output that may contain an execution-only path. */
export function redactTaskPrivatePaths(task: TaskPathContext, value: string): string {
	if (!isManagedWorker(task)) return value

	const variants = new Set<string>()
	for (const privatePath of [task.cwd, task.subagentPrivateWorkspaceRoot]) {
		if (!privatePath) continue
		variants.add(path.normalize(privatePath))
		variants.add(path.normalize(privatePath).toPosix())
	}

	return [...variants]
		.sort((left, right) => right.length - left.length)
		.reduce((redacted, privatePath) => replaceLiteral(redacted, privatePath, "."), value)
}
