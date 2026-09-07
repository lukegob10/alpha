import { execFile } from "child_process"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { promisify } from "util"

import type { ToolUse } from "../../shared/tools"
import { parsePatch } from "../tools/apply-patch/parser"
import { fingerprintContent } from "../tools/contentVersion"
import { getImageOutputPaths } from "../tools/imageOutputPaths"

const execFileAsync = promisify(execFile)
const MAX_PATHS = 256
const MAX_PATH_LENGTH = 4_096
const MAX_FILE_BYTES = 4 * 1_024 * 1_024
const MAX_TOTAL_BYTES = 16 * 1_024 * 1_024
const MAX_COMMAND_LENGTH = 4_096
const MAX_ANCESTORS = 32
const MAX_GIT_OUTPUT_BYTES = 1_024 * 1_024

export type VerificationContent = Record<string, string>

/** Callers must distinguish unavailable observation from a captured empty change set. */
export class VerificationScopeError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "VerificationScopeError"
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

function containsPath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function resolveContainedPath(root: string, candidate: string, workspaceRoot = root): string {
	if (!candidate || candidate.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(candidate)) {
		throw new VerificationScopeError("Invalid verification path")
	}
	const originalRoot = path.resolve(workspaceRoot)
	const absolute = path.resolve(originalRoot, candidate)
	const withinOriginal = containsPath(originalRoot, absolute)
	if (!path.isAbsolute(candidate) && !withinOriginal)
		throw new VerificationScopeError("Verification path is outside the workspace")
	if (containsPath(root, absolute)) return absolute
	if (!withinOriginal) throw new VerificationScopeError("Verification path is outside the workspace")
	// A trusted workspace may use a Windows short name or a junction alias. Map
	// only that root spelling; realContainedPath still rejects escaping descendants.
	return path.resolve(root, path.relative(originalRoot, absolute))
}

async function realContainedPath(root: string, absolute: string): Promise<string | undefined> {
	try {
		const real = await fs.realpath(absolute)
		if (!containsPath(root, real))
			throw new VerificationScopeError("Verification path resolves outside the workspace")
		return real
	} catch (error) {
		if (!isMissing(error)) throw error
		// A missing leaf is safe only if its nearest existing parent is also contained.
		if (absolute === root) throw error
		await realContainedPath(root, path.dirname(absolute))
		return undefined
	}
}

async function readBoundedFile(root: string, absolute: string, limit: number): Promise<Buffer | undefined> {
	const real = await realContainedPath(root, absolute)
	if (!real) return undefined
	const handle = await fs.open(real, "r")
	try {
		const before = await handle.stat()
		if (!before.isFile() || before.size > limit) {
			throw new VerificationScopeError("Verification content is not a bounded regular file")
		}
		// readFile can allocate past a stat-based bound if another writer grows the file.
		const buffer = Buffer.alloc(before.size + 1)
		let bytesRead = 0
		while (bytesRead < buffer.length) {
			const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
			if (result.bytesRead === 0) break
			bytesRead += result.bytesRead
		}
		const after = await handle.stat()
		const currentReal = await realContainedPath(root, absolute)
		const current = currentReal ? await fs.stat(currentReal) : undefined
		if (
			bytesRead !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			currentReal !== real ||
			current?.dev !== after.dev ||
			current?.ino !== after.ino ||
			current?.size !== after.size ||
			current?.mtimeMs !== after.mtimeMs
		) {
			throw new VerificationScopeError("Verification content changed while it was being observed")
		}
		return buffer.subarray(0, bytesRead)
	} finally {
		await handle.close()
	}
}

function boundedPaths(paths: readonly string[]): string[] {
	if (paths.length > MAX_PATHS) throw new VerificationScopeError("Verification path count exceeds the bound")
	return [...new Set(paths)].sort()
}

