import fs from "fs/promises"
import path from "path"
import os from "os"
import { createHash } from "crypto"
import { CodeIndexSearchService } from "../search-service"
import type { CodeIndexConfigManager } from "../config-manager"
import type { CodeIndexStateManager } from "../state-manager"
import type { IEmbedder, IVectorStore, VectorStoreSearchResult } from "../interfaces"
import { countCodeTokens } from "../processors/chunking"
import { packSearchResults, SEARCH_CONTEXT_TOKEN_BUDGET } from "../shared/retrieval"

vi.mock("fs/promises", async () => vi.importActual("fs/promises"))

const result = (id: string, codeChunk = "export const ready = true"): VectorStoreSearchResult => ({
	id,
	score: 0.8,
	payload: {
		filePath: id + ".ts",
		codeChunk,
		startLine: 1,
		endLine: 1,
		startOffset: 0,
		endOffset: codeChunk.length,
		fileHash: createHash("sha256").update(codeChunk).digest("hex"),
	},
})

describe("hybrid code search", () => {
	const config = {
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		currentSearchMinScore: 0.4,
		currentSearchMaxResults: 10,
	} as CodeIndexConfigManager
	const state = {
		getCurrentStatus: vi.fn(() => ({ systemStatus: "Indexed" })),
		setSystemState: vi.fn(),
	} as unknown as CodeIndexStateManager
	let embedder: IEmbedder
	let store: IVectorStore
	beforeEach(() => {
		vi.clearAllMocks()
		embedder = { createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[1, 0, 0]] }) } as unknown as IEmbedder
		store = {
			search: vi.fn().mockResolvedValue([]),
			searchLexical: vi.fn().mockResolvedValue([]),
		} as unknown as IVectorStore
	})
	it("rejects a matching chunk reached through a junction outside the workspace", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-search-"))
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-search-outside-"))
		try {
			const match = result("link/value")
			await fs.writeFile(path.join(outside, "value.ts"), match.payload!.codeChunk)
			await fs.symlink(outside, path.join(directory, "link"), "junction")
			vi.mocked(store.search).mockResolvedValue([match])
			const service = new CodeIndexSearchService(config, state, embedder, store, {
				workspacePath: directory,
				validateAccess: () => true,
			})
			expect(await service.searchIndex("ready")).toEqual([])
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
			await fs.rm(outside, { recursive: true, force: true })
		}
	})
	it("rescues an identifier missed by dense retrieval and promotes agreement between channels", async () => {
		vi.mocked(store.search).mockResolvedValue([result("distractor"), result("shared")])
		vi.mocked(store.searchLexical!).mockResolvedValue([result("exactIdentifier"), result("shared")])
		const results = await new CodeIndexSearchService(config, state, embedder, store).searchIndex(
			"exactIdentifier",
			"src",
		)
		expect(results[0].id).toBe("shared")
		expect(results.map((item) => item.id)).toContain("exactIdentifier")
		expect(results[0]).toMatchObject({ scoreType: "hybrid", semanticScore: 0.8, lexicalScore: 0.8 })
		expect(embedder.createEmbeddings).toHaveBeenCalledWith(["exactIdentifier"], undefined, "query")
		expect(store.search).toHaveBeenCalledWith([1, 0, 0], "src", 0.4, 40)
		expect(store.searchLexical).toHaveBeenCalledWith("exactIdentifier", "src", 40)
	})
	it("uses lexical evidence during embedding failure without corrupting indexing state", async () => {
		vi.mocked(embedder.createEmbeddings).mockRejectedValue(new Error("provider unavailable"))
		vi.mocked(store.searchLexical!).mockResolvedValue([result("exact")])
		expect((await new CodeIndexSearchService(config, state, embedder, store).searchIndex("exact"))[0].id).toBe(
			"exact",
		)
		expect(state.setSystemState).not.toHaveBeenCalled()
	})
	it("surfaces failure when no retrieval channel supplies evidence", async () => {
		vi.mocked(embedder.createEmbeddings).mockRejectedValue(new Error("provider unavailable"))
		await expect(new CodeIndexSearchService(config, state, embedder, store).searchIndex("query")).rejects.toThrow(
			"provider unavailable",
		)
		expect(state.setSystemState).not.toHaveBeenCalled()
	})
	it("rejects traversal before contacting either backend", async () => {
		await expect(
			new CodeIndexSearchService(config, state, embedder, store).searchIndex("query", "../secret"),
		).rejects.toThrow("outside the workspace")
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expect(store.searchLexical).not.toHaveBeenCalled()
	})
	it("bounds context and removes duplicate or overlapping source", async () => {
		const chunks = Array.from({ length: 50 }, (_, index) =>
			result(String(index), "performMeaningfulWork();\n".repeat(80)),
		)
		const packed = await packSearchResults([chunks[0], { ...chunks[0], id: "duplicate" }, ...chunks.slice(1)], 50)
		expect(packed.length).toBeLessThan(50)
		expect(packed.map((item) => item.id)).not.toContain("duplicate")
		let tokens = 0
		for (const item of packed)
			tokens += (await countCodeTokens(`${item.payload!.filePath}\n\n${item.payload!.codeChunk}`)) + 40
		expect(tokens).toBeLessThanOrEqual(SEARCH_CONTEXT_TOKEN_BUDGET)
	})
	it("revalidates source, ignore rules and scope on every request", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-search-"))
		try {
			const matches = [
				result("allowed"),
				result("ignored"),
				result("stale"),
				result("missing"),
				result("../outside"),
			]
			for (const item of matches.slice(0, 3))
				await fs.writeFile(path.join(directory, item.payload!.filePath), item.payload!.codeChunk)
			await fs.writeFile(path.join(directory, "stale.ts"), "changed after indexing")
			vi.mocked(store.search).mockResolvedValue(matches)
			const service = new CodeIndexSearchService(config, state, embedder, store, {
				workspacePath: directory,
				validateAccess: (file) => file !== "ignored.ts",
			})
			expect((await service.searchIndex("ready")).map((item) => item.id)).toEqual(["allowed"])
			await fs.writeFile(path.join(directory, "allowed.ts"), "changed between searches")
			expect(await service.searchIndex("ready")).toEqual([])
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
})
