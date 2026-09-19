// npx vitest src/core/webview/__tests__/diagnosticsHandler.spec.ts

import * as path from "path"

// Mock vscode first
vi.mock("vscode", () => {
	const showErrorMessage = vi.fn()
	const openTextDocument = vi.fn().mockResolvedValue({})
	const showTextDocument = vi.fn().mockResolvedValue(undefined)

	return {
		version: "1.122.1",
		window: {
			showErrorMessage,
			showTextDocument,
		},
		workspace: {
			openTextDocument,
		},
	}
})

// Mock storage utilities
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn(async () => "/mock/task-dir"),
}))

// Mock fs utilities
vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn(),
}))

// Mock fs/promises
vi.mock("fs/promises", () => {
	const mockReadFile = vi.fn()
	const mockWriteFile = vi.fn().mockResolvedValue(undefined)
	const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" })
	const sourceBuffer = async (filePath: string) => {
		const value = await mockReadFile(filePath, "utf8")
		if (value === undefined) throw missing()
		return Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8")
	}
	const mockStat = vi.fn(async (filePath: string) => {
		const content = await sourceBuffer(filePath)
		return {
			isFile: () => true,
			isSymbolicLink: () => false,
			dev: 1,
			ino: 1,
			size: content.length,
			mtimeMs: 1,
		}
	})
	const mockOpen = vi.fn(async (filePath: string) => {
		const content = await sourceBuffer(filePath)
		return {
			stat: async () => mockStat(filePath),
			read: async (buffer: Buffer, offset: number, length: number, position: number) => {
				const bytesRead = Math.max(0, Math.min(length, content.length - position))
				if (bytesRead > 0) content.copy(buffer, offset, position, position + bytesRead)
				return { bytesRead, buffer }
			},
			close: vi.fn().mockResolvedValue(undefined),
		}
	})

	return {
		default: {
			readFile: mockReadFile,
			writeFile: mockWriteFile,
			lstat: mockStat,
			stat: mockStat,
			open: mockOpen,
		},
		readFile: mockReadFile,
		writeFile: mockWriteFile,
		lstat: mockStat,
		stat: mockStat,
		open: mockOpen,
	}
})

import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as fsUtils from "../../../utils/fs"
import { generateErrorDiagnostics } from "../diagnosticsHandler"

