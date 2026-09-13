import path from "path"
import { CodeParser } from "../parser"
import { getEmbeddingText } from "../../shared/embedding-input"
import { countCodeTokens } from "../chunking"
import type { CodeBlock, ICodeParser } from "../../interfaces"

vi.mock("../../../tree-sitter/languageParser", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../tree-sitter/languageParser")>()
	return {
		...original,
		loadRequiredLanguageParsers: (files: string[]) =>
			original.loadRequiredLanguageParsers(files, path.resolve(__dirname, "../../../../dist")),
	}
})

const workload = [
	{ file: "small.ts", content: "export function isReady() { return true }" },
	{
		file: "lifecycle.ts",
		content:
			"export async function cancelDescendants(taskId: string) {\n" +
			Array.from(
				{ length: 80 },
				(_, index) =>
					`  await stopChildTask(taskId, ${index}, { propagateCancellation: true, waitForCleanup: true })`,
			).join("\n") +
			"\n}",
	},
	{
		file: "registry.ts",
		content:
			"export class SessionRegistry {\n" +
			Array.from({ length: 60 }, (_, index) => `  getSession${index}() { return this.lookup(${index}) }`).join(
				"\n",
			) +
			"\n}",
	},
	{
		file: "api.ts",
		content:
			'import { ready } from "./state"\n/** Public readiness check. */\nexport function isReady() { return ready }\nexport const version = 2\n',
	},
	{
		file: "guide.md",
		content:
			"# Cancellation\n## Child tasks\n" +
			"A parent cancellation waits for child cleanup before completing.\n".repeat(160),
	},
]

/** Exact character coverage, accounting for overlapping or repeated snippets in the old parser. */
function coverage(source: string, blocks: CodeBlock[]): number {
	const covered = new Uint8Array(source.length)
	for (const block of blocks) {
		const startOfLine =
			source
				.split("\n")
				.slice(0, block.start_line - 1)
				.join("\n").length + (block.start_line > 1 ? 1 : 0)
		const index = source.indexOf(block.content, startOfLine)
		if (index >= 0) covered.fill(1, index, index + block.content.length)
	}
	return covered.reduce((sum, value) => sum + value, 0)
}

it("records repeatable chunk coverage, embedding input size and warm parsing time", async () => {
	// A temporary module extracted from the recorded baseline commit enables the same workload before/after.
	const baseline = process.env.ALPHA_INDEX_PARSER
	const Parser: new () => ICodeParser = baseline ? (await import(baseline)).CodeParser : CodeParser
	const parser = new Parser()
	const parse = () => Promise.all(workload.map((item) => parser.parseFile(item.file, { content: item.content })))
	await parse()
	const timings: number[] = []
	let blocks: CodeBlock[][] = []
	for (let run = 0; run < 5; run++) {
		const start = performance.now()
		blocks = await parse()
		timings.push(performance.now() - start)
	}
	let embeddingTokens = 0
	for (const block of blocks.flat())
		embeddingTokens += await countCodeTokens(baseline ? block.content : getEmbeddingText(block, process.cwd()))
	const sourceCharacters = workload.reduce((sum, item) => sum + item.content.length, 0)
	const coveredCharacters = workload.reduce((sum, item, index) => sum + coverage(item.content, blocks[index]), 0)
	const functionContext = blocks[1].filter((block) =>
		(baseline ? block.content : getEmbeddingText(block, process.cwd())).includes("cancelDescendants"),
	).length
	console.info(
		"CODE_INDEX_BENCHMARK",
		JSON.stringify({
			variant: baseline ? "baseline" : "current",
			files: workload.length,
			sourceCharacters,
			coveredCharacters,
			chunks: blocks.flat().length,
			smallFunctionChunks: blocks[0].length,
			longFunctionChunks: blocks[1].length,
			longFunctionChunksWithIdentity: functionContext,
			embeddingTokens,
			warmParseMs: timings.map((value) => Number(value.toFixed(2))),
		}),
	)
	if (!baseline) {
		expect(coveredCharacters).toBe(sourceCharacters)
		expect(blocks[0]).toHaveLength(1)
		expect(blocks[1].length).toBeLessThan(20)
		expect(functionContext).toBe(blocks[1].length)
		for (const [index, item] of workload.entries())
			expect(blocks[index].map((block) => block.content).join("")).toBe(item.content)
	}
})
