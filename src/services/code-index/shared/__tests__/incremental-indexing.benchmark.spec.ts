import path from "path"
import { createHash } from "crypto"
import { VertexGeminiEmbedder } from "../../embedders/vertex"
import { GeminiEmbedder } from "../../embedders/gemini"
import type { CodeBlock, IVectorStore } from "../../interfaces"
import { createIndexPoint, getEmbeddingText } from "../embedding-input"
import { prepareIndexPoints } from "../file-indexing"
import { EmbeddingRateLimiter } from "../embedding-rate-limiter"

const sdk = vi.hoisted(() => ({ embed: vi.fn() }))
vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		models = { embedContent: sdk.embed }
	},
}))

/** Compare the verified previous whole-file strategy with reuse on the same warm-index fixture. */
it.each(["vertex", "gemini"] as const)("measures one changed chunk in a ten-chunk warm %s index", async (provider) => {
	vi.useFakeTimers()
	try {
		const workspace = path.resolve("workspace")
		const filePath = path.join(workspace, "state.ts")
		const blocks = (changed: boolean): CodeBlock[] =>
			Array.from({ length: 10 }, (_, index) => {
				const content = changed && index === 0 ? "modified_chunk" : `source_chunk_${index}`
				return {
					file_path: filePath,
					content,
					identifier: `function_${index}`,
					context: "scope",
					type: "code",
					start_line: index + 1,
					end_line: index + 1,
					startOffset: index * 20 + (changed && index > 0 ? 3 : 0),
					endOffset: index * 20 + 19,
					fileHash: changed ? "new-file-hash" : "old-file-hash",
					segmentHash: createHash("sha256").update(content).digest("hex"),
				}
			})
		const previous = blocks(false).map((block) => createIndexPoint(block, workspace, [1, 0, 0]))
		const samples = []
		for (const strategy of ["previous-whole-file", "incremental-reuse"] as const) {
			for (let sample = 0; sample < 5; sample++) {
				vi.setSystemTime(0)
				let requests = 0
				let inputs = 0
				sdk.embed.mockImplementation(async ({ contents }: { contents: unknown[] }) => {
					requests++
					inputs += contents.length
					await new Promise<void>((resolve) => setTimeout(resolve, 50))
					return { embeddings: contents.map(() => ({ values: [1, 0, 0] })) }
				})
				const embedder =
					provider === "vertex"
						? new VertexGeminiEmbedder(
								{ apiProvider: "vertex", projectId: "fixture", location: "global" },
								"gemini-embedding-001",
								1,
							)
						: new GeminiEmbedder("fixture-key", "gemini-embedding-001", 1)
				const store = { getPointsByFilePath: vi.fn(async () => previous) } as unknown as IVectorStore
				const current = blocks(true)
				const run =
					strategy === "previous-whole-file"
						? embedder.createEmbeddings(current.map((block) => getEmbeddingText(block, workspace)))
						: prepareIndexPoints(current, workspace, {
								embedder,
								vectorStore: store,
								rateLimiter: new EmbeddingRateLimiter(0),
								batchSize: 60,
							})
				await vi.runAllTimersAsync()
				const result = await run
				if (Array.isArray(result)) {
					expect(result).toHaveLength(10)
					expect(result.every((point) => point.payload.fileHash === "new-file-hash")).toBe(true)
					expect(result[1].id).not.toBe(previous[1].id)
				}
				const indexedMs = Date.now()
				const indexedRequests = requests
				const indexedInputs = inputs
				const query = embedder.createEmbeddings(["find the source"], undefined, "query")
				await vi.runAllTimersAsync()
				await query
				samples.push({
					strategy,
					sample,
					indexedMs,
					inputs: indexedInputs,
					requests: indexedRequests,
					queryReadyMs: Date.now(),
				})
				expect(indexedInputs).toBe(strategy === "previous-whole-file" ? 10 : 1)
				expect(indexedMs).toBe(provider === "vertex" && strategy === "previous-whole-file" ? 9050 : 50)
				expect(Date.now()).toBe(strategy === "previous-whole-file" ? 10_050 : 1050)
				expect(vi.getTimerCount()).toBe(0)
			}
		}
		console.info(
			"INCREMENTAL_INDEX_BENCHMARK",
			JSON.stringify({ provider, chunks: 10, changedChunks: 1, requestLatencyMs: 50, pacingMs: 1000, samples }),
		)
	} finally {
		vi.useRealTimers()
	}
})
