import * as vscode from "vscode"
import delay from "delay"

import { editorChatStateSchema, type CommandId, type EditorChatState } from "@alpha-code/types"

import { Package } from "../shared/package"
import { getCommand } from "../utils/commands"
import { AlphaProvider } from "../core/webview/AlphaProvider"
import { ContextProxy } from "../core/config/ContextProxy"
import { focusPanel } from "../utils/focusPanel"
import { handleNewTask } from "./handleTask"
import { t } from "../i18n"
import { showDiffReviewActions } from "../integrations/editor/diffReviewActions"
import { manageTaskGoal } from "./goalCommands"
import { recoverTaskHistory } from "./recoverTaskHistory"
import { generateErrorDiagnostics } from "../core/webview/diagnosticsHandler"

/**
 * Helper to get the visible AlphaProvider instance or log if not found.
 */
export function getVisibleProviderOrLog(
	outputChannel: vscode.OutputChannel,
	preferredProvider?: AlphaProvider,
): AlphaProvider | undefined {
	const visibleProvider = preferredProvider ?? AlphaProvider.getVisibleInstance()
	if (!visibleProvider) {
		outputChannel.appendLine("Cannot find any visible Alpha instances.")
		return undefined
	}
	return visibleProvider
}

// Store panel references in both modes
let sidebarPanel: vscode.WebviewView | undefined = undefined
let tabPanel: vscode.WebviewPanel | undefined = undefined

/**
 * Get the currently active panel
 * @returns WebviewPanel或WebviewView
 */
export function getPanel(): vscode.WebviewPanel | vscode.WebviewView | undefined {
	return tabPanel || sidebarPanel
}

/**
 * Set panel references
 */
export function setPanel(
	newPanel: vscode.WebviewPanel | vscode.WebviewView | undefined,
	type: "sidebar" | "tab",
): void {
	if (type === "sidebar") {
		sidebarPanel = newPanel as vscode.WebviewView
	} else {
		tabPanel = newPanel as vscode.WebviewPanel
	}
}

export type RegisterCommandOptions = {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	provider: AlphaProvider
}

export const registerCommands = (options: RegisterCommandOptions) => {
	const { context } = options

	for (const [id, callback] of Object.entries(getCommandsMap(options))) {
		const command = getCommand(id as CommandId)
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}
}