/** Fingerprints bytes (including binary files); missing files have a distinct non-hash marker. */
export async function captureVerificationContent(
	workspaceRoot: string,
	paths: readonly string[],
): Promise<VerificationContent> {
	const root = await fs.realpath(workspaceRoot)
	const content: VerificationContent = Object.create(null)
	let totalBytes = 0
	for (const candidate of boundedPaths(paths)) {
		const absolute = resolveContainedPath(root, candidate, workspaceRoot)
		const relative = path.relative(root, absolute).split(path.sep).join("/")
		const bytes = await readBoundedFile(root, absolute, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes))
		totalBytes += bytes?.length ?? 0
		content[relative] = bytes ? createHash("sha256").update(bytes).digest("hex") : "missing"
	}
	return content
}

/** Use the execution parser for patches so moves, deletions, and partial multi-file success are observable. */
export function extractMutationPaths(block: ToolUse): string[] | undefined {
	const args = block.nativeArgs as Record<string, unknown> | undefined
	const parameter = (name: "path" | "file_path" | "patch") => args?.[name] ?? block.params[name]
	let paths: string[]
	switch (block.name) {
		case "write_to_file":
		case "apply_diff":
		case "generate_image": {
			const candidate = parameter("path")
			if (typeof candidate !== "string" || !candidate)
				throw new VerificationScopeError("Mutation path is missing")
			paths = block.name === "generate_image" ? getImageOutputPaths(candidate) : [candidate]
			break
		}
		case "edit":
		case "edit_file":
		case "search_replace":
		case "search_and_replace": {
			const candidate = parameter("file_path")
			if (typeof candidate !== "string" || !candidate)
				throw new VerificationScopeError("Mutation path is missing")
			paths = [candidate]
			break
		}
		case "apply_patch": {
			const patch = parameter("patch")
			if (typeof patch !== "string" || Buffer.byteLength(patch) > MAX_FILE_BYTES) {
				throw new VerificationScopeError("Mutation patch is missing or exceeds the bound")
			}
			paths = parsePatch(patch).hunks.flatMap((hunk) =>
				hunk.type === "UpdateFile" && hunk.movePath ? [hunk.path, hunk.movePath] : [hunk.path],
			)
			break
		}
		default:
			return undefined
	}
	return boundedPaths(paths)
}

export interface CommandVerificationScope {
	scopePath: string
	commandDigest: string
	repositoryDigest: string
	repositoryFiles: VerificationContent
	assurance: "process"
	matchedFiles?: string[]
}

export interface CommandVerificationDiagnostic {
	/** Includes historical codes retained in saved command and completion diagnostics. */
	code:
		| "unsafe_command"
		| "unsupported_command"
		| "unsupported_configuration"
		| "uncovered_changes"
		| "unavailable_scope"
		| "missing_change_set"
		| "unknown_change_set"
		| "unavailable_content"
		| "no_test_validation"
		| "runtime_scope_unavailable"
	message: string
	changeSetId?: string
}

/**
 * Capture bounded process evidence for an explicitly associated change set.
 *
 * This function deliberately does not classify commands or infer test coverage.
 * Execution authority is enforced by the command policy and approval boundary;
 * this record only binds the approved process to the workspace and content that
 * the host explicitly associated with it.
 */
