import type { CodeBlock, ICodeParser, IVectorStore } from "../../interfaces"
import type { CacheManager } from "../../cache-manager"
import { VertexGeminiEmbedder } from "../../embedders/vertex"
import { DirectoryScanner } from "../scanner"
import ignore from "ignore"

const { embedContent, files } = vi.hoisted(() => ({
	embedContent: vi.fn(),
	files: Array.from({ length: 85 }, (_, index) => `/workspace/file-${index}.ts`),
}))

vi.mock("@google/genai", () => ({ GoogleGenAI: vi.fn(() => ({ models: { embedContent } })) }))
vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureEvent: vi.fn() } } }))
vi.mock("fs/promises", () => ({ stat: vi.fn(async () => ({ size: 1024 })) }))
vi.mock("../../../glob/list-files", () => ({ listFiles: vi.fn(async () => [files, false]) }))
vi.mock("../../../../utils/path", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../utils/path")>()),
	getWorkspacePathForContext: () => "/workspace",
}))
vi.mock("../../../../core/ignore/AlphaIgnoreController", () => ({
	AlphaIgnoreController: class {
		async initialize() {}
		dispose() {}
		filterPaths(paths: string[]) {
			return paths
		}
	},
}))
vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
		getWorkspaceFolder: () => ({ uri: { fsPath: "/workspace" } }),
		fs: { readFile: async () => Buffer.from("source") },
	},
	Uri: { file: (filePath: string) => filePath },
}))

it.each(["gemini-embedding-001", "gemini-embedding-2"])(
	"measures %s indexing with 1,700 blocks and bounded requests",
	async (model) => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		try {
			let active = 0
			let maxActive = 0
			let requests = 0
			let indexed = 0
			let firstRequestMs: number | undefined
			let firstIndexedMs: number | undefined
			let parsingFinishedMs = 0
			const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
			embedContent.mockImplementation(
				async ({ contents }: { contents: Array<string | { parts: { text: string }[] }> }) => {
					expect(contents).toHaveLength(1)
					firstRequestMs ??= Date.now()
					requests++
					maxActive = Math.max(maxActive, ++active)
					// Stable request costs depend on the input, not scheduling order.
					const text = typeof contents[0] === "string" ? contents[0] : contents[0].parts[0].text
					const blockId = Number(text.match(/block-(\d+)/)?.[1])
					await pause(blockId % 17 === 0 ? 400 : 100)
					active--
					return { embeddings: [{ values: [blockId, 1] }] }
				},
			)
			const parser: ICodeParser = {
				parseFile: async (filePath) => {
					await pause(20)
					parsingFinishedMs = Date.now()
					const fileIndex = files.indexOf(filePath)
					return Array.from(
						{ length: 20 },
						(_, line): CodeBlock => ({
							file_path: filePath,
							content: `block-${fileIndex * 20 + line}`,
							start_line: line + 1,
							end_line: line + 1,
							type: "function",
							identifier: "fixture",
							fileHash: `file-${fileIndex}`,
							segmentHash: `segment-${fileIndex}-${line}`,
						}),
					)
				},
			}
			const vectorStore = {
				upsertPoints: vi.fn(async () => pause(2)),
				deletePointsByMultipleFilePaths: vi.fn(),
			} as unknown as IVectorStore
			const cache = {
				getHash: () => undefined,
				getAllHashes: () => ({}),
				updateHash: vi.fn(),
			} as unknown as CacheManager
			const embedder = new VertexGeminiEmbedder(
				{
					apiProvider: "vertex",
					projectId: "fixture",
					location: "global",
				},
				model,
			)
			const scanner = new DirectoryScanner(embedder, vectorStore, parser, cache, ignore(), 60)
			const errors: Error[] = []
			const run = scanner.scanDirectory(
				"/workspace",
				(error) => errors.push(error),
				(count) => {
					firstIndexedMs ??= Date.now()
					indexed += count
				},
			)
			await vi.runAllTimersAsync()
			await run
			console.info(
				"VERTEX_INDEX_BENCHMARK",
				JSON.stringify({
					model,
					blocks: indexed,
					requests,
					maxActive,
					firstRequestMs,
					firstIndexedMs,
					parsingFinishedMs,
					totalMs: Date.now(),
				}),
			)
			expect(errors).toEqual([])
			expect(indexed).toBe(1700)
			expect(requests).toBe(1700)
			expect(maxActive).toBe(model === "gemini-embedding-2" ? 16 : 8)
			expect(firstRequestMs).toBeLessThan(parsingFinishedMs)
			expect(firstIndexedMs).toBeLessThan(parsingFinishedMs)
			expect(firstIndexedMs).toBeLessThan(model === "gemini-embedding-2" ? 1800 : 3000)
			expect(Date.now()).toBeLessThan(model === "gemini-embedding-2" ? 14000 : 26000)
		} finally {
			vi.useRealTimers()
		}
	},
)
