import * as path from "path"
import * as vscode from "vscode"
import os from "os"
import crypto from "crypto"
import { v7 as uuidv7 } from "uuid"
import EventEmitter from "events"

import { AskIgnoredError } from "./AskIgnoredError"

class SteerRequestInterruptError extends Error {
	constructor() {
		super("Request interrupted by steered user message")
		this.name = "SteerRequestInterruptError"
	}
}

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import debounce from "lodash.debounce"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"
import { Package } from "../../shared/package"
import { formatToolInvocation } from "../tools/helpers/toolResultFormatting"

import {
	type TaskLike,
	type TaskMetadata,
	type TaskEvents,
	type ProviderSettings,
	type TokenUsage,
	type ToolUsage,
	type ToolName,
	type ContextCondense,
	type ContextTruncation,
	type ClineMessage,
	type ClineSay,
	type ClineAsk,
	type ToolProgressStatus,
	type HistoryItem,
	type CreateTaskOptions,
	type ModelInfo,
	type ClineApiReqCancelReason,
	type ClineApiReqInfo,
	type FollowUpData,
	RooCodeEventName,
	TaskStatus,
	TodoItem,
	getApiProtocol,
	getModelId,
	isRetiredProvider,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	QueuedMessage,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	MAX_CHECKPOINT_TIMEOUT_SECONDS,
	MIN_CHECKPOINT_TIMEOUT_SECONDS,
	ConsecutiveMistakeError,
	MAX_MCP_TOOLS_THRESHOLD,
	countEnabledMcpTools,
	TelemetryEventName,
} from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

// api
import { ApiHandler, ApiHandlerCreateMessageMetadata, buildApiHandler } from "../../api"
import { ApiStream, GroundingSource } from "../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { getApiRequestTimeout, withApiRequestTimeout } from "../../api/providers/utils/timeout-config"

// shared
import { findLastIndex } from "../../shared/array"
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { t } from "../../i18n"
import { getApiMetrics, hasTokenUsageChanged, hasToolUsageChanged } from "../../shared/getApiMetrics"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { DiffStrategy, type ToolUse, type ToolParamName, toolParamNames } from "../../shared/tools"
import { getModelMaxOutputTokens } from "../../shared/api"
import { TokenAwareRequestPacer } from "../agent/RequestPacing"

