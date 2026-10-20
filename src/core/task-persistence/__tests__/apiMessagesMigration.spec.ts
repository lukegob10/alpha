import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { readApiMessages, saveApiMessages } from "../apiMessages"
import { ProviderTranscriptStore } from "../ProviderTranscriptStore"
import { GlobalFileNames } from "../../../shared/globalFileNames"

const migration = vi.hoisted(() => ({
	primaryPath: "",
	beforeRename: undefined as (() => Promise<void>) | undefined,
	missingObserved: undefined as (() => void) | undefined,
	publishAuthority: undefined as (() => Promise<void>) | undefined,
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
					const publish = migration.publishAuthority
					migration.publishAuthority = undefined
					await publish?.()
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

it("reads the committed authority after another cold reader completes migration", async () => {
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
		expect(results[1]).toEqual({ status: "fulfilled", value: messages })
		expect(JSON.parse(await fs.readFile(primaryPath, "utf8"))).toEqual(messages)
		await expect(fs.access(fallbackPath)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await readApiMessages({ taskId, globalStoragePath: storagePath })).toEqual(messages)
	} finally {
		releaseRename()
		await Promise.allSettled(second ? [first, second] : [first])
		migration.primaryPath = ""
		migration.beforeRename = undefined
		migration.missingObserved = undefined
		migration.publishAuthority = undefined
		await fs.rm(storagePath, { recursive: true, force: true })
	}
})

it.each(["{broken", JSON.stringify([{ role: "invalid", content: "Preserve this evidence" }])])(
	"rejects an invalid authority that appears before migration without replacing it or removing fallback (%s)",
	async (contents) => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-migration-invalid-"))
		const taskId = "migration-invalid"
		const taskDirectory = path.join(storagePath, "tasks", taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		const primaryPath = path.join(taskDirectory, GlobalFileNames.apiConversationHistory)
		const fallbackPath = path.join(taskDirectory, "claude_messages.json")
		const fallback = JSON.stringify([{ role: "user", content: "Older history" }])
		await fs.writeFile(fallbackPath, fallback)
		migration.primaryPath = primaryPath
		migration.publishAuthority = () => fs.writeFile(primaryPath, contents)
		try {
			await expect(readApiMessages({ taskId, globalStoragePath: storagePath })).rejects.toMatchObject({
				code: "invalid_messages",
			})
			expect(await fs.readFile(primaryPath, "utf8")).toBe(contents)
			expect(await fs.readFile(fallbackPath, "utf8")).toBe(fallback)
		} finally {
			migration.primaryPath = ""
			migration.publishAuthority = undefined
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	},
)

it.each(["matching", "conflicting", "missing"] as const)(
	"verifies a v2 authority that appears while a cold reader waits (%s)",
	async (state) => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-migration-v2-"))
		const taskId = "migration-v2"
		const taskDirectory = path.join(storagePath, "tasks", taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		const primaryPath = path.join(taskDirectory, GlobalFileNames.apiConversationHistory)
		const fallbackPath = path.join(taskDirectory, "claude_messages.json")
		const fallback = JSON.stringify([{ role: "user", content: "Obsolete fallback" }])
		const messages = [{ role: "user" as const, content: "Current authoritative history" }]
		await fs.writeFile(fallbackPath, fallback)
		migration.primaryPath = primaryPath
		migration.publishAuthority = async () => {
			const receipt = await saveApiMessages({ taskId, globalStoragePath: storagePath, messages })
			await new ProviderTranscriptStore(taskId, storagePath).commitAuthoritativeTranscript(receipt)
			if (state === "conflicting")
				await fs.writeFile(primaryPath, JSON.stringify([{ role: "user", content: "External change" }]))
			if (state === "missing") await fs.unlink(primaryPath)
		}
		try {
			const read = readApiMessages({ taskId, globalStoragePath: storagePath })
			if (state === "matching") await expect(read).resolves.toEqual(messages)
			else
				await expect(read).rejects.toMatchObject({
					code: state === "missing" ? "read_failed" : "digest_mismatch",
				})
			expect(await fs.readFile(fallbackPath, "utf8")).toBe(fallback)
			if (state === "conflicting") {
				expect(JSON.parse(await fs.readFile(primaryPath, "utf8"))).toEqual([
					{ role: "user", content: "External change" },
				])
				expect(
					(await fs.readdir(taskDirectory)).some((file) =>
						file.startsWith(`${GlobalFileNames.apiConversationHistory}.conflict_`),
					),
				).toBe(true)
			}
			if (state === "missing") await expect(fs.access(primaryPath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			migration.primaryPath = ""
			migration.publishAuthority = undefined
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	},
)
