import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

export const EVIDENCE_ROOT_MARKER = ".alpha-vscode-e2e-evidence-root.json"
export const EVIDENCE_RUN_MARKER = ".alpha-vscode-e2e-evidence-run.json"
const ROOT_MARKER = JSON.stringify({ kind: "alpha-vscode-e2e-evidence-root", version: 1 })

export function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function assertSafeRoot(candidate: string): string {
	if (!path.isAbsolute(candidate)) throw new Error("Evidence paths must be absolute")
	const resolved = path.resolve(candidate)
	if (resolved === path.parse(resolved).root || path.relative(os.homedir(), resolved) === "") {
		throw new Error("A filesystem or home root cannot be an evidence directory")
	}
	return resolved
}

/** Check each component, including an existing ancestor of a directory we are about to create. */
export async function rejectSymlinkComponents(candidate: string): Promise<void> {
	const absolute = path.resolve(candidate)
	let current = path.parse(absolute).root
	for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component)
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Evidence paths cannot contain symlinks")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return
			throw error
		}
	}
}

export async function readBounded(filePath: string, maxBytes: number): Promise<Buffer> {
	await rejectSymlinkComponents(filePath)
	const before = await fs.lstat(filePath)
	if (!before.isFile() || before.size > maxBytes) throw new Error("Evidence file exceeds its limit or is not regular")
	const handle = await fs.open(filePath, "r")
	try {
		const opened = await handle.stat()
		if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) {
			throw new Error("Evidence source changed during capture")
		}
		const buffer = Buffer.alloc(maxBytes + 1)
		let position = 0
		while (position < buffer.length) {
			const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position)
			if (bytesRead === 0) break
			position += bytesRead
		}
		if (position > maxBytes) throw new Error("Evidence file exceeds its limit")
		const after = await handle.stat()
		if (after.size !== position || after.mtimeMs !== opened.mtimeMs) {
			throw new Error("Evidence source changed during capture")
		}
		return buffer.subarray(0, position)
	} finally {
		await handle.close()
	}
}

export async function ensureEvidenceRoot(directory: string): Promise<string> {
	const root = assertSafeRoot(directory)
	await rejectSymlinkComponents(root)
	await fs.mkdir(root, { recursive: true, mode: 0o700 })
	const markerPath = path.join(root, EVIDENCE_ROOT_MARKER)
	try {
		const marker = await readBounded(markerPath, 256)
		if (marker.toString("utf8") !== ROOT_MARKER) throw new Error("Unrecognized evidence root marker")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		if ((await fs.readdir(root)).length > 0) throw new Error("Refusing to adopt a non-empty evidence root")
		try {
			await fs.writeFile(markerPath, ROOT_MARKER, { flag: "wx", mode: 0o600 })
		} catch (writeError) {
			if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError
			if ((await readBounded(markerPath, 256)).toString("utf8") !== ROOT_MARKER) throw writeError
		}
	}
	return assertSafeRoot(await fs.realpath(root))
}

export async function requireEvidenceRoot(directory: string): Promise<string> {
	const root = assertSafeRoot(directory)
	await rejectSymlinkComponents(root)
	if ((await readBounded(path.join(root, EVIDENCE_ROOT_MARKER), 256)).toString("utf8") !== ROOT_MARKER) {
		throw new Error("Unrecognized evidence root marker")
	}
	return assertSafeRoot(await fs.realpath(root))
}

export async function prepareEvidenceRun(options: {
	artifactsRoot: string
	runId: string
}): Promise<{ artifactDirectory: string; manifestPath: string }> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.runId)) throw new Error("Invalid evidence run ID")
	const root = await ensureEvidenceRoot(options.artifactsRoot)
	const artifactDirectory = path.join(root, options.runId)
	await fs.mkdir(artifactDirectory, { mode: 0o700 })
	await fs.writeFile(
		path.join(artifactDirectory, EVIDENCE_RUN_MARKER),
		JSON.stringify({ kind: "alpha-vscode-e2e-run", version: 1, runId: options.runId }),
		{ flag: "wx", mode: 0o600 },
	)
	return { artifactDirectory, manifestPath: path.join(artifactDirectory, "manifest.json") }
}

export async function requireEvidenceRun(root: string, runId: string): Promise<string> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid evidence run ID")
	const directory = path.join(root, runId)
	await rejectSymlinkComponents(directory)
	const marker = JSON.parse(
		(await readBounded(path.join(directory, EVIDENCE_RUN_MARKER), 512)).toString("utf8"),
	) as Record<string, unknown>
	if (marker.kind !== "alpha-vscode-e2e-run" || marker.version !== 1 || marker.runId !== runId) {
		throw new Error("Unrecognized evidence run marker")
	}
	return directory
}
