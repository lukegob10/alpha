// npx vitest core/webview/__tests__/webviewMessageHandler.spec.ts

vi.mock("../../../services/command/commands", () => ({
	getCommands: vi.fn(),
}))

vi.mock("../../../integrations/misc/open-file", () => ({
	openFile: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../integrations/editor/openDiff", () => ({
	openDiff: vi.fn().mockResolvedValue(undefined),
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
import type { ExtensionContext } from "vscode"

import { webviewMessageHandler } from "../webviewMessageHandler"
import { MessageEnhancer } from "../messageEnhancer"
import { beginPromptEnhancement } from "../promptEnhancementRequests"
import { TaskRenameError } from "../../task-persistence/TaskHistoryStore"
import * as todoTools from "../../tools/UpdateTodoListTool"
import type { AlphaProvider } from "../AlphaProvider"
import { getCommands } from "../../../services/command/commands"
import { openFile } from "../../../integrations/misc/open-file"
import { openDiff } from "../../../integrations/editor/openDiff"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import type { Task } from "../../task/Task"
import * as taskPersistence from "../../task-persistence"
import {
	ProviderSettingsManager,
	ProviderProfileRenameError,
	ProviderProfileSaveError,
} from "../../config/ProviderSettingsManager"

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
	setWebviewFocused: vi.fn(async () => undefined),
	updateTaskApprovalMode: vi.fn(),
	getReasoningCapabilities: vi.fn(),
	activateProviderProfile: vi.fn(),
	renameProviderProfile: vi.fn(),
	upsertProviderProfile: vi.fn(),
	postStateToWebview: vi.fn(),
	postTaskQueueToWebview: vi.fn(async () => undefined),
	getCurrentTask: vi.fn(),
	getTaskNavigationGeneration: vi.fn(() => 0),
	getLiveTask: vi.fn(),
	getAgentLifecycleSnapshot: vi.fn(),
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

describe("built-in personality Settings messages", () => {
	beforeEach(() => {
		vi.mocked(mockAlphaProvider.contextProxy.setValue).mockClear()
		vi.mocked(mockAlphaProvider.postStateToWebview).mockClear()
	})

	it.each(["default", "none"] as const)(
		"persists the supported %s choice before projecting state",
		async (personality) => {
			let finishWrite!: () => void
			const writing = new Promise<void>((resolve) => (finishWrite = resolve))
			vi.mocked(mockAlphaProvider.contextProxy.setValue).mockReturnValueOnce(writing)
			const save = webviewMessageHandler(mockAlphaProvider, {
				type: "updateSettings",
				updatedSettings: { personality },
			})
			expect(mockAlphaProvider.contextProxy.setValue).toHaveBeenCalledWith("personality", personality)
			expect(mockAlphaProvider.postStateToWebview).not.toHaveBeenCalled()
			finishWrite()
			await save
			expect(mockAlphaProvider.postStateToWebview).toHaveBeenCalledOnce()
		},
	)

	it.each(["pragmatic", "friendly", "", true, 1, null, {}])(
		"rejects the unsupported choice %j without replacing the saved preference",
		async (personality) => {
			const message = { type: "updateSettings", updatedSettings: { personality } } as unknown as WebviewMessage
			await expect(webviewMessageHandler(mockAlphaProvider, message)).rejects.toThrow()
			expect(mockAlphaProvider.contextProxy.setValue).not.toHaveBeenCalled()
			expect(mockAlphaProvider.postStateToWebview).not.toHaveBeenCalled()
		},
	)
})

describe("prompt enhancement cancellation messages", () => {
	afterEach(() => vi.restoreAllMocks())

	it("does not cancel an enhancement when a stale Stop targets a previous turn", async () => {
		const host = {
			...mockAlphaProvider,
			getLiveTask: vi.fn(() => ({ matchesExpectedTurn: () => false })),
		} as unknown as AlphaProvider
		const request = beginPromptEnhancement(host, "current-enhancement", "task")
		await webviewMessageHandler(host, { type: "cancelTask", taskId: "task", expectedTurnId: "previous-turn" })
		expect(request.signal.aborted).toBe(false)
		request.finish()
	})

	it.each(["cancelEnhancePrompt", "cancelTask"] as const)(
		"%s cancels the owned request and rejects its late enhancement result",
		async (control) => {
			let enter!: () => void
			let finish!: (result: { success: boolean; enhancedText: string }) => void
			const entered = new Promise<void>((resolve) => (enter = resolve))
			const response = new Promise<{ success: boolean; enhancedText: string }>((resolve) => (finish = resolve))
			let requestSignal: AbortSignal | undefined
			vi.spyOn(MessageEnhancer, "enhanceMessage").mockImplementationOnce((options) => {
				requestSignal = options.signal
				enter()
				return response
			})
			const postMessageToWebview = vi.fn(async () => undefined)
			const host = {
				...mockAlphaProvider,
				getState: vi.fn(async () => ({ apiConfiguration: { apiProvider: "vscode-lm" } })),
				postMessageToWebview,
			} as unknown as AlphaProvider
			const pending = webviewMessageHandler(host, {
				type: "enhancePrompt",
				requestId: "enhance-cancelled",
				taskId: "enhanced-task",
				text: "Original draft",
			})
			await entered
			await webviewMessageHandler(host, {
				type: control,
				requestId: "enhance-cancelled",
				taskId: "enhanced-task",
			})
			finish({ success: true, enhancedText: "Late stale result" })
			await pending

			expect(requestSignal?.aborted).toBe(true)
			expect(postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "enhancedPrompt",
				requestId: "enhance-cancelled",
				enhancementStatus: "cancelled",
			})
		},
	)
})

describe("chat rename and toolbar host messages", () => {
	const renamed = { id: "chat-1", displayName: "Useful name" }
	const rename = vi.fn()
	const host = { ...mockAlphaProvider, renameTask: rename } as unknown as AlphaProvider
	const request = {
		type: "renameTask" as const,
		taskRenameRequest: { taskId: "chat-1", requestId: "rename-1", displayName: "  Useful name  " },
	}

	beforeEach(() => {
		vi.clearAllMocks()
		rename.mockReset().mockResolvedValue(renamed)
	})

	it("trims the label and acknowledges the persisted identity only after the save settles", async () => {
		let complete!: (item: typeof renamed) => void
		rename.mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)))
		const pending = webviewMessageHandler(host, request)
		expect(rename).toHaveBeenCalledExactlyOnceWith("chat-1", "Useful name")
		expect(host.postMessageToWebview).not.toHaveBeenCalled()
		complete(renamed)
		await pending
		expect(host.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "taskRenameResult",
			taskRenameResult: {
				taskId: "chat-1",
				requestId: "rename-1",
				status: "success",
				displayName: "Useful name",
			},
		})
	})

	it.each(["", " ", "x".repeat(97)])(
		"rejects an invalid label without entering persistence (%s)",
		async (displayName) => {
			await webviewMessageHandler(host, {
				...request,
				taskRenameRequest: { ...request.taskRenameRequest, displayName },
			})
			expect(rename).not.toHaveBeenCalled()
			expect(host.postMessageToWebview).toHaveBeenCalledWith({
				type: "taskRenameResult",
				taskRenameResult: {
					taskId: "chat-1",
					requestId: "rename-1",
					status: "error",
					error: "invalid",
				},
			})
		},
	)

	it.each(["notFound", "wrongWorkspace"] as const)("returns a bounded %s rejection", async (code) => {
		rename.mockRejectedValueOnce(new TaskRenameError(code))
		await webviewMessageHandler(host, request)
		expect(host.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskRenameResult",
			taskRenameResult: {
				taskId: "chat-1",
				requestId: "rename-1",
				status: "error",
				error: code,
			},
		})
	})

	it("does not retry a committed rename when its acknowledgement transport fails", async () => {
		vi.mocked(host.postMessageToWebview).mockRejectedValueOnce(new Error("webview gone"))
		await webviewMessageHandler(host, request)
		expect(rename).toHaveBeenCalledTimes(1)
		expect(host.postMessageToWebview).toHaveBeenCalledTimes(1)
	})

	it("opens Tickets through its existing command", async () => {
		await webviewMessageHandler(host, { type: "openTickets" })
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("alpha.openTickets")
	})

	it.each([false, true])("gates Incident Dashboard on the actual debug configuration (%s)", async (enabled) => {
		const config = vi
			.spyOn(vscode.workspace, "getConfiguration")
			.mockReturnValue({ get: vi.fn(() => enabled) } as unknown as vscode.WorkspaceConfiguration)
		try {
			await webviewMessageHandler(host, { type: "openIncidentDashboard" })
			expect(config).toHaveBeenCalledWith("alpha")
			if (enabled) expect(vscode.commands.executeCommand).toHaveBeenCalledWith("alpha.openIncidents")
			else expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		} finally {
			config.mockRestore()
		}
	})
})

