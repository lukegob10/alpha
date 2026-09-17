import path from "path"
import os from "os"
import fs from "fs/promises"
import { LanceDbVectorStore } from "../lancedb-client"

vi.mock("fs/promises", async () => vi.importActual("fs/promises"))
vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

describe("native LanceDB hybrid index", () => {
	let directory: string
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-retrieval-"))
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
		expect((await store.search([1, 0, 0], "src_1", 0, 10))[0].id).toBe("a")
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
})
