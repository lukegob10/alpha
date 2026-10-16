/**
 * Tests for ReadFileTool - Codex-inspired file reading with indentation mode support.
 *
 * These tests cover:
 * - Input validation (missing path parameter)
 * - RooIgnore blocking
 * - Directory read error handling
 * - Binary file handling (images, PDF, DOCX, unsupported)
 * - Image memory limits
 * - Approval flow (approve, deny, feedback)
 * - Text file processing (slice and indentation modes)
 * - Output structure formatting
 */

import { isBinaryFile } from "isbinaryfile"

import { readFileTool } from "../ReadFileTool"
import type { AskApprovalResponse } from "../BaseTool"

import { isSupportedImageFormat } from "../helpers/imageHelpers"
import {
	extractTextFromFile,
	extractTextFromFileRaw,
	getSupportedBinaryFormats,
} from "../../../integrations/misc/extract-text"

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	stat: vi.fn(),
}))

vi.mock("isbinaryfile")

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFileRaw: vi.fn(),
	extractTextFromFile: vi.fn(),
	addLineNumbers: vi.fn().mockImplementation((text: string, startLine = 1) => {
		if (!text) return ""
		const lines = text.split("\n")
		return lines.map((line, i) => `${startLine + i} | ${line}`).join("\n")
	}),
	getSupportedBinaryFormats: vi.fn(() => [".pdf", ".docx", ".xlsx", ".ipynb"]),
}))

vi.mock("../../../integrations/misc/indentation-reader", async () => {
	const actual = await vi.importActual<typeof import("../../../integrations/misc/indentation-reader")>(
		"../../../integrations/misc/indentation-reader",
	)
	return {
		...actual,
		readWithIndentation: vi.fn(),
		readWithSlice: vi.fn(),
	}
})

vi.mock("../helpers/imageHelpers", () => ({
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB: 5,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB: 20,
	isSupportedImageFormat: vi.fn(),
	validateImageForProcessing: vi.fn(),
	processImageFile: vi.fn(),
	ImageMemoryTracker: vi.fn().mockImplementation(function () {
		return {
			getTotalMemoryUsed: vi.fn().mockReturnValue(0),
			addMemoryUsage: vi.fn(),
		}
	}),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolDenied: vi.fn(() => "The user denied this operation."),
		toolDeniedWithFeedback: vi.fn(
			(feedback?: string) =>
				`The user denied this operation and responded with the message:\n<user_message>\n${feedback}\n</user_message>`,
		),
		toolApprovedWithFeedback: vi.fn(
			(feedback?: string) =>
				`The user approved this operation and responded with the message:\n<user_message>\n${feedback}\n</user_message>`,
		),
		alphaIgnoreError: vi.fn(
			(filePath: string) =>
				`Access to ${filePath} is blocked by the .alphaignore file settings. You must try to continue in the task without using this file, or ask the user to update the .alphaignore file.`,
		),
		toolResult: vi.fn((text: string, images?: string[]) => {
			if (images && images.length > 0) {
				return [
					{ type: "text", text },
					...images.map((img) => {
						const [header, data] = img.split(",")
						const media_type = header.match(/:(.*?);/)?.[1] || "image/png"
						return { type: "image", source: { type: "base64", media_type, data } }
					}),
				]
			}
			return text
		}),
		imageBlocks: vi.fn((images?: string[]) => {
			return images
				? images.map((img) => {
						const [header, data] = img.split(",")
						const media_type = header.match(/:(.*?);/)?.[1] || "image/png"
						return { type: "image", source: { type: "base64", media_type, data } }
					})
				: []
		}),
	},
}))

// Mock fs/promises
const fsPromises = await import("fs/promises")
const mockedFsReadFile = vi.mocked(fsPromises.readFile)
const mockedFsStat = vi.mocked(fsPromises.stat)

const mockedIsBinaryFile = vi.mocked(isBinaryFile)
const mockedExtractTextFromFileRaw = vi.mocked(extractTextFromFileRaw)
const mockedLegacyExtraction = vi.mocked(extractTextFromFile)
const mockedIsSupportedImageFormat = vi.mocked(isSupportedImageFormat)

// ─── Test Helpers ─────────────────────────────────────────────────────────────

