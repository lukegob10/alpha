// npx vitest core/mentions/__tests__/index.spec.ts

import * as vscode from "vscode"
import fs from "fs/promises"
import * as path from "path"
import { isBinaryFile } from "isbinaryfile"

import { parseMentions } from "../index"
import { extractTextFromFileWithMetadata } from "../../../integrations/misc/extract-text"

// Mock vscode
vi.mock("vscode", () => ({
	window: {
		get activeTerminal() {
			return undefined
		},
		showErrorMessage: vi.fn(),
	},
	commands: { executeCommand: vi.fn() },
	env: { clipboard: { readText: vi.fn(), writeText: vi.fn() } },
}))

vi.mock("fs/promises", () => ({
	default: {
		realpath: vi.fn(),
		stat: vi.fn(),
		readdir: vi.fn(),
	},
}))

vi.mock("isbinaryfile", () => ({
	isBinaryFile: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFileWithMetadata: vi.fn(),
}))

// Mock i18n
vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

describe("parseMentions - URL mention handling", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should replace URL mentions with quoted URL reference", async () => {
		const result = await parseMentions("Check @https://example.com", "/test")

		// URL mentions are now replaced with a quoted reference (no fetching)
		expect(result.text).toContain("'https://example.com'")
	})
})

describe("parseMentions - terminal output", () => {
	const clipboardText = "  Sample text\nAnother line\n"

	beforeEach(() => {
		vi.mocked(vscode.commands.executeCommand).mockReset()
		vi.mocked(vscode.env.clipboard.readText).mockReset().mockResolvedValue(clipboardText)
		vi.mocked(vscode.env.clipboard.writeText).mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("keeps the clipboard untouched when there is no active terminal", async () => {
		const result = await parseMentions("Check @terminal", "/test")

		expect(result.text).toContain("<terminal_output>\n\n</terminal_output>")
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		expect(vscode.env.clipboard.readText).not.toHaveBeenCalled()
		expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled()
	})

	it("keeps an unchanged clipboard out of the attachment when terminal copy does nothing", async () => {
		vi.spyOn(vscode.window, "activeTerminal", "get").mockReturnValue({} as vscode.Terminal)

		const result = await parseMentions("Check @terminal", "/test")

		expect(result.text).toContain("<terminal_output>\n\n</terminal_output>")
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.terminal.clearSelection")
		expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled()
	})

	it("attaches copied terminal output and restores the original clipboard", async () => {
		vi.spyOn(vscode.window, "activeTerminal", "get").mockReturnValue({} as vscode.Terminal)
		vi.mocked(vscode.env.clipboard.readText)
			.mockResolvedValueOnce(clipboardText)
			.mockResolvedValueOnce("$ echo test\ntest\n$ ")

		const result = await parseMentions("Check @terminal", "/test")

		expect(result.text).toContain("<terminal_output>\n$ echo test\ntest\n</terminal_output>")
		expect(vscode.env.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(clipboardText)
	})

	it("clears the selection and restores the clipboard when copying fails", async () => {
		vi.spyOn(vscode.window, "activeTerminal", "get").mockReturnValue({} as vscode.Terminal)
		vi.mocked(vscode.commands.executeCommand)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("copy failed"))

		const result = await parseMentions("Check @terminal", "/test")

		expect(result.text).toContain("Error fetching terminal output: copy failed")
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.terminal.clearSelection")
		expect(vscode.env.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(clipboardText)
	})
})

describe("parseMentions - built-in Plan command", () => {
	it("switches mode and removes the command while preserving its inline prompt", async () => {
		const result = await parseMentions("<user_message>\n/plan inspect the provider flow\n</user_message>", "/test")

		expect(result.mode).toBe("architect")
		expect(result.text).toBe("<user_message>\ninspect the provider flow\n</user_message>")
		expect(result.slashCommandHelp).toBeUndefined()
	})

	it("does not claim similarly named workspace commands", async () => {
		const result = await parseMentions("<user_message>\n/planner inspect the flow\n</user_message>", "/test")

		expect(result.mode).toBeUndefined()
		expect(result.text).toContain("/planner")
	})
})

describe("parseMentions - workspace file boundary", () => {
	const cwd = path.resolve("C:/workspace")

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(fs.realpath).mockImplementation(async (value) => path.resolve(value.toString()))
		vi.mocked(fs.stat).mockResolvedValue({
			isFile: () => true,
			isDirectory: () => false,
		} as any)
		vi.mocked(isBinaryFile).mockResolvedValue(false)
		vi.mocked(extractTextFromFileWithMetadata).mockResolvedValue({
			content: "safe content",
			totalLines: 1,
			returnedLines: 1,
			wasTruncated: false,
		})
	})

	it("rejects lexical traversal before reading a file", async () => {
		const result = await parseMentions("Read @/../secret.txt", cwd)

		expect(extractTextFromFileWithMetadata).not.toHaveBeenCalled()
		expect(result.contentBlocks[0]?.content).toContain("outside the current workspace")
	})

	it("rejects an in-workspace symlink whose real target is outside", async () => {
		const linkedPath = path.resolve(cwd, "linked.txt")
		vi.mocked(fs.realpath).mockImplementation(async (value) => {
			const resolved = path.resolve(value.toString())
			return resolved === linkedPath ? path.resolve("C:/outside/secret.txt") : resolved
		})

		const result = await parseMentions("Read @/linked.txt", cwd)

		expect(extractTextFromFileWithMetadata).not.toHaveBeenCalled()
		expect(result.contentBlocks[0]?.content).toContain("outside the current workspace")
	})

	it("keeps inaccessible paths inside the established access-error wrapper", async () => {
		vi.mocked(fs.realpath).mockImplementation(async (value) => {
			const resolved = path.resolve(value.toString())
			if (resolved.endsWith(`${path.sep}missing.txt`)) {
				throw new Error("missing")
			}
			return resolved
		})

		const result = await parseMentions("Read @/missing.txt", cwd)

		expect(result.contentBlocks[0]?.content).toContain('Failed to access path "missing.txt": missing')
	})

	it("continues to read a file whose real path remains in the workspace", async () => {
		const result = await parseMentions("Read @/safe.txt", cwd)

		expect(extractTextFromFileWithMetadata).toHaveBeenCalledWith(path.resolve(cwd, "safe.txt"))
		expect(result.contentBlocks[0]?.content).toContain("safe content")
	})

	it("directs recovery back to the shortened line rather than skipping its omitted tail", async () => {
		vi.mocked(extractTextFromFileWithMetadata).mockResolvedValue({
			content: "1 | shortened...",
			totalLines: 1,
			returnedLines: 1,
			wasTruncated: true,
			linesShown: [1, 1],
			firstClippedLine: 1,
		})
		const result = await parseMentions("Read @/spec.txt", cwd)
		const block = result.contentBlocks[0]!
		expect(block.metadata).toMatchObject({ wasTruncated: true, firstClippedLine: 1 })
		expect(block.content).toContain("shortened line is 1")
		expect(block.content).toContain("exec_command")
		expect(block.content).toContain("offset=1")
		expect(block.content).toContain("Continuation")
		expect(block.content).not.toContain("offset=2")
	})

	it("keeps the ordinary omitted-line continuation after the shown range", async () => {
		vi.mocked(extractTextFromFileWithMetadata).mockResolvedValue({
			content: "1 | first\n2 | second",
			totalLines: 3,
			returnedLines: 2,
			wasTruncated: true,
			linesShown: [1, 2],
		})
		const result = await parseMentions("Read @/spec.txt", cwd)
		expect(result.contentBlocks[0]!.content).toContain("offset=3")
		expect(result.contentBlocks[0]!.content).not.toContain("shortened line")
	})
})