export async function resolveCommandVerification(input: {
	workspaceRoot: string
	cwd: string
	command: string
	/** Actual edited paths only; content-dependency paths must not be passed as edits. */
	changedFiles?: readonly string[]
	onRejected?: (diagnostic: CommandVerificationDiagnostic) => void
}): Promise<CommandVerificationScope | undefined> {
	const reject = (code: CommandVerificationDiagnostic["code"], message: string) => {
		input.onRejected?.({ code, message })
		return undefined
	}
	if (
		typeof input.command !== "string" ||
		!input.command.trim() ||
		input.command.length > MAX_COMMAND_LENGTH ||
		input.command.includes("\0")
	) {
		return reject("unsafe_command", "The approved command is empty or exceeds the bounded command identity limit.")
	}

	const root = await fs.realpath(input.workspaceRoot)
	const candidateCwd = resolveContainedPath(root, input.cwd, input.workspaceRoot)
	const cwd = await realContainedPath(root, candidateCwd)
	if (!cwd) throw new VerificationScopeError("Verification cwd is unavailable")
	const cwdStat = await fs.stat(cwd)
	if (!cwdStat.isDirectory()) throw new VerificationScopeError("Verification cwd is unavailable")

	const matchedFiles =
		input.changedFiles === undefined
			? undefined
			: boundedPaths(
					input.changedFiles.map((candidate) => {
						const absolute = resolveContainedPath(root, candidate, input.workspaceRoot)
						return path.relative(root, absolute).split(path.sep).join("/")
					}),
				)

	const repositoryFiles = matchedFiles
		? await captureVerificationContent(root, matchedFiles)
		: (Object.create(null) as VerificationContent)

	return {
		scopePath: root,
		// Keep the command text raw while binding it to the canonical execution
		// directory, so identical text from different directories cannot share a
		// process receipt accidentally.
		commandDigest: fingerprintContent(JSON.stringify({ command: input.command, cwd })),
		repositoryDigest: fingerprintContent(JSON.stringify(repositoryFiles)),
		repositoryFiles,
		assurance: "process",
		...(matchedFiles ? { matchedFiles } : {}),
	}
}

export interface GitMutationState {
	head: string | null
	files: VerificationContent
	digest: string
}

interface WorkspaceIdentity {
	root: string
	device: number
	inode: number
}

/** Ephemeral command evidence; never reconstructed from saved verification obligations. */
export type WorkspaceMutationState = GitMutationState & {
	kind: "git" | "files"
	workspace: WorkspaceIdentity
}

async function workspaceIdentity(workspaceRoot: string): Promise<WorkspaceIdentity> {
	const root = await fs.realpath(workspaceRoot)
	const stat = await fs.stat(root)
	if (!stat.isDirectory()) throw new VerificationScopeError("Workspace observation requires a directory")
	return { root, device: stat.dev, inode: stat.ino }
}

function assertWorkspaceIdentity(expected: WorkspaceIdentity, actual: WorkspaceIdentity): void {
	if (expected.root !== actual.root || expected.device !== actual.device || expected.inode !== actual.inode) {
		throw new VerificationScopeError("Workspace identity changed during command observation")
	}
}

async function gitObservation(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
		{ cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES, timeout: 5_000, windowsHide: true },
	)
	return stdout
}

async function readGitHead(cwd: string): Promise<string | null> {
	try {
		return (await gitObservation(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).trim()
	} catch (error) {
		if ((error as { code?: number }).code === 1) return null // Unborn repository.
		throw error
	}
}

/** Bounded Git-visible state only; unknown/non-Git/submodule/oversized observations fail closed. */
export async function captureGitMutationState(workspaceRoot: string): Promise<GitMutationState> {
	const root = await fs.realpath(workspaceRoot)
	const gitRoot = await fs.realpath((await gitObservation(root, ["rev-parse", "--show-toplevel"])).trim())
	if (gitRoot !== root) throw new VerificationScopeError("Git observation requires the workspace repository root")
	const head = await readGitHead(root)
	const status = await gitObservation(root, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
		"--no-renames",
		"--ignore-submodules=none",
	])
	// Status omits tracked files marked assume-unchanged/skip-worktree; their bytes remain task inputs.
	const trackedFlags = await gitObservation(root, ["ls-files", "-v", "-z"])
	const hiddenTrackedPaths = trackedFlags
		.split("\0")
		.filter(Boolean)
		.flatMap((record) => {
			if (!/^[A-Za-z?] /.test(record))
				throw new VerificationScopeError("Unsupported Git tracked-file observation")
			return record[0] === "S" || /^[a-z]/.test(record) ? [record.slice(2)] : []
		})
	const paths = status
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			if (!/^[ MADRCU?!]{2} /.test(record) || /[RCU!]/.test(record.slice(0, 2))) {
				throw new VerificationScopeError("Unsupported Git status observation")
			}
			return record.slice(3)
		})
	const files = await captureVerificationContent(root, [...new Set([...paths, ...hiddenTrackedPaths])])
	if (head !== (await readGitHead(root))) throw new VerificationScopeError("Git HEAD changed while observing changes")
	return { head, files, digest: fingerprintContent(JSON.stringify([head, files])) }
}

