// npx vitest core/webview/__tests__/webviewMessageHandler.spec.ts

vi.mock("../../../services/command/commands", () => ({
	getCommands: vi.fn(),
}))

vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: vi.fn(),
}))

vi.mock("google-auth-library", () => ({
	GoogleAuth: vi.fn(),
}))

// Mock the diagnosticsHandler module
vi.mock("../diagnosticsHandler", () => ({
	generateErrorDiagnostics: vi.fn().mockResolvedValue({ success: true, filePath: "/tmp/diagnostics.json" }),
}))

import type { WebviewMessage } from "@alpha-code/types"

import { webviewMessageHandler } from "../webviewMessageHandler"
import * as todoTools from "../../tools/UpdateTodoListTool"
import type { AlphaProvider } from "../AlphaProvider"
import { getCommands } from "../../../services/command/commands"

const mockGetCommands = vi.mocked(getCommands)

// Mock AlphaProvider
const mockAlphaProvider = {
	getState: vi.fn(),
	postMessageToWebview: vi.fn(),
	customModesManager: {
		getCustomModes: vi.fn(),
		deleteCustomMode: vi.fn(),
	},
	context: {
		extensionPath: "/mock/extension/path",
		globalStorageUri: { fsPath: "/mock/global/storage" },
		secrets: { get: vi.fn() },
	},
	contextProxy: {
		context: {
			extensionPath: "/mock/extension/path",
			globalStorageUri: { fsPath: "/mock/global/storage" },
		},
		setValue: vi.fn(),
		getValue: vi.fn(),
		storeSecret: vi.fn(),
	},
	log: vi.fn(),
	postStateToWebview: vi.fn(),
	getCurrentTask: vi.fn(),
	getLiveTask: vi.fn(),
	canAcceptTaskInput: vi.fn(() => true),
	queueMessageForTask: vi.fn((taskId: string, text: string, images?: string[]) => {
		const task = mockAlphaProvider.getLiveTask(taskId)
		if (!task || !mockAlphaProvider.canAcceptTaskInput(taskId)) return false
		return Boolean(task.messageQueueService.addMessage(text, images))
	}),
	getTaskWithId: vi.fn(),
	createTask: vi.fn(),
	createTaskWithHistoryItem: vi.fn(),
	cancelTask: vi.fn(),
	showTaskWithId: vi.fn(),
	exportTaskWithId: vi.fn(),
	condenseTaskContext: vi.fn(),
	deleteTaskWithId: vi.fn(),
	getSkillsManager: vi.fn(),
	getCurrentWorkspaceCodeIndexManager: vi.fn(),
	cwd: "/mock/workspace",
} as unknown as AlphaProvider

import { t } from "../../../i18n"

vi.mock("vscode", () => {
	const showInformationMessage = vi.fn()
	const showWarningMessage = vi.fn()
	const showErrorMessage = vi.fn()
	const openTextDocument = vi.fn().mockResolvedValue({})
	const showTextDocument = vi.fn().mockResolvedValue(undefined)

	return {
		window: {
			showInformationMessage,
			showWarningMessage,
			showErrorMessage,
			showTextDocument,
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
			openTextDocument,
		},
	}
})

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, args?: Record<string, any>) => {
		// For the delete confirmation with rules, we need to return the interpolated string
		if (key === "common:confirmation.delete_custom_mode_with_rules" && args) {
			return `Are you sure you want to delete this ${args.scope} mode?\n\nThis will also delete the associated rules folder at:\n${args.rulesFolderPath}`
		}
		// Return the translated value for "Yes"
		if (key === "common:answers.yes") {
			return "Yes"
		}
		// Return the translated value for "Cancel"
		if (key === "common:answers.cancel") {
			return "Cancel"
		}
		return key
	}),
}))

vi.mock("fs/promises", () => {
	const mockRm = vi.fn().mockResolvedValue(undefined)
	const mockMkdir = vi.fn().mockResolvedValue(undefined)
	const mockReadFile = vi.fn().mockResolvedValue("[]")
	const mockWriteFile = vi.fn().mockResolvedValue(undefined)

	return {
		default: {
			rm: mockRm,
			mkdir: mockMkdir,
			readFile: mockReadFile,
			writeFile: mockWriteFile,
		},
		rm: mockRm,
		mkdir: mockMkdir,
		readFile: mockReadFile,
		writeFile: mockWriteFile,
	}
})

import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as fsUtils from "../../../utils/fs"
import { getWorkspacePath } from "../../../utils/path"
import { ensureSettingsDirectoryExists } from "../../../utils/globalContext"
import { generateErrorDiagnostics } from "../diagnosticsHandler"
import type { ModeConfig } from "@alpha-code/types"

vi.mock("../../../utils/fs")
vi.mock("../../../utils/path")
vi.mock("../../../utils/globalContext")

vi.mock("../../mentions/resolveImageMentions", () => ({
	resolveImageMentions: vi.fn(async ({ text, images }: { text: string; images?: string[] }) => ({
		text,
		images: [...(images ?? []), "data:image/png;base64,from-mention"],
	})),
}))

import { resolveImageMentions } from "../../mentions/resolveImageMentions"

