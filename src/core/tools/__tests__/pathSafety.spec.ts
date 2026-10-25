import fs from "fs"
import os from "os"
import path from "path"

import { isPathWithinRoot, resolvePathWithExistingAncestor } from "../pathSafety"

describe("path safety", () => {
	let temporaryDirectory: string
	let root: string
	let outside: string

	beforeEach(() => {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-path-safety-"))
		root = path.join(temporaryDirectory, "workspace")
		outside = path.join(temporaryDirectory, "outside")
		fs.mkdirSync(root)
		fs.mkdirSync(outside)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		fs.rmSync(temporaryDirectory, { recursive: true, force: true })
	})

	const linkDirectory = (target: string, alias: string) =>
		fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir")

	it("rejects a dangling link to a missing directory outside the root", () => {
		const target = path.join(outside, "pending")
		const alias = path.join(root, "alias")
		linkDirectory(target, alias)

		expect(resolvePathWithExistingAncestor(path.join(alias, "new.txt"))).toBe(path.join(target, "new.txt"))
		expect(isPathWithinRoot(root, path.join(alias, "new.txt"))).toBe(false)
	})

	it("resolves a chain of dangling links before checking containment", () => {
		const target = path.join(outside, "pending")
		const first = path.join(root, "first")
		const second = path.join(root, "second")
		linkDirectory(second, first)
		linkDirectory(target, second)

		expect(resolvePathWithExistingAncestor(path.join(first, "new.txt"))).toBe(path.join(target, "new.txt"))
		expect(isPathWithinRoot(root, path.join(first, "new.txt"))).toBe(false)
	})

	it("allows missing ordinary descendants and dangling links with in-root targets", () => {
		const target = path.join(root, "..notes", "pending")
		const alias = path.join(root, "alias")
		linkDirectory(target, alias)

		expect(isPathWithinRoot(root, path.join(target, "new.txt"))).toBe(true)
		expect(resolvePathWithExistingAncestor(path.join(alias, "new.txt"))).toBe(path.join(target, "new.txt"))
		expect(isPathWithinRoot(root, path.join(alias, "new.txt"))).toBe(true)
	})

	it("preserves canonical containment for existing aliases and a linked workspace root", () => {
		const alias = path.join(root, "alias")
		const linkedRoot = path.join(temporaryDirectory, "linked-workspace")
		linkDirectory(outside, alias)
		linkDirectory(root, linkedRoot)

		expect(isPathWithinRoot(root, path.join(alias, "new.txt"))).toBe(false)
		expect(isPathWithinRoot(linkedRoot, path.join(linkedRoot, "new.txt"))).toBe(true)
		expect(isPathWithinRoot(root, path.join(outside, "new.txt"))).toBe(false)
	})

	it("rejects symbolic link cycles", () => {
		const first = path.join(root, "first")
		const second = path.join(root, "second")
		linkDirectory(second, first)
		linkDirectory(first, second)

		expect(isPathWithinRoot(root, first)).toBe(false)
		expect(isPathWithinRoot(root, path.join(first, "new.txt"))).toBe(false)
	})

	it("rejects canonicalization failures instead of accepting the lexical path", () => {
		vi.spyOn(fs, "realpathSync").mockImplementation(() => {
			throw Object.assign(new Error("access denied"), { code: "EACCES" })
		})

		expect(isPathWithinRoot(root, path.join(root, "new.txt"))).toBe(false)
	})

	it.runIf(process.platform === "win32")("retains case-insensitive Windows containment", () => {
		expect(isPathWithinRoot(root.toUpperCase(), path.join(root.toLowerCase(), "new.txt"))).toBe(true)
	})
})
