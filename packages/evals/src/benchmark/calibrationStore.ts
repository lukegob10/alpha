import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { sha256 } from "../evidence/canonical"
import { ensureOwnedDirectory, readBoundedFile } from "../improvement/store"
import { calibrationReportSchema, type CalibrationReport } from "./contracts"

const MAX_REPORT_BYTES = 16 * 1024 * 1024
const DEFAULT_LOCK_TIMEOUT_MS = 2_000

export type CalibrationReportSnapshot = { report: CalibrationReport | undefined; revision: string | null }

/** Revised tasks get new report files; historical unversioned reports remain readable with their original identity. */
export async function resolveCalibrationReportPath(
	directory: string,
	taskIdentity: string,
	options: { write?: boolean } = {},
): Promise<string> {
	const match = /^([a-z0-9][a-z0-9._/-]*)@([1-9][0-9]*)$/.exec(taskIdentity)
	if (!match || match[1]!.split("/").some((part) => !part || part === "." || part === ".."))
		throw new Error("A safe versioned calibration task identity is required")
	const versioned = path.join(directory, `${taskIdentity}.keyless.json`)
	try {
		await fs.access(versioned)
		return versioned
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const legacy = path.join(directory, `${match[1]}.keyless.json`)
	if (!options.write) return legacy
	const snapshot = await readCalibrationReport(legacy)
	return snapshot.report?.taskIdentity === taskIdentity ? legacy : versioned
}

export class CalibrationReportValidationError extends Error {
	readonly code = "CALIBRATION_REPORT_INVALID"
	readonly issues: Array<{ message: string }>

	constructor(issues: Array<{ code: string; path: Array<string | number> }>) {
		super("Calibration report does not satisfy its schema")
		this.name = "CalibrationReportValidationError"
		// Schema locations are sufficient for repair; received values can contain private material.
		this.issues = issues.slice(0, 32).map(({ code, path: issuePath }) => ({
			message: `Invalid calibration field ${
				issuePath
					.slice(0, 8)
					.map((part) =>
						String(part)
							.replace(/[^a-zA-Z0-9_-]/g, "?")
							.slice(0, 64),
					)
					.join(".") || "report"
			} (${code})`,
		}))
	}
}

export class CalibrationReportConflictError extends Error {
	readonly code = "CALIBRATION_REPORT_CONFLICT"

	constructor(readonly reason: "locked" | "revision") {
		super(
			reason === "locked"
				? "Calibration report is locked; wait for its writer or inspect an orphaned lock before retrying"
				: "Calibration report changed; read its current revision before retrying",
		)
		this.name = "CalibrationReportConflictError"
	}
}

type FileIdentity = { dev: bigint; ino: bigint }
type OwnedFile = { file: string; identity: FileIdentity }
type HeldLock = OwnedFile & { handle: Awaited<ReturnType<typeof fs.open>> }

/** Historical reports keep their existing schema; revisions describe retained bytes, including whitespace. */
export async function readCalibrationReport(file: string): Promise<CalibrationReportSnapshot> {
	const absolute = resolveReportPath(file)
	let bytes: Uint8Array
	try {
		bytes = await readBoundedFile(absolute, MAX_REPORT_BYTES)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { report: undefined, revision: null }
		throw error
	}
	const stat = await fs.lstat(absolute)
	if (stat.nlink !== 1) throw new Error("Calibration reports must not have hard-link aliases")
	let value: unknown
	try {
		value = JSON.parse(new TextDecoder().decode(bytes))
	} catch {
		throw new Error("Calibration report must contain valid JSON")
	}
	return { report: parseReport(value), revision: sha256(bytes) }
}

/**
 * Coordinate local-filesystem writers before reading, then publish one validated replacement.
 * Exclusive creation is advisory for cooperating writers, not a distributed-filesystem lock.
 * An orphan is never age-stolen. External editors must honor the lock; the last revision check
 * detects earlier edits but cannot make a filesystem rename into a kernel compare-and-swap.
 * Node 24.21 fs contract: https://nodejs.org/download/release/v24.21.0/docs/api/fs.html#file-system-flags
 */
export async function updateCalibrationReport(
	file: string,
	updater: (current: CalibrationReport | undefined) => CalibrationReport | undefined,
	options: { expectedRevision?: string | null; lockTimeoutMs?: number } = {},
): Promise<CalibrationReportSnapshot> {
	const { expectedRevision, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = options
	if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 30_000)
		throw new Error("Calibration lock timeout must be an integer between zero and 30000 milliseconds")
	if (typeof updater !== "function") throw new Error("Calibration updater must be a synchronous function")
	const absolute = resolveReportPath(file)
	await ensureOwnedDirectory(path.dirname(absolute))
	const parent = await fs.realpath(path.dirname(absolute))
	const target = path.join(parent, path.basename(absolute))
	const directory = { file: parent, identity: await fs.lstat(parent, { bigint: true }) }
	const lock = await acquireLock(`${target}.calibration.lock`, directory, lockTimeoutMs)
	let temporary: OwnedFile | undefined
	const publish = async (): Promise<CalibrationReportSnapshot> => {
		const snapshot = await readCalibrationReport(target)
		if (expectedRevision !== undefined && snapshot.revision !== expectedRevision)
			throw new CalibrationReportConflictError("revision")
		const next = updater(snapshot.report ? structuredClone(snapshot.report) : undefined)
		if (next instanceof Promise) {
			// The invalid callback is rejected now; observe its later rejection without running a second update.
			void next.catch(() => undefined)
			throw new Error("Calibration updater must return synchronously")
		}
		if (next === undefined) return snapshot
		const report = parseReport(next)
		const bytes = JSON.stringify(report, null, 2) + "\n"
		if (Buffer.byteLength(bytes) > MAX_REPORT_BYTES) throw new Error("Calibration report exceeds its byte budget")
		await assertDirectory(directory)
		const temporaryPath = path.join(parent, `.calibration-${randomUUID()}.partial`)
		const handle = await fs.open(temporaryPath, "wx", 0o600)
		try {
			temporary = { file: temporaryPath, identity: await handle.stat({ bigint: true }) }
			await handle.writeFile(bytes)
			await handle.sync()
		} finally {
			await handle.close()
		}
		await assertDirectory(directory)
		await assertOwnedFile(lock)
		if ((await readCalibrationReport(target)).revision !== snapshot.revision)
			throw new CalibrationReportConflictError("revision")
		if (!temporary) throw new Error("Calibration publication has no owned temporary file")
		await assertOwnedFile(temporary)
		await fs.rename(temporaryPath, target)
		return { report, revision: sha256(bytes) }
	}
	let outcome: { snapshot: CalibrationReportSnapshot } | { failure: unknown }
	try {
		outcome = { snapshot: await publish() }
	} catch (error) {
		outcome = { failure: error }
	}
	const cleanupErrors: unknown[] = []
	if (temporary) {
		try {
			await removeOwnedFile(temporary, true)
		} catch (error) {
			cleanupErrors.push(error)
		}
	}
	try {
		await lock.handle.close()
	} catch (error) {
		cleanupErrors.push(error)
	}
	try {
		await removeOwnedFile(lock)
	} catch (error) {
		cleanupErrors.push(error)
	}
	if (cleanupErrors.length)
		throw new AggregateError(
			[...("failure" in outcome ? [outcome.failure] : []), ...cleanupErrors],
			"Calibration publication resource cleanup failed; inspect the owned lock before retrying",
		)
	if ("failure" in outcome) throw outcome.failure
	return outcome.snapshot
}

function resolveReportPath(file: string): string {
	if (typeof file !== "string" || !file || file.includes("\0"))
		throw new Error("A non-empty calibration report path is required")
	const name = file.split(/[\\/]/).at(-1)
	const absolute = path.resolve(file)
	const basename = path.basename(absolute)
	const stem = basename.split(".")[0]!.trimEnd()
	// Validate before creating a sidecar: Windows alternate streams and device names are not report files.
	if (
		!name ||
		name === "." ||
		name === ".." ||
		basename.includes(":") ||
		basename.includes("\\") ||
		/[. ]$/.test(basename) ||
		/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)
	)
		throw new Error("Calibration report path has an unsafe or reserved filename")
	return absolute
}