// services
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { findToolName } from "../../integrations/misc/export-markdown"
import { RooTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"

// utils
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"
import { getWorkspacePath } from "../../utils/path"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { getTaskDirectoryPath } from "../../utils/storage"

// prompts
import { formatResponse } from "../prompts/responses"
import { SYSTEM_PROMPT } from "../prompts/system"
import { buildNativeToolsArrayWithRestrictions } from "./build-tools"

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { restoreTodoListForTask } from "../tools/UpdateTodoListTool"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { RooProtectedController } from "../protect/RooProtectedController"
import { type AssistantMessageContent, presentAssistantMessage } from "../assistant-message"
import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import { isSafeCompactionBoundary, manageContext, willManageContext } from "../context-management"
import { ClineProvider } from "../webview/ClineProvider"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import {
	type ApiMessage,
	readApiMessages,
	saveApiMessages,
	readTaskMessages,
	saveTaskMessages,
	taskMetadata,
} from "../task-persistence"
import { collectEnvironmentSnapshot, getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import type { EnvironmentSnapshot } from "../environment/EnvironmentSnapshot"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"
import { processUserContentMentions } from "../mentions/processUserContentMentions"
import { getMessagesSinceLastSummary, summarizeConversation, getEffectiveApiHistory } from "../condense"
import { MessageQueueService } from "../message-queue/MessageQueueService"
import { AutoApprovalHandler, checkAutoApproval } from "../auto-approval"
import { MessageManager } from "../message-manager"
import { validateAndFixToolResultIds } from "./validateToolResultIds"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"
import {
	AgentResponseAccumulator,
	AgentTurnEngine,
	type AgentResponse,
	type AgentResponseItem,
	type AgentTurnHost,
} from "../agent/AgentTurnEngine"
import { buildAgentTurnTelemetryProperties } from "../agent/AgentTurnTelemetry"
import { ToolScheduler, type ToolSchedulerOutcome } from "../agent/ToolScheduler"
import { createTaskToolRegistry, getToolCapabilities } from "../tools/ToolRegistry"
import {
	createStepContext,
	digestValue,
	toStepContextMetadata,
	type StepCompactionMetadata,
	type StepContext,
	type StepContextKind,
} from "../agent/StepContext"
import type { AgentTurnEvent } from "../agent/AgentTurnEvents"
import { AgentTurnEventLog } from "../agent/AgentTurnEventLog"
import { createToolPolicySnapshot, type ToolPolicySnapshot } from "../agent/ToolPolicy"
import { resolveExecutionProfile } from "../agent/ExecutionProfile"

const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600 // 10 minutes
const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000 // 5 seconds
const FORCED_CONTEXT_REDUCTION_PERCENT = 75 // Keep 75% of context (remove 25%) on context window errors
const MAX_CONTEXT_WINDOW_RETRIES = 3 // Maximum retries for context window errors

export interface TaskOptions extends CreateTaskOptions {
	provider: ClineProvider
	apiConfiguration: ProviderSettings
	enableCheckpoints?: boolean
	checkpointTimeout?: number
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Task
	parentTask?: Task
	taskNumber?: number
	onCreated?: (task: Task) => void
	initialTodos?: TodoItem[]
	workspacePath?: string
	/** Initial status for the task's history item (e.g., "active" for child tasks) */
	initialStatus?: "active" | "delegated" | "completed"
}

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	private static readonly requestPacer = new TokenAwareRequestPacer()
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	childTaskId?: string
	pendingNewTaskToolCallId?: string

	readonly instanceId: string
	readonly metadata: TaskMetadata

	todoList?: TodoItem[]

	readonly rootTask: Task | undefined = undefined
	readonly parentTask: Task | undefined = undefined
	readonly taskNumber: number
	readonly workspacePath: string

	/**
	 * The mode associated with this task. Persisted across sessions
	 * to maintain user context when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskMode()`
	 * 3. Falls back to `defaultModeSlug` if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.mode` during construction
	 * 2. Falls back to `defaultModeSlug` if mode is not stored in history
	 *
	 * ## Important
	 * This property should NOT be accessed directly until `taskModeReady` promise resolves.
	 * Use `getTaskMode()` for async access or `taskMode` getter for sync access after initialization.
	 *
	 * @private
	 * @see {@link getTaskMode} - For safe async access
	 * @see {@link taskMode} - For sync access after initialization
	 * @see {@link waitForModeInitialization} - To ensure initialization is complete
	 */
	private _taskMode: string | undefined

	/**
	 * Promise that resolves when the task mode has been initialized.
	 * This ensures async mode initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task mode
	 * - Ensures provider state is properly loaded before mode-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 * @see {@link waitForModeInitialization} - Public method to await this promise
	 */
	private taskModeReady: Promise<void>

	/**
	 * The API configuration name (provider profile) associated with this task.
	 * Persisted across sessions to maintain the provider profile when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskApiConfigName()`
	 * 3. Falls back to "default" if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.apiConfigName` during construction
	 * 2. Falls back to undefined if not stored in history (for backward compatibility)
	 *
	 * ## Important
	 * If you need a non-`undefined` provider profile (e.g., for profile-dependent operations),
	 * wait for `taskApiConfigReady` first (or use `getTaskApiConfigName()`).
	 * The sync `taskApiConfigName` getter may return `undefined` for backward compatibility.
	 *
	 * @private
	 * @see {@link getTaskApiConfigName} - For safe async access
	 * @see {@link taskApiConfigName} - For sync access after initialization
	 */
	private _taskApiConfigName: string | undefined

	/**
	 * Promise that resolves when the task API config name has been initialized.
	 * This ensures async API config name initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task API config name
	 * - Ensures provider state is properly loaded before profile-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 */
	private taskApiConfigReady: Promise<void>

	providerRef: WeakRef<ClineProvider>
	private readonly globalStoragePath: string
	private readonly taskAbortController = new AbortController()
	private agentTurnEventLog?: AgentTurnEventLog
	abort: boolean = false
	currentRequestAbortController?: AbortController
	private readonly taskCancellationController = new AbortController()
	private readonly childTasksRequiringVerification = new Set<string>()
	private pendingSteerMessage?: { text: string; images: string[] }
	private isTaskLoopActive = false
	private didComplete = false
	private completionFinalized = false
	skipPrevResponseIdOnce: boolean = false

	// TaskStatus
	idleAsk?: ClineMessage
	resumableAsk?: ClineMessage
	interactiveAsk?: ClineMessage

	didFinishAbortingStream = false
	abandoned = false
	abortReason?: ClineApiReqCancelReason
	isInitialized = false
	isPaused: boolean = false

	// API
	apiConfiguration: ProviderSettings
	api: ApiHandler
	private static lastGlobalApiRequestTime?: number
	private autoApprovalHandler: AutoApprovalHandler

	/**
	 * Reset the global API request timestamp. This should only be used for testing.
	 * @internal
	 */
	static resetGlobalApiRequestTime(): void {
		Task.lastGlobalApiRequestTime = undefined
	}

	toolRepetitionDetector: ToolRepetitionDetector
	rooIgnoreController?: RooIgnoreController
	rooProtectedController?: RooProtectedController
	fileContextTracker: FileContextTracker
	terminalProcess?: RooTerminalProcess

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	didEditFile: boolean = false

	// LLM Messages & Chat Messages
	apiConversationHistory: ApiMessage[] = []
	clineMessages: ClineMessage[] = []

	// Ask
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	private activeAsk?: { type: ClineAsk; ts: number }
	public lastMessageTs?: number
	private autoApprovalTimeoutRef?: NodeJS.Timeout

	// Tool Use
	consecutiveMistakeCount: number = 0
	consecutiveMistakeLimit: number
	consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	consecutiveMistakeCountForEditFile: Map<string, number> = new Map()
	consecutiveNoToolUseCount: number = 0
	consecutiveNoAssistantMessagesCount: number = 0
	toolUsage: ToolUsage = {}

	// Checkpoints
	enableCheckpoints: boolean
	checkpointTimeout: number
	checkpointService?: RepoPerTaskCheckpointService
	checkpointServiceInitializing = false

	// Message Queue Service
	public readonly messageQueueService: MessageQueueService
	private messageQueueStateChangedHandler: (() => void) | undefined

	// Streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	currentStreamingContentIndex = 0
	currentStreamingDidCheckpoint = false
	assistantMessageContent: AssistantMessageContent[] = []
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[] = []
	userMessageContentReady = false

	/**
	 * Flag indicating whether the assistant message for the current streaming session
	 * has been saved to API conversation history.
	 *
	 * This is critical for parallel tool calling: tools should NOT execute until
	 * the assistant message is saved. Otherwise, if a tool like `new_task` triggers
	 * `flushPendingToolResultsToHistory()`, the user message with tool_results would
	 * appear BEFORE the assistant message with tool_uses, causing API errors.
	 *
	 * Reset to `false` at the start of each API request.
	 * Set to `true` after the assistant message is saved in `recursivelyMakeClineRequests`.
	 */
	assistantMessageSavedToHistory = false

	/**
	 * The canonical response collected for the current model turn. Keeping the
	 * accumulator's result intact lets AgentTurnEngine consumers observe
	 * reasoning, usage, grounding, and structured errors in addition to text and
	 * tool calls.
	 */
	private completedAgentResponse?: AgentResponse
	private completedStepContext?: StepContext
	private retryStepContext?: StepContext
	private lastCompactionStepContext?: StepContext
	private currentStepEnvironmentDetails?: string
	private currentStepEnvironmentSnapshot?: EnvironmentSnapshot
	private lastAgentTurnRetryCount = 0
	private streamingBoundary: Promise<void> = Promise.resolve()
	private toolBatchBoundary: Promise<void> = Promise.resolve()
	private resolveStreamingBoundary?: () => void
	private resolveToolBatchBoundary?: () => void

	/**
	 * Push a tool_result block to userMessageContent, preventing duplicates.
	 * Duplicate tool_use_ids cause API errors.
	 *
	 * @param toolResult - The tool_result block to add
	 * @returns true if added, false if duplicate was skipped
	 */
	public pushToolResultToUserContent(toolResult: Anthropic.ToolResultBlockParam): boolean {
		const existingResult = this.userMessageContent.find(
			(block): block is Anthropic.ToolResultBlockParam =>
				block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
		)
		if (existingResult) {
			console.warn(
				`[Task#pushToolResultToUserContent] Skipping duplicate tool_result for tool_use_id: ${toolResult.tool_use_id}`,
			)
			return false
		}
		this.userMessageContent.push(toolResult)
		return true
	}

	didRejectTool = false
	didAlreadyUseTool = false
	didToolFailInCurrentTurn = false
	didCompleteReadingStream = false
	private _started = false
	// No streaming parser is required.
	assistantMessageParser?: undefined

	// Native tool call streaming state (track which index each tool is at)

	// Cached model info for current streaming session (set at start of each API request)
	// This prevents excessive getModel() calls during tool execution
	cachedStreamingModel?: { id: string; info: ModelInfo }

	// Token Usage Cache
	private tokenUsageSnapshot?: TokenUsage
	private tokenUsageSnapshotAt?: number

	// Tool Usage Cache
	private toolUsageSnapshot?: ToolUsage

	// Token Usage Throttling - Debounced emit function
	private readonly TOKEN_USAGE_EMIT_INTERVAL_MS = 2000 // 2 seconds
	private debouncedEmitTokenUsage: ReturnType<typeof debounce>

	// Initial status for the task's history item (set at creation time to avoid race conditions)
	private readonly initialStatus?: "active" | "delegated" | "completed"

	// MessageManager for high-level message operations (lazy initialized)
	private _messageManager?: MessageManager

	constructor({
		provider,
		apiConfiguration,
		enableCheckpoints = true,
		checkpointTimeout = DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
		taskId,
		task,
		images,
		historyItem,
		experiments: experimentsConfig,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber = -1,
		onCreated,
		initialTodos,
		workspacePath,
		taskMode,
		taskApiConfigName,
		initialStatus,
	}: TaskOptions) {
		super()

		if (startTask && !task && !images && !historyItem) {
			throw new Error("Either historyItem or task/images must be provided")
		}

		if (
			!checkpointTimeout ||
			checkpointTimeout > MAX_CHECKPOINT_TIMEOUT_SECONDS ||
			checkpointTimeout < MIN_CHECKPOINT_TIMEOUT_SECONDS
		) {
			throw new Error(
				"checkpointTimeout must be between " +
					MIN_CHECKPOINT_TIMEOUT_SECONDS +
					" and " +
					MAX_CHECKPOINT_TIMEOUT_SECONDS +
					" seconds",
			)
		}

		this.taskId = historyItem ? historyItem.id : (taskId ?? uuidv7())
		this.rootTaskId = historyItem ? historyItem.rootTaskId : rootTask?.taskId
		this.parentTaskId = historyItem ? historyItem.parentTaskId : parentTask?.taskId
		this.childTaskId = undefined

		this.metadata = {
			task: historyItem ? historyItem.task : task,
			images: historyItem ? [] : images,
		}

		// Normal use-case is usually retry similar history task with new workspace.
		this.workspacePath = parentTask
			? parentTask.workspacePath
			: (workspacePath ?? getWorkspacePath(path.join(os.homedir(), "Desktop")))

		this.instanceId = crypto.randomUUID().slice(0, 8)
		this.taskNumber = -1

		this.rooIgnoreController = new RooIgnoreController(this.cwd)
		this.rooProtectedController = new RooProtectedController(this.cwd)
		this.fileContextTracker = new FileContextTracker(provider, this.taskId)

		this.rooIgnoreController.initialize().catch((error) => {
			console.error("Failed to initialize RooIgnoreController:", error)
		})

		this.apiConfiguration = apiConfiguration
		this.api = buildApiHandler(this.apiConfiguration)
		this.autoApprovalHandler = new AutoApprovalHandler()

		this.consecutiveMistakeLimit = consecutiveMistakeLimit ?? DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
		this.providerRef = new WeakRef(provider)
		this.globalStoragePath = provider.context.globalStorageUri.fsPath
		this.diffViewProvider = new DiffViewProvider(this.cwd, this)
		this.enableCheckpoints = enableCheckpoints
		this.checkpointTimeout = checkpointTimeout

		this.parentTask = parentTask
		this.taskNumber = taskNumber
		this.initialStatus = initialStatus

		// Store the task's mode and API config name when it's created.
		// For history items, use the stored values; for new tasks, we'll set them
		// after getting state.
		if (historyItem) {
			this._taskMode = historyItem.mode || defaultModeSlug
			this._taskApiConfigName = historyItem.apiConfigName
			this.taskModeReady = Promise.resolve()
			this.taskApiConfigReady = Promise.resolve()
			TelemetryService.instance.captureTaskRestarted(this.taskId)
		} else {
			this._taskMode = taskMode
			this._taskApiConfigName = taskApiConfigName
			this.taskModeReady = taskMode ? Promise.resolve() : this.initializeTaskMode(provider)
			this.taskApiConfigReady = taskApiConfigName ? Promise.resolve() : this.initializeTaskApiConfigName(provider)
			TelemetryService.instance.captureTaskCreated(this.taskId)
		}

		this.assistantMessageParser = undefined

		this.messageQueueService = new MessageQueueService()

		this.messageQueueStateChangedHandler = () => {
			this.emit(RooCodeEventName.TaskUserMessage, this.taskId)
			this.emit(RooCodeEventName.QueuedMessagesUpdated, this.taskId, this.messageQueueService.messages)
			this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
		}

		this.messageQueueService.on("stateChanged", this.messageQueueStateChangedHandler)

		// Set up diff strategy
		this.diffStrategy = new MultiSearchReplaceDiffStrategy()

		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit)

		// Initialize todo list if provided
		if (initialTodos && initialTodos.length > 0) {
			this.todoList = initialTodos
		}

		// Initialize debounced token usage emit function
		// Uses debounce with maxWait to achieve throttle-like behavior:
		// - leading: true  - Emit immediately on first call
		// - trailing: true - Emit final state when updates stop
		// - maxWait        - Ensures at most one emit per interval during rapid updates (throttle behavior)
		this.debouncedEmitTokenUsage = debounce(
			(tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				const tokenChanged = hasTokenUsageChanged(tokenUsage, this.tokenUsageSnapshot)
				const toolChanged = hasToolUsageChanged(toolUsage, this.toolUsageSnapshot)

				if (tokenChanged || toolChanged) {
					this.emit(RooCodeEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage, toolUsage)
					this.tokenUsageSnapshot = tokenUsage
					this.tokenUsageSnapshotAt = this.clineMessages.at(-1)?.ts
					// Deep copy tool usage for snapshot
					this.toolUsageSnapshot = JSON.parse(JSON.stringify(toolUsage))
				}
			},
			this.TOKEN_USAGE_EMIT_INTERVAL_MS,
			{ leading: true, trailing: true, maxWait: this.TOKEN_USAGE_EMIT_INTERVAL_MS },
		)

		onCreated?.(this)

		if (startTask) {
			this._started = true
			if (task || images) {
				this.startTask(task, images)
			} else if (historyItem) {
				this.resumeTaskFromHistory()
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	/**
	 * Initialize the task mode from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current mode from provider state
	 * 2. Sets `_taskMode` to the fetched mode or `defaultModeSlug` if unavailable
	 * 3. Handles errors gracefully by falling back to default mode
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to `defaultModeSlug` to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskMode(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()
			this._taskMode = state?.mode || defaultModeSlug
		} catch (error) {
			// If there's an error getting state, use the default mode
			this._taskMode = defaultModeSlug
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task mode: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Initialize the task API config name from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current API config name from provider state
	 * 2. Sets `_taskApiConfigName` to the fetched name or "default" if unavailable
	 * 3. Handles errors gracefully by falling back to "default"
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to "default" to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskApiConfigName(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()

			// Avoid clobbering a newer value that may have been set while awaiting provider state
			// (e.g., user switches provider profile immediately after task creation).
			if (this._taskApiConfigName === undefined) {
				this._taskApiConfigName = state?.currentApiConfigName ?? "default"
			}
		} catch (error) {
			// If there's an error getting state, use the default profile (unless a newer value was set).
			if (this._taskApiConfigName === undefined) {
				this._taskApiConfigName = "default"
			}
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task API config name: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Wait for the task mode to be initialized before proceeding.
	 * This method ensures that any operations depending on the task mode
	 * will have access to the correct mode value.
	 *
	 * ## When to use
	 * - Before accessing mode-specific configurations
	 * - When switching between tasks with different modes
	 * - Before operations that depend on mode-based permissions
	 *
	 * ## Example usage
	 * ```typescript
	 * // Wait for mode initialization before mode-dependent operations
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Now safe to access synchronously
	 *
	 * // Or use with getTaskMode() for a one-liner
	 * const mode = await task.getTaskMode(); // Internally waits for initialization
	 * ```
	 *
	 * @returns Promise that resolves when the task mode is initialized
	 * @public
	 */
	public async waitForModeInitialization(): Promise<void> {
		return this.taskModeReady
	}

	/**
	 * Get the task mode asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task mode as it guarantees
	 * the mode is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskModeReady` promise to resolve
	 * - Returns the initialized mode or `defaultModeSlug` as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // Safe async access
	 * const mode = await task.getTaskMode();
	 * console.log(`Task is running in ${mode} mode`);
	 *
	 * // Use in conditional logic
	 * if (await task.getTaskMode() === 'architect') {
	 *   // Perform architect-specific operations
	 * }
	 * ```
	 *
	 * @returns Promise resolving to the task mode string
	 * @public
	 */
	public async getTaskMode(): Promise<string> {
		await this.taskModeReady
		return this._taskMode || defaultModeSlug
	}

	/**
	 * Get the task mode synchronously. This should only be used when you're certain
	 * that the mode has already been initialized (e.g., after waitForModeInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForModeInitialization()`
	 * - In event handlers or callbacks where mode is guaranteed to be initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // After ensuring initialization
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Safe synchronous access
	 *
	 * // In an event handler after task is started
	 * task.on('taskStarted', () => {
	 *   console.log(`Task started in ${task.taskMode} mode`); // Safe here
	 * });
	 * ```
	 *
	 * @throws {Error} If the mode hasn't been initialized yet
	 * @returns The task mode string
	 * @public
	 */
	public get taskMode(): string {
		if (this._taskMode === undefined) {
			throw new Error("Task mode accessed before initialization. Use getTaskMode() or wait for taskModeReady.")
		}

		return this._taskMode
	}

	/**
	 * Wait for the task API config name to be initialized before proceeding.
	 * This method ensures that any operations depending on the task's provider profile
	 * will have access to the correct value.
	 *
	 * ## When to use
	 * - Before accessing provider profile-specific configurations
	 * - When switching between tasks with different provider profiles
	 * - Before operations that depend on the provider profile
	 *
	 * @returns Promise that resolves when the task API config name is initialized
	 * @public
	 */
	public async waitForApiConfigInitialization(): Promise<void> {
		return this.taskApiConfigReady
	}

	/**
	 * Get the task API config name asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task's provider profile as it guarantees
	 * the value is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskApiConfigReady` promise to resolve
	 * - Returns the initialized API config name or undefined as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * @returns Promise resolving to the task API config name string or undefined
	 * @public
	 */
	public async getTaskApiConfigName(): Promise<string | undefined> {
		await this.taskApiConfigReady
		return this._taskApiConfigName
	}

	/**
	 * Get the task API config name synchronously. This should only be used when you're certain
	 * that the value has already been initialized (e.g., after waitForApiConfigInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForApiConfigInitialization()`
	 * - In event handlers or callbacks where API config name is guaranteed to be initialized
	 *
	 * Note: Unlike taskMode, this getter does not throw if uninitialized since the API config
	 * name can legitimately be undefined (backward compatibility with tasks created before
	 * this feature was added).
	 *
	 * @returns The task API config name string or undefined
	 * @public
	 */
	public get taskApiConfigName(): string | undefined {
		return this._taskApiConfigName
	}

	/**
	 * Update the task's API config name. This is called when the user switches
	 * provider profiles while a task is active, allowing the task to remember
	 * its new provider profile.
	 *
	 * @param apiConfigName - The new API config name to set
	 * @internal
	 */
	public setTaskApiConfigName(apiConfigName: string | undefined): void {
		this._taskApiConfigName = apiConfigName
		this.taskApiConfigReady = Promise.resolve()
	}

	/**
	 * Update this task's execution mode without changing the foreground provider mode.
	 */
	public setTaskMode(mode: string): void {
		this._taskMode = mode
		this.taskModeReady = Promise.resolve()
	}

	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false })
		const { images, task, historyItem } = options
		let promise

		if (images || task) {
			promise = instance.startTask(task, images)
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		return [instance, promise]
	}

	// API Messages

	private async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string) {
		// Capture the encrypted_content / thought signatures from the provider (e.g., OpenAI Responses API, Google GenAI) if present.
		// We only persist data reported by the current response body.
		const handler = this.api as ApiHandler & {
			getResponseId?: () => string | undefined
			getEncryptedContent?: () => { encrypted_content: string; id?: string } | undefined
			getThoughtSignature?: () => string | undefined
			getSummary?: () => any[] | undefined
			getReasoningDetails?: () => any[] | undefined
		}

		if (message.role === "assistant") {
			const responseId = handler.getResponseId?.()
			const reasoningData = handler.getEncryptedContent?.()
			const thoughtSignature = handler.getThoughtSignature?.()
			const reasoningSummary = handler.getSummary?.()
			const reasoningDetails = handler.getReasoningDetails?.()

			// Only Anthropic's API expects/validates the special `thinking` content block signature.
			// Other providers (notably Gemini 3) use different signature semantics (e.g. `thoughtSignature`)
			// and require round-tripping the signature in their own format.
			const modelId = getModelId(this.apiConfiguration)
			const apiProvider = this.apiConfiguration.apiProvider
			const apiProtocol = getApiProtocol(
				apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
				modelId,
			)
			const isAnthropicProtocol = apiProtocol === "anthropic"

			// Start from the original assistant message
			const messageWithTs: any = {
				...message,
				...(responseId ? { id: responseId } : {}),
				ts: Date.now(),
			}

			// Store reasoning_details array if present (for models like Gemini 3)
			if (reasoningDetails) {
				messageWithTs.reasoning_details = reasoningDetails
			}

			// Store reasoning: Anthropic thinking (with signature), plain text (most providers), or encrypted (OpenAI Native)
			// Skip if reasoning_details already contains the reasoning (to avoid duplication)
			if (isAnthropicProtocol && reasoning && thoughtSignature && !reasoningDetails) {
				// Anthropic provider with extended thinking: Store as proper `thinking` block
				// This format passes through anthropic-filter.ts and is properly round-tripped
				// for interleaved thinking with tool use (required by Anthropic API)
				const thinkingBlock = {
					type: "thinking",
					thinking: reasoning,
					signature: thoughtSignature,
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						thinkingBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [thinkingBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [thinkingBlock]
				}
			} else if (reasoning && !reasoningDetails) {
				// Other providers (non-Anthropic): Store as generic reasoning block
				const reasoningBlock = {
					type: "reasoning",
					text: reasoning,
					summary: reasoningSummary ?? ([] as any[]),
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						reasoningBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [reasoningBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [reasoningBlock]
				}
			} else if (reasoningData?.encrypted_content) {
				// OpenAI Native encrypted reasoning
				const reasoningBlock = {
					type: "reasoning",
					summary: [] as any[],
					encrypted_content: reasoningData.encrypted_content,
					...(reasoningData.id ? { id: reasoningData.id } : {}),
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						reasoningBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [reasoningBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [reasoningBlock]
				}
			}

			// For non-Anthropic providers (e.g., Gemini 3), persist the thought signature as its own
			// content block so converters can attach it back to the correct provider-specific fields.
			// Note: For Anthropic extended thinking, the signature is already included in the thinking block above.
			if (thoughtSignature && !isAnthropicProtocol) {
				const thoughtSignatureBlock = {
					type: "thoughtSignature",
					thoughtSignature,
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
						thoughtSignatureBlock,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [...messageWithTs.content, thoughtSignatureBlock]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [thoughtSignatureBlock]
				}
			}

			this.apiConversationHistory.push(messageWithTs)
		} else {
			// For user messages, validate tool_result IDs ONLY when the immediately previous *effective* message
			// is an assistant message.
			//
			// If the previous effective message is also a user message (e.g., summary + a new user message),
			// validating against any earlier assistant message can incorrectly inject placeholder tool_results.
			const effectiveHistoryForValidation = getEffectiveApiHistory(this.apiConversationHistory)
			const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
			const historyForValidation = lastEffective?.role === "assistant" ? effectiveHistoryForValidation : []

			// If the previous effective message is NOT an assistant, convert tool_result blocks to text blocks.
			// This prevents orphaned tool_results from being filtered out by getEffectiveApiHistory.
			// This can happen when condensing occurs after the assistant sends tool_uses but before
			// the user responds - the tool_use blocks get condensed away, leaving orphaned tool_results.
			let messageToAdd = message
			if (lastEffective?.role !== "assistant" && Array.isArray(message.content)) {
				messageToAdd = {
					...message,
					content: message.content.map((block) =>
						block.type === "tool_result"
							? {
									type: "text" as const,
									text: `Tool result:\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`,
								}
							: block,
					),
				}
			}

			const validatedMessage = validateAndFixToolResultIds(messageToAdd, historyForValidation)
			const messageWithTs = { ...validatedMessage, ts: Date.now() }
			this.apiConversationHistory.push(messageWithTs)
		}

		await this.saveApiConversationHistory()
	}

	private async restoreRemovedApiUserMessage(removedUserMessage: ApiMessage | undefined) {
		if (!removedUserMessage) {
			return
		}

		const lastMessage = this.apiConversationHistory[this.apiConversationHistory.length - 1]
		if (lastMessage !== removedUserMessage) {
			this.apiConversationHistory.push(removedUserMessage)
			await this.saveApiConversationHistory()
		}
	}

	private buildUserMessageContent(text?: string, images?: string[]): Anthropic.Messages.ContentBlockParam[] {
		const userContent: Anthropic.Messages.ContentBlockParam[] = []

		if (text) {
			userContent.push({
				type: "text",
				text: `<user_message>\n${text}\n</user_message>`,
			})
		}

		if (images && images.length > 0) {
			userContent.push(...formatResponse.imageBlocks(images))
		}

		return userContent
	}

	private takeLastApiUserMessageContent(): Anthropic.Messages.ContentBlockParam[] {
		const lastMessage = this.apiConversationHistory.at(-1)

		if (lastMessage?.role !== "user") {
			return []
		}

		this.apiConversationHistory.pop()

		if (Array.isArray(lastMessage.content)) {
			return lastMessage.content as Anthropic.Messages.ContentBlockParam[]
		}

		return [{ type: "text", text: lastMessage.content }]
	}

	// NOTE: We intentionally do NOT mutate stored messages to merge consecutive user turns.
	// For API requests, consecutive same-role messages are merged via mergeConsecutiveApiMessages()
	// so rewind/edit behavior can still reference original message boundaries.

	async overwriteApiConversationHistory(newHistory: ApiMessage[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	/**
	 * Flush any pending tool results to the API conversation history.
	 *
	 * This is critical when the task is about to be
	 * delegated (e.g., via new_task). Before delegation, if other tools were
	 * called in the same turn before new_task, their tool_result blocks are
	 * accumulated in `userMessageContent` but haven't been saved to the API
	 * history yet. If we don't flush them before the parent is disposed,
	 * the API conversation will be incomplete and cause 400 errors when
	 * the parent resumes (missing tool_result for tool_use blocks).
	 *
	 * NOTE: The assistant message is typically already in history by the time
	 * tools execute (added in recursivelyMakeClineRequests after streaming completes).
	 * So we usually only need to flush the pending user message with tool_results.
	 */
	public async flushPendingToolResultsToHistory(): Promise<boolean> {
		// Only flush if there's actually pending content to save
		if (this.userMessageContent.length === 0) {
			return true
		}

		// CRITICAL: Wait for the assistant message to be saved to API history first.
		// Without this, tool_result blocks would appear BEFORE tool_use blocks in the
		// conversation history, causing API errors like:
		// "unexpected `tool_use_id` found in `tool_result` blocks"
		//
		// This can happen when multiple tools are called (e.g., update_todo_list + new_task).
		// Tool execution is deferred until the complete assistant response is saved.
		// When new_task triggers delegation, it calls this method to flush pending
		// results after that history boundary has been established.
		//
		// The assistantMessageSavedToHistory flag is:
		// - Reset to false at the start of each API request
		// - Set to true after the assistant message is saved in recursivelyMakeClineRequests
		if (!this.assistantMessageSavedToHistory) {
			await pWaitFor(() => this.assistantMessageSavedToHistory || this.abort, {
				interval: 50,
				timeout: 30_000, // 30 second timeout as safety net
			}).catch(() => {
				// If timeout or abort, log and proceed anyway to avoid hanging
				console.warn(
					`[Task#${this.taskId}] flushPendingToolResultsToHistory: timed out waiting for assistant message to be saved`,
				)
			})
		}

		// If task was aborted while waiting, don't flush
		if (this.abort) {
			return false
		}

		// Save the user message with tool_result blocks
		const userMessage: Anthropic.MessageParam = {
			role: "user",
			content: this.userMessageContent,
		}

		// Validate and fix tool_result IDs when the previous *effective* message is an assistant message.
		const effectiveHistoryForValidation = getEffectiveApiHistory(this.apiConversationHistory)
		const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
		const historyForValidation = lastEffective?.role === "assistant" ? effectiveHistoryForValidation : []
		const validatedMessage = validateAndFixToolResultIds(userMessage, historyForValidation)
		const userMessageWithTs = { ...validatedMessage, ts: Date.now() }
		this.apiConversationHistory.push(userMessageWithTs as ApiMessage)

		const saved = await this.saveApiConversationHistory()

		if (saved) {
			// Clear the pending content since it's now saved
			this.userMessageContent = []
		} else {
			console.warn(
				`[Task#${this.taskId}] flushPendingToolResultsToHistory: save failed, retaining pending tool results in memory`,
			)
		}

		return saved
	}

	private async saveApiConversationHistory(): Promise<boolean> {
		try {
			await saveApiMessages({
				messages: structuredClone(this.apiConversationHistory),
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})
			return true
		} catch (error) {
			console.error("Failed to save API conversation history:", error)
			return false
		}
	}

	/**
	 * Public wrapper to retry saving the API conversation history.
	 * Uses exponential backoff: up to 3 attempts with delays of 100 ms, 500 ms, 1500 ms.
	 * Used by delegation flow when flushPendingToolResultsToHistory reports failure.
	 */
	public async retrySaveApiConversationHistory(): Promise<boolean> {
		const delays = [100, 500, 1500]

		for (let attempt = 0; attempt < delays.length; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]))
			console.warn(
				`[Task#${this.taskId}] retrySaveApiConversationHistory: retry attempt ${attempt + 1}/${delays.length}`,
			)

			const success = await this.saveApiConversationHistory()

			if (success) {
				return true
			}
		}

		return false
	}

	// Alpha Messages

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToClineMessages(message: ClineMessage) {
		this.clineMessages.push(message)
		const provider = this.providerRef.deref()
		// Avoid resending large, mostly-static fields (notably taskHistory) on every chat message update.
		// taskHistory is maintained in-memory in the webview and updated via taskHistoryItemUpdated.
		await provider?.postStateToWebviewWithoutTaskHistory()
		this.emit(RooCodeEventName.Message, { action: "created", message })
		await this.saveClineMessages()
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages
		restoreTodoListForTask(this)
		await this.saveClineMessages()
	}

	private async updateClineMessage(message: ClineMessage) {
		const provider = this.providerRef.deref()
		await provider?.postMessageToWebview({ type: "messageUpdated", taskId: this.taskId, clineMessage: message })
		this.emit(RooCodeEventName.Message, { action: "updated", message })
	}

	private async saveClineMessages(): Promise<boolean> {
		try {
			await saveTaskMessages({
				messages: structuredClone(this.clineMessages),
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})

			if (this._taskApiConfigName === undefined) {
				await this.taskApiConfigReady
			}

			const { historyItem, tokenUsage } = await taskMetadata({
				taskId: this.taskId,
				rootTaskId: this.rootTaskId,
				parentTaskId: this.parentTaskId,
				taskNumber: this.taskNumber,
				messages: this.clineMessages,
				globalStoragePath: this.globalStoragePath,
				workspace: this.cwd,
				mode: this._taskMode || defaultModeSlug, // Use the task's own mode, not the current provider mode.
				apiConfigName: this._taskApiConfigName, // Use the task's own provider profile, not the current provider profile.
				initialStatus: this.initialStatus,
			})

			// Emit token/tool usage updates using debounced function
			// The debounce with maxWait ensures:
			// - Immediate first emit (leading: true)
			// - At most one emit per interval during rapid updates (maxWait)
			// - Final state is emitted when updates stop (trailing: true)
			this.debouncedEmitTokenUsage(tokenUsage, this.toolUsage)

			await this.providerRef.deref()?.updateTaskHistory(historyItem)
			return true
		} catch (error) {
			console.error("Failed to save Alpha messages:", error)
			return false
		}
	}

	private findMessageByTimestamp(ts: number): ClineMessage | undefined {
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			if (this.clineMessages[i].ts === ts) {
				return this.clineMessages[i]
			}
		}

		return undefined
	}

	private getOffscreenAutoAskResponse(
		type: ClineAsk,
		text?: string,
		isProtected?: boolean,
	): { response: ClineAskResponse; text?: string; images?: string[] } | undefined {
		const provider = this.providerRef.deref()

		if (!provider || provider.isTaskOnScreen(this.taskId) || isProtected) {
			return undefined
		}

		if (type === "command_output") {
			return { response: "messageResponse" }
		}

		if (type === "mistake_limit_reached") {
			return { response: "messageResponse", text: this.getOffscreenMistakeLimitGuidance() }
		}

		if (type === "completion_result") {
			return { response: "yesButtonClicked" }
		}

		if (type === "followup") {
			try {
				const suggestion = (JSON.parse(text ?? "{}") as FollowUpData).suggest?.[0]
				if (suggestion?.answer) {
					return { response: "messageResponse", text: suggestion.answer }
				}
			} catch {
				// Fall through to the generic off-screen follow-up response.
			}

			return {
				response: "messageResponse",
				text: "Continue without waiting for the user. Choose the best reasonable option based on the current task context, then proceed.",
			}
		}

		if (type !== "tool") {
			return undefined
		}

		try {
			const payload = JSON.parse(text ?? "{}")
			if (["newTask", "switchMode", "finishTask"].includes(payload?.tool)) {
				return { response: "yesButtonClicked" }
			}
		} catch {
			return undefined
		}

		return undefined
	}

	private getMistakeLimitGuidance(): string {
		const details = [
			`Task lane: mode=${this._taskMode || defaultModeSlug}, providerProfile=${this._taskApiConfigName ?? "unknown"}.`,
			`Consecutive mistake count: ${this.consecutiveMistakeCount}/${this.consecutiveMistakeLimit}.`,
		]

		if (this.consecutiveNoToolUseCount > 0) {
			details.push(`Recent provider responses without tool use: ${this.consecutiveNoToolUseCount}.`)
		}

		if (this.consecutiveNoAssistantMessagesCount > 0) {
			details.push(
				`Recent provider responses without assistant messages: ${this.consecutiveNoAssistantMessagesCount}.`,
			)
		}

		details.push(
			"Recovery guidance: continue with the next concrete action. Independent read-only inspections may be batched; use attempt_completion if the task is finished, and use ask_followup_question only when a specific missing input blocks progress.",
			"If delegating, call new_task by itself in its own assistant turn. Do not batch new_task with any other tool.",
		)

		return `${t("common:errors.mistake_limit_guidance")}\n\n${details.map((detail) => `- ${detail}`).join("\n")}`
	}

	private getAutomaticMistakeLimitGuidance(): string {
		const details = [
			"Automatic recovery from repeated invalid or unproductive model turns. Continue without waiting for user input.",
			`Task lane: mode=${this._taskMode || defaultModeSlug}, providerProfile=${this._taskApiConfigName ?? "unknown"}.`,
			`Consecutive mistake count before recovery: ${this.consecutiveMistakeCount}/${this.consecutiveMistakeLimit}.`,
		]

		if (this.consecutiveNoToolUseCount > 0) {
			details.push(`Recent provider responses without tool use: ${this.consecutiveNoToolUseCount}.`)
		}

		if (this.consecutiveNoAssistantMessagesCount > 0) {
			details.push(
				`Recent provider responses without assistant messages: ${this.consecutiveNoAssistantMessagesCount}.`,
			)
		}

		details.push(
			"Continue with the next concrete action now: independent read-only inspections may be batched, while attempt_completion, new_task, switch_mode, and ask_followup_question remain isolated.",
			"If delegating, call new_task by itself in its own assistant turn. Do not batch new_task with any other tool.",
		)

		return details.join("\n")
	}

	private async shouldAutoRecoverFromMistakeLimit(): Promise<boolean> {
		const provider = this.providerRef.deref()

		if (!provider) {
			return true
		}

		if (!provider.isTaskOnScreen(this.taskId)) {
			return true
		}

		const state = await provider.getState()
		return state?.autoApprovalEnabled === true
	}

	private async handleConsecutiveMistakeLimit(currentUserContent: Anthropic.Messages.ContentBlockParam[]) {
		// Track consecutive mistake errors in telemetry via event and PostHog exception tracking.
		// The reason is "no_tools_used" because this limit is reached via initiateTaskLoop
		// which increments consecutiveMistakeCount when the model doesn't use any tools.
		TelemetryService.instance.captureConsecutiveMistakeError(this.taskId)
		TelemetryService.instance.captureException(
			new ConsecutiveMistakeError(
				`Task reached consecutive mistake limit (${this.consecutiveMistakeLimit})`,
				this.taskId,
				this.consecutiveMistakeCount,
				this.consecutiveMistakeLimit,
				"no_tools_used",
				this.apiConfiguration.apiProvider,
				getModelId(this.apiConfiguration),
			),
		)

		if (await this.shouldAutoRecoverFromMistakeLimit()) {
			const text = this.getAutomaticMistakeLimitGuidance()
			currentUserContent.push({ type: "text", text: formatResponse.tooManyMistakes(text) })
			await this.say("user_feedback", text)
			this.consecutiveMistakeCount = 0
			return
		}

		const { response, text, images } = await this.ask("mistake_limit_reached", this.getMistakeLimitGuidance())

		if (response === "messageResponse") {
			currentUserContent.push(
				...[
					{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
					...formatResponse.imageBlocks(images),
				],
			)

			await this.say("user_feedback", text, images)
		}

		this.consecutiveMistakeCount = 0
	}

	private getOffscreenMistakeLimitGuidance(): string {
		return [
			"Continue the current task without waiting for the user because this task lane is not currently on-screen.",
			"Recover from the previous invalid or unproductive turns with the next concrete action; independent read-only inspections may be batched.",
			"If work remains, use the most appropriate tool now. If delegating, call new_task by itself and do not include any other tool in the same turn. If complete, use attempt_completion.",
		].join(" ")
	}

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		// If this Alpha instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Alpha now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Alpha = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error(`[RooCode#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

		let askTs: number

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.updateClineMessage(lastMessage)
					// console.log("Task#ask: current ask promise was ignored (#1)")
					throw new AskIgnoredError("updating existing partial")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial, isProtected })
					// console.log("Task#ask: current ask promise was ignored (#2)")
					throw new AskIgnoredError("new partial")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined

					// Bug for the history books:
					// In the webview we use the ts as the chatrow key for the
					// virtuoso list. Since we would update this ts right at the
					// end of streaming, it would cause the view to flicker. The
					// key prop has to be stable otherwise react has trouble
					// reconciling items between renders, causing unmounting and
					// remounting of components (flickering).
					// The lesson here is if you see flickering when rendering
					// lists, it's likely because the key prop is not stable.
					// So in this case we must make sure that the message ts is
					// never altered after first setting it.
					askTs = lastMessage.ts
					this.lastMessageTs = askTs
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					await this.saveClineMessages()
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			askTs = Date.now()
			this.lastMessageTs = askTs
			await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
		}

		this.activeAsk = { type, ts: askTs }

		let timeouts: NodeJS.Timeout[] = []

		// Automatically approve if the ask according to the user's settings.
		const provider = this.providerRef.deref()
		const state = provider ? await provider.getState() : undefined
		const offscreenAutoResponse = this.getOffscreenAutoAskResponse(type, text, isProtected)
		const approval = offscreenAutoResponse
			? ({ decision: "ask" } as const)
			: await checkAutoApproval({ state, ask: type, text, isProtected })

		if (offscreenAutoResponse) {
			this.handleWebviewAskResponse(
				offscreenAutoResponse.response,
				offscreenAutoResponse.text,
				offscreenAutoResponse.images,
			)
		} else if (approval.decision === "approve") {
			this.approveAsk()
		} else if (approval.decision === "deny") {
			this.denyAsk()
		} else if (approval.decision === "timeout") {
			// Store the auto-approval timeout so it can be cancelled if user interacts
			this.autoApprovalTimeoutRef = setTimeout(() => {
				const { askResponse, text, images } = approval.fn()
				this.handleWebviewAskResponse(askResponse, text, images)
				this.autoApprovalTimeoutRef = undefined
			}, approval.timeout)
			timeouts.push(this.autoApprovalTimeoutRef)
		}

		// The state is mutable if the message is complete and the task will
		// block (via the `pWaitFor`).
		const isBlocking = !(this.askResponse !== undefined || this.lastMessageTs !== askTs)
		const isMessageQueued = !this.messageQueueService.isEmpty()
		// Queued messages represent the next conversational turn. Only drain them
		// at completion/resume boundaries unless the user explicitly steers one.
		const shouldDrainQueuedMessageForAsk =
			type === "completion_result" || type === "resume_task" || type === "resume_completed_task"
		const isStatusMutable = !partial && isBlocking && !isMessageQueued && approval.decision === "ask"

		if (isStatusMutable) {
			const statusMutationTimeout = 2_000

			if (isInteractiveAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.interactiveAsk = message
							this.emit(RooCodeEventName.TaskInteractive, this.taskId)
							provider?.postMessageToWebview({ type: "interactionRequired" })
						}
					}, statusMutationTimeout),
				)
			} else if (isResumableAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.resumableAsk = message
							this.emit(RooCodeEventName.TaskResumable, this.taskId)
						}
					}, statusMutationTimeout),
				)
			} else if (isIdleAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.idleAsk = message
							this.emit(RooCodeEventName.TaskIdle, this.taskId)
						}
					}, statusMutationTimeout),
				)
			}
		} else if (isMessageQueued && shouldDrainQueuedMessageForAsk) {
			const message = this.messageQueueService.dequeueMessage()

			if (message) {
				this.handleWebviewAskResponse("messageResponse", message.text, message.images)
			}
		}

		// Wait for askResponse to be set
		await pWaitFor(
			() => {
				if (this.askResponse !== undefined || this.lastMessageTs !== askTs) {
					return true
				}

				// If a queued message arrives while we're blocked on an ask (e.g. a follow-up
				// suggestion click that was incorrectly queued due to UI state), consume it
				// immediately so the task doesn't hang.
				if (shouldDrainQueuedMessageForAsk && !this.messageQueueService.isEmpty()) {
					const message = this.messageQueueService.dequeueMessage()
					if (message) {
						this.handleWebviewAskResponse("messageResponse", message.text, message.images)
					}
				}

				return false
			},
			{ interval: 100 },
		)

		if (this.lastMessageTs !== askTs) {
			if (this.activeAsk?.ts === askTs) {
				this.activeAsk = undefined
			}
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new AskIgnoredError("superseded")
		}

		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		if (this.activeAsk?.ts === askTs) {
			this.activeAsk = undefined
		}
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined

		// Cancel the timeouts if they are still running.
		timeouts.forEach((timeout) => clearTimeout(timeout))

		// Switch back to an active state.
		if (this.idleAsk || this.resumableAsk || this.interactiveAsk) {
			this.idleAsk = undefined
			this.resumableAsk = undefined
			this.interactiveAsk = undefined
			this.emit(RooCodeEventName.TaskActive, this.taskId)
		}

		this.emit(RooCodeEventName.TaskAskResponded)
		return result
	}

	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		// Clear any pending auto-approval timeout when user responds
		this.cancelAutoApprovalTimeout()

		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images

		// Create a checkpoint whenever the user sends a message.
		// Use allowEmpty=true to ensure a checkpoint is recorded even if there are no file changes.
		// Suppress the checkpoint_saved chat row for this particular checkpoint to keep the timeline clean.
		if (askResponse === "messageResponse") {
			void this.checkpointSave(false, true)
		}

		// Mark the last follow-up question as answered
		if (askResponse === "messageResponse" || askResponse === "yesButtonClicked") {
			// Find the last unanswered follow-up message using findLastIndex
			const lastFollowUpIndex = findLastIndex(
				this.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "followup" && !msg.isAnswered,
			)

			if (lastFollowUpIndex !== -1) {
				// Mark this follow-up as answered
				this.clineMessages[lastFollowUpIndex].isAnswered = true
				// Save the updated messages
				this.saveClineMessages().catch((error) => {
					console.error("Failed to save answered follow-up state:", error)
				})
			}
		}

		// Mark the last tool-approval ask as answered when user approves (or auto-approval)
		if (askResponse === "yesButtonClicked") {
			const lastToolAskIndex = findLastIndex(
				this.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "tool" && !msg.isAnswered,
			)
			if (lastToolAskIndex !== -1) {
				this.clineMessages[lastToolAskIndex].isAnswered = true
				void this.updateClineMessage(this.clineMessages[lastToolAskIndex])
				this.saveClineMessages().catch((error) => {
					console.error("Failed to save answered tool-ask state:", error)
				})
			}
		}
	}

	/**
	 * Cancel any pending auto-approval timeout.
	 * Called when user interacts (types, clicks buttons, etc.) to prevent the timeout from firing.
	 */
	public cancelAutoApprovalTimeout(): void {
		if (this.autoApprovalTimeoutRef) {
			clearTimeout(this.autoApprovalTimeoutRef)
			this.autoApprovalTimeoutRef = undefined
		}
	}

	public approveAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("yesButtonClicked", text, images)
	}

	public denyAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("noButtonClicked", text, images)
	}

	public supersedePendingAsk(): void {
		this.lastMessageTs = Date.now()
	}

	public markCompleted(): void {
		this.didComplete = true
		this.cancelAutoApprovalTimeout()
		this.activeAsk = undefined
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		this.idleAsk = undefined
		this.resumableAsk = undefined
		this.interactiveAsk = undefined
		this.userMessageContentReady = true
		this.messageQueueService.clear()
	}

	/**
	 * Finalize a genuinely completed task through the lifecycle observed by the provider.
	 * This is idempotent because attempt_completion can finalize during a model step and
	 * the turn engine will observe the same completed outcome immediately afterwards.
	 */
	public finalizeCompletion(): boolean {
		if (
			this.completionFinalized ||
			this.abort ||
			this.abandoned ||
			this.abortReason === "user_cancelled" ||
			this.activeAsk ||
			this.taskAsk
		) {
			return false
		}

		this.completionFinalized = true
		this.markCompleted()
		this.emitFinalTokenUsageUpdate()
		TelemetryService.instance.captureTaskCompleted(this.taskId)
		this.emit(RooCodeEventName.TaskCompleted, this.taskId, this.getTokenUsage(), this.toolUsage)
		return true
	}

	private async publishImplicitCompletionResult(response: AgentResponse): Promise<void> {
		const result = response.text.trim()
		if (
			!result ||
			this.clineMessages.some(
				(message) => message.say === "completion_result" || message.ask === "completion_result",
			)
		) {
			return
		}

		await this.say("completion_result", result, undefined, false)
	}

	/**
	 * Updates the API configuration and rebuilds the API handler.
	 * There is no tool-protocol switching or tool parser swapping.
	 *
	 * @param newApiConfiguration - The new API configuration to use
	 */
	public updateApiConfiguration(newApiConfiguration: ProviderSettings): void {
		// Update the configuration and rebuild the API handler
		this.apiConfiguration = newApiConfiguration
		this.api = buildApiHandler(this.apiConfiguration)
	}

	public async submitUserMessage(
		text: string,
		images?: string[],
		mode?: string,
		providerProfile?: string,
	): Promise<void> {
		try {
			text = (text ?? "").trim()
			images = images ?? []

			if (text.length === 0 && images.length === 0) {
				return
			}

			const provider = this.providerRef.deref()

			if (provider) {
				if (mode) {
					await provider.setTaskMode(this.taskId, mode)
				}

				if (providerProfile) {
					await provider.setTaskProviderProfile(this.taskId, providerProfile)
				}

				this.emit(RooCodeEventName.TaskUserMessage, this.taskId)

				// Handle the message directly instead of routing through the webview.
				// This avoids a race condition where the webview's message state hasn't
				// hydrated yet, causing it to interpret the message as a new task request.
				this.handleWebviewAskResponse("messageResponse", text, images)
			} else {
				console.error("[Task#submitUserMessage] Provider reference lost")
			}
		} catch (error) {
			console.error("[Task#submitUserMessage] Failed to submit user message:", error)
		}
	}

	public async steerUserMessage(text: string, images?: string[]): Promise<void> {
		text = (text ?? "").trim()
		images = images ?? []

		if (text.length === 0 && images.length === 0) {
			return
		}

		if (this.activeAsk) {
			this.handleWebviewAskResponse("messageResponse", text, images)
			return
		}

		if (this.isStreaming || this.isTaskLoopActive) {
			this.cancelAutoApprovalTimeout()
			this.pendingSteerMessage = { text, images }
			this.emit(RooCodeEventName.TaskUserMessage, this.taskId)
			this.currentRequestAbortController?.abort()
			return
		}

		await this.submitUserMessage(text, images)
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			this.terminalProcess?.abort()
		}
	}

	private async getFilesReadByRooSafely(context: string): Promise<string[] | undefined> {
		try {
			return await this.fileContextTracker.getFilesReadByRoo()
		} catch (error) {
			console.error(`[Task#${context}] Failed to get files read by Alpha:`, error)
			return undefined
		}
	}

	public async condenseContext(): Promise<void> {
		await this.waitForCompactionBoundary()
		// CRITICAL: Flush any pending tool results before condensing
		// to ensure tool_use/tool_result pairs are complete in history
		await this.flushPendingToolResultsToHistory()

		const systemPrompt = await this.getSystemPrompt()

		// Get condensing configuration
		const state = await this.providerRef.deref()?.getState()
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE
		const mode = await this.getTaskMode()
		const apiConfiguration = this.apiConfiguration
		const modelInfo = this.api.getModel().info

		const { contextTokens: prevContextTokens } = this.getTokenUsage()

		// Build tools for condensing metadata (same tools used for normal API calls)
		const provider = this.providerRef.deref()
		let allTools: import("openai").default.Chat.ChatCompletionTool[] = []
		if (provider) {
			const toolsResult = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: this.cwd,
				mode,
				customModes: state?.customModes,
				experiments: state?.experiments,
				apiConfiguration,
				disabledTools: state?.disabledTools,
				modelInfo,
				includeAllToolsWithRestrictions: false,
			})
			allTools = toolsResult.tools
		}

		// Build metadata with tools and taskId for the condensing API call
		const metadata: ApiHandlerCreateMessageMetadata = {
			mode,
			taskId: this.taskId,
			...(allTools.length > 0
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
					}
				: {}),
		}
		// Generate environment details to include in the condensed summary
		const environmentDetails = await getEnvironmentDetails(this, true)

		const filesReadByRoo = await this.getFilesReadByRooSafely("condenseContext")

		const {
			messages,
			summary,
			cost,
			newContextTokens = 0,
			error,
			errorDetails,
			condenseId,
		} = await summarizeConversation({
			messages: this.apiConversationHistory,
			apiHandler: this.api,
			systemPrompt,
			taskId: this.taskId,
			isAutomaticTrigger: false,
			customCondensingPrompt,
			metadata,
			environmentDetails,
			filesReadByRoo,
			cwd: this.cwd,
			rooIgnoreController: this.rooIgnoreController,
			createStepContext: async ({ systemPrompt: compactionPrompt, messages, metadata: compactionMetadata }) => {
				const context = await this.createStepContextSnapshot({
					kind: "compaction",
					contextId: crypto.randomUUID(),
					parentContextId: this.completedStepContext?.contextId,
					retryAttempt: 0,
					state,
					mode,
					systemPrompt: compactionPrompt,
					environmentDetails,
					environmentSnapshot: this.currentStepEnvironmentSnapshot,
					transcript: messages,
					metadata: compactionMetadata ?? metadata,
					tools: allTools,
					modelInfo,
					contextTokens: prevContextTokens,
					compaction: { action: "none", attempted: true },
				})
				this.lastCompactionStepContext = context
				return context
			},
		})
		if (error) {
			await this.say(
				"condense_context_error",
				error,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
			)
			return
		}
		await this.overwriteApiConversationHistory(messages)

		const contextCondense: ContextCondense = {
			summary,
			cost,
			newContextTokens,
			prevContextTokens,
			condenseId: condenseId!,
		}
		await this.say(
			"condense_context",
			undefined /* text */,
			undefined /* images */,
			false /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
			contextCondense,
		)

		// Process any queued messages after condensing completes
		this.processQueuedMessages()
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
		} = {},
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined> {
		if (this.abort) {
			throw new Error(`[RooCode#say] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new partial message, so add it with partial state.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
						contextCondense,
						contextTruncation,
					})
				}
			} else {
				// New now have a complete version of a previously partial message.
				// This is the complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					if (!options.isNonInteractive) {
						this.lastMessageTs = lastMessage.ts
					}

					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveClineMessages()

					// More performant than an entire `postStateToWebview`.
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						contextCondense,
						contextTruncation,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const sayTs = Date.now()

			// A "non-interactive" message is a message is one that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!options.isNonInteractive) {
				this.lastMessageTs = sayTs
			}

			await this.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				checkpoint,
				contextCondense,
				contextTruncation,
			})
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Alpha tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	// Lifecycle
	// Start / Resume / Abort / Dispose

	/**
	 * Get enabled MCP tools count for this task.
	 * Returns the count along with the number of servers contributing.
	 *
	 * @returns Object with enabledToolCount and enabledServerCount
	 */
	private async getEnabledMcpToolsCount(): Promise<{ enabledToolCount: number; enabledServerCount: number }> {
		try {
			const provider = this.providerRef.deref()
			if (!provider) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const { mcpEnabled } = (await provider.getState()) ?? {}
			if (!(mcpEnabled ?? true)) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const mcpHub = await McpServerManager.getInstance(provider.context, provider)
			if (!mcpHub) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const servers = mcpHub.getServers()
			return countEnabledMcpTools(servers)
		} catch (error) {
			console.error("[Task#getEnabledMcpToolsCount] Error counting MCP tools:", error)
			return { enabledToolCount: 0, enabledServerCount: 0 }
		}
	}

	/**
	 * Manually start a **new** task when it was created with `startTask: false`.
	 *
	 * This fires `startTask` as a background async operation for the
	 * `task/images` code-path only.  It does **not** handle the
	 * `historyItem` resume path (use the constructor with `startTask: true`
	 * for that).  The primary use-case is in the delegation flow where the
	 * parent's metadata must be persisted to globalState **before** the
	 * child task begins writing its own history (avoiding a read-modify-write
	 * race on globalState).
	 */
	public start(): void {
		if (this._started) {
			return
		}
		this._started = true

		const { task, images } = this.metadata

		if (task || images) {
			this.startTask(task ?? undefined, images ?? undefined)
		}
	}

	private async startTask(task?: string, images?: string[]): Promise<void> {
		try {
			// `conversationHistory` (for API) and `clineMessages` (for webview)
			// need to be in sync.
			// If the extension process were killed, then on restart the
			// `clineMessages` might not be empty, so we need to set it to [] when
			// we create a new Alpha client (otherwise webview would show stale
			// messages from previous session).
			this.clineMessages = []
			this.apiConversationHistory = []

			// The todo list is already set in the constructor if initialTodos were provided
			// No need to add any messages - the todoList property is already set

			await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

			await this.say("text", task, images)

			// Check for too many MCP tools and warn the user
			const { enabledToolCount, enabledServerCount } = await this.getEnabledMcpToolsCount()
			if (enabledToolCount > MAX_MCP_TOOLS_THRESHOLD) {
				await this.say(
					"too_many_tools_warning",
					JSON.stringify({
						toolCount: enabledToolCount,
						serverCount: enabledServerCount,
						threshold: MAX_MCP_TOOLS_THRESHOLD,
					}),
					undefined,
					undefined,
					undefined,
					undefined,
					{ isNonInteractive: true },
				)
			}
			this.isInitialized = true

			const imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

			// Task starting
			await this.initiateTaskLoop([
				{
					type: "text",
					text: `<user_message>\n${task}\n</user_message>`,
				},
				...imageBlocks,
			]).catch((error) => {
				// Swallow loop rejection when the task was intentionally abandoned/aborted
				// during delegation or user cancellation to prevent unhandled rejections.
				if (this.abandoned === true || this.abortReason === "user_cancelled") {
					return
				}
				throw error
			})
		} catch (error) {
			// In tests and some UX flows, tasks can be aborted while `startTask` is still
			// initializing. Treat abort/abandon as expected and avoid unhandled rejections.
			if (this.abandoned === true || this.abort === true || this.abortReason === "user_cancelled") {
				return
			}
			throw error
		}
	}

	private async resumeTaskFromHistory() {
		try {
			const modifiedClineMessages = await this.getSavedClineMessages()

			// Remove any resume messages that may have been added before.
			const lastRelevantMessageIndex = findLastIndex(
				modifiedClineMessages,
				(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
			)

			if (lastRelevantMessageIndex !== -1) {
				modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
			}

			// Remove any trailing reasoning-only UI messages that were not part of the persisted API conversation
			while (modifiedClineMessages.length > 0) {
				const last = modifiedClineMessages[modifiedClineMessages.length - 1]
				if (last.type === "say" && last.say === "reasoning") {
					modifiedClineMessages.pop()
				} else {
					break
				}
			}

			// Since we don't use `api_req_finished` anymore, we need to check if the
			// last `api_req_started` has a cost value, if it doesn't and no
			// cancellation reason to present, then we remove it since it indicates
			// an api request without any partial content streamed.
			const lastApiReqStartedIndex = findLastIndex(
				modifiedClineMessages,
				(m) => m.type === "say" && m.say === "api_req_started",
			)

			if (lastApiReqStartedIndex !== -1) {
				const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
				const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")

				if (cost === undefined && cancelReason === undefined) {
					modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
				}
			}

			await this.overwriteClineMessages(modifiedClineMessages)
			this.clineMessages = await this.getSavedClineMessages()

			// Now present the cline messages to the user and ask if they want to
			// resume (NOTE: we ran into a bug before where the
			// apiConversationHistory wouldn't be initialized when opening a old
			// task, and it was because we were waiting for resume).
			// This is important in case the user deletes messages without resuming
			// the task first.
			this.apiConversationHistory = await this.getSavedApiConversationHistory()

			const lastClineMessage = this.clineMessages
				.slice()
				.reverse()
				.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // Could be multiple resume tasks.

			let askType: ClineAsk
			if (lastClineMessage?.ask === "completion_result") {
				askType = "resume_completed_task"
			} else {
				askType = "resume_task"
			}

			this.isInitialized = true

			const { response, text, images } = await this.ask(askType) // Calls `postStateToWebview`.

			let responseText: string | undefined
			let responseImages: string[] | undefined

			if (response === "messageResponse") {
				await this.say("user_feedback", text, images)
				responseText = text
				responseImages = images
			}

			// Make sure that the api conversation history can be resumed by the API,
			// even if it goes out of sync with cline messages.
			let existingApiConversationHistory: ApiMessage[] = await this.getSavedApiConversationHistory()

			// Tool blocks are always preserved; native tool calling only.

			// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
			// if there's no tool use and only a text block, then we can just add a user message
			// (note this isn't relevant anymore since we use custom tool prompts instead of tool use blocks, but this is here for legacy purposes in case users resume old tasks)

			// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

			let modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[] // either the last message if its user message, or the user message before the last (assistant) message
			let modifiedApiConversationHistory: ApiMessage[] // need to remove the last user message to replace with new modified user message
			if (existingApiConversationHistory.length > 0) {
				const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

				if (lastMessage.isSummary) {
					// IMPORTANT: If the last message is a condensation summary, we must preserve it
					// intact. The summary message carries critical metadata (isSummary, condenseId)
					// that getEffectiveApiHistory() uses to filter out condensed messages.
					// Removing or merging it would destroy this metadata, causing all condensed
					// messages to become "orphaned" and restored to active status — effectively
					// undoing the condensation and sending the full history to the API.
					// See: https://github.com/AlphaInc/Alpha/issues/11487
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				} else if (lastMessage.role === "assistant") {
					const content = Array.isArray(lastMessage.content)
						? lastMessage.content
						: [{ type: "text", text: lastMessage.content }]
					const hasToolUse = content.some((block) => block.type === "tool_use")

					if (hasToolUse) {
						const toolUseBlocks = content.filter(
							(block) => block.type === "tool_use",
						) as Anthropic.Messages.ToolUseBlock[]
						const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
							type: "tool_result",
							tool_use_id: block.id,
							content: "Task was interrupted before this tool call could be completed.",
						}))
						modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
						modifiedOldUserContent = [...toolResponses]
					} else {
						modifiedApiConversationHistory = [...existingApiConversationHistory]
						modifiedOldUserContent = []
					}
				} else if (lastMessage.role === "user") {
					const previousAssistantMessage: ApiMessage | undefined =
						existingApiConversationHistory[existingApiConversationHistory.length - 2]

					const existingUserContent: Anthropic.Messages.ContentBlockParam[] = Array.isArray(
						lastMessage.content,
					)
						? lastMessage.content
						: [{ type: "text", text: lastMessage.content }]
					if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
						const assistantContent = Array.isArray(previousAssistantMessage.content)
							? previousAssistantMessage.content
							: [{ type: "text", text: previousAssistantMessage.content }]

						const toolUseBlocks = assistantContent.filter(
							(block) => block.type === "tool_use",
						) as Anthropic.Messages.ToolUseBlock[]

						if (toolUseBlocks.length > 0) {
							const existingToolResults = existingUserContent.filter(
								(block) => block.type === "tool_result",
							) as Anthropic.ToolResultBlockParam[]

							const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
								.filter(
									(toolUse) =>
										!existingToolResults.some((result) => result.tool_use_id === toolUse.id),
								)
								.map((toolUse) => ({
									type: "tool_result",
									tool_use_id: toolUse.id,
									content: "Task was interrupted before this tool call could be completed.",
								}))

							modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
							modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
						} else {
							modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
							modifiedOldUserContent = [...existingUserContent]
						}
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					throw new Error("Unexpected: Last message is not a user or assistant message")
				}
			} else {
				throw new Error("Unexpected: No existing API conversation history")
			}

			let newUserContent: Anthropic.Messages.ContentBlockParam[] = [...modifiedOldUserContent]

			const agoText = ((): string => {
				const timestamp = lastClineMessage?.ts ?? Date.now()
				const now = Date.now()
				const diff = now - timestamp
				const minutes = Math.floor(diff / 60000)
				const hours = Math.floor(minutes / 60)
				const days = Math.floor(hours / 24)

				if (days > 0) {
					return `${days} day${days > 1 ? "s" : ""} ago`
				}
				if (hours > 0) {
					return `${hours} hour${hours > 1 ? "s" : ""} ago`
				}
				if (minutes > 0) {
					return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
				}
				return "just now"
			})()

			if (responseText) {
				newUserContent.push({
					type: "text",
					text: `<user_message>\n${responseText}\n</user_message>`,
				})
			}

			if (responseImages && responseImages.length > 0) {
				newUserContent.push(...formatResponse.imageBlocks(responseImages))
			}

			// Ensure we have at least some content to send to the API.
			// If newUserContent is empty, add a minimal resumption message.
			if (newUserContent.length === 0) {
				newUserContent.push({
					type: "text",
					text: "[TASK RESUMPTION] Resuming task...",
				})
			}

			await this.overwriteApiConversationHistory(modifiedApiConversationHistory)

			// Task resuming from history item.
			await this.initiateTaskLoop(newUserContent)
		} catch (error) {
			// Resume and cancellation can race when users issue repeated cancels.
			// Treat intentional abort/abandon flows as expected and avoid process-level crashes.
			if (this.abandoned === true || this.abort === true || this.abortReason === "user_cancelled") {
				return
			}
			throw error
		}
	}

	/**
	 * Cancels the current HTTP request if one is in progress.
	 * This immediately aborts the underlying stream rather than waiting for the next chunk.
	 */
	public cancelCurrentRequest(): void {
		if (this.currentRequestAbortController) {
			console.log(`[Task#${this.taskId}.${this.instanceId}] Aborting current HTTP request`)
			this.currentRequestAbortController.abort()
			this.currentRequestAbortController = undefined
		}
	}

	/**
	 * Force emit a final token usage update, ignoring throttle.
	 * Called before task completion or abort to ensure final stats are captured.
	 * Triggers the debounce with current values and immediately flushes to ensure emit.
	 */
	public emitFinalTokenUsageUpdate(): void {
		const tokenUsage = this.getTokenUsage()
		this.debouncedEmitTokenUsage(tokenUsage, this.toolUsage)
		this.debouncedEmitTokenUsage.flush()
	}

	public async abortTask(isAbandoned = false) {
		// Aborting task

		// Will stop any autonomously running promises.
		if (isAbandoned) {
			this.abandoned = true
		}

		this.abort = true
		this.taskAbortController.abort()
		void this.recordAgentTurnEvent({ type: "cancelled", reason: this.abortReason ?? "user_cancelled" })

		// Reset consecutive error counters on abort (manual intervention)
		this.consecutiveNoToolUseCount = 0
		this.consecutiveNoAssistantMessagesCount = 0

		// Force final token usage update before abort event
		this.emitFinalTokenUsageUpdate()

		this.emit(RooCodeEventName.TaskAborted)

		try {
			this.dispose() // Call the centralized dispose method
		} catch (error) {
			console.error(`Error during task ${this.taskId}.${this.instanceId} disposal:`, error)
			// Don't rethrow - we want abort to always succeed
		}
		// Save the countdown message in the automatic retry or other content.
		try {
			// Save the countdown message in the automatic retry or other content.
			await this.saveClineMessages()
		} catch (error) {
			console.error(`Error saving messages during abort for task ${this.taskId}.${this.instanceId}:`, error)
		}
	}

	public dispose(): void {
		console.log(`[Task#dispose] disposing task ${this.taskId}.${this.instanceId}`)
		this.taskCancellationController.abort()

		// Cancel any in-progress HTTP request
		try {
			this.cancelCurrentRequest()
		} catch (error) {
			console.error("Error cancelling current request:", error)
		}

		// Dispose message queue and remove event listeners.
		try {
			if (this.messageQueueStateChangedHandler) {
				this.messageQueueService.removeListener("stateChanged", this.messageQueueStateChangedHandler)
				this.messageQueueStateChangedHandler = undefined
			}

			this.messageQueueService.dispose()
		} catch (error) {
			console.error("Error disposing message queue:", error)
		}

		// Remove all event listeners to prevent memory leaks.
		try {
			this.removeAllListeners()
		} catch (error) {
			console.error("Error removing event listeners:", error)
		}

		// Release any terminals associated with this task.
		try {
			// Release any terminals associated with this task.
			TerminalRegistry.releaseTerminalsForTask(this.taskId)
		} catch (error) {
			console.error("Error releasing terminals:", error)
		}

		// Cleanup command output artifacts
		getTaskDirectoryPath(this.globalStoragePath, this.taskId)
			.then((taskDir) => {
				const outputDir = path.join(taskDir, "command-output")
				return OutputInterceptor.cleanup(outputDir)
			})
			.catch((error) => {
				console.error("Error cleaning up command output artifacts:", error)
			})

		try {
			if (this.rooIgnoreController) {
				this.rooIgnoreController.dispose()
				this.rooIgnoreController = undefined
			}
		} catch (error) {
			console.error("Error disposing RooIgnoreController:", error)
			// This is the critical one for the leak fix.
		}

		try {
			this.fileContextTracker.dispose()
		} catch (error) {
			console.error("Error disposing file context tracker:", error)
		}

		try {
			// If we're not streaming then `abortStream` won't be called.
			if (this.isStreaming && this.diffViewProvider.isEditing) {
				this.diffViewProvider.revertChanges().catch(console.error)
			}
		} catch (error) {
			console.error("Error reverting diff changes:", error)
		}
	}

	// Subtasks
	// Spawn / Wait / Complete

	public async startSubtask(message: string, initialTodos: TodoItem[], mode: string) {
		const provider = this.providerRef.deref()

		if (!provider) {
			throw new Error("Provider not available")
		}

		const child = await (provider as any).delegateParentAndOpenChild({
			parentTaskId: this.taskId,
			message,
			initialTodos,
			mode,
		})
		return child
	}

	/**
	 * Resume parent task after delegation completion without showing resume ask.
	 * Used in metadata-driven subtask flow.
	 *
	 * This method:
	 * - Clears any pending ask states
	 * - Resets abort and streaming flags
	 * - Ensures next API call includes full context
	 * - Immediately continues task loop without user interaction
	 */
	public async resumeAfterDelegation(): Promise<void> {
		// Clear any ask states that might have been set during history load
		this.idleAsk = undefined
		this.resumableAsk = undefined
		this.interactiveAsk = undefined

		// Reset abort and streaming state to ensure clean continuation
		this.abort = false
		this.abandoned = false
		this.abortReason = undefined
		this.didFinishAbortingStream = false
		this.isStreaming = false
		this.isWaitingForFirstChunk = false

		// Ensure next API call includes full context after delegation
		this.skipPrevResponseIdOnce = true

		// Mark as initialized and active
		this.isInitialized = true
		this.emit(RooCodeEventName.TaskActive, this.taskId)

		// Load conversation history if not already loaded
		if (this.apiConversationHistory.length === 0) {
			this.apiConversationHistory = await this.getSavedApiConversationHistory()
		}

		// Add environment details to the existing last user message (which contains the tool_result)
		// This avoids creating a new user message which would cause consecutive user messages
		const environmentDetails = await getEnvironmentDetails(this, true)
		let lastUserMsgIndex = -1
		for (let i = this.apiConversationHistory.length - 1; i >= 0; i--) {
			if (this.apiConversationHistory[i].role === "user") {
				lastUserMsgIndex = i
				break
			}
		}
		if (lastUserMsgIndex >= 0) {
			const lastUserMsg = this.apiConversationHistory[lastUserMsgIndex]
			if (Array.isArray(lastUserMsg.content)) {
				// Remove any existing environment_details blocks before adding fresh ones
				const contentWithoutEnvDetails = lastUserMsg.content.filter(
					(block: Anthropic.Messages.ContentBlockParam) => {
						if (block.type === "text" && typeof block.text === "string") {
							const isEnvironmentDetailsBlock =
								block.text.trim().startsWith("<environment_details>") &&
								block.text.trim().endsWith("</environment_details>")
							return !isEnvironmentDetailsBlock
						}
						return true
					},
				)
				// Add fresh environment details
				lastUserMsg.content = [...contentWithoutEnvDetails, { type: "text" as const, text: environmentDetails }]
			}
		}

		// Save the updated history
		await this.saveApiConversationHistory()

		// Continue task loop - pass empty array to signal no new user content needed
		// The initiateTaskLoop will handle this by skipping user message addition
		await this.initiateTaskLoop([])
	}

	// Task Loop

	private async initiateTaskLoop(userContent: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		// Kicks off the checkpoints initialization process in the background.
		getCheckpointService(this)

		this.emit(RooCodeEventName.TaskStarted)

		type TaskTurnInput = {
			userContent: Anthropic.Messages.ContentBlockParam[]
			includeFileDetails: boolean
		}

		const host: AgentTurnHost<TaskTurnInput> = {
			shouldAbort: () => this.abort,
			runStep: async (input) => {
				const didEndLoop = await this.recursivelyMakeClineRequests(input.userContent, input.includeFileDetails)
				const response = this.buildCurrentAgentResponse()
				// Real provider turns always set this in attemptApiRequest. The
				// compatibility fallback keeps tests and older internal callers that
				// stub recursivelyMakeClineRequests inside the host contract valid.
				const context = this.completedStepContext ?? this.createCompatibilityStepContext()
				const hasToolActivity = response.items.some((item) => item.type === "tool_call")

				if (!this.abort && !this.didComplete && this.hasPendingChildVerification() && !hasToolActivity) {
					return {
						response,
						context,
						nextInput: {
							userContent: [
								{
									type: "text",
									text: "A child changed the workspace. Review the changed files and run an appropriate verification command before completing.",
								},
							],
							includeFileDetails: false,
						},
					}
				}

				if (!didEndLoop && !this.abort && !this.didComplete && !hasToolActivity) {
					await this.publishImplicitCompletionResult(response)
				}

				if (didEndLoop || this.abort || this.didComplete || !hasToolActivity) {
					return { response, context, nextInput: "complete" }
				}

				const nextUserContent = [...this.userMessageContent]

				return {
					response,
					context,
					nextInput: {
						userContent: nextUserContent,
						includeFileDetails: false,
					},
				}
			},
		}

		const outcome = await new AgentTurnEngine(host).run({ userContent, includeFileDetails: true })
		if (outcome.status === "completed") {
			this.finalizeCompletion()
		}
		await this.recordAgentTurnEvent({
			type: "task_completed",
			status: outcome.status,
			toolCallCount: this.completedAgentResponse?.toolCalls.length ?? 0,
			retryCount: this.lastAgentTurnRetryCount,
		})
	}

	public async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		interface StackItem {
			userContent: Anthropic.Messages.ContentBlockParam[]
			includeFileDetails: boolean
			retryAttempt?: number
			userMessageWasRemoved?: boolean // Track if user message was removed due to empty response
		}

		const stack: StackItem[] = [{ userContent, includeFileDetails, retryAttempt: 0 }]
		const wasTaskLoopActive = this.isTaskLoopActive
		this.isTaskLoopActive = true

		try {
			while (stack.length > 0) {
				if (this.didComplete) {
					return true
				}

				const currentItem = stack.pop()!
				const currentUserContent = currentItem.userContent
				const currentIncludeFileDetails = currentItem.includeFileDetails

				if (this.abort) {
					throw new Error(
						`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`,
					)
				}

				const pendingSteer = this.pendingSteerMessage
				if (pendingSteer) {
					this.pendingSteerMessage = undefined
					await this.say("user_feedback", pendingSteer.text, pendingSteer.images)
					stack.push({
						userContent: [
							...currentUserContent,
							...this.buildUserMessageContent(pendingSteer.text, pendingSteer.images),
						],
						includeFileDetails: currentIncludeFileDetails,
						retryAttempt: currentItem.retryAttempt,
						userMessageWasRemoved: currentItem.userMessageWasRemoved,
					})
					continue
				}

				if (this.consecutiveMistakeLimit > 0 && this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
					await this.handleConsecutiveMistakeLimit(currentUserContent)
				}

				// Getting verbose details is an expensive operation, it uses ripgrep to
				// top-down build file structure of project which for large projects can
				// take a few seconds. For the best UX we show a placeholder api_req_started
				// message with a loading spinner as this happens.

				// Determine API protocol based on provider and model
				const modelId = getModelId(this.apiConfiguration)
				const apiProvider = this.apiConfiguration.apiProvider
				const apiProtocol = getApiProtocol(
					apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
					modelId,
				)

				// Respect user-configured provider rate limiting BEFORE we emit api_req_started.
				// This prevents the UI from showing an "API Request..." spinner while we are
				// intentionally waiting due to the rate limit slider.
				//
				// NOTE: We also set Task.lastGlobalApiRequestTime here to reserve this slot
				// before we build environment details (which can take time).
				// This ensures subsequent requests (including subtasks) still honour the
				// provider rate-limit window.
				await this.maybeWaitForProviderRateLimit(currentItem.retryAttempt ?? 0)
				Task.lastGlobalApiRequestTime = performance.now()

				await this.say(
					"api_req_started",
					JSON.stringify({
						apiProtocol,
					}),
				)

				const provider = this.providerRef.deref()
				const state = provider ? await provider.getState() : undefined

				const showRooIgnoredFiles = state?.showRooIgnoredFiles ?? false
				const includeDiagnosticMessages = state?.includeDiagnosticMessages ?? true
				const maxDiagnosticMessages = state?.maxDiagnosticMessages ?? 50
				const currentMode = await this.getTaskMode()

				const { content: parsedUserContent, mode: slashCommandMode } = await processUserContentMentions({
					userContent: currentUserContent,
					cwd: this.cwd,
					fileContextTracker: this.fileContextTracker,
					rooIgnoreController: this.rooIgnoreController,
					showRooIgnoredFiles,
					includeDiagnosticMessages,
					maxDiagnosticMessages,
					skillsManager: provider?.getSkillsManager(),
					currentMode,
				})

				// Switch mode if specified in a slash command's frontmatter
				if (slashCommandMode) {
					const provider = this.providerRef.deref()
					if (provider) {
						const state = await provider.getState()
						const targetMode = getModeBySlug(slashCommandMode, state?.customModes)
						if (targetMode) {
							await provider.setTaskMode(this.taskId, slashCommandMode)
						}
					}
				}

				// Some legacy task tests and extension hosts mock only the string
				// renderer. Keep the compatibility fallback while all production
				// requests use the typed boundary capture.
				const environmentSnapshot =
					typeof collectEnvironmentSnapshot === "function"
						? await collectEnvironmentSnapshot(this, currentIncludeFileDetails)
						: await (async () => {
								const renderedDetails = await getEnvironmentDetails(this, currentIncludeFileDetails)
								return {
									stable: { workspaceRoot: this.cwd, roots: [this.cwd], capabilities: [] },
									volatile: { renderedDetails, capturedAt: Date.now() },
									renderedDetails,
								}
							})()
				const environmentDetails = environmentSnapshot.renderedDetails
				this.currentStepEnvironmentSnapshot = environmentSnapshot
				this.currentStepEnvironmentDetails = environmentDetails
				await this.recordAgentTurnEvent(
					{
						type: "context_refreshed",
						stableDigest: digestValue(environmentSnapshot.stable),
						volatileDigest: digestValue(environmentSnapshot.volatile),
					},
					this.completedStepContext,
				)

				// Remove any existing environment_details blocks before adding fresh ones.
				// This prevents duplicate environment details when resuming tasks,
				// where the old user message content may already contain environment details from the previous session.
				// We check for both opening and closing tags to ensure we're matching complete environment detail blocks,
				// not just mentions of the tag in regular content.
				const contentWithoutEnvDetails = parsedUserContent.filter((block) => {
					if (block.type === "text" && typeof block.text === "string") {
						// Check if this text block is a complete environment_details block
						// by verifying it starts with the opening tag and ends with the closing tag
						const isEnvironmentDetailsBlock =
							block.text.trim().startsWith("<environment_details>") &&
							block.text.trim().endsWith("</environment_details>")
						return !isEnvironmentDetailsBlock
					}
					return true
				})

				// Add environment details as its own text block, separate from tool
				// results.
				let finalUserContent = [
					...contentWithoutEnvDetails,
					{ type: "text" as const, text: environmentDetails },
				]
				// Only add user message to conversation history if:
				// 1. This is the first attempt (retryAttempt === 0), AND
				// 2. The original userContent was not empty (empty signals delegation resume where
				//    the user message with tool_result and env details is already in history), OR
				// 3. The message was removed in a previous iteration (userMessageWasRemoved === true)
				// This prevents consecutive user messages while allowing re-add when needed
				const isEmptyUserContent = currentUserContent.length === 0
				const shouldAddUserMessage =
					((currentItem.retryAttempt ?? 0) === 0 && !isEmptyUserContent) || currentItem.userMessageWasRemoved
				if (shouldAddUserMessage) {
					await this.addToApiConversationHistory({ role: "user", content: finalUserContent })
					TelemetryService.instance.captureConversationMessage(this.taskId, "user")
				}

				// Since we sent off a placeholder api_req_started message to update the
				// webview while waiting to actually start the API request (to load
				// potential details for example), we need to update the text of that
				// message.
				const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

				this.clineMessages[lastApiReqIndex].text = JSON.stringify({
					apiProtocol,
				} satisfies ClineApiReqInfo)

				await this.saveClineMessages()
				await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

				try {
					let cacheWriteTokens = 0
					let cacheReadTokens = 0
					let inputTokens = 0
					let outputTokens = 0
					let totalCost: number | undefined

					// We can't use `api_req_finished` anymore since it's a unique case
					// where it could come after a streaming message (i.e. in the middle
					// of being updated or executed).
					// Fortunately `api_req_finished` was always parsed out for the GUI
					// anyways, so it remains solely for legacy purposes to keep track
					// of prices in tasks from history (it's worth removing a few months
					// from now).
					const updateApiReqMsg = (
						cancelReason?: ClineApiReqCancelReason,
						streamingFailedMessage?: string,
					) => {
						if (lastApiReqIndex < 0 || !this.clineMessages[lastApiReqIndex]) {
							return
						}

						const existingData = JSON.parse(this.clineMessages[lastApiReqIndex].text || "{}")

						// Calculate total tokens and cost using provider-aware function
						const modelId = getModelId(this.apiConfiguration)
						const apiProvider = this.apiConfiguration.apiProvider
						const apiProtocol = getApiProtocol(
							apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
							modelId,
						)

						const costResult =
							apiProtocol === "anthropic"
								? calculateApiCostAnthropic(
										streamModelInfo,
										inputTokens,
										outputTokens,
										cacheWriteTokens,
										cacheReadTokens,
									)
								: calculateApiCostOpenAI(
										streamModelInfo,
										inputTokens,
										outputTokens,
										cacheWriteTokens,
										cacheReadTokens,
									)

						this.clineMessages[lastApiReqIndex].text = JSON.stringify({
							...existingData,
							tokensIn: costResult.totalInputTokens,
							tokensOut: costResult.totalOutputTokens,
							cacheWrites: cacheWriteTokens,
							cacheReads: cacheReadTokens,
							cost: totalCost ?? costResult.totalCost,
							cancelReason,
							streamingFailedMessage,
						} satisfies ClineApiReqInfo)
					}

					const abortStream = async (
						cancelReason: ClineApiReqCancelReason,
						streamingFailedMessage?: string,
					) => {
						if (this.diffViewProvider.isEditing) {
							await this.diffViewProvider.revertChanges() // closes diff view
						}

						// if last message is a partial we need to update and save it
						const lastMessage = this.clineMessages.at(-1)

						if (lastMessage && lastMessage.partial) {
							// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
							lastMessage.partial = false
							// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
						}

						// Update `api_req_started` to have cancelled and cost, so that
						// we can display the cost of the partial stream and the cancellation reason
						updateApiReqMsg(cancelReason, streamingFailedMessage)
						await this.saveClineMessages()

						// Signals to provider that it can retrieve the saved messages
						// from disk, as abortTask can not be awaited on in nature.
						this.didFinishAbortingStream = true
					}

					// Reset streaming state for each new API request
					this.currentStreamingContentIndex = 0
					this.currentStreamingDidCheckpoint = false
					this.assistantMessageContent = []
					this.didCompleteReadingStream = false
					this.userMessageContent = []
					this.userMessageContentReady = false
					this.didRejectTool = false
					this.didAlreadyUseTool = false
					this.assistantMessageSavedToHistory = false
					this.completedAgentResponse = undefined
					this.completedStepContext = undefined
					this.lastAgentTurnRetryCount = 0
					// Reset tool failure flag for each new assistant turn - this ensures that tool failures
					// only prevent attempt_completion within the same assistant message, not across turns
					// (e.g., if a tool fails, then user sends a message saying "just complete anyway")
					this.didToolFailInCurrentTurn = false
					this.presentAssistantMessageLocked = false
					this.presentAssistantMessageHasPendingUpdates = false
					// Clear any leftover streaming tool call state from previous interrupted streams.
					// The normalizer owns response buffering; these clears protect any
					// provider/parser state retained by the native tool parser.
					NativeToolCallParser.clearAllStreamingToolCalls(this.taskId)
					NativeToolCallParser.clearRawChunkState(this.taskId)

					await this.diffViewProvider.reset()

					// Cache model info once per API request to avoid repeated calls during streaming
					// This is especially important for tools and background usage collection
					this.cachedStreamingModel = this.api.getModel()
					const streamModelInfo = this.cachedStreamingModel.info
					const cachedModelId = this.cachedStreamingModel.id

					// Yields only if the first chunk is successful, otherwise will
					// allow the user to retry the request (most likely due to rate
					// limit error, which gets thrown on the first chunk).
					const stream = this.attemptApiRequest(currentItem.retryAttempt ?? 0, {
						skipProviderRateLimit: true,
					})
					let assistantMessage = ""
					let reasoningMessage = ""
					let pendingGroundingSources: GroundingSource[] = []
					const responseAccumulator = new AgentResponseAccumulator()
					this.beginStreamingBoundary()
					this.isStreaming = true

					const appendInvalidToolUse = (id: string, name: string) => {
						const alreadyStaged = this.assistantMessageContent.some(
							(block) => (block.type === "tool_use" || block.type === "mcp_tool_use") && block.id === id,
						)
						if (alreadyStaged) {
							return
						}

						const invalidToolUse: ToolUse = {
							type: "tool_use",
							name: name as ToolName,
							params: {},
							partial: false,
							id,
						}
						this.assistantMessageContent.push(invalidToolUse)
						this.userMessageContentReady = false
					}

					const consumeResponseItem = async (responseItem: AgentResponseItem): Promise<void> => {
						switch (responseItem.type) {
							case "reasoning": {
								reasoningMessage += responseItem.text
								let formattedReasoning = reasoningMessage
								if (reasoningMessage.includes("**")) {
									formattedReasoning = reasoningMessage.replace(
										/([.!?])\*\*([^*\n]+)\*\*/g,
										"$1\n\n**$2**",
									)
								}
								await this.say("reasoning", formattedReasoning, undefined, true)
								break
							}
							case "usage":
								inputTokens += responseItem.inputTokens
								outputTokens += responseItem.outputTokens
								cacheWriteTokens += responseItem.cacheWriteTokens ?? 0
								cacheReadTokens += responseItem.cacheReadTokens ?? 0
								totalCost = responseItem.totalCost
								break
							case "grounding":
								if (responseItem.sources.length > 0) {
									pendingGroundingSources.push(...responseItem.sources)
								}
								break
							case "tool_call": {
								const toolUse = NativeToolCallParser.parseToolCall({
									id: responseItem.id,
									name: responseItem.name as ToolName,
									arguments: JSON.stringify(responseItem.arguments) ?? "{}",
								})

								if (!toolUse) {
									appendInvalidToolUse(responseItem.id, responseItem.name)
									break
								}

								const lastBlock = this.assistantMessageContent[this.assistantMessageContent.length - 1]
								if (lastBlock?.type === "text" && lastBlock.partial) {
									lastBlock.partial = false
								}

								toolUse.id = responseItem.id
								this.assistantMessageContent.push(toolUse)
								this.userMessageContentReady = false
								break
							}
							case "error":
								if (responseItem.callId && responseItem.toolName) {
									appendInvalidToolUse(responseItem.callId, responseItem.toolName)
								} else {
									console.error(`[Task#${this.taskId}] Agent response error: ${responseItem.message}`)
								}
								break
							case "text": {
								assistantMessage += responseItem.text
								const lastTextBlock =
									this.assistantMessageContent[this.assistantMessageContent.length - 1]
								if (lastTextBlock?.type === "text" && lastTextBlock.partial) {
									lastTextBlock.content = assistantMessage
								} else {
									this.assistantMessageContent.push({
										type: "text",
										content: assistantMessage,
										partial: true,
									})
									this.userMessageContentReady = false
								}
								// Stream text directly. The compatibility presenter also owns
								// complete-tool execution, so it must not be involved while a
								// response is still being assembled.
								const visibleText = assistantMessage
									.replace(/<thinking>\s?/g, "")
									.replace(/\s?<\/thinking>/g, "")
								await this.say("text", visibleText, undefined, true)
								break
							}
						}
					}

					try {
						const iterator = stream[Symbol.asyncIterator]()

						// Helper to race iterator.next() with abort signal and the configured API timeout.
						const nextChunkWithAbort = async (
							operationName = `API response stream for ${cachedModelId}`,
							timeoutMs = getApiRequestTimeout(),
						) => {
							const nextPromise = iterator.next()
							let removeAbortListener: (() => void) | undefined

							// If we have an abort controller, race it with the next chunk
							const abortPromise = this.currentRequestAbortController
								? new Promise<never>((_, reject) => {
										const signal = this.currentRequestAbortController!.signal
										const onAbort = () => reject(new Error("Request cancelled by user"))
										if (signal.aborted) {
											onAbort()
										} else {
											signal.addEventListener("abort", onAbort, { once: true })
											removeAbortListener = () => signal.removeEventListener("abort", onAbort)
										}
									})
								: undefined

							const operation = abortPromise ? Promise.race([nextPromise, abortPromise]) : nextPromise

							try {
								return await withApiRequestTimeout(operation, operationName, timeoutMs, () => {
									this.currentRequestAbortController?.abort()
									const iteratorReturn = iterator.return?.(undefined)
									if (iteratorReturn) {
										void Promise.resolve(iteratorReturn).catch((error) => {
											console.warn("Failed to close stalled API response stream:", error)
										})
									}
								})
							} finally {
								removeAbortListener?.()
							}
						}

						let item = await nextChunkWithAbort()
						while (!item.done) {
							const chunk = item.value
							if (!chunk) {
								// Sometimes chunk is undefined, no idea that can cause
								// it, but this workaround seems to fix it.
								item = await nextChunkWithAbort()
								continue
							}

							await responseAccumulator.add(chunk, consumeResponseItem)

							if (this.abort) {
								console.log(`aborting stream, this.abandoned = ${this.abandoned}`)

								if (!this.abandoned) {
									// Only need to gracefully abort if this instance
									// isn't abandoned (sometimes OpenRouter stream
									// hangs, in which case this would affect future
									// instances of Alpha).
									await abortStream("user_cancelled")
								}

								break // Aborts the stream.
							}

							if (this.didRejectTool) {
								// `userContent` has a tool rejection, so interrupt the
								// assistant's response to present the user's feedback.
								assistantMessage += "\n\n[Response interrupted by user feedback]"
								// Instead of setting this preemptively, we allow the
								// present iterator to finish and set
								// userMessageContentReady when its ready.
								// this.userMessageContentReady = true
								break
							}

							item = await nextChunkWithAbort()
						}

						// Create a copy of current token values to avoid race conditions
						const currentTokens = {
							input: inputTokens,
							output: outputTokens,
							cacheWrite: cacheWriteTokens,
							cacheRead: cacheReadTokens,
							total: totalCost,
						}

						const drainStreamInBackgroundToFindAllUsage = async (apiReqIndex: number) => {
							const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS
							const startTime = performance.now()
							const modelId = getModelId(this.apiConfiguration)

							// Local variables to accumulate usage data without affecting the main flow
							let bgInputTokens = currentTokens.input
							let bgOutputTokens = currentTokens.output
							let bgCacheWriteTokens = currentTokens.cacheWrite
							let bgCacheReadTokens = currentTokens.cacheRead
							let bgTotalCost = currentTokens.total

							// Helper function to capture telemetry and update messages
							const captureUsageData = async (
								tokens: {
									input: number
									output: number
									cacheWrite: number
									cacheRead: number
									total?: number
								},
								messageIndex: number = apiReqIndex,
							) => {
								if (
									tokens.input > 0 ||
									tokens.output > 0 ||
									tokens.cacheWrite > 0 ||
									tokens.cacheRead > 0
								) {
									// Update the shared variables atomically
									inputTokens = tokens.input
									outputTokens = tokens.output
									cacheWriteTokens = tokens.cacheWrite
									cacheReadTokens = tokens.cacheRead
									totalCost = tokens.total

									// Update the API request message with the latest usage data
									updateApiReqMsg()
									await this.saveClineMessages()

									// Update the specific message in the webview
									const apiReqMessage = this.clineMessages[messageIndex]
									if (apiReqMessage) {
										await this.updateClineMessage(apiReqMessage)
									}

									// Capture telemetry with provider-aware cost calculation
									const modelId = getModelId(this.apiConfiguration)
									const apiProvider = this.apiConfiguration.apiProvider
									const apiProtocol = getApiProtocol(
										apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
										modelId,
									)

									// Use the appropriate cost function based on the API protocol
									const costResult =
										apiProtocol === "anthropic"
											? calculateApiCostAnthropic(
													streamModelInfo,
													tokens.input,
													tokens.output,
													tokens.cacheWrite,
													tokens.cacheRead,
												)
											: calculateApiCostOpenAI(
													streamModelInfo,
													tokens.input,
													tokens.output,
													tokens.cacheWrite,
													tokens.cacheRead,
												)

									TelemetryService.instance.captureLlmCompletion(this.taskId, {
										inputTokens: costResult.totalInputTokens,
										outputTokens: costResult.totalOutputTokens,
										cacheWriteTokens: tokens.cacheWrite,
										cacheReadTokens: tokens.cacheRead,
										cost: tokens.total ?? costResult.totalCost,
									})
								}
							}

							try {
								// Continue processing the original stream from where the main loop left off
								let usageFound = false
								let chunkCount = 0

								// Use the same iterator that the main loop was using
								while (!item.done) {
									// Check for timeout
									if (performance.now() - startTime > timeoutMs) {
										console.warn(
											`[Background Usage Collection] Timed out after ${timeoutMs}ms for model: ${modelId}, processed ${chunkCount} chunks`,
										)
										// Clean up the iterator before breaking
										if (iterator.return) {
											await iterator.return(undefined)
										}
										break
									}

									const chunk = item.value
									const remainingTimeoutMs = timeoutMs - (performance.now() - startTime)
									item = await nextChunkWithAbort(
										`Background usage collection stream for ${modelId}`,
										remainingTimeoutMs,
									)
									chunkCount++

									if (chunk && chunk.type === "usage") {
										usageFound = true
										bgInputTokens += chunk.inputTokens
										bgOutputTokens += chunk.outputTokens
										bgCacheWriteTokens += chunk.cacheWriteTokens ?? 0
										bgCacheReadTokens += chunk.cacheReadTokens ?? 0
										bgTotalCost = chunk.totalCost
									}
								}

								if (
									usageFound ||
									bgInputTokens > 0 ||
									bgOutputTokens > 0 ||
									bgCacheWriteTokens > 0 ||
									bgCacheReadTokens > 0
								) {
									// We have usage data either from a usage chunk or accumulated tokens
									await captureUsageData(
										{
											input: bgInputTokens,
											output: bgOutputTokens,
											cacheWrite: bgCacheWriteTokens,
											cacheRead: bgCacheReadTokens,
											total: bgTotalCost,
										},
										lastApiReqIndex,
									)
								} else {
									console.warn(
										`[Background Usage Collection] Suspicious: request ${apiReqIndex} is complete, but no usage info was found. Model: ${modelId}`,
									)
								}
							} catch (error) {
								console.error("Error draining stream for usage data:", error)
								// Still try to capture whatever usage data we have collected so far
								if (
									bgInputTokens > 0 ||
									bgOutputTokens > 0 ||
									bgCacheWriteTokens > 0 ||
									bgCacheReadTokens > 0
								) {
									await captureUsageData(
										{
											input: bgInputTokens,
											output: bgOutputTokens,
											cacheWrite: bgCacheWriteTokens,
											cacheRead: bgCacheReadTokens,
											total: bgTotalCost,
										},
										lastApiReqIndex,
									)
								}
							}
						}

						// Start the background task and handle any errors
						drainStreamInBackgroundToFindAllUsage(lastApiReqIndex).catch((error) => {
							console.error("Background usage collection failed:", error)
						})
					} catch (error) {
						// Abandoned happens when extension is no longer waiting for the
						// Alpha instance to finish aborting (error is thrown here when
						// any function in the for loop throws due to this.abort).
						if (!this.abandoned) {
							const pendingSteer = this.pendingSteerMessage

							if (pendingSteer) {
								this.pendingSteerMessage = undefined
								await abortStream("user_cancelled")
								await this.say("user_feedback", pendingSteer.text, pendingSteer.images)

								stack.push({
									userContent: [
										...this.takeLastApiUserMessageContent(),
										...this.buildUserMessageContent(pendingSteer.text, pendingSteer.images),
									],
									includeFileDetails: false,
								})

								continue
							}

							// Determine cancellation reason
							const cancelReason: ClineApiReqCancelReason = this.abort
								? "user_cancelled"
								: "streaming_failed"

							const rawErrorMessage = error.message ?? JSON.stringify(serializeError(error), null, 2)
							const streamingFailedMessage = this.abort
								? undefined
								: `${t("common:interruption.streamTerminatedByProvider")}: ${rawErrorMessage}`

							// Clean up partial state
							await abortStream(cancelReason, streamingFailedMessage)

							if (this.abort) {
								// User cancelled - abort the entire task
								this.abortReason = cancelReason
								await this.abortTask()
							} else {
								// Stream failed - log the error and retry with the same content
								// The existing rate limiting will prevent rapid retries
								console.error(
									`[Task#${this.taskId}.${this.instanceId}] Stream failed, will retry: ${streamingFailedMessage}`,
								)

								// Apply exponential backoff similar to first-chunk errors when auto-resubmit is enabled
								const stateForBackoff = await this.providerRef.deref()?.getState()
								if (stateForBackoff?.autoApprovalEnabled) {
									await this.backoffAndAnnounce(currentItem.retryAttempt ?? 0, error)

									// Check if task was aborted during the backoff
									if (this.abort) {
										console.log(
											`[Task#${this.taskId}.${this.instanceId}] Task aborted during mid-stream retry backoff`,
										)
										// Abort the entire task
										this.abortReason = "user_cancelled"
										await this.abortTask()
										break
									}
								}

								// Push the same content back onto the stack to retry, incrementing the retry attempt counter
								stack.push({
									userContent: currentUserContent,
									includeFileDetails: false,
									retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
								})

								// Continue to retry the request
								continue
							}
						}
					} finally {
						this.isStreaming = false
						this.endStreamingBoundary()
						// Clean up the abort controller when streaming completes
						this.currentRequestAbortController = undefined
					}

					// Need to call here in case the stream was aborted.
					if (this.abort || this.abandoned) {
						throw new Error(
							`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`,
						)
					}

					// Finalize buffered tool calls only after the provider stream has
					// completed and the abort check has passed.
					this.completedAgentResponse = await responseAccumulator.finish(consumeResponseItem)

					this.didCompleteReadingStream = true

					// Set any blocks to be complete to allow `presentAssistantMessage`
					// to finish and set `userMessageContentReady` to true.
					// (Could be a text block that had no subsequent tool uses, or a
					// text block at the very end, or an invalid tool use, etc. Whatever
					// the case, `presentAssistantMessage` relies on these blocks either
					// to be completed or the user to reject a block in order to proceed
					// and eventually set userMessageContentReady to true.)

					// Capture any blocks that remain partial after the complete response
					// has been normalized. Tool calls have not been presented yet.
					const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
					partialBlocks.forEach((block) => (block.partial = false))

					// Can't just do this b/c a tool could be in the middle of executing.
					// this.assistantMessageContent.forEach((e) => (e.partial = false))

					// No legacy streaming parser to finalize.

					// Note: updateApiReqMsg() is now called from within drainStreamInBackgroundToFindAllUsage
					// to ensure usage data is captured even when the stream is interrupted. The background task
					// uses local variables to accumulate usage data before atomically updating the shared state.

					// Complete the reasoning message if it exists
					// We can't use say() here because the reasoning message may not be the last message
					// (other messages like text blocks or tool uses may have been added after it during streaming)
					if (reasoningMessage) {
						const lastReasoningIndex = findLastIndex(
							this.clineMessages,
							(m) => m.type === "say" && m.say === "reasoning",
						)

						if (lastReasoningIndex !== -1 && this.clineMessages[lastReasoningIndex].partial) {
							this.clineMessages[lastReasoningIndex].partial = false
							await this.updateClineMessage(this.clineMessages[lastReasoningIndex])
						}
					}

					await this.saveClineMessages()
					await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

					// No legacy text-stream tool parser state to reset.

					// CRITICAL: Save assistant message to API history BEFORE executing tools.
					// This ensures that when new_task triggers delegation and calls flushPendingToolResultsToHistory(),
					// the assistant message is already in history. Otherwise, tool_result blocks would appear
					// BEFORE their corresponding tool_use blocks, causing API errors.

					// Check if we have any content to process (text or tool uses)
					const hasTextContent = assistantMessage.length > 0

					const hasToolUses = this.assistantMessageContent.some(
						(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
					)

					if (hasTextContent || hasToolUses) {
						// Reset counter when we get a successful response with content
						this.consecutiveNoAssistantMessagesCount = 0
						// Display grounding sources to the user if they exist
						if (pendingGroundingSources.length > 0) {
							const citationLinks = pendingGroundingSources.map(
								(source, i) => `[${i + 1}](${source.url})`,
							)
							const sourcesText = `${t("common:gemini.sources")} ${citationLinks.join(", ")}`

							await this.say("text", sourcesText, undefined, false, undefined, undefined, {
								isNonInteractive: true,
							})
						}

						// Build the assistant message content array
						const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = []

						// Add text content if present
						if (assistantMessage) {
							assistantContent.push({
								type: "text" as const,
								text: assistantMessage,
							})
						}

						// Add tool_use blocks with their IDs for native protocol
						// This handles both regular ToolUse and McpToolUse types
						// IMPORTANT: Track seen IDs to prevent duplicates in the API request.
						// Duplicate tool_use IDs cause Anthropic API 400 errors:
						// "tool_use ids must be unique"
						const seenToolUseIds = new Set<string>()
						const toolUseBlocks = this.assistantMessageContent.filter(
							(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
						)
						for (const block of toolUseBlocks) {
							if (block.type === "mcp_tool_use") {
								// McpToolUse already has the original tool name (e.g., "mcp_serverName_toolName")
								// The arguments are the raw tool arguments (matching the simplified schema)
								const mcpBlock = block as import("../../shared/tools").McpToolUse
								if (mcpBlock.id) {
									const sanitizedId = sanitizeToolUseId(mcpBlock.id)
									// Pre-flight deduplication: Skip if we've already added this ID
									if (seenToolUseIds.has(sanitizedId)) {
										console.warn(
											`[Task#${this.taskId}] Pre-flight deduplication: Skipping duplicate MCP tool_use ID: ${sanitizedId} (tool: ${mcpBlock.name})`,
										)
										continue
									}
									seenToolUseIds.add(sanitizedId)
									assistantContent.push({
										type: "tool_use" as const,
										id: sanitizedId,
										name: mcpBlock.name, // Original dynamic name
										input: mcpBlock.arguments, // Direct tool arguments
									})
								}
							} else {
								// Regular ToolUse
								const toolUse = block as import("../../shared/tools").ToolUse
								const toolCallId = toolUse.id
								if (toolCallId) {
									const sanitizedId = sanitizeToolUseId(toolCallId)
									// Pre-flight deduplication: Skip if we've already added this ID
									if (seenToolUseIds.has(sanitizedId)) {
										console.warn(
											`[Task#${this.taskId}] Pre-flight deduplication: Skipping duplicate tool_use ID: ${sanitizedId} (tool: ${toolUse.name})`,
										)
										continue
									}
									seenToolUseIds.add(sanitizedId)
									// nativeArgs is already in the correct API format for all tools
									const input = toolUse.nativeArgs || toolUse.params

									// Use originalName (alias) if present for API history consistency.
									// When tool aliases are used (e.g., "edit_file" -> "search_and_replace" -> "edit" (current canonical name)),
									// we want the alias name in the conversation history to match what the model
									// was told the tool was named, preventing confusion in multi-turn conversations.
									const toolNameForHistory = toolUse.originalName ?? toolUse.name

									assistantContent.push({
										type: "tool_use" as const,
										id: sanitizedId,
										name: toolNameForHistory,
										input,
									})
								}
							}
						}

						// Save assistant message BEFORE executing tools
						// This is critical for new_task: when it triggers delegation, flushPendingToolResultsToHistory()
						// will save the user message with tool_results. The assistant message must already be in history
						// so that tool_result blocks appear AFTER their corresponding tool_use blocks.
						await this.addToApiConversationHistory(
							{ role: "assistant", content: assistantContent },
							reasoningMessage || undefined,
						)
						this.assistantMessageSavedToHistory = true

						TelemetryService.instance.captureConversationMessage(this.taskId, "assistant")
					}

					// Tool calls are scheduled only after the complete assistant response
					// has been persisted. This preserves native tool_use/tool_result ordering,
					// allows independent reads to run concurrently, and prevents a streaming
					// tool call from interrupting the provider response.
					let schedulerOutcome: ToolSchedulerOutcome | undefined
					if (hasToolUses) {
						const state = await this.providerRef.deref()?.getState()
						const modelInfo = this.api.getModel().info
						const registry = await createTaskToolRegistry(this)
						const stepContext: StepContext | undefined = this.completedStepContext
						const scheduler = new ToolScheduler({
							task: this,
							registry,
							mode: await this.getTaskMode(),
							customModes: state?.customModes,
							experiments: state?.experiments,
							disabledTools: state?.disabledTools,
							includedTools: modelInfo.includedTools,
							policy: (stepContext as StepContext | undefined)?.policy,
							signal: this.taskAbortController.signal,
							onEvent: (event) => this.recordAgentTurnEvent(event, stepContext),
						})

						try {
							this.beginToolBatchBoundary()
							schedulerOutcome = await scheduler.run(this.buildCurrentAgentResponse())
						} finally {
							this.endToolBatchBoundary()
							await this.recordAgentTurnEvent(
								{ type: "progress", text: "Tool batch boundary closed" },
								stepContext,
							)
						}
						if (schedulerOutcome.status === "aborted") {
							throw new Error(`[Task#${this.taskId}.${this.instanceId}] tool scheduling aborted`)
						}
						this.userMessageContentReady = true
					}

					// Present any partial blocks that were just completed. This is a
					// recovery path for malformed streams; normal tool calls are presented
					// only after the complete assistant response is persisted above.
					// NOTE: This MUST happen AFTER saving the assistant message to API history.
					// When new_task is in the batch, it triggers delegation which calls flushPendingToolResultsToHistory().
					// If the assistant message isn't saved yet, tool_results would appear before tool_use blocks.
					if (partialBlocks.length > 0 && !hasToolUses) {
						// If there is content to update then it will complete and
						// update `this.userMessageContentReady` to true, which we
						// `pWaitFor` before making the next request.
						presentAssistantMessage(this)
					}
					if (hasTextContent && !hasToolUses) {
						this.userMessageContentReady = true
					}

					if (hasTextContent || hasToolUses) {
						// NOTE: This comment is here for future reference - this was a
						// workaround for `userMessageContent` not getting set to true.
						// It was due to it not recursively calling for partial blocks
						// when `didRejectTool`, so it would get stuck waiting for a
						// partial block to complete before it could continue.
						// In case the content blocks finished it may be the api stream
						// finished after the last parsed content block was executed, so
						// we are able to detect out of bounds and set
						// `userMessageContentReady` to true (note you should not call
						// `presentAssistantMessage` since if the last block i
						//  completed it will be presented again).
						// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // If there are any partial blocks after the stream ended we can consider them invalid.
						// if (this.currentStreamingContentIndex >= completeBlocks.length) {
						// 	this.userMessageContentReady = true
						// }

						await pWaitFor(() => this.userMessageContentReady)

						this.captureAgentTurnTelemetry(
							this.buildCurrentAgentResponse(),
							schedulerOutcome ?? {
								batchSize: 0,
								parallelBatchCount: 0,
								parallelToolCount: 0,
								durationMs: 0,
								approvalRequestCount: 0,
								approvalDeniedCount: 0,
								approvalCancelledCount: 0,
								supersededAskCount: 0,
								completedToolResultCount: 0,
								outputTruncatedCount: 0,
							},
							currentItem.retryAttempt ?? 0,
						)

						if (this.didComplete) {
							return true
						}

						// A normal text-only assistant response is a valid terminal
						// response. Do not coerce it into another tool-use turn.
						this.consecutiveNoToolUseCount = 0

						// Return after one complete model/tool turn. AgentTurnEngine owns
						// continuation sequencing; keeping this method to one step makes
						// the assistant-response/tool-result boundary explicit.
						return false
					} else {
						// If there's no assistant_responses, that means we got no text
						// or tool_use content blocks from API which we should assume is
						// an error.
						this.captureAgentTurnTelemetry(
							this.buildCurrentAgentResponse(),
							{
								batchSize: 0,
								parallelBatchCount: 0,
								parallelToolCount: 0,
								durationMs: 0,
								approvalRequestCount: 0,
								approvalDeniedCount: 0,
								approvalCancelledCount: 0,
								supersededAskCount: 0,
								completedToolResultCount: 0,
								outputTruncatedCount: 0,
							},
							currentItem.retryAttempt ?? 0,
						)

						// Increment consecutive no-assistant-messages counter
						this.consecutiveNoAssistantMessagesCount++

						// Only show error and count toward mistake limit after 2 consecutive failures
						// This provides a "grace retry" - first failure retries silently
						if (this.consecutiveNoAssistantMessagesCount >= 2) {
							await this.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
						}

						// IMPORTANT: We already added the user message to
						// apiConversationHistory at line 1876. Since the assistant failed to respond,
						// we need to remove that message before retrying to avoid having two consecutive
						// user messages (which would cause tool_result validation errors).
						let state = await this.providerRef.deref()?.getState()
						let removedUserMessage: ApiMessage | undefined
						if (this.apiConversationHistory.length > 0) {
							const lastMessage = this.apiConversationHistory[this.apiConversationHistory.length - 1]
							if (lastMessage.role === "user") {
								// Remove the last user message that we added earlier
								removedUserMessage = this.apiConversationHistory.pop()
							}
						}

						// Check if we should auto-retry or prompt the user
						// Reuse the state variable from above
						if (state?.autoApprovalEnabled) {
							// Auto-retry with backoff - don't persist failure message when retrying
							await this.backoffAndAnnounce(
								currentItem.retryAttempt ?? 0,
								new Error(
									"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
								),
							)

							// Check if task was aborted during the backoff
							if (this.abort) {
								console.log(
									`[Task#${this.taskId}.${this.instanceId}] Task aborted during empty-assistant retry backoff`,
								)
								await this.restoreRemovedApiUserMessage(removedUserMessage)
								break
							}

							// Push the same content back onto the stack to retry, incrementing the retry attempt counter
							// Mark that user message was removed so it gets re-added on retry
							stack.push({
								userContent: currentUserContent,
								includeFileDetails: false,
								retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
								userMessageWasRemoved: Boolean(removedUserMessage),
							})

							// Continue to retry the request
							continue
						} else {
							// Prompt the user for retry decision
							let response: string
							try {
								const askResponse = await this.ask(
									"api_req_failed",
									"The model returned no assistant messages. This may indicate an issue with the API or the model's output.",
								)
								response = askResponse.response
							} catch (error) {
								await this.restoreRemovedApiUserMessage(removedUserMessage)
								throw error
							}

							if (this.abort) {
								await this.restoreRemovedApiUserMessage(removedUserMessage)
								break
							}

							if (response === "yesButtonClicked") {
								await this.say("api_req_retried")

								// Push the same content back to retry
								stack.push({
									userContent: currentUserContent,
									includeFileDetails: false,
									retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
									userMessageWasRemoved: Boolean(removedUserMessage),
								})

								// Continue to retry the request
								continue
							} else {
								// User declined to retry
								// Re-add the exact user message we removed, including environment details.
								await this.restoreRemovedApiUserMessage(removedUserMessage)

								await this.say(
									"error",
									"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
								)

								await this.addToApiConversationHistory({
									role: "assistant",
									content: [{ type: "text", text: "Failure: I did not provide a response." }],
								})
							}
						}
					}

					// If we reach here without continuing, return false (will always be false for now)
					return false
				} catch (error) {
					// This should never happen since the only thing that can throw an
					// error is the attemptApiRequest, which is wrapped in a try catch
					// that sends an ask where if noButtonClicked, will clear current
					// task and destroy this instance. However to avoid unhandled
					// promise rejection, we will end this loop which will end execution
					// of this instance (see `startTask`).
					return true // Needs to be true so parent loop knows to end task.
				}
			}

			if (this.didComplete) {
				return true
			}

			// If we exit the while loop normally (stack is empty), return false
			return false
		} finally {
			this.isTaskLoopActive = wasTaskLoopActive
		}
	}

	/**
	 * Converts the current assistant turn into the provider-neutral response
	 * model used by AgentTurnEngine. API history remains Anthropic-shaped; this
	 * view is only the control-flow boundary between Task and the engine.
	 */
	private buildCurrentAgentResponse(): AgentResponse {
		if (this.completedAgentResponse) {
			return this.completedAgentResponse
		}

		const items: AgentResponseItem[] = []

		for (const block of this.assistantMessageContent) {
			if (block.type === "text") {
				items.push({ type: "text", text: block.content })
				continue
			}

			if (block.type === "tool_use" || block.type === "mcp_tool_use") {
				const candidate = block as unknown as {
					id?: unknown
					name?: unknown
					nativeArgs?: unknown
					params?: unknown
					arguments?: unknown
				}
				const id = typeof candidate.id === "string" ? candidate.id : undefined
				const name = typeof candidate.name === "string" ? candidate.name : undefined

				if (!id || !name) {
					items.push({ type: "error", message: "Tool call was missing a valid ID or name." })
					continue
				}

				items.push({
					type: "tool_call",
					id,
					name,
					arguments: candidate.nativeArgs ?? candidate.arguments ?? candidate.params ?? {},
				})
			}
		}

		return {
			items,
			text: items
				.filter((item): item is Extract<AgentResponseItem, { type: "text" }> => item.type === "text")
				.map((item) => item.text)
				.join(""),
			reasoning: "",
			toolCalls: items.filter(
				(item): item is Extract<AgentResponseItem, { type: "tool_call" }> => item.type === "tool_call",
			),
		}
	}

	private captureAgentTurnTelemetry(
		response: AgentResponse,
		metrics: Pick<
			ToolSchedulerOutcome,
			| "batchSize"
			| "parallelBatchCount"
			| "parallelToolCount"
			| "durationMs"
			| "approvalRequestCount"
			| "approvalDeniedCount"
			| "approvalCancelledCount"
			| "supersededAskCount"
			| "completedToolResultCount"
			| "outputTruncatedCount"
		>,
		retries: number,
	): void {
		if (!TelemetryService.hasInstance()) {
			return
		}

		TelemetryService.instance.captureEvent(TelemetryEventName.AGENT_TURN, {
			taskId: this.taskId,
			...buildAgentTurnTelemetryProperties(response, metrics, retries),
		})
		void this.recordAgentTurnEvent(
			{
				type: "turn_completed",
				status: this.abort ? "aborted" : "completed",
				toolCallCount: response.toolCalls.length,
				retryCount: retries,
			},
			this.completedStepContext,
		)
	}

	private async recordAgentTurnEvent(event: AgentTurnEvent, context?: StepContext): Promise<void> {
		try {
			this.agentTurnEventLog ??= new AgentTurnEventLog(this.taskId, this.globalStoragePath)
			await this.agentTurnEventLog.append(event, context)
		} catch (error) {
			console.warn(`[Task#${this.taskId}] Failed to persist harness event:`, error)
		}
	}

	public async recordInternalTaskEvent(
		event: Extract<AgentTurnEvent, { type: "internal_task_started" | "internal_task_completed" }>,
	): Promise<void> {
		await this.recordAgentTurnEvent(event, this.completedStepContext)
	}

	private beginStreamingBoundary(): void {
		this.streamingBoundary = new Promise<void>((resolve) => {
			this.resolveStreamingBoundary = resolve
		})
	}

	private endStreamingBoundary(): void {
		this.resolveStreamingBoundary?.()
		this.resolveStreamingBoundary = undefined
	}

	private beginToolBatchBoundary(): void {
		this.toolBatchBoundary = new Promise<void>((resolve) => {
			this.resolveToolBatchBoundary = resolve
		})
	}

	private endToolBatchBoundary(): void {
		this.resolveToolBatchBoundary?.()
		this.resolveToolBatchBoundary = undefined
	}

	private async waitForCompactionBoundary(): Promise<void> {
		await this.streamingBoundary
		await this.toolBatchBoundary
		if (!isSafeCompactionBoundary(this.apiConversationHistory)) {
			throw new Error("Context compaction deferred until all tool call results are committed.")
		}
	}

	private async createStepContextSnapshot(input: {
		kind: StepContextKind
		contextId?: string
		parentContextId?: string
		retryAttempt: number
		state: any
		mode: string
		systemPrompt: string
		environmentDetails?: string
		environmentSnapshot?: EnvironmentSnapshot
		transcript: ApiMessage[]
		metadata: ApiHandlerCreateMessageMetadata
		tools: OpenAI.Chat.ChatCompletionTool[]
		allowedFunctionNames?: string[]
		modelInfo: ModelInfo
		contextTokens?: number
		compaction: StepCompactionMetadata
		policy?: ToolPolicySnapshot
	}): Promise<StepContext> {
		const apiProvider = this.apiConfiguration.apiProvider
		const modelId = this.api.getModel().id
		const apiProtocol = getApiProtocol(
			apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
			modelId,
		)
		const profileName = await this.getTaskApiConfigName()
		const profileId = await this.getCurrentProfileId(input.state)
		const toolNames = input.tools.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))
		const allowedTools = input.allowedFunctionNames ?? toolNames
		const disabledTools = input.state?.disabledTools ?? []
		const policyBase = input.policy ?? {
			visibleTools: toolNames,
			allowedTools,
			disabledTools,
			autoApprovalEnabled: input.state?.autoApprovalEnabled === true,
			capabilities: Object.fromEntries(toolNames.map((name) => [name, getToolCapabilities(name)])),
			outputLimits: {},
			digest: digestValue({ toolNames, allowedTools, disabledTools }),
		}
		const policy = createToolPolicySnapshot(policyBase)
		const contextWindow = input.modelInfo.contextWindow
		const maxOutputTokens = getModelMaxOutputTokens({
			modelId,
			model: input.modelInfo,
			settings: this.apiConfiguration,
		})
		const inputTokens = input.contextTokens

		return createStepContext({
			contextId: input.contextId,
			kind: input.kind,
			parentContextId: input.parentContextId,
			retryAttempt: input.retryAttempt,
			task: {
				taskId: this.taskId,
				cwd: this.cwd,
				rootTaskId: this.rootTaskId,
				parentTaskId: this.parentTaskId,
			},
			mode: {
				slug: input.mode,
				profileName,
				profileId,
				customModeDigest: digestValue({
					customModes: input.state?.customModes,
					customModePrompts: input.state?.customModePrompts,
					customInstructions: input.state?.customInstructions,
				}),
			},
			provider: {
				apiProvider,
				apiProtocol,
				modelId,
				modelInfo: input.modelInfo,
				options: this.apiConfiguration as unknown as Record<string, unknown>,
			},
			instructions: {
				systemPrompt: input.systemPrompt,
				environmentDetails: input.environmentDetails,
				environmentSnapshot: input.environmentSnapshot,
				sources: [
					{
						kind: "system_prompt",
						path: "src/core/prompts/system.ts",
						digest: digestValue(input.systemPrompt),
					},
					{
						kind: "environment_details",
						path: "src/core/environment/getEnvironmentDetails.ts",
						digest: digestValue(input.environmentDetails ?? ""),
					},
					{
						kind: "mode",
						path: `mode:${input.mode}`,
						digest: digestValue(input.state?.customModes?.find?.((mode: any) => mode.slug === input.mode)),
					},
				],
			},
			environment: {
				roots: [this.cwd, this.globalStoragePath],
				capabilities: toolNames,
			},
			transcript: {
				messages: input.transcript,
				boundary: {
					startIndex: Math.max(0, this.apiConversationHistory.length - input.transcript.length),
					endIndex: this.apiConversationHistory.length,
					messageCount: input.transcript.length,
					digest: digestValue(input.transcript),
				},
			},
			tools: {
				schemas: input.tools,
				allowedFunctionNames: input.allowedFunctionNames,
				toolChoice: input.metadata.tool_choice,
				parallelToolCalls: input.metadata.parallelToolCalls ?? true,
				digest: digestValue(input.tools),
			},
			policy: {
				...policy,
				digest: digestValue(policy),
			},
			budget: {
				contextWindow,
				maxOutputTokens,
				inputTokens,
				estimatedInputTokens: inputTokens,
				remainingTokens:
					inputTokens === undefined
						? undefined
						: Math.max(0, contextWindow - inputTokens - (maxOutputTokens ?? 0)),
				compaction: input.compaction,
			},
			request: {
				metadata: input.metadata,
			},
		})
	}

	private createCompatibilityStepContext(): StepContext {
		const model = this.api.getModel()
		const emptyTools: OpenAI.Chat.ChatCompletionTool[] = []
		const emptyPolicy = createToolPolicySnapshot({
			visibleTools: [],
			allowedTools: [],
			disabledTools: [],
			capabilities: {},
			digest: digestValue([]),
		})
		const metadata: ApiHandlerCreateMessageMetadata = { taskId: this.taskId }

		return createStepContext({
			contextId: crypto.randomUUID(),
			kind: "agent",
			retryAttempt: 0,
			task: { taskId: this.taskId, cwd: this.cwd, rootTaskId: this.rootTaskId, parentTaskId: this.parentTaskId },
			mode: { slug: defaultModeSlug },
			provider: {
				apiProvider: this.apiConfiguration.apiProvider,
				apiProtocol: getApiProtocol(
					this.apiConfiguration.apiProvider && !isRetiredProvider(this.apiConfiguration.apiProvider)
						? this.apiConfiguration.apiProvider
						: undefined,
					model.id,
				),
				modelId: model.id,
				modelInfo: model.info,
				options: this.apiConfiguration as unknown as Record<string, unknown>,
			},
			instructions: { systemPrompt: "", sources: [] },
			environment: { roots: [this.cwd], capabilities: [] },
			transcript: {
				messages: [],
				boundary: { startIndex: 0, endIndex: 0, messageCount: 0, digest: digestValue([]) },
			},
			tools: { schemas: emptyTools, parallelToolCalls: true, digest: digestValue(emptyTools) },
			policy: emptyPolicy,
			budget: { contextWindow: model.info.contextWindow, compaction: { action: "none", attempted: false } },
			request: { metadata },
		})
	}

	private async persistStepContextMetadata(context: StepContext, retryAttempt: number): Promise<void> {
		const requestIndex = findLastIndex(this.clineMessages, (message) => message.say === "api_req_started")
		if (requestIndex < 0) {
			return
		}

		let existing: ClineApiReqInfo = {}
		try {
			existing = JSON.parse(this.clineMessages[requestIndex].text || "{}") as ClineApiReqInfo
		} catch {
			// Preserve the request record even if an older version wrote malformed metadata.
		}

		this.clineMessages[requestIndex].text = JSON.stringify({
			...existing,
			...toStepContextMetadata(context, retryAttempt),
		})
		await this.updateClineMessage(this.clineMessages[requestIndex])
	}

	private async getSystemPrompt(): Promise<string> {
		const { mcpEnabled } = (await this.providerRef.deref()?.getState()) ?? {}
		let mcpHub: McpHub | undefined
		if (mcpEnabled ?? true) {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			// Wait for MCP hub initialization through McpServerManager
			mcpHub = await McpServerManager.getInstance(provider.context, provider)

			if (!mcpHub) {
				throw new Error("Failed to get MCP hub from server manager")
			}

			// Wait for MCP servers to be connected before generating system prompt
			await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()

		const state = await this.providerRef.deref()?.getState()

		const { customModes, customModePrompts, customInstructions, experiments, language, enableSubfolderRules } =
			state ?? {}
		const mode = await this.getTaskMode()
		const apiConfiguration = this.apiConfiguration

		return await (async () => {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider not available")
			}

			const modelInfo = this.api.getModel().info

			return SYSTEM_PROMPT(
				provider.context,
				this.cwd,
				false,
				mcpHub,
				this.diffStrategy,
				mode,
				customModePrompts,
				customModes,
				customInstructions,
				experiments,
				language,
				rooIgnoreInstructions,
				{
					todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
					useAgentRules:
						vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
					enableSubfolderRules: enableSubfolderRules ?? false,
					newTaskRequireTodos: vscode.workspace
						.getConfiguration(Package.name)
						.get<boolean>("newTaskRequireTodos", false),
					isStealthModel: modelInfo?.isStealthModel,
				},
				undefined, // todoList
				this.api.getModel().id,
				provider.getSkillsManager(),
			)
		})()
	}

	private async getCurrentProfileId(state: any): Promise<string> {
		const taskApiConfigName = await this.getTaskApiConfigName()
		return (
			state?.listApiConfigMeta?.find(
				(profile: any) => profile.name === (taskApiConfigName ?? state?.currentApiConfigName),
			)?.id ?? "default"
		)
	}

	private async handleContextWindowExceededError(): Promise<void> {
		const state = await this.providerRef.deref()?.getState()
		const { profileThresholds = {} } = state ?? {}
		const mode = await this.getTaskMode()
		const apiConfiguration = this.apiConfiguration

		const { contextTokens } = this.getTokenUsage()
		const modelInfo = this.api.getModel().info

		const maxTokens = getModelMaxOutputTokens({
			modelId: this.api.getModel().id,
			model: modelInfo,
			settings: this.apiConfiguration,
		})

		const contextWindow = modelInfo.contextWindow

		// Get the current profile ID using the helper method
		const currentProfileId = await this.getCurrentProfileId(state)

		// Log the context window error for debugging
		console.warn(
			`[Task#${this.taskId}] Context window exceeded for model ${this.api.getModel().id}. ` +
				`Current tokens: ${contextTokens}, Context window: ${contextWindow}. ` +
				`Forcing truncation to ${FORCED_CONTEXT_REDUCTION_PERCENT}% of current context.`,
		)
		// Send condenseTaskContextStarted to show in-progress indicator
		await this.providerRef.deref()?.postMessageToWebview({ type: "condenseTaskContextStarted", text: this.taskId })

		// Build tools for condensing metadata (same tools used for normal API calls)
		const provider = this.providerRef.deref()
		let allTools: import("openai").default.Chat.ChatCompletionTool[] = []
		if (provider) {
			const toolsResult = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: this.cwd,
				mode,
				customModes: state?.customModes,
				experiments: state?.experiments,
				apiConfiguration,
				disabledTools: state?.disabledTools,
				modelInfo,
				includeAllToolsWithRestrictions: false,
			})
			allTools = toolsResult.tools
		}

		// Build metadata with tools and taskId for the condensing API call
		const metadata: ApiHandlerCreateMessageMetadata = {
			mode,
			taskId: this.taskId,
			...(allTools.length > 0
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
					}
				: {}),
		}

		try {
			// Generate environment details to include in the condensed summary
			const environmentDetails = await getEnvironmentDetails(this, true)

			// Force aggressive truncation by keeping only 75% of the conversation history
			const truncateResult = await manageContext({
				messages: this.apiConversationHistory,
				totalTokens: contextTokens || 0,
				maxTokens,
				contextWindow,
				apiHandler: this.api,
				autoCondenseContext: true,
				autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT,
				systemPrompt: await this.getSystemPrompt(),
				taskId: this.taskId,
				profileThresholds,
				currentProfileId,
				metadata,
				environmentDetails,
			})

			if (truncateResult.messages !== this.apiConversationHistory) {
				await this.overwriteApiConversationHistory(truncateResult.messages)
			}

			if (truncateResult.summary) {
				const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
				const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
				await this.say(
					"condense_context",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					contextCondense,
				)
			} else if (truncateResult.truncationId) {
				// Sliding window truncation occurred (fallback when condensing fails or is disabled)
				const contextTruncation: ContextTruncation = {
					truncationId: truncateResult.truncationId,
					messagesRemoved: truncateResult.messagesRemoved ?? 0,
					prevContextTokens: truncateResult.prevContextTokens,
					newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
				}
				await this.say(
					"sliding_window_truncation",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					undefined /* contextCondense */,
					contextTruncation,
				)
			}
		} finally {
			// Notify webview that context management is complete (removes in-progress spinner)
			// IMPORTANT: Must always be sent to dismiss the spinner, even on error
			await this.providerRef
				.deref()
				?.postMessageToWebview({ type: "condenseTaskContextResponse", text: this.taskId })
		}
	}

	/**
	 * Enforce the user-configured provider rate limit.
	 *
	 * NOTE: This is intentionally treated as expected behavior and is surfaced via
	 * the `api_req_rate_limit_wait` say type (not an error).
	 */
	private async maybeWaitForProviderRateLimit(retryAttempt: number): Promise<void> {
		const state = await this.providerRef.deref()?.getState()
		const rateLimitSeconds =
			state?.apiConfiguration?.rateLimitSeconds ?? this.apiConfiguration?.rateLimitSeconds ?? 0

		const now = performance.now()
		const configuration = (state?.apiConfiguration ?? this.apiConfiguration) as typeof this.apiConfiguration & {
			requestsPerMinute?: number
			tokensPerMinute?: number
		}
		const hasProviderLimits = Boolean(configuration.requestsPerMinute || configuration.tokensPerMinute)
		if (!hasProviderLimits && (rateLimitSeconds <= 0 || !Task.lastGlobalApiRequestTime)) return
		const { contextTokens = 0 } = this.getTokenUsage()
		const reservedOutputTokens =
			getModelMaxOutputTokens({
				modelId: this.api.getModel().id,
				model: this.api.getModel().info,
				settings: this.apiConfiguration,
			}) ?? 0
		const rateLimitDelay = hasProviderLimits
			? Math.ceil(
					Task.requestPacer.reserve(
						now,
						{ estimatedInputTokens: contextTokens, reservedOutputTokens, retry: retryAttempt > 0 },
						{
							requestsPerMinute: configuration.requestsPerMinute,
							tokensPerMinute: configuration.tokensPerMinute,
							minimumSpacingMs: Math.max(0, rateLimitSeconds * 1000),
						},
					) / 1000,
				)
			: Math.ceil(
					Math.min(
						rateLimitSeconds,
						Math.max(0, rateLimitSeconds * 1000 - (now - (Task.lastGlobalApiRequestTime ?? now))) / 1000,
					),
				)

		// Only show the countdown UX on the first attempt. Retry flows have their own delay messaging.
		if (rateLimitDelay > 0 && retryAttempt === 0) {
			for (let i = rateLimitDelay; i > 0; i--) {
				// Send structured JSON data for i18n-safe transport
				const delayMessage = JSON.stringify({ seconds: i })
				await this.say("api_req_rate_limit_wait", delayMessage, undefined, true)
				await delay(1000)
			}
			// Finalize the partial message so the UI doesn't keep rendering an in-progress spinner.
			await this.say("api_req_rate_limit_wait", undefined, undefined, false)
		}
	}

	public async *attemptApiRequest(
		retryAttempt: number = 0,
		options: { skipProviderRateLimit?: boolean } = {},
	): ApiStream {
		this.lastAgentTurnRetryCount = Math.max(this.lastAgentTurnRetryCount, retryAttempt)
		if (retryAttempt === 0) {
			this.retryStepContext = undefined
		}
		const reusedStepContext = this.retryStepContext
		const compactionParentContextId = reusedStepContext ? undefined : this.lastCompactionStepContext?.contextId

		const state = await this.providerRef.deref()?.getState()

		const {
			autoApprovalEnabled,
			requestDelaySeconds,
			autoCondenseContext = true,
			autoCondenseContextPercent = 100,
			profileThresholds = {},
		} = state ?? {}
		const mode = reusedStepContext?.mode.slug ?? (await this.getTaskMode())
		const apiConfiguration = this.apiConfiguration

		// Get condensing configuration for automatic triggers.
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE

		if (!options.skipProviderRateLimit) {
			await this.maybeWaitForProviderRateLimit(retryAttempt)
		}

		// Update last request time right before making the request so that subsequent
		// requests — even from new subtasks — will honour the provider's rate-limit.
		//
		// NOTE: When recursivelyMakeClineRequests handles rate limiting, it sets the
		// timestamp earlier to include the environment details build. We still set it
		// here for direct callers (tests) and for the case where we didn't rate-limit
		// in the caller.
		Task.lastGlobalApiRequestTime = performance.now()

		const systemPrompt = reusedStepContext?.instructions.systemPrompt ?? (await this.getSystemPrompt())
		const { contextTokens } =
			reusedStepContext?.budget.inputTokens !== undefined
				? { contextTokens: reusedStepContext.budget.inputTokens }
				: this.getTokenUsage()
		let compactionMetadata: StepCompactionMetadata = {
			action: "none",
			attempted: false,
		}
		const pendingAgentContextId = reusedStepContext?.contextId ?? crypto.randomUUID()

		if (contextTokens && !reusedStepContext) {
			const modelInfo = this.api.getModel().info

			const maxTokens = getModelMaxOutputTokens({
				modelId: this.api.getModel().id,
				model: modelInfo,
				settings: this.apiConfiguration,
			})

			const contextWindow = modelInfo.contextWindow

			// Get the current profile ID using the helper method
			const currentProfileId = await this.getCurrentProfileId(state)
			// Check if context management will likely run (threshold check)
			// This allows us to show an in-progress indicator to the user
			// We use the centralized willManageContext helper to avoid duplicating threshold logic
			const lastMessage = this.apiConversationHistory[this.apiConversationHistory.length - 1]
			const lastMessageContent = lastMessage?.content
			let lastMessageTokens = 0
			if (lastMessageContent) {
				lastMessageTokens = Array.isArray(lastMessageContent)
					? await this.api.countTokens(lastMessageContent)
					: await this.api.countTokens([{ type: "text", text: lastMessageContent as string }])
			}

			const contextManagementWillRun = willManageContext({
				totalTokens: contextTokens,
				contextWindow,
				maxTokens,
				autoCondenseContext,
				autoCondenseContextPercent,
				profileThresholds,
				currentProfileId,
				lastMessageTokens,
			})

			// Send condenseTaskContextStarted BEFORE manageContext to show in-progress indicator
			// This notification must be sent here (not earlier) because the early check uses stale token count
			// (before user message is added to history), which could incorrectly skip showing the indicator
			if (contextManagementWillRun && autoCondenseContext) {
				await this.providerRef
					.deref()
					?.postMessageToWebview({ type: "condenseTaskContextStarted", text: this.taskId })
			}

			// Build tools for condensing metadata (same tools used for normal API calls)
			// This ensures the condensing API call includes tool definitions for providers that need them
			let contextMgmtTools: import("openai").default.Chat.ChatCompletionTool[] = []
			{
				const provider = this.providerRef.deref()
				if (provider) {
					const toolsResult = await buildNativeToolsArrayWithRestrictions({
						provider,
						cwd: this.cwd,
						mode,
						customModes: state?.customModes,
						experiments: state?.experiments,
						apiConfiguration,
						disabledTools: state?.disabledTools,
						modelInfo,
						includeAllToolsWithRestrictions: false,
					})
					contextMgmtTools = toolsResult.tools
				}
			}

			// Build metadata with tools and taskId for the condensing API call
			const contextMgmtMetadata: ApiHandlerCreateMessageMetadata = {
				mode,
				taskId: this.taskId,
				...(contextMgmtTools.length > 0
					? {
							tools: contextMgmtTools,
							tool_choice: "auto",
							parallelToolCalls: true,
						}
					: {}),
			}

			// Only generate environment details when context management will actually run.
			// getEnvironmentDetails(this, true) triggers a recursive workspace listing which
			// adds overhead - avoid this for the common case where context is below threshold.
			const contextMgmtEnvironmentDetails = contextManagementWillRun
				? await getEnvironmentDetails(this, true)
				: undefined

			// Get files read by Alpha for code folding - only when context management will run
			const contextMgmtFilesReadByRoo =
				contextManagementWillRun && autoCondenseContext
					? await this.getFilesReadByRooSafely("attemptApiRequest")
					: undefined

			try {
				const truncateResult = await manageContext({
					messages: this.apiConversationHistory,
					totalTokens: contextTokens,
					maxTokens,
					contextWindow,
					apiHandler: this.api,
					autoCondenseContext,
					autoCondenseContextPercent,
					systemPrompt,
					taskId: this.taskId,
					customCondensingPrompt,
					profileThresholds,
					currentProfileId,
					metadata: contextMgmtMetadata,
					environmentDetails: contextMgmtEnvironmentDetails,
					filesReadByRoo: contextMgmtFilesReadByRoo,
					cwd: this.cwd,
					rooIgnoreController: this.rooIgnoreController,
					createStepContext: async ({
						systemPrompt: compactionPrompt,
						messages,
						metadata: compactionMetadata,
					}) => {
						const context = await this.createStepContextSnapshot({
							kind: "compaction",
							contextId: crypto.randomUUID(),
							parentContextId: pendingAgentContextId,
							retryAttempt: 0,
							state,
							mode,
							systemPrompt: compactionPrompt,
							environmentDetails: contextMgmtEnvironmentDetails,
							environmentSnapshot: this.currentStepEnvironmentSnapshot,
							transcript: messages,
							metadata: compactionMetadata ?? contextMgmtMetadata,
							tools: contextMgmtTools,
							modelInfo,
							contextTokens,
							compaction: { action: "none", attempted: true },
						})
						this.lastCompactionStepContext = context
						return context
					},
				})
				if (truncateResult.messages !== this.apiConversationHistory) {
					await this.overwriteApiConversationHistory(truncateResult.messages)
				}
				if (truncateResult.error) {
					await this.say("condense_context_error", truncateResult.error)
				}
				if (truncateResult.summary) {
					compactionMetadata = {
						action: "summary",
						attempted: true,
						prevContextTokens: truncateResult.prevContextTokens,
						newContextTokens: truncateResult.newContextTokens,
						summaryId: truncateResult.condenseId,
						cost: truncateResult.cost,
					}
					const { summary, cost, prevContextTokens, newContextTokens = 0, condenseId } = truncateResult
					const contextCondense: ContextCondense = {
						summary,
						cost,
						newContextTokens,
						prevContextTokens,
						condenseId,
					}
					await this.say(
						"condense_context",
						undefined /* text */,
						undefined /* images */,
						false /* partial */,
						undefined /* checkpoint */,
						undefined /* progressStatus */,
						{ isNonInteractive: true } /* options */,
						contextCondense,
					)
				} else if (truncateResult.truncationId) {
					compactionMetadata = {
						action: "truncation",
						attempted: true,
						prevContextTokens: truncateResult.prevContextTokens,
						newContextTokens: truncateResult.newContextTokensAfterTruncation,
						truncationId: truncateResult.truncationId,
						messagesRemoved: truncateResult.messagesRemoved,
						cost: truncateResult.cost,
					}
					// Sliding window truncation occurred (fallback when condensing fails or is disabled)
					const contextTruncation: ContextTruncation = {
						truncationId: truncateResult.truncationId,
						messagesRemoved: truncateResult.messagesRemoved ?? 0,
						prevContextTokens: truncateResult.prevContextTokens,
						newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
					}
					await this.say(
						"sliding_window_truncation",
						undefined /* text */,
						undefined /* images */,
						false /* partial */,
						undefined /* checkpoint */,
						undefined /* progressStatus */,
						{ isNonInteractive: true } /* options */,
						undefined /* contextCondense */,
						contextTruncation,
					)
				}
				await this.recordAgentTurnEvent(
					{
						type: "compaction_completed",
						action: compactionMetadata.action,
						messagesRemoved: compactionMetadata.messagesRemoved,
						previousTokens: compactionMetadata.prevContextTokens,
						newTokens: compactionMetadata.newContextTokens,
					},
					this.lastCompactionStepContext,
				)
			} finally {
				// Notify webview that context management is complete (sets isCondensing = false)
				// This removes the in-progress spinner and allows the completed result to show
				// IMPORTANT: Must always be sent to dismiss the spinner, even on error
				if (contextManagementWillRun && autoCondenseContext) {
					await this.providerRef
						.deref()
						?.postMessageToWebview({ type: "condenseTaskContextResponse", text: this.taskId })
				}
			}
		}

		// Get the effective API history by filtering out condensed messages
		// This allows non-destructive condensing where messages are tagged but not deleted,
		// enabling accurate rewind operations while still sending condensed history to the API.
		const cleanConversationHistory = reusedStepContext
			? (reusedStepContext.transcript.messages as unknown as ApiMessage[])
			: (() => {
					const effectiveHistory = getEffectiveApiHistory(this.apiConversationHistory)
					const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)
					// For API only: merge consecutive user messages (excludes summary messages per
					// mergeConsecutiveApiMessages implementation) without mutating stored history.
					const mergedForApi = mergeConsecutiveApiMessages(messagesSinceLastSummary, { roles: ["user"] })
					const messagesWithoutImages = maybeRemoveImageBlocks(mergedForApi, this.api)
					return this.buildCleanConversationHistory(messagesWithoutImages as ApiMessage[])
				})()

		// Check auto-approval limits
		const approvalResult = await this.autoApprovalHandler.checkAutoApprovalLimits(
			state,
			this.combineMessages(this.clineMessages.slice(1)),
			async (type, data) => this.ask(type, data),
		)

		if (!approvalResult.shouldProceed) {
			// User did not approve, task should be aborted
			throw new Error("Auto-approval limit reached and user did not approve continuation")
		}

		// Whether we include tools is determined by whether we have any tools to send.
		const modelInfo = (reusedStepContext?.provider.modelInfo as ModelInfo | undefined) ?? this.api.getModel().info

		// Build complete tools array: native tools + dynamic MCP tools
		// When includeAllToolsWithRestrictions is true, returns all tools but provides
		// allowedFunctionNames for providers (like Gemini) that need to see all tool
		// definitions in history while restricting callable tools for the current mode.
		// Only Gemini currently supports this - other providers filter tools normally.
		let allTools: OpenAI.Chat.ChatCompletionTool[] = reusedStepContext
			? (reusedStepContext.tools.schemas as unknown as OpenAI.Chat.ChatCompletionTool[])
			: []
		let allowedFunctionNames: string[] | undefined = reusedStepContext?.tools.allowedFunctionNames
			? [...reusedStepContext.tools.allowedFunctionNames]
			: undefined

		// Gemini requires all tool definitions to be present for history compatibility,
		// but uses allowedFunctionNames to restrict which tools can be called.
		// Vertex Gemini uses the same GenAI request format and validation rules.
		// Other providers (Anthropic, OpenAI, etc.) don't support this feature yet,
		// so they continue to receive only the filtered tools for the current mode.
		const supportsAllowedFunctionNames =
			apiConfiguration?.apiProvider === "gemini" || apiConfiguration?.apiProvider === "vertex"

		if (!reusedStepContext) {
			const provider = this.providerRef.deref()
			if (!provider) {
				throw new Error("Provider reference lost during tool building")
			}

			const toolsResult = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: this.cwd,
				mode,
				customModes: state?.customModes,
				experiments: state?.experiments,
				apiConfiguration,
				disabledTools: state?.disabledTools,
				modelInfo,
				includeAllToolsWithRestrictions: supportsAllowedFunctionNames,
			})
			allTools = toolsResult.tools
			allowedFunctionNames = toolsResult.allowedFunctionNames
		}

		const shouldIncludeTools = allTools.length > 0

		const metadata: ApiHandlerCreateMessageMetadata = reusedStepContext
			? (reusedStepContext.request.metadata as unknown as ApiHandlerCreateMessageMetadata)
			: {
					mode: mode,
					taskId: this.taskId,
					suppressPreviousResponseId: this.skipPrevResponseIdOnce,
					// Include tools whenever they are present.
					...(shouldIncludeTools
						? {
								tools: allTools,
								tool_choice: "auto",
								parallelToolCalls: true,
								// When mode restricts tools, provide allowedFunctionNames so providers
								// like Gemini can see all tools in history but only call allowed ones
								...(allowedFunctionNames ? { allowedFunctionNames } : {}),
							}
						: {}),
				}

		const stepContext =
			this.retryStepContext ??
			(await this.createStepContextSnapshot({
				kind: "agent",
				contextId: pendingAgentContextId,
				parentContextId: compactionParentContextId,
				retryAttempt,
				state,
				mode,
				systemPrompt,
				environmentDetails: this.currentStepEnvironmentDetails,
				environmentSnapshot: this.currentStepEnvironmentSnapshot,
				transcript: cleanConversationHistory as unknown as ApiMessage[],
				metadata,
				tools: allTools,
				allowedFunctionNames,
				modelInfo,
				contextTokens,
				compaction: compactionMetadata,
			}))
		this.retryStepContext = stepContext
		this.completedStepContext = stepContext
		this.lastCompactionStepContext = undefined
		await this.persistStepContextMetadata(stepContext, retryAttempt)
		await this.recordAgentTurnEvent(
			{ type: "policy_snapshot", digest: stepContext.policy.digest, toolCount: stepContext.tools.schemas.length },
			stepContext,
		)
		await this.recordAgentTurnEvent(
			{
				type: "profile_resolved",
				sourceMode: stepContext.mode.slug,
				profileId: resolveExecutionProfile(stepContext.mode.slug).id,
				legacyAdapter: !["work", "plan"].includes(stepContext.mode.slug),
			},
			stepContext,
		)
		await this.recordAgentTurnEvent({ type: "model_request_started", attempt: retryAttempt }, stepContext)

		// Create an AbortController to allow cancelling the request mid-stream
		this.currentRequestAbortController = new AbortController()
		const abortSignal = this.currentRequestAbortController.signal
		// Reset the flag after using it
		this.skipPrevResponseIdOnce = false

		// The provider accepts reasoning items alongside standard messages; cast to the expected parameter type.
		const stream = this.api.createMessage(
			stepContext.instructions.systemPrompt,
			stepContext.transcript.messages as unknown as Anthropic.Messages.MessageParam[],
			stepContext.request.metadata as unknown as ApiHandlerCreateMessageMetadata,
		)
		const iterator = stream[Symbol.asyncIterator]()

		// Set up abort handling - when the signal is aborted, clean up the controller reference
		abortSignal.addEventListener("abort", () => {
			console.log(`[Task#${this.taskId}.${this.instanceId}] AbortSignal triggered for current request`)
			this.currentRequestAbortController = undefined
		})

		try {
			// Awaiting first chunk to see if it will throw an error.
			this.isWaitingForFirstChunk = true

			// Race between the first chunk and the abort signal
			const firstChunkPromise = iterator.next()
			const abortPromise = new Promise<never>((_, reject) => {
				if (abortSignal.aborted) {
					reject(
						this.pendingSteerMessage
							? new SteerRequestInterruptError()
							: new Error("Request cancelled by user"),
					)
				} else {
					abortSignal.addEventListener("abort", () => {
						reject(
							this.pendingSteerMessage
								? new SteerRequestInterruptError()
								: new Error("Request cancelled by user"),
						)
					})
				}
			})

			const firstChunk = await withApiRequestTimeout(
				Promise.race([firstChunkPromise, abortPromise]),
				`API response stream for ${this.api.getModel().id}`,
				getApiRequestTimeout(),
				() => this.currentRequestAbortController?.abort(),
			)
			yield firstChunk.value
			this.isWaitingForFirstChunk = false
		} catch (error) {
			this.isWaitingForFirstChunk = false
			this.currentRequestAbortController = undefined
			if (error instanceof SteerRequestInterruptError) {
				throw error
			}

			const isContextWindowExceededError = checkContextWindowExceededError(error)

			// If it's a context window error and we haven't exceeded max retries for this error type
			if (isContextWindowExceededError && retryAttempt < MAX_CONTEXT_WINDOW_RETRIES) {
				console.warn(
					`[Task#${this.taskId}] Context window exceeded for model ${this.api.getModel().id}. ` +
						`Retry attempt ${retryAttempt + 1}/${MAX_CONTEXT_WINDOW_RETRIES}. ` +
						`Attempting automatic truncation...`,
				)
				await this.handleContextWindowExceededError()
				this.retryStepContext = undefined
				await this.recordAgentTurnEvent(
					{ type: "retry", attempt: retryAttempt + 1, reason: "context_window_exceeded" },
					this.lastCompactionStepContext,
				)
				// Retry the request after handling the context window error
				yield* this.attemptApiRequest(retryAttempt + 1)
				return
			}

			// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.
			if (autoApprovalEnabled) {
				// Apply shared exponential backoff and countdown UX
				await this.backoffAndAnnounce(retryAttempt, error)

				// CRITICAL: Check if task was aborted during the backoff countdown
				// This prevents infinite loops when users cancel during auto-retry
				// Without this check, the recursive call below would continue even after abort
				if (this.abort) {
					throw new Error(
						`[Task#attemptApiRequest] task ${this.taskId}.${this.instanceId} aborted during retry`,
					)
				}
				await this.recordAgentTurnEvent(
					{ type: "retry", attempt: retryAttempt + 1, reason: "provider_request_failed" },
					this.retryStepContext,
				)

				// Delegate generator output from the recursive call with
				// incremented retry count.
				yield* this.attemptApiRequest(retryAttempt + 1)

				return
			} else {
				const { response } = await this.ask(
					"api_req_failed",
					error.message ?? JSON.stringify(serializeError(error), null, 2),
				)

				if (response !== "yesButtonClicked") {
					// This will never happen since if noButtonClicked, we will
					// clear current task, aborting this instance.
					throw new Error("API request failed")
				}

				await this.say("api_req_retried")
				await this.recordAgentTurnEvent(
					{ type: "retry", attempt: retryAttempt + 1, reason: "user_retry" },
					this.retryStepContext,
				)

				// Delegate generator output from the recursive call.
				yield* this.attemptApiRequest(retryAttempt + 1)
				return
			}
		}

		// No error, so we can continue to yield all remaining chunks.
		// (Needs to be placed outside of try/catch since it we want caller to
		// handle errors not with api_req_failed as that is reserved for first
		// chunk failures only.)
		// This delegates to another generator or iterable object. In this case,
		// it's saying "yield all remaining values from this iterator". This
		// effectively passes along all subsequent chunks from the original
		// stream.
		yield* iterator
	}

	// Shared exponential backoff for retries (first-chunk and mid-stream)
	private async backoffAndAnnounce(retryAttempt: number, error: any): Promise<void> {
		try {
			const state = await this.providerRef.deref()?.getState()
			const baseDelay = state?.requestDelaySeconds || 5

			let exponentialDelay = Math.min(
				Math.ceil(baseDelay * Math.pow(2, retryAttempt)),
				MAX_EXPONENTIAL_BACKOFF_SECONDS,
			)
			const retryAfterMs = this.getRetryAfterMs(error)
			if (retryAfterMs > 0) {
				Task.requestPacer.observeRetryAfter(performance.now(), retryAfterMs)
				exponentialDelay = Math.max(exponentialDelay, Math.ceil(retryAfterMs / 1000))
			}

			// Respect provider rate limit window
			let rateLimitDelay = 0
			const rateLimit = (state?.apiConfiguration ?? this.apiConfiguration)?.rateLimitSeconds || 0
			if (Task.lastGlobalApiRequestTime && rateLimit > 0) {
				const elapsed = performance.now() - Task.lastGlobalApiRequestTime
				rateLimitDelay = Math.ceil(Math.min(rateLimit, Math.max(0, rateLimit * 1000 - elapsed) / 1000))
			}

			// Prefer RetryInfo on 429 if present
			if (error?.status === 429) {
				const retryInfo = error?.errorDetails?.find(
					(d: any) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
				)
				const match = retryInfo?.retryDelay?.match?.(/^(\d+)s$/)
				if (match) {
					exponentialDelay = Number(match[1]) + 1
				}
			}

			const finalDelay = Math.max(exponentialDelay, rateLimitDelay)
			if (finalDelay <= 0) {
				return
			}

			// Build header text; fall back to error message if none provided
			let headerText
			if (error.status) {
				// Include both status code (for ChatRow parsing) and detailed message (for error details)
				// Format: "<status>\n<message>" allows ChatRow to extract status via parseInt(text.substring(0,3))
				// while preserving the full error message in errorDetails for debugging
				const errorMessage = error?.message || "Unknown error"
				headerText = `${error.status}\n${errorMessage}`
			} else if (error?.message) {
				headerText = error.message
			} else {
				headerText = "Unknown error"
			}

			headerText = headerText ? `${headerText}\n` : ""

			// Show countdown timer with exponential backoff
			for (let i = finalDelay; i > 0; i--) {
				// Check abort flag during countdown to allow early exit
				if (this.abort) {
					throw new Error(`[Task#${this.taskId}] Aborted during retry countdown`)
				}

				await this.say("api_req_retry_delayed", `${headerText}<retry_timer>${i}</retry_timer>`, undefined, true)
				await delay(1000)
			}

			await this.say("api_req_retry_delayed", headerText, undefined, false)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)

			if (this.abort && message.includes("Aborted during retry countdown")) {
				return
			}

			console.error("Exponential backoff failed:", err)
		}
	}

	private getRetryAfterMs(error: any, now = Date.now()): number {
		const headers = error?.headers ?? error?.response?.headers
		const readHeader = (name: string): unknown =>
			typeof headers?.get === "function"
				? headers.get(name)
				: (headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()])
		const retryAfter = readHeader("retry-after")
		if (retryAfter !== undefined && retryAfter !== null) {
			const seconds = Number(retryAfter)
			if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
			const date = Date.parse(String(retryAfter))
			if (Number.isFinite(date)) return Math.max(0, date - now)
		}
		const reset = Number(readHeader("x-ratelimit-reset"))
		if (Number.isFinite(reset) && reset > 0) {
			const resetMs = reset > 10_000_000_000 ? reset : reset * 1000
			return Math.max(0, resetMs - now)
		}
		return 0
	}

	// Checkpoints

	public async checkpointSave(force: boolean = false, suppressMessage: boolean = false) {
		return checkpointSave(this, force, suppressMessage)
	}

	private buildCleanConversationHistory(
		messages: ApiMessage[],
	): Array<
		Anthropic.Messages.MessageParam | { type: "reasoning"; encrypted_content: string; id?: string; summary?: any[] }
	> {
		type ReasoningItemForRequest = {
			type: "reasoning"
			encrypted_content: string
			id?: string
			summary?: any[]
		}

		const cleanConversationHistory: (Anthropic.Messages.MessageParam | ReasoningItemForRequest)[] = []

		for (const msg of messages) {
			// Standalone reasoning: send encrypted, skip plain text
			if (msg.type === "reasoning") {
				if (msg.encrypted_content) {
					cleanConversationHistory.push({
						type: "reasoning",
						summary: msg.summary,
						encrypted_content: msg.encrypted_content!,
						...(msg.id ? { id: msg.id } : {}),
					})
				}
				continue
			}

			// Preferred path: assistant message with embedded reasoning as first content block
			if (msg.role === "assistant") {
				const rawContent = msg.content

				const contentArray: Anthropic.Messages.ContentBlockParam[] = Array.isArray(rawContent)
					? (rawContent as Anthropic.Messages.ContentBlockParam[])
					: rawContent !== undefined
						? ([
								{ type: "text", text: rawContent } satisfies Anthropic.Messages.TextBlockParam,
							] as Anthropic.Messages.ContentBlockParam[])
						: []

				const [first, ...rest] = contentArray

				// Check if this message has reasoning_details (OpenRouter format for Gemini 3, etc.)
				const msgWithDetails = msg
				if (msgWithDetails.reasoning_details && Array.isArray(msgWithDetails.reasoning_details)) {
					// Build the assistant message with reasoning_details
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (contentArray.length === 0) {
						assistantContent = ""
					} else if (contentArray.length === 1 && contentArray[0].type === "text") {
						assistantContent = (contentArray[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = contentArray
					}

					// Create message with reasoning_details property
					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
						reasoning_details: msgWithDetails.reasoning_details,
					} as any)

					continue
				}

				// Embedded reasoning: encrypted (send) or plain text (skip)
				const hasEncryptedReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).encrypted_content === "string"
				const hasPlainTextReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).text === "string"

				if (hasEncryptedReasoning) {
					const reasoningBlock = first as any

					// Send as separate reasoning item (OpenAI Native)
					cleanConversationHistory.push({
						type: "reasoning",
						summary: reasoningBlock.summary ?? [],
						encrypted_content: reasoningBlock.encrypted_content,
						...(reasoningBlock.id ? { id: reasoningBlock.id } : {}),
					})

					// Send assistant message without reasoning
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (rest.length === 0) {
						assistantContent = ""
					} else if (rest.length === 1 && rest[0].type === "text") {
						assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = rest
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
					} satisfies Anthropic.Messages.MessageParam)

					continue
				} else if (hasPlainTextReasoning) {
					// Check if the model's preserveReasoning flag is set
					// If true, include the reasoning block in API requests
					// If false/undefined, strip it out (stored for history only, not sent back to API)
					const shouldPreserveForApi = this.api.getModel().info.preserveReasoning === true
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (shouldPreserveForApi) {
						// Include reasoning block in the content sent to API
						assistantContent = contentArray
					} else {
						// Strip reasoning out - stored for history only, not sent back to API
						if (rest.length === 0) {
							assistantContent = ""
						} else if (rest.length === 1 && rest[0].type === "text") {
							assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
						} else {
							assistantContent = rest
						}
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
					} satisfies Anthropic.Messages.MessageParam)

					continue
				}
			}

			// Default path for regular messages (no embedded reasoning)
			if (msg.role) {
				cleanConversationHistory.push({
					role: msg.role,
					content: msg.content as Anthropic.Messages.ContentBlockParam[] | string,
				})
			}
		}

		return cleanConversationHistory
	}
	public async checkpointRestore(options: CheckpointRestoreOptions) {
		return checkpointRestore(this, options)
	}

	public async checkpointDiff(options: CheckpointDiffOptions) {
		return checkpointDiff(this, options)
	}

	// Metrics

	public combineMessages(messages: ClineMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	public getTokenUsage(): TokenUsage {
		return getApiMetrics(this.combineMessages(this.clineMessages.slice(1)))
	}

	public recordToolUsage(toolName: ToolName) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].attempts++
	}

	public recordToolError(toolName: ToolName, error?: string) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].failures++

		if (error) {
			this.emit(RooCodeEventName.TaskToolFailed, this.taskId, toolName, error)
		}
	}

	public getTaskCancellationSignal(): AbortSignal {
		return this.currentRequestAbortController?.signal ?? this.taskCancellationController.signal
	}

	public requireChildVerification(taskId: string): void {
		this.childTasksRequiringVerification.add(taskId)
	}

	public getChildTasksRequiringVerification(): readonly string[] {
		return [...this.childTasksRequiringVerification]
	}

	private hasPendingChildVerification(): boolean {
		return this.childTasksRequiringVerification.size > 0
	}

	public shouldStopRepeatedToolCall(name: string, args: unknown): boolean {
		const block = {
			type: "tool_use",
			name,
			params: {},
			nativeArgs: args,
			partial: false,
		} as ToolUse
		return !this.toolRepetitionDetector.check(block).allowExecution
	}

	public recordToolCallForStopping(
		_name: string,
		_args: unknown,
		_status: "success" | "error" | "denied" | "cancelled",
		_commandCategory?: string,
	): void {
		// Repetition is recorded before execution by shouldStopRepeatedToolCall.
		// This post-execution hook keeps the scheduler contract stable for future
		// outcome-aware stopping policies without counting a call twice.
	}

	// Getters

	public get taskStatus(): TaskStatus {
		if (this.interactiveAsk) {
			return TaskStatus.Interactive
		}

		if (this.resumableAsk) {
			return TaskStatus.Resumable
		}

		if (this.idleAsk) {
			return TaskStatus.Idle
		}

		return TaskStatus.Running
	}

	public get taskAsk(): ClineMessage | undefined {
		return this.idleAsk || this.resumableAsk || this.interactiveAsk
	}

	public get queuedMessages(): QueuedMessage[] {
		return this.messageQueueService.messages
	}

	public get tokenUsage(): TokenUsage | undefined {
		if (this.tokenUsageSnapshot && this.tokenUsageSnapshotAt) {
			return this.tokenUsageSnapshot
		}

		this.tokenUsageSnapshot = this.getTokenUsage()
		this.tokenUsageSnapshotAt = this.clineMessages.at(-1)?.ts

		return this.tokenUsageSnapshot
	}

	public get cwd() {
		return this.workspacePath
	}

	/**
	 * Provides convenient access to high-level message operations.
	 * Uses lazy initialization - the MessageManager is only created when first accessed.
	 * Subsequent accesses return the same cached instance.
	 *
	 * ## Important: Single Coordination Point
	 *
	 * **All MessageManager operations must go through this getter** rather than
	 * instantiating `new MessageManager(task)` directly. This ensures:
	 * - A single shared instance for consistent behavior
	 * - Centralized coordination of all rewind/message operations
	 * - Ability to add internal state or instrumentation in the future
	 *
	 * @example
	 * ```typescript
	 * // Correct: Use the getter
	 * await task.messageManager.rewindToTimestamp(ts)
	 *
	 * // Incorrect: Do NOT create new instances directly
	 * // const manager = new MessageManager(task) // Don't do this!
	 * ```
	 */
	get messageManager(): MessageManager {
		if (!this._messageManager) {
			this._messageManager = new MessageManager(this)
		}
		return this._messageManager
	}

	/**
	 * Queued messages are intentionally drained only from completion/resume asks.
	 * Tool-level callers still invoke this as a compatibility hook, but it must
	 * not promote queued messages mid-turn.
	 */
	public processQueuedMessages(): void {
		// Intentionally empty.
	}
}
