import os from "os"
import * as path from "path"
import fs from "fs/promises"
import EventEmitter from "events"
import crypto from "crypto"

import { Anthropic } from "@anthropic-ai/sdk"
import delay from "delay"
import axios from "axios"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"
import {
	managedSubagentWorktreeService,
	type ManagedWorkerArtifact,
	type PreparedManagedWorktree,
	type ValidatedWorkerScope,
} from "@alpha-code/core"

import {
	type TaskProviderLike,
	type TaskProviderEvents,
	type GlobalState,
	type ProviderName,
	type ProviderSettings,
	type RooCodeSettings,
	type ProviderSettingsEntry,
	type StaticAppProperties,
	type DynamicAppProperties,
	type TaskProperties,
	type GitProperties,
	type TelemetryProperties,
	type TelemetryPropertiesProvider,
	type CodeActionId,
	type CodeActionName,
	type TerminalActionId,
	type TerminalActionPromptType,
	type HistoryItem,
	type CreateTaskOptions,
	type CurrentTaskView,
	type TokenUsage,
	type ToolUsage,
	type ExtensionMessage,
	type ExtensionState,
	type SubagentGroupState,
	type SubagentLifecycleEvent,
	type SubagentRunPhase,
	type SubagentSpawnHandle,
	type SubagentChangeSetState,
	type SubagentVerification,
	type MarketplaceInstalledMetadata,
	TaskLifecycleState,
	RooCodeEventName,
	requestyDefaultModelId,
	openRouterDefaultModelId,
	DEFAULT_WRITE_DELAY_MS,
	DEFAULT_MAX_CONCURRENT_TASKS,
	DEFAULT_MODES,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	getModelId,
	isRetiredProvider,
} from "@alpha-code/types"
import { aggregateTaskCostsRecursive, type AggregatedCosts } from "./aggregateTaskCosts"
import { TelemetryService } from "@alpha-code/telemetry"

