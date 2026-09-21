import * as fsSync from "fs"
import * as path from "path"

import { getReadablePath } from "../../utils/path"
import { isPathWithinRoot } from "./pathSafety"

export type TaskPathContext = {
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
		const absolutePath = resolveTaskWorkspacePath(task, relPath)
		if (isWithin(task.cwd, absolutePath)) {
			const relative = path.relative(task.cwd, absolutePath)
			return relative ? relative.toPosix() : "."
		}
	}

	return getReadablePath(task.cwd, relPath)
}

/**
 * Map a worker path onto the private worktree when it names a file in the
 * opened folder / history workspace. Absolute logical paths stay in-scope after
 * rewrite; junctions that escape the worktree remain outside.
 */
export function resolveTaskWorkspacePath(task: TaskPathContext, candidate: string): string {
	const absolutePath = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(task.cwd, candidate)
	if (
		isManagedWorker(task) &&
		task.historyWorkspacePath &&
		isWithin(task.historyWorkspacePath, absolutePath) &&
		!isWithin(task.cwd, absolutePath)
	) {
		return path.resolve(task.cwd, path.relative(task.historyWorkspacePath, absolutePath))
	}
	return absolutePath
}

const PATCH_DESTINATION_MARKERS = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "] as const

function presentRemappedTaskPath(task: TaskPathContext, candidate: string): string {
	const remapped = resolveTaskWorkspacePath(task, candidate)
	const naive = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(task.cwd, candidate)
	if (path.resolve(remapped) === path.resolve(naive)) return candidate
	if (isWithin(task.cwd, remapped)) {
		const relative = path.relative(task.cwd, remapped)
		return relative ? relative.split(path.sep).join("/") : "."
	}
	return remapped
}

function remapNestedPathEntries(task: TaskPathContext, value: unknown): unknown {
	if (!Array.isArray(value)) return value
	return value.map((entry) => {
		if (!entry || typeof entry !== "object") return entry
		const record = entry as Record<string, unknown>
		if (typeof record.path !== "string") return entry
		return { ...record, path: presentRemappedTaskPath(task, record.path) }
	})
}

function remapPatchDestinations(task: TaskPathContext, patch: string): string {
	return patch
		.split(/\r?\n/)
		.map((line) => {
			const marker = PATCH_DESTINATION_MARKERS.find((prefix) => line.startsWith(prefix))
			if (!marker) return line
			return `${marker}${presentRemappedTaskPath(task, line.slice(marker.length))}`
		})
		.join("\n")
}

/**
 * Rewrite worker file-tool arguments onto the private worktree before policy,
 * identity capture, mutation tracking, and dispatch share one execution path.
 * Shell command text is never rewritten; only an explicit cwd is remapped.
 */
export function normalizeTaskToolArguments(
	task: TaskPathContext,
	toolName: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (!isManagedWorker(task) || !task.historyWorkspacePath || typeof task.cwd !== "string" || !task.cwd) {
		return args
	}

	if (toolName === "shell") {
		if (typeof args.cwd !== "string") return args
		const cwd = presentRemappedTaskPath(task, args.cwd)
		return cwd === args.cwd ? args : { ...args, cwd }
	}

	const next = { ...args }
	for (const key of ["path", "file_path", "cwd", "directory", "image"] as const) {
		if (typeof next[key] === "string") next[key] = presentRemappedTaskPath(task, next[key])
	}
	if ("files" in next) next.files = remapNestedPathEntries(task, next.files)
	if ("queries" in next) next.queries = remapNestedPathEntries(task, next.queries)
	if (toolName === "apply_patch" && typeof next.patch === "string") {
		next.patch = remapPatchDestinations(task, next.patch)
	}
	return next
}

/** Scope approvals to this task, including junctions, independently of the foreground VS Code workspace. */
export function isTaskPathOutsideWorkspace(task: TaskPathContext, absolutePath: string): boolean {
	return !isWithin(task.cwd, resolveTaskWorkspacePath(task, absolutePath))
}

export function isWorkerWritePathAllowed(
	task: TaskPathContext & {
		subagentWriteScope?: string[]
		subagentAuthority?: { role?: string; fileWriteScope?: string[] }
	},
	candidate: string,
): boolean {
	if (!task.subagentWriteScope?.length) return false
	const rewritten = resolveTaskWorkspacePath(task, candidate)
	if (!isWithin(task.cwd, rewritten)) return false

	const relative = path.relative(task.cwd, rewritten).split(path.sep).join("/")
	if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return false
	const fileScopes = task.subagentAuthority?.role === "worker" ? (task.subagentAuthority.fileWriteScope ?? []) : []
	const allowed = task.subagentWriteScope.some(
		(scope) => relative === scope || (!fileScopes.includes(scope) && relative.startsWith(`${scope}/`)),
	)
	if (!allowed) return false

	let existing = rewritten
	while (!fsSync.existsSync(existing)) {
		const parent = path.dirname(existing)
		if (parent === existing) return false
		existing = parent
	}
	try {
		const realWorkspace = fsSync.realpathSync(task.cwd)
		const realExisting = fsSync.realpathSync(existing)
		const realRelative = path.relative(realWorkspace, realExisting)
		if (realRelative === "" || (!realRelative.startsWith("..") && !path.isAbsolute(realRelative))) {
			if (
				task.historyWorkspacePath &&
				fsSync.existsSync(task.historyWorkspacePath) &&
				fsSync.realpathSync(task.historyWorkspacePath) === realExisting &&
				fsSync.realpathSync(task.historyWorkspacePath) !== realWorkspace
			) {
				return false
			}
			return true
		}
		return false
	} catch {
		return false
	}
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
