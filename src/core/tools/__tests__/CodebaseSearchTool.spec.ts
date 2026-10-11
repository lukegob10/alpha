import { CodebaseSearchTool } from "../CodebaseSearchTool"
import { CodeIndexManager } from "../../../services/code-index/manager"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { ToolRegistry } from "../ToolRegistry"
import type { ToolUse } from "../../../shared/tools"

vi.mock("../../../services/code-index/manager", () => ({ CodeIndexManager: { getInstance: vi.fn() } }))
vi.mock("../../../i18n", async () => {
	const { default: messages } = await import("../../../i18n/locales/en/embeddings.json")
	const resources: Record<string, unknown> = messages
	return {
		t: (key: string) => {
			const value = resources[key.replace(/^embeddings:/, "")]
			return typeof value === "string" ? value : key
		},
	}
})

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
	const controller = new AbortController()
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
	const descriptor = new ToolRegistry().resolve("codebase_search")!
	await descriptor.execute({
		task,
		call: {
			type: "tool_use",
			id: "hybrid-search",
			name: "codebase_search",
			params: {},
			nativeArgs: { query: "isReady", path: "src" },
			partial: false,
		} as ToolUse<"codebase_search">,
		signal: controller.signal,
		callbacks,
	})
	// Foreground editor selection must not redirect a background task's search.
	const call = vi.mocked(CodeIndexManager.getInstance).mock.calls[0]
	// The native VS Code context is opaque to the tool.
	expect(call).toEqual([context, task.cwd])
	expect(searchIndexWithDiagnostics).toHaveBeenCalledWith("isReady", "src", controller.signal)
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
		setResultMetadata: vi.fn(),
	} as unknown as ToolCallbacks
	await new CodebaseSearchTool().execute({ query: "ready" }, task, callbacks)
	expect(CodeIndexManager.getInstance).not.toHaveBeenCalled()
	expect(task.say).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
	expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "denied" })
})

it.each(["current", "partial", "catching-up"] as const)(
	"publishes honest empty-search coverage and finalizes once (%s)",
	async (coverage) => {
		const partial = coverage === "partial"
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
				diagnostics: {
					returnedChunks: 0,
					skippedSource: 2,
					indexFreshness: coverage === "catching-up" ? "catching-up" : "current",
					...(partial ? { semanticStatus: "timeout" } : {}),
				},
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
		if (partial) {
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Search coverage is partial"))
		}
		if (coverage === "catching-up") {
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("The code index is incomplete"),
			)
		}
		if (coverage !== "current") {
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("exec_command with rg"))
			expect(callbacks.pushToolResult).not.toHaveBeenCalledWith(expect.stringMatching(/read_file|search_files/))
		}
		expect(callbacks.handleError).not.toHaveBeenCalled()
	},
)

it("does not publish late search evidence after cancellation", async () => {
	const controller = new AbortController()
	let complete!: (value: { results: []; diagnostics: Record<string, never> }) => void
	let started!: () => void
	const entered = new Promise<void>((resolve) => {
		started = resolve
	})
	const search = new Promise<{ results: []; diagnostics: Record<string, never> }>((resolve) => {
		complete = resolve
	})
	const searchIndexWithDiagnostics = vi.fn(() => {
		started()
		return search
	})
	vi.mocked(CodeIndexManager.getInstance).mockReturnValue({
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		searchIndexWithDiagnostics,
	} as unknown as CodeIndexManager)
	const task = {
		cwd: "F:/workspace",
		providerRef: { deref: () => ({ context: {} }) },
		say: vi.fn(),
	} as unknown as Task
	const callbacks = {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		signal: controller.signal,
	} as unknown as ToolCallbacks
	const pending = new CodebaseSearchTool().execute({ query: "authentication" }, task, callbacks)
	const reason = new DOMException("Task stopped", "AbortError")
	const cancelled = expect(pending).rejects.toBe(reason)
	await entered
	controller.abort(reason)
	complete({ results: [], diagnostics: {} })
	await cancelled
	expect(searchIndexWithDiagnostics).toHaveBeenCalledWith("authentication", undefined, controller.signal)
	expect(task.say).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	expect(callbacks.handleError).not.toHaveBeenCalled()
})
