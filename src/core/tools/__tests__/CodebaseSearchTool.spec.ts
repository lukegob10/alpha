import { CodebaseSearchTool } from "../CodebaseSearchTool"
import { CodeIndexManager } from "../../../services/code-index/manager"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"

vi.mock("../../../services/code-index/manager", () => ({ CodeIndexManager: { getInstance: vi.fn() } }))

it("searches the task workspace and returns enclosing symbol context", async () => {
	const context = {}
	const task = {
		cwd: "F:/second-workspace",
		consecutiveMistakeCount: 0,
		providerRef: { deref: () => ({ context }) },
		say: vi.fn(),
	} as unknown as Task
	const callbacks = {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
	} as unknown as ToolCallbacks
	const searchIndex = vi.fn().mockResolvedValue([
		{
			id: "chunk",
			score: 0.9,
			payload: {
				filePath: "src/state.ts",
				codeChunk: "return ready",
				context: "class State\nisReady()",
				startLine: 4,
				endLine: 4,
			},
		},
	])
	vi.mocked(CodeIndexManager.getInstance).mockReturnValue({
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		searchIndex,
	} as unknown as CodeIndexManager)
	await new CodebaseSearchTool().execute({ query: "isReady", path: "src" }, task, callbacks)
	// Foreground editor selection must not redirect a background task's search.
	const call = vi.mocked(CodeIndexManager.getInstance).mock.calls[0]
	// The native VS Code context is opaque to the tool.
	expect(call).toEqual([context, task.cwd])
	expect(searchIndex).toHaveBeenCalledWith("isReady", "src")
	expect(callbacks.handleError).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Context: class State\nisReady()"))
})
