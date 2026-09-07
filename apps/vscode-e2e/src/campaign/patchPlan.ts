import { createHash, randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { assertSafeRoot, readBounded, rejectSymlinkComponents } from "../evidence/paths"

export interface PatchEdit {
	path: string
	expectedSha256: string
	replacement: string
}

export interface PatchPlan {
	id: string
	edits: PatchEdit[]
}

export interface PatchReceipt {
	planId: string
	/** Original bytes are retained, including on success; never delete a possibly externally edited backup. */
	recoveryBackups?: { targetPath: string; backupPath: string }[]
	files: Array<{
		path: string
		beforeSha256: string
		afterSha256: string
	}>
}

const MAX_FILES = 10
const MAX_REPLACEMENT_BYTES = 256 * 1024
const FAILURE_RECEIPT = Symbol("alphaPatchFailureReceipt")
const SAFE_ERROR = Symbol("alphaPatchSafeError")

const SOURCE_EXTENSIONS = new Set([
	".cjs",
	".css",
	".cts",
	".html",
	".js",
	".jsx",
	".less",
	".mjs",
	".mts",
	".scss",
	".ts",
	".tsx",
	".vue",
])

const GENERATED_DIRECTORIES = new Set([
	".next",
	".turbo",
	".vscode-test",
	"artifacts",
	"build",
	"coverage",
	"dist",
	"generated",
	"node_modules",
	"out",
])

const LOCKFILES = new Set([
	"bun.lock",
	"bun.lockb",
	"cargo.lock",
	"npm-shrinkwrap.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"pnpm-lock.yml",
	"yarn.lock",
])

type FileSnapshot = {
	relativePath: string
	absolutePath: string
	bytes: Buffer
	sha256: string
	stat: Stats
}

type PreparedEdit = {
	relativePath: string
	targetPath: string
	expectedSha256: string
	replacement: Buffer
	replacementSha256: string
	before: FileSnapshot
}

type RecoveryState = {
	directory: string
	backupPath: string
	temporaryPath: string
	targetPath: string
	backupClaimed: boolean
	backupPresent: boolean
	backupSha256?: string
	backupStat?: Stats
	temporaryOwned: boolean
	temporarySha256?: string
	temporaryStat?: Stats
}

type AppliedEdit = {
	prepared: PreparedEdit
	afterSha256?: string
}

type FailureCarrier = {
	[FAILURE_RECEIPT]?: unknown
}

function isRecord(value: unknown): value is Record<string | symbol, unknown> {
	return typeof value === "object" && value !== null
}

function patchError(message: string): Error {
	const error = new Error(message)
	Object.defineProperty(error, SAFE_ERROR, { value: true, enumerable: false })
	return error
}

function isSafeError(error: unknown): error is Error {
	return error instanceof Error && isRecord(error) && error[SAFE_ERROR] === true
}

function isNodeError(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code
}

function isMissing(error: unknown): boolean {
	return isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")
}

function normalizeSha256(value: unknown, fieldName: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
		throw patchError(`${fieldName} must be a SHA-256 hex digest`)
	}
	return value.toLowerCase()
}

function normalizeRepoRelative(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
		throw patchError("patch paths must be non-empty repo-relative strings")
	}

	const slashPath = value.replace(/\\/g, "/")
	if (
		slashPath.startsWith("/") ||
		path.posix.isAbsolute(slashPath) ||
		path.win32.isAbsolute(slashPath) ||
		/^[a-z]:/i.test(slashPath)
	) {
		throw patchError("patch paths must be repo-relative")
	}

	const rawSegments = slashPath.split("/")
	if (rawSegments.some((segment) => segment === ".." || segment.includes(":"))) {
		throw patchError("patch paths cannot traverse or use drive/alternate-stream syntax")
	}

	const normalized = path.posix.normalize(slashPath)
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.startsWith("/") ||
		normalized.includes("\0")
	) {
		throw patchError("patch paths must be normalized repo-relative files")
	}
	return normalized
}

function pathKey(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value
}

