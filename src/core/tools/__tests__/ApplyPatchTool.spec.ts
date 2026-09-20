import fs from "fs/promises"
import os from "os"
import path from "path"
import * as vscode from "vscode"

import { fileExistsAtPath } from "../../../utils/fs"
import { experiments } from "../../../shared/experiments"
import type { Task } from "../../task/Task"
import { ApplyPatchTool } from "../ApplyPatchTool"
import { DiffViewProvider } from "../../../integrations/editor/DiffViewProvider"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { ToolRegistry } from "../ToolRegistry"
import { ToolScheduler } from "../../agent/ToolScheduler"

vi.mock("../../../i18n", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../i18n")>()
	const { default: enTools } = await import("../../../i18n/locales/en/tools.json")
	return {
		...actual,
		t: (key: string, options?: Record<string, unknown>) => {
			const [namespace, translationPath] = key.split(":")
			let value: unknown = namespace === "tools" ? enTools : undefined
			for (const segment of translationPath?.split(".") ?? []) {
				value =
					typeof value === "object" && value !== null
						? (value as Record<string, unknown>)[segment]
						: undefined
			}
			if (typeof value !== "string") return key
			return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? `{{${name}}}`))
		},
	}
})

vi.mock("fs/promises", () => {
	const readFile = vi.fn()
	const mkdir = vi.fn()
	const writeFile = vi.fn()
	const unlink = vi.fn()
	const lstat = vi.fn()
	return { readFile, mkdir, writeFile, unlink, lstat, default: { readFile, mkdir, writeFile, unlink, lstat } }
})

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn(),
	createDirectoriesForFile: vi.fn().mockResolvedValue([]),
}))
vi.mock("../../../shared/experiments", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../shared/experiments")>()
	return { ...actual, experiments: { isEnabled: vi.fn(() => true) } }
})

const mockedFs = vi.mocked(fs)
const mockedFileExists = vi.mocked(fileExistsAtPath)

function createTask(
	validateAccess: (filePath: string) => boolean = () => true,
	providerState: { diagnosticsEnabled: boolean; writeDelayMs: number } = {
		diagnosticsEnabled: true,
		writeDelayMs: 0,
	},
) {
	return {
		cwd: "/workspace",
		getTaskCancellationSignal: vi.fn(() => new AbortController().signal),
		taskKind: "subagent",
		subagentRole: "worker",
		consecutiveMistakeCount: 0,
		didEditFile: false,
		didRejectTool: false,
		alphaIgnoreController: { validateAccess: vi.fn(validateAccess) },
		alphaProtectedController: { isWriteProtected: vi.fn(() => false) },
		providerRef: {
			deref: () => ({
				getState: vi.fn(async () => providerState),
				runWorkspaceMutation: async (_task: unknown, _label: string, run: () => Promise<void>) => run(),
			}),
		},
		diffViewProvider: {
			editType: undefined,
			originalContent: undefined,
			open: vi.fn(),
			update: vi.fn(),
			scrollToFirstDiff: vi.fn(),
			saveDirectly: vi.fn(),
			saveChanges: vi.fn(),
			assertExpectedFileState: vi.fn(async (filePath: string, relPath: string, expected: any) => {
				try {
					const current = await mockedFs.readFile(filePath, "utf8")
					if (!expected.exists || current !== expected.content) {
						throw new Error(`Cannot save '${relPath}': the file changed while approval was pending`)
					}
				} catch (error) {
					if (expected.exists && (error as any)?.code === "ENOENT") {
						throw new Error(`Cannot save '${relPath}': the file was deleted while approval was pending`)
					}
					if (!expected.exists && (error as any)?.code === "ENOENT") {
						return
					}
					throw error
				}
			}),
			pushToolWriteResult: vi.fn(async () => "write complete"),
			reset: vi.fn(),
		},
		fileContextTracker: { trackFileContext: vi.fn() },
		say: vi.fn(),
		recordToolError: vi.fn(),
		recordToolUsage: vi.fn(),
		checkpointSave: vi.fn(),
		processQueuedMessages: vi.fn(),
	} as unknown as Task
}

function createCallbacks(): any {
	return {
		askApproval: vi.fn(async () => true),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
		setResultMetadata: vi.fn(),
	}
}

