import * as fs from "fs/promises"
import * as path from "path"
import type { Stats } from "fs"
import { performance } from "node:perf_hooks"

import { assertSafeRoot, isWithin, rejectSymlinkComponents } from "./paths"

const DEFAULT_MAX_BYTES = 10 * 1_024 * 1_024 * 1_024
const DEFAULT_MAX_ENTRIES = 100_000
const DEFAULT_MAX_DEPTH = 32
const HARD_MAX_BYTES = 100 * 1_024 * 1_024 * 1_024
const HARD_MAX_ENTRIES = 1_000_000
const HARD_MAX_DEPTH = 32
// A persistent authenticated profile plus retained campaigns can need ~10s of metadata I/O on Windows.
// Allow bounded headroom without dropping ownership, mutation, entry, byte, or depth checks.
const SCAN_TIME_BUDGET_MS = 30_000
const MAX_ROOTS = 16

export interface RetainedStorageRoot {
	path: string
	label: string
	allowMissing?: boolean
}

export interface RetainedStorageBudgetLimits {
	maxBytes?: number
	maxEntries?: number
	maxDepth?: number
}

export interface RetainedStorageBudgetOptions {
	roots: Array<RetainedStorageRoot>
	limits?: RetainedStorageBudgetLimits
	assertOwned: (canonicalExistingOrResolvedMissingPath: string) => Promise<void>
	signal?: AbortSignal
}

export type RetainedStorageBudgetReason =
	| "byte_limit"
	| "entry_limit"
	| "depth_limit"
	| "symlink"
	| "changed"
	| "unreadable"
	| "timeout"
	| "aborted"
	| "ownership"

export interface RetainedStorageBudgetResult {
	status: "within_budget" | "over_budget" | "unknown"
	complete: boolean
	bytes: number
	entries: number
	roots: number
	reason?: RetainedStorageBudgetReason
}

interface ValidatedRoot {
	path: string
	label: string
	allowMissing: boolean
}

interface ValidatedOptions {
	roots: Array<ValidatedRoot>
	maxBytes: number
	maxEntries: number
	maxDepth: number
	assertOwned: (canonicalExistingOrResolvedMissingPath: string) => Promise<void>
	signal?: AbortSignal
}

interface ScanState {
	bytes: number
	entries: number
	deadline: number
	options: ValidatedOptions
}

interface PreparedRoot {
	canonicalPath: string
	missing: boolean
	rootStat?: Stats
	anchorPath?: string
	anchorStat?: Stats
}

class AuditFailure extends Error {
	readonly reason: RetainedStorageBudgetReason

	constructor(reason: RetainedStorageBudgetReason) {
		super(reason)
		this.name = "RetainedStorageAuditFailure"
		this.reason = reason
	}
}

function fail(reason: RetainedStorageBudgetReason): never {
	throw new AuditFailure(reason)
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}

function isSymlinkError(error: unknown): boolean {
	return isErrorCode(error, "ELOOP") || (error instanceof Error && error.message.toLowerCase().includes("symlink"))
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return typeof value === "object" && value !== null && typeof (value as { aborted?: unknown }).aborted === "boolean"
}

function samePath(left: string, right: string): boolean {
	const normalizedLeft = path.normalize(left)
	const normalizedRight = path.normalize(right)
	if (process.platform === "win32") return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
	return normalizedLeft === normalizedRight
}

function canonicalKey(value: string): string {
	return path.normalize(value)
}

