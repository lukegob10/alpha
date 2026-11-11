import { registerBuiltinSkillInspection } from "./services/skills/builtinSkillInspection"
import { TicketPanel } from "./services/tickets/TicketPanel"
import { TicketStore } from "./services/tickets/TicketStore"
import { IncidentPanel } from "./core/webview/IncidentPanel"
import * as vscode from "vscode"
import { registerHtmlDocumentViewer } from "./core/webview/html-document"
import * as path from "path"

import { customToolRegistry } from "@alpha-code/core"

import "./utils/path" // Necessary to have access to String.prototype.toPosix.
import { initializeNetworkProxy } from "./utils/networkProxy"
import { ChatGptAuthService } from "./services/chatgpt/ChatGptAuthService"
import { createLifecycleSafeOutputChannel } from "./utils/outputChannelLogger"
import { loadExtensionEnvironment } from "./utils/loadEnvironment"

import { Package } from "./shared/package"
import { formatLanguage } from "./shared/language"
import { ContextProxy } from "./core/config/ContextProxy"
import { AgentControlStore } from "./core/agent/AgentControlStore"
import { AlphaProvider } from "./core/webview/AlphaProvider"
import { DIFF_VIEW_URI_SCHEME } from "./integrations/editor/DiffViewProvider"
import { TerminalRegistry } from "./integrations/terminal/TerminalRegistry"
import { McpServerManager } from "./services/mcp/McpServerManager"
import { CodeIndexManager } from "./services/code-index/manager"
import { ScheduledTaskService } from "./services/scheduled-tasks"
import { migrateSettings } from "./utils/migrateSettings"
import { autoImportSettings } from "./utils/autoImportSettings"
import { API } from "./extension/api"

import { registerCommands, registerEditorChatSerializer } from "./activate"
import { initializeI18n } from "./i18n"

/**
 * Built using https://github.com/microsoft/vscode-webview-ui-toolkit
 *
 * Inspired by:
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra
 */

type ExtensionLifecycle = {
	context: vscode.ExtensionContext
	outputChannel?: vscode.OutputChannel
	stopChatGptAuth?: () => Promise<void>
	terminalStarted?: boolean
	providerStarted?: boolean
	shutdown?: Promise<void>
}

let extensionLifecycle: ExtensionLifecycle | undefined

function logLifecycle(lifecycle: ExtensionLifecycle, message: string): void {
	try {
		lifecycle.outputChannel?.appendLine(message)
	} catch {
		// The host may close its output channel before asynchronous cleanup finishes.
	}
}

/**
 * Check if we should auto-open the Alpha sidebar after switching to a worktree.
 * This is called during extension activation to handle the worktree auto-open flow.
 */