function validateSourcePath(relativePath: string): void {
	const segments = relativePath.split("/")
	const keys = segments.map(pathKey)
	const fileName = keys[keys.length - 1] ?? ""

	if ((keys[0] === "apps" && keys[1] === "cli") || (keys[0] === "packages" && keys[1] === "vscode-shim")) {
		throw patchError(`protected source path: ${relativePath}`)
	}
	if (
		segments.some((segment) => {
			const key = pathKey(segment)
			return (
				GENERATED_DIRECTORIES.has(key) ||
				key === ".alphaignore" ||
				key === "package.json" ||
				key.startsWith(".git")
			)
		})
	) {
		throw patchError(`generated or configuration path: ${relativePath}`)
	}
	if (
		segments.some((segment) => {
			const key = pathKey(segment)
			return key === "agents" || key.startsWith("agents.") || LOCKFILES.has(key) || key.endsWith(".lock")
		})
	) {
		throw patchError(`protected boundary path: ${relativePath}`)
	}

	const isRootSource = keys[0] === "src" || keys[0] === "webview-ui"
	const isE2eSource =
		keys[0] === "apps" && keys[1] === "vscode-e2e" && ["src", "test", "tests"].includes(keys[2] ?? "")
	if ((!isRootSource && !isE2eSource) || segments.length < (isE2eSource ? 4 : 2)) {
		throw patchError(`path is outside approved source/test roots: ${relativePath}`)
	}
	if (!SOURCE_EXTENSIONS.has(path.posix.extname(fileName))) {
		throw patchError(`path is not an approved source/test file: ${relativePath}`)
	}
}

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
}

function assertWithinRoot(root: string, candidate: string, description: string): void {
	if (!isWithinRoot(root, candidate)) {
		throw patchError(`path escapes source root: ${description}`)
	}
}

function sameStableStat(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.birthtimeMs === right.birthtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.nlink === right.nlink
	)
}

function sameClaimedStat(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.birthtimeMs === right.birthtimeMs
	)
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
}

function isUtf8Text(bytes: Buffer): boolean {
	if (bytes.includes(0)) {
		return false
	}
	return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1)
			if (next < 0xdc00 || next > 0xdfff) {
				return true
			}
			index += 1
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true
		}
	}
	return false
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex")
}

function abortError(): Error {
	const error = patchError("patch plan aborted")
	error.name = "AbortError"
	return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw abortError()
	}
}

async function getSourceRoot(sourceRoot: string): Promise<string> {
	if (typeof sourceRoot !== "string" || sourceRoot.length === 0 || sourceRoot.includes("\0")) {
		throw patchError("source root must be a non-empty directory")
	}

	const resolved = assertSafeRoot(sourceRoot)
	await rejectSymlinkComponents(resolved)
	let stat: Stats
	try {
		stat = await fs.lstat(resolved)
	} catch {
		throw patchError("source root is not an existing directory")
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw patchError("source root must be a real directory")
	}

	let realPath: string
	try {
		realPath = await fs.realpath(resolved)
	} catch {
		throw patchError("source root could not be resolved")
	}
	// Realpath may expand Windows 8.3 aliases. Ancestor lstat checks, not spelling equality, reject links.
	return assertSafeRoot(realPath)
}

async function lstatOrUndefined(filePath: string, description: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(filePath)
	} catch (error) {
		if (isMissing(error)) {
			return undefined
		}
		if (isSafeError(error)) {
			throw error
		}
		throw patchError(`unable to inspect ${description}`)
	}
}

async function realpathOrThrow(filePath: string, description: string): Promise<string> {
	try {
		return await fs.realpath(filePath)
	} catch (error) {
		if (isSafeError(error)) {
			throw error
		}
		throw patchError(`unable to resolve ${description}`)
	}
}

async function assertSafeParent(root: string, relativePath: string): Promise<string> {
	const segments = relativePath.split("/")
	let current = root
	for (const segment of segments.slice(0, -1)) {
		current = path.join(current, segment)
		const stat = await lstatOrUndefined(current, `source parent ${relativePath}`)
		if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
			throw patchError(`source parent is missing or unsafe: ${relativePath}`)
		}
		const realPath = await realpathOrThrow(current, `source parent ${relativePath}`)
		assertWithinRoot(root, realPath, relativePath)
	}
	return path.join(root, ...segments)
}