import { Package } from "../../shared/package"
import { findLast } from "../../shared/array"
import { supportPrompt } from "../../shared/support-prompt"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { Mode, defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { experimentDefault } from "../../shared/experiments"
import { formatLanguage } from "../../shared/language"
import { WebviewMessage } from "../../shared/WebviewMessage"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"

import { Terminal } from "../../integrations/terminal/Terminal"
import { downloadTask, getTaskFileName } from "../../integrations/misc/export-markdown"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { getTheme } from "../../integrations/theme/getTheme"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"

import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { MarketplaceManager } from "../../services/marketplace"
import { ShadowCheckpointService } from "../../services/checkpoints/ShadowCheckpointService"
import { CodeIndexManager } from "../../services/code-index/manager"
import type { IndexProgressUpdate } from "../../services/code-index/interfaces/manager"
import { SkillsManager } from "../../services/skills/SkillsManager"
import type { ScheduledTaskService } from "../../services/scheduled-tasks"
import type { GoalSeekService } from "../../services/goal-seek"

import { fileExistsAtPath } from "../../utils/fs"
import { setTtsEnabled, setTtsSpeed } from "../../utils/tts"
import { getWorkspaceGitInfo } from "../../utils/git"
import { getWorkspacePath } from "../../utils/path"

import { setPanel } from "../../activate/registerCommands"

import { t } from "../../i18n"

import { buildApiHandler } from "../../api"
import { forceFullModelDetailsLoad, hasLoadedFullDetails } from "../../api/providers/fetchers/lmstudio"

import { ContextProxy } from "../config/ContextProxy"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { CustomModesManager } from "../config/CustomModesManager"
import { Task } from "../task/Task"
import { WorkspaceMutationGate } from "../task/WorkspaceMutationGate"
import { AsyncSubagentRunManager } from "../agent/AsyncSubagentRunManager"
import { BoundedDelegationManager, type InternalTaskResult } from "../agent/BoundedDelegationManager"
import { buildInternalTaskEnvelope, type InternalTaskEnvelope } from "../agent/InternalTaskEnvelope"
import { SubagentNicknameRegistry } from "../agent/SubagentNicknameRegistry"
import { resolveSubagentModelRoute, type ResolvedSubagentModelRoute } from "../agent/SubagentModelRouter"
import {
	assertSubagentTaskAuthorities,
	buildSubagentPrompt,
	getWorkerCompletionError,
	normalizeSubagentTaskDrafts,
	type PreparedSubagentGroup,
	type SubagentToolResult,
} from "../agent/SubagentDelegation"

import { webviewMessageHandler } from "./webviewMessageHandler"
import type { ClineMessage, LiveTaskMetadata, TodoItem } from "@alpha-code/types"
import { readApiMessages, saveApiMessages, saveTaskMessages, TaskHistoryStore } from "../task-persistence"
import { readTaskMessages } from "../task-persistence/taskMessages"
import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { REQUESTY_BASE_URL } from "../../shared/utils/requesty"
import { validateAndFixToolResultIds } from "../task/validateToolResultIds"
import { normalizeMaxLiveTasks, TaskSessionRegistry } from "./TaskSessionRegistry"

/**
 * https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
 * https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
 */

export type ClineProviderEvents = {
	clineCreated: [cline: Task]
}

interface PendingEditOperation {
	messageTs: number
	editedContent: string
	images?: string[]
	messageIndex: number
	apiConversationHistoryIndex: number
	timeoutId: NodeJS.Timeout
	createdAt: number
}

const SUBAGENT_RESEARCH_WINDOW_MS = 75_000
const SUBAGENT_WORKER_TIMEOUT_MS = 15 * 60_000

export class ClineProvider
	extends EventEmitter<TaskProviderEvents>
	implements vscode.WebviewViewProvider, TelemetryPropertiesProvider, TaskProviderLike
{
	// Used in package.json as the view's id. This value cannot be changed due
	// to how VSCode caches views based on their id, and updating the id would
	// break existing instances of the extension.
	public static readonly sideBarId = `${Package.name}.SidebarProvider`
	public static readonly tabPanelId = `${Package.name}.TabPanelProvider`
	private static activeInstances: Set<ClineProvider> = new Set()
	private disposables: vscode.Disposable[] = []
	private webviewDisposables: vscode.Disposable[] = []
	private view?: vscode.WebviewView | vscode.WebviewPanel
	private clineStack: Task[] = []
	private taskSessions: TaskSessionRegistry
	private currentView: CurrentTaskView = { type: "newTaskDraft" }
	private readonly workspaceMutationGate = new WorkspaceMutationGate()
	private readonly subagentNicknameRegistry = new SubagentNicknameRegistry()
	private readonly preparedSubagentGroups = new Map<string, PreparedSubagentGroup>()
	private readonly subagentGroupControllers = new Map<string, AbortController>()
	private readonly reservedSubagentSlots = new Map<string, number>()
	private readonly publishedSubagentResults = new Set<string>()
	private readonly subagentDescriptors = new Map<
		string,
		{
			parent: Task
			groupId: string
			nickname: string
			role: "explore" | "review" | "worker"
			modelRoute: ResolvedSubagentModelRoute
			writeScope?: string[]
			validatedScope?: ValidatedWorkerScope
			managedWorktree?: PreparedManagedWorktree
			approvalProvenance: "group" | "auto"
		}
	>()
	private readonly boundedDelegationManager = new BoundedDelegationManager(
		(envelope, signal) => this.runSubagentEnvelope(envelope, signal),
		2,
	)
	private readonly asyncSubagentRunManager = new AsyncSubagentRunManager(this.boundedDelegationManager)
	private codeIndexStatusSubscription?: vscode.Disposable
	private codeIndexManager?: CodeIndexManager
	private _workspaceTracker?: WorkspaceTracker // workSpaceTracker read-only for access outside this class
	protected mcpHub?: McpHub // Change from private to protected
	protected skillsManager?: SkillsManager
	private scheduledTaskService?: ScheduledTaskService
	private goalSeekService?: GoalSeekService
	private marketplaceManager: MarketplaceManager
	private taskCreationCallback: (task: Task) => void
	private taskEventListeners: WeakMap<Task, Array<() => void>> = new WeakMap()
	private currentWorkspacePath: string | undefined
	private _disposed = false

	private recentTasksCache?: string[]
	public readonly taskHistoryStore: TaskHistoryStore
	private taskHistoryStoreInitialized = false
	private globalStateWriteThroughTimer: ReturnType<typeof setTimeout> | null = null
	private static readonly GLOBAL_STATE_WRITE_THROUGH_DEBOUNCE_MS = 5000 // 5 seconds
	private pendingOperations: Map<string, PendingEditOperation> = new Map()
	private static readonly PENDING_OPERATION_TIMEOUT_MS = 30000 // 30 seconds

	/**
	 * Monotonically increasing sequence number for clineMessages state pushes.
	 * Used by the frontend to reject stale state that arrives out-of-order.
	 */
	private clineMessagesSeq = 0

	public isViewLaunched = false
	public settingsImportedAt?: number
	public readonly latestAnnouncementId = "july-2026-v2.0.7-chat-scroll-lifecycle" // v2.0.7 chat scroll lifecycle
	public readonly providerSettingsManager: ProviderSettingsManager
	public readonly customModesManager: CustomModesManager

	constructor(
		readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly renderContext: "sidebar" | "editor" = "sidebar",
		public readonly contextProxy: ContextProxy,
	) {
		super()
		this.currentWorkspacePath = getWorkspacePath()
		this.taskSessions = new TaskSessionRegistry(this.getConfiguredMaxConcurrentTasks())

		ClineProvider.activeInstances.add(this)

		this.updateGlobalState("codebaseIndexModels", EMBEDDING_MODEL_PROFILES)

		// Initialize the per-task file-based history store.
		// The globalState write-through is debounced separately (not on every mutation)
		// since per-task files are authoritative and globalState is only for downgrade compat.
		this.taskHistoryStore = new TaskHistoryStore(this.contextProxy.globalStorageUri.fsPath, {
			onWrite: async () => {
				this.scheduleGlobalStateWriteThrough()
			},
		})
		this.initializeTaskHistoryStore().catch((error) => {
			this.log(`Failed to initialize TaskHistoryStore: ${error}`)
		})

		// Start configuration loading (which might trigger indexing) in the background.
		// Don't await, allowing activation to continue immediately.

		// Register this provider with the telemetry service to enable it to add
		// properties like mode and provider.
		TelemetryService.instance.setProvider(this)

		this._workspaceTracker = new WorkspaceTracker(this)

		this.providerSettingsManager = new ProviderSettingsManager(this.context)

		this.customModesManager = new CustomModesManager(this.context, async () => {
			await this.postStateToWebviewWithoutClineMessages()
		})

		// Initialize MCP Hub through the singleton manager
		McpServerManager.getInstance(this.context, this)
			.then((hub) => {
				this.mcpHub = hub
				this.mcpHub.registerClient()
			})
			.catch((error) => {
				this.log(`Failed to initialize MCP Hub: ${error}`)
			})

		// Initialize Skills Manager for skill discovery
		this.skillsManager = new SkillsManager(this)
		this.skillsManager.initialize().catch((error) => {
			this.log(`Failed to initialize Skills Manager: ${error}`)
		})

		this.marketplaceManager = new MarketplaceManager(this.context, this.customModesManager)

		// Forward <most> task events to the provider.
		// We do something fairly similar for the IPC-based API.
		this.taskCreationCallback = (instance: Task) => {
			this.emit(RooCodeEventName.TaskCreated, instance)

			// Create named listener functions so we can remove them later.
			const onTaskStarted = () => {
				this.markTaskLifecycle(instance.taskId, TaskLifecycleState.Running)
				this.emit(RooCodeEventName.TaskStarted, instance.taskId)
			}
			const onTaskCompleted = (taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				this.markTaskLifecycle(taskId, TaskLifecycleState.Completed)
				this.emit(RooCodeEventName.TaskCompleted, taskId, tokenUsage, toolUsage)
			}
			const onTaskAborted = () => {
				this.markTaskLifecycle(
					instance.taskId,
					instance.abortReason === "streaming_failed" ? TaskLifecycleState.Failed : TaskLifecycleState.Closed,
				)
				this.emit(RooCodeEventName.TaskAborted, instance.taskId)
			}
			const onTaskFocused = () => this.emit(RooCodeEventName.TaskFocused, instance.taskId)
			const onTaskUnfocused = () => this.emit(RooCodeEventName.TaskUnfocused, instance.taskId)
			const onTaskActive = (taskId: string) => {
				this.markTaskLifecycle(taskId, TaskLifecycleState.Running)
				this.emit(RooCodeEventName.TaskActive, taskId)
			}
			const onTaskInteractive = (taskId: string) => {
				this.markTaskLifecycle(taskId, TaskLifecycleState.Waiting, "interactive")
				this.emit(RooCodeEventName.TaskInteractive, taskId)
			}
			const onTaskResumable = (taskId: string) => {
				this.markTaskLifecycle(taskId, TaskLifecycleState.Waiting, "resumable")
				this.emit(RooCodeEventName.TaskResumable, taskId)
			}
			const onTaskIdle = (taskId: string) => {
				const lifecycle = this.getIdleTaskLifecycle(instance)
				this.markTaskLifecycle(taskId, lifecycle, lifecycle === TaskLifecycleState.Waiting ? "idle" : undefined)
				this.emit(RooCodeEventName.TaskIdle, taskId)
			}
			const onTaskPaused = (taskId: string) => this.emit(RooCodeEventName.TaskPaused, taskId)
			const onTaskUnpaused = (taskId: string) => this.emit(RooCodeEventName.TaskUnpaused, taskId)
			const onTaskSpawned = (taskId: string) => this.emit(RooCodeEventName.TaskSpawned, taskId)
			const onTaskUserMessage = (taskId: string) => this.emit(RooCodeEventName.TaskUserMessage, taskId)
			const onTaskTokenUsageUpdated = (taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				void this.postStateToWebviewWithoutTaskHistory()
				this.emit(RooCodeEventName.TaskTokenUsageUpdated, taskId, tokenUsage, toolUsage)
			}

			// Attach the listeners.
			instance.on(RooCodeEventName.TaskStarted, onTaskStarted)
			instance.on(RooCodeEventName.TaskCompleted, onTaskCompleted)
			instance.on(RooCodeEventName.TaskAborted, onTaskAborted)
			instance.on(RooCodeEventName.TaskFocused, onTaskFocused)
			instance.on(RooCodeEventName.TaskUnfocused, onTaskUnfocused)
			instance.on(RooCodeEventName.TaskActive, onTaskActive)
			instance.on(RooCodeEventName.TaskInteractive, onTaskInteractive)
			instance.on(RooCodeEventName.TaskResumable, onTaskResumable)
			instance.on(RooCodeEventName.TaskIdle, onTaskIdle)
			instance.on(RooCodeEventName.TaskPaused, onTaskPaused)
			instance.on(RooCodeEventName.TaskUnpaused, onTaskUnpaused)
			instance.on(RooCodeEventName.TaskSpawned, onTaskSpawned)
			instance.on(RooCodeEventName.TaskUserMessage, onTaskUserMessage)
			instance.on(RooCodeEventName.TaskTokenUsageUpdated, onTaskTokenUsageUpdated)

			// Store the cleanup functions for later removal.
			this.taskEventListeners.set(instance, [
				() => instance.off(RooCodeEventName.TaskStarted, onTaskStarted),
				() => instance.off(RooCodeEventName.TaskCompleted, onTaskCompleted),
				() => instance.off(RooCodeEventName.TaskAborted, onTaskAborted),
				() => instance.off(RooCodeEventName.TaskFocused, onTaskFocused),
				() => instance.off(RooCodeEventName.TaskUnfocused, onTaskUnfocused),
				() => instance.off(RooCodeEventName.TaskActive, onTaskActive),
				() => instance.off(RooCodeEventName.TaskInteractive, onTaskInteractive),
				() => instance.off(RooCodeEventName.TaskResumable, onTaskResumable),
				() => instance.off(RooCodeEventName.TaskIdle, onTaskIdle),
				() => instance.off(RooCodeEventName.TaskUserMessage, onTaskUserMessage),
				() => instance.off(RooCodeEventName.TaskPaused, onTaskPaused),
				() => instance.off(RooCodeEventName.TaskUnpaused, onTaskUnpaused),
				() => instance.off(RooCodeEventName.TaskSpawned, onTaskSpawned),
				() => instance.off(RooCodeEventName.TaskTokenUsageUpdated, onTaskTokenUsageUpdated),
			])
		}
	}

	/**
	 * Initialize the TaskHistoryStore and migrate from globalState if needed.
	 */
	private async initializeTaskHistoryStore(): Promise<void> {
		try {
			await this.taskHistoryStore.initialize()

			// Migration: backfill per-task files from globalState on first run
			const migrationKey = "taskHistoryMigratedToFiles"
			const alreadyMigrated = this.context.globalState.get<boolean>(migrationKey)

			if (!alreadyMigrated) {
				const legacyHistory = this.context.globalState.get<HistoryItem[]>("taskHistory") ?? []

				if (legacyHistory.length > 0) {
					this.log(`[initializeTaskHistoryStore] Migrating ${legacyHistory.length} entries from globalState`)
					await this.taskHistoryStore.migrateFromGlobalState(legacyHistory)
				}

				await this.context.globalState.update(migrationKey, true)
				this.log("[initializeTaskHistoryStore] Migration complete")
			}

			this.taskHistoryStoreInitialized = true
			await this.recoverManagedWorkerArtifacts()
			await this.reconcileInterruptedSubagentState()
		} catch (error) {
			this.log(`[initializeTaskHistoryStore] Error: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * Override EventEmitter's on method to match TaskProviderLike interface
	 */
	override on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.on(event, listener as any)
	}

	/**
	 * Override EventEmitter's off method to match TaskProviderLike interface
	 */
	override off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.off(event, listener as any)
	}

	// Adds a new Task instance to clineStack, marking the start of a new task.
	// The instance is pushed to the top of the stack (LIFO order).
	// When the task is completed, the top instance is removed, reactivating the
	// previous task.
	async addClineToStack(task: Task, options: { focus?: boolean } = {}) {
		// Add this cline instance into the stack that represents the order of
		// all the called tasks.
		const previous = this.getActiveTask()
		const shouldFocus = options.focus ?? true
		if (!this.clineStack.some((cline) => cline.taskId === task.taskId)) {
			this.clineStack.push(task)
		}
		this.taskSessions.register(task, { focus: shouldFocus })
		if (shouldFocus) {
			this.currentView = { type: "task", taskId: task.taskId }
		}
		this.taskSessions.markLifecycle(task.taskId, TaskLifecycleState.Initializing)
		if (shouldFocus && previous && previous.taskId !== task.taskId) {
			previous.emit(RooCodeEventName.TaskUnfocused)
		}
		if (shouldFocus) {
			task.emit(RooCodeEventName.TaskFocused)
		}

		// Perform special setup provider specific tasks.
		await this.performPreparationTasks(task)

		// Ensure getState() resolves correctly.
		const state = await this.getState()

		if (!state || typeof state.mode !== "string") {
			throw new Error(t("common:errors.retrieve_current_mode"))
		}
	}

	async performPreparationTasks(cline: Task) {
		// LMStudio: We need to force model loading in order to read its context
		// size; we do it now since we're starting a task with that model selected.
		if (cline.apiConfiguration && cline.apiConfiguration.apiProvider === "lmstudio") {
			try {
				if (!hasLoadedFullDetails(cline.apiConfiguration.lmStudioModelId!)) {
					await forceFullModelDetailsLoad(
						cline.apiConfiguration.lmStudioBaseUrl ?? "http://localhost:1234",
						cline.apiConfiguration.lmStudioModelId!,
					)
				}
			} catch (error) {
				this.log(`Failed to load full model details for LM Studio: ${error}`)
				vscode.window.showErrorMessage(error.message)
			}
		}
	}

	// Removes and destroys the top Alpha instance (the current finished task),
	// activating the previous one (resuming the parent task).
	async removeClineFromStack(options?: { skipDelegationRepair?: boolean; taskId?: string }) {
		const clineStack = this.clineStack ?? []
		const currentTask =
			(options?.taskId ? this.getLiveTask(options.taskId) : undefined) ??
			(typeof this.getActiveTask === "function" ? this.getActiveTask() : undefined) ??
			clineStack.at(-1)
		if (!currentTask) {
			return
		}

		this.clineStack = clineStack.filter((cline) => cline.taskId !== currentTask.taskId)
		this.taskSessions.markLifecycle(currentTask.taskId, TaskLifecycleState.Closing)
		let task: Task | undefined = this.taskSessions?.unregister(currentTask.taskId) ?? currentTask
		const nextActiveTaskId = this.getActiveTaskId()
		if (this.currentView.type === "task" && this.currentView.taskId === currentTask.taskId) {
			this.currentView = nextActiveTaskId ? { type: "task", taskId: nextActiveTaskId } : { type: "newTaskDraft" }
		}

		if (task) {
			// Capture delegation metadata before abort/dispose, since abortTask(true)
			// is async and the task reference is cleared afterwards.
			const childTaskId = task.taskId
			const parentTaskId = task.parentTaskId

			task.emit(RooCodeEventName.TaskUnfocused)

			try {
				// Abort the running task and set isAbandoned to true so
				// all running promises will exit as well.
				await task.abortTask(true)
			} catch (e) {
				this.log(
					`[ClineProvider#removeClineFromStack] abortTask() failed ${task.taskId}.${task.instanceId}: ${e.message}`,
				)
			}

			// Remove event listeners before clearing the reference.
			const cleanupFunctions = this.taskEventListeners.get(task)

			if (cleanupFunctions) {
				cleanupFunctions.forEach((cleanup) => cleanup())
				this.taskEventListeners.delete(task)
			}

			// Make sure no reference kept, once promises end it will be
			// garbage collected.
			task = undefined

			// Delegation-aware parent metadata repair:
			// If the popped task was a delegated child, repair the parent's metadata
			// so it transitions from "delegated" back to "active" and becomes resumable
			// from the task history list.
			// Skip when called from delegateParentAndOpenChild() during nested delegation
			// transitions (A→B→C), where the caller intentionally replaces the active
			// child and will update the parent to point at the new child.
			if (parentTaskId && childTaskId && !options?.skipDelegationRepair) {
				try {
					const { historyItem: parentHistory } = await this.getTaskWithId(parentTaskId)

					if (parentHistory.status === "delegated" && parentHistory.awaitingChildId === childTaskId) {
						await this.updateTaskHistory({
							...parentHistory,
							status: "active",
							awaitingChildId: undefined,
						})
						this.log(
							`[ClineProvider#removeClineFromStack] Repaired parent ${parentTaskId} metadata: delegated → active (child ${childTaskId} removed)`,
						)
					}
				} catch (err) {
					// Non-fatal: log but do not block the pop operation.
					this.log(
						`[ClineProvider#removeClineFromStack] Failed to repair parent metadata for ${parentTaskId} (non-fatal): ${
							err instanceof Error ? err.message : String(err)
						}`,
					)
				}
			}
		}
	}

	getTaskStackSize(): number {
		return this.clineStack.length
	}

	public getCurrentTaskStack(): string[] {
		return this.clineStack.map((cline) => cline.taskId)
	}

	// Pending Edit Operations Management

	/**
	 * Sets a pending edit operation with automatic timeout cleanup
	 */
	public setPendingEditOperation(
		operationId: string,
		editData: {
			messageTs: number
			editedContent: string
			images?: string[]
			messageIndex: number
			apiConversationHistoryIndex: number
		},
	): void {
		// Clear any existing operation with the same ID
		this.clearPendingEditOperation(operationId)

		// Create timeout for automatic cleanup
		const timeoutId = setTimeout(() => {
			this.clearPendingEditOperation(operationId)
			this.log(`[setPendingEditOperation] Automatically cleared stale pending operation: ${operationId}`)
		}, ClineProvider.PENDING_OPERATION_TIMEOUT_MS)

		// Store the operation
		this.pendingOperations.set(operationId, {
			...editData,
			timeoutId,
			createdAt: Date.now(),
		})

		this.log(`[setPendingEditOperation] Set pending operation: ${operationId}`)
	}

	/**
	 * Gets a pending edit operation by ID
	 */
	private getPendingEditOperation(operationId: string): PendingEditOperation | undefined {
		return this.pendingOperations.get(operationId)
	}

	/**
	 * Clears a specific pending edit operation
	 */
	private clearPendingEditOperation(operationId: string): boolean {
		const operation = this.pendingOperations.get(operationId)
		if (operation) {
			clearTimeout(operation.timeoutId)
			this.pendingOperations.delete(operationId)
			this.log(`[clearPendingEditOperation] Cleared pending operation: ${operationId}`)
			return true
		}
		return false
	}

	/**
	 * Clears all pending edit operations
	 */
	private clearAllPendingEditOperations(): void {
		for (const [operationId, operation] of this.pendingOperations) {
			clearTimeout(operation.timeoutId)
		}
		this.pendingOperations.clear()
		this.log(`[clearAllPendingEditOperations] Cleared all pending operations`)
	}

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	private clearWebviewResources() {
		while (this.webviewDisposables.length) {
			const x = this.webviewDisposables.pop()
			if (x) {
				x.dispose()
			}
		}
	}

	async dispose() {
		if (this._disposed) {
			return
		}

		this._disposed = true
		this.log("Disposing ClineProvider...")

		// Clear all tasks from the stack.
		while (this.clineStack.length > 0) {
			await this.removeClineFromStack()
		}

		this.log("Cleared all tasks")

		// Clear all pending edit operations to prevent memory leaks
		this.clearAllPendingEditOperations()
		this.log("Cleared pending operations")

		if (this.view && "dispose" in this.view) {
			this.view.dispose()
			this.log("Disposed webview")
		}

		this.clearWebviewResources()

		// Clean up cloud service event listener

		while (this.disposables.length) {
			const x = this.disposables.pop()

			if (x) {
				x.dispose()
			}
		}

		this._workspaceTracker?.dispose()
		this._workspaceTracker = undefined
		await this.mcpHub?.unregisterClient()
		this.mcpHub = undefined
		await this.skillsManager?.dispose()
		this.skillsManager = undefined
		this.marketplaceManager?.cleanup()
		this.customModesManager?.dispose()
		this.taskHistoryStore.dispose()
		this.scheduledTaskService?.dispose()
		this.scheduledTaskService = undefined
		this.goalSeekService?.dispose()
		this.goalSeekService = undefined
		this.flushGlobalStateWriteThrough()
		this.log("Disposed all disposables")
		ClineProvider.activeInstances.delete(this)

		// Clean up any event listeners attached to this provider
		this.removeAllListeners()

		McpServerManager.unregisterProvider(this)
	}

	public static getVisibleInstance(): ClineProvider | undefined {
		return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true)
	}

	public static async getInstance(): Promise<ClineProvider | undefined> {
		let visibleProvider = ClineProvider.getVisibleInstance()

		// If no visible provider, try to show the sidebar view
		if (!visibleProvider) {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
			// Wait briefly for the view to become visible
			await delay(100)
			visibleProvider = ClineProvider.getVisibleInstance()
		}

		// If still no visible provider, return
		if (!visibleProvider) {
			return
		}

		return visibleProvider
	}

	public static async isActiveTask(): Promise<boolean> {
		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return false
		}

		// Check if there is a cline instance in the stack (if this provider has an active task)
		if (visibleProvider.getCurrentTask()) {
			return true
		}

		return false
	}

	public static async handleCodeAction(
		command: CodeActionId,
		promptType: CodeActionName,
		params: Record<string, string | any[]>,
	): Promise<void> {
		// Capture telemetry for code action usage
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()

		// TODO: Improve type safety for promptType.
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "addToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		await visibleProvider.createTask(prompt)
	}

	public static async handleTerminalAction(
		command: TerminalActionId,
		promptType: TerminalActionPromptType,
		params: Record<string, string | any[]>,
	): Promise<void> {
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "terminalAddToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		await visibleProvider.createTask(prompt)
	}

	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
		this.view = webviewView
		const inTabMode = "onDidChangeViewState" in webviewView

		if (inTabMode) {
			setPanel(webviewView, "tab")
		} else if ("onDidChangeVisibility" in webviewView) {
			setPanel(webviewView, "sidebar")
		}

		// Initialize out-of-scope variables that need to receive persistent
		// global state values.
		this.getState().then(
			({
				terminalShellIntegrationTimeout = Terminal.defaultShellIntegrationTimeout,
				terminalShellIntegrationDisabled = false,
				terminalCommandDelay = 0,
				terminalZshClearEolMark = true,
				terminalZshOhMy = false,
				terminalZshP10k = false,
				terminalPowershellCounter = false,
				terminalZdotdir = false,
				ttsEnabled,
				ttsSpeed,
			}) => {
				Terminal.setShellIntegrationTimeout(terminalShellIntegrationTimeout)
				Terminal.setShellIntegrationDisabled(terminalShellIntegrationDisabled)
				Terminal.setCommandDelay(terminalCommandDelay)
				Terminal.setTerminalZshClearEolMark(terminalZshClearEolMark)
				Terminal.setTerminalZshOhMy(terminalZshOhMy)
				Terminal.setTerminalZshP10k(terminalZshP10k)
				Terminal.setPowershellCounter(terminalPowershellCounter)
				Terminal.setTerminalZdotdir(terminalZdotdir)
				setTtsEnabled(ttsEnabled ?? false)
				setTtsSpeed(ttsSpeed ?? 1)
			},
		)

		// Set up webview options with proper resource roots
		const resourceRoots = [this.contextProxy.extensionUri]

		// Add workspace folders to allow access to workspace files
		if (vscode.workspace.workspaceFolders) {
			resourceRoots.push(...vscode.workspace.workspaceFolders.map((folder) => folder.uri))
		}

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: resourceRoots,
		}

		webviewView.webview.html =
			this.contextProxy.extensionMode === vscode.ExtensionMode.Development
				? await this.getHMRHtmlContent(webviewView.webview)
				: await this.getHtmlContent(webviewView.webview)

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received.
		this.setWebviewMessageListener(webviewView.webview)

		// Initialize code index status subscription for the current workspace.
		this.updateCodeIndexStatusSubscription()

		// Listen for active editor changes to update code index status for the
		// current workspace.
		const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
			// Update subscription when workspace might have changed.
			this.updateCodeIndexStatusSubscription()
		})
		this.webviewDisposables.push(activeEditorSubscription)

		// Listen for when the panel becomes visible.
		// https://github.com/microsoft/vscode-discussions/discussions/840
		if ("onDidChangeViewState" in webviewView) {
			// WebviewView and WebviewPanel have all the same properties except
			// for this visibility listener panel.
			const viewStateDisposable = webviewView.onDidChangeViewState(() => {
				if (this.view?.visible) {
					this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				}
			})

			this.webviewDisposables.push(viewStateDisposable)
		} else if ("onDidChangeVisibility" in webviewView) {
			// sidebar
			const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
				if (this.view?.visible) {
					this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				}
			})

			this.webviewDisposables.push(visibilityDisposable)
		}

		// Listen for when the view is disposed
		// This happens when the user closes the view or when the view is closed programmatically
		webviewView.onDidDispose(
			async () => {
				if (inTabMode) {
					this.log("Disposing ClineProvider instance for tab view")
					await this.dispose()
				} else {
					this.log("Clearing webview resources for sidebar view")
					this.clearWebviewResources()
					// Reset current workspace manager reference when view is disposed
					this.codeIndexManager = undefined
				}
			},
			null,
			this.disposables,
		)

		// Listen for when color changes
		const configDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e && e.affectsConfiguration("workbench.colorTheme")) {
				// Sends latest theme name to webview
				await this.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) })
			}
		})
		this.webviewDisposables.push(configDisposable)

		// If the extension is starting a new session, clear previous task state.
		// But don't clear if there's already an active task (e.g., resumed via IPC/bridge).
		const currentTask = this.getCurrentTask()
		if (!currentTask || currentTask.abandoned || currentTask.abort) {
			await this.removeClineFromStack()
		}
	}

	public async createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean; preserveExisting?: boolean; background?: boolean },
	) {
		const isCliRuntime = process.env.ROO_CLI_RUNTIME === "1"
		// CLI injects runtime provider settings from command flags/env at startup.
		// Restoring provider profiles from task history can overwrite those
		// runtime settings with stale/incomplete persisted profiles.
		const skipProfileRestoreFromHistory = isCliRuntime
		let restoredApiConfiguration: ProviderSettings | undefined

		// Check if we're replacing an already-live task. Foreground replacement avoids
		// flicker; background replacement must not steal the selected chat.
		const existingTask =
			this.getLiveTask(historyItem.id) ?? this.clineStack?.find((task) => task.taskId === historyItem.id)
		const isRehydratingCurrentTask = Boolean(existingTask)
		const shouldFocus = !options?.background

		if (!isRehydratingCurrentTask && !options?.preserveExisting) {
			await this.removeClineFromStack()
		}

		// If the history item has a saved mode, restore it and its associated API configuration.
		if (historyItem.mode) {
			// Validate that the mode still exists
			const customModes = await this.customModesManager.getCustomModes()
			const modeExists = getModeBySlug(historyItem.mode, customModes) !== undefined

			if (!modeExists) {
				// Mode no longer exists, fall back to default mode.
				this.log(
					`Mode '${historyItem.mode}' from history no longer exists. Falling back to default mode '${defaultModeSlug}'.`,
				)
				historyItem.mode = defaultModeSlug
			}

			await this.updateGlobalState("mode", historyItem.mode)

			// Load the saved API config for the restored mode if it exists.
			// Skip mode-based profile activation if historyItem.apiConfigName exists,
			// since the task's specific provider profile will override it anyway.
			const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)

			if (!historyItem.apiConfigName && !lockApiConfigAcrossModes && !skipProfileRestoreFromHistory) {
				const savedConfigId = await this.providerSettingsManager.getModeConfigId(historyItem.mode)
				const listApiConfig = await this.providerSettingsManager.listConfig()

				// Update listApiConfigMeta first to ensure UI has latest data.
				await this.updateGlobalState("listApiConfigMeta", listApiConfig)

				// If this mode has a saved config, use it.
				if (savedConfigId) {
					const profile = listApiConfig.find(({ id }) => id === savedConfigId)

					if (profile?.name) {
						try {
							// Check if the profile has actual API configuration (not just an id).
							// In CLI mode, the ProviderSettingsManager may return empty default profiles
							// that only contain 'id' and 'name' fields. Activating such a profile would
							// overwrite the CLI's working API configuration with empty settings.
							const fullProfile = await this.providerSettingsManager.getProfile({ name: profile.name })
							const hasActualSettings = !!fullProfile.apiProvider

							if (hasActualSettings) {
								await this.activateProviderProfile({ name: profile.name })
							} else {
								// The task will continue with the current/default configuration.
							}
						} catch (error) {
							// Log the error but continue with task restoration.
							this.log(
								`Failed to restore API configuration for mode '${historyItem.mode}': ${
									error instanceof Error ? error.message : String(error)
								}. Continuing with default configuration.`,
							)
							// The task will continue with the current/default configuration.
						}
					}
				}
			}
		}

		// If the history item has a saved API config name (provider profile), restore it.
		// This overrides any mode-based config restoration above, because the task's
		// specific provider profile takes precedence over mode defaults.
		if (historyItem.apiConfigName && !skipProfileRestoreFromHistory) {
			const listApiConfig = await this.providerSettingsManager.listConfig()
			// Keep global state/UI in sync with latest profiles for parity with mode restoration above.
			await this.updateGlobalState("listApiConfigMeta", listApiConfig)
			const profile = listApiConfig.find(({ name }) => name === historyItem.apiConfigName)

			if (profile?.name) {
				try {
					restoredApiConfiguration = await this.getProviderSettingsForProfileName(profile.name)
				} catch (error) {
					// Log the error but continue with task restoration.
					this.log(
						`Failed to restore API configuration '${historyItem.apiConfigName}' for task: ${
							error instanceof Error ? error.message : String(error)
						}. Continuing with current configuration.`,
					)
				}
			} else {
				// Profile no longer exists, log warning but continue
				this.log(
					`Provider profile '${historyItem.apiConfigName}' from history no longer exists. Using current configuration.`,
				)
			}
		} else if (historyItem.apiConfigName && skipProfileRestoreFromHistory) {
			this.log(
				`Skipping restore of provider profile '${historyItem.apiConfigName}' for task ${historyItem.id} in CLI runtime.`,
			)
		}

		const {
			apiConfiguration: currentApiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			experiments,
		} = await this.getState()
		const apiConfiguration = restoredApiConfiguration ?? currentApiConfiguration

		const task = new Task({
			provider: this,
			apiConfiguration,
			taskApiConfigName: historyItem.apiConfigName,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			historyItem,
			experiments,
			rootTask: historyItem.rootTask,
			parentTask: historyItem.parentTask,
			taskNumber: historyItem.number,
			workspacePath: historyItem.workspace,
			onCreated: this.taskCreationCallback,
			startTask: options?.startTask ?? true,
			// Preserve the status from the history item to avoid overwriting it when the task saves messages
			initialStatus: historyItem.status,
		})

		if (isRehydratingCurrentTask) {
			// Replace the current task in-place to avoid UI flicker
			const stackIndex = this.clineStack.findIndex((cline) => cline.taskId === historyItem.id)

			// Properly dispose of the old task to ensure garbage collection
			const oldTask = stackIndex >= 0 ? this.clineStack[stackIndex] : existingTask!

			// Abort the old task to stop running processes and mark as abandoned
			try {
				await oldTask.abortTask(true)
			} catch (e) {
				this.log(
					`[createTaskWithHistoryItem] abortTask() failed for old task ${oldTask.taskId}.${oldTask.instanceId}: ${e.message}`,
				)
			}

			// Remove event listeners from the old task
			const cleanupFunctions = this.taskEventListeners.get(oldTask)
			if (cleanupFunctions) {
				cleanupFunctions.forEach((cleanup) => cleanup())
				this.taskEventListeners.delete(oldTask)
			}

			// Replace the task in the stack
			if (stackIndex >= 0) {
				this.clineStack[stackIndex] = task
			} else {
				this.clineStack.push(task)
			}
			this.taskSessions.register(task, { focus: shouldFocus })
			if (shouldFocus) {
				this.currentView = { type: "task", taskId: task.taskId }
				task.emit(RooCodeEventName.TaskFocused)
			} else if (this.getActiveTaskId() === task.taskId) {
				this.taskSessions.clearFocus()
			}

			// Perform preparation tasks and set up event listeners
			await this.performPreparationTasks(task)

			this.log(
				`[createTaskWithHistoryItem] rehydrated task ${task.taskId}.${task.instanceId} in-place (flicker-free)`,
			)
		} else {
			await this.addClineToStack(task, { focus: shouldFocus })

			this.log(
				`[createTaskWithHistoryItem] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
			)
		}

		// Check if there's a pending edit after checkpoint restoration
		const operationId = `task-${task.taskId}`
		const pendingEdit = this.getPendingEditOperation(operationId)
		if (pendingEdit) {
			this.clearPendingEditOperation(operationId) // Clear the pending edit

			this.log(`[createTaskWithHistoryItem] Processing pending edit after checkpoint restoration`)

			// Process the pending edit after a short delay to ensure the task is fully initialized
			setTimeout(async () => {
				try {
					// Find the message index in the restored state
					const { messageIndex, apiConversationHistoryIndex } = (() => {
						const messageIndex = task.clineMessages.findIndex((msg) => msg.ts === pendingEdit.messageTs)
						const apiConversationHistoryIndex = task.apiConversationHistory.findIndex(
							(msg) => msg.ts === pendingEdit.messageTs,
						)
						return { messageIndex, apiConversationHistoryIndex }
					})()

					if (messageIndex !== -1) {
						// Remove the target message and all subsequent messages
						await task.overwriteClineMessages(task.clineMessages.slice(0, messageIndex))

						if (apiConversationHistoryIndex !== -1) {
							await task.overwriteApiConversationHistory(
								task.apiConversationHistory.slice(0, apiConversationHistoryIndex),
							)
						}

						// Process the edited message
						await task.handleWebviewAskResponse(
							"messageResponse",
							pendingEdit.editedContent,
							pendingEdit.images,
						)
					}
				} catch (error) {
					this.log(`[createTaskWithHistoryItem] Error processing pending edit: ${error}`)
				}
			}, 100) // Small delay to ensure task is fully ready
		}

		return task
	}

	public async postMessageToWebview(message: ExtensionMessage) {
		if (this._disposed) {
			return
		}

		try {
			await this.view?.webview.postMessage(message)
		} catch {
			// View disposed, drop message silently
		}
	}

	private async getHMRHtmlContent(webview: vscode.Webview): Promise<string> {
		let localPort = "5173"

		try {
			const fs = require("fs")
			const path = require("path")
			const portFilePath = path.resolve(__dirname, "../../.vite-port")

			if (fs.existsSync(portFilePath)) {
				localPort = fs.readFileSync(portFilePath, "utf8").trim()
				console.log(`[ClineProvider:Vite] Using Vite server port from ${portFilePath}: ${localPort}`)
			} else {
				console.log(
					`[ClineProvider:Vite] Port file not found at ${portFilePath}, using default port: ${localPort}`,
				)
			}
		} catch (err) {
			console.error("[ClineProvider:Vite] Failed to read Vite port file:", err)
		}

		const localServerUrl = `localhost:${localPort}`

		// Check if local dev server is running.
		try {
			await axios.get(`http://${localServerUrl}`)
		} catch (error) {
			vscode.window.showErrorMessage(t("common:errors.hmr_not_running"))
			return this.getHtmlContent(webview)
		}

		const nonce = getNonce()

		// Get the OpenRouter base URL from configuration
		const { apiConfiguration } = await this.getState()
		const openRouterBaseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai"
		// Extract the domain for CSP
		const openRouterDomain = openRouterBaseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"

		const stylesUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])

		const codiconsUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "codicons", "codicon.css"])
		const materialIconsUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"vscode-material-icons",
			"icons",
		])
		const imagesUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "images"])
		const audioUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "audio"])

		const file = "src/index.tsx"
		const scriptUri = `http://${localServerUrl}/${file}`

		const reactRefresh = /*html*/ `
			<script nonce="${nonce}" type="module">
				import RefreshRuntime from "http://localhost:${localPort}/@react-refresh"
				RefreshRuntime.injectIntoGlobalHook(window)
				window.$RefreshReg$ = () => {}
				window.$RefreshSig$ = () => (type) => type
				window.__vite_plugin_react_preamble_installed__ = true
			</script>
		`

		const csp = [
			"default-src 'none'",
			`font-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline' https://* http://${localServerUrl} http://0.0.0.0:${localPort}`,
			`img-src ${webview.cspSource} https://storage.googleapis.com https://img.clerk.com data:`,
			`media-src ${webview.cspSource}`,
			`script-src 'unsafe-eval' ${webview.cspSource} https://* https://*.posthog.com http://${localServerUrl} http://0.0.0.0:${localPort} 'nonce-${nonce}'`,
			`connect-src ${webview.cspSource} ${openRouterDomain} https://* https://*.posthog.com ws://${localServerUrl} ws://0.0.0.0:${localPort} http://${localServerUrl} http://0.0.0.0:${localPort}`,
		]

		return /*html*/ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
					<meta http-equiv="Content-Security-Policy" content="${csp.join("; ")}">
					<link rel="stylesheet" type="text/css" href="${stylesUri}">
					<link href="${codiconsUri}" rel="stylesheet" />
					<script nonce="${nonce}">
						window.IMAGES_BASE_URI = "${imagesUri}"
						window.AUDIO_BASE_URI = "${audioUri}"
						window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
					</script>
					<title>Alpha</title>
				</head>
				<body>
					<div id="root"></div>
					${reactRefresh}
					<script type="module" src="${scriptUri}"></script>
				</body>
			</html>
		`
	}

	/**
	 * Defines and returns the HTML that should be rendered within the webview panel.
	 *
	 * @remarks This is also the place where references to the React webview build files
	 * are created and inserted into the webview HTML.
	 *
	 * @param webview A reference to the extension webview
	 * @param extensionUri The URI of the directory containing the extension
	 * @returns A template string literal containing the HTML that should be
	 * rendered within the webview panel
	 */
	private async getHtmlContent(webview: vscode.Webview): Promise<string> {
		// Get the local path to main script run in the webview,
		// then convert it to a uri we can use in the webview.

		// The CSS file from the React build output
		const stylesUri = getUri(webview, this.contextProxy.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])

		const scriptUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "build", "assets", "index.js"])
		const codiconsUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "codicons", "codicon.css"])
		const materialIconsUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"vscode-material-icons",
			"icons",
		])
		const imagesUri = getUri(webview, this.contextProxy.extensionUri, ["assets", "images"])
		const audioUri = getUri(webview, this.contextProxy.extensionUri, ["webview-ui", "audio"])

		// Use a nonce to only allow a specific script to be run.
		/*
		content security policy of your webview to only allow scripts that have a specific nonce
		create a content security policy meta tag so that only loading scripts with a nonce is allowed
		As your extension grows you will likely want to add custom styles, fonts, and/or images to your webview. If you do, you will need to update the content security policy meta tag to explicitly allow for these resources. E.g.
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
		- 'unsafe-inline' is required for styles due to vscode-webview-toolkit's dynamic style injection
		- since we pass base64 images to the webview, we need to specify img-src ${webview.cspSource} data:;

		in meta tag we add nonce attribute: A cryptographic nonce (only used once) to allow scripts. The server must generate a unique nonce value each time it transmits a policy. It is critical to provide a nonce that cannot be guessed as bypassing a resource's policy is otherwise trivial.
		*/
		const nonce = getNonce()

		// Get the OpenRouter base URL from configuration
		const { apiConfiguration } = await this.getState()
		const openRouterBaseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai"
		// Extract the domain for CSP
		const openRouterDomain = openRouterBaseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"

		// Tip: Install the es6-string-html VS Code extension to enable code highlighting below
		return /*html*/ `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta name="theme-color" content="#000000">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https://storage.googleapis.com data:; media-src ${webview.cspSource}; script-src ${webview.cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}' 'strict-dynamic'; connect-src ${webview.cspSource} ${openRouterDomain} https://api.requesty.ai;">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
			<link href="${codiconsUri}" rel="stylesheet" />
			<script nonce="${nonce}">
				window.IMAGES_BASE_URI = "${imagesUri}"
				window.AUDIO_BASE_URI = "${audioUri}"
				window.MATERIAL_ICONS_BASE_URI = "${materialIconsUri}"
			</script>
            <title>Alpha</title>
          </head>
          <body>
            <noscript>You need to enable JavaScript to run this app.</noscript>
            <div id="root"></div>
            <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
          </body>
        </html>
      `
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		const onReceiveMessage = async (message: WebviewMessage) =>
			webviewMessageHandler(this, message, this.marketplaceManager)

		const messageDisposable = webview.onDidReceiveMessage(onReceiveMessage)
		this.webviewDisposables.push(messageDisposable)
	}

	/**
	 * Handle switching to a new mode, including updating the associated API configuration
	 * @param newMode The mode to switch to
	 */
	public async handleModeSwitch(newMode: Mode) {
		const task = this.getCurrentTask()

		if (task) {
			try {
				await this.setTaskMode(task.taskId, newMode, { postState: false, applyModeProfile: false })
			} catch (error) {
				// If persistence fails, log the error but don't update the in-memory state.
				this.log(
					`Failed to persist mode switch for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				)

				// Optionally, we could emit an event to notify about the failure.
				// This ensures the in-memory state remains consistent with persisted state.
				throw error
			}
		}

		await this.updateGlobalState("mode", newMode)

		this.emit(RooCodeEventName.ModeChanged, newMode)

		// If workspace lock is on, keep the current API config — don't load mode-specific config
		const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
		if (lockApiConfigAcrossModes) {
			await this.postStateToWebview()
			return
		}

		// Load the saved API config for the new mode if it exists.
		const savedConfigId = await this.providerSettingsManager.getModeConfigId(newMode)
		const listApiConfig = await this.providerSettingsManager.listConfig()

		// Update listApiConfigMeta first to ensure UI has latest data.
		await this.updateGlobalState("listApiConfigMeta", listApiConfig)

		// If this mode has a saved config, use it.
		if (savedConfigId) {
			const profile = listApiConfig.find(({ id }) => id === savedConfigId)

			if (profile?.name) {
				// Check if the profile has actual API configuration (not just an id).
				// In CLI mode, the ProviderSettingsManager may return empty default profiles
				// that only contain 'id' and 'name' fields. Activating such a profile would
				// overwrite the CLI's working API configuration with empty settings.
				// Skip activation if the profile has no apiProvider set - this indicates
				// an unconfigured/empty profile.
				const fullProfile = await this.providerSettingsManager.getProfile({ name: profile.name })
				const hasActualSettings = !!fullProfile.apiProvider

				if (hasActualSettings) {
					await this.activateProviderProfile({ name: profile.name })
				} else {
					// The task will continue with the current/default configuration.
				}
			} else {
				// The task will continue with the current/default configuration.
			}
		} else {
			// If no saved config for this mode, save current config as default.
			const currentApiConfigNameAfter = this.getGlobalState("currentApiConfigName")

			if (currentApiConfigNameAfter) {
				const config = listApiConfig.find((c) => c.name === currentApiConfigNameAfter)

				if (config?.id) {
					await this.providerSettingsManager.setModeConfig(newMode, config.id)
				}
			}
		}

		await this.postStateToWebview()
	}

	// Provider Profile Management

	/**
	 * Updates the current task's API handler.
	 * Rebuilds when:
	 * - provider or model changes, OR
	 * - explicitly forced (e.g., user-initiated profile switch/save to apply changed settings like headers/baseUrl/tier).
	 * Always synchronizes task.apiConfiguration with latest provider settings.
	 * @param providerSettings The new provider settings to apply
	 * @param options.forceRebuild Force rebuilding the API handler regardless of provider/model equality
	 */
	private updateTaskApiHandlerIfNeeded(
		providerSettings: ProviderSettings,
		options: { forceRebuild?: boolean; task?: Task } = {},
	): void {
		const task = options.task ?? this.getCurrentTask()
		if (!task) return

		const { forceRebuild = false } = options

		// Determine if we need to rebuild using the previous configuration snapshot
		const prevConfig = task.apiConfiguration
		const prevProvider = prevConfig?.apiProvider
		const prevModelId = prevConfig ? getModelId(prevConfig) : undefined
		const newProvider = providerSettings.apiProvider
		const newModelId = getModelId(providerSettings)

		const needsRebuild = forceRebuild || prevProvider !== newProvider || prevModelId !== newModelId

		if (needsRebuild) {
			// Use updateApiConfiguration which handles both API handler rebuild and parser sync.
			// Note: updateApiConfiguration is declared async but has no actual async operations,
			// so we can safely call it without awaiting.
			task.updateApiConfiguration(providerSettings)
		} else {
			// No rebuild needed, just sync apiConfiguration
			;(task as any).apiConfiguration = providerSettings
		}
	}

	private async getProviderSettingsForProfileName(name: string): Promise<ProviderSettings | undefined> {
		const { name: _name, id: _id, ...providerSettings } = await this.providerSettingsManager.getProfile({ name })
		return providerSettings.apiProvider ? providerSettings : undefined
	}

	private async getModeProviderProfile(
		mode: string,
	): Promise<{ name: string; providerSettings: ProviderSettings } | undefined> {
		const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
		if (lockApiConfigAcrossModes) {
			return undefined
		}

		try {
			const savedConfigId = await this.providerSettingsManager.getModeConfigId(mode)
			if (!savedConfigId) {
				return undefined
			}

			const listApiConfig = await this.providerSettingsManager.listConfig()
			const profile = listApiConfig.find(({ id }) => id === savedConfigId)
			if (!profile?.name) {
				return undefined
			}

			const providerSettings = await this.getProviderSettingsForProfileName(profile.name)
			if (!providerSettings) {
				return undefined
			}

			return { name: profile.name, providerSettings }
		} catch (error) {
			this.log(
				`Failed to resolve provider profile for mode ${mode}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			return undefined
		}
	}

	private async applyModeProviderProfileToTask(task: Task, mode: string): Promise<void> {
		const modeProviderProfile = await this.getModeProviderProfile(mode)
		if (!modeProviderProfile) {
			return
		}

		await this.setTaskProviderProfile(task.taskId, modeProviderProfile.name, modeProviderProfile.providerSettings, {
			postState: false,
		})
	}

	public async setTaskMode(
		taskId: string,
		mode: string,
		options: { postState?: boolean; applyModeProfile?: boolean } = {},
	): Promise<void> {
		const task = this.getLiveTask(taskId)
		if (!task) {
			throw new Error(`Cannot switch mode for unknown task ${taskId}`)
		}
		const { postState = true, applyModeProfile = true } = options

		TelemetryService.instance.captureModeSwitch(task.taskId, mode)
		task.emit(RooCodeEventName.TaskModeSwitched, task.taskId, mode)

		const taskHistoryItem =
			this.taskHistoryStore.get(task.taskId) ??
			(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === task.taskId)

		if (taskHistoryItem) {
			await this.updateTaskHistory({ ...taskHistoryItem, mode })
		}

		if (typeof task.setTaskMode === "function") {
			task.setTaskMode(mode)
		} else {
			;(task as any)._taskMode = mode
		}

		if (applyModeProfile) {
			await this.applyModeProviderProfileToTask(task, mode)
		}

		if (postState && this.isTaskOnScreen(task.taskId)) {
			await this.postStateToWebview()
		}
	}

	public async setTaskProviderProfile(
		taskId: string,
		apiConfigName: string,
		providerSettings?: ProviderSettings,
		options: { postState?: boolean } = {},
	): Promise<void> {
		const task = this.getLiveTask(taskId)
		if (!task) {
			throw new Error(`Cannot switch provider profile for unknown task ${taskId}`)
		}
		const { postState = true } = options

		const resolvedProviderSettings =
			providerSettings ?? (await this.getProviderSettingsForProfileName(apiConfigName)) ?? task.apiConfiguration

		task.setTaskApiConfigName(apiConfigName)
		this.updateTaskApiHandlerIfNeeded(resolvedProviderSettings, { forceRebuild: true, task })

		const taskHistoryItem =
			this.taskHistoryStore.get(task.taskId) ??
			(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === task.taskId)

		if (taskHistoryItem) {
			await this.updateTaskHistory({ ...taskHistoryItem, apiConfigName })
		}

		if (postState && this.isTaskOnScreen(task.taskId)) {
			await this.postStateToWebview()
		}
	}

	getProviderProfileEntries(): ProviderSettingsEntry[] {
		return this.contextProxy.getValues().listApiConfigMeta || []
	}

	getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.getProviderProfileEntries().find((profile) => profile.name === name)
	}

	public hasProviderProfileEntry(name: string): boolean {
		return !!this.getProviderProfileEntry(name)
	}

	async upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		try {
			// TODO: Do we need to be calling `activateProfile`? It's not
			// clear to me what the source of truth should be; in some cases
			// we rely on the `ContextProxy`'s data store and in other cases
			// we rely on the `ProviderSettingsManager`'s data store. It might
			// be simpler to unify these two.
			const id = await this.providerSettingsManager.saveConfig(name, providerSettings)

			if (activate) {
				const { mode } = await this.getState()

				// These promises do the following:
				// 1. Adds or updates the list of provider profiles.
				// 2. Sets the current provider profile.
				// 3. Sets the current mode's provider profile.
				// 4. Copies the provider settings to the context.
				//
				// Note: 1, 2, and 4 can be done in one `ContextProxy` call:
				// this.contextProxy.setValues({ ...providerSettings, listApiConfigMeta: ..., currentApiConfigName: ... })
				// We should probably switch to that and verify that it works.
				// I left the original implementation in just to be safe.
				await Promise.all([
					this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
					this.updateGlobalState("currentApiConfigName", name),
					this.providerSettingsManager.setModeConfig(mode, id),
					this.contextProxy.setProviderSettings(providerSettings),
				])

				// Change the provider for the current task.
				// TODO: We should rename `buildApiHandler` for clarity (e.g. `getProviderClient`).
				this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

				// Keep the current task's sticky provider profile in sync with the newly-activated profile.
				await this.persistStickyProviderProfileToCurrentTask(name)
			} else {
				await this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig())
			}

			await this.postStateToWebview()
			return id
		} catch (error) {
			this.log(
				`Error create new api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			vscode.window.showErrorMessage(t("common:errors.create_api_config"))
			return undefined
		}
	}

	async deleteProviderProfile(profileToDelete: ProviderSettingsEntry) {
		const globalSettings = this.contextProxy.getValues()
		let profileToActivate: string | undefined = globalSettings.currentApiConfigName

		if (profileToDelete.name === profileToActivate) {
			profileToActivate = this.getProviderProfileEntries().find(({ name }) => name !== profileToDelete.name)?.name
		}

		if (!profileToActivate) {
			throw new Error("You cannot delete the last profile")
		}

		const entries = this.getProviderProfileEntries().filter(({ name }) => name !== profileToDelete.name)

		await this.contextProxy.setValues({
			...globalSettings,
			currentApiConfigName: profileToActivate,
			listApiConfigMeta: entries,
			...this.getClearedSubagentRouteSettings(profileToDelete.id, globalSettings),
		})

		await this.postStateToWebview()
	}

	/** Remove routing references to a deleted profile while preserving unrelated role selections. */
	public async clearSubagentProfileReferences(profileId: string): Promise<void> {
		const values = this.contextProxy.getValues()
		const cleared = this.getClearedSubagentRouteSettings(profileId, values)
		if (Object.keys(cleared).length > 0) await this.contextProxy.setValues(cleared)
	}

	private getClearedSubagentRouteSettings(
		profileId: string | undefined,
		values: RooCodeSettings,
	): Pick<RooCodeSettings, "subagentDefaultApiConfigId" | "subagentApiConfigByRole"> {
		if (!profileId) return {}

		const cleared: Pick<RooCodeSettings, "subagentDefaultApiConfigId" | "subagentApiConfigByRole"> = {}
		if (values.subagentDefaultApiConfigId === profileId) cleared.subagentDefaultApiConfigId = undefined

		const roles = values.subagentApiConfigByRole
		if (roles?.explore === profileId || roles?.review === profileId || roles?.worker === profileId) {
			const nextRoles = {
				...(roles.explore !== profileId && roles.explore ? { explore: roles.explore } : {}),
				...(roles.review !== profileId && roles.review ? { review: roles.review } : {}),
				...(roles.worker !== profileId && roles.worker ? { worker: roles.worker } : {}),
			}
			cleared.subagentApiConfigByRole = Object.keys(nextRoles).length > 0 ? nextRoles : undefined
		}

		return cleared
	}

	private async persistStickyProviderProfileToCurrentTask(apiConfigName: string): Promise<void> {
		const task = this.getCurrentTask()
		if (!task) {
			return
		}

		try {
			// Update in-memory state immediately so sticky behavior works even before the task has
			// been persisted into taskHistory (it will be captured on the next save).
			task.setTaskApiConfigName(apiConfigName)

			const taskHistoryItem =
				this.taskHistoryStore.get(task.taskId) ??
				(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === task.taskId)

			if (taskHistoryItem) {
				await this.updateTaskHistory({ ...taskHistoryItem, apiConfigName })
			}
		} catch (error) {
			// If persistence fails, log the error but don't fail the profile switch.
			this.log(
				`Failed to persist provider profile switch for task ${task.taskId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	async activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	) {
		const { name, id, ...providerSettings } = await this.providerSettingsManager.activateProfile(args)

		const persistModeConfig = options?.persistModeConfig ?? true
		const persistTaskHistory = options?.persistTaskHistory ?? true

		// See `upsertProviderProfile` for a description of what this is doing.
		await Promise.all([
			this.contextProxy.setValue("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
			this.contextProxy.setValue("currentApiConfigName", name),
			this.contextProxy.setProviderSettings(providerSettings),
		])

		const { mode } = await this.getState()

		if (id && persistModeConfig) {
			await this.providerSettingsManager.setModeConfig(mode, id)
		}

		// Change the provider for the current task.
		this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

		// Update the current task's sticky provider profile, unless this activation is
		// being used purely as a non-persisting restoration (e.g., reopening a task from history).
		if (persistTaskHistory) {
			await this.persistStickyProviderProfileToCurrentTask(name)
		}

		await this.postStateToWebview()

		if (providerSettings.apiProvider) {
			this.emit(RooCodeEventName.ProviderProfileChanged, { name, provider: providerSettings.apiProvider })
		}
	}

	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field.
		await this.updateGlobalState("customInstructions", instructions || undefined)
		await this.postStateToWebview()
	}

	// MCP

	async ensureMcpServersDirectoryExists(): Promise<string> {
		// Get platform-specific application data directory
		let mcpServersDir: string
		if (process.platform === "win32") {
			// Windows: %APPDATA%\Alpha\MCP
			mcpServersDir = path.join(os.homedir(), "AppData", "Roaming", "Alpha", "MCP")
		} else if (process.platform === "darwin") {
			// macOS: ~/Documents/Alpha/MCP
			mcpServersDir = path.join(os.homedir(), "Documents", "Alpha", "MCP")
		} else {
			// Linux: ~/.local/share/Alpha/MCP
			mcpServersDir = path.join(os.homedir(), ".local", "share", "Alpha", "MCP")
		}

		try {
			await fs.mkdir(mcpServersDir, { recursive: true })
		} catch (error) {
			// Fallback to a relative path if directory creation fails
			return path.join(os.homedir(), ".alpha-code", "mcp")
		}
		return mcpServersDir
	}

	async ensureSettingsDirectoryExists(): Promise<string> {
		const { getSettingsDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		return getSettingsDirectoryPath(globalStoragePath)
	}

	// OpenRouter

	async handleOpenRouterCallback(code: string) {
		let { apiConfiguration, currentApiConfigName = "default" } = await this.getState()

		let apiKey: string

		try {
			const baseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai/api/v1"
			// Extract the base domain for the auth endpoint.
			const baseUrlDomain = baseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"
			const response = await axios.post(`${baseUrlDomain}/api/v1/auth/keys`, { code })

			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			this.log(
				`Error exchanging code for API key: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			throw error
		}

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: "openrouter",
			openRouterApiKey: apiKey,
			openRouterModelId: apiConfiguration?.openRouterModelId || openRouterDefaultModelId,
		}

		await this.upsertProviderProfile(currentApiConfigName, newConfiguration)
	}

	// Requesty

	async handleRequestyCallback(code: string, baseUrl: string | null) {
		let { apiConfiguration } = await this.getState()

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: "requesty",
			requestyApiKey: code,
			requestyModelId: apiConfiguration?.requestyModelId || requestyDefaultModelId,
		}

		// set baseUrl as undefined if we don't provide one
		// or if it is the default requesty url
		if (!baseUrl || baseUrl === REQUESTY_BASE_URL) {
			newConfiguration.requestyBaseUrl = undefined
		} else {
			newConfiguration.requestyBaseUrl = baseUrl
		}

		const profileName = `Requesty (${new Date().toLocaleString()})`
		await this.upsertProviderProfile(profileName, newConfiguration)
	}

	// Task history

	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const historyItem =
			this.taskHistoryStore.get(id) ?? (this.getGlobalState("taskHistory") ?? []).find((item) => item.id === id)

		if (!historyItem) {
			throw new Error("Task not found")
		}

		const { getTaskDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, id)
		const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
		const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
		const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)

		let apiConversationHistory: Anthropic.MessageParam[] = []

		if (fileExists) {
			try {
				apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
			} catch (error) {
				console.warn(
					`[getTaskWithId] api_conversation_history.json corrupted for task ${id}, returning empty history: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		} else {
			console.warn(
				`[getTaskWithId] api_conversation_history.json missing for task ${id}, returning empty history`,
			)
		}

		return {
			historyItem,
			taskDirPath,
			apiConversationHistoryFilePath,
			uiMessagesFilePath,
			apiConversationHistory,
		}
	}

	async getTaskWithAggregatedCosts(taskId: string): Promise<{
		historyItem: HistoryItem
		aggregatedCosts: AggregatedCosts
	}> {
		const { historyItem } = await this.getTaskWithId(taskId)

		const aggregatedCosts = await aggregateTaskCostsRecursive(taskId, async (id: string) => {
			// Descendants can be attached to the parent a few milliseconds before their
			// HistoryItem is persisted. Aggregation already treats an absent descendant
			// as zero cost, so use the non-throwing history index instead of getTaskWithId.
			return (
				this.taskHistoryStore.get(id) ??
				(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === id)
			)
		})

		return { historyItem, aggregatedCosts }
	}

	async showTaskWithId(id: string) {
		if (id !== this.getCurrentTask()?.taskId) {
			const focused = await this.focusTask(id)
			if (focused) {
				await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
				return
			}

			const { historyItem } = await this.getTaskWithId(id)
			await this.createTaskWithHistoryItem(historyItem, { preserveExisting: true })
		}

		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	async exportTaskWithId(id: string) {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		const fileName = getTaskFileName(historyItem.ts)
		const defaultUri = await resolveDefaultSaveUri(this.contextProxy, "lastTaskExportPath", fileName, {
			useWorkspace: false,
			fallbackDir: path.join(os.homedir(), "Downloads"),
		})
		const saveUri = await downloadTask(historyItem.ts, apiConversationHistory, defaultUri)

		if (saveUri) {
			await saveLastExportPath(this.contextProxy, "lastTaskExportPath", saveUri)
		}
	}

	/* Condenses a task's message history to use fewer tokens. */
	async condenseTaskContext(taskId: string) {
		let task: Task | undefined
		for (let i = this.clineStack.length - 1; i >= 0; i--) {
			if (this.clineStack[i].taskId === taskId) {
				task = this.clineStack[i]
				break
			}
		}
		if (!task) {
			throw new Error(`Task with id ${taskId} not found in stack`)
		}
		await task.condenseContext()
		await this.postMessageToWebview({ type: "condenseTaskContextResponse", text: taskId })
	}

	// this function deletes a task from task history, and deletes its checkpoints and delete the task folder
	// If the task has subtasks (childIds), they will also be deleted recursively
	async deleteTaskWithId(id: string, cascadeSubtasks: boolean = true) {
		try {
			// get the task directory full path and history item
			const { taskDirPath, historyItem } = await this.getTaskWithId(id)

			// Collect all task IDs to delete (parent + all subtasks)
			const allIdsToDelete: string[] = [id]

			if (cascadeSubtasks) {
				// Recursively collect all child IDs
				const collectChildIds = async (taskId: string): Promise<void> => {
					try {
						const { historyItem: item } = await this.getTaskWithId(taskId)
						if (item.childIds && item.childIds.length > 0) {
							for (const childId of item.childIds) {
								allIdsToDelete.push(childId)
								await collectChildIds(childId)
							}
						}
					} catch (error) {
						// Child task may already be deleted or not found, continue
						console.log(`[deleteTaskWithId] child task ${taskId} not found, skipping`)
					}
				}

				await collectChildIds(id)
			}

			// Close any live task instances, including background tasks. History deletion
			// alone must not leave a live session counted against the max task limit.
			for (const taskId of allIdsToDelete) {
				if (this.getLiveTask(taskId)) {
					await this.removeClineFromStack({ taskId })
				}
			}
			const changeSetIds = allIdsToDelete
				.map((taskId) => this.taskHistoryStore.get(taskId)?.subagentChangeSet?.id)
				.filter((changeSetId): changeSetId is string => Boolean(changeSetId))

			// Delete all tasks from state in one batch
			await this.taskHistoryStore.deleteMany(allIdsToDelete)
			this.recentTasksCache = undefined

			// Delete associated shadow repositories or branches and task directories
			const globalStorageDir = this.contextProxy.globalStorageUri.fsPath
			const workspaceDir = this.cwd
			const { getTaskDirectoryPath } = await import("../../utils/storage")
			const globalStoragePath = this.contextProxy.globalStorageUri.fsPath

			for (const taskId of allIdsToDelete) {
				try {
					await ShadowCheckpointService.deleteTask({ taskId, globalStorageDir, workspaceDir })
				} catch (error) {
					console.error(
						`[deleteTaskWithId${taskId}] failed to delete associated shadow repository or branch: ${error instanceof Error ? error.message : String(error)}`,
					)
				}

				// Delete the task directory
				try {
					const dirPath = await getTaskDirectoryPath(globalStoragePath, taskId)
					await fs.rm(dirPath, { recursive: true, force: true })
					console.log(`[deleteTaskWithId${taskId}] removed task directory`)
				} catch (error) {
					console.error(
						`[deleteTaskWithId${taskId}] failed to remove task directory: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			for (const changeSetId of changeSetIds) {
				await managedSubagentWorktreeService
					.deleteArtifact(this.context.globalStorageUri.fsPath, changeSetId)
					.catch((error) => this.log(`Failed to delete worker artifact ${changeSetId}: ${String(error)}`))
			}

			await this.postStateToWebview()
		} catch (error) {
			// If task is not found, just remove it from state
			if (error instanceof Error && error.message === "Task not found") {
				await this.deleteTaskFromState(id)
				return
			}
			throw error
		}
	}

	async deleteTaskFromState(id: string) {
		if (this.getLiveTask(id)) {
			await this.removeClineFromStack({ taskId: id })
		}
		await this.taskHistoryStore.delete(id)
		this.recentTasksCache = undefined

		await this.postStateToWebview()
	}

	async refreshWorkspace() {
		this.currentWorkspacePath = getWorkspacePath()
		await this.postStateToWebview()
	}

	async postStateToWebview() {
		const state = await this.getStateToPostToWebview()
		this.clineMessagesSeq++
		state.clineMessagesSeq = this.clineMessagesSeq
		this.postMessageToWebview({ type: "state", state })
	}

	/**
	 * Like postStateToWebview but intentionally omits taskHistory.
	 *
	 * Rationale:
	 * - taskHistory can be large and was being resent on every chat message update.
	 * - The webview maintains taskHistory in-memory and receives updates via
	 *   `taskHistoryUpdated` / `taskHistoryItemUpdated`.
	 */
	async postStateToWebviewWithoutTaskHistory(): Promise<void> {
		const state = await this.getStateToPostToWebview()
		this.clineMessagesSeq++
		state.clineMessagesSeq = this.clineMessagesSeq
		const { taskHistory: _omit, ...rest } = state
		this.postMessageToWebview({ type: "state", state: rest })
	}

	/**
	 * Like postStateToWebview but intentionally omits both clineMessages and taskHistory.
	 *
	 * Rationale:
	 * - Mode changes trigger state pushes that have nothing to do with chat messages. Including
	 *   clineMessages in these pushes creates race conditions where a stale snapshot of clineMessages
	 *   overwrites newer messages the task has streamed in the meantime.
	 */
	async postStateToWebviewWithoutClineMessages(): Promise<void> {
		const state = await this.getStateToPostToWebview()
		const { clineMessages: _omitMessages, taskHistory: _omitHistory, ...rest } = state
		this.postMessageToWebview({ type: "state", state: rest })
	}

	/**
	 * Fetches marketplace data on demand to avoid blocking main state updates
	 */
	async fetchMarketplaceData() {
		try {
			const [marketplaceResult, marketplaceInstalledMetadata] = await Promise.all([
				this.marketplaceManager.getMarketplaceItems().catch((error) => {
					console.error("Failed to fetch marketplace items:", error)
					return { organizationMcps: [], marketplaceItems: [], errors: [error.message] }
				}),
				this.marketplaceManager.getInstallationMetadata().catch((error) => {
					console.error("Failed to fetch installation metadata:", error)
					return { project: {}, global: {} } as MarketplaceInstalledMetadata
				}),
			])

			// Send marketplace data separately
			this.postMessageToWebview({
				type: "marketplaceData",
				organizationMcps: marketplaceResult.organizationMcps || [],
				marketplaceItems: marketplaceResult.marketplaceItems || [],
				marketplaceInstalledMetadata: marketplaceInstalledMetadata || { project: {}, global: {} },
				errors: marketplaceResult.errors,
			})
		} catch (error) {
			console.error("Failed to fetch marketplace data:", error)

			// Send empty data on error to prevent UI from hanging
			this.postMessageToWebview({
				type: "marketplaceData",
				organizationMcps: [],
				marketplaceItems: [],
				marketplaceInstalledMetadata: { project: {}, global: {} },
				errors: [error instanceof Error ? error.message : String(error)],
			})

			// Show user-friendly error notification for network issues
			if (error instanceof Error && error.message.includes("timeout")) {
				vscode.window.showWarningMessage(
					"Marketplace data could not be loaded due to network restrictions. Core functionality remains available.",
				)
			}
		}
	}

	/**
	 * Merges allowed commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeAllowedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("allowedCommands", "allowed", globalStateCommands)
	}

	/**
	 * Merges denied commands from global state and workspace configuration
	 * with proper validation and deduplication
	 */
	private mergeDeniedCommands(globalStateCommands?: string[]): string[] {
		return this.mergeCommandLists("deniedCommands", "denied", globalStateCommands)
	}

	/**
	 * Common utility for merging command lists from global state and workspace configuration.
	 * Implements the Command Denylist feature's merging strategy with proper validation.
	 *
	 * @param configKey - VSCode workspace configuration key
	 * @param commandType - Type of commands for error logging
	 * @param globalStateCommands - Commands from global state
	 * @returns Merged and deduplicated command list
	 */
	private normalizeCommandList(commands?: unknown): string[] {
		if (!Array.isArray(commands)) {
			return []
		}

		return [
			...new Set(
				commands
					.filter((cmd): cmd is string => typeof cmd === "string" && cmd.trim().length > 0)
					.map((cmd) => cmd.trim()),
			),
		]
	}

	private getConfiguredCommandList(configKey: "allowedCommands" | "deniedCommands"): string[] {
		const configuration = vscode.workspace.getConfiguration(Package.name)
		const inspectedConfig =
			typeof configuration.inspect === "function" ? configuration.inspect<string[]>(configKey) : undefined

		return [
			...this.normalizeCommandList(inspectedConfig?.globalValue),
			...this.normalizeCommandList(inspectedConfig?.workspaceValue),
			...this.normalizeCommandList(inspectedConfig?.workspaceFolderValue),
		]
	}

	private mergeCommandLists(
		configKey: "allowedCommands" | "deniedCommands",
		commandType: "allowed" | "denied",
		globalStateCommands?: string[],
	): string[] {
		try {
			const validGlobalCommands = this.normalizeCommandList(globalStateCommands)
			const validConfiguredCommands = this.getConfiguredCommandList(configKey)

			// Combine and deduplicate commands
			// Global state takes precedence over workspace configuration
			const mergedCommands = [...new Set([...validGlobalCommands, ...validConfiguredCommands])]

			return mergedCommands
		} catch (error) {
			console.error(`Error merging ${commandType} commands:`, error)
			// Return empty array as fallback to prevent crashes
			return []
		}
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		// Ensure the store is initialized before reading task history
		await this.taskHistoryStore.initialized

		const {
			apiConfiguration,
			lastShownAnnouncementId,
			customInstructions,
			alwaysAllowReadOnly,
			alwaysAllowReadOnlyOutsideWorkspace,
			alwaysAllowWrite,
			alwaysAllowWriteOutsideWorkspace,
			alwaysAllowWriteProtected,
			alwaysAllowExecute,
			allowedCommands,
			deniedCommands,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowSubagents,
			maxConcurrentTasks,
			subagentDefaultApiConfigId,
			subagentApiConfigByRole,
			allowedMaxRequests,
			allowedMaxCost,
			autoCondenseContext,
			autoCondenseContextPercent,
			soundEnabled,
			ttsEnabled,
			ttsSpeed,
			enableCheckpoints,
			checkpointTimeout,
			taskHistory,
			soundVolume,
			writeDelayMs,
			terminalShellIntegrationTimeout,
			terminalShellIntegrationDisabled,
			terminalCommandDelay,
			terminalPowershellCounter,
			terminalZshClearEolMark,
			terminalZshOhMy,
			terminalZshP10k,
			terminalZdotdir,
			mcpEnabled,
			currentApiConfigName,
			listApiConfigMeta,
			pinnedApiConfigs,
			mode,
			customModePrompts,
			customSupportPrompts,
			enhancementApiConfigId,
			autoApprovalEnabled,
			customModes,
			experiments,
			maxOpenTabsContext,
			maxWorkspaceFiles,
			disabledTools,
			telemetrySetting,
			showRooIgnoredFiles,
			enableSubfolderRules,
			language,
			maxImageFileSize,
			maxTotalImageSize,
			historyPreviewCollapsed,
			reasoningBlockCollapsed,
			enterBehavior,
			customCondensingPrompt,
			codebaseIndexConfig,
			codebaseIndexModels,
			profileThresholds,
			alwaysAllowFollowupQuestions,
			followupAutoApproveTimeoutMs,
			includeDiagnosticMessages,
			maxDiagnosticMessages,
			includeTaskHistoryInEnhance,
			includeCurrentTime,
			includeCurrentCost,
			maxGitStatusFiles,
			imageGenerationProvider,
			openRouterImageApiKey,
			githubToken,
			openRouterImageGenerationSelectedModel,
			lockApiConfigAcrossModes,
		} = await this.getState()

		const telemetryKey = undefined
		const machineId = vscode.env.machineId
		const mergedAllowedCommands = this.mergeAllowedCommands(allowedCommands)
		const mergedDeniedCommands = this.mergeDeniedCommands(deniedCommands)
		const cwd = this.cwd
		const currentTask = this.currentView.type === "task" ? this.getLiveTask(this.currentView.taskId) : undefined
		let currentTaskMode: string | undefined
		let currentTaskApiConfigName: string | undefined
		if (currentTask) {
			try {
				currentTaskMode = await currentTask.getTaskMode()
			} catch (error) {
				this.log(
					`[getStateToPostToWebview] Failed to resolve task mode for ${currentTask.taskId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
			try {
				currentTaskApiConfigName = await currentTask.getTaskApiConfigName()
			} catch (error) {
				this.log(
					`[getStateToPostToWebview] Failed to resolve task API config for ${currentTask.taskId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		}
		const currentTaskApiConfiguration = currentTask?.apiConfiguration ?? apiConfiguration
		const scheduledTaskState = this.scheduledTaskService?.getState()
		const goalSeekState = this.goalSeekService?.getState()

		return {
			version: this.context.extension?.packageJSON?.version ?? "",
			apiConfiguration: currentTaskApiConfiguration,
			customInstructions,
			profileThresholds: profileThresholds ?? {},
			alwaysAllowReadOnly: alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? false,
			alwaysAllowWrite: alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? false,
			alwaysAllowExecute: alwaysAllowExecute ?? false,
			alwaysAllowMcp: alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: alwaysAllowSubtasks ?? false,
			alwaysAllowSubagents: alwaysAllowSubagents ?? false,
			maxConcurrentTasks: maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
			subagentDefaultApiConfigId,
			subagentApiConfigByRole,
			allowedMaxRequests,
			allowedMaxCost,
			autoCondenseContext: autoCondenseContext ?? true,
			autoCondenseContextPercent: autoCondenseContextPercent ?? 100,
			uriScheme: vscode.env.uriScheme,
			currentTaskId: currentTask?.taskId,
			currentView: this.currentView,
			activeTaskId: this.getActiveTaskId(),
			liveTaskIds: this.getLiveTaskIds(),
			liveTasksById: this.getLiveTaskMetadata(),
			currentTaskItem: currentTask?.taskId ? this.taskHistoryStore.get(currentTask.taskId) : undefined,
			clineMessages: currentTask?.clineMessages || [],
			currentTaskTodos: currentTask?.todoList || [],
			messageQueue: currentTask?.messageQueueService?.messages,
			taskHistory: this.taskHistoryStore.getAll().filter((item: HistoryItem) => item.ts && item.task),
			scheduledTasks: scheduledTaskState?.tasks ?? [],
			scheduledTaskRuns: scheduledTaskState?.runs ?? [],
			goalSeekJobs: goalSeekState?.jobs ?? [],
			goalSeekRuns: goalSeekState?.runs ?? [],
			goalSeekAttempts: goalSeekState?.attempts ?? [],
			soundEnabled: soundEnabled ?? false,
			ttsEnabled: ttsEnabled ?? false,
			ttsSpeed: ttsSpeed ?? 1.0,
			enableCheckpoints: enableCheckpoints ?? true,
			checkpointTimeout: checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			shouldShowAnnouncement:
				telemetrySetting !== "unset" && lastShownAnnouncementId !== this.latestAnnouncementId,
			allowedCommands: mergedAllowedCommands,
			deniedCommands: mergedDeniedCommands,
			soundVolume: soundVolume ?? 0.5,
			writeDelayMs: writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: terminalCommandDelay ?? 0,
			terminalPowershellCounter: terminalPowershellCounter ?? false,
			terminalZshClearEolMark: terminalZshClearEolMark ?? true,
			terminalZshOhMy: terminalZshOhMy ?? false,
			terminalZshP10k: terminalZshP10k ?? false,
			terminalZdotdir: terminalZdotdir ?? false,
			mcpEnabled: mcpEnabled ?? true,
			currentApiConfigName: currentTaskApiConfigName ?? currentApiConfigName ?? "default",
			listApiConfigMeta: listApiConfigMeta ?? [],
			pinnedApiConfigs: pinnedApiConfigs ?? {},
			mode: currentTaskMode ?? mode ?? defaultModeSlug,
			customModePrompts: customModePrompts ?? {},
			customSupportPrompts: customSupportPrompts ?? {},
			enhancementApiConfigId,
			autoApprovalEnabled: autoApprovalEnabled ?? false,
			customModes,
			experiments: experiments ?? experimentDefault,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			maxOpenTabsContext: maxOpenTabsContext ?? 20,
			maxWorkspaceFiles: maxWorkspaceFiles ?? 200,
			cwd,
			disabledTools,
			telemetrySetting,
			telemetryKey,
			machineId,
			showRooIgnoredFiles: showRooIgnoredFiles ?? false,
			enableSubfolderRules: enableSubfolderRules ?? false,
			language: language ?? formatLanguage(vscode.env.language),
			renderContext: this.renderContext,
			maxImageFileSize: maxImageFileSize ?? 5,
			maxTotalImageSize: maxTotalImageSize ?? 20,
			settingsImportedAt: this.settingsImportedAt,
			historyPreviewCollapsed: historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
			enterBehavior: enterBehavior ?? "send",
			customCondensingPrompt,
			codebaseIndexModels: codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexVectorStoreProvider: codebaseIndexConfig?.codebaseIndexVectorStoreProvider ?? "lancedb",
				codebaseIndexLocalIndexPath:
					codebaseIndexConfig?.codebaseIndexLocalIndexPath ?? ".alpha/code-index/lancedb",
				codebaseIndexQdrantUrl: codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider: codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
				codebaseIndexEmbedderBaseUrl: codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension: codebaseIndexConfig?.codebaseIndexEmbedderModelDimension ?? 1536,
				codebaseIndexOpenAiCompatibleBaseUrl: codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexEmbeddingRateLimitEnabled: codebaseIndexConfig?.codebaseIndexEmbeddingRateLimitEnabled,
				codebaseIndexEmbeddingRateLimitSeconds: codebaseIndexConfig?.codebaseIndexEmbeddingRateLimitSeconds,
				codebaseIndexBedrockRegion: codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexVertexProjectId: codebaseIndexConfig?.codebaseIndexVertexProjectId,
				codebaseIndexVertexRegion: codebaseIndexConfig?.codebaseIndexVertexRegion,
				codebaseIndexVertexKeyFile: codebaseIndexConfig?.codebaseIndexVertexKeyFile,
				codebaseIndexVertexGatewayBaseUrl: codebaseIndexConfig?.codebaseIndexVertexGatewayBaseUrl,
				codebaseIndexVertexGatewayCaBundlePath: codebaseIndexConfig?.codebaseIndexVertexGatewayCaBundlePath,
				codebaseIndexVertexGatewayHelixCommand: codebaseIndexConfig?.codebaseIndexVertexGatewayHelixCommand,
				codebaseIndexVertexGatewayTokenRefreshMinutes:
					codebaseIndexConfig?.codebaseIndexVertexGatewayTokenRefreshMinutes,
				codebaseIndexVertexGatewayModelRoutingMap:
					codebaseIndexConfig?.codebaseIndexVertexGatewayModelRoutingMap,
				codebaseIndexOpenRouterSpecificProvider: codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
			},
			hasOpenedModeSelector: this.getGlobalState("hasOpenedModeSelector") ?? false,
			lockApiConfigAcrossModes: lockApiConfigAcrossModes ?? false,
			alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: followupAutoApproveTimeoutMs ?? 60000,
			includeDiagnosticMessages: includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: includeCurrentTime ?? true,
			includeCurrentCost: includeCurrentCost ?? true,
			maxGitStatusFiles: maxGitStatusFiles ?? 0,
			imageGenerationProvider,
			openRouterImageApiKey,
			githubToken,
			openRouterImageGenerationSelectedModel,
			openAiCodexIsAuthenticated: await (async () => {
				try {
					const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
					return await openAiCodexOAuthManager.isAuthenticated()
				} catch {
					return false
				}
			})(),
			debug: vscode.workspace.getConfiguration(Package.name).get<boolean>("debug", false),
		}
	}

	/**
	 * Storage
	 * https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
	 * https://www.eliostruyf.com/devhack-code-extension-storage-options/
	 */

	async getState(): Promise<
		Omit<
			ExtensionState,
			"clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version" | "shouldShowAnnouncement"
		>
	> {
		const stateValues = this.contextProxy.getValues()
		const customModes = await this.customModesManager.getCustomModes()

		// Determine apiProvider with the same logic as before, while filtering retired providers.
		const apiProvider: ProviderName =
			stateValues.apiProvider && !isRetiredProvider(stateValues.apiProvider)
				? stateValues.apiProvider
				: "anthropic"

		// Build the apiConfiguration object combining state values and secrets.
		const providerSettings = this.contextProxy.getProviderSettings()

		// Ensure apiProvider is set properly if not already in state
		if (!providerSettings.apiProvider) {
			providerSettings.apiProvider = apiProvider
		}

		// Return the same structure as before.
		return {
			apiConfiguration: providerSettings,
			lastShownAnnouncementId: stateValues.lastShownAnnouncementId,
			customInstructions: stateValues.customInstructions,
			apiModelId: stateValues.apiModelId,
			alwaysAllowReadOnly: stateValues.alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: stateValues.alwaysAllowReadOnlyOutsideWorkspace ?? false,
			alwaysAllowWrite: stateValues.alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: stateValues.alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: stateValues.alwaysAllowWriteProtected ?? false,
			alwaysAllowExecute: stateValues.alwaysAllowExecute ?? false,
			alwaysAllowMcp: stateValues.alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: stateValues.alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: stateValues.alwaysAllowSubtasks ?? false,
			alwaysAllowSubagents: stateValues.alwaysAllowSubagents ?? false,
			maxConcurrentTasks: this.getConfiguredMaxConcurrentTasks(),
			subagentDefaultApiConfigId: stateValues.subagentDefaultApiConfigId,
			subagentApiConfigByRole: stateValues.subagentApiConfigByRole,
			alwaysAllowFollowupQuestions: stateValues.alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: stateValues.followupAutoApproveTimeoutMs ?? 60000,
			diagnosticsEnabled: stateValues.diagnosticsEnabled ?? true,
			allowedMaxRequests: stateValues.allowedMaxRequests,
			allowedMaxCost: stateValues.allowedMaxCost,
			autoCondenseContext: stateValues.autoCondenseContext ?? true,
			autoCondenseContextPercent: stateValues.autoCondenseContextPercent ?? 100,
			taskHistory: this.taskHistoryStore.getAll(),
			scheduledTasks: this.scheduledTaskService?.getState().tasks ?? [],
			scheduledTaskRuns: this.scheduledTaskService?.getState().runs ?? [],
			goalSeekJobs: this.goalSeekService?.getState().jobs ?? [],
			goalSeekRuns: this.goalSeekService?.getState().runs ?? [],
			goalSeekAttempts: this.goalSeekService?.getState().attempts ?? [],
			allowedCommands: this.mergeAllowedCommands(stateValues.allowedCommands),
			deniedCommands: this.mergeDeniedCommands(stateValues.deniedCommands),
			soundEnabled: stateValues.soundEnabled ?? false,
			ttsEnabled: stateValues.ttsEnabled ?? false,
			ttsSpeed: stateValues.ttsSpeed ?? 1.0,
			enableCheckpoints: stateValues.enableCheckpoints ?? true,
			checkpointTimeout: stateValues.checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			soundVolume: stateValues.soundVolume,
			writeDelayMs: stateValues.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			terminalShellIntegrationTimeout:
				stateValues.terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: stateValues.terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: stateValues.terminalCommandDelay ?? 0,
			terminalPowershellCounter: stateValues.terminalPowershellCounter ?? false,
			terminalZshClearEolMark: stateValues.terminalZshClearEolMark ?? true,
			terminalZshOhMy: stateValues.terminalZshOhMy ?? false,
			terminalZshP10k: stateValues.terminalZshP10k ?? false,
			terminalZdotdir: stateValues.terminalZdotdir ?? false,
			mode: stateValues.mode ?? defaultModeSlug,
			language: stateValues.language ?? formatLanguage(vscode.env.language),
			mcpEnabled: stateValues.mcpEnabled ?? true,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			currentApiConfigName: stateValues.currentApiConfigName ?? "default",
			listApiConfigMeta: stateValues.listApiConfigMeta ?? [],
			pinnedApiConfigs: stateValues.pinnedApiConfigs ?? {},
			modeApiConfigs: stateValues.modeApiConfigs ?? ({} as Record<Mode, string>),
			customModePrompts: stateValues.customModePrompts ?? {},
			customSupportPrompts: stateValues.customSupportPrompts ?? {},
			enhancementApiConfigId: stateValues.enhancementApiConfigId,
			experiments: stateValues.experiments ?? experimentDefault,
			autoApprovalEnabled: stateValues.autoApprovalEnabled ?? false,
			customModes,
			maxOpenTabsContext: stateValues.maxOpenTabsContext ?? 20,
			maxWorkspaceFiles: stateValues.maxWorkspaceFiles ?? 200,
			disabledTools: stateValues.disabledTools,
			telemetrySetting: stateValues.telemetrySetting || "unset",
			showRooIgnoredFiles: stateValues.showRooIgnoredFiles ?? false,
			enableSubfolderRules: stateValues.enableSubfolderRules ?? false,
			maxImageFileSize: stateValues.maxImageFileSize ?? 5,
			maxTotalImageSize: stateValues.maxTotalImageSize ?? 20,
			historyPreviewCollapsed: stateValues.historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: stateValues.reasoningBlockCollapsed ?? true,
			enterBehavior: stateValues.enterBehavior ?? "send",
			customCondensingPrompt: stateValues.customCondensingPrompt,
			codebaseIndexModels: stateValues.codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: stateValues.codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexVectorStoreProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexVectorStoreProvider ?? "lancedb",
				codebaseIndexLocalIndexPath:
					stateValues.codebaseIndexConfig?.codebaseIndexLocalIndexPath ?? ".alpha/code-index/lancedb",
				codebaseIndexQdrantUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
				codebaseIndexEmbedderBaseUrl: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension,
				codebaseIndexOpenAiCompatibleBaseUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: stateValues.codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: stateValues.codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexEmbeddingRateLimitEnabled:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbeddingRateLimitEnabled,
				codebaseIndexEmbeddingRateLimitSeconds:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbeddingRateLimitSeconds,
				codebaseIndexBedrockRegion: stateValues.codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: stateValues.codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexVertexProjectId: stateValues.codebaseIndexConfig?.codebaseIndexVertexProjectId,
				codebaseIndexVertexRegion: stateValues.codebaseIndexConfig?.codebaseIndexVertexRegion,
				codebaseIndexVertexKeyFile: stateValues.codebaseIndexConfig?.codebaseIndexVertexKeyFile,
				codebaseIndexVertexGatewayBaseUrl: stateValues.codebaseIndexConfig?.codebaseIndexVertexGatewayBaseUrl,
				codebaseIndexVertexGatewayCaBundlePath:
					stateValues.codebaseIndexConfig?.codebaseIndexVertexGatewayCaBundlePath,
				codebaseIndexVertexGatewayHelixCommand:
					stateValues.codebaseIndexConfig?.codebaseIndexVertexGatewayHelixCommand,
				codebaseIndexVertexGatewayTokenRefreshMinutes:
					stateValues.codebaseIndexConfig?.codebaseIndexVertexGatewayTokenRefreshMinutes,
				codebaseIndexVertexGatewayModelRoutingMap:
					stateValues.codebaseIndexConfig?.codebaseIndexVertexGatewayModelRoutingMap,
				codebaseIndexOpenRouterSpecificProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
			},
			profileThresholds: stateValues.profileThresholds ?? {},
			lockApiConfigAcrossModes: this.context.workspaceState.get("lockApiConfigAcrossModes", false),
			includeDiagnosticMessages: stateValues.includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: stateValues.maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: stateValues.includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: stateValues.includeCurrentTime ?? true,
			includeCurrentCost: stateValues.includeCurrentCost ?? true,
			maxGitStatusFiles: stateValues.maxGitStatusFiles ?? 0,
			imageGenerationProvider: stateValues.imageGenerationProvider,
			openRouterImageApiKey: stateValues.openRouterImageApiKey,
			githubToken: stateValues.githubToken,
			openRouterImageGenerationSelectedModel: stateValues.openRouterImageGenerationSelectedModel,
		}
	}

	/**
	 * Updates a task in the task history and optionally broadcasts the updated history to the webview.
	 * Now delegates to TaskHistoryStore for per-task file persistence.
	 *
	 * @param item The history item to update or add
	 * @param options.broadcast Whether to broadcast the updated history to the webview (default: true)
	 * @returns The updated task history array
	 */
	async updateTaskHistory(item: HistoryItem, options: { broadcast?: boolean } = {}): Promise<HistoryItem[]> {
		const { broadcast = true } = options

		const history = await this.taskHistoryStore.upsert(item)
		this.recentTasksCache = undefined

		// Broadcast the updated history to the webview if requested.
		// Prefer per-item updates to avoid repeatedly cloning/sending the full history.
		if (broadcast && this.isViewLaunched) {
			const updatedItem = this.taskHistoryStore.get(item.id) ?? item
			await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedItem })
		}

		return history
	}

	/**
	 * Schedule a debounced write-through of task history to globalState.
	 * Only used for backward compatibility during the transition period.
	 * Per-task files are authoritative; globalState is the downgrade fallback.
	 */
	private scheduleGlobalStateWriteThrough(): void {
		if (this.globalStateWriteThroughTimer) {
			clearTimeout(this.globalStateWriteThroughTimer)
		}

		this.globalStateWriteThroughTimer = setTimeout(async () => {
			this.globalStateWriteThroughTimer = null
			try {
				const items = this.taskHistoryStore.getAll()
				await this.updateGlobalState("taskHistory", items)
			} catch (err) {
				this.log(
					`[scheduleGlobalStateWriteThrough] Failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}, ClineProvider.GLOBAL_STATE_WRITE_THROUGH_DEBOUNCE_MS)
	}

	private getConfiguredMaxConcurrentTasks(): number {
		return normalizeMaxLiveTasks(this.contextProxy.getValue("maxConcurrentTasks"))
	}

	public setMaxConcurrentTasks(maxConcurrentTasks: number): void {
		this.taskSessions.setMaxLiveTasks(maxConcurrentTasks)
	}

	/**
	 * Flush any pending debounced globalState write-through immediately.
	 */
	private flushGlobalStateWriteThrough(): void {
		if (this.globalStateWriteThroughTimer) {
			clearTimeout(this.globalStateWriteThroughTimer)
			this.globalStateWriteThroughTimer = null
		}

		const items = this.taskHistoryStore.getAll()
		this.updateGlobalState("taskHistory", items).catch((err) => {
			this.log(`[flushGlobalStateWriteThrough] Failed: ${err instanceof Error ? err.message : String(err)}`)
		})
	}

	/**
	 * Broadcasts a task history update to the webview.
	 * This sends a lightweight message with just the task history, rather than the full state.
	 * @param history The task history to broadcast (if not provided, reads from the store)
	 */
	public async broadcastTaskHistoryUpdate(history?: HistoryItem[]): Promise<void> {
		if (!this.isViewLaunched) {
			return
		}

		const taskHistory = history ?? this.taskHistoryStore.getAll()

		// Sort and filter the history the same way as getStateToPostToWebview
		const sortedHistory = taskHistory
			.filter((item: HistoryItem) => item.ts && item.task)
			.sort((a: HistoryItem, b: HistoryItem) => b.ts - a.ts)

		await this.postMessageToWebview({
			type: "taskHistoryUpdated",
			taskHistory: sortedHistory,
		})
	}

	// ContextProxy

	// @deprecated - Use `ContextProxy#setValue` instead.
	private async updateGlobalState<K extends keyof GlobalState>(key: K, value: GlobalState[K]) {
		await this.contextProxy.setValue(key, value)
	}

	// @deprecated - Use `ContextProxy#getValue` instead.
	private getGlobalState<K extends keyof GlobalState>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public async setValue<K extends keyof RooCodeSettings>(key: K, value: RooCodeSettings[K]) {
		await this.contextProxy.setValue(key, value)
	}

	public getValue<K extends keyof RooCodeSettings>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public getValues() {
		return this.contextProxy.getValues()
	}

	public async setValues(values: RooCodeSettings) {
		await this.contextProxy.setValues(values)
	}

	// dev

	async resetState() {
		const answer = await vscode.window.showInformationMessage(
			t("common:confirmation.reset_state"),
			{ modal: true },
			t("common:answers.yes"),
		)

		if (answer !== t("common:answers.yes")) {
			return
		}

		await this.contextProxy.resetAllState()
		await this.providerSettingsManager.resetAllConfigs()
		await this.customModesManager.resetCustomModes()
		await this.removeClineFromStack()
		await this.postStateToWebview()
		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	// logging

	public log(message: string) {
		this.outputChannel.appendLine(message)
		console.log(message)
	}

	// getters

	public get workspaceTracker(): WorkspaceTracker | undefined {
		return this._workspaceTracker
	}

	get viewLaunched() {
		return this.isViewLaunched
	}

	get messages() {
		return this.getCurrentTask()?.clineMessages || []
	}

	public getMcpHub(): McpHub | undefined {
		return this.mcpHub
	}

	public getSkillsManager(): SkillsManager | undefined {
		return this.skillsManager
	}

	public setScheduledTaskService(service: ScheduledTaskService): void {
		this.scheduledTaskService = service
	}

	public getScheduledTaskService(): ScheduledTaskService | undefined {
		return this.scheduledTaskService
	}

	public setGoalSeekService(service: GoalSeekService): void {
		this.goalSeekService = service
	}

	public getGoalSeekService(): GoalSeekService | undefined {
		return this.goalSeekService
	}

	/**
	 * Gets the CodeIndexManager for the current active workspace
	 * @returns CodeIndexManager instance for the current workspace or the default one
	 */
	public getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined {
		return CodeIndexManager.getInstance(this.context)
	}

	/**
	 * Updates the code index status subscription to listen to the current workspace manager
	 */
	private updateCodeIndexStatusSubscription(): void {
		// Get the current workspace manager
		const currentManager = this.getCurrentWorkspaceCodeIndexManager()

		// If the manager hasn't changed, no need to update subscription
		if (currentManager === this.codeIndexManager) {
			return
		}

		// Dispose the old subscription if it exists
		if (this.codeIndexStatusSubscription) {
			this.codeIndexStatusSubscription.dispose()
			this.codeIndexStatusSubscription = undefined
		}

		// Update the current workspace manager reference
		this.codeIndexManager = currentManager

		// Subscribe to the new manager's progress updates if it exists
		if (currentManager) {
			this.codeIndexStatusSubscription = currentManager.onProgressUpdate((update: IndexProgressUpdate) => {
				// Only send updates if this manager is still the current one
				if (currentManager === this.getCurrentWorkspaceCodeIndexManager()) {
					// Get the full status from the manager to ensure we have all fields correctly formatted
					const fullStatus = currentManager.getCurrentStatus()
					this.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: fullStatus,
					})
				}
			})

			if (this.view) {
				this.webviewDisposables.push(this.codeIndexStatusSubscription)
			}

			// Send initial status for the current workspace
			this.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: currentManager.getCurrentStatus(),
			})
		}
	}

	/**
	 * TaskProviderLike, TelemetryPropertiesProvider
	 */

	private markTaskLifecycle(taskId: string, lifecycle: TaskLifecycleState, waitingReason?: string): void {
		this.taskSessions.markLifecycle(taskId, lifecycle, waitingReason)
		this.log(`[task-session] ${taskId}: ${lifecycle}${waitingReason ? ` (${waitingReason})` : ""}`)
		void this.postStateToWebviewWithoutTaskHistory()
	}

	private getIdleTaskLifecycle(task: Task): TaskLifecycleState {
		return task.taskAsk?.ask === "completion_result" || task.taskAsk?.ask === "resume_completed_task"
			? TaskLifecycleState.Completed
			: TaskLifecycleState.Waiting
	}

	public getCurrentTask(): Task | undefined {
		return this.getActiveTask()
	}

	public getActiveTask(): Task | undefined {
		return this.taskSessions.getActiveTask()
	}

	public getActiveTaskId(): string | undefined {
		return this.taskSessions.getActiveTaskId()
	}

	public getLiveTask(taskId: string | undefined): Task | undefined {
		return this.taskSessions.getTask(taskId)
	}

	public canAcceptTaskInput(taskId: string | undefined): boolean {
		return this.taskSessions.canAcceptInput(taskId)
	}

	public isTaskOnScreen(taskId: string): boolean {
		return this.currentView.type === "task" && this.currentView.taskId === taskId
	}

	public getTaskForMessage(message: Pick<WebviewMessage, "taskId">): Task | undefined {
		return this.getLiveTask(message.taskId)
	}

	public getLiveTaskIds(): string[] {
		return this.taskSessions.getLiveTaskIds()
	}

	public getLiveTaskMetadata(): Record<string, LiveTaskMetadata> {
		return this.taskSessions.getMetadata()
	}

	public async focusTask(taskId: string): Promise<boolean> {
		const previous = this.getActiveTask()
		const task = this.taskSessions.focus(taskId)

		if (!task) {
			return false
		}

		if (previous && previous.taskId !== task.taskId) {
			previous.emit(RooCodeEventName.TaskUnfocused)
		}

		this.currentView = { type: "task", taskId: task.taskId }
		task.emit(RooCodeEventName.TaskFocused)
		await this.postStateToWebview()
		return true
	}

	public async startBlankTask(): Promise<void> {
		const previous = this.getActiveTask()
		await this.postMessageToWebview({
			type: "action",
			action: "chatButtonClicked",
			values: { force: true },
		})
		this.taskSessions.clearFocus()
		this.currentView = { type: "newTaskDraft" }
		previous?.emit(RooCodeEventName.TaskUnfocused)
		await this.postStateToWebview()
		await this.postMessageToWebview({ type: "invoke", invoke: "newChat" })
	}

	public getRecentTasks(): string[] {
		if (this.recentTasksCache) {
			return this.recentTasksCache
		}

		const history = this.taskHistoryStore.getAll()
		const workspaceTasks: HistoryItem[] = []

		for (const item of history) {
			if (!item.ts || !item.task || item.workspace !== this.cwd) {
				continue
			}

			workspaceTasks.push(item)
		}

		if (workspaceTasks.length === 0) {
			this.recentTasksCache = []
			return this.recentTasksCache
		}

		workspaceTasks.sort((a, b) => b.ts - a.ts)
		let recentTaskIds: string[] = []

		if (workspaceTasks.length >= 100) {
			// If we have at least 100 tasks, return tasks from the last 7 days.
			const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

			for (const item of workspaceTasks) {
				// Stop when we hit tasks older than 7 days.
				if (item.ts < sevenDaysAgo) {
					break
				}

				recentTaskIds.push(item.id)
			}
		} else {
			// Otherwise, return the most recent 100 tasks (or all if less than 100).
			recentTaskIds = workspaceTasks.slice(0, Math.min(100, workspaceTasks.length)).map((item) => item.id)
		}

		this.recentTasksCache = recentTaskIds
		return this.recentTasksCache
	}

	// When initializing a new task, (not from history but from a tool command
	// new_task) there is no need to remove the previous task since the new
	// task is a subtask of the previous one, and when it finishes it is removed
	// from the stack and the caller is resumed in this way we can have a chain
	// of tasks, each one being a sub task of the previous one until the main
	// task is finished.
	public async createTask(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options: CreateTaskOptions = {},
		configuration: RooCodeSettings = {},
	): Promise<Task> {
		if (configuration) {
			const sanitizedConfiguration = {
				...configuration,
				...(configuration.allowedCommands !== undefined
					? { allowedCommands: this.normalizeCommandList(configuration.allowedCommands) }
					: {}),
				...(configuration.deniedCommands !== undefined
					? { deniedCommands: this.normalizeCommandList(configuration.deniedCommands) }
					: {}),
			}

			await this.setValues(sanitizedConfiguration)

			if (configuration.commandExecutionTimeout !== undefined) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update(
						"commandExecutionTimeout",
						configuration.commandExecutionTimeout,
						vscode.ConfigurationTarget.Global,
					)
			}

			if (configuration.currentApiConfigName) {
				await this.setProviderProfile(configuration.currentApiConfigName)
			}

			// Register custom modes so the CustomModesManager knows about them.
			// setValues writes to global state, but the manager overwrites that
			// when it merges .alphamodes + global settings on refresh.  Persisting
			// via updateCustomMode ensures modes survive the merge cycle.
			if (configuration.customModes?.length) {
				for (const mode of configuration.customModes) {
					await this.customModesManager.updateCustomMode(mode.slug, mode)
				}
			}
		}

		const {
			apiConfiguration: currentApiConfiguration,
			currentApiConfigName,
			enableCheckpoints,
			checkpointTimeout,
			experiments,
		} = await this.getState()
		const apiConfiguration = options.apiConfiguration ?? currentApiConfiguration
		const taskApiConfigName = options.taskApiConfigName ?? currentApiConfigName ?? "default"

		// Single-open-task invariant: always enforce for user-initiated top-level tasks
		if (!parentTask && !options.preserveExisting) {
			try {
				await this.removeClineFromStack()
			} catch {
				// Non-fatal
			}
		}

		if (!parentTask && options.preserveExisting && !this.taskSessions.canCreateTask()) {
			const configuredMaxLiveTasks = normalizeMaxLiveTasks(
				(this.contextProxy as { getValue?: (key: string) => unknown } | undefined)?.getValue?.(
					"maxConcurrentTasks",
				) ?? DEFAULT_MAX_CONCURRENT_TASKS,
			)
			const maxLiveTasks =
				typeof this.taskSessions.getMaxLiveTasks === "function"
					? this.taskSessions.getMaxLiveTasks()
					: configuredMaxLiveTasks
			const message = `Maximum live task limit reached (${maxLiveTasks}). Close a running task before starting another.`
			vscode.window.showErrorMessage(message)
			throw new Error(message)
		}

		const {
			background,
			apiConfiguration: _optionApiConfiguration,
			taskApiConfigName: _optionTaskApiConfigName,
			...taskOptions
		} = options
		const task = new Task({
			provider: this,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			task: text,
			images,
			experiments,
			rootTask: parentTask ? (parentTask.rootTask ?? parentTask) : undefined,
			parentTask,
			taskNumber: this.clineStack.length + 1,
			onCreated: this.taskCreationCallback,
			initialTodos: taskOptions.initialTodos,
			taskApiConfigName,
			// Ensure this task is present in clineStack before startTask() emits
			// its initial state update, so state.currentTaskId is available ASAP.
			startTask: false,
			...taskOptions,
		})

		await this.addClineToStack(task, { focus: !background })
		await this.postStateToWebviewWithoutTaskHistory()
		if (options.startTask !== false) {
			task.start()
		}

		this.log(
			`[createTask] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
		)

		return task
	}

	public async cancelTask(taskId?: string): Promise<void> {
		const task = this.getLiveTask(taskId) ?? this.getCurrentTask()

		if (!task) {
			return
		}

		console.log(`[cancelTask] cancelling task ${task.taskId}.${task.instanceId}`)

		let historyItem: HistoryItem | undefined
		try {
			const history = await this.getTaskWithId(task.taskId)
			historyItem = history.historyItem
		} catch (error) {
			// During task startup there is a short window where currentTask exists
			// but task history has not been persisted yet. Cancelling should still
			// abort safely; we just skip post-cancel rehydration in that case.
			if (error instanceof Error && error.message === "Task not found") {
				this.log(`[cancelTask] task history missing for ${task.taskId}; skipping rehydrate`)
			} else {
				throw error
			}
		}

		// Preserve parent and root task information for history item.
		const rootTask = task.rootTask
		const parentTask = task.parentTask

		// Mark this as a user-initiated cancellation so provider-only rehydration can occur
		task.abortReason = "user_cancelled"

		// Capture the current instance to detect if rehydrate already occurred elsewhere
		const originalInstanceId = task.instanceId

		// Immediately cancel the underlying HTTP request if one is in progress
		// This ensures the stream fails quickly rather than waiting for network timeout
		task.cancelCurrentRequest()

		// Begin abort (non-blocking)
		task.abortTask()

		// Immediately mark the original instance as abandoned to prevent any residual activity
		task.abandoned = true

		await pWaitFor(
			() =>
				this.getLiveTask(task.taskId) === undefined ||
				task.isStreaming === false ||
				task.didFinishAbortingStream ||
				// If only the first chunk is processed, then there's no
				// need to wait for graceful abort (closes edits, browser,
				// etc).
				task.isWaitingForFirstChunk,
			{
				timeout: 3_000,
			},
		).catch(() => {
			console.error("Failed to abort task")
		})

		// Defensive safeguard: if current instance already changed, skip rehydrate
		const current = this.getLiveTask(task.taskId)
		if (current && current.instanceId !== originalInstanceId) {
			this.log(
				`[cancelTask] Skipping rehydrate: current instance ${current.instanceId} != original ${originalInstanceId}`,
			)
			return
		}

		// Final race check before rehydrate to avoid duplicate rehydration
		{
			const currentAfterCheck = this.getLiveTask(task.taskId)
			if (currentAfterCheck && currentAfterCheck.instanceId !== originalInstanceId) {
				this.log(
					`[cancelTask] Skipping rehydrate after final check: current instance ${currentAfterCheck.instanceId} != original ${originalInstanceId}`,
				)
				return
			}
		}

		if (!historyItem) {
			return
		}

		// Clears task again, so we need to abortTask manually above.
		await this.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask }, { preserveExisting: true })
	}

	public async closeTask(taskId?: string): Promise<void> {
		const task = this.getLiveTask(taskId) ?? this.getCurrentTask()
		if (!task) {
			return
		}
		if (task.taskKind === "subagent" && task.parentTaskId) {
			await this.showTaskWithId(task.parentTaskId)
			return
		}

		await this.removeClineFromStack({ taskId: task.taskId })
		await this.postStateToWebview()
	}

	// Clear the current task without treating it as a subtask.
	// This is used when the user cancels a task that is not a subtask.
	public async clearTask(): Promise<void> {
		const task = this.getCurrentTask()
		if (task) {
			console.log(`[clearTask] clearing task ${task.taskId}.${task.instanceId}`)
			await this.removeClineFromStack()
		}
	}

	public resumeTask(taskId: string): void {
		// Use the existing showTaskWithId method which handles both current and
		// historical tasks.
		this.showTaskWithId(taskId).catch((error) => {
			this.log(`Failed to resume task ${taskId}: ${error.message}`)
		})
	}

	// Modes

	public async getModes(): Promise<{ slug: string; name: string }[]> {
		try {
			const customModes = await this.customModesManager.getCustomModes()
			return [...DEFAULT_MODES, ...customModes].map(({ slug, name }) => ({ slug, name }))
		} catch (error) {
			return DEFAULT_MODES.map(({ slug, name }) => ({ slug, name }))
		}
	}

	public async getMode(): Promise<string> {
		const { mode } = await this.getState()
		return mode
	}

	public async setMode(mode: string): Promise<void> {
		await this.setValues({ mode })
	}

	// Provider Profiles

	public async getProviderProfiles(): Promise<{ name: string; provider?: string }[]> {
		const { listApiConfigMeta = [] } = await this.getState()
		return listApiConfigMeta.map((profile) => ({ name: profile.name, provider: profile.apiProvider }))
	}

	public async getProviderProfile(): Promise<string> {
		const { currentApiConfigName = "default" } = await this.getState()
		return currentApiConfigName
	}

	public async setProviderProfile(name: string): Promise<void> {
		await this.activateProviderProfile({ name })
	}

	// Telemetry

	private _appProperties?: StaticAppProperties
	private _gitProperties?: GitProperties

	private getAppProperties(): StaticAppProperties {
		if (!this._appProperties) {
			const packageJSON = this.context.extension?.packageJSON

			this._appProperties = {
				appName: packageJSON?.name ?? Package.name,
				appVersion: packageJSON?.version ?? Package.version,
				vscodeVersion: vscode.version,
				platform: process.platform,
				editorName: vscode.env.appName,
			}
		}

		return this._appProperties
	}

	public get appProperties(): StaticAppProperties {
		return this._appProperties ?? this.getAppProperties()
	}

	private async getTaskProperties(): Promise<DynamicAppProperties & TaskProperties> {
		const {
			language = "en",
			mode: foregroundMode,
			apiConfiguration: foregroundApiConfiguration,
		} = await this.getState()

		const task = this.getCurrentTask()
		const todoList = task?.todoList
		let todos: { total: number; completed: number; inProgress: number; pending: number } | undefined

		if (todoList && todoList.length > 0) {
			todos = {
				total: todoList.length,
				completed: todoList.filter((todo) => todo.status === "completed").length,
				inProgress: todoList.filter((todo) => todo.status === "in_progress").length,
				pending: todoList.filter((todo) => todo.status === "pending").length,
			}
		}

		const taskMode = task ? await task.getTaskMode() : foregroundMode
		const apiConfiguration = task?.apiConfiguration ?? foregroundApiConfiguration
		const apiProvider = apiConfiguration?.apiProvider

		return {
			language,
			mode: taskMode,
			taskId: task?.taskId,
			parentTaskId: task?.parentTaskId,
			apiProvider: apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
			modelId: task?.api?.getModel().id,
			diffStrategy: task?.diffStrategy?.getName(),
			isSubtask: task ? !!task.parentTaskId : undefined,
			...(todos && { todos }),
		}
	}

	private async getGitProperties(): Promise<GitProperties> {
		if (!this._gitProperties) {
			this._gitProperties = await getWorkspaceGitInfo()
		}

		return this._gitProperties
	}

	public get gitProperties(): GitProperties | undefined {
		return this._gitProperties
	}

	public async getTelemetryProperties(): Promise<TelemetryProperties> {
		return {
			...this.getAppProperties(),
			...(await this.getTaskProperties()),
			...(await this.getGitProperties()),
		}
	}

	public get cwd() {
		return this.currentWorkspacePath || getWorkspacePath()
	}

	public async runWorkspaceMutation<T>(task: Task, label: string, run: () => Promise<T>): Promise<T> {
		return this.workspaceMutationGate.run(task.taskId, label, run, () => task.abort)
	}

	public async prepareSubagentGroup(
		parent: Task,
		drafts: unknown,
		toolCallId?: string,
	): Promise<PreparedSubagentGroup> {
		if (parent.taskKind === "subagent") {
			throw new Error("A sub-agent cannot delegate another sub-agent")
		}
		if ((await parent.getTaskMode()) !== "code") {
			throw new Error("delegate_task is available only in Code mode")
		}
		const normalizedDrafts = normalizeSubagentTaskDrafts(drafts)
		assertSubagentTaskAuthorities(normalizedDrafts)

		// A prepared child consumes capacity until TaskSessionRegistry knows about it.
		// Once the child is registered, getAvailableTaskCapacity() already accounts
		// for that live task, so continuing to count its reservation would charge the
		// same child twice and prevent sequential spawn_agent calls from filling the
		// configured child slots.
		const reservedCount = Array.from(this.reservedSubagentSlots.entries()).reduce((sum, [groupId, count]) => {
			const reservedGroup = this.preparedSubagentGroups.get(groupId)
			if (!reservedGroup) return sum + count

			const unregisteredChildren = reservedGroup.envelopes.filter(
				(envelope) => !this.taskSessions.getTask(envelope.id),
			).length
			return sum + Math.min(count, unregisteredChildren)
		}, 0)
		const availableCapacity = Math.max(0, this.taskSessions.getAvailableTaskCapacity() - reservedCount)
		if (normalizedDrafts.length > availableCapacity) {
			throw new Error(
				`Not enough task capacity for ${normalizedDrafts.length} sub-agent${normalizedDrafts.length === 1 ? "" : "s"}. ` +
					`Available slots: ${availableCapacity}; configured maximum: ${this.taskSessions.getMaxLiveTasks()}.`,
			)
		}
		if (normalizedDrafts.filter((draft) => draft.agent_kind === "worker").length > 1) {
			throw new Error("A delegation batch can contain at most one worker")
		}
		const validatedScopes = await Promise.all(
			normalizedDrafts.map((draft) =>
				draft.agent_kind === "worker"
					? managedSubagentWorktreeService.validateScope(parent.cwd, draft.write_scope)
					: Promise.resolve(undefined),
			),
		)

		const reservedNames = this.taskHistoryStore
			.getAll()
			.map((item) => item.subagentNickname)
			.filter((name): name is string => Boolean(name))
		for (const descriptor of this.subagentDescriptors.values()) reservedNames.push(descriptor.nickname)
		const nicknames = this.subagentNicknameRegistry.assign(normalizedDrafts.length, reservedNames)
		const groupId = crypto.randomUUID()
		const createdAt = Date.now()
		const parentApiConfigName = await parent.getTaskApiConfigName()
		const settings = this.contextProxy.getValues()
		const { subagentDefaultApiConfigId, subagentApiConfigByRole } = settings
		const routes = await Promise.all(
			normalizedDrafts.map((draft) =>
				resolveSubagentModelRoute({
					role: draft.agent_kind,
					parentApiConfiguration: parent.apiConfiguration,
					parentApiConfigName,
					defaultProfileId: subagentDefaultApiConfigId,
					profileByRole: subagentApiConfigByRole,
					profileLoader: this.providerSettingsManager,
				}),
			),
		)

		const envelopes = normalizedDrafts.map((draft, index) => {
			const id = crypto.randomUUID()
			const modelRoute = routes[index]
			const envelope = buildInternalTaskEnvelope({
				id,
				parentTaskId: parent.taskId,
				objective: draft.objective,
				agentKind: draft.agent_kind,
				expectedOutput: draft.expected_output,
				parentPolicy: {
					read: true,
					execute: draft.agent_kind === "worker",
					mutate: draft.agent_kind === "worker",
					delegate: false,
					network: false,
					externalSideEffects: false,
					requireApproval: false,
				},
				requestedPolicy: {
					read: true,
					execute: draft.agent_kind === "worker",
					mutate: draft.agent_kind === "worker",
					delegate: false,
					network: false,
					externalSideEffects: false,
					requireApproval: false,
				},
				workspaceRoots: [parent.cwd],
				allowedPaths: draft.agent_kind === "worker" ? draft.write_scope : undefined,
				sharedWorkspace: draft.agent_kind !== "worker",
				modelRouteId: "user-configured",
				modelOverride: {
					provider: modelRoute.route.provider,
					model: modelRoute.route.modelId,
				},
				budget: {
					maxDepth: 0,
					maxConcurrency: 1,
					timeoutMs: draft.agent_kind === "worker" ? SUBAGENT_WORKER_TIMEOUT_MS : 120_000,
				},
			})

			this.subagentDescriptors.set(id, {
				parent,
				groupId,
				nickname: nicknames[index],
				role: draft.agent_kind,
				modelRoute,
				writeScope: draft.agent_kind === "worker" ? [...draft.write_scope] : undefined,
				validatedScope: validatedScopes[index],
				approvalProvenance:
					settings.autoApprovalEnabled === true &&
					settings.alwaysAllowSubagents === true &&
					settings.alwaysAllowReadOnly === true &&
					(draft.agent_kind !== "worker" || settings.alwaysAllowWrite === true)
						? "auto"
						: "group",
			})
			return envelope
		})

		const group: SubagentGroupState = {
			groupId,
			parentTaskId: parent.taskId,
			toolCallId,
			status: "pending",
			createdAt,
			agents: envelopes.map((envelope, index) => ({
				taskId: envelope.id,
				nickname: nicknames[index],
				role: normalizedDrafts[index].agent_kind,
				objective: normalizedDrafts[index].objective,
				writeScope:
					normalizedDrafts[index].agent_kind === "worker"
						? [...normalizedDrafts[index].write_scope]
						: undefined,
				status: "pending",
				phase: "queued",
				phaseStartedAt: createdAt,
				modelRoute: structuredClone(routes[index].route),
				usage: { durationMs: 0 },
			})),
		}
		const prepared = { group, envelopes }
		this.preparedSubagentGroups.set(groupId, prepared)
		this.reservedSubagentSlots.set(groupId, envelopes.length)
		await parent.upsertSubagentGroup(group)
		return prepared
	}

	public async cancelPreparedSubagentGroup(
		parent: Task,
		prepared: PreparedSubagentGroup,
		reason: string,
	): Promise<void> {
		if (!["pending", "running", "cancelling"].includes(prepared.group.status)) return

		const completedAt = Date.now()
		prepared.group.status = "cancelled"
		prepared.group.completedAt = completedAt
		for (const agent of prepared.group.agents) {
			if (!["pending", "running", "cancelling"].includes(agent.status)) continue
			agent.status = "cancelled"
			delete agent.phase
			delete agent.phaseStartedAt
			agent.error = reason
			agent.completedAt = completedAt
			agent.usage.durationMs = Math.max(0, completedAt - (agent.startedAt ?? prepared.group.createdAt))
		}
		await parent.upsertSubagentGroup(prepared.group)
		this.releaseSubagentGroup(prepared.group.groupId)
	}

	public async launchPreparedSubagentGroup(
		parent: Task,
		prepared: PreparedSubagentGroup,
		parentSignal: AbortSignal,
	): Promise<SubagentSpawnHandle> {
		if (this.preparedSubagentGroups.get(prepared.group.groupId) !== prepared) {
			throw new Error("The prepared sub-agent spawn is no longer available")
		}
		if (prepared.group.parentTaskId !== parent.taskId) {
			throw new Error("The prepared sub-agent spawn belongs to a different parent task")
		}
		if (prepared.envelopes.length !== 1 || prepared.group.agents.length !== 1) {
			throw new Error("spawn_agent requires exactly one prepared child")
		}

		const envelope = prepared.envelopes[0]
		const agent = prepared.group.agents[0]
		const controller = new AbortController()
		const cancelFromParent = () => controller.abort(parentSignal.reason)
		if (parentSignal.aborted) cancelFromParent()
		else parentSignal.addEventListener("abort", cancelFromParent, { once: true })
		this.subagentGroupControllers.set(prepared.group.groupId, controller)

		let lifecycleWrites = Promise.resolve()
		const unsubscribe = this.asyncSubagentRunManager.subscribe((event) => {
			if (event.groupId !== prepared.group.groupId || event.taskId !== envelope.id) return
			lifecycleWrites = lifecycleWrites
				.then(() => this.publishSpawnedSubagentLifecycle(parent, prepared, event))
				.catch((error) => this.log(`Failed to publish sub-agent ${event.taskId} lifecycle: ${String(error)}`))
		})

		try {
			await this.attachSubagentGroupToParentHistory(parent, prepared)
			const handle = this.asyncSubagentRunManager.launch(
				envelope,
				{
					groupId: prepared.group.groupId,
					nickname: agent.nickname,
					role: agent.role,
					initialSnapshot: {
						writeScope: agent.writeScope,
						phase: agent.phase,
						phaseStartedAt: agent.phaseStartedAt,
						modelRoute: agent.modelRoute,
					},
				},
				controller.signal,
			)
			// Lifecycle callbacks are queued from launch(), so set the mode before
			// their first persistence write. Failed launches remain unmarked and are
			// reported through the spawn_agent tool result instead.
			prepared.group.executionMode = "async"
			const completion = this.asyncSubagentRunManager.waitForResult(handle.taskId)
			if (!completion) throw new Error(`Missing asynchronous result channel for ${handle.taskId}`)

			void this.finalizeSpawnedSubagent(
				parent,
				prepared,
				handle,
				completion,
				() => lifecycleWrites,
				unsubscribe,
				() => parentSignal.removeEventListener("abort", cancelFromParent),
			).catch((error) => this.log(`Failed to finalize spawned sub-agent ${handle.taskId}: ${String(error)}`))
			return handle
		} catch (error) {
			unsubscribe()
			parentSignal.removeEventListener("abort", cancelFromParent)
			if (!controller.signal.aborted) controller.abort(error)
			this.asyncSubagentRunManager.cancel(envelope.id, error as Error)
			this.subagentGroupControllers.delete(prepared.group.groupId)
			throw error
		}
	}

	private async publishSpawnedSubagentLifecycle(
		parent: Task,
		prepared: PreparedSubagentGroup,
		event: SubagentLifecycleEvent,
	): Promise<void> {
		if (event.type === "completed") return
		const agent = prepared.group.agents.find((item) => item.taskId === event.taskId)
		if (!agent) return

		agent.status = event.snapshot.status
		agent.phase = event.snapshot.phase
		agent.phaseStartedAt = event.snapshot.phaseStartedAt
		agent.startedAt = event.snapshot.startedAt
		agent.cancelRequestedAt = event.snapshot.cancelRequestedAt
		agent.usage = structuredClone(event.snapshot.usage)
		if (event.snapshot.status === "running") {
			prepared.group.status = "running"
			prepared.group.startedAt ??= event.snapshot.startedAt ?? event.occurredAt
		} else if (event.snapshot.status === "cancelling") {
			prepared.group.status = "cancelling"
		}
		await parent.upsertSubagentGroup(prepared.group)
	}

	private async finalizeSpawnedSubagent(
		parent: Task,
		prepared: PreparedSubagentGroup,
		handle: SubagentSpawnHandle,
		completion: Promise<InternalTaskResult>,
		getLifecycleWrites: () => Promise<void>,
		unsubscribe: () => void,
		detachParentSignal: () => void,
	): Promise<void> {
		try {
			const result = await completion
			await getLifecycleWrites()
			try {
				await this.applySubagentResult(prepared, result)
			} catch (error) {
				this.log(`Failed to publish spawned sub-agent ${result.taskId} result: ${String(error)}`)
			}

			prepared.group.status =
				result.status === "completed"
					? "completed"
					: result.status === "cancelled" || result.status === "denied"
						? "cancelled"
						: result.status === "timed_out"
							? "timed_out"
							: "failed"
			prepared.group.completedAt = Date.now()
			try {
				await parent.upsertSubagentGroup(prepared.group)
			} catch (error) {
				this.log(`Failed to publish terminal sub-agent group ${prepared.group.groupId}: ${String(error)}`)
			}
		} finally {
			await getLifecycleWrites()
			unsubscribe()
			detachParentSignal()
			this.asyncSubagentRunManager.forget(handle.taskId)
			this.releaseSubagentGroup(prepared.group.groupId)
		}
	}

	public async cancelSubagentGroup(parentTaskId: string, groupId: string): Promise<void> {
		const prepared = this.preparedSubagentGroups.get(groupId)
		if (!prepared || prepared.group.parentTaskId !== parentTaskId) return

		const controller = this.subagentGroupControllers.get(groupId)
		if (controller) {
			const cancelRequestedAt = Date.now()
			prepared.group.status = "cancelling"
			for (const agent of prepared.group.agents) {
				if (!["pending", "running"].includes(agent.status)) continue
				agent.status = "cancelling"
				agent.cancelRequestedAt = cancelRequestedAt
				delete agent.pendingApproval
			}
			const parent =
				this.getLiveTask(parentTaskId) ??
				[...this.subagentDescriptors.values()].find((descriptor) => descriptor.groupId === groupId)?.parent
			controller.abort(new Error("Sub-agent group cancelled by user"))
			if (parent) await parent.upsertSubagentGroup(prepared.group)
			return
		}

		const parent = this.getLiveTask(parentTaskId)
		if (parent) {
			parent.denyAsk()
			await this.cancelPreparedSubagentGroup(parent, prepared, "Cancelled by user before launch.")
		}
	}

	public async steerSubagent(parentTaskId: string, groupId: string, taskId: string, text: string): Promise<void> {
		const prepared = this.preparedSubagentGroups.get(groupId)
		const agent = prepared?.group.agents.find((item) => item.taskId === taskId)
		const child = this.getLiveTask(taskId)
		const instruction = text.trim()
		if (
			!prepared ||
			prepared.group.parentTaskId !== parentTaskId ||
			!agent ||
			agent.status !== "running" ||
			!child ||
			child.parentTaskId !== parentTaskId ||
			child.subagentGroupId !== groupId
		) {
			void vscode.window.showWarningMessage("This sub-agent is no longer available to steer.")
			return
		}
		if (!instruction || instruction.length > 2_000) {
			void vscode.window.showWarningMessage(
				"Sub-agent steering instructions must be between 1 and 2,000 characters.",
			)
			return
		}
		if (agent.pendingApproval) {
			void vscode.window.showWarningMessage("Resolve the sub-agent approval request before steering it.")
			return
		}
		if (!child.canAcceptSteerMessage()) {
			void vscode.window.showWarningMessage(
				"This sub-agent already has a steering instruction waiting to be applied.",
			)
			return
		}

		const steeredAt = Date.now()
		agent.phase = "steering"
		agent.phaseStartedAt = steeredAt
		agent.steerCount = (agent.steerCount ?? 0) + 1
		agent.lastSteeredAt = steeredAt
		await child.steerUserMessage(instruction)
		await this.subagentDescriptors.get(taskId)?.parent.upsertSubagentGroup(prepared.group)
	}

	public async cancelSubagent(parentTaskId: string, groupId: string, taskId: string): Promise<void> {
		const prepared = this.preparedSubagentGroups.get(groupId)
		const agent = prepared?.group.agents.find((item) => item.taskId === taskId)
		if (
			!prepared ||
			prepared.group.parentTaskId !== parentTaskId ||
			!agent ||
			!["pending", "running", "cancelling"].includes(agent.status)
		) {
			return
		}
		if (agent.status === "cancelling") return

		agent.status = "cancelling"
		agent.cancelRequestedAt = Date.now()
		delete agent.pendingApproval
		const reason = new Error("Sub-agent cancelled by user")
		if (!this.asyncSubagentRunManager.cancel(taskId, reason)) {
			this.boundedDelegationManager.cancel(taskId, reason)
		}
		await this.subagentDescriptors.get(taskId)?.parent.upsertSubagentGroup(prepared.group)
	}

	public async runSubagentGroup(
		parent: Task,
		prepared: PreparedSubagentGroup,
		parentSignal: AbortSignal,
	): Promise<SubagentToolResult> {
		const controller = new AbortController()
		const cancelFromParent = () => controller.abort(parentSignal.reason)
		if (parentSignal.aborted) cancelFromParent()
		else parentSignal.addEventListener("abort", cancelFromParent, { once: true })
		this.subagentGroupControllers.set(prepared.group.groupId, controller)

		const startedAt = Date.now()
		prepared.group.executionMode = "blocking"
		prepared.group.status = "running"
		prepared.group.startedAt = startedAt
		for (const agent of prepared.group.agents) {
			agent.status = "running"
			agent.startedAt = startedAt
			agent.phase = "starting"
			agent.phaseStartedAt = startedAt
		}

		let resultsPromise: Promise<InternalTaskResult[]> | undefined
		try {
			// Register every child with the bounded manager before publishing the
			// running state. Otherwise an immediate row-level cancel can arrive in
			// the narrow window where the UI says running but cancel(taskId) cannot
			// find the child yet.
			resultsPromise = this.boundedDelegationManager.runBatch(prepared.envelopes, controller.signal)
			await parent.upsertSubagentGroup(prepared.group)
			await this.attachSubagentGroupToParentHistory(parent, prepared)
			const results = await resultsPromise
			for (const result of results) {
				try {
					await this.applySubagentResult(prepared, result)
				} catch (error) {
					// A child result is a computational outcome, not a persistence outcome.
					// Preserve it even when the live parent card cannot be updated yet; the
					// aggregate terminal write below is a final best-effort reconciliation.
					this.log(`Failed to publish sub-agent ${result.taskId} result: ${String(error)}`)
				}
			}

			const completed = results.filter((result) => result.status === "completed").length
			const statuses = new Set(results.map((result) => result.status))
			const status: SubagentToolResult["status"] =
				completed === results.length
					? "completed"
					: completed > 0
						? "partial"
						: statuses.size === 1 && statuses.has("cancelled")
							? "cancelled"
							: statuses.size === 1 && statuses.has("timed_out")
								? "timed_out"
								: "failed"

			prepared.group.status = status
			prepared.group.completedAt = Date.now()
			try {
				await parent.upsertSubagentGroup(prepared.group)
			} catch (error) {
				this.log(`Failed to publish terminal sub-agent group ${prepared.group.groupId}: ${String(error)}`)
			}

			return {
				groupId: prepared.group.groupId,
				status,
				agents: prepared.group.agents.map(
					({
						taskId,
						nickname,
						role,
						status,
						summary,
						error,
						usage,
						changedFiles,
						verification,
						changeSet,
					}) => ({
						taskId,
						nickname,
						role,
						status,
						summary,
						error,
						usage,
						changedFiles,
						verification,
						changeSet,
					}),
				),
			}
		} catch (error) {
			// Capture external cancellation before aborting the controller for internal
			// cleanup. Otherwise every unexpected launch or persistence error looks like
			// a user cancellation after controller.abort(error) runs.
			const wasCancelled = controller.signal.aborted || parentSignal.aborted
			const agentsToFinalize = new Set(
				prepared.group.agents
					.filter((agent) => ["pending", "running", "cancelling"].includes(agent.status))
					.map((agent) => agent.taskId),
			)
			if (!controller.signal.aborted) controller.abort(error)
			await resultsPromise?.catch(() => undefined)
			const completedAt = Date.now()
			const message = wasCancelled
				? "Sub-agent group was cancelled."
				: error instanceof Error
					? error.message
					: String(error)
			for (const agent of prepared.group.agents) {
				if (!agentsToFinalize.has(agent.taskId)) continue
				agent.status = wasCancelled ? "cancelled" : "failed"
				delete agent.phase
				delete agent.phaseStartedAt
				agent.error = message
				agent.completedAt = completedAt
				agent.usage.durationMs = Math.max(
					0,
					completedAt - (agent.startedAt ?? prepared.group.startedAt ?? prepared.group.createdAt),
				)
			}
			const completed = prepared.group.agents.filter((agent) => agent.status === "completed").length
			const status: SubagentToolResult["status"] =
				completed > 0 ? "partial" : wasCancelled ? "cancelled" : "failed"
			prepared.group.status = status
			prepared.group.completedAt = completedAt
			try {
				await parent.upsertSubagentGroup(prepared.group)
			} catch (persistenceError) {
				this.log(
					`Failed to publish failed sub-agent group ${prepared.group.groupId}: ${String(persistenceError)}`,
				)
			}

			return {
				groupId: prepared.group.groupId,
				status,
				agents: prepared.group.agents.map(
					({
						taskId,
						nickname,
						role,
						status,
						summary,
						error,
						usage,
						changedFiles,
						verification,
						changeSet,
					}) => ({
						taskId,
						nickname,
						role,
						status,
						summary,
						error,
						usage,
						changedFiles,
						verification,
						changeSet,
					}),
				),
			}
		} finally {
			parentSignal.removeEventListener("abort", cancelFromParent)
			this.releaseSubagentGroup(prepared.group.groupId)
		}
	}

	private async attachSubagentGroupToParentHistory(parent: Task, prepared: PreparedSubagentGroup): Promise<void> {
		try {
			const { historyItem } = await this.getTaskWithId(parent.taskId)
			await this.updateTaskHistory({
				...historyItem,
				childIds: Array.from(
					new Set([...(historyItem.childIds ?? []), ...prepared.envelopes.map((envelope) => envelope.id)]),
				),
			})
		} catch (error) {
			this.log(`Failed to attach sub-agent group ${prepared.group.groupId} to parent history: ${String(error)}`)
		}
	}

	private async runSubagentEnvelope(
		envelope: InternalTaskEnvelope,
		signal: AbortSignal,
	): Promise<Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">> {
		const descriptor = this.subagentDescriptors.get(envelope.id)
		if (!descriptor) throw new Error(`Missing sub-agent descriptor for ${envelope.id}`)

		const { parent, groupId, nickname, role, modelRoute } = descriptor
		const startedAt =
			this.preparedSubagentGroups.get(groupId)?.group.agents.find((agent) => agent.taskId === envelope.id)
				?.startedAt ?? Date.now()
		if (role === "worker") {
			if (!descriptor.validatedScope) throw new Error("Worker scope preflight was not prepared")
			descriptor.managedWorktree = await managedSubagentWorktreeService.create(
				this.context.globalStorageUri.fsPath,
				envelope.id,
				descriptor.validatedScope,
			)
		}
		const prompt = buildSubagentPrompt({
			nickname,
			role,
			objective: envelope.objective,
			expectedOutput: envelope.expectedOutput,
			writeScope: descriptor.writeScope,
		})

		let child: Task
		try {
			child = await this.createTask(prompt, undefined, parent, {
				taskId: envelope.id,
				background: true,
				preserveExisting: true,
				startTask: false,
				initialStatus: "active",
				taskMode: "code",
				taskApiConfigName: modelRoute.apiConfigName,
				apiConfiguration: structuredClone(modelRoute.apiConfiguration),
				enableCheckpoints: false,
				workspacePath: descriptor.managedWorktree?.workspacePath,
				historyWorkspacePath: parent.historyWorkspacePath,
				subagentPrivateWorkspaceRoot: descriptor.managedWorktree?.artifact.worktreePath,
				taskKind: "subagent",
				subagentGroupId: groupId,
				subagentNickname: nickname,
				subagentRole: role,
				subagentModelRoute: structuredClone(modelRoute.route),
				subagentWriteScope: descriptor.writeScope,
				subagentAuthority:
					role === "worker"
						? {
								role,
								logicalWorkspace: parent.historyWorkspacePath,
								writeScope: descriptor.writeScope ?? [],
								fileWriteScope: descriptor.validatedScope?.fileWriteScope,
								approvalProvenance: descriptor.approvalProvenance,
							}
						: {
								role,
								logicalWorkspace: parent.historyWorkspacePath,
								approvalProvenance: descriptor.approvalProvenance,
							},
				subagentResearchDeadlineAt: role === "worker" ? undefined : Date.now() + SUBAGENT_RESEARCH_WINDOW_MS,
			})
		} catch (error) {
			if (descriptor.managedWorktree) {
				await managedSubagentWorktreeService
					.capture(this.context.globalStorageUri.fsPath, descriptor.managedWorktree.artifact.id, true)
					.catch((captureError) =>
						this.log(`Failed to capture worker startup error: ${String(captureError)}`),
					)
			}
			throw error
		}

		let result = await new Promise<Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">>(
			(resolve) => {
				let settled = false
				const onMessage = ({ message }: { message: ClineMessage }) => {
					const phase = this.getSubagentPhaseForMessage(message)
					if (!phase) return
					void this.updateSubagentPhase(groupId, child.taskId, phase).catch((error) =>
						this.log(`Failed to update sub-agent ${child.taskId} phase: ${String(error)}`),
					)
				}
				const finish = (
					status: "completed" | "blocked" | "failed" | "cancelled" | "timed_out",
					tokenUsage = child.getTokenUsage(),
				) => {
					if (settled) return
					settled = true
					child.off(RooCodeEventName.TaskCompleted, onCompleted)
					child.off(RooCodeEventName.TaskAborted, onAborted)
					child.off(RooCodeEventName.Message, onMessage)
					signal.removeEventListener("abort", onCancelled)

					const inspectedPaths = this.getSubagentInspectedPaths(child)
					const summary =
						findLast(child.clineMessages, (message) => message.say === "completion_result")?.text ??
						this.describeIncompleteSubagent(status, inspectedPaths)

					resolve({
						taskId: child.taskId,
						status,
						summary,
						evidence: inspectedPaths.map((reference) => ({ kind: "file", reference })),
						changedFiles: [],
						verification: [],
						remainingRisks: status === "completed" ? [] : [summary],
						usage: {
							inputTokens: tokenUsage.totalTokensIn,
							outputTokens: tokenUsage.totalTokensOut,
							durationMs: 0,
						},
					})
				}

				const onCompleted = (_taskId: string, tokenUsage: TokenUsage) =>
					void finish(child.subagentCompletionOutcome === "blocked" ? "blocked" : "completed", tokenUsage)
				const onAborted = () => {
					if (signal.aborted) return
					const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "")
					finish(reason.includes("timed out") ? "timed_out" : "failed")
				}
				const onCancelled = () => {
					const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "")
					const status = reason.includes("timed out") ? "timed_out" : "cancelled"
					child.abortReason = "user_cancelled"
					child.cancelCurrentRequest()
					void child.abortTask().then(
						() => finish(status),
						() => finish(status),
					)
				}

				child.once(RooCodeEventName.TaskCompleted, onCompleted)
				child.once(RooCodeEventName.TaskAborted, onAborted)
				child.on(RooCodeEventName.Message, onMessage)
				if (signal.aborted) {
					onCancelled()
				} else {
					signal.addEventListener("abort", onCancelled, { once: true })
					child.start()
				}
			},
		)

		if (role === "worker" && descriptor.managedWorktree) {
			const artifact = await managedSubagentWorktreeService.capture(
				this.context.globalStorageUri.fsPath,
				descriptor.managedWorktree.artifact.id,
				result.status !== "completed",
			)
			const changedFiles = this.getLogicalWorkerChangedFiles(artifact)
			const changeSet = this.toSubagentChangeSetState(artifact, changedFiles)
			const verification = this.getWorkerCommandResults(child)
			const displayVerification = this.getWorkerVerification(verification)
			const completionError = getWorkerCompletionError(result.status, changedFiles)
			if (artifact.status === "scope_violation") {
				result = {
					...result,
					status: "failed",
					summary: artifact.error ?? "Worker changed files outside its approved write scope.",
					changedFiles: [],
					verification,
					displayVerification,
					remainingRisks: [artifact.error ?? "Worker scope violation"],
					changeSet,
				}
			} else if (completionError) {
				result = {
					...result,
					status: "failed",
					summary: `${completionError}\n\nWorker report: ${result.summary}`,
					changedFiles,
					verification,
					displayVerification,
					remainingRisks: [completionError],
					changeSet,
				}
			} else {
				result = {
					...result,
					changedFiles,
					verification,
					displayVerification,
					changeSet,
				}
			}
			child.setSubagentChangeSet(changeSet)
		}

		try {
			await child.finalizeSubagentHistory(
				result.status === "denied" ? "cancelled" : result.status,
				result.summary,
			)
		} catch (error) {
			this.log(`Failed to finalize sub-agent ${child.taskId} history: ${String(error)}`)
		}

		// Worker capture removes the managed worktree, and history finalization can
		// perform additional asynchronous persistence. Record duration only after
		// both have finished so the parent sees the complete child lifecycle cost.
		result = {
			...result,
			usage: {
				...result.usage,
				durationMs: Math.max(0, Date.now() - startedAt),
			},
		}
		try {
			await this.applySubagentResult(this.preparedSubagentGroups.get(groupId), result)
		} catch (error) {
			// The group runner retries an unacknowledged terminal publication. Do not
			// turn a successful child into a failed child because its first UI/history
			// update encountered a transient persistence error.
			this.log(`Failed to publish sub-agent ${child.taskId} result: ${String(error)}`)
		}
		return result
	}

	private async recoverManagedWorkerArtifacts(): Promise<void> {
		const recovered = await managedSubagentWorktreeService.recoverOrphans(this.context.globalStorageUri.fsPath)
		for (const artifact of recovered) {
			const childHistory = this.taskHistoryStore.get(artifact.taskId)
			if (!childHistory?.parentTaskId) continue
			const changedFiles = this.getLogicalWorkerChangedFiles(artifact)
			const changeSet = this.toSubagentChangeSetState(artifact, changedFiles)
			await this.taskHistoryStore.upsert({
				...childHistory,
				status: "interrupted",
				subagentChangeSet: changeSet,
			})
			try {
				const messages = await readTaskMessages({
					taskId: childHistory.parentTaskId,
					globalStoragePath: this.context.globalStorageUri.fsPath,
				})
				const groupMessage = messages.find((message) =>
					message.subagentGroup?.agents.some((agent) => agent.taskId === artifact.taskId),
				)
				const agent = groupMessage?.subagentGroup?.agents.find((item) => item.taskId === artifact.taskId)
				if (!groupMessage?.subagentGroup || !agent) continue
				agent.status = "interrupted"
				agent.error =
					"The extension reloaded while this worker was active. Recoverable partial changes were quarantined."
				agent.changedFiles = changedFiles
				agent.changeSet = changeSet
				delete agent.pendingApproval
				await saveTaskMessages({
					taskId: childHistory.parentTaskId,
					globalStoragePath: this.context.globalStorageUri.fsPath,
					messages,
				})
			} catch (error) {
				this.log(`Failed to reconcile recovered worker ${artifact.taskId}: ${String(error)}`)
			}
		}
	}

	private async reconcileInterruptedSubagentState(): Promise<void> {
		const liveTaskIds = new Set(this.getLiveTaskIds())
		const childHistoryItems = this.taskHistoryStore
			.getAll()
			.filter((item) => item.taskKind === "subagent" && item.parentTaskId)
		const parentTaskIds = new Set(childHistoryItems.map((item) => item.parentTaskId!))
		const completedAt = Date.now()

		for (const child of childHistoryItems) {
			if (child.status !== "active" || liveTaskIds.has(child.id)) continue
			await this.taskHistoryStore.upsert({ ...child, status: "interrupted" })
		}

		for (const parentTaskId of parentTaskIds) {
			try {
				const messages = await readTaskMessages({
					taskId: parentTaskId,
					globalStoragePath: this.context.globalStorageUri.fsPath,
				})
				let changed = false

				for (const message of messages) {
					const group = message.subagentGroup
					if (!group || !["pending", "running", "cancelling"].includes(group.status)) continue
					if (
						group.agents.some(
							(agent) =>
								["pending", "running", "cancelling"].includes(agent.status) &&
								liveTaskIds.has(agent.taskId),
						)
					) {
						continue
					}

					for (const agent of group.agents) {
						if (!["pending", "running", "cancelling"].includes(agent.status)) continue
						agent.status = "interrupted"
						delete agent.phase
						delete agent.phaseStartedAt
						delete agent.pendingApproval
						agent.completedAt = agent.completedAt ?? completedAt
						agent.error =
							agent.error ??
							"The extension reloaded before this sub-agent finished. Start a new delegation from the parent task to retry."
						agent.usage.durationMs = Math.max(
							agent.usage.durationMs,
							completedAt - (agent.startedAt ?? group.startedAt ?? group.createdAt),
						)
					}

					group.status = "interrupted"
					group.completedAt = group.completedAt ?? completedAt
					changed = true
				}

				if (changed) {
					await saveTaskMessages({
						taskId: parentTaskId,
						globalStoragePath: this.context.globalStorageUri.fsPath,
						messages,
					})
				}
			} catch (error) {
				this.log(`Failed to reconcile interrupted sub-agent groups for ${parentTaskId}: ${String(error)}`)
			}
		}
	}

	public async surfaceSubagentApproval(
		child: Task,
		type: "command" | "protected_write",
		text?: string,
	): Promise<void> {
		const descriptor = this.subagentDescriptors.get(child.taskId)
		const prepared = descriptor ? this.preparedSubagentGroups.get(descriptor.groupId) : undefined
		const agent = prepared?.group.agents.find((item) => item.taskId === child.taskId)
		if (!descriptor || !prepared || !agent) return
		let operation = text?.trim() || (type === "command" ? "Run command" : "Protected write")
		let scope: string | undefined
		if (type === "protected_write") {
			try {
				const payload = JSON.parse(text ?? "{}") as { tool?: string; path?: string }
				operation = payload.tool ?? "Protected write"
				scope = payload.path
			} catch {
				// Keep the original display text when metadata is malformed.
			}
		}
		agent.pendingApproval = { id: crypto.randomUUID(), type, operation, scope, createdAt: Date.now() }
		await descriptor.parent.upsertSubagentGroup(prepared.group)
	}

	public async clearSubagentApproval(taskId: string): Promise<void> {
		const descriptor = this.subagentDescriptors.get(taskId)
		const prepared = descriptor ? this.preparedSubagentGroups.get(descriptor.groupId) : undefined
		const agent = prepared?.group.agents.find((item) => item.taskId === taskId)
		if (!descriptor || !prepared || !agent?.pendingApproval) return
		delete agent.pendingApproval
		await descriptor.parent.upsertSubagentGroup(prepared.group)
	}

	public async respondToSubagentApproval(
		parentTaskId: string,
		groupId: string,
		taskId: string,
		approvalId: string,
		approved: boolean,
	): Promise<void> {
		const prepared = this.preparedSubagentGroups.get(groupId)
		const agent = prepared?.group.agents.find((item) => item.taskId === taskId)
		if (!prepared || prepared.group.parentTaskId !== parentTaskId || agent?.pendingApproval?.id !== approvalId)
			return
		const child = this.getLiveTask(taskId)
		if (!child) return
		delete agent.pendingApproval
		await this.subagentDescriptors.get(taskId)?.parent.upsertSubagentGroup(prepared.group)
		if (approved) child.approveAsk()
		else child.denyAsk()
	}

	private getWorkerChangeSetTarget(parentTaskId: string, groupId: string, changeSetId: string) {
		const parent = this.getLiveTask(parentTaskId)
		const group = parent?.clineMessages.find(
			(message) => message.say === "subagent_group" && message.subagentGroup?.groupId === groupId,
		)?.subagentGroup
		const agent = group?.agents.find((item) => item.changeSet?.id === changeSetId)
		return parent && group && agent ? { parent, group, agent } : undefined
	}

	private async updateWorkerChangeSetHistory(taskId: string, changeSet: SubagentChangeSetState): Promise<void> {
		const child = this.getLiveTask(taskId)
		child?.setSubagentChangeSet(changeSet)
		try {
			const { historyItem } = await this.getTaskWithId(taskId)
			await this.updateTaskHistory({ ...historyItem, subagentChangeSet: structuredClone(changeSet) })
		} catch (error) {
			this.log(`Failed to update worker change-set history for ${taskId}: ${String(error)}`)
		}
	}

	public async openSubagentChangeSet(parentTaskId: string, groupId: string, changeSetId: string): Promise<void> {
		const target = this.getWorkerChangeSetTarget(parentTaskId, groupId, changeSetId)
		if (!target) return
		const [artifact, entries] = await Promise.all([
			managedSubagentWorktreeService.load(this.context.globalStorageUri.fsPath, changeSetId),
			managedSubagentWorktreeService.getDiffFiles(this.context.globalStorageUri.fsPath, changeSetId),
		])
		const emptyPath = path.join(this.context.globalStorageUri.fsPath, "subagent-change-sets", changeSetId, "empty")
		await fs.writeFile(emptyPath, "", { flag: "a" })
		const changes = entries.map((entry) => [
			vscode.Uri.file(path.join(artifact.gitRoot, entry.path)),
			vscode.Uri.file(entry.beforePath ?? emptyPath),
			vscode.Uri.file(entry.afterPath ?? emptyPath),
		])
		await vscode.commands.executeCommand("vscode.changes", `${target.agent.nickname} worker changes`, changes)
	}

	public async applySubagentChangeSet(parentTaskId: string, groupId: string, changeSetId: string): Promise<void> {
		const target = this.getWorkerChangeSetTarget(parentTaskId, groupId, changeSetId)
		if (!target) return
		if (!target.parent.isIdleForExternalMutation()) {
			void vscode.window.showWarningMessage(
				"Wait for the parent task to become idle before applying worker changes.",
			)
			return
		}
		const result = await this.runWorkspaceMutation(target.parent, "apply worker change set", () =>
			managedSubagentWorktreeService.apply(this.context.globalStorageUri.fsPath, changeSetId),
		)
		const artifact = await managedSubagentWorktreeService.load(this.context.globalStorageUri.fsPath, changeSetId)
		const changeSet = this.toSubagentChangeSetState(artifact)
		target.agent.changeSet = changeSet
		await target.parent.upsertSubagentGroup(target.group)
		await this.updateWorkerChangeSetHistory(target.agent.taskId, changeSet)
		if (result.status === "conflicted") {
			void vscode.window.showWarningMessage(
				"Worker changes remain quarantined because parent files changed. Review the conflicts and retry.",
			)
		}
	}

	public async discardSubagentChangeSet(parentTaskId: string, groupId: string, changeSetId: string): Promise<void> {
		const target = this.getWorkerChangeSetTarget(parentTaskId, groupId, changeSetId)
		if (!target) return
		const artifact = await managedSubagentWorktreeService.discard(this.context.globalStorageUri.fsPath, changeSetId)
		const changeSet = this.toSubagentChangeSetState(artifact)
		target.agent.changeSet = changeSet
		await target.parent.upsertSubagentGroup(target.group)
		await this.updateWorkerChangeSetHistory(target.agent.taskId, changeSet)
	}

	private getLogicalWorkerChangedFiles(artifact: ManagedWorkerArtifact): string[] {
		const prefix = artifact.logicalWorkspaceFromRoot
		return artifact.changes
			.map((change) => (prefix ? path.posix.relative(prefix, change.path) : change.path))
			.filter((candidate) => candidate && candidate !== ".." && !candidate.startsWith("../"))
	}

	private toSubagentChangeSetState(
		artifact: ManagedWorkerArtifact,
		changedFiles = this.getLogicalWorkerChangedFiles(artifact),
	): SubagentChangeSetState {
		return {
			id: artifact.id,
			status: artifact.status === "active" || artifact.changes.length === 0 ? "unavailable" : artifact.status,
			changedFiles,
			createdAt: artifact.createdAt,
			updatedAt: artifact.updatedAt,
			partial: artifact.partial,
			conflictPaths: artifact.conflictPaths,
			error: artifact.error ?? (artifact.changes.length === 0 ? "No worker changes were captured." : undefined),
		}
	}

	private getWorkerCommandResults(child: Task): InternalTaskResult["verification"] {
		return child.getCommandExecutionEvidence().map((evidence) => ({
			status:
				evidence.status === "succeeded"
					? "passed"
					: evidence.status === "running"
						? "running"
						: evidence.status,
			exitCode: evidence.exitCode,
		}))
	}

	private getWorkerVerification(results: InternalTaskResult["verification"]): SubagentVerification[] {
		if (results.length === 0) {
			return [
				{
					label: "Targeted verification",
					status: "not_run",
					detail: "The worker did not run a verification command.",
				},
			]
		}

		return results.map((result, index) => ({
			// Command contents are intentionally not persisted: they may contain
			// credentials or private paths. Use a truthful neutral label instead of
			// claiming every shell invocation was a verification command.
			label: `Worker command ${index + 1}`,
			status:
				result.status === "passed" ||
				result.status === "failed" ||
				result.status === "running" ||
				result.status === "not_run"
					? result.status
					: "failed",
			detail:
				result.exitCode !== undefined
					? `Exit code ${result.exitCode}`
					: result.status === "running"
						? "The command is still running."
						: result.status === "timed_out"
							? "The command timed out."
							: result.status === "denied"
								? "The command was denied."
								: result.status === "cancelled"
									? "The command was cancelled."
									: result.status === "not_run"
										? "No terminal exit status was recorded."
										: "The command did not complete successfully.",
		}))
	}

	private getSubagentInspectedPaths(child: Task): string[] {
		const paths = new Set<string>()
		for (const message of child.clineMessages) {
			if (message.ask !== "tool" || !message.text) continue
			try {
				const payload = JSON.parse(message.text) as {
					tool?: string
					path?: string
					batchFiles?: Array<{ path?: string }>
				}
				if (payload.tool !== "readFile") continue
				if (payload.path) paths.add(payload.path)
				for (const file of payload.batchFiles ?? []) {
					if (file.path) paths.add(file.path)
				}
			} catch {
				// Ignore malformed display metadata; the complete transcript is still preserved.
			}
		}
		return [...paths]
	}

	private getSubagentPhaseForMessage(message: ClineMessage): SubagentRunPhase | undefined {
		if (message.say === "completion_result") {
			return message.partial === false ? "finalizing" : "reporting"
		}
		if (message.say === "api_req_rate_limit_wait" || message.say === "api_req_retry_delayed") {
			return message.partial === false ? "working" : "waiting"
		}
		if (
			message.say === "api_req_started" ||
			message.say === "api_req_retried" ||
			message.say === "reasoning" ||
			message.ask === "tool"
		) {
			return "working"
		}
		return undefined
	}

	private async updateSubagentPhase(groupId: string, taskId: string, phase: SubagentRunPhase): Promise<void> {
		const prepared = this.preparedSubagentGroups.get(groupId)
		const agent = prepared?.group.agents.find((item) => item.taskId === taskId)
		if (!prepared || !agent || agent.status !== "running" || agent.phase === phase) return

		agent.phase = phase
		agent.phaseStartedAt = Date.now()
		const parent = this.getLiveTask(prepared.group.parentTaskId) ?? this.subagentDescriptors.get(taskId)?.parent
		if (parent) await parent.upsertSubagentGroup(prepared.group)
	}

	private describeIncompleteSubagent(
		status: "completed" | "blocked" | "failed" | "cancelled" | "timed_out",
		inspectedPaths: string[],
	): string {
		const label =
			status === "timed_out"
				? "Timed out"
				: status === "cancelled"
					? "Cancelled"
					: status === "blocked"
						? "Blocked"
						: status === "failed"
							? "Failed"
							: "Completed without a final report"
		if (inspectedPaths.length === 0) {
			return `${label} before producing a final report. The partial transcript is preserved.`
		}

		const preview = inspectedPaths.slice(0, 4).join(", ")
		const remaining = inspectedPaths.length - Math.min(inspectedPaths.length, 4)
		return `${label} after inspecting ${inspectedPaths.length} file${inspectedPaths.length === 1 ? "" : "s"}: ${preview}${remaining > 0 ? `, and ${remaining} more` : ""}. The partial transcript is preserved.`
	}

	private async applySubagentResult(
		prepared: PreparedSubagentGroup | undefined,
		result: Pick<
			InternalTaskResult,
			"taskId" | "status" | "summary" | "usage" | "changedFiles" | "displayVerification" | "changeSet"
		>,
	): Promise<void> {
		if (!prepared) return
		const publicationKey = `${prepared.group.groupId}:${result.taskId}`
		if (this.publishedSubagentResults.has(publicationKey)) return
		const agent = prepared.group.agents.find((item) => item.taskId === result.taskId)
		if (!agent) return
		const completedAt = agent.completedAt ?? Date.now()
		agent.status = result.status === "denied" ? "cancelled" : result.status
		delete agent.phase
		delete agent.phaseStartedAt
		const hasTerminalReport = result.status === "completed" || result.status === "blocked"
		agent.summary = hasTerminalReport ? result.summary : undefined
		agent.error = hasTerminalReport ? undefined : result.summary
		agent.completedAt = completedAt
		agent.usage = result.usage
		delete agent.pendingApproval
		agent.changedFiles = result.changedFiles
		agent.verification = result.displayVerification
		agent.changeSet = result.changeSet
		const parent =
			this.getLiveTask(prepared.group.parentTaskId) ?? this.subagentDescriptors.get(result.taskId)?.parent
		if (parent) {
			await parent.upsertSubagentGroup(prepared.group)
			this.publishedSubagentResults.add(publicationKey)
		}
	}

	private releaseSubagentGroup(groupId: string): void {
		const taskIds = this.preparedSubagentGroups.get(groupId)?.group.agents.map((agent) => agent.taskId) ?? []
		this.preparedSubagentGroups.delete(groupId)
		this.subagentGroupControllers.delete(groupId)
		this.reservedSubagentSlots.delete(groupId)
		for (const [taskId, descriptor] of this.subagentDescriptors) {
			if (descriptor.groupId === groupId) this.subagentDescriptors.delete(taskId)
		}
		for (const taskId of taskIds) this.publishedSubagentResults.delete(`${groupId}:${taskId}`)
	}

	/**
	 * Delegate parent task and open child task.
	 *
	 * - Enforce single-open invariant
	 * - Persist parent delegation metadata
	 * - Emit TaskDelegated (task-level; API forwards to provider/bridge)
	 * - Create child as sole active and switch mode to child's mode
	 */
	public async delegateParentAndOpenChild(params: {
		parentTaskId: string
		message: string
		initialTodos: TodoItem[]
		mode: string
	}): Promise<Task> {
		const { parentTaskId, message, initialTodos, mode } = params

		// Metadata-driven delegation is always enabled

		// 1) Get parent by lane id. Delegation can be triggered by a task that is not
		// currently focused, so do not rely on the foreground task pointer here.
		const parent = this.getLiveTask(parentTaskId) ?? this.getCurrentTask()
		if (!parent) {
			throw new Error(`[delegateParentAndOpenChild] Parent task ${parentTaskId} is not live`)
		}
		if (parent.taskId !== parentTaskId) {
			throw new Error(
				`[delegateParentAndOpenChild] Parent mismatch: expected ${parentTaskId}, resolved ${parent.taskId}`,
			)
		}
		const childTaskMode = mode
		const modeProviderProfile = await this.getModeProviderProfile(mode)
		const childTaskApiConfigName =
			modeProviderProfile?.name ?? (await parent.getTaskApiConfigName()) ?? (await this.getProviderProfile())
		const childApiConfiguration = modeProviderProfile?.providerSettings ?? parent.apiConfiguration
		const childRunsInBackground = !this.isTaskOnScreen(parentTaskId)
		// 2) Flush pending tool results to API history BEFORE disposing the parent.
		//    This is critical: when tools are called before new_task,
		//    their tool_result blocks are in userMessageContent but not yet saved to API history.
		//    If we don't flush them, the parent's API conversation will be incomplete and
		//    cause 400 errors when resumed (missing tool_result for tool_use blocks).
		//
		//    NOTE: We do NOT pass the assistant message here because the assistant message
		//    is already added to apiConversationHistory by the normal flow in
		//    recursivelyMakeClineRequests BEFORE tools start executing. We only need to
		//    flush the pending user message with tool_results.
		try {
			const flushSuccess = await parent.flushPendingToolResultsToHistory()

			if (!flushSuccess) {
				console.warn(`[delegateParentAndOpenChild] Flush failed for parent ${parentTaskId}, retrying...`)
				const retrySuccess = await parent.retrySaveApiConversationHistory()

				if (!retrySuccess) {
					console.error(
						`[delegateParentAndOpenChild] CRITICAL: Parent ${parentTaskId} API history not persisted to disk. Child return may produce stale state.`,
					)
					vscode.window.showWarningMessage(
						"Warning: Parent task state could not be saved. The parent task may lose recent context when resumed.",
					)
				}
			}
		} catch (error) {
			this.log(
				`[delegateParentAndOpenChild] Error flushing pending tool results (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		// 3) Enforce single-open invariant by closing/disposing the parent first
		//    This ensures we never have >1 tasks open at any time during delegation.
		//    Await abort completion to ensure clean disposal and prevent unhandled rejections.
		try {
			await this.removeClineFromStack({ taskId: parentTaskId, skipDelegationRepair: true })
		} catch (error) {
			this.log(
				`[delegateParentAndOpenChild] Error during parent disposal (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			// Non-fatal: proceed with child creation even if parent cleanup had issues
		}

		// 4) Create child as sole active (parent reference preserved for lineage)
		// Pass initialStatus: "active" to ensure the child task's historyItem is created
		// with status from the start, avoiding race conditions where the task might
		// call attempt_completion before status is persisted separately.
		//
		// Pass startTask: false to prevent the child from beginning its task loop
		// (and writing to globalState via saveClineMessages → updateTaskHistory)
		// before we persist the parent's delegation metadata in step 5.
		// Without this, the child's fire-and-forget startTask() races with step 5,
		// and the last writer to globalState overwrites the other's changes—
		// causing the parent's delegation fields to be lost.
		const child = await this.createTask(message, undefined, parent as any, {
			initialTodos,
			initialStatus: "active",
			startTask: false,
			taskMode: childTaskMode,
			taskApiConfigName: childTaskApiConfigName,
			apiConfiguration: childApiConfiguration,
			background: childRunsInBackground,
		})

		// 5) Persist parent delegation metadata BEFORE the child starts writing.
		try {
			const { historyItem } = await this.getTaskWithId(parentTaskId)
			const childIds = Array.from(new Set([...(historyItem.childIds ?? []), child.taskId]))
			const updatedHistory: typeof historyItem = {
				...historyItem,
				status: "delegated",
				delegatedToId: child.taskId,
				awaitingChildId: child.taskId,
				childIds,
			}
			await this.updateTaskHistory(updatedHistory)
		} catch (err) {
			this.log(
				`[delegateParentAndOpenChild] Failed to persist parent metadata for ${parentTaskId} -> ${child.taskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
		}

		// 6) Start the child task now that parent metadata is safely persisted.
		child.start()

		// 7) Emit TaskDelegated (provider-level)
		try {
			this.emit(RooCodeEventName.TaskDelegated, parentTaskId, child.taskId)
		} catch {
			// non-fatal
		}

		return child
	}

	/**
	 * Reopen parent task from delegation with write-back and events.
	 */
	public async reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void> {
		const { parentTaskId, childTaskId, completionResultSummary } = params
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		const childWasOnScreen =
			typeof this.isTaskOnScreen === "function"
				? this.isTaskOnScreen(childTaskId)
				: this.getCurrentTask()?.taskId === childTaskId

		// 1) Load parent from history and current persisted messages
		const { historyItem } = await this.getTaskWithId(parentTaskId)

		let parentClineMessages: ClineMessage[] = []
		try {
			parentClineMessages = await readTaskMessages({
				taskId: parentTaskId,
				globalStoragePath,
			})
		} catch {
			parentClineMessages = []
		}

		let parentApiMessages: any[] = []
		try {
			parentApiMessages = (await readApiMessages({
				taskId: parentTaskId,
				globalStoragePath,
			})) as any[]
		} catch {
			parentApiMessages = []
		}

		// 2) Inject synthetic records: UI subtask_result and update API tool_result
		const ts = Date.now()

		// Defensive: ensure arrays
		if (!Array.isArray(parentClineMessages)) parentClineMessages = []
		if (!Array.isArray(parentApiMessages)) parentApiMessages = []

		const subtaskUiMessage: ClineMessage = {
			type: "say",
			say: "subtask_result",
			text: completionResultSummary,
			ts,
		}
		parentClineMessages.push(subtaskUiMessage)
		await saveTaskMessages({ messages: parentClineMessages, taskId: parentTaskId, globalStoragePath })

		// Find the tool_use_id from the last assistant message's new_task tool_use
		let toolUseId: string | undefined
		for (let i = parentApiMessages.length - 1; i >= 0; i--) {
			const msg = parentApiMessages[i]
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use" && block.name === "new_task") {
						toolUseId = block.id
						break
					}
				}
				if (toolUseId) break
			}
		}

		// Preferred: if the parent history contains the native tool_use for new_task,
		// inject a matching tool_result for the Anthropic message contract:
		// user → assistant (tool_use) → user (tool_result)
		if (toolUseId) {
			// Check if the last message is already a user message with a tool_result for this tool_use_id
			// (in case this is a retry or the history was already updated)
			const lastMsg = parentApiMessages[parentApiMessages.length - 1]
			let alreadyHasToolResult = false
			if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
				for (const block of lastMsg.content) {
					if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
						// Update the existing tool_result content
						block.content = `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`
						alreadyHasToolResult = true
						break
					}
				}
			}

			// If no existing tool_result found, create a NEW user message with the tool_result
			if (!alreadyHasToolResult) {
				parentApiMessages.push({
					role: "user",
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: toolUseId,
							content: `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`,
						},
					],
					ts,
				})
			}

			// Validate the newly injected tool_result against the preceding assistant message.
			// This ensures the tool_result's tool_use_id matches a tool_use in the immediately
			// preceding assistant message (Anthropic API requirement).
			const lastMessage = parentApiMessages[parentApiMessages.length - 1]
			if (lastMessage?.role === "user") {
				const validatedMessage = validateAndFixToolResultIds(lastMessage, parentApiMessages.slice(0, -1))
				parentApiMessages[parentApiMessages.length - 1] = validatedMessage
			}
		} else {
			// If there is no corresponding tool_use in the parent API history, we cannot emit a
			// tool_result. Fall back to a plain user text note so the parent can still resume.
			parentApiMessages.push({
				role: "user",
				content: [
					{
						type: "text" as const,
						text: `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`,
					},
				],
				ts,
			})
		}

		await saveApiMessages({ messages: parentApiMessages as any, taskId: parentTaskId, globalStoragePath })

		// 3) Close child instance if still open (single-open-task invariant).
		//    This MUST happen BEFORE updating the child's status to "completed" because
		//    removeClineFromStack() → abortTask(true) → saveClineMessages() writes
		//    the historyItem with initialStatus (typically "active"), which would
		//    overwrite a "completed" status set earlier.
		const liveChild =
			typeof this.getLiveTask === "function"
				? this.getLiveTask(childTaskId)
				: this.getCurrentTask()?.taskId === childTaskId
					? this.getCurrentTask()
					: undefined
		if (liveChild) {
			await this.removeClineFromStack({ taskId: childTaskId })
		}

		// 4) Update child metadata to "completed" status.
		//    This runs after the abort so it overwrites the stale "active" status
		//    that saveClineMessages() may have written during step 3.
		try {
			const { historyItem: childHistory } = await this.getTaskWithId(childTaskId)
			await this.updateTaskHistory({
				...childHistory,
				status: "completed",
			})
		} catch (err) {
			this.log(
				`[reopenParentFromDelegation] Failed to persist child completed status for ${childTaskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
		}

		// 5) Update parent metadata and persist BEFORE emitting completion event
		const childIds = Array.from(new Set([...(historyItem.childIds ?? []), childTaskId]))
		const updatedHistory: typeof historyItem = {
			...historyItem,
			status: "active",
			completedByChildId: childTaskId,
			completionResultSummary,
			awaitingChildId: undefined,
			childIds,
		}
		await this.updateTaskHistory(updatedHistory)

		// 6) Emit TaskDelegationCompleted (provider-level)
		try {
			this.emit(RooCodeEventName.TaskDelegationCompleted, parentTaskId, childTaskId, completionResultSummary)
		} catch {
			// non-fatal
		}

		// 7) Reopen the parent from history (restores saved mode). If the child was
		//    off-screen, keep the parent off-screen too.
		//    IMPORTANT: startTask=false to suppress resume-from-history ask scheduling
		const parentInstance = await this.createTaskWithHistoryItem(
			updatedHistory,
			childWasOnScreen ? { startTask: false } : { startTask: false, preserveExisting: true, background: true },
		)

		// 8) Inject restored histories into the in-memory instance before resuming
		if (parentInstance) {
			try {
				await parentInstance.overwriteClineMessages(parentClineMessages)
			} catch {
				// non-fatal
			}
			try {
				await parentInstance.overwriteApiConversationHistory(parentApiMessages as any)
			} catch {
				// non-fatal
			}

			// Auto-resume parent without ask("resume_task")
			await parentInstance.resumeAfterDelegation()
		}

		// 9) Emit TaskDelegationResumed (provider-level)
		try {
			this.emit(RooCodeEventName.TaskDelegationResumed, parentTaskId, childTaskId)
		} catch {
			// non-fatal
		}
	}

	/**
	 * Convert a file path to a webview-accessible URI
	 * This method safely converts file paths to URIs that can be loaded in the webview
	 *
	 * @param filePath - The absolute file path to convert
	 * @returns The webview URI string, or the original file URI if conversion fails
	 * @throws {Error} When webview is not available
	 * @throws {TypeError} When file path is invalid
	 */
	public convertToWebviewUri(filePath: string): string {
		try {
			const fileUri = vscode.Uri.file(filePath)

			// Check if we have a webview available
			if (this.view?.webview) {
				const webviewUri = this.view.webview.asWebviewUri(fileUri)
				return webviewUri.toString()
			}

			// Specific error for no webview available
			const error = new Error("No webview available for URI conversion")
			console.error(error.message)
			// Fallback to file URI if no webview available
			return fileUri.toString()
		} catch (error) {
			// More specific error handling
			if (error instanceof TypeError) {
				console.error("Invalid file path provided for URI conversion:", error)
			} else {
				console.error("Failed to convert to webview URI:", error)
			}
			// Return file URI as fallback
			return vscode.Uri.file(filePath).toString()
		}
	}
}
