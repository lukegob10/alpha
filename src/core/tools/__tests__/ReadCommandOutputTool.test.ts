import * as fs from "fs/promises"
import * as path from "path"
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

import { ReadCommandOutputTool } from "../ReadCommandOutputTool"
import {
	READ_COMMAND_OUTPUT_ARTIFACT_ID_PATTERN,
	READ_COMMAND_OUTPUT_DEFAULT_LIMIT_BYTES,
	READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH,
	READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES,
	READ_COMMAND_OUTPUT_MAX_OFFSET,
	READ_COMMAND_OUTPUT_MAX_SEARCH_LENGTH,
	READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES,
	READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES,
} from "../commandOutputContract"
import { Task } from "../../task/Task"
import readCommandOutput from "../../prompts/tools/native-tools/read_command_output"

// Mock filesystem operations
vi.mock("fs/promises", () => ({
	default: {
		access: vi.fn(),
		stat: vi.fn(),
		open: vi.fn(),
		readFile: vi.fn(),
	},
	access: vi.fn(),
	stat: vi.fn(),
	open: vi.fn(),
	readFile: vi.fn(),
}))

// Mock getTaskDirectoryPath
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn((globalStoragePath: string, taskId: string) => {
		return path.join(globalStoragePath, "tasks", taskId)
	}),
}))

