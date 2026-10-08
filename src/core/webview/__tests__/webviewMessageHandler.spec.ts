// npx vitest core/webview/__tests__/webviewMessageHandler.spec.ts

vi.mock("../../../services/command/commands", () => ({
	getCommands: vi.fn(),
}))

vi.mock("../../../integrations/misc/open-file", () => ({
	openFile: vi.fn().mockResolvedValue(undefined),
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
import { openFile } from "../../../integrations/misc/open-file"
import { MessageQueueService } from "../../message-queue/MessageQueueService"

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
	handleImplementPlan: vi.fn(),
	handleModeSwitch: vi.fn(),
	setTaskReasoningPreference: vi.fn(),
	updateTaskApprovalMode: vi.fn(),
	getReasoningCapabilities: vi.fn(),
	activateProviderProfile: vi.fn(),
	postStateToWebview: vi.fn(),
	postTaskQueueToWebview: vi.fn(async () => undefined),
	getCurrentTask: vi.fn(),
	getLiveTask: vi.fn(),
	canAcceptTaskInput: vi.fn(() => true),
	queueMessageForTaskDurably: vi.fn(async (taskId: string, text: string, images?: string[]) => {
		const task = mockAlphaProvider.getLiveTask(taskId)
		if (!task || !mockAlphaProvider.canAcceptTaskInput(taskId)) return false
		return Boolean(task.messageQueueService.addMessage(text, images))
	}),
	getTaskWithId: vi.fn(),
	createTask: vi.fn(),
	createTaskWithHistoryItem: vi.fn(),
	cancelTask: vi.fn(),
	showTaskWithId: vi.fn(),
	clearPublishedTaskTranscriptRevisions: vi.fn(),
	exportTaskWithId: vi.fn(),
	condenseTaskContext: vi.fn(),
	deleteTaskWithId: vi.fn(),
	getSkillsManager: vi.fn(),
	getCurrentWorkspaceCodeIndexManager: vi.fn(),
	cwd: "/mock/workspace",
} as unknown as AlphaProvider

describe("task reasoning messages", () => {
	const state = {
		requested: { kind: "effort", effort: "high" },
		effective: { kind: "effort", effort: "high" },
		capabilities: { kind: "effort", efforts: ["low", "high"], canDisable: false },
	} as const

	beforeEach(() => vi.clearAllMocks())

	it("reposts accepted state after a rejected composer profile switch", async () => {
		vi.mocked(mockAlphaProvider.activateProviderProfile).mockRejectedValueOnce(new Error("profile unavailable"))
		await webviewMessageHandler(mockAlphaProvider, { type: "loadApiConfigurationById", text: "missing-profile" })
		expect(mockAlphaProvider.activateProviderProfile).toHaveBeenCalledWith({ id: "missing-profile" })
		expect(mockAlphaProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("addresses the task and correlates an acknowledgement only after the write succeeds", async () => {
		let accept!: () => void
		vi.mocked(mockAlphaProvider.setTaskReasoningPreference).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					accept = () => resolve(structuredClone(state) as never)
				}),
		)
		const pending = webviewMessageHandler(mockAlphaProvider, {
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: {
				requestId: "r1",
				taskId: "background",
				preference: { kind: "effort", effort: "high" },
			},
		})
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
		accept()
		await pending
		expect(mockAlphaProvider.setTaskReasoningPreference).toHaveBeenCalledWith(
			"background",
			{
				kind: "effort",
				effort: "high",
			},
			{ rememberForNewTasks: true },
		)
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskReasoningUpdated",
			taskReasoningResponse: { requestId: "r1", taskId: "background", state },
		})
	})

	it("rejects malformed preferences without calling the runtime", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: { requestId: "r2", preference: { kind: "custom", value: "bad token" } },
		})
		expect(mockAlphaProvider.setTaskReasoningPreference).not.toHaveBeenCalled()
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskReasoningUpdated",
			taskReasoningResponse: { requestId: "r2", error: "invalid" },
		})
	})

	it("correlates invalid preferences with the addressed existing task", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: {
				requestId: "invalid-existing",
				taskId: "background",
				preference: { kind: "custom", value: "bad token" },
			},
		})

		expect(mockAlphaProvider.setTaskReasoningPreference).not.toHaveBeenCalled()
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskReasoningUpdated",
			taskReasoningResponse: { requestId: "invalid-existing", taskId: "background", error: "invalid" },
		})
	})

	it("reports rejected writes without exposing sensitive error text", async () => {
		vi.mocked(mockAlphaProvider.setTaskReasoningPreference).mockRejectedValueOnce(new Error("private storage path"))
		await webviewMessageHandler(mockAlphaProvider, {
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: { requestId: "r3", preference: { kind: "default" } },
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskReasoningUpdated",
			taskReasoningResponse: { requestId: "r3", taskId: undefined, error: "saveFailed" },
		})
	})

	it("routes a valid approval update to its task and returns the scoped result", async () => {
		vi.mocked(mockAlphaProvider.updateTaskApprovalMode).mockReturnValueOnce({
			requestId: "approval-1",
			taskId: "background-task",
			status: "applied",
			approvalMode: "ask",
		})

		await webviewMessageHandler(mockAlphaProvider, {
			type: "setTaskApprovalMode",
			taskApprovalModeUpdate: {
				requestId: "approval-1",
				taskId: "background-task",
				approvalMode: "ask",
			},
		})

		expect(mockAlphaProvider.updateTaskApprovalMode).toHaveBeenCalledWith({
			requestId: "approval-1",
			taskId: "background-task",
			approvalMode: "ask",
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskApprovalModeUpdated",
			taskApprovalModeUpdateResult: {
				requestId: "approval-1",
				taskId: "background-task",
				status: "applied",
				approvalMode: "ask",
			},
		})
		expect(mockAlphaProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("returns explicit target-unavailable status without widening the update", async () => {
		vi.mocked(mockAlphaProvider.updateTaskApprovalMode).mockReturnValueOnce({
			requestId: "approval-2",
			taskId: "closed-task",
			status: "targetUnavailable",
		})

		await webviewMessageHandler(mockAlphaProvider, {
			type: "setTaskApprovalMode",
			taskApprovalModeUpdate: { requestId: "approval-2", taskId: "closed-task", approvalMode: "bypass" },
		})

		expect(mockAlphaProvider.updateTaskApprovalMode).toHaveBeenCalledWith({
			requestId: "approval-2",
			taskId: "closed-task",
			approvalMode: "bypass",
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskApprovalModeUpdated",
			taskApprovalModeUpdateResult: {
				requestId: "approval-2",
				taskId: "closed-task",
				status: "targetUnavailable",
			},
		})
		expect(mockAlphaProvider.postStateToWebview).not.toHaveBeenCalled()
	})

	it("rejects malformed approval updates and correlates by request even without a usable task id", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "setTaskApprovalMode",
			taskApprovalModeUpdate: { requestId: "approval-3", approvalMode: "unsafe" },
		} as unknown as WebviewMessage)

		expect(mockAlphaProvider.updateTaskApprovalMode).not.toHaveBeenCalled()
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskApprovalModeUpdated",
			taskApprovalModeUpdateResult: {
				requestId: "approval-3",
				status: "rejected",
				error: "invalid",
			},
		})
	})
})

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
		access: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../../mentions/resolveImageMentions", async () => {
	const actual = await vi.importActual<typeof import("../../mentions/resolveImageMentions")>(
		"../../mentions/resolveImageMentions",
	)
	return {
		...actual,
		resolveImageMentions: vi.fn(async ({ text, images }: { text: string; images?: string[] }) => ({
			text,
			images: [...(images ?? []), "data:image/png;base64,from-mention"],
		})),
	}
})