beforeEach(() => {
	vi.mocked(mockAlphaProvider.canAcceptTaskInput).mockReturnValue(true)
})

describe("webviewMessageHandler - pending TODO approval routing", () => {
	it.each(["missing", "unknown", "terminal", "live"] as const)(
		"handles a %s task identity without falling back to the active task",
		async (kind) => {
			const task = { taskId: "addressed-task" }
			vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue(kind === "unknown" ? undefined : (task as never))
			vi.mocked(mockAlphaProvider.canAcceptTaskInput).mockReturnValue(kind !== "terminal")
			const edit = vi.spyOn(todoTools, "setPendingTodoList").mockReturnValue(true)
			const payload = { approvalId: "approval", todos: [] }
			try {
				await webviewMessageHandler(mockAlphaProvider, {
					type: "updateTodoList",
					taskId: kind === "missing" ? undefined : "addressed-task",
					payload,
				})
				if (kind === "live") expect(edit).toHaveBeenCalledWith(task, payload)
				else expect(edit).not.toHaveBeenCalled()
			} finally {
				edit.mockRestore()
				vi.mocked(mockAlphaProvider.getLiveTask).mockReset()
			}
		},
	)
})

describe("webviewMessageHandler - removed features", () => {
	it.each(["createGoalSeekJob", "updateGoalSeekJob", "deleteGoalSeekJob", "runGoalSeekJob", "cancelGoalSeekRun"])(
		"ignores the obsolete %s message without starting a task",
		async (type) => {
			vi.mocked(mockAlphaProvider.createTask).mockClear()
			await expect(
				webviewMessageHandler(mockAlphaProvider, { type } as unknown as WebviewMessage),
			).resolves.toBeUndefined()
			expect(mockAlphaProvider.createTask).not.toHaveBeenCalled()
		},
	)
})

describe("webviewMessageHandler - showTaskWithId", () => {
	it("awaits a not-yet-available managed task and reports the failure without rejecting", async () => {
		const showTaskWithId = vi.mocked(mockAlphaProvider.showTaskWithId)
		showTaskWithId.mockRejectedValueOnce(new Error("Task not found"))

		await expect(
			webviewMessageHandler(mockAlphaProvider, { type: "showTaskWithId", text: "prepared-child" }),
		).resolves.toBeUndefined()

		expect(showTaskWithId).toHaveBeenCalledWith("prepared-child")
		expect(mockAlphaProvider.log).toHaveBeenCalledWith(expect.stringContaining("Task not found"))
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			"This task is not available yet. If it is still launching, wait a moment and try again.",
		)
	})
})

describe("webviewMessageHandler - task history commands", () => {
	beforeEach(() => {
		vi.mocked(mockAlphaProvider.getCurrentTask).mockReset()
		vi.mocked(mockAlphaProvider.exportTaskWithId).mockReset()
		vi.mocked(mockAlphaProvider.condenseTaskContext).mockReset()
		vi.mocked(mockAlphaProvider.deleteTaskWithId).mockReset()
	})

	it.each([
		["exportTaskWithId", { type: "exportTaskWithId", text: "history-task" }],
		["condenseTaskContext", { type: "condenseTaskContextRequest", text: "history-task" }],
		["deleteTaskWithId", { type: "deleteTaskWithId", text: "history-task" }],
	] as const)("awaits %s before accepting another webview command", async (method, message) => {
		let finishOperation!: () => void
		const operation = vi.mocked(mockAlphaProvider[method])
		operation.mockImplementationOnce(() => new Promise<void>((resolve) => (finishOperation = resolve)))

		let handled = false
		const handling = webviewMessageHandler(mockAlphaProvider, message).then(() => {
			handled = true
		})
		await vi.waitFor(() => expect(operation).toHaveBeenCalledWith("history-task"))
		expect(handled).toBe(false)

		finishOperation()
		await handling
		expect(handled).toBe(true)
	})

	it("awaits exportCurrentTask before accepting another webview command", async () => {
		let finishExport!: () => void
		vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue({ taskId: "current-task" } as any)
		vi.mocked(mockAlphaProvider.exportTaskWithId).mockImplementationOnce(
			() => new Promise<void>((resolve) => (finishExport = resolve)),
		)

		let handled = false
		const handling = webviewMessageHandler(mockAlphaProvider, { type: "exportCurrentTask" }).then(() => {
			handled = true
		})
		await vi.waitFor(() => expect(mockAlphaProvider.exportTaskWithId).toHaveBeenCalledWith("current-task"))
		expect(handled).toBe(false)

		finishExport()
		await handling
		expect(handled).toBe(true)
	})
})

describe("webviewMessageHandler - terminalOperation", () => {
	it("awaits asynchronous process-tree termination", async () => {
		let finishAbort!: () => void
		const handleTerminalOperation = vi.fn(() => new Promise<void>((resolve) => (finishAbort = resolve)))
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: "worker-task",
			handleTerminalOperation,
		} as any)

		let handled = false
		const handling = webviewMessageHandler(mockAlphaProvider, {
			type: "terminalOperation",
			taskId: "worker-task",
			terminalOperation: "abort",
		}).then(() => {
			handled = true
		})
		await vi.waitFor(() => expect(handleTerminalOperation).toHaveBeenCalledWith("abort"))
		expect(handled).toBe(false)

		finishAbort()
		await handling
		expect(handled).toBe(true)
	})
})

