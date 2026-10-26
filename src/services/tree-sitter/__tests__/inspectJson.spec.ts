import { inspectTreeStructure, testParseSourceCodeDefinitions } from "./helpers"
import { javascriptQuery } from "../queries"
import sampleJsonContent from "./fixtures/sample-json"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { copyWasms } from "../../../../packages/build/src/esbuild"
import treeSitterGrammars from "../grammars.json"

describe("inspectJson", () => {
	const testOptions = {
		language: "javascript",
		wasmFile: "tree-sitter-javascript.wasm",
		queryString: javascriptQuery,
		extKey: "json",
	}

	it("copies the shared grammar inventory and inspects JSON with the real bundled parser", async () => {
		const temporaryParent = fs.realpathSync(os.tmpdir())
		const root = fs.realpathSync(fs.mkdtempSync(path.join(temporaryParent, "alpha-tree-sitter-inspect-json-")))
		const output = path.join(root, "dist")
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(root)
		try {
			copyWasms(path.resolve(__dirname, "../../.."), output, Object.values(treeSitterGrammars))
			expect(
				fs
					.readdirSync(output)
					.filter((name) => /^tree-sitter-.+\.wasm$/u.test(name))
					.sort(),
			).toEqual(Object.values(treeSitterGrammars).sort())
			expect(fs.existsSync(path.join(output, "tree-sitter-json.wasm"))).toBe(true)
			const structure = await inspectTreeStructure(sampleJsonContent, "json")
			expect(structure).toMatch(/^\(document \(object\b/u)
			expect(structure).toContain("(array")
			const valid = await inspectTreeStructure('{"values": [1, true, null]}', "json")
			expect(valid).toMatch(/^\(document \(object\b/u)
			expect(valid).toContain("(array (number) (true) (null))")
			expect(valid).not.toContain("(ERROR")
		} finally {
			cwd.mockRestore()
			expect(path.dirname(root)).toBe(temporaryParent)
			expect(path.basename(root)).toMatch(/^alpha-tree-sitter-inspect-json-/u)
			fs.rmSync(root, { recursive: true, force: true })
		}
	})

	it("should parse JSON definitions", async () => {
		await testParseSourceCodeDefinitions("test.json", sampleJsonContent, testOptions)
	})
})
