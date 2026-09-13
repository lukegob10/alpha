import { readFile } from "fs/promises"
import { CodeParser, codeParser } from "../parser"
import { loadRequiredLanguageParsers } from "../../../tree-sitter/languageParser"
import { CHUNK_TOKEN_BUDGET, CHUNK_CHARACTER_LIMIT, countCodeTokens } from "../chunking"

vi.mock("fs/promises", () => ({ readFile: vi.fn() }))
vi.mock("../../../tree-sitter/languageParser", () => ({ loadRequiredLanguageParsers: vi.fn() }))

describe("CodeParser observable contract", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(readFile).mockResolvedValue("export const ready = true")
		vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({})
	})

	it("exports a reusable parser", () => expect(codeParser).toBeInstanceOf(CodeParser))
	it("does not read unsupported files", async () => {
		expect(await new CodeParser().parseFile("file.unknown")).toEqual([])
		expect(readFile).not.toHaveBeenCalled()
	})
	it("uses supplied source and hash", async () => {
		const blocks = await new CodeParser().parseFile("file.js", { content: "const x = 1", fileHash: "snapshot" })
		expect(readFile).not.toHaveBeenCalled()
		expect(blocks[0]).toMatchObject({ content: "const x = 1", fileHash: "snapshot", start_line: 1, end_line: 1 })
	})
	it("reads source when no snapshot is supplied", async () => {
		expect((await new CodeParser().parseFile("file.js"))[0].content).toBe("export const ready = true")
		expect(readFile).toHaveBeenCalledWith("file.js", "utf8")
	})
	it("propagates read failures so a failed file cannot be marked indexed", async () => {
		vi.mocked(readFile).mockRejectedValue(new Error("File not found"))
		await expect(new CodeParser().parseFile("file.js")).rejects.toThrow("File not found")
	})
	it("retains readable source when grammar loading fails", async () => {
		vi.mocked(loadRequiredLanguageParsers).mockRejectedValue(new Error("missing grammar"))
		expect((await new CodeParser().parseFile("file.js"))[0].content).toBe("export const ready = true")
	})
	it("shares a pending grammar load across concurrent parses", async () => {
		let resolve!: (value: Awaited<ReturnType<typeof loadRequiredLanguageParsers>>) => void
		vi.mocked(loadRequiredLanguageParsers).mockReturnValue(
			new Promise((done) => {
				resolve = done
			}),
		)
		const parser = new CodeParser()
		const first = parser.parseFile("a.js", { content: "const a = 1" })
		const second = parser.parseFile("b.js", { content: "const b = 2" })
		expect(loadRequiredLanguageParsers).toHaveBeenCalledTimes(1)
		resolve({})
		expect((await Promise.all([first, second])).flat()).toHaveLength(2)
	})
	it.each([".js", ".TS", ".vb", ".scala", ".swift", ".md"])("keeps short declarations in %s", async (extension) => {
		const blocks = await new CodeParser().parseFile("file" + extension, { content: "ready = true" })
		expect(blocks.map((block) => block.content).join("")).toBe("ready = true")
	})
	it.each(["", " \n\t"])("omits empty source", async (content) => {
		expect(await new CodeParser().parseFile("file.js", { content })).toEqual([])
	})
	it("uses stable content-sensitive hashes and exact offsets", async () => {
		const parser = new CodeParser()
		const first = await parser.parseFile("file.js", { content: "const x = 1\n" })
		const same = await parser.parseFile("file.js", { content: "const x = 1\n" })
		const changed = await parser.parseFile("file.js", { content: "const x = 2\n" })
		expect(first).toEqual(same)
		expect(first[0].fileHash).not.toBe(changed[0].fileHash)
		expect(first[0].segmentHash).not.toBe(changed[0].segmentHash)
		expect(first[0]).toMatchObject({ startOffset: 0, endOffset: 12 })
	})
	it.each(["😀".repeat(5000), "数据\r\n".repeat(900), "x = 1\n".repeat(1500)])(
		"bounds large source without loss",
		async (content) => {
			const blocks = await new CodeParser().parseFile("file.md", { content })
			expect(blocks.map((block) => block.content).join("")).toBe(content)
			expect(new Set(blocks.map((block) => block.segmentHash)).size).toBe(blocks.length)
			for (const block of blocks) {
				expect(block.content.length).toBeLessThanOrEqual(CHUNK_CHARACTER_LIMIT)
				expect(await countCodeTokens(block.content)).toBeLessThanOrEqual(CHUNK_TOKEN_BUDGET)
				expect(content.slice(block.startOffset, block.endOffset)).toBe(block.content)
				expect(Buffer.from(block.content, "utf8").toString("utf8")).toBe(block.content)
			}
		},
	)
	it("keeps nested markdown context, preamble and trailing text", async () => {
		const content = "Intro\n# Parent\n## Child\n" + "details here\n".repeat(500) + "tail"
		const blocks = await new CodeParser().parseFile("guide.md", { content })
		expect(blocks.map((block) => block.content).join("")).toBe(content)
		expect(blocks.at(-1)?.context).toContain("# Parent")
		expect(blocks.at(-1)?.context).toContain("## Child")
	})
	it("does not treat headings inside code fences as section context", async () => {
		const content = "# Real\n~~~md\n# Example\n~~~\n" + "details\n".repeat(300)
		const blocks = await new CodeParser().parseFile("guide.md", { content })
		expect(blocks.at(-1)?.context).toBe("Real\n# Real")
	})
	it("stops token-aware chunking when cancelled", async () => {
		const controller = new AbortController()
		const parsing = new CodeParser().parseFile("large.md", {
			content: "source content\n".repeat(10000),
			signal: controller.signal,
		})
		controller.abort()
		await expect(parsing).rejects.toHaveProperty("name", "AbortError")
	})
	it("does not close a longer code fence with a shorter or different marker", async () => {
		const content = "# Real\n~~~~\n~~~\n# Example\n~~~~\n" + "details\n".repeat(300)
		expect((await new CodeParser().parseFile("guide.md", { content })).at(-1)?.context).toBe("Real\n# Real")
	})
})