describe("webviewMessageHandler - Vertex code index settings", () => {
	const createVertexSettings = () => ({
		codebaseIndexEnabled: false,
		codebaseIndexVectorStoreProvider: "lancedb",
		codebaseIndexLocalIndexPath: ".alpha/code-index/lancedb",
		codebaseIndexQdrantUrl: "http://localhost:6333",
		codebaseIndexEmbedderProvider: "vertex",
		codebaseIndexEmbedderModelId: "text-embedding-005",
		codebaseIndexEmbedderModelDimension: 768,
		codebaseIndexVertexProjectId: "test-project",
		codebaseIndexVertexRegion: "us-central1",
		codebaseIndexVertexKeyFile: "",
		codebaseIndexVertexGatewayBaseUrl: "",
		codebaseIndexVertexGatewayCaBundlePath: "",
		codebaseIndexVertexGatewayHelixCommand: "",
		codebaseIndexVertexGatewayTokenRefreshMinutes: undefined,
		codebaseIndexVertexGatewayModelRoutingMap: "",
		codebaseIndexSearchMaxResults: 50,
		codebaseIndexSearchMinScore: 0.4,
		codebaseIndexEmbeddingRateLimitEnabled: false,
		codebaseIndexEmbeddingRateLimitSeconds: 1,
		codeIndexQdrantApiKey: "qdrant-secret",
		codebaseIndexVertexJsonCredentials: '{"project_id":"test-project"}',
	})

	beforeEach(() => {
		vi.clearAllMocks()
		const contextProxy = mockAlphaProvider.contextProxy as any
		contextProxy.getValue.mockReturnValue(undefined)
		contextProxy.setValue.mockResolvedValue(undefined)
		contextProxy.storeSecret.mockResolvedValue(undefined)
		;(mockAlphaProvider as any).getCurrentWorkspaceCodeIndexManager.mockReturnValue(undefined)
		;(mockAlphaProvider.context as any).secrets.get.mockResolvedValue(undefined)
	})

	it("saves Vertex settings and only the active embedding secrets", async () => {
		const settings = createVertexSettings()

		await webviewMessageHandler(mockAlphaProvider, {
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: settings,
		} as any)

		const contextProxy = mockAlphaProvider.contextProxy as any
		expect(contextProxy.setValue).toHaveBeenCalledWith(
			"codebaseIndexConfig",
			expect.objectContaining({
				codebaseIndexEmbedderProvider: "vertex",
				codebaseIndexEmbedderModelId: "text-embedding-005",
				codebaseIndexEmbedderModelDimension: 768,
				codebaseIndexVertexProjectId: "test-project",
			}),
		)
		expect(contextProxy.storeSecret).toHaveBeenNthCalledWith(1, "codeIndexQdrantApiKey", "qdrant-secret")
		expect(contextProxy.storeSecret).toHaveBeenNthCalledWith(
			2,
			"codebaseIndexVertexJsonCredentials",
			'{"project_id":"test-project"}',
		)
		expect(contextProxy.storeSecret).toHaveBeenCalledTimes(2)
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "codeIndexSettingsSaved", success: true }),
		)
	})

	it("reports only Vertex and vector-store secret status", async () => {
		const secrets = (mockAlphaProvider.context as any).secrets.get
		secrets.mockImplementation(async (key: string) =>
			key === "codeIndexQdrantApiKey"
				? "qdrant-secret"
				: key === "codebaseIndexVertexJsonCredentials"
					? "{}"
					: undefined,
		)

		await webviewMessageHandler(mockAlphaProvider, { type: "requestCodeIndexSecretStatus" })

		expect(secrets.mock.calls.map(([key]: [string]) => key)).toEqual([
			"codeIndexQdrantApiKey",
			"codebaseIndexVertexJsonCredentials",
		])
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "codeIndexSecretStatus",
			values: {
				hasQdrantApiKey: true,
				hasVertexJsonCredentials: true,
			},
		})
	})
})

