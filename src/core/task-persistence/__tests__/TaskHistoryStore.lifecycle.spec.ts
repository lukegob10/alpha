import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@alpha-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"

const fixtures = vi.hoisted(() => ({
	files: new Map<string, string>(),
	watch: vi.fn(),
	readFile: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs/promises")>()),
	readFile: fixtures.readFile,
}))
vi.mock("fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs")>()),
	watch: fixtures.watch,
}))
vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: async (storagePath: string) => storagePath,
}))
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: async (file: string, value: unknown) => {
		fixtures.files.set(file, JSON.stringify(value))
	},
}))

let storage: string
let store: TaskHistoryStore
let watchCallback: fsSync.WatchListener<string>

beforeEach(async () => {
	vi.useFakeTimers()
	fixtures.files.clear()
	fixtures.readFile.mockReset().mockImplementation(async (file: string) => {
		const value = fixtures.files.get(file)
		if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" })
		return value
	})
	fixtures.watch.mockReset().mockImplementation((_file, _options, callback) => {
		watchCallback = callback
		return { close: vi.fn(), on: vi.fn() }
	})
	storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-history-lifecycle-"))
	store = new TaskHistoryStore(storage)
	await store.initialize()
	await vi.advanceTimersByTimeAsync(0)
})

afterEach(async () => {
	store.dispose()
	await store.flushIndex()
	vi.useRealTimers()
	await fs.rm(storage, { recursive: true, force: true })
})

const item: HistoryItem = {
	id: "task",
	number: 1,
	ts: 1,
	task: "Inspect stale metadata",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}

it.each([false, true])("serializes metadata refresh with newer saves (strict=%s)", async (requireExisting) => {
	await store.upsert({ ...item, status: "active" })
	const file = path.join(storage, "tasks", item.id, "history_item.json")
	let release!: () => void
	let entered!: () => void
	const blocked = new Promise<void>((resolve) => (release = resolve))
	const reading = new Promise<void>((resolve) => (entered = resolve))
	fixtures.readFile.mockImplementationOnce(async () => {
		const oldContents = fixtures.files.get(file)
		entered()
		await blocked
		return oldContents
	})
	const refresh = store.invalidate(item.id, { requireExisting })
	await reading
	const save = store.upsert({ ...item, status: "completed", tokensIn: 42 })
	// Drain runnable continuations while the captured old read stays blocked.
	await vi.advanceTimersByTimeAsync(0)
	release()
	await Promise.all([refresh, save])
	expect(store.get(item.id)).toMatchObject({ status: "completed", tokensIn: 42 })
	expect(JSON.parse(fixtures.files.get(file)!)).toMatchObject({ status: "completed", tokensIn: 42 })
})

it("clears a pending watcher reconciliation when disposed", async () => {
	const reconcile = vi.spyOn(store, "reconcile")
	watchCallback("rename", "task")
	store.dispose()
	await vi.advanceTimersByTimeAsync(500)
	expect(reconcile).not.toHaveBeenCalled()
})