import { resolveImageMentions } from "../../mentions/resolveImageMentions"

beforeEach(() => {
	vi.mocked(mockAlphaProvider.canAcceptTaskInput).mockReturnValue(true)
})

describe("webviewMessageHandler - implement plan", () => {
	it("restores authoritative state when an optimistic mode switch fails", async () => {
		vi.mocked(mockAlphaProvider.postStateToWebview).mockClear()
		vi.mocked(mockAlphaProvider.handleModeSwitch).mockRejectedValueOnce(new Error("unresolved approval"))
		await expect(webviewMessageHandler(mockAlphaProvider, { type: "mode", text: "architect" })).rejects.toThrow(
			"unresolved approval",
		)
		expect(mockAlphaProvider.postStateToWebview).toHaveBeenCalledExactlyOnceWith()
	})
	it("routes the task and plan identity to the host", async () => {
		vi.mocked(mockAlphaProvider.handleImplementPlan).mockResolvedValue(undefined)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "implementPlan",
			taskId: "plan-task",
			planDigest: "digest",
		})
		expect(mockAlphaProvider.handleImplementPlan).toHaveBeenCalledWith("plan-task", "digest")
	})

	it("shows a localized error when implementation cannot start", async () => {
		vi.mocked(mockAlphaProvider.postStateToWebview).mockClear()
		vi.mocked(mockAlphaProvider.handleImplementPlan).mockRejectedValueOnce(new Error("stale plan"))
		await webviewMessageHandler(mockAlphaProvider, {
			type: "implementPlan",
			taskId: "plan-task",
			planDigest: "digest",
		})
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(t("common:planHandoff.implementFailed"))
		expect(mockAlphaProvider.log).toHaveBeenCalledWith("[implementPlan] stale plan")
		expect(mockAlphaProvider.postStateToWebview).toHaveBeenCalledExactlyOnceWith()
	})
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

	it("passes a non-negative cached transcript revision to the provider", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "showTaskWithId",
			text: "cached-task",
			values: { cachedTranscriptRevision: 42 },
		})

		expect(mockAlphaProvider.showTaskWithId).toHaveBeenCalledWith("cached-task", 42)
	})

	it("ignores an invalid cached transcript revision", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "showTaskWithId",
			text: "cached-task",
			values: { cachedTranscriptRevision: -1 },
		})

		expect(mockAlphaProvider.showTaskWithId).toHaveBeenCalledWith("cached-task")
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