describe("webviewMessageHandler - image mentions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockAlphaProvider.getState = vi.fn().mockResolvedValue({
			maxImageFileSize: 5,
			maxTotalImageSize: 20,
		})
	})

	it("should resolve image mentions for askResponse payloads", async () => {
		const mockHandleWebviewAskResponse = vi.fn()
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			cwd: "/mock/workspace",
			alphaIgnoreController: undefined,
			handleWebviewAskResponse: mockHandleWebviewAskResponse,
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "askResponse",
			askResponse: "messageResponse",
			text: "See @/img.png",
			images: [],
			taskId: "task-1",
		})

		expect(vi.mocked(resolveImageMentions)).toHaveBeenCalled()
		expect(mockHandleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "See @/img.png", [
			"data:image/png;base64,from-mention",
		])
	})

	it("resumes a completed task with the submitted follow-up instead of creating a task", async () => {
		const resumeCompletedTaskFollowup = vi.fn().mockResolvedValue(undefined)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			cwd: "/mock/workspace",
			alphaIgnoreController: undefined,
			resumeCompletedTaskFollowup,
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "resumeCompletedTask",
			text: "Evaluate @/img.png",
			images: [],
			taskId: "task-1",
		})

		expect(resumeCompletedTaskFollowup).toHaveBeenCalledWith("Evaluate @/img.png", [
			"data:image/png;base64,from-mention",
		])
		expect(mockAlphaProvider.createTask).not.toHaveBeenCalled()
	})

	it("restores a completed-task draft when the host cannot resume it", async () => {
		const resumeCompletedTaskFollowup = vi.fn().mockRejectedValue(new Error("terminal journal unavailable"))
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({ resumeCompletedTaskFollowup } as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "resumeCompletedTask",
			text: "keep this prompt",
			images: ["image1.png"],
			taskId: "task-1",
		})

		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "setChatBoxMessage",
			text: "keep this prompt",
			images: ["image1.png"],
		})
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to continue task: terminal journal unavailable",
		)
	})

	it("restores a completed-task draft when its live task disappeared before dispatch", async () => {
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue(undefined)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "resumeCompletedTask",
			text: "do not lose this prompt",
			images: ["image1.png"],
			taskId: "missing-task",
		})

		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "setChatBoxMessage",
			text: "do not lose this prompt",
			images: ["image1.png"],
		})
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to continue task: the completed task is no longer available",
		)
	})

	it("does not route askResponse without a taskId to the active task", async () => {
		const mockHandleWebviewAskResponse = vi.fn()
		vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue({
			handleWebviewAskResponse: mockHandleWebviewAskResponse,
		} as any)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue(undefined)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "askResponse",
			askResponse: "messageResponse",
			text: "wrong target",
			images: [],
		})

		expect(mockHandleWebviewAskResponse).not.toHaveBeenCalled()
		expect(mockAlphaProvider.log).toHaveBeenCalledWith(
			"[webviewMessageHandler] Ignoring askResponse: missing or unknown taskId",
		)
	})

	it("does not route askResponse to terminal tasks", async () => {
		const mockHandleWebviewAskResponse = vi.fn()
		vi.mocked(mockAlphaProvider.canAcceptTaskInput).mockReturnValue(false)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			cwd: "/mock/workspace",
			alphaIgnoreController: undefined,
			handleWebviewAskResponse: mockHandleWebviewAskResponse,
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "askResponse",
			askResponse: "messageResponse",
			text: "stale followup",
			images: [],
			taskId: "task-1",
		})

		expect(mockHandleWebviewAskResponse).not.toHaveBeenCalled()
		expect(mockAlphaProvider.log).toHaveBeenCalledWith(
			"[webviewMessageHandler] Ignoring askResponse: task task-1 is terminal",
		)
	})
})

describe("webviewMessageHandler - queued message steering", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("removes the selected queued message and steers it into the active task", async () => {
		const queuedMessage = {
			id: "queued-1",
			timestamp: Date.now(),
			text: "steer this now",
			images: ["img1.png"],
		}
		const getMessage = vi.fn().mockReturnValue(queuedMessage)
		const removeMessage = vi.fn().mockReturnValue(true)
		const steerUserMessage = vi.fn().mockResolvedValue(undefined)

		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: "task-1",
			messageQueueService: {
				getMessage,
				removeMessage,
			},
			steerUserMessage,
			canAcceptSteerMessage: vi.fn(() => true),
			hasPendingSteerMessage: vi.fn(() => false),
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "steerQueuedMessage",
			text: "queued-1",
			taskId: "task-1",
			requestId: "steer-request-1",
		})

		expect(getMessage).toHaveBeenCalledWith("queued-1")
		expect(steerUserMessage).toHaveBeenCalledWith("steer this now", ["img1.png"])
		expect(removeMessage).toHaveBeenCalledWith("queued-1")
		expect(steerUserMessage.mock.invocationCallOrder[0]).toBeLessThan(removeMessage.mock.invocationCallOrder[0])
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chatCommandResult",
				chatCommandResult: expect.objectContaining({
					requestId: "steer-request-1",
					command: "steerQueuedMessage",
					status: "accepted",
				}),
			}),
		)
	})

	it("keeps the queued message when the task rejects the steering handoff", async () => {
		const queuedMessage = {
			id: "queued-1",
			timestamp: Date.now(),
			text: "do not lose this",
			images: [],
		}
		const getMessage = vi.fn().mockReturnValue(queuedMessage)
		const removeMessage = vi.fn()
		const steerUserMessage = vi.fn().mockRejectedValue(new Error("another steering message is pending"))

		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: "task-1",
			messageQueueService: {
				getMessage,
				removeMessage,
			},
			steerUserMessage,
			canAcceptSteerMessage: vi.fn(() => true),
			hasPendingSteerMessage: vi.fn(() => true),
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "steerQueuedMessage",
			text: "queued-1",
			taskId: "task-1",
			requestId: "steer-request-2",
		})

		expect(getMessage).toHaveBeenCalledWith("queued-1")
		expect(removeMessage).not.toHaveBeenCalled()
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({
					requestId: "steer-request-2",
					status: "rejected",
					errorCode: "steer_pending",
				}),
			}),
		)
	})

	it("acknowledges a queued message only after the task accepts it", async () => {
		vi.mocked(mockAlphaProvider.queueMessageForTask).mockReturnValue(true)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "queueMessage",
			text: "keep this safe",
			images: [],
			taskId: "task-1",
			requestId: "queue-request-1",
		})

		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "chatCommandResult",
			taskId: "task-1",
			requestId: "queue-request-1",
			chatCommandResult: {
				requestId: "queue-request-1",
				taskId: "task-1",
				command: "queueMessage",
				status: "accepted",
			},
		})
	})

	it("does not queue or steer messages into terminal tasks", async () => {
		const addMessage = vi.fn()
		const getMessage = vi.fn()
		const steerUserMessage = vi.fn()
		vi.mocked(mockAlphaProvider.canAcceptTaskInput).mockReturnValue(false)
		vi.mocked(mockAlphaProvider.queueMessageForTask).mockReturnValue(false)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			messageQueueService: {
				addMessage,
				getMessage,
			},
			steerUserMessage,
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "queueMessage",
			text: "queued stale message",
			images: [],
			taskId: "task-1",
		})
		await webviewMessageHandler(mockAlphaProvider, {
			type: "steerQueuedMessage",
			text: "queued-1",
			taskId: "task-1",
		})

		expect(addMessage).not.toHaveBeenCalled()
		expect(getMessage).not.toHaveBeenCalled()
		expect(steerUserMessage).not.toHaveBeenCalled()
		expect(mockAlphaProvider.log).toHaveBeenCalledWith(
			"[webviewMessageHandler] Ignoring queueMessage: missing, terminal, or unknown taskId",
		)
		expect(mockAlphaProvider.log).toHaveBeenCalledWith(
			"[webviewMessageHandler] Ignoring steerQueuedMessage: task task-1 is terminal",
		)
	})

	it("moves the selected queued message on the resolved task", async () => {
		const moveMessage = vi.fn().mockReturnValue(true)

		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			messageQueueService: {
				moveMessage,
			},
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "reorderQueuedMessage",
			payload: {
				id: "queued-2",
				toIndex: 0,
			},
			taskId: "task-1",
		})

		expect(moveMessage).toHaveBeenCalledWith("queued-2", 0)
	})
})

