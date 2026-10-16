import * as path from "path"
import fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"
import { parseMentions } from "../index"
import { extractTextFromFileWithMetadata } from "../../../integrations/misc/extract-text"

vi.mock("vscode", () => ({ window: { showErrorMessage: vi.fn() } }))
vi.mock("fs/promises", () => ({ default: { realpath: vi.fn(), stat: vi.fn(), readdir: vi.fn() } }))
vi.mock("isbinaryfile", () => ({ isBinaryFile: vi.fn() }))
vi.mock("../../../integrations/misc/extract-text", () => ({ extractTextFromFileWithMetadata: vi.fn() }))
vi.mock("../../../i18n", () => ({ t: vi.fn((key: string) => key) }))

describe("extracted-document mention provenance and recovery", () => {
	const cwd = path.resolve("C:/workspace")
	beforeEach(() => {
		vi.resetAllMocks()
		vi.mocked(fs.realpath).mockImplementation(async (value) => path.resolve(value.toString()))
		vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false } as Awaited<
			ReturnType<typeof fs.stat>
		>)
		vi.mocked(isBinaryFile).mockResolvedValue(false)
		vi.mocked(extractTextFromFileWithMetadata).mockResolvedValue({
			content: "1 | first\n2 | second",
			totalLines: 4,
			returnedLines: 2,
			wasTruncated: true,
			linesShown: [1, 2],
			isExtractedDocument: true,
		})
	})
	it("labels notebook line positions as extracted text and avoids raw shell-line instructions", async () => {
		const result = await parseMentions("Read @/requirements.ipynb", cwd)
		const block = result.contentBlocks[0]!
		expect(extractTextFromFileWithMetadata).toHaveBeenCalledWith(path.resolve(cwd, "requirements.ipynb"))
		expect(block.content).toContain("File content truncated")
		expect(block.content).toContain("extracted document text")
		expect(block.content).toContain("offset=3")
		expect(block.content).toContain("If read_file is offered")
		expect(block.content).toContain("available approved document-extraction tool")
		expect(block.content).not.toContain("Use the available exec_command tool")
	})
	it("returns to a shortened extracted line before advancing the document", async () => {
		vi.mocked(extractTextFromFileWithMetadata).mockResolvedValue({
			content: "1 | shortened...",
			totalLines: 4,
			returnedLines: 1,
			wasTruncated: true,
			linesShown: [1, 1],
			firstClippedLine: 1,
			isExtractedDocument: true,
		})
		const result = await parseMentions("Read @/requirements.ipynb", cwd)
		expect(result.contentBlocks[0]!.content).toContain("offset=1")
		expect(result.contentBlocks[0]!.content).not.toContain("offset=2")
		expect(result.contentBlocks[0]!.content).toContain("Continuation")
	})
	it("continues to omit a file detected as binary before the extractor", async () => {
		vi.mocked(isBinaryFile).mockResolvedValue(true)
		const result = await parseMentions("Read @/requirements.docx", cwd)
		expect(extractTextFromFileWithMetadata).not.toHaveBeenCalled()
		expect(result.contentBlocks[0]!.content).toContain("Binary file omitted from context")
	})
	it("preserves workspace traversal and ignore boundaries", async () => {
		const traversal = await parseMentions("Read @/../requirements.ipynb", cwd)
		expect(traversal.contentBlocks[0]!.content).toContain("outside the current workspace")
		const ignored = await parseMentions("Read @/requirements.ipynb", cwd, undefined, {
			validateAccess: () => false,
		} as unknown as Parameters<typeof parseMentions>[3])
		expect(ignored.contentBlocks[0]!.content).toContain("ignored by .alphaignore")
		expect(extractTextFromFileWithMetadata).not.toHaveBeenCalled()
	})
	it("keeps extracted-text recovery metadata for a notebook reached through a folder", async () => {
		vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false, isDirectory: () => true } as Awaited<
			ReturnType<typeof fs.stat>
		>)
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: "requirements.ipynb", isFile: () => true, isDirectory: () => false },
		] as unknown as Awaited<ReturnType<typeof fs.readdir>>)
		const result = await parseMentions("Read @/specs/", cwd)
		expect(result.contentBlocks[0]!.content).toContain("extracted document text")
		expect(result.contentBlocks[0]!.content).toContain("offset=3")
		expect(result.contentBlocks[0]!.content).not.toContain("Use the available exec_command tool")
	})
	it("forwards cancellation and rejects late extracted metadata without tracking it", async () => {
		const controller = new AbortController()
		const reason = new DOMException("Mention cancelled", "AbortError")
		const tracker = { trackFileContext: vi.fn(async () => undefined) }
		vi.mocked(extractTextFromFileWithMetadata).mockImplementation(async () => {
			controller.abort(reason)
			return { content: "late text", totalLines: 1, returnedLines: 1, wasTruncated: false }
		})
		await expect(
			parseMentions(
				"Read @/requirements.ipynb",
				cwd,
				tracker as unknown as Parameters<typeof parseMentions>[2],
				undefined,
				false,
				true,
				50,
				undefined,
				"code",
				undefined,
				controller.signal,
			),
		).rejects.toBe(reason)
		expect(extractTextFromFileWithMetadata).toHaveBeenCalledWith(
			path.resolve(cwd, "requirements.ipynb"),
			2_000,
			controller.signal,
		)
		expect(tracker.trackFileContext).not.toHaveBeenCalled()
	})
})
