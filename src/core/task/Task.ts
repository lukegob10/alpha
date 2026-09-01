import * as path from "path"
import * as fsSync from "fs"
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
	type SubagentGroupState,
	type SubagentAuthorityGrant,
	type SubagentChangeSetState,
	type ExternalMutationCapability,
	type SubagentContextManifest,
	type SubagentDelegationPolicy,
	type SubagentModelRouteState,
	type SubagentRole,
	type SubagentStopReason,
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
	resolveSubagentDelegationPolicy,
	disabledSubagentAutoApprovalPolicy,
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
import { formatLanguage } from "../../shared/language"
import { getApiMetrics, hasTokenUsageChanged, hasToolUsageChanged } from "../../shared/getApiMetrics"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug, getModeBySlug, getModeSelection, planModeSlug } from "../../shared/modes"
import { DiffStrategy, type ToolUse, type ToolParamName, toolParamNames } from "../../shared/tools"
import { getModelMaxOutputTokens } from "../../shared/api"
import { ensureProposedPlanBlock } from "../../shared/plan-mode"

// services
import { McpHub } from "../../services/mcp/McpHub"
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
import { SYSTEM_PROMPT, getPromptComponent } from "../prompts/system"
import { addCustomInstructions, loadApplicableAgentInstructionSources } from "../prompts/sections"
import { buildNativeToolsArrayWithRestrictions } from "./build-tools"

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { redactTaskPrivatePaths } from "../tools/taskPathPresentation"
import { restoreTodoListForTask } from "../tools/UpdateTodoListTool"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { RooProtectedController } from "../protect/RooProtectedController"
import { type AssistantMessageContent, presentAssistantMessage } from "../assistant-message"
import { NativeToolCallParser, type ToolCallStreamEvent } from "../assistant-message/NativeToolCallParser"
import { manageContext, willManageContext } from "../context-management"
import { ClineProvider } from "../webview/ClineProvider"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import {
	type ApiMessage,
	assertFrozenSubagentInstructions,
	readApiMessages,
	readSubagentInstructionSnapshot,
	saveApiMessages,
	saveSubagentInstructionSnapshot,
	readTaskMessages,
	saveTaskMessages,
	taskMetadata,
} from "../task-persistence"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
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
import { AutoApprovalHandler, checkAutoApprovalWithInheritedPolicy } from "../auto-approval"
import { MessageManager } from "../message-manager"
import { validateAndFixToolResultIds } from "./validateToolResultIds"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"
import {
	AgentTurnEngine,
	type AgentResponse,
	type AgentResponseItem,
	type AgentTurnHost,
} from "../agent/AgentTurnEngine"
import {
	isValidSubagentContextManifest,
	type SubagentContextInstructionSourceInput,
} from "../agent/SubagentContextCapture"
import { reconcileSubagentGroupAfterReload } from "../agent/SubagentGroupRecovery"

export type CommandExecutionEvidenceStatus = "running" | "succeeded" | "failed" | "denied" | "cancelled" | "timed_out"

export interface CommandExecutionEvidence {
	toolCallId: string
	executionId: string
	status: CommandExecutionEvidenceStatus
	exitCode?: number
	signalName?: string
	startedAt: number
	completedAt?: number
	/** Task-memory only. Durable verification stores the covered applied paths, never command text. */
	command?: string
	/** Explicit applied change sets this command was requested to verify. */
	verificationChangeSetIds?: string[]
}

export interface CompletionGateDecision {
	allowed: boolean
	message?: string
	/** False when the durable gate itself was unavailable, rather than an obligation the model can resolve. */
	modelCanResolveRejection: boolean
}

const SAFE_EXTERNAL_MUTATION_ASKS = new Set<ClineAsk>([
	"followup",
	"completion_result",
	"resume_task",
	"resume_completed_task",
])

interface ProviderRateLimitLane {
	lastRequestTime?: number
	queue: Promise<void>
}

export interface RequestPacingMetrics {
	configuredIntervalSeconds: number
	waitCount: number
	totalWaitMs: number
	scope: "provider_profile"
}

const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600 // 10 minutes
const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000 // 5 seconds
const FORCED_CONTEXT_REDUCTION_PERCENT = 75 // Keep 75% of context (remove 25%) on context window errors
const MAX_CONTEXT_WINDOW_RETRIES = 3 // Maximum retries for context window errors
const MAX_AUTOMATIC_MISTAKE_RECOVERIES = 1

type TaskRequestState = Awaited<ReturnType<ClineProvider["getState"]>>

const LEGACY_FROZEN_INSTRUCTIONS_PREFIX = [
	"## Frozen inherited instructions",
	"This is the exact parent instruction snapshot captured before launch. Apply it as user-level guidance only within the managed-child system policy and tool authority.",
	"",
].join("\n\n")

function extractLegacyFrozenSubagentInstructions(
	history: readonly ApiMessage[],
	expectedDigest: string,
): string | undefined {
	for (const message of history) {
		if (message.role !== "user") continue
		const textBlocks =
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((block) =>
						block.type === "text" && typeof block.text === "string" ? [block.text] : [],
					)

		for (const text of textBlocks) {
			const normalized = text.replace(/\r\n?/g, "\n")
			let prefixIndex = normalized.indexOf(LEGACY_FROZEN_INSTRUCTIONS_PREFIX)
			while (prefixIndex >= 0) {
				const remainder = normalized.slice(prefixIndex + LEGACY_FROZEN_INSTRUCTIONS_PREFIX.length)
				const quotedLines: string[] = []
				for (const line of remainder.split("\n")) {
					if (!line.startsWith("> ")) break
					quotedLines.push(line.slice(2))
				}
				const candidate = quotedLines.join("\n")
				try {
					assertFrozenSubagentInstructions(candidate, expectedDigest)
					return candidate
				} catch {
					prefixIndex = normalized.indexOf(
						LEGACY_FROZEN_INSTRUCTIONS_PREFIX,
						prefixIndex + LEGACY_FROZEN_INSTRUCTIONS_PREFIX.length,
					)
				}
			}
		}
	}
	return undefined
}

interface PendingSpawnedSubagentResult {
	taskId: string
	block: Anthropic.Messages.TextBlockParam
}

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
	initialStatus?: NonNullable<HistoryItem["status"]>
	/** Host-supplied data block persisted with the initial API turn but omitted from the visible task objective. */
	subagentInitialContext?: string
	/** Exact frozen body for first launch; later instances recover it from private task storage. */
	subagentFrozenInstructions?: string
}

