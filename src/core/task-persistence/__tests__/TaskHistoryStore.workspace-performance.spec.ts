import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@alpha-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"
import { GlobalFileNames } from "../../../shared/globalFileNames"

const { resolveWorkspace } = vi.hoisted(() => ({ resolveWorkspace: vi.fn() }))

vi.mock("path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("path")>()
	resolveWorkspace.mockImplementation(actual.resolve)
	return { ...actual, resolve: resolveWorkspace }
})

vi.mock("../../../utils/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/storage")>()),
	getStorageBasePath: async (storagePath: string) => storagePath,
}))

// These workloads measure reads; real-file mutation and lease behavior have dedicated store suites.
vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: vi.fn(async () => undefined) }))

function historyItem(id: string, workspace?: string, ts = 1): HistoryItem {
	return { id, number: 1, ts, task: "Workspace history fixture", workspace, tokensIn: 0, tokensOut: 0, totalCost: 0 }
}

describe("TaskHistoryStore workspace read workload", () => {
	let storagePath: string
	let workspace: string
	let store: TaskHistoryStore

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-history-workspace-"))
		workspace = path.join(storagePath, "project")
		store = new TaskHistoryStore(storagePath)
		await store.initialize()
	})

	afterEach(async () => {
		await store.dispose()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("normalizes repeated workspace paths once per read while returning fresh newest-first arrays", async () => {
		const neighbor = path.join(storagePath, "neighbor")
		for (let index = 0; index < 96; index++) {
			await store.upsert(historyItem(`task-${index}`, index % 2 === 0 ? workspace : neighbor, index + 1))
		}
		resolveWorkspace.mockClear()

		const first = store.getByWorkspace(workspace)

		expect(first.map((item) => item.id)).toEqual(Array.from({ length: 48 }, (_, index) => `task-${94 - index * 2}`))
		// The query root and two stored workspace paths are the complete normalization workload.
		expect(resolveWorkspace.mock.calls.length).toBeLessThanOrEqual(3)
		const second = store.getByWorkspace(workspace)
		expect(second).not.toBe(first)
		first.reverse().pop()
		expect(second).toHaveLength(48)
		expect(store.getByWorkspace(workspace)[0].id).toBe("task-94")
	})

	it("observes refreshed workspace metadata on the next read", async () => {
		const original = historyItem("moving-task", workspace)
		await store.upsert(original)
		expect(store.getByWorkspace(workspace).map((item) => item.id)).toEqual([original.id])

		const neighbor = path.join(storagePath, "neighbor")
		const taskDirectory = path.join(storagePath, "tasks", original.id)
		await fs.mkdir(taskDirectory, { recursive: true })
		await fs.writeFile(
			path.join(taskDirectory, GlobalFileNames.historyItem),
			JSON.stringify({ ...original, workspace: neighbor }),
		)
		await store.invalidate(original.id, { requireExisting: true })

		expect(store.getByWorkspace(workspace)).toEqual([])
		expect(store.getByWorkspace(neighbor).map((item) => item.id)).toEqual([original.id])
		await store.upsert(original)
		expect(store.getByWorkspace(workspace).map((item) => item.id)).toEqual([original.id])
		expect(store.getByWorkspace(neighbor)).toEqual([])
	})

	it("preserves path equivalence, platform case handling, archived rows and stable equal timestamps", async () => {
		const items = [
			historyItem("same-root", `${workspace}${path.sep}`, 100),
			{ ...historyItem("archived", `${workspace}${path.sep}.${path.sep}`, 100), archived: true },
			historyItem("case-variant", workspace.toUpperCase(), 100),
			historyItem("older", workspace, 50),
			historyItem("neighbor", path.join(storagePath, "project-neighbor"), 200),
			historyItem("unassigned", undefined, 200),
		]
		for (const item of items) await store.upsert(item)

		expect(store.getByWorkspace(workspace).map((item) => item.id)).toEqual([
			"same-root",
			"archived",
			...(process.platform === "win32" ? ["case-variant"] : []),
			"older",
		])
		resolveWorkspace.mockClear()
		expect(store.getByWorkspace("")).toEqual([])
		expect(resolveWorkspace).not.toHaveBeenCalled()
	})

	it("caps temporary workspace matches at 64 paths while preserving overflow matches", async () => {
		const roots = Array.from({ length: 65 }, (_, index) => path.join(storagePath, `project-${index}`))
		for (const [index, root] of roots.entries()) await store.upsert(historyItem(`unique-${index}`, root))
		for (let index = 0; index < 64; index++) {
			await store.upsert(historyItem(`cached-${index}`, roots[0]))
			await store.upsert(historyItem(`overflow-${index}`, roots[64]))
		}
		resolveWorkspace.mockClear()

		expect(store.getByWorkspace(roots[0])).toHaveLength(65)
		// First 64 paths are memoized; the overflow path is normalized on every encounter.
		expect(resolveWorkspace.mock.calls).toHaveLength(130)
		expect(resolveWorkspace.mock.calls.filter(([root]) => root === roots[64])).toHaveLength(65)
		expect(store.getByWorkspace(roots[64])).toHaveLength(65)
	})
})