async function readStable(
	root: string,
	filePath: string,
	relativePath: string,
	initialStat: Stats,
	requireText: boolean,
): Promise<FileSnapshot> {
	let bytes: Buffer
	try {
		bytes = await readBounded(filePath, MAX_REPLACEMENT_BYTES)
	} catch (error) {
		if (isSafeError(error)) {
			throw error
		}
		throw patchError(`unable to read source file: ${relativePath}`)
	}

	const finalStat = await lstatOrUndefined(filePath, relativePath)
	if (!finalStat || finalStat.isSymbolicLink() || !finalStat.isFile()) {
		throw patchError(`source file changed or became unsafe: ${relativePath}`)
	}
	if (!sameStableStat(initialStat, finalStat)) {
		throw patchError(`source file changed while being read: ${relativePath}`)
	}
	const realPath = await realpathOrThrow(filePath, relativePath)
	assertWithinRoot(root, realPath, relativePath)
	if (requireText && !isUtf8Text(bytes)) {
		throw patchError(`source file is not UTF-8 text: ${relativePath}`)
	}
	return { relativePath, absolutePath: filePath, bytes, sha256: sha256(bytes), stat: finalStat }
}

async function inspectExistingFile(root: string, relativePath: string, requireText: boolean): Promise<FileSnapshot> {
	const filePath = await assertSafeParent(root, relativePath)
	const stat = await lstatOrUndefined(filePath, relativePath)
	if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
		throw patchError(`source file is missing or unsafe: ${relativePath}`)
	}
	const realPath = await realpathOrThrow(filePath, relativePath)
	assertWithinRoot(root, realPath, relativePath)
	const snapshot = await readStable(root, filePath, relativePath, stat, requireText)
	if (snapshot.stat.nlink > 1) {
		throw patchError(`source file has an external hard-link: ${relativePath}`)
	}
	return snapshot
}

async function inspectArtifact(root: string, filePath: string, description: string): Promise<FileSnapshot> {
	assertWithinRoot(root, filePath, description)
	const stat = await lstatOrUndefined(filePath, description)
	if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
		throw patchError(`owned recovery artifact is missing or unsafe: ${description}`)
	}
	const realPath = await realpathOrThrow(filePath, description)
	assertWithinRoot(root, realPath, description)
	return readStable(root, filePath, description, stat, false)
}

async function tryInspectCurrent(root: string, prepared: PreparedEdit): Promise<FileSnapshot | undefined> {
	try {
		return await inspectExistingFile(root, prepared.relativePath, false)
	} catch {
		return undefined
	}
}

async function tryInspectPublishedTarget(root: string, prepared: PreparedEdit, temporaryStat: Stats): Promise<boolean> {
	try {
		const snapshot = await inspectArtifact(root, prepared.targetPath, prepared.relativePath)
		return sameIdentity(snapshot.stat, temporaryStat)
	} catch {
		return false
	}
}

async function ensureAbsent(filePath: string, description: string): Promise<void> {
	const stat = await lstatOrUndefined(filePath, description)
	if (stat) {
		throw patchError(`recovery destination already exists: ${description}`)
	}
}

async function createRecoveryState(
	root: string,
	prepared: PreparedEdit,
	signal: AbortSignal | undefined,
): Promise<RecoveryState> {
	await assertSafeParent(root, prepared.relativePath)
	throwIfAborted(signal)

	let directory: string
	try {
		directory = await fs.mkdtemp(path.join(path.dirname(prepared.targetPath), `.alpha-patch-${randomUUID()}-`))
	} catch {
		throw patchError(`unable to create recovery area: ${prepared.relativePath}`)
	}

	const state: RecoveryState = {
		directory,
		backupPath: path.join(directory, "original"),
		temporaryPath: path.join(directory, "replacement.tmp"),
		targetPath: prepared.targetPath,
		backupClaimed: false,
		backupPresent: false,
		temporaryOwned: false,
	}
	try {
		const stat = await lstatOrUndefined(directory, "recovery area")
		if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
			throw patchError("recovery area is unsafe")
		}
		const realPath = await realpathOrThrow(directory, "recovery area")
		assertWithinRoot(root, realPath, "recovery area")
		return state
	} catch (error) {
		await removeRecoveryDirectory(root, state).catch(() => undefined)
		if (isSafeError(error)) {
			throw error
		}
		throw patchError(`recovery area is unsafe: ${prepared.relativePath}`)
	}
}

