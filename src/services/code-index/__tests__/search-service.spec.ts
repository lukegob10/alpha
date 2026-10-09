import fs from "fs/promises"
import path from "path"
import os from "os"
import { createHash } from "crypto"
import { CodeIndexSearchService } from "../search-service"
import type { CodeIndexConfigManager } from "../config-manager"
import type { CodeIndexStateManager } from "../state-manager"
import type { ICodeParser, IEmbedder, IVectorStore, VectorStoreSearchResult } from "../interfaces"
import { countCodeTokens } from "../processors/chunking"
import { packSearchResults, SEARCH_CONTEXT_TOKEN_BUDGET } from "../shared/retrieval"
import { chunkSource } from "../processors/chunking"

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
	it("bounds local retrieval waiting behind a slow provider", async () => {
		vi.useFakeTimers()
		try {
			const samples: Array<{ strategy: string; returnedMs: number }> = []
			for (const strategy of ["previous-allSettled", "bounded-search"]) {
				for (let sample = 0; sample < 5; sample++) {
					vi.setSystemTime(0)
					vi.mocked(embedder.createEmbeddings).mockImplementation(async () => {
						await new Promise<void>((resolve) => setTimeout(resolve, 30_000))
						return { embeddings: [[1, 0, 0]] }
					})
					vi.mocked(store.searchLexical!).mockResolvedValue([result("local")])
					let returnedAt = -1
					// Characterize the verified previous channel join on the identical scripted workload.
					const search =
						strategy === "previous-allSettled"
							? Promise.allSettled([
									embedder.createEmbeddings(["local"]),
									store.searchLexical!("local"),
								]).then(() => ({ results: [result("local")] }))
							: new CodeIndexSearchService(config, state, embedder, store).searchIndexWithDiagnostics(
									"local",
								)
					void search.then(() => {
						returnedAt = Date.now()
					})
					await vi.runAllTimersAsync()
					const response = await search
					samples.push({ strategy, returnedMs: returnedAt })
					expect(response.results[0].id).toBe("local")
					expect(returnedAt).toBe(strategy === "previous-allSettled" ? 30_000 : 1500)
				}
			}
			console.info("RETRIEVAL_WAIT_BENCHMARK", JSON.stringify({ providerMs: 30_000, samples }))
		} finally {
			vi.useRealTimers()
		}
	})
	it("cancels pending search on Stop without accepting a late provider response", async () => {
		vi.useFakeTimers()
		try {
			let release!: (value: { embeddings: number[][] }) => void
			vi.mocked(embedder.createEmbeddings).mockImplementation(
				() =>
					new Promise((resolve) => {
						release = resolve
					}),
			)
			const service = new CodeIndexSearchService(config, state, embedder, store)
			const run = service.searchIndex("query")
			const rejection = expect(run).rejects.toMatchObject({ name: "AbortError" })
			service.cancelPending()
			await rejection
			release({ embeddings: [[1, 0, 0]] })
			await Promise.resolve()
			expect(store.search).not.toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})
	it("allows a semantic-only query time to produce evidence when local channels have no candidates", async () => {
		vi.useFakeTimers()
		try {
			vi.mocked(embedder.createEmbeddings).mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 2500))
				return { embeddings: [[1, 0, 0]] }
			})
			vi.mocked(store.search).mockResolvedValue([result("semantic")])
			const run = new CodeIndexSearchService(config, state, embedder, store).searchIndexWithDiagnostics(
				"conceptual question",
			)
			await vi.runAllTimersAsync()
			expect(await run).toMatchObject({
				results: [{ id: "semantic" }],
				diagnostics: { semanticStatus: "complete" },
			})
		} finally {
			vi.useRealTimers()
		}
	})
	it("surfaces a deadline as an error when no usable channel returns evidence", async () => {
		vi.useFakeTimers()
		try {
			vi.mocked(embedder.createEmbeddings).mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 30_000))
				return { embeddings: [[1, 0, 0]] }
			})
			const run = new CodeIndexSearchService(config, state, embedder, store).searchIndex("question")
			const rejection = expect(run).rejects.toMatchObject({ name: "TimeoutError" })
			await vi.runAllTimersAsync()
			await rejection
			expect(store.search).not.toHaveBeenCalled()
			expect(state.setSystemState).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
	it("captures the search threshold before awaiting the provider", async () => {
		let release!: (value: { embeddings: number[][] }) => void
		vi.mocked(embedder.createEmbeddings).mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const settings = { ...config, currentSearchMinScore: 0.4 } as CodeIndexConfigManager
		const run = new CodeIndexSearchService(settings, state, embedder, store).searchIndex("query")
		Object.defineProperty(settings, "currentSearchMinScore", { value: 0.95 })
		release({ embeddings: [[1, 0, 0]] })
		await run
		expect(store.search).toHaveBeenCalledWith([1, 0, 0], undefined, 0.4, 200)
	})
	it("retains fresh evidence when another pending file exceeds the query deadline", async () => {
		vi.useFakeTimers()
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-fresh-search-"))
		let release!: () => void
		try {
			for (const file of ["ready.ts", "slow.ts"])
				await fs.writeFile(path.join(directory, file), "const freshIdentifier = 1")
			let parsed!: () => void
			let entered!: () => void
			const ready = new Promise<void>((resolve) => {
				parsed = resolve
			})
			const slow = new Promise<void>((resolve) => {
				entered = resolve
			})
			const barrier = new Promise<void>((resolve) => {
				release = resolve
			})
			const service = new CodeIndexSearchService(config, state, embedder, store, {
				workspacePath: directory,
				validateAccess: () => true,
				pendingFiles: () => ["ready.ts", "slow.ts"],
				parser: {
					parseFile: async (file, options) => {
						if (file.endsWith("slow.ts")) {
							entered()
							await barrier
							return []
						}
						const chunks = await chunkSource(file, options!.content!, options!.fileHash!)
						parsed()
						return chunks
					},
				},
			})
			const run = service.searchIndexWithDiagnostics("freshIdentifier")
			await Promise.all([ready, slow])
			await vi.advanceTimersByTimeAsync(1500)
			expect(await run).toMatchObject({
				results: [{ payload: { filePath: "ready.ts" } }],
				diagnostics: { freshStatus: "timeout", freshCandidates: 1 },
			})
		} finally {
			release?.()
			vi.useRealTimers()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
	it("revalidates fresh source after edits during retrieval and never lets indexed duplicates overwrite it", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-fresh-search-"))
		try {
			const file = path.join(directory, "current.ts")
			await fs.writeFile(file, "export const freshIdentifier = 1\n")
			let parsed!: () => void
			const prepared = new Promise<void>((resolve) => {
				parsed = resolve
			})
			let release!: (value: { embeddings: number[][] }) => void
			vi.mocked(embedder.createEmbeddings).mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve
					}),
			)
			const service = new CodeIndexSearchService(config, state, embedder, store, {
				workspacePath: directory,
				validateAccess: () => true,
				pendingFiles: () => [file],
				parser: {
					parseFile: async (filePath, options) => {
						const blocks = await chunkSource(filePath, options!.content!, options!.fileHash!)
						parsed()
						return blocks
					},
				},
			})
			const run = service.searchIndex("freshIdentifier")
			await prepared
			await fs.writeFile(file, "export const freshIdentifier = 2\n")
			release({ embeddings: [[1, 0, 0]] })
			expect(await run).toEqual([])
			const fresh = await service.searchIndex("freshIdentifier")
			vi.mocked(store.searchLexical!).mockResolvedValue(
				fresh.map((match) => ({ ...match, payload: { ...match.payload!, fileHash: "stale" } })),
			)
			vi.mocked(store.search).mockResolvedValue(
				fresh.map((match) => ({ ...match, payload: { ...match.payload!, fileHash: "stale" } })),
			)
			expect((await service.searchIndex("freshIdentifier"))[0].payload?.codeChunk).toContain("= 2")
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
	it("filters pending files by scope, ignores and real workspace boundaries before parsing", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-fresh-search-"))
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-fresh-outside-"))
		try {
			await fs.mkdir(path.join(directory, "src"))
			for (const name of ["src/current.ts", "src/ignored.ts", "other.ts"])
				await fs.writeFile(path.join(directory, name), "const freshIdentifier = 1")
			await fs.writeFile(path.join(outside, "secret.ts"), "const freshIdentifier = 2")
			await fs.symlink(outside, path.join(directory, "src/link"), "junction")
			const parser = {
				parseFile: vi.fn<ICodeParser["parseFile"]>(async (filePath, options) =>
					chunkSource(filePath, options!.content!, options!.fileHash!),
				),
			}
			const service = new CodeIndexSearchService(config, state, embedder, store, {
				workspacePath: directory,
				validateAccess: (file) => !file.includes("ignored"),
				parser,
				pendingFiles: () => [
					"../unsafe.ts",
					"src/link/secret.ts",
					"src/ignored.ts",
					"other.ts",
					"src/current.ts",
				],
			})
			expect(
				(await service.searchIndex("freshIdentifier", "src")).map((match) => match.payload!.filePath),
			).toEqual(["src/current.ts"])
			expect(parser.parseFile).toHaveBeenCalledTimes(1)
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
			await fs.rm(outside, { recursive: true, force: true })
		}
	})
	it("keeps healthy results searchable during an incremental error and fails closed if source cannot open", async () => {
		const errorState = { getCurrentStatus: () => ({ systemStatus: "Error" }) } as unknown as CodeIndexStateManager
		vi.mocked(store.searchLexical!).mockResolvedValue([result("healthy")])
		expect(
			(
				await new CodeIndexSearchService(config, errorState, embedder, store).searchIndexWithDiagnostics(
					"healthy",
				)
			).diagnostics.indexFreshness,
		).toBe("error")
		expect(
			(await new CodeIndexSearchService(config, errorState, embedder, store).searchIndex("healthy"))[0].id,
		).toBe("healthy")
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-fresh-search-"))
		try {
			const service = new CodeIndexSearchService(config, errorState, embedder, store, {
				workspacePath: path.join(directory, "missing"),
				validateAccess: () => true,
			})
			await expect(service.searchIndex("healthy")).rejects.toThrow("ENOENT")
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
	it("searches current saved chunks while their replacement is pending", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-fresh-search-"))
		try {
			const file = path.join(directory, "current.ts")
			await fs.writeFile(file, "export function freshIdentifier() { return 42 }\n")
			const service = new CodeIndexSearchService(config, state, embedder, store, {
				workspacePath: directory,
				validateAccess: () => true,
				pendingFiles: () => [file],
				parser: {
					parseFile: async (filePath, options) =>
						chunkSource(filePath, options!.content!, options!.fileHash!),
				},
			})
			const response = await service.searchIndexWithDiagnostics("freshIdentifier")
			expect(response.results).toMatchObject([
				{ payload: { filePath: "current.ts", codeChunk: expect.stringContaining("freshIdentifier") } },
			])
			expect(response.diagnostics).toMatchObject({ freshCandidates: 1 })
			await fs.writeFile(file, "export const unrelated = 1\n")
			expect(await service.searchIndex("freshIdentifier")).toEqual([])
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
	it("finds shared evidence beyond the old candidate cutoff when returning ten chunks", async () => {
		const dense = [...Array.from({ length: 60 }, (_, index) => result(`dense-${index}`)), result("evidence")]
		const lexical = [...Array.from({ length: 60 }, (_, index) => result(`lexical-${index}`)), result("evidence")]
		vi.mocked(store.search).mockImplementation(async (_vector, _prefix, _score, limit) => dense.slice(0, limit))
		vi.mocked(store.searchLexical!).mockImplementation(async (_query, _prefix, limit) => lexical.slice(0, limit))
		const results = await new CodeIndexSearchService(config, state, embedder, store).searchIndex("find evidence")
		expect(results).toHaveLength(10)
		expect(results[0].id).toBe("evidence")
		expect(embedder.createEmbeddings).toHaveBeenCalledTimes(1)
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
		expect(embedder.createEmbeddings).toHaveBeenCalledWith(
			["exactIdentifier"],
			undefined,
			"query",
			expect.any(AbortSignal),
		)
		expect(store.search).toHaveBeenCalledWith([1, 0, 0], "src", 0.4, 200)
		expect(store.searchLexical).toHaveBeenCalledWith("exactIdentifier", "src", 200)
	})
	it("reports the effective cap and candidate counts without hiding keyword matches at a high threshold", async () => {
		vi.mocked(store.searchLexical!).mockResolvedValue([result("exact")])
		const settings = {
			...config,
			currentSearchMinScore: 0.95,
			currentSearchMaxResults: 200,
		} as CodeIndexConfigManager
		const response = await new CodeIndexSearchService(settings, state, embedder, store).searchIndexWithDiagnostics(
			"exact",
		)
		expect(response.results).toMatchObject([{ id: "exact", score: 0.5, scoreType: "hybrid", lexicalScore: 0.8 }])
		expect(response.diagnostics).toMatchObject({
			candidateLimit: 200,
			semanticCandidates: 0,
			lexicalCandidates: 1,
			fusedCandidates: 1,
			effectiveMaxResults: 100,
			returnedChunks: 1,
			skippedBudget: 0,
			skippedSource: 0,
		})
		expect(store.search).toHaveBeenCalledWith([1, 0, 0], undefined, 0.95, 200)
	})
	it("returns empty diagnostics without embedding an empty query", async () => {
		const response = await new CodeIndexSearchService(config, state, embedder, store).searchIndexWithDiagnostics(
			"  ",
		)
		expect(response.results).toEqual([])
		expect(response.diagnostics).toMatchObject({ fusedCandidates: 0, returnedChunks: 0, estimatedContextTokens: 0 })
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
		expect(store.searchLexical).not.toHaveBeenCalled()
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