function parseReport(value: unknown): CalibrationReport {
	const parsed = calibrationReportSchema.safeParse(value)
	if (!parsed.success) throw new CalibrationReportValidationError(parsed.error.issues)
	return parsed.data
}

async function assertDirectory(directory: OwnedFile): Promise<void> {
	if ((await fs.realpath(directory.file)) !== directory.file)
		throw new Error("Calibration directory changed its physical path during publication")
	const stat = await fs.lstat(directory.file, { bigint: true })
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.dev !== directory.identity.dev ||
		stat.ino !== directory.identity.ino
	)
		throw new Error("Calibration directory changed during publication")
}

async function assertOwnedFile(owned: OwnedFile): Promise<void> {
	const stat = await fs.lstat(owned.file, { bigint: true })
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1n ||
		stat.dev !== owned.identity.dev ||
		stat.ino !== owned.identity.ino
	)
		throw new Error("Calibration publication file ownership changed")
}

async function removeOwnedFile(owned: OwnedFile, allowMissing = false): Promise<void> {
	try {
		await assertOwnedFile(owned)
	} catch (error) {
		if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}
	await fs.unlink(owned.file)
}

async function acquireLock(file: string, directory: OwnedFile, timeoutMs: number): Promise<HeldLock> {
	const deadline = performance.now() + timeoutMs
	while (true) {
		await assertDirectory(directory)
		let handle: Awaited<ReturnType<typeof fs.open>>
		try {
			handle = await fs.open(file, "wx", 0o600)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			let stat: Awaited<ReturnType<typeof fs.lstat>>
			try {
				stat = await fs.lstat(file)
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError
				if (performance.now() >= deadline) throw new CalibrationReportConflictError("locked")
				continue
			}
			if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
				throw new Error("Calibration lock must be an unaliased regular file")
			const remaining = deadline - performance.now()
			if (remaining <= 0) throw new CalibrationReportConflictError("locked")
			await delay(Math.min(50, remaining))
			continue
		}
		let lock: HeldLock | undefined
		try {
			lock = { file, identity: await handle.stat({ bigint: true }), handle }
			await handle.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: randomUUID() }) + "\n")
			return lock
		} catch (error) {
			await handle.close()
			// Failed identity collection cannot justify deleting a possibly replaced path.
			if (lock) await removeOwnedFile(lock)
			throw error
		}
	}
}
