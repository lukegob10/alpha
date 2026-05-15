import * as fs from "fs/promises"
import * as path from "path"
import * as lancedb from "@lancedb/lancedb"

import { LanceDbVectorStore } from "../lancedb-client"

vitest.mock("@lancedb/lancedb", () => ({
	connect: vitest.fn(),
}))

vitest.mock("fs/promises", () => ({
	mkdir: vitest.fn(),
}))

vitest.mock("../../../../i18n", () => ({
	t: (key: string, params?: Record<string, string>) =>
		params?.indexPath && params?.errorMessage ? `${key}:${params.indexPath}:${params.errorMessage}` : key,
}))

const createQueryBuilder = (rowsQueue: any[][]) => {
	const builder = {
		where: vitest.fn().mockReturnThis(),
		limit: vitest.fn().mockReturnThis(),
		toArray: vitest.fn().mockImplementation(async () => rowsQueue.shift() ?? []),
	}

	return builder
}

const createMergeBuilder = () => {
	const builder = {
		whenMatchedUpdateAll: vitest.fn().mockReturnThis(),
		whenNotMatchedInsertAll: vitest.fn().mockReturnThis(),
		execute: vitest.fn().mockResolvedValue(undefined),
	}

	return builder
}

const createSearchBuilder = (rows: any[]) => {
	const builder = {
		distanceType: vitest.fn().mockReturnThis(),
		where: vitest.fn().mockReturnThis(),
		limit: vitest.fn().mockReturnThis(),
		toArray: vitest.fn().mockResolvedValue(rows),
	}

	return builder
}