async function writeReplacement(
	root: string,
	prepared: PreparedEdit,
	state: RecoveryState,
	signal: AbortSignal | undefined,
): Promise<void> {
	let handle: fs.FileHandle | undefined
	try {
		throwIfAborted(signal)
		const mode = prepared.before.stat.mode & 0o777
		handle = await fs.open(state.temporaryPath, "wx", mode)
		state.temporaryOwned = true
		throwIfAborted(signal)
		await handle.writeFile(prepared.replacement, { signal })
		throwIfAborted(signal)
		await handle.sync()
	} catch (error) {
		if (signal?.aborted) {
			throw abortError()
		}
		if (isSafeError(error)) {
			throw error
		}
		throw patchError(`unable to stage replacement: ${prepared.relativePath}`)
	} finally {
		if (handle) {
			await handle.close().catch(() => undefined)
		}
	}

	const staged = await inspectArtifact(root, state.temporaryPath, `replacement for ${prepared.relativePath}`)
	if (staged.sha256 !== prepared.replacementSha256 || !isUtf8Text(staged.bytes)) {
		throw patchError(`staged replacement verification failed: ${prepared.relativePath}`)
	}
	state.temporaryStat = staged.stat
	state.temporarySha256 = staged.sha256
}

async function claimTarget(
	root: string,
	prepared: PreparedEdit,
	state: RecoveryState,
	signal: AbortSignal | undefined,
): Promise<void> {
	const current = await inspectExistingFile(root, prepared.relativePath, true)
	if (current.sha256 !== prepared.expectedSha256 || !sameStableStat(current.stat, prepared.before.stat)) {
		throw patchError(`hash mismatch before write: ${prepared.relativePath}`)
	}
	await assertSafeParent(root, prepared.relativePath)
	await ensureAbsent(state.backupPath, `original for ${prepared.relativePath}`)
	throwIfAborted(signal)
	try {
		await fs.rename(prepared.targetPath, state.backupPath)
	} catch (error) {
		if (isSafeError(error)) {
			throw error
		}
		throw patchError(`unable to claim source file: ${prepared.relativePath}`)
	}
	state.backupClaimed = true
	state.backupPresent = true

	const claimed = await inspectArtifact(root, state.backupPath, `original for ${prepared.relativePath}`)
	state.backupStat = claimed.stat
	state.backupSha256 = claimed.sha256
	if (claimed.sha256 !== prepared.expectedSha256 || !sameClaimedStat(claimed.stat, prepared.before.stat)) {
		throw patchError(`source changed while being claimed: ${prepared.relativePath}`)
	}
}

async function linkExclusive(sourcePath: string, targetPath: string, description: string): Promise<boolean> {
	try {
		await fs.link(sourcePath, targetPath)
		return true
	} catch (error) {
		if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY")) {
			return false
		}
		if (isSafeError(error)) {
			throw error
		}
		throw patchError(`unable to publish replacement: ${description}`)
	}
}

async function unlinkOwnedTemporary(state: RecoveryState): Promise<void> {
	if (!state.temporaryOwned || !state.temporaryStat || !state.temporarySha256) {
		return
	}
	let current: FileSnapshot
	try {
		current = await inspectArtifact(stateRootForCleanup(state), state.temporaryPath, "owned replacement")
	} catch {
		state.temporaryOwned = false
		return
	}
	if (!sameIdentity(current.stat, state.temporaryStat) || current.sha256 !== state.temporarySha256) {
		state.temporaryOwned = false
		return
	}
	try {
		await fs.unlink(state.temporaryPath)
	} catch (error) {
		if (!isMissing(error)) {
			throw patchError("unable to clean owned replacement")
		}
	}
	state.temporaryOwned = false
}

