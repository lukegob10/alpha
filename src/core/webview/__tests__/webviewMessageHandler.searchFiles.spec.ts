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

describe("webviewMessageHandler - searchFiles with RooIgnore filtering", () => {
	let mockAlphaProvider: AlphaProvider
	let mockFilterPaths: Mock
	let mockDispose: Mock

	beforeEach(() => {
		vi.clearAllMocks()

		// Spy on the mock AlphaIgnoreController prototype methods
		mockFilterPaths = vi.fn()
		mockDispose = vi.fn()

		// Override the filterPaths method on the prototype
		;(AlphaIgnoreController.prototype as any).filterPaths = mockFilterPaths
		;(AlphaIgnoreController.prototype as any).initialize = vi.fn().mockResolvedValue(undefined)
		;(AlphaIgnoreController.prototype as any).dispose = mockDispose

		// Create mock AlphaProvider
		mockAlphaProvider = {
			getState: vi.fn(),
			postMessageToWebview: vi.fn(),
			getCurrentTask: vi.fn(),
			cwd: "/mock/workspace",
		} as unknown as AlphaProvider
	})

	it("should filter results using AlphaIgnoreController when showRooIgnoredFiles is false", async () => {
		// Setup mock results from file search
		const mockResults = [
			{ path: "src/index.ts", type: "file" as const, label: "index.ts" },
			{ path: "secrets/config.json", type: "file" as const, label: "config.json" },
			{ path: "src/utils.ts", type: "file" as const, label: "utils.ts" },
		]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup state with showRooIgnoredFiles = false
		;(mockAlphaProvider.getState as Mock).mockResolvedValue({
			showRooIgnoredFiles: false,
		})

		// Setup filter to exclude secrets folder
		mockFilterPaths.mockReturnValue(["src/index.ts", "src/utils.ts"])

		// No current task, so temporary controller will be created
		;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-123",
		})

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

	it("should not filter results when showRooIgnoredFiles is true", async () => {
		// Setup mock results from file search
		const mockResults = [
			{ path: "src/index.ts", type: "file" as const, label: "index.ts" },
			{ path: "secrets/config.json", type: "file" as const, label: "config.json" },
		]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup state with showRooIgnoredFiles = true
		;(mockAlphaProvider.getState as Mock).mockResolvedValue({
			showRooIgnoredFiles: true,
		})

		// No current task
		;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-456",
		})

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

		// Setup state with showRooIgnoredFiles = false
		;(mockAlphaProvider.getState as Mock).mockResolvedValue({
			showRooIgnoredFiles: false,
		})

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

		// Setup state
		;(mockAlphaProvider.getState as Mock).mockResolvedValue({
			showRooIgnoredFiles: false,
		})
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

	it("should default showRooIgnoredFiles to false when state is null", async () => {
		// Setup mock results from file search
		const mockResults = [{ path: "src/index.ts", type: "file" as const, label: "index.ts" }]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup state to return null
		;(mockAlphaProvider.getState as Mock).mockResolvedValue(null)

		// Setup filter to return all paths (no filtering)
		mockFilterPaths.mockReturnValue(["src/index.ts"])

		// No current task
		;(mockAlphaProvider.getCurrentTask as Mock).mockReturnValue(null)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "searchFiles",
			query: "index",
			requestId: "test-request-default",
		})

		// Verify filterPaths was called (showRooIgnoredFiles defaults to false)
		expect(mockFilterPaths).toHaveBeenCalled()
	})

	it("should dispose temporary AlphaIgnoreController after use", async () => {
		// Setup mock results from file search
		const mockResults = [{ path: "src/index.ts", type: "file" as const, label: "index.ts" }]
		mockSearchWorkspaceFiles.mockResolvedValue(mockResults)

		// Setup state
		;(mockAlphaProvider.getState as Mock).mockResolvedValue({
			showRooIgnoredFiles: false,
		})

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

		// Setup state
		;(mockAlphaProvider.getState as Mock).mockResolvedValue({
			showRooIgnoredFiles: false,
		})

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
})
