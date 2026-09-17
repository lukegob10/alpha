import fs from "fs"
import path from "path"

function isRelativePathOutsideRoot(relativePath: string): boolean {
	return path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)
}

/**
 * Resolve symlinks and junctions even when the final path does not exist yet.
 * The nearest existing ancestor is canonicalized and the missing suffix is
 * appended again without consulting the filesystem.
 */
export function resolvePathWithExistingAncestor(candidatePath: string): string {
	const absolutePath = path.resolve(candidatePath)
	const missingSegments: string[] = []
	let currentPath = absolutePath

	while (true) {
		try {
			return path.join(fs.realpathSync(currentPath), ...missingSegments.reverse())
		} catch {
			const parentPath = path.dirname(currentPath)
			if (parentPath === currentPath) {
				return absolutePath
			}

			missingSegments.push(path.basename(currentPath))
			currentPath = parentPath
		}
	}
}

export function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
	const absoluteRoot = path.resolve(rootPath)
	const absoluteCandidate = path.resolve(candidatePath)
	const lexicalRelative = path.relative(absoluteRoot, absoluteCandidate)

	if (isRelativePathOutsideRoot(lexicalRelative)) {
		return false
	}

	const canonicalRoot = resolvePathWithExistingAncestor(absoluteRoot)
	const canonicalCandidate = resolvePathWithExistingAncestor(absoluteCandidate)
	const canonicalRelative = path.relative(canonicalRoot, canonicalCandidate)
	return !isRelativePathOutsideRoot(canonicalRelative)
}

export function getPathRelativeToRoot(rootPath: string, candidatePath: string): string | undefined {
	const absoluteRoot = path.resolve(rootPath)
	const absoluteCandidate = path.resolve(candidatePath)
	const relativePath = path.relative(absoluteRoot, absoluteCandidate)

	if (isRelativePathOutsideRoot(relativePath)) {
		return undefined
	}

	return relativePath.replace(/\\/g, "/")
}