async function checkWorktreeAutoOpen(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	try {
		const worktreeAutoOpenPath = context.globalState.get<string>("worktreeAutoOpenPath")
		if (!worktreeAutoOpenPath) {
			return
		}

		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return
		}

		const currentPath = workspaceFolders[0].uri.fsPath

		// Normalize paths for comparison
		const normalizePath = (p: string) => p.replace(/\/+$/, "").replace(/\\+/g, "/").toLowerCase()

		// Check if current workspace matches the worktree path
		if (normalizePath(currentPath) === normalizePath(worktreeAutoOpenPath)) {
			// Clear the state first to prevent re-triggering
			await context.globalState.update("worktreeAutoOpenPath", undefined)

			outputChannel.appendLine(`[Worktree] Auto-opening Alpha sidebar for worktree: ${worktreeAutoOpenPath}`)

			// Open the Alpha sidebar with a slight delay to ensure UI is ready
			const autoOpenTimer = setTimeout(async () => {
				try {
					await vscode.commands.executeCommand("alpha.plusButtonClicked")
				} catch (error) {
					outputChannel.appendLine(
						`[Worktree] Error auto-opening sidebar: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}, 500)
			context.subscriptions.push({ dispose: () => clearTimeout(autoOpenTimer) })
		}
	} catch (error) {
		outputChannel.appendLine(
			`[Worktree] Error checking worktree auto-open: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {
	const lifecycle: ExtensionLifecycle = { context }
	extensionLifecycle = lifecycle
	const subscriptionStart = context.subscriptions.length
	let completeStartupConfiguration!: () => void
	let failStartupConfiguration!: (error: unknown) => void
	const startupConfigurationReady = new Promise<void>((resolve, reject) => {
		completeStartupConfiguration = resolve
		failStartupConfiguration = reject
	})
	// Own rejection even if activation fails before the provider can subscribe to readiness.
	void startupConfigurationReady.catch(() => undefined)
	try {
		const api = await activateExtension(lifecycle, startupConfigurationReady)
		completeStartupConfiguration()
		// Allows other extensions to activate once Alpha is ready.
		void Promise.resolve()
			.then(() => vscode.commands.executeCommand(`${Package.name}.activationCompleted`))
			.catch(() => logLifecycle(lifecycle, "Failed to notify extensions that Alpha is ready"))
		return api
	} catch (error) {
		failStartupConfiguration(error)
		// VS Code 1.125.0 and 1.141.0 only attach subscription disposal after successful activation.
		await stopExtension(lifecycle, context.subscriptions.splice(subscriptionStart)).catch(() =>
			logLifecycle(lifecycle, "Failed to finish activation cleanup"),
		)
		throw error
	}
}

async function activateExtension(lifecycle: ExtensionLifecycle, startupConfigurationReady: Promise<void>) {
	const { context } = lifecycle
	const activationStartedAt = performance.now()
	await loadExtensionEnvironment(path.join(__dirname, "..", ".env"))
	const performanceObservabilityEnabled = process.env.ALPHA_TASK_OBSERVABILITY === "1"
	context.subscriptions.push(registerBuiltinSkillInspection(context.extensionUri))
	const outputChannel = createLifecycleSafeOutputChannel(vscode.window.createOutputChannel(Package.outputChannel))
	lifecycle.outputChannel = outputChannel
	context.subscriptions.push(outputChannel)
	outputChannel.appendLine(`${Package.name} extension activated - ${JSON.stringify(Package)}`)

	// Initialize network proxy configuration early, before any network requests.
	// When proxyUrl is configured, all HTTP/HTTPS traffic will be routed through it.
	// Only applied in debug mode (F5).
	await initializeNetworkProxy(context, outputChannel)
	const chatGptAuth = ChatGptAuthService.initialize({
		secrets: context.secrets,
		globalState: context.globalState,
		storagePath: path.join(context.globalStorageUri.fsPath, "chatgpt-auth.lock"),
		openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
	})
	let authDisposal: Promise<void> | undefined
	const stopChatGptAuth = () => {
		authDisposal ??= chatGptAuth
			.dispose()
			.catch(() => logLifecycle(lifecycle, "Failed to close ChatGPT authentication services"))
		return authDisposal
	}
	lifecycle.stopChatGptAuth = stopChatGptAuth
	context.subscriptions.push({ dispose: stopChatGptAuth })
	context.subscriptions.push(
		chatGptAuth.onDidChangeStatus((status) => {
			void AlphaProvider.publishChatGptAuthStatus(status)
		}),
	)

	// Set extension path for custom tool registry to find bundled esbuild
	customToolRegistry.setExtensionPath(context.extensionPath)

	// Migrate old settings to new
	await migrateSettings(context, outputChannel)

	// Initialize i18n for internationalization support.
	initializeI18n(context.globalState.get("language") ?? formatLanguage(vscode.env.language))

	// Initialize terminal shell execution handlers.
	lifecycle.terminalStarted = true
	TerminalRegistry.initialize()

	// Get default commands from configuration.
	const defaultCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>("allowedCommands") || []

	// Initialize global state if not already set.
	if (!context.globalState.get("allowedCommands")) {
		await context.globalState.update("allowedCommands", defaultCommands)
	}

	const contextProxy = await ContextProxy.getInstance(context)
	lifecycle.providerStarted = true
	const provider = new AlphaProvider(context, outputChannel, "sidebar", contextProxy, startupConfigurationReady)

	// Settle imported provider and approval settings before indexing, schedules, or task surfaces admit work.
	try {
		await autoImportSettings(outputChannel, {
			providerSettingsManager: provider.providerSettingsManager,
			contextProxy: provider.contextProxy,
			customModesManager: provider.customModesManager,
		})
	} catch (error) {
		outputChannel.appendLine(
			`[AutoImport] Error during auto-import: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	// Initialize code index managers for all workspace folders.
	if (vscode.workspace.workspaceFolders) {
		for (const folder of vscode.workspace.workspaceFolders) {
			const manager = CodeIndexManager.getInstance(context, folder.uri.fsPath)

			if (manager) {
				context.subscriptions.push(manager)
				// Initialize in background; do not block extension activation
				void manager.initialize(contextProxy, { refreshSecrets: false }).catch((error) => {
					const message = error instanceof Error ? error.message : String(error)
					outputChannel.appendLine(
						`[CodeIndexManager] Error during background CodeIndexManager configuration/indexing for ${folder.uri.fsPath}: ${message}`,
					)
				})
			}
		}
	}

	const ticketPanel = new TicketPanel(context, provider)
	context.subscriptions.push(ticketPanel, { dispose: () => TicketStore.disposeSearchCaches() })
	const incidentPanel = new IncidentPanel(context, provider)
	context.subscriptions.push(incidentPanel)
	context.subscriptions.push(
		vscode.commands.registerCommand("alpha.openTickets", (target?: unknown) => ticketPanel.open(target)),
	)
	context.subscriptions.push(vscode.commands.registerCommand("alpha.openIncidents", () => incidentPanel.open()))
	const scheduledTaskService = new ScheduledTaskService(context, provider, outputChannel)
	context.subscriptions.push(scheduledTaskService)
	provider.setScheduledTaskService(scheduledTaskService)
	void scheduledTaskService.initialize().catch((error) => {
		outputChannel.appendLine(
			`[ScheduledTaskService] Error during initialization: ${error instanceof Error ? error.message : String(error)}`,
		)
	})

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(AlphaProvider.sideBarId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	registerCommands({ context, outputChannel, provider })
	registerEditorChatSerializer({ context, outputChannel })
	// Auto-import may be slow; admit auto-open only once its target command exists.
	await checkWorktreeAutoOpen(context, outputChannel)
	registerHtmlDocumentViewer(context)

	/**
	 * We use the text document content provider API to show the left side for diff
	 * view by creating a virtual document for the original content. This makes it
	 * readonly so users know to edit the right side if they want to keep their changes.
	 *
	 * This API allows you to create readonly documents in VSCode from arbitrary
	 * sources, and works by claiming an uri-scheme for which your provider then
	 * returns text contents. The scheme must be provided when registering a
	 * provider and cannot change afterwards.
	 *
	 * Note how the provider doesn't create uris for virtual documents - its role
	 * is to provide contents given such an uri. In return, content providers are
	 * wired into the open document logic so that providers are always considered.
	 *
	 * https://code.visualstudio.com/api/extension-guides/virtual-documents
	 */
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider),
	)
	// Implements the `AlphaCodeAPI` interface.
	const socketPath = process.env.ALPHA_CODE_IPC_SOCKET_PATH
	const enableLogging = typeof socketPath === "string"

	// Watch the core files and automatically reload the extension host.
	if (process.env.NODE_ENV === "development") {
		const watchPaths = [
			{ path: context.extensionPath, pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "../packages/types"), pattern: "**/*.ts" },
		]

		console.log(
			`♻️♻️♻️ Core auto-reloading: Watching for changes in ${watchPaths.map(({ path }) => path).join(", ")}`,
		)

		// Create a debounced reload function to prevent excessive reloads
		let reloadTimeout: NodeJS.Timeout | undefined
		const DEBOUNCE_DELAY = 1_000

		const debouncedReload = (uri: vscode.Uri) => {
			if (reloadTimeout) {
				clearTimeout(reloadTimeout)
			}

			console.log(`♻️ ${uri.fsPath} changed; scheduling reload...`)

			reloadTimeout = setTimeout(() => {
				console.log(`♻️ Reloading host after debounce delay...`)
				vscode.commands.executeCommand("workbench.action.reloadWindow")
			}, DEBOUNCE_DELAY)
		}

		context.subscriptions.push({ dispose: () => clearTimeout(reloadTimeout) })
		watchPaths.forEach(({ path: watchPath, pattern }) => {
			const relPattern = new vscode.RelativePattern(vscode.Uri.file(watchPath), pattern)
			const watcher = vscode.workspace.createFileSystemWatcher(relPattern, false, false, false)
			context.subscriptions.push(watcher)

			// Listen to all change types to ensure symlinked file updates trigger reloads.
			watcher.onDidChange(debouncedReload)
			watcher.onDidCreate(debouncedReload)
			watcher.onDidDelete(debouncedReload)
		})
	}

	if (performanceObservabilityEnabled) {
		outputChannel.appendLine(
			`[performance] ${JSON.stringify({ phase: "extension_activation", durationMs: Math.round(performance.now() - activationStartedAt) })}`,
		)
	}
	return new API(outputChannel, provider, socketPath, enableLogging)
}

export function deactivate(): Promise<void> {
	return extensionLifecycle ? stopExtension(extensionLifecycle) : Promise.resolve()
}

function stopExtension(lifecycle: ExtensionLifecycle, rollbackSubscriptions?: vscode.Disposable[]): Promise<void> {
	return (lifecycle.shutdown ??= shutdownExtension(lifecycle, rollbackSubscriptions).finally(() => {
		if (extensionLifecycle === lifecycle) extensionLifecycle = undefined
	}))
}

async function shutdownExtension(lifecycle: ExtensionLifecycle, rollbackSubscriptions?: vscode.Disposable[]) {
	const { context, outputChannel } = lifecycle
	const log = (message: string) => logLifecycle(lifecycle, message)
	const dispose = async (subscription: vscode.Disposable) => {
		try {
			await subscription.dispose()
		} catch {
			log("Failed to dispose an extension subscription")
		}
	}

	log(rollbackSubscriptions ? `${Package.name} activation failed` : `${Package.name} extension deactivated`)
	// Stop browser authorization and close rollback registrations before joining view operations.
	const chatGptAuthStopped = lifecycle.stopChatGptAuth?.()
	const subscriptionsStopped = rollbackSubscriptions
		?.reverse()
		.filter((subscription) => subscription !== outputChannel)
		.map(dispose)

	if (lifecycle.providerStarted) {
		try {
			await AlphaProvider.disposeAll()
		} catch {
			log("Failed to dispose task providers")
		}
	}
	await chatGptAuthStopped
	if (subscriptionsStopped) await Promise.all(subscriptionsStopped)

	if (lifecycle.providerStarted) {
		try {
			await AgentControlStore.shutdownGlobalStores()
		} catch {
			log("Failed to release managed-agent runtime ownership")
		}
		try {
			await McpServerManager.cleanup(context)
		} catch {
			log("Failed to shut down MCP services")
		}
	}

	if (lifecycle.terminalStarted) {
		try {
			TerminalRegistry.cleanup()
		} catch {
			log("Failed to shut down terminal services")
		}
	}

	if (rollbackSubscriptions && outputChannel) await dispose(outputChannel)
}
