// npx vitest core/webview/__tests__/webviewMessageHandler.searchFiles.spec.ts

import type { Mock } from "vitest"

// Mock dependencies - must come before imports
vi.mock("../../../services/search/file-search")
vi.mock("../../ignore/AlphaIgnoreController")

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { AlphaProvider } from "../AlphaProvider"
import { searchWorkspaceFiles } from "../../../services/search/file-search"
import { AlphaIgnoreController } from "../../ignore/AlphaIgnoreController"

const mockSearchWorkspaceFiles = searchWorkspaceFiles as Mock<typeof searchWorkspaceFiles>

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
	},
}))

describe("webviewMessageHandler - searchFiles with AlphaIgnore filtering", () => {
	let mockAlphaProvider: AlphaProvider
	let mockFilterPaths: Mock
	let mockDispose: Mock
	let getSetting: Mock

	beforeEach(() => {
		vi.clearAllMocks()

		// Spy on the mock AlphaIgnoreController prototype methods
		mockFilterPaths = vi.fn()
		mockDispose = vi.fn()
		getSetting = vi.fn()

		// Override the filterPaths method on the prototype
		;(AlphaIgnoreController.prototype as any).filterPaths = mockFilterPaths
		;(AlphaIgnoreController.prototype as any).initialize = vi.fn().mockResolvedValue(undefined)
		;(AlphaIgnoreController.prototype as any).dispose = mockDispose

		// Create mock AlphaProvider
		mockAlphaProvider = {
			contextProxy: { getValue: getSetting },
			getState: vi.fn(),
			postMessageToWebview: vi.fn(),
			getCurrentTask: vi.fn(),
			cwd: "/mock/workspace",
		} as unknown as AlphaProvider
	})

	it("should filter results using AlphaIgnoreController when showAlphaIgnoredFiles is false", async () => {
		// Setup mock results from file search
		const mockResults = [
			{ path: "src/index.ts", type: "file" as const, label: "index.ts" },
			{ path: "secrets/config.json", type: "file" as const, label: "config.json" },
			{ path: "src/utils.ts", type: "file" as const, label: "utils.ts" },
		]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		getSetting.mockReturnValue(false)

		// Setup filter to exclude secrets folder
		mockFilterPaths.mockReturnValue(["src/index.ts", "src/utils.ts"])

		// No current task, so temporary controller will be created
		;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-123",
		})
		expect(mockAlphaProvider.getState).not.toHaveBeenCalled()

		// Verify filterPaths was called with all result paths
		expect(mockFilterPaths).toHaveBeenCalledWith(["src/index.ts", "secrets/config.json", "src/utils.ts"])

		// Verify filtered results were sent to webview
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: [
				{ path: "src/index.ts", type: "file", label: "index.ts" },
				{ path: "src/utils.ts", type: "file", label: "utils.ts" },
			],
			requestId: "test-request-123",
		})
	})

	it("should not filter results when showAlphaIgnoredFiles is true", async () => {
		// Setup mock results from file search
		const mockResults = [
			{ path: "src/index.ts", type: "file" as const, label: "index.ts" },
			{ path: "secrets/config.json", type: "file" as const, label: "config.json" },
		]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		getSetting.mockReturnValue(true)

		// No current task
		;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-456",
		})
		expect(AlphaIgnoreController.prototype.initialize).not.toHaveBeenCalled()

		// Verify filterPaths was NOT called
		expect(mockFilterPaths).not.toHaveBeenCalled()

		// Verify all results were sent to webview (unfiltered)
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: mockResults,
			requestId: "test-request-456",
		})
	})

	it("should use existing AlphaIgnoreController from current task", async () => {
		// Setup mock results from file search
		const mockResults = [
			{ path: "src/index.ts", type: "file" as const, label: "index.ts" },
			{ path: "private/secret.ts", type: "file" as const, label: "secret.ts" },
		]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Create a mock task with its own AlphaIgnoreController
		const taskFilterPaths = vi.fn().mockReturnValue(["src/index.ts"])
		const taskAlphaIgnoreController = {
			filterPaths: taskFilterPaths,
			initialize: vi.fn(),
		}
		;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue({
			taskId: "test-task-id",
			alphaIgnoreController: taskAlphaIgnoreController,
		})

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-789",
		})

		// Verify the task's controller was used (not the prototype)
		expect(taskFilterPaths).toHaveBeenCalledWith(["src/index.ts", "private/secret.ts"])

		// Verify filtered results were sent to webview
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: [{ path: "src/index.ts", type: "file", label: "index.ts" }],
			requestId: "test-request-789",
		})
	})

	it("should handle error when no workspace path is available", async () => {
		// Create provider without cwd
		mockAlphaProvider = {
			...mockAlphaProvider,
			cwd: undefined,
			getCurrentTask: vi.fn().mockReturnValue(null),
		} as unknown as AlphaProvider

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "test",
			requestId: "test-request-error",
		})

		// Verify error response was sent
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: [],
			requestId: "test-request-error",
			error: "No workspace path available",
		})
	})

	it("should handle errors from searchWorkspaceFiles", async () => {
		mockSearchWorkspaceFiles.mockRejectedValue(new Error("File search failed"))
		;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "test",
			requestId: "test-request-fail",
		})

		// Verify error response was sent
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileSearchResults",
			results: [],
			error: "File search failed",
			requestId: "test-request-fail",
		})
	})

	it("filters ignored paths when the preference is missing", async () => {
		// Setup mock results from file search
		const mockResults = [{ path: "src/index.ts", type: "file" as const, label: "index.ts" }]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup filter to return all paths (no filtering)
		mockFilterPaths.mockReturnValue(["src/index.ts"])

		// No current task
		;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-default",
		})

		// Verify filterPaths was called (showAlphaIgnoredFiles defaults to false)
		expect(mockFilterPaths).toHaveBeenCalled()
	})

	it("should dispose temporary AlphaIgnoreController after use", async () => {
		// Setup mock results from file search
		const mockResults = [{ path: "src/index.ts", type: "file" as const, label: "index.ts" }]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup filter
		mockFilterPaths.mockReturnValue(["src/index.ts"])

		// No current task, so temporary controller will be created and should be disposed
		;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-dispose",
		})

		// Verify dispose was called on the temporary controller
		expect(mockDispose).toHaveBeenCalled()
	})

	it("should not dispose controller from current task", async () => {
		// Setup mock results from file search
		const mockResults = [{ path: "src/index.ts", type: "file" as const, label: "index.ts" }]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Create a mock task with its own AlphaIgnoreController
		const taskFilterPaths = vi.fn().mockReturnValue(["src/index.ts"])
		const taskDispose = vi.fn()
		const taskAlphaIgnoreController = {
			filterPaths: taskFilterPaths,
			initialize: vi.fn(),
			dispose: taskDispose,
		}
		;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue({
			taskId: "test-task-id",
			alphaIgnoreController: taskAlphaIgnoreController,
		})

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-no-dispose",
		})

		// Verify dispose was NOT called on the task's controller
		expect(taskDispose).not.toHaveBeenCalled()
		// Verify the prototype dispose was also not called
		expect(mockDispose).not.toHaveBeenCalled()
	})

	it("passes captured project scope and cancellation to discovery and suppresses a late result", async () => {
		let finish!: (results: Awaited<ReturnType<typeof searchWorkspaceFiles>>) => void
		mockSearchWorkspaceFiles.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
		const controller = new AbortController()
		const running = webviewMessageHandler(
			mockAlphaProvider,
			{ type: "searchFiles", query: "source", requestId: "superseded" },
			{ fileSearch: { signal: controller.signal, cwd: "/captured/project" } },
		)
		controller.abort()
		finish([{ path: "source.ts", type: "file" }])
		await running

		expect(mockSearchWorkspaceFiles).toHaveBeenCalledWith("source", "/captured/project", 20, controller.signal)
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
		expect(AlphaIgnoreController.prototype.initialize).not.toHaveBeenCalled()
	})

	it("disposes a temporary ignore controller when cancellation arrives during initialization", async () => {
		let finish!: () => void
		const initializing = new Promise<void>((resolve) => (finish = resolve))
		const started = new Promise<void>((resolve) => {
			;(AlphaIgnoreController.prototype as any).initialize = vi.fn(() => {
				resolve()
				return initializing
			})
		})
		mockSearchWorkspaceFiles.mockResolvedValueOnce([{ path: "source.ts", type: "file" }])
		const controller = new AbortController()
		const running = webviewMessageHandler(
			mockAlphaProvider,
			{ type: "searchFiles", query: "source", requestId: "cancelled" },
			{ fileSearch: { signal: controller.signal, cwd: "/captured/project" } },
		)
		await started
		controller.abort()
		finish()
		await running

		expect(mockDispose).toHaveBeenCalledOnce()
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("does not publish a result to a replacement webview after loading the ignore rules", async () => {
		mockSearchWorkspaceFiles.mockResolvedValueOnce([{ path: "source.ts", type: "file" }])
		let current = true
		vi.mocked(AlphaIgnoreController.prototype.initialize).mockImplementationOnce(async () => {
			current = false
		})
		const controller = new AbortController()
		await webviewMessageHandler(
			mockAlphaProvider,
			{ type: "searchFiles", query: "source", requestId: "old-view" },
			{ fileSearch: { signal: controller.signal, cwd: "/captured/project" }, isCurrentWebview: () => current },
		)

		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
		expect(mockDispose).toHaveBeenCalledOnce()
	})
})