describe("webviewMessageHandler - newTask", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(mockAlphaProvider.createTask).mockResolvedValue({ taskId: "task-1" } as any)
	})

	it("keeps the newly created task visible instead of resetting back to a blank chat", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "newTask",
			text: "Build the feature",
			images: [],
			taskId: "task-1",
		})

		expect(mockAlphaProvider.createTask).toHaveBeenCalledWith(
			"Build the feature",
			["data:image/png;base64,from-mention"],
			undefined,
			{ taskId: "task-1", preserveExisting: true },
			undefined,
		)
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "chatButtonClicked",
			values: { force: true },
		})
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalledWith({
			type: "invoke",
			invoke: "newChat",
		})
	})

	it("forces the chat view and resets the draft if task creation fails", async () => {
		vi.mocked(mockAlphaProvider.createTask).mockRejectedValue(new Error("boom"))

		await webviewMessageHandler(mockAlphaProvider, {
			type: "newTask",
			text: "Build the feature",
			images: [],
			taskId: "task-1",
		})

		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "chatButtonClicked",
			values: { force: true },
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "invoke",
			invoke: "newChat",
		})
	})
})

describe("webviewMessageHandler - deleteCustomMode", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getWorkspacePath).mockReturnValue("/mock/workspace")
		vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined)
		vi.mocked(ensureSettingsDirectoryExists).mockResolvedValue("/mock/global/storage/.roo")
	})

	it("should delete a project mode and its rules folder", async () => {
		const slug = "test-project-mode"
		const rulesFolderPath = path.join("/mock/workspace", ".roo", `rules-${slug}`)

		vi.mocked(mockAlphaProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Project Mode",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "project",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(mockAlphaProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)

		await webviewMessageHandler(mockAlphaProvider, { type: "deleteCustomMode", slug })

		// The confirmation dialog is now handled in the webview, so we don't expect showInformationMessage to be called
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		expect(mockAlphaProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).toHaveBeenCalledWith(rulesFolderPath, { recursive: true, force: true })
	})

	it("should delete a global mode and its rules folder", async () => {
		const slug = "test-global-mode"
		const homeDir = os.homedir()
		const rulesFolderPath = path.join(homeDir, ".roo", `rules-${slug}`)

		vi.mocked(mockAlphaProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Global Mode",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "global",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(mockAlphaProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)

		await webviewMessageHandler(mockAlphaProvider, { type: "deleteCustomMode", slug })

		// The confirmation dialog is now handled in the webview, so we don't expect showInformationMessage to be called
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		expect(mockAlphaProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).toHaveBeenCalledWith(rulesFolderPath, { recursive: true, force: true })
	})

	it("should only delete the mode when rules folder does not exist", async () => {
		const slug = "test-mode-no-rules"
		vi.mocked(mockAlphaProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Mode No Rules",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "project",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(false)
		vi.mocked(mockAlphaProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)

		await webviewMessageHandler(mockAlphaProvider, { type: "deleteCustomMode", slug })

		// The confirmation dialog is now handled in the webview, so we don't expect showInformationMessage to be called
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		expect(mockAlphaProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).not.toHaveBeenCalled()
	})

	it("should handle errors when deleting rules folder", async () => {
		const slug = "test-mode-error"
		const rulesFolderPath = path.join("/mock/workspace", ".roo", `rules-${slug}`)
		const error = new Error("Permission denied")

		vi.mocked(mockAlphaProvider.customModesManager.getCustomModes).mockResolvedValue([
			{
				name: "Test Mode Error",
				slug,
				roleDefinition: "Test Role",
				groups: [],
				source: "project",
			} as ModeConfig,
		])
		vi.mocked(fsUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(mockAlphaProvider.customModesManager.deleteCustomMode).mockResolvedValue(undefined)
		vi.mocked(fs.rm).mockRejectedValue(error)

		await webviewMessageHandler(mockAlphaProvider, { type: "deleteCustomMode", slug })

		expect(mockAlphaProvider.customModesManager.deleteCustomMode).toHaveBeenCalledWith(slug)
		expect(fs.rm).toHaveBeenCalledWith(rulesFolderPath, { recursive: true, force: true })
		// Verify error message is shown to the user
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			t("common:errors.delete_rules_folder_failed", {
				rulesFolderPath,
				error: error.message,
			}),
		)
		// No error response is sent anymore - we just continue with deletion
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - message dialog preferences", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Mock a current Alpha instance
		vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue({
			taskId: "test-task-id",
			apiConversationHistory: [],
			clineMessages: [{ ts: 123456789, type: "say", say: "user_feedback", text: "Original prompt" }],
		} as any)
		// Reset getValue mock
		vi.mocked(mockAlphaProvider.contextProxy.getValue).mockReturnValue(false)
	})

	describe("deleteMessage", () => {
		it("should always show dialog for delete confirmation", async () => {
			vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue({
				taskId: "test-task-id",
				clineMessages: [{ ts: 123456789, type: "say", say: "user_feedback", text: "Original prompt" }],
				apiConversationHistory: [],
			} as any) // Mock current cline with proper structure

			await webviewMessageHandler(mockAlphaProvider, {
				type: "deleteMessage",
				value: 123456789, // Changed from messageTs to value
			})

			expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "showDeleteMessageDialog",
				taskId: "test-task-id",
				messageTs: 123456789,
				hasCheckpoint: false,
			})
		})
	})

	describe("submitEditedMessage", () => {
		it("should always show dialog for edit confirmation", async () => {
			vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue({
				taskId: "test-task-id",
				clineMessages: [{ ts: 123456789, type: "say", say: "user_feedback", text: "Original prompt" }],
				apiConversationHistory: [],
			} as any) // Mock current cline with proper structure

			await webviewMessageHandler(mockAlphaProvider, {
				type: "submitEditedMessage",
				value: 123456789,
				editedMessageContent: "edited content",
			})

			expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "showEditMessageDialog",
				taskId: "test-task-id",
				messageTs: 123456789,
				text: "edited content",
				hasCheckpoint: false,
				images: undefined,
			})
		})
	})
})

