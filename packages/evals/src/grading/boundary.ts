import * as path from "path"
import * as fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"

export class HiddenGraderBoundaryError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "HiddenGraderBoundaryError"
	}
}

export function assertHiddenGraderBoundary(options: {
	workspaceRoot: string
	hiddenRoot: string
	trackedPaths?: string[]
}): void {
	const workspace = path.resolve(options.workspaceRoot)
	const hidden = path.resolve(options.hiddenRoot)
	if (isWithin(workspace, hidden) || isWithin(hidden, workspace)) {
		throw new HiddenGraderBoundaryError("Hidden grader root and agent workspace must be disjoint")
	}
	for (const trackedPath of options.trackedPaths ?? []) {
		const tracked = path.resolve(trackedPath)
		if (isWithin(hidden, tracked)) {
			throw new HiddenGraderBoundaryError(`Hidden grader asset is Git-visible: ${trackedPath}`)
		}
	}
}

/** Resolve aliases before a hidden command launch; lexical disjointness alone cannot establish isolation. */
export async function resolveHiddenGraderBoundary(options: {
	workspaceRoot: string
	hiddenRoot: string
}): Promise<{ workspaceRoot: string; hiddenRoot: string }> {
	assertHiddenGraderBoundary(options)
	const [workspaceRoot, hiddenRoot] = await Promise.all([
		fs.realpath(options.workspaceRoot),
		fs.realpath(options.hiddenRoot),
	])
	assertHiddenGraderBoundary({ workspaceRoot, hiddenRoot })
	const stats = await Promise.all([fs.lstat(workspaceRoot), fs.lstat(hiddenRoot)])
	if (stats.some((stat) => !stat.isDirectory() || stat.isSymbolicLink()))
		throw new HiddenGraderBoundaryError("Grader roots must be existing directories")
	return { workspaceRoot, hiddenRoot }
}

export function resolveContained(root: string, relativePath: string): string {
	const resolvedRoot = path.resolve(root)
	const resolved = path.resolve(resolvedRoot, relativePath)
	if (!isWithin(resolvedRoot, resolved))
		throw new HiddenGraderBoundaryError(`Path escapes grader root: ${relativePath}`)
	return resolved
}

async function inspectContainedFile(
	root: string,
	relative: string,
): Promise<{ file: string; stat: Stats } | undefined> {
	let file = root
	let stat = await fs.lstat(root)
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new HiddenGraderBoundaryError("Grader workspace must be an existing directory")
	for (const component of relative.split(path.sep).filter(Boolean)) {
		file = path.join(file, component)
		try {
			stat = await fs.lstat(file)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
			throw error
		}
		// lstat observes the link itself, including Windows junctions and dangling links.
		if (stat.isSymbolicLink())
			throw new HiddenGraderBoundaryError("Grader evidence paths cannot contain symbolic links or junctions")
	}
	if (!stat.isFile()) throw new HiddenGraderBoundaryError("Grader evidence must be a regular file")
	return { file, stat }
}

function sameFile(before: Stats, after: Stats): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.size === after.size &&
		before.mtimeMs === after.mtimeMs &&
		before.ctimeMs === after.ctimeMs
	)
}

/** One contained read for both file graders; unknown access and path races cannot prove absence or success. */
export async function readContainedFile(root: string, relativePath: string): Promise<string | undefined> {
	const lexicalRoot = path.resolve(root)
	const candidate = resolveContained(lexicalRoot, relativePath)
	const canonicalRoot = await fs.realpath(lexicalRoot)
	const relative = path.relative(lexicalRoot, candidate)
	const before = await inspectContainedFile(canonicalRoot, relative)
	if (!before) return undefined
	const handle = await fs.open(before.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
	try {
		const opened = await handle.stat()
		const current = await inspectContainedFile(canonicalRoot, relative)
		if (!sameFile(before.stat, opened) || !current || !sameFile(current.stat, opened))
			throw new HiddenGraderBoundaryError("Grader evidence changed before capture")
		const contents = await handle.readFile("utf8")
		const after = await handle.stat()
		const retained = await inspectContainedFile(canonicalRoot, relative)
		if (
			!sameFile(opened, after) ||
			!retained ||
			!sameFile(retained.stat, after) ||
			(await fs.realpath(lexicalRoot)) !== canonicalRoot
		)
			throw new HiddenGraderBoundaryError("Grader evidence changed during capture")
		return contents
	} finally {
		await handle.close()
	}
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
