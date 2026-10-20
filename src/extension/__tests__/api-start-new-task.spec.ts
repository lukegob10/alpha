import * as vscode from "vscode"
import type { AlphaCodeSettings } from "@alpha-code/types"

import { API } from "../api"
import { AlphaProvider } from "../../core/webview/AlphaProvider"
import { openAlphaInNewTab } from "../../activate/registerCommands"

vi.mock("vscode")
vi.mock("../../core/webview/AlphaProvider", () => ({ AlphaProvider: vi.fn() }))
vi.mock("../../activate/registerCommands", () => ({ openAlphaInNewTab: vi.fn() }))

function createProvider(taskId: string) {
	return {
		context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
		on: vi.fn(),
		getState: vi.fn().mockResolvedValue({ apiConfiguration: { apiProvider: "vertex" } }),
		removeTaskFromStack: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		createTask: vi.fn().mockResolvedValue({ taskId }),
	}
}

describe("API task creation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each([false, true])("uses current settings without rewriting them when newTab is %s", async (newTab) => {
		const provider = createProvider("saved-settings-task")
		const savedConfiguration: AlphaCodeSettings = { apiProvider: "openai", openAiModelId: "saved-model" }
		provider.getState.mockResolvedValueOnce({ apiConfiguration: savedConfiguration })
		vi.mocked(openAlphaInNewTab).mockResolvedValue(provider as unknown as AlphaProvider)
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, provider as unknown as AlphaProvider)

		await expect(api.startNewTask({ text: "Use my current settings", newTab })).resolves.toBe("saved-settings-task")

		const [text, images, parent, options, configuration] = provider.createTask.mock.calls[0]
		expect(text).toBe("Use my current settings")
		expect(images).toBeUndefined()
		expect(parent).toBeUndefined()
		expect(provider.getState).toHaveBeenCalledExactlyOnceWith({ includeTaskHistory: false })
		expect(options.apiConfiguration).toBe(savedConfiguration)
		expect(options).not.toHaveProperty("presentationModelCalls")
		expect(configuration).toBeUndefined()
	})

	it.each([false, true])("forwards presentation suppression as a task option when newTab is %s", async (newTab) => {
		const provider = createProvider("governed-task")
		vi.mocked(openAlphaInNewTab).mockResolvedValue(provider as unknown as AlphaProvider)
		const api = new API(
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
			provider as unknown as AlphaProvider,
		)

		await expect(
			api.startNewTask({ text: "Use only execution model calls", newTab, presentationModelCalls: false }),
		).resolves.toBe("governed-task")

		const [, , , options, configuration] = provider.createTask.mock.calls[0]
		expect(options.presentationModelCalls).toBe(false)
		expect(options.apiConfiguration).not.toHaveProperty("presentationModelCalls")
		expect(configuration).toBeUndefined()
	})

	it.each([true, null, "false", 0])(
		"rejects unsupported presentation opt-out %j before changing task state",
		async (value) => {
			const provider = createProvider("unused-task")
			const api = new API(
				{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
				provider as unknown as AlphaProvider,
			)
			const request = {
				text: "Keep the current task intact",
				newTab: true,
				presentationModelCalls: value,
			} as unknown as Parameters<API["startNewTask"]>[0]

			await expect(api.startNewTask(request)).rejects.toThrow("presentationModelCalls only supports false")

			expect(provider.getState).not.toHaveBeenCalled()
			expect(provider.removeTaskFromStack).not.toHaveBeenCalled()
			expect(provider.createTask).not.toHaveBeenCalled()
			expect(openAlphaInNewTab).not.toHaveBeenCalled()
			expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		},
	)

	it("opens a task in a new tab without reverting or closing existing editors", async () => {
		const sidebar = createProvider("sidebar-task")
		const tab = createProvider("editor-task")
		vi.mocked(openAlphaInNewTab).mockResolvedValue(tab as unknown as AlphaProvider)
		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		const api = new API(outputChannel, sidebar as unknown as AlphaProvider)
		const configuration: AlphaCodeSettings = { apiProvider: "vertex" }

		await expect(api.startNewTask({ configuration, text: "Start in an editor", newTab: true })).resolves.toBe(
			"editor-task",
		)

		expect(openAlphaInNewTab).toHaveBeenCalledWith({ context: sidebar.context, outputChannel })
		expect(tab.createTask).toHaveBeenCalledOnce()
		expect(sidebar.createTask).not.toHaveBeenCalled()
		const commands = vi.mocked(vscode.commands.executeCommand).mock.calls.map(([command]) => command)
		expect(commands).not.toContain("workbench.action.files.revert")
		expect(commands).not.toContain("workbench.action.closeAllEditors")
	})

	it("preserves explicitly supplied executable provider callbacks", async () => {
		const provider = createProvider("explicit-settings-task")
		const api = new API(
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
			provider as unknown as AlphaProvider,
		)
		const configuration: AlphaCodeSettings = {
			apiProvider: "fake-ai",
			fakeAi: { id: "runtime-provider", createMessage: vi.fn() },
		}

		await api.startNewTask({ configuration, text: "Use this runtime provider" })

		const [, , , options, passedConfiguration] = provider.createTask.mock.calls[0]
		expect(options.apiConfiguration).toBe(configuration)
		expect(passedConfiguration).toBe(configuration)
		expect(provider.getState).not.toHaveBeenCalled()
	})

	it("rejects unsupported configuration before changing task or editor state", async () => {
		const provider = createProvider("unused-task")
		const api = new API(
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
			provider as unknown as AlphaProvider,
		)
		const configuration = { apiProvider: "retired-provider" } as unknown as AlphaCodeSettings

		await expect(api.startNewTask({ configuration, newTab: true })).rejects.toThrow("Unsupported API provider")

		expect(provider.removeTaskFromStack).not.toHaveBeenCalled()
		expect(provider.createTask).not.toHaveBeenCalled()
		expect(openAlphaInNewTab).not.toHaveBeenCalled()
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
	})

	it("rejects unsupported saved settings before closing the existing task or opening an editor", async () => {
		const provider = createProvider("unused-task")
		provider.getState.mockResolvedValueOnce({ apiConfiguration: { apiProvider: "retired-provider" } })
		const api = new API(
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
			provider as unknown as AlphaProvider,
		)

		await expect(api.startNewTask({ text: "Keep the existing task", newTab: true })).rejects.toThrow(
			"Unsupported API provider",
		)

		expect(provider.removeTaskFromStack).not.toHaveBeenCalled()
		expect(provider.createTask).not.toHaveBeenCalled()
		expect(openAlphaInNewTab).not.toHaveBeenCalled()
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
	})
})
