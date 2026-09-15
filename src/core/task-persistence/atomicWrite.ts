import * as fs from "fs/promises"
import * as path from "path"
import * as lockfile from "proper-lockfile"

// Six rename attempts with 775 ms of total backoff. Keep persistence bounded
// while allowing short-lived filesystem sharing violations to clear.
const atomicReplaceRetryDelaysMs = [25, 50, 100, 200, 400] as const

async function renameWithRetry(source: string, destination: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(source, destination)
			return
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code
			if (
				(code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") ||
				attempt >= atomicReplaceRetryDelaysMs.length
			) {
				throw error
			}
			// Retry only the atomic replacement: the same synced, closed temp file
			// and the caller's transaction lock remain owned throughout the wait.
			await new Promise<void>((resolve) => setTimeout(resolve, atomicReplaceRetryDelaysMs[attempt]))
		}
	}
}

/**
 * Execute a file operation while holding an advisory lock for that file.
 *
 * The authoritative history writer and receipt verifier share this lock.
 * Stores also hold it across read/compare/write transactions, which
 * `safeWriteJson` cannot do.
 */
export async function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
	const absolutePath = path.resolve(filePath)
	await fs.mkdir(path.dirname(absolutePath), { recursive: true })

	const release = await lockfile.lock(absolutePath, {
		stale: 31_000,
		update: 10_000,
		realpath: false,
		retries: {
			retries: 8,
			factor: 2,
			minTimeout: 25,
			maxTimeout: 500,
		},
	})

	try {
		return await operation()
	} finally {
		await release()
	}
}

/**
 * Atomically replace a UTF-8 file by writing a sibling temporary file first.
 * The caller owns any desired lock; this function intentionally does not
 * acquire one so it can be used inside a read/compare/write transaction.
 */
export async function atomicWriteText(
	filePath: string,
	contents: string,
	options: { requireAtomicReplace?: boolean } = {},
): Promise<void> {
	const absolutePath = path.resolve(filePath)
	const directory = path.dirname(absolutePath)
	await fs.mkdir(directory, { recursive: true })

	const temporaryPath = path.join(
		directory,
		`.${path.basename(absolutePath)}.new_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`,
	)

	try {
		const handle = await fs.open(temporaryPath, "w")
		try {
			await handle.writeFile(contents, "utf8")
			await handle.sync()
		} finally {
			await handle.close()
		}

		try {
			await renameWithRetry(temporaryPath, absolutePath)
		} catch (error) {
			// The sole authoritative transcript must retain its previous durable
			// snapshot if the platform cannot replace it atomically.
			if (options.requireAtomicReplace) throw error
			// POSIX replaces an existing destination with rename. Windows can
			// reject that operation, so make the narrow compatibility fallback
			// only when the destination is present. The temp file is still fully
			// written before this point, and all callers hold the file lock.
			const code = (error as NodeJS.ErrnoException).code
			if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw error
			await fs.rm(absolutePath, { force: true })
			await fs.rename(temporaryPath, absolutePath)
		}
	} finally {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
	}
}

export async function atomicWriteJson(
	filePath: string,
	value: unknown,
	options: { requireAtomicReplace?: boolean } = {},
): Promise<void> {
	await atomicWriteText(filePath, `${JSON.stringify(value)}\n`, options)
}
