import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@alpha-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"
import { safeWriteJson, type SafeWriteJsonOptions } from "../../../utils/safeWriteJson"

vi.mock("../../../utils/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/storage")>()),
	getStorageBasePath: async (storagePath: string) => storagePath,
}))

vi.mock("../../../utils/safeWriteJson", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/safeWriteJson")>()),
	safeWriteJson: vi.fn((await importOriginal<typeof import("../../../utils/safeWriteJson")>()).safeWriteJson),
}))

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => (resolve = complete))
	return { promise, resolve }
}

const item: HistoryItem = {
	id: "rename-task",
	number: 1,
	ts: 123,
	task: "Original user prompt",
	tokensIn: 10,
	tokensOut: 5,
	totalCost: 0.2,
	workspace: "/test/workspace",
	status: "active",
}

describe("TaskHistoryStore durable chat renaming", () => {
	let storage: string
	let stores: TaskHistoryStore[]
	let originalWrite: typeof safeWriteJson
	const read = async () =>
		JSON.parse(await fs.readFile(path.join(storage, "tasks", item.id, "history_item.json"), "utf8"))
	const makeStore = async () => {
		const store = new TaskHistoryStore(storage)
		stores.push(store)
		await store.initialize()
		return store
	}

	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-chat-rename-"))
		stores = []
		originalWrite = (
			await vi.importActual<typeof import("../../../utils/safeWriteJson")>("../../../utils/safeWriteJson")
		).safeWriteJson
		vi.mocked(safeWriteJson).mockImplementation(originalWrite)
		vi.spyOn(console, "error").mockImplementation(() => undefined)
	})

	afterEach(async () => {
		await Promise.all(stores.map((store) => store.dispose()))
		vi.restoreAllMocks()
		await fs.rm(storage, { recursive: true, force: true })
	})

	it("renames only the label, persists through reload, and keeps future metadata saves from replacing it", async () => {
		const store = await makeStore()
		await store.upsert(item)
		const renamed = await store.renameTask(item.id, "  Cancellation fixes  ", item.workspace!)
		expect(renamed).toEqual({ ...item, displayName: "Cancellation fixes" })
		await store.upsert({ ...item, tokensIn: 100, displayName: "stale cached name" })
		expect(await read()).toEqual({ ...item, tokensIn: 100, displayName: "Cancellation fixes" })
		const reloaded = await makeStore()
		expect(reloaded.get(item.id)?.displayName).toBe("Cancellation fixes")
	})

	it("persists generated titles without changing the prompt and yields to user names", async () => {
		const store = await makeStore()
		await store.upsert(item)

		const titled = await store.setGeneratedTitle(item.id, "Fix task naming", item.workspace!)
		expect(titled).toEqual({ ...item, generatedTitle: "Fix task naming" })
		await store.upsert({ ...item, tokensIn: 100 })
		expect(await read()).toEqual({ ...item, tokensIn: 100, generatedTitle: "Fix task naming" })

		const renamed = await store.renameTask(item.id, "User chosen name", item.workspace!)
		expect(renamed).toMatchObject({
			task: item.task,
			displayName: "User chosen name",
			generatedTitle: "Fix task naming",
		})
		await expect(store.setGeneratedTitle(item.id, "Late generated name", item.workspace!)).resolves.toBeUndefined()
		expect(await read()).toMatchObject({
			task: item.task,
			displayName: "User chosen name",
			generatedTitle: "Fix task naming",
		})
	})

	it("does not replace an existing user name with a generated title", async () => {
		const store = await makeStore()
		await store.upsert({ ...item, displayName: "Manual title" })

		await expect(store.setGeneratedTitle(item.id, "Generated title", item.workspace!)).resolves.toBeUndefined()
		expect(await read()).toEqual({ ...item, displayName: "Manual title" })
	})

	it("preserves imported labels and unknown metadata without changing prompt, order, or timestamps", async () => {
		const store = await makeStore()
		await store.upsert({ ...item, displayName: "Imported name" })
		const file = path.join(storage, "tasks", item.id, "history_item.json")
		await fs.writeFile(
			file,
			JSON.stringify({ ...item, displayName: "Imported name", futureMetadata: { keep: true } }),
		)
		await store.renameTask(item.id, "Renamed import", item.workspace!)
		expect(await read()).toEqual({ ...item, displayName: "Renamed import", futureMetadata: { keep: true } })
	})

	it("retains a successful canonical rename when the compatibility callback rejects", async () => {
		const mirror = vi.fn().mockResolvedValue(undefined)
		const store = new TaskHistoryStore(storage, { onWrite: mirror })
		stores.push(store)
		await store.initialize()
		await store.upsert(item)
		mirror.mockRejectedValueOnce(new Error("compatibility mirror unavailable"))
		await expect(store.renameTask(item.id, "Committed name", item.workspace!)).resolves.toMatchObject({
			displayName: "Committed name",
		})
		expect((await read()).displayName).toBe("Committed name")
		expect(console.error).toHaveBeenCalledWith("[TaskHistoryStore] Chat rename compatibility projection failed")
	})

	it.each(["", "  ", "x".repeat(97)])("rejects an invalid label before writing (%s)", async (name) => {
		const store = await makeStore()
		await store.upsert(item)
		await expect(store.renameTask(item.id, name, item.workspace!)).rejects.toMatchObject({ code: "invalid" })
		expect(await read()).toEqual(item)
	})

	it("rejects missing tasks, traversal and other-workspace identities without creating records", async () => {
		const store = await makeStore()
		await store.upsert(item)
		await expect(store.renameTask("unknown", "Name", item.workspace!)).rejects.toMatchObject({ code: "notFound" })
		await expect(store.renameTask("../escape", "Name", item.workspace!)).rejects.toMatchObject({ code: "invalid" })
		await expect(store.renameTask(item.id, "Name", "/different/project")).rejects.toMatchObject({
			code: "wrongWorkspace",
		})
		expect(await read()).toEqual(item)
		await expect(fs.access(path.join(storage, "tasks", "unknown"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it.each(["rename", "metadata"] as const)(
		"serializes a held %s against a stale sibling-store write",
		async (first) => {
			const writer = await makeStore()
			await writer.upsert(item)
			const sibling = await makeStore()
			const held = deferred()
			const release = deferred()
			const arrived = deferred()
			let taskWrites = 0
			vi.mocked(safeWriteJson).mockImplementation(
				async (file: string, value: unknown, options?: SafeWriteJsonOptions) => {
					if (path.basename(file) !== "history_item.json") return originalWrite(file, value, options)
					const index = ++taskWrites
					if (index === 2) arrived.resolve()
					return originalWrite(file, value, {
						...options,
						prepareData: async () => {
							const current = await options!.prepareData!()
							if (index === 1) {
								held.resolve()
								await release.promise
							}
							return current
						},
					})
				},
			)
			const rename = () => writer.renameTask(item.id, "Latest user label", item.workspace!)
			const metadata = () => sibling.upsert({ ...item, tokensIn: 222, displayName: "Stale label" })
			const earlier = first === "rename" ? rename() : metadata()
			await held.promise
			const later = first === "rename" ? metadata() : rename()
			await arrived.promise
			try {
				expect(await read()).toEqual(item)
			} finally {
				release.resolve()
				await Promise.all([earlier, later])
			}
			expect(await read()).toEqual({ ...item, tokensIn: 222, displayName: "Latest user label" })
			await sibling.reconcile()
			expect(sibling.get(item.id)?.displayName).toBe("Latest user label")
		},
	)

	it("fences external replacement during a held lease without clobbering newer labels", async () => {
		const store = await makeStore()
		await store.upsert(item)
		vi.mocked(safeWriteJson).mockImplementation(async (file, value, options) => {
			if (path.basename(file) !== "history_item.json") return originalWrite(file, value, options)
			return originalWrite(file, value, {
				...options,
				prepareData: async () => {
					const next = await options!.prepareData!()
					await fs.writeFile(file, JSON.stringify({ ...item, displayName: "External winner" }))
					return next
				},
			})
		})
		await expect(store.renameTask(item.id, "Losing label", item.workspace!)).rejects.toThrow(
			"changed during metadata write",
		)
		expect((await read()).displayName).toBe("External winner")
	})
})