function pathIsWithin(root: string, candidate: string): boolean {
	const normalizedRoot = path.normalize(root)
	const normalizedCandidate = path.normalize(candidate)
	if (process.platform !== "win32" && isWithin(normalizedRoot, normalizedCandidate)) return true
	if (normalizedRoot === normalizedCandidate) return true
	const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`
	return normalizedCandidate.startsWith(prefix)
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino
}

function sameDirectoryObservation(left: Stats, right: Stats): boolean {
	return sameIdentity(left, right) && left.mtimeMs === right.mtimeMs && left.isDirectory() === right.isDirectory()
}

function sameFileObservation(left: Stats, right: Stats): boolean {
	return (
		sameIdentity(left, right) &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.isFile() === right.isFile()
	)
}

function validateLimit(value: unknown, name: string, fallback: number, ceiling: number): number {
	if (value === undefined) return fallback
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
		throw new RangeError(`Invalid retained storage limit: ${name}`)
	}
	return value
}

function validateOptions(options: RetainedStorageBudgetOptions): ValidatedOptions {
	if (typeof options !== "object" || options === null) throw new TypeError("Retained storage options are required")
	if (!Array.isArray(options.roots)) throw new TypeError("Retained storage roots must be an array")
	if (options.roots.length === 0 || options.roots.length > MAX_ROOTS) {
		throw new RangeError(`Retained storage roots must contain 1-${MAX_ROOTS} entries`)
	}
	if (typeof options.assertOwned !== "function")
		throw new TypeError("Retained storage ownership validator is required")
	if (options.signal !== undefined && !isAbortSignal(options.signal)) {
		throw new TypeError("Retained storage signal is invalid")
	}

	const limits = options.limits
	if (limits !== undefined && (typeof limits !== "object" || limits === null || Array.isArray(limits))) {
		throw new TypeError("Retained storage limits are invalid")
	}

	const validatedRoots = options.roots.map((root, index) => {
		if (typeof root !== "object" || root === null) throw new TypeError(`Invalid retained storage root ${index}`)
		if (typeof root.path !== "string") throw new TypeError(`Invalid retained storage root path ${index}`)
		if (typeof root.label !== "string") throw new TypeError(`Invalid retained storage root label ${index}`)
		if (root.label.length > 128) throw new RangeError(`Invalid retained storage root label ${index}`)
		if (root.allowMissing !== undefined && typeof root.allowMissing !== "boolean") {
			throw new TypeError(`Invalid retained storage allowMissing option ${index}`)
		}
		return {
			path: assertSafeRoot(root.path),
			label: root.label,
			allowMissing: root.allowMissing === true,
		}
	})

	return {
		roots: validatedRoots,
		maxBytes: validateLimit(limits?.maxBytes, "maxBytes", DEFAULT_MAX_BYTES, HARD_MAX_BYTES),
		maxEntries: validateLimit(limits?.maxEntries, "maxEntries", DEFAULT_MAX_ENTRIES, HARD_MAX_ENTRIES),
		maxDepth: validateLimit(limits?.maxDepth, "maxDepth", DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH),
		assertOwned: options.assertOwned,
		signal: options.signal,
	}
}

function checkBudget(state: ScanState): void {
	if (state.options.signal?.aborted) fail("aborted")
	if (performance.now() >= state.deadline) fail("timeout")
}

function mapFilesystemError(error: unknown, fallback: RetainedStorageBudgetReason): never {
	if (error instanceof AuditFailure) throw error
	if (isSymlinkError(error)) fail("symlink")
	if (isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM")) fail("unreadable")
	if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) fail(fallback)
	fail(fallback === "unreadable" ? "unreadable" : fallback)
}

async function checkedOperation<T>(
	state: ScanState,
	operation: () => Promise<T>,
	fallback: RetainedStorageBudgetReason,
): Promise<T> {
	checkBudget(state)
	try {
		const result = await operation()
		checkBudget(state)
		return result
	} catch (error) {
		mapFilesystemError(error, fallback)
	}
}

async function checkedLstat(state: ScanState, target: string, fallback: RetainedStorageBudgetReason): Promise<Stats> {
	return checkedOperation(state, () => fs.lstat(target), fallback)
}

async function checkedRejectSymlinkComponents(state: ScanState, target: string): Promise<void> {
	await checkedOperation(state, () => rejectSymlinkComponents(target), "changed")
}

async function lstatMaybeMissing(state: ScanState, target: string): Promise<Stats | undefined> {
	checkBudget(state)
	try {
		const result = await fs.lstat(target)
		checkBudget(state)
		return result
	} catch (error) {
		if (state.options.signal?.aborted) fail("aborted")
		if (isErrorCode(error, "ENOENT")) return undefined
		mapFilesystemError(error, "unreadable")
	}
}

async function verifyOwnership(state: ScanState, canonicalPath: string): Promise<void> {
	checkBudget(state)
	try {
		await state.options.assertOwned(canonicalPath)
	} catch {
		if (state.options.signal?.aborted) fail("aborted")
		fail("ownership")
	}
	checkBudget(state)
}

async function resolveMissingRoot(
	state: ScanState,
	requestedPath: string,
): Promise<{ canonicalPath: string; anchorPath: string; anchorStat: Stats }> {
	const missingComponents = [path.basename(requestedPath)]
	let cursor = path.dirname(requestedPath)

	while (true) {
		const anchorStat = await lstatMaybeMissing(state, cursor)
		if (!anchorStat) {
			const parent = path.dirname(cursor)
			if (samePath(parent, cursor)) fail("unreadable")
			missingComponents.unshift(path.basename(cursor))
			cursor = parent
			continue
		}
		if (anchorStat.isSymbolicLink()) fail("symlink")
		if (!anchorStat.isDirectory()) fail("unreadable")

		await checkedRejectSymlinkComponents(state, cursor)
		const canonicalAnchor = await checkedOperation(state, () => fs.realpath(cursor), "changed")
		const canonicalPath = path.resolve(canonicalAnchor, ...missingComponents)
		try {
			assertSafeRoot(canonicalPath)
		} catch {
			fail("changed")
		}
		if (!pathIsWithin(canonicalAnchor, canonicalPath)) fail("changed")
		const canonicalAnchorStat = await checkedLstat(state, canonicalAnchor, "changed")
		if (!sameDirectoryObservation(anchorStat, canonicalAnchorStat)) fail("changed")
		return { canonicalPath, anchorPath: canonicalAnchor, anchorStat: canonicalAnchorStat }
	}
}

async function prepareRoot(state: ScanState, root: ValidatedRoot): Promise<PreparedRoot> {
	await checkedRejectSymlinkComponents(state, root.path)
	const initial = await lstatMaybeMissing(state, root.path)
	if (!initial) {
		if (!root.allowMissing) fail("unreadable")
		const missing = await resolveMissingRoot(state, root.path)
		await verifyOwnership(state, missing.canonicalPath)

		const currentAnchor = await checkedLstat(state, missing.anchorPath, "changed")
		if (!sameDirectoryObservation(missing.anchorStat, currentAnchor)) fail("changed")
		if (await lstatMaybeMissing(state, root.path)) fail("changed")
		return { ...missing, missing: true }
	}
	if (initial.isSymbolicLink()) fail("symlink")
	if (!initial.isDirectory()) fail("unreadable")

	const canonicalPath = await checkedOperation(state, () => fs.realpath(root.path), "changed")
	try {
		assertSafeRoot(canonicalPath)
	} catch {
		fail("changed")
	}
	await checkedRejectSymlinkComponents(state, canonicalPath)
	const canonicalStat = await checkedLstat(state, canonicalPath, "changed")
	if (!canonicalStat.isDirectory() || !sameIdentity(initial, canonicalStat)) fail("changed")
	await verifyOwnership(state, canonicalPath)
	return { canonicalPath, missing: false, rootStat: canonicalStat }
}

function deduplicateRoots(roots: Array<PreparedRoot>): Array<PreparedRoot> {
	const ordered = [...roots].sort(
		(left, right) =>
			canonicalKey(left.canonicalPath).length - canonicalKey(right.canonicalPath).length ||
			canonicalKey(left.canonicalPath).localeCompare(canonicalKey(right.canonicalPath)),
	)
	const selected: Array<PreparedRoot> = []
	for (const candidate of ordered) {
		if (
			selected.some(
				(existing) =>
					pathIsWithin(existing.canonicalPath, candidate.canonicalPath) ||
					(!!existing.rootStat &&
						!!candidate.rootStat &&
						sameIdentity(existing.rootStat, candidate.rootStat)),
			)
		)
			continue
		for (let index = selected.length - 1; index >= 0; index--) {
			const selectedRoot = selected[index]
			if (
				selectedRoot &&
				(pathIsWithin(candidate.canonicalPath, selectedRoot.canonicalPath) ||
					(!!selectedRoot.rootStat &&
						!!candidate.rootStat &&
						sameIdentity(selectedRoot.rootStat, candidate.rootStat)))
			) {
				selected.splice(index, 1)
			}
		}
		selected.push(candidate)
	}
	return selected.sort((left, right) =>
		canonicalKey(left.canonicalPath).localeCompare(canonicalKey(right.canonicalPath)),
	)
}

async function walkDirectory(
	state: ScanState,
	current: string,
	root: string,
	depth: number,
	expectedRoot?: Stats,
): Promise<void> {
	checkBudget(state)
	if (!pathIsWithin(root, current)) fail("changed")
	await checkedRejectSymlinkComponents(state, current)
	const before = await checkedLstat(state, current, "changed")
	if (before.isSymbolicLink()) fail("symlink")
	if (!before.isDirectory()) fail("changed")
	if (expectedRoot && !sameDirectoryObservation(expectedRoot, before)) fail("changed")

	const directory = await checkedOperation(state, () => fs.opendir(current), "changed")
	for await (const entry of directory) {
		checkBudget(state)
		if (state.entries >= state.options.maxEntries) fail("entry_limit")
		const child = path.join(current, entry.name)
		if (!pathIsWithin(root, child)) fail("changed")
		state.entries++

		await checkedRejectSymlinkComponents(state, child)
		const childBefore = await checkedLstat(state, child, "changed")
		if (childBefore.isSymbolicLink()) fail("symlink")
		if (childBefore.isDirectory()) {
			if (depth >= state.options.maxDepth) fail("depth_limit")
			await walkDirectory(state, child, root, depth + 1)
			const childAfter = await checkedLstat(state, child, "changed")
			if (!sameDirectoryObservation(childBefore, childAfter)) fail("changed")
			continue
		}
		if (!childBefore.isFile()) fail("unreadable")

		const childAfter = await checkedLstat(state, child, "changed")
		if (!sameFileObservation(childBefore, childAfter)) fail("changed")
		const size = childBefore.size
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) fail("unreadable")
		if (state.bytes > Number.MAX_SAFE_INTEGER - size) state.bytes = Number.MAX_SAFE_INTEGER
		else state.bytes += size
		if (state.bytes > state.options.maxBytes) fail("byte_limit")
	}

	const after = await checkedLstat(state, current, "changed")
	if (!sameDirectoryObservation(before, after)) fail("changed")
}

async function verifyMissingRootAtEnd(state: ScanState, root: PreparedRoot): Promise<void> {
	if (!root.anchorPath || !root.anchorStat) fail("changed")
	const currentAnchor = await checkedLstat(state, root.anchorPath, "changed")
	if (!sameDirectoryObservation(root.anchorStat, currentAnchor)) fail("changed")
	if (await lstatMaybeMissing(state, root.canonicalPath)) fail("changed")
}

function result(
	state: ScanState,
	roots: number,
	status: RetainedStorageBudgetResult["status"],
	complete: boolean,
	reason?: RetainedStorageBudgetReason,
): RetainedStorageBudgetResult {
	return {
		status,
		complete,
		bytes: state.bytes,
		entries: state.entries,
		roots,
		...(reason ? { reason } : {}),
	}
}

function failureResult(state: ScanState, roots: number, error: unknown): RetainedStorageBudgetResult {
	if (error instanceof AuditFailure) {
		if (error.reason === "byte_limit" || error.reason === "entry_limit") {
			return result(state, roots, "over_budget", false, error.reason)
		}
		return result(state, roots, "unknown", false, error.reason)
	}
	return result(state, roots, "unknown", false, "unreadable")
}

export async function auditRetainedStorage(
	options: RetainedStorageBudgetOptions,
): Promise<RetainedStorageBudgetResult> {
	const validated = validateOptions(options)
	const state: ScanState = {
		bytes: 0,
		entries: 0,
		deadline: performance.now() + SCAN_TIME_BUDGET_MS,
		options: validated,
	}
	const prepared: Array<PreparedRoot> = []
	let scanRoots: Array<PreparedRoot> = []

	try {
		checkBudget(state)
		for (const root of validated.roots) prepared.push(await prepareRoot(state, root))
		scanRoots = deduplicateRoots(prepared)
		for (const root of scanRoots) {
			checkBudget(state)
			if (root.missing) {
				if (await lstatMaybeMissing(state, root.canonicalPath)) fail("changed")
				continue
			}
			const beforeWalk = await checkedLstat(state, root.canonicalPath, "changed")
			if (!root.rootStat || !sameDirectoryObservation(root.rootStat, beforeWalk)) fail("changed")
			await walkDirectory(state, root.canonicalPath, root.canonicalPath, 0, root.rootStat)
		}
		for (const root of scanRoots) if (root.missing) await verifyMissingRootAtEnd(state, root)
		return result(state, scanRoots.length, "within_budget", true)
	} catch (error) {
		return failureResult(state, scanRoots.length || deduplicateRoots(prepared).length, error)
	}
}
