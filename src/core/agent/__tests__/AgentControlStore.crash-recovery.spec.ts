import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { fork } from "child_process"
import { build } from "esbuild"

import { agentControlStateSchema, type AgentControlState } from "@alpha-code/types"

import { AgentControlStore, FileAgentControlPersistence } from "../AgentControlStore"

const initialState = (): AgentControlState => ({
	version: 2,
	updatedAt: 1,
	nextSequence: 1,
	agents: [],
	tombstones: [],
	mailbox: [],
	mailboxCursors: {},
	verificationObligations: [],
})

const advanceOnlyDuringLockWait = () => {
	const schedule = globalThis.setTimeout
	let elapsedMs = 0
	vi.spyOn(performance, "now").mockImplementation(() => elapsedMs)
	vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
		if (typeof delay !== "number" || delay > 400) return schedule(callback, delay, ...args)
		return schedule(() => {
			elapsedMs += delay
			callback(...args)
		}, 0)
	})
}

describe("Agent control crash recovery", () => {
	let directory: string
	let fixtureDirectory: string
	let writer: string

	beforeAll(async () => {
		fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-crash-fixture-"))
		writer = path.join(fixtureDirectory, "writer.cjs")
		await build({
			entryPoints: [path.join(__dirname, "fixtures", "agent-control-crash-writer.ts")],
			outfile: writer,
			bundle: true,
			platform: "node",
			format: "cjs",
			logLevel: "silent",
		})
	})

	afterAll(async () => {
		await fs.rm(fixtureDirectory, { recursive: true, force: true })
	})

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-crash-"))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it.each(["preparing", "published", "committed", "released"])(
		"recovers after a process dies at the %s boundary without resetting task state",
		async (phase) => {
			const persistence = new FileAgentControlPersistence(directory)
			await persistence.write(initialState())
			await fs.mkdir(path.join(directory, "tasks", "retained"), { recursive: true })
			const historyPath = path.join(directory, "tasks", "retained", "history_item.json")
			await fs.writeFile(historyPath, '{"id":"retained"}')
			const child = fork(writer, [directory, phase], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
			const ready = new Promise<void>((resolve, reject) => {
				child.once("message", (message) => {
					if (message === "ready") resolve()
					else reject(new Error("Unexpected crash fixture message"))
				})
				child.once("error", reject)
				child.once("exit", () => reject(new Error("Crash fixture exited before the controlled boundary")))
			})
			try {
				await ready
				child.kill("SIGKILL")
				await exited
				const expectedSequence = phase === "committed" || phase === "released" ? 2 : 1
				const restarted = new FileAgentControlPersistence(directory, { transactionWaitTimeoutMs: 1_000 })
				await restarted.withTransaction(async () => {
					const state = agentControlStateSchema.parse(await restarted.read())
					expect(state.nextSequence).toBe(expectedSequence)
					state.nextSequence++
					await restarted.write(state)
				})
				expect(agentControlStateSchema.parse(await restarted.read()).nextSequence).toBe(expectedSequence + 1)
				expect(await fs.readFile(historyPath, "utf8")).toBe('{"id":"retained"}')
				await expect(fs.stat(`${persistence.filePath}.transaction.lock`)).rejects.toMatchObject({
					code: "ENOENT",
				})
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
				await exited
			}
		},
	)

	it("recovers a finished writer in another instance even when every release attempt fails and its PID stays alive", async () => {
		const persistence = new FileAgentControlPersistence(directory)
		const internals = persistence as unknown as {
			renameTransactionLock(source: string, destination: string): Promise<void>
			markTransactionLockReleased(token: string): Promise<void>
		}
		const failure = Object.assign(new Error("Injected cleanup failure"), { code: "EIO" })
		vi.spyOn(internals, "renameTransactionLock").mockRejectedValue(failure)
		vi.spyOn(internals, "markTransactionLockReleased").mockRejectedValue(failure)
		await expect(persistence.write(initialState())).resolves.toBeUndefined()
		const owner = JSON.parse(await fs.readFile(`${persistence.filePath}.transaction.lock`, "utf8"))
		expect(owner.pid).toBe(process.pid)
		// Old recovery tombstones must not keep a completed file owner authoritative.
		await fs.mkdir(`${persistence.filePath}.transaction.lock.released.${owner.token}`)
		const restarted = new FileAgentControlPersistence(directory, { transactionWaitTimeoutMs: 1_000 })
		await expect(restarted.write({ ...initialState(), nextSequence: 2 })).resolves.toBeUndefined()
		expect(agentControlStateSchema.parse(await restarted.read()).nextSequence).toBe(2)
	})

	it("keeps activation and read-only operations usable when lock metadata cannot be cleaned up", async () => {
		const diagnostics = vi.fn()
		const persistence = new FileAgentControlPersistence(directory, { onTransactionDiagnostic: diagnostics })
		const internals = persistence as unknown as {
			renameTransactionLock(source: string, destination: string): Promise<void>
			markTransactionLockReleased(token: string): Promise<void>
		}
		const failure = Object.assign(new Error("Injected cleanup failure"), { code: "EIO" })
		vi.spyOn(internals, "renameTransactionLock").mockRejectedValue(failure)
		vi.spyOn(internals, "markTransactionLockReleased").mockRejectedValue(failure)
		const store = new AgentControlStore(persistence)
		try {
			await expect(store.initialize()).resolves.toBeUndefined()
			await expect(persistence.withTransaction(async () => "read completed")).resolves.toBe("read completed")
			expect(diagnostics).toHaveBeenLastCalledWith(
				expect.objectContaining({ outcome: "success", committed: false, releaseFailed: true }),
			)
			await expect(
				new FileAgentControlPersistence(directory).withTransaction(async () => "next instance"),
			).resolves.toBe("next instance")
		} finally {
			await store.shutdown()
		}
	})

	it.each([undefined, "", "{interrupted"])(
		"automatically quarantines an abandoned legacy directory with owner metadata %s during activation",
		async (metadata) => {
			const persistence = new FileAgentControlPersistence(directory, { transactionWaitTimeoutMs: 1_000 })
			const state = JSON.stringify(initialState())
			await fs.writeFile(persistence.filePath, state)
			const lockPath = `${persistence.filePath}.transaction.lock`
			await fs.mkdir(lockPath)
			if (metadata !== undefined) await fs.writeFile(path.join(lockPath, "owner.json"), metadata)
			const store = new AgentControlStore(persistence)
			try {
				await expect(store.initialize()).resolves.toBeUndefined()
				expect(await fs.readFile(persistence.filePath, "utf8")).toBe(state)
				const quarantines = (await fs.readdir(directory)).filter((entry) => entry.includes(".quarantine."))
				expect(quarantines).toHaveLength(1)
				if (metadata !== undefined) {
					expect(await fs.readFile(path.join(directory, quarantines[0], "owner.json"), "utf8")).toBe(metadata)
				}
			} finally {
				await store.shutdown()
			}
		},
	)

	it.each(["live", "missing", "malformed", "oversized"])(
		"preserves an ownerless legacy lock while a foreign activation lease is %s",
		async (foreign) => {
			const persistence = new FileAgentControlPersistence(directory, { transactionWaitTimeoutMs: 30 })
			const lockPath = `${persistence.filePath}.transaction.lock`
			await fs.mkdir(lockPath)
			const owners = `${persistence.filePath}.owners`
			await fs.mkdir(path.join(owners, "foreign-host.lock"), { recursive: true })
			if (foreign !== "missing") {
				await fs.writeFile(
					path.join(owners, "foreign-host.json"),
					foreign === "live"
						? JSON.stringify({ token: "foreign", pid: process.pid })
						: foreign === "oversized"
							? "x".repeat(1_025)
							: "{interrupted",
				)
			}
			const store = new AgentControlStore(persistence)
			try {
				advanceOnlyDuringLockWait()
				await expect(store.initialize()).rejects.toMatchObject({ code: "ELOCKLEGACY" })
				expect(await fs.readdir(lockPath)).toEqual([])
				expect((await fs.readdir(directory)).some((entry) => entry.includes(".quarantine."))).toBe(false)
			} finally {
				await store.shutdown()
			}
		},
	)
})
