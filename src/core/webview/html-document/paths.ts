import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

function hasControlCharacters(value: string): boolean {
	return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function fail(code: "scope" | "missing" | "path"): never {
	throw new Error(code)
}

function contains(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function localAbsolute(value: string): boolean {
	return (
		path.isAbsolute(value) && !value.startsWith("\\\\") && !value.startsWith("//") && !hasControlCharacters(value)
	)
}

async function canonicalRoot(root: string): Promise<string> {
	if (!localAbsolute(root)) fail("scope")
	try {
		const canonical = await fs.realpath(root)
		if (!(await fs.stat(canonical)).isDirectory()) fail("scope")
		return canonical
	} catch {
		return fail("scope")
	}
}

async function canonicalFileInner(candidate: string, root: string, allowMissing: boolean): Promise<string> {
	try {
		const canonical = await fs.realpath(candidate)
		if (!contains(root, canonical)) fail("scope")
		if (!(await fs.stat(canonical)).isFile()) fail("path")
		return canonical
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}

	// Resolve the closest existing ancestor even for a deleted document. Lexical
	// containment alone would allow a missing file beneath an escaping symlink.
	let ancestor = candidate
	const suffix: string[] = []
	while (true) {
		try {
			const canonical = await fs.realpath(ancestor)
			if (!contains(root, canonical)) fail("scope")
			if (!(await fs.stat(canonical)).isDirectory()) fail("path")
			if (!allowMissing) fail("missing")
			return path.join(canonical, ...suffix.reverse())
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		try {
			// A dangling symlink has no canonical destination and is never treated
			// as an ordinary missing document or directory.
			if ((await fs.lstat(ancestor)).isSymbolicLink()) fail("scope")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		const parent = path.dirname(ancestor)
		if (parent === ancestor) fail("scope")
		suffix.push(path.basename(ancestor))
		ancestor = parent
	}
}

async function canonicalFile(candidate: string, root: string, allowMissing: boolean): Promise<string> {
	try {
		return await canonicalFileInner(candidate, root, allowMissing)
	} catch (error) {
		if (error instanceof Error && ["path", "scope", "missing"].includes(error.message)) throw error
		return fail("path")
	}
}

function documentFilePath(uri: string): string {
	if (typeof uri !== "string" || uri.length > 8192 || hasControlCharacters(uri) || uri.includes("\\")) fail("path")
	try {
		// Reject authorities before URL normalizes file://localhost to file:///.
		const authority = /^file:\/\/([^/]*)/i.exec(uri)
		if (!authority || authority[1] !== "") fail("path")
		const decoded = decodeURIComponent(uri.slice("file://".length))
		if (
			hasControlCharacters(decoded) ||
			decoded.includes("\\") ||
			decoded.split("/").some((part) => part === "..")
		) {
			fail("path")
		}
		const parsed = new URL(uri)
		if (parsed.protocol !== "file:" || parsed.host || uri.includes("?") || uri.includes("#")) fail("path")
		const candidate = fileURLToPath(parsed)
		if (candidate.length > 2048 || !localAbsolute(candidate) || !/\.html?$/i.test(candidate)) fail("path")
		if (process.platform === "win32" && candidate.slice(path.parse(candidate).root.length).includes(":"))
			fail("path")
		return candidate
	} catch {
		return fail("path")
	}
}

export async function resolveDocumentPath(
	uri: string,
	roots: readonly string[],
	allowMissing = false,
): Promise<{ uri: string; fsPath: string; root: string }> {
	const candidate = documentFilePath(uri)
	const matchingRoots: string[] = []
	for (const suppliedRoot of roots) {
		if (!localAbsolute(suppliedRoot)) continue
		try {
			const root = await canonicalRoot(suppliedRoot)
			if (contains(path.resolve(suppliedRoot), candidate) || contains(root, candidate)) matchingRoots.push(root)
		} catch {
			// A disconnected or deleted workspace must not block other roots.
		}
	}
	// Nested workspaces use the narrowest canonical root, independent of UI order.
	matchingRoots.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b))
	const root = matchingRoots[0]
	if (!root) return fail("scope")
	const fsPath = await canonicalFile(candidate, root, allowMissing)
	if (!/\.html?$/i.test(fsPath)) fail("path")
	return { uri: pathToFileURL(fsPath).toString(), fsPath, root }
}

/** Source references use forward-slash, workspace-root-relative paths only. */
export async function resolveSourcePath(root: string, relativePath: string): Promise<string> {
	if (
		typeof relativePath !== "string" ||
		!relativePath ||
		relativePath.length > 2048 ||
		hasControlCharacters(relativePath) ||
		/[\\:]/.test(relativePath) ||
		relativePath.startsWith("/") ||
		relativePath.split("/").some((part) => part === ".." || part === "." || !part)
	) {
		fail("path")
	}
	const canonical = await canonicalRoot(root)
	return canonicalFile(path.join(canonical, ...relativePath.split("/")), canonical, false)
}