describe("LanceDbVectorStore", () => {
	const workspacePath = path.join("C:", "workspace")
	const vectorSize = 3

	let mockConnection: any
	let mockTable: any
	let queryRowsQueue: any[][]
	let mergeBuilder: ReturnType<typeof createMergeBuilder>
	let searchBuilder: ReturnType<typeof createSearchBuilder>

	beforeEach(() => {
		vitest.clearAllMocks()

		queryRowsQueue = []
		mergeBuilder = createMergeBuilder()
		searchBuilder = createSearchBuilder([])

		mockTable = {
			query: vitest.fn().mockImplementation(() => createQueryBuilder(queryRowsQueue)),
			mergeInsert: vitest.fn().mockReturnValue(mergeBuilder),
			search: vitest.fn().mockReturnValue(searchBuilder),
			delete: vitest.fn().mockResolvedValue(undefined),
			countRows: vitest.fn().mockResolvedValue(0),
		}

		mockConnection = {
			tableNames: vitest.fn().mockResolvedValue([]),
			openTable: vitest.fn().mockResolvedValue(mockTable),
			createTable: vitest.fn().mockResolvedValue(mockTable),
			dropTable: vitest.fn().mockResolvedValue(undefined),
		}
		;(lancedb.connect as any).mockResolvedValue(mockConnection)
		;(fs.mkdir as any).mockResolvedValue(undefined)
	})

	it("creates a local LanceDB table at the default workspace-relative path", async () => {
		const store = new LanceDbVectorStore(workspacePath, undefined, vectorSize)
		const expectedPath = path.join(workspacePath, ".alpha/code-index/lancedb")

		const created = await store.initialize()

		expect(created).toBe(true)
		expect(fs.mkdir).toHaveBeenCalledWith(expectedPath, { recursive: true })
		expect(lancedb.connect).toHaveBeenCalledWith(expectedPath)
		expect(mockConnection.createTable).toHaveBeenCalledWith(
			"code_blocks",
			[
				expect.objectContaining({
					id: "__indexing_metadata__",
					type: "metadata",
					vectorSize,
					indexingComplete: false,
					vector: [0, 0, 0],
				}),
			],
			{ mode: "overwrite" },
		)
	})

	it("recreates an existing table when the stored vector dimension differs", async () => {
		mockConnection.tableNames.mockResolvedValue(["code_blocks"])
		queryRowsQueue.push([{ vectorSize: 4 }])

		const store = new LanceDbVectorStore(workspacePath, ".alpha/code-index/lancedb", vectorSize)
		const created = await store.initialize()

		expect(created).toBe(true)
		expect(mockConnection.openTable).toHaveBeenCalledWith("code_blocks")
		expect(mockConnection.dropTable).toHaveBeenCalledWith("code_blocks")
		expect(mockConnection.createTable).toHaveBeenCalled()
	})

	it("upserts code block points with normalized workspace-relative paths", async () => {
		mockConnection.tableNames.mockResolvedValue(["code_blocks"])
		const store = new LanceDbVectorStore(workspacePath, ".alpha/code-index/lancedb", vectorSize)

		await store.upsertPoints([
			{
				id: "point-1",
				vector: [0.1, 0.2, 0.3],
				payload: {
					filePath: path.join(workspacePath, "src", "index.ts"),
					codeChunk: "const value = 1",
					startLine: 4,
					endLine: 5,
					segmentHash: "hash-1",
				},
			},
		])

		expect(mockTable.mergeInsert).toHaveBeenCalledWith("id")
		expect(mergeBuilder.execute).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "point-1",
				type: "code",
				filePath: "src/index.ts",
				codeChunk: "const value = 1",
				startLine: 4,
				endLine: 5,
				segmentHash: "hash-1",
				vector: [0.1, 0.2, 0.3],
			}),
		])
	})

	it("searches by directory prefix and converts LanceDB distance to score", async () => {
		mockConnection.tableNames.mockResolvedValue(["code_blocks"])
		searchBuilder = createSearchBuilder([
			{
				id: "point-1",
				filePath: "src/services/index.ts",
				codeChunk: "export const ok = true",
				startLine: 1,
				endLine: 2,
				segmentHash: "hash-1",
				_distance: 0.2,
			},
			{
				id: "point-2",
				filePath: "src/services/noise.ts",
				codeChunk: "noise",
				startLine: 10,
				endLine: 11,
				segmentHash: "hash-2",
				_distance: 0.8,
			},
		])
		mockTable.search.mockReturnValue(searchBuilder)

		const store = new LanceDbVectorStore(workspacePath, ".alpha/code-index/lancedb", vectorSize)
		const results = await store.search([0.1, 0.2, 0.3], "src\\services", 0.5, 5)

		expect(mockTable.search).toHaveBeenCalledWith([0.1, 0.2, 0.3])
		expect(searchBuilder.distanceType).toHaveBeenCalledWith("cosine")
		expect(searchBuilder.where).toHaveBeenCalledWith(
			"type = 'code' AND (filePath = 'src/services' OR filePath LIKE 'src/services/%')",
		)
		expect(searchBuilder.limit).toHaveBeenCalledWith(5)
		expect(results).toEqual([
			{
				id: "point-1",
				score: 0.8,
				payload: {
					filePath: "src/services/index.ts",
					codeChunk: "export const ok = true",
					startLine: 1,
					endLine: 2,
					segmentHash: "hash-1",
				},
			},
		])
	})

	it("deletes multiple file paths using normalized stored paths", async () => {
		mockConnection.tableNames.mockResolvedValue(["code_blocks"])
		const store = new LanceDbVectorStore(workspacePath, ".alpha/code-index/lancedb", vectorSize)

		await store.deletePointsByMultipleFilePaths([path.join(workspacePath, "src", "a.ts"), "src/b.ts"])

		expect(mockTable.delete).toHaveBeenCalledWith("filePath IN ('src/a.ts', 'src/b.ts')")
	})

	it("tracks whether indexed data is complete", async () => {
		mockConnection.tableNames.mockResolvedValue(["code_blocks"])
		mockTable.countRows.mockResolvedValue(2)
		queryRowsQueue.push([{ id: "__indexing_metadata__", indexingComplete: true }])
		const store = new LanceDbVectorStore(workspacePath, ".alpha/code-index/lancedb", vectorSize)

		await expect(store.hasIndexedData()).resolves.toBe(true)
		expect(mockTable.countRows).toHaveBeenCalledWith("type = 'code'")
		expect(mockTable.query).toHaveBeenCalled()
	})

	it("marks indexing complete through the metadata row", async () => {
		mockConnection.tableNames.mockResolvedValue(["code_blocks"])
		const store = new LanceDbVectorStore(workspacePath, ".alpha/code-index/lancedb", vectorSize)

		await store.markIndexingComplete()

		expect(mergeBuilder.execute).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "__indexing_metadata__",
				type: "metadata",
				indexingComplete: true,
				vector: [0, 0, 0],
			}),
		])
	})
})