describe("webviewMessageHandler - Google code index settings", () => {
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

	it("reports only presence flags for embedding and vector-store secrets", async () => {
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
			"codebaseIndexGeminiApiKey",
		])
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "codeIndexSecretStatus",
			values: {
				hasQdrantApiKey: true,
				hasVertexJsonCredentials: true,
				hasGeminiApiKey: false,
			},
		})
	})

	it("stores Gemini credentials only in SecretStorage and preserves an omitted key", async () => {
		const settings = {
			...createVertexSettings(),
			codebaseIndexEmbedderProvider: "gemini",
			codebaseIndexGeminiApiKey: "index-secret",
		}
		await webviewMessageHandler(mockAlphaProvider, {
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: settings,
		} as any)
		const contextProxy = mockAlphaProvider.contextProxy as any
		expect(contextProxy.storeSecret).toHaveBeenCalledWith("codebaseIndexGeminiApiKey", "index-secret")
		expect(
			contextProxy.setValue.mock.calls.find(([key]: [string]) => key === "codebaseIndexConfig")[1],
		).not.toHaveProperty("codebaseIndexGeminiApiKey")
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalledWith(
			expect.objectContaining({
				settings: expect.objectContaining({ codebaseIndexGeminiApiKey: "index-secret" }),
			}),
		)
		contextProxy.storeSecret.mockClear()
		const { codebaseIndexGeminiApiKey: _key, ...withoutKey } = settings
		await webviewMessageHandler(mockAlphaProvider, {
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: withoutKey,
		} as any)
		expect(contextProxy.storeSecret.mock.calls.some(([key]: [string]) => key === "codebaseIndexGeminiApiKey")).toBe(
			false,
		)
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
		expect(mockHandleWebviewAskResponse).toHaveBeenCalledWith(
			"messageResponse",
			"See @/img.png",
			["data:image/png;base64,from-mention"],
			undefined,
			undefined,
		)
	})

	it("persists the exact async question card after accepting its ordinary reply", async () => {
		const handleWebviewAskResponse = vi.fn()
		const markAsyncUserInputAnswered = vi.fn().mockResolvedValue(true)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			handleWebviewAskResponse,
			markAsyncUserInputAnswered,
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "askResponse",
			askResponse: "messageResponse",
			text: "Answers to the earlier questions:\n\nWhich color?\nAnswer: Blue",
			taskId: "task-1",
			asyncUserInputMessageTs: 42,
		})

		expect(handleWebviewAskResponse).toHaveBeenCalledOnce()
		expect(markAsyncUserInputAnswered).toHaveBeenCalledExactlyOnceWith(42)
		expect(handleWebviewAskResponse.mock.invocationCallOrder[0]).toBeLessThan(
			markAsyncUserInputAnswered.mock.invocationCallOrder[0],
		)
	})

	it("routes typed approval decisions with their request id", async () => {
		const handleWebviewToolApprovalResponse = vi.fn().mockReturnValue(true)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({ handleWebviewToolApprovalResponse } as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "toolApprovalResponse",
			taskId: "task-1",
			approvalRequestId: "task-1:call-1",
			toolApprovalDecision: { decision: "abort" },
		})

		expect(handleWebviewToolApprovalResponse).toHaveBeenCalledWith("task-1:call-1", { decision: "abort" })
	})

	it("ignores legacy askResponse messages while a typed approval is pending", async () => {
		const handleWebviewAskResponse = vi.fn()
		const markAsyncUserInputAnswered = vi.fn()
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			hasPendingToolApprovalRequest: vi.fn().mockReturnValue(true),
			handleWebviewAskResponse,
			markAsyncUserInputAnswered,
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "askResponse",
			askResponse: "yesButtonClicked",
			taskId: "task-1",
			asyncUserInputMessageTs: 42,
		})

		expect(handleWebviewAskResponse).not.toHaveBeenCalled()
		expect(markAsyncUserInputAnswered).not.toHaveBeenCalled()
		expect(mockAlphaProvider.log).toHaveBeenCalledWith(
			"[webviewMessageHandler] Ignoring legacy askResponse while a typed tool approval is active",
		)
	})

	it("rejects a legacy reply when the ask changes during image resolution", async () => {
		const handleWebviewAskResponse = vi.fn()
		const task = { taskAsk: { ts: 10 }, cwd: "/mock/workspace", handleWebviewAskResponse }
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue(task as any)
		let release!: (state: any) => void
		vi.mocked(mockAlphaProvider.getState).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const dispatch = webviewMessageHandler(mockAlphaProvider, {
			type: "askResponse",
			taskId: "task-1",
			askMessageTs: 10,
			askResponse: "messageResponse",
			text: "see @/img.png",
		})
		await vi.waitFor(() => expect(release).toBeDefined())
		task.taskAsk = { ts: 11 }
		release({ maxImageFileSize: 5, maxTotalImageSize: 20 })
		await dispatch
		expect(handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it("correlates a failed completed-task resume without overwriting the active composer", async () => {
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue(undefined)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "resumeCompletedTask",
			taskId: "background",
			requestId: "resume-1",
			text: "retain this",
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "background",
				type: "chatCommandResult",
				chatCommandResult: expect.objectContaining({ requestId: "resume-1", status: "rejected" }),
			}),
		)
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "invoke" }),
		)
	})

	it("resumes a completed task with the submitted follow-up instead of creating a task", async () => {
		const resumeCompletedTaskFollowup = vi.fn().mockResolvedValue(undefined)
		const markAsyncUserInputAnswered = vi.fn().mockResolvedValue(true)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			cwd: "/mock/workspace",
			alphaIgnoreController: undefined,
			resumeCompletedTaskFollowup,
			markAsyncUserInputAnswered,
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "resumeCompletedTask",
			text: "Evaluate @/img.png",
			images: [],
			taskId: "task-1",
			asyncUserInputMessageTs: 42,
		})

		expect(resumeCompletedTaskFollowup).toHaveBeenCalledWith("Evaluate @/img.png", [
			"data:image/png;base64,from-mention",
		])
		expect(mockAlphaProvider.createTask).not.toHaveBeenCalled()
		expect(markAsyncUserInputAnswered).toHaveBeenCalledExactlyOnceWith(42)
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
			taskId: "task-1",
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
			taskId: "missing-task",
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

