import fs from "fs/promises"
import mammoth from "mammoth"
// @ts-ignore-next-line
import pdf from "pdf-parse/lib/pdf-parse"
import { isBinaryFile } from "isbinaryfile"
import { extractTextFromXLSX } from "../extract-text-from-xlsx"
import { extractTextFromFileWithMetadata, extractTextFromFile } from "../extract-text"
import * as extractionModule from "../extract-text"
import { readWithSlice } from "../indentation-reader"
import { DEFAULT_LINE_LIMIT, MAX_LINE_LENGTH } from "../../../core/prompts/tools/native-tools/read_file"

vi.mock("fs/promises", () => ({ default: { access: vi.fn(), readFile: vi.fn() } }))
vi.mock("mammoth", () => ({ default: { extractRawText: vi.fn() } }))
vi.mock("pdf-parse/lib/pdf-parse", () => ({ default: vi.fn() }))
vi.mock("isbinaryfile", () => ({ isBinaryFile: vi.fn() }))
vi.mock("../extract-text-from-xlsx", () => ({ extractTextFromXLSX: vi.fn() }))

function rawDocumentSource(...args: Parameters<typeof extractionModule.extractTextFromFileRaw>) {
	expect(typeof extractionModule.extractTextFromFileRaw, "new raw extraction API is required for this case").toBe(
		"function",
	)
	return extractionModule.extractTextFromFileRaw(...args)
}

describe("bounded extracted document projection", () => {
	function parserOutput(extension: string, raw: string) {
		vi.mocked(fs.readFile).mockResolvedValue(
			extension === ".ipynb"
				? JSON.stringify({ cells: [{ cell_type: "markdown", source: raw.slice(0, -1).split("\n") }] })
				: Buffer.from("parser input bytes"),
		)
		vi.mocked(mammoth.extractRawText).mockResolvedValue({ value: raw, messages: [] })
		vi.mocked(pdf).mockResolvedValue({ text: raw })
		vi.mocked(extractTextFromXLSX).mockResolvedValue(raw)
	}
	function expectedProjection(raw: string, limit: number) {
		const expected = readWithSlice(raw, 0, limit)
		return {
			content: expected.content,
			totalLines: expected.totalLines,
			returnedLines: expected.returnedLines,
			wasTruncated: expected.wasTruncated,
			linesShown: expected.includedRanges[0],
			...(expected.firstClippedLine === undefined ? {} : { firstClippedLine: expected.firstClippedLine }),
			isExtractedDocument: true,
		}
	}
	beforeEach(() => {
		vi.resetAllMocks()
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(isBinaryFile).mockResolvedValue(false)
	})
	it.each([".pdf", ".docx", ".xlsx", ".ipynb"])("applies requested line and character limits to %s", async (ext) => {
		const raw = `1 | source text\n${"x".repeat(MAX_LINE_LENGTH + 1)}\nOMITTED_REQUIREMENT\n`
		parserOutput(ext, raw)
		const result = await extractTextFromFileWithMetadata(`fixture${ext}`, 2)
		expect(result).toEqual(expectedProjection(raw, 2))
		expect(result.content).not.toContain("OMITTED_REQUIREMENT")
		expect(result.content).toContain("1 | 1 | source text")
		expect(result).toMatchObject({ totalLines: 4, returnedLines: 2, firstClippedLine: 2, wasTruncated: true })
	})
	it.each([".pdf", ".docx", ".xlsx", ".ipynb"])(
		"caps the default %s excerpt without hiding the source",
		async (ext) => {
			const raw =
				Array.from({ length: DEFAULT_LINE_LIMIT + 3 }, (_, i) => `Requirement ${i + 1}`).join("\n") + "\n"
			parserOutput(ext, raw)
			const result = await extractTextFromFileWithMetadata(`fixture${ext}`)
			expect(result).toEqual(expectedProjection(raw, DEFAULT_LINE_LIMIT))
			expect(result.returnedLines).toBe(DEFAULT_LINE_LIMIT)
			expect(await rawDocumentSource(`fixture${ext}`)).toBe(raw)
			expect(await extractTextFromFile(`fixture${ext}`)).toBe(result.content)
		},
	)
	it.each([".pdf", ".docx", ".xlsx"])(
		"matches ordinary line positions for empty/trailing-line %s text",
		async (ext) => {
			for (const raw of ["", "alpha\n", "alpha\n\n", "alpha\r\nbeta\r\n"]) {
				parserOutput(ext, raw)
				expect(await extractTextFromFileWithMetadata(`fixture${ext}`, 2)).toEqual(expectedProjection(raw, 2))
			}
		},
	)
	it("retains notebook cell order and excludes outputs", async () => {
		vi.mocked(fs.readFile).mockResolvedValue(
			JSON.stringify({
				cells: [
					{ cell_type: "markdown", source: ["Requirement one", "Requirement two"] },
					{ cell_type: "raw", source: ["RAW_CELL_OMITTED"] },
					{ cell_type: "code", source: ["doWork()"], outputs: [{ text: "OUTPUT_OMITTED" }] },
				],
			}),
		)
		const raw = "Requirement one\nRequirement two\ndoWork()\n"
		expect(await rawDocumentSource("fixture.ipynb")).toBe(raw)
		expect(await extractTextFromFileWithMetadata("fixture.ipynb", 2)).toEqual(expectedProjection(raw, 2))
	})
	it("keeps ordinary text metadata and unsupported binary denial", async () => {
		vi.mocked(fs.readFile).mockResolvedValue("ordinary text")
		expect(await extractTextFromFileWithMetadata("fixture.txt", 2)).toEqual({
			content: "1 | ordinary text",
			totalLines: 1,
			returnedLines: 1,
			wasTruncated: false,
			linesShown: [1, 1],
		})
		vi.mocked(isBinaryFile).mockResolvedValue(true)
		await expect(extractTextFromFileWithMetadata("fixture.bin", 2)).rejects.toThrow("Cannot read text")
	})
	it("rejects pre-aborted document extraction before touching its parser or filesystem", async () => {
		const controller = new AbortController()
		const reason = new DOMException("Document read cancelled", "AbortError")
		controller.abort(reason)
		await expect(extractTextFromFileWithMetadata("fixture.docx", 2, controller.signal)).rejects.toBe(reason)
		expect(fs.access).not.toHaveBeenCalled()
		expect(mammoth.extractRawText).not.toHaveBeenCalled()
	})
	it.each(["fulfilled", "rejected"] as const)(
		"preserves cancellation over a late %s uninterruptible document parser",
		async (outcome) => {
			const controller = new AbortController()
			const reason = new DOMException("Document read cancelled", "AbortError")
			let started!: () => void
			const entered = new Promise<void>((resolve) => {
				started = resolve
			})
			let release!: () => void
			vi.mocked(mammoth.extractRawText).mockImplementation(
				() =>
					new Promise((resolve, reject) => {
						started()
						release = () =>
							outcome === "fulfilled"
								? resolve({ value: "late text", messages: [] })
								: reject(new Error("Late parser error"))
					}),
			)
			const pending = extractTextFromFileWithMetadata("fixture.docx", 2, controller.signal)
			const rejected = expect(pending).rejects.toBe(reason)
			await entered
			controller.abort(reason)
			release()
			await rejected
		},
	)
})