describe("ApplyPatchTool", () => {
	it("keeps newly created files out of editor tabs during background editing", async () => {
		mockedFileExists.mockResolvedValue(false)
		mockedFs.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
		const task = createTask(() => true, { diagnosticsEnabled: false, writeDelayMs: 0 })
		task.diffViewProvider = new DiffViewProvider(task.cwd, task)
		const openPreview = vi.spyOn(task.diffViewProvider, "open")
		const callbacks = createCallbacks()

		await new ApplyPatchTool().execute(
			{ patch: "*** Begin Patch\n*** Add File: new.txt\n+new content\n*** End Patch" },
			task,
			callbacks,
		)

		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		expect(mockedFs.writeFile).toHaveBeenCalledWith(path.resolve(task.cwd, "new.txt"), "new content\n", {
			encoding: "utf-8",
			flag: "wx",
		})
		expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		expect(openPreview).not.toHaveBeenCalled()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toMatchObject([
			{ path: "new.txt", status: "applied" },
		])
	})

	it("reports committed bytes even if post-write tracking fails", async () => {
		mockedFileExists.mockResolvedValue(false)
		const task = createTask()
		vi.mocked(task.fileContextTracker.trackFileContext).mockRejectedValueOnce(new Error("tracking failed"))
		const callbacks = createCallbacks()
		await new ApplyPatchTool().execute(
			{
				patch: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch",
			},
			task,
			callbacks,
		)
		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toMatchObject([
			{
				path: "first.txt",
				status: "applied",
				reason: expect.stringContaining("Changes saved, but follow-up failed"),
			},
			{ path: "second.txt", status: "skipped" },
		])
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
	})

	it.each([true, false])("preserves update bytes through the real save boundary (direct: %s)", async (direct) => {
		vi.mocked(experiments.isEnabled).mockReturnValue(direct)
		const original = "\uFEFFold\r\nkeep"
		const expected = "\uFEFF$& $$ $' &amp;\r\nkeep"
		mockedFs.readFile.mockResolvedValue(original)
		const task = createTask(() => true, { diagnosticsEnabled: false, writeDelayMs: 0 })
		const provider = new DiffViewProvider(task.cwd, task)
		task.diffViewProvider = provider
		if (!direct) {
			// The editor mock retains the exact approved text; saveChanges still
			// exercises the shared filesystem write and stale-content checks.
			vi.spyOn(provider, "open").mockImplementation(async (relPath, expectedFileState) => {
				Object.assign(provider, { relPath, expectedFileState, originalContent: original, isEditing: true })
			})
			vi.spyOn(provider, "update").mockImplementation(async (content) => {
				Object.assign(provider, {
					newContent: content,
					activeDiffEditor: { document: { getText: () => content, version: 1 } },
				})
			})
			vi.spyOn(provider, "scrollToFirstDiff").mockImplementation(() => {})
		}
		const callbacks = createCallbacks()
		await new ApplyPatchTool().execute(
			{ patch: "*** Begin Patch\n*** Update File: source.txt\n@@\n-old\n+$& $$ $' &amp;\n*** End Patch" },
			task,
			callbacks,
		)
		expect(mockedFs.writeFile).toHaveBeenCalledWith(expect.stringContaining("source.txt"), expected, "utf-8")
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "success" })
	})

	it.each(["denied", "cancelled"])(
		"keeps the first write and publishes the complete ledger after file two is %s",
		async (decision) => {
			mockedFileExists.mockResolvedValue(false)
			const task = createTask()
			const published: unknown[] = []
			Object.assign(task, {
				abort: false,
				userMessageContent: [],
				ask: vi
					.fn()
					.mockResolvedValueOnce({ response: "yesButtonClicked" })
					.mockImplementationOnce(async () => {
						if (decision === "cancelled") task.abort = true
						return {
							response: "noButtonClicked",
							text: decision === "denied" ? "Keep the second file unchanged" : undefined,
						}
					}),
				pushToolResultToUserContent: (result: unknown) => {
					published.push(result)
					return true
				},
			})
			const call = {
				type: "tool_call" as const,
				id: "patch-ledger",
				name: "apply_patch",
				arguments: {
					patch: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** Add File: third.txt\n+third\n*** End Patch",
				},
			}
			const outcome = await new ToolScheduler({
				task,
				registry: new ToolRegistry({ nativeTools: getNativeTools({ includeApplyPatch: true }) }),
				mode: "code",
				preserveAbortedResults: true,
				validateCall: () => {},
			}).run({ items: [call], text: "", reasoning: "", toolCalls: [call] })
			expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledExactlyOnceWith(
				"first.txt",
				"first\n",
				false,
				true,
				0,
				{ exists: false },
			)
			expect(mockedFs.unlink).not.toHaveBeenCalled()
			expect(outcome.results).toHaveLength(1)
			expect(outcome.results[0].status).toBe(decision)
			const content = String(outcome.results[0].content)
			expect(content).toContain('"path":"first.txt","status":"applied"')
			expect(content).toContain('"path":"second.txt","status":"skipped"')
			expect(content).toContain('"path":"third.txt","status":"skipped"')
			if (decision === "denied") expect(content).toContain("Keep the second file unchanged")
			expect(published).toEqual([expect.objectContaining({ tool_use_id: call.id, is_error: true })])
		},
	)

	it.each(["mismatch", "ignored"])("reports every path after %s preflight failure", async (failure) => {
		const task = createTask((filePath) => failure !== "ignored" || filePath !== "second.txt")
		const callbacks = createCallbacks()
		mockedFs.readFile.mockImplementation(async (filePath) =>
			String(filePath).endsWith("second.txt") ? "different\n" : "old\n",
		)
		const patch =
			"*** Begin Patch\n*** Update File: first.txt\n@@\n-old\n+new\n*** Update File: second.txt\n@@\n-old\n+new\n*** Update File: third.txt\n@@\n-old\n+new\n*** End Patch"
		await new ApplyPatchTool().execute({ patch }, task, callbacks)
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toMatchObject([
			{ path: "first.txt", status: "applied" },
			{ path: "second.txt", status: failure === "ignored" ? "skipped" : "error", reason: expect.any(String) },
			{ path: "third.txt", status: "applied" },
		])
		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledTimes(2)
		expect(Math.max(...mockedFs.readFile.mock.invocationCallOrder)).toBeLessThan(
			callbacks.askApproval.mock.invocationCallOrder[0],
		)
		if (failure === "ignored")
			expect(mockedFs.readFile.mock.calls.some(([filePath]) => String(filePath).endsWith("second.txt"))).toBe(
				false,
			)
	})

	it.each([true, false])(
		"reviews an external move destination for a primary task (approved: %s)",
		async (approved) => {
			const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
			mockedFs.readFile.mockImplementation(async (filePath: unknown) => {
				if (String(filePath).endsWith("moved.txt")) throw missing
				return "old\n"
			})
			const task = createTask()
			Object.assign(task, { taskKind: "primary" })
			const callbacks = createCallbacks()
			callbacks.askApproval.mockResolvedValue(approved)
			await new ApplyPatchTool().execute(
				{
					patch: "*** Begin Patch\n*** Update File: source.txt\n*** Move to: ../outside/moved.txt\n@@\n-old\n+new\n*** End Patch",
				},
				task,
				callbacks,
			)
			expect(callbacks.askApproval).toHaveBeenCalledOnce()
			expect(JSON.parse(callbacks.askApproval.mock.calls[0][1])).toMatchObject({
				isOutsideWorkspace: true,
				content: expect.stringContaining("moved.txt"),
			})
			if (approved) {
				expect(task.diffViewProvider.saveDirectly).toHaveBeenCalled()
			} else {
				expect(task.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
				expect(mockedFs.unlink).not.toHaveBeenCalled()
			}
		},
	)

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(experiments.isEnabled).mockReturnValue(true)
		;(vscode.workspace as any).textDocuments = []
		;(vscode.workspace as any).openTextDocument = vi.fn().mockResolvedValue({ isDirty: false })
		;(vscode.window as any).showTextDocument = vi.fn().mockResolvedValue(undefined)
		;(vscode.window as any).tabGroups = { all: [], close: vi.fn() }
		;(vscode.languages as any).getDiagnostics = vi.fn().mockReturnValue([])
		mockedFileExists.mockResolvedValue(true)
		mockedFs.readFile.mockResolvedValue("old\n")
		mockedFs.mkdir.mockResolvedValue(undefined)
		mockedFs.writeFile.mockResolvedValue(undefined)
		mockedFs.unlink.mockResolvedValue()
	})

	it("skips ignored paths before reading their contents", async () => {
		const task = createTask((filePath) => filePath !== "ignored.txt")
		const callbacks = createCallbacks()
		const patch = `*** Begin Patch
*** Update File: allowed.txt
@@
-old
+new
*** Delete File: ignored.txt
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(mockedFs.readFile).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("allowed.txt"), "utf8")
		expect(task.say).toHaveBeenCalledWith("rooignore_error", "ignored.txt")
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
	})

	it("stops a multi-file patch after the first denial and emits one result", async () => {
		mockedFileExists.mockResolvedValue(false)
		const task = createTask()
		const callbacks = createCallbacks()
		callbacks.askApproval.mockResolvedValue(false)
		const patch = `*** Begin Patch
*** Add File: first.txt
+first
*** Add File: second.txt
+second
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(callbacks.askApproval).toHaveBeenCalledTimes(1)
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toEqual([
			{ path: "first.txt", status: "skipped", reason: "Changes were rejected by the user." },
			{ path: "second.txt", status: "skipped", reason: "Not attempted after denied in first.txt" },
		])
		expect(task.didRejectTool).toBe(true)
		expect(task.recordToolUsage).not.toHaveBeenCalled()
	})

	it("passes an expected-missing baseline to an add preview", async () => {
		vi.mocked(experiments.isEnabled).mockReturnValue(false)
		mockedFileExists.mockResolvedValue(false)
		const task = createTask()
		const callbacks = createCallbacks()
		const patch = `*** Begin Patch
*** Add File: new.txt
+new content
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(task.diffViewProvider.open).toHaveBeenCalledWith("new.txt", { exists: false })
	})

	it("passes the raw source baseline to an update preview", async () => {
		vi.mocked(experiments.isEnabled).mockReturnValue(false)
		const rawBaseline = "old\r\n"
		mockedFs.readFile.mockResolvedValueOnce(rawBaseline)
		const task = createTask()
		const callbacks = createCallbacks()
		const patch = `*** Begin Patch
*** Update File: source.txt
@@
-old
+new
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(task.diffViewProvider.open).toHaveBeenCalledWith("source.txt", {
			exists: true,
			content: rawBaseline,
		})
	})

	it("aggregates successful multi-file results into one native tool result", async () => {
		mockedFileExists.mockResolvedValue(false)
		const task = createTask()
		const callbacks = createCallbacks()
		const patch = `*** Begin Patch
*** Add File: first.txt
+first
*** Add File: second.txt
+second
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledTimes(2)
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toEqual([
			{ path: "first.txt", status: "applied", result: "write complete" },
			{ path: "second.txt", status: "applied", result: "write complete" },
		])
		expect(task.recordToolUsage).toHaveBeenCalledWith("apply_patch")
	})

	it("treats a move to the same resolved path as an in-place update", async () => {
		const task = createTask()
		const callbacks = createCallbacks()
		const patch = `*** Begin Patch
*** Update File: same.txt
*** Move to: same.txt
@@
-old
+new
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledWith("same.txt", "new\n", false, true, 0, {
			exists: true,
			content: "old\n",
		})
		expect(mockedFs.unlink).not.toHaveBeenCalled()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toMatchObject([
			{ path: "same.txt", status: "applied", result: "write complete" },
		])
	})

	it("captures the existing move destination before approval and rejects a concurrent edit", async () => {
		let destinationContent = "destination\n"
		mockedFs.readFile.mockImplementation(async (filePath: any) => {
			if (String(filePath).endsWith("moved.txt")) {
				return destinationContent
			}

			return "old\n"
		})

		const task = createTask()
		const callbacks = createCallbacks()
		callbacks.askApproval.mockImplementation(async () => {
			destinationContent = "user edit\n"
			return true
		})
		;(task.diffViewProvider.saveDirectly as any).mockImplementation(async (...args: any[]) => {
			const expected = args[5] as { exists: true; content: string }
			expect(expected).toEqual({ exists: true, content: "destination\n" })
			const current = await mockedFs.readFile("moved.txt", "utf8")
			if (current !== expected.content) {
				throw new Error("Cannot save: the destination changed while approval was pending")
			}
		})
		const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toMatchObject([
			{ path: "source.txt", status: "error", reason: expect.stringMatching(/changed|unsaved changes/) },
		])
		const approvalMessage = JSON.parse((callbacks.askApproval as any).mock.calls[0][1] as string) as {
			content: string
		}
		expect(approvalMessage.content).toContain("Move destination: moved.txt")
		expect(mockedFs.unlink).not.toHaveBeenCalled()
		expect(task.didEditFile).toBe(false)
	})

	it("guards the destination on the normal diff-view move path", async () => {
		vi.mocked(experiments.isEnabled).mockReturnValue(false)
		let destinationContent = "destination\n"
		mockedFs.readFile.mockImplementation(async (filePath: any) => {
			if (String(filePath).endsWith("moved.txt")) {
				return destinationContent
			}

			return "old\n"
		})
		const task = createTask()
		const callbacks = createCallbacks()
		callbacks.askApproval.mockImplementation(async () => {
			destinationContent = "user edit\n"
			return true
		})
		;(task.diffViewProvider.saveChanges as any).mockImplementation(async (...args: any[]) => {
			const saveTo = args[2] as { relPath: string; expectedFileState: { exists: true; content: string } }
			const current = await mockedFs.readFile(saveTo.relPath, "utf8")
			if (current !== saveTo.expectedFileState.content) {
				throw new Error("Cannot save: the destination changed while approval was pending")
			}
		})
		const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toMatchObject([
			{ path: "source.txt", status: "error", reason: expect.stringMatching(/changed|unsaved changes/) },
		])
		expect(mockedFs.writeFile).not.toHaveBeenCalled()
		expect(mockedFs.unlink).not.toHaveBeenCalled()
		expect(task.diffViewProvider.saveChanges).toHaveBeenCalledWith(true, 0, {
			relPath: "moved.txt",
			expectedFileState: { exists: true, content: "destination\n" },
		})
	})

	it("rejects a dirty destination document before a normal move approval", async () => {
		vi.mocked(experiments.isEnabled).mockReturnValue(false)
		mockedFs.readFile.mockImplementation(async (filePath: any) => {
			if (String(filePath).endsWith("moved.txt")) {
				return "destination\n"
			}

			return "old\n"
		})
		;(vscode.workspace as any).textDocuments = [
			{
				uri: { scheme: "file", fsPath: path.resolve("/workspace/moved.txt") },
				isDirty: true,
			},
		]
		const task = createTask()
		const provider = new DiffViewProvider(task.cwd, task)
		task.diffViewProvider = provider
		const callbacks = createCallbacks()
		const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toMatchObject([
			{ path: "source.txt", status: "error", reason: expect.stringMatching(/changed|unsaved changes/) },
		])
		expect(mockedFs.writeFile).not.toHaveBeenCalled()
		expect(mockedFs.unlink).not.toHaveBeenCalled()
	})

	it("does not save a move when the source preview rejects a dirty source", async () => {
		vi.mocked(experiments.isEnabled).mockReturnValue(false)
		const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
		mockedFs.readFile.mockImplementation(async (filePath: any) => {
			if (String(filePath).endsWith("moved.txt")) {
				throw missing
			}

			return "old\n"
		})

		const task = createTask(() => true, { diagnosticsEnabled: false, writeDelayMs: 0 })
		const provider = new DiffViewProvider(task.cwd, task)
		vi.spyOn(provider, "open").mockImplementation(async (_relPath, expectedFileState) => {
			expect(expectedFileState).toEqual({ exists: true, content: "old\n" })
			throw new Error("The source file has unsaved changes")
		})
		task.diffViewProvider = provider

		const callbacks = createCallbacks()
		const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toMatchObject([
			{ path: "source.txt", status: "error", reason: expect.stringMatching(/changed|unsaved changes/) },
		])
		expect(mockedFs.writeFile).not.toHaveBeenCalled()
		expect(mockedFs.unlink).not.toHaveBeenCalled()
	})

	it("moves to a missing destination through the real direct save guard", async () => {
		const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
		mockedFs.readFile.mockImplementation(async (filePath: any) => {
			if (String(filePath).endsWith("moved.txt")) {
				throw missing
			}

			return "old\n"
		})
		const task = createTask(() => true, { diagnosticsEnabled: false, writeDelayMs: 0 })
		const provider = new DiffViewProvider(task.cwd, task)
		task.diffViewProvider = provider
		const callbacks = createCallbacks()
		const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(mockedFs.writeFile).toHaveBeenCalledWith(expect.stringContaining("moved.txt"), "new\n", {
			encoding: "utf-8",
			flag: "wx",
		})
		expect(mockedFs.unlink).toHaveBeenCalledWith(expect.stringContaining("source.txt"))
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("reports a failed source cleanup instead of claiming a move succeeded", async () => {
		mockedFs.unlink.mockRejectedValueOnce(new Error("locked"))
		const task = createTask()
		const callbacks = createCallbacks()
		const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(callbacks.pushToolResult.mock.calls[0][0]).toContain("failed to remove original")
		expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
		expect(task.recordToolUsage).not.toHaveBeenCalled()
		expect(task.processQueuedMessages).toHaveBeenCalledOnce()
	})
})

