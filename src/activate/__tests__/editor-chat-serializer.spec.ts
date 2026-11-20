import type * as vscode from "vscode"

const mocks = vi.hoisted(() => {
	const providers: Array<{
		restoreEditorTask: ReturnType<typeof vi.fn>
		resolveWebviewView: ReturnType<typeof vi.fn>
		dispose: ReturnType<typeof vi.fn>
	}> = []
	const createProvider = vi.fn(function () {
		const provider = {
			restoreEditorTask: vi.fn().mockResolvedValue(true),
			resolveWebviewView: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
		providers.push(provider)
		return provider
	})
	Object.assign(createProvider, { tabPanelId: "alpha.TabPanelProvider" })
	return {
		providers,
		createProvider,
		getContextProxy: vi.fn(async (): Promise<unknown> => ({})),
		registerSerializer: vi.fn((_viewType: string, _serializer: unknown) => ({ dispose: vi.fn() })),
		createWebviewPanel: vi.fn(),
		executeCommand: vi.fn().mockResolvedValue(undefined),
		tabGroups: { all: [] as Array<{ viewColumn: number; tabs: unknown[] }>, activeTabGroup: { viewColumn: 1 } },
	}
})

vi.mock("vscode", () => ({
	commands: { executeCommand: mocks.executeCommand },
	window: {
		registerWebviewPanelSerializer: mocks.registerSerializer,
		createWebviewPanel: mocks.createWebviewPanel,
		visibleTextEditors: [],
		tabGroups: mocks.tabGroups,
	},
	ViewColumn: { One: 1, Two: 2 },
	Uri: { joinPath: vi.fn(() => ({})) },
}))
vi.mock("../../core/webview/AlphaProvider", () => ({ AlphaProvider: mocks.createProvider }))
vi.mock("../../core/config/ContextProxy", () => ({ ContextProxy: { getInstance: mocks.getContextProxy } }))
vi.mock("../../core/config/importExport", () => ({ importSettingsWithFeedback: vi.fn() }))
vi.mock("../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../handleTask", () => ({ handleNewTask: vi.fn() }))
vi.mock("../goalCommands", () => ({ manageTaskGoal: vi.fn() }))

import { getPanel, openAlphaInNewTab, registerEditorChatSerializer, setPanel } from "../registerCommands"

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => (resolve = complete))
	return { promise, resolve }
}

function panelFixture() {
	const disposals = new Set<() => void>()
	const close = vi.fn(() => disposals.forEach((listener) => listener()))
	const panel = {
		webview: { html: "", options: {} },
		active: true,
		visible: true,
		viewColumn: 3,
		dispose: close,
		onDidDispose: vi.fn((listener: () => void) => {
			disposals.add(listener)
			return { dispose: () => disposals.delete(listener) }
		}),
	} as unknown as vscode.WebviewPanel
	return { panel, close }
}

function fixture() {
	const context = { extensionUri: {}, subscriptions: [] } as unknown as vscode.ExtensionContext
	const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
	registerEditorChatSerializer({ context, outputChannel })
	const serializer = mocks.registerSerializer.mock.calls[0][1] as vscode.WebviewPanelSerializer
	return { context, outputChannel, serializer }
}

const savedTask = (taskId: string) => ({ alphaEditorChat: { version: 1, currentView: { type: "task", taskId } } })

describe("opening an editor chat", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.providers.length = 0
		mocks.tabGroups.all = [
			{ viewColumn: 1, tabs: [{ input: "webview" }] },
			{ viewColumn: 2, tabs: [{ input: "custom editor" }] },
		]
		mocks.tabGroups.activeTabGroup = { viewColumn: 3 }
		setPanel(undefined, "tab")
		vi.useFakeTimers()
	})

	afterEach(() => vi.useRealTimers())

	it("opens past existing non-text editor groups and locks its own active group", async () => {
		const { panel } = panelFixture()
		mocks.createWebviewPanel.mockReturnValueOnce(panel)
		const opening = openAlphaInNewTab(fixture())
		await vi.runAllTimersAsync()
		await expect(opening).resolves.toBe(mocks.providers[0])
		expect(mocks.createWebviewPanel).toHaveBeenCalledWith("alpha.TabPanelProvider", "Alpha", 3, expect.anything())
		expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith("workbench.action.lockEditorGroup")
	})

	it("leaves another active group unlocked while the chat opens", async () => {
		mocks.tabGroups.activeTabGroup = { viewColumn: 1 }
		mocks.createWebviewPanel.mockReturnValueOnce(panelFixture().panel)
		const opening = openAlphaInNewTab(fixture())
		await vi.runAllTimersAsync()
		await expect(opening).resolves.toBe(mocks.providers[0])
		expect(mocks.executeCommand).not.toHaveBeenCalledWith("workbench.action.lockEditorGroup")
	})

	it("does not lock a group after its newly opened chat closes", async () => {
		const { panel, close } = panelFixture()
		mocks.createWebviewPanel.mockReturnValueOnce(panel)
		const opening = openAlphaInNewTab(fixture())
		await vi.advanceTimersByTimeAsync(0)
		close()
		await vi.runAllTimersAsync()
		await expect(opening).resolves.toBe(mocks.providers[0])
		expect(mocks.executeCommand).not.toHaveBeenCalledWith("workbench.action.lockEditorGroup")
	})

	it("closes a newly created tab when attaching its chat fails", async () => {
		const { panel, close } = panelFixture()
		const attachmentError = new Error("Context initialization failed")
		mocks.createWebviewPanel.mockReturnValueOnce(panel)
		mocks.getContextProxy.mockRejectedValueOnce(attachmentError)
		await expect(openAlphaInNewTab(fixture())).rejects.toBe(attachmentError)
		expect(close).toHaveBeenCalledOnce()
	})
})