describe("provider profile Save messages", () => {
	const draft = { apiProvider: "openai" as const, openAiModelId: "explicit-save-model" }
	const saved = { id: "profile-id", name: "current-name" }
	const upsert = vi.fn(async (_target: { id: string }, _draft: typeof draft) => saved)
	const modernHost = { ...mockAlphaProvider, upsertProviderProfile: upsert } as unknown as AlphaProvider

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(mockAlphaProvider.upsertProviderProfile).mockResolvedValue("profile-id")
		upsert.mockReset().mockResolvedValue(saved)
	})

	it("routes a modern Save by stable ID and ignores its stale display name", async () => {
		await webviewMessageHandler(modernHost, {
			type: "upsertApiConfiguration",
			requestId: "save-1",
			apiConfigurationId: "profile-id",
			text: "stale-name",
			apiConfiguration: draft,
		})
		expect(upsert).toHaveBeenCalledExactlyOnceWith({ id: "profile-id" }, draft)
		expect(modernHost.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "save-1", status: "success", ...saved },
		})
	})

	it("accepts an ID-targeted Save without a display name", async () => {
		await webviewMessageHandler(modernHost, {
			type: "upsertApiConfiguration",
			requestId: "save-2",
			apiConfigurationId: "profile-id",
			apiConfiguration: draft,
		})
		expect(upsert).toHaveBeenCalledExactlyOnceWith({ id: "profile-id" }, draft)
	})

	it("acknowledges success only after the queued Save operation finishes", async () => {
		let complete!: (value: typeof saved) => void
		upsert.mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)))
		const pending = webviewMessageHandler(modernHost, {
			type: "upsertApiConfiguration",
			requestId: "held-save",
			apiConfigurationId: "profile-id",
			apiConfiguration: draft,
		})
		expect(modernHost.postMessageToWebview).not.toHaveBeenCalled()
		complete(saved)
		await pending
		expect(modernHost.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "held-save", status: "success", ...saved },
		})
	})

	it.each([undefined, null, "", 42, {}, []])(
		"rejects property-present malformed Save identity %j without falling back to its legacy name",
		async (apiConfigurationId) => {
			await webviewMessageHandler(modernHost, {
				type: "upsertApiConfiguration",
				requestId: "invalid-save",
				apiConfigurationId,
				text: "legacy-name",
				apiConfiguration: draft,
			} as unknown as WebviewMessage)
			expect(mockAlphaProvider.upsertProviderProfile).not.toHaveBeenCalled()
			expect(upsert).not.toHaveBeenCalled()
			expect(modernHost.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "apiConfigurationSaved",
				apiConfigurationSaveResult: { requestId: "invalid-save", status: "error", error: "invalid" },
			})
		},
	)

	it("keeps legacy absent-ID Save and creation routed by name", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "upsertApiConfiguration",
			text: "created-profile",
			apiConfiguration: draft,
		})
		expect(mockAlphaProvider.upsertProviderProfile).toHaveBeenCalledExactlyOnceWith("created-profile", draft)
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("safely ignores a stale modern Save lacking its draft", async () => {
		await webviewMessageHandler(modernHost, {
			type: "upsertApiConfiguration",
			requestId: "missing-draft",
			apiConfigurationId: "profile-id",
			text: "legacy-name",
		} as unknown as WebviewMessage)
		expect(mockAlphaProvider.upsertProviderProfile).not.toHaveBeenCalled()
		expect(upsert).not.toHaveBeenCalled()
		expect(modernHost.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "missing-draft", status: "error", error: "invalid" },
		})
	})

	it.each([undefined, "", "x".repeat(129), 42])(
		"does not mutate an ID-targeted packet with malformed correlation %j",
		async (requestId) => {
			await webviewMessageHandler(modernHost, {
				type: "upsertApiConfiguration",
				requestId,
				apiConfigurationId: "profile-id",
				text: "stale-name",
				apiConfiguration: draft,
			} as unknown as WebviewMessage)
			expect(upsert).not.toHaveBeenCalled()
			expect(modernHost.postMessageToWebview).not.toHaveBeenCalled()
		},
	)

	it("rejects a requestId-only packet instead of falling back to its legacy name", async () => {
		await webviewMessageHandler(modernHost, {
			type: "upsertApiConfiguration",
			requestId: "missing-id",
			text: "legacy-name",
			apiConfiguration: draft,
		} as unknown as WebviewMessage)
		expect(upsert).not.toHaveBeenCalled()
		expect(modernHost.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "missing-id", status: "error", error: "invalid" },
		})
	})

	it.each(["notFound", "invalid", "saveFailed"] as const)(
		"acknowledges the safe queued failure %s",
		async (error) => {
			upsert.mockRejectedValueOnce(new ProviderProfileSaveError(error))
			await webviewMessageHandler(modernHost, {
				type: "upsertApiConfiguration",
				requestId: "failed-save",
				apiConfigurationId: "profile-id",
				apiConfiguration: draft,
			})
			expect(modernHost.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "apiConfigurationSaved",
				apiConfigurationSaveResult: { requestId: "failed-save", status: "error", error },
			})
		},
	)

	it("does not retry or send a contradictory failure when success acknowledgement delivery rejects", async () => {
		vi.mocked(modernHost.postMessageToWebview).mockRejectedValueOnce(new Error("private transport failure"))
		await webviewMessageHandler(modernHost, {
			type: "upsertApiConfiguration",
			requestId: "delivered-save",
			apiConfigurationId: "profile-id",
			apiConfiguration: draft,
		})
		expect(upsert).toHaveBeenCalledOnce()
		expect(modernHost.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "delivered-save", status: "success", ...saved },
		})
		expect(modernHost.log).toHaveBeenCalledWith("[ProviderProfileSave] acknowledgement_failed")
		expect(JSON.stringify(vi.mocked(modernHost.log).mock.calls)).not.toContain("private transport failure")
	})
})

