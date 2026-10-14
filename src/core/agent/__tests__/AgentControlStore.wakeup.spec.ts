import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"
import { EventEmitter } from "events"
import { fork } from "child_process"
import { clearTimeout as clearWatchdog, setTimeout as startWatchdog } from "timers"
import { build } from "esbuild"

import { agentControlStateSchema } from "@alpha-code/types"

import { FileAgentControlPersistence } from "../AgentControlStore"

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return { ...actual, watch: vi.fn(actual.watch) }
})

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

class ControlledWatcher extends EventEmitter implements fsSync.FSWatcher {
	close = vi.fn(() => this.removeAllListeners())
	ref() {
		return this
	}
	unref() {
		return this
	}
}

// The watchdog bounds a regression failure; fallback timers remain frozen throughout.
const observedWithoutAdvancingRetry = async (observed: Promise<void>) => {
	let watchdog: ReturnType<typeof startWatchdog> | undefined
	try {
		return await Promise.race([
			observed.then(() => true),
			new Promise<boolean>((resolve) => {
				watchdog = startWatchdog(() => resolve(false), 1_000)
			}),
		])
	} finally {
		clearWatchdog(watchdog)
	}
}

describe("FileAgentControlPersistence contention wakeup", () => {
	let directory: string
	let holder: FileAgentControlPersistence
	let contender: FileAgentControlPersistence
	let release: ReturnType<typeof barrier>
	let holding: Promise<void>
	let cancellation: AbortController
	let waiting: Promise<unknown> | undefined
	let watcher: ControlledWatcher

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-lock-wakeup-"))
		holder = new FileAgentControlPersistence(directory)
		contender = new FileAgentControlPersistence(directory)
		release = barrier()
		const entered = barrier()
		holding = holder.withTransaction(async () => {
			entered.resolve()
			await release.promise
		})
		await entered.promise
		watcher = new ControlledWatcher()
		vi.mocked(fsSync.watch).mockImplementation(
			(
				_filename: fsSync.PathLike,
				options?: fsSync.WatchOptions | BufferEncoding | fsSync.WatchListener<string>,
				listener?: fsSync.WatchListener<string>,
			) => {
				const callback = typeof options === "function" ? options : listener
				if (callback) watcher.on("change", callback)
				return watcher
			},
		)
		cancellation = new AbortController()
		waiting = undefined
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
	})

	afterEach(async () => {
		cancellation.abort()
		release.resolve()
		await Promise.allSettled([holding, waiting])
		vi.restoreAllMocks()
		vi.useRealTimers()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("acquires a released lock on a parent-directory event without waiting for the polling interval", async () => {
		const fallbackArmed = barrier()
		const schedule = globalThis.setTimeout
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
			const timer = schedule(callback, delay, ...args)
			fallbackArmed.resolve()
			return timer
		})
		const acquired = barrier()
		waiting = contender
			.withTransaction(
				() => {
					acquired.resolve()
					return Promise.resolve("acquired")
				},
				{ signal: cancellation.signal },
			)
			.catch((error: unknown) => error)
		await fallbackArmed.promise
		release.resolve()
		await holding
		watcher.emit("change", "rename", path.basename(`${holder.filePath}.transaction.lock`))

		expect(await observedWithoutAdvancingRetry(acquired.promise)).toBe(true)
		await expect(waiting).resolves.toBe("acquired")
		expect(watcher.close).toHaveBeenCalledTimes(1)
	})

	it("retries immediately when the failed acquisition observes that the holder has already disappeared", async () => {
		const internals = contender as unknown as { observeTransactionLockForAcquisition(): Promise<unknown> }
		vi.spyOn(internals, "observeTransactionLockForAcquisition").mockImplementationOnce(async () => {
			release.resolve()
			await holding
			return undefined
		})
		const acquired = barrier()
		waiting = contender
			.withTransaction(
				() => {
					acquired.resolve()
					return Promise.resolve("acquired")
				},
				{ signal: cancellation.signal },
			)
			.catch((error: unknown) => error)

		expect(await observedWithoutAdvancingRetry(acquired.promise)).toBe(true)
		await expect(waiting).resolves.toBe("acquired")
	})
})

