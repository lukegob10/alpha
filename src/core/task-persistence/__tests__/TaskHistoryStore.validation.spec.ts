import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { getTaskDisplayName, type HistoryItem } from "@alpha-code/types"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { TaskHistoryStore } from "../TaskHistoryStore"

vi.mock("../../../utils/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/storage")>()),
	getStorageBasePath: async (storagePath: string) => storagePath,
}))
vi.mock("fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs")>()),
	watch: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })),
}))

const legacyItem: HistoryItem = {
	id: "saved-task",
	number: 1,
	ts: 10,
	task: "Inspect the repository",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}

let storage: string
let store: TaskHistoryStore

beforeEach(async () => {
	storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-history-validation-"))
	store = new TaskHistoryStore(storage)
})

afterEach(async () => {
	await store.dispose()
	await fs.rm(storage, { recursive: true, force: true })
})

async function writeTask(item: unknown, taskId = legacyItem.id): Promise<string> {
	const directory = path.join(storage, "tasks", taskId)
	await fs.mkdir(directory, { recursive: true })
	const file = path.join(directory, GlobalFileNames.historyItem)
	await fs.writeFile(file, JSON.stringify(item), "utf8")
	return file
}

it.each([{ workspace: 123 }, { displayName: {} }, { id: "different-task" }])(
	"ignores invalid per-task metadata without changing saved bytes (%j)",
	async (invalid) => {
		const file = await writeTask({ ...legacyItem, ...invalid })
		const original = await fs.readFile(file, "utf8")
		await store.initialize()

		expect(() => store.getByWorkspace(storage)).not.toThrow()
		expect(() => store.getAll().map(getTaskDisplayName)).not.toThrow()
		expect(store.getAll()).toEqual([])
		expect(await fs.readFile(file, "utf8")).toBe(original)
	},
)

it("skips invalid index entries individually and retains valid legacy metadata with unknown fields", async () => {
	const tasksDirectory = path.join(storage, "tasks")
	const preserved = { ...legacyItem, mode: "retired-mode", futureMetadata: { retained: true } }
	const invalid = { ...legacyItem, id: "invalid-task", workspace: 123 }
	for (const id of [preserved.id, invalid.id]) {
		await fs.mkdir(path.join(tasksDirectory, id), { recursive: true })
	}
	await fs.writeFile(
		path.join(tasksDirectory, GlobalFileNames.historyIndex),
		JSON.stringify({ version: 1, updatedAt: 10, entries: [invalid, null, preserved] }),
		"utf8",
	)
	await store.initialize()

	expect(() => store.getByWorkspace(storage)).not.toThrow()
	expect(store.getAll()).toEqual([preserved])
})

it("keeps last-known-good metadata when reconciliation sees malformed fields or a mismatched identity", async () => {
	const preserved = { ...legacyItem, futureMetadata: { retained: true } }
	const file = await writeTask(preserved)
	await store.initialize()

	for (const invalid of [{ displayName: {} }, { id: "different-task" }]) {
		await fs.writeFile(file, JSON.stringify({ ...legacyItem, ...invalid }), "utf8")
		await store.reconcile()
		expect(store.get(legacyItem.id)).toEqual(preserved)
	}
})

it("does not publish invalid metadata during an explicit refresh", async () => {
	const file = await writeTask(legacyItem)
	await store.initialize()
	await fs.writeFile(file, JSON.stringify({ ...legacyItem, workspace: 123 }), "utf8")
	await store.invalidate(legacyItem.id)

	expect(() => store.getByWorkspace(storage)).not.toThrow()
	expect(store.get(legacyItem.id)).toBeUndefined()
})
