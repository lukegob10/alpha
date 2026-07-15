import * as path from "path"

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

export function resolveContained(root: string, relativePath: string): string {
	const resolvedRoot = path.resolve(root)
	const resolved = path.resolve(resolvedRoot, relativePath)
	if (!isWithin(resolvedRoot, resolved))
		throw new HiddenGraderBoundaryError(`Path escapes grader root: ${relativePath}`)
	return resolved
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
