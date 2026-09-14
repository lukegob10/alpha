import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { resolveDocumentPath, resolveSourcePath } from "../paths"

describe("HTML document path boundary", () => {
	let temporary: string
	let root: string
	let sibling: string
	const uri = (file: string) => pathToFileURL(file).toString()

	beforeEach(async () => {
		temporary = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-html-paths-"))
		root = path.join(temporary, "workspace")
		sibling = path.join(temporary, "workspace-other")
		await Promise.all([fs.mkdir(root), fs.mkdir(sibling)])
		await Promise.all([
			fs.writeFile(path.join(root, "report.html"), "<!doctype html>"),
			fs.writeFile(path.join(sibling, "review.htm"), "<!doctype html>"),
		])
	})

	afterEach(async () => {
		await fs.rm(temporary, { recursive: true, force: true })
	})

	it("returns canonical durable identity and chooses the appropriate workspace", async () => {
		const result = await resolveDocumentPath(uri(path.join(sibling, "review.htm")), [root, sibling])
		expect(result).toEqual({
			uri: uri(await fs.realpath(path.join(sibling, "review.htm"))),
			fsPath: await fs.realpath(path.join(sibling, "review.htm")),
			root: await fs.realpath(sibling),
		})
		await expect(resolveDocumentPath(uri(path.join(sibling, "review.htm")), [root])).rejects.toThrow("scope")
	})

	it("ignores unavailable roots and selects the deepest workspace independently of order", async () => {
		const nested = path.join(root, "nested")
		await fs.mkdir(nested)
		await fs.writeFile(path.join(nested, "report.html"), "document")
		const documentUri = uri(path.join(nested, "report.html"))
		const result = await resolveDocumentPath(documentUri, [path.join(temporary, "deleted"), root, nested])
		expect(result.root).toBe(await fs.realpath(nested))
		expect(await resolveDocumentPath(documentUri, [nested, root])).toEqual(result)
	})

	it.each([
		"https://example.com/report.html",
		"file://localhost/report.html",
		"file://server/share/report.html",
		"file:///tmp/report.html?",
		"file:///tmp/report.html#",
		"file:///tmp/%2e%2e/report.html",
		"file:///tmp/%5creport.html",
		"file:///tmp/%00report.html",
		"file:///tmp/%ZZreport.html",
		"file:///tmp/report.txt",
	])("rejects malformed or unsupported URI %s", async (value) => {
		await expect(resolveDocumentPath(value, [root])).rejects.toThrow("path")
	})

	it("keeps missing document identity stable through deletion and correction", async () => {
		const file = path.join(root, "new", "report.html")
		await expect(resolveDocumentPath(uri(file), [root])).rejects.toThrow("missing")
		const missing = await resolveDocumentPath(uri(file), [root], true)
		await fs.mkdir(path.dirname(file))
		await fs.writeFile(file, "corrected")
		expect(await resolveDocumentPath(uri(file), [root])).toEqual(missing)
		await fs.unlink(file)
		expect(await resolveDocumentPath(uri(file), [root], true)).toEqual(missing)
	})

	it("requires a file for documents and source references", async () => {
		await fs.mkdir(path.join(root, "directory.html"))
		await expect(resolveDocumentPath(uri(path.join(root, "directory.html")), [root])).rejects.toThrow("path")
		await expect(resolveSourcePath(root, "directory.html")).rejects.toThrow("path")
		await expect(resolveSourcePath(root, "missing.ts")).rejects.toThrow("missing")
		expect(await resolveSourcePath(root, "report.html")).toBe(await fs.realpath(path.join(root, "report.html")))
	})

	it.each([
		"../secret.ts",
		"a/../secret.ts",
		"/secret.ts",
		"C:/secret.ts",
		"C:secret.ts",
		"\\\\server\\share",
		"a\\b.ts",
		"a//b",
		"./a",
		"a\u0000",
		"x".repeat(2049),
	])("rejects invalid source reference %s", async (relative) => {
		await expect(resolveSourcePath(root, relative)).rejects.toThrow("path")
	})

	it("rejects existing and missing files through a directory symlink escaping the root", async (context) => {
		const link = path.join(root, "escape")
		try {
			await fs.symlink(sibling, link, process.platform === "win32" ? "junction" : "dir")
		} catch (error) {
			if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				context.skip()
				return
			}
			throw error
		}
		await expect(resolveDocumentPath(uri(path.join(link, "review.htm")), [root])).rejects.toThrow("scope")
		await expect(resolveDocumentPath(uri(path.join(link, "missing.html")), [root], true)).rejects.toThrow("scope")
		await expect(resolveSourcePath(root, "escape/review.htm")).rejects.toThrow("scope")
	})

	it("supports a symlinked workspace root and reopening its canonical identity", async (context) => {
		const alias = path.join(temporary, "alias")
		try {
			await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir")
		} catch (error) {
			if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				context.skip()
				return
			}
			throw error
		}
		const result = await resolveDocumentPath(uri(path.join(alias, "report.html")), [alias])
		expect(await resolveDocumentPath(result.uri, [alias])).toEqual(result)
	})

	it("rejects a missing document beneath a dangling symlink", async (context) => {
		const link = path.join(root, "dangling")
		try {
			await fs.symlink(path.join(sibling, "nonexistent"), link, process.platform === "win32" ? "junction" : "dir")
		} catch (error) {
			if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				context.skip()
				return
			}
			throw error
		}
		await expect(resolveDocumentPath(uri(path.join(link, "missing.html")), [root], true)).rejects.toThrow("scope")
	})

	it.skipIf(process.platform !== "win32")(
		"compares Windows drive and directory casing without a prefix shortcut",
		async () => {
			expect((await resolveDocumentPath(uri(path.join(root.toUpperCase(), "report.html")), [root])).root).toBe(
				await fs.realpath(root),
			)
		},
	)
})
