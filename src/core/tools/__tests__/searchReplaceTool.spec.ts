import * as path from "path"
import fs from "fs/promises"

import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import { getReadablePath } from "../../../utils/path"
import { ToolUse, ToolResponse } from "../../../shared/tools"
import { searchReplaceTool } from "../SearchReplaceTool"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue(""),
	},
}))

vi.mock("path", async () => {
	const originalPath = await vi.importActual("path")
	return {
		...originalPath,
		resolve: vi.fn().mockImplementation((...args) => {
			const separator = process.platform === "win32" ? "\\" : "/"
			return args.join(separator)
		}),
		isAbsolute: vi.fn().mockReturnValue(false),
		relative: vi.fn().mockImplementation((from, to) => to),
	}
})

vi.mock("delay", () => ({
	default: vi.fn(),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg) => `Error: ${msg}`),
		alphaIgnoreError: vi.fn((path) => `Access denied: ${path}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn().mockReturnValue("test/path.txt"),
}))

vi.mock("../../diff/stats", () => ({
	sanitizeUnifiedDiff: vi.fn((diff) => diff),
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
}))

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn().mockResolvedValue(undefined),
	},
	env: {
		openExternal: vi.fn(),
	},
	Uri: {
		parse: vi.fn(),
	},
}))

describe("searchReplaceTool", () => {
	// Test data
	const testFilePath = "test/file.txt"
	const absoluteFilePath = process.platform === "win32" ? "C:\\test\\file.txt" : "/test/file.txt"
	const testFileContent = "Line 1\nLine 2\nLine 3\nLine 4"
	const testOldString = "Line 2"
	const testNewString = "Modified Line 2"

	// Mocked functions
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockedFsReadFile = fs.readFile as unknown as MockedFunction<
		(path: string, encoding: string) => Promise<string>
	>
	const mockedGetReadablePath = getReadablePath as MockedFunction<typeof getReadablePath>
	const mockedPathResolve = path.resolve as MockedFunction<typeof path.resolve>
	const mockedPathIsAbsolute = path.isAbsolute as MockedFunction<typeof path.isAbsolute>

	const mockAlphaTask: any = {}
	let mockAskApproval: import("vitest").Mock
	let mockHandleError: import("vitest").Mock
	let mockPushToolResult: import("vitest").Mock
	let toolResult: ToolResponse | undefined

	beforeEach(() => {
		vi.clearAllMocks()

		mockedPathResolve.mockReturnValue(absoluteFilePath)
		mockedPathIsAbsolute.mockReturnValue(false)
		mockedFileExistsAtPath.mockResolvedValue(true)
		mockedFsReadFile.mockResolvedValue(testFileContent)
		mockedGetReadablePath.mockReturnValue("test/path.txt")

		mockAlphaTask.cwd = "/"
		mockAlphaTask.consecutiveMistakeCount = 0
		mockAlphaTask.didEditFile = false
		mockAlphaTask.providerRef = {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					experiments: {},
				}),
			}),
		}
		mockAlphaTask.alphaIgnoreController = {
			validateAccess: vi.fn().mockReturnValue(true),
		}
		mockAlphaTask.alphaProtectedController = {
			isWriteProtected: vi.fn().mockReturnValue(false),
		}
		mockAlphaTask.diffViewProvider = {
			editType: undefined,
			isEditing: false,
			originalContent: "",
			open: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			reset: vi.fn().mockResolvedValue(undefined),
			revertChanges: vi.fn().mockResolvedValue(undefined),
			saveChanges: vi.fn().mockResolvedValue({
				newProblemsMessage: "",
				userEdits: null,
				finalContent: "final content",
			}),
			saveDirectly: vi.fn().mockResolvedValue(undefined),
			scrollToFirstDiff: vi.fn(),
			pushToolWriteResult: vi.fn().mockResolvedValue("Tool result message"),
		}
		mockAlphaTask.fileContextTracker = {
			trackFileContext: vi.fn().mockResolvedValue(undefined),
		}
		mockAlphaTask.say = vi.fn().mockResolvedValue(undefined)
		mockAlphaTask.ask = vi.fn().mockResolvedValue(undefined)
		mockAlphaTask.recordToolError = vi.fn()
		mockAlphaTask.recordToolUsage = vi.fn()
		mockAlphaTask.processQueuedMessages = vi.fn()
		mockAlphaTask.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing param error")

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)

		toolResult = undefined
	})

	/**
	 * Helper function to execute the search replace tool with different parameters
	 */
	async function executeSearchReplaceTool(
		params: Partial<ToolUse["params"]> = {},
		options: {
			fileExists?: boolean
			fileContent?: string
			isPartial?: boolean
			accessAllowed?: boolean
		} = {},
	): Promise<ToolResponse | undefined> {
		const fileExists = options.fileExists ?? true
		const fileContent = options.fileContent ?? testFileContent
		const isPartial = options.isPartial ?? false
		const accessAllowed = options.accessAllowed ?? true

		mockedFileExistsAtPath.mockResolvedValue(fileExists)
		mockedFsReadFile.mockResolvedValue(fileContent)
		mockAlphaTask.alphaIgnoreController.validateAccess.mockReturnValue(accessAllowed)

		const nativeArgs: Record<string, unknown> = {
			file_path: testFilePath,
			old_string: testOldString,
			new_string: testNewString,
		}
		for (const [key, value] of Object.entries(params)) {
			nativeArgs[key] = value
		}

		const toolUse: ToolUse = {
			type: "tool_use",
			name: "search_replace",
			params: {
				file_path: testFilePath,
				old_string: testOldString,
				new_string: testNewString,
				...params,
			},
			nativeArgs: nativeArgs as any,
			partial: isPartial,
		}

		mockPushToolResult = vi.fn((result: ToolResponse) => {
			toolResult = result
		})

		await searchReplaceTool.handle(mockAlphaTask, toolUse as ToolUse<"search_replace">, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		return toolResult
	}

	it.each(["\n", "\r\n"])("preserves BOM and %j endings while replacing literal dollar text", async (eol) => {
		const replacement = "$& $$ $' &amp;\nchanged"
		const originalContent = `\uFEFFLine 1${eol}Line 2${eol}Line 3`
		await executeSearchReplaceTool(
			{ old_string: "Line 1\nLine 2", new_string: replacement },
			{ fileContent: originalContent },
		)
		expect(mockAlphaTask.diffViewProvider.saveDirectly).toHaveBeenCalledWith(
			testFilePath,
			`\uFEFF$& $$ $' &amp;${eol}changed${eol}Line 3`,
			false,
			true,
			1000,
			{ exists: true, content: originalContent },
		)
	})

	it("rejects mixed endings without requesting approval or saving", async () => {
		await executeSearchReplaceTool({}, { fileContent: "Line 1\r\nLine 2\nLine 3" })
		expect(mockHandleError).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ message: expect.stringMatching(/mixed line endings/i) }),
		)
		expect(mockAskApproval).not.toHaveBeenCalled()
		expect(mockAlphaTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		expect(mockAlphaTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
	})

	describe("parameter validation", () => {
		it("returns error when file_path is missing", async () => {
			const result = await executeSearchReplaceTool({ file_path: undefined })

			expect(result).toBe("Missing param error")
			expect(mockAlphaTask.consecutiveMistakeCount).toBe(1)
			expect(mockAlphaTask.recordToolError).toHaveBeenCalledWith("search_replace")
		})

		it("returns error when old_string is missing", async () => {
			const result = await executeSearchReplaceTool({ old_string: undefined })

			expect(result).toBe("Missing param error")
			expect(mockAlphaTask.consecutiveMistakeCount).toBe(1)
		})

		it("allows empty new_string for deletion", async () => {
			// Empty new_string is valid - it means delete the old_string
			await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			// Should proceed to approval (not error out)
			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("returns error when old_string equals new_string", async () => {
			const result = await executeSearchReplaceTool({
				old_string: "same",
				new_string: "same",
			})

			expect(result).toContain("Error:")
			expect(mockAlphaTask.consecutiveMistakeCount).toBe(1)
		})
	})

	describe("file access", () => {
		it("returns error when file does not exist", async () => {
			const result = await executeSearchReplaceTool({}, { fileExists: false })

			expect(result).toContain("Error:")
			expect(result).toContain("File not found")
			expect(mockAlphaTask.consecutiveMistakeCount).toBe(1)
		})

		it("returns error when access is denied", async () => {
			const result = await executeSearchReplaceTool({}, { accessAllowed: false })

			expect(result).toContain("Access denied")
		})
	})

	describe("search and replace logic", () => {
		describe.each([false, true])(
			"literal replacements with legacy background preference %s",
			(legacyPreference) => {
				it.each(["$&", "$$", "$`", "$'", "$1", "$<name>"])(
					"preserves %s in replacement text",
					async (token) => {
						mockAlphaTask.providerRef.deref().getState.mockResolvedValue({
							diagnosticsEnabled: true,
							writeDelayMs: 1000,
							experiments: { preventFocusDisruption: legacyPreference },
						})
						const replacement = `const value = "${token}"`
						const originalContent = "before\nTARGET\nafter"
						const expectedContent = `before\n${replacement}\nafter`

						await executeSearchReplaceTool(
							{ old_string: "TARGET", new_string: replacement },
							{ fileContent: originalContent },
						)

						expect(mockHandleError).not.toHaveBeenCalled()
						expect(mockAlphaTask.didEditFile).toBe(true)
						expect(mockAlphaTask.diffViewProvider.saveDirectly).toHaveBeenCalledWith(
							testFilePath,
							expectedContent,
							false,
							true,
							1000,
							{ exists: true, content: originalContent },
						)
						expect(mockAlphaTask.diffViewProvider.update).not.toHaveBeenCalled()
						expect(mockAlphaTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
					},
				)
			},
		)

		it("returns error when no match is found", async () => {
			const result = await executeSearchReplaceTool(
				{ old_string: "NonExistent" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("Error:")
			expect(result).toContain("No match found")
			expect(mockAlphaTask.consecutiveMistakeCount).toBe(1)
			expect(mockAlphaTask.recordToolError).toHaveBeenCalledWith("search_replace", "no_match")
		})

		it("returns error when multiple matches are found", async () => {
			const result = await executeSearchReplaceTool(
				{ old_string: "Line" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("Error:")
			expect(result).toContain("3 matches")
			expect(mockAlphaTask.consecutiveMistakeCount).toBe(1)
			expect(mockAlphaTask.recordToolError).toHaveBeenCalledWith("search_replace", "multiple_matches")
		})

		it("successfully replaces single unique match", async () => {
			await executeSearchReplaceTool(
				{
					old_string: "Line 2",
					new_string: "Modified Line 2",
				},
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockAlphaTask.consecutiveMistakeCount).toBe(0)
			expect(mockAlphaTask.diffViewProvider.editType).toBe("modify")
			expect(mockAskApproval).toHaveBeenCalled()
		})
	})

	describe("approval workflow", () => {
		it.each([undefined, false, true])(
			"keeps background edits behind approval with legacy preference %s",
			async (legacyPreference) => {
				const rawBaseline = "\uFEFFLine 1\r\nLine 2\r\nLine 3"
				mockAlphaTask.providerRef.deref().getState.mockResolvedValue({
					diagnosticsEnabled: false,
					writeDelayMs: 175,
					...(legacyPreference === undefined
						? {}
						: { experiments: { preventFocusDisruption: legacyPreference } }),
				})
				mockAlphaTask.alphaProtectedController.isWriteProtected.mockReturnValue(true)
				let resolveApproval!: (approved: boolean) => void
				let markApprovalRequested!: () => void
				const approvalRequested = new Promise<void>((resolve) => {
					markApprovalRequested = resolve
				})
				const approval = new Promise<boolean>((resolve) => {
					resolveApproval = resolve
				})
				mockAskApproval.mockImplementation(() => {
					markApprovalRequested()
					return approval
				})
				const execution = executeSearchReplaceTool(
					{ old_string: "Line 2", new_string: "Changed" },
					{ fileContent: rawBaseline },
				)
				await approvalRequested
				try {
					expect(mockAlphaTask.diffViewProvider.open).not.toHaveBeenCalled()
					expect(mockAlphaTask.diffViewProvider.update).not.toHaveBeenCalled()
					expect(mockAlphaTask.diffViewProvider.scrollToFirstDiff).not.toHaveBeenCalled()
					expect(mockAlphaTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
					expect(mockAlphaTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
					expect(mockAskApproval).toHaveBeenCalledWith("tool", expect.any(String), undefined, true)
					expect(JSON.parse(mockAskApproval.mock.calls[0][1])).toMatchObject({
						diff: "mock-diff",
						content: "mock-diff",
						originalContent: rawBaseline,
						finalContent: "\uFEFFLine 1\r\nChanged\r\nLine 3",
						isProtected: true,
					})
				} finally {
					resolveApproval(true)
					await execution
				}
				expect(mockAlphaTask.diffViewProvider.saveDirectly).toHaveBeenCalledExactlyOnceWith(
					testFilePath,
					"\uFEFFLine 1\r\nChanged\r\nLine 3",
					false,
					false,
					175,
					{ exists: true, content: rawBaseline },
				)
				expect(mockAlphaTask.didEditFile).toBe(true)
				expect(mockAlphaTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
				expect(mockAlphaTask.diffViewProvider.reset).toHaveBeenCalledTimes(1)
			},
		)

		it("leaves the workspace unchanged when approval is cancelled", async () => {
			const cancellation = new Error("Approval cancelled")
			cancellation.name = "AbortError"
			mockAskApproval.mockRejectedValueOnce(cancellation)
			await executeSearchReplaceTool()
			expect(mockAlphaTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
			expect(mockAlphaTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockAlphaTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
			expect(mockAlphaTask.recordToolUsage).not.toHaveBeenCalled()
			expect(mockAlphaTask.didEditFile).toBe(false)
			expect(mockAlphaTask.diffViewProvider.reset).toHaveBeenCalled()
			expect(mockHandleError).toHaveBeenCalledWith("search and replace", cancellation)
		})

		it("saves changes when user approves", async () => {
			mockAskApproval.mockResolvedValue(true)

			await executeSearchReplaceTool()

			expect(mockAlphaTask.diffViewProvider.saveDirectly).toHaveBeenCalled()
			expect(mockAlphaTask.didEditFile).toBe(true)
			expect(mockAlphaTask.recordToolUsage).toHaveBeenCalledWith("search_replace")
		})

		it("leaves the workspace unchanged when the user rejects", async () => {
			mockAskApproval.mockResolvedValue(false)

			const result = await executeSearchReplaceTool()

			expect(mockAlphaTask.diffViewProvider.revertChanges).not.toHaveBeenCalled()
			expect(mockAlphaTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
			expect(mockAlphaTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockAlphaTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
			expect(mockAlphaTask.didEditFile).toBe(false)
			expect(mockAlphaTask.diffViewProvider.reset).toHaveBeenCalledTimes(1)
			expect(result).toContain("rejected")
		})

		it("includes the raw baseline in the inline diff approval", async () => {
			const rawBaseline = "Line 1\r\nLine 2\r\nLine 3"

			await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "Changed" },
				{ fileContent: rawBaseline },
			)

			expect(JSON.parse(mockAskApproval.mock.calls[0][1])).toMatchObject({
				originalContent: rawBaseline,
				finalContent: "Line 1\r\nChanged\r\nLine 3",
			})
			expect(mockAlphaTask.diffViewProvider.open).not.toHaveBeenCalled()
		})
	})

	describe("partial block handling", () => {
		it("handles partial block without errors after path stabilizes", async () => {
			// Path stabilization requires two consecutive calls with the same path
			// First call sets lastSeenPartialPath, second call sees it has stabilized
			await executeSearchReplaceTool({}, { isPartial: true })
			await executeSearchReplaceTool({}, { isPartial: true })

			expect(mockAlphaTask.ask).toHaveBeenCalled()
			expect(mockAlphaTask.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockAlphaTask.diffViewProvider.update).not.toHaveBeenCalled()
			expect(mockAlphaTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		})
	})

	describe("error handling", () => {
		it("handles file read errors gracefully", async () => {
			// Set up the rejection BEFORE executing
			mockedFsReadFile.mockRejectedValueOnce(new Error("Read failed"))

			const toolUse: ToolUse = {
				type: "tool_use",
				name: "search_replace",
				params: {
					file_path: testFilePath,
					old_string: testOldString,
					new_string: testNewString,
				},
				nativeArgs: {
					file_path: testFilePath,
					old_string: testOldString,
					new_string: testNewString,
				},
				partial: false,
			}

			let capturedResult: ToolResponse | undefined
			const localPushToolResult = vi.fn((result: ToolResponse) => {
				capturedResult = result
			})

			await searchReplaceTool.handle(mockAlphaTask, toolUse as ToolUse<"search_replace">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: localPushToolResult,
			})

			expect(capturedResult).toContain("Error:")
			expect(capturedResult).toContain("Failed to read file")
			expect(mockAlphaTask.consecutiveMistakeCount).toBe(1)
		})

		it("handles general errors and resets diff view", async () => {
			mockAlphaTask.diffViewProvider.saveDirectly.mockRejectedValueOnce(new Error("General error"))

			await executeSearchReplaceTool()

			expect(mockHandleError).toHaveBeenCalledWith("search and replace", expect.any(Error))
			expect(mockAlphaTask.diffViewProvider.reset).toHaveBeenCalled()
		})
	})

	describe("file tracking", () => {
		it("tracks file context after successful edit", async () => {
			await executeSearchReplaceTool()

			expect(mockAlphaTask.fileContextTracker.trackFileContext).toHaveBeenCalledWith(testFilePath, "alpha_edited")
		})
	})

	describe("CRLF normalization", () => {
		it("normalizes CRLF to LF when reading file", async () => {
			const contentWithCRLF = "Line 1\r\nLine 2\r\nLine 3"

			await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "Modified Line 2" },
				{ fileContent: contentWithCRLF },
			)

			expect(mockAlphaTask.consecutiveMistakeCount).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("normalizes CRLF in old_string to match LF-normalized file content", async () => {
			// File has CRLF line endings
			const contentWithCRLF = "Line 1\r\nLine 2\r\nLine 3"
			// Search string also has CRLF (simulating what the model might send)
			const searchWithCRLF = "Line 1\r\nLine 2"

			await executeSearchReplaceTool(
				{ old_string: searchWithCRLF, new_string: "Modified Lines" },
				{ fileContent: contentWithCRLF },
			)

			expect(mockAlphaTask.consecutiveMistakeCount).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("matches LF old_string against CRLF file content after normalization", async () => {
			// File has CRLF line endings
			const contentWithCRLF = "Line 1\r\nLine 2\r\nLine 3"
			// Search string has LF (typical model output)
			const searchWithLF = "Line 1\nLine 2"

			await executeSearchReplaceTool(
				{ old_string: searchWithLF, new_string: "Modified Lines" },
				{ fileContent: contentWithCRLF },
			)

			expect(mockAlphaTask.consecutiveMistakeCount).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("passes the raw CRLF baseline to direct saves", async () => {
			const rawBaseline = "Line 1\r\nLine 2\r\nLine 3"
			mockAlphaTask.providerRef.deref().getState.mockResolvedValue({
				diagnosticsEnabled: true,
				writeDelayMs: 0,
				experiments: { preventFocusDisruption: true },
			})

			await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "Modified Line 2" },
				{ fileContent: rawBaseline },
			)

			expect(mockAlphaTask.diffViewProvider.saveDirectly).toHaveBeenCalledWith(
				testFilePath,
				"Line 1\r\nModified Line 2\r\nLine 3",
				false,
				true,
				0,
				{ exists: true, content: rawBaseline },
			)
		})

		it("rejects a direct save when the raw baseline changes during approval", async () => {
			const rawBaseline = "Line 1\r\nLine 2\r\nLine 3"
			mockAlphaTask.providerRef.deref().getState.mockResolvedValue({
				diagnosticsEnabled: true,
				writeDelayMs: 0,
				experiments: { preventFocusDisruption: false },
			})
			mockAskApproval.mockImplementation(async () => {
				mockedFsReadFile.mockResolvedValue("Line 1\r\nLine 2\r\nconcurrent edit")
				return true
			})
			mockAlphaTask.diffViewProvider.saveDirectly.mockImplementation(
				async (
					_path: string,
					_content: string,
					_openFile: boolean,
					_diagnostics: boolean,
					_delay: number,
					expected: { exists: true; content: string },
				) => {
					const current = await mockedFsReadFile(absoluteFilePath, "utf8")
					if (current !== expected.content) {
						throw new Error("Cannot save: the file changed while approval was pending")
					}
				},
			)

			await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "Modified Line 2" },
				{ fileContent: rawBaseline },
			)

			expect(mockHandleError).toHaveBeenCalledWith(
				"search and replace",
				expect.objectContaining({ message: expect.stringContaining("changed") }),
			)
			expect(mockAlphaTask.didEditFile).toBe(false)
			expect(mockAlphaTask.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
			expect(mockAlphaTask.recordToolUsage).not.toHaveBeenCalled()
			expect(mockAlphaTask.diffViewProvider.reset).toHaveBeenCalled()
		})
	})
})