describe("FileAgentControlPersistence progress across processes", () => {
	it("wakes on a real process release with polling frozen and preserves sustained updates from both writers", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-wakeup-processes-"))
		const actualFs = await vi.importActual<typeof import("fs")>("fs")
		vi.mocked(fsSync.watch).mockImplementation(actualFs.watch)
		const persistence = new FileAgentControlPersistence(directory)
		const cancellation = new AbortController()
		let parentUpdates: Promise<void> | undefined
		let child: ReturnType<typeof fork> | undefined
		let exited: Promise<number | null> | undefined
		const pendingSignals = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
		const receivedSignals = new Set<string>()
		const progress: string[] = []

		try {
			await persistence.write({
				version: 2,
				updatedAt: 1,
				nextSequence: 1,
				agents: [],
				tombstones: [],
				mailbox: [],
				mailboxCursors: {},
				verificationObligations: [],
			})
			const bundledWriter = path.join(directory, "wakeup-writer.cjs")
			await build({
				entryPoints: [path.join(__dirname, "fixtures", "agent-control-wakeup-writer.ts")],
				outfile: bundledWriter,
				bundle: true,
				platform: "node",
				format: "cjs",
				logLevel: "silent",
			})
			child = fork(bundledWriter, [directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
			const failSignals = (error: Error) => {
				for (const pending of pendingSignals.values()) pending.reject(error)
				pendingSignals.clear()
			}
			exited = new Promise<number | null>((resolve) => {
				child!.once("exit", (code) => {
					resolve(code)
					failSignals(new Error(`Writer exited with code ${code}`))
				})
				child!.once("error", (error) => {
					resolve(null)
					failSignals(error)
				})
			})
			child.on("message", (message) => {
				if (typeof message !== "string") return
				if (message.startsWith("acquired:")) progress.push("child acquired")
				if (message === "finished") progress.push("child finished")
				receivedSignals.add(message)
				pendingSignals.get(message)?.resolve()
				pendingSignals.delete(message)
			})
			const waitForSignal = (signal: string) => {
				if (receivedSignals.has(signal)) return Promise.resolve()
				return new Promise<void>((resolve, reject) => {
					const timeout = startWatchdog(
						() => reject(new Error(`Timed out waiting for writer ${signal}`)),
						5_000,
					)
					pendingSignals.set(signal, {
						resolve: () => {
							clearWatchdog(timeout)
							resolve()
						},
						reject: (error) => {
							clearWatchdog(timeout)
							reject(error)
						},
					})
				})
			}

			await waitForSignal("holding")
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
			const fallbackArmed = barrier()
			const schedule = globalThis.setTimeout
			const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
				const timer = schedule(callback, delay, ...args)
				fallbackArmed.resolve()
				return timer
			})
			const firstAcquired = barrier()
			parentUpdates = (async () => {
				for (let update = 0; update < 32; update++) {
					await persistence.withTransaction(
						async () => {
							if (update === 0) firstAcquired.resolve()
							progress.push("parent acquired")
							const state = agentControlStateSchema.parse(await persistence.read())
							state.nextSequence++
							await persistence.write(state)
						},
						{ signal: cancellation.signal },
					)
				}
				progress.push("parent finished")
			})()
			await fallbackArmed.promise
			child.send("release")
			expect(await observedWithoutAdvancingRetry(firstAcquired.promise)).toBe(true)
			timerSpy.mockRestore()
			vi.useRealTimers()
			await parentUpdates
			await waitForSignal("finished")
			expect(await exited).toBe(0)
			expect(progress.filter((event) => event === "parent acquired")).toHaveLength(32)
			expect(progress.filter((event) => event === "child acquired")).toHaveLength(32)
			expect(agentControlStateSchema.parse(await persistence.read()).nextSequence).toBe(65)
			await expect(fs.stat(`${persistence.filePath}.transaction.lock`)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			cancellation.abort()
			vi.restoreAllMocks()
			vi.useRealTimers()
			if (child && child.exitCode === null && child.signalCode === null) child.kill()
			await Promise.allSettled([parentUpdates, exited])
			await fs.rm(directory, { recursive: true, force: true })
		}
	}, 15_000)
})
