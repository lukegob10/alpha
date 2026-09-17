import { randomUUID } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import type { Stats } from "fs"
import {
	EVIDENCE_ROOT_MARKER,
	readBounded,
	rejectSymlinkComponents,
	requireEvidenceRoot,
	requireEvidenceRun,
} from "./paths"

export const EVIDENCE_RETENTION_ELIGIBLE = ".retention-eligible.json"
export interface EvidenceRetentionOptions {
	artifactsRoot: string
	maxRuns?: number
	maxBytes?: number
	maxAgeMs?: number
	keepRunIds?: string[]
	now?: number
}
export interface EvidenceRetentionResult {
	removedRunIds: string[]
	keptRunIds: string[]
	protectedRunIds: string[]
	skippedEntries: number
	retainedBytes: number
	retainedRuns: number
	/** False means diagnostic observations may be partial or invalidated by a race, not a current quota claim. */
	complete: boolean
	overBudget: boolean
	warnings: Array<"scan_incomplete" | "concurrent_change">
}
type Stat = Stats
type Stamp = { relative: string; stat: Stat }
type RunManifest = { completedAt?: number; passed: boolean }
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid retention receipt")
	return value as Record<string, unknown>
}
async function json(file: string, limit: number): Promise<Record<string, unknown>> {
	return object(JSON.parse((await readBounded(file, limit)).toString("utf8")))
}
async function readManifest(directory: string, runId: string): Promise<RunManifest> {
	const manifest = await json(path.join(directory, "manifest.json"), 4 * 1_024 * 1_024)
	const metadata = object(manifest.metadata)
	if (manifest.kind !== "alpha-vscode-e2e-run-evidence" || manifest.version !== 1 || manifest.runId !== runId)
		throw new Error("Unrecognized retention manifest")
	const completedAt = typeof metadata.finishedAt === "string" ? Date.parse(metadata.finishedAt) : NaN
	return {
		...(Number.isFinite(completedAt) ? { completedAt } : {}),
		passed:
			manifest.finalized === true &&
			manifest.captureComplete === true &&
			metadata.outcome === "passed" &&
			Number.isFinite(completedAt),
	}
}
const eligibleBytes = (runId: string) => JSON.stringify({ kind: "alpha-vscode-e2e-inactive", version: 1, runId })
/** LAST producer write, after callbacks, final receipts and profile-lease release. Campaigns defer until their terminal report. */
export async function markRunRetentionEligible(options: { artifactsRoot: string; runId: string }): Promise<void> {
	const root = await requireEvidenceRoot(options.artifactsRoot)
	const directory = await requireEvidenceRun(root, options.runId)
	if (!(await readManifest(directory, options.runId)).passed)
		throw new Error("Only complete passed evidence can become inactive")
	const result = await json(path.join(directory, "run-result.json"), 64 * 1_024)
	if (
		result.runId !== options.runId ||
		result.status !== "passed" ||
		result.exitCode !== 0 ||
		result.execution !== "extension-host" ||
		result.ownershipGate !== "verified" ||
		result.hostExitObserved !== true ||
		result.captureComplete !== true ||
		![result.launchedHostPid, result.extensionHostPid, result.extensionHostParentPid].every(
			(pid) => Number.isSafeInteger(pid) && Number(pid) > 0 && Number(pid) <= 2_147_483_647,
		)
	)
		throw new Error("Run inactivity requires a verified successful owned host close")
	const receipt = path.join(directory, EVIDENCE_RETENTION_ELIGIBLE)
	const bytes = eligibleBytes(options.runId)
	try {
		if ((await readBounded(receipt, 512)).toString("utf8") === bytes) return
		throw new Error("Conflicting inactive receipt")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	// Fully write and close before atomic no-replace publication. Keep this tiny hard-link
	// sibling for the artifact pruner: no fallible cleanup or further writes follow publication.
	const candidate = path.join(directory, `.retention-eligible-${randomUUID()}.candidate`)
	await fs.writeFile(candidate, bytes, { flag: "wx", mode: 0o600 })
	try {
		await fs.link(candidate, receipt)
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "EEXIST" ||
			(await readBounded(receipt, 512)).toString("utf8") !== bytes
		)
			throw error
	}
}
async function isEligible(directory: string, runId: string): Promise<boolean> {
	try {
		return (
			(await readManifest(directory, runId)).passed &&
			(await readBounded(path.join(directory, EVIDENCE_RETENTION_ELIGIBLE), 512)).toString("utf8") ===
				eligibleBytes(runId)
		)
	} catch {
		return false
	}
}
const sameIdentity = (first: Stat, second: Stat) => first.dev === second.dev && first.ino === second.ino
const sameFile = (first: Stat, second: Stat) =>
	sameIdentity(first, second) && first.size === second.size && first.mtimeMs === second.mtimeMs

