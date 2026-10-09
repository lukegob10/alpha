import type { DatabaseSync } from "node:sqlite"

/**
 * A kernel-owned mutex for bookkeeping, using SQLite's cross-platform file locks.
 * This database holds no task data. Closing the connection or losing the process
 * releases ownership; the persistent file's existence never denotes a live lock.
 */
export class AgentControlTransactionGuard {
	private database?: DatabaseSync

	constructor(private readonly filePath: string) {}

	get owned(): boolean {
		return this.database !== undefined
	}

	async tryAcquire(): Promise<boolean> {
		if (this.database) throw new Error("Agent control transaction guard is already acquired")
		// Load the builtin only when persistence runs, rather than during activation.
		const { DatabaseSync } = await import("node:sqlite")
		const database = new DatabaseSync(this.filePath, { timeout: 0, allowExtension: false })
		try {
			// No schema or writes: SQLite supplies the OS lock, while JSON remains
			// authoritative. Zero busy timeout keeps contention off the event loop.
			database.exec("BEGIN EXCLUSIVE")
			this.database = database
			return true
		} catch (error) {
			database.close()
			const sqliteError = error as { code?: string; errcode?: number }
			if (sqliteError?.code === "ERR_SQLITE_ERROR" && (sqliteError.errcode === 5 || sqliteError.errcode === 6)) {
				return false
			}
			throw error
		}
	}

	close(): void {
		const database = this.database
		this.database = undefined
		// sqlite3_close_v2 rolls back the read-only transaction and releases its
		// OS handles. There is no lock-directory cleanup required to release it.
		database?.close()
	}
}