describe("persisted provider profile rename messages", () => {
	const renamed = { id: "profile-id", oldName: "saved", newName: "renamed", isActive: true, entries: [] }

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(mockAlphaProvider.renameProviderProfile).mockResolvedValue(renamed)
	})

	it("routes a stable-ID name-only operation and acknowledges only after persistence completes", async () => {
		let complete!: (result: typeof renamed) => void
		vi.mocked(mockAlphaProvider.renameProviderProfile).mockImplementationOnce(
			() => new Promise((resolve) => (complete = resolve)),
		)
		const pending = webviewMessageHandler(mockAlphaProvider, {
			type: "renameApiConfiguration",
			apiConfigurationRename: { requestId: "rename-1", id: "profile-id", newName: " renamed " },
		})
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
		complete(renamed)
		await pending
		expect(mockAlphaProvider.renameProviderProfile).toHaveBeenCalledExactlyOnceWith({ id: "profile-id" }, "renamed")
		expect(mockAlphaProvider.activateProviderProfile).not.toHaveBeenCalled()
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationRenamed",
			apiConfigurationRenameResult: {
				requestId: "rename-1",
				status: "success",
				id: "profile-id",
				oldName: "saved",
				newName: "renamed",
			},
		})
	})

	it("accepts a legacy name-based request but ignores all draft provider settings", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "renameApiConfiguration",
			values: { oldName: "saved", newName: "renamed" },
			apiConfiguration: {
				apiProvider: "openai",
				openAiBaseUrl: "https://unsaved.example/v1",
				openAiApiKey: "unsaved-test-key",
				openAiModelId: "unsaved-model",
			},
		})
		expect(mockAlphaProvider.renameProviderProfile).toHaveBeenCalledExactlyOnceWith({ name: "saved" }, "renamed")
		expect(mockAlphaProvider.activateProviderProfile).not.toHaveBeenCalled()
	})

	it("accepts a legacy request without an edit buffer", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "renameApiConfiguration",
			values: { oldName: "saved", newName: "renamed" },
		})
		expect(mockAlphaProvider.renameProviderProfile).toHaveBeenCalledExactlyOnceWith({ name: "saved" }, "renamed")
	})

	it.each(["legacy", "modern"])(
		"keeps persisted endpoint, key, provider and model when a dirty %s webview renames a profile",
		async (wire) => {
			const saved = {
				id: "profile-id",
				apiProvider: "openai" as const,
				openAiBaseUrl: "https://saved.example/v1",
				openAiApiKey: "saved-test-key",
				openAiModelId: "saved-model",
			}
			let content = JSON.stringify({
				currentApiConfigName: "saved",
				apiConfigs: { saved },
				modeApiConfigs: { code: "profile-id" },
				migrations: {
					rateLimitSecondsMigrated: true,
					openAiHeadersMigrated: true,
					consecutiveMistakeLimitMigrated: true,
					todoListEnabledMigrated: true,
					claudeCodeLegacySettingsMigrated: true,
				},
			})
			const manager = new ProviderSettingsManager({
				secrets: {
					get: vi.fn(async () => content),
					store: vi.fn(async (_key: string, value: string) => {
						content = value
					}),
				},
			} as unknown as ExtensionContext)
			await manager.initialize()
			const host = {
				...mockAlphaProvider,
				providerSettingsManager: manager,
				renameProviderProfile: vi.fn((params: { id: string } | { name: string }, newName: string) =>
					manager.renameProfile(params, newName),
				),
			} as unknown as AlphaProvider
			await webviewMessageHandler(host, {
				type: "renameApiConfiguration",
				...(wire === "legacy"
					? { values: { oldName: "saved", newName: "renamed" } }
					: { apiConfigurationRename: { requestId: "dirty-modern", id: "profile-id", newName: "renamed" } }),
				apiConfiguration: {
					apiProvider: "vertex",
					apiKey: "draft-test-key",
					apiModelId: "draft-model",
					openAiBaseUrl: "https://draft.example/v1",
				},
			} as unknown as WebviewMessage)
			expect(await manager.getProfile({ id: "profile-id" })).toEqual({ name: "renamed", ...saved })
			expect(mockAlphaProvider.activateProviderProfile).not.toHaveBeenCalled()
			if (wire === "modern") {
				expect(host.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
					type: "apiConfigurationRenamed",
					apiConfigurationRenameResult: {
						requestId: "dirty-modern",
						status: "success",
						id: "profile-id",
						oldName: "saved",
						newName: "renamed",
					},
				})
			}
		},
	)

	it.each([
		{ requestId: "invalid", id: "profile-id", newName: "" },
		{ requestId: "invalid", id: "", newName: "renamed" },
		{ requestId: "invalid", id: "profile-id", newName: "renamed", openAiApiKey: "draft" },
	])("rejects malformed modern requests without falling back to legacy values: %j", async (payload) => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "renameApiConfiguration",
			apiConfigurationRename: payload,
			values: { oldName: "saved", newName: "renamed" },
		} as unknown as WebviewMessage)
		expect(mockAlphaProvider.renameProviderProfile).not.toHaveBeenCalled()
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationRenamed",
			apiConfigurationRenameResult: { requestId: "invalid", status: "error", error: "invalid" },
		})
	})

	it.each([null, undefined, {}, { oldName: "saved", newName: 123 }, { oldName: 123, newName: "renamed" }])(
		"safely rejects malformed legacy payloads %j",
		async (values) => {
			await expect(
				webviewMessageHandler(mockAlphaProvider, {
					type: "renameApiConfiguration",
					values,
				} as unknown as WebviewMessage),
			).resolves.not.toThrow()
			expect(mockAlphaProvider.renameProviderProfile).not.toHaveBeenCalled()
		},
	)

	it.each(["notFound", "nameInUse", "saveFailed"] as const)(
		"returns the deterministic %s failure without raw storage details",
		async (code) => {
			vi.mocked(mockAlphaProvider.renameProviderProfile).mockRejectedValueOnce(
				new ProviderProfileRenameError(code),
			)
			await webviewMessageHandler(mockAlphaProvider, {
				type: "renameApiConfiguration",
				apiConfigurationRename: { requestId: "failed", id: "profile-id", newName: "renamed" },
			})
			expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "apiConfigurationRenamed",
				apiConfigurationRenameResult: { requestId: "failed", status: "error", error: code },
			})
		},
	)

	it("maps unexpected failures to saveFailed without logging raw error text", async () => {
		vi.mocked(mockAlphaProvider.renameProviderProfile).mockRejectedValueOnce(new Error("private endpoint and key"))
		await webviewMessageHandler(mockAlphaProvider, {
			type: "renameApiConfiguration",
			apiConfigurationRename: { requestId: "failed", id: "profile-id", newName: "renamed" },
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "apiConfigurationRenamed",
			apiConfigurationRenameResult: { requestId: "failed", status: "error", error: "saveFailed" },
		})
		expect(mockAlphaProvider.log).not.toHaveBeenCalledWith(expect.stringContaining("private endpoint and key"))
	})

	it("returns authoritative saved identity after compensation even if state projection failed", async () => {
		vi.mocked(mockAlphaProvider.renameProviderProfile).mockRejectedValueOnce(
			new ProviderProfileRenameError("saveFailed", { id: "profile-id", name: "saved" }),
		)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "renameApiConfiguration",
			apiConfigurationRename: { requestId: "reverted", id: "profile-id", newName: "renamed" },
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationRenamed",
			apiConfigurationRenameResult: {
				requestId: "reverted",
				status: "error",
				error: "saveFailed",
				profile: { id: "profile-id", name: "saved" },
			},
		})
	})

	it("does not reclassify committed success or send a second result when acknowledgement delivery rejects", async () => {
		vi.mocked(mockAlphaProvider.postMessageToWebview).mockRejectedValueOnce(new Error("private transport detail"))
		await expect(
			webviewMessageHandler(mockAlphaProvider, {
				type: "renameApiConfiguration",
				apiConfigurationRename: { requestId: "committed", id: "profile-id", newName: "renamed" },
			}),
		).resolves.not.toThrow()
		expect(mockAlphaProvider.renameProviderProfile).toHaveBeenCalledOnce()
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationRenamed",
			apiConfigurationRenameResult: {
				requestId: "committed",
				status: "success",
				id: "profile-id",
				oldName: "saved",
				newName: "renamed",
			},
		})
		expect(mockAlphaProvider.log).toHaveBeenCalledWith("[ProviderProfileRename] acknowledgement_failed")
		expect(mockAlphaProvider.log).not.toHaveBeenCalledWith(expect.stringContaining("private transport detail"))
	})
})

