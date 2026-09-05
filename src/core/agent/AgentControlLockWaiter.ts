import * as fs from "fs"
import * as path from "path"

import { AgentControlTransactionError, throwIfTransactionCancelled } from "./AgentControlTransaction"

/** Filesystem events only shorten polling; mkdir remains the ownership boundary. */
export class AgentControlLockWaiter {
	private watcher?: fs.FSWatcher
	private generation = 0
	private wake?: () => void

	constructor(lockPath: string) {
		try {
			// The lock directory is renamed on release. Watch its stable parent so
			// Windows notifications and inode-based watchers see subsequent owners.
			const lockName = path.basename(lockPath)
			this.watcher = fs.watch(path.dirname(lockPath), { persistent: false }, (_event, filename) => {
				if (filename !== null && filename.toString() !== lockName) return
				this.notify()
			})
			this.watcher.on("error", () => this.close())
			this.watcher.on("close", () => {
				this.watcher = undefined
				this.notify()
			})
		} catch {
			// Unsupported or unavailable watchers retain bounded timer polling.
		}
	}

	checkpoint(): number {
		return this.generation
	}

	private notify(): void {
		this.generation++
		this.wake?.()
	}

	async wait(checkpoint: number, delayMs: number, signal?: AbortSignal): Promise<void> {
		throwIfTransactionCancelled(signal)
		// Retain a notification received during an asynchronous ownership probe.
		if (checkpoint !== this.generation) return
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer)
				signal?.removeEventListener("abort", abort)
				this.wake = undefined
			}
			const finish = () => {
				cleanup()
				resolve()
			}
			const abort = () => {
				cleanup()
				reject(
					new AgentControlTransactionError(
						"Agent control transaction acquisition was cancelled",
						"ABORT_ERR",
					),
				)
			}
			const timer = setTimeout(finish, delayMs)
			this.wake = finish
			signal?.addEventListener("abort", abort, { once: true })
		})
	}

	close(): void {
		const watcher = this.watcher
		this.watcher = undefined
		watcher?.close()
		this.notify()
	}
}