describe("editor chat panel serializer", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.providers.length = 0
		setPanel(undefined, "tab")
	})

	it("registers the chat panel restore entry point for extension disposal", () => {
		const { context } = fixture()
		expect(mocks.registerSerializer).toHaveBeenCalledWith("alpha.TabPanelProvider", expect.anything())
		expect(context.subscriptions).toContain(mocks.registerSerializer.mock.results[0].value)
	})

	it("restores independent panel identities before attaching either chat UI", async () => {
		const { serializer } = fixture()
		const first = panelFixture()
		const second = panelFixture()
		await serializer.deserializeWebviewPanel(first.panel, savedTask("first-task"))
		await serializer.deserializeWebviewPanel(second.panel, savedTask("second-task"))
		for (const [index, taskId] of ["first-task", "second-task"].entries()) {
			const provider = mocks.providers[index]
			expect(provider.restoreEditorTask).toHaveBeenCalledWith(taskId, expect.any(Function))
			expect(provider.restoreEditorTask.mock.invocationCallOrder[0]).toBeLessThan(
				provider.resolveWebviewView.mock.invocationCallOrder[0],
			)
		}
		expect(mocks.providers[0]).not.toBe(mocks.providers[1])
		expect(getPanel()).toBe(second.panel)
		first.close()
		expect(getPanel()).toBe(second.panel)
		expect(mocks.providers[1].dispose).not.toHaveBeenCalled()
	})

	it("restores a saved draft without starting or looking up a task", async () => {
		const { serializer } = fixture()
		const { panel } = panelFixture()
		await serializer.deserializeWebviewPanel(panel, {
			alphaEditorChat: { version: 1, currentView: { type: "newTaskDraft" } },
		})
		expect(mocks.providers[0].restoreEditorTask).not.toHaveBeenCalled()
		expect(mocks.providers[0].resolveWebviewView).toHaveBeenCalledWith(panel)
	})

	it.each([undefined, {}, { unrelated: "legacy-state" }])(
		"explains missing legacy identity without resetting task data: %j",
		async (state) => {
			const { serializer } = fixture()
			const { panel } = panelFixture()
			await serializer.deserializeWebviewPanel(panel, state)
			expect(mocks.createProvider).not.toHaveBeenCalled()
			expect(panel.webview.html).toContain("common:editorChatRestore.missing")
			expect(panel.webview.html).toContain('role="alert"')
			expect(panel.webview.options.enableScripts).toBe(false)
		},
	)

	it("rejects traversal and unsupported state before creating a runtime", async () => {
		const { serializer } = fixture()
		const { panel } = panelFixture()
		await serializer.deserializeWebviewPanel(panel, savedTask("../other-chat"))
		expect(mocks.createProvider).not.toHaveBeenCalled()
		expect(panel.webview.html).toContain("common:editorChatRestore.invalid")
	})

	it("shows a contextual load failure while retaining the original saved identity", async () => {
		const { serializer, outputChannel } = fixture()
		mocks.createProvider.mockImplementationOnce(function () {
			const provider = {
				restoreEditorTask: vi.fn().mockRejectedValue(new Error("SECRET missing saved provider")),
				resolveWebviewView: vi.fn(),
				dispose: vi.fn().mockResolvedValue(undefined),
			}
			mocks.providers.push(provider)
			return provider
		})
		const { panel } = panelFixture()
		const state = savedTask("deleted-task")
		await serializer.deserializeWebviewPanel(panel, state)
		expect(mocks.providers[0].resolveWebviewView).not.toHaveBeenCalled()
		expect(mocks.providers[0].dispose).toHaveBeenCalled()
		expect(panel.webview.html).toContain("common:editorChatRestore.unavailable")
		expect(state).toEqual(savedTask("deleted-task"))
		expect(JSON.stringify(vi.mocked(outputChannel.appendLine).mock.calls)).not.toContain("SECRET")
	})

	it("does not create a provider after the panel closes while setup is loading", async () => {
		const ready = barrier()
		mocks.getContextProxy.mockImplementationOnce(() => ready.promise)
		const { serializer } = fixture()
		const { panel, close } = panelFixture()
		const restoring = serializer.deserializeWebviewPanel(panel, savedTask("saved-task"))
		close()
		ready.resolve()
		await restoring
		expect(mocks.createProvider).not.toHaveBeenCalled()
		expect(panel.webview.html).toBe("")
	})

	it("revokes restore admission and skips UI attachment when a loading panel closes", async () => {
		const ready = barrier()
		const entered = barrier()
		let isCurrent!: () => boolean
		mocks.createProvider.mockImplementationOnce(function () {
			const provider = {
				restoreEditorTask: vi.fn((_id: string, guard: () => boolean) => {
					isCurrent = guard
					entered.resolve()
					return ready.promise
				}),
				resolveWebviewView: vi.fn(),
				dispose: vi.fn().mockResolvedValue(undefined),
			}
			mocks.providers.push(provider)
			return provider
		})
		const { serializer } = fixture()
		const { panel, close } = panelFixture()
		const restoring = serializer.deserializeWebviewPanel(panel, savedTask("saved-task"))
		await entered.promise
		expect(isCurrent()).toBe(true)
		close()
		expect(isCurrent()).toBe(false)
		ready.resolve()
		await restoring
		expect(mocks.providers[0].resolveWebviewView).not.toHaveBeenCalled()
		expect(panel.webview.html).toBe("")
	})
})