const getCommandsMap = ({ context, outputChannel, provider }: RegisterCommandOptions): Record<CommandId, any> => ({
	activationCompleted: () => {},
	diffReviewActions: showDiffReviewActions,
	// Native media-preview commands are supported on VS Code 1.125.0 and 1.138.0 (verified 2026-10-26).
	diagramZoomOut: () => vscode.commands.executeCommand("imagePreview.zoomOut"),
	diagramZoomIn: () => vscode.commands.executeCommand("imagePreview.zoomIn"),
	// Native view/title actions must keep their sidebar owner even while an editor Alpha view is focused.
	// VS Code 1.125.0 forwards no reliable originating view identity through menu activation arguments.
	sidebarNewChat: async () => {
		await provider.focusInput()
		// App owns the Settings unsaved-changes guard and the subsequent startBlankTask request.
		await provider.postMessageToWebview({ type: "action", action: "newChatButtonClicked" })
	},
	sidebarSettings: () => {
		provider.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
		provider.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
	},
	sidebarScheduledTasks: () => {
		provider.postMessageToWebview({ type: "action", action: "switchTab", tab: "scheduledTasks" })
	},
	plusButtonClicked: async (surface?: string) => {
		const visibleProvider =
			(surface === "sidebar" ? provider : AlphaProvider.getVisibleInstance()) ??
			(await AlphaProvider.getInstance())

		if (!visibleProvider) {
			return
		}
		if (surface === "sidebar") {
			await vscode.commands.executeCommand(`${AlphaProvider.sideBarId}.focus`)
			if (!(await visibleProvider.waitForWebviewLaunch(5_000, { requireVisible: true }))) {
				throw new Error("Alpha sidebar did not become ready")
			}
		}

		// Keyboard commands can run from Quick Input; focus the native owner before the UI starts a draft.
		await visibleProvider.focusInput()
		await visibleProvider.postMessageToWebview({
			type: "action",
			action: "newChatButtonClicked",
		})
	},
	popoutButtonClicked: () => {
		return openAlphaInNewTab({ context, outputChannel })
	},
	openInNewTab: () => openAlphaInNewTab({ context, outputChannel }),
	settingsButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
		// Also explicitly post the visibility message to trigger scroll reliably
		visibleProvider.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
	},
	historyButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({ type: "action", action: "historyButtonClicked" })
	},
	scheduledTasksButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({ type: "action", action: "switchTab", tab: "scheduledTasks" })
	},
	newTask: handleNewTask,
	exportDiagnostics: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) return
		const task = visibleProvider.getCurrentTask()
		if (!task) {
			await vscode.window.showInformationMessage(t("common:diagnostics.noTask"))
			return
		}
		await generateErrorDiagnostics({
			taskId: task.taskId,
			globalStoragePath: visibleProvider.contextProxy.globalStorageUri.fsPath,
			extension: visibleProvider.context.extension,
			getRuntimeDiagnostics: () => visibleProvider.getTaskSettlementDiagnostics(task),
			log: (message) => visibleProvider.log(message),
		})
	},
	manageGoal: async (surface?: string) => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel, surface === "sidebar" ? provider : undefined)
		if (visibleProvider) await manageTaskGoal(visibleProvider)
	},
	recoverTaskHistory: () => recoverTaskHistory(provider),
	setCustomStoragePath: async () => {
		const { promptForCustomStoragePath } = await import("../utils/storage")
		await promptForCustomStoragePath()
	},
	importSettings: async (filePath?: string) => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) {
			return
		}

		await visibleProvider.importSettings(filePath)
	},
	focusInput: async () => {
		try {
			const visibleProvider = await AlphaProvider.getInstance()
			await visibleProvider?.focusInput()
		} catch (error) {
			outputChannel.appendLine(`Error focusing input: ${error}`)
		}
	},
	focusPanel: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)
		} catch (error) {
			outputChannel.appendLine(`Error focusing panel: ${error}`)
		}
	},
	acceptInput: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({ type: "acceptInput" })
	},
	sendAndSteer: async (surface?: string) => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel, surface === "sidebar" ? provider : undefined)
		if (!visibleProvider) return
		await visibleProvider.postMessageToWebview({
			type: "steerNextQueuedMessage",
			taskId: visibleProvider.getActiveTaskId(),
		})
	},
	decreaseReasoningEffort: async (surface?: string) => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel, surface === "sidebar" ? provider : undefined)
		if (visibleProvider) await visibleProvider.adjustTaskReasoningEffort(visibleProvider.getActiveTaskId(), -1)
	},
	increaseReasoningEffort: async (surface?: string) => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel, surface === "sidebar" ? provider : undefined)
		if (visibleProvider) await visibleProvider.adjustTaskReasoningEffort(visibleProvider.getActiveTaskId(), 1)
	},
	previousTask: async (surface?: string) => {
		await getVisibleProviderOrLog(outputChannel, surface === "sidebar" ? provider : undefined)?.navigateTask(-1)
	},
	nextTask: async (surface?: string) => {
		await getVisibleProviderOrLog(outputChannel, surface === "sidebar" ? provider : undefined)?.navigateTask(1)
	},
	nextTaskNeedingInput: async (surface?: string) => {
		await getVisibleProviderOrLog(outputChannel, surface === "sidebar" ? provider : undefined)?.navigateTask(
			1,
			true,
		)
	},
	toggleAutoApprove: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({
			type: "action",
			action: "toggleAutoApprove",
		})
	},
})