/** One pruner: explicitly inactive successful runs only; never raw sources or failed evidence. */
export async function pruneRunEvidence(options: EvidenceRetentionOptions): Promise<EvidenceRetentionResult> {
	const maxRuns = options.maxRuns ?? 20
	const maxBytes = options.maxBytes ?? 100 * 1_024 * 1_024
	const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1_000
	const now = options.now ?? Date.now()
	if (
		![maxRuns, maxBytes, maxAgeMs].every((value) => Number.isSafeInteger(value) && value > 0) ||
		!Number.isFinite(now) ||
		(options.keepRunIds &&
			(options.keepRunIds.length > 10_000 || options.keepRunIds.some((id) => !identifier.test(id))))
	)
		throw new Error("Invalid evidence retention limits")
	const root = await requireEvidenceRoot(options.artifactsRoot)
	const keep = new Set(options.keepRunIds ?? [])
	const result: EvidenceRetentionResult = {
		removedRunIds: [],
		keptRunIds: [],
		protectedRunIds: [],
		skippedEntries: 0,
		retainedBytes: 0,
		retainedRuns: 0,
		complete: true,
		overBudget: false,
		warnings: [],
	}
	const warn = (warning: EvidenceRetentionResult["warnings"][number]) => {
		result.complete = false
		if (!result.warnings.includes(warning)) result.warnings.push(warning)
	}
	const runs: Array<{
		runId: string
		directory: string
		stat: Stat
		completedAt?: number
		eligible: boolean
		files: Stamp[]
		directories: Stamp[]
	}> = []
	let scanned = 0
	let scannedRoots = 0
	const entries = await fs.opendir(root)
	for await (const entry of entries) {
		if (++scanned > 100_000 || ++scannedRoots > 10_000) {
			warn("scan_incomplete")
			break
		}
		if (entry.name === EVIDENCE_ROOT_MARKER) continue
		const directory = path.join(root, entry.name)
		let stat: Stat
		try {
			await rejectSymlinkComponents(directory)
			stat = await fs.lstat(directory)
		} catch {
			result.skippedEntries++
			warn("scan_incomplete")
			continue
		}
		if (!stat.isDirectory()) {
			result.skippedEntries++
			if (stat.isFile()) result.retainedBytes += stat.size
			else warn("scan_incomplete")
			continue
		}
		const files: Stamp[] = []
		const directories: Stamp[] = []
		let measured = true
		const walk = async (current: string, depth = 0): Promise<void> => {
			if (depth > 32 || files.length + directories.length >= 10_000) throw new Error("Retention scan limit")
			await rejectSymlinkComponents(current)
			const before = await fs.lstat(current)
			if (!before.isDirectory()) throw new Error("Retention directory changed")
			const children = await fs.opendir(current)
			for await (const child of children) {
				if (++scanned > 100_000 || files.length + directories.length >= 10_000)
					throw new Error("Retention scan limit")
				const file = path.join(current, child.name)
				const childStat = await fs.lstat(file)
				if (childStat.isSymbolicLink()) throw new Error("Retention symlink")
				if (childStat.isDirectory()) {
					await walk(file, depth + 1)
					directories.push({ relative: path.relative(directory, file), stat: childStat })
				} else if (childStat.isFile()) {
					files.push({ relative: path.relative(directory, file), stat: childStat })
					result.retainedBytes += childStat.size
				} else throw new Error("Unsupported retention entry")
			}
			const after = await fs.lstat(current)
			if (!sameIdentity(before, after) || before.mtimeMs !== after.mtimeMs)
				throw new Error("Retention directory changed")
		}
		try {
			await walk(directory)
		} catch {
			measured = false
			warn("scan_incomplete")
		}
		try {
			await requireEvidenceRun(root, entry.name)
		} catch {
			result.skippedEntries++
			continue
		}
		result.retainedRuns++
		let manifest: RunManifest | undefined
		try {
			manifest = await readManifest(directory, entry.name)
		} catch {
			/* Active, partial and legacy runs stay protected. */
		}
		const eligible = measured && !keep.has(entry.name) && (await isEligible(directory, entry.name))
		if (!eligible) {
			result.protectedRunIds.push(entry.name)
			result.skippedEntries++
		}
		runs.push({
			runId: entry.name,
			directory,
			stat,
			completedAt: manifest?.completedAt,
			eligible,
			files,
			directories,
		})
	}
	runs.sort((a, b) => (a.completedAt ?? Infinity) - (b.completedAt ?? Infinity) || a.runId.localeCompare(b.runId))
	for (const run of runs) {
		const old = run.completedAt !== undefined && now - run.completedAt > maxAgeMs
		if (!run.eligible || (result.retainedRuns <= maxRuns && result.retainedBytes <= maxBytes && !old)) {
			result.keptRunIds.push(run.runId)
			continue
		}
		try {
			await rejectSymlinkComponents(run.directory)
			if (!sameIdentity(run.stat, await fs.lstat(run.directory)) || !(await isEligible(run.directory, run.runId)))
				throw new Error("Retention candidate changed")
			const quarantine = path.join(root, `.pruning-${randomUUID()}`)
			await fs.rename(run.directory, quarantine)
			for (const file of run.files) {
				const filePath = path.join(quarantine, file.relative)
				await rejectSymlinkComponents(filePath)
				const current = await fs.lstat(filePath)
				if (!current.isFile() || !sameFile(file.stat, current)) throw new Error("Retention file changed")
				await fs.unlink(filePath)
				result.retainedBytes -= file.stat.size
			}
			for (const subdirectory of run.directories) {
				const directory = path.join(quarantine, subdirectory.relative)
				await rejectSymlinkComponents(directory)
				const current = await fs.lstat(directory)
				if (!current.isDirectory() || !sameIdentity(subdirectory.stat, current))
					throw new Error("Retention directory changed")
				await fs.rmdir(directory)
			}
			await fs.rmdir(quarantine)
			result.removedRunIds.push(run.runId)
			result.retainedRuns--
		} catch {
			// Never retry a destructive operation blindly after concurrent pruning or external edits.
			result.skippedEntries++
			result.keptRunIds.push(run.runId)
			warn("concurrent_change")
		}
	}
	result.overBudget =
		result.retainedRuns > maxRuns ||
		result.retainedBytes > maxBytes ||
		runs.some(
			(run) =>
				!result.removedRunIds.includes(run.runId) &&
				run.completedAt !== undefined &&
				now - run.completedAt > maxAgeMs,
		)
	return result
}