describe("webviewMessageHandler - sub-agent controls", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		;(mockAlphaProvider as any).steerSubagent = vi.fn().mockResolvedValue(undefined)
		;(mockAlphaProvider as any).cancelSubagent = vi.fn().mockResolvedValue(undefined)
		;(mockAlphaProvider as any).respondToSubagentApproval = vi.fn().mockResolvedValue(undefined)
	})

	it("routes steering and cancellation through explicit child identifiers", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "steerSubagent",
			taskId: "parent-1",
			groupId: "group-1",
			subagentTaskId: "child-1",
			text: "Focus on the parser boundary.",
		})
		await webviewMessageHandler(mockAlphaProvider, {
			type: "cancelSubagent",
			taskId: "parent-1",
			groupId: "group-1",
			subagentTaskId: "child-2",
		})

		expect((mockAlphaProvider as any).steerSubagent).toHaveBeenCalledWith(
			"parent-1",
			"group-1",
			"child-1",
			"Focus on the parser boundary.",
		)
		expect((mockAlphaProvider as any).cancelSubagent).toHaveBeenCalledWith("parent-1", "group-1", "child-2")
	})

	it("ignores malformed or empty sub-agent control messages", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "steerSubagent",
			taskId: "parent-1",
			groupId: "group-1",
			subagentTaskId: "child-1",
			text: "   ",
		})
		await webviewMessageHandler(mockAlphaProvider, {
			type: "cancelSubagent",
			taskId: "parent-1",
			groupId: "group-1",
		})

		expect((mockAlphaProvider as any).steerSubagent).not.toHaveBeenCalled()
		expect((mockAlphaProvider as any).cancelSubagent).not.toHaveBeenCalled()
	})

	it("routes approval responses without overloading the text field", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "respondToSubagentApproval",
			taskId: "parent-1",
			groupId: "group-1",
			subagentTaskId: "child-1",
			approvalId: "approval-1",
			approved: true,
		})

		expect((mockAlphaProvider as any).respondToSubagentApproval).toHaveBeenCalledWith(
			"parent-1",
			"group-1",
			"child-1",
			"approval-1",
			true,
		)
	})
})