// Recovery paths are created below the target parent, so this only supplies the root for
// ownership checks during cleanup. applyPatchPlan installs it before any state is used.
const cleanupRoots = new WeakMap<RecoveryState, string>()

function stateRootForCleanup(state: RecoveryState): string {
	const root = cleanupRoots.get(state)
	if (!root) {
		throw patchError("recovery state is not owned")
	}
	return root
}

async function removeRecoveryDirectory(root: string, state: RecoveryState): Promise<void> {
	if (state.backupPresent || state.temporaryOwned) {
		return
	}
	const stat = await lstatOrUndefined(state.directory, "recovery area")
	if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
		return
	}
	const realPath = await realpathOrThrow(state.directory, "recovery area")
	assertWithinRoot(root, realPath, "recovery area")
	try {
		await fs.rmdir(state.directory)
	} catch (error) {
		if (!isMissing(error) && !isNodeError(error, "ENOTEMPTY")) {
			throw patchError("unable to clean owned recovery area")
		}
	}
}

async function restoreClaim(root: string, prepared: PreparedEdit, state: RecoveryState): Promise<boolean> {
	if (!state.backupClaimed || !state.backupPresent) {
		return false
	}
	const target = await lstatOrUndefined(prepared.targetPath, prepared.relativePath)
	if (target) {
		return false
	}
	await assertSafeParent(root, prepared.relativePath)
	try {
		const backup = await inspectArtifact(root, state.backupPath, `original for ${prepared.relativePath}`)
		if (state.backupStat && !sameIdentity(backup.stat, state.backupStat)) {
			return false
		}
		// This is the only target mutation allowed during abort cleanup: an exclusive
		// restore of bytes already claimed by this invocation. It never overwrites.
		return await linkExclusive(state.backupPath, prepared.targetPath, prepared.relativePath)
	} catch {
		return false
	}
}

async function cleanupFailure(root: string, states: RecoveryState[]): Promise<void> {
	for (const state of states) {
		await unlinkOwnedTemporary(state).catch(() => undefined)
		if (!state.backupClaimed) {
			await removeRecoveryDirectory(root, state).catch(() => undefined)
		}
	}
}

async function cleanupSuccess(root: string, states: RecoveryState[], signal: AbortSignal | undefined): Promise<void> {
	for (const state of states) {
		throwIfAborted(signal)
		await unlinkOwnedTemporary(state)
		// A writer holding the old inode can still change it after publication. Keep the
		// claimed original recoverable; a hash-then-unlink check cannot close that race.
		await removeRecoveryDirectory(root, state)
	}
}

function cloneReceipt(value: unknown): PatchReceipt | undefined {
	if (!isRecord(value) || typeof value.planId !== "string" || !Array.isArray(value.files)) {
		return undefined
	}
	const files: PatchReceipt["files"] = []
	for (const file of value.files) {
		if (
			!isRecord(file) ||
			typeof file.path !== "string" ||
			!/^[0-9a-f]{64}$/.test(String(file.beforeSha256)) ||
			!/^[0-9a-f]{64}$/.test(String(file.afterSha256))
		) {
			return undefined
		}
		files.push({
			path: file.path,
			beforeSha256: String(file.beforeSha256),
			afterSha256: String(file.afterSha256),
		})
	}
	const recoveryBackups = Array.isArray(value.recoveryBackups)
		? value.recoveryBackups.flatMap((entry) =>
				isRecord(entry) && typeof entry.targetPath === "string" && typeof entry.backupPath === "string"
					? [{ targetPath: entry.targetPath, backupPath: entry.backupPath }]
					: [],
			)
		: []
	return { planId: value.planId, files, ...(recoveryBackups.length ? { recoveryBackups } : {}) }
}

