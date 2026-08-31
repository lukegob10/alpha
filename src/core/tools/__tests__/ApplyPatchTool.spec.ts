import fs from "fs/promises"

import { fileExistsAtPath } from "../../../utils/fs"
import type { Task } from "../../task/Task"
import { ApplyPatchTool } from "../ApplyPatchTool"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn(),
		mkdir: vi.fn(),
		writeFile: vi.fn(),
		unlink: vi.fn(),
	},
}))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn() }))
vi.mock("../../../shared/experiments", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../shared/experiments")>()
	return { ...actual, experiments: { isEnabled: vi.fn(() => true) } }
})

const mockedFs = vi.mocked(fs)
const mockedFileExists = vi.mocked(fileExistsAtPath)

function createTask(validateAccess: (filePath: string) => boolean = () => true) {
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
			deref: () => ({ getState: vi.fn(async () => ({ diagnosticsEnabled: true, writeDelayMs: 0 })) }),
		},
		diffViewProvider: {
			editType: undefined,
			originalContent: undefined,
			saveDirectly: vi.fn(),
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

function createCallbacks() {
	return {
		askApproval: vi.fn(async () => true),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
	}
}

describe("ApplyPatchTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockedFileExists.mockResolvedValue(true)
		mockedFs.readFile.mockResolvedValue("old\n")
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

		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledWith("same.txt", "new\n", false, true, 0)
		expect(mockedFs.unlink).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("write complete")
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
