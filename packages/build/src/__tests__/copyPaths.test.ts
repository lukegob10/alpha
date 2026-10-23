import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { copyPaths } from "../esbuild.js"

describe("copy destination containment", () => {
	let root: string
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-copy-paths-"))
		fs.writeFileSync(path.join(root, "source.txt"), "fixture")
	})
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
	it("copies names containing shell metacharacters as file paths", () => {
		fs.mkdirSync(path.join(root, "build"))
		copyPaths([["source.txt", "build/a & %name% 雪.txt"]], root, root)
		expect(fs.readFileSync(path.join(root, "build/a & %name% 雪.txt"), "utf8")).toBe("fixture")
	})
	it.each(["..", "../outside", "."])("rejects destination %s before filesystem mutation", (destination) => {
		expect(() => copyPaths([["source.txt", destination, { optional: true }]], root, root)).toThrow("output directory")
	})
	it("rejects output directory aliases that would escape through a symlink", () => {
		const external = path.join(root, "external")
		const output = path.join(root, "output")
		fs.mkdirSync(external)
		fs.mkdirSync(output)
		fs.symlinkSync(external, path.join(output, "alias"), process.platform === "win32" ? "junction" : "dir")
		expect(() => copyPaths([["source.txt", "alias/file.txt"]], root, output)).toThrow("symbolic links")
		expect(fs.existsSync(path.join(external, "file.txt"))).toBe(false)
	})

	it("skips an absent optional source without replacing an existing destination", () => {
		const destination = path.join(root, "existing.txt")
		fs.writeFileSync(destination, "keep existing output")
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			copyPaths([["absent.txt", "existing.txt", { optional: true }]], root, root)
			expect(fs.readFileSync(destination, "utf8")).toBe("keep existing output")
			expect(warning).toHaveBeenCalledExactlyOnceWith("[copyPaths] Optional file not found: absent.txt")
		} finally {
			warning.mockRestore()
		}
	})

	it("propagates copy failures even when the source is optional", () => {
		expect(() => copyPaths([["source.txt", "absent/file.txt", { optional: true }]], root, root)).toThrow()
		expect(fs.existsSync(path.join(root, "absent", "file.txt"))).toBe(false)
	})
})