class EditorPanelClosedError extends Error {}

async function attachAlphaEditorPanel(
	{ context, outputChannel }: Omit<RegisterCommandOptions, "provider">,
	panel: vscode.WebviewPanel,
	state?: EditorChatState,
): Promise<{ provider: AlphaProvider; isOpen: () => boolean }> {
	let closed = false
	let provider: AlphaProvider | undefined
	context.subscriptions.push(
		panel.onDidDispose(() => {
			closed = true
			if (getPanel() === panel) setPanel(undefined, "tab")
			void provider?.dispose().catch(() => outputChannel.appendLine("Failed to dispose editor chat provider"))
		}),
	)
	try {
		const contextProxy = await ContextProxy.getInstance(context)
		if (closed) throw new EditorPanelClosedError()
		provider = new AlphaProvider(context, outputChannel, "editor", contextProxy)
		panel.iconPath = {
			light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel-light.svg"),
			dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel-dark.svg"),
		}
		if (state?.currentView.type === "task") {
			await provider.restoreEditorTask(state.currentView.taskId, () => !closed)
		}
		if (closed) throw new EditorPanelClosedError()
		setPanel(panel, "tab")
		await provider.resolveWebviewView(panel)
		if (closed) throw new EditorPanelClosedError()
		return { provider, isOpen: () => !closed }
	} catch (error) {
		await provider?.dispose()
		if (closed) throw new EditorPanelClosedError()
		throw error
	}
}

function showEditorRestoreError(panel: vscode.WebviewPanel, key: "missing" | "invalid" | "unavailable"): void {
	const message = t(`common:editorChatRestore.${key}`).replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
	)
	panel.webview.options = { enableScripts: false }
	panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>Alpha</title></head><body><p role="alert">${message}</p></body></html>`
}

/** retainContextWhenHidden covers tab hiding; a serializer owns restart restoration. */
export function registerEditorChatSerializer(options: Omit<RegisterCommandOptions, "provider">): void {
	options.context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer(AlphaProvider.tabPanelId, {
			async deserializeWebviewPanel(panel, savedState: unknown) {
				const identity =
					savedState && typeof savedState === "object" && "alphaEditorChat" in savedState
						? savedState.alphaEditorChat
						: undefined
				const parsed = editorChatStateSchema.safeParse(identity)
				if (!parsed.success) {
					showEditorRestoreError(panel, identity === undefined ? "missing" : "invalid")
					return
				}
				try {
					await attachAlphaEditorPanel(options, panel, parsed.data)
				} catch (error) {
					if (error instanceof EditorPanelClosedError) return
					options.outputChannel.appendLine("Could not restore editor chat; saved task data was retained")
					showEditorRestoreError(panel, "unavailable")
				}
			},
		}),
	)
}

export const openAlphaInNewTab = async ({ context, outputChannel }: Omit<RegisterCommandOptions, "provider">) => {
	const groups = vscode.window.tabGroups.all
	const targetCol = Math.max(vscode.ViewColumn.One, ...groups.map((group) => group.viewColumn)) + 1
	if (groups.length <= 1 && !groups[0]?.tabs.length) {
		await vscode.commands.executeCommand("workbench.action.newGroupRight")
	}

	const newPanel = vscode.window.createWebviewPanel(AlphaProvider.tabPanelId, "Alpha", targetCol, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [context.extensionUri],
	})

	const { provider, isOpen } = await attachAlphaEditorPanel({ context, outputChannel }, newPanel).catch((error) => {
		newPanel.dispose()
		throw error
	})

	// Lock the editor group so clicking on files doesn't open them over the panel.
	await delay(100)
	if (
		isOpen() &&
		newPanel.visible &&
		newPanel.active &&
		vscode.window.tabGroups.activeTabGroup.viewColumn === newPanel.viewColumn
	) {
		await vscode.commands.executeCommand("workbench.action.lockEditorGroup")
	}

	return provider
}
