import fs from "fs/promises"
import path from "path"

const MAX_CHANGED_PATHS = 256
const MAX_PATH_LENGTH = 4_096
const MAX_MANIFEST_BYTES = 256 * 1_024
const MAX_ANCESTORS = 32

export const verificationRequirementKinds = ["test", "types", "lint"] as const
export type VerificationRequirement = (typeof verificationRequirementKinds)[number]
export type VerificationRequirements = Record<string, VerificationRequirement[]>

const PROSE_AND_ASSET_EXTENSIONS = new Set([
	".md",
	".markdown",
	".mdx",
	".txt",
	".rst",
	".adoc",
	".asciidoc",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".ico",
	".bmp",
	".tif",
	".tiff",
	".avif",
	".heic",
	".mp3",
	".wav",
	".ogg",
	".oga",
	".flac",
	".m4a",
	".aac",
	".opus",
	".aiff",
	".mid",
	".midi",
	".mp4",
	".mov",
	".avi",
	".mkv",
	".webm",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".map",
])

const PROSE_AND_ASSET_BASENAMES = new Set(["readme", "license", "copying", "changelog", "notice"])

export class VerificationRequirementsError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "VerificationRequirementsError"
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

function containsPath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function resolveContainedPath(root: string, candidate: string): string {
	if (!candidate || candidate.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(candidate)) {
		throw new VerificationRequirementsError("Invalid verification path")
	}
	const absolute = path.resolve(root, candidate)
	if (!containsPath(root, absolute)) {
		throw new VerificationRequirementsError("Verification path is outside the workspace")
	}
	return absolute
}

/**
 * Verify a path even when its leaf is missing. Walking existing ancestors
 * catches a missing file below a symlink that resolves outside the workspace.
 */
async function assertContainedRealPath(root: string, absolute: string): Promise<void> {
	try {
		const real = await fs.realpath(absolute)
		if (!containsPath(root, real)) {
			throw new VerificationRequirementsError("Verification path resolves outside the workspace")
		}
		return
	} catch (error) {
		if (!isMissing(error)) throw error
	}

	let cursor = absolute
	while (true) {
		try {
			const stat = await fs.lstat(cursor)
			let real: string
			try {
				real = await fs.realpath(cursor)
			} catch (error) {
				if (stat.isSymbolicLink() && isMissing(error)) {
					throw new VerificationRequirementsError("Verification path contains an unresolved symlink")
				}
				throw error
			}
			if (!containsPath(root, real)) {
				throw new VerificationRequirementsError("Verification path resolves outside the workspace")
			}
			return
		} catch (error) {
			if (!isMissing(error)) throw error
			if (cursor === root) throw error
			const parent = path.dirname(cursor)
			if (parent === cursor) throw error
			cursor = parent
		}
	}
}

async function readBoundedPackageJson(root: string, manifestPath: string): Promise<unknown | undefined> {
	let realManifest: string
	try {
		realManifest = await fs.realpath(manifestPath)
	} catch (error) {
		if (!isMissing(error)) throw error
		try {
			const stat = await fs.lstat(manifestPath)
			if (stat.isSymbolicLink()) {
				throw new VerificationRequirementsError("package.json is an unresolved symlink")
			}
		} catch (statError) {
			if (!isMissing(statError)) throw statError
		}
		return undefined
	}

	if (!containsPath(root, realManifest)) {
		throw new VerificationRequirementsError("package.json resolves outside the workspace")
	}

	const handle = await fs.open(realManifest, "r")
	try {
		const before = await handle.stat()
		if (!before.isFile() || before.size > MAX_MANIFEST_BYTES) {
			throw new VerificationRequirementsError("package.json is not a bounded regular file")
		}

		const buffer = Buffer.alloc(before.size + 1)
		let bytesRead = 0
		while (bytesRead < buffer.length) {
			const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
			if (result.bytesRead === 0) break
			bytesRead += result.bytesRead
		}
		const after = await handle.stat()
		const currentRealManifest = await fs.realpath(manifestPath)
		const current = await fs.stat(currentRealManifest)
		if (
			bytesRead !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			currentRealManifest !== realManifest ||
			current.dev !== before.dev ||
			current.ino !== before.ino ||
			current.size !== before.size ||
			current.mtimeMs !== before.mtimeMs
		) {
			throw new VerificationRequirementsError("package.json changed while it was being observed")
		}

		try {
			return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown
		} catch {
			throw new VerificationRequirementsError("package.json is not valid JSON")
		}
	} finally {
		await handle.close()
	}
}

async function nearestPackageJson(root: string, startingDirectory: string): Promise<unknown | undefined> {
	let cursor = startingDirectory
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		await assertContainedRealPath(root, cursor)
		const manifest = await readBoundedPackageJson(root, path.join(cursor, "package.json"))
		if (manifest !== undefined) return manifest
		if (cursor === root) return undefined
		const parent = path.dirname(cursor)
		if (parent === cursor) return undefined
		cursor = parent
	}
	throw new VerificationRequirementsError("Verification package ancestor traversal exceeds the bound")
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requirementsFromManifest(manifest: unknown): VerificationRequirement[] {
	if (!isRecord(manifest) || !isRecord(manifest.scripts)) return []
	const found = new Set<VerificationRequirement>()
	for (const [name, value] of Object.entries(manifest.scripts)) {
		if (typeof value !== "string") continue
		if (name === "test" || name.startsWith("test:")) found.add("test")
		if (name === "check-types" || name === "typecheck") found.add("types")
		if (name === "lint") found.add("lint")
	}
	return verificationRequirementKinds.filter((kind) => found.has(kind))
}

function isProseOrAsset(relativePath: string): boolean {
	const normalized = relativePath.replaceAll("\\", "/").toLowerCase()
	const basename = path.posix.basename(normalized)
	const extension = path.posix.extname(basename)
	return PROSE_AND_ASSET_BASENAMES.has(basename) || PROSE_AND_ASSET_EXTENSIONS.has(extension)
}

/**
 * Derive the named checks declared by the nearest package for each changed
 * workspace path. Manifest content is observed as bounded data; no scripts or
 * prose files are executed or interpreted as policy.
 */
export async function resolveVerificationRequirements(
	workspaceRoot: string,
	changedFiles: readonly string[],
): Promise<VerificationRequirements> {
	if (changedFiles.length > MAX_CHANGED_PATHS) {
		throw new VerificationRequirementsError("Verification path count exceeds the bound")
	}

	const root = await fs.realpath(workspaceRoot)
	const result: VerificationRequirements = {}
	const resolved = new Map<string, string>()
	for (const candidate of changedFiles) {
		if (typeof candidate !== "string") throw new VerificationRequirementsError("Invalid verification path")
		const absolute = resolveContainedPath(root, candidate)
		await assertContainedRealPath(root, absolute)
		const relative = path.relative(root, absolute).split(path.sep).join("/")
		if (!relative) throw new VerificationRequirementsError("A changed path must identify a workspace file")
		resolved.set(relative, absolute)
	}

	for (const [relative, absolute] of [...resolved.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		if (isProseOrAsset(relative)) {
			Object.defineProperty(result, relative, { value: [], enumerable: true, configurable: true, writable: true })
			continue
		}
		const manifest = await nearestPackageJson(root, path.dirname(absolute))
		Object.defineProperty(result, relative, {
			value: requirementsFromManifest(manifest),
			enumerable: true,
			configurable: true,
			writable: true,
		})
	}
	return result
}