describe("webviewMessageHandler - retained completed-task input receipts", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(mockAlphaProvider.getState).mockResolvedValue({ maxImageFileSize: 5, maxTotalImageSize: 20 } as any)
	})

	const request = {
		type: "resumeCompletedTask" as const,
		taskId: "task-1",
		requestId: "retained-followup",
		text: "Continue the work",
	}

	it.each(["consumed", "claimed"])("rechecks %s input after publishing its pending queue", async (state) => {
		const queue = new MessageQueueService()
		queue.addMessage(request.text, undefined, request.requestId)
		const history: { queued_message_ids: string[] }[] = []
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: request.taskId,
			apiConversationHistory: history,
			messageQueueService: queue,
			hasAcceptedQueuedUserMessage: vi.fn().mockResolvedValue(true),
		} as any)
		let releaseProjection!: () => void
		let projectionStarted!: () => void
		const started = new Promise<void>((resolve) => (projectionStarted = resolve))
		vi.mocked(mockAlphaProvider.postTaskQueueToWebview).mockImplementationOnce(async () => {
			projectionStarted()
			await new Promise<void>((resolve) => (releaseProjection = resolve))
		})
		const dispatch = webviewMessageHandler(mockAlphaProvider, request)
		await Promise.race([started, dispatch])
		expect(mockAlphaProvider.postTaskQueueToWebview).toHaveBeenCalledOnce()
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
		if (state === "consumed") history.push({ queued_message_ids: [request.requestId] })
		else queue.claimMessage(request.requestId)
		releaseProjection()
		await dispatch
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "chatCommandResult",
			taskId: request.taskId,
			requestId: request.requestId,
			chatCommandResult: {
				requestId: request.requestId,
				taskId: request.taskId,
				command: "resumeCompletedTask",
				status: "accepted",
			},
		})
	})

	it.each([false, true])(
		"publishes retained input before its accepted queued receipt (duplicate: %s)",
		async (duplicate) => {
			const queue = new MessageQueueService()
			const submitUserMessage = vi.fn(async () => {
				queue.addMessage(request.text, undefined, request.requestId)
				queue.claimMessage(request.requestId)
				// Preparation failed after admission; the owning task released its claim.
				queue.releaseMessage(request.requestId)
			})
			if (duplicate) queue.addMessage(request.text, undefined, request.requestId)
			vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
				taskId: request.taskId,
				cwd: "/mock/workspace",
				apiConversationHistory: [],
				messageQueueService: queue,
				hasAcceptedQueuedUserMessage: vi.fn().mockResolvedValue(duplicate),
				isCompleted: vi.fn().mockReturnValue(true),
				submitUserMessage,
			} as any)

			await webviewMessageHandler(mockAlphaProvider, request)

			expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "chatCommandResult",
				taskId: request.taskId,
				requestId: request.requestId,
				chatCommandResult: {
					requestId: request.requestId,
					taskId: request.taskId,
					command: "resumeCompletedTask",
					status: "accepted",
					deliveryState: "queued",
				},
			})
			expect(mockAlphaProvider.postTaskQueueToWebview).toHaveBeenCalledExactlyOnceWith(
				request.taskId,
				queue.visibleMessages,
			)
			expect(vi.mocked(mockAlphaProvider.postTaskQueueToWebview).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(mockAlphaProvider.postMessageToWebview).mock.invocationCallOrder[0],
			)
			expect(submitUserMessage).toHaveBeenCalledTimes(duplicate ? 0 : 1)
			expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "invoke" }),
			)
		},
	)

	it.each([
		{ duplicate: false, state: "consumed" },
		{ duplicate: true, state: "consumed" },
		{ duplicate: false, state: "claimed" },
		{ duplicate: true, state: "claimed" },
		{ duplicate: false, state: "unrelated" },
		{ duplicate: true, state: "unrelated" },
	])("omits queued delivery for $state input (duplicate: $duplicate)", async ({ duplicate, state }) => {
		const queue = new MessageQueueService()
		queue.addMessage(request.text, undefined, state === "unrelated" ? "different-request" : request.requestId)
		if (state === "claimed") queue.claimMessage(request.requestId)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: request.taskId,
			cwd: "/mock/workspace",
			apiConversationHistory: state === "consumed" ? [{ queued_message_ids: [request.requestId] }] : [],
			messageQueueService: queue,
			hasAcceptedQueuedUserMessage: vi.fn().mockResolvedValue(duplicate),
			isCompleted: vi.fn().mockReturnValue(true),
			submitUserMessage: vi.fn().mockResolvedValue(undefined),
		} as any)

		await webviewMessageHandler(mockAlphaProvider, request)

		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "chatCommandResult",
			taskId: request.taskId,
			requestId: request.requestId,
			chatCommandResult: {
				requestId: request.requestId,
				taskId: request.taskId,
				command: "resumeCompletedTask",
				status: "accepted",
			},
		})
		expect(mockAlphaProvider.postTaskQueueToWebview).not.toHaveBeenCalled()
	})
})