describe("webviewMessageHandler - task cancellation provenance", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("labels an explicit stop-button cancellation", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "cancelTask",
			taskId: "parent-1",
		})

		expect(mockAlphaProvider.cancelTask).toHaveBeenCalledWith("parent-1", "webview_stop")
	})
})

describe("webviewMessageHandler - mcpEnabled", () => {
	let mockMcpHub: any

	beforeEach(() => {
		vi.clearAllMocks()

		// Create a mock McpHub instance
		mockMcpHub = {
			handleMcpEnabledChange: vi.fn().mockResolvedValue(undefined),
		}

		// Ensure provider exposes getMcpHub and returns our mock
		;(mockAlphaProvider as any).getMcpHub = vi.fn().mockReturnValue(mockMcpHub)
	})

	it("delegates enable=true to McpHub and posts updated state", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "updateSettings",
			updatedSettings: { mcpEnabled: true },
		})

		expect((mockAlphaProvider as any).getMcpHub).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledWith(true)
		expect(mockAlphaProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("delegates enable=false to McpHub and posts updated state", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "updateSettings",
			updatedSettings: { mcpEnabled: false },
		})

		expect((mockAlphaProvider as any).getMcpHub).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledTimes(1)
		expect(mockMcpHub.handleMcpEnabledChange).toHaveBeenCalledWith(false)
		expect(mockAlphaProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("handles missing McpHub instance gracefully and still posts state", async () => {
		;(mockAlphaProvider as any).getMcpHub = vi.fn().mockReturnValue(undefined)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "updateSettings",
			updatedSettings: { mcpEnabled: true },
		})

		expect((mockAlphaProvider as any).getMcpHub).toHaveBeenCalledTimes(1)
		expect(mockAlphaProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})
})

describe("webviewMessageHandler - ticket auto-approval settings", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each([true, false])(
		"saves ticket approval %s through the settings edit buffer message",
		async (alwaysAllowTickets) => {
			await webviewMessageHandler(mockAlphaProvider, {
				type: "updateSettings",
				updatedSettings: { alwaysAllowTickets },
			})
			expect(mockAlphaProvider.contextProxy.setValue).toHaveBeenCalledWith(
				"alwaysAllowTickets",
				alwaysAllowTickets,
			)
			expect(mockAlphaProvider.postStateToWebview).toHaveBeenCalledTimes(1)
		},
	)
})

describe("webviewMessageHandler - command auto-approval settings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("sanitizes command lists from updateSettings and stores them in global state", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "updateSettings",
			updatedSettings: {
				allowedCommands: [" git ", "", "git", 7 as any, "*"],
				deniedCommands: [" rm ", null as any, "rm"],
			},
		})

		expect(mockAlphaProvider.contextProxy.setValue).toHaveBeenCalledWith("allowedCommands", ["git", "*"])
		expect(mockAlphaProvider.contextProxy.setValue).toHaveBeenCalledWith("deniedCommands", ["rm"])
		expect(mockAlphaProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("sanitizes command lists from legacy command messages", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "allowedCommands",
			commands: [" npm test ", "", "npm test", false as any],
		})

		await webviewMessageHandler(mockAlphaProvider, {
			type: "deniedCommands",
			commands: [" rm -rf ", undefined as any, "rm -rf"],
		})

		expect(mockAlphaProvider.contextProxy.setValue).toHaveBeenCalledWith("allowedCommands", ["npm test"])
		expect(mockAlphaProvider.contextProxy.setValue).toHaveBeenCalledWith("deniedCommands", ["rm -rf"])
	})
})