async function changedGitHeadPaths(cwd: string, before: string | null, after: string | null): Promise<string[]> {
	if (before === after) return []
	const output = await gitObservation(
		cwd,
		before && after
			? ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", before, after, "--"]
			: ["ls-tree", "-r", "--name-only", "-z", (before ?? after)!],
	)
	return boundedPaths(output.split("\0").filter(Boolean))
}

/** Refresh files that became clean, including changes committed during the command. */
export async function compareGitMutationState(
	workspaceRoot: string,
	before: GitMutationState,
	after: GitMutationState,
): Promise<{ changedPaths: string[]; files: VerificationContent }> {
	const committedPaths = await changedGitHeadPaths(workspaceRoot, before.head, after.head)
	const candidates = boundedPaths([
		...new Set([...Object.keys(before.files), ...Object.keys(after.files), ...committedPaths]),
	])
	const refreshed = await captureVerificationContent(workspaceRoot, candidates)
	if (Object.keys(after.files).some((candidate) => after.files[candidate] !== refreshed[candidate])) {
		throw new VerificationScopeError("Workspace content changed while comparing command changes")
	}
	if ((await readGitHead(workspaceRoot)) !== after.head) {
		throw new VerificationScopeError("Git HEAD changed while comparing command changes")
	}
	// A commit alone preserves the captured working bytes. Paths that were clean
	// before a HEAD transition have no byte snapshot and conservatively require
	// validation; the tree diff keeps edit-and-commit commands observable.
	const changedPaths = candidates.filter((candidate) => before.files[candidate] !== refreshed[candidate])
	return {
		changedPaths,
		files: Object.fromEntries(changedPaths.map((candidate) => [candidate, refreshed[candidate]])),
	}
}

async function workspaceFilePaths(root: string): Promise<string[]> {
	const files: string[] = []
	let entries = 0
	async function visit(directory: string, depth: number): Promise<void> {
		if (depth > MAX_ANCESTORS) throw new VerificationScopeError("Workspace observation exceeds the depth bound")
		for await (const entry of await fs.opendir(directory)) {
			if (entry.name === ".git" || entry.name === "node_modules") continue
			if (++entries > MAX_PATHS * 2)
				throw new VerificationScopeError("Workspace observation exceeds the entry bound")
			const absolute = path.join(directory, entry.name)
			const stat = await fs.lstat(absolute)
			if (stat.isSymbolicLink()) {
				throw new VerificationScopeError("Workspace observation cannot follow symlinks or special files")
			} else if (stat.isDirectory()) {
				if ((await realContainedPath(root, absolute)) !== absolute) {
					throw new VerificationScopeError("Workspace observation cannot follow symlinks or special files")
				}
				await visit(absolute, depth + 1)
			} else if (stat.isFile()) {
				files.push(path.relative(root, absolute).split(path.sep).join("/"))
				if (files.length > MAX_PATHS)
					throw new VerificationScopeError("Workspace observation exceeds the file bound")
			} else {
				throw new VerificationScopeError("Workspace observation cannot follow symlinks or special files")
			}
		}
	}
	await visit(root, 0)
	return files.sort()
}

async function workspaceObservationKind(root: string): Promise<WorkspaceMutationState["kind"]> {
	try {
		const stat = await fs.lstat(path.join(root, ".git"))
		if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
			throw new VerificationScopeError(
				"Workspace observation cannot follow Git metadata symlinks or special files",
			)
		}
		return "git"
	} catch (error) {
		if (!isMissing(error)) throw error
		return "files"
	}
}

