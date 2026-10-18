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
	writeJson: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs/promises")>()),
	readFile: fixtures.readFile,
}))
vi.mock("fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs")>()),
	watch: fixtures.watch,
}))
vi.mock("../../../utils/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/storage")>()),
	getStorageBasePath: async (storagePath: string) => storagePath,
}))
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: fixtures.writeJson,
}))

let storage: string
let store: TaskHistoryStore
let watchCallback: fsSync.WatchListener<string>

beforeEach(async () => {
	vi.useFakeTimers()
	fixtures.files.clear()
	fixtures.writeJson.mockReset().mockImplementation(async (file: string, value: unknown) => {
		fixtures.files.set(file, JSON.stringify(value))
	})
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
	await store.dispose()
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

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

it("awaited disposal drains an admitted history write before publishing the final index", async () => {
	const entered = deferred()
	const release = deferred()
	const indexPath = path.join(storage, "tasks", "_index.json")
	fixtures.writeJson.mockImplementation(async (file: string, value: unknown) => {
		if (path.basename(file) === "history_item.json") {
			entered.resolve()
			await release.promise
		}
		fixtures.files.set(file, JSON.stringify(value))
	})
	const save = store.upsert(item)
	await entered.promise
	let closed = false
	const closing = Promise.resolve(store.dispose()).then(() => {
		closed = true
	})
	let before!: { closed: boolean; indexExists: boolean }
	try {
		await vi.advanceTimersByTimeAsync(0)
		before = { closed, indexExists: fixtures.files.has(indexPath) }
	} finally {
		release.resolve()
		await Promise.all([save, closing])
	}
	expect(before).toEqual({ closed: false, indexExists: false })
	expect(JSON.parse(fixtures.files.get(indexPath)!)).toMatchObject({ entries: [item] })
})

it("concurrent disposal callers join one final index write", async () => {
	const entered = deferred()
	const release = deferred()
	const flush = store.flushIndex.bind(store)
	const finalFlush = vi.spyOn(store, "flushIndex").mockImplementation(async () => {
		entered.resolve()
		await release.promise
		await flush()
	})
	let settled = 0
	const closings = [store.dispose(), store.dispose()].map((value) =>
		Promise.resolve(value).then(() => {
			settled++
		}),
	)
	await entered.promise
	let before!: { settled: number; writes: number }
	try {
		await vi.advanceTimersByTimeAsync(0)
		before = { settled, writes: finalFlush.mock.calls.length }
	} finally {
		release.resolve()
		await Promise.all(closings)
	}
	expect(before).toEqual({ settled: 0, writes: 1 })
})

it.each([new Error("controlled final index failure"), undefined, null])(
	"preserves a final index failure and permits an explicit disposal retry (%s)",
	async (failure) => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			fixtures.writeJson.mockRejectedValueOnce(failure)
			const [result] = await Promise.allSettled([Promise.resolve(store.dispose())])
			expect(result).toEqual({ status: "rejected", reason: failure })
			await expect(Promise.resolve(store.dispose())).resolves.toBeUndefined()
			expect(fixtures.files.has(path.join(storage, "tasks", "_index.json"))).toBe(true)
		} finally {
			log.mockRestore()
		}
	},
)

it("a legacy disposal followed by flushIndex joins both admitted index writes", async () => {
	const entered = deferred()
	const release = deferred()
	let writes = 0
	fixtures.writeJson.mockImplementation(async (file: string, value: unknown) => {
		if (path.basename(file) === "_index.json" && ++writes === 2) {
			entered.resolve()
			await release.promise
		}
		fixtures.files.set(file, JSON.stringify(value))
	})
	const closing = Promise.resolve(store.dispose())
	let flushed = false
	const flushing = store.flushIndex().then(() => {
		flushed = true
	})
	await entered.promise
	let flushedBeforeRelease = false
	try {
		await vi.advanceTimersByTimeAsync(0)
		flushedBeforeRelease = flushed
	} finally {
		release.resolve()
		await Promise.all([closing, flushing])
	}
	expect(flushedBeforeRelease).toBe(false)
})
