import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { FileAgentControlPersistence } from "../AgentControlStore"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, writeFile: vi.fn(actual.writeFile), link: vi.fn(actual.link), unlink: vi.fn(actual.unlink) }
})

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("Agent control lock publication", () => {
	let directory: string
	let actualFs: typeof import("fs/promises")

	beforeEach(async () => {
		actualFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.writeFile).mockImplementation(actualFs.writeFile)
		vi.mocked(fs.link).mockImplementation(actualFs.link)
		vi.mocked(fs.unlink).mockImplementation(actualFs.unlink)
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-lock-publication-"))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("does not reserve the canonical lock before its complete owner record is ready", async () => {
		const persistence = new FileAgentControlPersistence(directory)
		const lockPath = `${persistence.filePath}.transaction.lock`
		const preparing = barrier()
		const finish = barrier()
		vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
			preparing.resolve()
			await finish.promise
			return actualFs.writeFile(...args)
		})
		const holding = persistence.withTransaction(async () => {
			await expect(persistence.assertTransactionOwner()).resolves.toBeUndefined()
		})

		try {
			await preparing.promise
			await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			finish.resolve()
			await holding
		}
		expect(await fs.readdir(directory)).toEqual(["agent_control.json.coordination.sqlite"])
	})

	it("cancels preparation without publishing a lock or starting the operation", async () => {
		const persistence = new FileAgentControlPersistence(directory)
		const cancellation = new AbortController()
		const operation = vi.fn(async () => "must not run")
		vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
			await actualFs.writeFile(...args)
			cancellation.abort()
		})

		await expect(persistence.withTransaction(operation, { signal: cancellation.signal })).rejects.toMatchObject({
			code: "ABORT_ERR",
		})
		expect(operation).not.toHaveBeenCalled()
		expect(await fs.readdir(directory)).toEqual(["agent_control.json.coordination.sqlite"])
		await expect(persistence.withTransaction(async () => "recovered")).resolves.toBe("recovered")
	})

	it("preserves an existing lock when atomic publication loses admission", async () => {
		const persistence = new FileAgentControlPersistence(directory)
		const lockPath = `${persistence.filePath}.transaction.lock`
		const existingOwner = { token: "live-owner", pid: process.pid }
		await actualFs.writeFile(lockPath, JSON.stringify(existingOwner))
		const internals = persistence as unknown as {
			tryCreateTransactionLock(owner: { token: string; pid: number }): Promise<boolean>
		}

		await expect(internals.tryCreateTransactionLock({ token: "contender", pid: process.pid })).resolves.toBe(false)
		expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual(existingOwner)
		expect(await fs.readdir(directory)).toEqual([path.basename(lockPath)])
	})

	it("retains admission and subsequent progress when unused candidate cleanup fails", async () => {
		const persistence = new FileAgentControlPersistence(directory)
		vi.mocked(fs.unlink).mockImplementation(async (file) => {
			if (String(file).includes(".candidate."))
				throw Object.assign(new Error("Injected sharing conflict"), { code: "EPERM" })
			return actualFs.unlink(file)
		})
		await expect(persistence.withTransaction(async () => "completed")).resolves.toBe("completed")
		await expect(new FileAgentControlPersistence(directory).withTransaction(async () => "next")).resolves.toBe(
			"next",
		)
		await expect(fs.stat(`${persistence.filePath}.transaction.lock`)).rejects.toMatchObject({ code: "ENOENT" })
		expect((await fs.readdir(directory)).filter((entry) => entry.includes(".candidate."))).toHaveLength(2)
	})
})