describe("webviewMessageHandler - requestCommands", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("includes skill slug commands and dedupes duplicate skill names while preserving first skill entry", async () => {
		mockGetCommands.mockResolvedValue([])

		const getTaskMode = vi.fn().mockResolvedValue("code")
		vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue({
			cwd: "/mock/workspace",
			getTaskMode,
		} as unknown as ReturnType<AlphaProvider["getCurrentTask"]>)

		const getSkillsForMode = vi.fn().mockReturnValue([
			{
				name: "skill-slug-entry",
				description: "Primary skill slug",
				path: "/mock/.alpha/skills/skill-slug-entry/SKILL.md",
				source: "project",
				modeSlugs: ["code"],
			},
			{
				name: "skill-slug-entry",
				description: "Duplicate skill slug",
				path: "/mock/.alpha/skills/duplicate-skill/SKILL.md",
				source: "global",
				modeSlugs: ["code"],
			},
			{
				name: "another-skill-slug",
				description: "Another skill-generated command",
				path: "/mock/.alpha/skills/another-skill-slug/SKILL.md",
				source: "global",
				modeSlugs: ["code"],
			},
		])

		vi.mocked(mockAlphaProvider.getSkillsManager).mockReturnValue({
			getSkillsForMode,
		} as unknown as ReturnType<AlphaProvider["getSkillsManager"]>)

		await webviewMessageHandler(mockAlphaProvider, { type: "requestCommands" })

		const commandMessageCall = vi
			.mocked(mockAlphaProvider.postMessageToWebview)
			.mock.calls.find(([postedMessage]) => postedMessage.type === "commands")
		expect(commandMessageCall).toBeDefined()

		const commandMessage = commandMessageCall?.[0]
		expect(commandMessage?.commands).toEqual(
			expect.arrayContaining([
				{
					name: "skill-slug-entry",
					source: "project",
					filePath: "/mock/.alpha/skills/skill-slug-entry/SKILL.md",
					description: "Primary skill slug",
				},
				{
					name: "another-skill-slug",
					source: "global",
					filePath: "/mock/.alpha/skills/another-skill-slug/SKILL.md",
					description: "Another skill-generated command",
				},
			]),
		)

		expect(commandMessage?.commands?.filter((command) => command.name === "skill-slug-entry")).toHaveLength(1)
	})

	it("adds skill-backed command entries without overriding existing command names", async () => {
		mockGetCommands.mockResolvedValue([
			{
				name: "deploy",
				content: "existing command",
				source: "project",
				filePath: "/mock/workspace/.alpha/commands/deploy.md",
				description: "Deploy command",
				argumentHint: "staging | production",
			},
		])

		const getTaskMode = vi.fn().mockResolvedValue("code")
		vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue({
			cwd: "/mock/workspace",
			getTaskMode,
		} as unknown as ReturnType<AlphaProvider["getCurrentTask"]>)

		const getSkillsForMode = vi.fn().mockReturnValue([
			{
				name: "deploy",
				description: "Deploy skill",
				path: "/mock/.alpha/skills/deploy/SKILL.md",
				source: "global",
				modeSlugs: ["code"],
			},
			{
				name: "skill-only",
				description: "Skill-generated command",
				path: "/mock/.alpha/skills/skill-only/SKILL.md",
				source: "project",
				modeSlugs: ["code"],
			},
		])

		vi.mocked(mockAlphaProvider.getSkillsManager).mockReturnValue({
			getSkillsForMode,
		} as unknown as ReturnType<AlphaProvider["getSkillsManager"]>)

		await webviewMessageHandler(mockAlphaProvider, { type: "requestCommands" })

		expect(getSkillsForMode).toHaveBeenCalledWith("code")

		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "commands",
			commands: expect.arrayContaining([
				{
					name: "deploy",
					source: "project",
					filePath: "/mock/workspace/.alpha/commands/deploy.md",
					description: "Deploy command",
					argumentHint: "staging | production",
				},
				{
					name: "skill-only",
					source: "project",
					filePath: "/mock/.alpha/skills/skill-only/SKILL.md",
					description: "Skill-generated command",
				},
			]),
		})

		const commandMessageCall = vi
			.mocked(mockAlphaProvider.postMessageToWebview)
			.mock.calls.find(([postedMessage]) => postedMessage.type === "commands")
		expect(commandMessageCall).toBeDefined()

		const commandMessage = commandMessageCall?.[0]
		expect(commandMessage?.commands?.filter((command) => command.name === "deploy")).toHaveLength(1)
	})

	it("preserves existing behavior when skills manager is unavailable", async () => {
		mockGetCommands.mockResolvedValue([
			{
				name: "build",
				content: "build command",
				source: "built-in",
				filePath: "<built-in:build>",
				description: "Build command",
				argumentHint: "target",
			},
		])

		vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue({
			cwd: "/mock/workspace",
		} as unknown as ReturnType<AlphaProvider["getCurrentTask"]>)

		vi.mocked(mockAlphaProvider.getSkillsManager).mockReturnValue(undefined)

		await webviewMessageHandler(mockAlphaProvider, { type: "requestCommands" })

		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "commands",
			commands: [
				{
					name: "build",
					source: "built-in",
					filePath: "<built-in:build>",
					description: "Build command",
					argumentHint: "target",
				},
			],
		})
	})
})

describe("webviewMessageHandler - downloadErrorDiagnostics", () => {
	beforeEach(() => {
		vi.clearAllMocks()

		// Ensure contextProxy has a globalStorageUri for the handler
		;(mockAlphaProvider as any).contextProxy.globalStorageUri = { fsPath: "/mock/global/storage" }

		// Provide a current task with a stable ID
		vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue({
			taskId: "test-task-id",
		} as any)
	})

	it("calls generateErrorDiagnostics with correct parameters", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "downloadErrorDiagnostics",
			values: {
				timestamp: "2025-01-01T00:00:00.000Z",
				version: "1.2.3",
				provider: "test-provider",
				model: "test-model",
				details: "Sample error details",
			},
		} as any)

		// Verify generateErrorDiagnostics was called with the correct parameters
		expect(generateErrorDiagnostics).toHaveBeenCalledTimes(1)
		expect(generateErrorDiagnostics).toHaveBeenCalledWith({
			taskId: "test-task-id",
			extension: mockAlphaProvider.context.extension,
			getRuntimeDiagnostics: expect.any(Function),
			globalStoragePath: "/mock/global/storage",
			values: {
				timestamp: "2025-01-01T00:00:00.000Z",
				version: "1.2.3",
				provider: "test-provider",
				model: "test-model",
				details: "Sample error details",
			},
			log: expect.any(Function),
		})
	})

	it("shows error when no active task", async () => {
		vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue(null as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "downloadErrorDiagnostics",
			values: {},
		} as any)

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No active task to generate diagnostics for")
		expect(generateErrorDiagnostics).not.toHaveBeenCalled()
	})
})
