import fs from "fs/promises"
import path from "path"
import * as vscode from "vscode"

import { fileExistsAtPath } from "../../../utils/fs"
import { experiments } from "../../../shared/experiments"
import type { Task } from "../../task/Task"
import { ApplyPatchTool } from "../ApplyPatchTool"
import { DiffViewProvider } from "../../../integrations/editor/DiffViewProvider"

vi.mock("fs/promises", () => {
	const readFile = vi.fn()
	const mkdir = vi.fn()
	const writeFile = vi.fn()
	const unlink = vi.fn()
	return { readFile, mkdir, writeFile, unlink, default: { readFile, mkdir, writeFile, unlink } }
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
		taskKind: "subagent",
		subagentRole: "worker",
		consecutiveMistakeCount: 0,
		didEditFile: false,
		didRejectTool: false,
		rooIgnoreController: { validateAccess: vi.fn(validateAccess) },
		rooProtectedController: { isWriteProtected: vi.fn(() => false) },
		providerRef: {
			deref: () => ({ getState: vi.fn(async () => providerState) }),
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
		processQueuedMessages: vi.fn(),
	} as unknown as Task
}

function createCallbacks(): any {
	return {
		askApproval: vi.fn(async () => true),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
	}
}

describe("ApplyPatchTool", () => {
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

	it("validates every source and destination before reading any hunk", async () => {
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

		expect(mockedFs.readFile).not.toHaveBeenCalled()
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
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Changes were rejected by the user.")
		expect(task.didRejectTool).toBe(true)
		expect(task.recordToolUsage).not.toHaveBeenCalled()
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
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("write complete\n\nwrite complete")
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
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("write complete")
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

		expect(callbacks.handleError).toHaveBeenCalledWith("apply patch", expect.any(Error))
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
		const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(callbacks.handleError).toHaveBeenCalledWith("apply patch", expect.any(Error))
		expect(mockedFs.writeFile).not.toHaveBeenCalled()
		expect(mockedFs.unlink).not.toHaveBeenCalled()
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
				uri: { scheme: "file", fsPath: "/workspace/moved.txt" },
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
		expect(callbacks.handleError).toHaveBeenCalledWith("apply patch", expect.any(Error))
		expect(mockedFs.writeFile).not.toHaveBeenCalled()
		expect(mockedFs.unlink).not.toHaveBeenCalled()
	})

	it("allows the provider's managed dirty source diff during a normal move", async () => {
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
		const sourceAbsolutePath = path.resolve(task.cwd, "source.txt")
		const managedDocument = {
			uri: { scheme: "file", fsPath: sourceAbsolutePath },
			isDirty: true,
			getText: vi.fn().mockReturnValue("new\n"),
		}

		vi.spyOn(provider, "open").mockImplementation(async (relPath) => {
			;(provider as any).isEditing = true
			;(provider as any).relPath = relPath
			;(provider as any).activeDiffEditor = { document: managedDocument }
		})
		vi.spyOn(provider, "update").mockImplementation(async (content) => {
			;(provider as any).newContent = content
		})
		vi.spyOn(provider, "scrollToFirstDiff").mockImplementation(() => undefined)
		vi.spyOn(provider, "reset").mockResolvedValue(undefined)
		task.diffViewProvider = provider
		;(vscode.workspace as any).textDocuments = [managedDocument]

		const callbacks = createCallbacks()
		const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`

		await new ApplyPatchTool().execute({ patch }, task, callbacks as any)

		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(mockedFs.writeFile).toHaveBeenCalledWith(expect.stringContaining("moved.txt"), "new\n", {
			encoding: "utf-8",
			flag: "wx",
		})
		expect(mockedFs.unlink).toHaveBeenCalledWith(expect.stringContaining("source.txt"))
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