/** Hard task-lane capability ceiling used both by capture manifests and runtime filtering. */
export function getSubagentAllowedToolNames(
	role: SubagentRole,
	hasInheritedSkills = false,
	allowDelegation = false,
): readonly ToolName[] {
	const tools: ToolName[] =
		role === "worker"
			? [
					"read_file",
					"search_files",
					"list_files",
					"codebase_search",
					"write_to_file",
					"apply_diff",
					"edit",
					"search_and_replace",
					"search_replace",
					"edit_file",
					"apply_patch",
					"execute_command",
					"read_command_output",
					"attempt_completion",
				]
			: ["read_file", "search_files", "list_files", "codebase_search", "attempt_completion"]
	tools.splice(tools.length - 1, 0, "report_progress")
	if (hasInheritedSkills) tools.splice(tools.length - 1, 0, "skill")
	if (allowDelegation) {
		tools.splice(
			tools.length - 1,
			0,
			"spawn_agent",
			"list_agents",
			"wait_agent",
			"send_message",
			"followup_task",
			"interrupt_agent",
			"cancel_agent",
			"close_agent",
		)
	}
	return tools
}

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	readonly taskKind: "primary" | "subagent"
	readonly subagentGroupId?: string
	readonly subagentNickname?: string
	readonly subagentRole?: SubagentRole
	public subagentCompletionOutcome?: "completed" | "blocked"
	readonly subagentModelRoute?: SubagentModelRouteState
	readonly subagentContextManifest?: SubagentContextManifest
	readonly subagentInstructionPlacement?: "system"
	readonly subagentDelegationPolicy?: SubagentDelegationPolicy
	readonly subagentDelegationExplicitlyEnabled?: boolean
	private subagentStopReason?: SubagentStopReason
	private subagentFrozenInstructions?: string
	private subagentInstructionSnapshotLoaded = false
	private subagentInstructionSnapshotPersisted = false
	private readonly subagentInitialContext?: string
	readonly subagentWriteScope?: string[]
	private subagentChangeSet?: SubagentChangeSetState
	childTaskId?: string
	pendingNewTaskToolCallId?: string

	readonly instanceId: string
	readonly metadata: TaskMetadata

	todoList?: TodoItem[]

	readonly rootTask: Task | undefined
	readonly parentTask: Task | undefined = undefined
	readonly taskNumber: number
	readonly workspacePath: string
	readonly historyWorkspacePath: string
	readonly subagentPrivateWorkspaceRoot?: string

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
	abort: boolean = false
	private abortTaskPromise?: Promise<void>
	currentRequestAbortController?: AbortController
	private readonly taskCancellationController = new AbortController()
	private agentWaitAbortController?: AbortController
	private readonly subagentAuthority?: SubagentAuthorityGrant
	private readonly subagentResearchDeadlineAt?: number
	private readonly childTasksRequiringVerification = new Set<string>()
	private readonly commandExecutionEvidence = new Map<string, CommandExecutionEvidence>()
	private pendingSteerMessage?: {
		text: string
		images: string[]
		onPersisted?: () => Promise<void> | void
	}
	private pendingAutomaticResultClaimSettlement?: {
		claimId: string
		disposition: "acknowledge" | "release"
	}
	private readonly pendingWaitAgentResultClaims = new Map<string, string>()
	private readonly persistedToolResultIds = new Set<string>()
	private steerMessageAwaitingPersistence = false
	private isAgentTurnEngineActive = false
	private externalMutationLease?: { label: string; token: symbol }
	private deferredAskResponse?: { askResponse: ClineAskResponse; text?: string; images?: string[] }
	private subagentReviewBarrier?: { promise: Promise<void>; resolve: () => void }
	private isAwaitingSubagentReview = false
	private isTaskLoopActive = false
	private didComplete = false
	private didEmitTaskCompleted = false
	private suspendAfterCurrentTurnReason?: string
	private currentAssistantResponseMessageTs: number | undefined
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
	private static providerRateLimitLanes = new Map<string, ProviderRateLimitLane>()
	private requestPacingWaitCount = 0
	private requestPacingWaitMs = 0
	private autoApprovalHandler: AutoApprovalHandler

	/**
	 * Reset all provider-profile request-pacing lanes. This should only be used for testing.
	 * @internal
	 */
	static resetGlobalApiRequestTime(): void {
		Task.providerRateLimitLanes.clear()
	}

	/** Task-local observations for the configured provider-profile pacing lane. */
	public getRequestPacingMetrics(): RequestPacingMetrics {
		return {
			configuredIntervalSeconds: Math.max(0, this.apiConfiguration?.rateLimitSeconds ?? 0),
			waitCount: this.requestPacingWaitCount,
			totalWaitMs: Math.round(this.requestPacingWaitMs),
			scope: "provider_profile",
		}
	}

	/** Add the just-completed pacing wait to the model-facing request already persisted for this turn. */
	private async appendRequestPacingUpdateToLatestUserMessage(): Promise<void> {
		const metrics = this.getRequestPacingMetrics()
		let latestUserMessage: ApiMessage | undefined
		for (let index = this.apiConversationHistory.length - 1; index >= 0; index--) {
			if (this.apiConversationHistory[index].role === "user") {
				latestUserMessage = this.apiConversationHistory[index]
				break
			}
		}
		if (!latestUserMessage) return

		const update = {
			type: "text" as const,
			text: `<request_pacing_update wait_count="${metrics.waitCount}" total_wait_ms="${metrics.totalWaitMs}" interval_seconds="${metrics.configuredIntervalSeconds}" scope="provider_profile_shared" classification="configured_pacing_not_provider_error" />`,
		}
		const currentContent = Array.isArray(latestUserMessage.content)
			? latestUserMessage.content.filter(
					(block) =>
						!(
							block.type === "text" &&
							typeof block.text === "string" &&
							block.text.startsWith("<request_pacing_update ")
						),
				)
			: [{ type: "text" as const, text: latestUserMessage.content }]
		latestUserMessage.content = [...currentContent, update]
		await this.saveApiConversationHistory()
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
	private clineMessagesSaveQueue: Promise<void> = Promise.resolve()

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
	private automaticMistakeRecoveryCount: number = 0
	private lastToolFailure?: { toolName: ToolName; error?: string }
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
	 * Push a tool_result block to userMessageContent, preventing duplicates.
	 * Duplicate tool_use_ids cause API errors.
	 *
	 * @param toolResult - The tool_result block to add
	 * @returns true if added, false if duplicate was skipped
	 */
	public pushToolResultToUserContent(toolResult: Anthropic.ToolResultBlockParam): boolean {
		const normalizedToolUseId = sanitizeToolUseId(toolResult.tool_use_id)
		if (this.persistedToolResultIds.has(normalizedToolUseId)) {
			return false
		}
		const existingResult = this.userMessageContent.find(
			(block): block is Anthropic.ToolResultBlockParam =>
				block.type === "tool_result" && sanitizeToolUseId(block.tool_use_id) === normalizedToolUseId,
		)
		if (existingResult) {
			console.warn(
				`[Task#pushToolResultToUserContent] Skipping duplicate tool_result for tool_use_id: ${toolResult.tool_use_id}`,
			)
			return false
		}
		const content =
			typeof toolResult.content === "string"
				? redactTaskPrivatePaths(this, toolResult.content)
				: toolResult.content?.map((block) =>
						block.type === "text" ? { ...block, text: redactTaskPrivatePaths(this, block.text) } : block,
					)
		this.userMessageContent.push({ ...toolResult, tool_use_id: normalizedToolUseId, content })
		return true
	}

	/**
	 * Retain native wait_agent claim ownership until its matching tool_result is
	 * durably present in API history. Rendering a lifecycle row is deliberately
	 * not a consumption receipt.
	 */
	public retainWaitAgentResultClaim(toolCallId: string, claimId: string): void {
		const normalizedToolCallId = sanitizeToolUseId(toolCallId)
		const normalizedClaimId = claimId.trim()
		if (!normalizedToolCallId || !normalizedClaimId) {
			throw new Error("wait_agent result claims require a tool call ID and mailbox claim ID")
		}
		this.pendingWaitAgentResultClaims.set(normalizedToolCallId, normalizedClaimId)
	}

	public forgetWaitAgentResultClaim(claimId: string): void {
		for (const [toolCallId, retainedClaimId] of this.pendingWaitAgentResultClaims) {
			if (retainedClaimId === claimId) this.pendingWaitAgentResultClaims.delete(toolCallId)
		}
	}

	private waitAgentClaimsPersistedBy(message: Anthropic.MessageParam): string[] {
		if (message.role !== "user" || !Array.isArray(message.content)) return []
		const persistedClaimIds = new Set<string>()
		for (const block of message.content) {
			if (block.type !== "tool_result") continue
			const retainedClaimId = this.pendingWaitAgentResultClaims.get(sanitizeToolUseId(block.tool_use_id))
			if (!retainedClaimId) continue
			const textParts =
				typeof block.content === "string"
					? [block.content]
					: (block.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))
			for (const text of textParts) {
				try {
					const receipt = JSON.parse(text) as { source?: unknown; claimId?: unknown }
					if (receipt.source === "managed_agent_mailbox" && receipt.claimId === retainedClaimId) {
						persistedClaimIds.add(retainedClaimId)
						break
					}
				} catch {
					// Error and compatibility tool results are not native mailbox receipts.
				}
			}
		}
		return [...persistedClaimIds]
	}

	private async settlePersistedWaitAgentResultClaims(message: Anthropic.MessageParam): Promise<void> {
		const claimIds = this.waitAgentClaimsPersistedBy(message)
		if (claimIds.length === 0) return
		const provider = this.providerRef.deref()
		if (!provider?.acknowledgeWaitAgentResults) return

		for (const claimId of claimIds) {
			try {
				await provider.acknowledgeWaitAgentResults(this, claimId)
				this.forgetWaitAgentResultClaim(claimId)
			} catch (error) {
				// AgentControlStore retains a failed settlement for same-host retry,
				// while the durable API-history receipt supports full reload recovery.
				console.error(`[Task#${this.taskId}] Failed to acknowledge persisted wait_agent result:`, error)
			}
		}
	}

	private async settleAllPersistedWaitAgentResultClaims(): Promise<void> {
		for (const message of this.apiConversationHistory) {
			await this.settlePersistedWaitAgentResultClaims(message)
			if (this.pendingWaitAgentResultClaims.size === 0) return
		}
	}

	private processNativeToolCallStreamEvents(events: ToolCallStreamEvent[]): void {
		for (const event of events) {
			if (event.type === "tool_call_start") {
				// Guard against duplicate tool_call_start events for the same tool ID.
				// This can occur due to stream retry, reconnection, or API quirks.
				// Without this check, duplicate tool_use blocks with the same ID would
				// be added to assistantMessageContent, causing API 400 errors:
				// "tool_use ids must be unique"
				if (this.streamingToolCallIndices.has(event.id)) {
					console.warn(
						`[Task#${this.taskId}] Ignoring duplicate tool_call_start for ID: ${event.id} (tool: ${event.name})`,
					)
					continue
				}

				// Initialize streaming in NativeToolCallParser
				NativeToolCallParser.startStreamingToolCall(event.id, event.name as ToolName, this.taskId)

				// Before adding a new tool, finalize any preceding text block
				// This prevents the text block from blocking tool presentation
				const lastBlock = this.assistantMessageContent[this.assistantMessageContent.length - 1]
				if (lastBlock?.type === "text" && lastBlock.partial) {
					lastBlock.partial = false
				}

				// Track the index where this tool will be stored
				const toolUseIndex = this.assistantMessageContent.length
				this.streamingToolCallIndices.set(event.id, toolUseIndex)

				// Create initial partial tool use
				const partialToolUse: ToolUse = {
					type: "tool_use",
					name: event.name as ToolName,
					params: {},
					partial: true,
				}

				// Store the ID for native protocol
				;(partialToolUse as any).id = event.id

				// Add to the response buffer. Tool execution is deferred until the
				// provider stream has completed and the assistant message is saved.
				this.assistantMessageContent.push(partialToolUse)
				this.userMessageContentReady = false
			} else if (event.type === "tool_call_delta") {
				// Process chunk using streaming JSON parser
				const partialToolUse = NativeToolCallParser.processStreamingChunk(event.id, event.delta, this.taskId)

				if (partialToolUse) {
					// Get the index for this tool call
					const toolUseIndex = this.streamingToolCallIndices.get(event.id)
					if (toolUseIndex !== undefined) {
						// Store the ID for native protocol
						;(partialToolUse as any).id = event.id

						// Update the existing tool use with new partial data
						this.assistantMessageContent[toolUseIndex] = partialToolUse
					}
				}
			} else if (event.type === "tool_call_end") {
				// Finalize the streaming tool call
				const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(event.id, this.taskId)

				// Get the index for this tool call
				const toolUseIndex = this.streamingToolCallIndices.get(event.id)

				if (finalToolUse) {
					// Store the tool call ID
					;(finalToolUse as any).id = event.id

					// Get the index and replace partial with final
					if (toolUseIndex !== undefined) {
						this.assistantMessageContent[toolUseIndex] = finalToolUse
					}

					// Clean up tracking
					this.streamingToolCallIndices.delete(event.id)

					// Mark that we have new content to process
					this.userMessageContentReady = false
				} else if (toolUseIndex !== undefined) {
					// finalizeStreamingToolCall returned null (malformed JSON or missing args)
					// Mark the tool as non-partial so it's presented as complete, but execution
					// will be short-circuited in presentAssistantMessage with a structured tool_result.
					const existingToolUse = this.assistantMessageContent[toolUseIndex]
					if (existingToolUse && existingToolUse.type === "tool_use") {
						existingToolUse.partial = false
						// Ensure it has the ID for native protocol
						;(existingToolUse as any).id = event.id
					}

					// Clean up tracking
					this.streamingToolCallIndices.delete(event.id)

					// Mark that we have new content to process
					this.userMessageContentReady = false
				}
			}
		}
	}

	didRejectTool = false
	didAlreadyUseTool = false
	didToolFailInCurrentTurn = false
	didCompleteReadingStream = false
	private _started = false
	// No streaming parser is required.
	assistantMessageParser?: undefined

	// Native tool call streaming state (track which index each tool is at)
	private streamingToolCallIndices: Map<string, number> = new Map()

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
	private initialStatus?: NonNullable<HistoryItem["status"]>

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
		subagentInitialContext,
		subagentFrozenInstructions,
		taskKind,
		subagentGroupId,
		subagentNickname,
		subagentRole,
		subagentModelRoute,
		subagentContextManifest,
		subagentInstructionPlacement,
		subagentDelegationPolicy,
		subagentDelegationExplicitlyEnabled,
		subagentAuthority,
		subagentWriteScope,
		subagentChangeSet,
		historyWorkspacePath,
		subagentPrivateWorkspaceRoot,
		subagentResearchDeadlineAt,
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
		const contextManifest = historyItem?.subagentContextManifest ?? subagentContextManifest
		if (contextManifest && !isValidSubagentContextManifest(contextManifest)) {
			throw new Error("Managed child context manifest failed integrity validation")
		}
		// A finalized managed-child manifest is the durable identity authority. Live
		// Task pointers and older HistoryItems remain fallbacks for primary tasks and
		// pre-orchestration children, but cannot narrow a depth-two child to its
		// immediate parent after creation or reload.
		this.rootTaskId =
			contextManifest?.orchestration?.ancestry.rootTaskId ?? historyItem?.rootTaskId ?? rootTask?.taskId
		this.parentTaskId =
			contextManifest?.orchestration?.ancestry.parentTaskId ?? historyItem?.parentTaskId ?? parentTask?.taskId
		this.taskKind = historyItem?.taskKind ?? taskKind ?? "primary"
		this.subagentGroupId = historyItem?.subagentGroupId ?? subagentGroupId
		this.subagentNickname = historyItem?.subagentNickname ?? subagentNickname
		this.subagentRole = historyItem?.subagentRole ?? subagentRole
		this.subagentModelRoute = structuredClone(historyItem?.subagentModelRoute ?? subagentModelRoute)
		this.subagentContextManifest = structuredClone(contextManifest)
		this.subagentInstructionPlacement = historyItem?.subagentInstructionPlacement ?? subagentInstructionPlacement
		this.subagentDelegationPolicy = historyItem?.subagentDelegationPolicy ?? subagentDelegationPolicy
		this.subagentDelegationExplicitlyEnabled =
			historyItem?.subagentDelegationExplicitlyEnabled ?? subagentDelegationExplicitlyEnabled
		this.subagentStopReason = historyItem?.stopReason
		this.subagentAuthority = subagentAuthority
		this.subagentWriteScope =
			historyItem?.subagentWriteScope ??
			subagentWriteScope ??
			(subagentAuthority?.role === "worker" ? subagentAuthority.writeScope : undefined)
		this.subagentChangeSet = structuredClone(historyItem?.subagentChangeSet ?? subagentChangeSet)
		this.subagentResearchDeadlineAt = subagentResearchDeadlineAt
		this.subagentInitialContext = subagentInitialContext
		if (subagentFrozenInstructions !== undefined) {
			if (!contextManifest) throw new Error("Managed child frozen instructions require a context manifest")
			assertFrozenSubagentInstructions(subagentFrozenInstructions, contextManifest.instructions.digest)
			this.subagentFrozenInstructions = subagentFrozenInstructions
		}
		this.childTaskId = undefined

		this.metadata = {
			task: historyItem ? historyItem.task : task,
			images: historyItem ? [] : images,
		}

		// Normal use-case is usually retry similar history task with new workspace.
		this.workspacePath =
			workspacePath ?? parentTask?.workspacePath ?? getWorkspacePath(path.join(os.homedir(), "Desktop"))
		this.historyWorkspacePath =
			historyWorkspacePath ?? historyItem?.workspace ?? parentTask?.historyWorkspacePath ?? this.workspacePath
		this.subagentPrivateWorkspaceRoot = subagentPrivateWorkspaceRoot

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

		this.rootTask = rootTask
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

		let queuedMessageCount = 0
		this.messageQueueStateChangedHandler = () => {
			const currentMessageCount = this.messageQueueService.messages.length
			if (currentMessageCount > queuedMessageCount) {
				// A new user-authored instruction breaks a sequence of model mistakes.
				// Do not let a stale error pre-empt the queued guidance with the
				// mistake-limit dialog before the model can act on it.
				this.resetMistakeRecoveryState()
			}
			queuedMessageCount = currentMessageCount
			this.emit(RooCodeEventName.TaskUserMessage, this.taskId)
			this.emit(RooCodeEventName.QueuedMessagesUpdated, this.taskId, this.messageQueueService.messages)
			void this.providerRef
				.deref()
				?.postTaskQueueToWebview(this.taskId, this.messageQueueService.messages)
				.catch(() => undefined)
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
				this.ownBackgroundLifecycle("start", this.startTask(task, images))
			} else if (historyItem) {
				this.ownBackgroundLifecycle("resume", this.resumeTaskFromHistory())
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	private ownBackgroundLifecycle(operation: "start" | "resume", lifecycle: Promise<void>): void {
		void lifecycle.catch((error) => {
			console.error(`[Task#${this.taskId}] Background ${operation} failed:`, error)
		})
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

	private async addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string): Promise<boolean> {
		// Capture the encrypted_content / thought signatures from the provider (e.g., OpenAI Responses API, Google GenAI) if present.
		// We only persist data reported by the current response body.
		const handler = this.api as ApiHandler & {
			getResponseId?: () => string | undefined
			getEncryptedContent?: () => { encrypted_content: string; id?: string } | undefined
			getThoughtSignature?: () => string | undefined
			getSummary?: () => any[] | undefined
			getReasoningDetails?: () => any[] | undefined
			getStatefulMarker?: () => string | undefined
		}

		if (message.role === "assistant") {
			const responseId = handler.getResponseId?.()
			const reasoningData = handler.getEncryptedContent?.()
			const thoughtSignature = handler.getThoughtSignature?.()
			const reasoningSummary = handler.getSummary?.()
			const reasoningDetails = handler.getReasoningDetails?.()
			const vscodeLmStatefulMarker = handler.getStatefulMarker?.()

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
				...(vscodeLmStatefulMarker ? { vscodeLmStatefulMarker } : {}),
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

		const saved = await this.saveApiConversationHistory()
		if (saved) await this.settleAllPersistedWaitAgentResultClaims()
		return saved
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
			const reachedAssistantBoundary = await pWaitFor(() => this.assistantMessageSavedToHistory || this.abort, {
				interval: 50,
				timeout: 30_000, // 30 second timeout as safety net
			})
				.then(() => this.assistantMessageSavedToHistory)
				.catch(() => {
					console.warn(
						`[Task#${this.taskId}] flushPendingToolResultsToHistory: timed out waiting for assistant message to be saved`,
					)
					return false
				})
			if (!reachedAssistantBoundary) return false
		}

		// If task was aborted while waiting, don't flush
		if (this.abort) {
			return false
		}

		// Save the user message with tool_result blocks
		const pendingContent = [...this.userMessageContent]
		const userMessage: Anthropic.MessageParam = {
			role: "user",
			content: pendingContent,
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
			await this.settlePersistedWaitAgentResultClaims(userMessageWithTs as ApiMessage)
			for (const block of pendingContent) {
				if (block.type === "tool_result") {
					this.persistedToolResultIds.add(sanitizeToolUseId(block.tool_use_id))
				}
			}
			// Remove only the snapshot that was persisted. Tool results arriving while
			// the write was in flight belong to a later boundary and must be retained.
			if (pendingContent.every((block, index) => this.userMessageContent[index] === block)) {
				this.userMessageContent.splice(0, pendingContent.length)
			} else {
				const persisted = new Set(pendingContent)
				this.userMessageContent = this.userMessageContent.filter((block) => !persisted.has(block))
			}
		} else {
			const appendedIndex = this.apiConversationHistory.indexOf(userMessageWithTs as ApiMessage)
			if (appendedIndex >= 0) this.apiConversationHistory.splice(appendedIndex, 1)
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
				await this.settleAllPersistedWaitAgentResultClaims()
				return true
			}
		}

		return false
	}

	private async persistAssistantResponseBeforeEffects(
		message: Anthropic.MessageParam,
		reasoning?: string,
	): Promise<boolean> {
		const saved = await this.addToApiConversationHistory(message, reasoning)
		if (!saved && !(await this.retrySaveApiConversationHistory())) {
			this.assistantMessageSavedToHistory = false
			this.suspendAfterCurrentTurn(
				"The assistant response could not be saved, so the turn stopped before executing tool calls or making another model request.",
			)
			return false
		}

		this.assistantMessageSavedToHistory = true
		return true
	}

	// Alpha Messages

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToClineMessages(message: ClineMessage, stateUpdate?: "full" | "task") {
		this.clineMessages.push(message)
		await this.publishClineMessageCreated(message, stateUpdate)
		await this.saveClineMessages()
	}

	private async publishClineMessageCreated(message: ClineMessage, stateUpdate?: "full" | "task") {
		const provider = this.providerRef.deref()
		if (stateUpdate === "task") {
			await provider?.postTaskStateToWebview()
		} else if (stateUpdate === "full") {
			// Avoid resending large, mostly-static fields (notably taskHistory) on every chat message update.
			// taskHistory is maintained in-memory in the webview and updated via taskHistoryItemUpdated.
			await provider?.postStateToWebviewWithoutTaskHistory()
		} else {
			if (typeof provider?.postTaskMessageToWebview === "function") {
				await provider.postTaskMessageToWebview("messageCreated", this.taskId, message)
			} else if (typeof provider?.postMessageToWebview === "function") {
				// Compatibility for narrow provider doubles and alternate hosts.
				await provider.postMessageToWebview({
					type: "messageCreated",
					taskId: this.taskId,
					clineMessage: message,
				})
			} else {
				await provider?.postStateToWebviewWithoutTaskHistory()
			}
		}
		this.emit(RooCodeEventName.Message, { action: "created", message })
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages
		restoreTodoListForTask(this)
		await this.saveClineMessages()
	}

	private async updateClineMessage(message: ClineMessage) {
		const provider = this.providerRef.deref()
		if (typeof provider?.postTaskMessageToWebview === "function") {
			await provider.postTaskMessageToWebview("messageUpdated", this.taskId, message)
		} else {
			await provider?.postMessageToWebview({ type: "messageUpdated", taskId: this.taskId, clineMessage: message })
		}
		this.emit(RooCodeEventName.Message, { action: "updated", message })
	}

	private async enqueueClineMessagesSave(
		createSnapshot: () => ClineMessage[] = () => structuredClone(this.clineMessages),
		onPersisted?: () => void,
	): Promise<boolean> {
		const save = this.clineMessagesSaveQueue.then(async () => {
			try {
				// Snapshot only after earlier writes finish. This prevents a slower, stale
				// write from overwriting a newer terminal transcript during concurrent updates.
				const messages = createSnapshot()
				await saveTaskMessages({
					messages,
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
					messages,
					globalStoragePath: this.globalStoragePath,
					workspace: this.historyWorkspacePath,
					mode: this._taskMode || defaultModeSlug, // Use the task's own mode, not the current provider mode.
					apiConfigName: this._taskApiConfigName, // Use the task's own provider profile, not the current provider profile.
					initialStatus: this.initialStatus,
					taskKind: this.taskKind,
					subagentGroupId: this.subagentGroupId,
					subagentNickname: this.subagentNickname,
					subagentRole: this.subagentRole,
					subagentModelRoute: this.subagentModelRoute,
					subagentContextManifest: this.subagentContextManifest,
					subagentInstructionPlacement: this.subagentInstructionPlacement,
					subagentDelegationPolicy: this.subagentDelegationPolicy,
					subagentDelegationExplicitlyEnabled: this.subagentDelegationExplicitlyEnabled,
					stopReason: this.subagentStopReason,
					subagentWriteScope: this.subagentWriteScope,
					subagentChangeSet: this.subagentChangeSet,
				})

				// Emit token/tool usage updates using debounced function
				// The debounce with maxWait ensures:
				// - Immediate first emit (leading: true)
				// - At most one emit per interval during rapid updates (maxWait)
				// - Final state is emitted when updates stop (trailing: true)
				this.debouncedEmitTokenUsage(tokenUsage, this.toolUsage)

				await this.providerRef.deref()?.updateTaskHistory(historyItem)
				onPersisted?.()
				return true
			} catch (error) {
				console.error("Failed to save Alpha messages:", error)
				return false
			}
		})

		// Keep the queue usable after a failed write. The caller still receives the
		// boolean result for this specific operation.
		this.clineMessagesSaveQueue = save.then(() => undefined)
		return save
	}

	private async saveClineMessages(): Promise<boolean> {
		return this.enqueueClineMessagesSave()
	}

	/**
	 * Persist a message mutation before exposing it in memory or to the webview.
	 * The save queue is also the commit fence: later transcript saves observe the
	 * committed live mutation, while a failed attempt leaves the visible state alone.
	 */
	private async commitClineMessageMutation(
		timestamp: number,
		context: string,
		mutate: (message: ClineMessage | undefined) => ClineMessage | undefined,
	): Promise<{ message: ClineMessage; created: boolean } | undefined> {
		for (const retryDelayMs of [0, 50, 200]) {
			if (retryDelayMs > 0) await delay(retryDelayMs)

			let stagedMessage: ClineMessage | undefined
			let created = false
			let committedMessage: ClineMessage | undefined
			const saved = await this.enqueueClineMessagesSave(
				() => {
					const messages = structuredClone(this.clineMessages)
					const index = messages.findIndex((message) => message.ts === timestamp)
					created = index < 0
					stagedMessage = mutate(index >= 0 ? messages[index] : undefined)
					if (!stagedMessage) return messages
					if (index >= 0) messages[index] = stagedMessage
					else messages.push(stagedMessage)
					return messages
				},
				() => {
					if (!stagedMessage) return
					const liveIndex = this.clineMessages.findIndex((message) => message.ts === timestamp)
					committedMessage = structuredClone(stagedMessage)
					if (liveIndex >= 0) this.clineMessages[liveIndex] = committedMessage
					else this.clineMessages.push(committedMessage)
				},
			)

			if (saved) {
				return committedMessage ? { message: committedMessage, created } : undefined
			}
		}

		throw new Error(`Unable to persist ${context}.`)
	}

	private async requireClineMessagesSaved(context: string): Promise<void> {
		for (const retryDelayMs of [0, 50, 200]) {
			if (retryDelayMs > 0) await delay(retryDelayMs)
			if (await this.saveClineMessages()) return
		}
		throw new Error(`Unable to persist ${context}.`)
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

		const lastToolFailure = this.getLastToolFailureGuidance()
		if (lastToolFailure) {
			details.push(lastToolFailure)
		}
		if (this.lastToolFailure?.toolName === "attempt_completion") {
			details.push(
				"The previous completion call failed. Do not repeat it unchanged; resolve its reported blocker or correct its arguments before retrying once.",
			)
		}
		if (this.consecutiveMistakeLimit === 1) {
			details.push(
				"This provider profile's Error & Repetition Limit is 1, so a single failed tool call opens this dialog.",
			)
		}

		details.push(
			"Recovery guidance: continue with one concrete next action. Use a tool if work remains, use attempt_completion if the task is finished, and use ask_followup_question only when a specific missing input blocks progress.",
			"If delegating, call new_task by itself in its own assistant turn. Do not batch new_task with any other tool.",
		)

		return `${t("common:errors.mistake_limit_guidance")}\n\n${details.map((detail) => `- ${detail}`).join("\n")}`
	}

	private getAutomaticMistakeLimitGuidance(): string {
		const details = [
			"Automatic recovery from repeated invalid or unproductive model turns. Continue without waiting for user input.",
			`Recovery attempt: ${this.automaticMistakeRecoveryCount}/${MAX_AUTOMATIC_MISTAKE_RECOVERIES}.`,
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

		const lastToolFailure = this.getLastToolFailureGuidance()
		if (lastToolFailure) {
			details.push(lastToolFailure)
		}
		if (this.lastToolFailure?.toolName === "attempt_completion") {
			details.push(
				"The previous completion call failed. Do not repeat it unchanged; resolve its reported blocker or correct its arguments before retrying once.",
			)
		}
		if (this.consecutiveMistakeLimit === 1) {
			details.push(
				"This provider profile's Error & Repetition Limit is 1, so a single failed tool call opens this dialog.",
			)
		}

		details.push(
			"Use exactly one concrete next action now: call one valid tool with complete arguments if work remains, call attempt_completion if finished, or call ask_followup_question only when a specific missing input blocks progress.",
			"If the requested work includes workspace changes and inspection is sufficient, call an edit or other mutation tool now. More reads, searches, todo updates, or status narration do not apply the change.",
			"If delegating, call new_task by itself in its own assistant turn. Do not batch new_task with any other tool.",
		)

		return details.join("\n")
	}

	private getLastToolFailureGuidance(): string | undefined {
		if (!this.lastToolFailure) return undefined
		const normalizedError = this.lastToolFailure.error?.replace(/\s+/g, " ").trim().slice(0, 500)
		return normalizedError
			? `Most recent tool failure: ${this.lastToolFailure.toolName} — ${normalizedError}`
			: `Most recent tool failure: ${this.lastToolFailure.toolName}.`
	}

	private resetConsecutiveMistakeState(): void {
		this.consecutiveMistakeCount = 0
		this.consecutiveNoToolUseCount = 0
		this.consecutiveNoAssistantMessagesCount = 0
	}

	private resetMistakeRecoveryState(): void {
		this.resetConsecutiveMistakeState()
		this.automaticMistakeRecoveryCount = 0
		this.lastToolFailure = undefined
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

		const queuedGuidance = this.messageQueueService.isEmpty()
			? undefined
			: this.messageQueueService.dequeueMessage()
		if (queuedGuidance) {
			// The user has already supplied the guidance this safeguard would ask
			// for. Deliver it with the pending tool result instead of interrupting
			// it with another generic mistake-limit dialog.
			await this.say("user_feedback", queuedGuidance.text, queuedGuidance.images)
			currentUserContent.push(...this.buildUserMessageContent(queuedGuidance.text, queuedGuidance.images))
			this.resetMistakeRecoveryState()
			return
		}

		if (
			this.automaticMistakeRecoveryCount < MAX_AUTOMATIC_MISTAKE_RECOVERIES &&
			(await this.shouldAutoRecoverFromMistakeLimit())
		) {
			this.automaticMistakeRecoveryCount++
			const text = this.getAutomaticMistakeLimitGuidance()
			currentUserContent.push({ type: "text", text: formatResponse.tooManyMistakes(text) })
			await this.say("user_feedback", text)
			// Keep the bounded automatic-attempt count, but give that attempt a
			// clean consecutive-error window. Retaining the no-tool counter here
			// caused one recovery response to immediately reopen the same dialog.
			this.resetConsecutiveMistakeState()
			return
		}

		const { response, text, images } = await this.ask(
			"mistake_limit_reached",
			this.getMistakeLimitGuidance(),
			undefined,
			undefined,
			true,
		)

		if (response === "messageResponse") {
			currentUserContent.push(
				...[
					{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
					...formatResponse.imageBlocks(images),
				],
			)

			await this.say("user_feedback", text, images)
		}

		this.resetMistakeRecoveryState()
	}

	private getOffscreenMistakeLimitGuidance(): string {
		return [
			"Continue the current task without waiting for the user because this task lane is not currently on-screen.",
			"Recover from the previous invalid or unproductive turns with exactly one concrete next action.",
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
		if (text !== undefined) text = redactTaskPrivatePaths(this, text)

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
					// In the webview we use the ts as the ChatRow key in the
					// transcript. Since we would update this ts right at the
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
		const approval = this.isParentAuthorizedSubagentAsk(type, text, isProtected)
			? ({ decision: "approve" } as const)
			: offscreenAutoResponse
				? ({ decision: "ask" } as const)
				: await checkAutoApprovalWithInheritedPolicy({
						state,
						inheritedState:
							this.taskKind === "subagent"
								? (this.subagentContextManifest?.runtimePolicy.autoApproval ??
									disabledSubagentAutoApprovalPolicy)
								: undefined,
						ask: type,
						text,
						isProtected,
					})

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
		if (
			isStatusMutable &&
			this.subagentRole === "worker" &&
			(type === "command" || (type === "tool" && isProtected))
		) {
			await provider?.surfaceSubagentApproval(this, type === "command" ? "command" : "protected_write", text)
		}

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
		}

		// Wait for askResponse to be set
		try {
			await pWaitFor(
				() => {
					if (this.abort) {
						return true
					}

					// If a queued message arrives while we're blocked on an ask (e.g. a follow-up
					// suggestion click that was incorrectly queued due to UI state), it wins over
					// a simultaneous completion acceptance so guidance is never discarded.
					if (shouldDrainQueuedMessageForAsk && !this.messageQueueService.isEmpty()) {
						const message = this.messageQueueService.dequeueMessage()
						if (message) {
							this.handleWebviewAskResponse("messageResponse", message.text, message.images)
							return true
						}
					}

					if (this.askResponse !== undefined || this.lastMessageTs !== askTs) {
						return true
					}

					return false
				},
				{ interval: 100 },
			)
		} finally {
			// Every exit path owns and clears only the timers created for this ask.
			timeouts.forEach((timeout) => clearTimeout(timeout))
			if (this.autoApprovalTimeoutRef && timeouts.includes(this.autoApprovalTimeoutRef)) {
				this.autoApprovalTimeoutRef = undefined
			}
		}

		if (this.abort) {
			if (this.activeAsk?.ts === askTs) {
				this.activeAsk = undefined
			}
			throw new Error(`[RooCode#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

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
		if (this.subagentRole === "worker") await provider?.clearSubagentApproval(this.taskId)
		if (this.activeAsk?.ts === askTs) {
			this.activeAsk = undefined
		}
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined

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
		// An Apply/Discard lease wins the single-threaded race with a user reply.
		// Resume the ask only after the artifact, ledger, and transcript projection settle.
		if (this.externalMutationLease) {
			this.deferredAskResponse = { askResponse, text, images }
			return
		}

		// Clear any pending auto-approval timeout when user responds
		this.cancelAutoApprovalTimeout()

		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images

		if (askResponse === "messageResponse" && (Boolean(text?.trim()) || Boolean(images?.length))) {
			// Human guidance is the recovery boundary the mistake dialog asks for.
			// Clear stale counters before the next request so that guidance reaches
			// the model instead of being intercepted by another dialog.
			this.resetMistakeRecoveryState()
		}

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
		this.resetMistakeRecoveryState()
		this.cancelAutoApprovalTimeout()
		this.activeAsk = undefined
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		this.idleAsk = undefined
		this.resumableAsk = undefined
		this.interactiveAsk = undefined
		this.deferredAskResponse = undefined
		this.userMessageContentReady = true
	}

	/** Stop after the current tool protocol boundary instead of spending another model turn. */
	public suspendAfterCurrentTurn(reason: string): void {
		this.suspendAfterCurrentTurnReason = reason
	}

	/** Remove a staged native tool result when its terminal transaction fails. */
	public removePendingToolResult(toolCallId: string): boolean {
		const sanitizedId = sanitizeToolUseId(toolCallId)
		const index = this.userMessageContent.findIndex(
			(block) => block.type === "tool_result" && sanitizeToolUseId(block.tool_use_id) === sanitizedId,
		)
		if (index < 0) return false
		this.userMessageContent.splice(index, 1)
		return true
	}

	/**
	 * Undo a just-persisted terminal tool result when a later completion guard
	 * observes queued user guidance. The assistant tool_use remains in history;
	 * the caller immediately supplies the replacement result for the next turn.
	 */
	public async rollbackPersistedToolResult(toolCallId: string): Promise<boolean> {
		const sanitizedId = sanitizeToolUseId(toolCallId)
		const originalHistory = this.apiConversationHistory
		const nextHistory = structuredClone(originalHistory)
		for (let index = nextHistory.length - 1; index >= 0; index--) {
			const message = nextHistory[index]
			if (message.role !== "user" || !Array.isArray(message.content)) continue
			const nextContent = message.content.filter(
				(block) => block.type !== "tool_result" || sanitizeToolUseId(block.tool_use_id) !== sanitizedId,
			)
			if (nextContent.length === message.content.length) continue
			if (nextContent.length === 0) nextHistory.splice(index, 1)
			else message.content = nextContent
			this.apiConversationHistory = nextHistory
			try {
				if (!(await this.saveApiConversationHistory())) {
					throw new Error("Unable to roll back the interrupted completion tool result.")
				}
			} catch (error) {
				// The durable transcript still contains the terminal result. Restore the
				// matching in-memory view and retain its dedupe reservation so a later
				// error callback cannot create a conflicting second result.
				if (this.apiConversationHistory === nextHistory) this.apiConversationHistory = originalHistory
				throw error
			}
			this.persistedToolResultIds.delete(sanitizedId)
			return true
		}
		this.persistedToolResultIds.delete(sanitizedId)
		return false
	}

	/**
	 * Publish the terminal task transition exactly once.
	 *
	 * Both explicit `attempt_completion` calls and ordinary assistant responses
	 * converge here so lifecycle state, final usage, and telemetry cannot drift.
	 */
	public async finalizeTaskCompletion(stagedToolCallId?: string): Promise<boolean> {
		if (this.didEmitTaskCompleted) return false

		// Reserve the transition before awaiting the persistence barrier so concurrent
		// acceptance paths cannot publish the same completion twice.
		this.didEmitTaskCompleted = true
		let preparedPrimaryLifecycle = false
		try {
			if (this.taskKind === "primary") {
				const provider = this.providerRef.deref()
				if (!provider || typeof provider.prepareTaskCompletionLifecycle !== "function") {
					throw new Error("Unable to durably prepare the task lifecycle for completion.")
				}
				await provider.prepareTaskCompletionLifecycle(this.taskId)
				preparedPrimaryLifecycle = true
			}
			if (!(await this.flushPendingToolResultsToHistory())) {
				throw new Error("Unable to persist pending tool results before task completion.")
			}

			// User guidance wins any race with the asynchronous persistence barriers
			// above. No await occurs between this check and markCompleted().
			if (!this.messageQueueService.isEmpty()) {
				if (stagedToolCallId) await this.rollbackPersistedToolResult(stagedToolCallId)
				if (preparedPrimaryLifecycle) {
					await this.providerRef.deref()?.rollbackTaskCompletionLifecycle(this.taskId)
				}
				this.didEmitTaskCompleted = false
				return false
			}

			this.markCompleted()
			this.emitFinalTokenUsageUpdate()
			TelemetryService.instance.captureTaskCompleted(this.taskId)
			this.emit(RooCodeEventName.TaskCompleted, this.taskId, this.getTokenUsage(), this.toolUsage)
			return true
		} catch (error) {
			if (stagedToolCallId && this.persistedToolResultIds.has(sanitizeToolUseId(stagedToolCallId))) {
				try {
					await this.rollbackPersistedToolResult(stagedToolCallId)
				} catch (toolResultRollbackError) {
					this.didEmitTaskCompleted = false
					throw new AggregateError(
						[error, toolResultRollbackError],
						"Task completion failed and its staged tool result could not be restored.",
					)
				}
			}
			if (preparedPrimaryLifecycle) {
				try {
					await this.providerRef.deref()?.rollbackTaskCompletionLifecycle(this.taskId)
				} catch (rollbackError) {
					this.didEmitTaskCompleted = false
					throw new AggregateError(
						[error, rollbackError],
						"Task completion failed and its orchestration lifecycle could not be restored.",
					)
				}
			}
			this.didEmitTaskCompleted = false
			throw error
		}
	}

	/**
	 * Load the single durable completion decision used by both explicit
	 * `attempt_completion` calls and provider text-only completion fallback.
	 * Completion always fails closed when the provider or its ledger is unavailable.
	 */
	public async getCompletionGateDecision(): Promise<CompletionGateDecision> {
		const provider = this.providerRef?.deref()
		if (!provider || typeof provider.getParentCompletionDecision !== "function") {
			return {
				allowed: false,
				modelCanResolveRejection: false,
				message:
					"Cannot verify managed-agent completion obligations because the durable completion decision is unavailable.",
			}
		}

		try {
			const decision = await provider.getParentCompletionDecision(this)
			return { ...decision, modelCanResolveRejection: true }
		} catch (error) {
			return {
				allowed: false,
				modelCanResolveRejection: false,
				message: `Cannot verify managed-agent completion obligations right now: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}

	/** Return an accepted text-only completion through the legacy blocking handoff, when applicable. */
	private async returnCompletionToLegacyParent(result: string): Promise<boolean> {
		if (this.taskKind !== "primary" || !this.parentTaskId) return false

		const provider = this.providerRef.deref()
		if (!provider) throw new Error("Cannot return legacy child completion because the provider is unavailable")
		const { historyItem } = await provider.getTaskWithId(this.taskId)
		if (historyItem.status === "completed") return false
		if (historyItem.status !== "active") {
			throw new Error(
				`Cannot return legacy child completion while task ${this.taskId} has status ${historyItem.status ?? "unknown"}`,
			)
		}

		await provider.reopenParentFromDelegation({
			parentTaskId: this.parentTaskId,
			childTaskId: this.taskId,
			completionResultSummary: result,
		})
		return true
	}

	public beginCommandExecution(
		toolCallId: string,
		executionId: string,
		command?: string,
		verificationChangeSetIds?: readonly string[],
	): void {
		if (this.commandExecutionEvidence.has(toolCallId)) return
		const scopedChangeSetIds =
			verificationChangeSetIds === undefined ? undefined : [...new Set(verificationChangeSetIds)]
		this.commandExecutionEvidence.set(toolCallId, {
			toolCallId,
			executionId,
			status: "running",
			startedAt: Date.now(),
			command,
			...(scopedChangeSetIds ? { verificationChangeSetIds: scopedChangeSetIds } : {}),
		})
	}

	public completeCommandExecution(toolCallId: string, details: { exitCode?: number; signalName?: string }): void {
		const evidence = this.commandExecutionEvidence.get(toolCallId)
		if (!evidence || evidence.status !== "running") return
		evidence.status = details.exitCode === 0 && !details.signalName ? "succeeded" : "failed"
		evidence.exitCode = details.exitCode
		evidence.signalName = details.signalName
		evidence.completedAt = Date.now()
		this.publishParentVerificationEvidence()
	}

	public failCommandExecution(
		toolCallId: string,
		status: Exclude<CommandExecutionEvidenceStatus, "running" | "succeeded"> = "failed",
	): void {
		const evidence = this.commandExecutionEvidence.get(toolCallId)
		if (!evidence || evidence.status !== "running") return
		evidence.status = status
		evidence.completedAt = Date.now()
		this.publishParentVerificationEvidence()
	}

	private publishParentVerificationEvidence(): void {
		if (this.taskKind === "subagent") return
		void this.providerRef
			.deref()
			?.recordParentVerificationEvidence(this)
			.catch((error) => console.error(`[Task] Failed to persist parent verification evidence: ${String(error)}`))
	}

	public getCommandExecutionEvidence(): CommandExecutionEvidence[] {
		return [...this.commandExecutionEvidence.values()].map((evidence) => ({
			...evidence,
			...(evidence.verificationChangeSetIds
				? { verificationChangeSetIds: [...evidence.verificationChangeSetIds] }
				: {}),
		}))
	}

	public hasActiveCommandExecutions(): boolean {
		return [...this.commandExecutionEvidence.values()].some((evidence) => evidence.status === "running")
	}

	/** A mode transition must not cross an unresolved approval boundary. */
	public hasPendingAsk(): boolean {
		return this.activeAsk !== undefined
	}

	private failActiveCommandExecutions(status: "cancelled" | "failed"): void {
		for (const evidence of this.commandExecutionEvidence.values()) {
			if (evidence.status !== "running") continue
			evidence.status = status
			evidence.completedAt = Date.now()
		}
	}

	private async stopActiveWorkerCommand(): Promise<void> {
		if (this.taskKind !== "subagent" || this.subagentRole !== "worker") return
		// Command launch can still be awaiting approval or terminal acquisition, so
		// cancel its evidence even when no process has become visible yet.
		this.failActiveCommandExecutions("cancelled")

		// A command can leave the model-facing foreground as soon as it produces
		// output while its terminal process continues in the background. In that
		// state ExecuteCommandTool clears terminalProcess, but TerminalRegistry
		// still owns the busy process under this task ID. Cancellation must stop
		// both forms before the task can become terminal.
		const processes = new Set<RooTerminalProcess>()
		if (this.terminalProcess) processes.add(this.terminalProcess)
		for (const terminal of TerminalRegistry.getTerminals(true, this.taskId)) {
			if (terminal.process) processes.add(terminal.process)
		}
		if (processes.size === 0) return

		// Record the semantic reason before aborting. Some terminal adapters emit
		// their exit callback synchronously from abort(), which must not replace a
		// deliberate cancellation with a generic command failure.
		await Promise.all(
			[...processes].map(async (process) => {
				// ExecuteCommand clears its direct reference immediately after a
				// foreground completion. Cancellation can observe that narrow gap,
				// so do not wait for an event that has already been emitted.
				if (process.isSettled === true) return

				let finish!: () => void
				const settled = new Promise<void>((resolve) => {
					finish = resolve
					process.once("completed", finish)
					process.once("error", finish)
				})
				let timeout: ReturnType<typeof setTimeout> | undefined
				const timedOut = new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error(`Timed out stopping a managed Worker command for task ${this.taskId}`)),
						10_000,
					)
				})

				try {
					await Promise.race([Promise.all([Promise.resolve(process.abort()), settled]), timedOut])
				} finally {
					if (timeout) clearTimeout(timeout)
					process.removeListener("completed", finish)
					process.removeListener("error", finish)
				}
			}),
		)
	}

	public async upsertSubagentGroup(group: SubagentGroupState): Promise<void> {
		const existing = this.clineMessages.find(
			(message) => message.say === "subagent_group" && message.subagentGroup?.groupId === group.groupId,
		)

		if (existing) {
			existing.subagentGroup = structuredClone(group)
			this.releaseSubagentReviewBarrierIfSettled()
			await this.saveClineMessages()
			await this.updateClineMessage(existing)
			return
		}

		await this.addToClineMessages({
			ts: group.createdAt,
			type: "say",
			say: "subagent_group",
			subagentGroup: structuredClone(group),
		})
		this.releaseSubagentReviewBarrierIfSettled()
	}

	private getPendingSpawnedSubagentResults(): PendingSpawnedSubagentResult[] {
		// Phase 3: asynchronous terminal results are consumed only through the
		// native wait_agent mailbox path. Keep this compatibility seam inert so
		// the legacy request loop never fabricates a user-authored result block.
		return []
	}

	private buildUserContentWithPendingSpawnedSubagentResults(
		content: Anthropic.Messages.ContentBlockParam[],
		environmentDetails: string,
		_allowedTaskIds?: ReadonlySet<string>,
	): {
		content: Anthropic.Messages.ContentBlockParam[]
		pendingResults: PendingSpawnedSubagentResult[]
	} {
		return {
			content: [...content, { type: "text", text: environmentDetails }],
			pendingResults: [],
		}
	}

	private async markSpawnedSubagentResultsDelivered(_taskIds: readonly string[]): Promise<void> {
		// Compatibility no-op for the legacy request loop. Native wait_agent
		// receipts, not transcript presentation state, now own consumption.
	}

	private async settleAutomaticResultClaim(
		provider: ClineProvider,
		claimId: string,
		disposition: "acknowledge" | "release",
	): Promise<void> {
		if (disposition === "acknowledge") {
			await provider.acknowledgeAutomaticSubagentResults(this, claimId)
		} else {
			await provider.releaseAutomaticSubagentResults(this, claimId)
		}
	}

	private async retryPendingAutomaticResultClaimSettlement(provider: ClineProvider | undefined): Promise<void> {
		const pending = this.pendingAutomaticResultClaimSettlement
		if (!pending) return
		if (!provider) throw new Error("Cannot recover the pending automatic-result mailbox claim without a provider")

		await this.settleAutomaticResultClaim(provider, pending.claimId, pending.disposition)
		if (this.pendingAutomaticResultClaimSettlement === pending) {
			this.pendingAutomaticResultClaimSettlement = undefined
		}
	}

	private retainAutomaticResultClaimSettlement(claimId: string, disposition: "acknowledge" | "release"): void {
		this.pendingAutomaticResultClaimSettlement = { claimId, disposition }
	}

	private async reconcileInterruptedSubagentGroups(): Promise<void> {
		const liveTaskIds = new Set(this.providerRef.deref()?.getLiveTaskIds() ?? [])
		let changed = false

		for (const message of this.clineMessages) {
			const group = message.subagentGroup
			if (!group || !["pending", "running", "cancelling"].includes(group.status)) continue

			const unfinishedAgents = group.agents.filter((agent) =>
				["pending", "running", "cancelling"].includes(agent.status),
			)
			if (unfinishedAgents.some((agent) => liveTaskIds.has(agent.taskId))) continue

			changed = reconcileSubagentGroupAfterReload(group, Date.now()) || changed
		}

		if (changed) await this.saveClineMessages()
	}

	public getTaskAllowedToolNames(): readonly ToolName[] | undefined {
		if (this.taskKind !== "subagent") return undefined
		const role = this.subagentRole ?? "review"
		const hardCeiling = getSubagentAllowedToolNames(
			role,
			Boolean(this.subagentContextManifest?.skills.length),
			this.subagentContextManifest?.runtimePolicy.delegate === true,
		)
		const capturedGrant = this.subagentContextManifest?.runtimePolicy.allowedTools
		if (!capturedGrant) return hardCeiling
		const granted = new Set(capturedGrant)
		// Progress reporting is a host-safe upward-only capability. Include it for
		// legacy managed children whose frozen manifests predate this tool.
		return hardCeiling.filter((tool) => tool === "report_progress" || granted.has(tool))
	}

	private shouldExposeAgentLifecycleTools(): boolean {
		if (this.taskKind !== "primary") return false
		if (this.clineMessages.some((message) => message.say === "subagent_group")) return true

		// A legacy new_task child is still a primary task even though it carries
		// blocking-handoff lineage. Its managed-agent control plane is rooted here,
		// not at the legacy ancestor.
		return this.providerRef?.deref()?.hasManagedAgentLifecycleState?.(this.taskId) ?? true
	}

	public getInheritedSubagentSkill(name: string) {
		return this.subagentContextManifest?.skills.find((skill) => skill.name === name)
	}

	public getInheritedSubagentSkillNames(): string[] {
		return this.subagentContextManifest?.skills.map((skill) => skill.name) ?? []
	}

	/** Exact-file entries retained from managed Worker scope validation. */
	public getSubagentFileWriteScope(): string[] {
		return this.subagentAuthority?.role === "worker" ? [...(this.subagentAuthority.fileWriteScope ?? [])] : []
	}

	public isToolAllowedForTask(toolName: string): boolean {
		return this.getTaskToolDenialReason(toolName) === undefined
	}

	public getTaskToolDenialReason(toolName: string, params?: Record<string, unknown>): string | undefined {
		const allowed = this.getTaskAllowedToolNames()
		if (allowed && !(allowed as readonly string[]).includes(toolName)) {
			return `Tool "${toolName}" is not allowed for this parent-managed ${this.subagentRole === "worker" ? "editing worker" : "read-only sub-agent"}.`
		}

		if (this.subagentRole === "worker" && this.isWorkerEditTool(toolName) && params) {
			const paths = this.getWorkerEditPaths(params)
			if (paths.length === 0) return `Tool "${toolName}" did not provide a verifiable edit path.`
			const outside = paths.find((candidate) => !this.isWorkerWritePathAllowed(candidate))
			if (outside) return `Worker edit path is outside the approved write_scope: ${outside}`
		}

		if (
			this.taskKind === "subagent" &&
			toolName !== "attempt_completion" &&
			this.subagentResearchDeadlineAt !== undefined &&
			Date.now() >= this.subagentResearchDeadlineAt
		) {
			return "The sub-agent research window has ended. Stop using research tools and call attempt_completion now with the evidence already collected."
		}

		return undefined
	}

	private isWorkerEditTool(toolName: string): boolean {
		return [
			"write_to_file",
			"apply_diff",
			"edit",
			"search_and_replace",
			"search_replace",
			"edit_file",
			"apply_patch",
		].includes(toolName)
	}

	private getWorkerEditPaths(params?: Record<string, unknown>): string[] {
		if (!params) return []
		const paths = [params.path, params.file_path].filter((value): value is string => typeof value === "string")
		if (typeof params.patch === "string") {
			for (const line of params.patch.split(/\r?\n/)) {
				const match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/.exec(line)
				const move = /^\*\*\* Move to:\s*(.+)$/.exec(line)
				if (match?.[1]) paths.push(match[1].trim())
				if (move?.[1]) paths.push(move[1].trim())
			}
		}
		return [...new Set(paths)]
	}

	private isWorkerWritePathAllowed(candidate: string): boolean {
		if (!this.subagentWriteScope || path.isAbsolute(candidate)) return false
		const resolved = path.resolve(this.cwd, candidate)
		const relative = path.relative(this.cwd, resolved).split(path.sep).join("/")
		if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return false
		const fileScopes =
			this.subagentAuthority?.role === "worker" ? (this.subagentAuthority.fileWriteScope ?? []) : []
		const allowed = this.subagentWriteScope.some(
			(scope) => relative === scope || (!fileScopes.includes(scope) && relative.startsWith(`${scope}/`)),
		)
		if (!allowed) return false

		let existing = resolved
		while (!fsSync.existsSync(existing)) {
			const parent = path.dirname(existing)
			if (parent === existing) return false
			existing = parent
		}
		try {
			const realWorkspace = fsSync.realpathSync(this.cwd)
			const realExisting = fsSync.realpathSync(existing)
			const realRelative = path.relative(realWorkspace, realExisting)
			return realRelative === "" || (!realRelative.startsWith("..") && !path.isAbsolute(realRelative))
		} catch {
			return false
		}
	}

	public setSubagentChangeSet(changeSet: SubagentChangeSetState): void {
		this.subagentChangeSet = structuredClone(changeSet)
	}

	private hasPendingSubagentChangeSetReview(): boolean {
		return this.clineMessages.some((message) =>
			message.subagentGroup?.agents.some((agent) =>
				["pending_review", "conflicted"].includes(agent.changeSet?.status ?? ""),
			),
		)
	}

	private releaseSubagentReviewBarrierIfSettled(force = false): void {
		const barrier = this.subagentReviewBarrier
		if (!barrier) return
		if (!force && (this.externalMutationLease || this.hasPendingSubagentChangeSetReview())) return
		this.subagentReviewBarrier = undefined
		barrier.resolve()
	}

	private async waitForPendingSubagentChangeSetReviews(): Promise<void> {
		while (!this.abort && this.hasPendingSubagentChangeSetReview()) {
			if (!this.subagentReviewBarrier) {
				let resolve!: () => void
				const promise = new Promise<void>((resolveBarrier) => {
					resolve = resolveBarrier
				})
				this.subagentReviewBarrier = { promise, resolve }
			}

			const barrier = this.subagentReviewBarrier
			this.isAwaitingSubagentReview = true
			await this.providerRef
				.deref()
				?.postStateToWebviewWithoutTaskHistory()
				.catch(() => undefined)
			try {
				await barrier.promise
			} finally {
				if (this.subagentReviewBarrier === barrier) this.subagentReviewBarrier = undefined
				this.isAwaitingSubagentReview = false
			}
		}
	}

	private getExternalMutationCapabilityForAction(allowInPlan: boolean): ExternalMutationCapability {
		if (this.abort) {
			return { allowed: false, state: "unavailable", reason: "The parent task is stopping." }
		}
		if (this.didComplete) {
			return { allowed: false, state: "unavailable", reason: "The parent task has already completed." }
		}
		if (!allowInPlan && this._taskMode === planModeSlug) {
			return {
				allowed: false,
				state: "unavailable",
				reason: "Plan mode cannot apply Worker changes. Switch to Code mode to apply this proposal.",
			}
		}
		if (this.externalMutationLease) {
			return {
				allowed: false,
				state: "busy",
				reason: `The parent is already ${this.externalMutationLease.label}.`,
			}
		}
		if (this.isWaitingForFirstChunk) {
			return {
				allowed: false,
				state: "busy",
				reason: "Wait for the parent response to finish.",
			}
		}
		if (this.hasActiveCommandExecutions()) {
			return {
				allowed: false,
				state: "busy",
				reason: "Wait for the parent command to finish.",
			}
		}
		if (this.isAwaitingSubagentReview) {
			return {
				allowed: true,
				state: "available",
				reason: "The parent is paused for nested Worker review.",
			}
		}
		if (!this.messageQueueService.isEmpty() || this.pendingSteerMessage) {
			return {
				allowed: false,
				state: "busy",
				reason: "The parent has queued work to process first.",
			}
		}
		// Reloading a task abandons its task loop and cannot reconstruct the in-memory
		// ask promise. Once every concrete runtime blocker above is clear, that inactive
		// state is a safe suspension barrier for reviewing a durable change set.
		if (!this.isTaskLoopActive) {
			return {
				allowed: true,
				state: "available",
				reason: "The parent is inactive and safe for review.",
			}
		}
		if (!this.activeAsk || !SAFE_EXTERNAL_MUTATION_ASKS.has(this.activeAsk.type)) {
			return {
				allowed: false,
				state: "busy",
				reason: "Wait until the parent pauses for your input.",
			}
		}
		if (this.askResponse !== undefined) {
			return {
				allowed: false,
				state: "busy",
				reason: "The parent is resuming from your latest response.",
			}
		}
		// A presented, unresolved safe ask is the suspension barrier. The task loop can
		// retain streaming/render flags while it waits for that tool result, so those
		// flags must not make Apply permanently unavailable. A resumed ask is rejected
		// above via askResponse, before the next model turn can race this mutation.

		return {
			allowed: true,
			state: "available",
			reason: "The parent is paused for your review.",
		}
	}

	public getExternalMutationCapability(): ExternalMutationCapability {
		return this.getExternalMutationCapabilityForAction(false)
	}

	public getSubagentChangeSetDiscardCapability(): ExternalMutationCapability {
		if (this.abort) {
			return { allowed: false, state: "unavailable", reason: "The parent task is stopping." }
		}
		if (this.externalMutationLease) {
			return {
				allowed: false,
				state: "busy",
				reason: `The parent is already ${this.externalMutationLease.label}.`,
			}
		}
		if (this.didComplete) {
			return {
				allowed: true,
				state: "available",
				reason: "The completed parent can still discard this quarantined proposal.",
			}
		}
		return this.getExternalMutationCapabilityForAction(true)
	}

	private acquireExternalMutationLease(
		label: string,
		capability: ExternalMutationCapability,
	): {
		capability: ExternalMutationCapability
		release?: () => void
	} {
		if (!capability.allowed) return { capability }

		const token = Symbol(label)
		this.externalMutationLease = { label, token }
		let released = false
		return {
			capability,
			release: () => {
				if (released) return
				released = true
				if (this.externalMutationLease?.token !== token) return
				this.externalMutationLease = undefined
				const deferred = this.deferredAskResponse
				this.deferredAskResponse = undefined
				if (deferred) {
					this.handleWebviewAskResponse(deferred.askResponse, deferred.text, deferred.images)
				}
				this.releaseSubagentReviewBarrierIfSettled()
			},
		}
	}

	public acquireExternalMutation(label: string): {
		capability: ExternalMutationCapability
		release?: () => void
	} {
		return this.acquireExternalMutationLease(label, this.getExternalMutationCapability())
	}

	public acquireSubagentChangeSetDiscard(label: string): {
		capability: ExternalMutationCapability
		release?: () => void
	} {
		return this.acquireExternalMutationLease(label, this.getSubagentChangeSetDiscardCapability())
	}

	/** @deprecated Use getExternalMutationCapability so callers retain the rejection reason. */
	public isIdleForExternalMutation(): boolean {
		return this.getExternalMutationCapability().allowed
	}

	public async finalizeSubagentHistory(
		status: "completed" | "blocked" | "failed" | "cancelled" | "timed_out" | "interrupted",
		summary: string,
		stopReason?: SubagentStopReason,
	): Promise<void> {
		if (this.taskKind !== "subagent") return

		const terminalSay = status === "completed" || status === "blocked" ? "completion_result" : "error"
		const hasTerminalMessage = this.clineMessages.some(
			(message) =>
				message.type === "say" &&
				message.say === terminalSay &&
				message.partial !== true &&
				Boolean(message.text?.trim()),
		)
		if (!hasTerminalMessage) {
			const message: ClineMessage = {
				ts: Date.now(),
				type: "say",
				say: terminalSay,
				text: summary,
				partial: false,
			}
			this.clineMessages.push(message)
			this.emit(RooCodeEventName.Message, { action: "created", message })
		}

		this.initialStatus = status
		this.subagentStopReason = stopReason ?? this.defaultSubagentStopReason(status)
		await this.requireClineMessagesSaved("the managed sub-agent terminal transcript")

		const provider = this.providerRef.deref()
		if (!provider) return

		const { historyItem } = await provider.getTaskWithId(this.taskId)
		await provider.updateTaskHistory({
			...historyItem,
			status,
			completionResultSummary: summary,
			stopReason: this.subagentStopReason,
		})
	}

	private defaultSubagentStopReason(
		status: "completed" | "blocked" | "failed" | "cancelled" | "timed_out" | "interrupted",
	): SubagentStopReason {
		if (status === "completed" || status === "blocked") return "completed"
		if (status === "cancelled") return "cancelled"
		if (status === "timed_out") return "timeout"
		if (status === "interrupted") return "interrupted"
		return "failed"
	}

	private isParentAuthorizedSubagentAsk(type: ClineAsk, text?: string, isProtected?: boolean): boolean {
		if (!this.subagentAuthority || type !== "tool") return false

		try {
			const payload = JSON.parse(text ?? "{}") as { tool?: string; path?: string; skill?: string }
			if (payload.tool === "skill" && typeof payload.skill === "string") {
				return Boolean(this.getInheritedSubagentSkill(payload.skill))
			}
			if (
				[
					"readFile",
					"listFiles",
					"listFilesTopLevel",
					"listFilesRecursive",
					"searchFiles",
					"codebaseSearch",
				].includes(payload.tool ?? "")
			)
				return true
			return (
				this.subagentAuthority.role === "worker" &&
				!isProtected &&
				["editedExistingFile", "appliedDiff", "newFileCreated"].includes(payload.tool ?? "") &&
				typeof payload.path === "string" &&
				this.isWorkerWritePathAllowed(payload.path)
			)
		} catch {
			return false
		}
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

	public canAcceptSteerMessage(): boolean {
		const managedChildIsIdle =
			this.taskKind === "subagent" &&
			this.isInitialized &&
			!this.isStreaming &&
			!this.isTaskLoopActive &&
			!this.isAgentTurnEngineActive
		return (
			!this.abort &&
			!this.didComplete &&
			!this.activeAsk &&
			!this.pendingSteerMessage &&
			!this.steerMessageAwaitingPersistence &&
			!managedChildIsIdle
		)
	}

	public canAcceptSubagentFollowup(): boolean {
		return this.taskKind === "subagent" && this.didComplete && !this.isTaskLoopActive && !this.isStreaming
	}

	public async steerUserMessage(
		text: string,
		images?: string[],
		onPersisted?: () => Promise<void> | void,
	): Promise<void> {
		text = (text ?? "").trim()
		images = images ?? []

		if (text.length === 0 && images.length === 0) {
			return
		}
		if (this.abort || this.didComplete) {
			throw new Error("The task cannot accept a steering message")
		}
		if (
			this.pendingSteerMessage ||
			this.steerMessageAwaitingPersistence ||
			this.askResponse !== undefined ||
			this.deferredAskResponse !== undefined
		) {
			throw new Error("A steering message is already pending")
		}

		this.resetMistakeRecoveryState()
		const retainForDurableRecovery = () => {
			this.pendingSteerMessage = { text, images, ...(onPersisted ? { onPersisted } : {}) }
			this.steerMessageAwaitingPersistence = true
			this.emit(RooCodeEventName.TaskUserMessage, this.taskId)
		}

		if (this.activeAsk) {
			if (onPersisted) {
				retainForDurableRecovery()
				throw new Error("Managed sub-agent began waiting for input before steering could be durably persisted")
			}
			this.handleWebviewAskResponse("messageResponse", text, images)
			return
		}

		// A just-launched managed child can be steered before its asynchronous
		// startup has finished. Queue that message so the first model request sees
		// it instead of racing submitUserMessage against history initialization.
		if (this.taskKind === "subagent" && !this.isInitialized) {
			retainForDurableRecovery()
			return
		}

		if (this.isStreaming || this.isTaskLoopActive || this.isAgentTurnEngineActive) {
			this.cancelAutoApprovalTimeout()
			retainForDurableRecovery()
			this.agentWaitAbortController?.abort(new Error("Parent received a steering message"))
			this.currentRequestAbortController?.abort()
			return
		}

		if (this.taskKind === "subagent" && onPersisted) {
			// The child became idle after the provider's canAcceptSteerMessage check.
			// Retain the receipt in memory and leave the durable mailbox event
			// unacknowledged so follow-up rehydration can recover it exactly once.
			retainForDurableRecovery()
			throw new Error("Managed sub-agent became inactive before steering could be durably persisted")
		}

		await this.submitUserMessage(text, images)
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			await Promise.resolve(this.terminalProcess?.abort())
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
		// CRITICAL: Flush any pending tool results before condensing
		// to ensure tool_use/tool_result pairs are complete in history
		await this.flushPendingToolResultsToHistory()

		// Get condensing configuration
		const state = await this.providerRef.deref()?.getState()
		const systemPrompt = await this.getSystemPrompt(state)
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE
		const mode = await this.getTaskMode()
		const apiConfiguration = this.apiConfiguration

		const { contextTokens: prevContextTokens } = this.getTokenUsage()

		// Build tools for condensing metadata (same tools used for normal API calls)
		const provider = this.providerRef.deref()
		let allTools: import("openai").default.Chat.ChatCompletionTool[] = []
		if (provider) {
			const modelInfo = this.api.getModel().info
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
				allowedToolNames: this.getTaskAllowedToolNames(),
				taskKind: this.taskKind,
				enableAgentLifecycleTools: this.shouldExposeAgentLifecycleTools(),
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
		const environmentDetails = await getEnvironmentDetails(this, true, state)

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
			stateUpdate?: "full" | "task"
		} = {},
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined> {
		if (this.abort) {
			throw new Error(`[RooCode#say] task ${this.taskId}.${this.instanceId} aborted`)
		}
		if (text !== undefined) text = redactTaskPrivatePaths(this, text)

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					if (type === "text" && !options.isNonInteractive) {
						this.currentAssistantResponseMessageTs = lastMessage.ts
					}
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
						if (type === "text") this.currentAssistantResponseMessageTs = sayTs
					}

					await this.addToClineMessages(
						{
							ts: sayTs,
							type: "say",
							say: type,
							text,
							images,
							partial,
							contextCondense,
							contextTruncation,
						},
						options.stateUpdate,
					)
				}
			} else {
				// New now have a complete version of a previously partial message.
				// This is the complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					if (!options.isNonInteractive) {
						this.lastMessageTs = lastMessage.ts
						if (type === "text") this.currentAssistantResponseMessageTs = lastMessage.ts
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
						if (type === "text") this.currentAssistantResponseMessageTs = sayTs
					}

					await this.addToClineMessages(
						{
							ts: sayTs,
							type: "say",
							say: type,
							text,
							images,
							contextCondense,
							contextTruncation,
						},
						options.stateUpdate,
					)
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
				if (type === "text") this.currentAssistantResponseMessageTs = sayTs
			}

			await this.addToClineMessages(
				{
					ts: sayTs,
					type: "say",
					say: type,
					text,
					images,
					checkpoint,
					contextCondense,
					contextTruncation,
				},
				options.stateUpdate,
			)
		}
	}

	/**
	 * Publish one canonical visible final response for every provider.
	 *
	 * Ordinary assistant text is streamed as `say:text`. Once the turn is known
	 * to be terminal, promote that same row in place instead of appending a
	 * second, provider-specific completion card. Native `attempt_completion`
	 * calls use the same path, preserving their tool protocol while replacing
	 * any same-turn preamble with the authoritative result.
	 */
	public async presentCompletionResult(text: string, images?: string[], partial: boolean = false): Promise<void> {
		const mode = await this.getTaskMode()
		const normalizedText =
			this.taskKind === "primary" && mode === planModeSlug && !partial ? ensureProposedPlanBlock(text) : text
		const completionText = redactTaskPrivatePaths(this, normalizedText)
		// Stream an in-progress completion as ordinary assistant text. Terminal
		// styling is reserved for the durable final boundary below.
		if (partial) {
			await this.say("text", completionText, images, true)
			return
		}

		const currentMessage = this.currentAssistantResponseMessageTs
			? this.findMessageByTimestamp(this.currentAssistantResponseMessageTs)
			: undefined
		const canPromoteCurrent =
			currentMessage?.type === "say" &&
			(currentMessage.say === "text" || currentMessage.say === "completion_result")
		const completionTs = canPromoteCurrent ? currentMessage.ts : Date.now()
		const committed = await this.commitClineMessageMutation(completionTs, "the completion result", (message) => ({
			...(message?.type === "say" ? message : { ts: completionTs, type: "say" as const }),
			say: "completion_result",
			text: completionText,
			images,
			partial: false,
		}))
		if (!committed) throw new Error("Unable to stage the completion result.")

		this.lastMessageTs = committed.message.ts
		this.currentAssistantResponseMessageTs = committed.message.ts
		if (committed.created) await this.publishClineMessageCreated(committed.message)
		else await this.updateClineMessage(committed.message)
	}

	/** Remove terminal styling when a final verification gate rejects a candidate. */
	public async retractCompletionResult(): Promise<void> {
		const currentMessage = this.currentAssistantResponseMessageTs
			? this.findMessageByTimestamp(this.currentAssistantResponseMessageTs)
			: undefined
		if (currentMessage?.type !== "say" || currentMessage.say !== "completion_result") return

		try {
			const committed = await this.commitClineMessageMutation(
				currentMessage.ts,
				"the rejected completion state",
				(message) =>
					message?.type === "say"
						? {
								...message,
								say: "text",
								partial: false,
							}
						: undefined,
			)
			if (committed) await this.updateClineMessage(committed.message)
		} catch (error) {
			this.suspendAfterCurrentTurn(
				"The rejected completion state could not be committed durably. The task was paused before another model request.",
			)
			throw error
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

			if (!(provider.getValue("mcpEnabled") ?? true)) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			// MCP initialization belongs to provider activation, not task startup.
			// Count the servers that are already available without making a new task
			// wait for configuration reads or connection timeouts.
			const mcpHub = provider.getMcpHub()
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
			this.ownBackgroundLifecycle("start", this.startTask(task ?? undefined, images ?? undefined))
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

			await this.persistFrozenSubagentInstructions()

			// The todo list is already set in the constructor if initialTodos were provided
			// No need to add any messages - the todoList property is already set

			await this.say("text", task, images, undefined, undefined, undefined, { stateUpdate: "task" })

			// Internal sub-agents never receive MCP authority, so avoid initializing
			// or counting foreground MCP servers for their isolated task startup.
			if (this.taskKind !== "subagent") {
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
			}
			this.isInitialized = true

			const imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

			// Task starting
			await this.initiateTaskLoop([
				{
					type: "text",
					text: `<user_message>\n${task}\n</user_message>`,
				},
				...(this.subagentInitialContext
					? ([{ type: "text", text: this.subagentInitialContext }] as Anthropic.TextBlockParam[])
					: []),
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

	/** Resume a retained managed sub-agent with a new parent instruction. */
	public async resumeSubagentFollowup(text: string, onPersisted?: () => Promise<void> | void): Promise<void> {
		const instruction = text.trim()
		if (this.taskKind !== "subagent") throw new Error("Only a managed sub-agent can accept a follow-up task")
		if (!instruction) throw new Error("A follow-up instruction is required")
		if (this.isTaskLoopActive || this.isStreaming) throw new Error("The sub-agent is still running")

		this._started = true
		this.didComplete = false
		this.didEmitTaskCompleted = false
		this.abort = false
		this.abandoned = false
		this.abortReason = undefined
		this.didFinishAbortingStream = false
		this.isWaitingForFirstChunk = false
		this.pendingSteerMessage = undefined
		this.steerMessageAwaitingPersistence = Boolean(onPersisted)
		this.skipPrevResponseIdOnce = true
		this.emit(RooCodeEventName.TaskActive, this.taskId)

		await this.resumeTaskFromHistory(instruction, onPersisted)
	}

	private async resumeTaskFromHistory(
		subagentFollowup?: string,
		onSubagentSteeringPersisted?: () => Promise<void> | void,
	) {
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
			await this.reconcileInterruptedSubagentGroups()

			// Now present the cline messages to the user and ask if they want to
			// resume (NOTE: we ran into a bug before where the
			// apiConversationHistory wouldn't be initialized when opening a old
			// task, and it was because we were waiting for resume).
			// This is important in case the user deletes messages without resuming
			// the task first.
			this.apiConversationHistory = await this.getSavedApiConversationHistory()

			if (this.taskKind === "subagent" && !subagentFollowup) {
				this.isInitialized = true
				await this.finalizeTaskCompletion()
				await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
				return
			}

			const lastClineMessage = this.clineMessages
				.slice()
				.reverse()
				.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // Could be multiple resume tasks.

			this.isInitialized = true

			let responseText: string | undefined
			let responseImages: string[] | undefined
			if (subagentFollowup) {
				responseText = subagentFollowup
				await this.say("user_feedback", subagentFollowup)
			} else {
				const askType: ClineAsk =
					lastClineMessage?.ask === "completion_result" ? "resume_completed_task" : "resume_task"
				const { response, text, images } = await this.ask(askType) // Calls `postStateToWebview`.

				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					responseText = text
					responseImages = images
				}
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
			await this.initiateTaskLoop(newUserContent, onSubagentSteeringPersisted)
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
		this.agentWaitAbortController?.abort(new Error("Current task request was cancelled"))
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

	public abortTask(isAbandoned = false): Promise<void> {
		if (isAbandoned) {
			this.abandoned = true
		}
		if (this.abortTaskPromise) return this.abortTaskPromise

		const abortPromise = this.performAbortTask()
		this.abortTaskPromise = abortPromise
		// Coalesce one in-flight transition, but let an operator retry process
		// cleanup after an observable failure instead of caching a rejection forever.
		void abortPromise.catch(() => {
			if (this.abortTaskPromise === abortPromise) this.abortTaskPromise = undefined
		})
		return abortPromise
	}

	private async performAbortTask(): Promise<void> {
		// Will stop any autonomously running promises.

		this.abort = true
		this.releaseSubagentReviewBarrierIfSettled(true)
		let cleanupError: unknown
		try {
			await this.stopActiveWorkerCommand()
		} catch (error) {
			cleanupError = error
		}

		// Reset consecutive error counters on abort (manual intervention)
		this.consecutiveNoToolUseCount = 0
		this.consecutiveNoAssistantMessagesCount = 0
		this.automaticMistakeRecoveryCount = 0

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

		if (cleanupError) throw cleanupError
	}

	public dispose(): void {
		console.log(`[Task#dispose] disposing task ${this.taskId}.${this.instanceId}`)
		this.releaseSubagentReviewBarrierIfSettled(true)
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
		this.abortTaskPromise = undefined
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

	private async initiateTaskLoop(
		userContent: Anthropic.Messages.ContentBlockParam[],
		onInitialUserContentPersisted?: () => Promise<void> | void,
	): Promise<void> {
		// Kicks off the checkpoints initialization process in the background.
		getCheckpointService(this)

		this.emit(RooCodeEventName.TaskStarted)

		type TaskTurnInput = {
			userContent: Anthropic.Messages.ContentBlockParam[]
			includeFileDetails: boolean
			onUserContentPersisted?: () => Promise<void> | void
		}

		const host: AgentTurnHost<TaskTurnInput> = {
			shouldAbort: () => this.abort,
			canCompleteWithoutTools: () => {
				// Managed children must publish a durable terminal result through attempt_completion.
				return (
					this.taskKind === "primary" &&
					this.userMessageContent.length === 0 &&
					this.pendingSteerMessage === undefined
				)
			},
			runStep: async (input) => {
				const didEndLoop = await this.recursivelyMakeClineRequests(
					input.userContent,
					input.includeFileDetails,
					input.onUserContentPersisted,
				)
				const response = this.buildCurrentAgentResponse()
				const suspensionReason = this.suspendAfterCurrentTurnReason
				if (suspensionReason) {
					this.suspendAfterCurrentTurnReason = undefined
					const persisted = await this.flushPendingToolResultsToHistory()
					await this.say(
						"error",
						persisted
							? suspensionReason
							: `${suspensionReason}\n\nThe completion error could not be persisted; the task was paused without another model request.`,
					)
					return { response, nextInput: "complete" }
				}
				const hasVisiblePrimaryText =
					this.taskKind === "primary" && response.toolCalls.length === 0 && response.text.trim().length > 0
				const hasErrorToolResult = this.userMessageContent.some(
					(block) => block.type === "tool_result" && block.is_error === true,
				)
				const hasSuccessfulToolResponse =
					response.toolCalls.length > 0 &&
					this.consecutiveMistakeCount === 0 &&
					!this.didToolFailInCurrentTurn &&
					!hasErrorToolResult

				if (hasVisiblePrimaryText || hasSuccessfulToolResponse) {
					this.resetMistakeRecoveryState()
				} else if (response.text.trim().length > 0 || response.toolCalls.length > 0) {
					// Even an invalid tool response breaks a run of empty provider replies.
					this.consecutiveNoAssistantMessagesCount = 0
				}

				if (didEndLoop || this.abort || this.didComplete) {
					return { response, nextInput: "complete" }
				}

				let requiresContinuation = this.userMessageContent.length > 0 || this.pendingSteerMessage !== undefined
				let nextUserContent: Anthropic.Messages.ContentBlockParam[]

				if (this.userMessageContent.length > 0) {
					nextUserContent = [...this.userMessageContent]
				} else if (this.pendingSteerMessage !== undefined) {
					// recursivelyMakeClineRequests consumes durable steering before the next API request.
					nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
				} else {
					const isVisiblePrimaryResponse =
						this.taskKind === "primary" &&
						response.toolCalls.length === 0 &&
						response.text.trim().length > 0
					const queuedMessage =
						isVisiblePrimaryResponse && !this.messageQueueService.isEmpty()
							? this.messageQueueService.dequeueMessage()
							: undefined

					if (queuedMessage) {
						requiresContinuation = true
						await this.say("user_feedback", queuedMessage.text, queuedMessage.images)
						nextUserContent = this.buildUserMessageContent(queuedMessage.text, queuedMessage.images)
					} else {
						nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
					}
				}

				return {
					response,
					nextInput: {
						userContent: nextUserContent,
						includeFileDetails: false,
					},
					...(requiresContinuation ? { requiresContinuation: true } : {}),
				}
			},
		}

		const engine = new AgentTurnEngine(host)
		const runAgentTurn = async (input: TaskTurnInput) => {
			const wasAgentTurnEngineActive = this.isAgentTurnEngineActive
			this.isAgentTurnEngineActive = true
			try {
				return await engine.run(input)
			} finally {
				this.isAgentTurnEngineActive = wasAgentTurnEngineActive
			}
		}

		let nextTurnInput: TaskTurnInput = {
			userContent,
			includeFileDetails: true,
			onUserContentPersisted: onInitialUserContentPersisted,
		}
		const continueAfterCompletionRejection = async (
			decision: CompletionGateDecision,
		): Promise<TaskTurnInput | undefined> => {
			const message =
				decision.message ??
				"Cannot complete while managed-agent results or parent verification obligations remain unresolved."
			if (decision.modelCanResolveRejection) this.consecutiveMistakeCount++
			await this.say("error", message)
			if (!decision.modelCanResolveRejection) return undefined
			return {
				userContent: [{ type: "text", text: formatResponse.toolError(message) }],
				includeFileDetails: false,
			}
		}

		while (!this.abort && !this.didComplete) {
			const outcome = await runAgentTurn(nextTurnInput)

			if (
				outcome.status !== "completed" ||
				outcome.completionReason !== "assistant" ||
				this.abort ||
				this.didComplete
			) {
				return
			}

			// Text-only provider completions participate in the exact same durable
			// descendant/verification gate as attempt_completion. Do this before
			// promoting the streamed text to terminal styling so a rejected candidate
			// can never expose an accept-to-finish path.
			const initialCompletionDecision = await this.getCompletionGateDecision()
			if (!initialCompletionDecision.allowed) {
				const continuation = await continueAfterCompletionRejection(initialCompletionDecision)
				if (!continuation) return
				nextTurnInput = continuation
				continue
			}

			// Normalize ordinary provider text into the same visible final-result row
			// used by attempt_completion, then publish a hidden review/follow-up boundary.
			await this.presentCompletionResult(outcome.response.text)
			const { response, text, images } = await this.ask("completion_result", "", false)
			if (this.abort || this.didComplete) return

			const queuedFollowup =
				response === "yesButtonClicked" ? this.messageQueueService.dequeueMessage() : undefined
			const feedbackText = queuedFollowup?.text ?? text ?? ""
			const feedbackImages = queuedFollowup?.images ?? images ?? []

			const shouldFinish =
				(response === "yesButtonClicked" && !queuedFollowup) ||
				(!feedbackText.trim() && feedbackImages.length === 0)
			if (shouldFinish) {
				// A background child or verification obligation can change while the
				// review boundary is open. Recheck immediately before the terminal write.
				const finalCompletionDecision = await this.getCompletionGateDecision()
				if (!finalCompletionDecision.allowed) {
					await this.retractCompletionResult()
					const continuation = await continueAfterCompletionRejection(finalCompletionDecision)
					if (!continuation) return
					nextTurnInput = continuation
					continue
				}

				const lateQueuedFeedback = this.messageQueueService.dequeueMessage()
				if (lateQueuedFeedback) {
					await this.retractCompletionResult()
					await this.say("user_feedback", lateQueuedFeedback.text, lateQueuedFeedback.images)
					nextTurnInput = {
						userContent: this.buildUserMessageContent(lateQueuedFeedback.text, lateQueuedFeedback.images),
						includeFileDetails: false,
					}
					continue
				}

				try {
					if (await this.returnCompletionToLegacyParent(outcome.response.text)) return
				} catch (error) {
					await this.retractCompletionResult()
					const continuation = await continueAfterCompletionRejection({
						allowed: false,
						modelCanResolveRejection: false,
						message: `Cannot finish the delegated child right now: ${error instanceof Error ? error.message : String(error)}`,
					})
					if (!continuation) return
					nextTurnInput = continuation
					continue
				}

				const finalized = await this.finalizeTaskCompletion()
				if (!finalized) {
					const concurrentFeedback = this.messageQueueService.dequeueMessage()
					if (concurrentFeedback) {
						await this.retractCompletionResult()
						await this.say("user_feedback", concurrentFeedback.text, concurrentFeedback.images)
						nextTurnInput = {
							userContent: this.buildUserMessageContent(
								concurrentFeedback.text,
								concurrentFeedback.images,
							),
							includeFileDetails: false,
						}
						continue
					}
				}
				return
			}

			await this.retractCompletionResult()
			await this.say("user_feedback", feedbackText, feedbackImages)
			nextTurnInput = {
				userContent: this.buildUserMessageContent(feedbackText, feedbackImages),
				includeFileDetails: false,
			}
		}
	}

	public async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
		onInitialUserContentPersisted?: () => Promise<void> | void,
	): Promise<boolean> {
		interface StackItem {
			userContent: Anthropic.Messages.ContentBlockParam[]
			includeFileDetails: boolean
			retryAttempt?: number
			userMessageWasRemoved?: boolean // Track if user message was removed due to empty response
			steeringPersistence?: {
				onPersisted?: () => Promise<void> | void
			}
		}

		const stack: StackItem[] = [
			{
				userContent,
				includeFileDetails,
				retryAttempt: 0,
				...(onInitialUserContentPersisted
					? { steeringPersistence: { onPersisted: onInitialUserContentPersisted } }
					: {}),
			},
		]
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
					// The failed turn may have re-armed the limit after steering was
					// accepted. Reset again at durable consumption time so this exact
					// guidance reaches the next model request.
					this.resetMistakeRecoveryState()
					stack.push({
						userContent: [
							...currentUserContent,
							...this.buildUserMessageContent(pendingSteer.text, pendingSteer.images),
						],
						includeFileDetails: currentIncludeFileDetails,
						retryAttempt: currentItem.retryAttempt,
						userMessageWasRemoved: currentItem.userMessageWasRemoved,
						steeringPersistence: { onPersisted: pendingSteer.onPersisted },
					})
					continue
				}

				if (this.consecutiveMistakeLimit > 0 && this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
					await this.handleConsecutiveMistakeLimit(currentUserContent)
				}

				// Determine API protocol based on provider and model
				const modelId = getModelId(this.apiConfiguration)
				const apiProvider = this.apiConfiguration.apiProvider
				const apiProtocol = getApiProtocol(
					apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
					modelId,
				)

				const provider = this.providerRef.deref()
				let state = provider ? await provider.getState() : undefined

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
				if (slashCommandMode && provider) {
					const targetMode = getModeBySlug(slashCommandMode, state?.customModes)
					if (targetMode) {
						await provider.setTaskMode(this.taskId, slashCommandMode)
						state = await provider.getState()
					}
				}

				const environmentDetails = await getEnvironmentDetails(this, currentIncludeFileDetails, state)

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
				const deliveryProvider = this.providerRef.deref()
				// A transient persistence failure while ACKing or releasing a durable
				// mailbox claim must not wedge that result until extension restart.
				await this.retryPendingAutomaticResultClaimSettlement(deliveryProvider)
				const pendingSpawnedSubagentTaskIds = this.getPendingSpawnedSubagentResults().map(
					({ taskId }) => taskId,
				)
				const automaticResultClaim =
					pendingSpawnedSubagentTaskIds.length > 0 && deliveryProvider?.claimAutomaticSubagentResults
						? await deliveryProvider.claimAutomaticSubagentResults(this, pendingSpawnedSubagentTaskIds)
						: undefined
				const claimedTaskIds = automaticResultClaim ? new Set(automaticResultClaim.taskIds) : undefined
				const { content: finalUserContent, pendingResults: pendingSpawnedSubagentResults } =
					this.buildUserContentWithPendingSpawnedSubagentResults(
						contentWithoutEnvDetails,
						environmentDetails,
						claimedTaskIds,
					)
				// Only add user message to conversation history if:
				// 1. This is the first attempt (retryAttempt === 0), AND
				// 2. The original userContent was not empty (empty signals delegation resume where
				//    the user message with tool_result and env details is already in history), OR
				// 3. The message was removed in a previous iteration (userMessageWasRemoved === true)
				// This prevents consecutive user messages while allowing re-add when needed
				const isEmptyUserContent = currentUserContent.length === 0 && pendingSpawnedSubagentResults.length === 0
				const shouldAddUserMessage =
					((currentItem.retryAttempt ?? 0) === 0 && !isEmptyUserContent) || currentItem.userMessageWasRemoved
				if (shouldAddUserMessage) {
					let historyPersisted = false
					try {
						historyPersisted = await this.addToApiConversationHistory({
							role: "user",
							content: finalUserContent,
						})
						if (!historyPersisted) historyPersisted = await this.retrySaveApiConversationHistory()
						if (!historyPersisted) {
							throw new Error("Failed to persist the user turn before starting the provider request")
						}
						if (currentItem.steeringPersistence) {
							await currentItem.steeringPersistence.onPersisted?.()
							this.steerMessageAwaitingPersistence = false
						}
						await this.markSpawnedSubagentResultsDelivered(
							pendingSpawnedSubagentResults.map(({ taskId }) => taskId),
						)
						if (automaticResultClaim && automaticResultClaim.taskIds.length > 0 && deliveryProvider) {
							await deliveryProvider.acknowledgeAutomaticSubagentResults(
								this,
								automaticResultClaim.claimId,
							)
						}
					} catch (error) {
						if (automaticResultClaim && automaticResultClaim.taskIds.length > 0 && deliveryProvider) {
							try {
								if (historyPersisted) {
									await deliveryProvider.acknowledgeAutomaticSubagentResults(
										this,
										automaticResultClaim.claimId,
									)
								} else {
									await deliveryProvider.releaseAutomaticSubagentResults(
										this,
										automaticResultClaim.claimId,
									)
								}
							} catch (settlementError) {
								this.retainAutomaticResultClaimSettlement(
									automaticResultClaim.claimId,
									historyPersisted ? "acknowledge" : "release",
								)
								throw new AggregateError(
									[error, settlementError],
									"Failed to persist the user turn and settle its automatic-result mailbox claim",
								)
							}
						}
						throw error
					}
					TelemetryService.instance.captureConversationMessage(this.taskId, "user")
				} else if (automaticResultClaim && automaticResultClaim.taskIds.length > 0 && deliveryProvider) {
					try {
						await deliveryProvider.releaseAutomaticSubagentResults(this, automaticResultClaim.claimId)
					} catch (error) {
						this.retainAutomaticResultClaimSettlement(automaticResultClaim.claimId, "release")
						throw error
					}
				}

				// A nested Worker proposal targets this task's working tree. Suspend
				// before the next provider request so explicit Apply/Discard cannot race
				// model generation or a workspace mutation. The action lease releases
				// this barrier only after the artifact and transcript have settled.
				await this.waitForPendingSubagentChangeSetReviews()

				// Persist locally produced tool and child results before entering the
				// interruptible provider throttle. The same profile lane still serializes
				// parent and child requests, but stopping during the wait can no longer
				// discard a result that already completed locally.
				if (this.abort) {
					throw new Error(
						`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`,
					)
				}
				const pacingWaitCountBefore = this.requestPacingWaitCount
				await this.maybeWaitForProviderRateLimit(currentItem.retryAttempt ?? 0, state)
				if (this.requestPacingWaitCount > pacingWaitCountBefore) {
					await this.appendRequestPacingUpdateToLatestUserMessage()
				}
				if (this.abort) {
					throw new Error(
						`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`,
					)
				}

				await this.say(
					"api_req_started",
					JSON.stringify({
						apiProtocol,
					} satisfies ClineApiReqInfo),
				)

				const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

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
							// lastMessage.ts = Date.now() DO NOT update ts since it is used as a ChatRow key
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
					this.currentAssistantResponseMessageTs = undefined
					this.didCompleteReadingStream = false
					this.userMessageContent = []
					this.userMessageContentReady = false
					this.didRejectTool = false
					this.didAlreadyUseTool = false
					this.assistantMessageSavedToHistory = false
					// Reset tool failure flag for each new assistant turn - this ensures that tool failures
					// only prevent attempt_completion within the same assistant message, not across turns
					// (e.g., if a tool fails, then user sends a message saying "just complete anyway")
					this.didToolFailInCurrentTurn = false
					this.presentAssistantMessageLocked = false
					this.presentAssistantMessageHasPendingUpdates = false
					// No legacy text-stream tool parser.
					this.streamingToolCallIndices.clear()
					// Clear any leftover streaming tool call state from previous interrupted streams
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
						state,
					})
					let assistantMessage = ""
					let reasoningMessage = ""
					let pendingGroundingSources: GroundingSource[] = []
					this.isStreaming = true

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

							switch (chunk.type) {
								case "reasoning": {
									reasoningMessage += chunk.text
									// Only apply formatting if the message contains sentence-ending punctuation followed by **
									let formattedReasoning = reasoningMessage
									if (reasoningMessage.includes("**")) {
										// Add line breaks before **Title** patterns that appear after sentence endings
										// This targets section headers like "...end of sentence.**Title Here**"
										// Handles periods, exclamation marks, and question marks
										formattedReasoning = reasoningMessage.replace(
											/([.!?])\*\*([^*\n]+)\*\*/g,
											"$1\n\n**$2**",
										)
									}
									await this.say("reasoning", formattedReasoning, undefined, true)
									break
								}
								case "usage":
									inputTokens += chunk.inputTokens
									outputTokens += chunk.outputTokens
									cacheWriteTokens += chunk.cacheWriteTokens ?? 0
									cacheReadTokens += chunk.cacheReadTokens ?? 0
									totalCost = chunk.totalCost
									break
								case "grounding":
									// Handle grounding sources separately from regular content
									// to prevent state persistence issues - store them separately
									if (chunk.sources && chunk.sources.length > 0) {
										pendingGroundingSources.push(...chunk.sources)
									}
									break
								case "tool_call_partial": {
									// Process raw tool call chunk through NativeToolCallParser
									// which handles tracking, buffering, and emits events
									const events = NativeToolCallParser.processRawChunk(
										{
											index: chunk.index,
											id: chunk.id,
											name: chunk.name,
											arguments: chunk.arguments,
										},
										this.taskId,
									)

									this.processNativeToolCallStreamEvents(events)
									break
								}

								case "tool_call_start":
								case "tool_call_delta":
								case "tool_call_end": {
									this.processNativeToolCallStreamEvents([chunk])
									break
								}

								case "tool_call": {
									// Legacy: Handle complete tool calls (for backward compatibility)
									// Convert native tool call to ToolUse format
									const toolUse = NativeToolCallParser.parseToolCall({
										id: chunk.id,
										name: chunk.name as ToolName,
										arguments: chunk.arguments,
									})

									if (!toolUse) {
										console.error(`Failed to parse tool call for task ${this.taskId}:`, chunk)
										break
									}

									// Store the tool call ID on the ToolUse object for later reference
									// This is needed to create tool_result blocks that reference the correct tool_use_id
									toolUse.id = chunk.id

									// Add the tool use to assistant message content
									this.assistantMessageContent.push(toolUse)

									// Mark that we have new content to process
									this.userMessageContentReady = false

									break
								}
								case "text": {
									assistantMessage += chunk.text

									// Native tool calling: text chunks are plain text.
									// Create or update a text content block directly
									const lastBlock =
										this.assistantMessageContent[this.assistantMessageContent.length - 1]
									if (lastBlock?.type === "text" && lastBlock.partial) {
										lastBlock.content = assistantMessage
									} else {
										this.assistantMessageContent.push({
											type: "text",
											content: assistantMessage,
											partial: true,
										})
										this.userMessageContentReady = false
									}
									presentAssistantMessage(this)
									break
								}
							}

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

							if (this.didAlreadyUseTool) {
								assistantMessage +=
									"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
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
									steeringPersistence: { onPersisted: pendingSteer.onPersisted },
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
						// Clean up the abort controller when streaming completes
						this.currentRequestAbortController = undefined
					}

					// Need to call here in case the stream was aborted.
					if (this.abort || this.abandoned) {
						throw new Error(
							`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`,
						)
					}

					this.didCompleteReadingStream = true

					// Set any blocks to be complete to allow `presentAssistantMessage`
					// to finish and set `userMessageContentReady` to true.
					// (Could be a text block that had no subsequent tool uses, or a
					// text block at the very end, or an invalid tool use, etc. Whatever
					// the case, `presentAssistantMessage` relies on these blocks either
					// to be completed or the user to reject a block in order to proceed
					// and eventually set userMessageContentReady to true.)

					// Finalize any remaining streaming tool calls that weren't explicitly ended
					// This is critical for MCP tools which need tool_call_end events to be properly
					// converted from ToolUse to McpToolUse via finalizeStreamingToolCall()
					const finalizeEvents = NativeToolCallParser.finalizeRawChunks(this.taskId)
					for (const event of finalizeEvents) {
						if (event.type === "tool_call_end") {
							// Finalize the streaming tool call
							const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(event.id, this.taskId)

							// Get the index for this tool call
							const toolUseIndex = this.streamingToolCallIndices.get(event.id)

							if (finalToolUse) {
								// Store the tool call ID
								;(finalToolUse as any).id = event.id

								// Get the index and replace partial with final
								if (toolUseIndex !== undefined) {
									this.assistantMessageContent[toolUseIndex] = finalToolUse
								}

								// Clean up tracking
								this.streamingToolCallIndices.delete(event.id)

								// Mark that we have new content to process
								this.userMessageContentReady = false
							} else if (toolUseIndex !== undefined) {
								// finalizeStreamingToolCall returned null (malformed JSON or missing args)
								// We still need to mark the tool as non-partial so it gets executed
								// The tool's validation will catch any missing required parameters
								const existingToolUse = this.assistantMessageContent[toolUseIndex]
								if (existingToolUse && existingToolUse.type === "tool_use") {
									existingToolUse.partial = false
									// Ensure it has the ID for native protocol
									;(existingToolUse as any).id = event.id
								}

								// Clean up tracking
								this.streamingToolCallIndices.delete(event.id)

								// Mark that we have new content to process
								this.userMessageContentReady = false
							}
						}
					}

					// IMPORTANT: Capture partialBlocks AFTER finalizeRawChunks() to avoid double-presentation.
					// Tools finalized above are already presented, so we only want blocks still partial after finalization.
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

						// Enforce terminal-tool isolation before any tools execute. Delegation and
						// completion both close or suspend the current turn, so mixing either with
						// another tool would leave results racing a terminal transition.
						const assistantToolUses = assistantContent.filter(
							(block): block is Anthropic.ToolUseBlockParam => block.type === "tool_use",
						)
						const terminalTool = assistantToolUses.find(
							(block) => block.name === "new_task" || block.name === "attempt_completion",
						)
						const hasMixedTerminalToolBatch = assistantToolUses.length > 1 && terminalTool !== undefined

						if (hasMixedTerminalToolBatch) {
							const isolationError = `${terminalTool.name} must be called by itself in a message turn. No tools from this turn were executed. Retry by calling only ${terminalTool.name} after any required setup is complete.`

							for (const tool of assistantToolUses) {
								this.pushToolResultToUserContent({
									type: "tool_result",
									tool_use_id: tool.id,
									content: isolationError,
									is_error: true,
								})
							}

							this.assistantMessageContent = []
							this.currentStreamingContentIndex = 0
							this.userMessageContentReady = true
						}

						// Save assistant message BEFORE executing tools
						// This is critical for new_task: when it triggers delegation, flushPendingToolResultsToHistory()
						// will save the user message with tool_results. The assistant message must already be in history
						// so that tool_result blocks appear AFTER their corresponding tool_use blocks.
						const assistantResponsePersisted = await this.persistAssistantResponseBeforeEffects(
							{ role: "assistant", content: assistantContent },
							reasoningMessage || undefined,
						)
						if (!assistantResponsePersisted) {
							return true
						}

						TelemetryService.instance.captureConversationMessage(this.taskId, "assistant")
					}

					// Tool calls are intentionally presented only after the complete
					// assistant response has been persisted. This preserves native
					// tool_use/tool_result ordering and prevents a streaming tool call
					// from interrupting the provider response.
					if (hasToolUses) {
						await presentAssistantMessage(this)
					}

					// Present any partial blocks that were just completed. This is a
					// recovery path for malformed streams; normal tool calls are presented
					// only after the complete assistant response is persisted above.
					// NOTE: This MUST happen AFTER saving the assistant message to API history.
					// When new_task is in the batch, it triggers delegation which calls flushPendingToolResultsToHistory().
					// If the assistant message isn't saved yet, tool_results would appear before tool_use blocks.
					if (partialBlocks.length > 0) {
						// If there is content to update then it will complete and
						// update `this.userMessageContentReady` to true, which we
						// `pWaitFor` before making the next request.
						presentAssistantMessage(this)
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

						if (this.didComplete) {
							return true
						}

						// Primary tasks may end with ordinary assistant text. Managed children
						// retain the explicit completion tool because it publishes their durable
						// terminal result back to the parent.
						const didToolUse = hasToolUses

						if (!didToolUse && this.taskKind === "subagent") {
							// Increment consecutive no-tool-use counter
							this.consecutiveNoToolUseCount++

							// Only show error and count toward mistake limit after 2 consecutive failures
							if (this.consecutiveNoToolUseCount >= 2) {
								await this.say("error", "MODEL_NO_TOOLS_USED")
								// Only count toward mistake limit after second consecutive failure
								this.consecutiveMistakeCount++
							}

							// Use the task's locked protocol for consistent behavior
							this.userMessageContent.push({
								type: "text",
								text: formatResponse.noToolsUsed(),
							})
						} else {
							// Reset the legacy recovery counter after tools or a valid primary response.
							this.consecutiveNoToolUseCount = 0
						}

						// Return after one complete model/tool turn. AgentTurnEngine owns
						// continuation sequencing; keeping this method to one step makes
						// the assistant-response/tool-result boundary explicit.
						return false
					} else {
						// If there's no assistant_responses, that means we got no text
						// or tool_use content blocks from API which we should assume is
						// an error.

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

	private async getFrozenSubagentInstructions(): Promise<string | undefined> {
		if (this.taskKind !== "subagent" || !this.subagentContextManifest) return undefined
		if (this.subagentFrozenInstructions !== undefined) return this.subagentFrozenInstructions
		if (this.subagentInstructionSnapshotLoaded) {
			if (this.subagentInstructionPlacement === "system") {
				throw new Error("Managed child frozen instruction snapshot is missing")
			}
			return undefined
		}

		const instructions = await readSubagentInstructionSnapshot({
			taskId: this.taskId,
			globalStoragePath: this.globalStoragePath,
			expectedDigest: this.subagentContextManifest.instructions.digest,
		})
		this.subagentInstructionSnapshotLoaded = true
		if (instructions === undefined && this.subagentInstructionPlacement === "system") {
			throw new Error("Managed child frozen instruction snapshot is missing")
		}
		this.subagentFrozenInstructions = instructions
		this.subagentInstructionSnapshotPersisted = instructions !== undefined
		return instructions
	}

	/** Persist and verify the private system-layer snapshot before a managed child is started. */
	public async persistFrozenSubagentInstructions(): Promise<void> {
		if (this.taskKind !== "subagent" || this.subagentInstructionPlacement !== "system") return
		if (this.subagentInstructionSnapshotPersisted) return
		if (!this.subagentContextManifest || this.subagentFrozenInstructions === undefined) {
			throw new Error("Managed child frozen instruction snapshot is missing")
		}

		await saveSubagentInstructionSnapshot({
			taskId: this.taskId,
			globalStoragePath: this.globalStoragePath,
			instructions: this.subagentFrozenInstructions,
			expectedDigest: this.subagentContextManifest.instructions.digest,
		})
		const persisted = await readSubagentInstructionSnapshot({
			taskId: this.taskId,
			globalStoragePath: this.globalStoragePath,
			expectedDigest: this.subagentContextManifest.instructions.digest,
		})
		if (persisted !== this.subagentFrozenInstructions) {
			throw new Error("Managed child frozen instruction snapshot failed persistence verification")
		}
		this.subagentInstructionSnapshotLoaded = true
		this.subagentInstructionSnapshotPersisted = true
	}

	/** Capture the exact mutable instruction layer once before a managed child launches. */
	public async captureEffectiveInheritedInstructions(): Promise<{
		effectiveText: string
		sources: SubagentContextInstructionSourceInput[]
	}> {
		if (this.taskKind === "subagent" && this.subagentContextManifest) {
			const effectiveText =
				(await this.getFrozenSubagentInstructions()) ??
				extractLegacyFrozenSubagentInstructions(
					this.apiConversationHistory,
					this.subagentContextManifest.instructions.digest,
				)
			if (!effectiveText) {
				throw new Error("Managed child frozen instruction snapshot is unavailable for delegation")
			}
			return {
				effectiveText,
				sources: this.subagentContextManifest.instructions.sources.map(({ kind, ref, digest }) => ({
					kind,
					ref,
					digest,
				})),
			}
		}

		const provider = this.providerRef.deref()
		if (!provider) throw new Error("Provider not available")
		const state = await provider.getState()
		const mode = await this.getTaskMode()
		const promptComponent = getPromptComponent(state?.customModePrompts, mode)
		const { baseInstructions } = getModeSelection(mode, promptComponent, state?.customModes)
		const useAgentRules = vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true
		const settings = {
			todoListEnabled: this.apiConfiguration?.todoListEnabled ?? true,
			useAgentRules,
			enableSubfolderRules: state?.enableSubfolderRules ?? false,
			newTaskRequireTodos: vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false),
			isStealthModel: this.api.getModel().info?.isStealthModel,
		}
		const agentInstructionSources = useAgentRules
			? await loadApplicableAgentInstructionSources(this.cwd, settings.enableSubfolderRules)
			: []
		const effectiveText = await addCustomInstructions(
			baseInstructions,
			state?.customInstructions || "",
			this.cwd,
			mode,
			{
				language: state?.language ?? formatLanguage(vscode.env.language),
				rooIgnoreInstructions: this.rooIgnoreController?.getInstructions(),
				settings,
				agentInstructionSources,
			},
		)
		const sources: SubagentContextInstructionSourceInput[] = [
			{
				kind: "aggregate",
				ref: `task:${this.taskId}:effective-instructions:${mode}`,
				text: effectiveText,
			},
		]
		sources.push(...agentInstructionSources)
		return { effectiveText, sources }
	}

	private async getSystemPrompt(stateOverride?: TaskRequestState): Promise<string> {
		const state = stateOverride ?? (await this.providerRef.deref()?.getState())
		const { mcpEnabled } = state ?? {}
		const isSubagent = this.taskKind === "subagent"
		let mcpHub: McpHub | undefined
		if (!isSubagent && (mcpEnabled ?? true)) {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			// The provider initializes MCP in the background. A task should use the
			// currently ready hub, if any, but must not wait up to ten seconds for MCP
			// configuration or connections before its first model request.
			mcpHub = provider.getMcpHub()
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()

		const { customModes, customModePrompts, customInstructions, experiments, language, enableSubfolderRules } =
			state ?? {}
		const mode = await this.getTaskMode()
		const apiConfiguration = this.apiConfiguration
		const subagentAncestry = this.subagentContextManifest?.orchestration?.ancestry
		const effectiveSubagentDelegationPolicy = resolveSubagentDelegationPolicy({
			settingsPolicy: state?.subagentDelegationPolicy,
			frozenTaskPolicy:
				this.subagentContextManifest?.orchestration?.delegationPolicy.policy ?? this.subagentDelegationPolicy,
			// A live explicit-only setting is a security narrowing for an
			// already-open proactive task. A later proactive setting never widens
			// a task that was frozen as explicit-only.
			requestedChildPolicy: state?.subagentDelegationPolicy === "explicit-only" ? "explicit-only" : undefined,
			taskExplicitlyEnabled: this.subagentDelegationExplicitlyEnabled === true,
		}).policy
		const subagentCanDelegate = Boolean(
			isSubagent &&
				this.subagentContextManifest?.runtimePolicy.delegate === true &&
				subagentAncestry &&
				subagentAncestry.depth < subagentAncestry.maxDepth &&
				this.getTaskAllowedToolNames()?.includes("spawn_agent"),
		)
		const frozenSubagentInstructions = isSubagent ? await this.getFrozenSubagentInstructions() : undefined

		const systemPrompt = await (async () => {
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
					subagentRole: isSubagent ? this.subagentRole : undefined,
					subagentHasInheritedSkills: isSubagent
						? Boolean(this.subagentContextManifest?.skills.length)
						: undefined,
					subagentUsesFrozenContext: isSubagent ? this.subagentContextManifest !== undefined : undefined,
					subagentFrozenInstructions: frozenSubagentInstructions,
					subagentCanDelegate: isSubagent ? subagentCanDelegate : undefined,
					subagentDelegationPolicy: effectiveSubagentDelegationPolicy,
				},
				undefined, // todoList
				this.api.getModel().id,
				isSubagent ? undefined : provider.getSkillsManager(),
			)
		})()

		return redactTaskPrivatePaths(this, systemPrompt)
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
				allowedToolNames: this.getTaskAllowedToolNames(),
				taskKind: this.taskKind,
				enableAgentLifecycleTools: this.shouldExposeAgentLifecycleTools(),
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
			const environmentDetails = await getEnvironmentDetails(this, true, state)

			// Force aggressive truncation by keeping only 75% of the conversation history
			const truncateResult = await manageContext({
				messages: this.apiConversationHistory,
				totalTokens: contextTokens || 0,
				maxTokens,
				contextWindow,
				apiHandler: this.api,
				autoCondenseContext: true,
				autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT,
				systemPrompt: await this.getSystemPrompt(state),
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
	private async maybeWaitForProviderRateLimit(retryAttempt: number, stateOverride?: TaskRequestState): Promise<void> {
		// A task owns a frozen provider profile. Background sub-agents may be
		// routed differently from the foreground profile exposed by getState().
		const rateLimitSeconds = this.apiConfiguration?.rateLimitSeconds ?? 0

		if (rateLimitSeconds <= 0) {
			return
		}

		const laneKey = await this.getProviderRateLimitLaneKey(stateOverride)
		const existingLane = Task.providerRateLimitLanes.get(laneKey)
		const lane = existingLane ?? { queue: Promise.resolve() }
		if (!existingLane) {
			Task.providerRateLimitLanes.set(laneKey, lane)
		}

		// Append the complete wait-and-reserve operation synchronously after resolving
		// the lane key. This removes the check/wait/set race between concurrent tasks.
		const reservation = lane.queue.then(async () => {
			const now = performance.now()
			const timeSinceLastRequest = lane.lastRequestTime === undefined ? Infinity : now - lane.lastRequestTime
			const remainingMs = Math.max(0, rateLimitSeconds * 1000 - timeSinceLastRequest)
			const rateLimitDelay = Math.ceil(Math.min(rateLimitSeconds, remainingMs / 1000))

			if (rateLimitDelay > 0) {
				const plannedWaitMs = retryAttempt === 0 ? rateLimitDelay * 1000 : remainingMs
				if (retryAttempt === 0) {
					for (let i = rateLimitDelay; i > 0; i--) {
						// Send structured JSON data for i18n-safe transport.
						const delayMessage = JSON.stringify({ seconds: i })
						await this.say("api_req_rate_limit_wait", delayMessage, undefined, true)
						await delay(1000)
					}
					// Finalize the partial message so the UI doesn't keep rendering an in-progress spinner.
					await this.say("api_req_rate_limit_wait", undefined, undefined, false)
				} else {
					// Retry flows announce their own backoff. Still enforce any remainder
					// introduced by another request on this lane without a second countdown.
					await delay(remainingMs)
				}
				this.requestPacingWaitCount++
				this.requestPacingWaitMs += plannedWaitMs
			}

			lane.lastRequestTime = performance.now()
		})

		lane.queue = reservation.catch(() => undefined)
		await reservation
	}

	private async getProviderRateLimitLaneKey(stateOverride?: TaskRequestState): Promise<string> {
		const routedProfileId = this.subagentModelRoute?.profileId
		if (routedProfileId) {
			return `profile:${routedProfileId}`
		}

		await this.waitForApiConfigInitialization()
		const state = stateOverride ?? (await this.providerRef.deref()?.getState())
		const profileName = this._taskApiConfigName ?? state?.currentApiConfigName
		const profileId = state?.listApiConfigMeta?.find((profile: any) => profile.name === profileName)?.id
		if (profileId) {
			return `profile:${profileId}`
		}

		// Legacy/restored tasks may not have a resolvable stable ID. Keep their lane
		// credential-free while separating distinct provider/profile/model routes.
		return `configuration:${JSON.stringify([
			this.apiConfiguration.apiProvider ?? "unknown",
			profileName ?? "default",
			getModelId(this.apiConfiguration) ?? "default",
		])}`
	}

	private async getProviderRateLimitRemainingSeconds(): Promise<number> {
		const rateLimitSeconds = this.apiConfiguration?.rateLimitSeconds ?? 0
		if (rateLimitSeconds <= 0) {
			return 0
		}

		const lane = Task.providerRateLimitLanes.get(await this.getProviderRateLimitLaneKey())
		if (lane?.lastRequestTime === undefined) {
			return 0
		}

		const elapsed = performance.now() - lane.lastRequestTime
		return Math.ceil(Math.min(rateLimitSeconds, Math.max(0, rateLimitSeconds * 1000 - elapsed) / 1000))
	}

	public async *attemptApiRequest(
		retryAttempt: number = 0,
		options: { skipProviderRateLimit?: boolean; state?: TaskRequestState } = {},
	): ApiStream {
		const state = options.state ?? (await this.providerRef.deref()?.getState())

		const {
			autoApprovalEnabled,
			requestDelaySeconds,
			autoCondenseContext = true,
			autoCondenseContextPercent = 100,
			profileThresholds = {},
		} = state ?? {}
		const mode = await this.getTaskMode()
		const apiConfiguration = this.apiConfiguration

		// Get condensing configuration for automatic triggers.
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE

		if (!options.skipProviderRateLimit) {
			await this.maybeWaitForProviderRateLimit(retryAttempt, state)
		}
		const systemPrompt = await this.getSystemPrompt(state)
		const { contextTokens } = this.getTokenUsage()

		if (contextTokens) {
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
						allowedToolNames: this.getTaskAllowedToolNames(),
						taskKind: this.taskKind,
						enableAgentLifecycleTools: this.shouldExposeAgentLifecycleTools(),
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
				? await getEnvironmentDetails(this, true, state)
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
				})
				if (truncateResult.messages !== this.apiConversationHistory) {
					await this.overwriteApiConversationHistory(truncateResult.messages)
				}
				if (truncateResult.error) {
					await this.say("condense_context_error", truncateResult.error)
				}
				if (truncateResult.summary) {
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
		const effectiveHistory = getEffectiveApiHistory(this.apiConversationHistory)
		const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)
		// For API only: merge consecutive user messages (excludes summary messages per
		// mergeConsecutiveApiMessages implementation) without mutating stored history.
		const mergedForApi = mergeConsecutiveApiMessages(messagesSinceLastSummary, { roles: ["user"] })
		const messagesWithoutImages = maybeRemoveImageBlocks(mergedForApi, this.api)
		const cleanConversationHistory = this.buildCleanConversationHistory(messagesWithoutImages as ApiMessage[])

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
		const modelInfo = this.api.getModel().info

		// Build complete tools array: native tools + dynamic MCP tools
		// When includeAllToolsWithRestrictions is true, returns all tools but provides
		// allowedFunctionNames for providers (like Gemini) that need to see all tool
		// definitions in history while restricting callable tools for the current mode.
		// Only Gemini currently supports this - other providers filter tools normally.
		let allTools: OpenAI.Chat.ChatCompletionTool[] = []
		let allowedFunctionNames: string[] | undefined

		// Gemini requires all tool definitions to be present for history compatibility,
		// but uses allowedFunctionNames to restrict which tools can be called.
		// Vertex Gemini uses the same GenAI request format and validation rules.
		// Other providers (Anthropic, OpenAI, etc.) don't support this feature yet,
		// so they continue to receive only the filtered tools for the current mode.
		const supportsAllowedFunctionNames =
			apiConfiguration?.apiProvider === "gemini" || apiConfiguration?.apiProvider === "vertex"

		{
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
				allowedToolNames: this.getTaskAllowedToolNames(),
				taskKind: this.taskKind,
				enableAgentLifecycleTools: this.shouldExposeAgentLifecycleTools(),
			})
			allTools = toolsResult.tools
			allowedFunctionNames = toolsResult.allowedFunctionNames
		}

		const shouldIncludeTools = allTools.length > 0

		const metadata: ApiHandlerCreateMessageMetadata = {
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

		// Create an AbortController to allow cancelling the request mid-stream
		this.currentRequestAbortController = new AbortController()
		const abortSignal = this.currentRequestAbortController.signal
		// Reset the flag after using it
		this.skipPrevResponseIdOnce = false

		// The provider accepts reasoning items alongside standard messages; cast to the expected parameter type.
		const stream = this.api.createMessage(
			systemPrompt,
			cleanConversationHistory as unknown as Anthropic.Messages.MessageParam[],
			metadata,
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

				// Delegate generator output from the recursive call.
				yield* this.attemptApiRequest()
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

			// Respect this task's routed provider-profile lane.
			const rateLimitDelay = await this.getProviderRateLimitRemainingSeconds()

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
			const persistedVscodeLmMarker = (msg as ApiMessage & { vscodeLmStatefulMarker?: unknown })
				.vscodeLmStatefulMarker
			const vscodeLmMetadata =
				msg.role === "assistant" &&
				this.apiConfiguration.apiProvider === "vscode-lm" &&
				typeof persistedVscodeLmMarker === "string"
					? { vscodeLmStatefulMarker: persistedVscodeLmMarker }
					: {}

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
						...vscodeLmMetadata,
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
						...vscodeLmMetadata,
					} as Anthropic.Messages.MessageParam)

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
						...vscodeLmMetadata,
					} as Anthropic.Messages.MessageParam)

					continue
				}
			}

			// Default path for regular messages (no embedded reasoning)
			if (msg.role) {
				cleanConversationHistory.push({
					role: msg.role,
					content: msg.content as Anthropic.Messages.ContentBlockParam[] | string,
					...vscodeLmMetadata,
				} as Anthropic.Messages.MessageParam)
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
		this.didToolFailInCurrentTurn = true
		this.lastToolFailure = { toolName, ...(error ? { error } : {}) }

		if (error) {
			this.emit(RooCodeEventName.TaskToolFailed, this.taskId, toolName, error)
		}
	}

	public getTaskCancellationSignal(): AbortSignal {
		return this.currentRequestAbortController?.signal ?? this.taskCancellationController.signal
	}

	/**
	 * A signal that remains active across model requests and steering interrupts.
	 * Background work should use this instead of the current-request signal so it
	 * is cancelled only when the owning task itself is disposed.
	 */
	public getTaskLifetimeCancellationSignal(): AbortSignal {
		return this.taskCancellationController.signal
	}

	/**
	 * Open one cancellable wait for agent mailbox activity. The lease survives the
	 * provider response ending, but steering, request cancellation, and task
	 * disposal all stop it promptly.
	 */
	public beginAgentWait(): { signal: AbortSignal; dispose: () => void } {
		this.agentWaitAbortController?.abort(new Error("Agent wait was superseded"))
		const controller = new AbortController()
		this.agentWaitAbortController = controller
		const taskSignal = this.taskCancellationController.signal
		const cancelFromTask = () => controller.abort(taskSignal.reason)
		if (taskSignal.aborted) cancelFromTask()
		else taskSignal.addEventListener("abort", cancelFromTask, { once: true })

		return {
			signal: controller.signal,
			dispose: () => {
				taskSignal.removeEventListener("abort", cancelFromTask)
				if (this.agentWaitAbortController === controller) {
					this.agentWaitAbortController = undefined
				}
			},
		}
	}

	public requireChildVerification(taskId: string): void {
		this.childTasksRequiringVerification.add(taskId)
	}

	public getChildTasksRequiringVerification(): readonly string[] {
		return [...this.childTasksRequiringVerification]
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
