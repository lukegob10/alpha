import * as fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { fingerprintContent } from "../../../core/tools/contentVersion"
import { writeMemorySummaryInDocument, type MemorySummaryWriter } from "../MemorySummaryEditor"

const host = vi.hoisted(() => ({
	documents: [] as unknown[],
	open: vi.fn(),
	apply: vi.fn(),
	saveConflict: "askUser",
	realpath: vi.fn(),
}))

vi.mock("fs/promises", async (original) => ({
	...(await original<typeof import("fs/promises")>()),
	realpath: host.realpath,
}))

vi.mock("vscode", () => ({
	workspace: {
		get textDocuments() {
			return host.documents
		},
		openTextDocument: host.open,
		applyEdit: host.apply,
		getConfiguration: () => ({ get: () => host.saveConflict }),
	},
	Uri: { file: (file: string) => ({ fsPath: file, scheme: "file" }) },
	Range: class {},
	EndOfLine: { LF: 1, CRLF: 2 },
	WorkspaceEdit: class {
		text = ""
		replace(_uri: unknown, _range: unknown, text: string) {
			this.text = text
		}
	},
}))
const disk = await vi.importActual<typeof import("fs/promises")>("fs/promises")

describe("memory summary publication", () => {
	let temporary: string
	let file: string
	let text: string
	let version: number
	let dirty: boolean
	let eol: number
	let save: ReturnType<typeof vi.fn<() => Promise<boolean>>>
	let beforeSave: (() => Promise<void>) | undefined
	let options: Parameters<MemorySummaryWriter>[2]

	beforeEach(async () => {
		host.realpath.mockImplementation(disk.realpath)
		temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-memory-editor-")))
		file = path.join(temporary, "memory_summary.md")
		text = "Original summary."
		version = 1
		dirty = false
		eol = 1
		beforeSave = undefined
		host.documents = []
		host.saveConflict = "askUser"
		host.open.mockReset()
		host.apply.mockReset()
		await fs.writeFile(file, text)
		options = {
			expectedVersion: fingerprintContent(text),
			signal: new AbortController().signal,
			isCurrent: vi.fn(async () => true),
			assertPath: vi.fn(async () => undefined),
			readFile: async () => {
				try {
					const value = await fs.readFile(file, "utf8")
					return { text: value, version: fingerprintContent(value) }
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
					throw error
				}
			},
		}
		save = vi.fn<() => Promise<boolean>>()
		host.open.mockImplementation(async () => {
			const original = await fs.readFile(file, "utf8")
			text = original.replace(/^\uFEFF/, "")
			const bom = original.startsWith("\uFEFF") ? "\uFEFF" : ""
			save.mockImplementation(async () => {
				await beforeSave?.()
				// Model the host's modified-since protection, including changes after applyEdit.
				if ((await fs.readFile(file, "utf8")) !== original) return false
				await fs.writeFile(file, bom + text)
				dirty = false
				return true
			})
			return {
				uri: { fsPath: file, scheme: "file" },
				isClosed: false,
				get eol() {
					return eol
				},
				get isDirty() {
					return dirty
				},
				get version() {
					return version
				},
				getText: () => text,
				positionAt: (offset: number) => ({ line: 0, character: offset }),
				save,
			}
		})
		host.apply.mockImplementation(async (edit: { text: string }) => {
			text = edit.text.replace(/\r?\n/g, eol === 2 ? "\r\n" : "\n")
			version++
			dirty = true
			return true
		})
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(temporary, { recursive: true, force: true })
	})

	it("uses a versioned document edit and host save while retaining its BOM", async () => {
		await fs.writeFile(file, "\uFEFFOriginal summary.")
		options.expectedVersion = fingerprintContent("\uFEFFOriginal summary.")
		await expect(writeMemorySummaryInDocument(file, "Updated summary.", options)).resolves.toBe(true)
		expect(host.apply).toHaveBeenCalledOnce()
		expect(save).toHaveBeenCalledOnce()
		expect(await fs.readFile(file, "utf8")).toBe("\uFEFFUpdated summary.")
	})

	it("preserves the document's CRLF line endings", async () => {
		eol = 2
		await fs.writeFile(file, "Original\r\nsummary.\r\n")
		options.expectedVersion = fingerprintContent("Original\r\nsummary.\r\n")
		await expect(writeMemorySummaryInDocument(file, "Updated\nsummary.\n", options)).resolves.toBe(true)
		expect(await fs.readFile(file, "utf8")).toBe("Updated\r\nsummary.\r\n")
	})

	it("honors a document-version rejection at the host edit boundary", async () => {
		host.apply.mockImplementation(async () => {
			text = "Human edit while application was pending."
			version++
			dirty = true
			return false
		})
		await expect(writeMemorySummaryInDocument(file, "Stale summary.", options)).resolves.toBe(false)
		expect(text).toBe("Human edit while application was pending.")
		expect(save).not.toHaveBeenCalled()
		expect(await fs.readFile(file, "utf8")).toBe("Original summary.")
	})

	it("rejects unsaved edits and leaves their text intact", async () => {
		options.isCurrent = vi.fn(async () => {
			if (host.open.mock.calls.length) {
				text = "Unsaved human correction."
				version++
				dirty = true
			}
			return true
		})
		await expect(writeMemorySummaryInDocument(file, "Stale summary.", options)).resolves.toBe(false)
		expect(text).toBe("Unsaved human correction.")
		expect(await fs.readFile(file, "utf8")).toBe("Original summary.")
		expect(host.apply).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
	})

	it("rejects a dirty alias of the summary before opening or editing it", async () => {
		host.documents = [{ uri: { fsPath: file, scheme: "file" }, isDirty: true, isClosed: false }]
		await expect(writeMemorySummaryInDocument(file, "Stale summary.", options)).rejects.toThrow("changed")
		expect(host.open).not.toHaveBeenCalled()
		expect(host.apply).not.toHaveBeenCalled()
	})

	it("preserves a disk edit made during final source validation", async () => {
		options.isCurrent = vi.fn(async () => {
			if (host.open.mock.calls.length) await fs.writeFile(file, "Human correction.")
			return true
		})
		await expect(writeMemorySummaryInDocument(file, "Stale summary.", options)).resolves.toBe(false)
		expect(await fs.readFile(file, "utf8")).toBe("Human correction.")
		expect(host.apply).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
	})

	it("lets the host reject a disk edit arriving after the final explicit check", async () => {
		beforeSave = async () => {
			await fs.writeFile(file, "Human edit during save.")
		}
		await expect(writeMemorySummaryInDocument(file, "Stale summary.", options)).resolves.toBe(false)
		expect(save).toHaveBeenCalledOnce()
		expect(await fs.readFile(file, "utf8")).toBe("Human edit during save.")
	})

	it.each(["cancelled", "stale"])("stops %s publication after editor preparation", async (reason) => {
		const controller = new AbortController()
		options.signal = controller.signal
		options.isCurrent = vi.fn(async () => {
			if (!host.open.mock.calls.length) return true
			if (reason === "cancelled") controller.abort()
			return false
		})
		const publication = writeMemorySummaryInDocument(file, "Discarded summary.", options)
		if (reason === "cancelled") await expect(publication).rejects.toMatchObject({ name: "AbortError" })
		else await expect(publication).resolves.toBe(false)
		expect(host.apply).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(await fs.readFile(file, "utf8")).toBe("Original summary.")
	})

	it.each(["cancelled", "stale"])("joins the admitted save after publication becomes %s", async (reason) => {
		const controller = new AbortController()
		options.signal = controller.signal
		let current = true
		options.isCurrent = vi.fn(async () => current)
		beforeSave = async () => {
			if (reason === "cancelled") controller.abort()
			current = false
		}
		await expect(writeMemorySummaryInDocument(file, "Admitted summary.", options)).resolves.toBe(true)

		expect(text).toBe("Admitted summary.")
		expect(dirty).toBe(false)
		expect(save).toHaveBeenCalledOnce()
		expect(await fs.readFile(file, "utf8")).toBe("Admitted summary.")
	})

	it("rechecks cancellation after asynchronous preparation and before dispatch", async () => {
		const controller = new AbortController()
		options.signal = controller.signal
		const read = options.readFile
		let reads = 0
		options.readFile = async () => {
			const value = await read()
			if (++reads === 2) controller.abort()
			return value
		}
		await expect(writeMemorySummaryInDocument(file, "Discarded summary.", options)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(host.apply).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(await fs.readFile(file, "utf8")).toBe("Original summary.")
	})

	it("restores only its exactly-owned buffer after a failed save", async () => {
		const open = host.open.getMockImplementation()!
		host.open.mockImplementation(async () => {
			const document = await open()
			let attempts = 0
			const saveNormally = save.getMockImplementation()!
			save.mockImplementation(async () => (++attempts === 1 ? false : saveNormally()))
			return document
		})
		await expect(writeMemorySummaryInDocument(file, "Failed generated summary.", options)).resolves.toBe(false)
		expect(text).toBe("Original summary.")
		expect(dirty).toBe(false)
		expect(await fs.readFile(file, "utf8")).toBe("Original summary.")
	})

	it("does not roll back a human amendment after a failed save", async () => {
		const open = host.open.getMockImplementation()!
		host.open.mockImplementation(async () => {
			const document = await open()
			save.mockImplementation(async () => {
				text = "Human amendment while save was pending."
				version++
				dirty = true
				return false
			})
			return document
		})
		await expect(writeMemorySummaryInDocument(file, "Failed generated summary.", options)).resolves.toBe(false)
		expect(text).toBe("Human amendment while save was pending.")
		expect(dirty).toBe(true)
		expect(host.apply).toHaveBeenCalledOnce()
		expect(await fs.readFile(file, "utf8")).toBe("Original summary.")
	})

	it("requires the editor's save-conflict protection", async () => {
		host.saveConflict = "overwriteFileOnDisk"
		await expect(writeMemorySummaryInDocument(file, "Stale summary.", options)).rejects.toThrow("save-conflict")
		expect(host.apply).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
	})

	it("atomically creates a complete private summary without opening an editor", async () => {
		await fs.rm(file)
		options.expectedVersion = undefined
		await expect(writeMemorySummaryInDocument(file, "First summary.", options)).resolves.toBe(true)
		expect(await fs.readFile(file, "utf8")).toBe("First summary.")
		if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
		expect(host.open).not.toHaveBeenCalled()
		expect(await fs.readdir(temporary)).toEqual(["memory_summary.md"])
	})

	it("preserves another creator that wins before the exclusive first publication", async () => {
		await fs.rm(file)
		options.expectedVersion = undefined
		let checks = 0
		options.isCurrent = vi.fn(async () => {
			if (++checks === 2) await fs.writeFile(file, "Human-created summary.")
			return true
		})
		await expect(writeMemorySummaryInDocument(file, "Stale first summary.", options)).resolves.toBe(false)
		expect(await fs.readFile(file, "utf8")).toBe("Human-created summary.")
		expect(await fs.readdir(temporary)).toEqual(["memory_summary.md"])
	})

	it("does not create over an unsaved document associated with an absent summary", async () => {
		await fs.rm(file)
		options.expectedVersion = undefined
		host.documents = [{ uri: { fsPath: file, scheme: "untitled" }, isDirty: true, isClosed: false }]
		await expect(writeMemorySummaryInDocument(file, "Stale first summary.", options)).rejects.toThrow("changed")
		await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" })
		expect(host.open).not.toHaveBeenCalled()
		expect(await fs.readdir(temporary)).toEqual([])
	})

	it("rejects a clean alias that becomes dirty while another document is being resolved", async () => {
		const aliasDirectory = path.join(temporary, "alias")
		const sourceDirectory = path.join(temporary, "source")
		await fs.mkdir(sourceDirectory)
		const source = path.join(sourceDirectory, "memory_summary.md")
		await fs.rename(file, source)
		file = source
		await fs.symlink(sourceDirectory, aliasDirectory, "junction")
		const unrelated = path.join(temporary, "unrelated.md")
		await fs.writeFile(unrelated, "Unrelated document.")
		let aliasDirty = false
		host.documents = [
			{
				uri: { fsPath: path.join(aliasDirectory, "memory_summary.md"), scheme: "file" },
				isClosed: false,
				get isDirty() {
					return aliasDirty
				},
			},
			{ uri: { fsPath: unrelated, scheme: "file" }, isDirty: true, isClosed: false },
		]
		let scanning!: () => void
		let release!: () => void
		const entered = new Promise<void>((resolve) => (scanning = resolve))
		const held = new Promise<void>((resolve) => (release = resolve))
		host.realpath.mockImplementation(async (candidate: import("fs").PathLike) => {
			if (candidate === unrelated) {
				scanning()
				await held
			}
			return disk.realpath(candidate)
		})
		const publication = writeMemorySummaryInDocument(file, "Stale generated summary.", options)
		await entered
		aliasDirty = true
		release()
		await expect(publication).rejects.toThrow("changed")
		expect(host.apply).not.toHaveBeenCalled()
		expect(save).not.toHaveBeenCalled()
		expect(await fs.readFile(file, "utf8")).toBe("Original summary.")
	})
})