function makeReceipt(planId: string, applied: AppliedEdit[], states: RecoveryState[]): PatchReceipt {
	const recoveryBackups = states
		.filter((state) => state.backupPresent)
		.map((state) => ({
			targetPath: path.relative(stateRootForCleanup(state), state.targetPath).replace(/\\/g, "/"),
			backupPath: path.relative(stateRootForCleanup(state), state.backupPath).replace(/\\/g, "/"),
		}))
	return {
		planId,
		...(recoveryBackups.length ? { recoveryBackups } : {}),
		files: applied.flatMap(({ prepared, afterSha256 }) =>
			afterSha256 && /^[0-9a-f]{64}$/.test(afterSha256)
				? [{ path: prepared.relativePath, beforeSha256: prepared.before.sha256, afterSha256 }]
				: [],
		),
	}
}

function decorateFailure(error: unknown, receipt: PatchReceipt, signal: AbortSignal | undefined): Error {
	if (hasFailureReceipt(error)) return error
	const failure = signal?.aborted ? abortError() : isSafeError(error) ? error : patchError("patch plan failed")
	Object.defineProperty(failure, FAILURE_RECEIPT, { value: cloneReceipt(receipt), enumerable: false })
	return failure
}

function hasFailureReceipt(error: unknown): error is Error & FailureCarrier {
	return isRecord(error) && Object.prototype.hasOwnProperty.call(error, FAILURE_RECEIPT)
}

export function getPatchFailureReceipt(error: unknown): PatchReceipt | undefined {
	if (!hasFailureReceipt(error)) {
		return undefined
	}
	return cloneReceipt(error[FAILURE_RECEIPT])
}

function validatePlan(plan: PatchPlan): { id: string; edits: PatchEdit[] } {
	if (!isRecord(plan) || typeof plan.id !== "string" || plan.id.trim() === "" || !Array.isArray(plan.edits)) {
		throw patchError("patch plan must have a non-empty id and edits array")
	}
	if (plan.edits.length > MAX_FILES) {
		throw patchError(`patch plan exceeds the ${MAX_FILES}-file limit`)
	}
	return { id: plan.id, edits: plan.edits }
}

async function prepareEdits(
	root: string,
	allowedPaths: readonly string[],
	plan: { id: string; edits: PatchEdit[] },
	signal: AbortSignal | undefined,
): Promise<PreparedEdit[]> {
	if (!Array.isArray(allowedPaths)) {
		throw patchError("allowed paths must be an array")
	}

	const allowed = new Set<string>()
	for (const value of allowedPaths) {
		const normalized = normalizeRepoRelative(value)
		validateSourcePath(normalized)
		const key = pathKey(normalized)
		if (allowed.has(key)) {
			throw patchError(`duplicate allowed path: ${normalized}`)
		}
		allowed.add(key)
	}

	const normalizedEdits: Array<{ relativePath: string; expectedSha256: string; replacement: Buffer }> = []
	const seen = new Set<string>()
	let replacementBytes = 0
	for (const edit of plan.edits) {
		if (!isRecord(edit) || typeof edit.path !== "string" || typeof edit.replacement !== "string") {
			throw patchError("each patch edit must contain a path and replacement string")
		}
		const relativePath = normalizeRepoRelative(edit.path)
		validateSourcePath(relativePath)
		const key = pathKey(relativePath)
		if (!allowed.has(key)) {
			throw patchError(`path was not explicitly allowed: ${relativePath}`)
		}
		if (seen.has(key)) {
			throw patchError(`duplicate patch path: ${relativePath}`)
		}
		seen.add(key)
		const expectedSha256 = normalizeSha256(edit.expectedSha256, "expectedSha256")
		if (hasUnpairedSurrogate(edit.replacement)) {
			throw patchError(`replacement is not valid UTF-8 text: ${relativePath}`)
		}
		const replacement = Buffer.from(edit.replacement, "utf8")
		if (!isUtf8Text(replacement)) {
			throw patchError(`replacement is not UTF-8 text: ${relativePath}`)
		}
		replacementBytes += replacement.byteLength
		if (replacementBytes > MAX_REPLACEMENT_BYTES) {
			throw patchError(`replacements exceed the ${MAX_REPLACEMENT_BYTES}-byte limit`)
		}
		normalizedEdits.push({ relativePath, expectedSha256, replacement })
	}

	const prepared: PreparedEdit[] = []
	for (const edit of normalizedEdits) {
		throwIfAborted(signal)
		const before = await inspectExistingFile(root, edit.relativePath, true)
		if (before.sha256 !== edit.expectedSha256) {
			throw patchError(`hash mismatch: ${edit.relativePath}`)
		}
		prepared.push({
			relativePath: edit.relativePath,
			targetPath: path.resolve(root, ...edit.relativePath.split("/")),
			expectedSha256: edit.expectedSha256,
			replacement: edit.replacement,
			replacementSha256: sha256(edit.replacement),
			before,
		})
	}
	return prepared
}

