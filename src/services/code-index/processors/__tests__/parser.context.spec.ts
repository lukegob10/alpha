import { countCodeTokens, CONTEXT_TOKEN_BUDGET } from "../chunking"
import path from "path"
import { CodeParser } from "../parser"

vi.mock("../../../tree-sitter/languageParser", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../tree-sitter/languageParser")>()
	return {
		...original,
		loadRequiredLanguageParsers: (files: string[]) =>
			original.loadRequiredLanguageParsers(files, path.resolve(__dirname, "../../../../dist")),
	}
})

describe("code index source coverage and context", () => {
	it("indexes small declarations rather than dropping valid symbols", async () => {
		const content = "export function isReady() { return true }"
		const blocks = await new CodeParser().parseFile("src/state.ts", { content })
		expect(blocks.map((block) => block.content).join("\n")).toContain("isReady")
	})

	it("retains function identity in every fragment of a large function", async () => {
		const content =
			"export async function cancelDescendants(taskId: string) {\n" +
			Array.from(
				{ length: 80 },
				(_, index) =>
					`  await stopChildTask(taskId, ${index}, { propagateCancellation: true, waitForCleanup: true })`,
			).join("\n") +
			"\n}"
		const blocks = await new CodeParser().parseFile("src/lifecycle.ts", { content })
		expect(blocks.length).toBeGreaterThan(1)
		for (const block of blocks) {
			expect(block).toHaveProperty("context", expect.stringContaining("cancelDescendants"))
		}
		expect(blocks.length).toBeLessThan(20)
	})

	it("preserves imports, documentation, short declarations and closing source without overlapping chunks", async () => {
		const content = [
			'import { ready } from "./state"',
			"/** The public readiness check. */",
			"export function isReady() { return ready }",
			"export const version = 2",
		].join("\n")
		const blocks = await new CodeParser().parseFile("src/api.ts", { content })
		expect(blocks.map((block) => block.content).join("")).toBe(content)
	})

	it("keeps a parent class name with split methods", async () => {
		const content = `export class SessionRegistry {\n${Array.from(
			{ length: 60 },
			(_, index) => `  getSession${index}() { return this.lookup(${index}) }`,
		).join("\n")}\n}`
		const blocks = await new CodeParser().parseFile("src/sessions.ts", { content })
		for (const block of blocks) {
			expect(block).toHaveProperty("context", expect.stringContaining("SessionRegistry"))
		}
		expect(blocks.map((block) => block.content).join("")).toBe(content)
	})
	it("bounds non-ASCII scope context while retaining the function name", async () => {
		const content =
			"/** " +
			"说明".repeat(300) +
			" */\nexport function handleUnicode() {\n" +
			'  return "成功"\n'.repeat(200) +
			"}"
		const blocks = await new CodeParser().parseFile("src/unicode.ts", { content })
		for (const block of blocks.filter((block) => block.identifier === "handleUnicode")) {
			expect(block.context).toContain("handleUnicode")
			expect(await countCodeTokens(block.context ?? "")).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET)
		}
	})
})
