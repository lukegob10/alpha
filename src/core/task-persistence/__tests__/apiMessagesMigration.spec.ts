import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { readApiMessages } from "../apiMessages"
import { GlobalFileNames } from "../../../shared/globalFileNames"

const migration = vi.hoisted(() => ({
	primaryPath: "",
	beforeRename: undefined as (() => Promise<void>) | undefined,
	missingObserved: undefined as (() => void) | undefined,
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	const mocked = {
		...actual,
		access: (async (...args) => {
			try {
				return await actual.access(...args)
			} catch (error) {
				if (String(args[0]) === migration.primaryPath && (error as NodeJS.ErrnoException).code === "ENOENT") {
					migration.missingObserved?.()
				}
				throw error
			}
		}) as typeof actual.access,
		rename: (async (source, destination) => {
			if (String(destination) === migration.primaryPath) await migration.beforeRename?.()
			return actual.rename(source, destination)
		}) as typeof actual.rename,
	}
	return { ...mocked, default: mocked }
})

it("refuses stale-empty fallback after another cold reader completed migration", async () => {
	const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-migration-race-"))
	const taskId = "migration-race"
	const taskDirectory = path.join(storagePath, "tasks", taskId)
	await fs.mkdir(taskDirectory, { recursive: true })
	const primaryPath = path.join(taskDirectory, GlobalFileNames.apiConversationHistory)
	const fallbackPath = path.join(taskDirectory, "claude_messages.json")
	const messages = [{ role: "user", content: "durable fallback history" }]
	await fs.writeFile(fallbackPath, JSON.stringify(messages))
	let releaseRename!: () => void
	const renameGate = new Promise<void>((resolve) => {
		releaseRename = resolve
	})
	let renameEntered = false
	let secondObservedMissing = false
	migration.primaryPath = primaryPath
	migration.beforeRename = async () => {
		renameEntered = true
		await renameGate
	}
	const first = readApiMessages({ taskId, globalStoragePath: storagePath })
	let second: ReturnType<typeof readApiMessages> | undefined
	try {
		await vi.waitFor(() => expect(renameEntered).toBe(true))
		migration.missingObserved = () => {
			secondObservedMissing = true
		}
		second = readApiMessages({ taskId, globalStoragePath: storagePath })
		await vi.waitFor(() => expect(secondObservedMissing).toBe(true))
		const observed = Promise.allSettled([first, second])
		releaseRename()
		const results = await observed
		expect(results[0]).toEqual({ status: "fulfilled", value: messages })
		expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "read_failed" } })
		expect(JSON.parse(await fs.readFile(primaryPath, "utf8"))).toEqual(messages)
		await expect(fs.access(fallbackPath)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await readApiMessages({ taskId, globalStoragePath: storagePath })).toEqual(messages)
	} finally {
		releaseRename()
		await Promise.allSettled(second ? [first, second] : [first])
		migration.primaryPath = ""
		migration.beforeRename = undefined
		migration.missingObserved = undefined
		await fs.rm(storagePath, { recursive: true, force: true })
	}
})