async function applyOne(
	root: string,
	prepared: PreparedEdit,
	states: RecoveryState[],
	applied: AppliedEdit[],
	signal: AbortSignal | undefined,
): Promise<void> {
	const state = await createRecoveryState(root, prepared, signal)
	cleanupRoots.set(state, root)
	states.push(state)
	let published = false
	let recorded = false
	try {
		await writeReplacement(root, prepared, state, signal)
		await claimTarget(root, prepared, state, signal)
		await assertSafeParent(root, prepared.relativePath)
		throwIfAborted(signal)
		if (!(await linkExclusive(state.temporaryPath, prepared.targetPath, prepared.relativePath))) {
			throw patchError(`target was recreated before publish: ${prepared.relativePath}`)
		}
		published = true
		await unlinkOwnedTemporary(state)
		const after = await tryInspectCurrent(root, prepared)
		const result: AppliedEdit = { prepared, afterSha256: after?.sha256 }
		applied.push(result)
		recorded = true
		if (!after) {
			throw patchError(`published file could not be verified: ${prepared.relativePath}`)
		}
		if (after.sha256 !== prepared.replacementSha256) {
			throw patchError(`target changed after publish: ${prepared.relativePath}`)
		}
		throwIfAborted(signal)
	} catch (error) {
		if (!published && state.temporaryStat) {
			published = await tryInspectPublishedTarget(root, prepared, state.temporaryStat)
		}
		await unlinkOwnedTemporary(state).catch(() => undefined)
		if (published) {
			if (!recorded) {
				const after = await tryInspectCurrent(root, prepared)
				applied.push({ prepared, afterSha256: after?.sha256 })
			}
		} else if (state.backupClaimed) {
			await restoreClaim(root, prepared, state)
		} else {
			await removeRecoveryDirectory(root, state).catch(() => undefined)
		}
		throw error
	}
}

export async function applyPatchPlan(
	sourceRoot: string,
	allowedPaths: readonly string[],
	plan: PatchPlan,
	signal?: AbortSignal,
): Promise<PatchReceipt> {
	let planId = ""
	try {
		const validatedPlan = validatePlan(plan)
		planId = validatedPlan.id
		throwIfAborted(signal)
		const root = await getSourceRoot(sourceRoot)
		const prepared = await prepareEdits(root, allowedPaths, validatedPlan, signal)
		const states: RecoveryState[] = []
		const applied: AppliedEdit[] = []
		try {
			for (const edit of prepared) {
				throwIfAborted(signal)
				await applyOne(root, edit, states, applied, signal)
			}
		} catch (error) {
			await cleanupFailure(root, states)
			if (hasFailureReceipt(error)) {
				const receipt = getPatchFailureReceipt(error) ?? makeReceipt(planId, applied, states)
				throw decorateFailure(error, receipt, signal)
			}
			throw decorateFailure(error, makeReceipt(planId, applied, states), signal)
		}

		const receipt = makeReceipt(planId, applied, states)
		try {
			await cleanupSuccess(root, states, signal)
		} catch (error) {
			throw decorateFailure(error, receipt, signal)
		}
		return receipt
	} catch (error) {
		if (hasFailureReceipt(error)) {
			throw error
		}
		throw decorateFailure(error, { planId, files: [] }, signal)
	}
}