describe("webviewMessageHandler - queued message steering", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("publishes accepted input before acknowledging the composer submission", async () => {
		const queue = [{ id: "visible-input", timestamp: 1, text: "unrelated words" }]
		vi.mocked(mockAlphaProvider.queueMessageForTaskDurably).mockResolvedValueOnce(true)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: "task-1",
			messageQueueService: { visibleMessages: queue },
		} as any)
		let finishProjection!: () => void
		const projectionStarted = new Promise<void>((resolve) => {
			vi.mocked(mockAlphaProvider.postTaskQueueToWebview).mockImplementationOnce(async () => {
				resolve()
				await new Promise<void>((finish) => {
					finishProjection = finish
				})
			})
		})
		const dispatch = webviewMessageHandler(mockAlphaProvider, {
			type: "queueMessage",
			taskId: "task-1",
			requestId: "visible-input",
			text: "unrelated words",
		})
		await Promise.race([projectionStarted, dispatch])
		expect(mockAlphaProvider.postTaskQueueToWebview).toHaveBeenCalledWith("task-1", queue)
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "chatCommandResult" }),
		)
		finishProjection()
		await dispatch
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ chatCommandResult: expect.objectContaining({ status: "accepted" }) }),
		)
	})

	it("waits for durable queue admission before acknowledging a background submission", async () => {
		let admit!: (value: boolean) => void
		vi.mocked(mockAlphaProvider.queueMessageForTaskDurably).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					admit = resolve
				}),
		)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({} as any)
		const dispatch = webviewMessageHandler(mockAlphaProvider, {
			type: "queueMessage",
			taskId: "background",
			requestId: "queue-durable",
			text: "recoverable",
		})
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
		admit(true)
		await dispatch
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "background",
				chatCommandResult: expect.objectContaining({ requestId: "queue-durable", status: "accepted" }),
			}),
		)
	})

	it("publishes the containing transcript when accepted input is consumed before its receipt", async () => {
		vi.mocked(mockAlphaProvider.queueMessageForTaskDurably).mockResolvedValueOnce(true)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: "task-1",
			messageQueueService: { visibleMessages: [] },
		} as any)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "queueMessage",
			taskId: "task-1",
			requestId: "already-consumed-input",
			text: "arbitrary input",
		})
		expect(mockAlphaProvider.postTaskQueueToWebview).toHaveBeenCalledWith("task-1", [], {
			includeTranscript: true,
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ chatCommandResult: expect.objectContaining({ status: "accepted" }) }),
		)
	})

	it("still acknowledges durable input when its async question annotation fails", async () => {
		vi.mocked(mockAlphaProvider.queueMessageForTaskDurably).mockResolvedValueOnce(true)
		const markAsyncUserInputAnswered = vi.fn().mockRejectedValue(new Error("annotation write failed"))
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({ markAsyncUserInputAnswered } as any)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "queueMessage",
			taskId: "task-1",
			requestId: "accepted-input",
			text: "arbitrary input",
			asyncUserInputMessageTs: 42,
		})
		expect(markAsyncUserInputAnswered).toHaveBeenCalledWith(42)
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ chatCommandResult: expect.objectContaining({ status: "accepted" }) }),
		)
	})

	it("hands the selected identity to the task's durable steering boundary", async () => {
		const queuedMessage = {
			id: "queued-1",
			timestamp: Date.now(),
			text: "steer this now",
			images: ["img1.png"],
		}
		const getMessage = vi.fn().mockReturnValue(queuedMessage)
		const removeMessage = vi.fn().mockReturnValue(true)
		const steerQueuedUserMessage = vi.fn().mockResolvedValue(undefined)

		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: "task-1",
			messageQueueService: {
				getMessage,
				removeMessage,
			},
			steerQueuedUserMessage,
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
		expect(steerQueuedUserMessage).toHaveBeenCalledWith("queued-1")
		expect(removeMessage).not.toHaveBeenCalled()
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
		const steerQueuedUserMessage = vi.fn().mockRejectedValue(new Error("another steering message is pending"))

		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: "task-1",
			messageQueueService: {
				getMessage,
				removeMessage,
			},
			steerQueuedUserMessage,
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
		vi.mocked(mockAlphaProvider.queueMessageForTaskDurably).mockResolvedValue(true)
		const recordTaskPerformanceDuration = vi.fn()
		const markAsyncUserInputAnswered = vi.fn().mockResolvedValue(true)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			recordTaskPerformanceDuration,
			markAsyncUserInputAnswered,
		} as any)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "queueMessage",
			text: "keep this safe",
			images: [],
			taskId: "task-1",
			requestId: "queue-request-1",
			clientSubmittedAt: Date.now() - 15,
			asyncUserInputMessageTs: 42,
		})
		expect(recordTaskPerformanceDuration).toHaveBeenCalledWith("queue_admission", expect.any(Number))
		expect(markAsyncUserInputAnswered).toHaveBeenCalledExactlyOnceWith(42)

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

	it("admits plain text without waiting for provider state", async () => {
		const queued: string[] = []
		vi.mocked(mockAlphaProvider.queueMessageForTaskDurably).mockImplementation(async (_taskId, text) => {
			queued.push(text)
			return true
		})
		let stateObserved = false
		vi.mocked(mockAlphaProvider.getState).mockImplementation(
			() =>
				new Promise(() => {
					stateObserved = true
				}),
		)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "queueMessage",
			text: "plain guidance @/notes.md",
			taskId: "task-1",
			requestId: "queue-plain",
		})

		expect(stateObserved).toBe(false)
		expect(mockAlphaProvider.getState).not.toHaveBeenCalled()
		expect(queued).toEqual(["plain guidance @/notes.md"])
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chatCommandResult",
				requestId: "queue-plain",
				chatCommandResult: expect.objectContaining({ status: "accepted" }),
			}),
		)
	})

	it("keeps rapidly submitted plain-text messages ordered without dropping or duplicating them", async () => {
		const queued: string[] = []
		vi.mocked(mockAlphaProvider.queueMessageForTaskDurably).mockImplementation(async (_taskId, text) => {
			queued.push(text)
			return true
		})
		vi.mocked(mockAlphaProvider.getState).mockImplementation(() => new Promise(() => undefined))
		const texts = ["first", "second", "third"]

		await Promise.all(
			texts.map((text, index) =>
				webviewMessageHandler(mockAlphaProvider, {
					type: "queueMessage",
					text,
					taskId: "task-1",
					requestId: `rapid-${index}`,
				}),
			),
		)

		expect(queued).toEqual(texts)
		expect(mockAlphaProvider.getState).not.toHaveBeenCalled()
		const acks = vi
			.mocked(mockAlphaProvider.postMessageToWebview)
			.mock.calls.map((call) => call[0])
			.filter((message) => message.type === "chatCommandResult")
		expect(acks.map((message) => message.requestId)).toEqual(["rapid-0", "rapid-1", "rapid-2"])
		expect(new Set(acks.map((message) => message.requestId)).size).toBe(3)
	})

	it("still resolves image mentions and explicit images through provider limits", async () => {
		const queued: Array<{ text: string; images?: string[] }> = []
		vi.mocked(mockAlphaProvider.queueMessageForTaskDurably).mockImplementation(async (_taskId, text, images) => {
			queued.push({ text, images })
			return true
		})
		let releaseState!: (state: { maxImageFileSize: number; maxTotalImageSize: number }) => void
		vi.mocked(mockAlphaProvider.getState).mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseState = (state) => resolve(state as never)
				}),
		)
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({ cwd: "/mock/workspace" } as any)

		const mentioned = webviewMessageHandler(mockAlphaProvider, {
			type: "queueMessage",
			text: "look at @/screen.png",
			taskId: "task-1",
			requestId: "queue-mention",
		})
		await vi.waitFor(() => expect(mockAlphaProvider.getState).toHaveBeenCalled())
		expect(mockAlphaProvider.queueMessageForTaskDurably).not.toHaveBeenCalled()
		releaseState({ maxImageFileSize: 3, maxTotalImageSize: 9 })
		await mentioned

		expect(resolveImageMentions).toHaveBeenCalledWith(
			expect.objectContaining({ maxImageFileSize: 3, maxTotalImageSize: 9, text: "look at @/screen.png" }),
		)
		expect(queued[0]?.images).toContain("data:image/png;base64,from-mention")

		vi.mocked(mockAlphaProvider.getState).mockResolvedValue({
			maxImageFileSize: 4,
			maxTotalImageSize: 8,
		} as never)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "queueMessage",
			text: "attached only",
			images: ["data:image/png;base64,explicit"],
			taskId: "task-1",
			requestId: "queue-explicit",
		})
		expect(mockAlphaProvider.getState).toHaveBeenCalled()
		expect(resolveImageMentions).toHaveBeenLastCalledWith(
			expect.objectContaining({
				maxImageFileSize: 4,
				maxTotalImageSize: 8,
				images: ["data:image/png;base64,explicit"],
			}),
		)
		expect(queued.map((entry) => entry.text)).toEqual(["look at @/screen.png", "attached only"])
	})

	it("does not queue or steer messages into terminal tasks", async () => {
		const addMessage = vi.fn()
		const getMessage = vi.fn()
		const steerUserMessage = vi.fn()
		vi.mocked(mockAlphaProvider.canAcceptTaskInput).mockReturnValue(false)
		vi.mocked(mockAlphaProvider.queueMessageForTaskDurably).mockResolvedValue(false)
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
				flush: vi.fn().mockResolvedValue(undefined),
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

	it("captures a draft approval choice on the new task without updating the global default", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "newTask",
			text: "Build the feature",
			images: [],
			taskApprovalMode: "ask",
		})

		expect(mockAlphaProvider.createTask).toHaveBeenCalledWith(
			"Build the feature",
			expect.any(Array),
			undefined,
			{ taskId: undefined, preserveExisting: true, taskApprovalMode: "ask" },
			undefined,
		)
		expect(mockAlphaProvider.contextProxy.setValue).not.toHaveBeenCalled()
	})

	it("rejects an invalid draft approval mode before creating a task", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "newTask",
			text: "Build the feature",
			taskApprovalMode: "unsafe",
		} as unknown as WebviewMessage)

		expect(mockAlphaProvider.createTask).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Invalid task approval mode")
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
		const rulesFolderPath = path.join("/mock/workspace", ".alpha", `rules-${slug}`)

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
		const rulesFolderPath = path.join("/mock/workspace", ".alpha", `rules-${slug}`)
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

