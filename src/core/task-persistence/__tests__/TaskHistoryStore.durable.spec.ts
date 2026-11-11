import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@alpha-code/types"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { TaskHistoryStore } from "../TaskHistoryStore"

vi.mock("fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs")>()),
	// Keep sibling caches stale until the test explicitly refreshes them.
	watch: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })),
}))

const item: HistoryItem = {
	id: "shared-task",
	number: 1,
	ts: 1,
	task: "Inspect history",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}

let storage: string
let stores: TaskHistoryStore[]

beforeEach(async () => {
	storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-durable-history-"))
	stores = []
})

afterEach(async () => {
	await Promise.all(stores.map((store) => store.dispose()))
	await fs.rm(storage, { recursive: true, force: true })
})

async function openStore(): Promise<TaskHistoryStore> {
	const store = new TaskHistoryStore(storage)
	stores.push(store)
	await store.initialize()
	return store
}

async function linkTaskDirectory(): Promise<{ contents: string; outsideFile: string }> {
	const outside = path.join(storage, "outside")
	const outsideFile = path.join(outside, GlobalFileNames.historyItem)
	const contents = JSON.stringify(item)
	await fs.mkdir(outside)
	await fs.writeFile(outsideFile, contents)
	await fs.symlink(outside, path.join(storage, "tasks", item.id), "junction")
	return { contents, outsideFile }
}

it("preserves newer durable fields that a stale sibling's metadata update omits", async () => {
	const first = await openStore()
	await first.upsert({ ...item, childIds: ["first-child"], archived: false })
	const sibling = await openStore()
	const latest = { ...item, childIds: ["first-child", "second-child"], archived: true }
	await first.upsert(latest)
	expect(sibling.get(item.id)?.archived).toBe(false)

	await sibling.upsert({ ...item, tokensIn: 42 })

	const reloaded = await openStore()
	expect(reloaded.get(item.id)).toEqual({ ...latest, tokensIn: 42 })
})

it("does not load history from a linked task directory", async () => {
	const store = await openStore()
	await linkTaskDirectory()

	await store.reconcile()
	expect(store.get(item.id)).toBeUndefined()
	await expect(store.invalidate(item.id, { requireExisting: true })).rejects.toThrow()
})

it.each(["upsert", "delete", "migrate"] as const)(
	"rejects %s through a linked task directory without changing external bytes",
	async (operation) => {
		const store = await openStore()
		const { contents, outsideFile } = await linkTaskDirectory()
		const actions = {
			upsert: () => store.upsert({ ...item, tokensIn: 42 }),
			delete: () => store.delete(item.id),
			migrate: () => store.migrateFromGlobalState([item]),
		}

		await expect(actions[operation]()).rejects.toThrow("not a regular directory")
		expect(await fs.readFile(outsideFile, "utf8")).toBe(contents)
	},
)

it("rejects a linked tasks root even when the target task does not exist", async () => {
	const outside = path.join(storage, "outside")
	await fs.mkdir(outside)
	await fs.symlink(outside, path.join(storage, "tasks"), "junction")
	const store = new TaskHistoryStore(storage)

	await expect(store.upsert(item)).rejects.toThrow("not a regular directory")
	expect(await fs.readdir(outside)).toEqual([])
})
