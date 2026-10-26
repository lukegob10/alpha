import * as fs from "fs"
import * as path from "path"
import treeSitterGrammars from "../services/tree-sitter/grammars.json"

describe("dist assets", () => {
	const distPath = path.join(__dirname, "../dist")

	describe("tiktoken", () => {
		it("should have tiktoken wasm file", () => {
			expect(fs.existsSync(path.join(distPath, "tiktoken_bg.wasm"))).toBe(true)
		})
	})

	describe("tree-sitter", () => {
		const treeSitterFiles = ["tree-sitter.wasm", ...Object.values(treeSitterGrammars)]

		test.each(treeSitterFiles)("should have %s file", (filename) => {
			expect(fs.existsSync(path.join(distPath, filename))).toBe(true)
		})
	})
})
