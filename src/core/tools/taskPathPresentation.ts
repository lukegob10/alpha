import * as path from "path"

import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"

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
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
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

/** Check paths against the worker's isolated logical root rather than VS Code's foreground workspace. */
export function isTaskPathOutsideWorkspace(task: TaskPathContext, absolutePath: string): boolean {
	if (isManagedWorker(task)) return !isWithin(task.cwd, absolutePath)
	return isPathOutsideWorkspace(absolutePath)
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
