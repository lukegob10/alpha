import * as fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as atomicWrite from "../../../core/task-persistence/atomicWrite"
import { tiktoken } from "../../../utils/tiktoken"
import {
	MemoryStore,
	isValidMemorySummary,
	limitMemoryTokens,
	redactMemoryText,
	truncateMemoryText,
	type MemoryStoreTransaction,
} from "../MemoryStore"

const editors = vi.hoisted(() => ({ documents: [] as unknown[] }))
const filesystem = vi.hoisted(() => ({ realpath: vi.fn() }))
vi.mock("fs/promises", async (original) => ({
	...(await original<typeof import("fs/promises")>()),
	realpath: filesystem.realpath,
}))
vi.mock("vscode", () => ({
	workspace: {
		get textDocuments() {
			return editors.documents
		},
	},
}))
const disk = await vi.importActual<typeof import("fs/promises")>("fs/promises")

const summary = (profile = "Works on Alpha.") =>
	`v1\n\n## User Profile\n${profile}\n\n## User preferences\nUse focused checks.\n\n## General Tips\nInspect current code.\n\n## What's in Memory\n- Alpha extension\n`

describe("MemoryStore", () => {
	let temporary: string
	let store: MemoryStore

	beforeEach(async () => {
		filesystem.realpath.mockImplementation(disk.realpath)
		editors.documents = []
		temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-memory-store-")))
		store = new MemoryStore({ home: path.join(temporary, ".alpha"), now: () => Date.UTC(2026, 9, 25, 12, 34, 56) })
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		await fs.rm(temporary, { recursive: true, force: true })
	})

	it("uses the Alpha host home and keeps disabled reads free of filesystem writes", async () => {
		vi.stubEnv("ALPHA_HOME", store.home)
		expect(MemoryStore.forDefaultHome().rootPath).toBe(path.join(store.home, "memories_v2"))
		expect(await store.readSummary()).toBeUndefined()
		expect(await store.listFiles()).toEqual([])
		await expect(fs.stat(store.home)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("validates and atomically replaces the v2 summary", async () => {
		await store.writeSummary(summary())
		expect(await store.readSummary()).toBe(summary())
		await store.writeSummary(summary("Updated profile."))
		expect(await store.readSummary()).toContain("Updated profile.")
		expect(await store.listFiles()).toEqual(["memory_summary.md"])
		await expect(store.writeSummary(summary().replace("## General Tips", "## Other"))).rejects.toThrow("format")
		await expect(store.writeSummary(summary().replace("v1", "v2"))).rejects.toThrow("format")
		expect(await store.readSummary()).toContain("Updated profile.")
	})

	it("keeps extraction cache private, rematerializes it, and removes it on reset", async () => {
		await store.withTransaction(async (transaction) => {
			await transaction.writeExtraction("task-1", "api_key=secret-value\nUseful evidence")
			const cached = await transaction.readExtraction("task-1")
			expect(cached).toContain("Useful evidence")
			expect(cached).not.toContain("secret-value")
			await transaction.writeRolloutSummary("task-1", "useful", cached!)
		})
		const file = "rollout_summaries/task-1_useful.md"
		await store.removeRolloutSummary(file)
		expect(await store.listFiles()).toEqual([])
		expect(await store.readExtraction("task-1")).toContain("Useful evidence")
		await store.reset()
		expect(await store.readExtraction("task-1")).toBeUndefined()
		await expect(fs.stat(path.join(store.home, ".memory-rollouts"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("enforces UTF-8 bytes and keeps injected memory within its token budget", async () => {
		const valid = summary("界".repeat(2_600))
		expect(isValidMemorySummary(valid)).toBe(true)
		await store.writeSummary(valid)
		const injected = (await store.readSummary())!
		expect(await tiktoken([{ type: "text", text: injected }])).toBeLessThanOrEqual(2_500)
		expect(injected).not.toContain("�")
		await expect(store.writeSummary(summary("界".repeat(3_400)))).rejects.toThrow("size")
		await expect(store.writeSummary(summary("\ud800"))).rejects.toThrow("format")
		expect(truncateMemoryText("a界b", 3)).toBe("a")
		expect(truncateMemoryText("a界b", 4)).toBe("a界")
	})

	it.each([
		["blank", ""],
		["malformed", "damaged"],
		["oversized", summary("x".repeat(10_000))],
	])("ignores %s optional summary when a task starts", async (_name, content) => {
		await store.initialize()
		await fs.writeFile(path.join(store.rootPath, "memory_summary.md"), content)
		expect(await store.readSummary()).toBeUndefined()
	})

	it("redacts generated artifacts and append-only notes before persisting them", async () => {
		const secret = "sk-proj-1234567890abcdefghij1234567890"
		const text = `api_key=hidden-value\n${secret}\n-----BEGIN PRIVATE KEY-----\nsecret-key\n-----END PRIVATE KEY-----`
		const relative = await store.writeRolloutSummary("task-123", "alpha-build", text)
		const first = await store.addAdHocNote(text)
		const second = await store.addAdHocNote("Another note")
		expect(first).toMatch(/^extensions\/ad_hoc\/notes\/2026-10-25T12-34-56-[a-f0-9-]+\.md$/)
		expect(first).not.toBe(second)
		const stored = await fs.readFile(path.join(store.rootPath, relative), "utf8")
		expect(stored).not.toContain(secret)
		expect(stored).not.toContain("hidden-value")
		expect(stored).not.toContain("secret-key")
		expect(stored).toContain("[redacted]")
		expect(redactMemoryText(stored)).toBe(stored)
		expect(await store.readFile(first)).toBe(stored)
		await store.writeSummary(summary(`password="private-value" ${secret}`))
		expect(await store.readSummary()).not.toContain("private-value")
		expect(redactMemoryText("https://user:secret@example.com/path")).toBe("https://[redacted]@example.com/path")
	})

	it("redacts signed URL grants before persistence and when reading manually edited files", async () => {
		const grant = "synthetic-sas-access-grant%2Bvalue%3D"
		const url = `https://example.blob.core.windows.net/private/file?sv=2025-01-05&sp=r&sig=${grant}&se=2026-12-01`
		const expected = url.replace(grant, "[redacted]")
		expect(redactMemoryText(url)).toBe(expected)
		expect(redactMemoryText(expected)).toBe(expected)
		const rollout = await store.writeRolloutSummary("thread-1", "signed-url", url)
		const note = await store.addAdHocNote(url)
		await store.writeSummary(summary(url))
		await store.withTransaction((transaction) => transaction.writeExtraction("thread-1", url))
		for (const file of [rollout, note, "memory_summary.md"]) {
			const persisted = await fs.readFile(path.join(store.rootPath, file), "utf8")
			expect(persisted).not.toContain(grant)
			expect(persisted).toContain(expected)
		}
		expect(await store.readExtraction("thread-1")).toBe(expected)
		await fs.writeFile(path.join(store.rootPath, "manual.md"), `Public line\n${url}`)
		expect(await store.readFile("manual.md", 2, 1)).toBe(expected)
		expect(await store.search("private/file")).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "manual.md", line: 2, text: expected })]),
		)
	})

	it.each(["sig", "signature", "X-Amz-Signature", "X-Goog-Signature"])(
		"redacts repeated %s grants without corrupting a Markdown pointer",
		(parameter) => {
			const pointer = `[report](https://example.com/file?${parameter}=synthetic-first&${parameter}=synthetic-second)`
			const expected = `[report](https://example.com/file?${parameter}=[redacted]&${parameter}=[redacted])`
			expect(redactMemoryText(pointer)).toBe(expected)
			expect(redactMemoryText(expected)).toBe(expected)
			expect(redactMemoryText("https://example.com/file?view=report#section")).toBe(
				"https://example.com/file?view=report#section",
			)
		},
	)

	it("bounds rollout bytes without splitting Unicode and rejects unsafe output filenames", async () => {
		const relative = await store.writeRolloutSummary("thread_1", "safe-slug", "界".repeat(4_000))
		const text = await fs.readFile(path.join(store.rootPath, relative), "utf8")
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(9_000)
		expect(text).not.toContain("�")
		await expect(store.writeRolloutSummary("../escape", "slug", "text")).rejects.toThrow("ID")
		await expect(store.writeRolloutSummary("id", "../escape", "text")).rejects.toThrow("slug")
		await expect(store.addAdHocNote("  ")).rejects.toThrow("empty")
	})

	it("provides bounded one-indexed line reads and literal case-insensitive search", async () => {
		const relative = await store.writeRolloutSummary("id", "line-test", "first\nAlpha [test]\nthird\nALPHA last")
		expect(await store.readFile(relative, 2, 2)).toBe("Alpha [test]\nthird")
		expect(await store.search("[test]")).toEqual([{ path: relative, line: 2, text: "Alpha [test]" }])
		expect(await store.search("alpha")).toHaveLength(2)
		await expect(store.readFile(relative, 0)).rejects.toThrow("positive")
		await expect(store.readFile(relative, 1, 0)).rejects.toThrow("positive")
		await expect(store.readFile(relative, 99)).rejects.toThrow("exceeds")
		await expect(store.search(" ")).rejects.toThrow("nonempty")
	})

	it("redacts a whole file before selecting lines inside a private credential", async () => {
		await store.initialize()
		await fs.writeFile(
			path.join(store.rootPath, "manual.md"),
			"-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----\nPublic evidence",
		)
		expect(await store.readFile("manual.md", 2, 1)).not.toContain("private-key-material")
		expect(await store.readFile("manual.md", 4, 1)).toBe("Public evidence")
	})

	it("redacts incomplete private keys and preserves redaction markers idempotently", () => {
		const text = "api_key=[redacted]\n[redacted private key]\n-----BEGIN PRIVATE KEY-----\nprivate-key-material"
		const redacted = redactMemoryText(text)
		expect(redacted).not.toContain("private-key-material")
		expect(redacted).toContain("api_key=[redacted]")
		expect(redactMemoryText(redacted)).toBe(redacted)
		expect(redactMemoryText('password="top secret value')).toBe("password=[redacted]")
		expect(redactMemoryText("api_key='top secret value")).toBe("api_key=[redacted]")
	})

	it("requests private permissions before atomic artifact creation", async () => {
		const write = vi.spyOn(atomicWrite, "atomicWriteText")
		await store.writeSummary(summary())
		expect(write).toHaveBeenCalledWith(path.join(store.rootPath, "memory_summary.md"), summary(), {
			requireAtomicReplace: true,
			mode: 0o600,
		})
	})

	it("reports line and token truncation accurately for memory tools", async () => {
		const relative = await store.writeRolloutSummary("id", "complete", "first\nsecond\nthird")
		expect(await store.readFileDetails(relative, 1, 3)).toEqual({
			content: "first\nsecond\nthird",
			totalLines: 3,
			truncated: false,
		})
		expect(await store.readFileDetails(relative, 2, 1)).toEqual({
			content: "second",
			totalLines: 3,
			truncated: true,
		})
		await fs.writeFile(path.join(store.rootPath, "manual.md"), "界 ".repeat(20_000))
		const bounded = await store.readFileDetails("manual.md")
		expect(bounded.totalLines).toBe(1)
		expect(bounded.truncated).toBe(true)
		expect(await tiktoken([{ type: "text", text: bounded.content }])).toBeLessThanOrEqual(20_000)
	})

	it("lists notes independently of the public root inventory and rejects scoped traversal", async () => {
		const note = await store.addAdHocNote("An explicit correction.")
		await store.writeRolloutSummary("id", "alpha", "A result.")
		expect(await store.listFiles(undefined, "extensions/ad_hoc/notes")).toEqual([note])
		await expect(store.listFiles(undefined, "../tasks")).rejects.toThrow("path")
	})

	it("honors cancelled reads and notes before touching the filesystem", async () => {
		const controller = new AbortController()
		controller.abort()
		for (const action of [
			() => store.listFiles(controller.signal),
			() => store.readFile("memory_summary.md", 1, 200, controller.signal),
			() => store.search("anything", controller.signal),
			() => store.addAdHocNote("A note", controller.signal),
		]) {
			await expect(action()).rejects.toMatchObject({ name: "AbortError" })
		}
		await expect(fs.stat(store.home)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("yields to cancellation while budgeting an unbroken manual memory line", async () => {
		const controller = new AbortController()
		const request = limitMemoryTokens("界".repeat(20_000), 20_000, controller.signal)
		setImmediate(() => controller.abort())
		await expect(request).rejects.toMatchObject({ name: "AbortError" })
	})

	it.each([
		"../outside.md",
		"/outside.md",
		"..\\outside.md",
		"C:\\outside.md",
		"folder/.hidden.md",
		".git/config.md",
		"file.md:stream",
		"file.txt",
	])("rejects memory path %s", async (relative) => {
		await expect(store.readFile(relative)).rejects.toThrow("path")
	})

	it("lists only visible Markdown and bounds search results", async () => {
		await store.initialize()
		await fs.mkdir(path.join(store.rootPath, ".hidden"))
		await fs.writeFile(path.join(store.rootPath, ".hidden", "private.md"), "needle")
		await fs.writeFile(path.join(store.rootPath, ".private.md"), "needle")
		await fs.writeFile(path.join(store.rootPath, "text.txt"), "needle")
		await fs.writeFile(path.join(store.rootPath, "visible.md"), "needle\n".repeat(250))
		expect(await store.listFiles()).toEqual(["visible.md"])
		expect(await store.search("needle")).toHaveLength(200)
	})

	it("rejects root and nested symbolic-link escapes without modifying their targets", async () => {
		const outside = path.join(temporary, "outside")
		await fs.mkdir(outside)
		await fs.writeFile(path.join(outside, "secret.md"), "keep me")
		await fs.mkdir(store.home)
		await fs.symlink(outside, store.rootPath, "junction")
		await expect(store.writeSummary(summary())).rejects.toThrow("symbolic")
		await expect(store.readFile("secret.md")).rejects.toThrow("symbolic")
		await expect(store.reset()).rejects.toThrow("symbolic")
		expect(await fs.readFile(path.join(outside, "secret.md"), "utf8")).toBe("keep me")
		await fs.rm(store.rootPath)
		await store.initialize()
		await fs.symlink(outside, path.join(store.rootPath, "nested"), "junction")
		await expect(store.readFile("nested/secret.md")).rejects.toThrow("symbolic")
		expect(await store.listFiles()).toEqual([])
	})

	it("shares one transaction across metadata and artifacts and invalidates its facade afterward", async () => {
		let held: MemoryStoreTransaction | undefined
		await store.withTransaction(async (transaction) => {
			held = transaction
			expect(await transaction.readState()).toBeUndefined()
			await transaction.writeState({ revision: 1 })
			await transaction.writeSummary(summary())
			await transaction.writeRolloutSummary("id", "slug", "A durable result")
			expect(await transaction.readState()).toEqual({ revision: 1 })
		})
		expect(await store.readSummary()).toBe(summary())
		expect(() => held!.readState()).toThrow("finished")
	})

	it("serializes cross-instance metadata updates", async () => {
		const other = new MemoryStore({ home: store.home })
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				(index % 2 ? store : other).withTransaction(async (transaction) => {
					const state = (await transaction.readState()) as { count: number } | undefined
					await transaction.writeState({ count: (state?.count ?? 0) + 1 })
				}),
			),
		)
		await store.withTransaction(async (transaction) => expect(await transaction.readState()).toEqual({ count: 8 }))
	})

	it("orders reset after an in-flight publication and preserves tasks and other Alpha files", async () => {
		const preserved = path.join(store.home, "tasks", "history.json")
		await fs.mkdir(path.dirname(preserved), { recursive: true })
		await fs.writeFile(preserved, "historical conversation")
		await fs.mkdir(path.join(store.home, "memories"))
		await fs.writeFile(path.join(store.home, "memories", "MEMORY.md"), "old memory")
		let release: () => void = () => undefined
		let started: () => void = () => undefined
		const barrier = new Promise<void>((resolve) => (release = resolve))
		const publicationStarted = new Promise<void>((resolve) => (started = resolve))
		const write = atomicWrite.atomicWriteText
		vi.spyOn(atomicWrite, "atomicWriteText").mockImplementation(async (file, text, options) => {
			if (file.endsWith("memory_summary.md")) {
				started()
				await barrier
			}
			return write(file, text, options)
		})
		const publication = store.withTransaction(async (transaction) => {
			await transaction.writeState({ epoch: 1 })
			await transaction.writeSummary(summary())
		})
		await publicationStarted
		const reset = new MemoryStore({ home: store.home }).reset()
		release()
		await publication
		await reset
		expect(await store.readSummary()).toBeUndefined()
		expect(await store.listFiles()).toEqual([])
		await expect(fs.stat(path.join(store.home, "memories"))).rejects.toMatchObject({ code: "ENOENT" })
		await expect(fs.stat(store.statePath)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await fs.readFile(preserved, "utf8")).toBe("historical conversation")
	})

	it("prunes only a direct rollout summary", async () => {
		await store.writeSummary(summary())
		const relative = await store.writeRolloutSummary("id", "slug", "Memory")
		await store.removeRolloutSummary(relative)
		expect(await store.listFiles()).toEqual(["memory_summary.md"])
		await expect(store.removeRolloutSummary("memory_summary.md")).rejects.toThrow("Only rollout")
	})

	it.each([
		["memories/MEMORY.md", "file"],
		["memories_v2/memory_summary.md", "file"],
		["memories_v2/rollout_summaries/thread.md", "file"],
		["memories_v2/extensions/ad_hoc/notes/correction.md", "untitled"],
		[".memory-state.json", "file"],
		[".memory-rollouts/extraction.md", "file"],
	])("refuses reset while %s has an unsaved buffer", async (relative, scheme) => {
		const file = path.join(store.home, relative)
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(file, "Preserve these learned bytes.")
		editors.documents = [{ uri: { fsPath: file, scheme }, isDirty: true, isClosed: false }]
		await expect(store.reset()).rejects.toThrow("Save or close unsaved memory documents")
		expect(await fs.readFile(file, "utf8")).toBe("Preserve these learned bytes.")
	})

	it("refuses reset for a dirty buffer opened through a canonical file alias", async () => {
		await store.writeSummary(summary())
		const alias = path.join(temporary, "memory-alias")
		await fs.symlink(store.rootPath, alias, "junction")
		editors.documents = [
			{ uri: { fsPath: path.join(alias, "memory_summary.md"), scheme: "file" }, isDirty: true, isClosed: false },
		]
		await expect(store.reset()).rejects.toThrow("Save or close unsaved memory documents")
		expect(await store.readSummary()).toBe(summary())
	})

	it("refuses reset when a new dirty alias appears during asynchronous document preparation", async () => {
		await store.writeSummary(summary())
		const unrelated = path.join(temporary, "unrelated.md")
		await fs.writeFile(unrelated, "Unrelated document.")
		const alias = path.join(temporary, "memory-alias")
		await fs.symlink(store.rootPath, alias, "junction")
		editors.documents = [{ uri: { fsPath: unrelated, scheme: "file" }, isDirty: false, isClosed: false }]
		let scanning!: () => void
		let release!: () => void
		const entered = new Promise<void>((resolve) => (scanning = resolve))
		const held = new Promise<void>((resolve) => (release = resolve))
		filesystem.realpath.mockImplementation(async (candidate: import("fs").PathLike) => {
			if (candidate === unrelated) {
				scanning()
				await held
			}
			return disk.realpath(candidate)
		})
		const reset = store.reset()
		await entered
		editors.documents = [
			...editors.documents,
			{ uri: { fsPath: path.join(alias, "memory_summary.md"), scheme: "file" }, isDirty: true, isClosed: false },
		]
		release()
		await expect(reset).rejects.toThrow("Save or close unsaved memory documents")
		expect(await store.readSummary()).toBe(summary())
	})
})