interface MockTaskOptions {
	supportsImages?: boolean
	alphaIgnoreAllowed?: boolean
	maxImageFileSize?: number
	maxTotalImageSize?: number
}

function createMockTask(options: MockTaskOptions = {}) {
	const { supportsImages = false, alphaIgnoreAllowed = true, maxImageFileSize = 5, maxTotalImageSize = 20 } = options

	return {
		cwd: "/test/workspace",
		api: {
			getModel: vi.fn().mockReturnValue({
				info: { supportsImages },
			}),
		},
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		didRejectTool: false,
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined }),
		say: vi.fn().mockResolvedValue(undefined),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing required parameter: path"),
		recordToolError: vi.fn(),
		alphaIgnoreController: {
			validateAccess: vi.fn().mockReturnValue(alphaIgnoreAllowed),
		},
		fileContextTracker: {
			trackFileContext: vi.fn().mockResolvedValue(undefined),
		},
		providerRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					maxImageFileSize,
					maxTotalImageSize,
				}),
			}),
		},
	}
}

function createMockCallbacks() {
	return {
		pushToolResult: vi.fn(),
		askApproval: vi.fn().mockResolvedValue(true),
		askApprovalResponse: vi.fn<AskApprovalResponse>().mockResolvedValue({ response: "yesButtonClicked" }),
		handleError: vi.fn(),
		setResultMetadata: vi.fn(),
		signal: undefined as AbortSignal | undefined,
	}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("document extraction and bounded read selections", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mockedFsStat.mockResolvedValue({ isDirectory: () => false } as Awaited<ReturnType<typeof fsPromises.stat>>)
		mockedIsBinaryFile.mockResolvedValue(true)
		mockedIsSupportedImageFormat.mockReturnValue(false)
		vi.mocked(getSupportedBinaryFormats).mockReturnValue([".pdf", ".docx", ".xlsx", ".ipynb"])
		useDocumentSource("")
	})
	// Match the captured legacy extractor: PDF/DOCX/IPYNB are fully numbered;
	// XLSX already returns unnumbered extracted text. The raw helper always returns source.
	const legacyProjection = (source: string, filename: string) => {
		if (filename.toLowerCase().endsWith(".xlsx") || source === "") return source
		const lines = source.split("\n")
		if (lines.at(-1) === "") lines.pop()
		const width = String(lines.length).length
		return lines.map((line, index) => `${String(index + 1).padStart(width, " ")} | ${line}`).join("\n") + "\n"
	}
	function useDocumentSource(source: string) {
		mockedExtractTextFromFileRaw.mockResolvedValue(source)
		mockedLegacyExtraction.mockImplementation(async (filename) => legacyProjection(source, filename))
	}
	const readResult = (callbacks: ReturnType<typeof createMockCallbacks>) => {
		const value = callbacks.pushToolResult.mock.calls.at(-1)?.[0]
		expect(typeof value).toBe("string")
		return value as string
	}
	const continuationFrom = (output: string) => {
		const encoded = output.match(/Continuation: (\{[^\n]+\})/)?.[1]
		expect(encoded).toBeDefined()
		return (JSON.parse(encoded!) as { continuation: string }).continuation
	}
	it.each([".pdf", ".docx", ".xlsx"])(
		"retains explicit late-offset pagination from full %s extraction",
		async (extension) => {
			useDocumentSource(Array.from({ length: 2_005 }, (_, i) => "Requirement " + (i + 1)).join("\n"))
			const callbacks = createMockCallbacks()
			await readFileTool.execute(
				{ path: "requirements" + extension, offset: 2_003, limit: 1 },
				createMockTask() as any,
				callbacks,
			)
			expect(readResult(callbacks)).toContain("2003 | Requirement 2003")
			expect(readResult(callbacks)).not.toContain("beyond file end")
			expect(mockedLegacyExtraction.mock.calls.length + mockedExtractTextFromFileRaw.mock.calls.length).toBe(1)
			expect(callbacks.handleError).not.toHaveBeenCalled()
		},
	)
	it("uses the new unnumbered helper at the document adapter boundary", async () => {
		useDocumentSource("first\nsecond")
		const callbacks = createMockCallbacks()
		await readFileTool.execute(
			{ path: "requirements.docx", offset: 2, limit: 1 },
			createMockTask() as any,
			callbacks,
		)
		expect(readResult(callbacks)).toContain("2 | second")
		expect(
			mockedExtractTextFromFileRaw,
			"new adapter contract; legacy pagination is tested separately",
		).toHaveBeenCalledOnce()
		expect(mockedLegacyExtraction).not.toHaveBeenCalled()
	})
	it("uses extracted notebook positions when sniffing detects ordinary JSON", async () => {
		mockedIsBinaryFile.mockResolvedValue(false)
		mockedFsReadFile.mockResolvedValue(
			Buffer.from(JSON.stringify({ cells: [{ cell_type: "markdown", source: ["first", "second"] }] })),
		)
		useDocumentSource("first\nsecond\n")
		const callbacks = createMockCallbacks()
		await readFileTool.execute(
			{ path: "requirements.ipynb", offset: 2, limit: 1 },
			createMockTask() as any,
			callbacks,
		)
		expect(readResult(callbacks)).toContain("2 | second")
		expect(readResult(callbacks)).not.toContain('"cells"')
		expect(mockedExtractTextFromFileRaw).toHaveBeenCalledOnce()
	})
	it("preserves authored text resembling a line-number prefix", async () => {
		useDocumentSource("1 | actual user text")
		const callbacks = createMockCallbacks()
		await readFileTool.execute({ path: "requirements.docx" }, createMockTask() as any, callbacks)
		expect(readResult(callbacks)).toContain("1 | 1 | actual user text")
	})
	it("retains the full extracted tail for bounded cursor recovery", async () => {
		useDocumentSource("BEGIN" + "x".repeat(40_000) + "FINAL_REQUIREMENT")
		const task = createMockTask()
		const first = createMockCallbacks()
		await readFileTool.execute({ path: "requirements.docx", limit: 1 }, task as any, first)
		const initial = readResult(first)
		expect(initial.length).toBeLessThanOrEqual(32_000)
		expect(initial).not.toContain("FINAL_REQUIREMENT")
		const second = createMockCallbacks()
		await readFileTool.execute(
			{ path: "requirements.docx", continuation: continuationFrom(initial) },
			task as any,
			second,
		)
		expect(readResult(second).length).toBeLessThanOrEqual(32_000)
		expect(readResult(second)).toContain("FINAL_REQUIREMENT")
	})
	it("preserves stale-source cursor rejection", async () => {
		useDocumentSource("x".repeat(40_000))
		const task = createMockTask()
		const first = createMockCallbacks()
		await readFileTool.execute({ path: "requirements.docx", limit: 1 }, task as any, first)
		const cursor = continuationFrom(readResult(first))
		useDocumentSource("y".repeat(40_000))
		const second = createMockCallbacks()
		await readFileTool.execute({ path: "requirements.docx", continuation: cursor }, task as any, second)
		expect(readResult(second)).toContain("File changed since the previous read")
		expect(second.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
	})
	it("retains approval denial before either extractor", async () => {
		const callbacks = createMockCallbacks()
		callbacks.askApprovalResponse.mockResolvedValue({ response: "noButtonClicked" })
		await readFileTool.execute({ path: "requirements.ipynb" }, createMockTask() as any, callbacks)
		expect(mockedExtractTextFromFileRaw).not.toHaveBeenCalled()
		expect(mockedLegacyExtraction).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "denied" })
	})
	it.each(["fulfilled", "rejected"] as const)(
		"suppresses late %s extraction after cancellation before tracking",
		async (outcome) => {
			const controller = new AbortController()
			const task = createMockTask()
			const callbacks = createMockCallbacks()
			callbacks.signal = controller.signal
			const complete = () => {
				controller.abort(new DOMException("Tool cancelled", "AbortError"))
				if (outcome === "rejected") throw new Error("Late parser failure")
				return "late extracted text"
			}
			mockedExtractTextFromFileRaw.mockImplementation(async (_filename, signal) => {
				expect(signal).toBe(controller.signal)
				return complete()
			})
			mockedLegacyExtraction.mockImplementation(async (filename) => legacyProjection(complete(), filename))
			await readFileTool.execute({ path: "requirements.docx" }, task as any, callbacks)
			expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "cancelled" })
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		},
	)
})
