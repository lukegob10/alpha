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
	const followedLinks = new Set<string>()
	let currentPath = absolutePath

	while (true) {
		try {
			return path.join(fs.realpathSync(currentPath), ...missingSegments.reverse())
		} catch (error) {
			// realpath cannot resolve dangling links. Inspect the link itself before
			// treating it as a missing suffix, or an outside write target looks local.
			const metadata = fs.lstatSync(currentPath, { throwIfNoEntry: false })
			if (metadata?.isSymbolicLink()) {
				const linkKey = process.platform === "win32" ? currentPath.toLowerCase() : currentPath
				if (followedLinks.has(linkKey) || followedLinks.size >= 40) {
					throw new Error("Too many symbolic links while resolving workspace path")
				}
				followedLinks.add(linkKey)
				currentPath = path.resolve(path.dirname(currentPath), fs.readlinkSync(currentPath))
				continue
			}
			if (metadata) throw error

			const parentPath = path.dirname(currentPath)
			if (parentPath === currentPath) {
				throw error
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

	try {
		const canonicalRoot = resolvePathWithExistingAncestor(absoluteRoot)
		const canonicalCandidate = resolvePathWithExistingAncestor(absoluteCandidate)
		const canonicalRelative = path.relative(canonicalRoot, canonicalCandidate)
		return !isRelativePathOutsideRoot(canonicalRelative)
	} catch {
		return false
	}
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