async function captureWorkspaceFiles(root: string): Promise<GitMutationState> {
	const paths = await workspaceFilePaths(root)
	const files = await captureVerificationContent(root, paths)
	// The per-file reader fences individual reads; repeat the bounded inventory and
	// bytes to also detect changes to earlier files while later ones were captured.
	const refreshed = await captureVerificationContent(root, paths)
	if (
		JSON.stringify(files) !== JSON.stringify(refreshed) ||
		JSON.stringify(paths) !== JSON.stringify(await workspaceFilePaths(root))
	) {
		throw new VerificationScopeError("Workspace files changed while observing command changes")
	}
	return { head: null, files, digest: fingerprintContent(JSON.stringify(files)) }
}

/**
 * Keep a complete baseline's content scope through repository initialization.
 * Switching to Git status would lose committed or newly ignored final bytes.
 * Ordinary Git commands retain their bounded Git-visible observation strategy.
 */
export async function captureWorkspaceMutationState(
	workspaceRoot: string,
	baseline?: WorkspaceMutationState,
): Promise<WorkspaceMutationState> {
	const workspace = await workspaceIdentity(workspaceRoot)
	if (baseline) assertWorkspaceIdentity(baseline.workspace, workspace)
	const observedKind = await workspaceObservationKind(workspace.root)
	const kind = baseline?.kind === "files" ? "files" : observedKind
	const state =
		kind === "git" ? await captureGitMutationState(workspace.root) : await captureWorkspaceFiles(workspace.root)
	const finalKind = await workspaceObservationKind(workspace.root)
	if (baseline?.kind !== "files" && observedKind !== finalKind) {
		throw new VerificationScopeError("Workspace observation changed while capturing command changes")
	}
	assertWorkspaceIdentity(workspace, await workspaceIdentity(workspaceRoot))
	return { ...state, kind, workspace }
}

function assertWorkspaceObservation(expected: WorkspaceMutationState, actual: WorkspaceMutationState): void {
	assertWorkspaceIdentity(expected.workspace, actual.workspace)
	if (expected.kind !== actual.kind || expected.digest !== actual.digest) {
		throw new VerificationScopeError("Workspace observation changed while comparing command changes")
	}
}

export async function compareWorkspaceMutationState(
	workspaceRoot: string,
	before: WorkspaceMutationState,
	after: WorkspaceMutationState,
): Promise<{ changedPaths: string[]; files: VerificationContent }> {
	assertWorkspaceIdentity(before.workspace, after.workspace)
	assertWorkspaceIdentity(before.workspace, await workspaceIdentity(workspaceRoot))
	if (before.kind === "git") {
		if (after.kind !== "git") {
			throw new VerificationScopeError(
				"Repository metadata became unavailable; the Git baseline has incomplete content scope",
			)
		}
		const changes = await compareGitMutationState(workspaceRoot, before, after)
		assertWorkspaceObservation(after, await captureWorkspaceMutationState(workspaceRoot, after))
		return changes
	}
	const current = await captureWorkspaceMutationState(workspaceRoot, before)
	if (after.kind === "files") {
		assertWorkspaceObservation(after, current)
	} else {
		// Compatibility for independently captured snapshots: the complete baseline
		// can still be compared with a bounded full inventory at comparison time.
		// Command finalizers pass the baseline to capture so final ignored bytes are
		// already frozen and checked by the files branch above.
		assertWorkspaceObservation(after, await captureWorkspaceMutationState(workspaceRoot))
	}
	const candidates = boundedPaths([...new Set([...Object.keys(before.files), ...Object.keys(current.files)])])
	const changedPaths = candidates.filter(
		(candidate) => (before.files[candidate] ?? "missing") !== (current.files[candidate] ?? "missing"),
	)
	return {
		changedPaths,
		files: Object.fromEntries(changedPaths.map((candidate) => [candidate, current.files[candidate] ?? "missing"])),
	}
}