describe("generateErrorDiagnostics", () => {
	const mockLog = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(fs.readFile)
			.mockReset()
			.mockResolvedValue(undefined as any)
	})

	it("generates a diagnostics file with error metadata and history", async () => {
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true as any)
		vi.mocked(fs.readFile).mockResolvedValue('[{"role": "user", "content": "test"}]' as any)

		const result = await generateErrorDiagnostics({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			values: {
				timestamp: "2025-01-01T00:00:00.000Z",
				version: "1.2.3",
				provider: "test-provider",
				model: "test-model",
				details: "Sample error details",
			},
			log: mockLog,
		})

		expect(result.success).toBe(true)
		expect(result.filePath).toContain("alpha-diagnostics-")

		// Verify we attempted to read API history
		expect(fs.readFile).toHaveBeenCalledWith(path.join("/mock/task-dir", "api_conversation_history.json"), "utf8")

		// Verify we wrote a diagnostics file with the expected content
		expect(fs.writeFile).toHaveBeenCalledTimes(1)
		const [writtenPath, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0]
		// taskId.slice(0, 8) = "test-tas" from "test-task-id"
		expect(String(writtenPath)).toContain("alpha-diagnostics-test-tas")
		expect(String(writtenContent)).toContain(
			"// Please review this bounded report before sharing it with Alpha Support (support@alpha.invalid).",
		)
		expect(String(writtenContent)).toContain('"error":')
		expect(String(writtenContent)).toContain('"history":')
		expect(String(writtenContent)).toContain('"version": "1.2.3"')
		expect(String(writtenContent)).toContain('"provider": "test-provider"')
		expect(String(writtenContent)).toContain('"model": "test-model"')
		expect(String(writtenContent)).toContain('"details": {')
		expect(String(writtenContent)).not.toContain("Sample error details")
		expect(String(writtenContent)).toContain('"included": false')
		expect(String(writtenContent)).not.toContain('"content": "test"')

		// Verify VS Code APIs were used to open the generated file
		expect(vscode.workspace.openTextDocument).toHaveBeenCalledTimes(1)
		expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1)
	})

	it("joins bounded lifecycle and event evidence without exporting raw provider content or IDs", async () => {
		const secret = "private-prompt-and-tool-output"
		const files = new Map([
			[
				"agent_lifecycle_events.jsonl",
				[
					{
						version: 1,
						eventId: "event-1",
						taskId: "task-join",
						runId: "run-1",
						turnId: "turn-1",
						stepId: "step-1",
						sequence: 1,
						occurredAt: 10,
						type: "turn_started",
						payload: { phase: "starting" },
					},
					{
						version: 1,
						eventId: "event-2",
						taskId: "task-join",
						runId: "run-1",
						turnId: "turn-1",
						stepId: "step-1",
						sequence: 2,
						occurredAt: 11,
						type: "step_started",
						payload: {},
					},
				]
					.map((event) => JSON.stringify(event))
					.join("\n") + "\n",
			],
			[
				"agent_turn_events.jsonl",
				JSON.stringify({
					taskId: "task-join",
					runId: "run-1",
					turnId: "turn-1",
					stepId: "step-1",
					requestId: "request-1",
					attemptId: "attempt-1",
					sequence: 1,
					timestamp: 11,
					event: { type: "tool_result", callId: "call-1", status: "error", output: secret },
				}) + "\n",
			],
			[
				"agent_lifecycle_snapshot.json",
				JSON.stringify({
					version: 1,
					taskId: "task-join",
					runId: "run-1",
					turnId: "turn-1",
					status: "in_progress",
					phase: "starting",
					lastSequence: 1,
				}),
			],
			[
				"api_conversation_history.json",
				JSON.stringify([
					{ role: "user", content: secret },
					{ role: "assistant", content: [{ type: "tool_use", id: "call-1", input: secret }] },
				]),
			],
			[
				"provider_transcript.json",
				JSON.stringify({ version: 2, revision: 3, taskId: "task-join", digest: "digest-1" }),
			],
		])
		vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
			const name = path.basename(String(filePath))
			const value = files.get(name)
			if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			return value as any
		})

		const result = await generateErrorDiagnostics({
			taskId: "task-join",
			globalStoragePath: "/mock/global/storage",
			values: { details: "provider failed" },
			getRuntimeDiagnostics: () =>
				({
					completion: { lastReasonCode: "private-runtime-code" },
					commands: [{ status: "private-status", toolCallId: secret }],
					obligations: [{ status: "private-obligation", origin: "private-origin", changeSetId: secret }],
				}) as any,
			log: mockLog,
		})
		expect(result.success).toBe(true)
		const report = String(vi.mocked(fs.writeFile).mock.calls.at(-1)?.[1])
		expect(report).not.toContain(secret)
		expect(report).not.toContain("event-1")
		expect(report).not.toContain("call-1")
		expect(report).not.toContain("private-runtime-code")
		expect(report).not.toContain("private-status")
		expect(report).not.toContain("private-obligation")
		expect(report).not.toContain("private-origin")
		expect(report).toContain('"rawProviderHistory": {')
		expect(report).toContain('"status": "captured"')
		expect(report).toContain('"eventLogSequences"')
		expect(report).toContain('"requestIdSha256"')
		const payload = JSON.parse(report.slice(report.indexOf("{")))
		expect(payload.evidence.sources.lifecycle.status).toBe("captured")
		expect(payload.evidence.sources.lifecycle.projection.validationStatus).toBe("validated")
	})

	it("uses empty history when API history file does not exist", async () => {
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(false as any)

		const result = await generateErrorDiagnostics({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			values: {
				timestamp: "2025-01-01T00:00:00.000Z",
				version: "1.0.0",
				provider: "test",
				model: "test",
				details: "error",
			},
			log: mockLog,
		})

		expect(result.success).toBe(true)

		// Missing sources remain explicit evidence markers; no raw history is read
		// into the report when the transcript is absent.
		expect(String(vi.mocked(fs.writeFile).mock.calls[0][1])).toContain('"rawProviderHistory": {')

		// Verify empty history in output
		const [, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0]
		expect(String(writtenContent)).toContain('"history": []')
	})

	it("uses default values when values are not provided", async () => {
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(false as any)

		const result = await generateErrorDiagnostics({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			log: mockLog,
		})

		expect(result.success).toBe(true)

		// Verify defaults in output
		const [, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0]
		expect(String(writtenContent)).toContain('"version": ""')
		expect(String(writtenContent)).toContain('"provider": ""')
		expect(String(writtenContent)).toContain('"model": ""')
		expect(String(writtenContent)).toContain('"details": {')
	})

	it("distinguishes the reported version from the actively loaded installation", async () => {
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(false)
		const result = await generateErrorDiagnostics({
			taskId: "task",
			globalStoragePath: "/mock",
			log: mockLog,
			values: { version: "2.1.18" },
			extension: {
				id: "AlphaInc.alpha",
				isActive: true,
				extensionPath: "/extensions/alphainc.alpha-2.1.28",
				packageJSON: { version: "2.1.28", secret: "do not export" },
			} as unknown as vscode.Extension<unknown>,
		})
		expect(result.success).toBe(true)
		const text = String(vi.mocked(fs.writeFile).mock.calls[0][1])
		expect(text).toContain('"version": "2.1.18"')
		expect(text).toContain('"manifestVersion": "2.1.28"')
		expect(text).toContain('"vscodeVersion": "1.122.1"')
		expect(text).not.toContain("do not export")
	})

	it("retains the original report when runtime diagnostics are unavailable", async () => {
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(false)
		const result = await generateErrorDiagnostics({
			taskId: "task",
			globalStoragePath: "/mock",
			log: mockLog,
			values: { details: "original receipt error" },
			getRuntimeDiagnostics: () => {
				throw new Error("store unavailable")
			},
		})
		expect(result.success).toBe(true)
		const text = String(vi.mocked(fs.writeFile).mock.calls[0][1])
		expect(text).toContain('"unavailable": true')
		expect(text).toContain('"details": {')
		expect(text).toContain('"runtimeVersion":')
	})

	it("does not export a malformed primitive runtime callback payload", async () => {
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(false)
		const result = await generateErrorDiagnostics({
			taskId: "task",
			globalStoragePath: "/mock",
			log: mockLog,
			getRuntimeDiagnostics: () => "private-runtime-value" as any,
		})
		expect(result.success).toBe(true)
		const text = String(vi.mocked(fs.writeFile).mock.calls[0][1])
		expect(text).not.toContain("private-runtime-value")
		expect(text).toContain('"unavailable": true')
	})

	it("marks a source that disappears after lstat as changed evidence", async () => {
		vi.mocked(fs.readFile).mockResolvedValue("[]" as any)
		vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as any)
		const result = await generateErrorDiagnostics({
			taskId: "task",
			globalStoragePath: "/mock",
			log: mockLog,
		})
		expect(result.success).toBe(true)
		const text = String(vi.mocked(fs.writeFile).mock.calls[0][1])
		const payload = JSON.parse(text.slice(text.indexOf("{")))
		expect(payload.evidence.sources.lifecycle).toMatchObject({ status: "incomplete", warning: "SOURCE_CHANGED" })
	})

	it("handles JSON parse error gracefully", async () => {
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true as any)
		vi.mocked(fs.readFile).mockResolvedValue("invalid json" as any)

		const result = await generateErrorDiagnostics({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			values: {
				timestamp: "2025-01-01T00:00:00.000Z",
				version: "1.0.0",
				provider: "test",
				model: "test",
				details: "error",
			},
			log: mockLog,
		})

		// Should still succeed but with empty history
		expect(result.success).toBe(true)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to parse api_conversation_history.json")

		// Verify empty history in output
		const [, writtenContent] = vi.mocked(fs.writeFile).mock.calls[0]
		expect(String(writtenContent)).toContain('"history": []')
	})

	it("returns error result when file write fails", async () => {
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(false as any)
		vi.mocked(fs.writeFile).mockRejectedValue(new Error("Write failed"))

		const result = await generateErrorDiagnostics({
			taskId: "test-task-id",
			globalStoragePath: "/mock/global/storage",
			log: mockLog,
		})

		expect(result.success).toBe(false)
		expect(result.error).toBe("Write failed")
		expect(mockLog).toHaveBeenCalledWith("Error generating diagnostics: Write failed")
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to generate diagnostics: Write failed")
	})
})
