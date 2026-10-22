import fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"

vi.mock("fs/promises", () => ({ default: { access: vi.fn(), readFile: vi.fn() } }))
vi.mock("isbinaryfile", () => ({ isBinaryFile: vi.fn() }))

describe("document parser initialization", () => {
	let loaded: string[]
	let extraction: typeof import("../extract-text")
	const parsePDF = vi.fn()
	const parseDOCX = vi.fn()
	const parseXLSX = vi.fn()

	beforeEach(async () => {
		vi.resetModules()
		vi.resetAllMocks()
		loaded = []
		vi.doMock("pdf-parse/lib/pdf-parse", () => {
			loaded.push("pdf")
			return { default: parsePDF }
		})
		vi.doMock("mammoth", () => {
			loaded.push("docx")
			return { default: { extractRawText: parseDOCX } }
		})
		vi.doMock("../extract-text-from-xlsx", () => {
			loaded.push("xlsx")
			return { extractTextFromXLSX: parseXLSX }
		})
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue("ordinary text")
		vi.mocked(isBinaryFile).mockResolvedValue(false)
		parsePDF.mockResolvedValue({ text: "PDF text" })
		parseDOCX.mockResolvedValue({ value: "DOCX text", messages: [] })
		parseXLSX.mockResolvedValue("XLSX text")
		extraction = await import("../extract-text")
	})

	afterEach(() => {
		vi.doUnmock("pdf-parse/lib/pdf-parse")
		vi.doUnmock("mammoth")
		vi.doUnmock("../extract-text-from-xlsx")
	})

	it("keeps module imports, text helpers, and the format catalog free of document parsers", () => {
		expect(extraction.getSupportedBinaryFormats()).toEqual([".pdf", ".docx", ".ipynb", ".xlsx"])
		expect(extraction.addLineNumbers("hello")).toBe("1 | hello\n")
		expect(extraction.truncateOutput("hello", 1)).toBe("hello")
		expect(loaded).toEqual([])
	})

	it("reads ordinary text without initializing document parsers", async () => {
		await expect(extraction.extractTextFromFileRaw("fixture.txt")).resolves.toBe("ordinary text")
		expect(loaded).toEqual([])
	})

	it("reads notebook cells without initializing document parsers", async () => {
		vi.mocked(fs.readFile).mockResolvedValue(
			JSON.stringify({ cells: [{ cell_type: "code", source: ["print('hello')"] }] }),
		)
		await expect(extraction.extractTextFromFileRaw("fixture.ipynb")).resolves.toBe("print('hello')\n")
		expect(loaded).toEqual([])
	})

	it.each(["pdf", "docx", "xlsx"])("initializes only the requested %s parser", async (format) => {
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("document bytes"))
		await expect(extraction.extractTextFromFileRaw(`fixture.${format}`)).resolves.toBe(
			`${format.toUpperCase()} text`,
		)
		expect(loaded).toEqual([format])
	})

	it.each(["pdf", "docx", "xlsx"])("preserves %s parser failures after lazy initialization", async (format) => {
		const failure = new Error("Document parser failed")
		parsePDF.mockRejectedValue(failure)
		parseDOCX.mockRejectedValue(failure)
		parseXLSX.mockRejectedValue(failure)
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("document bytes"))
		await expect(extraction.extractTextFromFileRaw(`fixture.${format}`)).rejects.toBe(failure)
		expect(loaded).toEqual([format])
	})

	it.each(["pdf", "docx", "xlsx"])("rejects pre-aborted %s reads before loading a parser", async (format) => {
		const controller = new AbortController()
		const reason = new Error("Document read cancelled")
		controller.abort(reason)
		await expect(extraction.extractTextFromFileRaw(`fixture.${format}`, controller.signal)).rejects.toBe(reason)
		expect(loaded).toEqual([])
		expect(fs.access).not.toHaveBeenCalled()
	})

	it.each([
		["pdf", "pdf-parse/lib/pdf-parse"],
		["docx", "mammoth"],
		["xlsx", "../extract-text-from-xlsx"],
	])("does not start %s parsing after cancellation during module loading", async (format, moduleName) => {
		const controller = new AbortController()
		const reason = new Error("Cancelled while loading document parser")
		let started!: () => void
		const entered = new Promise<void>((resolve) => {
			started = resolve
		})
		let release!: () => void
		const ready = new Promise<void>((resolve) => {
			release = resolve
		})
		vi.doMock(moduleName, async () => {
			started()
			await ready
			return {
				default: format === "pdf" ? parsePDF : { extractRawText: parseDOCX },
				extractTextFromXLSX: parseXLSX,
			}
		})
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("document bytes"))
		const pending = extraction.extractTextFromFileRaw(`fixture.${format}`, controller.signal)
		const cancelled = expect(pending).rejects.toBe(reason)
		await entered
		controller.abort(reason)
		release()
		await cancelled
		expect(parsePDF).not.toHaveBeenCalled()
		expect(parseDOCX).not.toHaveBeenCalled()
		expect(parseXLSX).not.toHaveBeenCalled()
	})
})
