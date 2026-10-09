import { CodebaseSearchTool } from "../CodebaseSearchTool"
import { CodeIndexManager } from "../../../services/code-index/manager"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"

vi.mock("../../../services/code-index/manager", () => ({ CodeIndexManager: { getInstance: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

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
	const diagnostics = {
		candidateLimit: 200,
		semanticCandidates: 1,
		lexicalCandidates: 1,
		fusedCandidates: 1,
		effectiveMaxResults: 50,
		contextTokenBudget: 6000,
		estimatedContextTokens: 70,
		returnedChunks: 1,
		candidatesExamined: 1,
		skippedDuplicates: 0,
		skippedBudget: 0,
		skippedSource: 0,
		skippedInvalid: 0,
		remainingCandidates: 0,
	}
	const searchIndexWithDiagnostics = vi.fn().mockResolvedValue({
		diagnostics,
		results: [
			{
				id: "chunk",
				score: 0.9,
				scoreType: "hybrid",
				semanticScore: 0.81,
				lexicalScore: 4.2,
				payload: {
					filePath: "src/state.ts",
					codeChunk: "return ready",
					context: "class State\nisReady()",
					startLine: 4,
					endLine: 4,
				},
			},
		],
	})
	vi.mocked(CodeIndexManager.getInstance).mockReturnValue({
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		searchIndexWithDiagnostics,
	} as unknown as CodeIndexManager)
	await new CodebaseSearchTool().execute({ query: "isReady", path: "src" }, task, callbacks)
	// Foreground editor selection must not redirect a background task's search.
	const call = vi.mocked(CodeIndexManager.getInstance).mock.calls[0]
	// The native VS Code context is opaque to the tool.
	expect(call).toEqual([context, task.cwd])
	expect(searchIndexWithDiagnostics).toHaveBeenCalledWith("isReady", "src")
	expect(callbacks.handleError).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Context: class State\nisReady()"))
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Hybrid rank score: 0.9"))
	const [, message] = vi.mocked(task.say).mock.calls[0]
	expect(JSON.parse(message!)).toMatchObject({
		content: { diagnostics, results: [{ scoreType: "hybrid", semanticScore: 0.81, lexicalScore: 4.2 }] },
	})
})

it("does not retrieve or publish evidence when approval is denied", async () => {
	const task = { cwd: "F:/workspace", say: vi.fn() } as unknown as Task
	const callbacks = {
		askApproval: vi.fn().mockResolvedValue(false),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
	} as unknown as ToolCallbacks
	await new CodebaseSearchTool().execute({ query: "ready" }, task, callbacks)
	expect(CodeIndexManager.getInstance).not.toHaveBeenCalled()
	expect(task.say).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
})

it.each([false, true])("publishes honest empty-search coverage and finalizes once (partial=%s)", async (partial) => {
	const task = {
		cwd: "F:/workspace",
		providerRef: { deref: () => ({ context: {} }) },
		say: vi.fn(),
	} as unknown as Task
	const callbacks = {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
	} as unknown as ToolCallbacks
	vi.mocked(CodeIndexManager.getInstance).mockReturnValue({
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		searchIndexWithDiagnostics: vi.fn().mockResolvedValue({
			results: [],
			diagnostics: { returnedChunks: 0, skippedSource: 2, ...(partial ? { semanticStatus: "timeout" } : {}) },
		}),
	} as unknown as CodeIndexManager)
	await new CodebaseSearchTool().execute({ query: "ready" }, task, callbacks)
	expect(task.say).toHaveBeenCalledTimes(1)
	const [, message] = vi.mocked(task.say).mock.calls[0]
	expect(JSON.parse(message!)).toMatchObject({
		content: { results: [], diagnostics: { returnedChunks: 0, skippedSource: 2 } },
	})
	expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(
		expect.stringContaining('No relevant code snippets found for the query: "ready"'),
	)
	if (partial)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Search coverage is partial"))
	expect(callbacks.handleError).not.toHaveBeenCalled()
})