describe("webviewMessageHandler - Alpha project configuration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(mockAlphaProvider.getCurrentTask).mockReturnValue(undefined)
		vi.mocked(getWorkspacePath).mockReturnValue("/mock/workspace")
		vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }))
		vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined)
		mockGetCommands.mockResolvedValue([])
	})

	afterEach(() => {
		vi.mocked(fs.access).mockResolvedValue(undefined)
	})

	it("creates and opens project MCP configuration in .alpha", async () => {
		await webviewMessageHandler(mockAlphaProvider, { type: "openProjectMcpSettings" })
		const configPath = path.join("/mock/workspace", ".alpha", "mcp.json")
		expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(configPath), { recursive: true })
		expect(fs.writeFile).toHaveBeenCalledWith(configPath, JSON.stringify({ mcpServers: {} }, null, 2), {
			encoding: "utf-8",
			flag: "wx",
		})
		expect(openFile).toHaveBeenCalledWith(configPath)
	})

	it("opens an existing or concurrently created MCP file without overwriting it", async () => {
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.writeFile).mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "EEXIST" }))
		await webviewMessageHandler(mockAlphaProvider, { type: "openProjectMcpSettings" })
		expect(openFile).toHaveBeenCalledWith(path.join("/mock/workspace", ".alpha", "mcp.json"))
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("creates project slash commands in .alpha where discovery can find them", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "createCommand",
			text: "Project Setup",
			values: { source: "project" },
		})
		expect(fs.writeFile).toHaveBeenCalledWith(
			path.join("/mock/workspace", ".alpha", "commands", "project-setup.md"),
			t("common:errors.command_template_content"),
			"utf8",
		)
		expect(mockGetCommands).toHaveBeenCalledWith("/mock/workspace")
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
			undefined,
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