describe("ReadCommandOutputTool", () => {
	let tool: ReadCommandOutputTool
	let mockTask: any
	let mockCallbacks: any
	let mockFileHandle: any
	let globalStoragePath: string
	let taskId: string

	beforeEach(() => {
		vi.clearAllMocks()

		tool = new ReadCommandOutputTool()
		globalStoragePath = "/mock/global/storage"
		taskId = "task-123"

		// Mock task object
		mockTask = {
			taskId,
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			say: vi.fn().mockResolvedValue(undefined),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter"),
			recordToolError: vi.fn(),
			providerRef: {
				deref: vi.fn().mockResolvedValue({
					context: {
						globalStorageUri: {
							fsPath: globalStoragePath,
						},
					},
				}),
			},
		}

		// Mock callbacks
		mockCallbacks = {
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}

		// Mock file handle
		mockFileHandle = {
			read: vi.fn(),
			close: vi.fn().mockResolvedValue(undefined),
		}

		// Default mocks
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.stat).mockResolvedValue({ size: 1000 } as any)
		vi.mocked(fs.open).mockResolvedValue(mockFileHandle as any)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("Basic read functionality", () => {
		it("should read artifact file correctly", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "Line 1\nLine 2\nLine 3\n"
			const buffer = Buffer.from(content)

			mockFileHandle.read.mockImplementation((buf: Buffer) => {
				buffer.copy(buf)
				return Promise.resolve({ bytesRead: buffer.length })
			})

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			expect(fs.access).toHaveBeenCalledWith(
				path.join(globalStoragePath, "tasks", taskId, "command-output", artifactId),
			)
			expect(mockCallbacks.pushToolResult).toHaveBeenCalled()
			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("Line 1")
			expect(result).toContain("Line 2")
			expect(result).toContain("Line 3")
		})

		it("should return content with line numbers", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "First line\nSecond line\nThird line\n"
			const buffer = Buffer.from(content)

			mockFileHandle.read.mockImplementation((buf: Buffer) => {
				buffer.copy(buf)
				return Promise.resolve({ bytesRead: buffer.length })
			})

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toMatch(/1 \| First line/)
			expect(result).toMatch(/2 \| Second line/)
			expect(result).toMatch(/3 \| Third line/)
		})

		it("should include size metadata in output", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "Test output"
			const fileSize = 5000
			const buffer = Buffer.from(content)

			vi.mocked(fs.stat).mockResolvedValue({ size: fileSize } as any)
			mockFileHandle.read.mockImplementation((buf: Buffer) => {
				buffer.copy(buf)
				return Promise.resolve({ bytesRead: buffer.length })
			})

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain(`[Command Output: ${artifactId}]`)
			expect(result).toContain("Total size:")
			expect(result).toMatch(/\d+(\.\d+)?(bytes|KB|MB)/)
		})

		it("should close file handle after reading", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "Test"
			const buffer = Buffer.from(content)

			mockFileHandle.read.mockImplementation((buf: Buffer) => {
				buffer.copy(buf)
				return Promise.resolve({ bytesRead: buffer.length })
			})

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			expect(mockFileHandle.close).toHaveBeenCalled()
		})
	})

	describe("Pagination (offset/limit)", () => {
		it("should use default limit of 40KB", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const largeContent = "x".repeat(50 * 1024) // 50KB
			const fileSize = Buffer.byteLength(largeContent, "utf8")

			vi.mocked(fs.stat).mockResolvedValue({ size: fileSize } as any)

			// Mock read to return only up to default limit (40KB)
			mockFileHandle.read.mockImplementation((buf: Buffer) => {
				const defaultLimit = READ_COMMAND_OUTPUT_DEFAULT_LIMIT_BYTES
				const bytesToRead = Math.min(buf.length, defaultLimit)
				buf.write(largeContent.slice(0, bytesToRead))
				return Promise.resolve({ bytesRead: bytesToRead })
			})

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("TRUNCATED")
		})

		it("should start reading from custom offset", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "0123456789ABCDEFGHIJ"
			const offset = 10
			const fileSize = Buffer.byteLength(content, "utf8")

			vi.mocked(fs.stat).mockResolvedValue({ size: fileSize } as any)

			// Mock first read for offset calculation (returns content before offset)
			// Mock second read for actual content
			let readCallCount = 0
			mockFileHandle.read.mockImplementation(
				(buf: Buffer, bufOffset: number, length: number, position: number | null) => {
					readCallCount++
					if (position === 0) {
						// First read: prefix for line number calculation
						const prefixContent = content.slice(0, offset)
						buf.write(prefixContent)
						return Promise.resolve({ bytesRead: prefixContent.length })
					} else {
						// Second read: actual content from offset
						const actualContent = content.slice(offset)
						buf.write(actualContent)
						return Promise.resolve({ bytesRead: actualContent.length })
					}
				},
			)

			await tool.execute({ artifact_id: artifactId, offset }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain(`Showing bytes ${offset}-`)
			expect(mockFileHandle.read).toHaveBeenCalled()
		})

		it("should restrict output size with custom limit", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const largeContent = "x".repeat(10000)
			const customLimit = 1000
			const fileSize = Buffer.byteLength(largeContent, "utf8")

			vi.mocked(fs.stat).mockResolvedValue({ size: fileSize } as any)

			mockFileHandle.read.mockImplementation((buf: Buffer) => {
				const bytesToRead = Math.min(buf.length, customLimit)
				buf.write(largeContent.slice(0, bytesToRead))
				return Promise.resolve({ bytesRead: bytesToRead })
			})

			await tool.execute({ artifact_id: artifactId, limit: customLimit }, mockTask, mockCallbacks)

			expect(mockCallbacks.pushToolResult).toHaveBeenCalled()
			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("TRUNCATED")
		})

		it("should keep the complete normal-read response within the UTF-8 byte limit", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = `${"🙂".repeat(1000)}\n`
			const buffer = Buffer.from(content, "utf8")
			const limit = READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES
			vi.mocked(fs.stat).mockResolvedValue({ size: buffer.length } as any)
			mockFileHandle.read.mockImplementation(
				(buf: Buffer, bufOffset: number, length: number, position: number | null) => {
					const start = position ?? 0
					const bytesToRead = Math.min(length, buffer.length - start)
					if (bytesToRead > 0) buffer.copy(buf, bufOffset, start, start + bytesToRead)
					return Promise.resolve({ bytesRead: Math.max(0, bytesToRead) })
				},
			)

			await tool.execute({ artifact_id: artifactId, limit }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(limit)
			expect(result).not.toContain("�")
		})

		it("should advance a read offset inside a multibyte code point", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "prefix🙂suffix\n"
			const buffer = Buffer.from(content, "utf8")
			const emojiStart = Buffer.byteLength("prefix", "utf8")
			const offset = emojiStart + 1
			vi.mocked(fs.stat).mockResolvedValue({ size: buffer.length } as any)
			mockFileHandle.read.mockImplementation(
				(buf: Buffer, bufOffset: number, length: number, position: number | null) => {
					const start = position ?? 0
					const bytesToRead = Math.min(length, buffer.length - start)
					if (bytesToRead > 0) buffer.copy(buf, bufOffset, start, start + bytesToRead)
					return Promise.resolve({ bytesRead: Math.max(0, bytesToRead) })
				},
			)

			await tool.execute({ artifact_id: artifactId, offset }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			const telemetry = JSON.parse(mockTask.say.mock.calls.find(([type]: [string]) => type === "tool")[1])
			expect(result).toContain("suffix")
			expect(result).not.toContain("�")
			expect(telemetry.readStart).toBe(emojiStart + Buffer.byteLength("🙂", "utf8"))
			expect(telemetry.nextOffset).toBe(telemetry.readEnd)
		})

		it("should fill multiple short positional reads before rendering", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = `${"short-read ".repeat(200)}\n`
			const buffer = Buffer.from(content, "utf8")
			const limit = READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES
			let readCalls = 0
			vi.mocked(fs.stat).mockResolvedValue({ size: buffer.length } as any)
			mockFileHandle.read.mockImplementation(
				(buf: Buffer, bufOffset: number, length: number, position: number | null) => {
					readCalls++
					const start = position ?? 0
					const bytesToRead = Math.min(7, length, buffer.length - start)
					if (bytesToRead > 0) buffer.copy(buf, bufOffset, start, start + bytesToRead)
					return Promise.resolve({ bytesRead: Math.max(0, bytesToRead) })
				},
			)

			await tool.execute({ artifact_id: artifactId, limit }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(readCalls).toBeGreaterThan(2)
			expect(result).toContain("short-read")
			expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(limit)
		})

		it("should reject a limit above the resource cap", async () => {
			const artifactId = "cmd-1706119234567.txt"

			await tool.execute({ artifact_id: artifactId, limit: 4 * 1024 * 1024 + 1 }, mockTask, mockCallbacks)

			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Invalid limit"))
			expect(fs.access).not.toHaveBeenCalled()
		})

		it("should show TRUNCATED when more content exists", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const fileSize = 10000
			const limit = 5000

			vi.mocked(fs.stat).mockResolvedValue({ size: fileSize } as any)

			mockFileHandle.read.mockImplementation((buf: Buffer) => {
				const content = "x".repeat(limit)
				buf.write(content)
				return Promise.resolve({ bytesRead: limit })
			})

			await tool.execute({ artifact_id: artifactId, limit }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("TRUNCATED")
		})

		it("should show COMPLETE when all content is returned", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "Small content"
			const fileSize = Buffer.byteLength(content, "utf8")

			vi.mocked(fs.stat).mockResolvedValue({ size: fileSize } as any)

			mockFileHandle.read.mockImplementation((buf: Buffer) => {
				buf.write(content)
				return Promise.resolve({ bytesRead: fileSize })
			})

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("COMPLETE")
			expect(result).not.toContain("TRUNCATED")
		})
	})

	describe("Search filtering", () => {
		// Helper to setup file handle mock for search (which now uses streaming)
		const setupSearchMock = (content: string) => {
			const buffer = Buffer.from(content)
			const fileSize = buffer.length
			vi.mocked(fs.stat).mockResolvedValue({ size: fileSize } as any)

			// Mock streaming read - return entire content in one chunk (simulates small file)
			mockFileHandle.read.mockImplementation(
				(buf: Buffer, bufOffset: number, length: number, position: number | null) => {
					const pos = position ?? 0
					if (pos >= fileSize) {
						return Promise.resolve({ bytesRead: 0 })
					}
					const bytesToRead = Math.min(length, fileSize - pos)
					buffer.copy(buf, 0, pos, pos + bytesToRead)
					return Promise.resolve({ bytesRead: bytesToRead })
				},
			)
		}

		it("should filter lines matching pattern", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "Line 1: error occurred\nLine 2: success\nLine 3: error found\nLine 4: complete\n"

			setupSearchMock(content)

			await tool.execute({ artifact_id: artifactId, search: "error" }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("error occurred")
			expect(result).toContain("error found")
			expect(result).not.toContain("success")
			expect(result).not.toContain("complete")
		})

		it("should use case-insensitive matching", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "ERROR: Something bad\nwarning: minor issue\nERROR: Another problem\n"

			setupSearchMock(content)

			await tool.execute({ artifact_id: artifactId, search: "error" }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("ERROR: Something bad")
			expect(result).toContain("ERROR: Another problem")
		})

		it("should show match count and line numbers", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "Line 1\nError on line 2\nLine 3\nError on line 4\n"

			setupSearchMock(content)

			await tool.execute({ artifact_id: artifactId, search: "Error" }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("Total matches: 2")
			expect(result).toMatch(/2 \|.*Error on line 2/)
			expect(result).toMatch(/4 \|.*Error on line 4/)
		})

		it.each([
			{ name: "with a trailing newline", suffix: "\n" },
			{ name: "without a trailing newline", suffix: "" },
		])("should report an oversized first match $name", async ({ suffix }) => {
			const artifactId = "cmd-1706119234567.txt"
			const content = `ERROR ${"x".repeat(50000)}${suffix}`
			setupSearchMock(content)

			const result = await (tool as any).searchInArtifact(
				path.join(globalStoragePath, "tasks", taskId, "command-output", artifactId),
				"ERROR",
				0,
				Buffer.byteLength(content),
				READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES,
			)

			expect(result.matchCount).toBeGreaterThan(0)
			expect(result.content).toContain("TRUNCATED")
			expect(result.content).not.toContain("No matches found")
			expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(1000)
		})

		it("should bound blank-line matches and stop scanning after the output budget", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "\n".repeat(100000)
			setupSearchMock(content)

			const result = await (tool as any).searchInArtifact(
				path.join(globalStoragePath, "tasks", taskId, "command-output", artifactId),
				"^$",
				0,
				Buffer.byteLength(content),
				READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES,
			)

			expect(result.matchCount).toBeGreaterThan(0)
			expect(result.content).toContain("TRUNCATED")
			expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(1000)
			expect(result.bytesRead).toBeLessThan(content.length)
		})

		it("should report the bounded search range in tool telemetry", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "\n".repeat(100000)
			setupSearchMock(content)

			await tool.execute({ artifact_id: artifactId, search: "^$", limit: READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES }, mockTask, mockCallbacks)

			const telemetry = JSON.parse(mockTask.say.mock.calls.find(([type]: [string]) => type === "tool")[1])
			expect(telemetry.readEnd).toBeLessThan(content.length)
			expect(telemetry.searchBytesRead).toBe(telemetry.readEnd)
			expect(telemetry.searchTruncated).toBe(true)
			expect(telemetry.searchMatchCountExact).toBe(false)
		})

		it("should report processed search bytes and resume at the next match", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const firstLine = `ERROR ${"x".repeat(200)}`
			const content = `${firstLine}\nnoise\n${"noise\n".repeat(20)}ERROR later\n`
			setupSearchMock(content)

			await tool.execute(
				{ artifact_id: artifactId, search: "ERROR", limit: READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES },
				mockTask,
				mockCallbacks,
			)
			const firstResult = mockCallbacks.pushToolResult.mock.calls[0][0]
			const firstTelemetry = JSON.parse(mockTask.say.mock.calls.find(([type]: [string]) => type === "tool")[1])
			expect(firstResult).toContain("ERROR")
			expect(firstTelemetry.readStart).toBe(0)
			expect(firstTelemetry.readEnd).toBe(Buffer.byteLength(`${firstLine}\n`, "utf8"))
			expect(firstTelemetry.readEnd).toBeLessThan(Buffer.byteLength(content, "utf8"))
			expect(firstTelemetry.searchBytesRead).toBe(firstTelemetry.readEnd)
			expect(firstTelemetry.nextOffset).toBe(firstTelemetry.readEnd)

			mockCallbacks.pushToolResult.mockClear()
			mockTask.say.mockClear()
			await tool.execute(
				{
					artifact_id: artifactId,
					search: "ERROR",
					offset: firstTelemetry.nextOffset,
					limit: READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES,
				},
				mockTask,
				mockCallbacks,
			)

			const secondResult = mockCallbacks.pushToolResult.mock.calls[0][0]
			const secondTelemetry = JSON.parse(mockTask.say.mock.calls.find(([type]: [string]) => type === "tool")[1])
			expect(secondResult).toContain("ERROR later")
			expect(secondTelemetry.readStart).toBe(firstTelemetry.nextOffset)
		})

		it("should keep an exact-budget match at EOF exact", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const line = `ERROR ${"x".repeat(50)}`
			setupSearchMock(`${line}\n`)

			const result = await (tool as any).searchInArtifact(
				path.join(globalStoragePath, "tasks", taskId, "command-output", artifactId),
				"ERROR",
				0,
				Buffer.byteLength(`${line}\n`, "utf8"),
				READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES,
			)

			expect(result.matchCount).toBe(1)
			expect(result.truncated).toBe(false)
			expect(result.content).toContain("Total matches: 1")
			expect(result.content).not.toContain("At least 1 matches observed")
		})

		it("should charge multibyte content by UTF-8 bytes when truncating a match", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = `${"🙂".repeat(200)}\n`
			setupSearchMock(content)

			const result = await (tool as any).searchInArtifact(
				path.join(globalStoragePath, "tasks", taskId, "command-output", artifactId),
				"🙂",
				0,
				Buffer.byteLength(content),
				READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES,
			)

			expect(result.matchCount).toBe(1)
			expect(result.content).toContain("🙂")
			expect(result.content).toContain("TRUNCATED")
			expect(result.content).not.toContain("�")
			expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES)
		})

		it("should keep the complete search response within the UTF-8 byte limit", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = `ERROR ${"🙂".repeat(1000)}\n`
			const limit = READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES
			setupSearchMock(content)

			await tool.execute({ artifact_id: artifactId, search: "ERROR", limit }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(limit)
			expect(result).not.toContain("�")
		})

		it("should report an incomplete oversized unterminated line instead of no matches", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = `ERROR ${"x".repeat(READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES + 1024)}`
			setupSearchMock(content)

			await tool.execute({ artifact_id: artifactId, search: "ERROR" }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			const telemetry = JSON.parse(mockTask.say.mock.calls.find(([type]: [string]) => type === "tool")[1])
			expect(result).toMatch(/incomplete/i)
			expect(result).not.toContain("No matches found for the search pattern")
			expect(telemetry.searchIncomplete).toBe(true)
			expect(telemetry.searchMatchCountExact).toBe(false)
		})

		it.each([
			"a+a+$",
			"(a|aa)+$",
			"(a?)+$",
			"(?:a{1,2})+$",
			"a{0,1000}a{1000}b",
		])(
			"should reject potentially unsafe search pattern %s before reading",
			async (search) => {
				const artifactId = "cmd-1706119234567.txt"

				await tool.execute({ artifact_id: artifactId, search }, mockTask, mockCallbacks)

				expect(mockTask.didToolFailInCurrentTurn).toBe(true)
				expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
				expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Invalid search pattern"))
				expect(fs.access).not.toHaveBeenCalled()
			},
		)

		it.each([
			["a+b", "aaab\n"],
			["a+$", "aaa\n"],
			["a+\\b", "aaa\n"],
			["a{64}b", `${"a".repeat(64)}b\n`],
			["a{1000}b", `${"a".repeat(1000)}b\n`],
			["ERROR.*timeout", "ERROR: command timeout\n"],
		])(
			"should allow a flat quantifier with a suffix and return matching lines: %s",
			async (search, content) => {
				const artifactId = "cmd-1706119234567.txt"
				setupSearchMock(content)

				await tool.execute({ artifact_id: artifactId, search, limit: 2048 }, mockTask, mockCallbacks)

				const result = mockCallbacks.pushToolResult.mock.calls[0][0]
				expect(result).toContain("Total matches: 1")
				expect(mockTask.didToolFailInCurrentTurn).toBe(false)
			},
		)

		it.each(["test\\d+", "a{8}b+"])(
			"should allow a safe search pattern with small or single quantifiers: %s",
			async (search) => {
				const artifactId = "cmd-1706119234567.txt"
				setupSearchMock(search === "test\\d+" ? "test123\nother\n" : "aaaaaaaab\n")

				await tool.execute({ artifact_id: artifactId, search }, mockTask, mockCallbacks)

				const result = mockCallbacks.pushToolResult.mock.calls[0][0]
				expect(result).toContain(search === "test\\d+" ? "test123" : "aaaaaaaab")
				expect(mockTask.didToolFailInCurrentTurn).toBe(false)
			},
		)

		it.each([64, 1000])("should allow a large fixed repetition when it is the terminal token: %s", async (count) => {
			const artifactId = "cmd-1706119234567.txt"
			setupSearchMock(`${"a".repeat(count)}\n`)

			await tool.execute({ artifact_id: artifactId, search: `a{${count}}`, limit: 2048 }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("Total matches: 1")
			expect(mockTask.didToolFailInCurrentTurn).toBe(false)
		})

		it("should match blank CRLF lines as empty lines", async () => {
			const artifactId = "cmd-1706119234567.txt"
			setupSearchMock("first\r\n\r\nERROR\r\n")

			await tool.execute({ artifact_id: artifactId, search: "^$" }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("Total matches: 1")
			expect(result).toMatch(/2 \|\s*$/m)
		})

		it("should handle empty search results gracefully", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "Line 1\nLine 2\nLine 3\n"

			setupSearchMock(content)

			await tool.execute({ artifact_id: artifactId, search: "NOTFOUND" }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("No matches found for the search pattern")
		})

		it("should handle regex patterns in search", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "test123\ntest456\nabc789\ntest000\n"

			setupSearchMock(content)

			await tool.execute({ artifact_id: artifactId, search: "test\\d+" }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("test123")
			expect(result).toContain("test456")
			expect(result).toContain("test000")
			expect(result).not.toContain("abc789")
		})

		it("should handle invalid regex patterns by treating as literal", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "Line with [brackets]\nLine without\n"

			setupSearchMock(content)

			// Invalid regex but valid as literal string
			await tool.execute({ artifact_id: artifactId, search: "[" }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(result).toContain("[brackets]")
		})
	})

	describe("Error handling", () => {
		it("should keep artifact validation in parity with the schema and bound invalid ID errors", async () => {
			const artifactSchema = (readCommandOutput.function.parameters as any).properties.artifact_id
			expect(artifactSchema.pattern).toBe(READ_COMMAND_OUTPUT_ARTIFACT_ID_PATTERN)
			expect(artifactSchema.maxLength).toBe(READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH)

			const oversizedArtifactId = `cmd-${"9".repeat(500)}.txt`
			await tool.execute({ artifact_id: oversizedArtifactId }, mockTask, mockCallbacks)

			const errorResult = mockCallbacks.pushToolResult.mock.calls[0][0]
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(errorResult).toContain("Invalid artifact_id format")
			expect(errorResult).not.toContain("9".repeat(100))
			expect(Buffer.byteLength(errorResult, "utf8")).toBeLessThan(400)
			expect(fs.access).not.toHaveBeenCalled()
		})

		it("should return error for non-existent artifact", async () => {
			const artifactId = "cmd-9999999999.txt"

			vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"))

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("not found"))
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Error: Artifact not found"),
			)
		})

		it("should reject invalid artifact_id with path traversal attempt", async () => {
			const invalidIds = [
				"../../../etc/passwd",
				"..\\..\\..\\windows\\system32\\config",
				"cmd-123/../other.txt",
				"cmd-<script>alert()</script>.txt",
				"cmd-.txt",
				"invalid-format.txt",
			]

			for (const invalidId of invalidIds) {
				vi.clearAllMocks()
				mockTask.consecutiveMistakeCount = 0
				mockTask.didToolFailInCurrentTurn = false

				await tool.execute({ artifact_id: invalidId }, mockTask, mockCallbacks)

				expect(mockTask.consecutiveMistakeCount).toBeGreaterThan(0)
				expect(mockTask.didToolFailInCurrentTurn).toBe(true)
				expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
				expect(mockTask.say).toHaveBeenCalledWith(
					"error",
					expect.stringContaining("Invalid artifact_id format"),
				)
			}
		})

		it("should accept valid artifact_id format", async () => {
			const validId = "cmd-1706119234567.txt"
			const content = "Test"
			const buffer = Buffer.from(content)

			mockFileHandle.read.mockImplementation((buf: Buffer) => {
				buffer.copy(buf)
				return Promise.resolve({ bytesRead: buffer.length })
			})

			await tool.execute({ artifact_id: validId }, mockTask, mockCallbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.didToolFailInCurrentTurn).toBe(false)
		})

		it("should handle invalid offset gracefully", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const fileSize = 1000

			vi.mocked(fs.stat).mockResolvedValue({ size: fileSize } as any)

			await tool.execute(
				{ artifact_id: artifactId, offset: 2000 }, // Offset beyond file size
				mockTask,
				mockCallbacks,
			)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Invalid offset"))
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error: Invalid offset"))
		})

		it("should handle negative offset", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const fileSize = 1000

			vi.mocked(fs.stat).mockResolvedValue({ size: fileSize } as any)

			await tool.execute({ artifact_id: artifactId, offset: -10 }, mockTask, mockCallbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Invalid offset"))
			expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		})

		it.each([
			["fractional offset", { offset: 1.5 }, "Invalid offset"],
			["NaN offset", { offset: Number.NaN }, "Invalid offset"],
			["infinite offset", { offset: Number.POSITIVE_INFINITY }, "Invalid offset"],
			["offset above safe maximum", { offset: READ_COMMAND_OUTPUT_MAX_OFFSET + 1 }, "Invalid offset"],
			["zero limit", { limit: 0 }, "Invalid limit"],
			["fractional limit", { limit: 1.5 }, "Invalid limit"],
			["NaN limit", { limit: Number.NaN }, "Invalid limit"],
			["infinite limit", { limit: Number.POSITIVE_INFINITY }, "Invalid limit"],
			["limit below minimum", { limit: READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES - 1 }, "Invalid limit"],
			["limit above maximum", { limit: READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES + 1 }, "Invalid limit"],
		] as const)("should reject %s", async (_label, params, message) => {
			await tool.execute({ artifact_id: "cmd-1706119234567.txt", ...params }, mockTask, mockCallbacks)

			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining(message))
			expect(fs.access).not.toHaveBeenCalled()
		})

		it("should handle missing artifact_id parameter", async () => {
			await tool.execute({ artifact_id: "" }, mockTask, mockCallbacks)

			expect(mockTask.consecutiveMistakeCount).toBeGreaterThan(0)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("read_command_output")
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("read_command_output", "artifact_id")
		})

		it("should handle missing global storage path", async () => {
			const artifactId = "cmd-1706119234567.txt"

			mockTask.providerRef.deref.mockResolvedValue({
				context: {
					globalStorageUri: null,
				},
			})

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			expect(mockTask.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("Global storage path is not available"),
			)
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error"))
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		})

		it("should handle file read errors", async () => {
			const artifactId = "cmd-1706119234567.txt"

			mockFileHandle.read.mockRejectedValue(new Error("Read error"))

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Error reading command output"))
		})

		it("should ensure file handle is closed even on error", async () => {
			const artifactId = "cmd-1706119234567.txt"

			mockFileHandle.read.mockRejectedValue(new Error("Read error"))

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			expect(mockFileHandle.close).toHaveBeenCalled()
		})

		it("should close the search handle when UTF-8 alignment initialization fails", async () => {
			const artifactId = "cmd-1706119234567.txt"
			vi.spyOn(tool as any, "alignReadStart").mockRejectedValue(new Error("Alignment error"))

			await tool.execute({ artifact_id: artifactId, search: "error" }, mockTask, mockCallbacks)

			expect(mockFileHandle.close).toHaveBeenCalled()
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Alignment error"))
		})

		it("should report access failures as errors without calling them missing artifacts", async () => {
			const artifactId = "cmd-1706119234567.txt"
			vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error("Permission denied"), { code: "EACCES" }))

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Unable to access artifact"))
			expect(mockCallbacks.pushToolResult).not.toHaveBeenCalledWith(expect.stringContaining("Artifact not found"))
		})

		it.each([
			["stat", () => vi.mocked(fs.stat).mockRejectedValue(new Error("Stat error"))],
			["open", () => vi.mocked(fs.open).mockRejectedValue(new Error("Open error"))],
		])("should report %s failures with structured error metadata", async (_operation, fail) => {
			const artifactId = "cmd-1706119234567.txt"
			fail()

			await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockCallbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error reading command output"))
		})

		it("should preserve cancellation and close a handle when a read is pending", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const controller = new AbortController()
			const reason = new Error("cancelled read")
			let resolveRead!: (value: { bytesRead: number }) => void
			let readStarted!: () => void
			const readStartedPromise = new Promise<void>((resolve) => {
				readStarted = resolve
			})
			const pendingRead = new Promise<{ bytesRead: number }>((resolve) => {
				resolveRead = resolve
			})
			mockFileHandle.read.mockImplementation(() => {
				readStarted()
				return pendingRead
			})

			const execution = tool.execute(
				{ artifact_id: artifactId },
				mockTask,
				{ ...mockCallbacks, signal: controller.signal },
			)
			await readStartedPromise
			controller.abort(reason)

			await expect(execution).rejects.toBe(reason)
			expect(mockFileHandle.close).toHaveBeenCalled()
			expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()

			resolveRead({ bytesRead: 0 })
			await Promise.resolve()
		})
	})

	describe("Byte formatting", () => {
		it("should format bytes correctly", async () => {
			const testCases = [
				{ size: 500, expected: "bytes" },
				{ size: 1024, expected: "1.0KB" },
				{ size: 2048, expected: "2.0KB" },
				{ size: 1024 * 1024, expected: "1.0MB" },
				{ size: 2.5 * 1024 * 1024, expected: "2.5MB" },
			]

			for (const { size, expected } of testCases) {
				vi.clearAllMocks()
				const artifactId = "cmd-1706119234567.txt"
				const content = "x"
				const buffer = Buffer.from(content)

				vi.mocked(fs.stat).mockResolvedValue({ size } as any)
				mockFileHandle.read.mockImplementation((buf: Buffer) => {
					buffer.copy(buf)
					return Promise.resolve({ bytesRead: buffer.length })
				})

				await tool.execute({ artifact_id: artifactId }, mockTask, mockCallbacks)

				const result = mockCallbacks.pushToolResult.mock.calls[0][0]
				expect(result).toContain(expected)
			}
		})
	})

	describe("Line number calculation", () => {
		it("should calculate correct starting line number for offset", async () => {
			const artifactId = "cmd-1706119234567.txt"
			const content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n"
			const offset = 14 // After "Line 1\nLine 2\n"
			const fileSize = Buffer.byteLength(content, "utf8")

			vi.mocked(fs.stat).mockResolvedValue({ size: fileSize } as any)

			let readCallCount = 0
			mockFileHandle.read.mockImplementation(
				(buf: Buffer, bufOffset: number, length: number, position: number | null) => {
					readCallCount++
					if (position === 0) {
						// Read prefix for line counting
						const prefix = content.slice(0, offset)
						buf.write(prefix)
						return Promise.resolve({ bytesRead: prefix.length })
					} else {
						// Read actual content from offset
						const actualContent = content.slice(offset)
						buf.write(actualContent)
						return Promise.resolve({ bytesRead: actualContent.length })
					}
				},
			)

			await tool.execute({ artifact_id: artifactId, offset }, mockTask, mockCallbacks)

			const result = mockCallbacks.pushToolResult.mock.calls[0][0]
			// Should start at line 3 since we skipped 2 newlines
			expect(result).toMatch(/3 \|/)
		})
	})
})
