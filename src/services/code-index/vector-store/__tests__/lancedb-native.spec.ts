import path from "path"
import os from "os"
import fs from "fs/promises"
import * as lancedb from "@lancedb/lancedb"
import { LanceDbVectorStore } from "../lancedb-client"

vi.mock("fs/promises", async () => vi.importActual("fs/promises"))
vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

describe("native LanceDB hybrid index", () => {
	let directory: string
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-retrieval-"))
	})

	it("measures projected retrieval against the previous full-row query at 3072 dimensions", async () => {
		const dimensions = 3072
		const store = new LanceDbVectorStore(directory, "index", dimensions, "fixture")
		await store.initialize()
		await store.upsertPoints(
			Array.from({ length: 500 }, (_, index) => ({
				id: String(index),
				vector: [index / 500, 1, ...new Array(dimensions - 2).fill(0)],
				payload: {
					filePath: `src/file-${index}.ts`,
					codeChunk: `const identifier${index} = true`,
					startLine: 1,
					endLine: 1,
				},
			})),
		)
		const connection = await lancedb.connect(path.join(directory, "index"))
		const table = await connection.openTable("code_blocks")
		const vector = [1, 1, ...new Array(dimensions - 2).fill(0)]
		const samples = []
		for (let sample = 0; sample < 5; sample++) {
			const beforeStart = performance.now()
			const before = await table
				.vectorSearch(vector)
				.distanceType("cosine")
				.where("type = 'code'")
				.limit(200)
				.toArray()
			const beforeMs = performance.now() - beforeStart
			const afterStart = performance.now()
			const after = await store.search(vector, undefined, 0, 200)
			const afterMs = performance.now() - afterStart
			const bytes = (value: unknown) =>
				Buffer.byteLength(
					JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? String(entry) : entry)),
				)
			const beforeBytes = bytes(before)
			const afterBytes = bytes(after)
			expect(after.map((match) => String(match.id))).toEqual(before.map((row) => String(row.id)))
			expect(afterBytes).toBeLessThan(beforeBytes / 10)
			samples.push({ sample, beforeMs, afterMs, beforeBytes, afterBytes })
		}
		console.info(
			"LANCEDB_PROJECTION_BENCHMARK",
			JSON.stringify({ rows: 500, candidates: 200, dimensions, samples }),
		)
	})
	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 })
	})

	it("searches newly inserted and updated identifiers, scopes literal paths, and migrates same-dimension models", async () => {
		const store = new LanceDbVectorStore(directory, "index", 3, "model-a")
		expect(await store.initialize()).toBe(true)
		const point = (id: string, filePath: string, codeChunk: string, vector: number[]) => ({
			id,
			vector,
			payload: {
				filePath,
				codeChunk,
				startLine: 1,
				endLine: 1,
				context: "class SessionRegistry",
				identifier: codeChunk,
			},
		})
		await store.upsertPoints([
			point("a", "src_1/state.ts", "cancelDescendants", [1, 0, 0]),
			point("b", "srcX1/state.ts", "cancelDescendants", [0, 1, 0]),
			point("c", "src_1/queue.ts", "drainQueue", [0, 0, 1]),
		])
		expect((await store.searchLexical("cancelDescendants", "src_1")).map((result) => result.id)).toEqual(["a"])
		expect((await store.search([1, 0, 0], "src_1", 0.4, 10))[0]).toMatchObject({ id: "a", score: 1 })
		await store.upsertPoints([point("a", "src_1/state.ts", "releaseSession", [1, 0, 0])])
		expect(await store.searchLexical("cancelDescendants", "src_1")).toEqual([])
		expect((await store.searchLexical("releaseSession", "src_1"))[0].id).toBe("a")
		await store.markIndexingComplete()
		expect(await new LanceDbVectorStore(directory, "index", 3, "model-a").initialize()).toBe(false)
		const changed = new LanceDbVectorStore(directory, "index", 3, "model-b")
		expect(await changed.initialize()).toBe(true)
		expect(await changed.hasIndexedData()).toBe(false)
		expect(await changed.searchLexical("releaseSession")).toEqual([])
	})

	it("atomically replaces one file, retains other files, and reads reusable vectors after reopening", async () => {
		const store = new LanceDbVectorStore(directory, "index", 3, "model-a")
		await store.initialize()
		const point = (id: string, filePath: string, codeChunk: string) => ({
			id,
			vector: [1, 0, 0],
			payload: { filePath, codeChunk, startLine: 1, endLine: 1, fileHash: "new", context: "scope" },
		})
		await store.upsertPoints([
			point("old", "src/o'hare.ts", "obsoleteunique"),
			point("other", "src/other.ts", "otherunique"),
		])
		await store.replaceFilePoints("src/o'hare.ts", [point("new", "src/o'hare.ts", "freshunique")])
		const reopened = new LanceDbVectorStore(directory, "index", 3, "model-a")
		await reopened.initialize()
		expect((await reopened.getPointsByFilePath("src/o'hare.ts")).map((p) => p.id)).toEqual(["new"])
		expect((await reopened.getPointsByFilePath("src/other.ts"))[0].vector).toEqual([1, 0, 0])
		expect(await reopened.searchLexical("obsoleteunique")).toEqual([])
		expect((await reopened.searchLexical("freshunique"))[0].id).toBe("new")
		await reopened.replaceFilePoints("src/o'hare.ts", [])
		expect(await reopened.getPointsByFilePath("src/o'hare.ts")).toEqual([])
		expect((await reopened.getPointsByFilePath("src/other.ts"))[0].id).toBe("other")
	})
})
