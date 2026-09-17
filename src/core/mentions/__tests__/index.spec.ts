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
		showErrorMessage: vi.fn(),
	},
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
})
