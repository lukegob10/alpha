import path from "path"
import { createIndexPoint, getEmbeddingText, getIndexIdentity, validateEmbeddingBatch } from "../embedding-input"
import { codeTerms, lexicalVector } from "../lexical"
import type { CodeBlock } from "../../interfaces"
import type { CodeIndexConfig } from "../../interfaces/config"

describe("index representation", () => {
	const block: CodeBlock = {
		file_path: "src/state.ts",
		content: "return ready",
		identifier: "isReady",
		context: "class State\nisReady()",
		type: "method",
		start_line: 4,
		end_line: 4,
		startOffset: 30,
		endOffset: 42,
		fileHash: "file-hash",
		segmentHash: "segment-hash",
	}
	it("uses identical contextual inputs and IDs for scans and incremental updates", () => {
		const root = path.resolve("workspace")
		const absolute = { ...block, file_path: path.join(root, block.file_path) }
		expect(getEmbeddingText(block, root)).toBe("File: src/state.ts\nclass State\nisReady()\nreturn ready")
		expect(getEmbeddingText(absolute, root)).toBe(getEmbeddingText(block, root))
		expect(createIndexPoint(absolute, root, [1, 2])).toEqual(createIndexPoint(block, root, [1, 2]))
		expect(createIndexPoint({ ...block, startOffset: 50 }, root, [1, 2]).id).not.toBe(
			createIndexPoint(block, root, [1, 2]).id,
		)
	})
	it("changes index identity with the model even when dimensions match, but excludes credentials", () => {
		const config: CodeIndexConfig = {
			isConfigured: true,
			embedderProvider: "openai-compatible",
			modelId: "model-a",
			modelDimension: 3,
			openAiCompatibleOptions: { baseUrl: "https://example.com", apiKey: "first" },
		}
		expect(getIndexIdentity(config)).not.toBe(getIndexIdentity({ ...config, modelId: "model-b" }))
		expect(getIndexIdentity(config)).toBe(
			getIndexIdentity({
				...config,
				openAiCompatibleOptions: { ...config.openAiCompatibleOptions!, apiKey: "second" },
			}),
		)
	})
	it.each(
		[
			[[1, 2]],
			[[1, 2], [3]],
			[
				[1, 2],
				[NaN, 2],
			],
			[[], []],
		].map((embeddings) => ({ embeddings })),
	)("rejects incomplete or malformed provider batches", ({ embeddings }) => {
		expect(() => validateEmbeddingBatch(embeddings, 2)).toThrow()
	})
	it("keeps full identifiers and their components in lexical search", () => {
		expect(codeTerms("HTTPServer cancelDescendants task_id")).toEqual([
			"httpserver",
			"http",
			"server",
			"canceldescendants",
			"cancel",
			"descendants",
			"task_id",
			"task",
			"id",
		])
		const query = lexicalVector("cancelDescendants", true)
		const document = lexicalVector("function cancelDescendants() { stopChild() }")
		expect(query.indices.every((index) => document.indices.includes(index))).toBe(true)
		expect(query.values.every((value) => value === 1)).toBe(true)
		expect(document.indices).toEqual([...document.indices].sort((a, b) => a - b))
	})
})