describe("ApplyPatchTool deletion protection", () => {
	let realFs: typeof fs
	let directory: string
	let target: string
	let task: Task
	let callbacks: ReturnType<typeof createCallbacks>
	const patch = "*** Begin Patch\n*** Delete File: target.txt\n*** End Patch"

	beforeAll(async () => {
		realFs = await vi.importActual<typeof fs>("fs/promises")
	})

	beforeEach(async () => {
		vi.clearAllMocks()
		mockedFs.readFile.mockImplementation(realFs.readFile)
		mockedFs.unlink.mockImplementation(realFs.unlink)
		mockedFs.lstat.mockImplementation(realFs.lstat)
		mockedFileExists.mockImplementation(async (filePath) => {
			try {
				await realFs.access(filePath)
				return true
			} catch {
				return false
			}
		})
		directory = await realFs.mkdtemp(path.join(os.tmpdir(), "alpha-delete-"))
		target = path.join(directory, "target.txt")
		await realFs.writeFile(target, "approved content\n")
		;(vscode.workspace as any).textDocuments = []
		task = Object.assign(createTask(), { cwd: directory })
		task.diffViewProvider = new DiffViewProvider(directory, task)
		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		callbacks = createCallbacks()
		callbacks.setResultMetadata = vi.fn()
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		;(vscode.workspace as any).textDocuments = []
		if (
			path.dirname(directory) !== path.resolve(os.tmpdir()) ||
			!path.basename(directory).startsWith("alpha-delete-")
		) {
			throw new Error("Unexpected deletion fixture path")
		}
		await realFs.rm(directory, { recursive: true, force: true })
	})

	async function waitForApproval(patchText = patch) {
		let signalEntered!: () => void
		let decide!: (approved: boolean) => void
		const entered = new Promise<void>((resolve) => (signalEntered = resolve))
		const decision = new Promise<boolean>((resolve) => (decide = resolve))
		callbacks.askApproval.mockImplementation(() => {
			signalEntered()
			return decision
		})
		const execution = new ApplyPatchTool().execute({ patch: patchText }, task, callbacks)
		await Promise.race([
			entered,
			execution.then(() => {
				throw new Error("Deletion finished before reaching approval")
			}),
		])
		return async (approved = true) => {
			decide(approved)
			await execution
		}
	}

	function expectNoDeletion() {
		expect(mockedFs.unlink).not.toHaveBeenCalled()
		expect(task.didEditFile).toBe(false)
		expect(task.recordToolUsage).not.toHaveBeenCalled()
		expect(task.processQueuedMessages).not.toHaveBeenCalled()
		expect(JSON.stringify(callbacks.pushToolResult.mock.calls)).not.toContain("Successfully deleted")
	}

	function dirtyDocument() {
		const document = {
			uri: { scheme: "file", fsPath: target },
			isDirty: true,
			getText: vi.fn(() => "unsaved user content\n"),
			save: vi.fn(),
		}
		;(vscode.workspace as any).textDocuments = [document]
		return document
	}

	it("preserves committed CRLF/BOM bytes and an external edit to file two through the real save guard", async () => {
		const first = path.join(directory, "first.txt")
		const third = path.join(directory, "third.txt")
		await realFs.writeFile(first, "\uFEFFold\r\nkeep")
		await realFs.writeFile(target, "old\n")
		await realFs.writeFile(third, "old\n")
		mockedFs.writeFile.mockImplementation(realFs.writeFile)
		vi.mocked(experiments.isEnabled).mockReturnValue(true)
		callbacks.askApproval.mockImplementationOnce(async () => {
			await realFs.writeFile(target, "user edit during approval\n")
			return true
		})
		await new ApplyPatchTool().execute(
			{
				patch: "*** Begin Patch\n*** Update File: first.txt\n@@\n-old\n+$& $$ $'\n*** Update File: target.txt\n@@\n-old\n+new\n*** Update File: third.txt\n@@\n-old\n+new\n*** End Patch",
			},
			task,
			callbacks,
		)
		expect(await realFs.readFile(first)).toEqual(Buffer.from("\uFEFF$& $$ $'\r\nkeep"))
		expect(await realFs.readFile(target, "utf8")).toBe("user edit during approval\n")
		expect(await realFs.readFile(third, "utf8")).toBe("old\n")
		expect(mockedFs.writeFile).toHaveBeenCalledOnce()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0]).files).toMatchObject([
			{ path: "first.txt", status: "applied" },
			{
				path: "target.txt",
				status: "error",
				reason: expect.stringContaining("changed while approval was pending"),
			},
			{ path: "third.txt", status: "skipped", reason: expect.stringContaining("target.txt") },
		])
	})

	it("deletes an unchanged file only after approval and preserves the protected approval flag", async () => {
		vi.mocked(task.alphaProtectedController!.isWriteProtected).mockReturnValue(true)
		const approve = await waitForApproval()
		expect(await realFs.readFile(target, "utf8")).toBe("approved content\n")
		expect(mockedFs.unlink).not.toHaveBeenCalled()
		expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.any(String), undefined, true)
		await approve()
		await expect(realFs.access(target)).rejects.toMatchObject({ code: "ENOENT" })
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("Successfully deleted target.txt"),
		)
		expect(task.didEditFile).toBe(true)
		expect(task.recordToolUsage).toHaveBeenCalledExactlyOnceWith("apply_patch")
	})

	it("reports a missing file without requesting approval", async () => {
		await realFs.unlink(target)
		await new ApplyPatchTool().execute({ patch }, task, callbacks)
		expectNoDeletion()
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("ENOENT"))
	})

	it("preserves disk edits made while approval is pending and stops the rest of the patch", async () => {
		const later = path.join(directory, "later.txt")
		await realFs.writeFile(later, "later content\n")
		const approve = await waitForApproval(
			patch.replace("*** End Patch", "*** Delete File: later.txt\n*** End Patch"),
		)
		await realFs.writeFile(target, "user changed the file\n")
		await approve()
		expectNoDeletion()
		expect(await realFs.readFile(target, "utf8")).toBe("user changed the file\n")
		expect(await realFs.readFile(later, "utf8")).toBe("later content\n")
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("changed while approval was pending"),
		)
		expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
		expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "error" })
	})

	it("reports an external deletion during approval as a conflict", async () => {
		const approve = await waitForApproval()
		await realFs.unlink(target)
		await approve()
		expectNoDeletion()
		await expect(realFs.access(target)).rejects.toMatchObject({ code: "ENOENT" })
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("deleted while approval was pending"),
		)
	})

	it("preserves a later target edited while the first deletion awaits approval", async () => {
		const first = path.join(directory, "first.txt")
		await realFs.writeFile(first, "first content\n")
		const approve = await waitForApproval(
			patch.replace("*** Begin Patch", "*** Begin Patch\n*** Delete File: first.txt"),
		)
		await realFs.writeFile(target, "user edited the later target\n")
		await approve()
		expect(mockedFs.unlink).toHaveBeenCalledExactlyOnceWith(first)
		expect(await realFs.readFile(target, "utf8")).toBe("user edited the later target\n")
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("changed while approval was pending"),
		)
		expect(JSON.stringify(callbacks.pushToolResult.mock.calls)).not.toContain("Successfully deleted target.txt")
		expect(task.recordToolUsage).not.toHaveBeenCalled()
	})

	it("publishes a multi-file deletion conflict as an error receipt through the scheduler", async () => {
		const first = path.join(directory, "first.txt")
		await realFs.writeFile(first, "first content\n")
		const published: unknown[] = []
		Object.assign(task, {
			abort: false,
			taskId: "deletion-receipt",
			userMessageContent: [],
			ask: vi.fn(async () => {
				await realFs.writeFile(target, "user edited during first approval\n")
				return { response: "yesButtonClicked" }
			}),
			pushToolResultToUserContent: (result: unknown) => {
				published.push(result)
				return true
			},
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			name: "apply_patch",
			aliases: [],
			schema: {
				type: "function",
				function: {
					name: "apply_patch",
					description: "Apply a patch",
					parameters: { type: "object", properties: { patch: { type: "string" } } },
				},
			},
			capabilities: { concurrency: "serial", sideEffects: "task", controlFlow: false, requiresApproval: true },
			execute: async ({ task: executionTask, call, callbacks: executionCallbacks }) => {
				await new ApplyPatchTool().execute(
					call.nativeArgs as { patch: string },
					executionTask,
					executionCallbacks,
				)
			},
		})
		const call = {
			type: "tool_call" as const,
			id: "delete-two-files",
			name: "apply_patch",
			arguments: { patch: patch.replace("*** Begin Patch", "*** Begin Patch\n*** Delete File: first.txt") },
		}
		const outcome = await new ToolScheduler({ task, registry, mode: "code", validateCall: () => {} }).run({
			items: [call],
			text: "",
			reasoning: "",
			toolCalls: [call],
		})
		expect(mockedFs.unlink).toHaveBeenCalledExactlyOnceWith(first)
		expect(await realFs.readFile(target, "utf8")).toBe("user edited during first approval\n")
		expect(outcome.results[0].status).toBe("error")
		expect(published).toEqual([
			expect.objectContaining({ type: "tool_result", tool_use_id: call.id, is_error: true }),
		])
	})

	it.each(["replacement content\n", "approved content\n"])(
		"preserves a replacement file during approval with contents %j",
		async (content) => {
			const replacement = path.join(directory, "replacement.txt")
			await realFs.writeFile(replacement, content)
			const approve = await waitForApproval()
			await realFs.unlink(target)
			await realFs.rename(replacement, target)
			await approve()
			expectNoDeletion()
			expect(await realFs.readFile(target, "utf8")).toBe(content)
			expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
		},
	)

	it("rejects an existing dirty editor without saving or requesting approval", async () => {
		const document = dirtyDocument()
		await new ApplyPatchTool().execute({ patch }, task, callbacks)
		expectNoDeletion()
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(document.save).not.toHaveBeenCalled()
		expect(document.getText()).toBe("unsaved user content\n")
		expect(await realFs.readFile(target, "utf8")).toBe("approved content\n")
	})

	it("preserves a buffer made dirty while approval is pending", async () => {
		const approve = await waitForApproval()
		const document = dirtyDocument()
		await approve()
		expectNoDeletion()
		expect(document.save).not.toHaveBeenCalled()
		expect(document.isDirty).toBe(true)
		expect(await realFs.readFile(target, "utf8")).toBe("approved content\n")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("unsaved changes"))
		expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "error" })
	})

	it.each(["dirty editor", "cancellation"])("rechecks %s after the final filesystem await", async (change) => {
		const controller = new AbortController()
		callbacks.signal = controller.signal
		const approve = await waitForApproval()
		let validationFinished = false
		mockedFs.lstat.mockImplementationOnce(async (...args: Parameters<typeof fs.lstat>) => {
			const stat = await realFs.lstat(...args)
			if (change === "dirty editor") dirtyDocument()
			else controller.abort()
			validationFinished = true
			return stat
		})
		await approve()
		expect(validationFinished).toBe(true)
		expectNoDeletion()
		expect(await realFs.readFile(target, "utf8")).toBe("approved content\n")
	})

	it("reports an unlink failure without marking the patch successful", async () => {
		const approve = await waitForApproval()
		mockedFs.unlink.mockRejectedValueOnce(Object.assign(new Error("file is locked"), { code: "EPERM" }))
		await approve()
		expect(mockedFs.unlink).toHaveBeenCalledExactlyOnceWith(target)
		expect(await realFs.readFile(target, "utf8")).toBe("approved content\n")
		expect(task.didEditFile).toBe(false)
		expect(task.recordToolUsage).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("file is locked"))
		expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "error" })
	})

	it("preserves edits when the user denies deletion", async () => {
		const approve = await waitForApproval()
		await realFs.writeFile(target, "user content after denial\n")
		const document = dirtyDocument()
		await approve(false)
		expectNoDeletion()
		expect(document.save).not.toHaveBeenCalled()
		expect(await realFs.readFile(target, "utf8")).toBe("user content after denial\n")
		expect(task.didRejectTool).toBe(true)
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("Delete operation was rejected by the user."),
		)
		expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "denied" })
	})

	it.each(["signal", "task"])("preserves the file when %s cancellation arrives during approval", async (kind) => {
		const controller = new AbortController()
		callbacks.signal = controller.signal
		const approve = await waitForApproval()
		if (kind === "signal") controller.abort()
		else task.abort = true
		await approve()
		expectNoDeletion()
		expect(await realFs.readFile(target, "utf8")).toBe("approved content\n")
		expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" })
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("Delete operation was cancelled."),
		)
		expect(task.recordToolError).not.toHaveBeenCalled()
	})
})