describe("webview focus messages", () => {
	beforeEach(() => vi.clearAllMocks())

	it("updates the sending provider's focus and rejects malformed focus input", async () => {
		await webviewMessageHandler(mockAlphaProvider, { type: "webviewFocusChanged", focused: true })
		expect(mockAlphaProvider.setWebviewFocused).toHaveBeenCalledExactlyOnceWith(true)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "webviewFocusChanged",
			focused: "true",
		} as unknown as WebviewMessage)
		expect(mockAlphaProvider.setWebviewFocused).toHaveBeenCalledOnce()
	})
})

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
		commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
		window: {
			showInformationMessage,
			showWarningMessage,
			showErrorMessage,
			showTextDocument,
		},
		workspace: {
			getConfiguration: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(false) }),
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

describe("webviewMessageHandler - captured diff review", () => {
	const payload = {
		title: "Alpha Diff: src/file.ts",
		files: [{ path: "src/file.ts", originalContent: "before\n", finalContent: "after\n" }],
	}

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(openDiff).mockResolvedValue(undefined)
	})

	it("opens captured snapshots without requiring a live task or reading workspace files", async () => {
		await webviewMessageHandler(mockAlphaProvider, { type: "openDiff", payload })

		expect(openDiff).toHaveBeenCalledExactlyOnceWith(payload)
		expect(mockAlphaProvider.getCurrentTask).not.toHaveBeenCalled()
		expect(mockAlphaProvider.getLiveTask).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it.each(["src/file.ts", "../../../private.txt", "/outside/workspace.txt", ""])(
		"ignores retired file-content requests for %j without resolving task state or reading files",
		async (text) => {
			await expect(
				webviewMessageHandler(mockAlphaProvider, { type: "readFileContent", text }),
			).resolves.toBeUndefined()

			expect(fs.readFile).not.toHaveBeenCalled()
			expect(mockAlphaProvider.getCurrentTask).not.toHaveBeenCalled()
			expect(mockAlphaProvider.getLiveTask).not.toHaveBeenCalled()
			expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ ...payload, files: [] },
		{ ...payload, title: "x".repeat(257) },
		{ ...payload, files: Array.from({ length: 129 }, () => payload.files[0]) },
	])("reports an invalid review request instead of silently ignoring it", async (invalidPayload) => {
		await webviewMessageHandler(mockAlphaProvider, { type: "openDiff", payload: invalidPayload })

		expect(openDiff).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(t("common:errors.invalid_diff"))
		expect(mockAlphaProvider.log).toHaveBeenCalledExactlyOnceWith(
			"[openDiff] Rejected invalid captured diff request",
		)
	})

	it("reports a failed editor command without exposing snapshots embedded in the error URI", async () => {
		const secretSnapshot = Buffer.from("private file contents").toString("base64")
		vi.mocked(openDiff).mockRejectedValueOnce(new Error(`Failed to resolve cline-diff:/file?${secretSnapshot}`))

		await expect(webviewMessageHandler(mockAlphaProvider, { type: "openDiff", payload })).resolves.toBeUndefined()

		expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(t("common:errors.could_not_open_diff"))
		expect(mockAlphaProvider.log).toHaveBeenCalledExactlyOnceWith(
			"[openDiff] VS Code could not open the captured diff",
		)
		expect(JSON.stringify(vi.mocked(mockAlphaProvider.log).mock.calls)).not.toContain(secretSnapshot)
		expect(JSON.stringify(vi.mocked(vscode.window.showErrorMessage).mock.calls)).not.toContain(secretSnapshot)
	})
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

	it("keeps a saved Gemini key and reports validation failure without a second initialization", async () => {
		const settings = {
			...createVertexSettings(),
			codebaseIndexEnabled: true,
			codebaseIndexEmbedderProvider: "gemini",
			codebaseIndexGeminiApiKey: "index-secret",
		}
		const status = {
			systemStatus: "Error",
			message: "HTTP 402: prepayment credits depleted",
			workspaceEnabled: true,
		}
		const manager = {
			handleSettingsChange: vi.fn().mockRejectedValue(new Error(status.message)),
			initialize: vi.fn(),
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			isInitialized: false,
			getCurrentStatus: vi.fn(() => status),
		}
		vi.mocked(mockAlphaProvider.contextProxy.getValue).mockReturnValue({ codebaseIndexEmbedderProvider: "gemini" })
		vi.mocked(mockAlphaProvider.getCurrentWorkspaceCodeIndexManager).mockReturnValue(manager as never)

		await webviewMessageHandler(mockAlphaProvider, {
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: settings,
		} as WebviewMessage)

		expect(mockAlphaProvider.contextProxy.storeSecret).toHaveBeenCalledWith(
			"codebaseIndexGeminiApiKey",
			"index-secret",
		)
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "codeIndexSettingsSaved", success: true }),
		)
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexingStatusUpdate",
			values: status,
		})
		expect(manager.initialize).not.toHaveBeenCalled()
	})

	it.each(["startIndexing", "toggleWorkspaceIndexing"] as const)(
		"loads saved configuration before checking readiness when enabling via %s",
		async (type) => {
			const manager = {
				isFeatureEnabled: false,
				isFeatureConfigured: false,
				isInitialized: false,
				state: "Standby",
				setWorkspaceEnabled: vi.fn().mockResolvedValue(undefined),
				initialize: vi.fn(async () => {
					manager.isFeatureEnabled = true
					manager.isFeatureConfigured = true
					manager.isInitialized = true
				}),
				startIndexing: vi.fn(),
				getCurrentStatus: vi.fn(() => ({ systemStatus: "Standby", workspaceEnabled: true })),
			}
			vi.mocked(mockAlphaProvider.getCurrentWorkspaceCodeIndexManager).mockReturnValue(manager as never)

			await webviewMessageHandler(mockAlphaProvider, { type, bool: true })

			expect(manager.setWorkspaceEnabled).toHaveBeenCalledWith(true)
			expect(manager.initialize).toHaveBeenCalledWith(mockAlphaProvider.contextProxy)
			expect(manager.startIndexing).toHaveBeenCalledOnce()
			expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "indexingStatusUpdate",
				values: manager.getCurrentStatus(),
			})
		},
	)

	it.each(["startIndexing", "toggleWorkspaceIndexing"] as const)(
		"publishes the enabled workspace and provider error when %s fails",
		async (type) => {
			const status = {
				systemStatus: "Error",
				message: "HTTP 402: prepayment credits depleted",
				workspaceEnabled: true,
			}
			const manager = {
				setWorkspaceEnabled: vi.fn().mockResolvedValue(undefined),
				isFeatureEnabled: true,
				isFeatureConfigured: true,
				initialize: vi.fn().mockRejectedValue(new Error(status.message)),
				startIndexing: vi.fn(),
				getCurrentStatus: vi.fn(() => status),
			}
			vi.mocked(mockAlphaProvider.getCurrentWorkspaceCodeIndexManager).mockReturnValue(manager as never)

			await webviewMessageHandler(mockAlphaProvider, { type, bool: true })

			expect(manager.startIndexing).not.toHaveBeenCalled()
			expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "indexingStatusUpdate",
				values: status,
			})
		},
	)
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

	it("retains a fresh human reply through the queue when its legacy ask is already answered", async () => {
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: "task-1",
			handleWebviewAskResponse: vi.fn(() => false),
		} as unknown as Task)
		vi.mocked(mockAlphaProvider.queueMessageForTaskDurably).mockResolvedValueOnce(true)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "askResponse",
			askResponse: "messageResponse",
			taskId: "task-1",
			text: "Fresh human reply",
			images: [],
		})
		expect(mockAlphaProvider.queueMessageForTaskDurably).toHaveBeenCalledWith(
			"task-1",
			"Fresh human reply",
			["data:image/png;base64,from-mention"],
			undefined,
			{ source: "human" },
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

	it.each(["delivering", "queued"] as const)(
		"waits for durable direct steering before acknowledging %s input on the addressed task",
		async (deliveryState) => {
			let finish!: () => void
			const steerUserMessageDurably = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve
					}),
			)
			vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
				taskId: "background",
				steerUserMessageDurably,
				messageQueueService: {
					visibleMessages: [
						{ id: "direct-steer", text: "Use the existing parser", timestamp: 1, deliveryState },
					],
				},
			} as any)
			const dispatch = webviewMessageHandler(mockAlphaProvider, {
				type: "sendAndSteer",
				taskId: "background",
				requestId: "direct-steer",
				text: "Use the existing parser",
				images: [],
			})
			expect(steerUserMessageDurably).toHaveBeenCalledWith(
				"Use the existing parser",
				[],
				"direct-steer",
				undefined,
			)
			expect(mockAlphaProvider.getCurrentTask).not.toHaveBeenCalled()
			expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalled()
			finish()
			await dispatch
			expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({
					chatCommandResult: {
						command: "sendAndSteer",
						taskId: "background",
						requestId: "direct-steer",
						status: "accepted",
						...(deliveryState === "queued" ? { deliveryState: "queued" } : {}),
					},
				}),
			)
		},
	)

	it.each([true, false])(
		"rejects successor turns after delayed image resolution (explicit token: %s)",
		async (explicit) => {
			let releaseState!: (state: object) => void
			const stateReady = new Promise<object>((resolve) => {
				releaseState = resolve
			})
			vi.mocked(mockAlphaProvider.getState).mockReturnValueOnce(stateReady as never)
			let turnId = "turn-original"
			vi.mocked(mockAlphaProvider.getAgentLifecycleSnapshot).mockImplementation(() => ({ turnId }) as never)
			const task = {
				taskId: "background",
				steerUserMessageDurably: vi.fn(),
				cwd: "/mock/workspace",
				messageQueueService: { visibleMessages: [] },
			}
			vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue(task as never)
			const dispatch = webviewMessageHandler(mockAlphaProvider, {
				type: "sendAndSteer",
				taskId: task.taskId,
				requestId: "late-steer",
				text: "Keep this draft",
				images: ["data:image/png;base64,eA=="],
				...(explicit ? { expectedTurnId: turnId } : {}),
			})
			expect(mockAlphaProvider.getState).toHaveBeenCalled()
			turnId = "turn-successor"
			releaseState({})
			await dispatch
			expect(task.steerUserMessageDurably).not.toHaveBeenCalled()
			expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({
					chatCommandResult: expect.objectContaining({ status: "rejected", errorCode: "stale_turn" }),
				}),
			)
			vi.mocked(mockAlphaProvider.getAgentLifecycleSnapshot).mockReset()
		},
	)

	it("rejects an already stale composer before resolving attachments", async () => {
		vi.mocked(mockAlphaProvider.getAgentLifecycleSnapshot).mockReturnValue({ turnId: "successor" } as never)
		const task = { taskId: "background", steerUserMessageDurably: vi.fn() }
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue(task as never)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "sendAndSteer",
			taskId: task.taskId,
			requestId: "stale",
			text: "Keep this draft",
			expectedTurnId: "original",
			images: ["data:image/png;base64,eA=="],
		})
		expect(mockAlphaProvider.getState).not.toHaveBeenCalled()
		expect(task.steerUserMessageDurably).not.toHaveBeenCalled()
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ status: "rejected", errorCode: "stale_turn" }),
			}),
		)
		vi.mocked(mockAlphaProvider.getAgentLifecycleSnapshot).mockReset()
	})

	it("acknowledges a stale retry of durably accepted input without steering or refreshing the successor", async () => {
		vi.mocked(mockAlphaProvider.getAgentLifecycleSnapshot).mockReturnValue({ turnId: "successor" } as never)
		const task = {
			taskId: "background",
			steerUserMessageDurably: vi.fn(),
			matchesExpectedTurn: vi.fn(() => false),
			hasAcceptedQueuedUserMessage: vi.fn(async () => true),
		}
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue(task as never)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "sendAndSteer",
			taskId: task.taskId,
			requestId: "already-accepted",
			text: "Accepted earlier",
			expectedTurnId: "original",
		})
		expect(task.hasAcceptedQueuedUserMessage).toHaveBeenCalledExactlyOnceWith("already-accepted")
		expect(task.steerUserMessageDurably).not.toHaveBeenCalled()
		expect(mockAlphaProvider.postTaskQueueToWebview).not.toHaveBeenCalled()
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ requestId: "already-accepted", status: "accepted" }),
			}),
		)
		vi.mocked(mockAlphaProvider.getAgentLifecycleSnapshot).mockReset()
	})

	it("acknowledges a retained steering message as queued when the handoff fails", async () => {
		const queue = [{ id: "retained-steer", text: "Keep this correction", timestamp: 1 }]
		const task = {
			taskId: "background",
			messageQueueService: { visibleMessages: queue },
			steerUserMessageDurably: vi.fn().mockRejectedValue(new Error("approval began")),
			hasAcceptedQueuedUserMessage: vi.fn().mockResolvedValue(true),
		}
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue(task as any)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "sendAndSteer",
			taskId: "background",
			requestId: "retained-steer",
			text: "Keep this correction",
		})
		expect(task.hasAcceptedQueuedUserMessage).toHaveBeenCalledWith("retained-steer")
		expect(mockAlphaProvider.postTaskQueueToWebview).toHaveBeenCalledWith("background", queue)
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({
					command: "sendAndSteer",
					status: "accepted",
					deliveryState: "queued",
				}),
			}),
		)
	})

	it("rejects a failed steering admission without reporting it as accepted", async () => {
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: "background",
			steerUserMessageDurably: vi.fn().mockRejectedValue(new Error("steer pending")),
			hasAcceptedQueuedUserMessage: vi.fn().mockResolvedValue(false),
			hasPendingSteerMessage: vi.fn(() => true),
		} as any)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "sendAndSteer",
			taskId: "background",
			requestId: "rejected-steer",
			text: "Keep this draft",
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({
					command: "sendAndSteer",
					status: "rejected",
					errorCode: "steer_pending",
				}),
			}),
		)
	})

	it("rejects malformed direct steering and managed-child composer submissions", async () => {
		const steerUserMessageDurably = vi.fn()
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({
			taskId: "child",
			taskKind: "subagent",
			steerUserMessageDurably,
		} as any)
		await webviewMessageHandler(mockAlphaProvider, {
			type: "sendAndSteer",
			taskId: "child",
			requestId: "child-steer",
			text: "Use parent controls",
		})
		await webviewMessageHandler(mockAlphaProvider, {
			type: "sendAndSteer",
			taskId: "child",
			requestId: "invalid-steer",
			text: 42,
		} as unknown as WebviewMessage)
		expect(steerUserMessageDurably).not.toHaveBeenCalled()
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({
					requestId: "child-steer",
					status: "rejected",
					errorCode: "task_unavailable",
				}),
			}),
		)
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				chatCommandResult: expect.objectContaining({ requestId: "invalid-steer", status: "rejected" }),
			}),
		)
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
		expect(steerQueuedUserMessage).toHaveBeenCalledWith("queued-1", undefined)
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
		expect(mockAlphaProvider.queueMessageForTaskDurably).toHaveBeenCalledWith(
			"task-1",
			"keep this safe",
			[],
			"queue-request-1",
			{ source: "human" },
		)
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
		vi.mocked(mockAlphaProvider.getTaskNavigationGeneration).mockReturnValue(0)
		vi.mocked(mockAlphaProvider.createTask).mockResolvedValue({ taskId: "task-1" } as any)
	})

	it("acknowledges a correlated first-prompt admission after task creation", async () => {
		await webviewMessageHandler(mockAlphaProvider, {
			type: "newTask",
			text: "Build the feature",
			taskId: "task-1",
			requestId: "initial-submission",
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chatCommandResult",
				chatCommandResult: {
					command: "newTask",
					requestId: "initial-submission",
					taskId: "task-1",
					status: "accepted",
				},
			}),
		)
	})

	it("rejects failed first-prompt admission without navigating away from the recoverable draft", async () => {
		vi.mocked(mockAlphaProvider.createTask).mockRejectedValueOnce(new Error("boom"))
		await webviewMessageHandler(mockAlphaProvider, {
			type: "newTask",
			text: "Build the feature",
			taskId: "task-1",
			requestId: "initial-submission",
		})
		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chatCommandResult",
				chatCommandResult: {
					command: "newTask",
					requestId: "initial-submission",
					taskId: "task-1",
					status: "rejected",
					errorCode: "unknown",
				},
			}),
		)
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "invoke", invoke: "newChat" }),
		)
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

	it("preserves a later navigation when task creation fails", async () => {
		let rejectCreation!: (reason: Error) => void
		const creation = new Promise<never>((_resolve, reject) => {
			rejectCreation = reject
		})
		let signalCreation!: () => void
		const enteredCreation = new Promise<void>((resolve) => {
			signalCreation = resolve
		})
		vi.mocked(mockAlphaProvider.createTask).mockImplementationOnce(() => {
			signalCreation()
			return creation
		})

		const submission = webviewMessageHandler(mockAlphaProvider, {
			type: "newTask",
			text: "Build the feature",
		})
		await enteredCreation
		// A navigation remains newer even if it returns to the same task or draft.
		vi.mocked(mockAlphaProvider.getTaskNavigationGeneration).mockReturnValue(1)
		rejectCreation(new Error("boom"))
		await submission

		expect(mockAlphaProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalledWith({
			type: "invoke",
			invoke: "newChat",
		})
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to create task: boom")
	})

	it("does not reset a chat selected while failure recovery is being delivered", async () => {
		vi.mocked(mockAlphaProvider.createTask).mockRejectedValueOnce(new Error("boom"))
		let releaseRecovery!: () => void
		const recovery = new Promise<void>((resolve) => {
			releaseRecovery = resolve
		})
		let signalRecovery!: () => void
		const enteredRecovery = new Promise<void>((resolve) => {
			signalRecovery = resolve
		})
		vi.mocked(mockAlphaProvider.postMessageToWebview)
			.mockResolvedValueOnce(undefined)
			.mockImplementationOnce(() => {
				signalRecovery()
				return recovery
			})

		const submission = webviewMessageHandler(mockAlphaProvider, {
			type: "newTask",
			text: "Build the feature",
		})
		await enteredRecovery
		vi.mocked(mockAlphaProvider.getTaskNavigationGeneration).mockReturnValue(1)
		releaseRecovery()
		await submission

		expect(mockAlphaProvider.postMessageToWebview).not.toHaveBeenCalledWith({
			type: "invoke",
			invoke: "newChat",
		})
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to create task: boom")
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

describe("non-checkpoint transcript deletion", () => {
	it.each([false, true])("joins the captured task before rewinding (successor installed: %s)", async (replace) => {
		vi.clearAllMocks()
		let joined!: () => void
		let finish!: () => void
		const entering = new Promise<void>((resolve) => {
			joined = resolve
		})
		const termination = new Promise<void>((resolve) => {
			finish = resolve
		})
		const saved = vi.spyOn(taskPersistence, "saveTaskMessages").mockResolvedValue(undefined)
		const task = {
			taskId: "background",
			abort: false,
			abortTask: vi.fn(async () => {
				task.abort = true
			}),
			waitForTermination: vi.fn(async () => {
				joined()
				await termination
			}),
			clineMessages: [
				{ ts: 10, type: "say", say: "task", text: "Keep" },
				{ ts: 20, type: "say", say: "text", text: "Delete" },
			],
			apiConversationHistory: [],
			messageManager: { rewindToTimestamp: vi.fn(async () => undefined) },
		}
		const host = {
			...mockAlphaProvider,
			contextProxy: { ...mockAlphaProvider.contextProxy, globalStorageUri: { fsPath: "/mock/storage" } },
		} as unknown as AlphaProvider
		vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue(task as never)
		const dispatch = webviewMessageHandler(host, {
			type: "deleteMessageConfirm",
			taskId: task.taskId,
			messageTs: 20,
		})
		try {
			expect(task.messageManager.rewindToTimestamp).not.toHaveBeenCalled()
			expect(saved).not.toHaveBeenCalled()
			await entering
			if (replace) vi.mocked(mockAlphaProvider.getLiveTask).mockReturnValue({ ...task } as never)
			finish()
			await dispatch
			expect(task.abortTask).toHaveBeenCalledExactlyOnceWith()
			if (replace) {
				expect(task.messageManager.rewindToTimestamp).not.toHaveBeenCalled()
				expect(saved).not.toHaveBeenCalled()
			} else {
				expect(task.messageManager.rewindToTimestamp).toHaveBeenCalledExactlyOnceWith(20, {
					includeTargetMessage: false,
				})
				expect(saved).toHaveBeenCalledOnce()
			}
		} finally {
			finish()
			await dispatch
			saved.mockRestore()
		}
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

		expect(mockAlphaProvider.cancelTask).toHaveBeenCalledWith("parent-1", "webview_stop", undefined)
	})
})

describe("turn-scoped cancellation wire", () => {
	it("forwards the composer's expected turn to the owning provider", async () => {
		vi.clearAllMocks()
		await webviewMessageHandler(mockAlphaProvider, {
			type: "cancelTask",
			taskId: "background",
			expectedTurnId: "original",
		})
		expect(mockAlphaProvider.cancelTask).toHaveBeenCalledExactlyOnceWith("background", "webview_stop", "original")
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
