import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { copyWasms } from "../esbuild.js"

describe("runtime WASM inventory", () => {
	let root: string
	let output: string
	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-copy-wasms-")))
		output = path.join(root, "dist")
		for (const relative of [
			"tiktoken/lite/tiktoken_bg.wasm",
			"@imagemagick/magick-wasm/dist/x86/magick.wasm",
			"@imagemagick/magick-wasm/LICENSE",
			"@imagemagick/magick-wasm/NOTICE",
			"web-tree-sitter/tree-sitter.wasm",
			"tree-sitter-wasms/out/tree-sitter-typescript.wasm",
			"tree-sitter-wasms/out/tree-sitter-c.wasm",
			"tree-sitter-wasms/out/tree-sitter-objc.wasm",
			"esbuild-wasm/bin/esbuild",
			"esbuild-wasm/esbuild.wasm",
			"esbuild-wasm/wasm_exec_node.js",
			"esbuild-wasm/wasm_exec.js",
		]) {
			const destination = path.join(root, "node_modules", relative)
			fs.mkdirSync(path.dirname(destination), { recursive: true })
			fs.writeFileSync(destination, relative)
		}
	})
	afterEach(() => {
		expect(path.dirname(root)).toBe(fs.realpathSync(os.tmpdir()))
		expect(path.basename(root)).toMatch(/^alpha-copy-wasms-/u)
		fs.rmSync(root, { recursive: true, force: true })
	})

	it("copies selected grammars without shipping unused vendor languages", () => {
		const grammars = ["tree-sitter-typescript.wasm", "tree-sitter-c.wasm"]
		copyWasms(root, output, grammars)
		expect(
			fs
				.readdirSync(output)
				.filter((name) => /^tree-sitter-.+\.wasm$/u.test(name))
				.sort(),
		).toEqual([...grammars].sort())
		for (const grammar of grammars) {
			expect(fs.readFileSync(path.join(output, grammar), "utf8")).toBe(`tree-sitter-wasms/out/${grammar}`)
		}
		expect(fs.existsSync(path.join(output, "tree-sitter.wasm"))).toBe(true)
	})

	it("fails the build when a selected grammar is missing", () => {
		expect(() => copyWasms(root, output, ["tree-sitter-missing.wasm"])).toThrow("tree-sitter-missing.wasm")
	})

	it("rejects grammar paths outside the vendor inventory", () => {
		expect(() => copyWasms(root, output, ["../outside.wasm"])).toThrow("Invalid tree-sitter grammar filename")
	})
})
