import {
	assertPrimaryMode,
	restoreTaskMode,
	taskWorkContextSchema,
	taskWorkPlanSchema,
	taskDesignHandoffSchema,
	MAX_DESIGN_HANDOFF_CHARS,
	type TaskDesignHandoff,
	type AlphaMessageTurn,
	type TaskGoal,
	type TaskGoalCreateInput,
	type TaskGoalResumeInput,
	taskGoalUsageReceiptsSchema,
	type TaskWorkContext,
	type TaskWorkPlan,
	type TaskMemoryState,
	type AgentMailboxEntry,
	type AcceptanceReceipt,
	type AutoCondenseContextScope,
	type ToolApprovalDecision,
	type ToolApprovalPrompt,
	type ToolApprovalRequest,
	persistentCommandPrefixAmendmentSchema,
	toolApprovalDecisionSchema,
	toolApprovalRequestSchema,
	DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT,
	normalizeAssistantMessageMetadata,
} from "@alpha-code/types"
import {
	captureAcceptanceChecks,
	settleAcceptanceChecks,
	getOutstandingAcceptanceChecks,
	getAcceptanceEvidenceFingerprints,
	replaceWorkPlan,
	restoreWorkContext,
	formatWorkContext,
} from "../agent/TaskWorkContext"
import * as path from "path"
import * as fsSync from "fs"
import * as vscode from "vscode"
import os from "os"
import crypto from "crypto"
import { v7 as uuidv7 } from "uuid"
import EventEmitter from "events"
import { AsyncLocalStorage } from "node:async_hooks"
import { isDeepStrictEqual } from "node:util"
import { canContinueFromCommittedHistoryTools } from "../agent/CommittedHistoryRecoveryPolicy"

import { AskIgnoredError } from "./AskIgnoredError"
import { AgentMessageInbox, type AgentMessage } from "../task-persistence/AgentMessageInbox"
import { getPersistedAgentNotificationIds, serializeAgentNotification } from "../task-persistence/agentNotifications"
import { TaskMessageQueuePersistence } from "../task-persistence/TaskMessageQueuePersistence"
import {
	canReplayMessageProviderState,
	invalidateOpaqueProviderStateReplay,
	hasOpaqueProviderState,
	isOpaqueProviderContentBlock,
	providerStateScopeSchema,
} from "../task-persistence/providerStateScope"
import { TaskRewindStore, type TaskRewindRecord } from "../task-persistence/TaskRewindStore"
import { replaceDeliberatelyRemovedToolResults } from "../task-persistence/rewindToolResults"
import { TaskGoalStore } from "../task-persistence/TaskGoalStore"
import { GoalController } from "../agent/goals/GoalController"
import { GoalAccountingBindingStore } from "../agent/goals/GoalAccountingBindingStore"
import {
	accountGoalResponse,
	finishGoalStep,
	getGoalStepElapsedReceipt,
	goalResponseTokens,
	type GoalStepAccounting,
	type GoalAccountingBinding,
} from "../agent/GoalStepAccounting"
import {
	readCompletionHookConfig,
	runCompletionHooks,
	runLifecycleHooks,
	HookCommandCleanupError,
	type CompletionHookConfig,
	type CompletionHookPromptProvenance,
	type LifecycleHookPayload,
	type LifecycleHookOutcome,
	type LifecycleHookTarget,
} from "../agent/CompletionHooks"
import { LifecycleHookStoppedError } from "../agent/LifecycleHookTargets"
import { TaskMemoryContext } from "../../services/memory/TaskMemoryContext"
import { assistantMemoryCitationReferences } from "../../services/memory/MemoryCitations"

/** Process-local abort marker; never lets an old hook continue through a replacement owner. */
class LifecycleHookOwnershipError extends Error {
	constructor() {
		super("Request lifecycle preflight was superseded by a newer agent step")
		this.name = "AbortError"
	}
}

class SteerRequestInterruptError extends Error {
	constructor() {
		super("Request interrupted by steered user message")
		this.name = "SteerRequestInterruptError"
	}
}

class ContextRecoveryExhaustedError extends Error {
	readonly retryable = false
	readonly retryCategory = "context"

	constructor(message?: string) {
		super(message || t("common:errors.condense_failed"))
		this.name = "ContextRecoveryExhaustedError"
	}
}

/** Identifies local persistence failures without promoting diagnostic text into chat. */
class TaskPersistenceError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "TaskPersistenceError"
	}
}

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import debounce from "lodash.debounce"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"
import { Package } from "../../shared/package"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { formatToolInvocation } from "../tools/helpers/toolResultFormatting"

import {
	type TaskLike,
	type TaskMetadata,
	type TaskEvents,
	type ProviderSettings,
	type TokenUsage,
	type ParentVerificationObligation,
	type ToolUsage,
	type ToolName,
	type ContextCondense,
	type ContextTruncation,
	type AlphaMessage,
	type SubagentGroupState,
	type SubagentAuthorityGrant,
	type SubagentChangeSetState,
	type ExternalMutationCapability,
	type SubagentContextManifest,
	type SubagentDelegationPolicy,
	type SubagentModelRouteState,
	type SubagentRole,
	type SubagentStopReason,
	type AgentLifecyclePhase,
	type AgentLifecycleSnapshot,
	type AlphaSay,
	type AlphaAsk,
	type ToolProgressStatus,
	type HistoryItem,
	type CreateTaskOptions,
	type ModelInfo,
	type ApprovalMode,
	type AlphaApiReqCancelReason,
	type AlphaApiReqInfo,
	type AsyncUserInputData,
	type UserInputResponseData,
	AlphaCodeEventName,
	TaskStatus,
	TodoItem,
	getApiProtocol,
	getModelId,
	isProviderName,
	isApprovalMode,
	deriveAutoApprovalFlags,
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
	diagnosticTaskIdentitySchema,
	resolveSubagentDelegationPolicy,
	migrateApprovalMode,
	disabledSubagentAutoApprovalPolicy,
	type SubagentAutoApprovalPolicy,
} from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

// api
import { ApiHandler, ApiHandlerCreateMessageMetadata, buildApiHandler, type ApiInstructionFragment } from "../../api"
import {
	type TaskReasoningPreference,
	type TaskReasoningState,
	type TaskReasoningProjection,
	taskReasoningPreferenceSchema,
	subagentModelRouteStateSchema,
} from "@alpha-code/types"
import {
	assertTaskReasoningEffortSupported,
	hasPendingReasoningChange,
	resolveTaskReasoning,
} from "../agent/TaskReasoning"
import { fallbackTaskTitle, generateTaskTitle } from "./taskTitle"
import {
	ApiStreamDeadlineError,
	type ApiDeadlineScope,
	createLinkedAbortController,
	createApiStreamOutcome,
	ApiStream,
	GroundingSource,
	type ApiStreamChunk,
	type ApiStreamOutcomeChunk,
	type ApiStreamRequestMetadata,
	isApiStreamAbortError,
	isApiStreamSemanticChunk,
	normalizeApiStreamErrorMetadata,
} from "../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import {
	ApiRequestTimeoutError,
	getApiRequestTimeout,
	withApiRequestTimeout,
} from "../../api/providers/utils/timeout-config"

// shared
import { findLastIndex } from "../../shared/array"
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { t } from "../../i18n"
import { formatLanguage } from "../../shared/language"
import { getApiMetrics, hasTokenUsageChanged, hasToolUsageChanged } from "../../shared/getApiMetrics"
import { AlphaAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug, getModeBySlug, getModeSelection, planModeSlug } from "../../shared/modes"
import {
	DiffStrategy,
	type ToolUse,
	type ToolParamName,
	toolParamNames,
	isCommandArtifactRead,
} from "../../shared/tools"
import {
	getModelMaxOutputTokens,
	getModelReservedOutputTokens,
	supportsFunctionCallingRestrictions,
} from "../../shared/api"
import {
	ensureProposedPlanBlock,
	parseProposedPlan,
	PROPOSED_PLAN_OPEN_TAG,
	PROPOSED_PLAN_CLOSE_TAG,
} from "../../shared/plan-mode"
import { createDesignHandoff } from "../task-persistence/designHandoff"

// services
import { McpHub } from "../../services/mcp/McpHub"
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { findToolName } from "../../integrations/misc/export-markdown"
import { AlphaTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { commandSessionRegistry, type TaskCommandOutputFinalization } from "../tools/CommandSessionRegistry"
import { BaseTerminal } from "../../integrations/terminal/BaseTerminal"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"

// utils
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"
import { ReasoningSummary } from "./ReasoningSummary"
import { getWorkspacePath } from "../../utils/path"
import { getCommandShell } from "../../utils/shell"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { getToolCallId, getToolResultId, sanitizeToolUseId } from "../../utils/tool-id"
import { getTaskDirectoryPath, resolveExistingTaskDirectoryPathReadOnly } from "../../utils/storage"

// prompts
import { formatResponse } from "../prompts/responses"
import { SYSTEM_PROMPT_FRAGMENTS, getPromptComponent, renderSystemPromptFragments } from "../prompts/system"
import { filterNativeToolsForMode } from "../prompts/tools/filter-tools-for-mode"
import { createSpawnAgentTool } from "../prompts/tools/native-tools/spawn_agent"
import { addCustomInstructions, loadApplicableAgentInstructionSources } from "../prompts/sections"
import { captureProjectInstructionDiscoveryOptions } from "../../services/config-paths/project-instruction-settings"
import { getDesignHandoffPrompt, getDesignHandoffSource } from "../prompts/sections/design-handoff"
import { buildNativeToolsArrayWithRestrictions, createModelToolIdentity } from "./build-tools"
import { TaskToolCatalogCache } from "./TaskToolCatalogCache"

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { canonicalizeToolName } from "../tools/ToolRegistry"
import { extractApplyPatchCommand } from "../tools/apply-patch/invocation"
import { getPatchPaths, ParseError } from "../tools/apply-patch/parser"
import { classifyCommandRead } from "../tools/ParallelCommandRead"
import { isPathWithinRoot } from "../tools/pathSafety"
import { CLOSED_TOOL_REVIEW_POLICY, isPathAllowed } from "../agent/ToolPolicy"
import { formatToolFailureGuidance, normalizeToolFailure, type ToolFailureMetadata } from "../tools/ToolFailure"
import type { ParentCommandVerificationEvidence } from "../agent/AgentControlStore"
import { AgentControlTransactionError } from "../agent/AgentControlTransaction"
import type { CommandVerificationDiagnostic } from "../agent/VerificationScope"
import { formatBackgroundCommandContext } from "../agent/CommandOutcomeContext"
import { CompletionRecovery } from "../agent/CompletionRecovery"
import { SearchLoopRecoveryPolicy, formatSearchLoopRecoveryGuidance } from "../agent/SearchLoopRecoveryPolicy"
import {
	isWorkerWritePathAllowed as isScopedWorkerWritePathAllowed,
	redactTaskPrivatePaths,
} from "../tools/taskPathPresentation"
import { restoreTodoListForTask } from "../tools/UpdateTodoListTool"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { AlphaIgnoreController } from "../ignore/AlphaIgnoreController"
import { AlphaProtectedController } from "../protect/AlphaProtectedController"
import { type AssistantMessageContent, presentAssistantMessage } from "../assistant-message"
import { NativeToolCallParser, type ToolCallStreamEvent } from "../assistant-message/NativeToolCallParser"
import { AgentResponseAccumulator } from "../agent/AgentResponseAccumulator"
import { classifyRequestWorkClass, extractUserRequestText } from "../agent/requestWorkClass"
import {
	AgentRetryPolicy,
	delayWithAbort,
	getAgentRetryDeadline,
	type AgentRetryCategory,
	type AgentRetryDecision,
} from "../agent/AgentRetryPolicy"
import { AgentStepContextBuilder, type AgentStepSnapshot } from "../agent/AgentStepContextBuilder"
import {
	captureInheritedStepInstructions,
	getFinalAssistantMessageIndexes,
	type SubagentInvocationContext,
} from "../agent/SubagentInvocationContext"
import { getSubagentRouteModelId, snapshotProviderSettings } from "../agent/SubagentModelRouter"
import { AgentTurnEventLog } from "../agent/AgentTurnEventLog"
import type { AgentLifecycleEventInput } from "../agent/lifecycle"
import {
	getToolBatchIsolationError,
	ToolScheduler,
	type ToolExecutionHost,
	type ToolSchedulerOutcome,
	type ToolSchedulerResult,
} from "../agent/ToolScheduler"
import type { TaskToolSurface } from "../tools/TaskToolSurface"
import type { ToolPolicyInput } from "../agent/ToolPolicy"
import type { AgentTurnEvent, AgentTurnEventIdentity } from "../agent/AgentTurnEvents"
import type { StepContext } from "../agent/StepContext"
import {
	getCompactionTargetTokens,
	getContextLimits,
	isPostTurnCondenseDue,
	manageContext,
	resolveCondenseThreshold,
	willManageContext,
} from "../context-management"
import { AlphaProvider } from "../webview/AlphaProvider"
import { collectDiagnosticsEvidence, type CollectedDiagnosticsEvidence } from "../webview/diagnosticsEvidence"
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
import {
	digestProviderTranscript,
	ProviderTranscriptRevisionConflictError,
	ProviderTranscriptStore,
	ProviderTranscriptStoreError,
	type ProviderTranscriptCommitReceipt,
} from "../task-persistence/ProviderTranscriptStore"
import { captureEnvironmentDetails } from "../environment/getEnvironmentDetails"
import { EnvironmentContext, type EnvironmentCapture } from "../environment/EnvironmentContext"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"

import {
	processUserContentMentions,
	type ProcessUserContentMentionsResult,
} from "../mentions/processUserContentMentions"
import { finalizeUserContentMentionAttachments } from "../mentions/attachmentBudget"
import {
	getHumanFeedbackToolResultIds,
	getSkillLookupForCapturedCatalog,
} from "../../services/skills/skillInvocationProvenance"
import {
	countContextTokens,
	createTokenCountContext,
	getMessagesSinceLastSummary,
	summarizeConversation,
	getEffectiveApiHistory,
	type CountableHistoryMessage,
	type TokenCountContext,
} from "../condense"
import { MessageQueueService } from "../message-queue/MessageQueueService"
import {
	AutoApprovalHandler,
	captureToolReviewPolicy,
	checkAutoApprovalWithInheritedPolicy,
	getFollowupAutoApprovalTimeoutMs,
} from "../auto-approval"
import { getInheritedSubagentToolNames } from "../agent/SubagentPermissions"
import { clearTaskSessionApprovalGrants } from "../auto-approval/taskSessionApprovalGrants"
import { collectArtifactExecutionIds, MessageManager } from "../message-manager"
import { validateAndFixToolResultIds } from "./validateToolResultIds"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"
import {
	AgentTurnEngine,
	type AgentResponse,
	type AgentResponseItem,
	type AgentToolCall,
	type AgentTurnStagedHost,
	type AgentTurnOutcome,
} from "../agent/AgentTurnEngine"
import { createAgentResponse } from "../agent/AgentResponse"
import {
	buildCanonicalAnthropicAssistantHistoryContent,
	buildCanonicalAssistantHistoryContent,
	isCanonicalEncryptedReasoningHistoryItem,
} from "../task-persistence/canonicalAssistantHistory"
import { lifecycleResponseItems } from "../agent/lifecycle/responseItems"
import {
	assertSubagentHistoryFork,
	isValidSubagentContextManifest,
	type SubagentContextInstructionSourceInput,
	type SubagentHistoryFork,
} from "../agent/SubagentContextCapture"
import { reconcileSubagentGroupAfterReload } from "../agent/SubagentGroupRecovery"

export type CommandExecutionEvidenceStatus = "running" | "succeeded" | "failed" | "denied" | "cancelled" | "timed_out"

export interface CommandExecutionEvidence {
	acceptanceChecks?: AcceptanceReceipt[]
	toolCallId: string
	executionId: string
	status: CommandExecutionEvidenceStatus
	exitCode?: number
	signalName?: string
	startedAt: number
	completedAt?: number
	/** This invocation returned before delivering its final process outcome to the model. */
	returnedInBackground?: boolean
	/** Task-memory only. Durable verification stores the covered applied paths, never command text. */
	command?: string
	/** Explicit applied change sets this command was requested to verify. */
	verificationChangeSetIds?: string[]
	cwd?: string
	verificationVersions?: ParentCommandVerificationEvidence["verificationVersions"]
	verificationDiagnostics?: CommandVerificationDiagnostic[]
}

export interface CompletionGateDecision {
	allowed: boolean
	message?: string
	/** Durable file-level debt used by the shared repair allowance. */
	blockingObligations?: readonly ParentVerificationObligation[]
	/** Runtime waits and unavailable evidence never require a model recovery turn. */
	modelCanResolveRejection: boolean
	classification?: "ready" | "waiting" | "repairable" | "blocked"
	reasonCode?:
		| "ready"
		| "command_running"
		| "receipt_pending"
		| "evidence_pending"
		| "scope_unavailable"
		| "verification_failed"
		| "verification_missing"
		| "managed_results_pending"
		| "descendants_running"
		| "child_results_unconsumed"
		| "review_pending"
		| "todos_open"
		| "persistence_unavailable"
		| "runtime_timeout"
		| "interrupted"
		| "repair_limit"
		| "stale_content"
		| CommandVerificationDiagnostic["code"]
	/** Internal semantic identity; never included in metrics or telemetry. */
	blockerKey?: string
}

export interface CompletionStageMetrics {
	candidateCount: number
	rejectionCount: number
	repairToolCount: number
	runtimeWaitMs: number
	firstCandidateAt?: number
	firstCandidateUsage?: TokenUsage
	settledUsage?: TokenUsage
	persistenceSettledAt?: number
	completedAt?: number
	blockedAt?: number
	lastReasonCode?: CompletionGateDecision["reasonCode"]
}

const OPEN_TODO_COMPLETION_MESSAGE =
	"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion."

const SAFE_EXTERNAL_MUTATION_ASKS = new Set<AlphaAsk>([
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
// A preview is best-effort UI work.  Never let a provider turn boundary wait
// forever for a stale webview update; the preview epoch fence below makes the
// timeout safe by preventing the abandoned promise from touching the next
// turn's state.
const STREAMING_PREVIEW_DRAIN_TIMEOUT_MS = 1000
const MAX_CONTEXT_WINDOW_RETRIES = 3 // Maximum retries for context window errors
const MAX_AUTOMATIC_MISTAKE_RECOVERIES = 1

function getBoundedRequestDeadline(
	configuredTimeoutMs: number | undefined,
	absoluteLimit: number | undefined,
): number | undefined {
	const configuredDeadline =
		typeof configuredTimeoutMs === "number" && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
			? Date.now() + configuredTimeoutMs
			: undefined
	const normalizedLimit =
		typeof absoluteLimit === "number" && Number.isFinite(absoluteLimit) ? absoluteLimit : undefined
	if (configuredDeadline === undefined) return normalizedLimit
	if (normalizedLimit === undefined) return configuredDeadline
	return Math.min(configuredDeadline, normalizedLimit)
}

function getTimeoutWithinDeadline(
	configuredTimeoutMs: number | undefined,
	absoluteDeadline: number | undefined,
): number | undefined {
	if (absoluteDeadline === undefined || !Number.isFinite(absoluteDeadline)) return configuredTimeoutMs
	const remainingMs = absoluteDeadline - Date.now()
	if (remainingMs <= 0) throw new ApiStreamDeadlineError("Automatic retry deadline exceeded", "retry_deadline")
	if (typeof configuredTimeoutMs !== "number" || !Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
		return remainingMs
	}
	return Math.min(configuredTimeoutMs, remainingMs)
}

function throwIfAbsoluteDeadlineExceeded(
	absoluteDeadline: number | undefined,
	timeoutScope: ApiDeadlineScope = "retry_deadline",
): void {
	if (typeof absoluteDeadline === "number" && Number.isFinite(absoluteDeadline) && absoluteDeadline <= Date.now()) {
		throw new ApiStreamDeadlineError(undefined, timeoutScope)
	}
}

type TaskRequestState = Awaited<ReturnType<AlphaProvider["getState"]>>
type ContextCondenseAccounting = {
	observeCost: (cost: number) => void
	persistUnreportedCost: (preserveError: boolean) => Promise<void>
}

type CapturedTaskProvider = {
	apiHandler: ApiHandler
	compactionApiHandler?: ApiHandler
	apiConfiguration: ProviderSettings
	profileConfiguration?: ProviderSettings
	apiConfigName?: string
	profileId?: string
}

type TaskRequestOptions = {
	skipProviderRateLimit?: boolean
	state?: TaskRequestState
	retryCategory?: AgentRetryCategory
	/** Derive a new transcript boundary from this durably closed response with settled audited reads. */
	recoveryStep?: CurrentAgentStep
	/** Remaining absolute budget for a policy-approved automatic retry. */
	retryDeadline?: number
	/** The live Task loop owns policy decisions; omit for legacy direct callers. */
	ownerHandlesRetry?: boolean
	/** Process-local host capture; undefined precedes an owned synchronous step reset. */
	onStepCaptured?: (step: CurrentAgentStep | undefined) => void
	/**
	 * Interrupts read-only/cancellable preflight, provider admission, and retry
	 * waits. Atomic transcript writes finish on their owning queue and are
	 * rechecked against this signal/deadline before provider dispatch.
	 */
	interruptionSignal?: AbortSignal
}

type CanonicalLifecycleEventGuard = () => boolean

type TaskLifecycleHookInvocation = {
	guard: CanonicalLifecycleEventGuard
	provider: AlphaProvider | undefined
	config: CompletionHookConfig
	turn?: AlphaMessageTurn
	context: {
		session_id: string
		turn_id: string
		cwd: string
		model: string
		permission_mode: string
		agent_id?: string
		agent_type?: string
	}
}

type BackgroundUsageDrainOwner = {
	epoch: number
	controller: AbortController
	requestController?: AbortController
	messageIndex: number
	message: AlphaMessage
}

/** Provider-neutral result returned by one Task model/tool step. */
type TaskStepStatus = "completed" | "aborted" | "failed" | "incomplete" | "exhausted" | "awaiting-user"

export function shouldCompactAfterTurn(
	outcome: {
		status: AgentTurnOutcome["status"]
		completionReason?: "assistant" | "host"
	},
	lifecycleHookStopped = false,
): boolean {
	if (lifecycleHookStopped) return false
	return (
		(outcome.status === "completed" && outcome.completionReason === "assistant") ||
		outcome.status === "awaiting-user"
	)
}

type TaskRetryAttempts = Partial<Record<AgentRetryCategory, number>>

interface TaskStepTransaction {
	commitResponse(): Promise<TaskStepExecutionResult>
	executeEffects(): Promise<TaskStepExecutionResult>
	release(): void
}

interface TaskStepExecutionResult {
	status: TaskStepStatus
	response?: AgentResponse
	reason?: string
	error?: unknown
	/** Runtime-only provider-neutral transaction; never part of persisted task state. */
	transaction?: TaskStepTransaction
	/** Process-local admission only; failed canonical output remains failed in history. */
	recovery?: TaskStreamRecovery
}

interface CurrentAgentStep {
	createReasoningSummaryHandler: () => ApiHandler
	snapshot: AgentStepSnapshot<ApiHandler, unknown>
	/** Fresh wire copies from the private, unsanitized logical capture; never persisted or logged. */
	getRequest: () => {
		systemPrompt: string
		messages: Anthropic.Messages.MessageParam[]
		metadata: Omit<ApiHandlerCreateMessageMetadata, "signal" | "deadline" | "streamCapabilities">
	}
	releaseRequest: () => void
	hasRetainedRequest?: () => boolean
	getCapturedProvider?: () => CapturedTaskProvider
	getSubagentInvocationContext?: () => SubagentInvocationContext
	turnId: string
	stepId: string
	requestId: string
	attemptId: string
	surface?: TaskToolSurface
}

interface TaskStreamRecovery {
	step: CurrentAgentStep
	decision: AgentRetryDecision
	error: Error
	retryAttempt: number
	retryAttempts: TaskRetryAttempts
	retryDeadline?: number
	sequenceStartedAt: number
}

type CanonicalToolExecutionOptions = {
	earlyReadStep?: CurrentAgentStep
	deferResultCommit?: boolean
	onSchedulerCreated?: (scheduler: ToolScheduler) => void
}

type EarlyReadonlyDispatch = {
	call: AgentToolCall
	surface: TaskToolSurface
	step: CurrentAgentStep
	runId: string | undefined
	identity: Pick<CurrentAgentStep, "turnId" | "stepId" | "requestId" | "attemptId">
	scheduler?: ToolScheduler
	outcome?: ToolSchedulerOutcome
	error?: unknown
	resultCommitStarted?: boolean
}

type TaskCommandOutputCleanup = {
	guard: CanonicalLifecycleEventGuard
	outputs: readonly TaskCommandOutputFinalization[]
	candidates: ReadonlySet<string>
}

/** Process-local Stop boundary; never rebind cancellation repair after an asynchronous join. */
type TaskCancellationBoundary = {
	guard: CanonicalLifecycleEventGuard
	provider: AlphaProvider | undefined
	step: CurrentAgentStep | undefined
	response: AgentResponse | undefined
	runId: string | undefined
	turnId: string | undefined
	lifecycle: Promise<void> | undefined
	releaseRequest: CurrentAgentStep["releaseRequest"] | undefined
	lifetimeController: AbortController
	requestController: AbortController | undefined
	agentWaitController: AbortController | undefined
	stepInterruptionController: AbortController | undefined
	contextCondenseController: AbortController | undefined
	postTurnCompactionController: AbortController | undefined
	backgroundUsageController: AbortController | undefined
	reasoningSummary: ReasoningSummary | undefined
	goalController: GoalController | undefined
	goalShutdown: Promise<void> | undefined
	manualCompaction: Promise<void> | undefined
	pendingOutput: readonly TaskCommandOutputFinalization[]
	outputCleanup: TaskCommandOutputCleanup
	requestedGoalShutdown?: Promise<void>
	commandCleanupFailed: boolean
	commandCleanupFailure: unknown
	disposalAttempted: boolean
	abortCleanup?: Promise<void>
	wasAlreadyCompleted: boolean
	preserveCommandOutputArtifacts: boolean
}

type TaskCancellationReceipt = Readonly<{
	abort: Promise<void>
	termination: Promise<void>
	isCurrent: CanonicalLifecycleEventGuard
}>

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

interface GoalInputAdmission {
	isStillCurrent(): boolean
	canWake(): Promise<boolean>
}

export interface TaskOptions extends CreateTaskOptions {
	provider: AlphaProvider
	apiConfiguration: ProviderSettings
	enableCheckpoints?: boolean
	checkpointTimeout?: number
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	/** Stop restoration preserves queued drafts until a new human response permits resuming. */
	requireExplicitResume?: boolean
	rootTask?: Task
	parentTask?: Task
	/** Captured at effect admission, before deferred launch outlives the invoking goal step. */
	goalAccountingBinding?: Promise<GoalAccountingBinding | undefined>
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
	/** Host-captured conversational seed for a fresh child; resumed children read their own transcript. */
	subagentHistoryFork?: SubagentHistoryFork
	/** Monotonic timestamp captured when the provider begins admitting this task. */
	performanceSubmissionStartedAt?: number
	/** Optional provider-neutral reviewer; omitted tasks route typed approvals to the user. */
	toolApprovalReviewer?: ToolApprovalReviewer
}

export type ToolApprovalReviewOutcome =
	| { decision: "approve" }
	| { decision: "deny"; feedback?: string }
	| { decision: "fallback_to_user" }

/** Injectable provider-neutral reviewer; absence keeps the existing user review path. */
export type ToolApprovalReviewer = (
	request: ToolApprovalRequest,
	signal: AbortSignal,
	/** Complete action details; request.description may only be a short summary. */
	reviewMessage?: string,
) => Promise<ToolApprovalReviewOutcome>

function parseToolApprovalReviewOutcome(value: unknown): ToolApprovalReviewOutcome {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Tool approval reviewer returned an invalid outcome.")
	}
	const candidate = value as Record<string, unknown>
	const keys = Object.keys(candidate)
	if (candidate.decision === "approve" && keys.length === 1) return { decision: "approve" }
	if (candidate.decision === "fallback_to_user" && keys.length === 1) return { decision: "fallback_to_user" }
	if (
		candidate.decision === "deny" &&
		keys.every((key) => key === "decision" || key === "feedback") &&
		(candidate.feedback === undefined ||
			(typeof candidate.feedback === "string" && candidate.feedback.length <= 20_000))
	) {
		return { decision: "deny", ...(candidate.feedback === undefined ? {} : { feedback: candidate.feedback }) }
	}
	throw new Error("Tool approval reviewer returned an invalid outcome.")
}

/** Hard task-lane capability ceiling used both by capture manifests and runtime filtering. */
export function getSubagentAllowedToolNames(
	role: SubagentRole,
	hasInheritedSkills = false,
	allowDelegation = false,
): readonly ToolName[] {
	const tools: ToolName[] =
		role === "worker"
			? ["apply_patch", "exec_command", "manage_command", "write_stdin", "send_message", "attempt_completion"]
			: ["exec_command", "write_stdin", "send_message", "attempt_completion"]
	if (hasInheritedSkills) tools.splice(tools.length - 1, 0, "skill")
	if (allowDelegation) {
		tools.splice(
			tools.length - 1,
			0,
			"spawn_agent",
			"list_provider_profiles",
			"list_agents",
			"wait_agent",
			"followup_task",
			"interrupt_agent",
		)
	} else {
		tools.splice(tools.length - 1, 0, "list_agents")
	}
	return tools
}

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	readonly taskId: string
	/** Captured host policy: optional presentation requests never widen on resume or delegation. */
	readonly presentationModelCalls?: false
	readonly diagnosticSession: boolean
	readonly diagnosticIncidentId?: string
	readonly diagnosticSourceTaskId?: string
	readonly orchestrationParentTaskId?: string
	readonly orchestrationNotifyCompletion: boolean
	readonly orchestrationWorkspaceMode?: "shared" | "worktree"
	readonly orchestrationWorkspaceRelativePath?: string
	readonly orchestrationWorkspaceBaselineCommit?: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	readonly taskKind: "primary" | "subagent"
	private readonly taskMemoryContext: TaskMemoryContext
	private memoryPreferenceSaveQueue: Promise<void> = Promise.resolve()
	private memoryGenerationPreferenceDirty = false
	private memoryExternalContextDirty = false
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
	private subagentHistoryFork?: SubagentHistoryFork
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
	workContext?: TaskWorkContext
	designHandoff?: TaskDesignHandoff

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

	providerRef: WeakRef<AlphaProvider>
	private readonly globalStoragePath: string
	private readonly agentMessageInbox: AgentMessageInbox
	private readonly agentMessageAdmissions = new Set<Promise<unknown>>()
	private independentAgentMessagesMayResume = false
	private independentAgentWakePromise?: Promise<boolean>
	private agentStopMessageId?: string
	/**
	 * The legacy API-history file remains the provider/runtime authority during
	 * the strangler rollout. This versioned transcript is an integrity-checked
	 * sidecar: a successful Task history save is reported only after both the
	 * legacy write and a verified sidecar receipt have completed.
	 */
	private readonly providerTranscriptStore: ProviderTranscriptStore
	private apiConversationHistorySaveQueue: Promise<void> = Promise.resolve()
	private providerTranscriptCommitReceipt?: ProviderTranscriptCommitReceipt
	private providerTranscriptSidecarFailure?: ProviderTranscriptStoreError
	private apiConversationHistoryFailureGeneration = 0
	/** A staged resume repair is retired by its transcript receipt, independently of input admission. */
	private pendingResumeHistoryRepair?: { message: ApiMessage; persisted: boolean }
	abort: boolean = false
	private abortTaskPromise?: Promise<void>
	private taskCancellationReceipt?: TaskCancellationReceipt
	private retryTaskCancellationFinalization?: () => TaskCancellationReceipt
	private subagentRuntimeUnloadStarted = false
	private subagentRuntimeUnloadPromise?: Promise<void>
	private ownedLifecyclePromise?: Promise<void>
	private queuedInputWakePromise?: Promise<void>
	/** Retains host input until a rehydrated task has installed its initial resume ask. */
	private initialHistoryResumePending = false
	private resumeRequiresExplicitInput = false
	private taskTerminationPromise?: Promise<void>
	currentRequestAbortController?: AbortController
	/** Owns the whole model step, including preflight and automatic context compaction. */
	private stepInterruptionController?: AbortController
	/** Manual compaction is not part of AgentTurnEngine, but Stop must still reach it. */
	private manualContextCondenseSettlement?: Promise<void>
	private contextCondenseAbortController?: AbortController
	private postTurnCompactionAbortController?: AbortController
	private generatedTitleAbortController?: AbortController
	private readonly taskCancellationController = new AbortController()
	private reasoningSummaries?: ReasoningSummary
	private agentWaitAbortController?: AbortController
	private readonly subagentAuthority?: SubagentAuthorityGrant
	private readonly childTasksRequiringVerification = new Set<string>()
	private readonly commandExecutionEvidence = new Map<string, CommandExecutionEvidence>()
	private pendingCommandVerification: Promise<void> = Promise.resolve()
	private pendingCommandVerificationCount = 0
	private completionRuntimeRevision = 0
	private completionRecovery?: CompletionRecovery
	private completionRecoveryActive = false
	private completionStageMetrics?: CompletionStageMetrics
	private pendingSteerMessage?: {
		text: string
		images: string[]
		queuedMessageIds?: string[]
		inputOrigin?: "human" | "agent"
		isAgentMessageWake?: boolean
		onPersisted?: () => Promise<void> | void
	}
	private queuedInputBlockReceipts = new WeakMap<object, readonly string[]>()
	private inputBlockOrigins = new WeakMap<object, "human" | "agent">()
	private queuedToolResultReceipts = new Map<
		string,
		{ ids: readonly string[]; content: Anthropic.Messages.ContentBlockParam[] }
	>()
	private toolInputContext = new AsyncLocalStorage<{ toolCallId: string; turn?: AlphaMessageTurn }>()
	/** Presentation cursor only; canonical lifecycle state continues to own the turn. */
	private openingTurnInputPending = false
	private durableSteerAdmission: Promise<void> = Promise.resolve()
	private readonly pendingWaitAgentResultClaims = new Map<string, string>()
	private readonly stagedWaitAgentNotifications = new Map<string, Anthropic.TextBlockParam[]>()
	private readonly waitAgentClaimEntries = new Map<string, readonly AgentMailboxEntry[]>()
	private readonly durableWaitAgentClaimIds = new Set<string>()
	private readonly pendingWaitAgentNotificationBlocks = new Set<Anthropic.TextBlockParam>()
	/** A final answer fences passive result mail until the next authorized turn. */
	private deferAgentResultNotifications = false
	private persistedToolResultIds = new Set<string>()
	private steerMessageAwaitingPersistence = false
	private isAgentTurnEngineActive = false
	private goalController?: GoalController
	/** Children retain the root goal identity present when they were created. */
	private inheritedGoalBinding?: Promise<GoalAccountingBinding | undefined>
	private goalChildRequiresAdmission = false
	private activeGoalStep?: GoalStepAccounting
	private goalTurnCompletionText?: string
	private goalWakePromise?: Promise<void>
	private goalShutdownPromise?: Promise<void>
	private goalSteeringGeneration = 0
	private goalHostAdmission?: GoalInputAdmission
	private goalAskAdmission?: { text: string; admission: GoalInputAdmission }
	private goalRequestAdmissionRevoked = false
	private externalMutationLease?: { label: string; token: symbol }
	private deferredAskResponse?:
		| {
				kind: "legacy"
				askResponse: AlphaAskResponse
				text?: string
				images?: string[]
				queuedMessageIds?: string[]
		  }
		| { kind: "toolApproval"; requestId: string; decision: ToolApprovalDecision }
	private activeToolApprovalRequest?: ToolApprovalRequest
	private activeToolApprovalDecision?: ToolApprovalDecision
	private subagentReviewBarrier?: { promise: Promise<void>; resolve: () => void }
	private isAwaitingSubagentReview = false
	private isTaskLoopActive = false
	private didComplete = false
	private didEmitTaskCompleted = false
	private pendingTurnSuspension?: { reason: string; kind: "error" | "blocked" }
	private currentAssistantResponseMessageTs: number | undefined
	/** Transcript boundary used only to avoid repeating the current attempt's visible error. */
	private recoveryAttemptMessageStart = 0
	skipPrevResponseIdOnce: boolean = false

	/** Canonical response and captured execution surface for the active step. */
	private currentAgentResponse?: AgentResponse
	private currentAgentStep?: CurrentAgentStep
	private currentTaskToolSurface?: TaskToolSurface
	private readonly toolCatalogCache = new TaskToolCatalogCache()
	private currentRequestSignal?: AbortSignal
	private readonly agentRetryPolicy = new AgentRetryPolicy()
	private readonly searchLoopRecoveryPolicy: SearchLoopRecoveryPolicy
	private lastSearchProgressVersion = 0
	private readonly agentStepContextBuilder = new AgentStepContextBuilder<ApiHandler, unknown>()
	private readonly agentTurnEventLog: AgentTurnEventLog
	private readonly performanceObservabilityEnabled = process.env.ALPHA_TASK_OBSERVABILITY === "1"
	private performanceSubmissionStartedAt?: number
	private performanceRequestPending = false
	private performanceCheckpointStartedAt?: number
	private performanceRequestPhase: "first_provider_request" | "completed_task_followup" = "first_provider_request"
	/** Stable host run identity; a new engine run gets a new identity after terminality. */
	private agentRunId?: string
	private agentTurnId?: string
	private agentTurnStep = 0
	private readonly canonicalLifecycleStartedSteps = new Set<string>()
	private canonicalLifecycleQueue: Promise<void> = Promise.resolve()
	/**
	 * Canonical lifecycle persistence is additive during the migration: the
	 * journal/projector is authoritative whenever the provider accepts an event,
	 * while the legacy loop remains operational when an older host has no
	 * publisher or the journal is temporarily unavailable. Retain the first
	 * failure explicitly so host diagnostics can distinguish degraded lifecycle
	 * projection from a successful durable turn.
	 */
	private canonicalLifecyclePersistenceFailure?: { type: AgentLifecycleEventInput["type"]; error: Error }

	// TaskStatus
	idleAsk?: AlphaMessage
	resumableAsk?: AlphaMessage
	interactiveAsk?: AlphaMessage

	didFinishAbortingStream = false
	abandoned = false
	abortReason?: AlphaApiReqCancelReason
	isInitialized = false
	isPaused: boolean = false

	// API
	apiConfiguration: ProviderSettings
	api: ApiHandler
	/** Profile settings stay untouched; only this derived snapshot enters requests. */
	private effectiveApiConfiguration: ProviderSettings
	public reasoningPreference: TaskReasoningPreference
	private reasoningState: TaskReasoningState
	private readonly reasoningByHandler = new WeakMap<ApiHandler, TaskReasoningState>()
	private readonly retainedReasoningHandlers = new Set<ApiHandler>()
	private readonly reasoningHandlerUsers = new Map<ApiHandler, number>()
	private disposedReasoningHandlers?: WeakSet<ApiHandler>
	private reasoningDisposed = false
	/** One model transition, released after the next captured request finishes. */
	private previousCompactionHandler?: ApiHandler
	private static providerRateLimitLanes = new Map<string, ProviderRateLimitLane>()
	/**
	 * Transcript writes are shared by every live/re-hydrated Task instance for a
	 * task ID. An instance-local queue cannot prevent an old instance from
	 * writing its captured snapshot after a replacement has started.
	 */
	private static apiConversationHistorySaveQueues = new Map<string, Promise<void>>()
	private static apiConversationHistoryPendingCounts = new Map<string, number>()
	private static readonly MAX_PENDING_TRANSCRIPT_SAVES = 8
	private static apiConversationHistoryOwnerGenerations = new Map<string, number>()
	private readonly apiConversationHistoryPersistenceKey: string
	private readonly apiConversationHistoryOwnerGeneration: number
	private requestPacingWaitCount = 0
	private requestPacingWaitMs = 0
	private autoApprovalHandler: AutoApprovalHandler
	private taskApprovalMode?: ApprovalMode
	private readonly toolApprovalReviewer?: ToolApprovalReviewer
	private completionHookConfig?: CompletionHookConfig
	private pendingCompletionHookPrompt?: CompletionHookPromptProvenance
	private completionHookActive = false
	private pendingHookCleanupFailures?: Set<HookCommandCleanupError>
	private lifecycleHookStartSource: "startup" | "resume" = "startup"
	private lifecycleHookStartConsumed = false
	private interruptHookPending = false
	private lifecycleHookStoppedThisTurn = false
	private sessionEndHookConsumed = false
	private submittedLifecycleHookBlocks = new WeakSet<object>()
	private pendingLifecycleHookContexts: Array<{
		provenance: CompletionHookPromptProvenance
		guard: CanonicalLifecycleEventGuard
		staged?: boolean
	}> = []
	private taskApprovalModePersistence: Promise<boolean> = Promise.resolve(true)

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
	private async appendRequestPacingUpdateToLatestUserMessage(): Promise<boolean> {
		const metrics = this.getRequestPacingMetrics()
		let latestUserMessage: ApiMessage | undefined
		for (let index = this.apiConversationHistory.length - 1; index >= 0; index--) {
			if (this.apiConversationHistory[index].role === "user") {
				latestUserMessage = this.apiConversationHistory[index]
				break
			}
		}
		if (!latestUserMessage) return true

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
		return this.saveApiConversationHistory()
	}

	toolRepetitionDetector: ToolRepetitionDetector
	alphaIgnoreController?: AlphaIgnoreController
	alphaProtectedController?: AlphaProtectedController
	fileContextTracker: FileContextTracker
	private readonly environmentContext = new EnvironmentContext()
	terminalProcess?: AlphaTerminalProcess

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	didEditFile: boolean = false

	// LLM Messages & Chat Messages
	apiConversationHistory: ApiMessage[] = []
	alphaMessages: AlphaMessage[] = []
	private uiMessageTimestampHighWater?: number
	private alphaMessagesSaveQueue: Promise<void> = Promise.resolve()
	private alphaMessagesHydrated: boolean

	// Ask
	private askResponse?: AlphaAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	private activeAsk?: {
		type: AlphaAsk
		ts: number
		toolCallId?: string
		queuedMessageIds?: string[]
		signal?: AbortSignal
		published?: boolean
	}
	private askResponseQueuedMessageIds?: string[]
	public lastMessageTs?: number
	private autoApprovalTimeoutRef?: NodeJS.Timeout
	private autoApprovalTimeoutRevision = 0

	// Tool Use
	consecutiveMistakeCount: number = 0
	consecutiveMistakeLimit: number
	consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	consecutiveMistakeCountForEditFile: Map<string, number> = new Map()
	consecutiveNoToolUseCount: number = 0
	consecutiveNoAssistantMessagesCount: number = 0
	private automaticMistakeRecoveryCount: number = 0
	private lastToolFailure?: { toolName: string; error?: string; failure?: ToolFailureMetadata }
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
	private streamingPreviewEpoch = 0
	private streamingPreviewQueue: Promise<void> = Promise.resolve()
	private streamingPreviewRequestVersion = 0
	private streamingPreviewPumpOwner?: symbol
	private backgroundUsageDrainEpoch = 0
	private backgroundUsageDrainAbortController?: AbortController
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
	 * Set to `true` after the assistant message is saved in `runAgentRequests`.
	 */
	assistantMessageSavedToHistory = false

	/**
	 * Return the identity of the currently mutable streaming-preview boundary.
	 * The value is intentionally opaque to callers; it is only used to fence
	 * asynchronous preview work from canonical response state.
	 */
	public getStreamingPreviewEpoch(): number {
		return this.streamingPreviewEpoch
	}

	/**
	 * Preview presenters call this after every await.  A stale presenter may
	 * finish its webview request, but it must not continue into the next turn.
	 */
	public isStreamingPreviewEpochCurrent(epoch: number): boolean {
		return epoch === this.streamingPreviewEpoch && !this.abort && !this.abandoned
	}

	private invalidateStreamingPreviewEpoch(): void {
		this.streamingPreviewEpoch += 1
	}

	/**
	 * Usage collection may outlive the visible provider turn. Give that work a
	 * separate epoch so a superseding request, rewind, or task cancellation can
	 * stop it without consulting whichever request controller is current later.
	 */
	private invalidateBackgroundUsageDrain(reason = "Background usage collection was superseded"): void {
		this.backgroundUsageDrainEpoch += 1
		const controller = this.backgroundUsageDrainAbortController
		this.backgroundUsageDrainAbortController = undefined
		if (controller && !controller.signal.aborted) controller.abort(new Error(reason))
	}

	private beginBackgroundUsageDrain(
		requestController: AbortController | undefined,
		messageIndex: number,
		message: AlphaMessage,
	): BackgroundUsageDrainOwner {
		this.invalidateBackgroundUsageDrain()
		const controller = new AbortController()
		this.backgroundUsageDrainAbortController = controller
		return {
			epoch: this.backgroundUsageDrainEpoch,
			controller,
			requestController,
			messageIndex,
			message,
		}
	}

	private isBackgroundUsageDrainCurrent(owner: BackgroundUsageDrainOwner): boolean {
		return (
			owner.epoch === this.backgroundUsageDrainEpoch &&
			this.backgroundUsageDrainAbortController === owner.controller &&
			!owner.controller.signal.aborted &&
			!this.abort &&
			!this.abandoned &&
			this.alphaMessages[owner.messageIndex] === owner.message
		)
	}

	private finishBackgroundUsageDrain(owner: BackgroundUsageDrainOwner): void {
		if (this.backgroundUsageDrainAbortController === owner.controller) {
			this.backgroundUsageDrainAbortController = undefined
		}
	}

	/**
	 * Coalesce best-effort streaming text previews behind one tracked pump.
	 *
	 * Providers can emit many small text deltas while one webview update is still
	 * in flight. Chaining one presentation promise per delta turns that burst into
	 * a serialized backlog at the tool boundary. The version counter retains only
	 * one trailing presentation of the latest accumulated text.
	 */
	private scheduleStreamingPreview(): void {
		const epoch = this.streamingPreviewEpoch
		this.streamingPreviewRequestVersion += 1
		if (this.streamingPreviewPumpOwner) return

		const owner = Symbol("streamingPreviewPump")
		this.streamingPreviewPumpOwner = owner
		let presentedVersion = 0
		const queuedPreview = (async () => {
			while (
				this.streamingPreviewPumpOwner === owner &&
				this.isStreamingPreviewEpochCurrent(epoch) &&
				presentedVersion !== this.streamingPreviewRequestVersion
			) {
				presentedVersion = this.streamingPreviewRequestVersion
				if (!this.isStreamingPreviewEpochCurrent(epoch)) return
				try {
					await presentAssistantMessage(this, { previewEpoch: epoch })
				} catch (error) {
					// Preview output is non-authoritative.  A provider turn must still be
					// able to complete when a webview update rejects or is superseded.
					if (this.isStreamingPreviewEpochCurrent(epoch)) {
						console.error(`[Task#${this.taskId}] Failed to present streaming text preview:`, error)
					}
				}
			}
		})().finally(() => {
			if (this.streamingPreviewPumpOwner !== owner) return
			this.streamingPreviewPumpOwner = undefined
			// A delta can arrive after the pump has decided it is caught up but
			// before this finalizer releases ownership. Re-arm the pump so that
			// narrow microtask window cannot drop the latest preview.
			if (
				this.isStreamingPreviewEpochCurrent(epoch) &&
				presentedVersion !== this.streamingPreviewRequestVersion
			) {
				this.scheduleStreamingPreview()
			}
		})
		this.streamingPreviewQueue = queuedPreview
	}

	/**
	 * Join all previews currently queued before a turn boundary mutates shared
	 * streaming state. Preview work is non-authoritative, so every boundary uses a
	 * short deadline. After that deadline the epoch fence makes any late completion
	 * harmless and the queue is detached so a provider turn cannot be permanently
	 * chained behind a hung webview operation.
	 */
	private async drainStreamingPreviews(reason: string, guard?: CanonicalLifecycleEventGuard): Promise<void> {
		if (guard && !guard()) return
		const cancellationSignal = this.getTaskLifetimeCancellationSignal()
		let cancelDeadline: () => void = () => {}
		const deadline = new Promise<"timed-out" | "cancelled">((resolve) => {
			let settled = false
			const timer = setTimeout(() => finish("timed-out"), STREAMING_PREVIEW_DRAIN_TIMEOUT_MS)
			const onAbort = () => finish("cancelled")
			const cleanup = () => {
				clearTimeout(timer)
				cancellationSignal.removeEventListener("abort", onAbort)
			}
			const finish = (result: "timed-out" | "cancelled") => {
				if (settled) return
				settled = true
				cleanup()
				resolve(result)
			}
			cancelDeadline = () => finish("cancelled")
			cancellationSignal.addEventListener("abort", onAbort, { once: true })
			if (cancellationSignal.aborted) onAbort()
		})

		try {
			while (true) {
				if (guard && !guard()) return
				const queue = this.streamingPreviewQueue
				const result = await Promise.race([queue.then(() => "drained" as const), deadline])
				if (guard && !guard()) return

				if (result !== "drained") {
					this.invalidateStreamingPreviewEpoch()
					this.streamingPreviewPumpOwner = undefined
					// Release the presentation lock before dropping the abandoned chain.
					// The presenter records ownership by epoch, so its late finally block
					// cannot clear a lock acquired by a resumed/new preview.
					this.presentAssistantMessageLocked = false
					this.presentAssistantMessageHasPendingUpdates = false
					delete (this as Task & { presentAssistantMessageLockOwner?: unknown })
						.presentAssistantMessageLockOwner
					// The old promise remains internally observed by its own rejection
					// handler, and its epoch fence prevents late state mutation once it
					// settles.
					this.streamingPreviewQueue = Promise.resolve()
					console.warn(`[Task#${this.taskId}] Streaming preview drain ${result} during ${reason}`)
					return
				}
				if (queue === this.streamingPreviewQueue) return
			}
		} finally {
			cancelDeadline()
		}
	}

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
		const claimId = this.pendingWaitAgentResultClaims.get(normalizedToolUseId)
		const notifications = claimId ? this.stagedWaitAgentNotifications.get(claimId) : undefined
		const receiptText =
			typeof toolResult.content === "string"
				? [toolResult.content]
				: (toolResult.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))
		const hasWaitReceipt =
			claimId &&
			receiptText.some((text) => {
				try {
					const receipt = JSON.parse(text) as { source?: unknown; claimId?: unknown }
					return receipt.source === "managed_agent_mailbox" && receipt.claimId === claimId
				} catch {
					return false
				}
			})
		if (notifications && hasWaitReceipt && !toolResult.is_error) {
			this.userMessageContent.push(...notifications)
			for (const notification of notifications) this.pendingWaitAgentNotificationBlocks.add(notification)
			this.captureInputBlockOrigins(notifications, "agent")
			this.stagedWaitAgentNotifications.delete(claimId!)
		} else if (claimId) {
			// A cancellation/error receipt did not deliver the claim; retry it from the mailbox.
			this.forgetWaitAgentResultClaim(claimId)
		}
		return true
	}

	/** Stage child input beside its wait receipt; the transcript save is the delivery fence. */
	public stageWaitAgentNotifications(claimId: string, entries: readonly AgentMailboxEntry[]): void {
		if (!claimId || entries.length === 0) throw new Error("Agent notifications require a nonempty mailbox claim")
		if (this.stagedWaitAgentNotifications.has(claimId)) return
		const ordered = [...entries].sort((left, right) => left.sequence - right.sequence)
		this.waitAgentClaimEntries.set(claimId, structuredClone(ordered))
		const deliveredEventIds = getPersistedAgentNotificationIds(this.apiConversationHistory, ordered, (text) =>
			redactTaskPrivatePaths(this, text),
		)
		this.stagedWaitAgentNotifications.set(
			claimId,
			ordered
				.filter((entry) => !deliveredEventIds.has(entry.eventId))
				.map((entry) => ({
					type: "text",
					text: redactTaskPrivatePaths(this, serializeAgentNotification(entry)),
				})),
		)
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

	public hasRetainedWaitAgentResultClaim(claimId: string): boolean {
		return [...this.pendingWaitAgentResultClaims.values()].includes(claimId)
	}

	public hasDurablyPersistedWaitAgentClaim(claimId: string): boolean {
		return this.durableWaitAgentClaimIds.has(claimId)
	}

	public forgetWaitAgentResultClaim(claimId: string): void {
		this.stagedWaitAgentNotifications.delete(claimId)
		this.waitAgentClaimEntries.delete(claimId)
		this.durableWaitAgentClaimIds.delete(claimId)
		for (const [toolCallId, retainedClaimId] of this.pendingWaitAgentResultClaims) {
			if (retainedClaimId === claimId) this.pendingWaitAgentResultClaims.delete(toolCallId)
		}
	}

	private waitAgentClaimsPersistedBy(message: Anthropic.MessageParam): string[] {
		if (message.role !== "user" || !Array.isArray(message.content)) return []
		const persistedClaimIds = new Set<string>()
		for (const block of message.content) {
			if (block.type !== "tool_result" || block.is_error) continue
			const retainedClaimId = this.pendingWaitAgentResultClaims.get(sanitizeToolUseId(block.tool_use_id))
			if (!retainedClaimId) continue
			const expectedEntries = this.waitAgentClaimEntries.get(retainedClaimId)
			const persistedEventIds = getPersistedAgentNotificationIds(
				this.apiConversationHistory,
				expectedEntries,
				(text) => redactTaskPrivatePaths(this, text),
			)
			const textParts =
				typeof block.content === "string"
					? [block.content]
					: (block.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))
			for (const text of textParts) {
				try {
					const receipt = JSON.parse(text) as { source?: unknown; claimId?: unknown }
					if (
						receipt.source === "managed_agent_mailbox" &&
						receipt.claimId === retainedClaimId &&
						expectedEntries?.length &&
						expectedEntries.every((entry) => persistedEventIds.has(entry.eventId))
					) {
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

	private async settlePersistedWaitAgentResultClaims(
		message: Anthropic.MessageParam,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<void> {
		if (guard && !guard()) return
		const claimIds = this.waitAgentClaimsPersistedBy(message)
		if (claimIds.length === 0) return
		const provider = this.providerRef.deref()
		if (!provider?.acknowledgeWaitAgentResults) return

		for (const claimId of claimIds) {
			if (guard && !guard()) return
			this.durableWaitAgentClaimIds.add(claimId)
			try {
				await provider.acknowledgeWaitAgentResults(this, claimId)
				if (guard && !guard()) return
				this.forgetWaitAgentResultClaim(claimId)
			} catch (error) {
				if (guard && !guard()) return
				// AgentControlStore retains a failed settlement for same-host retry,
				// while the durable API-history receipt supports full reload recovery.
				console.error(`[Task#${this.taskId}] Failed to acknowledge persisted wait_agent result:`, error)
			}
		}
	}

	private async settleAllPersistedWaitAgentResultClaims(guard?: CanonicalLifecycleEventGuard): Promise<void> {
		if (guard && !guard()) return
		const messages = guard ? [...this.apiConversationHistory] : this.apiConversationHistory
		for (const message of messages) {
			if (guard && !guard()) return
			if (guard) await this.settlePersistedWaitAgentResultClaims(message, guard)
			else await this.settlePersistedWaitAgentResultClaims(message)
			if (guard && !guard()) return
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
					id: event.id,
					name: event.name as ToolName,
					params: {},
					partial: true,
				}

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
					// Mark the preview complete. The canonical accumulator and scheduler
					// independently validate tool calls before any execution.
					const existingToolUse = this.assistantMessageContent[toolUseIndex]
					if (existingToolUse && existingToolUse.type === "tool_use") {
						existingToolUse.partial = false
					}

					// Clean up tracking
					this.streamingToolCallIndices.delete(event.id)

					// Mark that we have new content to process
					this.userMessageContentReady = false
				}
			}
		}
		this.scheduleStreamingPreview()
	}

	didRejectTool = false
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
	private conversationRewindRecord?: TaskRewindRecord
	private conversationRewindQueue?: Promise<unknown>

	constructor({
		provider,
		apiConfiguration,
		reasoningPreference,
		enableCheckpoints = true,
		checkpointTimeout = DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
		taskId,
		presentationModelCalls,
		diagnosticSession,
		diagnosticIncidentId,
		diagnosticSourceTaskId,
		task,
		images,
		historyItem,
		experiments: experimentsConfig,
		startTask = true,
		requireExplicitResume = false,
		rootTask,
		parentTask,
		goalAccountingBinding,
		taskNumber = -1,
		onCreated,
		initialTodos,
		workspacePath,
		taskMode,
		taskApiConfigName,
		orchestrationParentTaskId,
		orchestrationNotifyCompletion,
		orchestrationWorkspaceMode,
		orchestrationWorkspaceRelativePath,
		orchestrationWorkspaceBaselineCommit,
		initialStatus,
		subagentInitialContext,
		subagentFrozenInstructions,
		subagentHistoryFork,
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
		performanceSubmissionStartedAt,
		taskApprovalMode,
		toolApprovalReviewer,
	}: TaskOptions) {
		super()
		if (!historyItem && taskMode !== undefined) assertPrimaryMode(taskMode)

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
		this.presentationModelCalls =
			historyItem?.presentationModelCalls === false ||
			presentationModelCalls === false ||
			rootTask?.presentationModelCalls === false ||
			parentTask?.presentationModelCalls === false
				? false
				: undefined
		this.lifecycleHookStartSource = historyItem ? "resume" : "startup"
		this.diagnosticSession = (historyItem?.diagnosticSession ?? diagnosticSession) === true
		const incidentId = historyItem?.diagnosticIncidentId ?? diagnosticIncidentId
		const sourceTaskId = historyItem?.diagnosticSourceTaskId ?? diagnosticSourceTaskId
		this.diagnosticIncidentId =
			incidentId === undefined ? undefined : diagnosticTaskIdentitySchema.parse(incidentId)
		this.diagnosticSourceTaskId =
			sourceTaskId === undefined ? undefined : diagnosticTaskIdentitySchema.parse(sourceTaskId)
		if (
			this.diagnosticSession &&
			(!this.diagnosticIncidentId || !this.diagnosticSourceTaskId || this.diagnosticSourceTaskId === this.taskId)
		) {
			throw new Error("Diagnostic sessions require a bounded incident ID and source task ID.")
		}
		this.alphaMessagesHydrated = historyItem === undefined
		this.orchestrationParentTaskId = historyItem?.orchestrationParentTaskId ?? orchestrationParentTaskId
		this.orchestrationNotifyCompletion =
			historyItem?.orchestrationNotifyCompletion ?? orchestrationNotifyCompletion ?? true
		this.orchestrationWorkspaceMode = historyItem?.orchestrationWorkspaceMode ?? orchestrationWorkspaceMode
		this.orchestrationWorkspaceRelativePath =
			historyItem?.orchestrationWorkspaceRelativePath ?? orchestrationWorkspaceRelativePath
		this.orchestrationWorkspaceBaselineCommit =
			historyItem?.orchestrationWorkspaceBaselineCommit ?? orchestrationWorkspaceBaselineCommit
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
		if (this.diagnosticSession && this.taskKind !== "primary") {
			throw new Error("Diagnostic sessions must use the primary task runtime.")
		}
		this.subagentGroupId = historyItem?.subagentGroupId ?? subagentGroupId
		this.subagentNickname = historyItem?.subagentNickname ?? subagentNickname
		this.subagentRole = historyItem?.subagentRole ?? subagentRole
		this.subagentModelRoute = structuredClone(historyItem?.subagentModelRoute ?? subagentModelRoute)
		this.subagentContextManifest = structuredClone(contextManifest)
		const restoredWork = taskWorkContextSchema.safeParse(historyItem?.workContext)
		if (restoredWork.success) this.workContext = restoreWorkContext(restoredWork.data)
		const restoredDesign = taskDesignHandoffSchema.safeParse(historyItem?.designHandoff)
		if (this.taskKind === "primary" && restoredDesign.success && restoredDesign.data.sourceTaskId === this.taskId) {
			this.designHandoff = structuredClone(restoredDesign.data)
		}
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
		this.subagentInitialContext = subagentInitialContext
		if (subagentFrozenInstructions !== undefined) {
			if (!contextManifest) throw new Error("Managed child frozen instructions require a context manifest")
			assertFrozenSubagentInstructions(subagentFrozenInstructions, contextManifest.instructions.digest)
			this.subagentFrozenInstructions = subagentFrozenInstructions
		}
		if (subagentHistoryFork !== undefined) {
			if (this.taskKind !== "subagent" || historyItem || !contextManifest) {
				throw new Error("A managed history fork requires a fresh child and a captured context manifest")
			}
			assertSubagentHistoryFork(subagentHistoryFork, contextManifest)
			this.subagentHistoryFork = structuredClone(subagentHistoryFork)
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

		this.alphaIgnoreController = new AlphaIgnoreController(this.cwd)
		this.alphaProtectedController = new AlphaProtectedController(this.cwd)
		this.fileContextTracker = new FileContextTracker(provider, this.taskId, this.cwd)

		this.alphaIgnoreController.initialize().catch((error) => {
			console.error("Failed to initialize AlphaIgnoreController:", error)
		})

		this.apiConfiguration = apiConfiguration
		this.reasoningPreference = taskReasoningPreferenceSchema.parse(
			historyItem
				? (historyItem.reasoningPreference ?? { kind: "default" })
				: (reasoningPreference ?? parentTask?.reasoningPreference ?? { kind: "default" }),
		)
		const initialReasoning = this.prepareReasoningConfiguration(apiConfiguration, this.reasoningPreference)
		this.api = initialReasoning.api
		this.effectiveApiConfiguration = initialReasoning.configuration
		this.reasoningState = initialReasoning.state
		this.autoApprovalHandler = new AutoApprovalHandler()

		this.consecutiveMistakeLimit = consecutiveMistakeLimit ?? DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
		this.providerRef = new WeakRef(provider)
		this.taskMemoryContext = new TaskMemoryContext({
			settings: provider.getMemorySettings?.(),
			saved: historyItem?.memory,
			taskKind: this.taskKind,
			diagnosticSession: this.diagnosticSession,
			rootPath: provider.getMemoryStore?.().rootPath ?? "",
			readSummary: async () => this.providerRef.deref()?.getMemoryStore?.().readSummary(),
			onReadError: () => console.warn(`[Task#${this.taskId}] Alpha memory summary is unavailable`),
		})
		this.globalStoragePath = provider.context.globalStorageUri.fsPath
		this.agentMessageInbox = new AgentMessageInbox(this.taskId, this.globalStoragePath)
		this.apiConversationHistoryPersistenceKey = `${path.resolve(this.globalStoragePath)}\u0000${this.taskId}`
		this.apiConversationHistoryOwnerGeneration =
			(Task.apiConversationHistoryOwnerGenerations.get(this.apiConversationHistoryPersistenceKey) ?? 0) + 1
		Task.apiConversationHistoryOwnerGenerations.set(
			this.apiConversationHistoryPersistenceKey,
			this.apiConversationHistoryOwnerGeneration,
		)
		this.providerTranscriptStore = new ProviderTranscriptStore(this.taskId, this.globalStoragePath)
		this.agentTurnEventLog = new AgentTurnEventLog(this.taskId, this.globalStoragePath)
		this.performanceSubmissionStartedAt = performanceSubmissionStartedAt
		this.performanceRequestPending = performanceSubmissionStartedAt !== undefined
		this.diffViewProvider = new DiffViewProvider(this.cwd, this)
		this.enableCheckpoints = enableCheckpoints
		this.checkpointTimeout = checkpointTimeout

		this.rootTask = rootTask
		this.parentTask = parentTask
		this.goalController = new GoalController({
			taskId: this.taskId,
			store: new TaskGoalStore(this.globalStoragePath, this.taskId),
		})
		if (rootTask || parentTask || this.parentTaskId) {
			const ownerTask = rootTask ?? parentTask
			this.goalChildRequiresAdmission = ownerTask === undefined
			this.inheritedGoalBinding = this.loadInheritedGoalBinding(
				ownerTask,
				goalAccountingBinding ?? ownerTask?.captureGoalAccountingBinding() ?? Promise.resolve(undefined),
				historyItem !== undefined,
				goalAccountingBinding !== undefined,
			)
			void this.inheritedGoalBinding.catch(() => undefined)
		}
		this.taskNumber = taskNumber
		this.initialStatus = initialStatus
		this.taskApprovalMode = historyItem?.approvalMode ?? taskApprovalMode
		this.toolApprovalReviewer = toolApprovalReviewer

		// Store the task's mode and API config name when it's created.
		// For history items, use the stored values; for new tasks, we'll set them
		// after getting state.
		if (historyItem) {
			this._taskMode = restoreTaskMode(historyItem.mode)
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

		this.messageQueueService = new MessageQueueService(
			new TaskMessageQueuePersistence(this.taskId, this.globalStoragePath),
		)

		let queuedMessageCount = 0
		this.messageQueueStateChangedHandler = () => {
			const currentMessageCount = this.messageQueueService.messages.length
			if (currentMessageCount > queuedMessageCount) {
				this.invalidateGoalContinuation()
				// A new user-authored instruction breaks a sequence of model mistakes.
				// Do not let a stale error pre-empt the queued guidance with the
				// mistake-limit dialog before the model can act on it.
				this.resetMistakeRecoveryState()
				this.postTurnCompactionAbortController?.abort(new SteerRequestInterruptError())
			}
			queuedMessageCount = currentMessageCount
			this.emit(AlphaCodeEventName.TaskUserMessage, this.taskId)
			this.emit(AlphaCodeEventName.QueuedMessagesUpdated, this.taskId, this.queuedMessages)
			void this.providerRef
				.deref()
				?.postTaskQueueToWebview(this.taskId, this.queuedMessages)
				.catch(() => undefined)
			void this.wakeQueuedInputWhenIdle().catch(() => {
				console.warn(`[Task#${this.taskId}] Accepted input remains queued after follow-up admission failed`)
			})
		}

		this.messageQueueService.on("stateChanged", this.messageQueueStateChangedHandler)

		// Set up diff strategy
		this.diffStrategy = new MultiSearchReplaceDiffStrategy()

		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit)
		this.searchLoopRecoveryPolicy = new SearchLoopRecoveryPolicy()

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
			(tokenUsage: TokenUsage, toolUsage: ToolUsage) => this.publishTokenUsageUpdate(tokenUsage, toolUsage),
			this.TOKEN_USAGE_EMIT_INTERVAL_MS,
			{ leading: true, trailing: true, maxWait: this.TOKEN_USAGE_EMIT_INTERVAL_MS },
		)

		onCreated?.(this)

		if (startTask) {
			this._started = true
			if (task || images) {
				this.ownBackgroundLifecycle("start", this.startTask(task, images))
			} else if (historyItem) {
				this.initialHistoryResumePending = true
				const lifecycle = this.resumeTaskFromHistory(undefined, undefined, undefined, {
					requireExplicitResume,
				}).finally(() => {
					this.initialHistoryResumePending = false
				})
				this.ownBackgroundLifecycle("resume", lifecycle)
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	private ownBackgroundLifecycle(operation: "start" | "resume", lifecycle: Promise<void>): Promise<void> {
		this.ownedLifecyclePromise = lifecycle
		const releaseOwner = () => {
			if (this.ownedLifecyclePromise !== lifecycle) return
			this.ownedLifecyclePromise = undefined
			void this.wakeQueuedInputWhenIdle().catch(() => {
				console.warn(`[Task#${this.taskId}] Accepted input remains queued after lifecycle settlement`)
			})
		}
		void lifecycle.then(releaseOwner, (error) => {
			// A settled failure is diagnostic state, not a live owner that may fence
			// every later admission. Joiners already holding this promise still fail.
			console.error(`[Task#${this.taskId}] Background ${operation} failed:`, error)
			releaseOwner()
		})
		return lifecycle
	}

	/**
	 * Join the Task-owned start/resume loop and, after cancellation, its durable
	 * transcript and canonical lifecycle finalization. This boundary is external
	 * by design: performAbortTask may be awaited by the loop it is cancelling, so
	 * joining the loop from inside abort would deadlock.
	 */
	public async waitForTermination(guard?: CanonicalLifecycleEventGuard): Promise<void> {
		if (guard) {
			if (!guard()) return
			const termination = this.taskTerminationPromise
			const lifecycle = this.ownedLifecyclePromise
			const goalShutdown = this.goalShutdownPromise
			if (termination) {
				// Native cancellation already joins the originating producer/goal.
				await termination
				return
			}
			// Join only entry-time work, including after owner loss. A replacement
			// lifecycle or goal must neither hold this waiter nor replace its error.
			const settlements = await Promise.allSettled([lifecycle, goalShutdown])
			let firstFailure: unknown
			let failureObserved = false
			for (const settlement of settlements) {
				if (settlement.status === "rejected" && !failureObserved) {
					failureObserved = true
					firstFailure = settlement.reason
				}
			}
			if (failureObserved) throw firstFailure
			return
		}
		const termination = this.taskTerminationPromise
		if (termination) {
			// Cancellation finalization already owns its captured goal/lifecycle
			// joins. A later live goal belongs to a replacement transition.
			await termination
			return
		}
		try {
			await this.waitForOwnedLifecycle()
		} finally {
			await this.goalShutdownPromise
		}
	}

	private async waitForOwnedLifecycle(): Promise<void> {
		for (;;) {
			const lifecycle = this.ownedLifecyclePromise
			if (!lifecycle) return
			await lifecycle
			if (lifecycle === this.ownedLifecyclePromise) return
		}
	}

	/** A passive queue admission still needs a consumer when the preceding loop has returned. */
	private wakeQueuedInputWhenIdle(): Promise<void> {
		if (this.queuedInputWakePromise) return this.queuedInputWakePromise
		const canWake = () =>
			this.taskKind === "primary" &&
			this.isInitialized &&
			this._started &&
			!this.abort &&
			!this.abandoned &&
			!this.resumeRequiresExplicitInput &&
			!this.initialHistoryResumePending &&
			!this.ownedLifecyclePromise &&
			!this.activeAsk &&
			!this.isTaskLoopActive &&
			!this.isStreaming &&
			!this.isAgentTurnEngineActive &&
			!this.steerMessageAwaitingPersistence &&
			(this.messageQueueService.messages.length > 0 ||
				(this.independentAgentMessagesMayResume && this.didComplete && this.agentMessageInbox.hasPending()))
		if (!canWake()) return Promise.resolve()
		// Install the owner before selecting input: queue selection publishes synchronously.
		const wake = Promise.resolve().then(async () => {
			if (!canWake()) return
			const message = this.messageQueueService.messages[0]
			if (!message) {
				await this.resumeIndependentAgentMessages()
				return
			}
			if (this.didComplete) {
				await this.resumeCompletedTaskFollowup(message.text, message.images, "human", [message.id])
				return
			}
			this.steerMessageAwaitingPersistence = true
			let persisted = false
			try {
				await this.prepareForRetainedLifecycle()
				if (this.abort || this.abandoned) throw new Error("Queued follow-up was cancelled")
				if (!this.messageQueueService.claimMessage(message.id)) return
				await this.messageQueueService.flush()
				let resolvePersisted!: () => void
				let rejectPersisted!: (error: unknown) => void
				const admission = new Promise<void>((resolve, reject) => {
					resolvePersisted = resolve
					rejectPersisted = reject
				})
				const lifecycle = this.resumeTaskFromHistory(
					message.text,
					() => {
						persisted = true
						this.steerMessageAwaitingPersistence = false
						if (!this.abort && !this.abandoned) this.emit(AlphaCodeEventName.TaskActive, this.taskId)
						resolvePersisted()
					},
					message.images,
					{
						deferTaskStartedUntilInitialUserContentPersisted: true,
						reuseRetainedHistory: true,
						inputOrigin: "human",
						queuedMessageIds: [message.id],
					},
				)
				this.ownBackgroundLifecycle("resume", lifecycle)
				void lifecycle.then(() => {
					if (!persisted) rejectPersisted(new Error("Queued follow-up was not persisted"))
				}, rejectPersisted)
				await admission
			} finally {
				this.steerMessageAwaitingPersistence = false
				if (!persisted) {
					this.messageQueueService.releaseMessage(message.id)
					await this.messageQueueService.flush()
				}
			}
		})
		this.queuedInputWakePromise = wake
		void wake.then(
			() => {
				if (this.queuedInputWakePromise === wake) this.queuedInputWakePromise = undefined
			},
			() => {
				if (this.queuedInputWakePromise === wake) this.queuedInputWakePromise = undefined
			},
		)
		return wake
	}

	private async prepareForRetainedLifecycle(retainedInputIds: readonly string[] = []): Promise<void> {
		if (this.taskTerminationPromise) await this.taskTerminationPromise
		this.messageQueueService?.activate?.()
		await this.releaseUnpersistedQueuedInputs(retainedInputIds)
		if (
			this.messageQueueStateChangedHandler &&
			!this.messageQueueService.listeners("stateChanged").includes(this.messageQueueStateChangedHandler)
		) {
			this.messageQueueService.on("stateChanged", this.messageQueueStateChangedHandler)
		}
		this.abortTaskPromise = undefined
		this.taskTerminationPromise = undefined
		this.taskCancellationReceipt = undefined
		this.retryTaskCancellationFinalization = undefined
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
	 * @param provider - The AlphaProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskMode(provider: AlphaProvider): Promise<void> {
		try {
			const state = await provider.getState()
			this._taskMode = restoreTaskMode(state?.mode)
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
	 * @param provider - The AlphaProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskApiConfigName(provider: AlphaProvider): Promise<void> {
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
		assertPrimaryMode(mode)
		this._taskMode = mode
		this.taskModeReady = Promise.resolve()
	}

	/** Current task policy, captured at task creation or explicitly changed for later steps. */
	public getTaskApprovalMode(): ApprovalMode {
		return this.taskApprovalMode ?? "auto"
	}

	/** Authority of the invoking step, including when the task dial changes while a tool is pending. */
	public getStepApprovalMode(): ApprovalMode {
		return this.getApprovalModeForAsk()
	}

	private getApprovalModeForAsk(): ApprovalMode {
		return this.currentAgentStep?.snapshot.context.policy.approval.mode ?? this.getTaskApprovalMode()
	}

	/** A fresh private copy of the invoking request boundary, never redacted diagnostic state. */
	public getSubagentInvocationContext(): SubagentInvocationContext | undefined {
		return this.currentAgentStep?.getSubagentInvocationContext?.()
	}

	/** Persisted thread opt-ins; callers cannot mutate the captured read preference. */
	public get memory(): TaskMemoryState {
		return this.taskMemoryContext?.snapshot ?? { version: "v2", useMemories: false, generateMemories: false }
	}

	public getMemoryContext(): Promise<string | undefined> {
		return this.taskMemoryContext?.getContext() ?? Promise.resolve(undefined)
	}

	public setMemoryGenerationEnabled(enabled: boolean): Promise<void> {
		const save = this.memoryPreferenceSaveQueue.then(async () => {
			const changed = this.taskMemoryContext?.setGenerationEnabled(enabled)
			if (!changed && !this.memoryGenerationPreferenceDirty) return
			this.memoryGenerationPreferenceDirty = true
			try {
				await this.requireAlphaMessagesSaved("memory generation preference")
				this.memoryGenerationPreferenceDirty = false
			} catch (error) {
				// A failed opt-in must never make an unpersisted transcript eligible.
				// A failed opt-out remains disabled in this running task.
				if (enabled) this.taskMemoryContext.setGenerationEnabled(false)
				throw error
			}
		})
		this.memoryPreferenceSaveQueue = save.catch(() => undefined)
		return save
	}

	/** Sticky source provenance used by the optional external-context exclusion. */
	public markMemoryExternalContext(): Promise<void> {
		const save = this.memoryPreferenceSaveQueue.then(async () => {
			const changed = this.taskMemoryContext?.markExternalContext()
			if (!changed && !this.memoryExternalContextDirty) return
			// An external effect cannot proceed on a later attempt until its sticky
			// exclusion flag is durable, even if an earlier save failed.
			this.memoryExternalContextDirty = true
			await this.requireAlphaMessagesSaved("memory source provenance")
			this.memoryExternalContextDirty = false
		})
		this.memoryPreferenceSaveQueue = save.catch(() => undefined)
		return save
	}

	private approvalStateForAsk(state: TaskRequestState | undefined, approvalMode: ApprovalMode) {
		return state ? { ...state, approvalMode } : undefined
	}

	/** Copy command authority before asynchronous request preparation can observe changed settings. */
	private captureToolExecutionPolicy(state?: TaskRequestState): NonNullable<ToolPolicyInput["execution"]> {
		const configuration = vscode.workspace.getConfiguration(Package.name)
		const timeoutSeconds = configuration.get<unknown>("commandExecutionTimeout", 0)
		const timeoutAllowlist = configuration.get<unknown>("commandTimeoutAllowlist", [])
		// Keep malformed external settings out of timers and policy digests. The
		// upper bound matches the extension's contributed configuration contract.
		const userTimeoutMs =
			typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0
				? Math.floor(Math.min(timeoutSeconds, 600) * 1_000)
				: 0
		return Object.freeze({
			workspaceRoots: Object.freeze([this.cwd]),
			...(this.taskKind === "primary" ? { outsideWorkspace: "approval" as const } : {}),
			command: Object.freeze({
				allowedPrefixes: Object.freeze([...(state?.allowedCommands ?? [])]),
				deniedPrefixes: Object.freeze([...(state?.deniedCommands ?? [])]),
				userTimeoutMs,
				timeoutAllowlist: Object.freeze(
					Array.isArray(timeoutAllowlist)
						? timeoutAllowlist.filter((rule): rule is string => typeof rule === "string")
						: [],
				),
			}),
		})
	}

	/**
	 * Update only this task's policy for subsequently admitted steps. Existing
	 * StepContext and unresolved asks retain the policy under which they were admitted.
	 */
	public setTaskApprovalMode(mode: ApprovalMode): boolean {
		if (!isApprovalMode(mode) || this.abort || this.abandoned || this.didComplete) return false
		this.taskApprovalMode = mode
		this.taskApprovalModePersistence = this.taskApprovalModePersistence.then(async () => {
			const saved = await this.saveAlphaMessages()
			if (!saved) this.providerRef.deref()?.log(`Failed to persist approval mode for task ${this.taskId}`)
			return saved
		})
		return true
	}

	private captureTaskApprovalMode(state?: TaskRequestState): ApprovalMode {
		this.taskApprovalMode ??= migrateApprovalMode(state)
		return this.taskApprovalMode
	}

	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false })
		const { images, task, historyItem } = options
		let promise: Promise<void>
		let operation: "start" | "resume"

		if (images || task) {
			promise = instance.startTask(task, images)
			operation = "start"
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory()
			operation = "resume"
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		instance.ownBackgroundLifecycle(operation, promise)
		return [instance, promise]
	}

	// API Messages

	private async getSavedApiConversationHistory({ hydrateOnly = false } = {}): Promise<ApiMessage[]> {
		let messages: ApiMessage[]
		try {
			messages = await readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
		} catch (error) {
			this.recordProviderTranscriptSidecarFailure(error)
			throw error
		}
		// The compatibility reader returns [] for a missing file or empty history.
		// A v2 receipt distinguishes those states and supplies authoritative bytes.
		if (messages.length === 0) {
			try {
				const verified = await this.providerTranscriptStore.read()
				if (verified.version === 2) messages = verified.messages
			} catch (error) {
				this.recordProviderTranscriptSidecarFailure(error)
				throw error
			}
			return messages
		}
		// Reopen must finish loading both histories before any instance-owned write.
		// The next normal save reconciles the sidecar under its existing queue.
		if (hydrateOnly) return messages

		// The legacy file is still authoritative for reads. Reconcile the new
		// provider-facing sidecar only after the read succeeds, and do it behind
		// the same queue used by writes. If this best-effort backfill fails, the
		// task can still resume from the legacy transcript; the next save retries
		// the sidecar and reports false until both durability boundaries succeed.
		let legacyReadFailed = false
		try {
			await this.enqueueApiConversationHistoryPersistence(async () => {
				// Re-read at queue execution time. A save may have been submitted while
				// the first legacy read was in flight; never let that older snapshot
				// overwrite the sidecar after the newer legacy write.
				const latestMessages = await readApiMessages({
					taskId: this.taskId,
					globalStoragePath: this.globalStoragePath,
				}).catch((error) => {
					legacyReadFailed = true
					throw error
				})
				messages = latestMessages
				if (latestMessages.length === 0) {
					const verified = await this.providerTranscriptStore.read()
					if (verified.version === 2) messages = verified.messages
					return
				}
				await this.reconcileProviderTranscriptSidecar(latestMessages)
			})
		} catch (error) {
			this.recordProviderTranscriptSidecarFailure(error)
			// The second legacy read may have discovered corruption after the
			// initial nonempty read. Do not continue with its tolerant [] fallback.
			if (legacyReadFailed || messages.length === 0) throw error
		}

		return messages
	}

	private async addToApiConversationHistory(
		message: Anthropic.MessageParam,
		reasoning?: string,
		onPersisted?: () => void,
		canonicalAnthropicThinkingProjected = false,
		hookPrompt?: CompletionHookPromptProvenance,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<boolean> {
		if (guard && !guard()) return false
		// Capture the encrypted_content / thought signatures from the provider (e.g., OpenAI Responses API, Google GenAI) if present.
		// We only persist data reported by the current response body.
		const responseStep = message.role === "assistant" ? this.currentAgentStep : undefined
		const handler = (responseStep?.snapshot.runtime.getHandler() ?? this.api) as ApiHandler & {
			getResponseId?: () => string | undefined
			getEncryptedContent?: () => { encrypted_content: string; id?: string } | undefined
			getReasoningItems?: () => Array<{
				encrypted_content: string
				id?: string
				summary?: unknown[]
			}>
			getThoughtSignature?: () => string | undefined
			getSummary?: () => any[] | undefined
			getReasoningDetails?: () => any[] | undefined
			getStatefulMarker?: () => string | undefined
		}

		if (message.role === "assistant") {
			const canonicalEncryptedReasoningProjected =
				Array.isArray(message.content) && message.content.some(isCanonicalEncryptedReasoningHistoryItem)
			const canonicalVscodeThinkingProjected =
				Array.isArray(message.content) &&
				message.content.some((block) => (block as { type: string }).type === "vscode_lm_thinking")
			const canonicalGeminiResponseProjected =
				Array.isArray(message.content) &&
				message.content.some((block) => (block as { type: string }).type === "gemini_response")
			const responseId = handler.getResponseId?.()
			const reasoningData = handler.getEncryptedContent?.()
			const encryptedReasoningItems = (handler.getReasoningItems?.() ?? []).filter(
				(item) => typeof item.encrypted_content === "string" && item.encrypted_content.length > 0,
			)
			const encryptedReasoningBlocks =
				encryptedReasoningItems.length > 0
					? encryptedReasoningItems.map((item) => ({
							type: "reasoning" as const,
							encrypted_content: item.encrypted_content,
							summary: Array.isArray(item.summary) ? item.summary : [],
							...(item.id ? { id: item.id } : {}),
						}))
					: reasoningData?.encrypted_content
						? [
								{
									type: "reasoning" as const,
									encrypted_content: reasoningData.encrypted_content,
									summary: [] as unknown[],
									...(reasoningData.id ? { id: reasoningData.id } : {}),
								},
							]
						: []
			const thoughtSignature = handler.getThoughtSignature?.()
			const reasoningSummary = handler.getSummary?.()
			const reasoningDetails = handler.getReasoningDetails?.()
			const vscodeLmStatefulMarker = handler.getStatefulMarker?.()

			// Only Anthropic's API expects/validates the special `thinking` content block signature.
			// Other providers (notably Gemini 3) use different signature semantics (e.g. `thoughtSignature`)
			// and require round-tripping the signature in their own format.
			const modelId = getModelId(this.apiConfiguration)
			const apiProvider = this.apiConfiguration.apiProvider
			const apiProtocol =
				responseStep?.snapshot.context.provider.apiProtocol ??
				getApiProtocol(isProviderName(apiProvider) ? apiProvider : undefined, modelId)
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
			if (
				!canonicalAnthropicThinkingProjected &&
				!canonicalEncryptedReasoningProjected &&
				isAnthropicProtocol &&
				reasoning &&
				thoughtSignature &&
				!reasoningDetails
			) {
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
			} else if (
				!canonicalAnthropicThinkingProjected &&
				!canonicalEncryptedReasoningProjected &&
				!canonicalVscodeThinkingProjected &&
				!canonicalGeminiResponseProjected &&
				reasoning &&
				!reasoningDetails
			) {
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
			} else if (
				!canonicalAnthropicThinkingProjected &&
				!canonicalEncryptedReasoningProjected &&
				encryptedReasoningBlocks.length > 0
			) {
				// OpenAI Native encrypted reasoning
				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						...encryptedReasoningBlocks,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [...encryptedReasoningBlocks, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = encryptedReasoningBlocks
				}
			}

			// For non-Anthropic providers (e.g., Gemini 3), persist the thought signature as its own
			// content block so converters can attach it back to the correct provider-specific fields.
			// Note: For Anthropic extended thinking, the signature is already included in the thinking block above.
			if (thoughtSignature && !isAnthropicProtocol && !canonicalGeminiResponseProjected) {
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

			if (hasOpaqueProviderState(messageWithTs)) {
				const source = responseStep?.snapshot.context.provider
				const replayModelId = source?.modelId ?? handler.getModel().id
				if (typeof replayModelId === "string" && replayModelId.length > 0) {
					const scope = providerStateScopeSchema.safeParse({
						provider: source?.apiProvider ?? apiProvider ?? "vertex",
						modelId: replayModelId,
					})
					// Optional provenance must not narrow the host's opaque ID contract.
					if (scope.success) messageWithTs.provider_state_scope = scope.data
				}
			}

			this.apiConversationHistory.push(messageWithTs)
		} else {
			this.stageApiUserMessage({ ...message, ...(hookPrompt ? { hook_prompt: hookPrompt } : {}) })
		}

		if (guard && !guard()) return false
		const saved = guard ? await this.saveApiConversationHistory(guard) : await this.saveApiConversationHistory()
		if (guard && !guard()) return false
		if (saved) {
			// Environment receipts acknowledge the durable history before unrelated
			// mailbox settlement can fail. This callback is synchronous and idempotent.
			onPersisted?.()
			if (guard && !guard()) return false
			if (guard) await this.settleAllPersistedWaitAgentResultClaims(guard)
			else await this.settleAllPersistedWaitAgentResultClaims()
			if (guard && !guard()) return false
		}
		return saved
	}

	/** Stage each input envelope before the shared transcript save, preserving its own provenance. */
	private stageApiUserMessage(message: ApiMessage): ApiMessage {
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
		const messageWithTs = {
			...validatedMessage,
			ts: message.ts ?? Date.now(),
		}
		this.apiConversationHistory.push(messageWithTs)
		return messageWithTs
	}

	private async persistUserContentWithEnvironment(
		content: Anthropic.Messages.ContentBlockParam[],
		capture: EnvironmentCapture | undefined,
		signal: AbortSignal | undefined,
		onPersisted?: () => Promise<void> | void,
		hookPrompt?: CompletionHookPromptProvenance,
		queuedMessageIds: readonly string[] = [],
		inputOrigin?: "human" | "agent",
		precedingMessages: readonly ApiMessage[] = [],
		guard?: CanonicalLifecycleEventGuard,
	): Promise<void> {
		const assertCurrent = () => {
			if (guard && !guard()) throw new TaskPersistenceError("The user input persistence boundary was superseded.")
		}
		const originalHistory = guard ? this.apiConversationHistory : undefined
		let persisted = false
		const stagedMessages: ApiMessage[] = []
		const acknowledgedQueueIds = [
			...new Set([
				...precedingMessages.flatMap((message) => message.queued_message_ids ?? []),
				...queuedMessageIds,
			]),
		]
		let acknowledgment: Promise<void> | undefined
		const resumeHistoryRepair =
			this.pendingResumeHistoryRepair &&
			this.apiConversationHistory.includes(this.pendingResumeHistoryRepair.message)
				? this.pendingResumeHistoryRepair
				: undefined
		const acknowledge = () => {
			assertCurrent()
			if (persisted) return
			persisted = true
			if (resumeHistoryRepair) resumeHistoryRepair.persisted = true
			capture?.commit()
			acknowledgment = (async () => {
				assertCurrent()
				await onPersisted?.()
				assertCurrent()
			})()
			// The transcript callback cannot await admission, but its caller joins it
			// before independent queue deletion. Observe early rejection until then.
			void acknowledgment.catch(() => undefined)
		}
		try {
			assertCurrent()
			this.throwIfStepInterrupted(signal)
			for (const message of precedingMessages) stagedMessages.push(this.stageApiUserMessage(message))
			const previousMessage = this.apiConversationHistory.at(-1)
			// addToApiConversationHistory stages its user message synchronously before
			// awaiting the save. Keep that exact identity for rollback, not an index.
			const message: Anthropic.MessageParam = {
				role: "user",
				content,
				...(inputOrigin ? { input_origin: inputOrigin } : {}),
				...(queuedMessageIds.length ? { queued_message_ids: [...queuedMessageIds] } : {}),
			}
			const save = guard
				? this.addToApiConversationHistory(message, undefined, acknowledge, false, hookPrompt, guard)
				: this.addToApiConversationHistory(message, undefined, acknowledge, false, hookPrompt)
			const latest = this.apiConversationHistory.at(-1)
			if (latest && latest !== previousMessage) stagedMessages.push(latest)
			const saved = await save
			assertCurrent()
			const retried =
				!saved &&
				(guard
					? await this.retrySaveApiConversationHistory(acknowledge, signal, guard)
					: await this.retrySaveApiConversationHistory(acknowledge, signal))
			assertCurrent()
			if (saved || retried) acknowledge()
			if (!persisted)
				throw new TaskPersistenceError("Failed to persist the user turn before starting the provider request")
			await acknowledgment
			assertCurrent()
			if (acknowledgedQueueIds.length) {
				this.messageQueueService.acknowledgeMessages(acknowledgedQueueIds)
				await this.messageQueueService.flush()
				assertCurrent()
				for (const [callId, reply] of this.queuedToolResultReceipts ?? []) {
					if (reply.ids.every((id) => acknowledgedQueueIds.includes(id)))
						this.queuedToolResultReceipts.delete(callId)
				}
			}
		} catch (error) {
			if (!persisted && (!guard || guard())) {
				const history = originalHistory ?? this.apiConversationHistory
				for (const stagedMessage of stagedMessages) {
					const index = history.indexOf(stagedMessage)
					if (index >= 0) history.splice(index, 1)
				}
			}
			throw error
		} finally {
			capture?.release()
		}
	}

	/** Add a fresh baseline to the next request without removing already acknowledged transient events. */
	private async refreshEnvironmentContext(state?: TaskRequestState, signal?: AbortSignal): Promise<void> {
		if (!this.environmentContext.needsFullSnapshot) return
		const capture = await captureEnvironmentDetails(this, true, state, { context: this.environmentContext, signal })
		// A separate boundary preserves the exact retained user/tool-result records.
		// Consecutive user messages are merged only in the provider request projection.
		await this.persistUserContentWithEnvironment(
			[{ type: "text", text: capture.details }],
			capture,
			signal,
			undefined,
			undefined,
			[],
			"agent",
		)
	}

	private async restoreRemovedApiUserMessage(removedUserMessage: ApiMessage | undefined): Promise<boolean> {
		if (!removedUserMessage) {
			return true
		}

		const lastMessage = this.apiConversationHistory[this.apiConversationHistory.length - 1]
		if (lastMessage !== removedUserMessage) {
			this.apiConversationHistory.push(removedUserMessage)
			const saved = await this.saveApiConversationHistory()
			if (!saved) throw new TaskPersistenceError("Unable to restore the removed user message before continuing.")
		}
		return true
	}

	private buildUserMessageContent(
		text?: string,
		images?: string[],
		queuedMessageIds: readonly string[] = [],
	): Anthropic.Messages.ContentBlockParam[] {
		// User guidance starts a fresh Stop-hook window, including queued feedback
		// delivered inside an existing task loop.
		this.completionHookConfig = readCompletionHookConfig()
		this.pendingCompletionHookPrompt = undefined
		this.completionHookActive = false
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

		this.bindQueuedInputBlocks(userContent, queuedMessageIds)
		return userContent
	}

	private bindQueuedInputBlocks(
		content: readonly Anthropic.Messages.ContentBlockParam[],
		ids: readonly string[],
	): void {
		if (!ids.length) return
		this.queuedInputBlockReceipts ??= new WeakMap()
		for (const block of content) this.queuedInputBlockReceipts.set(block, ids)
	}

	/** Admission origin outlives consumable queue receipts and notification ACK markers. */
	private captureInputBlockOrigins(
		content: readonly Anthropic.Messages.ContentBlockParam[],
		fallback: "human" | "agent",
	): void {
		this.inputBlockOrigins ??= new WeakMap()
		const claimedIds = new Set(this.messageQueueService?.getClaimedMessageIds?.() ?? [])
		for (const block of content) {
			if (block.type === "text" && this.pendingWaitAgentNotificationBlocks?.has(block)) {
				this.inputBlockOrigins.set(block, "agent")
			} else if (!this.inputBlockOrigins.has(block)) {
				const humanReceipt = this.queuedInputBlockReceipts?.get(block)?.some((id) => claimedIds.has(id))
				this.inputBlockOrigins.set(block, humanReceipt ? "human" : fallback)
			}
		}
	}

	/** A queued tool reply belongs to its actual terminal result, not the next unrelated user message. */
	public retainQueuedMessageToolResult(
		toolCallId: string | undefined,
		ids: readonly string[],
		content: Anthropic.Messages.ContentBlockParam[],
	): void {
		toolCallId ??= this.toolInputContext?.getStore()?.toolCallId
		if (!toolCallId || !ids.length) return
		this.queuedToolResultReceipts ??= new Map()
		this.queuedToolResultReceipts.set(sanitizeToolUseId(toolCallId), { ids, content })
	}

	public retainQueuedMessageToolReply(toolCallId: string | undefined, message: QueuedMessage): void {
		this.retainQueuedMessageToolResult(
			toolCallId,
			[message.id],
			this.buildUserMessageContent(message.text, message.images, [message.id]),
		)
	}

	public withToolInputContext<T>(toolCallId: string, operation: () => Promise<T>): Promise<T> {
		this.toolInputContext ??= new AsyncLocalStorage()
		return this.toolInputContext.run({ toolCallId, turn: this.captureMessageTurn() }, operation)
	}

	/** Capture at producer admission; late callbacks must pass this snapshot back to say(). */
	public captureMessageTurn(): AlphaMessageTurn | undefined {
		return this.agentRunId && this.agentTurnId ? { runId: this.agentRunId, turnId: this.agentTurnId } : undefined
	}

	private async annotateMessageTurn(
		timestamp: number,
		attribution: Pick<AlphaMessageTurn, "inputKind" | "terminalStatus">,
		guard: CanonicalLifecycleEventGuard = this.captureAgentStepOwnership(),
	): Promise<void> {
		const turn = this.captureMessageTurn()
		if (!turn || !guard() || !this.findMessageByTimestamp(timestamp)) return
		const provider = this.providerRef.deref()
		const committed = await this.commitAlphaMessageMutation(
			timestamp,
			"the message turn attribution",
			(message) => {
				if (!message) return undefined
				const existing = message.turn
				if (
					attribution.terminalStatus &&
					(existing?.inputKind ||
						(existing && (existing.runId !== turn.runId || existing.turnId !== turn.turnId)))
				)
					return undefined
				const inputKind =
					existing?.runId === turn.runId && existing.turnId === turn.turnId && existing.inputKind
						? existing.inputKind
						: attribution.inputKind
				return { ...message, turn: { ...turn, ...attribution, ...(inputKind ? { inputKind } : {}) } }
			},
			undefined,
			undefined,
			{ guard, provider },
		)
		if (committed && guard()) await this.updateAlphaMessage(committed.message, { guard, provider })
	}

	private async sayOpeningInput(
		type: AlphaSay,
		text?: string,
		images?: string[],
		queuedMessageIds?: readonly string[],
		stateUpdate?: "full" | "task",
	): Promise<number | undefined> {
		let timestamp: number | undefined
		await this.say(type, text, images, undefined, undefined, undefined, {
			turn: null,
			queuedMessageIds,
			stateUpdate,
			onCreated: (message) => {
				timestamp = message.ts
			},
		})
		return timestamp
	}

	private getQueuedInputReceipts(content: readonly Anthropic.Messages.ContentBlockParam[]): string[] {
		const claimed = new Set(this.messageQueueService?.getClaimedMessageIds?.() ?? [])
		return [
			...new Set(
				content.flatMap((block) => [
					...(this.queuedInputBlockReceipts?.get(block) ?? []),
					...(block.type === "tool_result"
						? (this.queuedToolResultReceipts?.get(sanitizeToolUseId(block.tool_use_id))?.ids ?? [])
						: []),
				]),
			),
		].filter((id) => claimed.has(id))
	}

	private includeQueuedToolReplyContent(
		content: Anthropic.Messages.ContentBlockParam[],
	): Anthropic.Messages.ContentBlockParam[] {
		const replies = content.flatMap((block) =>
			block.type === "tool_result"
				? [this.queuedToolResultReceipts?.get(sanitizeToolUseId(block.tool_use_id))].filter(
						(item) => item !== undefined,
					)
				: [],
		)
		if (!replies.length) return content
		// The host owns the guidance payload. A tool's denial/error must not discard a
		// queued reply merely because its result omits the user's text or images.
		return [...content, ...replies.flatMap((reply) => reply.content)]
	}

	/** A retained lifecycle must be able to recover selections whose input was never committed. */
	private async releaseUnpersistedQueuedInputs(
		retainedInputIds: readonly string[] = [],
		guard?: CanonicalLifecycleEventGuard,
	): Promise<void> {
		if (guard && !guard()) return
		const queue = this.messageQueueService
		if (!queue) return
		await queue.ready
		if (guard && !guard()) return
		const consumed = new Set(
			(this.apiConversationHistory ?? []).flatMap((message) => message.queued_message_ids ?? []),
		)
		const ids = queue.getClaimedMessageIds?.() ?? []
		const retained = new Set(retainedInputIds)
		if (guard && !guard()) return
		queue.acknowledgeMessages?.(ids.filter((id) => consumed.has(id)))
		for (const id of ids.slice().reverse()) {
			if (guard && !guard()) return
			if (!consumed.has(id) && !retained.has(id)) queue.releaseMessage?.(id)
		}
		if (guard && !guard()) return
		await queue.flush?.()
	}

	/**
	 * Reconcile locally retained tool results with the next request boundary.
	 *
	 * A failed transcript write intentionally leaves the original result in
	 * `userMessageContent` so a later request can retry it. Recovery requests carry
	 * new text, so they do not otherwise include that result. Match by call ID and
	 * prefer the retained block, preserving its content and error status instead of
	 * allowing history validation to fabricate an interrupted placeholder.
	 */
	private mergePendingToolResultsIntoUserContent(
		userContent: Anthropic.Messages.ContentBlockParam[],
	): Anthropic.Messages.ContentBlockParam[] {
		const pendingNotifications = this.userMessageContent.filter(
			(block): block is Anthropic.TextBlockParam =>
				block.type === "text" && this.pendingWaitAgentNotificationBlocks.has(block),
		)
		const pendingToolResults = this.userMessageContent.filter(
			(block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result",
		)
		if (pendingToolResults.length === 0 && pendingNotifications.length === 0) return userContent

		const pendingByToolUseId = new Map(
			pendingToolResults.map((result) => [sanitizeToolUseId(result.tool_use_id), result]),
		)
		const reconciledToolUseIds = new Set<string>()
		const reconciledContent = userContent.map((block) => {
			if (block.type !== "tool_result") return block

			const toolUseId = sanitizeToolUseId(block.tool_use_id)
			const pendingResult = pendingByToolUseId.get(toolUseId)
			if (!pendingResult) return block

			reconciledToolUseIds.add(toolUseId)
			return pendingResult
		})
		const missingResults = pendingToolResults.filter(
			(result) => !reconciledToolUseIds.has(sanitizeToolUseId(result.tool_use_id)),
		)

		const missingNotifications = pendingNotifications.filter((block) => !reconciledContent.includes(block))
		return [...missingResults, ...missingNotifications, ...reconciledContent]
	}

	/** Remove only content that was included in the user message that just crossed the save fence. */
	private acknowledgePersistedUserMessageContent(
		persistedContent: readonly Anthropic.Messages.ContentBlockParam[],
	): void {
		for (const block of persistedContent) {
			if (block.type === "text") this.pendingWaitAgentNotificationBlocks.delete(block)
		}
		const persistedToolUseIds = new Set(
			persistedContent
				.filter((block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result")
				.map((block) => sanitizeToolUseId(block.tool_use_id)),
		)
		this.userMessageContent = this.userMessageContent.filter((block) => {
			if (block.type === "tool_result") {
				return !persistedToolUseIds.has(sanitizeToolUseId(block.tool_use_id))
			}
			return !persistedContent.includes(block)
		})
	}

	// NOTE: We intentionally do NOT mutate stored messages to merge consecutive user turns.
	// For API requests, consecutive same-role messages are merged via mergeConsecutiveApiMessages()
	// so rewind/edit behavior can still reference original message boundaries.

	/** Commit deliberate history removal before either recoverable projection changes. */
	public async commitConversationRewind(uiMessages: AlphaMessage[], apiHistory: ApiMessage[]): Promise<boolean> {
		return this.enqueueConversationRewind(async () => {
			await this.loadConversationRewind()
			await this.flushApiConversationHistoryPersistence()
			await this.canonicalLifecycleQueue
			await this.replayCanonicalLifecycle()
			const snapshot = this.getCanonicalLifecycleSnapshot()
			apiHistory = replaceDeliberatelyRemovedToolResults(this.apiConversationHistory, apiHistory)
			const retainedCalls = new Set(
				apiHistory.flatMap((message) =>
					Array.isArray(message.content)
						? message.content
								.map(getToolCallId)
								.filter((id): id is string => id !== undefined)
								.map(sanitizeToolUseId)
						: [],
				),
			)
			const store = new TaskRewindStore(this.globalStoragePath, this.taskId)
			this.conversationRewindRecord = await store.begin(
				structuredClone(uiMessages),
				structuredClone(apiHistory),
				snapshot
					? {
							runId: snapshot.runId,
							turnId: snapshot.turnId,
							toolCallIds: snapshot.acceptedToolCallIds.filter(
								(id) => !retainedCalls.has(sanitizeToolUseId(id)),
							),
						}
					: undefined,
			)
			await this.finishConversationRewind(store)
			return true
		})
	}

	private enqueueConversationRewind<T>(operation: () => Promise<T>): Promise<T> {
		const pending = (this.conversationRewindQueue ?? Promise.resolve()).catch(() => undefined).then(operation)
		this.conversationRewindQueue = pending
		return pending
	}

	private recoverConversationRewind(): Promise<void> {
		return this.enqueueConversationRewind(() => this.loadConversationRewind())
	}

	/** A crash between the legacy UI/API writes retries the exact write-ahead targets. */
	private async loadConversationRewind(): Promise<void> {
		const store = new TaskRewindStore(this.globalStoragePath, this.taskId)
		this.conversationRewindRecord = await store.read()
		await this.finishConversationRewind(store)
	}

	private async finishConversationRewind(store: TaskRewindStore): Promise<void> {
		const record = this.conversationRewindRecord
		if (!record?.pending) return
		if ((await this.overwriteAlphaMessages(structuredClone(record.pending.uiMessages))) !== true) {
			throw new TaskPersistenceError("Conversation rewind UI history could not be durably saved.")
		}
		if ((await this.overwriteApiConversationHistory(structuredClone(record.pending.apiHistory))) !== true) {
			throw new TaskPersistenceError("Conversation rewind provider history could not be durably saved.")
		}
		await store.complete(record.rewindId)
		delete record.pending
	}

	private isRewoundCanonicalToolCall(snapshot: AgentLifecycleSnapshot, toolCallId: string): boolean {
		return (
			this.conversationRewindRecord?.exclusions.some(
				(exclusion) =>
					exclusion.runId === snapshot.runId &&
					exclusion.turnId === snapshot.turnId &&
					exclusion.toolCallIds.includes(toolCallId),
			) ?? false
		)
	}

	async overwriteApiConversationHistory(
		newHistory: ApiMessage[],
		guard?: CanonicalLifecycleEventGuard,
	): Promise<boolean> {
		if (guard && !guard()) return false
		// The provider verifies wait receipts from the saved transcript. Join earlier
		// saves before deleting queue evidence or asking it to settle those receipts.
		await this.flushApiConversationHistoryPersistence()
		if (guard && !guard()) return false
		// Persist deletion before a rewind/compaction can remove the transcript receipt
		// that otherwise suppresses replay after a crash between input commit and ACK.
		await this.messageQueueService?.ready
		if (guard && !guard()) return false
		const consumed = (this.apiConversationHistory ?? []).flatMap((message) => message.queued_message_ids ?? [])
		for (const id of consumed) {
			if (guard && !guard()) return false
			this.messageQueueService?.claimMessage?.(id)
		}
		if (guard && !guard()) return false
		this.messageQueueService?.acknowledgeMessages?.(consumed)
		await this.messageQueueService?.flush?.()
		if (guard && !guard()) return false
		// A consumed independent wait result must settle its durable outbox receipt
		// before replacement can archive or remove the only evidence of delivery.
		await this.providerRef.deref()?.settleIndependentTaskWaitReceiptsForParent?.(this.taskId)
		if (guard && !guard()) return false
		this.apiConversationHistory = newHistory.map((message) =>
			message.role === "user" && (message.isSummary || message.isTruncationMarker || message.hook_prompt)
				? { ...message, input_origin: "agent" }
				: message,
		)
		// Rewind/recovery may remove the acknowledged baseline. Invalidate when the
		// in-memory view changes, even if persistence fails and keeps it for retry.
		this.environmentContext.reset()
		return guard ? this.saveApiConversationHistory(guard) : this.saveApiConversationHistory()
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
	 * tools execute (added in runAgentRequests after streaming completes).
	 * So we usually only need to flush the pending user message with tool_results.
	 */
	public async flushPendingToolResultsToHistory(
		options: { allowAborted?: boolean; guard?: CanonicalLifecycleEventGuard } = {},
	): Promise<boolean> {
		const guard = options.guard
		if (guard && !guard()) return false
		// A delayed acknowledgment belongs to the turn that began this flush.
		const persistedToolResultIds = this.persistedToolResultIds
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
		// - Set to true after the assistant message is saved in runAgentRequests
		if (!this.assistantMessageSavedToHistory) {
			const reachedAssistantBoundary = await pWaitFor(
				() => this.assistantMessageSavedToHistory || this.abort || (guard !== undefined && !guard()),
				{
					interval: 50,
					timeout: 30_000, // 30 second timeout as safety net
				},
			)
				.then(() => this.assistantMessageSavedToHistory)
				.catch(() => {
					if (guard && !guard()) return false
					console.warn(
						`[Task#${this.taskId}] flushPendingToolResultsToHistory: timed out waiting for assistant message to be saved`,
					)
					return false
				})
			if (!reachedAssistantBoundary) return false
		}
		if (guard && !guard()) return false

		// If task was aborted while waiting, don't flush unless this is the terminal
		// response repair path. That path must close every persisted assistant
		// tool_use with a deterministic error receipt even when cancellation has
		// already set the task-wide abort flag.
		if (this.abort && !options.allowAborted) {
			return false
		}

		// Save the user message with tool_result blocks
		const pendingContent = [...this.userMessageContent]
		const content = this.includeQueuedToolReplyContent(pendingContent)
		this.captureInputBlockOrigins(content, "agent")
		const queuedMessageIds = this.getQueuedInputReceipts(content)
		const userMessage: ApiMessage = {
			role: "user",
			content,
			input_origin: queuedMessageIds.length ? "human" : "agent",
			...(queuedMessageIds.length ? { queued_message_ids: queuedMessageIds } : {}),
		}

		// Validate and fix tool_result IDs when the previous *effective* message is an assistant message.
		const effectiveHistoryForValidation = getEffectiveApiHistory(this.apiConversationHistory)
		const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
		const historyForValidation = lastEffective?.role === "assistant" ? effectiveHistoryForValidation : []
		const validatedMessage = validateAndFixToolResultIds(userMessage, historyForValidation)
		const userMessageWithTs = {
			...validatedMessage,
			input_origin: userMessage.input_origin,
			...(queuedMessageIds.length ? { queued_message_ids: queuedMessageIds } : {}),
			ts: Date.now(),
		}
		this.apiConversationHistory.push(userMessageWithTs as ApiMessage)

		const saved = await (guard ? this.saveApiConversationHistory(guard) : this.saveApiConversationHistory())
		// An admitted transcript transaction finishes coherently, but its pending
		// content and queue/mailbox acknowledgements still belong to this step.
		if (guard && !guard()) return false

		if (saved) {
			// Retire the durable snapshot before fallible queue/mailbox settlement.
			// A failed acknowledgment must not stage already saved results again.
			for (const block of pendingContent) {
				if (block.type === "text") this.pendingWaitAgentNotificationBlocks.delete(block)
			}
			for (const block of pendingContent) {
				if (block.type === "tool_result") {
					persistedToolResultIds.add(sanitizeToolUseId(getToolResultId(block) ?? ""))
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
			this.messageQueueService?.acknowledgeMessages?.(queuedMessageIds)
			await this.messageQueueService?.flush?.()
			if (guard && !guard()) return false
			if (guard) await this.settlePersistedWaitAgentResultClaims(userMessageWithTs as ApiMessage, guard)
			else await this.settlePersistedWaitAgentResultClaims(userMessageWithTs as ApiMessage)
			if (guard && !guard()) return false
		} else {
			const appendedIndex = this.apiConversationHistory.indexOf(userMessageWithTs as ApiMessage)
			if (appendedIndex >= 0) this.apiConversationHistory.splice(appendedIndex, 1)
			console.warn(
				`[Task#${this.taskId}] flushPendingToolResultsToHistory: save failed, retaining pending tool results in memory`,
			)
		}

		return saved
	}

	/**
	 * Close canonical tool calls when the provider ends a response before tool
	 * execution can begin.
	 *
	 * The assistant boundary is persisted before this method is called. Results
	 * are staged through the same deduplicating path used by real tool execution
	 * and flushed as one user message, so a cancelled/failed provider response
	 * cannot leave an unmatched tool_use in the durable transcript. No tool is
	 * executed here.
	 */
	private async persistUnexecutedTerminalToolResults(
		response: AgentResponse | undefined,
		status: Exclude<AgentResponse["outcome"], undefined>["status"] | "failed",
		earlyExecutedReadCallIds: ReadonlySet<string> = new Set(),
		guard?: CanonicalLifecycleEventGuard,
	): Promise<boolean> {
		if (guard && !guard()) throw new TaskPersistenceError("The terminal tool receipt boundary was superseded.")
		const step = this.currentAgentStep
		const toolCalls = response?.toolCalls ?? []
		if (toolCalls.length === 0) return true

		// A result must never be written before its assistant tool_use boundary. A
		// missing boundary is an unrecoverable persistence failure for this step;
		// returning false keeps the caller on an explicit non-success outcome.
		if (!this.assistantMessageSavedToHistory) return false

		const historyToolResultIds = new Set<string>()
		for (const call of toolCalls) {
			const id = sanitizeToolUseId(call.id)
			if (this.findPersistedProviderToolResult(id)) historyToolResultIds.add(id)
		}

		const pendingToolResultIds = new Set(
			this.userMessageContent
				.filter((block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result")
				.map((block) => sanitizeToolUseId(block.tool_use_id)),
		)
		const normalizedToolUseIds = toolCalls.map((toolCall) => sanitizeToolUseId(toolCall.id))
		if (normalizedToolUseIds.some((toolUseId) => !toolUseId)) return false
		const receiptContent =
			status === "cancelled"
				? "Tool call was not executed because the provider response was cancelled."
				: status === "failed"
					? "Tool call was not executed because the provider response failed."
					: "Tool call was not executed because the provider response was incomplete."
		const effectStartedCallIds = this.getCurrentEffectStartedToolCallIds()
		const terminalReceiptContent = (toolUseId: string): string => {
			if (earlyExecutedReadCallIds.has(toolUseId)) {
				return status === "cancelled"
					? "The read completed before cancellation, but its result was withheld because the provider response was cancelled."
					: "The read completed, but its result was withheld because the provider response did not complete."
			}
			if (effectStartedCallIds.has(toolUseId)) {
				return status === "cancelled"
					? "The tool effect may have started before cancellation. Its outcome is unknown; verify the current state before retrying."
					: "The tool effect may have started before the provider response ended. Its outcome is unknown; verify the current state before retrying."
			}
			return receiptContent
		}
		for (const [index, toolCall] of toolCalls.entries()) {
			const toolUseId = normalizedToolUseIds[index]!
			if (historyToolResultIds.has(toolUseId) || pendingToolResultIds.has(toolUseId)) continue
			const callReceiptContent = terminalReceiptContent(toolUseId)
			this.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: toolUseId,
				content: callReceiptContent,
				is_error: true,
			})
		}

		let transcriptPersisted = false
		try {
			transcriptPersisted = await this.flushPendingToolResultsToHistory({
				allowAborted: true,
				...(guard ? { guard } : {}),
			})
		} catch (error) {
			// The canonical lifecycle journal is an independent receipt ledger. A
			// legacy transcript failure must be reported to the caller, but it must
			// not prevent us from closing accepted calls in that ledger below.
			console.error(`[Task#${this.taskId}] Failed to flush terminal tool receipts:`, error)
		}
		if (guard && !guard()) throw new TaskPersistenceError("The terminal tool receipt boundary was superseded.")

		// Treat the persisted transcript, rather than only the in-memory dedupe
		// set, as the durability check. This also makes the helper safe for direct
		// continuation/retry callers that invoke it more than once.
		const persisted =
			transcriptPersisted &&
			normalizedToolUseIds.every((toolUseId) => this.findPersistedProviderToolResult(toolUseId))
		// Always close the canonical call set, even when the legacy transcript
		// write failed. This keeps the lifecycle reducer terminally consistent;
		// the false return still promotes the host/task result to a durability
		// failure so callers cannot mistake the transcript for fully persisted.
		const resultStatus = status === "cancelled" ? "cancelled" : "error"
		for (const toolUseId of normalizedToolUseIds) {
			if (guard && !guard()) throw new TaskPersistenceError("The terminal tool receipt boundary was superseded.")
			// A deferred commit may have staged its actual result before an observer
			// or journal append failed. Preserve that truth even when the flush failed.
			const receipt =
				this.findPersistedProviderToolResult(toolUseId) ??
				this.userMessageContent.find(
					(block): block is Anthropic.ToolResultBlockParam =>
						block.type === "tool_result" && sanitizeToolUseId(block.tool_use_id) === toolUseId,
				)
			const callResultStatus = earlyExecutedReadCallIds.has(toolUseId) ? "error" : resultStatus
			const callReceiptContent = terminalReceiptContent(toolUseId)
			const hasActualReceipt = historyToolResultIds.has(toolUseId) || pendingToolResultIds.has(toolUseId)
			await this.publishCanonicalLifecycleToolResult(
				{
					callId: toolUseId,
					status: receipt && hasActualReceipt ? (receipt.is_error ? "error" : "success") : callResultStatus,
					content: receipt ? receipt.content : callReceiptContent,
				},
				step,
				{ guard },
			)
			if (guard && !guard()) throw new TaskPersistenceError("The terminal tool receipt boundary was superseded.")
		}
		return persisted
	}

	private getCurrentEffectStartedToolCallIds(): ReadonlySet<string> {
		const lifecycle = this.getCanonicalLifecycleSnapshot()
		return new Set(
			lifecycle !== undefined && lifecycle.runId === this.agentRunId && lifecycle.turnId === this.agentTurnId
				? lifecycle.effectStartedToolCallIds
				: [],
		)
	}

	private getCompletedEarlyReadCallIds(dispatches: readonly EarlyReadonlyDispatch[]): ReadonlySet<string> {
		const effectStartedCallIds = this.getCurrentEffectStartedToolCallIds()
		// A settled scheduler can contain a cancellation, fence failure, or denial
		// before approval. Effect-start plus a known terminal outcome proves it ran.
		return new Set(
			dispatches
				.filter(
					(dispatch) =>
						dispatch.outcome?.status === "completed" &&
						!dispatch.outcome.failure &&
						!dispatch.error &&
						dispatch.outcome.results.some(
							(result) =>
								sanitizeToolUseId(result.callId) === sanitizeToolUseId(dispatch.call.id) &&
								(result.status === "success" || result.status === "error") &&
								result.executionStatus !== "running" &&
								result.executionStatus !== "cancelled" &&
								result.executionStatus !== "denied" &&
								result.failure?.outcome !== "unknown" &&
								effectStartedCallIds.has(sanitizeToolUseId(result.callId)),
						),
				)
				.map((dispatch) => sanitizeToolUseId(dispatch.call.id)),
		)
	}

	/** Capture owner and primitive identity before an asynchronous persistence/settlement boundary. */
	private captureAgentStepOwnership(
		boundary?: Pick<EarlyReadonlyDispatch, "step" | "runId" | "surface" | "identity">,
	): CanonicalLifecycleEventGuard {
		const step = boundary ? boundary.step : this.currentAgentStep
		const runId = boundary ? boundary.runId : this.agentRunId
		const turnId = boundary ? boundary.identity.turnId : this.agentTurnId
		const stepTurnId = boundary ? boundary.identity.turnId : step?.turnId
		const stepId = boundary ? boundary.identity.stepId : step?.stepId
		const requestId = boundary ? boundary.identity.requestId : step?.requestId
		const attemptId = boundary ? boundary.identity.attemptId : step?.attemptId
		const surface = boundary ? boundary.surface : this.currentTaskToolSurface
		const stepSurface = boundary ? boundary.surface : step?.surface
		return () =>
			this.isCurrentApiConversationHistoryOwner() &&
			this.currentAgentStep === step &&
			this.agentRunId === runId &&
			this.agentTurnId === turnId &&
			step?.turnId === stepTurnId &&
			step?.stepId === stepId &&
			step?.requestId === requestId &&
			step?.attemptId === attemptId &&
			step?.surface === stepSurface &&
			this.currentTaskToolSurface === surface
	}

	/** Settle an already executed read, never start an effect for a terminal response. */
	private async persistTerminalToolResults(
		response: AgentResponse,
		status: "failed" | "incomplete" | "cancelled",
		dispatches: readonly EarlyReadonlyDispatch[],
		allowEarlyReadResults = true,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<{ persisted: boolean; error?: Error; superseded?: boolean }> {
		if (guard && !guard()) {
			return {
				persisted: false,
				error: new TaskPersistenceError("The terminal response no longer owns its transcript step."),
				superseded: true,
			}
		}
		// Dispatch identity predates assistant persistence. Never bind an old
		// response's fallback receipts to a step that replaced it during that await.
		const step = dispatches.length > 0 ? dispatches[0]!.step : this.currentAgentStep
		const runId = dispatches.length > 0 ? dispatches[0]!.runId : this.agentRunId
		const identity = dispatches[0]?.identity ?? {
			turnId: step?.turnId,
			stepId: step?.stepId,
			requestId: step?.requestId,
			attemptId: step?.attemptId,
		}
		const surface = dispatches.length > 0 ? dispatches[0]!.surface : step?.surface
		const ownsDispatchBoundary = this.captureAgentStepOwnership(dispatches[0])
		const ownsBoundary = guard ? () => guard() && ownsDispatchBoundary() : ownsDispatchBoundary
		const assertOwnership = () => {
			if (!ownsBoundary()) throw new TaskPersistenceError("The early read no longer owns its transcript step.")
		}
		let settlementError: Error | undefined
		const recordFailure = (error: unknown) => {
			settlementError ??= error instanceof Error ? error : new Error(String(error))
		}
		const prefixMatches = dispatches.every((dispatch, index) => {
			const call = response.toolCalls[index]
			return (
				call !== undefined &&
				call.id === dispatch.call.id &&
				call.name === dispatch.call.name &&
				JSON.stringify(call.arguments) === JSON.stringify(dispatch.call.arguments) &&
				dispatch.step === step &&
				dispatch.runId === runId &&
				dispatch.surface === surface &&
				dispatch.identity.turnId === identity.turnId &&
				dispatch.identity.stepId === identity.stepId &&
				dispatch.identity.requestId === identity.requestId &&
				dispatch.identity.attemptId === identity.attemptId
			)
		})
		const committedDispatches: EarlyReadonlyDispatch[] = []
		await this.canonicalLifecycleQueue
		if (!ownsBoundary()) {
			return {
				persisted: false,
				error: new TaskPersistenceError("The terminal response no longer owns its transcript step."),
				superseded: true,
			}
		}
		for (const dispatch of dispatches) {
			if (!dispatch.scheduler || !dispatch.outcome) continue
			const lifecycle = ownsBoundary() ? this.getCanonicalLifecycleSnapshot() : undefined
			const callId = sanitizeToolUseId(dispatch.call.id)
			const accepted = lifecycle?.items.find((item) => item.type === "tool_call" && item.toolCallId === callId)
			const result = dispatch.outcome.results[0]
			const canCommit =
				allowEarlyReadResults &&
				(status === "failed" || status === "incomplete") &&
				(response.outcome?.status === "failed" || response.outcome?.status === "incomplete") &&
				prefixMatches &&
				ownsBoundary() &&
				runId !== undefined &&
				step !== undefined &&
				!this.abort &&
				!this.getTaskLifetimeCancellationSignal().aborted &&
				!this.pendingSteerMessage &&
				!settlementError &&
				!dispatch.error &&
				!dispatch.resultCommitStarted &&
				dispatch.outcome.status === "completed" &&
				!dispatch.outcome.failure &&
				dispatch.outcome.results.length === 1 &&
				result !== undefined &&
				sanitizeToolUseId(result.callId) === callId &&
				result.name === dispatch.call.name &&
				(result.status === "success" || result.status === "error") &&
				result.executionStatus !== "running" &&
				result.executionStatus !== "cancelled" &&
				result.executionStatus !== "denied" &&
				result.failure?.outcome !== "unknown" &&
				lifecycle !== undefined &&
				lifecycle.runId === runId &&
				lifecycle.turnId === identity.turnId &&
				lifecycle.status === "in_progress" &&
				lifecycle.effectStartedToolCallIds.includes(callId) &&
				!lifecycle.terminalToolCallIds.includes(callId) &&
				accepted?.type === "tool_call" &&
				accepted.stepId === identity.stepId &&
				accepted.name === dispatch.call.name &&
				JSON.stringify(accepted.arguments) === JSON.stringify(dispatch.call.arguments)
			if (!canCommit) {
				if (!dispatch.resultCommitStarted) {
					try {
						await dispatch.scheduler.discardDeferredResults()
					} catch (error) {
						recordFailure(error)
					}
					if (dispatch.outcome.status === "failed" && !settlementError) {
						recordFailure(new Error(dispatch.outcome.failure?.message ?? "Early read execution failed."))
					}
				}
				continue
			}
			const previewStatus = result!.status
			// A rejected commit can already have consumed its finalizer and staged a
			// truthful receipt. It must never be discarded or retried as a fresh read.
			dispatch.resultCommitStarted = true
			try {
				await dispatch.scheduler.commitDeferredResults({ deferBatchFinished: true, assertOwnership })
				committedDispatches.push(dispatch)
			} catch (error) {
				recordFailure(error)
			}
			if (!ownsBoundary()) {
				recordFailure(new TaskPersistenceError("The early read settlement no longer owns its transcript step."))
				continue
			}
			// Finalizers can replace a successful preview with an archive/permission
			// failure. Only an actual staged/persisted receipt permits journal repair.
			const finalized = dispatch.outcome.results.find((item) => sanitizeToolUseId(item.callId) === callId)
			const receipt =
				this.findPersistedProviderToolResult(callId) ??
				this.userMessageContent.find(
					(block): block is Anthropic.ToolResultBlockParam =>
						block.type === "tool_result" && sanitizeToolUseId(block.tool_use_id) === callId,
				)
			if (!receipt || !finalized) {
				recordFailure(new TaskPersistenceError("The early read commit did not stage a terminal receipt."))
			} else {
				if (previewStatus === "success" && (finalized.status === "error" || finalized.status === "denied")) {
					recordFailure(new Error("The completed early read result could not be finalized."))
				}
				try {
					await this.publishCanonicalLifecycleToolResult(
						{ callId, status: finalized.status, content: receipt.content },
						dispatch.step,
						{ durable: true, required: true, guard: ownsBoundary },
					)
				} catch (error) {
					recordFailure(error)
				}
			}
		}
		if (!ownsBoundary()) {
			return {
				persisted: false,
				error:
					settlementError ??
					new TaskPersistenceError("The terminal read no longer owns its transcript step."),
				superseded: true,
			}
		}
		let persisted = false
		try {
			persisted = await this.persistUnexecutedTerminalToolResults(
				response,
				this.abort || this.getTaskLifetimeCancellationSignal().aborted ? "cancelled" : status,
				this.getCompletedEarlyReadCallIds(dispatches),
				ownsBoundary,
			)
			if (!ownsBoundary()) {
				throw new TaskPersistenceError("The terminal read receipt was superseded.")
			}
			if (persisted && ownsBoundary()) {
				for (const dispatch of committedDispatches) {
					if (!ownsBoundary()) throw new TaskPersistenceError("The terminal read batch was superseded.")
					await dispatch.scheduler!.finishDeferredBatch({
						status:
							this.abort || this.getTaskLifetimeCancellationSignal().aborted
								? "aborted"
								: settlementError
									? "failed"
									: dispatch.outcome!.status,
						assertOwnership,
					})
				}
			}
		} catch (error) {
			recordFailure(error)
		}
		return {
			persisted,
			...(settlementError ? { error: settlementError } : {}),
			...(!ownsBoundary() ? { superseded: true } : {}),
		}
	}

	/**
	 * Persist a non-success canonical response and close every unexecuted tool
	 * call. This is shared by explicit provider outcomes and salvage of an
	 * unexpected throw after semantic output; it never executes a tool.
	 */
	private async persistTerminalCanonicalResponse(
		response: AgentResponse,
		status: "failed" | "incomplete" | "cancelled",
		reason: string,
		earlyDispatches: readonly EarlyReadonlyDispatch[] = [],
		guard?: CanonicalLifecycleEventGuard,
	): Promise<{
		assistantPersisted: boolean
		receiptsPersisted: boolean
		status: "failed" | "incomplete" | "aborted"
		reason: string
		error?: Error
	}> {
		if (guard && !guard()) {
			return {
				assistantPersisted: false,
				receiptsPersisted: false,
				status: "aborted",
				reason: "The task no longer owns its terminal response step.",
			}
		}
		const assistantContent = buildCanonicalAssistantHistoryContent(response)
		// A sealed empty reasoning block still owns provider state needed on replay.
		const terminalStep = this.currentAgentStep
		const terminalRunId = this.agentRunId
		const terminalTurnId = this.agentTurnId
		const terminalStepId = terminalStep?.stepId
		const ownsCapturedTerminalStep = this.captureAgentStepOwnership(earlyDispatches[0])
		const ownsTerminalStep = guard ? () => guard() && ownsCapturedTerminalStep() : ownsCapturedTerminalStep
		const hasAssistantBoundary =
			assistantContent.length > 0 ||
			response.reasoning.length > 0 ||
			response.items.some((item) => item.type === "reasoning" && item.signature !== undefined)
		let assistantPersisted = !hasAssistantBoundary
		const supersededResult = (error?: Error) => ({
			assistantPersisted,
			receiptsPersisted: false,
			status: "aborted" as const,
			reason: "The task no longer owns its terminal response step.",
			...(error ? { error } : {}),
		})

		if (hasAssistantBoundary) {
			assistantPersisted = await this.persistAssistantResponseBeforeEffects(
				{ role: "assistant", content: assistantContent },
				response.reasoning || undefined,
				response,
				ownsTerminalStep,
			)
			if (!ownsTerminalStep()) return supersededResult()
			if (assistantPersisted) {
				TelemetryService.instance.captureConversationMessage(this.taskId, "assistant")
				await this.appendAgentTurnEvent(
					{ type: "assistant_committed", response },
					terminalStep?.snapshot.context,
				)
				if (!ownsTerminalStep()) return supersededResult()
			}
		}
		if (!ownsTerminalStep()) return supersededResult()

		const completedEarlyReads = earlyDispatches.filter(
			(
				dispatch,
			): dispatch is EarlyReadonlyDispatch & { scheduler: ToolScheduler; outcome: ToolSchedulerOutcome } =>
				dispatch.scheduler !== undefined && dispatch.outcome !== undefined,
		)
		let discardError: Error | undefined
		if (!assistantPersisted) {
			for (const dispatch of completedEarlyReads) {
				if (!dispatch.resultCommitStarted) {
					try {
						await dispatch.scheduler.discardDeferredResults()
					} catch (error) {
						discardError ??= error instanceof Error ? error : new Error(String(error))
					}
				}
			}
		}
		if (!ownsTerminalStep()) return supersededResult(discardError)
		const terminalResults: { persisted: boolean; error?: Error; superseded?: boolean } = assistantPersisted
			? await this.persistTerminalToolResults(response, status, earlyDispatches, true, ownsTerminalStep)
			: { persisted: false, ...(discardError ? { error: discardError } : {}) }
		const receiptsPersisted = terminalResults.persisted
		if (terminalResults.superseded || !ownsTerminalStep()) return supersededResult(terminalResults.error)
		if (assistantPersisted && receiptsPersisted) {
			const responseCallIds = new Set(response.toolCalls.map((call) => sanitizeToolUseId(call.id)))
			const missingAcceptedReads = completedEarlyReads.filter(
				(dispatch) => !responseCallIds.has(sanitizeToolUseId(dispatch.call.id)),
			)
			try {
				for (const dispatch of missingAcceptedReads) {
					if (!ownsTerminalStep()) return supersededResult()
					await this.publishCanonicalLifecycleToolResult(
						{
							callId: dispatch.call.id,
							status: "error",
							content: "The finalized provider response omitted a durably accepted read call.",
						},
						terminalStep,
						{ durable: true, required: true, guard: ownsTerminalStep },
					)
					if (!ownsTerminalStep()) return supersededResult()
				}
				if (missingAcceptedReads.length > 0) {
					await this.canonicalLifecycleQueue
					if (!ownsTerminalStep()) return supersededResult()
					await this.replayCanonicalLifecycle()
					if (!ownsTerminalStep()) return supersededResult()
					const lifecycle = this.getCanonicalLifecycleSnapshot()
					if (
						lifecycle &&
						(lifecycle.runId !== terminalRunId ||
							lifecycle.turnId !== terminalTurnId ||
							(lifecycle.currentStepId !== undefined && lifecycle.currentStepId !== terminalStepId) ||
							!lifecycle.steps.some((step) => step.stepId === terminalStepId) ||
							missingAcceptedReads.some(
								(dispatch) =>
									!lifecycle.items.some(
										(item) =>
											item.type === "tool_call" &&
											item.toolCallId === sanitizeToolUseId(dispatch.call.id) &&
											item.stepId === terminalStepId,
									),
							))
					)
						return supersededResult()
					const reconciled =
						lifecycle &&
						(await this.reconcileRecoveredCanonicalToolCallTranscript(lifecycle, ownsTerminalStep))
					if (!ownsTerminalStep()) return supersededResult()
					if (!reconciled) {
						throw new TaskPersistenceError(
							"Mismatched early read calls could not be paired in provider history.",
						)
					}
				}
			} catch (error) {
				if (!ownsTerminalStep()) return supersededResult()
				throw error
			}
		}
		const persistenceFailures = [
			!assistantPersisted ? "The assistant response could not be durably saved." : undefined,
			response.toolCalls.length > 0 && !receiptsPersisted
				? "Terminal tool-result receipts could not be durably saved."
				: undefined,
			terminalResults.error?.message,
		].filter((message): message is string => Boolean(message))
		const terminalReason = [reason, ...persistenceFailures].filter(Boolean).join(" ")
		const persistenceFailed = persistenceFailures.length > 0
		const taskWasCancelled = this.abort || this.getTaskLifetimeCancellationSignal().aborted
		const terminalStatus = taskWasCancelled
			? "aborted"
			: persistenceFailed
				? "failed"
				: status === "cancelled"
					? "aborted"
					: status
		const persistenceError =
			terminalResults.error ??
			(persistenceFailed ? new TaskPersistenceError(persistenceFailures.join(" ")) : undefined)

		await this.appendAgentTurnEvent(
			{
				type: "response_terminal",
				status: terminalStatus,
				reason: terminalReason,
				retryable: response.outcome?.retryable,
			},
			terminalStep?.snapshot.context,
		)
		if (!ownsTerminalStep()) return supersededResult(persistenceError)

		return {
			assistantPersisted,
			receiptsPersisted,
			status: terminalStatus,
			reason: terminalReason,
			...(persistenceError ? { error: persistenceError } : {}),
		}
	}

	private async saveApiConversationHistory(
		guard?: CanonicalLifecycleEventGuard,
		stagedMessages?: readonly ApiMessage[],
	): Promise<boolean> {
		if (guard && !guard()) return false
		if (
			(Task.apiConversationHistoryPendingCounts.get(this.apiConversationHistoryPersistenceKey) ?? 0) >=
			Task.MAX_PENDING_TRANSCRIPT_SAVES
		) {
			this.recordProviderTranscriptSidecarFailure(
				new ProviderTranscriptStoreError("queue_full", "Transcript persistence queue is full", this.taskId),
			)
			return false
		}
		// Capture the intended legacy snapshot before entering the queue. Each
		// caller therefore commits the history state it observed, while calls made
		// after a later mutation remain ordered behind it and cannot race a write.
		const resumeHistoryRepair =
			this.pendingResumeHistoryRepair &&
			this.apiConversationHistory.includes(this.pendingResumeHistoryRepair.message)
				? this.pendingResumeHistoryRepair
				: undefined
		const messages = structuredClone(stagedMessages ? [...stagedMessages] : this.apiConversationHistory)
		const failureGeneration = this.apiConversationHistoryFailureGeneration

		return this.enqueueApiConversationHistoryPersistence(async () => {
			if ((guard && !guard()) || !this.isCurrentApiConversationHistoryOwner()) {
				// A replacement Task has taken ownership of this task ID. The old
				// instance must not write its captured snapshot after that handoff.
				return false
			}
			let legacyReceipt: Awaited<ReturnType<typeof saveApiMessages>>
			try {
				// Keep this write first: api_conversation_history.json remains the
				// provider/runtime source of truth throughout the migration.
				legacyReceipt = await saveApiMessages({
					messages,
					taskId: this.taskId,
					globalStoragePath: this.globalStoragePath,
				})
			} catch (error) {
				// Do not create or advance the sidecar when the authoritative write
				// failed. Returning false keeps callers from executing effects or
				// acknowledging a turn whose legacy history is not durable.
				if (guard && !guard()) return false
				console.error("Failed to save API conversation history:", error)
				this.recordProviderTranscriptSidecarFailure(error)
				return false
			}

			try {
				let receipt: ProviderTranscriptCommitReceipt
				try {
					receipt = await this.providerTranscriptStore.commitAuthoritativeTranscript(legacyReceipt)
				} catch (error) {
					if (
						!(error instanceof ProviderTranscriptStoreError) ||
						!["invalid_envelope", "invalid_messages", "task_mismatch", "digest_mismatch"].includes(
							error.code,
						)
					)
						throw error
					receipt = await this.providerTranscriptStore.repairAuthoritativeTranscript(legacyReceipt)
				}
				await this.providerTranscriptStore.assertCommitReceipt(receipt)
				// An admitted legacy/sidecar transaction finishes coherently; only its
				// local acknowledgements must stop when the original step is replaced.
				if (guard && !guard()) return false
				// An admission/write failure that occurred after this snapshot was
				// accepted cannot be acknowledged away by that older queued save.
				if (failureGeneration !== this.apiConversationHistoryFailureGeneration) return false
				this.providerTranscriptCommitReceipt = receipt
				this.providerTranscriptSidecarFailure = undefined
				if (resumeHistoryRepair) resumeHistoryRepair.persisted = true
				this.providerRef.deref()?.retryIndependentTaskCompletionsForParent?.(this.taskId)
				return true
			} catch (error) {
				// The legacy write succeeded, but a sidecar failure is still reported
				// as a failed Task persistence boundary. This conservative result is
				// intentional: callers must retry before exposing effects, while a
				// later restart can safely backfill from the legacy file.
				if (guard && !guard()) return false
				this.recordProviderTranscriptSidecarFailure(error)
				return false
			}
		})
	}

	/**
	 * Wait for every legacy/sidecar transcript transaction currently accepted for
	 * this task ID. Provider replacement/cancellation paths call this before
	 * exposing a new Task instance so an old snapshot cannot land afterward.
	 */
	public async flushApiConversationHistoryPersistence(guard?: CanonicalLifecycleEventGuard): Promise<void> {
		for (;;) {
			if (guard && !guard()) return
			const queued = Task.apiConversationHistorySaveQueues.get(this.apiConversationHistoryPersistenceKey)
			if (!queued) break
			await queued
			if (guard && !guard()) return
			if (Task.apiConversationHistorySaveQueues.get(this.apiConversationHistoryPersistenceKey) === queued) break
		}
		if (guard && !guard()) return
		if (this.providerTranscriptSidecarFailure) throw this.providerTranscriptSidecarFailure
	}

	private isCurrentApiConversationHistoryOwner(): boolean {
		return (
			Task.apiConversationHistoryOwnerGenerations.get(this.apiConversationHistoryPersistenceKey) ===
			this.apiConversationHistoryOwnerGeneration
		)
	}

	/** Serialize every legacy/sidecar transcript transaction across Task instances. */
	private enqueueApiConversationHistoryPersistence<T>(operation: () => Promise<T>): Promise<T> {
		const pending = Task.apiConversationHistoryPendingCounts.get(this.apiConversationHistoryPersistenceKey) ?? 0
		if (pending >= Task.MAX_PENDING_TRANSCRIPT_SAVES) {
			return Promise.reject(
				new ProviderTranscriptStoreError("queue_full", "Transcript persistence queue is full", this.taskId),
			)
		}
		Task.apiConversationHistoryPendingCounts.set(this.apiConversationHistoryPersistenceKey, pending + 1)
		const previous =
			Task.apiConversationHistorySaveQueues.get(this.apiConversationHistoryPersistenceKey) ?? Promise.resolve()
		const queued = previous.then(operation)
		const settled = queued.then(
			() => undefined,
			() => undefined,
		)
		Task.apiConversationHistorySaveQueues.set(this.apiConversationHistoryPersistenceKey, settled)
		this.apiConversationHistorySaveQueue = settled
		void settled.then(() => {
			const remaining =
				(Task.apiConversationHistoryPendingCounts.get(this.apiConversationHistoryPersistenceKey) ?? 1) - 1
			if (remaining === 0)
				Task.apiConversationHistoryPendingCounts.delete(this.apiConversationHistoryPersistenceKey)
			else Task.apiConversationHistoryPendingCounts.set(this.apiConversationHistoryPersistenceKey, remaining)
			if (Task.apiConversationHistorySaveQueues.get(this.apiConversationHistoryPersistenceKey) === settled) {
				Task.apiConversationHistorySaveQueues.delete(this.apiConversationHistoryPersistenceKey)
			}
		})
		return queued
	}

	/**
	 * Backfill older/mixed sidecars against a successfully read legacy snapshot.
	 * Real saves use compact v2 receipts; this compatibility path retains v1
	 * recovery and CAS retries without interpreting unreadable history as empty.
	 */
	private async reconcileProviderTranscriptSidecar(
		messages: ApiMessage[],
	): Promise<ProviderTranscriptCommitReceipt | undefined> {
		const expectedDigest = digestProviderTranscript(messages)
		let current: Awaited<ReturnType<ProviderTranscriptStore["read"]>>
		try {
			current = await this.providerTranscriptStore.read()
		} catch (error) {
			// A malformed or digest-invalid sidecar is recoverable because the
			// legacy transcript is still authoritative. Quarantine the bad envelope
			// and rebuild it before the next continuation can depend on a receipt.
			if (
				error instanceof ProviderTranscriptStoreError &&
				(error.code === "invalid_envelope" ||
					error.code === "invalid_messages" ||
					error.code === "task_mismatch" ||
					error.code === "digest_mismatch")
			) {
				const receipt = await this.providerTranscriptStore.repairFromAuthoritativeTranscript(messages)
				await this.providerTranscriptStore.verifyCommitReceipt(receipt)
				return receipt
			}
			throw error
		}

		for (let attempt = 0; attempt < 3; attempt++) {
			if (current.revision === 0 && messages.length === 0) return undefined

			if (current.revision > 0 && current.digest === expectedDigest) {
				const receipt = this.providerTranscriptStore.getLastCommitReceipt()
				if (!receipt) {
					throw new ProviderTranscriptStoreError(
						"receipt_mismatch",
						`Provider transcript task ${this.taskId} has no receipt for revision ${current.revision}`,
						this.taskId,
					)
				}
				await this.providerTranscriptStore.verifyCommitReceipt(receipt)
				return receipt
			}

			try {
				const receipt = await this.providerTranscriptStore.commit({
					messages,
					expectedRevision: current.revision,
				})
				await this.providerTranscriptStore.verifyCommitReceipt(receipt)
				return receipt
			} catch (error) {
				if (!(error instanceof ProviderTranscriptRevisionConflictError) || attempt === 2) throw error
				// Another Task instance committed the sidecar between read and CAS.
				// Re-read under the store's verification path and compare again rather
				// than overwriting a newer transcript blindly.
				current = await this.providerTranscriptStore.read()
			}
		}

		throw new ProviderTranscriptStoreError(
			"revision_conflict",
			`Provider transcript task ${this.taskId} could not be reconciled after concurrent commits`,
			this.taskId,
		)
	}

	private recordProviderTranscriptSidecarFailure(error: unknown): void {
		this.apiConversationHistoryFailureGeneration++
		this.providerTranscriptCommitReceipt = undefined
		this.providerTranscriptSidecarFailure =
			error instanceof ProviderTranscriptStoreError
				? error
				: new ProviderTranscriptStoreError(
						"write_failed",
						`Provider transcript sidecar failed for task ${this.taskId}: ${error instanceof Error ? error.message : String(error)}`,
						this.taskId,
					)
		console.error(`[Task#${this.taskId}] Failed to reconcile provider transcript sidecar:`, error)
	}

	/**
	 * Public wrapper to retry saving the API conversation history.
	 * Uses exponential backoff: up to 3 attempts with delays of 100 ms, 500 ms, 1500 ms.
	 * Used by delegation flow when flushPendingToolResultsToHistory reports failure.
	 */
	public async retrySaveApiConversationHistory(
		onPersisted?: () => void,
		signal?: AbortSignal,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<boolean> {
		if (guard && !guard()) return false
		const delays = [100, 500, 1500]

		for (let attempt = 0; attempt < delays.length; attempt++) {
			await delayWithAbort(delays[attempt], signal)
			if (guard && !guard()) return false
			console.warn(
				`[Task#${this.taskId}] retrySaveApiConversationHistory: retry attempt ${attempt + 1}/${delays.length}`,
			)

			const success = guard
				? await this.saveApiConversationHistory(guard)
				: await this.saveApiConversationHistory()
			if (guard && !guard()) return false

			if (success) {
				onPersisted?.()
				if (guard && !guard()) return false
				if (guard) await this.settleAllPersistedWaitAgentResultClaims(guard)
				else await this.settleAllPersistedWaitAgentResultClaims()
				if (guard && !guard()) return false
				return true
			}
		}

		return false
	}

	private async recordFinalizedAssistantMemoryUsage(
		message: Anthropic.MessageParam,
		response: AgentResponse | undefined,
		step: CurrentAgentStep | undefined,
	): Promise<void> {
		if (
			message.role !== "assistant" ||
			!response ||
			!step ||
			!this.memory.useMemories ||
			this.taskKind === "subagent" ||
			this.diagnosticSession ||
			(response.outcome && response.outcome.status !== "completed")
		)
			return
		const references = assistantMemoryCitationReferences(response)
		if (!references.length) return
		const eventKey = crypto
			.createHash("sha256")
			.update(JSON.stringify([this.taskId, step.stepId, step.attemptId]))
			.digest("hex")
		try {
			await this.providerRef.deref()?.recordMemoryUsage(references, eventKey)
		} catch {
			// Learned-memory ranking is optional; an unavailable store cannot undo a
			// successfully persisted assistant response or expose its private text.
			console.warn(`[Task#${this.taskId}] Alpha memory citation usage is unavailable`)
		}
	}

	private async persistAssistantResponseBeforeEffects(
		message: Anthropic.MessageParam,
		reasoning?: string,
		response?: AgentResponse,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<boolean> {
		const ownsResponse = guard ?? this.captureAgentStepOwnership()
		const responseStep = this.currentAgentStep
		if (!ownsResponse()) return false
		let canonicalAnthropicThinkingProjected = false
		const goalStep = this.activeGoalStep
		if (goalStep && this.currentAgentStep?.snapshot.context.mode.slug === "architect") {
			goalStep.responseAccounted = true
			goalStep.finished = true
		}
		if (goalStep && response && this.currentAgentStep?.snapshot.context.mode.slug !== "architect") {
			const stepId = this.currentAgentStep?.stepId
			if (stepId) {
				goalStep.eventId = `goal-step:${crypto
					.createHash("sha256")
					.update(this.taskId)
					.update(stepId)
					.update(this.currentAgentStep?.attemptId ?? "")
					.digest("hex")}`
			}
			goalStep.responseAccounted = false
			goalStep.inputIncludesCache = this.currentAgentStep?.snapshot.context.provider.apiProtocol !== "anthropic"
			goalStep.usageReceipt = {
				goalTaskId: goalStep.goalTaskId,
				goalId: goalStep.goalId,
				eventId: `${goalStep.eventId}:usage`,
				tokens: goalResponseTokens(response, goalStep.inputIncludesCache),
				timeMs: goalStep.accountElapsed
					? Math.max(0, Date.now() - goalStep.startedAt - (goalStep.elapsedChargedMs ?? 0))
					: 0,
			}
			;(message as ApiMessage).goal_usage_receipts = [goalStep.usageReceipt]
		}
		if (response) {
			const canonicalMessage = message as Anthropic.MessageParam & {
				agentResponseItems?: AgentResponseItem[]
				agentResponseOutcome?: AgentResponse["outcome"]
			}
			canonicalMessage.agentResponseItems = response.items.map((item) => ({ ...item }))
			if (response.outcome) canonicalMessage.agentResponseOutcome = { ...response.outcome }

			if (message.role === "assistant") {
				const provider = this.apiConfiguration.apiProvider
				const modelId = getModelId(this.apiConfiguration)
				const apiProtocol =
					this.currentAgentStep?.snapshot.context.provider.apiProtocol ??
					getApiProtocol(isProviderName(provider) ? provider : undefined, modelId)
				const thinkingContent =
					apiProtocol === "anthropic" ? buildCanonicalAnthropicAssistantHistoryContent(response) : undefined
				if (thinkingContent) {
					canonicalMessage.content = thinkingContent
					canonicalAnthropicThinkingProjected = true
				}
			}
		}
		const saved = await this.addToApiConversationHistory(
			message,
			reasoning,
			undefined,
			canonicalAnthropicThinkingProjected,
		)
		if (!ownsResponse()) return false
		if (!saved && !(await this.retrySaveApiConversationHistory())) {
			if (!ownsResponse()) return false
			this.assistantMessageSavedToHistory = false
			this.suspendAfterCurrentTurn(
				"The assistant response could not be saved, so the turn stopped before executing tool calls or making another model request.",
			)
			return false
		}
		if (!ownsResponse()) return false

		this.assistantMessageSavedToHistory = true
		await this.recordFinalizedAssistantMemoryUsage(message, response, responseStep)
		if (!ownsResponse()) return false
		if (response) await this.publishCanonicalLifecycleResponseItems(response, responseStep, ownsResponse)
		if (!ownsResponse()) return false
		await this.publishCanonicalLifecyclePendingToolResults(response, responseStep, ownsResponse)
		if (!ownsResponse()) return false
		if (response) await accountGoalResponse(goalStep, response)
		return ownsResponse()
	}

	/**
	 * Reserve the immutable captured descriptor for a complete streamed call.
	 * This is a pure preflight lookup; approvals and effects remain behind EOF and
	 * the assistant transcript commit fence.
	 */
	private reserveStreamingToolCall(call: AgentToolCall): ReturnType<TaskToolSurface["resolve"]> {
		return this.currentTaskToolSurface?.resolve(call.name)
	}

	/** Execute only the complete, accumulator-authoritative calls from a persisted response. */
	private async executeCanonicalToolCallsForTurn(
		response: AgentResponse,
		surface: TaskToolSurface | undefined,
		mode: string,
		state: TaskRequestState | undefined,
	): Promise<ToolSchedulerOutcome> {
		// The provider stream owns its request controller only until EOF. Tool
		// execution happens after that boundary, so give the scheduler a fresh
		// controller that remains reachable by steering and explicit cancellation.
		// Otherwise currentRequestSignal still exists but there is no controller left
		// to abort it while a long-running tool is active.
		const controller = new AbortController()
		const signal = controller.signal
		const taskSignal = this.getTaskLifetimeCancellationSignal()
		const abortFromTask = () => {
			if (!signal.aborted) controller.abort(taskSignal.reason)
		}

		this.currentRequestAbortController = controller
		this.currentRequestSignal = signal
		if (taskSignal.aborted) {
			abortFromTask()
		} else {
			taskSignal.addEventListener("abort", abortFromTask, { once: true })
		}
		// Steering can arrive after the provider reaches EOF but before this
		// controller is installed. Fail closed before starting any tool effect in
		// that race; the pending message is consumed by the next agent turn.
		if (this.abort || this.pendingSteerMessage) {
			controller.abort(new Error(this.abort ? "Task was aborted" : "Tool execution was interrupted by steering"))
		}

		try {
			return await this.executeCanonicalToolCalls(response, surface, mode, state, signal)
		} finally {
			taskSignal.removeEventListener("abort", abortFromTask)
			if (this.currentRequestAbortController === controller) {
				this.currentRequestAbortController = undefined
			}
			if (this.currentRequestSignal === signal) {
				this.currentRequestSignal = undefined
			}
		}
	}

	/** Execute only the complete, accumulator-authoritative calls from a persisted response. */
	private async executeCanonicalToolCalls(
		response: AgentResponse,
		surface: TaskToolSurface | undefined,
		mode: string,
		state: TaskRequestState | undefined,
		signal: AbortSignal,
		options: CanonicalToolExecutionOptions = {},
	): Promise<ToolSchedulerOutcome> {
		if (response.toolCalls.length === 0) {
			return {
				status: "completed",
				results: [],
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
			}
		}
		const configuredHooks = this.completionHookConfig
		const hookInvocation =
			configuredHooks?.preToolUse?.length ||
			configuredHooks?.postToolUse?.length ||
			configuredHooks?.permissionRequest?.length
				? this.captureLifecycleHookInvocation()
				: undefined
		const hookStep = this.currentAgentStep
		const hookIdentity = hookStep
			? {
					turnId: hookStep.turnId,
					stepId: hookStep.stepId,
					requestId: hookStep.requestId,
					attemptId: hookStep.attemptId,
					correlationId: hookStep.stepId,
				}
			: undefined
		const ownsHookBoundary = () => hookInvocation?.guard() ?? true
		const hookAbortController = new AbortController()
		const schedulerSignal = hookInvocation ? AbortSignal.any([signal, hookAbortController.signal]) : signal
		const assertHookBoundary = () => {
			if (ownsHookBoundary()) return
			const error = new LifecycleHookOwnershipError()
			// Abort this scheduler before its adapters can translate the loss into an ordinary tool error.
			hookAbortController.abort(error)
			throw error
		}
		const invokeForHookOwner = async <T>(operation: () => Promise<T>): Promise<T> => {
			assertHookBoundary()
			try {
				return await operation()
			} finally {
				assertHookBoundary()
			}
		}
		// Object accessors have their own receiver; keep their Task target lexical.
		const getTask = () => this
		const discardedHookContent: Task["userMessageContent"] = []
		const admitsHookMutation = () => {
			if (ownsHookBoundary()) return true
			hookAbortController.abort(new LifecycleHookOwnershipError())
			return false
		}
		const executionHost: ToolExecutionHost | undefined = hookInvocation
			? {
					taskId: this.taskId,
					taskKind: this.taskKind,
					cwd: this.cwd,
					taskFacade: this,
					ownsLifecyclePublication: ownsHookBoundary,
					get abort() {
						return !admitsHookMutation() || getTask().abort
					},
					get userMessageContent() {
						return admitsHookMutation() ? getTask().userMessageContent : discardedHookContent
					},
					get userMessageContentReady() {
						return ownsHookBoundary() ? getTask().userMessageContentReady : false
					},
					set userMessageContentReady(value: boolean | undefined) {
						if (value !== undefined && admitsHookMutation()) getTask().userMessageContentReady = value
					},
					get didToolFailInCurrentTurn() {
						return ownsHookBoundary() ? getTask().didToolFailInCurrentTurn : false
					},
					set didToolFailInCurrentTurn(value: boolean | undefined) {
						if (value !== undefined && admitsHookMutation()) getTask().didToolFailInCurrentTurn = value
					},
					ask: (...args) => invokeForHookOwner(() => getTask().ask(...args)),
					requestToolApproval: (...args) => invokeForHookOwner(() => getTask().requestToolApproval(...args)),
					persistCommandApprovalPrefix: (prefix) =>
						invokeForHookOwner(() => getTask().persistCommandApprovalPrefix(prefix)),
					say: (...args) => invokeForHookOwner(() => getTask().say(...args)),
					recordToolUsage: (name) => {
						if (admitsHookMutation()) getTask().recordToolUsage(name as ToolName)
					},
					pushToolResultToUserContent: (result) =>
						admitsHookMutation() && getTask().pushToolResultToUserContent(result),
					hasToolResultForCall: (callId) => ownsHookBoundary() && getTask().hasToolResultForCall(callId),
					shouldStopRepeatedToolCall: (name, args) =>
						!ownsHookBoundary() || getTask().shouldStopRepeatedToolCall(name, args),
					getToolRetryBlock: (name, args) =>
						ownsHookBoundary() ? getTask().getToolRetryBlock(name, args) : undefined,
					recordToolCallForStopping: (name, args, status, category, result, assertOwnership) =>
						invokeForHookOwner(() =>
							getTask().recordToolCallForStopping(name, args, status, category, result, () => {
								assertHookBoundary()
								assertOwnership?.()
							}),
						),
				}
			: undefined
		const runSchedulerHook = async (payload: LifecycleHookPayload, hookSignal: AbortSignal) => {
			assertHookBoundary()
			try {
				return await this.runTaskLifecycleHook(payload, hookSignal, hookInvocation)
			} finally {
				assertHookBoundary()
			}
		}
		const failedBeforeScheduler = async (error: unknown): Promise<ToolSchedulerOutcome> => {
			assertHookBoundary()
			const message = error instanceof Error ? error.message : String(error)
			const content = `Tool call was not executed because tool execution could not start: ${message}`
			const results: ToolSchedulerResult[] = response.toolCalls.map((call) => ({
				callId: call.id,
				name: call.name,
				status: "error",
				content: formatResponse.toolError(content),
				executionStatus: "error",
				durationMs: 0,
			}))
			if (options.deferResultCommit) {
				return {
					status: "failed",
					results,
					batchSize: results.length,
					parallelBatchCount: 0,
					parallelToolCount: 0,
					durationMs: 0,
					approvalRequestCount: 0,
					approvalDeniedCount: 0,
					approvalCancelledCount: 0,
					supersededAskCount: 0,
					completedToolResultCount: results.length,
					outputTruncatedCount: 0,
					failure: { kind: "effect_fence", callId: response.toolCalls[0]!.id, message },
				}
			}
			for (const result of results) {
				assertHookBoundary()
				this.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: sanitizeToolUseId(result.callId),
					content,
					is_error: true,
				})
				await this.publishCanonicalLifecycleToolResult(
					{ callId: result.callId, status: result.status, content: result.content },
					hookInvocation ? hookStep : this.currentAgentStep,
					hookInvocation ? { guard: ownsHookBoundary } : undefined,
				)
				assertHookBoundary()
			}
			this.userMessageContentReady = true
			const persisted = await this.flushPendingToolResultsToHistory({
				allowAborted: true,
				...(hookInvocation ? { guard: ownsHookBoundary } : {}),
			})
			assertHookBoundary()
			const failureMessage = persisted ? message : `${message} Tool-result receipts could not be durably saved.`
			return {
				status: "failed",
				results,
				batchSize: results.length,
				parallelBatchCount: 0,
				parallelToolCount: 0,
				durationMs: 0,
				approvalRequestCount: 0,
				approvalDeniedCount: 0,
				approvalCancelledCount: 0,
				supersededAskCount: 0,
				completedToolResultCount: results.length,
				outputTruncatedCount: 0,
				failure: { kind: "effect_fence", callId: response.toolCalls[0]!.id, message: failureMessage },
			}
		}
		if (!surface) {
			const error = new Error("A captured tool surface is required before executing provider tool calls.")
			return failedBeforeScheduler(error)
		}
		try {
			if (options.earlyReadStep) {
				for (const call of response.toolCalls) {
					await this.assertDurableAcceptedReadonlyToolCallBeforeEffects(
						call,
						surface,
						options.earlyReadStep,
						signal,
					)
				}
			} else {
				await this.assertCurrentProviderTranscriptBeforeEffects()
			}
			assertHookBoundary()
		} catch (error) {
			return failedBeforeScheduler(error)
		}

		const earlyReadStep = options.earlyReadStep
		const earlyReadRunId = this.agentRunId
		const earlyReadIdentity = earlyReadStep
			? {
					turnId: earlyReadStep.turnId,
					stepId: earlyReadStep.stepId,
					requestId: earlyReadStep.requestId,
					attemptId: earlyReadStep.attemptId,
				}
			: undefined
		const ownsEarlyRead = () =>
			earlyReadStep !== undefined &&
			this.isCurrentApiConversationHistoryOwner() &&
			this.currentAgentStep === earlyReadStep &&
			this.agentRunId === earlyReadRunId &&
			this.agentTurnId === earlyReadIdentity?.turnId &&
			earlyReadStep.turnId === earlyReadIdentity?.turnId &&
			earlyReadStep.stepId === earlyReadIdentity?.stepId &&
			earlyReadStep.requestId === earlyReadIdentity?.requestId &&
			earlyReadStep.attemptId === earlyReadIdentity?.attemptId &&
			this.currentTaskToolSurface === surface &&
			earlyReadStep.surface === surface
		const scheduler = new ToolScheduler({
			task: this,
			executionHost,
			registry: surface.registry,
			policy: surface.policy,
			readGrant: surface.readGrant,
			bundledSkillExtensionPath: (hookInvocation ? hookInvocation.provider : this.providerRef.deref())
				?.contextProxy?.extensionUri?.fsPath,
			mode,
			customModes: state?.customModes,
			experiments: state?.experiments,
			disabledTools: this.getDisabledToolsForStep(state),
			// Opt-in editors were already selected and authority-filtered at this step's capture boundary.
			includedTools: [...surface.allowedFunctionNames],
			signal: schedulerSignal,
			executionMode: "selective-parallel",
			maxConcurrency: 4,
			get preserveAbortedResults() {
				return ownsHookBoundary()
			},
			deferResultCommit: options.deferResultCommit,
			requirePreparedCommandRead: options.earlyReadStep !== undefined,
			beforeEffect: async (call) => {
				assertHookBoundary()
				try {
					if (options.earlyReadStep) {
						await this.assertDurableAcceptedReadonlyToolCallBeforeEffects(
							call,
							surface,
							options.earlyReadStep,
							schedulerSignal,
						)
					} else {
						await this.assertCurrentProviderTranscriptBeforeEffects()
					}
				} finally {
					assertHookBoundary()
				}
			},
			...((hookInvocation?.config ?? configuredHooks)?.preToolUse?.length
				? {
						preToolUse: async (call: Readonly<AgentToolCall>, hookSignal: AbortSignal) => {
							const outcome = await runSchedulerHook(
								{
									hook_event_name: "PreToolUse",
									tool_name: call.name,
									tool_use_id: call.id,
									tool_input: call.arguments as Record<string, unknown>,
								},
								hookSignal,
							)
							return {
								...(outcome.shouldBlock
									? { denied: outcome.blockReason ?? t("common:lifecycleHooks.preToolBlocked") }
									: {}),
								...(outcome.updatedInput ? { updatedInput: outcome.updatedInput } : {}),
							}
						},
					}
				: {}),
			...((hookInvocation?.config ?? configuredHooks)?.postToolUse?.length
				? {
						postToolUse: async (
							call: Readonly<AgentToolCall>,
							result: Readonly<ToolSchedulerOutcome["results"][number]>,
							hookSignal: AbortSignal,
						) => {
							const outcome = await runSchedulerHook(
								{
									hook_event_name: "PostToolUse",
									tool_name: call.name,
									tool_use_id: call.id,
									tool_input: call.arguments as Record<string, unknown>,
									tool_response: {
										status: result.status,
										execution_status: result.executionStatus,
										exit_code: result.exitCode,
										content: result.content,
									},
								},
								hookSignal,
							)
							return {
								...(outcome.shouldBlock
									? {
											blocked:
												outcome.feedbackMessage ??
												outcome.blockReason ??
												t("common:lifecycleHooks.postToolBlocked"),
										}
									: {}),
								...(outcome.feedbackMessage ? { feedback: outcome.feedbackMessage } : {}),
							}
						},
					}
				: {}),
			...((hookInvocation?.config ?? configuredHooks)?.permissionRequest?.length
				? {
						permissionRequest: async (call: Readonly<AgentToolCall>, hookSignal: AbortSignal) => {
							const outcome = await runSchedulerHook(
								{
									hook_event_name: "PermissionRequest",
									tool_name: call.name,
									tool_input: call.arguments as Record<string, unknown>,
								},
								hookSignal,
							)
							return outcome.shouldBlock
								? { denied: outcome.blockReason ?? t("common:lifecycleHooks.permissionDenied") }
								: {}
						},
					}
				: {}),
			onEffectStart: async (call) => {
				assertHookBoundary()
				const toolCallId = sanitizeToolUseId(call.id)
				if (!toolCallId) throw new Error("Effectful tool call has no valid lifecycle call ID.")
				const step = hookInvocation ? hookStep : this.currentAgentStep
				if (!step) throw new Error("Effectful tool call has no active lifecycle step.")
				await this.enqueueCanonicalLifecycleEvent(
					"tool_effect_started",
					{ toolCallId },
					step.stepId,
					() => ownsHookBoundary() && this.currentAgentStep?.stepId === step.stepId && !this.abort,
					{ durable: true, required: true },
				)
				assertHookBoundary()
				const snapshot = this.getCanonicalLifecycleSnapshot()
				if (
					!snapshot ||
					snapshot.runId !== this.agentRunId ||
					snapshot.turnId !== this.agentTurnId ||
					!snapshot.effectStartedToolCallIds.includes(toolCallId)
				) {
					throw new Error("Effect-start intent was not durably recorded; tool execution is blocked.")
				}
			},
			onEvent: async (event: AgentTurnEvent) => {
				if (event.type === "tool_batch_finished" && !ownsHookBoundary()) return
				assertHookBoundary()
				if (options.deferResultCommit && !ownsEarlyRead()) {
					throw new TaskPersistenceError("The deferred read no longer owns its lifecycle step.")
				}
				await this.appendAgentTurnEvent(
					event,
					(hookInvocation ? hookStep : earlyReadStep)?.snapshot.context,
					hookInvocation
						? hookIdentity
						: earlyReadIdentity
							? { ...earlyReadIdentity, correlationId: earlyReadIdentity.stepId }
							: undefined,
				)
				assertHookBoundary()
				if (options.deferResultCommit && !ownsEarlyRead()) {
					throw new TaskPersistenceError("The deferred read lifecycle publication was superseded.")
				}
				if (options.deferResultCommit && event.type === "tool_result") {
					await this.publishCanonicalLifecycleToolResult(
						{ callId: event.callId, status: event.status, content: event.output },
						earlyReadStep,
						{ durable: true, required: true, guard: ownsEarlyRead },
					)
				} else {
					await this.publishCanonicalLifecycleSchedulerEvent(
						event,
						hookInvocation ? hookStep : undefined,
						hookInvocation ? ownsHookBoundary : undefined,
					)
				}
				assertHookBoundary()
			},
		})
		options.onSchedulerCreated?.(scheduler)
		try {
			assertHookBoundary()
			const outcome = await scheduler.run(response)
			assertHookBoundary()
			// abortOutcome fills deterministic cancelled results without invoking the
			// scheduler event callback. Reconcile the complete result set here so every
			// accepted canonical call has a terminal lifecycle receipt before the turn
			// can close; the helper is idempotent for normal callback-delivered results.
			const returnedCallIds = new Set<string>()
			for (const result of options.deferResultCommit ? [] : outcome.results) {
				const callId = sanitizeToolUseId(result.callId)
				if (callId) returnedCallIds.add(callId)
				await this.publishCanonicalLifecycleToolResult(
					{ callId: result.callId, status: result.status, content: result.content },
					hookInvocation ? hookStep : this.currentAgentStep,
					hookInvocation ? { guard: ownsHookBoundary } : undefined,
				)
				assertHookBoundary()
			}
			// A scheduler implementation must return one result per accepted call.
			// Close any omitted calls before the turn-terminal event instead of
			// allowing the reducer to strand the turn in progress.
			for (const call of options.deferResultCommit ? [] : response.toolCalls) {
				if (returnedCallIds.has(sanitizeToolUseId(call.id))) continue
				await this.publishCanonicalLifecycleToolResult(
					{
						callId: call.id,
						status: outcome.status === "aborted" ? "cancelled" : "error",
						content:
							outcome.status === "aborted"
								? "Tool call was not executed because the task was cancelled."
								: "Tool call did not produce a scheduler result.",
					},
					hookInvocation ? hookStep : this.currentAgentStep,
					hookInvocation ? { guard: ownsHookBoundary } : undefined,
				)
				assertHookBoundary()
			}
			if (outcome.status === "failed" && !options.deferResultCommit) {
				// The scheduler stages its complete truthful result set (including
				// successful earlier calls and deterministic failures for blocked calls).
				// Persist that exact batch before the failed turn can terminate.
				const persisted = await this.flushPendingToolResultsToHistory({
					allowAborted: true,
					...(hookInvocation ? { guard: ownsHookBoundary } : {}),
				})
				assertHookBoundary()
				if (!persisted && outcome.failure) {
					outcome.failure.message = `${outcome.failure.message} Tool-result receipts could not be durably saved.`
				}
			}
			return outcome
		} catch (error) {
			assertHookBoundary()
			// Unexpected host failures still close the durable provider transcript;
			// known per-call fence failures return a richer truthful failed outcome
			// directly from ToolScheduler above.
			return failedBeforeScheduler(error)
		}
	}

	/**
	 * The assistant history write and its provider sidecar receipt form the
	 * effect fence. Verify both the receipt and the exact in-memory snapshot
	 * immediately before the scheduler (and again before each tool) starts.
	 */
	private async assertCurrentProviderTranscriptBeforeEffects(): Promise<void> {
		if (!this.assistantMessageSavedToHistory) {
			throw new Error("Cannot execute tool effects before the assistant transcript is persisted.")
		}
		const receipt = this.providerTranscriptCommitReceipt
		if (!receipt) {
			throw new Error("Cannot execute tool effects without a provider transcript commit receipt.")
		}
		const expectedDigest = digestProviderTranscript(this.apiConversationHistory)
		if (receipt.digest !== expectedDigest) {
			throw new Error("Provider transcript receipt is stale relative to the current assistant history.")
		}
		await this.providerTranscriptStore.assertCommitReceipt(receipt)
	}

	/** A narrowly scoped pre-EOF fence for one durably accepted, audited read. */
	private async assertDurableAcceptedReadonlyToolCallBeforeEffects(
		call: AgentToolCall,
		surface: TaskToolSurface,
		step: CurrentAgentStep,
		signal: AbortSignal,
	): Promise<void> {
		const preEofReadonlyCall = await this.isPreEofReadonlyToolCall(call, surface)
		if (
			this.currentAgentStep !== step ||
			step.surface !== surface ||
			this.currentTaskToolSurface !== surface ||
			!surface.isCallable(call.name) ||
			!preEofReadonlyCall ||
			signal.aborted ||
			this.abort ||
			this.pendingSteerMessage !== undefined ||
			this.getTaskLifetimeCancellationSignal().aborted
		) {
			throw new Error("Pre-EOF execution is limited to an uninterrupted captured, audited read.")
		}

		await this.canonicalLifecycleQueue
		const snapshot = this.getCanonicalLifecycleSnapshot()
		const toolCallId = sanitizeToolUseId(call.id)
		const accepted = snapshot?.items.find((item) => item.type === "tool_call" && item.toolCallId === toolCallId)
		if (
			!snapshot ||
			snapshot.runId !== this.agentRunId ||
			snapshot.turnId !== step.turnId ||
			snapshot.status !== "in_progress" ||
			!snapshot.acceptedToolCallIds.includes(toolCallId) ||
			snapshot.terminalToolCallIds.includes(toolCallId) ||
			accepted?.type !== "tool_call" ||
			accepted.stepId !== step.stepId ||
			accepted.name !== call.name ||
			JSON.stringify(accepted.arguments) !== JSON.stringify(call.arguments) ||
			snapshot.items.some(
				(item) => item.type === "approval" && item.toolCallId === toolCallId && item.status === "requested",
			)
		) {
			throw new Error("The completed tool item has no matching durable acceptance receipt for this step.")
		}
	}

	private async isPreEofReadonlyToolCall(call: AgentToolCall, surface: TaskToolSurface): Promise<boolean> {
		const descriptor = surface.resolve(call.name)
		if (!descriptor || !surface.isCallable(call.name)) return false
		const canonicalName = surface.registry.canonicalName(call.name)
		if (
			canonicalName !== "exec_command" ||
			call.name !== "exec_command" ||
			descriptor.name !== "exec_command" ||
			descriptor.prepareParallelCommand === undefined ||
			descriptor.isParallelCommandReadReady === undefined ||
			descriptor.capabilities.parallelCommandRead !== true ||
			descriptor.capabilities.controlFlow
		) {
			return false
		}
		const captured = surface.policy.capabilities.exec_command
		const args =
			call.arguments !== null && typeof call.arguments === "object" && !Array.isArray(call.arguments)
				? (call.arguments as Record<string, unknown>)
				: undefined
		const command = args?.cmd
		const requestedCwd = args?.workdir
		if (
			!args ||
			captured?.parallelCommandRead !== true ||
			captured.controlFlow ||
			typeof command !== "string" ||
			args?.verification != null ||
			(args?.workdir == null && args?.cwd != null && args.cwd !== ".") ||
			(requestedCwd != null && typeof requestedCwd !== "string")
		) {
			return false
		}

		try {
			const cwd = path.resolve(this.cwd, typeof requestedCwd === "string" ? requestedCwd : ".")
			if (!isPathWithinRoot(this.cwd, cwd) || !isPathAllowed(surface.policy, cwd, this.cwd)) return false
			// Syntactic reads can still require the serial handler for ignore rules, environment configuration,
			// or executable capabilities. Defer those calls without producing an early denial or serial effect.
			return (
				(await classifyCommandRead(command, this.cwd, cwd)) !== undefined &&
				(await descriptor.isParallelCommandReadReady(this, args, surface.policy))
			)
		} catch {
			return false
		}
	}

	private async appendAgentTurnEvent(
		event: AgentTurnEvent,
		context?: StepContext,
		identity?: AgentTurnEventIdentity,
	): Promise<void> {
		try {
			const step = this.currentAgentStep
			const resolvedContext = context ?? step?.snapshot.context
			const contextBelongsToActiveStep =
				step !== undefined &&
				resolvedContext !== undefined &&
				resolvedContext.contextId === step.snapshot.context.contextId
			const activeStepIdentity =
				!context || contextBelongsToActiveStep
					? step
						? {
								turnId: step.turnId,
								stepId: step.stepId,
								requestId: step.requestId,
								attemptId: step.attemptId,
								correlationId: step.stepId ?? step.turnId,
							}
						: undefined
					: undefined
			await this.agentTurnEventLog.append(event, resolvedContext, {
				...(activeStepIdentity ?? {}),
				...(identity ?? {}),
			})
		} catch (error) {
			// Event telemetry is additive to the legacy task contract. A telemetry
			// write must not turn a successful provider/tool step into a task failure.
			console.error(`[Task#${this.taskId}] Failed to append agent turn event:`, error)
		}
	}

	/** Record bounded, task-local timing evidence only in explicitly enabled eval runs. */
	public recordTaskPerformance(
		phase: Extract<AgentTurnEvent, { type: "task_performance" }>["phase"],
		startedAt: number,
		status: Extract<AgentTurnEvent, { type: "task_performance" }>["status"] = "completed",
	): void {
		if (!this.performanceObservabilityEnabled || !Number.isFinite(startedAt)) return
		const durationMs = Math.max(0, Math.round(performance.now() - startedAt))
		this.recordTaskPerformanceDuration(phase, durationMs, status)
	}

	public recordTaskPerformanceDuration(
		phase: Extract<AgentTurnEvent, { type: "task_performance" }>["phase"],
		durationMs: number,
		status: Extract<AgentTurnEvent, { type: "task_performance" }>["status"] = "completed",
	): void {
		if (!this.performanceObservabilityEnabled || !Number.isFinite(durationMs)) return
		void this.appendAgentTurnEvent({ type: "task_performance", phase, status, durationMs })
	}

	private dequeueQueuedMessage() {
		const message = this.messageQueueService.dequeueMessage()
		if (message) {
			this.recordTaskPerformanceDuration("queued_message_wait", Math.max(0, Date.now() - message.timestamp))
		}
		return message
	}

	/**
	 * Publish an explicit provider-neutral lifecycle event at a real Task
	 * boundary. AgentTurnEventLog remains additive telemetry; it is deliberately
	 * not converted into canonical events because it lacks durable identity and
	 * item/transition semantics.
	 */
	private enqueueCanonicalLifecycleEvent(
		type: AgentLifecycleEventInput["type"],
		payload: Record<string, unknown>,
		stepId?: string,
		guard?: CanonicalLifecycleEventGuard,
		options: { durable?: boolean; required?: boolean } = {},
	): Promise<void> {
		// Capture identity at enqueue time. A delayed old event must never be
		// constructed with a newer run/turn merely because the queue settled late.
		const runId = this.agentRunId
		const turnId = this.agentTurnId
		const operation = this.canonicalLifecycleQueue.then(async () => {
			if (guard && !guard()) {
				if (options.required) throw new Error(`Required lifecycle event ${type} was superseded.`)
				return
			}
			const provider = this.providerRef.deref() as
				| (AlphaProvider & {
						publishAgentLifecycleEvent?: (
							value: unknown,
							options?: { durable?: boolean },
						) => Promise<{ accepted?: boolean; error?: unknown }>
				  })
				| undefined
			if (!provider || !runId || !turnId || typeof provider.publishAgentLifecycleEvent !== "function") {
				if (options.required) throw new Error(`Lifecycle event ${type} has no durable provider journal.`)
				return
			}
			const current = this.getCanonicalLifecycleSnapshot()
			if (
				type !== "turn_started" &&
				current?.runId === runId &&
				current.turnId === turnId &&
				current.status !== "in_progress"
			) {
				if (options.required) throw new Error(`Lifecycle event ${type} cannot append to a terminal turn.`)
				return
			}
			if (guard && !guard()) return
			const event = {
				version: 1,
				eventId: crypto.randomUUID(),
				taskId: this.taskId,
				runId,
				turnId,
				occurredAt: Date.now(),
				type,
				...(stepId ? { stepId } : {}),
				correlationId: stepId ?? turnId,
				payload,
			} as AgentLifecycleEventInput
			const result = await provider.publishAgentLifecycleEvent(event, { durable: options.durable === true })
			// The host append is atomic once admitted, but a cancellation/replacement
			// that wins while it is in flight must not let its late rejection poison
			// the newer turn's local lifecycle state.
			if (guard && !guard()) return
			if (!result.accepted) {
				const error =
					result.error instanceof Error
						? result.error
						: new Error(
								result.error === undefined
									? `Lifecycle event ${type} was not accepted.`
									: String(result.error),
							)
				this.canonicalLifecyclePersistenceFailure ??= { type, error }
				this.notifyCanonicalLifecyclePersistenceFailure()
				console.error(`[Task#${this.taskId}] Canonical lifecycle event was not accepted: ${type}`, error)
				if (options.required) throw error
			}
		})
		const observed = operation.catch((error) => {
			if (guard && !guard()) return
			const normalizedError = error instanceof Error ? error : new Error(String(error))
			this.canonicalLifecyclePersistenceFailure ??= { type, error: normalizedError }
			this.notifyCanonicalLifecyclePersistenceFailure()
			console.error(`[Task#${this.taskId}] Failed to publish canonical lifecycle event:`, error)
		})
		this.canonicalLifecycleQueue = observed
		return options.required ? operation : observed
	}

	/** Surface the additive canonical failure without changing legacy task flow. */
	private notifyCanonicalLifecyclePersistenceFailure(): void {
		const provider = this.providerRef.deref() as
			| (Partial<AlphaProvider> & {
					markAgentLifecycleDegraded?: (taskId: string, error: Error, reason?: string) => unknown
			  })
			| undefined
		const failure = this.canonicalLifecyclePersistenceFailure
		if (!failure || typeof provider?.markAgentLifecycleDegraded !== "function") return
		provider.markAgentLifecycleDegraded(this.taskId, failure.error, "append_rejected")
	}

	/**
	 * Task tests and older host adapters may expose only the legacy provider
	 * surface. Keep the canonical lifecycle additive at that boundary while the
	 * production AlphaProvider still supplies the full journal/projector API.
	 */
	private getCanonicalLifecycleSnapshot() {
		const provider = this.providerRef.deref() as Partial<AlphaProvider> | undefined
		return typeof provider?.getAgentLifecycleSnapshot === "function"
			? provider.getAgentLifecycleSnapshot(this.taskId)
			: undefined
	}

	private async replayCanonicalLifecycle(): Promise<void> {
		const provider = this.providerRef.deref() as Partial<AlphaProvider> | undefined
		if (typeof provider?.replayAgentLifecycle === "function") {
			await provider.replayAgentLifecycle(this.taskId, { reuseUnchanged: true })
		}
	}

	/**
	 * Start one AgentTurnEngine run. On reload, replay first and continue an
	 * existing in-progress identity; after terminality, allocate a fresh run and
	 * turn so the task journal can begin a new local sequence at one.
	 */
	private async beginCanonicalLifecycleTurn(): Promise<boolean> {
		try {
			await this.replayCanonicalLifecycle()
		} catch (error) {
			// Lifecycle recovery is additive to the legacy loop. The publisher will
			// report a durable failure if recovery is unavailable; do not prevent the
			// existing Task from retaining its historical behavior.
			const provider = this.providerRef.deref() as
				| (Partial<AlphaProvider> & {
						markAgentLifecycleDegraded?: (taskId: string, error: Error, reason?: string) => unknown
				  })
				| undefined
			if (typeof provider?.markAgentLifecycleDegraded === "function") {
				provider.markAgentLifecycleDegraded(
					this.taskId,
					error instanceof Error ? error : new Error(String(error)),
					"replay_rejected",
				)
			}
			console.error(`[Task#${this.taskId}] Failed to replay canonical lifecycle:`, error)
		}
		const recovered = this.getCanonicalLifecycleSnapshot()
		const resumeExistingTurn = recovered?.status === "in_progress"
		this.agentRunId = resumeExistingTurn && recovered ? recovered.runId : crypto.randomUUID()
		this.agentTurnId = resumeExistingTurn && recovered ? recovered.turnId : crypto.randomUUID()
		this.agentTurnStep =
			resumeExistingTurn && recovered
				? recovered.steps.reduce((highest, step) => {
						const prefix = `${recovered.turnId}:step-`
						if (!step.stepId.startsWith(prefix)) return highest
						const suffix = Number(step.stepId.slice(prefix.length))
						return Number.isSafeInteger(suffix) && suffix > highest ? suffix : highest
					}, recovered.steps.length)
				: 0
		this.canonicalLifecycleStartedSteps.clear()
		// A restarted Task may be resuming an already-open canonical turn. Its
		// durable turn_started event is already in the journal; emitting another
		// event would add a meaningless transition and duplicate UI work.
		if (!resumeExistingTurn) {
			// Provider IDs may be reused by a fresh turn. Resumed turns retain their
			// existing receipt cache so retries cannot duplicate a settled result.
			this.persistedToolResultIds = new Set<string>()
			await this.enqueueCanonicalLifecycleEvent("turn_started", {
				phase: "starting",
				effectTrackingVersion: 1,
			})
		}
		return resumeExistingTurn
	}

	private async publishCanonicalLifecyclePhase(
		phase: AgentLifecyclePhase,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<void> {
		await this.enqueueCanonicalLifecycleEvent("phase_changed", { phase }, undefined, guard)
	}

	private async ensureCanonicalLifecycleStepStarted(
		step: CurrentAgentStep,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<void> {
		if (guard && !guard()) return
		if (this.canonicalLifecycleStartedSteps.has(step.stepId)) return
		const recovered = this.getCanonicalLifecycleSnapshot()
		if (
			recovered &&
			recovered.runId === this.agentRunId &&
			recovered.turnId === this.agentTurnId &&
			recovered.steps.some((candidate) => candidate.stepId === step.stepId)
		) {
			this.canonicalLifecycleStartedSteps.add(step.stepId)
			return
		}
		this.canonicalLifecycleStartedSteps.add(step.stepId)
		await this.enqueueCanonicalLifecycleEvent("step_started", { phase: "working" }, step.stepId, guard)
		if (guard && !guard()) this.canonicalLifecycleStartedSteps.delete(step.stepId)
	}

	private async publishCanonicalLifecycleStepStatus(
		step: CurrentAgentStep | undefined,
		status: TaskStepStatus,
		reason?: string,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<void> {
		if (!step || (guard && !guard())) return
		const recovered = this.getCanonicalLifecycleSnapshot()
		const previous = recovered?.steps.find((candidate) => candidate.stepId === step.stepId)
		if (previous && previous.status !== "in_progress") return
		const canonicalStatus =
			status === "completed"
				? "completed"
				: status === "failed" || status === "exhausted"
					? "failed"
					: "interrupted"
		await this.enqueueCanonicalLifecycleEvent(
			"step_status_changed",
			{
				status: canonicalStatus,
				...(reason ? { reason } : {}),
			},
			step.stepId,
			guard,
		)
	}

	private async publishCanonicalLifecycleResponseItems(
		response: AgentResponse,
		step: CurrentAgentStep | undefined,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<void> {
		if (!step || (guard && !guard())) return
		const recovered = this.getCanonicalLifecycleSnapshot()
		const publishedIds = new Set(
			recovered && recovered.runId === this.agentRunId && recovered.turnId === this.agentTurnId
				? recovered.items.map((item) => item.itemId)
				: [],
		)
		const acceptedToolCallIds = new Set(
			recovered && recovered.runId === this.agentRunId && recovered.turnId === this.agentTurnId
				? recovered.acceptedToolCallIds
				: [],
		)
		for (const { itemId, responseItem } of lifecycleResponseItems(response.items, step.stepId, publishedIds)) {
			if (guard && !guard()) return
			switch (responseItem.type) {
				case "text":
					await this.enqueueCanonicalLifecycleEvent(
						"item_added",
						{
							item: {
								itemId,
								stepId: step.stepId,
								type: "assistant_text",
								text: responseItem.text,
								...(responseItem.id !== undefined ? { messageId: responseItem.id } : {}),
								...(responseItem.phase !== undefined ? { phase: responseItem.phase } : {}),
								...(responseItem.outputIndex !== undefined
									? { outputIndex: responseItem.outputIndex }
									: {}),
							},
						},
						step.stepId,
						guard,
					)
					break
				case "reasoning":
					await this.enqueueCanonicalLifecycleEvent(
						"item_added",
						{ item: { itemId, stepId: step.stepId, type: "assistant_reasoning", text: responseItem.text } },
						step.stepId,
						guard,
					)
					break
				case "tool_call": {
					const toolCallId = sanitizeToolUseId(responseItem.id)
					if (!toolCallId || acceptedToolCallIds.has(toolCallId)) break
					await this.enqueueCanonicalLifecycleEvent(
						"tool_call_accepted",
						{
							item: {
								itemId,
								stepId: step.stepId,
								type: "tool_call",
								toolCallId,
								name: responseItem.name,
								arguments: responseItem.arguments,
								status: "accepted",
								accepted: true,
							},
						},
						step.stepId,
						guard,
					)
					acceptedToolCallIds.add(toolCallId)
					break
				}
				case "usage":
					await this.enqueueCanonicalLifecycleEvent(
						"item_added",
						{
							item: {
								itemId,
								stepId: step.stepId,
								type: "usage",
								inputTokens: responseItem.inputTokens,
								outputTokens: responseItem.outputTokens,
								...(responseItem.cacheReadTokens !== undefined
									? { cacheReadTokens: responseItem.cacheReadTokens }
									: {}),
								...(responseItem.cacheWriteTokens !== undefined
									? { cacheWriteTokens: responseItem.cacheWriteTokens }
									: {}),
								...(responseItem.reasoningTokens !== undefined
									? { reasoningTokens: responseItem.reasoningTokens }
									: {}),
								...(responseItem.totalCost !== undefined ? { cost: responseItem.totalCost } : {}),
							},
						},
						step.stepId,
						guard,
					)
					break
				case "error":
					await this.enqueueCanonicalLifecycleEvent(
						"item_added",
						{
							item: {
								itemId,
								stepId: step.stepId,
								type: "error",
								message: responseItem.message,
								...(responseItem.code ? { code: responseItem.code } : {}),
								...(responseItem.retryable !== undefined ? { retryable: responseItem.retryable } : {}),
							},
						},
						step.stepId,
						guard,
					)
					break
				case "grounding":
					if (responseItem.sources.length > 0) await this.markMemoryExternalContext()
					// Grounding sources are provider metadata, not user-visible lifecycle
					// items. They remain in the canonical response/transcript boundary.
					break
			}
		}
	}

	/** Persist the completed provider item before EOF without authorizing or executing it. */
	private async publishCompletedCanonicalToolCall(
		call: AgentToolCall,
		step: CurrentAgentStep | undefined,
	): Promise<void> {
		if (!step) return
		const toolCallId = sanitizeToolUseId(call.id)
		if (!toolCallId) throw new Error("Completed provider tool call has no valid lifecycle call ID.")
		const recovered = this.getCanonicalLifecycleSnapshot()
		if (
			recovered &&
			recovered.runId === this.agentRunId &&
			recovered.turnId === this.agentTurnId &&
			recovered.acceptedToolCallIds.includes(toolCallId)
		)
			return

		await this.enqueueCanonicalLifecycleEvent(
			"tool_call_accepted",
			{
				item: {
					itemId: `stream-tool-call-${crypto.randomUUID()}`,
					stepId: step.stepId,
					type: "tool_call",
					toolCallId,
					name: call.name,
					arguments: call.arguments,
					status: "accepted",
					accepted: true,
				},
			},
			step.stepId,
			undefined,
			{ durable: true, required: true },
		)
	}

	private async publishCanonicalLifecycleToolResult(
		result: { callId: string; status: string; content: unknown },
		step: CurrentAgentStep | undefined,
		options: { durable?: boolean; required?: boolean; guard?: CanonicalLifecycleEventGuard } = {},
	): Promise<void> {
		if (options.guard && !options.guard()) {
			throw new TaskPersistenceError("The tool result no longer owns its lifecycle step.")
		}
		if (!step) return
		const toolCallId = sanitizeToolUseId(result.callId)
		if (!toolCallId) return
		const itemId = `${step.stepId}:tool-result-${toolCallId}`
		const recovered = this.getCanonicalLifecycleSnapshot()
		if (
			recovered &&
			recovered.runId === this.agentRunId &&
			recovered.turnId === this.agentTurnId &&
			(recovered.terminalToolCallIds.includes(toolCallId) ||
				recovered.items.some((item) => item.itemId === itemId))
		)
			return
		const effectMayHaveStarted =
			recovered !== undefined &&
			recovered.runId === this.agentRunId &&
			recovered.turnId === this.agentTurnId &&
			(recovered.effectStartedToolCallIds.includes(toolCallId) || recovered.effectTrackingVersion !== 1)
		const status =
			effectMayHaveStarted && (result.status === "error" || result.status === "cancelled")
				? "indeterminate"
				: ["success", "error", "denied", "cancelled", "indeterminate"].includes(result.status)
					? result.status
					: "error"
		await this.enqueueCanonicalLifecycleEvent(
			"tool_result_recorded",
			{
				item: {
					itemId,
					stepId: step.stepId,
					type: "tool_result",
					toolCallId,
					status,
					output: result.content,
				},
			},
			step.stepId,
			options.guard,
			options,
		)
	}

	/** Publish synthetic/manual receipts after the assistant boundary exists. */
	private async publishCanonicalLifecyclePendingToolResults(
		response: AgentResponse | undefined,
		step: CurrentAgentStep | undefined,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<void> {
		if (!step || (guard && !guard())) return
		const responseCallIds = response
			? new Set(response.toolCalls.map((call) => sanitizeToolUseId(call.id)))
			: undefined
		for (const block of this.userMessageContent) {
			if (guard && !guard()) return
			if (block.type !== "tool_result") continue
			const callId = sanitizeToolUseId(block.tool_use_id)
			if (!callId || (responseCallIds && !responseCallIds.has(callId))) continue
			await this.publishCanonicalLifecycleToolResult(
				{
					callId,
					status: block.is_error ? "error" : "success",
					content: block.content,
				},
				step,
				{ guard },
			)
			if (guard && !guard()) return
		}
	}

	/** Close accepted calls left open by a process restart before rebuilding provider history. */
	private async recoverIncompleteCanonicalToolCallsForResume(): Promise<void> {
		await this.canonicalLifecycleQueue
		await this.replayCanonicalLifecycle()
		let snapshot = this.getCanonicalLifecycleSnapshot()
		if (
			!snapshot ||
			(snapshot.status !== "in_progress" && snapshot.status !== "interrupted") ||
			snapshot.acceptedToolCallIds.length === 0
		)
			return
		const recoverySnapshot = snapshot

		// Rollback suppresses provider replay, while the journal still closes every accepted call.
		const unresolved = recoverySnapshot.acceptedToolCallIds.filter(
			(toolCallId) => !recoverySnapshot.terminalToolCallIds.includes(toolCallId),
		)

		this.agentRunId = recoverySnapshot.runId
		this.agentTurnId = recoverySnapshot.turnId
		for (const toolCallId of unresolved) {
			const callItem = recoverySnapshot.items.find(
				(item) => item.type === "tool_call" && item.toolCallId === toolCallId,
			)
			if (!callItem || callItem.type !== "tool_call") continue
			const stepId = callItem.stepId ?? `${recoverySnapshot.turnId}:recovery`
			const effectMayHaveStarted =
				recoverySnapshot.effectStartedToolCallIds.includes(toolCallId) ||
				recoverySnapshot.effectTrackingVersion !== 1
			const persistedResult = this.findPersistedProviderToolResult(toolCallId)
			const persistedResultStatus = persistedResult ? (persistedResult.is_error ? "error" : "success") : undefined
			const recoveredStatus = persistedResultStatus ?? (effectMayHaveStarted ? "indeterminate" : "cancelled")
			await this.enqueueCanonicalLifecycleEvent(
				"tool_result_recorded",
				{
					item: {
						itemId: `${stepId}:tool-result-${toolCallId}`,
						stepId,
						type: "tool_result",
						toolCallId,
						status: recoveredStatus,
						output:
							persistedResultStatus !== undefined
								? persistedResult!.content
								: effectMayHaveStarted
									? "The tool effect may have started before the task stopped. Its outcome is unknown; verify the current state before retrying."
									: "Tool call was not executed because the task stopped before its effect began.",
					},
				},
				stepId,
				undefined,
				{ required: true },
			)
		}

		await this.replayCanonicalLifecycle()
		snapshot = this.getCanonicalLifecycleSnapshot() ?? snapshot
		if (!(await this.reconcileRecoveredCanonicalToolCallTranscript(snapshot))) {
			throw new TaskPersistenceError("Recovered tool calls could not be paired in the provider transcript.")
		}
		if (snapshot.status === "in_progress") {
			await this.enqueueCanonicalLifecycleEvent(
				"turn_terminal",
				{ status: "interrupted", reason: "process_recovery" },
				undefined,
				undefined,
				{ required: true },
			)
		}
	}

	/** Repair accepted lifecycle calls that crashed before their provider transcript pair was durable. */
	private async reconcileRecoveredCanonicalToolCallTranscript(
		snapshot: AgentLifecycleSnapshot,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<boolean> {
		if (guard && !guard()) return false
		const acceptedCalls = snapshot.items.filter(
			(item): item is Extract<AgentLifecycleSnapshot["items"][number], { type: "tool_call" }> =>
				item.type === "tool_call" &&
				snapshot.acceptedToolCallIds.includes(item.toolCallId) &&
				!this.isRewoundCanonicalToolCall(snapshot, item.toolCallId),
		)
		if (acceptedCalls.length === 0) return true

		const pendingByAssistant = new Map<number, Anthropic.ToolResultBlockParam[]>()
		const missingAssistantCalls: Array<{
			id: string
			name: string
			input: unknown
			result: Anthropic.ToolResultBlockParam
		}> = []
		for (const call of acceptedCalls) {
			if (guard && !guard()) return false
			const toolCallId = sanitizeToolUseId(call.toolCallId)
			if (!toolCallId || this.findPersistedProviderToolResult(toolCallId)) continue

			const resultItem = snapshot.items.find(
				(item) => item.type === "tool_result" && item.toolCallId === toolCallId,
			)
			const resultStatus = resultItem?.type === "tool_result" ? resultItem.status : undefined
			const output = resultItem?.type === "tool_result" ? (resultItem.output ?? resultItem.result) : undefined
			const resultText =
				typeof output === "string"
					? output
					: Array.isArray(output)
						? output
								.filter(
									(block): block is { type: "text"; text: string } =>
										!!block &&
										typeof block === "object" &&
										block.type === "text" &&
										typeof block.text === "string",
								)
								.map((block) => block.text)
								.join("\n") || "Tool result was recovered from the lifecycle journal."
						: output === undefined
							? snapshot.effectStartedToolCallIds.includes(toolCallId) ||
								snapshot.effectTrackingVersion !== 1
								? "The tool effect may have started before the task stopped. Its outcome is unknown; verify the current state before retrying."
								: "Tool call was not executed because the task stopped before its effect began."
							: (JSON.stringify(output) ?? String(output))
			const result: Anthropic.ToolResultBlockParam = {
				type: "tool_result",
				tool_use_id: toolCallId,
				content: (resultText || "Tool result was recovered from the lifecycle journal.").slice(0, 16_000),
				is_error:
					resultStatus !== undefined
						? resultStatus !== "success" && resultStatus !== "completed"
						: snapshot.effectStartedToolCallIds.includes(toolCallId) ||
							snapshot.effectTrackingVersion !== 1,
			}
			let assistantIndex = -1
			for (let index = this.apiConversationHistory.length - 1; index >= 0; index--) {
				const message = this.apiConversationHistory[index]
				if (
					message?.role === "assistant" &&
					Array.isArray(message.content) &&
					message.content.some((block) => sanitizeToolUseId(getToolCallId(block) ?? "") === toolCallId)
				) {
					assistantIndex = index
					break
				}
			}
			if (assistantIndex < 0) {
				missingAssistantCalls.push({ id: toolCallId, name: call.name, input: call.arguments, result })
				continue
			}
			const pending = pendingByAssistant.get(assistantIndex) ?? []
			pending.push(result)
			pendingByAssistant.set(assistantIndex, pending)
		}

		if (pendingByAssistant.size === 0 && missingAssistantCalls.length === 0) return true
		if (guard && !guard()) return false
		const history = [...this.apiConversationHistory]
		for (const [assistantIndex, results] of [...pendingByAssistant.entries()].sort(
			([left], [right]) => right - left,
		)) {
			const following = history[assistantIndex + 1]
			if (following?.role === "user" && !following.isSummary && !following.isTruncationMarker) {
				const content = Array.isArray(following.content)
					? [...following.content]
					: [{ type: "text" as const, text: following.content }]
				const existingIds = new Set(
					content
						.filter((block) => block.type === "tool_result")
						.map((block) => sanitizeToolUseId(getToolResultId(block) ?? "")),
				)
				const missingResults = results.filter(
					(result) => !existingIds.has(sanitizeToolUseId(result.tool_use_id)),
				)
				if (missingResults.length > 0) {
					history[assistantIndex + 1] = { ...following, content: [...missingResults, ...content] }
				}
			} else {
				history.splice(assistantIndex + 1, 0, { role: "user", content: results, ts: Date.now() })
			}
		}
		if (missingAssistantCalls.length > 0) {
			history.push({
				role: "assistant",
				content: missingAssistantCalls.map(({ id, name, input }) => ({ type: "tool_use", id, name, input })),
				ts: Date.now(),
			})
			history.push({
				role: "user",
				content: missingAssistantCalls.map(({ result }) => result),
				ts: Date.now(),
			})
		}
		return guard
			? this.overwriteApiConversationHistory(history, guard)
			: this.overwriteApiConversationHistory(history)
	}

	/** Find a persisted result paired with this assistant tool call, not an older ID collision. */
	private findPersistedProviderToolResult(toolCallId: string): Anthropic.ToolResultBlockParam | undefined {
		for (let assistantIndex = this.apiConversationHistory.length - 1; assistantIndex >= 0; assistantIndex--) {
			const assistantMessage = this.apiConversationHistory[assistantIndex]
			if (assistantMessage?.role !== "assistant" || !Array.isArray(assistantMessage.content)) continue

			const containsCall = assistantMessage.content.some(
				(block) => sanitizeToolUseId(getToolCallId(block) ?? "") === toolCallId,
			)
			if (!containsCall) continue

			for (
				let resultIndex = assistantIndex + 1;
				resultIndex < this.apiConversationHistory.length;
				resultIndex++
			) {
				const followingMessage = this.apiConversationHistory[resultIndex]
				if (followingMessage?.role === "assistant") break
				if (followingMessage?.role !== "user" || !Array.isArray(followingMessage.content)) continue

				const result = followingMessage.content.find(
					(block) =>
						block.type === "tool_result" && sanitizeToolUseId(getToolResultId(block) ?? "") === toolCallId,
				)
				if (result?.type === "tool_result") return result
			}

			return undefined
		}
		return undefined
	}

	private async finishCanonicalLifecycleCancellation(
		reason: string,
		cancellation: TaskCancellationBoundary,
	): Promise<void> {
		const ownsCancellation = cancellation.guard
		const runId = cancellation.runId
		const turnId = cancellation.turnId
		// Generation ownership alone does not admit a cold replacement to a prior
		// journal. Explicit begin/resume establishes these IDs before any repair.
		if (!this.providerRef.deref() || !ownsCancellation() || !runId || !turnId) return
		// An accepted call can still be queued behind a delayed journal append when
		// cancellation wins. Replay only after every Task-owned publication has
		// settled so recovery sees the complete set that needs terminal receipts.
		await this.canonicalLifecycleQueue
		if (!ownsCancellation()) return
		try {
			await this.replayCanonicalLifecycle()
		} catch (error) {
			console.error(`[Task#${this.taskId}] Failed to replay lifecycle before cancellation:`, error)
		}
		if (!ownsCancellation()) return
		const snapshot = this.getCanonicalLifecycleSnapshot()
		if (!snapshot || snapshot.status !== "in_progress" || snapshot.runId !== runId || snapshot.turnId !== turnId)
			return
		let stagedRecoveryResult = false
		for (const approval of snapshot.items) {
			if (!ownsCancellation()) return
			if (approval.type !== "approval" || approval.status !== "requested") continue
			await this.enqueueCanonicalLifecycleEvent(
				"approval_resolved",
				{
					item: {
						...approval,
						status: "cancelled",
						reason,
					},
				},
				approval.stepId,
				ownsCancellation,
			)
			if (!ownsCancellation()) return
		}
		for (const toolCallId of snapshot.acceptedToolCallIds) {
			if (!ownsCancellation()) return
			if (snapshot.terminalToolCallIds.includes(toolCallId)) continue
			const callItem = snapshot.items.find((item) => item.type === "tool_call" && item.toolCallId === toolCallId)
			if (!callItem || callItem.type !== "tool_call") continue
			const stepId = callItem.stepId ?? `${snapshot.turnId}:recovery`
			const itemId = `${stepId}:tool-result-${toolCallId}`
			const effectMayHaveStarted =
				snapshot.effectStartedToolCallIds.includes(toolCallId) || snapshot.effectTrackingVersion !== 1
			const output = effectMayHaveStarted
				? "The tool effect may have started before cancellation. Its outcome is unknown; verify the current state before retrying."
				: "Tool call was not executed because the task was cancelled."
			stagedRecoveryResult =
				this.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: toolCallId,
					content: output,
					is_error: true,
				}) || stagedRecoveryResult
			await this.enqueueCanonicalLifecycleEvent(
				"tool_result_recorded",
				{
					item: {
						itemId,
						stepId,
						type: "tool_result",
						toolCallId,
						status: effectMayHaveStarted ? "indeterminate" : "cancelled",
						output,
					},
				},
				stepId,
				ownsCancellation,
			)
			if (!ownsCancellation()) return
		}
		if (!ownsCancellation()) return
		if (stagedRecoveryResult) {
			const persisted = await this.flushPendingToolResultsToHistory({
				allowAborted: true,
				guard: ownsCancellation,
			})
			if (!ownsCancellation()) return
			if (!persisted) {
				throw new Error("Recovery tool-result receipts could not be durably saved during task termination.")
			}
		}
		await this.enqueueCanonicalLifecycleEvent(
			"turn_terminal",
			{ status: "interrupted", reason },
			undefined,
			ownsCancellation,
		)
	}

	private async publishCanonicalLifecycleSchedulerEvent(
		event: AgentTurnEvent,
		capturedStep?: CurrentAgentStep,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<void> {
		if (guard && !guard()) return
		const step = guard ? capturedStep : this.currentAgentStep
		if (!step) return
		if (event.type === "tool_result") {
			await this.publishCanonicalLifecycleToolResult(
				{ callId: event.callId, status: event.status, content: event.output },
				step,
				guard ? { guard } : undefined,
			)
			return
		}
		if (event.type === "approval_request") {
			const approvalId = event.requestId
			const itemId = `${step.stepId}:approval-${approvalId}`
			const recovered = this.getCanonicalLifecycleSnapshot()
			if (
				recovered &&
				recovered.runId === this.agentRunId &&
				recovered.turnId === this.agentTurnId &&
				recovered.items.some((item) => item.itemId === itemId)
			)
				return
			await this.enqueueCanonicalLifecycleEvent(
				"approval_requested",
				{
					item: {
						itemId,
						stepId: step.stepId,
						type: "approval",
						approvalId,
						...(event.callId ? { toolCallId: sanitizeToolUseId(event.callId) } : {}),
						status: "requested",
					},
				},
				step.stepId,
				guard,
			)
			return
		}
		if (event.type === "approval_result") {
			const approvalId = event.requestId
			const itemId = `${step.stepId}:approval-${approvalId}`
			const recovered = this.getCanonicalLifecycleSnapshot()
			const existing =
				recovered && recovered.runId === this.agentRunId && recovered.turnId === this.agentTurnId
					? recovered.items.find(
							(item) =>
								item.type === "approval" && item.itemId === itemId && item.approvalId === approvalId,
						)
					: undefined
			if (existing?.type === "approval" && existing.status !== "requested") return
			await this.enqueueCanonicalLifecycleEvent(
				"approval_resolved",
				{
					item: {
						itemId,
						stepId: step.stepId,
						type: "approval",
						approvalId,
						...(existing?.type === "approval" && existing.toolCallId
							? { toolCallId: existing.toolCallId }
							: {}),
						status: event.decision,
						...(event.reason ? { reason: event.reason } : {}),
					},
				},
				step.stepId,
				guard,
			)
		}
	}

	private async finishCanonicalLifecycleTurn(
		outcome: AgentTurnOutcome,
		guard?: CanonicalLifecycleEventGuard,
		capturedStep?: CurrentAgentStep,
		finalMessageTs?: number,
	): Promise<void> {
		const step = guard ? capturedStep : this.currentAgentStep
		const status =
			outcome.status === "completed"
				? "completed"
				: outcome.status === "failed" || outcome.status === "exhausted"
					? "failed"
					: "interrupted"
		try {
			if (guard && !guard()) return
			await this.enqueueCanonicalLifecycleEvent("phase_changed", { phase: "finalizing" }, undefined, guard)
			if (guard && !guard()) return
			await this.enqueueCanonicalLifecycleEvent(
				"turn_terminal",
				{
					status,
					...("reason" in outcome && outcome.reason ? { reason: outcome.reason } : {}),
					...("error" in outcome && outcome.error !== undefined
						? { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }
						: {}),
				},
				undefined,
				guard,
			)
			if (guard && !guard()) return
			if (outcome.status === "completed" && finalMessageTs !== undefined) {
				await this.annotateMessageTurn(finalMessageTs, { terminalStatus: "completed" }, guard)
				if (!guard || guard()) this.currentAssistantResponseMessageTs = finalMessageTs
			}
		} finally {
			// Keep the diagnostic snapshot available after finalization, but release
			// raw retry inputs even if publishing the terminal lifecycle event fails.
			step?.releaseRequest?.()
		}
	}

	private getTaskProviderProfileId(): string | undefined {
		const route =
			this.subagentModelRoute ?? this.providerRef.deref()?.taskHistoryStore?.get(this.taskId)?.threadModelRoute
		return route &&
			route.provider === this.apiConfiguration.apiProvider &&
			route.profileName === this._taskApiConfigName
			? route.profileId
			: undefined
	}

	/**
	 * Capture the model-visible request boundary once all request inputs have been
	 * assembled. Transport retries derive a retry snapshot so the context ID and
	 * captured prompt/transcript/tool surface stay stable.
	 */
	private captureAgentStep(
		retryAttempt: number,
		systemPrompt: string,
		cleanConversationHistory: readonly Anthropic.Messages.MessageParam[],
		allTools: OpenAI.Chat.ChatCompletionTool[],
		allowedFunctionNames: string[] | undefined,
		metadata: ApiHandlerCreateMessageMetadata,
		mode: string,
		modelInfo: ModelInfo,
		surface: TaskToolSurface | undefined,
		retainedStep?: CurrentAgentStep,
		capturedProvider?: CapturedTaskProvider,
		designHandoffOverride?: TaskDesignHandoff | null,
		capturedAutoApprovalPolicy?: SubagentAutoApprovalPolicy,
		recoverFromCommittedHistory = false,
	): CurrentAgentStep {
		if (!surface) {
			throw new Error("A unified tool surface is required to capture an agent step.")
		}

		const turnId = this.agentTurnId ?? (this.agentTurnId = crypto.randomUUID())
		const requestId =
			(recoverFromCommittedHistory ? undefined : retainedStep?.requestId) ??
			metadata.requestId ??
			crypto.randomUUID()
		const attemptId = metadata.attemptId ?? crypto.randomUUID()

		if (retainedStep) {
			if (recoverFromCommittedHistory) {
				const {
					signal: _signal,
					deadline: _deadline,
					deadlineScope: _deadlineScope,
					streamCapabilities: _capabilities,
					...recoveryMetadata
				} = metadata
				let recoveryRequest: ReturnType<CurrentAgentStep["getRequest"]> | undefined = structuredClone({
					systemPrompt,
					messages: [...cleanConversationHistory],
					metadata: recoveryMetadata,
				})
				let recoveryForkContext = retainedStep.getSubagentInvocationContext?.()
				if (recoveryForkContext) {
					recoveryForkContext.history = structuredClone(getEffectiveApiHistory(this.apiConversationHistory))
					recoveryForkContext.finalAssistantMessageIndexes = getFinalAssistantMessageIndexes(
						recoveryForkContext.history,
					)
				}
				const snapshot = this.agentStepContextBuilder.child(retainedStep.snapshot, {
					childTaskId: this.taskId,
					contextId: crypto.randomUUID(),
					createdAt: Date.now(),
					retryAttempt,
					transcript: {
						messages: structuredClone(cleanConversationHistory) as ApiMessage[],
						boundary: {
							startIndex: 0,
							endIndex: cleanConversationHistory.length,
							messageCount: cleanConversationHistory.length,
							digest: "",
						},
					},
					request: { metadata: recoveryMetadata },
				})
				this.agentTurnStep += 1
				this.currentAgentStep = {
					...retainedStep,
					snapshot,
					stepId: `${turnId}:step-${this.agentTurnStep}`,
					requestId,
					attemptId,
					getRequest: () => {
						if (!recoveryRequest) throw new Error("The captured recovery request has been released.")
						return structuredClone(recoveryRequest)
					},
					hasRetainedRequest: () => recoveryRequest !== undefined,
					releaseRequest: () => {
						if (!recoveryRequest) return
						recoveryRequest = undefined
						recoveryForkContext = undefined
						retainedStep.releaseRequest()
					},
					...(recoveryForkContext
						? {
								getSubagentInvocationContext: () => {
									if (!recoveryForkContext)
										throw new Error("The captured recovery invocation has been released.")
									return structuredClone(recoveryForkContext)
								},
							}
						: {}),
				}
				return this.currentAgentStep
			}
			const retrySnapshot = this.agentStepContextBuilder.retry(retainedStep.snapshot, {
				retryAttempt: Math.max(retryAttempt, retainedStep.snapshot.context.retryAttempt),
			})
			this.currentAgentStep = {
				...retainedStep,
				snapshot: retrySnapshot,
				attemptId,
			}
			return this.currentAgentStep
		}

		const apiHandler = capturedProvider?.apiHandler ?? this.api
		const apiConfiguration = capturedProvider?.apiConfiguration ?? this.effectiveApiConfiguration
		let providerCapture: CapturedTaskProvider | undefined = {
			apiHandler,
			compactionApiHandler: capturedProvider?.compactionApiHandler,
			apiConfiguration: snapshotProviderSettings(apiConfiguration),
			profileConfiguration: snapshotProviderSettings(
				capturedProvider?.profileConfiguration ?? this.apiConfiguration,
			),
			apiConfigName: capturedProvider ? capturedProvider.apiConfigName : this._taskApiConfigName,
			profileId: capturedProvider ? capturedProvider.profileId : this.getTaskProviderProfileId(),
		}
		this.agentTurnStep += 1
		const model = apiHandler.getModel()
		const {
			signal: _requestSignal,
			deadline: _requestDeadline,
			deadlineScope: _requestDeadlineScope,
			streamCapabilities: _streamCapabilities,
			...capturedMetadata
		} = metadata
		// StepContext is a sanitized diagnostic snapshot. Its recursive redaction
		// must not alter legitimate tool arguments, schemas, or opaque provider state
		// on the wire. Keep the raw capture inside a process-local closure and give
		// each adapter a fresh copy so adapter mutation cannot corrupt a later retry.
		let capturedRequest: ReturnType<CurrentAgentStep["getRequest"]> | undefined = structuredClone({
			systemPrompt,
			messages: [...cleanConversationHistory],
			metadata: { ...capturedMetadata, taskId: this.taskId, mode, requestId, attemptId },
		})
		const stepId = `${turnId}:step-${this.agentTurnStep}`
		const capturedApiConfigName = capturedProvider ? capturedProvider.apiConfigName : this._taskApiConfigName
		const forkHistory = surface.allowedFunctionNames.includes("spawn_agent")
			? structuredClone(getEffectiveApiHistory(this.apiConversationHistory))
			: undefined
		let capturedForkContext: SubagentInvocationContext | undefined = forkHistory
			? {
					mode,
					reasoningPreference: structuredClone(
						this.reasoningByHandler.get(apiHandler)?.requested ?? { kind: "default" },
					),
					apiConfiguration: snapshotProviderSettings(
						capturedProvider?.profileConfiguration ??
							capturedProvider?.apiConfiguration ??
							this.apiConfiguration,
					),
					apiConfigName: capturedApiConfigName,
					modelRoute: {
						source: "parent",
						resolution: "selected",
						provider: apiConfiguration.apiProvider,
						modelId:
							apiConfiguration.apiProvider === "fake-ai"
								? getSubagentRouteModelId(apiConfiguration)
								: model.id,
						profileName: capturedApiConfigName ?? "Parent profile",
						profileId: providerCapture.profileId,
					},
					history: forkHistory,
					allowedTools: [...surface.policy.allowedTools],
					finalAssistantMessageIndexes: getFinalAssistantMessageIndexes(forkHistory),
					...(capturedAutoApprovalPolicy
						? { autoApprovalPolicy: structuredClone(capturedAutoApprovalPolicy) }
						: {}),
					instructions:
						this.taskKind === "subagent" && this.subagentFrozenInstructions !== undefined
							? {
									effectiveText: this.subagentFrozenInstructions,
									sources:
										this.subagentContextManifest?.instructions.sources.map(
											({ kind, ref, digest }) => ({
												kind,
												ref,
												digest,
											}),
										) ?? [],
								}
							: captureInheritedStepInstructions(
									this.taskId,
									stepId,
									metadata.instructionFragments ?? [],
								),
				}
			: undefined
		// FakeAI is an in-process executable, not serializable provider configuration.
		// Retain it through the runtime handler without copying callbacks into diagnostics.
		const { fakeAi: _fakeAi, ...diagnosticProviderOptions } = apiConfiguration ?? {}
		const designHandoffSource =
			this.taskKind === "primary" && mode === defaultModeSlug
				? getDesignHandoffSource(
						designHandoffOverride === null ? undefined : (designHandoffOverride ?? this.designHandoff),
						this.taskId,
					)
				: undefined
		const snapshot = this.agentStepContextBuilder.build(
			{
				kind: "agent",
				retryAttempt,
				task: {
					taskId: this.taskId,
					cwd: this.cwd,
					...(this.rootTaskId ? { rootTaskId: this.rootTaskId } : {}),
					...(this.parentTaskId ? { parentTaskId: this.parentTaskId } : {}),
				},
				mode: { slug: mode },
				provider: {
					apiProvider: apiConfiguration.apiProvider,
					apiProtocol: getApiProtocol(
						isProviderName(apiConfiguration.apiProvider) ? apiConfiguration.apiProvider : undefined,
						apiHandler.getModel().id,
					),
					modelId: model.id,
					...(model.instructionModelId === undefined ? {} : { instructionModelId: model.instructionModelId }),
					modelInfo,
					options: diagnosticProviderOptions,
				},
				instructions: {
					systemPrompt,
					...(metadata.instructionFragments
						? {
								instructionFragments: metadata.instructionFragments.map(
									({ role, content, origin }) => ({
										role,
										content,
										origin: origin ?? "legacy-instruction-fragment",
									}),
								),
							}
						: {}),
					sources: designHandoffSource ? [designHandoffSource] : [],
				},
				environment: { roots: [this.cwd], capabilities: [] },
				transcript: {
					messages: structuredClone(cleanConversationHistory) as ApiMessage[],
					boundary: {
						startIndex: 0,
						endIndex: cleanConversationHistory.length,
						messageCount: cleanConversationHistory.length,
						digest: "",
					},
				},
				tools: {
					schemas: structuredClone(surface.schemas) as OpenAI.Chat.ChatCompletionTool[],
					...(allowedFunctionNames ? { allowedFunctionNames: [...allowedFunctionNames] } : {}),
					toolChoice: metadata.tool_choice,
					parallelToolCalls: metadata.parallelToolCalls ?? true,
					digest: surface.digest,
				},
				policy: surface.policy,
				budget: {
					contextWindow: modelInfo.contextWindow,
					maxOutputTokens: getModelMaxOutputTokens({
						modelId: apiHandler.getModel().id,
						model: modelInfo,
						settings: apiConfiguration,
					}),
					compaction: { action: "none", attempted: false },
				},
				request: {
					metadata: {
						...capturedMetadata,
						taskId: this.taskId,
						mode,
						requestId,
						attemptId,
					},
				},
			},
			{ handler: apiHandler },
		)

		this.currentAgentStep?.releaseRequest?.()
		if (providerCapture.compactionApiHandler) {
			this.reasoningHandlerUsers.set(
				providerCapture.compactionApiHandler,
				(this.reasoningHandlerUsers.get(providerCapture.compactionApiHandler) ?? 0) + 1,
			)
		}
		const summaryConfiguration: ProviderSettings = {
			...structuredClone(diagnosticProviderOptions),
			modelMaxTokens: 2_048,
			includeMaxTokens: true,
			modelMaxThinkingTokens: 1_024,
			// Pick the least expensive supported effort for this presentation-only request.
			reasoningEffort: modelInfo.requiredReasoningEffort
				? Array.isArray(modelInfo.supportsReasoningEffort)
					? modelInfo.supportsReasoningEffort[0]
					: modelInfo.reasoningEffort
				: "disable",
		}
		this.currentAgentStep = {
			createReasoningSummaryHandler: () => this.createReasoningSummaryHandler(summaryConfiguration),
			snapshot,
			getRequest: () => {
				if (!capturedRequest) throw new Error("The captured provider request has been released.")
				return structuredClone(capturedRequest)
			},
			getCapturedProvider: () => {
				if (!providerCapture) throw new Error("The captured provider route has been released.")
				return {
					...providerCapture,
					apiConfiguration: snapshotProviderSettings(providerCapture.apiConfiguration),
					...(providerCapture.profileConfiguration
						? { profileConfiguration: snapshotProviderSettings(providerCapture.profileConfiguration) }
						: {}),
				}
			},
			releaseRequest: () => {
				if (!capturedRequest) return
				const compactionApiHandler = providerCapture?.compactionApiHandler
				capturedRequest = undefined
				capturedForkContext = undefined
				providerCapture = undefined
				this.releaseCompactionHandler(compactionApiHandler)
				this.retireReasoningHandler(apiHandler)
			},
			hasRetainedRequest: () => capturedRequest !== undefined,
			...(forkHistory
				? {
						getSubagentInvocationContext: () => {
							if (!capturedForkContext)
								throw new Error("The captured subagent invocation has been released.")
							return structuredClone(capturedForkContext)
						},
					}
				: {}),
			turnId,
			stepId,
			requestId,
			attemptId,
			surface,
		}
		return this.currentAgentStep
	}

	private async flushAgentTurnEvents(): Promise<void> {
		try {
			await this.agentTurnEventLog.flush()
		} catch (error) {
			console.error(`[Task#${this.taskId}] Failed to flush agent turn events:`, error)
		}
	}

	private retryAfterMs(error: unknown): number | undefined {
		const candidate = error as {
			retryAfterMs?: unknown
			errorDetails?: Array<{ [key: string]: unknown }>
		}
		if (typeof candidate?.retryAfterMs === "number") return candidate.retryAfterMs
		const retryInfo = candidate?.errorDetails?.find(
			(detail) => detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
		)
		const retryDelay = retryInfo?.retryDelay
		if (typeof retryDelay === "string") {
			const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/)
			if (match) return Math.ceil(Number(match[1]) * 1000)
		}
		return undefined
	}

	private retryCategoryForError(error: unknown, fallback: AgentRetryCategory = "transport"): AgentRetryCategory {
		const candidate = error as { retryCategory?: unknown; status?: unknown; statusCode?: unknown }
		if (
			candidate?.retryCategory === "transport" ||
			candidate?.retryCategory === "rate-limit" ||
			candidate?.retryCategory === "context" ||
			candidate?.retryCategory === "empty-response"
		) {
			return candidate.retryCategory
		}
		if (checkContextWindowExceededError(error)) return "context"
		if (candidate?.status === 429 || candidate?.statusCode === 429) return "rate-limit"
		return fallback
	}

	private async waitForRetryDecision(
		decision: AgentRetryDecision,
		error: unknown,
		interruptionSignal?: AbortSignal,
		retryDeadline?: number,
	): Promise<void> {
		const retryAt = decision.retryAt ?? Date.now() + decision.delayMs
		this.throwIfStepInterrupted(interruptionSignal)
		throwIfAbsoluteDeadlineExceeded(retryDeadline)
		const message = error instanceof Error ? error.message : String(error)
		await this.waitForRequestControl(
			this.appendAgentTurnEvent({
				type: "retry",
				attempt: decision.attempt,
				reason: message,
				delayMs: decision.delayMs,
			}),
			interruptionSignal,
			retryDeadline,
		)
		if (decision.delayMs <= 0) return

		const headerText = message ? `${message}\n` : ""
		const seconds = Math.max(1, Math.ceil(decision.delayMs / 1000))
		await this.waitForRequestControl(
			this.say("api_req_retry_delayed", `${headerText}<retry_timer>${seconds}</retry_timer>`, undefined, true),
			interruptionSignal,
			retryDeadline,
		)
		await this.waitForProviderPacingDelay(
			Math.max(0, retryAt - Date.now()),
			interruptionSignal ?? this.getTaskLifetimeCancellationSignal(),
			retryDeadline,
		)
		await this.waitForRequestControl(
			this.say("api_req_retry_delayed", headerText, undefined, false),
			interruptionSignal,
			retryDeadline,
		)
	}

	// Alpha Messages

	private async getSavedAlphaMessages(requireExisting = false): Promise<AlphaMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath, requireExisting })
	}

	private getLastNonAgentMessage(): AlphaMessage | undefined {
		return this.alphaMessages[findLastIndex(this.alphaMessages, (message) => message.say !== "agent_message")]
	}

	private observeUiMessageTimestamps(messages: readonly AlphaMessage[] = this.alphaMessages): void {
		let latest = this.uiMessageTimestampHighWater ?? 0
		if (this.uiMessageTimestampHighWater === undefined && messages !== this.alphaMessages) {
			for (const message of this.alphaMessages) {
				if (Number.isFinite(message.ts)) latest = Math.max(latest, message.ts)
			}
		}
		for (const message of messages) {
			if (Number.isFinite(message.ts)) latest = Math.max(latest, message.ts)
		}
		this.uiMessageTimestampHighWater = latest
	}

	private reserveUiMessageTimestamp(): number {
		if (this.uiMessageTimestampHighWater === undefined) this.observeUiMessageTimestamps()
		const previous = this.uiMessageTimestampHighWater ?? 0
		const inputBoundary = Number.isFinite(this.lastMessageTs) ? this.lastMessageTs! : 0
		const timestamp = Math.max(Date.now(), previous + 1, inputBoundary + 1)
		if (!Number.isFinite(timestamp) || timestamp <= previous || timestamp <= inputBoundary) {
			throw new Error("Unable to allocate a unique UI message timestamp.")
		}
		// Reserve before publication/persistence can suspend; input ownership uses lastMessageTs separately.
		this.uiMessageTimestampHighWater = timestamp
		return timestamp
	}

	private async addToAlphaMessages(
		message: AlphaMessage,
		stateUpdate?: "full" | "task",
		requiredPersistenceContext?: string,
		turn: AlphaMessageTurn | null | undefined = this.toolInputContext?.getStore()?.turn ??
			this.captureMessageTurn(),
		onCreated?: (message: AlphaMessage) => void,
	) {
		if (!message.turn && turn) message.turn = { ...turn }
		this.observeUiMessageTimestamps([message])
		this.alphaMessages.push(message)
		onCreated?.(message)
		await this.publishAlphaMessageCreated(message, stateUpdate)
		const saved = await this.saveAlphaMessages()
		if (!saved && requiredPersistenceContext) throw new Error(`Unable to persist ${requiredPersistenceContext}.`)
	}

	private async publishAlphaMessageCreated(
		message: AlphaMessage,
		stateUpdate?: "full" | "task",
		ownership?: { guard: CanonicalLifecycleEventGuard; provider: AlphaProvider | undefined },
	) {
		if (ownership && !ownership.guard()) return
		const provider = ownership ? ownership.provider : this.providerRef.deref()
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
					alphaMessage: message,
				})
			} else {
				await provider?.postStateToWebviewWithoutTaskHistory()
			}
		}
		if (ownership && !ownership.guard()) return
		this.emit(AlphaCodeEventName.Message, { action: "created", message })
	}

	/**
	 * Paint the cleaned UI transcript as soon as it is in memory. Provider
	 * history is still required before Continue, but it must not block first paint.
	 */
	private async publishResumedUiPreview(): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return
		if (typeof provider.isTaskOnScreen === "function" && !provider.isTaskOnScreen(this.taskId)) {
			return
		}
		if (typeof provider.postTaskStateToWebview === "function") {
			await provider.postTaskStateToWebview()
		}
	}

	public async overwriteAlphaMessages(newMessages: AlphaMessage[]): Promise<boolean> {
		this.reasoningSummaries?.dispose()
		this.reasoningSummaries = undefined
		this.invalidateBackgroundUsageDrain("UI transcript was replaced")
		this.alphaMessages = newMessages
		this.observeUiMessageTimestamps()
		this.alphaMessagesHydrated = true
		restoreTodoListForTask(this)
		return this.saveAlphaMessages()
	}

	private async updateAlphaMessage(
		message: AlphaMessage,
		ownership?: { guard: CanonicalLifecycleEventGuard; provider: AlphaProvider | undefined },
	) {
		if (ownership && !ownership.guard()) return
		const provider = ownership ? ownership.provider : this.providerRef.deref()
		if (typeof provider?.postTaskMessageToWebview === "function") {
			await provider.postTaskMessageToWebview("messageUpdated", this.taskId, message)
		} else {
			await provider?.postMessageToWebview({ type: "messageUpdated", taskId: this.taskId, alphaMessage: message })
		}
		if (ownership && !ownership.guard()) return
		this.emit(AlphaCodeEventName.Message, { action: "updated", message })
	}

	/** Separate presentation transport, with the same observable provider creation boundary as task work. */
	public createReasoningSummaryHandler(configuration: ProviderSettings): ApiHandler {
		return buildApiHandler(configuration)
	}

	private scheduleInitialTaskTitle(requestText: string): Promise<void> {
		if (
			this.presentationModelCalls === false ||
			!requestText.trim() ||
			this.diagnosticSession ||
			this.taskKind === "subagent" ||
			this.parentTaskId ||
			this.orchestrationParentTaskId
		) {
			return Promise.resolve()
		}
		const provider = this.providerRef.deref()
		if (!provider || typeof provider.updateGeneratedTaskTitle !== "function") return Promise.resolve()
		if (!provider.taskHistoryStore.get(this.taskId)) return Promise.resolve()
		if (this.generatedTitleAbortController) return Promise.resolve()
		const titleController = new AbortController()
		this.generatedTitleAbortController = titleController
		const signal = AbortSignal.any([this.getTaskLifetimeCancellationSignal(), titleController.signal])
		const releaseTitleController = () => {
			if (this.generatedTitleAbortController === titleController) this.generatedTitleAbortController = undefined
		}
		let handler: ApiHandler
		try {
			handler = this.createReasoningSummaryHandler(this.effectiveApiConfiguration)
		} catch {
			return Promise.resolve()
				.then(async () => {
					if (signal.aborted) return
					await provider.updateGeneratedTaskTitle(
						this.taskId,
						fallbackTaskTitle(requestText) ?? "Untitled task",
					)
				})
				.catch(() => undefined)
				.finally(releaseTitleController)
		}

		return generateTaskTitle(handler, this.taskId, requestText, signal)
			.catch(() => undefined)
			.then(async (generatedTitle) => {
				if (signal.aborted) return
				const title = generatedTitle ?? fallbackTaskTitle(requestText) ?? "Untitled task"
				await provider.updateGeneratedTaskTitle(this.taskId, title)
			})
			.catch(() => {
				console.warn(`[Task#${this.taskId}] Automatic title could not be saved`)
			})
			.finally(releaseTitleController)
	}

	public cancelAutomaticTaskTitle(): void {
		this.generatedTitleAbortController?.abort(new Error("The task was renamed"))
	}

	private reportedProviderTimeoutSteps?: WeakSet<CurrentAgentStep>

	private recordProviderRequestTimeout(error: unknown, step = this.currentAgentStep): void {
		if (!step || normalizeApiStreamErrorMetadata(error).code !== "ProviderTimeout") return
		this.reportedProviderTimeoutSteps ??= new WeakSet()
		if (this.reportedProviderTimeoutSteps.has(step)) return
		this.reportedProviderTimeoutSteps.add(step)
		// Capture the exact attempt before cancellation can install its successor.
		void this.appendAgentTurnEvent(
			{ type: "model_request_failed", purpose: "task", code: "ProviderTimeout" },
			step.snapshot.context,
			{ turnId: step.turnId, stepId: step.stepId, requestId: step.requestId, attemptId: step.attemptId },
		)
	}

	private summarizeReasoning(message: AlphaMessage | undefined): void {
		const step = this.currentAgentStep
		if (this.presentationModelCalls === false || this.abort || !step || message?.say !== "reasoning") return
		this.reasoningSummaries ??= new ReasoningSummary(this.taskId, async (updated) => {
			if (this.abort || !this.alphaMessages.includes(updated)) return
			await this.updateAlphaMessage(updated)
			await this.saveAlphaMessages()
		})
		const identity = {
			turnId: step.turnId,
			stepId: step.stepId,
			requestId: crypto.randomUUID(),
			attemptId: crypto.randomUUID(),
		}
		this.reasoningSummaries.update({
			message,
			createHandler: step.createReasoningSummaryHandler,
			protocol: step.snapshot.context.provider.apiProtocol === "anthropic" ? "anthropic" : "openai",
			observeRequest: () =>
				this.appendAgentTurnEvent(
					{ type: "model_request_started", attempt: 0, purpose: "reasoning-summary" },
					step.snapshot.context,
					identity,
				),
			observeUsage: (chunk, totalCost) =>
				this.appendAgentTurnEvent(
					{
						type: "request_usage",
						purpose: "reasoning-summary",
						requestIndex: message.ts,
						retry: false,
						inputTokens: chunk.inputTokens,
						outputTokens: chunk.outputTokens,
						cacheReadTokens: chunk.cacheReadTokens ?? 0,
						cacheWriteTokens: chunk.cacheWriteTokens,
						reasoningTokens: chunk.reasoningTokens,
						totalCost,
						usageSource: chunk.usageSource ?? "unknown",
					},
					step.snapshot.context,
					identity,
				),
		})
	}

	private async enqueueAlphaMessagesSave(
		createSnapshot: () => AlphaMessage[] = () => structuredClone(this.alphaMessages),
		onPersisted?: () => void,
		designHandoff?: TaskDesignHandoff,
		reasoning?: {
			preference: TaskReasoningPreference
			state: TaskReasoningState
			route?: Pick<HistoryItem, "apiConfigName" | "threadModelOverride" | "threadModelRoute">
		},
		ownership?: { guard: CanonicalLifecycleEventGuard; provider: AlphaProvider | undefined },
	): Promise<boolean> {
		if (ownership && !ownership.guard()) return false
		const capturedProvider = ownership?.provider
		const save = this.alphaMessagesSaveQueue.then(async () => {
			let routeProvider: AlphaProvider | undefined
			let previousRouteHistory: HistoryItem | undefined
			let attemptedRouteHistory: HistoryItem | undefined
			let routePersistenceAttempted = false
			let routeCommitted = false
			try {
				if (ownership && !ownership.guard()) return false
				// A reopened task must not replace its saved transcript with the empty
				// constructor state if it closes or receives an update during hydration.
				if (!this.alphaMessagesHydrated) return false
				// Snapshot only after earlier writes finish. This prevents a slower, stale
				// write from overwriting a newer terminal transcript during concurrent updates.
				const messages = createSnapshot()
				if (ownership && !ownership.guard()) return false
				await saveTaskMessages({
					messages,
					taskId: this.taskId,
					globalStoragePath: this.globalStoragePath,
				})
				if (ownership && !ownership.guard()) return false

				if (this._taskApiConfigName === undefined) {
					await this.taskApiConfigReady
					if (ownership && !ownership.guard()) return false
				}

				const { historyItem, tokenUsage } = await taskMetadata({
					taskId: this.taskId,
					presentationModelCalls: this.presentationModelCalls,
					diagnosticSession: this.diagnosticSession,
					diagnosticIncidentId: this.diagnosticIncidentId,
					diagnosticSourceTaskId: this.diagnosticSourceTaskId,
					orchestrationParentTaskId: this.orchestrationParentTaskId,
					orchestrationNotifyCompletion: this.orchestrationNotifyCompletion,
					orchestrationWorkspaceMode: this.orchestrationWorkspaceMode,
					orchestrationWorkspaceRelativePath: this.orchestrationWorkspaceRelativePath,
					orchestrationWorkspaceBaselineCommit: this.orchestrationWorkspaceBaselineCommit,
					rootTaskId: this.rootTaskId,
					parentTaskId: this.parentTaskId,
					taskNumber: this.taskNumber,
					messages,
					globalStoragePath: this.globalStoragePath,
					workspace: this.historyWorkspacePath,
					mode: this._taskMode || defaultModeSlug, // Use the task's own mode, not the current provider mode.
					apiConfigName: reasoning?.route?.apiConfigName ?? this._taskApiConfigName,
					approvalMode: this.taskApprovalMode,
					memory: this.memory,
					reasoningPreference: reasoning?.preference ?? this.reasoningPreference,
					reasoningState: reasoning?.state ?? this.reasoningState,
					workContext: this.workContext,
					designHandoff: designHandoff ?? this.designHandoff,
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
				if (ownership && !ownership.guard()) return false

				// Emit token/tool usage updates using debounced function
				// The debounce with maxWait ensures:
				// - Immediate first emit (leading: true)
				// - At most one emit per interval during rapid updates (maxWait)
				// - Final state is emitted when updates stop (trailing: true)
				this.debouncedEmitTokenUsage(tokenUsage, this.toolUsage)

				if (ownership && !ownership.guard()) return false
				const provider = ownership ? capturedProvider : this.providerRef.deref()
				if (reasoning?.route) {
					routeProvider = provider
					previousRouteHistory = provider?.taskHistoryStore.get(this.taskId)
					if (!provider || !previousRouteHistory) throw new Error("The task model route is unavailable")
					previousRouteHistory = structuredClone(previousRouteHistory)
					attemptedRouteHistory = { ...historyItem, ...reasoning.route }
					routePersistenceAttempted = true
				}
				await provider?.updateTaskHistory(
					reasoning?.route ? { ...historyItem, ...reasoning.route } : historyItem,
					reasoning ? { broadcast: false } : undefined,
				)
				if (ownership && !ownership.guard()) return false
				onPersisted?.()
				routeCommitted = true
				if (ownership && !ownership.guard()) return false
				return true
			} catch (error) {
				if (ownership && !ownership.guard()) return false
				console.error("Failed to save Alpha messages:", error)
				return false
			} finally {
				if (
					routePersistenceAttempted &&
					!routeCommitted &&
					routeProvider &&
					previousRouteHistory &&
					attemptedRouteHistory
				) {
					// Compensate under the store's file lease. Stop may restore its own
					// provisional route; a replacement Task owns all later selection writes.
					await routeProvider.taskHistoryStore.restoreModelRoute(
						this.taskId,
						attemptedRouteHistory,
						previousRouteHistory,
						() => this.isCurrentApiConversationHistoryOwner(),
					)
				}
			}
		})

		// Keep the queue usable after a failed write. The caller still receives the
		// boolean result for this specific operation.
		this.alphaMessagesSaveQueue = save.then(
			() => undefined,
			() => undefined,
		)
		return save
	}

	private async saveAlphaMessages(ownership?: {
		guard: CanonicalLifecycleEventGuard
		provider: AlphaProvider | undefined
	}): Promise<boolean> {
		return ownership
			? this.enqueueAlphaMessagesSave(undefined, undefined, undefined, undefined, ownership)
			: this.enqueueAlphaMessagesSave()
	}

	/**
	 * Persist a message mutation before exposing it in memory or to the webview.
	 * The save queue is also the commit fence: later transcript saves observe the
	 * committed live mutation, while a failed attempt leaves the visible state alone.
	 */
	private async commitAlphaMessageMutation(
		timestamp: number,
		context: string,
		mutate: (message: AlphaMessage | undefined) => AlphaMessage | undefined,
		designHandoff?: TaskDesignHandoff,
		matchesMessage: (message: AlphaMessage) => boolean = (message) => message.ts === timestamp,
		ownership?: { guard: CanonicalLifecycleEventGuard; provider: AlphaProvider | undefined },
		messageTurn = this.toolInputContext?.getStore()?.turn ?? this.captureMessageTurn(),
	): Promise<{ message: AlphaMessage; created: boolean } | undefined> {
		for (const retryDelayMs of [0, 50, 200]) {
			if (ownership && !ownership.guard()) return
			if (retryDelayMs > 0) await delay(retryDelayMs)
			if (ownership && !ownership.guard()) return

			let stagedMessage: AlphaMessage | undefined
			let created = false
			let committedMessage: AlphaMessage | undefined
			const saved = await this.enqueueAlphaMessagesSave(
				() => {
					const messages = structuredClone(this.alphaMessages)
					const index = messages.findIndex(matchesMessage)
					created = index < 0
					stagedMessage = mutate(index >= 0 ? messages[index] : undefined)
					if (!stagedMessage) return messages
					if (!stagedMessage.turn && messageTurn) stagedMessage.turn = { ...messageTurn }
					if (index >= 0) messages[index] = stagedMessage
					else messages.push(stagedMessage)
					return messages
				},
				() => {
					if (!stagedMessage) return
					if (designHandoff) this.designHandoff = structuredClone(designHandoff)
					const liveIndex = this.alphaMessages.findIndex(matchesMessage)
					committedMessage = structuredClone(stagedMessage)
					this.observeUiMessageTimestamps([committedMessage])
					if (liveIndex >= 0) this.alphaMessages[liveIndex] = committedMessage
					else this.alphaMessages.push(committedMessage)
				},
				designHandoff,
				undefined,
				ownership,
			)

			if (ownership && !ownership.guard()) return
			if (saved) {
				return committedMessage ? { message: committedMessage, created } : undefined
			}
		}

		if (ownership && !ownership.guard()) return
		throw new Error(`Unable to persist ${context}.`)
	}

	private async requireAlphaMessagesSaved(context: string): Promise<void> {
		for (const retryDelayMs of [0, 50, 200]) {
			if (retryDelayMs > 0) await delay(retryDelayMs)
			if (await this.saveAlphaMessages()) return
		}
		throw new Error(`Unable to persist ${context}.`)
	}

	private findMessageByTimestamp(ts: number): AlphaMessage | undefined {
		for (let i = this.alphaMessages.length - 1; i >= 0; i--) {
			if (this.alphaMessages[i].ts === ts) {
				return this.alphaMessages[i]
			}
		}

		return undefined
	}

	private getOffscreenAutoAskResponse(
		type: AlphaAsk,
		text?: string,
		isProtected?: boolean,
	): { response: AlphaAskResponse; text?: string; images?: string[] } | undefined {
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
			this.getRecoveryActionGuidance(),
			"If delegating, call spawn_agent by itself in its own assistant turn. Do not batch spawn_agent with any other tool.",
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
			this.getRecoveryActionGuidance(),
			"Unrelated reads or substitute writes do not resolve a failed operation. Use a supported repair or authorized alternative; otherwise report the remaining limitation accurately. Resolve an unknown execution outcome before repeating its effects.",
			"If delegating, call spawn_agent by itself in its own assistant turn. Do not batch spawn_agent with any other tool.",
		)

		return details.join("\n")
	}

	private getRecoveryActionGuidance(): string {
		const completion =
			this.taskKind === "subagent"
				? "give an ordinary final answer that the host records as the child result"
				: "give an ordinary final answer"
		return `Resolve the reported cause with the smallest supported action. When the requested outcome and applicable checks are satisfied, ${completion}. Ask a follow-up only when specific missing user input blocks progress.`
	}

	private getLastToolFailureGuidance(): string | undefined {
		if (!this.lastToolFailure) return undefined
		if (this.lastToolFailure.failure) {
			return `Most recent tool failure: ${this.lastToolFailure.toolName}. ${formatToolFailureGuidance(this.lastToolFailure.failure)}`
		}
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

		const queuedGuidance = this.messageQueueService.isEmpty() ? undefined : this.dequeueQueuedMessage()
		if (queuedGuidance) {
			// The user has already supplied the guidance this safeguard would ask
			// for. Deliver it with the pending tool result instead of interrupting
			// it with another generic mistake-limit dialog.
			await this.say(
				"user_feedback",
				queuedGuidance.text,
				queuedGuidance.images,
				undefined,
				undefined,
				undefined,
				{
					queuedMessageIds: [queuedGuidance.id],
				},
			)
			currentUserContent.push(
				...this.buildUserMessageContent(queuedGuidance.text, queuedGuidance.images, [queuedGuidance.id]),
			)
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
			await this.say("user_feedback", text, undefined, undefined, undefined, undefined, {
				feedbackSource: "automatic",
			})
			// Keep the bounded automatic-attempt count, but give that attempt a
			// clean consecutive-error window. Retaining the no-tool counter here
			// caused one recovery response to immediately reopen the same dialog.
			this.resetConsecutiveMistakeState()
			return
		}

		const { response, text, images, queuedMessageIds } = await this.ask(
			"mistake_limit_reached",
			this.getMistakeLimitGuidance(),
			undefined,
			undefined,
			true,
		)

		if (response === "messageResponse") {
			const feedback: Anthropic.Messages.ContentBlockParam[] = [
				{ type: "text", text: formatResponse.tooManyMistakes(text) },
				...formatResponse.imageBlocks(images),
			]
			this.bindQueuedInputBlocks(feedback, queuedMessageIds ?? [])
			this.captureInputBlockOrigins(feedback, "human")
			currentUserContent.push(...feedback)

			await this.say("user_feedback", text, images, undefined, undefined, undefined, { queuedMessageIds })
		}

		this.resetMistakeRecoveryState()
	}

	private getOffscreenMistakeLimitGuidance(): string {
		return [
			"This task lane is not currently on-screen. Continue independent authorized work where possible.",
			this.getLastToolFailureGuidance(),
			this.getRecoveryActionGuidance(),
			"If delegating, call spawn_agent by itself and do not include any other tool in the same turn.",
		]
			.filter(Boolean)
			.join(" ")
	}

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: AlphaAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
		requiresExplicitApproval?: boolean,
		toolApprovalRequest?: ToolApprovalRequest,
		onCommandApproved?: (commandExecutionId: string) => void,
		signal?: AbortSignal,
	): Promise<{ response: AlphaAskResponse; text?: string; images?: string[]; queuedMessageIds?: string[] }> {
		const capturedAutoApprovalTimeoutRevision = this.autoApprovalTimeoutRevision ?? 0
		const capturedTurn = this.toolInputContext?.getStore()?.turn ?? this.captureMessageTurn()
		const addMessage = (message: AlphaMessage) =>
			this.addToAlphaMessages(message, undefined, undefined, capturedTurn)
		// If this Alpha instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Alpha now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Alpha = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error(`[Task#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}
		if (signal) this.throwIfStepInterrupted(signal)
		const taskApprovalMode = this.getStepApprovalMode()
		const stepPolicy = this.currentAgentStep?.snapshot.context.policy
		const commandPolicy = stepPolicy?.execution?.command
		const reviewPolicy = stepPolicy ? (stepPolicy.approval.reviewPolicy ?? CLOSED_TOOL_REVIEW_POLICY) : undefined
		// Policy compares execution text; private-path redaction belongs only to presentation.
		const commandForApproval = type === "command" ? text : undefined
		if (text !== undefined) text = redactTaskPrivatePaths(this, text)
		const alphaToolApprovalRequest: ToolApprovalPrompt | undefined = toolApprovalRequest
			? {
					requestId: toolApprovalRequest.requestId,
					taskId: toolApprovalRequest.taskId,
					toolName: toolApprovalRequest.toolName,
					...(toolApprovalRequest.description === undefined
						? {}
						: { description: redactTaskPrivatePaths(this, toolApprovalRequest.description) }),
					...(toolApprovalRequest.askType === "command" && toolApprovalRequest.cwd !== undefined
						? { cwd: redactTaskPrivatePaths(this, toolApprovalRequest.cwd) }
						: {}),
					...(toolApprovalRequest.commandPathApproval
						? { commandPathApproval: toolApprovalRequest.commandPathApproval }
						: {}),
					availableDecisions: toolApprovalRequest.availableDecisions,
					...(toolApprovalRequest.proposedAmendment
						? { proposedAmendment: toolApprovalRequest.proposedAmendment }
						: {}),
					...(toolApprovalRequest.proposedPersistentAmendment
						? {
								proposedPersistentAmendment: {
									kind: "command_prefix",
									prefix: redactTaskPrivatePaths(
										this,
										toolApprovalRequest.proposedPersistentAmendment.prefix,
									),
								},
							}
						: {}),
				}
			: undefined

		// Resolve automatic decisions before publishing the ask. Otherwise the webview
		// briefly renders approval controls for actions that the policy immediately approves.
		const provider = this.providerRef.deref()
		const state =
			partial === true || !provider
				? undefined
				: signal
					? await this.waitForRequestControl(provider.getState(), signal)
					: await provider.getState()
		const taskApprovalState = this.approvalStateForAsk(state, taskApprovalMode)
		const offscreenAutoResponse =
			partial === true || requiresExplicitApproval
				? undefined
				: this.getOffscreenAutoAskResponse(type, text, isProtected)
		const autoApprovalInput = {
			state: taskApprovalState,
			commandPolicy,
			reviewPolicy,
			inheritedState:
				this.taskKind === "subagent"
					? (this.subagentContextManifest?.runtimePolicy.autoApproval ?? disabledSubagentAutoApprovalPolicy)
					: undefined,
			ask: type,
			text: type === "command" ? commandForApproval : text,
			isProtected,
			requiresExplicitApproval,
		}
		const pendingApproval =
			partial === true || offscreenAutoResponse
				? undefined
				: checkAutoApprovalWithInheritedPolicy(autoApprovalInput)
		const approval = pendingApproval
			? signal
				? await this.waitForRequestControl(pendingApproval, signal)
				: await pendingApproval
			: ({ decision: "ask" } as const)
		if (this.abort) {
			throw new Error(`[Task#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}
		if (signal) this.throwIfStepInterrupted(signal)
		const isAutomaticallyResolved =
			offscreenAutoResponse !== undefined || approval.decision === "approve" || approval.decision === "deny"

		let askTs: number
		let installedAsk: Task["activeAsk"]
		const installActiveAsk = (ts: number) => {
			installedAsk = { type, ts, toolCallId: this.toolInputContext?.getStore()?.toolCallId, signal }
			this.activeAsk = installedAsk
		}

		if (partial !== undefined) {
			const lastMessage = this.getLastNonAgentMessage()

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					lastMessage.toolApprovalRequest = alphaToolApprovalRequest
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.updateAlphaMessage(lastMessage)
					throw new AskIgnoredError("updating existing partial")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = this.reserveUiMessageTimestamp()
					this.lastMessageTs = askTs
					await addMessage({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
						partial,
						isProtected,
						progressStatus,
						toolApprovalRequest: alphaToolApprovalRequest,
					})
					throw new AskIgnoredError("new partial")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					this.askResponseQueuedMessageIds = undefined

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
					installActiveAsk(askTs)
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					lastMessage.toolApprovalRequest = alphaToolApprovalRequest
					lastMessage.isAnswered = isAutomaticallyResolved ? true : undefined
					await this.saveAlphaMessages()
					this.updateAlphaMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					this.askResponseQueuedMessageIds = undefined
					askTs = this.reserveUiMessageTimestamp()
					this.lastMessageTs = askTs
					installActiveAsk(askTs)
					await addMessage({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
						isProtected,
						progressStatus,
						toolApprovalRequest: alphaToolApprovalRequest,
						...(isAutomaticallyResolved ? { isAnswered: true } : {}),
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			this.askResponseQueuedMessageIds = undefined
			askTs = this.reserveUiMessageTimestamp()
			this.lastMessageTs = askTs
			installActiveAsk(askTs)
			await addMessage({
				ts: askTs,
				type: "ask",
				ask: type,
				text,
				isProtected,
				progressStatus,
				toolApprovalRequest: alphaToolApprovalRequest,
				...(isAutomaticallyResolved ? { isAnswered: true } : {}),
			})
		}

		if (installedAsk) installedAsk.published = true
		let timeouts: NodeJS.Timeout[] = []

		const onAbort = () => {
			if (
				this.abort ||
				!installedAsk ||
				this.activeAsk !== installedAsk ||
				this.activeAsk?.ts !== askTs ||
				this.lastMessageTs !== askTs
			) {
				return
			}
			this.handleWebviewAskResponse("noButtonClicked", undefined, undefined, undefined, askTs)
		}

		try {
			// Await publication before cancellation can answer its owned slot.
			signal?.addEventListener("abort", onAbort, { once: true })
			if (signal?.aborted) onAbort()

			if (!signal?.aborted && offscreenAutoResponse) {
				this.handleWebviewAskResponse(
					offscreenAutoResponse.response,
					offscreenAutoResponse.text,
					offscreenAutoResponse.images,
				)
			} else if (!signal?.aborted && approval.decision === "approve") {
				this.approveAsk()
			} else if (!signal?.aborted && approval.decision === "deny") {
				this.denyAsk()
			} else if (
				!signal?.aborted &&
				approval.decision === "timeout" &&
				(this.autoApprovalTimeoutRevision ?? 0) === capturedAutoApprovalTimeoutRevision
			) {
				// Store the auto-approval timeout so it can be cancelled if user interacts
				const timeout = setTimeout(() => {
					const ownsAutomaticAnswer = () =>
						!this.abort &&
						!this.abandoned &&
						!signal?.aborted &&
						(this.autoApprovalTimeoutRevision ?? 0) === capturedAutoApprovalTimeoutRevision &&
						this.autoApprovalTimeoutRef === timeout &&
						this.activeAsk === installedAsk &&
						this.activeAsk?.ts === askTs &&
						this.lastMessageTs === askTs &&
						this.askResponse === undefined &&
						!this.deferredAskResponse
					void (async () => {
						try {
							if (!provider || !ownsAutomaticAnswer()) return
							const pendingCurrentState = provider.getState()
							const currentState = signal
								? await this.waitForRequestControl(pendingCurrentState, signal)
								: await pendingCurrentState
							if (!ownsAutomaticAnswer()) return
							// Settings may revoke a timed answer while preserving the admitted step's authority.
							const pendingCurrentApproval = checkAutoApprovalWithInheritedPolicy({
								...autoApprovalInput,
								state: this.approvalStateForAsk(currentState, taskApprovalMode),
							})
							const currentApproval = signal
								? await this.waitForRequestControl(pendingCurrentApproval, signal)
								: await pendingCurrentApproval
							if (!ownsAutomaticAnswer()) return
							// Imports/API writes may revoke the preference after getState captured it.
							// Read it synchronously at the effect boundary, after the last await.
							if (
								currentApproval.decision !== "timeout" ||
								currentApproval.timeout !== approval.timeout ||
								provider.contextProxy.getValue("followupAutoApproveTimeoutMs") !== approval.timeout
							) {
								this.markActiveFollowupQuestionWaiting(askTs)
								return
							}
							const { askResponse, text, images } = approval.fn()
							this.handleWebviewAskResponse(askResponse, text, images, undefined, askTs)
						} catch {
							if (ownsAutomaticAnswer()) {
								provider?.log(
									"Skipping automatic question answer because settings could not be revalidated.",
								)
								this.markActiveFollowupQuestionWaiting(askTs)
							}
						} finally {
							if (this.autoApprovalTimeoutRef === timeout) this.autoApprovalTimeoutRef = undefined
						}
					})()
				}, approval.timeout)
				this.autoApprovalTimeoutRef = timeout
				timeouts.push(timeout)
			}

			// The state is mutable if the message is complete and the task will
			// block (via the `pWaitFor`).
			const isBlocking = !(this.askResponse !== undefined || this.lastMessageTs !== askTs)
			const isMessageQueued = !this.messageQueueService.isEmpty()
			// Queued messages represent the next conversational turn. Only drain them
			// at completion/resume boundaries unless the user explicitly steers one.
			const shouldDrainQueuedMessageForAsk = () =>
				type === "completion_result" ||
				((type === "resume_task" || type === "resume_completed_task") && !this.resumeRequiresExplicitInput)
			const isStatusMutable =
				!partial &&
				!signal?.aborted &&
				isBlocking &&
				(!shouldDrainQueuedMessageForAsk() || !isMessageQueued) &&
				(approval.decision === "ask" ||
					(approval.decision === "timeout" &&
						(this.autoApprovalTimeoutRevision ?? 0) !== capturedAutoApprovalTimeoutRevision))
			if (
				isStatusMutable &&
				this.taskKind === "subagent" &&
				(type === "command" || type === "tool" || type === "use_mcp_server")
			) {
				await provider?.surfaceSubagentApproval?.(
					this,
					type === "command"
						? "command"
						: type === "use_mcp_server"
							? "mcp"
							: isProtected
								? "protected_write"
								: "tool",
					text,
				)
			}

			if (isStatusMutable) {
				const statusMutationTimeout = 2_000

				if (isInteractiveAsk(type)) {
					timeouts.push(
						setTimeout(() => {
							if (type === "followup") {
								this.markActiveFollowupQuestionWaiting(askTs)
								return
							}
							const message = this.findMessageByTimestamp(askTs)

							if (message) {
								this.interactiveAsk = message
								this.emit(AlphaCodeEventName.TaskInteractive, this.taskId)
								provider?.postMessageToWebview({ type: "interactionRequired", taskId: this.taskId })
							}
						}, statusMutationTimeout),
					)
				} else if (isResumableAsk(type)) {
					timeouts.push(
						setTimeout(() => {
							const message = this.findMessageByTimestamp(askTs)

							if (message) {
								this.resumableAsk = message
								this.emit(AlphaCodeEventName.TaskResumable, this.taskId)
							}
						}, statusMutationTimeout),
					)
				} else if (isIdleAsk(type)) {
					timeouts.push(
						setTimeout(() => {
							const message = this.findMessageByTimestamp(askTs)

							if (message) {
								this.idleAsk = message
								this.emit(AlphaCodeEventName.TaskIdle, this.taskId)
							}
						}, statusMutationTimeout),
					)
				}
			}

			// Wait for askResponse to be set
			await pWaitFor(
				() => {
					if (this.abort) {
						return true
					}

					// An accepted response owns its slot. Leave later FIFO guidance for the
					// outer completion/recovery consumer instead of claiming it invisibly.
					if (this.askResponse !== undefined || this.deferredAskResponse || this.lastMessageTs !== askTs) {
						return true
					}
					if (shouldDrainQueuedMessageForAsk() && !this.messageQueueService.isEmpty()) {
						const message = this.dequeueQueuedMessage()
						if (message) {
							const accepted = this.handleWebviewAskResponse(
								"messageResponse",
								message.text,
								message.images,
								[message.id],
								askTs,
							)
							if (!accepted) this.messageQueueService.releaseMessage(message.id)
							return accepted
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
			signal?.removeEventListener("abort", onAbort)
			// Every exit path owns and clears only the timers created for this ask.
			timeouts.forEach((timeout) => clearTimeout(timeout))
			if (this.autoApprovalTimeoutRef && timeouts.includes(this.autoApprovalTimeoutRef)) {
				this.autoApprovalTimeoutRef = undefined
			}
		}

		if (this.abort) {
			await this.releaseQueuedAskInput(installedAsk)
			if (this.activeAsk?.ts === askTs) {
				this.activeAsk = undefined
			}
			throw new Error(`[Task#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (this.lastMessageTs !== askTs) {
			await this.releaseQueuedAskInput(installedAsk)
			if (this.activeAsk?.ts === askTs) {
				this.activeAsk = undefined
			}
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new AskIgnoredError("superseded")
		}

		const queuedMessageIds = this.askResponseQueuedMessageIds as string[] | undefined
		const result = {
			response: this.askResponse!,
			text: this.askResponseText,
			images: this.askResponseImages,
			...(queuedMessageIds?.length ? { queuedMessageIds } : {}),
		}
		if (result.queuedMessageIds?.length && this.activeAsk?.ts === askTs && this.activeAsk.toolCallId) {
			this.retainQueuedMessageToolResult(
				this.activeAsk.toolCallId,
				result.queuedMessageIds,
				this.buildUserMessageContent(result.text, result.images, result.queuedMessageIds),
			)
		}
		if (this.taskKind === "subagent") await provider?.clearSubagentApproval?.(this.taskId)
		if (this.activeAsk?.ts === askTs) {
			this.activeAsk = undefined
		}
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		this.askResponseQueuedMessageIds = undefined

		// Switch back to an active state.
		if (this.idleAsk || this.resumableAsk || this.interactiveAsk) {
			this.idleAsk = undefined
			this.resumableAsk = undefined
			this.interactiveAsk = undefined
			this.emit(AlphaCodeEventName.TaskActive, this.taskId)
		}

		if (type === "command" && result.response === "yesButtonClicked") onCommandApproved?.(askTs.toString())
		this.emit(AlphaCodeEventName.TaskAskResponded)
		return result
	}

	/** A superseded ask must return its selected guidance even after a replacement resets the reply slot. */
	private async releaseQueuedAskInput(ask: Task["activeAsk"]): Promise<void> {
		const ids = ask?.queuedMessageIds ?? []
		for (const id of ids.slice().reverse()) this.messageQueueService.releaseMessage(id)
		if (ask && this.activeAsk === ask) {
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			this.askResponseQueuedMessageIds = undefined
			if (this.deferredAskResponse?.kind === "legacy") this.deferredAskResponse = undefined
		}
		if (ids.length) await this.messageQueueService.flush()
	}

	/** Route typed scheduler approvals through the reviewer or existing task ask policy. */
	public async requestToolApproval(
		request: ToolApprovalRequest,
		reviewMessage = request.description,
		onCommandApproved?: (commandExecutionId: string) => void,
	): Promise<ToolApprovalDecision | undefined> {
		const parsedRequest = toolApprovalRequestSchema.safeParse(request)
		if (
			!parsedRequest.success ||
			parsedRequest.data.taskId !== this.taskId ||
			(parsedRequest.data.askType === "command" && reviewMessage !== parsedRequest.data.description)
		) {
			throw new Error("Task received an invalid or mismatched tool approval request.")
		}
		if (this.activeToolApprovalRequest) {
			throw new Error("Task already has a pending tool approval request.")
		}

		this.activeToolApprovalRequest = parsedRequest.data
		this.activeToolApprovalDecision = undefined
		try {
			const reviewedDecision = await this.reviewToolApproval(parsedRequest.data, reviewMessage)
			if (reviewedDecision !== undefined) return reviewedDecision

			const result = await this.ask(
				parsedRequest.data.askType,
				reviewMessage,
				undefined,
				undefined,
				parsedRequest.data.forceApproval,
				parsedRequest.data.requiresExplicitApproval,
				parsedRequest.data,
				...(onCommandApproved && parsedRequest.data.askType === "command"
					? ([onCommandApproved] as const)
					: []),
			)
			if (this.activeToolApprovalDecision) {
				this.markToolApprovalPromptAnswered(parsedRequest.data.requestId)
				return this.activeToolApprovalDecision
			}
			if (result.response === "yesButtonClicked") {
				this.markToolApprovalPromptAnswered(parsedRequest.data.requestId)
				return { decision: "approve_once" }
			}
			if (result.response === "noButtonClicked") {
				this.markToolApprovalPromptAnswered(parsedRequest.data.requestId)
				const feedback = result.text?.trim()
				return { decision: "deny", ...(feedback ? { feedback } : {}) }
			}
			return undefined
		} finally {
			if (this.activeToolApprovalRequest?.requestId === parsedRequest.data.requestId) {
				this.activeToolApprovalRequest = undefined
				this.activeToolApprovalDecision = undefined
			}
		}
	}

	/** Save an explicitly approved static command prefix through the normal global settings store. */
	public async persistCommandApprovalPrefix(prefix: string): Promise<boolean> {
		const amendment = persistentCommandPrefixAmendmentSchema.safeParse({ kind: "command_prefix", prefix })
		if (!amendment.success || this.taskKind !== "primary" || this.abort) return false

		const provider = this.providerRef.deref()
		if (!provider) return false

		const current = provider.getValue("allowedCommands")
		const allowedCommands = Array.isArray(current)
			? current
					.filter((command): command is string => typeof command === "string")
					.map((command) => command.trim())
			: []
		if (!allowedCommands.includes(amendment.data.prefix)) {
			await provider.setValue("allowedCommands", [...allowedCommands.filter(Boolean), amendment.data.prefix])
		}

		try {
			await provider.postStateToWebviewWithoutTaskHistory()
		} catch (error) {
			provider.log(
				`Failed to refresh command approval settings: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		return true
	}

	/**
	 * Review typed approvals before presenting them to the user. The default
	 * reviewer is the user; an injected reviewer can only approve this call once
	 * or deny it, and cannot grant a session amendment.
	 */
	private async reviewToolApproval(
		request: ToolApprovalRequest,
		reviewMessage: string | undefined,
	): Promise<ToolApprovalDecision | undefined> {
		const reviewer = this.toolApprovalReviewer
		if (!reviewer) return undefined

		const signal = this.getTaskCancellationSignal()
		if (signal.aborted) return { decision: "abort" }

		const cancelled = Symbol("approval review cancelled")
		let onAbort: (() => void) | undefined
		const cancellation = new Promise<typeof cancelled>((resolve) => {
			onAbort = () => resolve(cancelled)
			signal.addEventListener("abort", onAbort, { once: true })
			if (signal.aborted) onAbort()
		})

		try {
			const rawOutcome = await Promise.race([
				Promise.resolve().then(() => reviewer(request, signal, reviewMessage)),
				cancellation,
			])
			if (rawOutcome === cancelled || signal.aborted) return { decision: "abort" }

			const outcome = parseToolApprovalReviewOutcome(rawOutcome)
			if (outcome.decision === "fallback_to_user") return undefined

			const decision: ToolApprovalDecision =
				outcome.decision === "approve"
					? { decision: "approve_once" }
					: { decision: "deny", ...(outcome.feedback ? { feedback: outcome.feedback } : {}) }
			if (!request.availableDecisions.includes(decision.decision)) {
				throw new Error(`Approval reviewer selected an unavailable decision: ${decision.decision}`)
			}
			return decision
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort)
		}
	}

	public hasPendingToolApprovalRequest(): boolean {
		return this.activeToolApprovalRequest !== undefined
	}

	private markToolApprovalPromptAnswered(requestId: string): void {
		const messageIndex = findLastIndex(
			this.alphaMessages,
			(message) =>
				message.type === "ask" && message.toolApprovalRequest?.requestId === requestId && !message.isAnswered,
		)
		if (messageIndex === -1) return

		const message = this.alphaMessages[messageIndex]
		message.isAnswered = true
		void this.updateAlphaMessage(message)
		this.saveAlphaMessages().catch((error) => {
			console.error("Failed to save answered tool approval state:", error)
		})
	}

	/** Accept only a decision for the exact currently displayed approval request. */
	public handleWebviewToolApprovalResponse(requestId: string, decision: ToolApprovalDecision): boolean {
		const parsedDecision = toolApprovalDecisionSchema.safeParse(decision)
		const request = this.activeToolApprovalRequest
		if (
			!parsedDecision.success ||
			!request ||
			request.requestId !== requestId ||
			this.activeToolApprovalDecision ||
			!this.activeAsk ||
			this.activeAsk.type !== request.askType ||
			!request.availableDecisions.includes(
				parsedDecision.data.decision as (typeof request.availableDecisions)[number],
			)
		) {
			return false
		}

		if (parsedDecision.data.decision === "timeout") {
			return false
		}
		if (
			parsedDecision.data.decision === "approve_session" &&
			(request.forceApproval || request.requiresExplicitApproval)
		) {
			return false
		}
		if (
			parsedDecision.data.decision === "approve_with_amendment" &&
			(!request.proposedAmendment ||
				parsedDecision.data.amendment.kind !== "exact_command" ||
				parsedDecision.data.amendment.command !== request.proposedAmendment.command)
		) {
			return false
		}
		if (
			parsedDecision.data.decision === "approve_persistently" &&
			(!request.proposedPersistentAmendment ||
				request.forceApproval ||
				request.requiresExplicitApproval ||
				request.commandPathApproval ||
				this.taskKind !== "primary" ||
				parsedDecision.data.amendment.kind !== "command_prefix" ||
				parsedDecision.data.amendment.prefix !== request.proposedPersistentAmendment.prefix)
		) {
			return false
		}

		if (this.externalMutationLease) {
			if (this.deferredAskResponse) return false
			this.deferredAskResponse = {
				kind: "toolApproval",
				requestId,
				decision: parsedDecision.data,
			}
			return true
		}

		this.activeToolApprovalDecision = parsedDecision.data
		this.markToolApprovalPromptAnswered(requestId)
		const askResponse =
			parsedDecision.data.decision === "approve_once" ||
			parsedDecision.data.decision === "approve_session" ||
			parsedDecision.data.decision === "approve_with_amendment" ||
			parsedDecision.data.decision === "approve_persistently"
				? "yesButtonClicked"
				: "noButtonClicked"
		this.handleWebviewAskResponse(
			askResponse,
			parsedDecision.data.decision === "deny" ? parsedDecision.data.feedback : undefined,
		)
		return true
	}

	public async markAsyncUserInputAnswered(messageTs: number): Promise<boolean> {
		if (!Number.isSafeInteger(messageTs) || messageTs < 0) return false
		const committed = await this.commitAlphaMessageMutation(
			messageTs,
			"async user input acknowledgement",
			(message) =>
				message?.type === "say" && message.say === "async_user_input" && !message.isAnswered
					? { ...message, isAnswered: true }
					: undefined,
		)
		if (!committed) return false
		await this.updateAlphaMessage(committed.message)
		return true
	}

	/** Published ask identity is authoritative before delayed attention status appears. */
	public getActiveAskTimestamp(): number | undefined {
		return this.activeAsk?.ts
	}

	/** A restored transcript can reach the UI before its owned resume ask does. */
	public canAcceptHistoryResumeFollowup(): boolean {
		return (
			this.taskKind === "primary" &&
			this.initialHistoryResumePending &&
			!this.abort &&
			!this.abandoned &&
			!this.isTurnActive() &&
			!this.activeToolApprovalRequest &&
			!this.hasPendingSteerMessage() &&
			this.askResponse === undefined &&
			!this.deferredAskResponse &&
			(!this.activeAsk ||
				this.activeAsk.type === "resume_task" ||
				this.activeAsk.type === "resume_completed_task")
		)
	}

	handleWebviewAskResponse(
		askResponse: AlphaAskResponse,
		text?: string,
		images?: string[],
		queuedMessageIds?: string[],
		expectedAskTs?: number,
	): boolean {
		if (expectedAskTs !== undefined && this.activeAsk?.ts !== expectedAskTs) return false
		if (this.askResponse !== undefined || this.deferredAskResponse !== undefined) return false
		this.goalAskAdmission = undefined
		this.invalidateGoalContinuation()
		if (queuedMessageIds?.length && this.activeAsk) this.activeAsk.queuedMessageIds = [...queuedMessageIds]
		// An Apply/Discard lease wins the single-threaded race with a user reply.
		// Resume the ask only after the artifact, ledger, and transcript projection settle.
		if (this.externalMutationLease) {
			this.deferredAskResponse = { kind: "legacy", askResponse, text, images, queuedMessageIds }
			return true
		}

		// Clear any pending auto-approval timeout when user responds
		this.cancelAutoApprovalTimeout()

		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images
		this.askResponseQueuedMessageIds = queuedMessageIds

		if (askResponse === "messageResponse" && (Boolean(text?.trim()) || Boolean(images?.length))) {
			// Human guidance is the recovery boundary the mistake dialog asks for.
			// Clear stale counters before the next request so that guidance reaches
			// the model instead of being intercepted by another dialog.
			this.resetMistakeRecoveryState()
			this.resetCompletionRecoveryState()
		}

		// Create a checkpoint whenever the user sends a message.
		// Use allowEmpty=true to ensure a checkpoint is recorded even if there are no file changes.
		// Suppress the checkpoint_saved chat row for this particular checkpoint to keep the timeline clean.
		if (askResponse === "messageResponse") {
			void this.checkpointSave(false, true)
		}

		// Mark the last follow-up question as answered
		if (
			askResponse === "messageResponse" ||
			askResponse === "yesButtonClicked" ||
			(askResponse === "noButtonClicked" && this.activeAsk?.type === "followup")
		) {
			// Find the last unanswered follow-up message using findLastIndex
			const lastFollowUpIndex = findLastIndex(
				this.alphaMessages,
				(msg) => msg.type === "ask" && msg.ask === "followup" && !msg.isAnswered,
			)

			if (lastFollowUpIndex !== -1) {
				// Mark this follow-up as answered
				this.alphaMessages[lastFollowUpIndex].isAnswered = true
				// Save the updated messages
				this.saveAlphaMessages().catch((error) => {
					console.error("Failed to save answered follow-up state:", error)
				})
			}
		}

		// Mark the last tool-approval ask as answered when user approves (or auto-approval)
		if (askResponse === "yesButtonClicked") {
			const lastToolAskIndex = findLastIndex(
				this.alphaMessages,
				(msg) => msg.type === "ask" && msg.ask === "tool" && !msg.isAnswered,
			)
			if (lastToolAskIndex !== -1) {
				this.alphaMessages[lastToolAskIndex].isAnswered = true
				void this.updateAlphaMessage(this.alphaMessages[lastToolAskIndex])
				this.saveAlphaMessages().catch((error) => {
					console.error("Failed to save answered tool-ask state:", error)
				})
			}
		}
		return true
	}

	/**
	 * Cancel any pending auto-approval timeout.
	 * Called when user interacts (types, clicks buttons, etc.) to prevent the timeout from firing.
	 */
	public cancelAutoApprovalTimeout(notifyQuestionWaiting = false): void {
		// Revocation also covers an ask still admitting settings before its timer is installed.
		this.autoApprovalTimeoutRevision = (this.autoApprovalTimeoutRevision ?? 0) + 1
		if (this.autoApprovalTimeoutRef) {
			clearTimeout(this.autoApprovalTimeoutRef)
			this.autoApprovalTimeoutRef = undefined
		}
		if (notifyQuestionWaiting) this.markActiveFollowupQuestionWaiting()
	}

	private markActiveFollowupQuestionWaiting(expectedAskTs?: number): void {
		const ask = this.activeAsk
		if (
			!ask ||
			ask.type !== "followup" ||
			!ask.published ||
			ask.signal?.aborted ||
			this.abort ||
			this.abandoned ||
			this.didComplete ||
			(expectedAskTs !== undefined && ask.ts !== expectedAskTs) ||
			this.lastMessageTs !== ask.ts ||
			this.askResponse !== undefined ||
			this.deferredAskResponse
		) {
			return
		}
		const message = this.findMessageByTimestamp(ask.ts)
		if (
			!message ||
			message.type !== "ask" ||
			message.ask !== "followup" ||
			message.partial ||
			message.isAnswered ||
			this.interactiveAsk?.ts === ask.ts
		) {
			return
		}
		this.interactiveAsk = message
		this.emit(AlphaCodeEventName.TaskInteractive, this.taskId)
		this.providerRef.deref()?.postMessageToWebview({ type: "interactionRequired", taskId: this.taskId })
	}

	public approveAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("yesButtonClicked", text, images)
	}

	public denyAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("noButtonClicked", text, images)
	}

	public supersedePendingAsk(): void {
		this.lastMessageTs = Math.max(Date.now(), (this.lastMessageTs ?? 0) + 1)
	}

	public markCompleted(): void {
		this.didComplete = true
		this.resetMistakeRecoveryState()
		this.cancelAutoApprovalTimeout()
		this.activeToolApprovalRequest = undefined
		this.activeToolApprovalDecision = undefined
		this.activeAsk = undefined
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		this.askResponseQueuedMessageIds = undefined
		this.idleAsk = undefined
		this.resumableAsk = undefined
		this.interactiveAsk = undefined
		this.deferredAskResponse = undefined
		this.userMessageContentReady = true
	}

	public canMutateWorkspace(): boolean {
		return !this.abort && !this.didComplete && !this.didEmitTaskCompleted
	}

	public async getGoal(): Promise<TaskGoal | undefined> {
		return this.goalController?.get()
	}

	private invalidateGoalContinuation(): void {
		this.goalSteeringGeneration = (this.goalSteeringGeneration ?? 0) + 1
		this.goalHostAdmission = undefined
		this.goalController?.invalidateContinuation()
	}

	private consumeGoalAskAdmission(text: string | undefined): GoalInputAdmission | undefined {
		const pending = this.goalAskAdmission
		this.goalAskAdmission = undefined
		return pending && pending.text === text ? pending.admission : undefined
	}

	private assertGoalMutationAllowed(signal?: AbortSignal): void {
		if (this.taskKind !== "primary" || this.parentTaskId || this.orchestrationParentTaskId) {
			throw new Error("Goals belong to primary tasks only.")
		}
		if (this.abort || this.abandoned || this.taskCancellationController?.signal.aborted || signal?.aborted) {
			throw new Error("The task is stopped. Reopen it from history before changing its goal.")
		}
	}

	private goalMutationStillAllowed(source: "user" | "tool", signal?: AbortSignal): boolean {
		return (
			this.taskKind === "primary" &&
			!this.parentTaskId &&
			!this.orchestrationParentTaskId &&
			!this.abort &&
			!this.abandoned &&
			!this.taskCancellationController?.signal.aborted &&
			!signal?.aborted &&
			this.isCurrentApiConversationHistoryOwner() &&
			(source === "user" || this.taskMode === "code")
		)
	}

	public async createGoal(
		input: TaskGoalCreateInput,
		authority: {
			source: "user" | "tool"
			approved: true
			expectedGoalId?: string | null
			expectedVersion?: number
			expectedControlVersion?: number
		},
		signal?: AbortSignal,
	): Promise<TaskGoal> {
		this.assertGoalMutationAllowed(signal)
		if (authority.approved !== true) throw new Error("Creating a goal requires explicit user approval.")
		if (authority.source === "tool" && (await this.getTaskMode()) !== "code") {
			throw new Error("Goal tools cannot change goals in Plan mode.")
		}
		this.assertGoalMutationAllowed(signal)
		if (!this.goalController) throw new Error("Goal persistence is unavailable.")
		const goal = await this.goalController.create(
			input,
			authority.source === "user" ? "user" : "tool-approved",
			authority.expectedGoalId === undefined
				? undefined
				: {
						goalId: authority.expectedGoalId,
						version: authority.expectedVersion,
						controlVersion: authority.expectedControlVersion,
					},
			() => this.goalMutationStillAllowed(authority.source, signal),
		)
		this.invalidateGoalContinuation()
		if (this.abort || this.abandoned || signal?.aborted) {
			await this.goalController.systemStop(
				"paused",
				{ goalId: goal.goalId, controlVersion: goal.controlVersion },
				() => this.isCurrentApiConversationHistoryOwner(),
			)
			this.assertGoalMutationAllowed(signal)
		}
		if (authority.source === "user") await this.wakeGoalFromHost(goal)
		return goal
	}

	public async updateGoalStatus(
		status: "complete" | "blocked" | "paused",
		authority: {
			source: "user" | "tool"
			approved?: true
			expectedGoalId?: string
			expectedVersion?: number
			expectedControlVersion?: number
		},
		signal?: AbortSignal,
	): Promise<TaskGoal> {
		this.assertGoalMutationAllowed(signal)
		if (status === "paused" && authority.source === "tool" && authority.approved !== true) {
			throw new Error("Pausing a goal requires explicit user approval.")
		}
		if (authority.source === "tool" && (await this.getTaskMode()) !== "code") {
			throw new Error("Goal tools cannot change goals in Plan mode.")
		}
		this.assertGoalMutationAllowed(signal)
		if (!this.goalController) throw new Error("Goal persistence is unavailable.")
		if (status === "complete") {
			const decision = await this.waitForCompletionGateDecision()
			if (!decision.allowed) throw new Error(decision.message ?? "Goal completion still has pending work.")
			this.assertGoalMutationAllowed(signal)
		}
		const goal = await this.goalController.updateStatus(
			status,
			authority.expectedGoalId
				? {
						goalId: authority.expectedGoalId,
						version: authority.expectedVersion,
						controlVersion: authority.expectedControlVersion,
					}
				: undefined,
			() => this.goalMutationStillAllowed(authority.source, signal),
		)
		this.invalidateGoalContinuation()
		return goal
	}

	public async pauseGoal(expectedGoalId?: string, expectedControlVersion?: number): Promise<TaskGoal | undefined> {
		this.assertGoalMutationAllowed()
		if (!this.goalController) throw new Error("Goal persistence is unavailable.")
		const goal = await this.goalController.pause(
			undefined,
			expectedGoalId ? { goalId: expectedGoalId, controlVersion: expectedControlVersion } : undefined,
			() => this.goalMutationStillAllowed("user"),
		)
		if (goal?.status === "paused") this.invalidateGoalContinuation()
		return goal
	}

	public async resumeGoal(
		input?: TaskGoalResumeInput,
		expectedGoalId?: string,
		expectedControlVersion?: number,
	): Promise<TaskGoal> {
		this.assertGoalMutationAllowed()
		if (this.isPaused) throw new Error("Resume the task before resuming its goal.")
		if (!this.goalController) throw new Error("Goal persistence is unavailable.")
		const goal = await this.goalController.resume(
			input,
			expectedGoalId ? { goalId: expectedGoalId, controlVersion: expectedControlVersion } : undefined,
			() => this.goalMutationStillAllowed("user") && !this.isPaused,
		)
		this.invalidateGoalContinuation()
		if (this.abort || this.abandoned) {
			await this.goalController.systemStop(
				"paused",
				{ goalId: goal.goalId, controlVersion: goal.controlVersion },
				() => this.isCurrentApiConversationHistoryOwner(),
			)
			this.assertGoalMutationAllowed()
		}
		await this.wakeGoalFromHost(goal)
		return goal
	}

	public async clearGoal(expectedGoalId?: string, expectedControlVersion?: number): Promise<void> {
		this.assertGoalMutationAllowed()
		await this.goalController?.clear(
			expectedGoalId ? { goalId: expectedGoalId, controlVersion: expectedControlVersion } : undefined,
			() => this.goalMutationStillAllowed("user"),
		)
		this.invalidateGoalContinuation()
	}

	/** Goal progress can end a turn without publishing TaskCompleted. */
	public async completeGoalTurn(text: string): Promise<boolean> {
		const goal = await this.getGoal()
		if (
			!goal ||
			goal.recoveryDeferred ||
			(goal.status !== "active" && goal.status !== "budget_limited") ||
			this.taskKind !== "primary" ||
			(await this.getTaskMode()) !== "code" ||
			this.abort ||
			this.hasGoalPendingInput()
		) {
			return false
		}
		await this.say("text", text, undefined, false)
		if (this.abort || this.hasGoalPendingInput()) return false
		this.goalTurnCompletionText = text
		this.deferAgentResultNotifications = true
		return true
	}

	private hasGoalPendingInput(): boolean {
		return Boolean(
			this.pendingSteerMessage ||
				this.steerMessageAwaitingPersistence ||
				this.messageQueueService?.hasUnconsumedInput() ||
				this.hasPendingAgentMessages() ||
				this.activeAsk ||
				this.externalMutationLease ||
				this.pendingTurnSuspension,
		)
	}

	private isGoalIdleBoundary(): boolean {
		return (
			this.taskKind === "primary" &&
			!this.abort &&
			!this.abandoned &&
			!this.didComplete &&
			!this.isPaused &&
			!this.isStreaming &&
			!this.isAgentTurnEngineActive &&
			!this.contextCondenseAbortController &&
			!this.postTurnCompactionAbortController &&
			!this.taskCancellationController?.signal.aborted &&
			!this.hasGoalPendingInput()
		)
	}

	private async admitGoalContinuation(): Promise<TaskGoal | undefined> {
		if (!this.goalController || !this.isGoalIdleBoundary()) return undefined
		const mode = await this.getTaskMode()
		const boundary = {
			isIdle: this.isGoalIdleBoundary(),
			hasPendingInput: this.hasGoalPendingInput(),
			isPaused: this.isPaused,
			isCancelled: this.abort || this.abandoned,
			mode: mode === "code" ? ("code" as const) : ("architect" as const),
			signal: this.taskCancellationController?.signal,
			isStillAdmissible: () =>
				this.isCurrentApiConversationHistoryOwner() && this.isGoalIdleBoundary() && this.taskMode === "code",
		}
		const reservation = await this.goalController.reserveContinuation(boundary)
		if (!reservation) return undefined
		return this.goalController.consumeContinuation(reservation, boundary)
	}

	private goalContinuationText(goal: TaskGoal): string {
		return `Continue the explicitly requested goal. Use update_goal when the objective is complete or blocked.\n${JSON.stringify(
			{
				objective: goal.objective,
				tokenBudget: goal.tokenBudget,
				tokensUsed: goal.tokensUsed,
				continuationsRemaining: goal.maxContinuations - goal.continuationCount,
			},
		)}`
	}

	private goalInputAdmission(goal: TaskGoal): GoalInputAdmission {
		const steeringGeneration = this.goalSteeringGeneration
		const controller = this.goalController
		const requestGeneration = controller?.getRequestGeneration()
		const isStillCurrent = () =>
			this.goalSteeringGeneration === steeringGeneration &&
			this.goalMutationStillAllowed("user") &&
			!this.abort &&
			!this.abandoned &&
			!this.isPaused &&
			!this.hasGoalPendingInput() &&
			this.taskMode === "code" &&
			!!controller &&
			requestGeneration !== undefined &&
			controller.isRequestCurrent(goal.goalId, requestGeneration)
		return {
			isStillCurrent,
			canWake: async () => {
				const current = await controller?.get()
				return (
					isStillCurrent() &&
					current?.goalId === goal.goalId &&
					current.controlVersion === goal.controlVersion &&
					current.status === "active" &&
					!current.recoveryDeferred
				)
			},
		}
	}

	/** Explicit host creation/resume reuses the existing retained-task input path. */
	private wakeGoalFromHost(goal: TaskGoal): Promise<void> {
		if (this.goalWakePromise) return this.goalWakePromise.then(() => this.wakeGoalFromHost(goal))
		let steeringGeneration = this.goalSteeringGeneration
		const isStillAdmissible = () =>
			steeringGeneration === this.goalSteeringGeneration &&
			this.goalMutationStillAllowed("user") &&
			!this.isPaused
		const canWake = async () => {
			if (!isStillAdmissible() || (await this.getTaskMode()) !== "code") return false
			const current = await this.getGoal()
			return (
				isStillAdmissible() &&
				this.taskMode === "code" &&
				current?.goalId === goal.goalId &&
				current.controlVersion === goal.controlVersion &&
				current.status === "active" &&
				!current.recoveryDeferred
			)
		}
		const wake = Promise.resolve().then(async () => {
			if (!(await canWake())) return
			const goalAdmission = { isStillCurrent: isStillAdmissible, canWake }
			const text = this.goalContinuationText(goal)
			if (this.activeAsk?.type === "resume_task" || this.activeAsk?.type === "resume_completed_task") {
				// The persisted goal supplies recovery evidence for this host reply.
				// Select the existing ask synchronously so a later pause cannot leave
				// synthetic goal input waiting in the human-message queue.
				if (
					!this.messageQueueService.hasUnconsumedInput() &&
					!this.pendingSteerMessage &&
					!this.hasPendingAgentMessages()
				) {
					if (this.handleWebviewAskResponse("messageResponse", text)) {
						steeringGeneration = this.goalSteeringGeneration
						this.goalHostAdmission = goalAdmission
						this.goalAskAdmission = { text, admission: goalAdmission }
					}
				}
				return
			}
			if (this.ownedLifecyclePromise || this.isTaskLoopActive || this.isAgentTurnEngineActive || this.isStreaming)
				return
			if (this.hasGoalPendingInput()) {
				await this.wakeQueuedInputWhenIdle()
				return
			}
			if (this.didComplete) {
				this.goalHostAdmission = goalAdmission
				await this.resumeCompletedTaskFollowup(text, [], "agent", undefined, isStillAdmissible, canWake)
				return
			}
			if (!this._started && !this.isInitialized && this.apiConversationHistory.length === 0) {
				this._started = true
				this.goalHostAdmission = goalAdmission
				this.ownBackgroundLifecycle("start", this.startTask(text, undefined, goalAdmission))
				return
			}
			await this.prepareForRetainedLifecycle()
			if (!(await canWake()) || this.hasGoalPendingInput()) return
			this._started = true
			this.goalHostAdmission = goalAdmission
			this.ownBackgroundLifecycle(
				"resume",
				this.resumeTaskFromHistory(text, undefined, undefined, {
					inputOrigin: "agent",
					reuseRetainedHistory: true,
					goalAdmission,
				}),
			)
		})
		this.goalWakePromise = wake
		void wake
			.finally(() => {
				if (this.goalWakePromise === wake) this.goalWakePromise = undefined
			})
			.catch(() => undefined)
		return wake
	}

	private async loadInheritedGoalBinding(
		ownerTask: Task | undefined,
		captured: Promise<GoalAccountingBinding | undefined>,
		isReload: boolean,
		explicitEffectAdmission = false,
	): Promise<GoalAccountingBinding | undefined> {
		const store = new GoalAccountingBindingStore(this.globalStoragePath, this.taskId)
		void captured.catch(() => undefined)
		const saved = await store.read()
		if (saved?.owner === null) {
			if (explicitEffectAdmission && (await captured))
				throw new TaskPersistenceError("A child created without a goal cannot acquire a later goal owner.")
			return undefined
		}
		const binding = await captured
		const ownerTaskId = this.rootTaskId ?? ownerTask?.rootTaskId ?? ownerTask?.taskId ?? this.parentTaskId
		const controller =
			binding?.controller ??
			ownerTask?.rootTask?.goalController ??
			ownerTask?.goalController ??
			(ownerTaskId
				? new GoalController({
						taskId: ownerTaskId,
						store: new TaskGoalStore(this.globalStoragePath, ownerTaskId),
					})
				: undefined)
		if (saved) {
			if (!saved.owner) return undefined
			if (saved.owner.goalTaskId !== ownerTaskId || !controller)
				throw new TaskPersistenceError("Saved child goal owner does not match its parent.")
			if (
				!saved.owner.drainOnly &&
				explicitEffectAdmission &&
				binding &&
				binding.goalTaskId === saved.owner.goalTaskId &&
				binding.goalId === saved.owner.goalId &&
				binding.controller.isRequestCurrent(binding.goalId, binding.requestGeneration)
			)
				return binding
			return {
				...saved.owner,
				controller,
				requestGeneration:
					!saved.owner.drainOnly &&
					binding?.goalId === saved.owner.goalId &&
					binding.controlVersion === saved.owner.controlVersion
						? binding.requestGeneration
						: -1,
			}
		}
		if (isReload) {
			// Older saved children without admission metadata may carry canonical
			// usage receipts. Preserve their owner for late drain, without inventing
			// fresh request authority from the parent's current objective.
			const history = await this.getSavedApiConversationHistory({ hydrateOnly: true })
			const original = history.flatMap((message) => message.goal_usage_receipts ?? []).at(0)
			if (original && original.goalTaskId === ownerTaskId && controller) {
				const owner = {
					goalTaskId: original.goalTaskId,
					goalId: original.goalId,
					controlVersion: 1,
					drainOnly: true,
				}
				await store.save(owner)
				return { ...owner, controller, requestGeneration: -1 }
			}
			await store.save(undefined)
			if (binding && explicitEffectAdmission)
				throw new TaskPersistenceError(
					"A saved child without goal admission cannot acquire a later goal owner.",
				)
			return undefined
		}
		await store.save(binding)
		return binding
	}

	public async captureGoalAccountingBinding(): Promise<GoalAccountingBinding | undefined> {
		if (this.inheritedGoalBinding) return this.inheritedGoalBinding
		if (this.activeGoalStep) {
			const { controller, goalId, goalTaskId, controlVersion, requestGeneration } = this.activeGoalStep
			return { controller, goalId, goalTaskId, controlVersion, requestGeneration }
		}
		const goal = await this.goalController?.get()
		const requestGeneration = this.goalController?.getRequestGeneration()
		return this.goalController &&
			goal &&
			requestGeneration !== undefined &&
			goal.status === "active" &&
			!goal.recoveryDeferred &&
			this.goalController.isRequestCurrent(goal.goalId, requestGeneration)
			? {
					controller: this.goalController,
					goalId: goal.goalId,
					goalTaskId: this.taskId,
					controlVersion: goal.controlVersion,
					requestGeneration,
				}
			: undefined
	}

	/** Only an explicit managed followup may renew a live child's original owner lease. */
	public async readmitGoalAccountingBinding(
		captured: Promise<GoalAccountingBinding | undefined>,
		parent: Task,
	): Promise<void> {
		if (
			!this.parentTaskId ||
			this.parentTaskId !== parent.taskId ||
			(this.rootTaskId && this.rootTaskId !== (parent.rootTaskId ?? parent.taskId)) ||
			this.abort ||
			this.abandoned ||
			this.taskCancellationController?.signal.aborted ||
			this.isTaskLoopActive ||
			this.isAgentTurnEngineActive ||
			this.isStreaming ||
			!this.isCurrentApiConversationHistoryOwner()
		)
			throw new Error("The saved child cannot accept goal admission while running or stopped.")
		const binding = await this.loadInheritedGoalBinding(parent.rootTask ?? parent, captured, true, true)
		if (
			this.abort ||
			this.abandoned ||
			this.taskCancellationController?.signal.aborted ||
			this.isTaskLoopActive ||
			this.isAgentTurnEngineActive ||
			this.isStreaming ||
			!this.isCurrentApiConversationHistoryOwner() ||
			(binding && !binding.controller.isRequestCurrent(binding.goalId, binding.requestGeneration))
		)
			throw new Error("The child's original goal admission stopped or changed.")
		this.inheritedGoalBinding = Promise.resolve(binding)
		this.goalChildRequiresAdmission = false
	}

	private async beginGoalStep(): Promise<GoalStepAccounting | undefined> {
		if (!this.goalController && !this.inheritedGoalBinding) return undefined
		const binding = await this.captureGoalAccountingBinding()
		if (!binding) return undefined
		if (!binding.controller.isRequestCurrent(binding.goalId, binding.requestGeneration)) return undefined
		const executionMode = (await this.getTaskMode()) === "code" ? "code" : "architect"
		return {
			...binding,
			eventId: `goal-step:${crypto.randomUUID()}`,
			startedAt: Date.now(),
			executionMode,
			accountElapsed: binding.goalTaskId === this.taskId && executionMode === "code",
		}
	}

	private async settleGoalStep(step: GoalStepAccounting | undefined): Promise<void> {
		if (
			!step ||
			step.executionMode === "architect" ||
			step.finished ||
			!this.isCurrentApiConversationHistoryOwner()
		) {
			return
		}
		const receipt = getGoalStepElapsedReceipt(step)
		const message = [...(this.apiConversationHistory ?? [])]
			.reverse()
			.find((candidate) =>
				candidate.goal_usage_receipts?.some((entry) => entry.eventId === step.usageReceipt?.eventId),
			)
		if (message && !message.goal_usage_receipts?.some((entry) => entry.eventId === receipt.eventId)) {
			message.goal_usage_receipts = [...(message.goal_usage_receipts ?? []), receipt]
			const persisted = await this.saveApiConversationHistory()
			if (!this.isCurrentApiConversationHistoryOwner()) return
			if (!persisted) {
				throw new TaskPersistenceError("Goal elapsed usage could not be durably saved.")
			}
		}
		await finishGoalStep(step)
	}

	/** Replay bills only host-validated receipts, without granting any continuation authority. */
	private async reconcileGoalUsageFromHistory(): Promise<void> {
		const root = this.rootTask ?? this.parentTask ?? (this.taskKind === "primary" ? this : undefined)
		const binding = await this.inheritedGoalBinding
		const isChild = Boolean(this.rootTask || this.parentTask || this.parentTaskId || this.taskKind === "subagent")
		if (isChild && !binding) {
			if (this.apiConversationHistory.some((message) => message.goal_usage_receipts?.length))
				throw new TaskPersistenceError("Saved child receipts have no admitted goal owner.")
			return
		}
		const controller = binding?.controller ?? root?.goalController
		const goalTaskId = binding?.goalTaskId ?? root?.taskId
		if (!controller) return
		for (const message of this.apiConversationHistory) {
			if (!message.goal_usage_receipts) continue
			const receipts = taskGoalUsageReceiptsSchema.parse(message.goal_usage_receipts)
			for (const receipt of receipts) {
				if (
					message.role !== "assistant" ||
					receipt.goalTaskId !== goalTaskId ||
					(binding && receipt.goalId !== binding.goalId)
				) {
					throw new TaskPersistenceError("Goal usage receipt belongs to another task.")
				}
				await controller.recordUsage(receipt.eventId, receipt.tokens, receipt.timeMs, receipt.goalId)
			}
		}
	}

	public hasToolResultForCall(callId: string): boolean {
		const id = sanitizeToolUseId(callId)
		return (
			this.persistedToolResultIds.has(id) ||
			this.userMessageContent.some(
				(item) => item.type === "tool_result" && sanitizeToolUseId(item.tool_use_id) === id,
			)
		)
	}

	/** Stop after the current tool protocol boundary instead of spending another model turn. */
	public suspendAfterCurrentTurn(reason: string, kind: "error" | "blocked" = "error"): void {
		// A model's handoff cannot replace a runtime failure already awaiting settlement.
		if (kind === "blocked" && this.pendingTurnSuspension?.kind === "error") return
		this.pendingTurnSuspension = { reason, kind }
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
				(block) =>
					block.type !== "tool_result" || sanitizeToolUseId(getToolResultId(block) ?? "") !== sanitizedId,
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
		const provider = this.providerRef?.deref()
		return provider?.runWorkspaceMutation
			? provider.runWorkspaceMutation(this, "finalize task completion", () =>
					this.commitTaskCompletion(stagedToolCallId),
				)
			: this.commitTaskCompletion(stagedToolCallId)
	}

	private async completionHookTranscriptPath(taskId: string): Promise<string | null> {
		try {
			const filePath = path.join(
				await getTaskDirectoryPath(this.globalStoragePath, taskId),
				GlobalFileNames.apiConversationHistory,
			)
			await fsSync.promises.access(filePath)
			return filePath
		} catch {
			return null
		}
	}

	private assertLifecycleHookOwnership(guard: CanonicalLifecycleEventGuard): void {
		if (!guard()) throw new LifecycleHookOwnershipError()
	}

	/** Bind the native owner and entry-time metadata before any lifecycle adapter can suspend. */
	private captureLifecycleHookInvocation(): TaskLifecycleHookInvocation {
		const guard = this.captureAgentStepOwnership()
		this.assertLifecycleHookOwnership(guard)
		this.completionHookConfig ??= readCompletionHookConfig()
		const step = this.currentAgentStep
		return {
			guard,
			provider: this.providerRef.deref(),
			config: this.completionHookConfig,
			turn: this.captureMessageTurn(),
			context: {
				session_id: this.parentTaskId ?? this.taskId,
				turn_id: step?.turnId ?? this.agentTurnId ?? "",
				cwd: this.cwd,
				model: step?.snapshot.context.provider.modelId ?? this.api?.getModel().id ?? "",
				permission_mode: this.getStepApprovalMode(),
				...(this.taskKind === "subagent"
					? { agent_id: this.taskId, agent_type: this.subagentRole ?? "worker" }
					: {}),
			},
		}
	}

	/** Lifecycle feedback commits through the existing UI queue before it becomes visible. */
	private async publishLifecycleHookMessage(
		text: string,
		invocation: TaskLifecycleHookInvocation,
		signal: AbortSignal,
	): Promise<void> {
		this.assertLifecycleHookOwnership(invocation.guard)
		const isActive = () => invocation.guard() && !signal.aborted && !this.abort && !this.abandoned
		if (!isActive()) return
		let message: AlphaMessage | undefined
		const ownership = { guard: isActive, provider: invocation.provider }
		const saved = await this.enqueueAlphaMessagesSave(
			() => {
				message = {
					ts: this.reserveUiMessageTimestamp(),
					type: "say",
					say: "text",
					text: redactTaskPrivatePaths(this, text),
					turn: invocation.turn,
				}
				return [...structuredClone(this.alphaMessages), message]
			},
			() => {
				if (!message) return
				this.alphaMessages.push(message)
				this.lastMessageTs = message.ts
				this.currentAssistantResponseMessageTs = message.ts
			},
			undefined,
			undefined,
			ownership,
		)
		this.assertLifecycleHookOwnership(invocation.guard)
		if (!isActive()) return
		if (!saved || !message) throw new TaskPersistenceError("Unable to persist lifecycle hook feedback.")
		await this.publishAlphaMessageCreated(message, undefined, ownership)
		this.assertLifecycleHookOwnership(invocation.guard)
	}

	private queueLifecycleHookContext(
		event: LifecycleHookTarget,
		fragments: CompletionHookPromptProvenance["fragments"],
		guard: CanonicalLifecycleEventGuard = this.captureAgentStepOwnership(),
	): void {
		this.assertLifecycleHookOwnership(guard)
		this.pendingLifecycleHookContexts ??= []
		// A current owner may discard obsolete process-local entries; this is not a durable acknowledgment.
		this.pendingLifecycleHookContexts = this.pendingLifecycleHookContexts.filter((entry) => entry.guard())
		if (!fragments.length || this.pendingLifecycleHookContexts.length >= 16) return
		let remaining =
			16_000 -
			this.pendingLifecycleHookContexts.reduce(
				(total, entry) =>
					total + entry.provenance.fragments.reduce((size, fragment) => size + fragment.text.length, 0),
				0,
			)
		const bounded = fragments.flatMap((fragment) => {
			if (remaining <= 0) return []
			const text = fragment.text.slice(0, remaining)
			remaining -= text.length
			return text.trim() ? [{ hook_run_id: fragment.hook_run_id, text }] : []
		})
		if (bounded.length) this.pendingLifecycleHookContexts.push({ provenance: { event, fragments: bounded }, guard })
	}

	private async runCompactionLifecycleHook(
		event: "PreCompact" | "PostCompact",
		trigger: "manual" | "auto",
		signal: AbortSignal,
	): Promise<void> {
		const invocation = this.captureLifecycleHookInvocation()
		const commands = event === "PreCompact" ? invocation.config.preCompact : invocation.config.postCompact
		if (event === "PostCompact" && (commands?.length || invocation.config.sessionStart?.length)) {
			const saved = await this.enqueueAlphaMessagesSave(undefined, undefined, undefined, undefined, {
				guard: invocation.guard,
				provider: invocation.provider,
			})
			if (!saved) {
				this.assertLifecycleHookOwnership(invocation.guard)
				throw new TaskPersistenceError(
					"Unable to persist the successful compaction receipt before lifecycle hooks.",
				)
			}
			this.assertLifecycleHookOwnership(invocation.guard)
			this.throwIfStepInterrupted(signal)
		}
		if (commands?.length) {
			const outcome = await this.runTaskLifecycleHook({ hook_event_name: event, trigger }, signal, invocation)
			this.assertLifecycleHookOwnership(invocation.guard)
			this.throwIfStepInterrupted(signal)
			if (outcome.shouldStop) {
				if (outcome.stopReason) await this.publishLifecycleHookMessage(outcome.stopReason, invocation, signal)
				this.assertLifecycleHookOwnership(invocation.guard)
				throw new LifecycleHookStoppedError(
					event,
					outcome.stopReason ?? t("common:lifecycleHooks.stopped", { event }),
				)
			}
		}
		if (event === "PostCompact" && this.taskKind === "primary" && invocation.config.sessionStart?.length) {
			const outcome = await this.runTaskLifecycleHook(
				{ hook_event_name: "SessionStart", source: "compact" },
				signal,
				invocation,
			)
			this.assertLifecycleHookOwnership(invocation.guard)
			this.throwIfStepInterrupted(signal)
			await this.persistLifecycleHookContexts(invocation.guard, signal)
			this.assertLifecycleHookOwnership(invocation.guard)
			if (outcome.shouldStop)
				throw new LifecycleHookStoppedError(
					event,
					outcome.stopReason ?? t("common:lifecycleHooks.stopped", { event: "SessionStart" }),
				)
		}
	}

	/** Root cleanup keeps its independent deadline and the original native identity after request cancellation. */
	private async runTerminationLifecycleHooks(): Promise<void> {
		if (this.taskKind !== "primary" || this.sessionEndHookConsumed || !this.isCurrentApiConversationHistoryOwner())
			return
		const invocation = this.captureLifecycleHookInvocation()
		const { config, guard } = invocation
		if (!config.sessionEnd?.length && !(this.interruptHookPending && config.interrupt?.length)) return
		this.sessionEndHookConsumed = true
		const signal = AbortSignal.timeout(3_000)
		let cancelTranscriptLookup!: () => void
		const cancelledTranscript = new Promise<null>((resolve) => {
			cancelTranscriptLookup = () => resolve(null)
			signal.addEventListener("abort", cancelTranscriptLookup, { once: true })
		})
		let transcriptPath: string | null
		try {
			transcriptPath = await Promise.race([this.completionHookTranscriptPath(this.taskId), cancelledTranscript])
		} finally {
			signal.removeEventListener("abort", cancelTranscriptLookup)
		}
		if (signal.aborted || !guard()) return
		const context = { ...invocation.context, session_id: this.taskId, transcript_path: transcriptPath }
		if (this.interruptHookPending && config.interrupt?.length) {
			this.interruptHookPending = false
			await runLifecycleHooks(
				config,
				{ ...context, hook_event_name: "Interrupt" },
				AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
			)
			if (!guard()) return
		}
		if (config.sessionEnd?.length && !signal.aborted && guard())
			await runLifecycleHooks(config, { ...context, hook_event_name: "SessionEnd", reason: "other" }, signal)
	}

	private async persistLifecycleHookContexts(
		guard: CanonicalLifecycleEventGuard = this.captureAgentStepOwnership(),
		signal?: AbortSignal,
	): Promise<void> {
		this.assertLifecycleHookOwnership(guard)
		this.throwIfStepInterrupted(signal)
		if (!this.pendingLifecycleHookContexts?.length) return
		this.pendingLifecycleHookContexts = this.pendingLifecycleHookContexts.filter((entry) => entry.guard())
		const pending = [...this.pendingLifecycleHookContexts]
		if (!pending.length) return
		const ownsPending = () => guard() && !signal?.aborted && pending.every((entry) => entry.guard())
		const flushed = await this.flushPendingToolResultsToHistory({ guard: ownsPending })
		this.assertLifecycleHookOwnership(guard)
		this.throwIfStepInterrupted(signal)
		if (!flushed) throw new TaskPersistenceError("Unable to persist tool receipts before lifecycle hook context.")
		for (const entry of pending) {
			this.assertLifecycleHookOwnership(ownsPending)
			if (entry.staged) continue
			this.stageApiUserMessage({
				role: "user",
				input_origin: "agent",
				content: [{ type: "text", text: entry.provenance.fragments.map(({ text }) => text).join("\n\n") }],
				hook_prompt: entry.provenance,
			})
			entry.staged = true
		}
		const saved = await this.saveApiConversationHistory(ownsPending)
		this.assertLifecycleHookOwnership(guard)
		this.throwIfStepInterrupted(signal)
		this.assertLifecycleHookOwnership(ownsPending)
		if (!saved) throw new TaskPersistenceError("Unable to persist lifecycle hook context before the next request.")
		const committed = new Set(pending)
		this.pendingLifecycleHookContexts = this.pendingLifecycleHookContexts.filter((entry) => !committed.has(entry))
	}

	private async runTaskLifecycleHook(
		payload: LifecycleHookPayload,
		signal: AbortSignal,
		captured?: TaskLifecycleHookInvocation,
	): Promise<LifecycleHookOutcome> {
		if (this.pendingHookCleanupFailures?.size) await this.retryPendingHookCleanup()
		signal = AbortSignal.any([signal, this.getTaskLifetimeCancellationSignal()])
		const invocation = captured ?? this.captureLifecycleHookInvocation()
		const { guard, config } = invocation
		this.assertLifecycleHookOwnership(guard)
		try {
			const isCancelled = () => signal.aborted || this.abort || this.abandoned
			if (isCancelled()) return { warnings: [] }
			const transcriptPath = await this.waitForRequestControl(
				this.completionHookTranscriptPath(invocation.context.session_id),
				signal,
			)
			this.assertLifecycleHookOwnership(guard)
			if (isCancelled()) return { warnings: [] }
			const outcome = await runLifecycleHooks(
				config,
				{ ...invocation.context, transcript_path: transcriptPath, ...payload },
				signal,
			)
			this.assertLifecycleHookOwnership(guard)
			if (isCancelled()) return { warnings: [] }
			for (const warning of outcome.warnings) {
				await this.publishLifecycleHookMessage(`Warning: ${warning}`, invocation, signal)
				this.assertLifecycleHookOwnership(guard)
				if (isCancelled()) return { warnings: [] }
			}
			if (outcome.shouldStop) this.lifecycleHookStoppedThisTurn = true
			if (outcome.additionalContext)
				this.queueLifecycleHookContext(payload.hook_event_name, outcome.additionalContext, guard)
			return outcome
		} catch (error) {
			this.retainHookCleanupFailures(error)
			throw error
		} finally {
			this.assertLifecycleHookOwnership(guard)
		}
	}

	/** A steered turn joins its tool receipts before the next input or hook observes its transcript. */
	private async runPendingInterruptLifecycleHook(captured?: TaskLifecycleHookInvocation): Promise<void> {
		if (this.taskKind !== "primary" || !this.interruptHookPending) return
		const invocation = captured ?? this.captureLifecycleHookInvocation()
		const { guard, config } = invocation
		this.assertLifecycleHookOwnership(guard)
		if (!config.interrupt?.length) {
			this.interruptHookPending = false
			return
		}
		const signal = this.getTaskLifetimeCancellationSignal()
		const flushed = await this.waitForRequestControl(this.flushPendingToolResultsToHistory({ guard }), signal)
		this.assertLifecycleHookOwnership(guard)
		if (!flushed)
			throw new TaskPersistenceError("Unable to persist interrupted tool receipts before lifecycle hooks.")
		await this.waitForRequestControl(this.flushApiConversationHistoryPersistence(), signal)
		this.assertLifecycleHookOwnership(guard)
		this.interruptHookPending = false
		await this.runTaskLifecycleHook({ hook_event_name: "Interrupt" }, signal, invocation)
	}

	private async inspectLifecycleHookInput(
		content: readonly Anthropic.Messages.ContentBlockParam[],
		signal: AbortSignal,
		captured?: TaskLifecycleHookInvocation,
	): Promise<LifecycleHookOutcome> {
		const invocation = captured ?? this.captureLifecycleHookInvocation()
		const { guard, config } = invocation
		this.assertLifecycleHookOwnership(guard)
		if (!this.lifecycleHookStartConsumed) {
			this.lifecycleHookStartConsumed = true
			const child = this.taskKind === "subagent" && this.parentTaskId && this.subagentGroupId
			const startHooks = child ? config.subagentStart : config.sessionStart
			if (startHooks?.length && (child || this.taskKind === "primary")) {
				const outcome = await this.runTaskLifecycleHook(
					child
						? {
								hook_event_name: "SubagentStart",
								agent_id: this.taskId,
								agent_type: this.subagentRole ?? "worker",
							}
						: { hook_event_name: "SessionStart", source: this.lifecycleHookStartSource ?? "startup" },
					signal,
					invocation,
				)
				this.assertLifecycleHookOwnership(guard)
				if (outcome.shouldStop || signal.aborted) return outcome
			}
		}
		this.submittedLifecycleHookBlocks ??= new WeakSet()
		const freshHumanBlocks = content.filter(
			(block) =>
				(block.type === "text" || block.type === "image") &&
				this.inputBlockOrigins.get(block) === "human" &&
				!this.submittedLifecycleHookBlocks.has(block),
		)
		if (!freshHumanBlocks.length || !config.userPromptSubmit?.length || signal.aborted) return { warnings: [] }
		const outcome = await this.runTaskLifecycleHook(
			{
				hook_event_name: "UserPromptSubmit",
				prompt: freshHumanBlocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
			},
			signal,
			invocation,
		)
		this.assertLifecycleHookOwnership(guard)
		if (!signal.aborted && !this.abort && !this.abandoned)
			for (const block of freshHumanBlocks) this.submittedLifecycleHookBlocks.add(block)
		return outcome
	}

	private retainHookCleanupFailures(error: unknown, requireOnlyCleanupFailures = false): boolean {
		const seen = new Set<unknown>()
		let retained = false
		const visit = (failure: unknown): boolean => {
			if (seen.has(failure)) return failure instanceof HookCommandCleanupError
			seen.add(failure)
			if (failure instanceof HookCommandCleanupError) {
				this.pendingHookCleanupFailures ??= new Set()
				this.pendingHookCleanupFailures.add(failure)
				retained = true
				return true
			}
			if (!(failure instanceof AggregateError) || failure.errors.length === 0) return false
			// Visit every sibling even when a different failure also prevents completion.
			return failure.errors.map(visit).every(Boolean)
		}
		const cleanupOnly = visit(error)
		return requireOnlyCleanupFailures ? cleanupOnly : retained
	}

	private async retryPendingHookCleanup(): Promise<void> {
		for (;;) {
			const pending = [...(this.pendingHookCleanupFailures ?? [])]
			if (!pending.length) return
			const results = await Promise.allSettled(
				pending.map(async (failure) => {
					try {
						await failure.retryCleanup()
						this.pendingHookCleanupFailures?.delete(failure)
					} catch {
						// Preserve the typed resource owner rather than the retry's raw cause.
						throw failure
					}
				}),
			)
			const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
			if (failures.length === 1) throw failures[0]
			if (failures.length > 1) throw new AggregateError(failures, "Lifecycle hook process cleanup failed")
		}
	}

	/** Run user-configured hooks once for a verified completion candidate. */
	public async evaluateCompletionHooks(
		lastAssistantMessage: string,
	): Promise<{ prompt?: string; hookPrompt?: CompletionHookPromptProvenance }> {
		if (this.pendingHookCleanupFailures?.size) await this.retryPendingHookCleanup()
		if (
			this.abort ||
			this.getTaskLifetimeCancellationSignal().aborted ||
			!this.isCurrentApiConversationHistoryOwner()
		) {
			return {}
		}
		const target =
			this.taskKind === "primary"
				? "Stop"
				: this.parentTaskId && this.subagentGroupId
					? "SubagentStop"
					: undefined
		if (!target) return {}
		const invocation = this.captureLifecycleHookInvocation()
		const { config, context, guard } = invocation
		if ((target === "Stop" ? config.stop : config.subagentStop).length === 0) {
			return {}
		}
		const stopHookActive = this.completionHookActive
		const lifetimeSignal = this.getTaskLifetimeCancellationSignal()
		const interruptionSignal = this.stepInterruptionController?.signal
		const signal = interruptionSignal ? AbortSignal.any([lifetimeSignal, interruptionSignal]) : lifetimeSignal
		const interrupted = () => signal.aborted || this.abort || this.abandoned || Boolean(this.pendingSteerMessage)
		const isCurrent = () => {
			this.assertLifecycleHookOwnership(guard)
			return !interrupted()
		}
		try {
			const transcriptPath = await this.waitForRequestControl(
				this.completionHookTranscriptPath(context.session_id),
				signal,
			)
			if (!isCurrent()) return {}
			const agentTranscriptPath =
				target === "SubagentStop"
					? await this.waitForRequestControl(this.completionHookTranscriptPath(this.taskId), signal)
					: undefined
			if (!isCurrent()) return {}
			const outcome = await runCompletionHooks(
				config,
				{
					...context,
					hook_event_name: target,
					transcript_path: transcriptPath,
					stop_hook_active: stopHookActive,
					last_assistant_message: lastAssistantMessage.slice(0, 16_000),
					...(target === "SubagentStop" ? { agent_transcript_path: agentTranscriptPath } : {}),
				},
				signal,
			)
			if (!isCurrent()) return {}
			for (const warning of outcome.warnings) {
				await this.publishLifecycleHookMessage(`Warning: ${warning}`, invocation, signal)
				if (!isCurrent()) return {}
			}
			if (outcome.shouldStop && outcome.stopReason) {
				await this.publishLifecycleHookMessage(outcome.stopReason, invocation, signal)
				if (!isCurrent()) return {}
			}
			if (!outcome.prompt || !isCurrent()) return {}
			this.completionHookActive = true
			const hookPrompt: CompletionHookPromptProvenance = { event: target, fragments: outcome.fragments ?? [] }
			this.pendingCompletionHookPrompt = hookPrompt
			return { prompt: outcome.prompt, hookPrompt }
		} catch (error) {
			if (this.retainHookCleanupFailures(error)) throw error
			this.assertLifecycleHookOwnership(guard)
			if (interrupted()) return {}
			throw error
		}
	}

	private async commitTaskCompletion(stagedToolCallId?: string): Promise<boolean> {
		if (this.didEmitTaskCompleted) return false
		const goalSteeringGeneration = this.goalSteeringGeneration ?? 0
		const goalRequestGeneration = this.goalController?.getRequestGeneration()
		const activeGoal = await this.getGoal()
		if (activeGoal?.status === "active" && !activeGoal.recoveryDeferred && (await this.getTaskMode()) === "code") {
			return false
		}
		if (
			this.didEmitTaskCompleted ||
			goalSteeringGeneration !== (this.goalSteeringGeneration ?? 0) ||
			goalRequestGeneration !== this.goalController?.getRequestGeneration()
		)
			return false

		// Reserve the transition before awaiting the persistence barrier so concurrent
		// acceptance paths cannot publish the same completion twice.
		this.didEmitTaskCompleted = true
		let preparedPrimaryLifecycle = false
		let verificationRejection: string | undefined
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
			await this.flushApiConversationHistoryPersistence()
			this.getMutableCompletionStageMetrics().persistenceSettledAt = Date.now()
			const transcriptQueue = this.apiConversationHistorySaveQueue
			const completionSignal = this.getTaskLifetimeCancellationSignal()
			let finalDecision: CompletionGateDecision
			try {
				// Receipt publishers also need the mutation gate, so bound one snapshot
				// read here without polling or joining their work inside the gate.
				finalDecision = await this.waitForRequestControl(
					this.getCompletionGateDecision(),
					completionSignal,
					Date.now() + 30_000,
				)
			} catch (error) {
				if (error instanceof ApiStreamDeadlineError) {
					verificationRejection = t("common:errors.completion_evidence_read_timeout")
				} else if (completionSignal.aborted) {
					verificationRejection = t("common:errors.completion_evidence_read_interrupted")
				}
				throw error
			}
			if (!finalDecision.allowed || this.abort || completionSignal.aborted) {
				verificationRejection = finalDecision.message ?? "Task completion was interrupted."
				throw new Error(verificationRejection)
			}
			// The verification decision remains the last asynchronous gate. A save
			// admitted while it was pending requires a fresh completion attempt,
			// not another await that could stale the Stage 3 verification decision.
			if (this.providerTranscriptSidecarFailure) throw this.providerTranscriptSidecarFailure
			if (
				transcriptQueue !== this.apiConversationHistorySaveQueue ||
				(Task.apiConversationHistoryPendingCounts.get(this.apiConversationHistoryPersistenceKey) ?? 0) > 0
			) {
				throw new Error("Transcript persistence is still pending at task completion.")
			}

			// User guidance wins any race with the asynchronous persistence barriers
			// above. No await occurs between this check and markCompleted().
			if (
				this.messageQueueService.hasUnconsumedInput() ||
				this.hasPendingAgentMessages() ||
				goalSteeringGeneration !== (this.goalSteeringGeneration ?? 0) ||
				goalRequestGeneration !== this.goalController?.getRequestGeneration()
			) {
				if (stagedToolCallId) await this.rollbackPersistedToolResult(stagedToolCallId)
				if (preparedPrimaryLifecycle) {
					await this.providerRef.deref()?.rollbackTaskCompletionLifecycle(this.taskId)
				}
				await this.retractCompletionResult()
				this.didEmitTaskCompleted = false
				return false
			}

			this.markCompleted()
			const completionMetrics = this.getMutableCompletionStageMetrics()
			completionMetrics.completedAt = Date.now()
			completionMetrics.lastReasonCode = "ready"
			completionMetrics.settledUsage = this.getTokenUsage()
			this.emitFinalTokenUsageUpdate()
			TelemetryService.instance.captureTaskCompleted(this.taskId)
			this.emit(AlphaCodeEventName.TaskCompleted, this.taskId, this.getTokenUsage(), this.toolUsage)
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
			if (verificationRejection) {
				await this.retractCompletionResult()
				if (this.hasPendingAgentMessages()) return false
				this.suspendAfterCurrentTurn(`Task remains incomplete and unverified. ${verificationRejection}`)
				return false
			}
			throw error
		}
	}

	/**
	 * Load the single durable completion decision used by both explicit
	 * `attempt_completion` calls and provider text-only completion fallback.
	 * Completion always fails closed when the provider or its ledger is unavailable.
	 */
	public async getCompletionGateDecision(): Promise<CompletionGateDecision> {
		if (this.hasPendingAgentMessages()) return this.pendingAgentMessageDecision()
		const reviewDecision = this.getPendingSubagentReviewCompletionDecision()
		if (reviewDecision) return reviewDecision
		const todoDecision = this.getOpenTodoCompletionDecision()
		if (todoDecision) return todoDecision

		const runtimeDecision = this.getPendingCompletionRuntimeDecision()
		if (runtimeDecision) return runtimeDecision
		const provider = this.providerRef?.deref()
		if (!provider || typeof provider.getParentCompletionDecision !== "function") {
			return {
				allowed: false,
				classification: "blocked",
				reasonCode: "persistence_unavailable",
				modelCanResolveRejection: false,
				message:
					"Cannot verify completion because the durable completion decision is unavailable. The task remains incomplete; restore task persistence before resuming.",
			}
		}

		try {
			await this.pendingCommandVerification
			const runtimeRevision = this.completionRuntimeRevision
			const backgroundExecutions = JSON.stringify(this.getActiveBackgroundCommandExecutionIds())
			const outstanding =
				this.workContext?.plan && !this.isLookupStyleCompletionTurn()
					? await getOutstandingAcceptanceChecks(
							this.workContext,
							this.cwd,
							(file) => this.alphaIgnoreController?.validateAccess(file) ?? true,
						)
					: []
			const decision = await provider.getParentCompletionDecision(this, {
				deferResultNotifications: this.deferAgentResultNotifications,
			})
			// Commands and evidence publication can start while the durable snapshot is read.
			const lateRuntimeDecision = this.getPendingCompletionRuntimeDecision()
			if (this.hasPendingAgentMessages()) return this.pendingAgentMessageDecision()
			const lateReviewDecision = this.getPendingSubagentReviewCompletionDecision()
			if (lateReviewDecision) return lateReviewDecision
			if (lateRuntimeDecision) return lateRuntimeDecision
			if (
				runtimeRevision !== this.completionRuntimeRevision ||
				backgroundExecutions !== JSON.stringify(this.getActiveBackgroundCommandExecutionIds())
			) {
				return {
					allowed: false,
					classification: "waiting",
					reasonCode: "evidence_pending",
					modelCanResolveRejection: false,
					message:
						"Command evidence changed while reading the completion decision. Refresh the durable evidence before completing.",
				}
			}
			if (outstanding.length && decision.allowed)
				return {
					allowed: false,
					classification: "repairable",
					reasonCode: "verification_missing",
					modelCanResolveRejection: true,
					blockerKey: JSON.stringify(outstanding),
					message: `Declared acceptance checks need attention: ${outstanding.join("; ")}. Run only the relevant checks, repair failures, or report a blocked outcome when evidence is unavailable.`,
				}
			if (decision.allowed)
				return { ...decision, classification: "ready", reasonCode: "ready", modelCanResolveRejection: true }
			const obligations = decision.blockingObligations ?? []
			const unavailable = obligations.some((item) => item.scopeUnresolved)
			const receiptPending = obligations.some((item) => item.mutationReservations?.length)
			const resultsPending = (decision.unconsumedResultCount ?? 0) > 0
			const descendantsPending = (decision.activeDescendantCount ?? 0) > 0 && !resultsPending
			const waitReason = !unavailable
				? receiptPending
					? "receipt_pending"
					: descendantsPending
						? "descendants_running"
						: undefined
				: undefined
			// Earlier command diagnostics cannot override a current receipt/child wait.
			// In particular, orphan-receipt deadlines depend on this runtime reason.
			if (waitReason) {
				return {
					...decision,
					classification: "waiting",
					reasonCode: waitReason,
					modelCanResolveRejection: false,
				}
			}
			if (!unavailable && resultsPending) {
				return {
					...decision,
					classification: "repairable",
					reasonCode: "child_results_unconsumed",
					modelCanResolveRejection: true,
				}
			}
			const diagnostic = this.getCompletionVerificationDiagnostic(obligations)
			const diagnosticUnavailable =
				diagnostic &&
				[
					"unavailable_scope",
					"unavailable_content",
					"unsupported_configuration",
					"runtime_scope_unavailable",
				].includes(diagnostic.code)
			return {
				...decision,
				message: diagnostic
					? `${decision.message ?? "Required verification is missing."}\nVerification evidence (${diagnostic.code}): ${diagnostic.message}`
					: decision.message,
				classification: unavailable || diagnosticUnavailable ? "blocked" : "repairable",
				reasonCode: unavailable
					? "scope_unavailable"
					: (diagnostic?.code ??
						(obligations.some((item) => item.status === "failed")
							? "verification_failed"
							: obligations.length > 0
								? "verification_missing"
								: "managed_results_pending")),
				modelCanResolveRejection: !unavailable && !diagnosticUnavailable,
			}
		} catch {
			return {
				allowed: false,
				classification: "blocked",
				reasonCode: "persistence_unavailable",
				modelCanResolveRejection: false,
				message:
					"Cannot verify completion because durable verification evidence is unavailable. The task remains incomplete; restore task persistence before resuming.",
			}
		}
	}

	private getCompletionVerificationDiagnostic(
		obligations: readonly ParentVerificationObligation[],
	): CommandVerificationDiagnostic | { code: "stale_content"; message: string } | undefined {
		const commands = [...(this.commandExecutionEvidence?.values() ?? [])].reverse()
		for (const obligation of obligations) {
			const latest = commands.find(
				(item) =>
					item.status !== "running" &&
					item.startedAt >= (obligation.appliedAt ?? 0) &&
					(item.verificationChangeSetIds?.includes(obligation.changeSetId) ||
						item.verificationDiagnostics?.some(
							(diagnostic) =>
								diagnostic.code === "missing_change_set" || diagnostic.code === "unknown_change_set",
						)),
			)
			if (!latest) continue
			const diagnostic = latest.verificationDiagnostics?.find(
				(item) => !item.changeSetId || item.changeSetId === obligation.changeSetId,
			)
			if (diagnostic) return diagnostic
			const captured = latest.verificationVersions?.[obligation.changeSetId]
			if (captured && captured.contentVersion !== obligation.contentVersion) {
				return {
					code: "stale_content",
					message: `Change set ${obligation.changeSetId} requires content version ${obligation.contentVersion}; the command captured version ${captured.contentVersion}. Run only the remaining checks for the current content and exact change-set association.`,
				}
			}
		}
		return undefined
	}

	private getPendingCompletionRuntimeDecision(): CompletionGateDecision | undefined {
		const commandRunning = this.shouldWaitForCommandCompletion()
		if (!commandRunning && !(this.pendingCommandVerificationCount > 0)) return undefined
		return {
			allowed: false,
			classification: "waiting",
			reasonCode: commandRunning ? "command_running" : "evidence_pending",
			modelCanResolveRejection: false,
			message: commandRunning
				? "A command or its content receipt is still running. The runtime is waiting for its terminal outcome; do not rerun the command."
				: "The command has ended and its verification evidence is being persisted. The runtime is waiting for that receipt; do not rerun verification.",
		}
	}

	private shouldWaitForCommandCompletion(): boolean {
		const running = [...(this.commandExecutionEvidence?.values() ?? [])].filter(
			(evidence) => evidence.status === "running",
		)
		if (running.length === 0) return false
		const activeBackgroundExecutions = new Set(this.getActiveBackgroundCommandExecutionIds())
		const lookup = this.isLookupStyleCompletionTurn()
		return running.some(
			(evidence) =>
				!activeBackgroundExecutions.has(evidence.executionId) &&
				!(lookup && this.isUnscopedBackgroundCommand(evidence)),
		)
	}

	/** Runtime ownership, never persisted history or command spelling, permits a process to outlive its turn. */
	public getActiveBackgroundCommandExecutionIds(): string[] {
		if (this.taskKind !== "primary") return []
		const terminals = TerminalRegistry.getTerminals(true, this.taskId)
		return [...(this.commandExecutionEvidence?.values() ?? [])]
			.filter(
				(evidence) =>
					this.isUnscopedBackgroundCommand(evidence) &&
					terminals.some(
						(terminal) =>
							terminal.taskId === this.taskId &&
							terminal.running &&
							terminal.process?.executionId === evidence.executionId &&
							terminal.process.isSettled === false,
					),
			)
			.map((evidence) => evidence.executionId)
			.sort()
	}

	private isUnscopedBackgroundCommand(evidence: CommandExecutionEvidence): boolean {
		return (
			evidence.status === "running" &&
			evidence.returnedInBackground === true &&
			!evidence.verificationChangeSetIds?.length &&
			!evidence.acceptanceChecks?.length
		)
	}

	private isLookupStyleCompletionTurn(): boolean {
		if (this.taskKind !== "primary") return false
		return (
			classifyRequestWorkClass(this.getUserRequestTextForCatalog(), { taskKind: this.taskKind }).class ===
			"lookup"
		)
	}

	/** Wait outside the workspace mutation gate: receipt publishers need that gate to settle. */
	public async waitForCompletionGateDecision(): Promise<CompletionGateDecision> {
		let lease = this.beginAgentWait()
		const startedAt = Date.now()
		let orphanReceiptDeadline: number | undefined
		let runningCommandDeadline: number | undefined
		let orphanReceiptTimedOut = false
		let timedOut = false
		let waited = false
		let publishedWait = false
		let lastDecision: CompletionGateDecision | undefined
		try {
			while (true) {
				try {
					lastDecision = await this.waitForRequestControl(
						this.getCompletionGateDecision(),
						lease.signal,
						Date.now() + 30_000,
					)
				} catch (error) {
					timedOut = error instanceof ApiStreamDeadlineError
					throw error
				}
				if (lastDecision.classification !== "waiting") return lastDecision
				if (lastDecision.reasonCode === "review_pending") {
					// Review uses the same control lease as the pre-request pause.
					// Release this observer before that wait owns steering and Stop.
					waited = true
					lease.dispose()
					await this.waitForPendingSubagentChangeSetReviews()
					lease = this.beginAgentWait()
					continue
				}
				if (lastDecision.reasonCode === "command_running") {
					runningCommandDeadline ??= Date.now() + 30_000
					if (Date.now() >= runningCommandDeadline) {
						timedOut = true
						throw new Error("Completion command observation timed out")
					}
				} else runningCommandDeadline = undefined
				waited = true
				if (!publishedWait) {
					await this.publishCompletionWaitStatus(lastDecision, true)
					publishedWait = true
				}
				if (lastDecision.reasonCode === "receipt_pending") {
					orphanReceiptDeadline ??= Date.now() + 30_000
					if (Date.now() >= orphanReceiptDeadline) {
						timedOut = true
						orphanReceiptTimedOut = true
						throw new Error("Mutation receipt has no active publisher")
					}
				} else orphanReceiptDeadline = undefined
				// Tracked evidence publication is joined directly. Standalone durable
				// receipts have no local publisher; bounded runtime polls recheck the ledger.
				await this.waitForRequestControl(
					this.pendingCommandVerificationCount > 0
						? this.pendingCommandVerification
						: delayWithAbort(250, lease.signal),
					lease.signal,
					this.pendingCommandVerificationCount > 0 ? Date.now() + 30_000 : undefined,
				)
			}
		} catch (error) {
			timedOut ||= error instanceof ApiStreamDeadlineError
			return {
				allowed: false,
				classification: "blocked",
				reasonCode: timedOut
					? "runtime_timeout"
					: lease.signal.aborted
						? "interrupted"
						: "persistence_unavailable",
				modelCanResolveRejection: false,
				message: orphanReceiptTimedOut
					? t("common:errors.mutation_receipt_orphaned")
					: timedOut
						? `Task remains incomplete and unverified because runtime settlement did not finish within 30 seconds. ${lastDecision?.message ?? "Durable completion evidence is unavailable."} Resume after the existing operation settles.`
						: lease.signal.aborted
							? "Completion was interrupted; pending user guidance and unresolved evidence are preserved."
							: "Task remains incomplete because verification evidence could not be persisted. Restore task persistence before resuming.",
			}
		} finally {
			lease.dispose()
			if (publishedWait) await this.publishCompletionWaitStatus(undefined, false)
			if (waited) this.getMutableCompletionStageMetrics().runtimeWaitMs += Math.max(0, Date.now() - startedAt)
		}
	}

	private async publishCompletionWaitStatus(
		decision: CompletionGateDecision | undefined,
		active: boolean,
	): Promise<void> {
		try {
			this.providerRef.deref()?.markCompletionWait?.(this.taskId, active ? decision?.reasonCode : undefined)
			if (typeof this.say !== "function" || !Array.isArray(this.alphaMessages)) return
			if (!active) {
				await this.say("api_req_rate_limit_wait", undefined, undefined, false)
				return
			}
			if (decision?.classification !== "waiting") return
			await this.say(
				"api_req_rate_limit_wait",
				JSON.stringify({ kind: "completion", reason: decision.reasonCode ?? "command_running" }),
				undefined,
				true,
			)
		} catch {
			// Chat/lifecycle wait status is best-effort and must not change the gate decision.
		}
	}
	private getMutableCompletionStageMetrics(): CompletionStageMetrics {
		return (this.completionStageMetrics ??= {
			candidateCount: 0,
			rejectionCount: 0,
			repairToolCount: 0,
			runtimeWaitMs: 0,
		})
	}

	/** Bounded redacted counters, independent from persisted lifecycle authority. */
	public getCompletionStageMetrics(): Readonly<CompletionStageMetrics> {
		return structuredClone(this.getMutableCompletionStageMetrics())
	}

	public recordCompletionCandidate(): void {
		const metrics = this.getMutableCompletionStageMetrics()
		if (metrics.firstCandidateAt === undefined) {
			metrics.firstCandidateAt = Date.now()
			metrics.firstCandidateUsage = this.getTokenUsage()
		}
		metrics.candidateCount++
	}

	/** Real user guidance starts a new repair allowance; automatic recovery text does not. */
	public resetCompletionRecoveryState(): void {
		this.completionRecovery?.reset()
		this.completionRecoveryActive = false
	}

	/** Charge actual model feedback, never internal gate reads or runtime waiting. */
	public recordCompletionRejection(decision: CompletionGateDecision): CompletionGateDecision {
		if (decision.allowed) return decision
		const metrics = this.getMutableCompletionStageMetrics()
		metrics.rejectionCount++
		metrics.lastReasonCode = decision.reasonCode
		if (!decision.modelCanResolveRejection) {
			metrics.blockedAt = Date.now()
			metrics.settledUsage = this.getTokenUsage()
			return decision
		}
		this.completionRecoveryActive = true
		if (!(this.completionRecovery ??= new CompletionRecovery()).reject(decision)) return decision
		metrics.blockedAt = Date.now()
		metrics.settledUsage = this.getTokenUsage()
		metrics.lastReasonCode = "repair_limit"
		return {
			...decision,
			classification: "blocked",
			reasonCode: "repair_limit",
			modelCanResolveRejection: false,
			message: `Task remains incomplete and unverified after repeated attempts to resolve the same obligation. ${decision.message ?? "Required evidence is missing."}`,
		}
	}
	/** Return the user-configured todo completion policy shared by every completion path. */
	public getOpenTodoCompletionDecision(): (CompletionGateDecision & { message: string }) | undefined {
		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)
		const hasIncompleteTodos = this.todoList?.some((todo) => todo.status !== "completed") === true

		return preventCompletionWithOpenTodos && hasIncompleteTodos
			? {
					allowed: false,
					modelCanResolveRejection: true,
					classification: "repairable",
					reasonCode: "todos_open",
					blockerKey: JSON.stringify(this.todoList?.filter((todo) => todo.status !== "completed")),
					message: OPEN_TODO_COMPLETION_MESSAGE,
				}
			: undefined
	}

	/** Return an accepted text-only completion through the legacy blocking handoff, when applicable. */
	private async returnCompletionToLegacyParent(result: string): Promise<boolean> {
		if (this.taskKind !== "primary" || !this.parentTaskId) return false

		const provider = this.providerRef.deref()
		if (!provider) throw new Error("Cannot return legacy child completion because the provider is unavailable")
		const { historyItem } = await provider.getTaskWithId(this.taskId, { includeApiConversationHistory: false })
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
		this.completionRuntimeRevision = (this.completionRuntimeRevision ?? 0) + 1
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

	public async admitCommandExecution(
		toolCallId: string,
		executionId: string,
		command: string,
		cwd: string,
		verificationChangeSetIds?: readonly string[],
	): Promise<void> {
		const commandCwd = await fsSync.promises.realpath(cwd)
		const verificationDiagnostics: CommandVerificationDiagnostic[] = []
		let verificationVersions: CommandExecutionEvidence["verificationVersions"]
		try {
			verificationVersions = await this.providerRef
				?.deref()
				?.captureCommandVerification?.(this, command, commandCwd, verificationChangeSetIds, (diagnostic) => {
					if (verificationDiagnostics.length < 16) verificationDiagnostics.push(diagnostic)
				})
		} catch {
			verificationDiagnostics.push({
				code: "unavailable_scope",
				message:
					"Verification scope could not be captured. The command can run, but cannot receive scoped verification credit.",
			})
		}
		if (this.abort) throw new Error("Command admission was cancelled")
		await this.pendingCommandVerification
		await this.prepareCommandEvidenceSlot(toolCallId)
		if (this.abort) throw new Error("Command admission was cancelled")
		this.beginCommandExecution(toolCallId, executionId, command, verificationChangeSetIds)
		const evidence = this.commandExecutionEvidence.get(toolCallId)!
		evidence.cwd = commandCwd
		evidence.verificationVersions = structuredClone(verificationVersions)
		evidence.verificationDiagnostics = verificationDiagnostics
		await this.enqueueCommandEvidence(async () => {
			evidence.acceptanceChecks = await captureAcceptanceChecks(
				this.workContext,
				this.cwd,
				command,
				commandCwd,
				executionId,
				(file) => this.alphaIgnoreController?.validateAccess(file) ?? true,
			)
			if (evidence.acceptanceChecks.length && this.workContext) {
				this.workContext = {
					...this.workContext,
					receipts: [
						...this.workContext.receipts.filter(
							(receipt) => !evidence.acceptanceChecks!.some((item) => item.checkId === receipt.checkId),
						),
						...evidence.acceptanceChecks,
					],
				}
				await this.requireAlphaMessagesSaved("acceptance check admission")
			}
		})
	}

	/** Terminal attempt observation only; no process or verification was admitted. */
	private recordDeniedCommandAttempt(toolCallId: string, command: string): void {
		if (this.abort || this.didComplete || this.commandExecutionEvidence.has(toolCallId)) return
		if (this.getCurrentEffectStartedToolCallIds().has(sanitizeToolUseId(toolCallId))) return
		for (const [id, evidence] of this.commandExecutionEvidence) {
			if (this.commandExecutionEvidence.size < 128) break
			// Diagnostic attempts must not displace pending receipts or live verification inputs.
			if (
				evidence.status !== "running" &&
				!evidence.acceptanceChecks?.length &&
				!evidence.verificationChangeSetIds?.length &&
				!Object.keys(evidence.verificationVersions ?? {}).length &&
				!evidence.verificationDiagnostics?.length
			) {
				this.commandExecutionEvidence.delete(id)
			}
		}
		if (this.commandExecutionEvidence.size >= 128) return
		const observedAt = Date.now()
		this.commandExecutionEvidence.set(toolCallId, {
			toolCallId,
			// This is a diagnostic attempt identity, never a process or command-session ID.
			executionId: `denied:${toolCallId}`,
			status: "denied",
			command,
			startedAt: observedAt,
			completedAt: observedAt,
		})
		this.completionRuntimeRevision = (this.completionRuntimeRevision ?? 0) + 1
	}

	private async prepareCommandEvidenceSlot(toolCallId: string): Promise<void> {
		this.commandExecutionEvidence.delete(toolCallId)
		if (this.commandExecutionEvidence.size >= 128) {
			await this.pendingCommandVerification
			for (const [id, evidence] of this.commandExecutionEvidence) {
				if (evidence.status !== "running") this.commandExecutionEvidence.delete(id)
				if (this.commandExecutionEvidence.size < 128) break
			}
		}
	}

	/** Joined inspections record process outcomes without claiming verification of workspace mutations. */
	public async recordCommandInspectionResult(evidence: CommandExecutionEvidence): Promise<void> {
		const previous = this.commandExecutionEvidence.get(evidence.toolCallId)
		if (previous?.executionId === evidence.executionId && previous.status !== "running") return
		await this.prepareCommandEvidenceSlot(evidence.toolCallId)
		this.commandExecutionEvidence.set(evidence.toolCallId, {
			toolCallId: evidence.toolCallId,
			executionId: evidence.executionId,
			command: evidence.command,
			cwd: evidence.cwd,
			startedAt: evidence.startedAt,
			completedAt: evidence.completedAt,
			status: this.abort ? "cancelled" : evidence.status,
			...(previous?.executionId === evidence.executionId && previous.returnedInBackground
				? { returnedInBackground: true }
				: {}),
			exitCode: evidence.exitCode,
			signalName: evidence.signalName,
		})
		this.completionRuntimeRevision = (this.completionRuntimeRevision ?? 0) + 1
		this.publishParentVerificationEvidence()
	}

	public completeCommandExecution(
		toolCallId: string,
		details: {
			exitCode?: number
			signalName?: string
		},
		executionId?: string,
	): void {
		const evidence = this.commandExecutionEvidence.get(toolCallId)
		if (!evidence || evidence.status !== "running" || (executionId && evidence.executionId !== executionId)) return
		evidence.status = this.abort
			? "cancelled"
			: details.exitCode === 0 && !details.signalName
				? "succeeded"
				: "failed"
		evidence.exitCode = details.exitCode
		evidence.signalName = details.signalName
		evidence.completedAt = Date.now()
		this.completionRuntimeRevision = (this.completionRuntimeRevision ?? 0) + 1
		this.publishParentVerificationEvidence()
	}

	public failCommandExecution(
		toolCallId: string,
		status: Exclude<CommandExecutionEvidenceStatus, "running" | "succeeded"> = "failed",
		executionId?: string,
	): void {
		const evidence = this.commandExecutionEvidence.get(toolCallId)
		if (!evidence || evidence.status !== "running" || (executionId && evidence.executionId !== executionId)) return
		evidence.status = status
		evidence.completedAt = Date.now()
		this.completionRuntimeRevision = (this.completionRuntimeRevision ?? 0) + 1
		this.publishParentVerificationEvidence()
	}

	/** Serialize working-record reads and writes with terminal evidence publication. */
	private enqueueCommandEvidence(operation: () => Promise<void>): Promise<void> {
		this.pendingCommandVerificationCount = (this.pendingCommandVerificationCount ?? 0) + 1
		this.pendingCommandVerification = (this.pendingCommandVerification ?? Promise.resolve())
			.catch(() => undefined)
			.then(operation)
			.finally(() => {
				this.pendingCommandVerificationCount--
			})
		return this.pendingCommandVerification
	}

	private publishParentVerificationEvidence(): void {
		if (this.taskKind === "subagent" && !this.workContext?.plan) return
		const provider = this.providerRef.deref()
		if (!provider) return
		const publication = this.enqueueCommandEvidence(async () => {
			for (const evidence of this.commandExecutionEvidence.values()) {
				if (evidence.status === "running" || !evidence.acceptanceChecks?.length || !this.workContext) continue
				this.workContext = await settleAcceptanceChecks(
					this.workContext,
					this.cwd,
					evidence.acceptanceChecks,
					evidence.status === "succeeded",
					evidence.exitCode,
					(file) => this.alphaIgnoreController?.validateAccess(file) ?? true,
				)
				await this.requireAlphaMessagesSaved("acceptance evidence")
				evidence.acceptanceChecks = undefined
			}
			if (this.taskKind !== "subagent") await provider.recordParentVerificationEvidence(this)
		})
		void publication.catch((error) =>
			console.error(`[Task] Failed to persist parent verification evidence: ${String(error)}`),
		)
	}

	public getCommandExecutionEvidence(): CommandExecutionEvidence[] {
		return structuredClone([...this.commandExecutionEvidence.values()])
	}

	public markCommandExecutionBackgrounded(toolCallId: string, executionId: string): void {
		const evidence = this.commandExecutionEvidence.get(toolCallId)
		if (evidence?.executionId === executionId && !evidence.returnedInBackground) {
			evidence.returnedInBackground = true
			this.completionRuntimeRevision = (this.completionRuntimeRevision ?? 0) + 1
		}
	}

	public getBackgroundCommandContext(): string | undefined {
		return formatBackgroundCommandContext(this.commandExecutionEvidence.values())
	}

	public async updateWorkPlan(plan: TaskWorkPlan): Promise<void> {
		await this.enqueueCommandEvidence(async () => {
			this.workContext = replaceWorkPlan(this.workContext, taskWorkPlanSchema.parse(plan))
			this.completionRuntimeRevision = (this.completionRuntimeRevision ?? 0) + 1
			await this.requireAlphaMessagesSaved("task working record")
		})
	}

	public async recordLoadedSkill(name: string, skillPath: string, digest: string): Promise<void> {
		await this.enqueueCommandEvidence(async () => {
			const context = this.workContext ?? { receipts: [], skills: [] }
			this.workContext = {
				...context,
				skills: [
					...context.skills.filter((skill) => skill.path !== skillPath),
					{ name, path: skillPath, digest },
				].slice(-16),
			}
			await this.requireAlphaMessagesSaved("loaded skill identity")
		})
	}

	public async getWorkContext(): Promise<string | undefined> {
		await this.pendingCommandVerification
		return this.workContext ? formatWorkContext(this.workContext) : undefined
	}

	public hasActiveCommandExecutions(): boolean {
		return [...(this.commandExecutionEvidence?.values() ?? [])].some((evidence) => evidence.status === "running")
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

	private async stopActiveTaskCommands(
		includeUntrackedTaskProcesses = true,
		pendingOutput: readonly TaskCommandOutputFinalization[] = [],
	): Promise<void> {
		if (
			this.taskKind === "subagent" &&
			this.subagentRole !== "worker" &&
			!this.subagentContextManifest?.runtimePolicy.execute
		)
			return
		// Command launch can still be awaiting approval or terminal acquisition, so
		// cancel its evidence even when no process has become visible yet.
		this.failActiveCommandExecutions("cancelled")

		// A command can leave the model-facing foreground as soon as it produces
		// output while its terminal process continues in the background. In that
		// state ExecuteCommandTool clears terminalProcess, but TerminalRegistry
		// still owns the busy process under this task ID. Cancellation must stop
		// both forms before the task can become terminal.
		const processes = new Set<AlphaTerminalProcess>()
		const physicallyRunning = new Set<AlphaTerminalProcess>()
		if (this.terminalProcess) processes.add(this.terminalProcess)
		for (const output of pendingOutput) {
			if (output.process.executionId === output.executionId) processes.add(output.process)
		}
		for (const terminal of TerminalRegistry.getTerminals(true, this.taskId)) {
			if (
				terminal.process &&
				((includeUntrackedTaskProcesses && this.taskKind === "subagent") ||
					[...this.commandExecutionEvidence.values()].some(
						(evidence) => evidence.executionId === terminal.process?.executionId,
					))
			) {
				processes.add(terminal.process)
				if (terminal.running) physicallyRunning.add(terminal.process)
			}
		}
		if (processes.size === 0) return

		// Record the semantic reason before aborting. Some terminal adapters emit
		// their exit callback synchronously from abort(), which must not replace a
		// deliberate cancellation with a generic command failure.
		const settlements = await Promise.allSettled(
			[...processes].map(async (process) => {
				// ExecuteCommand clears its direct reference immediately after a
				// foreground completion. Cancellation can observe that narrow gap,
				// so do not wait for an event that has already been emitted.
				if (process.isSettled === true && !physicallyRunning.has(process)) return
				// A failed output reader can settle before the underlying shell exits.
				const finishEvent = process.isSettled ? "shell_execution_complete" : "completed"

				let finish!: () => void
				const settled = new Promise<void>((resolve) => {
					finish = resolve
					process.once(finishEvent, finish)
					process.once("error", finish)
				})
				let timeout: ReturnType<typeof setTimeout> | undefined
				const timedOut = new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error(`Timed out stopping a command for task ${this.taskId}`)),
						10_000,
					)
				})

				try {
					await Promise.race([Promise.all([Promise.resolve(process.abort()), settled]), timedOut])
				} finally {
					if (timeout) clearTimeout(timeout)
					process.removeListener(finishEvent, finish)
					process.removeListener("error", finish)
				}
			}),
		)
		for (const settlement of settlements) {
			if (settlement.status === "rejected") throw settlement.reason
		}
	}

	private async stopTaskCommands(cancellation: TaskCancellationBoundary): Promise<void> {
		let firstFailure: unknown
		let failureObserved = false
		const captureFailure = (error: unknown) => {
			if (!failureObserved) {
				failureObserved = true
				firstFailure = error
			}
		}
		try {
			await this.stopActiveTaskCommands(this.isCurrentApiConversationHistoryOwner(), cancellation.pendingOutput)
		} catch (error) {
			captureFailure(error)
		}

		// Physical exit does not mean the original reader and archive have finished.
		// Start every passive wait after the physical phase, including after failure.
		const settlements = await Promise.allSettled(
			cancellation.pendingOutput.map(async (output) => {
				let outputFailure: unknown
				let outputFailed = false
				const captureOutputFailure = (error: unknown) => {
					if (!outputFailed) {
						outputFailed = true
						outputFailure = error
					}
				}
				try {
					if (output.process.executionId !== output.executionId) {
						throw new Error(`Command output ownership changed for task ${this.taskId}`)
					}
					// This only releases a currently blocked write before natural finalizer
					// admission. It never interrupts a process or starts finalization.
					output.process.cancelPendingOutputWrite?.()
				} catch (error) {
					captureOutputFailure(error)
				}
				let timeout: ReturnType<typeof setTimeout> | undefined
				const timedOut = new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error(`Timed out waiting for command output for task ${this.taskId}`)),
						15_000,
					)
				})
				try {
					await Promise.race([output.completion, timedOut])
				} catch (error) {
					captureOutputFailure(error)
				} finally {
					if (timeout) clearTimeout(timeout)
				}
				if (outputFailed) throw outputFailure
			}),
		)
		for (const settlement of settlements) {
			if (settlement.status === "rejected") captureFailure(settlement.reason)
		}
		if (failureObserved) throw firstFailure
	}

	public async upsertSubagentGroup(group: SubagentGroupState, guard?: CanonicalLifecycleEventGuard): Promise<void> {
		if (guard && !guard()) return
		// Cancellation may still publish for its original owner; capture even an absent provider before waiting.
		const ownership = guard ? { guard, provider: this.providerRef.deref() } : undefined
		const snapshot = structuredClone(group)
		const committed = await this.commitAlphaMessageMutation(
			snapshot.createdAt,
			"the sub-agent group",
			(message) => ({
				...(message ?? { ts: snapshot.createdAt, type: "say" as const, say: "subagent_group" as const }),
				subagentGroup: snapshot,
			}),
			undefined,
			(message) =>
				message.type === "say" &&
				message.say === "subagent_group" &&
				message.subagentGroup?.groupId === snapshot.groupId,
			ownership,
		)
		if (guard && !guard()) return
		if (!committed) throw new Error("Unable to stage the sub-agent group.")
		this.releaseSubagentReviewBarrierIfSettled()
		if (guard && !guard()) return
		if (committed.created) await this.publishAlphaMessageCreated(committed.message, undefined, ownership)
		else await this.updateAlphaMessage(committed.message, ownership)
	}

	private async reconcileInterruptedSubagentGroups(): Promise<void> {
		const liveTaskIds = new Set(this.providerRef.deref()?.getLiveTaskIds() ?? [])
		let changed = false

		for (const message of this.alphaMessages) {
			const group = message.subagentGroup
			if (!group || !["pending", "running", "cancelling"].includes(group.status)) continue

			const unfinishedAgents = group.agents.filter((agent) =>
				["pending", "running", "cancelling"].includes(agent.status),
			)
			if (unfinishedAgents.some((agent) => liveTaskIds.has(agent.taskId))) continue

			changed = reconcileSubagentGroupAfterReload(group, Date.now()) || changed
		}

		if (changed) await this.saveAlphaMessages()
	}

	public getTaskAllowedToolNames(): readonly string[] | undefined {
		if (this.taskKind !== "subagent") return undefined
		const policy = this.subagentContextManifest?.runtimePolicy
		if (policy?.authorityModel === "parent") {
			return getInheritedSubagentToolNames(
				[...policy.allowedTools, "send_message", "list_agents"],
				policy,
				Boolean(this.subagentContextManifest?.skills.length),
			)
		}
		const role = this.subagentRole ?? "review"
		const roleCeiling = getSubagentAllowedToolNames(
			role,
			Boolean(this.subagentContextManifest?.skills.length),
			this.subagentContextManifest?.runtimePolicy.delegate === true,
		)
		const execute = this.subagentContextManifest?.runtimePolicy.execute ?? role === "worker"
		const hardCeiling = execute ? roleCeiling : roleCeiling.filter((tool) => tool !== "manage_command")
		const capturedGrant = this.subagentContextManifest?.runtimePolicy.allowedTools
		if (!capturedGrant) return hardCeiling
		// Preserve equivalent renamed capabilities in saved manifests. An artifact-read
		// grant alone must not become authority to stop or send input to commands.
		const granted = new Set(
			capturedGrant.map((tool) => (tool === "read_command_output" ? tool : canonicalizeToolName(tool))),
		)
		// Passive same-tree communication conveys data, never delegation or effect
		// authority. Old frozen manifests must remain able to reply to their parent.
		granted.add("send_message")
		granted.add("list_agents")
		return hardCeiling.filter((tool) => granted.has(tool))
	}

	public async readDiagnosticEvidence(): Promise<CollectedDiagnosticsEvidence> {
		if (!this.diagnosticSession || !this.diagnosticSourceTaskId) {
			throw new Error("This task does not have diagnostic evidence authority.")
		}
		const sourceDirectory = await resolveExistingTaskDirectoryPathReadOnly(
			this.globalStoragePath,
			this.diagnosticSourceTaskId,
		)
		return collectDiagnosticsEvidence(sourceDirectory, this.diagnosticSourceTaskId)
	}

	private shouldExposeMemoryTools(): boolean {
		const settings = this.providerRef.deref()?.getMemorySettings?.()
		return (
			this.taskKind === "primary" &&
			!this.parentTaskId &&
			!this.orchestrationParentTaskId &&
			!this.diagnosticSession &&
			this.memory.useMemories &&
			settings?.enabled === true &&
			settings.dedicatedTools
		)
	}

	private shouldExposeAgentLifecycleTools(): boolean {
		// Primary catalogs stay eager across idle, active, and reloaded sessions.
		// Managed children are narrowed separately by their frozen authority grants.
		return this.taskKind === "primary"
	}

	private getDisabledToolsForStep(state?: TaskRequestState): ToolName[] | undefined {
		return state?.subagentsEnabled === false
			? [...(state.disabledTools ?? []), "spawn_agent"]
			: state?.disabledTools
	}

	private getUserRequestTextForCatalog(): string | undefined {
		return extractUserRequestText(
			this.apiConversationHistory,
			this.orchestrationParentTaskId ? undefined : this.metadata?.task,
		)
	}

	private getCrossTaskRole(): "root" | "child" | "none" {
		if (this.taskKind !== "primary" || this.diagnosticSession) return "none"
		if (this.parentTaskId) return "none"
		if (this.rootTaskId && this.rootTaskId !== this.taskId) return "none"
		return "root"
	}

	public getInheritedSubagentSkill(name: string) {
		return this.subagentContextManifest?.skills.find((skill) => skill.name === name)
	}

	public getInheritedSubagentSkillNames(): string[] {
		return this.subagentContextManifest?.skills.map((skill) => skill.name) ?? []
	}

	/** Exact-file entries retained from managed Worker scope validation. */
	public getSubagentFileWriteScope(): string[] {
		if (this.subagentContextManifest?.runtimePolicy.authorityModel === "parent") {
			return [...(this.subagentContextManifest.runtimePolicy.fileWriteScope ?? [])]
		}
		return this.subagentAuthority?.role === "worker" ? [...(this.subagentAuthority.fileWriteScope ?? [])] : []
	}

	public isToolAllowedForTask(toolName: string): boolean {
		return this.getTaskToolDenialReason(toolName) === undefined
	}

	/**
	 * Read-only managed roles may use the audited Git and ripgrep inspection
	 * executor, but must not fall through to the serial terminal handler. Their
	 * captured execute=false ceiling cannot be raised by approval behavior.
	 */
	public getTaskCommandDenialReason(
		_command: string,
		_cwd?: string,
		executionKind: "shell" | "audited-read" = "shell",
	): string | undefined {
		if (this.taskKind !== "subagent") return undefined
		if (executionKind === "audited-read") {
			const toolDenial = this.getTaskToolDenialReason("exec_command")
			if (toolDenial) return toolDenial
			if (this.subagentContextManifest?.runtimePolicy.read === false)
				return "This sub-agent cannot inspect workspace files."
			return undefined
		}

		const role = this.subagentRole ?? this.subagentContextManifest?.runtimePolicy.role ?? "review"
		const execute = this.subagentContextManifest?.runtimePolicy.execute ?? role === "worker"
		if (execute) return undefined

		return "This read-only sub-agent may run audited Git and ripgrep inspections only through the isolated command reader."
	}

	public getTaskToolDenialReason(toolName: string, params?: Record<string, unknown>): string | undefined {
		toolName = canonicalizeToolName(toolName)
		if (toolName === "spawn_agent" && this.providerRef?.deref()?.getValue?.("subagentsEnabled") === false) {
			return "Subagents are disabled in Agents settings."
		}
		const allowed = this.getTaskAllowedToolNames()
		if (allowed && !(allowed as readonly string[]).includes(toolName)) {
			const label =
				this.subagentContextManifest?.runtimePolicy.authorityModel === "parent"
					? "sub-agent"
					: this.subagentRole === "worker"
						? "editing worker"
						: "read-only sub-agent"
			return `Tool "${toolName}" is not allowed for this parent-managed ${label}.`
		}
		if (this.taskKind === "subagent" && toolName === "write_stdin" && params) {
			const role = this.subagentRole ?? this.subagentContextManifest?.runtimePolicy.role ?? "review"
			const execute = this.subagentContextManifest?.runtimePolicy.execute ?? role === "worker"
			if (!execute && !isCommandArtifactRead(params)) {
				return "This read-only sub-agent may read command artifacts but cannot control command sessions."
			}
		}

		if (
			(this.subagentRole === "worker" ||
				this.subagentContextManifest?.runtimePolicy.authorityModel === "parent") &&
			this.isWorkerEditTool(toolName) &&
			params
		) {
			let paths: string[]
			try {
				paths = this.getWorkerEditPaths(params)
			} catch (error) {
				if (error instanceof ParseError) return `Tool "${toolName}" did not provide a valid patch.`
				throw error
			}
			if (paths.length === 0) return `Tool "${toolName}" did not provide a verifiable edit path.`
			const outside = paths.find((candidate) => !this.isWorkerWritePathAllowed(candidate))
			if (outside) return `Worker edit path is outside the approved write_scope: ${outside}`
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
			paths.push(...getPatchPaths(params.patch))
		}
		return [...new Set(paths)]
	}

	private isWorkerWritePathAllowed(candidate: string): boolean {
		return isScopedWorkerWritePathAllowed(
			{
				taskKind: this.taskKind,
				subagentRole: this.subagentRole,
				cwd: this.cwd,
				historyWorkspacePath: this.historyWorkspacePath,
				subagentPrivateWorkspaceRoot: this.subagentPrivateWorkspaceRoot,
				subagentWriteScope: this.subagentWriteScope ?? this.subagentContextManifest?.runtimePolicy.writeScope,
				subagentAuthority:
					this.subagentContextManifest?.runtimePolicy.authorityModel === "parent"
						? { role: "worker", fileWriteScope: this.subagentContextManifest.runtimePolicy.fileWriteScope }
						: this.subagentAuthority?.role === "worker"
							? { role: "worker", fileWriteScope: this.subagentAuthority.fileWriteScope }
							: undefined,
			},
			candidate,
		)
	}

	public setSubagentChangeSet(changeSet: SubagentChangeSetState): void {
		this.subagentChangeSet = structuredClone(changeSet)
	}

	private hasPendingSubagentChangeSetReview(): boolean {
		return (this.alphaMessages ?? []).some((message) =>
			message.subagentGroup?.agents.some((agent) =>
				["pending_review", "conflicted"].includes(agent.changeSet?.status ?? ""),
			),
		)
	}

	private getPendingSubagentReviewCompletionDecision(): CompletionGateDecision | undefined {
		if (!this.externalMutationLease) return undefined
		return {
			allowed: false,
			classification: "waiting",
			reasonCode: "review_pending",
			modelCanResolveRejection: false,
			message: t("common:errors.completion_review_pending"),
		}
	}

	private releaseSubagentReviewBarrierIfSettled(force = false): void {
		const barrier = this.subagentReviewBarrier
		if (!barrier || (!force && this.externalMutationLease)) return
		this.subagentReviewBarrier = undefined
		barrier.resolve()
	}

	private async waitForPendingSubagentChangeSetReviews(): Promise<void> {
		let attemptedIntegration = false
		while (
			!this.abort &&
			!this.getTaskLifetimeCancellationSignal().aborted &&
			(this.externalMutationLease ||
				(!attemptedIntegration && !this.pendingSteerMessage && this.hasPendingSubagentChangeSetReview()))
		) {
			if (!this.subagentReviewBarrier) {
				let resolve!: () => void
				const promise = new Promise<void>((resolveBarrier) => {
					resolve = resolveBarrier
				})
				this.subagentReviewBarrier = { promise, resolve }
			}

			const barrier = this.subagentReviewBarrier
			const wait = this.beginAgentWait()
			// This safe step boundary permits already-authorized integration. A
			// quarantined proposal never grants authority or waits for human review.
			this.isAwaitingSubagentReview = true
			try {
				if (!this.externalMutationLease && !attemptedIntegration) {
					attemptedIntegration = true
					try {
						await this.providerRef.deref()?.autoApplyPendingSubagentChangeSets?.(this.taskId)
					} catch (error) {
						console.error(
							`[Task#waitForPendingSubagentChangeSetReviews] Automatic Worker apply failed: ${String(error)}`,
						)
					}
				}
				this.releaseSubagentReviewBarrierIfSettled()
				// Only an admitted workspace effect owns this barrier. The canonical
				// ledger decides completion for unapplied and applied proposals.
				if (this.externalMutationLease) await this.waitForRequestControl(barrier.promise, wait.signal)
			} catch (error) {
				if (
					!this.abort &&
					!this.getTaskLifetimeCancellationSignal().aborted &&
					wait.signal.aborted &&
					this.pendingSteerMessage
				) {
					// Steering must join an already-admitted effect before sampling.
					this.releaseSubagentReviewBarrierIfSettled()
					await barrier.promise
				} else if (!this.abort && !this.getTaskLifetimeCancellationSignal().aborted) throw error
			} finally {
				wait.dispose()
				if (this.subagentReviewBarrier === barrier) this.subagentReviewBarrier = undefined
				this.isAwaitingSubagentReview = false
			}
			if (this.pendingSteerMessage) return
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
		if (this.contextCondenseAbortController) {
			return { allowed: false, state: "busy", reason: "Context compaction is in progress." }
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
					if (deferred.kind === "toolApproval") {
						this.handleWebviewToolApprovalResponse(deferred.requestId, deferred.decision)
					} else {
						this.handleWebviewAskResponse(
							deferred.askResponse,
							deferred.text,
							deferred.images,
							deferred.queuedMessageIds,
						)
					}
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
		const hasTerminalMessage = this.alphaMessages.some(
			(message) =>
				message.type === "say" &&
				message.say === terminalSay &&
				message.partial !== true &&
				Boolean(message.text?.trim()),
		)
		if (!hasTerminalMessage) {
			const message: AlphaMessage = {
				ts: this.reserveUiMessageTimestamp(),
				type: "say",
				say: terminalSay,
				text: summary,
				partial: false,
			}
			this.observeUiMessageTimestamps([message])
			this.alphaMessages.push(message)
			this.emit(AlphaCodeEventName.Message, { action: "created", message })
		}

		this.initialStatus = status
		this.subagentStopReason = stopReason ?? this.defaultSubagentStopReason(status)
		await this.requireAlphaMessagesSaved("the managed sub-agent terminal transcript")

		const provider = this.providerRef.deref()
		if (!provider) return

		const { historyItem } = await provider.getTaskWithId(this.taskId, { includeApiConversationHistory: false })
		await provider.updateTaskHistory({
			...historyItem,
			status,
			completionResultSummary: summary,
			stopReason: this.subagentStopReason,
		})
	}

	/** Record only model context; UI and terminal lifecycle remain independent. */
	public async recordSubagentInterruption(): Promise<void> {
		if (this.taskKind !== "subagent") return
		if (this.providerRef.deref()?.getValue?.("subagentInterruptMessage") === false) return
		const entry: ApiMessage = {
			role: "user",
			input_origin: "agent",
			content: [
				{
					type: "text",
					text: "<agent_interruption>The previous agent turn was interrupted. Review the current task state before continuing.</agent_interruption>",
				},
			],
		}
		if (!(await this.addToApiConversationHistory(entry))) {
			throw new Error("Failed to persist the agent interruption message")
		}
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

	/**
	 * Updates the API configuration and rebuilds the API handler.
	 * There is no tool-protocol switching or tool parser swapping.
	 *
	 * @param newApiConfiguration - The new API configuration to use
	 */
	public updateApiConfiguration(newApiConfiguration: ProviderSettings): void {
		// Build first so a rejected profile cannot leave the old handler paired with new settings.
		const prepared = this.prepareReasoningConfiguration(newApiConfiguration, this.reasoningPreference)
		this.installPreparedReasoningConfiguration(newApiConfiguration, prepared)()
	}

	private installPreparedReasoningConfiguration(
		newApiConfiguration: ProviderSettings,
		prepared: ReturnType<Task["prepareReasoningConfiguration"]>,
	): () => void {
		const previous = this.api
		const comparableConfiguration = (configuration: ProviderSettings) => {
			const { apiModelId, openAiModelId, vsCodeLmModelSelector, ...rest } = configuration
			return rest
		}
		const previousModel = previous.getModel()
		const selectedModel = prepared.api.getModel()
		const retainForCompaction =
			previousModel.id !== selectedModel.id &&
			(previousModel.info.contextWindow > selectedModel.info.contextWindow ||
				prepared.api.prepareModel !== undefined) &&
			isDeepStrictEqual(
				comparableConfiguration(this.apiConfiguration),
				comparableConfiguration(newApiConfiguration),
			)
		const retained = this.previousCompactionHandler
		this.previousCompactionHandler = retainForCompaction ? previous : undefined
		this.apiConfiguration = newApiConfiguration
		this.api = prepared.api
		this.effectiveApiConfiguration = prepared.configuration
		this.reasoningState = prepared.state
		return () => {
			if (retained) this.retireReasoningHandler(retained)
			this.retireReasoningHandler(previous)
		}
	}

	private getCompactionHandler(selected: ApiHandler, previous: ApiHandler | undefined): ApiHandler | undefined {
		return previous && previous.getModel().info.contextWindow > selected.getModel().info.contextWindow
			? previous
			: undefined
	}

	private captureCompactionHandler(selected: ApiHandler): ApiHandler | undefined {
		// VS Code resolves the selected model asynchronously. Retain the candidate now,
		// and compare real windows only after prepareCapturedReasoning has prepared it.
		const handler = selected === this.api ? this.previousCompactionHandler : undefined
		if (handler) this.reasoningHandlerUsers.set(handler, (this.reasoningHandlerUsers.get(handler) ?? 0) + 1)
		return handler
	}

	private releaseCompactionHandler(handler: ApiHandler | undefined): void {
		if (!handler) return
		if (this.previousCompactionHandler === handler) this.previousCompactionHandler = undefined
		const users = (this.reasoningHandlerUsers.get(handler) ?? 1) - 1
		if (users) this.reasoningHandlerUsers.set(handler, users)
		else this.reasoningHandlerUsers.delete(handler)
		this.retireReasoningHandler(handler)
	}

	private prepareReasoningConfiguration(configuration: ProviderSettings, preference: TaskReasoningPreference) {
		const baseHandler = buildApiHandler(configuration)
		try {
			const resolved = resolveTaskReasoning(configuration, preference, baseHandler.getModel())
			const api = resolved.configuration === configuration ? baseHandler : buildApiHandler(resolved.configuration)
			if (api !== baseHandler) this.disposeReasoningHandler(baseHandler)
			this.reasoningByHandler.set(api, resolved.state)
			return { ...resolved, api }
		} catch (error) {
			this.disposeReasoningHandler(baseHandler)
			throw error
		}
	}

	/** Scheduled runs persist this resolved admission before starting their first request. */
	public async prepareReasoningForAdmission(): Promise<void> {
		if (this.abort || this.abandoned || this.reasoningDisposed) throw new Error("Task is unavailable")
		const handler = this.api
		this.reasoningHandlerUsers.set(handler, (this.reasoningHandlerUsers.get(handler) ?? 0) + 1)
		try {
			await this.prepareCapturedReasoning(
				{
					apiHandler: handler,
					apiConfiguration: this.effectiveApiConfiguration,
					profileConfiguration: this.apiConfiguration,
				},
				{ signal: this.getTaskLifetimeCancellationSignal() },
			)
		} finally {
			const users = (this.reasoningHandlerUsers.get(handler) ?? 1) - 1
			if (users) this.reasoningHandlerUsers.set(handler, users)
			else this.reasoningHandlerUsers.delete(handler)
			this.retireReasoningHandler(handler)
		}
	}

	private async prepareCapturedReasoning(
		captured: CapturedTaskProvider,
		metadata?: ApiStreamRequestMetadata,
	): Promise<void> {
		const handler = captured.apiHandler
		await handler.prepareModel?.(metadata)
		metadata?.signal?.throwIfAborted()
		const previous = this.reasoningByHandler.get(handler)
		if (!previous || !handler.setReasoningOptions) return
		const resolved = resolveTaskReasoning(
			captured.profileConfiguration ?? captured.apiConfiguration,
			previous.requested,
			handler.getModel(),
		)
		handler.setReasoningOptions(resolved.configuration)
		captured.apiConfiguration = resolved.configuration
		this.reasoningByHandler.set(handler, resolved.state)
		if (handler === this.api) {
			this.effectiveApiConfiguration = resolved.configuration
			this.reasoningState = resolved.state
		}
	}

	private disposeReasoningHandler(handler: ApiHandler): void {
		this.retainedReasoningHandlers.delete(handler)
		const disposed = (this.disposedReasoningHandlers ??= new WeakSet<ApiHandler>())
		if (disposed.has(handler)) return
		// Disposal can re-enter or throw; late request/admission releases must not invoke it again.
		disposed.add(handler)
		handler.dispose?.()
	}

	private retireReasoningHandler(handler: ApiHandler): void {
		if (handler === this.api || this.disposedReasoningHandlers?.has(handler)) return
		if (
			handler === this.previousCompactionHandler ||
			this.reasoningHandlerUsers.has(handler) ||
			(handler === this.currentAgentStep?.snapshot.runtime.getHandler() &&
				this.currentAgentStep?.hasRetainedRequest?.() !== false)
		) {
			this.retainedReasoningHandlers.add(handler)
		} else {
			this.disposeReasoningHandler(handler)
		}
	}

	public getReasoningState(): TaskReasoningProjection {
		const handler =
			this.reasoningHandlerUsers.keys().next().value ??
			(this.isStreaming ? this.currentAgentStep?.snapshot.runtime.getHandler() : undefined)
		const current = handler ? this.reasoningByHandler.get(handler) : undefined
		return {
			...structuredClone(this.reasoningState),
			taskId: this.taskId,
			pending: hasPendingReasoningChange(current, this.reasoningState),
			...(current ? { current: structuredClone(current) } : {}),
		}
	}

	/** Called within the provider configuration queue; publish only after durable history succeeds. */
	public async updateReasoningPreference(input: TaskReasoningPreference): Promise<void> {
		if (this.abort || this.abandoned || this.reasoningDisposed) throw new Error("Task is unavailable")
		const preference = taskReasoningPreferenceSchema.parse(input)
		const prepared = this.prepareReasoningConfiguration(this.apiConfiguration, preference)
		let committed = false
		try {
			const saved = await this.enqueueAlphaMessagesSave(
				undefined,
				() => {
					if (this.abort || this.abandoned || this.reasoningDisposed) throw new Error("Task is unavailable")
					const previous = this.api
					this.reasoningPreference = preference
					this.reasoningState = prepared.state
					this.effectiveApiConfiguration = prepared.configuration
					this.api = prepared.api
					this.retireReasoningHandler(previous)
					committed = true
				},
				undefined,
				{ preference, state: prepared.state },
			)
			if (!saved) {
				throw new Error("Unable to persist task reasoning preference")
			}
		} finally {
			if (!committed) this.disposeReasoningHandler(prepared.api)
		}
	}

	/** Change an idle task's captured route without exposing a partially persisted selection. */
	public async updateModelRoute(input: {
		apiConfiguration: ProviderSettings
		apiConfigName?: string
		reasoningPreference: TaskReasoningPreference
		threadModelOverride?: string
		threadModelRoute?: SubagentModelRouteState
		signal?: AbortSignal
		/** A cold replacement may not have the previous account's in-memory settings. */
		invalidateProviderStateReplay?: boolean
	}): Promise<void> {
		const requestSignal = input.signal
		requestSignal?.throwIfAborted()
		this.assertModelRouteUpdateAvailable()
		const preference = taskReasoningPreferenceSchema.parse(input.reasoningPreference)
		const configuration = snapshotProviderSettings(input.apiConfiguration)
		const apiConfigName = input.apiConfigName?.trim() || undefined
		const route = input.threadModelRoute ? subagentModelRouteStateSchema.parse(input.threadModelRoute) : undefined
		const threadModelOverride = input.threadModelOverride
		if (
			route &&
			(route.provider !== configuration.apiProvider ||
				route.modelId !== getSubagentRouteModelId(configuration) ||
				route.profileName !== apiConfigName ||
				(threadModelOverride !== undefined && threadModelOverride !== route.modelId))
		) {
			throw new Error("The captured task model route does not match its selected provider profile and model")
		}
		const invalidateProviderStateReplay = input.invalidateProviderStateReplay === true
		const mutation = this.acquireExternalMutationLease("updating its model route", {
			allowed: true,
			state: "available",
			reason: "The task is idle.",
		})
		const lease = this.externalMutationLease
		const previousApi = this.api
		let prepared: ReturnType<Task["prepareReasoningConfiguration"]> | undefined
		let committed = false
		let retirePrevious: (() => void) | undefined
		const ownsUpdate = () => {
			if (requestSignal?.aborted) return false
			try {
				this.assertModelRouteUpdateAvailable(lease)
				return this.api === (committed ? prepared?.api : previousApi)
			} catch {
				return false
			}
		}
		try {
			prepared = this.prepareReasoningConfiguration(configuration, preference)
			const lifetimeSignal = this.getTaskLifetimeCancellationSignal()
			const signal = requestSignal ? AbortSignal.any([lifetimeSignal, requestSignal]) : lifetimeSignal
			const captured = {
				apiHandler: prepared.api,
				apiConfiguration: prepared.configuration,
				profileConfiguration: configuration,
			}
			await this.waitForRequestControl(this.prepareCapturedReasoning(captured, { signal }), signal)
			if (!ownsUpdate()) throw new Error("The task model route update is no longer available")
			prepared = {
				api: prepared.api,
				configuration: captured.apiConfiguration,
				state: this.reasoningByHandler.get(prepared.api) ?? prepared.state,
			}
			const configuredEffort =
				configuration.enableReasoningEffort !== false && configuration.reasoningEffort !== "disable"
					? configuration.reasoningEffort
					: undefined
			const requestedEffort =
				preference.kind === "effort"
					? preference.effort
					: preference.kind === "default"
						? (route?.requestedReasoningEffort ?? configuredEffort)
						: undefined
			if (requestedEffort) {
				assertTaskReasoningEffortSupported(
					requestedEffort,
					prepared.state.capabilities,
					prepared.api.getModel().id,
				)
			}
			if (!this.alphaMessagesHydrated) {
				await this.flushApiConversationHistoryPersistence(ownsUpdate)
				if (!ownsUpdate()) throw new Error("The task stopped before loading its saved history")
				await this.recoverConversationRewind()
				if (!ownsUpdate()) throw new Error("The task stopped before loading its saved history")
				const [messages, apiHistory] = await Promise.all([
					this.getSavedAlphaMessages(true),
					this.getSavedApiConversationHistory({ hydrateOnly: true }),
				])
				if (!ownsUpdate()) throw new Error("The task stopped before loading its saved history")
				this.alphaMessages = messages
				this.observeUiMessageTimestamps()
				this.apiConversationHistory = apiHistory
				this.alphaMessagesHydrated = true
			}
			const withoutReasoning = (settings: ProviderSettings) => {
				const { reasoningEffort: _effort, enableReasoningEffort: _enabled, ...rest } = settings
				return rest
			}
			const previousRoute = this.providerRef.deref()?.taskHistoryStore.get(this.taskId)?.threadModelRoute
			const changedProfile =
				previousRoute?.profileId && route?.profileId
					? previousRoute.profileId !== route.profileId
					: this.taskApiConfigName !== apiConfigName
			const routeChanged =
				invalidateProviderStateReplay ||
				changedProfile ||
				!isDeepStrictEqual(withoutReasoning(this.apiConfiguration), withoutReasoning(configuration))
			if (routeChanged) {
				const stagedHistory = invalidateOpaqueProviderStateReplay(this.apiConversationHistory)
				if (stagedHistory.some((message, index) => message !== this.apiConversationHistory[index])) {
					if (!(await this.saveApiConversationHistory(ownsUpdate, stagedHistory))) {
						throw new Error("Unable to persist provider state before changing the task model route")
					}
					// Invalidation is safe even if the following route write fails. Keep
					// canonical evidence while preventing replay through a new account.
					this.apiConversationHistory = stagedHistory
				}
			}
			const selected = prepared
			const saved = await this.enqueueAlphaMessagesSave(
				undefined,
				() => {
					if (!ownsUpdate()) throw new Error("The task model route update is no longer available")
					retirePrevious = this.installPreparedReasoningConfiguration(configuration, selected)
					this.reasoningPreference = preference
					this.setTaskApiConfigName(apiConfigName)
					this.skipPrevResponseIdOnce = true
					committed = true
				},
				undefined,
				{
					preference,
					state: selected.state,
					route: {
						apiConfigName,
						threadModelOverride,
						threadModelRoute: route,
					},
				},
				{ guard: ownsUpdate, provider: this.providerRef.deref() },
			)
			if (!saved) throw new Error("Unable to persist task model route")
			try {
				retirePrevious?.()
			} catch (error) {
				console.error("Failed to dispose the previous task model route handler:", error)
			}
		} finally {
			try {
				if (prepared && !committed) this.disposeReasoningHandler(prepared.api)
			} catch (error) {
				console.error("Failed to dispose the staged task model route handler:", error)
			} finally {
				mutation.release?.()
			}
		}
	}

	private assertModelRouteUpdateAvailable(lease?: { label: string; token: symbol }): void {
		if (
			this.abort ||
			this.abandoned ||
			this.reasoningDisposed ||
			this.taskCancellationController?.signal.aborted ||
			!this.isCurrentApiConversationHistoryOwner()
		) {
			throw new Error("The task is unavailable for a model route update")
		}
		if (
			this.isStreaming ||
			this.isWaitingForFirstChunk ||
			this.isTaskLoopActive ||
			this.isAgentTurnEngineActive ||
			this.contextCondenseAbortController ||
			this.manualContextCondenseSettlement ||
			this.postTurnCompactionAbortController ||
			this.ownedLifecyclePromise ||
			this.queuedInputWakePromise ||
			this.pendingSteerMessage ||
			this.steerMessageAwaitingPersistence ||
			this.hasPendingAsk() ||
			this.hasActiveCommandExecutions() ||
			this.messageQueueService?.hasUnconsumedInput() ||
			this.hasPendingAgentMessages() ||
			(this.externalMutationLease && this.externalMutationLease !== lease)
		) {
			throw new Error("Task work is in progress; wait until it is idle before changing its model route")
		}
	}

	/** Fresh human queue intake resumes the existing FIFO without selecting a newer entry over its head. */
	public async queueUserMessageDurably(
		text: string,
		images?: string[],
		receiptId?: string,
		admit?: () => void,
	): Promise<boolean> {
		if (!text?.trim() && !images?.length) return false
		const lifetime = this.taskCancellationController
		const ownsAdmission = () =>
			!this.abort &&
			!this.abandoned &&
			!lifetime.signal.aborted &&
			this.taskCancellationController === lifetime &&
			this.isCurrentApiConversationHistoryOwner()
		await this.messageQueueService.ready
		if (receiptId && (await this.hasAcceptedQueuedUserMessage(receiptId))) return true
		let isNewAdmission = false
		const message = await this.messageQueueService.addMessageDurably(text, images, receiptId, (isNew) => {
			admit?.()
			if (!ownsAdmission()) throw new Error("The task cannot accept queued input")
			isNewAdmission = isNew
		})
		if (!message) return false
		// The per-receipt queue lane distinguishes retries before persistence. A
		// stopped/replaced owner cannot transfer its resume intent to a successor.
		if (isNewAdmission && ownsAdmission()) {
			this.resumeRequiresExplicitInput = false
			void this.wakeQueuedInputWhenIdle().catch(() => {
				console.warn(
					`[Task#${this.taskId}] Accepted human input remains queued after follow-up admission failed`,
				)
			})
		}
		return true
	}

	public async submitUserMessage(
		text: string,
		images?: string[],
		mode?: string,
		providerProfile?: string,
		queuedMessageIds?: string[],
		receiptId?: string,
	): Promise<void> {
		text = (text ?? "").trim()
		images = images ?? []

		if (text.length === 0 && images.length === 0) {
			return
		}
		this.invalidateGoalContinuation()

		const originatingAsk = this.activeAsk
		const provider = this.providerRef.deref()
		if (!provider) throw new Error("The task provider is unavailable")
		await this.messageQueueService.ready
		if (receiptId && (await this.hasAcceptedQueuedUserMessage(receiptId))) {
			await this.wakeQueuedInputWhenIdle().catch(() => {
				console.warn(`[Task#${this.taskId}] Accepted input remains queued after retry admission failed`)
			})
			return
		}
		if (this.abort) throw new Error("The task is stopped and cannot accept input")
		if (mode) {
			await provider.setTaskMode(this.taskId, mode)
		}

		if (providerProfile) {
			await provider.setTaskProviderProfile(this.taskId, providerProfile)
		}

		// showTaskWithId acknowledges navigation before asynchronous history
		// rehydration necessarily reaches its resume ask. A host message sent in
		// that window must wait in the existing FIFO rather than occupying the
		// ask-response slot that ask() resets during initialization.
		if (this.didComplete && this.taskKind !== "primary")
			throw new Error("Use managed follow-up to resume a completed sub-agent")
		// Admission is durable before returning to UI/API callers, even while history
		// initialization or a provider response still owns the current input boundary.
		const message = queuedMessageIds?.length
			? undefined
			: await this.messageQueueService.addMessageDurably(text, images, receiptId)
		const ids = queuedMessageIds ?? (message ? [message.id] : [])
		await this.messageQueueService.flush()
		// Only a fresh durable human admission can lift a Stop restore's fence.
		// Receipt retries returned above without reauthorizing the retained queue.
		this.resumeRequiresExplicitInput = false
		this.postTurnCompactionAbortController?.abort(new SteerRequestInterruptError())
		if (this.didComplete) {
			if (this.taskKind !== "primary") throw new Error("Use managed follow-up to resume a completed sub-agent")
			if (!this.steerMessageAwaitingPersistence) {
				await this.resumeCompletedTaskFollowup(text, images, "human", ids).catch(() => {
					console.warn(`[Task#${this.taskId}] Accepted input remains queued after completed follow-up failed`)
				})
			}
			return
		}
		if (
			!originatingAsk ||
			this.activeAsk !== originatingAsk ||
			this.activeToolApprovalRequest ||
			this.askResponse !== undefined ||
			this.deferredAskResponse
		) {
			for (const id of ids.slice().reverse()) this.messageQueueService.releaseMessage(id)
			await this.messageQueueService.flush()
			await this.wakeQueuedInputWhenIdle().catch(() => {
				console.warn(`[Task#${this.taskId}] Accepted input remains queued after follow-up selection failed`)
			})
			return
		}
		for (const id of ids) this.messageQueueService.claimMessage(id)
		try {
			await this.messageQueueService.flush()
		} catch {
			// The input already has a durable admission receipt. Selection failure
			// falls back to FIFO delivery and must not strand an invisible claim.
			for (const id of ids.slice().reverse()) this.messageQueueService.releaseMessage(id)
			try {
				await this.messageQueueService.flush()
			} catch {
				// The admission snapshot still contains these entries for reload.
				console.warn(`[Task#${this.taskId}] Failed to persist queued reply selection recovery`)
			}
			console.warn(`[Task#${this.taskId}] Accepted input remains queued after reply selection failed`)
			return
		}
		if (
			this.activeAsk !== originatingAsk ||
			this.activeToolApprovalRequest ||
			this.askResponse !== undefined ||
			this.deferredAskResponse
		) {
			for (const id of ids.slice().reverse()) this.messageQueueService.releaseMessage(id)
			await this.messageQueueService.flush()
			return
		}
		this.handleWebviewAskResponse("messageResponse", text, images, ids)
	}

	/** Request IDs survive accepted-ACK retries through the queue and transcript receipts. */
	public async hasAcceptedQueuedUserMessage(id: string): Promise<boolean> {
		await this.messageQueueService.ready
		const accepted =
			this.messageQueueService.getMessage(id) !== undefined ||
			this.messageQueueService.getClaimedMessageIds().includes(id) ||
			(this.apiConversationHistory ?? []).some((message) => message.queued_message_ids?.includes(id))
		if (accepted) await this.messageQueueService.flush()
		return accepted
	}

	public matchesExpectedTurn(expectedTurnId: string): boolean {
		return (this.agentTurnId ?? this.getCanonicalLifecycleSnapshot()?.turnId) === expectedTurnId
	}

	public async steerUserMessageDurably(
		text: string,
		images: string[] = [],
		receiptId?: string,
		expectedTurnId?: string,
	): Promise<void> {
		const assertExpectedTurn = () => {
			if (expectedTurnId !== undefined && !this.matchesExpectedTurn(expectedTurnId)) {
				throw new Error("The active turn changed before steering admission")
			}
		}
		// An ACK retry observes the original admission even after its turn has ended.
		if (expectedTurnId !== undefined && !this.matchesExpectedTurn(expectedTurnId) && receiptId) {
			if (await this.hasAcceptedQueuedUserMessage(receiptId)) return
		}
		assertExpectedTurn()
		return this.enqueueDurableSteer(async () => {
			text = (text ?? "").trim()
			await this.messageQueueService.ready
			if (receiptId && (await this.hasAcceptedQueuedUserMessage(receiptId))) return
			assertExpectedTurn()
			if (
				this.abort ||
				this.abandoned ||
				this.didComplete ||
				(!this.canAcceptSteerMessage() && !this.hasPendingSteerMessage())
			)
				throw new Error("The task cannot accept a steering message")
			const message = await this.messageQueueService.addMessageDurably(
				text,
				images,
				receiptId,
				assertExpectedTurn,
			)
			if (!message) throw new Error("A steering message or image is required")
			await this.messageQueueService.flush()
			// A rapid second submission belongs to the FIFO until the first input's
			// transcript receipt commits; it cannot replace that selected input.
			if (this.hasPendingSteerMessage()) return
			try {
				await this.applyQueuedSteeringMessage(message.id, assertExpectedTurn)
			} catch (error) {
				if (!this.pendingSteerMessage?.queuedMessageIds?.includes(message.id)) {
					this.messageQueueService.releaseMessage(message.id)
					await this.messageQueueService.flush()
				}
				throw error
			}
		})
	}

	/** Manual Steer selects the oldest unclaimed message inside the durable admission queue (FIFO). */
	public async steerQueuedUserMessage(messageId: string | undefined, expectedTurnId?: string): Promise<void> {
		const turnId = expectedTurnId ?? this.agentTurnId ?? this.getCanonicalLifecycleSnapshot()?.turnId
		const assertExpectedTurn = () => {
			if (turnId !== undefined && !this.matchesExpectedTurn(turnId))
				throw new Error("The active turn changed before steering admission")
		}
		assertExpectedTurn()
		return this.enqueueDurableSteer(async () => {
			await this.messageQueueService.ready
			assertExpectedTurn()
			const selectedId = messageId ?? this.messageQueueService.messages[0]?.id
			if (selectedId) await this.applyQueuedSteeringMessage(selectedId, assertExpectedTurn)
		})
	}

	private enqueueDurableSteer(operation: () => Promise<void>): Promise<void> {
		const admission = (this.durableSteerAdmission ?? Promise.resolve()).catch(() => undefined).then(operation)
		this.durableSteerAdmission = admission
		return admission
	}

	private async applyQueuedSteeringMessage(messageId: string, assertExpectedTurn?: () => void): Promise<void> {
		await this.messageQueueService.ready
		if (!this.messageQueueService.getMessage(messageId)) {
			if (await this.hasAcceptedQueuedUserMessage(messageId)) return
			throw new Error("The queued steering message is unavailable")
		}
		assertExpectedTurn?.()
		if (!this.canAcceptSteerMessage()) throw new Error("The task cannot accept a steering message")
		const message = this.messageQueueService.claimMessage(messageId)
		if (!message) {
			if (await this.hasAcceptedQueuedUserMessage(messageId)) return
			throw new Error("The queued steering message is unavailable")
		}
		try {
			await this.messageQueueService.flush()
			// Command handoffs and approvals can change while the claim is persisted.
			assertExpectedTurn?.()
			if (!this.canAcceptSteerMessage()) throw new Error("The task cannot accept a steering message")
			await this.steerUserMessage(message.text, message.images, undefined, [message.id])
		} catch (error) {
			if (!this.pendingSteerMessage?.queuedMessageIds?.includes(message.id)) {
				this.messageQueueService.releaseMessage(message.id)
				await this.messageQueueService.flush()
			}
			throw error
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
			(!this.activeAsk || this.activeAsk.type === "command_output") &&
			!this.contextCondenseAbortController &&
			!this.pendingSteerMessage &&
			!this.steerMessageAwaitingPersistence &&
			this.askResponse === undefined &&
			this.deferredAskResponse === undefined &&
			!managedChildIsIdle
		)
	}

	/** Reserve delivery before asynchronous mailbox persistence can race completion. */
	public async admitAgentMessage<T>(persist: () => Promise<T>): Promise<T> {
		const admission = Promise.resolve().then(persist)
		this.agentMessageAdmissions.add(admission)
		try {
			return await admission
		} finally {
			this.agentMessageAdmissions.delete(admission)
		}
	}

	public hasPendingAgentMessages(): boolean {
		return (
			(this.agentMessageAdmissions?.size ?? 0) > 0 ||
			this.agentMessageInbox?.hasPending() === true ||
			this.providerRef.deref()?.hasPendingAgentMessages?.(this) === true
		)
	}

	private shouldDeferAgentResultNotifications(response: AgentResponse): boolean {
		if (response.toolCalls.length > 0) return false
		const textItems = response.items.filter(
			(item): item is Extract<AgentResponseItem, { type: "text" }> =>
				item.type === "text" && item.text.trim().length > 0,
		)
		if (textItems.some((item) => item.phase === "final_answer")) return true
		return (
			response.outcome?.requiresContinuation !== true &&
			response.text.trim().length > 0 &&
			!textItems.some((item) => item.phase === "commentary")
		)
	}

	private pendingAgentMessageDecision(): CompletionGateDecision {
		return {
			allowed: false,
			classification: "repairable",
			reasonCode: "interrupted",
			modelCanResolveRejection: true,
			message: "Agent messages are pending. Read them on the next model step before completing.",
		}
	}

	/** Independent input can require a consumer after the current lifecycle settles. */
	public markIndependentAgentMessagesPending(): void {
		this.independentAgentMessagesMayResume = true
	}

	/** Coalesce independent wake requests; passive managed-agent mail grants no new turn. */
	public resumeIndependentAgentMessages(): Promise<boolean> {
		if (this.independentAgentWakePromise) return this.independentAgentWakePromise
		if (
			this.taskKind !== "primary" ||
			!this.independentAgentMessagesMayResume ||
			!this.agentMessageInbox.hasPending() ||
			!this.didComplete ||
			this.abort ||
			this.abandoned ||
			this.steerMessageAwaitingPersistence
		)
			return Promise.resolve(false)
		const wake = this.resumeCompletedTaskFollowup("Continue with the pending agent messages.", [], "agent").then(
			() => true,
		)
		this.independentAgentWakePromise = wake
		const settled = () => {
			if (this.independentAgentWakePromise === wake) this.independentAgentWakePromise = undefined
		}
		void wake.then(settled, settled)
		return wake
	}

	public async receiveAgentMessage(message: AgentMessage): Promise<void> {
		if (this.abort && !this.didComplete) throw new Error("The task is stopped and cannot accept an agent message")
		await this.agentMessageInbox.receive(message)
		await this.presentIncomingAgentMessage(message)
	}

	/** Record host-controlled stopping without admitting model input or waking this conversation. */
	public async recordAgentStopRequest(senderTaskId: string, reason?: string): Promise<void> {
		if (!this.alphaMessagesHydrated) throw new Error(t("common:tasks.peer_stop_loading"))
		const ownership = {
			guard: () => this.isCurrentApiConversationHistoryOwner() && !this.abort,
			provider: this.providerRef.deref(),
		}
		await this.presentIncomingAgentMessage(
			{
				id: this.agentStopMessageId ?? uuidv7(),
				senderTaskId,
				text: reason?.trim().slice(0, 500) || t("common:tasks.peer_stop_request"),
			},
			"requested",
			ownership,
		)
		if (!ownership.guard()) throw new Error(t("common:tasks.peer_stop_unavailable"))
	}

	private async presentIncomingAgentMessage(
		message: AgentMessage,
		stopStatus?: "requested",
		ownership?: { guard: CanonicalLifecycleEventGuard; provider: AlphaProvider | undefined },
	): Promise<void> {
		// Cold recipients hydrate their existing transcript before delivery. Structured
		// managed-agent notifications keep their existing lifecycle presentation.
		if (!this.alphaMessagesHydrated || message.notification) return
		const matches = (entry: AlphaMessage) => entry.agentMessage?.id === message.id
		if (this.alphaMessages.some(matches)) return
		const timestamp = this.reserveUiMessageTimestamp()
		const committed = await this.commitAlphaMessageMutation(
			timestamp,
			"the incoming chat message",
			(existing) =>
				existing ?? {
					ts: timestamp,
					type: "say",
					say: "agent_message",
					text: redactTaskPrivatePaths(this, message.text),
					agentMessage: {
						id: message.id,
						senderTaskId: message.senderTaskId,
						...(stopStatus && { stopStatus }),
					},
					isProtected: true,
				},
			undefined,
			matches,
			ownership,
		)
		if (committed && stopStatus) this.agentStopMessageId = message.id
		if (committed?.created) await this.publishAlphaMessageCreated(committed.message, undefined, ownership)
	}

	private async finalizeAgentStopMessage(ownership: {
		guard: CanonicalLifecycleEventGuard
		provider: AlphaProvider | undefined
	}): Promise<void> {
		const id = this.agentStopMessageId
		if (!id) return
		const receipt = this.alphaMessages.find((message) => message.agentMessage?.id === id)
		if (receipt?.agentMessage?.stopStatus !== "requested") return
		const committed = await this.commitAlphaMessageMutation(
			receipt.ts,
			"the incoming chat stop receipt",
			(message) =>
				message?.agentMessage && {
					...message,
					agentMessage: { ...message.agentMessage, stopStatus: "stopped" },
				},
			undefined,
			(message) => message.agentMessage?.id === id,
			ownership,
		)
		if (committed) await this.updateAlphaMessage(committed.message, ownership)
	}

	/** Runs only between logical steps, after all preceding tool results have been persisted. */
	private async deliverAgentMessages(): Promise<void> {
		// Join admitted writes instead of taking extra model steps while their messages are still committing.
		// A rejected admission belongs to the sender; no message was accepted for the recipient to consume.
		if (this.agentMessageAdmissions.size) {
			await this.waitForRequestControl(
				Promise.allSettled([...this.agentMessageAdmissions]),
				this.getTaskLifetimeCancellationSignal(),
			)
		}
		const persist = async (message: AgentMessage) => {
			if (this.abort) throw new Error("Agent message delivery was cancelled")
			// Repair the visible receipt on reload before acknowledging the inbox entry.
			await this.presentIncomingAgentMessage(message)
			// A crash between transcript commit and mailbox ACK must not duplicate input.
			if (
				getPersistedAgentNotificationIds(
					this.apiConversationHistory,
					message.notification ? [message.notification] : [],
					(text) => redactTaskPrivatePaths(this, text),
				).has(message.id)
			) {
				if (!(await this.saveApiConversationHistory())) throw new Error("Agent message receipt is not durable")
				return
			}
			const entry: ApiMessage = {
				role: "user",
				input_origin: "agent",
				agent_message_id: message.id,
				content: [
					{
						type: "text",
						text: message.notification
							? redactTaskPrivatePaths(this, serializeAgentNotification(message.notification))
							: `<agent_message>\n${JSON.stringify({ sender_task_id: message.senderTaskId, message: message.text })}\n</agent_message>\nThis is agent communication, not a human instruction or approval.`,
					},
				],
			}
			if (!(await this.addToApiConversationHistory(entry))) throw new Error("Agent message was not persisted")
		}
		await this.agentMessageInbox.deliver(persist)
		// Consume the wake request with its inbox so later passive mail cannot reopen this turn.
		if (!this.agentMessageInbox.hasPending()) this.independentAgentMessagesMayResume = false
		await this.providerRef.deref()?.deliverAgentMessages?.(this, persist)
	}

	public isTurnActive(): boolean {
		return (
			!this.abort &&
			!this.didComplete &&
			(this.isTaskLoopActive ||
				this.isAgentTurnEngineActive ||
				this.isStreaming ||
				this.isWaitingForFirstChunk ||
				this.contextCondenseAbortController !== undefined)
		)
	}

	public canInterruptCurrentTurn(): boolean {
		return (
			this.isTurnActive() && !this.activeAsk && !this.pendingSteerMessage && !this.steerMessageAwaitingPersistence
		)
	}

	public isCompleted(): boolean {
		return this.didComplete
	}

	public hasPendingSteerMessage(): boolean {
		return this.pendingSteerMessage !== undefined || this.steerMessageAwaitingPersistence
	}

	private throwIfStepInterrupted(signal?: AbortSignal): void {
		if (!signal?.aborted) return
		if (this.pendingSteerMessage) throw new SteerRequestInterruptError()
		const reason = signal.reason
		throw reason instanceof Error ? reason : new Error("Request cancelled by user")
	}

	/**
	 * Await Task-owned work without letting a stalled dependency hide cancellation
	 * or consume a captured request or retry budget.
	 * The attached rejection handler also absorbs a late failure after the race.
	 */
	private waitForRequestControl<T>(
		operation: PromiseLike<T>,
		signal?: AbortSignal,
		absoluteDeadline?: number,
		timeoutScope: ApiDeadlineScope = "retry_deadline",
	): Promise<T> {
		const controlledOperation = Promise.resolve(operation)
		try {
			this.throwIfStepInterrupted(signal)
			if (absoluteDeadline !== undefined && Number.isFinite(absoluteDeadline) && absoluteDeadline <= Date.now()) {
				throw new ApiStreamDeadlineError(undefined, timeoutScope)
			}
		} catch (error) {
			// The operation may already have been created by the caller. Observe its
			// eventual rejection even when control was lost before this race began.
			void controlledOperation.catch(() => undefined)
			return Promise.reject(error)
		}
		if (!signal && absoluteDeadline === undefined) return controlledOperation

		return new Promise<T>((resolve, reject) => {
			let settled = false
			let deadlineTimer: ReturnType<typeof setTimeout> | undefined

			const cleanup = () => {
				if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
				signal?.removeEventListener("abort", onAbort)
			}
			const finish = (callback: () => void) => {
				if (settled) return
				settled = true
				cleanup()
				callback()
			}
			const onAbort = () => {
				let error: Error
				try {
					this.throwIfStepInterrupted(signal)
					error = new Error("Request cancelled by user")
				} catch (reason) {
					error = reason instanceof Error ? reason : new Error(String(reason))
				}
				finish(() => reject(error))
			}

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true })
				if (signal.aborted) onAbort()
			}
			if (!settled && typeof absoluteDeadline === "number" && Number.isFinite(absoluteDeadline)) {
				deadlineTimer = setTimeout(
					() => finish(() => reject(new ApiStreamDeadlineError(undefined, timeoutScope))),
					Math.max(0, absoluteDeadline - Date.now()),
				)
			}

			controlledOperation.then(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			)
		})
	}

	public canAcceptSubagentFollowup(): boolean {
		return this.taskKind === "subagent" && this.didComplete && !this.isTaskLoopActive && !this.isStreaming
	}

	/** Persist agent guidance before interrupting an active independent task. */
	public async steerAgentMessage(message: AgentMessage): Promise<"steered" | "buffered"> {
		if (this.abort || this.abandoned || this.didComplete) {
			throw new Error("The task cannot accept a steering message")
		}
		await this.admitAgentMessage(() => this.receiveAgentMessage(message))

		// Admission may race a human response, approval, stop, or completion. Keep
		// accepted guidance in the existing inbox for the next authorized boundary.
		if (
			this.abort ||
			this.abandoned ||
			this.didComplete ||
			this.isPaused ||
			this.activeAsk ||
			this.activeToolApprovalRequest ||
			this.contextCondenseAbortController ||
			this.pendingSteerMessage ||
			this.steerMessageAwaitingPersistence ||
			this.askResponse !== undefined ||
			this.deferredAskResponse !== undefined ||
			!this.isTurnActive()
		) {
			return "buffered"
		}

		this.invalidateGoalContinuation()
		this.cancelAutoApprovalTimeout()
		// The interruption marker carries no parent guidance. The actual input and
		// receipt are delivered once from the durable inbox between logical steps.
		this.pendingSteerMessage = {
			text: "Continue with the pending agent messages.",
			images: [],
			inputOrigin: "agent",
			isAgentMessageWake: true,
		}
		this.steerMessageAwaitingPersistence = true
		if (this.taskKind === "primary") this.interruptHookPending = true
		const interrupt = new SteerRequestInterruptError()
		this.agentWaitAbortController?.abort(interrupt)
		this.postTurnCompactionAbortController?.abort(interrupt)
		this.stepInterruptionController?.abort(interrupt)
		this.currentRequestAbortController?.abort(interrupt)
		return "steered"
	}

	private async presentSteeringInput(steering: NonNullable<Task["pendingSteerMessage"]>): Promise<void> {
		// The actual attributed message already has its own bubble. The wake is internal.
		if (!steering.isAgentMessageWake)
			await this.say("user_feedback", steering.text, steering.images, undefined, undefined, undefined, {
				queuedMessageIds: steering.queuedMessageIds,
			})
	}

	public async steerUserMessage(
		text: string,
		images?: string[],
		onPersisted?: () => Promise<void> | void,
		queuedMessageIds?: string[],
	): Promise<void> {
		text = (text ?? "").trim()
		images = images ?? []

		if (text.length === 0 && images.length === 0) {
			return
		}
		this.invalidateGoalContinuation()
		if (this.abort || this.didComplete) {
			throw new Error("The task cannot accept a steering message")
		}
		if (this.contextCondenseAbortController) {
			throw new Error("Context compaction is in progress")
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
		this.resetCompletionRecoveryState()
		const retainForDurableRecovery = () => {
			this.pendingSteerMessage = {
				text,
				images,
				inputOrigin: onPersisted ? "agent" : "human",
				...(queuedMessageIds?.length ? { queuedMessageIds } : {}),
				...(onPersisted ? { onPersisted } : {}),
			}
			this.steerMessageAwaitingPersistence = true
			this.emit(AlphaCodeEventName.TaskUserMessage, this.taskId)
		}

		if (this.activeAsk) {
			if (onPersisted) {
				retainForDurableRecovery()
				throw new Error("Managed sub-agent began waiting for input before steering could be durably persisted")
			}
			this.handleWebviewAskResponse("messageResponse", text, images, queuedMessageIds)
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
			if (this.taskKind === "primary") this.interruptHookPending = true
			const interrupt = new SteerRequestInterruptError()
			this.agentWaitAbortController?.abort(interrupt)
			this.postTurnCompactionAbortController?.abort(interrupt)
			this.stepInterruptionController?.abort(interrupt)
			this.currentRequestAbortController?.abort(interrupt)
			return
		}

		if (this.taskKind === "subagent" && onPersisted) {
			// The child became idle after the provider's canAcceptSteerMessage check.
			// Retain the receipt in memory and leave the durable mailbox event
			// unacknowledged so follow-up rehydration can recover it exactly once.
			retainForDurableRecovery()
			throw new Error("Managed sub-agent became inactive before steering could be durably persisted")
		}

		await this.submitUserMessage(text, images, undefined, undefined, queuedMessageIds)
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			await Promise.resolve(this.terminalProcess?.abort())
		}
	}

	private async getFilesReadByAlphaSafely(context: string): Promise<string[] | undefined> {
		try {
			return await this.fileContextTracker.getFilesReadByAlpha()
		} catch (error) {
			console.error(`[Task#${context}] Failed to get files read by Alpha:`, error)
			return undefined
		}
	}

	private logCompactionDiagnostic(diagnostic: Record<string, unknown> | undefined): void {
		if (!diagnostic) return
		try {
			this.providerRef.deref()?.log?.(`[compaction] ${JSON.stringify({ taskId: this.taskId, ...diagnostic })}`)
		} catch {
			// Diagnostic delivery must never prevent history validation or persistence.
		}
	}

	private async measureCompactedContext(
		apiHandler: ApiHandler,
		systemPrompt: string,
		metadata: ApiHandlerCreateMessageMetadata,
		targetContextTokens: number | undefined,
		messages: readonly CountableHistoryMessage[] = getEffectiveApiHistory(this.apiConversationHistory),
		countContext?: TokenCountContext,
	): Promise<number> {
		this.throwIfStepInterrupted(metadata.signal)
		const tokens = await countContextTokens(messages, apiHandler, systemPrompt, metadata, countContext)
		this.throwIfStepInterrupted(metadata.signal)
		if (
			!Number.isFinite(tokens) ||
			tokens < 0 ||
			(targetContextTokens !== undefined && tokens > targetContextTokens)
		) {
			this.logCompactionDiagnostic({
				stage: "validation",
				tokens,
				targetContextTokens,
				messages: messages.length,
			})
			throw new ContextRecoveryExhaustedError()
		}
		return tokens
	}

	public condenseContext(): Promise<void> {
		if (this.manualContextCondenseSettlement) {
			return Promise.reject(new Error("Context compaction is already in progress"))
		}
		const operation = this.performManualContextCondense().finally(() => {
			if (this.manualContextCondenseSettlement === settlement) this.manualContextCondenseSettlement = undefined
		})
		// Both callers and termination observe cleanup before the operation settles.
		const settlement = operation.then(
			() => undefined,
			() => undefined,
		)
		this.manualContextCondenseSettlement = settlement
		return operation
	}

	private async performManualContextCondense(): Promise<void> {
		const performanceStartedAt = performance.now()
		let performanceStatus: Extract<AgentTurnEvent, { type: "task_performance" }>["status"] = "failed"
		if (this.contextCondenseAbortController) {
			throw new Error("Context compaction is already in progress")
		}
		if (this.abort || this.abandoned) {
			throw new Error("The task cannot condense context after it has stopped")
		}
		if (
			this.isTaskLoopActive ||
			this.isAgentTurnEngineActive ||
			this.isStreaming ||
			this.isWaitingForFirstChunk ||
			this.externalMutationLease
		) {
			// A flushed partial result batch does not close the active scheduler transaction.
			throw new Error("Task work is in progress; wait for it to finish before condensing context")
		}
		const controller = new AbortController()
		const taskSignal = this.getTaskLifetimeCancellationSignal()
		const abortFromTask = () => controller.abort(taskSignal.reason)
		this.contextCondenseAbortController = controller
		if (taskSignal.aborted) abortFromTask()
		else taskSignal.addEventListener("abort", abortFromTask, { once: true })
		const deadline = getBoundedRequestDeadline(getApiRequestTimeout(), undefined)
		const contextControl = createLinkedAbortController({
			signal: controller.signal,
			deadline,
			deadlineScope: "compaction_deadline",
		})

		const capturedProvider: CapturedTaskProvider = {
			apiHandler: this.api,
			compactionApiHandler: this.captureCompactionHandler(this.api),
			apiConfiguration: this.effectiveApiConfiguration,
			profileConfiguration: this.apiConfiguration,
		}
		this.reasoningHandlerUsers.set(
			capturedProvider.apiHandler,
			(this.reasoningHandlerUsers.get(capturedProvider.apiHandler) ?? 0) + 1,
		)
		try {
			await this.waitForRequestControl(
				this.prepareCapturedReasoning(capturedProvider, {
					signal: contextControl.signal,
					deadline,
					deadlineScope: "compaction_deadline",
				}),
				contextControl.signal,
				deadline,
				"compaction_deadline",
			)
			await this.condenseContextWithSignal(contextControl.signal, capturedProvider, undefined, deadline)
			performanceStatus = "completed"
		} catch (error) {
			if (error instanceof LifecycleHookStoppedError) {
				performanceStatus = "cancelled"
				return
			}
			performanceStatus = error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed"
			throw error
		} finally {
			contextControl.dispose()
			this.releaseCompactionHandler(capturedProvider.compactionApiHandler)
			this.reasoningHandlerUsers.delete(capturedProvider.apiHandler)
			this.retireReasoningHandler(capturedProvider.apiHandler)
			taskSignal.removeEventListener("abort", abortFromTask)
			if (this.contextCondenseAbortController === controller) this.contextCondenseAbortController = undefined
			this.recordTaskPerformance("condensation", performanceStartedAt, performanceStatus)
		}
		this.processQueuedMessages()
	}

	private async maybeCompactAfterTurn(): Promise<void> {
		if (this.abort || this.pendingSteerMessage !== undefined || this.messageQueueService.hasUnconsumedInput())
			return
		const lifetimeSignal = this.getTaskLifetimeCancellationSignal()
		const interruption = new AbortController()
		this.postTurnCompactionAbortController = interruption
		const deadline = getBoundedRequestDeadline(getApiRequestTimeout(), undefined)
		const contextControl = createLinkedAbortController({
			signal: AbortSignal.any([lifetimeSignal, interruption.signal]),
			deadline,
			deadlineScope: "compaction_deadline",
		})
		const signal = contextControl.signal
		let capturedProvider: CapturedTaskProvider | undefined
		try {
			const pendingState = this.providerRef.deref()?.getState()
			const state = pendingState
				? await this.waitForRequestControl(pendingState, signal, deadline, "compaction_deadline")
				: undefined
			if (signal.aborted) signal.throwIfAborted()
			if (this.pendingSteerMessage !== undefined || this.messageQueueService.hasUnconsumedInput()) return
			const percent = state?.postTurnCondenseContextPercent ?? DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT
			if (state?.autoCondenseContext === false || !Number.isInteger(percent) || percent < 1 || percent > 100)
				return
			capturedProvider = {
				apiHandler: this.api,
				compactionApiHandler: this.captureCompactionHandler(this.api),
				apiConfiguration: this.effectiveApiConfiguration,
				profileConfiguration: this.apiConfiguration,
			}
			this.reasoningHandlerUsers.set(
				capturedProvider.apiHandler,
				(this.reasoningHandlerUsers.get(capturedProvider.apiHandler) ?? 0) + 1,
			)
			await this.waitForRequestControl(
				this.prepareCapturedReasoning(capturedProvider, {
					signal,
					deadline,
					deadlineScope: "compaction_deadline",
				}),
				signal,
				deadline,
				"compaction_deadline",
			)
			if (this.pendingSteerMessage !== undefined || this.messageQueueService.hasUnconsumedInput()) return
			const scope = state?.autoCondenseContextScope ?? "full-context"
			await this.condenseContextWithSignal(
				signal,
				capturedProvider,
				{
					percent,
					scope,
					prefillTokens: scope === "after-prefix" ? this.getCompactionWindowPrefillTokens() : undefined,
				},
				deadline,
			)
		} catch (error) {
			if (
				interruption.signal.reason instanceof SteerRequestInterruptError &&
				!lifetimeSignal.aborted &&
				!this.abort
			)
				return
			if (lifetimeSignal.aborted || interruption.signal.aborted || this.abort) throw error
			if (error instanceof LifecycleHookStoppedError || error instanceof LifecycleHookOwnershipError) throw error
			console.warn(`[Task#${this.taskId}] Post-turn compaction failed; the completed turn was preserved.`)
		} finally {
			contextControl.dispose()
			if (this.postTurnCompactionAbortController === interruption)
				this.postTurnCompactionAbortController = undefined
			if (capturedProvider) {
				this.releaseCompactionHandler(capturedProvider.compactionApiHandler)
				const users = (this.reasoningHandlerUsers.get(capturedProvider.apiHandler) ?? 1) - 1
				if (users) this.reasoningHandlerUsers.set(capturedProvider.apiHandler, users)
				else this.reasoningHandlerUsers.delete(capturedProvider.apiHandler)
				this.retireReasoningHandler(capturedProvider.apiHandler)
			}
		}
	}

	private getCompactionWindowPrefillTokens(): number | undefined {
		for (let index = this.alphaMessages.length - 1; index >= 0; index--) {
			const message = this.alphaMessages[index]
			const tokens =
				message.say === "condense_context"
					? message.contextCondense?.newContextTokens
					: message.say === "sliding_window_truncation"
						? message.contextTruncation?.newContextTokens
						: undefined
			if (tokens !== undefined && Number.isFinite(tokens) && tokens >= 0) return tokens
		}
		for (const message of this.alphaMessages) {
			if (message.say !== "api_req_started") continue
			try {
				const tokens = (JSON.parse(message.text ?? "{}") as Partial<AlphaApiReqInfo>).tokensIn
				if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) return tokens
			} catch {
				// A malformed saved request cannot establish a compaction baseline.
			}
		}
		return undefined
	}

	private async condenseContextWithSignal(
		signal: AbortSignal,
		capturedProvider: CapturedTaskProvider,
		postTurn?: { percent: number; scope: AutoCondenseContextScope; prefillTokens?: number },
		deadline?: number,
	): Promise<void> {
		const accounting = this.createContextCondenseAccounting()
		let compactionError: unknown
		try {
			await this.condenseContextWithAccounting(signal, capturedProvider, accounting, postTurn, deadline)
		} catch (error) {
			compactionError = error
			throw error
		} finally {
			await accounting.persistUnreportedCost(compactionError !== undefined)
		}
	}

	private async condenseContextWithAccounting(
		signal: AbortSignal,
		capturedProvider: CapturedTaskProvider,
		accounting: ContextCondenseAccounting,
		postTurn?: { percent: number; scope: AutoCondenseContextScope; prefillTokens?: number },
		deadline?: number,
	): Promise<void> {
		const assertWithinBudget = () => {
			this.throwIfStepInterrupted(signal)
			throwIfAbsoluteDeadlineExceeded(deadline, "compaction_deadline")
		}
		const waitForContextPreparation = <T>(operation: PromiseLike<T>): Promise<T> =>
			this.waitForRequestControl(operation, signal, deadline, "compaction_deadline")
		assertWithinBudget()
		// CRITICAL: Flush any pending tool results before condensing
		// to ensure tool_use/tool_result pairs are complete in history
		if (!(await this.flushPendingToolResultsToHistory())) {
			throw new Error("Unable to persist pending tool results before condensing context.")
		}
		assertWithinBudget()
		const history = this.apiConversationHistory
		const historyDigest = digestProviderTranscript(history)
		const { apiHandler, apiConfiguration } = capturedProvider

		// Get condensing configuration
		const pendingState = this.providerRef.deref()?.getState()
		const state = pendingState ? await waitForContextPreparation(pendingState) : undefined
		assertWithinBudget()
		const capturedExecution = this.captureToolExecutionPolicy(state)
		const mode = await waitForContextPreparation(this.getTaskMode())
		let instructionFragments: readonly ApiInstructionFragment[] | undefined
		const systemPrompt = await waitForContextPreparation(
			this.getSystemPrompt(state, { apiHandler, apiConfiguration }, undefined, mode, (fragments) => {
				instructionFragments = fragments
			}),
		)
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE

		// Build tools for condensing metadata (same tools used for normal API calls)
		const provider = this.providerRef.deref()
		let allTools: import("openai").default.Chat.ChatCompletionTool[] = []
		let allowedFunctionNames: string[] | undefined
		if (provider) {
			const model = apiHandler.getModel()
			const modelInfo = model.info
			const toolsResult = await waitForContextPreparation(
				buildNativeToolsArrayWithRestrictions({
					provider,
					cwd: this.cwd,
					mode,
					customModes: state?.customModes,
					experiments: state?.experiments,
					apiConfiguration,
					disabledTools: this.getDisabledToolsForStep(state),
					waitForQuestionAnswers:
						getFollowupAutoApprovalTimeoutMs(
							this.approvalStateForAsk(state, this.captureTaskApprovalMode(state)),
						) === 0,
					execution: capturedExecution,
					modelInfo,
					modelIdentity: createModelToolIdentity(apiConfiguration, model),
					includeAllToolsWithRestrictions: supportsFunctionCallingRestrictions(apiConfiguration.apiProvider),
					catalogCache: this.toolCatalogCache,
					discoveryHistory: history,
					signal,
					allowedToolNames: this.getTaskAllowedToolNames(),
					taskKind: this.taskKind,
					diagnosticSession: this.diagnosticSession,
					memoryToolsEnabled: this.shouldExposeMemoryTools(),
					diagnosticSourceTaskId: this.diagnosticSourceTaskId,
					enableAgentLifecycleTools: this.shouldExposeAgentLifecycleTools(),
					crossTaskRole: this.getCrossTaskRole(),
					userRequestText: this.getUserRequestTextForCatalog(),
				}),
			)
			allTools = toolsResult.tools
			allowedFunctionNames = toolsResult.allowedFunctionNames
		}

		// Build metadata with tools and taskId for the condensing API call
		const metadata: ApiHandlerCreateMessageMetadata = {
			mode,
			taskId: this.taskId,
			signal,
			...(instructionFragments ? { instructionFragments } : {}),
			...(deadline !== undefined ? { deadline, deadlineScope: "compaction_deadline" as const } : {}),
			...(allTools.length > 0
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
						...(allowedFunctionNames ? { allowedFunctionNames } : {}),
					}
				: {}),
		}
		const countContext = createTokenCountContext(apiHandler, {
			signal,
			remoteDeadline: metadata.deadline,
		})
		const { id: modelId, info: modelInfo } = apiHandler.getModel()
		const reservedTokens = getModelReservedOutputTokens({ modelId, model: modelInfo, settings: apiConfiguration })
		const threshold = resolveCondenseThreshold(state?.autoCondenseContextPercent ?? 100)
		const { allowedTokens, triggerTokens } = getContextLimits(modelInfo.contextWindow, reservedTokens, threshold)
		const prevContextTokens = await waitForContextPreparation(
			countContextTokens(getEffectiveApiHistory(history), apiHandler, systemPrompt, metadata, countContext),
		)
		if (
			postTurn &&
			!isPostTurnCondenseDue(
				prevContextTokens,
				allowedTokens,
				triggerTokens,
				postTurn.percent,
				postTurn.scope,
				postTurn.prefillTokens,
			)
		)
			return
		const targetTriggerTokens = postTurn
			? Math.min(triggerTokens, Math.floor((allowedTokens * postTurn.percent) / 100))
			: triggerTokens
		const fixedTokens = await waitForContextPreparation(
			countContextTokens([], apiHandler, systemPrompt, metadata, countContext),
		)
		const maxContextTokens = getCompactionTargetTokens({
			contextWindow: modelInfo.contextWindow,
			reservedTokens,
			triggerTokens: targetTriggerTokens,
			fixedTokens,
		})
		const filesReadByAlpha = await waitForContextPreparation(this.getFilesReadByAlphaSafely("condenseContext"))
		assertWithinBudget()

		const { messages, summary, cost, error, condenseId, targetContextTokens, diagnostic, status } =
			await waitForContextPreparation(
				summarizeConversation({
					beforeCompact: () =>
						this.runCompactionLifecycleHook("PreCompact", postTurn ? "auto" : "manual", signal),
					messages: history,
					apiHandler,
					compactionApiHandler: this.getCompactionHandler(apiHandler, capturedProvider.compactionApiHandler),
					systemPrompt,
					taskId: this.taskId,
					isAutomaticTrigger: postTurn !== undefined,
					customCondensingPrompt,
					metadata,
					filesReadByAlpha,
					cwd: this.cwd,
					alphaIgnoreController: this.alphaIgnoreController,
					countContext,
					maxContextTokens,
					observeCost: accounting.observeCost,
				}).then((result) => {
					accounting.observeCost(result.cost)
					return result
				}),
			)
		this.logCompactionDiagnostic(diagnostic && { stage: "summary", automatic: false, ...diagnostic })
		assertWithinBudget()
		// Rewind/edit can replace the transcript while the summarizer is awaiting its provider.
		if (digestProviderTranscript(this.apiConversationHistory) !== historyDigest) {
			throw new Error("Conversation history changed during context compaction; retry with the current history")
		}
		if (error) {
			await this.sayCondenseError(error, cost, true)
			return
		}
		if (status === "unchanged") {
			await this.say(
				"condense_context",
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				{ isNonInteractive: true },
				{
					outcome: "unchanged",
					cost,
					summary: "",
					prevContextTokens,
					newContextTokens: prevContextTokens,
				},
			)
			return
		}
		let newContextTokens = await waitForContextPreparation(
			this.measureCompactedContext(
				apiHandler,
				systemPrompt,
				metadata,
				targetContextTokens,
				// Stored messages include the rewind archive; only the active projection
				// is sent to the provider and belongs in the input-budget check.
				getEffectiveApiHistory(messages),
				countContext,
			),
		)
		if (newContextTokens >= prevContextTokens) throw new ContextRecoveryExhaustedError()
		assertWithinBudget()
		if (digestProviderTranscript(this.apiConversationHistory) !== historyDigest) {
			throw new Error("Conversation history changed during context compaction; retry with the current history")
		}
		if (!(await this.overwriteApiConversationHistory(messages))) {
			throw new Error("Unable to persist condensed conversation history before continuing.")
		}
		assertWithinBudget()
		this.environmentContext.reset()
		await this.refreshEnvironmentContext(state, signal)
		newContextTokens = await waitForContextPreparation(
			this.measureCompactedContext(
				apiHandler,
				systemPrompt,
				metadata,
				// The summary meets its target before fresh context is added. Resume
				// within the configured working window, leaving room before the trigger.
				Math.max(0, targetTriggerTokens - 1),
				getEffectiveApiHistory(this.apiConversationHistory),
				countContext,
			),
		)
		if (newContextTokens >= prevContextTokens) throw new ContextRecoveryExhaustedError()

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
		await this.runCompactionLifecycleHook("PostCompact", postTurn ? "auto" : "manual", signal)
	}

	private createContextCondenseAccounting(): ContextCondenseAccounting {
		const isReceipt = (message: AlphaMessage) =>
			message.type === "say" &&
			message.partial !== true &&
			(message.say === "condense_context" ||
				message.say === "condense_context_error" ||
				message.say === "sliding_window_truncation")
		// Compaction has one task owner. Older same-cost attempts must not discharge this attempt.
		let previousReceipts: ReadonlySet<AlphaMessage> | undefined
		let observedCost: number | undefined
		return {
			observeCost: (cost) => {
				if (!Number.isFinite(cost) || cost < 0) return
				if (cost > 0) previousReceipts ??= new Set(this.alphaMessages.filter(isReceipt))
				observedCost = cost > 0 ? cost : undefined
			},
			persistUnreportedCost: async (preserveError) => {
				if (observedCost === undefined) return
				const hasReceipt = this.alphaMessages.some(
					(message) =>
						isReceipt(message) &&
						!previousReceipts?.has(message) &&
						(message.contextCondense?.cost === observedCost ||
							message.contextCondenseErrorCost === observedCost),
				)
				try {
					if (!hasReceipt) {
						// Usage is task data even after Stop, deadline expiry, or a stale-history rejection.
						// Persist through the existing save queue without reviving the disposed UI.
						this.alphaMessages.push({
							ts: this.reserveUiMessageTimestamp(),
							type: "say",
							say: "condense_context_error",
							text: t("common:errors.condense_failed"),
							contextCondenseErrorCost: observedCost,
						})
					}
					// A visible receipt may still be awaiting a UI bridge or a failed earlier save.
					if (!(await this.saveAlphaMessages())) {
						throw new Error("Unable to persist observed context compaction cost.")
					}
				} catch (error) {
					if (!preserveError) throw error
					// Cleanup preserves cancellation while exposing the failed durability guarantee.
					console.warn("Unable to persist observed context compaction cost during failure cleanup.")
				}
			},
		}
	}

	private getCondenseErrorCost(cost: number): number | undefined {
		return Number.isFinite(cost) && cost > 0 ? cost : undefined
	}

	private sayCondenseError(error: string, cost: number, isNonInteractive = false): Promise<undefined> {
		return this.say("condense_context_error", error, undefined, false, undefined, undefined, {
			isNonInteractive,
			contextCondenseErrorCost: this.getCondenseErrorCost(cost),
		})
	}

	async say(
		type: AlphaSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
			asyncUserInput?: AsyncUserInputData
			userInputResponse?: UserInputResponseData
			commandExecutionId?: string
			stateUpdate?: "full" | "task"
			previewEpoch?: number
			/** Automatic retry guidance shares the feedback presentation, not the user-request boundary. */
			feedbackSource?: "user" | "automatic"
			/** Correlates canonical user input with its durable admission and optimistic UI row. */
			queuedMessageIds?: readonly string[]
			/** Known failed-summary charge; never a successful compaction receipt. */
			contextCondenseErrorCost?: number
			turn?: AlphaMessageTurn | null
			onCreated?: (message: AlphaMessage) => void
		} = {},
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined> {
		let capturedTurn =
			options.turn === undefined
				? (this.toolInputContext?.getStore()?.turn ?? this.captureMessageTurn())
				: options.turn
		if (type === "user_feedback" && !partial && options.feedbackSource !== "automatic" && capturedTurn) {
			capturedTurn = { ...capturedTurn, inputKind: this.openingTurnInputPending ? "start" : "steer" }
			this.openingTurnInputPending = false
		}
		const addMessage = (message: AlphaMessage, stateUpdate?: "full" | "task") =>
			this.addToAlphaMessages(message, stateUpdate, undefined, capturedTurn, options.onCreated)
		if (
			options.contextCondenseErrorCost !== undefined &&
			(!Number.isFinite(options.contextCondenseErrorCost) ||
				options.contextCondenseErrorCost < 0 ||
				partial === true ||
				(type !== "condense_context_error" && type !== "sliding_window_truncation"))
		) {
			throw new Error("Failed summary cost requires a completed error or truncation message.")
		}
		if (options.previewEpoch !== undefined && !this.isStreamingPreviewEpochCurrent(options.previewEpoch)) {
			return undefined
		}
		if ((type === "async_user_input") !== (options.asyncUserInput !== undefined)) {
			throw new Error("Async user input messages require their typed question payload.")
		}
		if (options.userInputResponse !== undefined && type !== "user_feedback") {
			throw new Error("User input responses can only be attached to user feedback.")
		}
		if (this.abort) {
			throw new Error(`[Task#say] task ${this.taskId}.${this.instanceId} aborted`)
		}
		if (text !== undefined) text = redactTaskPrivatePaths(this, text)
		const userInputResponse =
			options.userInputResponse === undefined
				? undefined
				: {
						questions: options.userInputResponse.questions.map(({ header, question, answers }) => ({
							...(header === undefined ? {} : { header: redactTaskPrivatePaths(this, header) }),
							question: redactTaskPrivatePaths(this, question),
							answers: answers.map((answer) => redactTaskPrivatePaths(this, answer)),
						})),
					}
		const queuedMessageIds =
			options.feedbackSource !== "automatic" && options.queuedMessageIds?.length
				? [...options.queuedMessageIds]
				: undefined
		const feedbackReceiptIds =
			type === "user_feedback" && !partial && queuedMessageIds ? new Set(queuedMessageIds) : undefined
		const isFeedbackConsumed = () =>
			Boolean(
				feedbackReceiptIds &&
					this.apiConversationHistory.some((message) =>
						message.queued_message_ids?.some((id) => feedbackReceiptIds.has(id)),
					),
			)
		// A replay of durable input must not renew request progress or invalidate evidence.
		if (isFeedbackConsumed()) return undefined
		if (
			type === "user_feedback" &&
			!partial &&
			options.feedbackSource !== "automatic" &&
			(text?.trim() || images?.length)
		) {
			// Ask replies, queued follow-ups, and steering converge here when consumed.
			// Renew the attempt at this boundary; arrival alone can precede a still-running step.
			this.toolRepetitionDetector?.resetProgress()
			this.searchLoopRecoveryPolicy?.reset()
			this.resetCompletionRecoveryState()
			if (this.workContext) {
				// External state is reusable only within the current user request.
				await this.enqueueCommandEvidence(async () => {
					this.completionRuntimeRevision = (this.completionRuntimeRevision ?? 0) + 1
					if (this.workContext) this.workContext = restoreWorkContext(this.workContext)
				})
			}
		}

		const lastFeedback = this.alphaMessages.at(-1)
		if (
			feedbackReceiptIds &&
			!(lastFeedback?.type === "say" && lastFeedback.say === type && lastFeedback.partial)
		) {
			const isSameFeedback = (message: AlphaMessage | undefined): message is AlphaMessage =>
				Boolean(message) &&
				message?.type === "say" &&
				message.say === "user_feedback" &&
				!message.partial &&
				message.queuedMessageIds?.length === feedbackReceiptIds.size &&
				message.queuedMessageIds.every((id) => feedbackReceiptIds.has(id))
			const previousIndex = findLastIndex(this.alphaMessages, isSameFeedback)
			if (previousIndex >= 0) {
				// Feedback can be visible before provider admission fails. Reuse only
				// that exact receipt; consumed input is immutable even on a stale retry.
				const committed = await this.commitAlphaMessageMutation(
					this.alphaMessages[previousIndex].ts,
					"the retried user feedback",
					(message) =>
						!this.abort && !this.abandoned && !isFeedbackConsumed() && isSameFeedback(message)
							? { ...message, text, images, queuedMessageIds, userInputResponse }
							: undefined,
					undefined,
					isSameFeedback,
				)
				if (this.abort || this.abandoned) {
					throw new Error(`[Task#say] task ${this.taskId}.${this.instanceId} aborted`)
				}
				if (committed) {
					options.onCreated?.(committed.message)
					if (!options.isNonInteractive) this.lastMessageTs = committed.message.ts
					await this.updateAlphaMessage(committed.message)
					return undefined
				}
				if (isFeedbackConsumed()) return undefined
			}
		}

		if (partial !== undefined) {
			const commandOutputExecutionId =
				type === "command_output" ? options.commandExecutionId || undefined : undefined
			// Output from another command may arrive while this command's row is still partial.
			const previousMessageIndex = commandOutputExecutionId
				? findLastIndex(
						this.alphaMessages,
						(message) =>
							message.type === "say" &&
							message.say === type &&
							message.commandExecutionId === commandOutputExecutionId,
					)
				: findLastIndex(this.alphaMessages, (message) => message.say !== "agent_message")
			const lastMessage = this.alphaMessages[previousMessageIndex]
			// Boolean publications are cumulative snapshots of one command invocation.
			if (commandOutputExecutionId && lastMessage && !lastMessage.partial) return

			const isUpdatingPreviousPartial =
				lastMessage &&
				lastMessage.partial &&
				lastMessage.type === "say" &&
				lastMessage.say === type &&
				(type !== "command_output" ||
					(lastMessage.commandExecutionId || undefined) === commandOutputExecutionId)

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
					lastMessage.asyncUserInput = options.asyncUserInput
					lastMessage.userInputResponse = userInputResponse
					if (queuedMessageIds) lastMessage.queuedMessageIds = queuedMessageIds
					if (options.commandExecutionId) lastMessage.commandExecutionId = options.commandExecutionId
					await this.updateAlphaMessage(lastMessage).catch((error) => {
						console.error(`[Task#${this.taskId}] Failed to update partial message:`, error)
					})
				} else {
					// This is a new partial message, so add it with partial state.
					const sayTs = this.reserveUiMessageTimestamp()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
						if (type === "text") this.currentAssistantResponseMessageTs = sayTs
					}

					await addMessage(
						{
							ts: sayTs,
							type: "say",
							say: type,
							text,
							images,
							partial,
							contextCondense,
							contextTruncation,
							contextCondenseErrorCost: options.contextCondenseErrorCost,
							asyncUserInput: options.asyncUserInput,
							userInputResponse,
							...(queuedMessageIds ? { queuedMessageIds } : {}),
							...(options.commandExecutionId ? { commandExecutionId: options.commandExecutionId } : {}),
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
						this.lastMessageTs = commandOutputExecutionId
							? Math.max(this.lastMessageTs ?? 0, lastMessage.ts)
							: lastMessage.ts
						if (type === "text") this.currentAssistantResponseMessageTs = lastMessage.ts
					}

					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.contextCondenseErrorCost = options.contextCondenseErrorCost
					lastMessage.progressStatus = progressStatus
					lastMessage.asyncUserInput = options.asyncUserInput
					lastMessage.userInputResponse = userInputResponse
					if (queuedMessageIds) lastMessage.queuedMessageIds = queuedMessageIds
					if (options.commandExecutionId) lastMessage.commandExecutionId = options.commandExecutionId

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveAlphaMessages()

					// More performant than an entire `postStateToWebview`.
					await this.updateAlphaMessage(lastMessage).catch((error) => {
						console.error(`[Task#${this.taskId}] Failed to update completed message:`, error)
					})
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = this.reserveUiMessageTimestamp()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
						if (type === "text") this.currentAssistantResponseMessageTs = sayTs
					}

					await addMessage(
						{
							ts: sayTs,
							type: "say",
							say: type,
							text,
							images,
							contextCondense,
							contextTruncation,
							contextCondenseErrorCost: options.contextCondenseErrorCost,
							asyncUserInput: options.asyncUserInput,
							userInputResponse,
							...(queuedMessageIds ? { queuedMessageIds } : {}),
							...(options.commandExecutionId ? { commandExecutionId: options.commandExecutionId } : {}),
						},
						options.stateUpdate,
					)
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const sayTs = this.reserveUiMessageTimestamp()

			// A "non-interactive" message is a message is one that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!options.isNonInteractive) {
				this.lastMessageTs = sayTs
				if (type === "text") this.currentAssistantResponseMessageTs = sayTs
			}

			await addMessage(
				{
					ts: sayTs,
					type: "say",
					say: type,
					text,
					images,
					checkpoint,
					contextCondense,
					contextTruncation,
					contextCondenseErrorCost: options.contextCondenseErrorCost,
					asyncUserInput: options.asyncUserInput,
					userInputResponse,
					...(queuedMessageIds ? { queuedMessageIds } : {}),
					...(options.commandExecutionId ? { commandExecutionId: options.commandExecutionId } : {}),
				},
				options.stateUpdate,
			)
		}
	}

	/** Present an already-approved command without taking ownership of any pending ask. */
	public async presentApprovedCommand(command: string, progressStatus?: ToolProgressStatus): Promise<string> {
		if (this.abort) {
			throw new Error(`[Task#presentApprovedCommand] task ${this.taskId}.${this.instanceId} aborted`)
		}
		const timestamp = this.reserveUiMessageTimestamp()
		await this.addToAlphaMessages(
			{
				ts: timestamp,
				type: "ask",
				ask: "command",
				text: redactTaskPrivatePaths(this, command),
				progressStatus,
				isAnswered: true,
			},
			undefined,
			"the approved command presentation",
		)
		if (this.abort) {
			throw new Error(`[Task#presentApprovedCommand] task ${this.taskId}.${this.instanceId} aborted`)
		}
		return timestamp.toString()
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
		const planOpenIndex = text.indexOf(PROPOSED_PLAN_OPEN_TAG)
		const hasUnclosedPlan =
			planOpenIndex >= 0 &&
			text.indexOf(PROPOSED_PLAN_CLOSE_TAG, planOpenIndex + PROPOSED_PLAN_OPEN_TAG.length) < 0
		const normalizedText =
			this.taskKind === "primary" && mode === planModeSlug && !partial && !hasUnclosedPlan
				? ensureProposedPlanBlock(text)
				: text
		const completionText = redactTaskPrivatePaths(this, normalizedText)
		// Stream an in-progress completion as ordinary assistant text. Terminal
		// styling is reserved for the durable final boundary below.
		if (partial) {
			await this.say("text", completionText, images, true)
			return
		}
		const canStoreDesign = this.taskKind === "primary" && mode === planModeSlug && !hasUnclosedPlan
		const designHandoff = canStoreDesign ? createDesignHandoff(completionText, this.taskId) : undefined
		const oversizedDesign =
			canStoreDesign && (parseProposedPlan(completionText)?.content.length ?? 0) > MAX_DESIGN_HANDOFF_CHARS

		const currentMessage = this.currentAssistantResponseMessageTs
			? this.findMessageByTimestamp(this.currentAssistantResponseMessageTs)
			: undefined
		const canPromoteCurrent =
			currentMessage?.type === "say" &&
			(currentMessage.say === "text" || currentMessage.say === "completion_result")
		const completionTs = canPromoteCurrent ? currentMessage.ts : this.reserveUiMessageTimestamp()
		const committed = await this.commitAlphaMessageMutation(
			completionTs,
			"the completion result",
			(message) => ({
				...(message?.type === "say" ? message : { ts: completionTs, type: "say" as const }),
				say: "completion_result",
				text: completionText,
				images,
				partial: false,
			}),
			designHandoff,
		)
		if (!committed) throw new Error("Unable to stage the completion result.")

		this.lastMessageTs = committed.message.ts
		this.currentAssistantResponseMessageTs = committed.message.ts
		if (committed.created) await this.publishAlphaMessageCreated(committed.message)
		else await this.updateAlphaMessage(committed.message)
		if (oversizedDesign) await this.say("error", t("common:planHandoff.tooLarge"))
	}

	/** Remove terminal styling when a final verification gate rejects a candidate. */
	public async retractCompletionResult(): Promise<void> {
		const currentMessage = this.currentAssistantResponseMessageTs
			? this.findMessageByTimestamp(this.currentAssistantResponseMessageTs)
			: undefined
		if (
			currentMessage?.type !== "say" ||
			(currentMessage.say !== "completion_result" && !currentMessage.turn?.terminalStatus)
		)
			return

		try {
			const committed = await this.commitAlphaMessageMutation(
				currentMessage.ts,
				"the rejected completion state",
				(message) => {
					if (message?.type !== "say") return undefined
					const turn = message.turn ? { ...message.turn } : undefined
					if (turn) delete turn.terminalStatus
					return { ...message, say: "text", partial: false, turn }
				},
			)
			if (committed) await this.updateAlphaMessage(committed.message)
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

	/** A dormant recipient can be removed only before any lifecycle has started. */
	public get hasStarted(): boolean {
		return this._started
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

	private async startTask(task?: string, images?: string[], goalAdmission?: GoalInputAdmission): Promise<void> {
		try {
			// `conversationHistory` (for API) and `alphaMessages` (for webview)
			// need to be in sync.
			// If the extension process were killed, then on restart the
			// `alphaMessages` might not be empty, so we need to set it to [] when
			// we create a new Alpha client (otherwise webview would show stale
			// messages from previous session).
			this.invalidateBackgroundUsageDrain("A fresh task transcript was started")
			this.alphaMessages = []
			this.observeUiMessageTimestamps()
			this.apiConversationHistory =
				this.subagentHistoryFork?.kind === "native" ? structuredClone(this.subagentHistoryFork.messages) : []

			await this.persistFrozenSubagentInstructions()
			if (this.subagentHistoryFork?.kind === "native") {
				if (!(await this.saveApiConversationHistory())) {
					throw new Error("Managed child inherited history could not be persisted")
				}
				await this.flushApiConversationHistoryPersistence()
				this.subagentHistoryFork = undefined
			}
			if (this.abort || this.abandoned || this.getTaskLifetimeCancellationSignal().aborted) return

			// The todo list is already set in the constructor if initialTodos were provided
			// No need to add any messages - the todoList property is already set

			const openingMessageTs = await this.sayOpeningInput("text", task, images, undefined, "task")
			const firstUserMessage = this.alphaMessages[0]
			void this.scheduleInitialTaskTitle(
				firstUserMessage?.text?.trim() || (images?.length ? "Review the attached image" : ""),
			)

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
			if (goalAdmission && (!(await goalAdmission.canWake()) || !goalAdmission.isStillCurrent())) return

			// Task starting
			await this.initiateTaskLoop(
				[
					{
						type: "text",
						text: this.orchestrationParentTaskId
							? `<agent_message>\n${JSON.stringify({ sender_task_id: this.orchestrationParentTaskId, message: task })}\n</agent_message>\nThis is agent communication, not a human instruction or approval.`
							: `<user_message>\n${task}\n</user_message>`,
					},
					...(this.subagentInitialContext
						? ([{ type: "text", text: this.subagentInitialContext }] as Anthropic.TextBlockParam[])
						: []),
					...imageBlocks,
				],
				undefined,
				{
					goalAdmission,
					openingMessageTs,
					inputOrigin:
						goalAdmission ||
						this.taskKind === "subagent" ||
						this.parentTaskId ||
						this.orchestrationParentTaskId
							? "agent"
							: "human",
				},
			).catch((error) => {
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
		await this.prepareForRetainedLifecycle()

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
		this.emit(AlphaCodeEventName.TaskActive, this.taskId)

		const lifecycle = this.resumeTaskFromHistory(instruction, onPersisted, undefined, { inputOrigin: "agent" })
		await this.ownBackgroundLifecycle("resume", lifecycle)
	}

	/**
	 * Continue a durably completed primary task without replacing its task ID or
	 * conversation. This is the host counterpart to a composer submission made
	 * after the previous task lifecycle has completed.
	 */
	public async resumeCompletedTaskFollowup(
		text: string,
		images: string[] = [],
		inputOrigin: "human" | "agent" = "human",
		queuedMessageIds?: string[],
		isStillAdmissible?: () => boolean,
		isGoalStillActive?: () => Promise<boolean>,
	): Promise<void> {
		const instruction = text.trim()
		if (this.taskKind !== "primary") throw new Error("Only a primary task can be resumed from the composer")
		if (!instruction && images.length === 0) throw new Error("A follow-up instruction or image is required")
		if (!this.didComplete) {
			if (this.isTaskLoopActive || this.isStreaming || this.isAgentTurnEngineActive) {
				throw new Error("The task is still running")
			}
			throw new Error("The task has not completed")
		}
		if (this.steerMessageAwaitingPersistence) {
			throw new Error("A completed-task follow-up is already being admitted")
		}
		if (this.performanceObservabilityEnabled) {
			this.performanceSubmissionStartedAt = performance.now()
			this.performanceRequestPending = true
			this.performanceRequestPhase = "completed_task_followup"
		}

		// Claim the one pending admission synchronously and publish a receipt before
		// joining the previous turn's durability fence. The task remains Completed
		// until the new user content itself is durable, but callers no longer see a
		// silent interval while terminal journal work drains.
		this.steerMessageAwaitingPersistence = true
		let followupPersisted = false
		let completionStateReset = false
		try {
			// The admission receipt already protects this input. Select it before
			// joining the old lifecycle so the host projects delivery immediately.
			for (const id of queuedMessageIds ?? []) this.messageQueueService.claimMessage(id)
			if (inputOrigin === "human") this.emit(AlphaCodeEventName.TaskUserMessage, this.taskId)

			// TaskCompleted is emitted before the old loop's terminal journal flush has
			// necessarily returned. Join that owned lifecycle so the new turn cannot
			// overlap the preceding terminal write. A stuck owner must release this
			// admission without giving a new turn access to its durability fence.
			const admissionSignal = this.getTaskLifetimeCancellationSignal()
			try {
				await this.waitForRequestControl(this.waitForOwnedLifecycle(), admissionSignal, Date.now() + 30_000)
			} catch (error) {
				if (error instanceof ApiStreamDeadlineError) {
					throw new Error(t("common:errors.completed_followup_finalize_timeout"))
				}
				if (admissionSignal.aborted) throw new Error(t("common:errors.completed_followup_cancelled"))
				throw error
			}
			if ((isGoalStillActive && !(await isGoalStillActive())) || (isStillAdmissible && !isStillAdmissible())) {
				return
			}
			if (this.abort || this.abandoned) throw new Error("Completed-task follow-up was cancelled")
			if (!this.didComplete) throw new Error("The task has not completed")
			if (this.isTaskLoopActive || this.isStreaming || this.isAgentTurnEngineActive) {
				throw new Error("The completed task is still finalizing")
			}
			await this.prepareForRetainedLifecycle(queuedMessageIds)
			await this.messageQueueService.flush()
			if ((isGoalStillActive && !(await isGoalStillActive())) || (isStillAdmissible && !isStillAdmissible())) {
				return
			}
			if (this.abort || this.abandoned) throw new Error("Completed-task follow-up was cancelled")

			completionStateReset = true
			this._started = true
			this.didComplete = false
			this.didEmitTaskCompleted = false
			this.abort = false
			this.abandoned = false
			this.abortReason = undefined
			this.didFinishAbortingStream = false
			this.isWaitingForFirstChunk = false
			this.pendingSteerMessage = undefined

			let resolvePersisted!: () => void
			let rejectPersisted!: (error: unknown) => void
			const persisted = new Promise<void>((resolve, reject) => {
				resolvePersisted = resolve
				rejectPersisted = reject
			})
			const lifecycle = this.resumeTaskFromHistory(
				instruction,
				() => {
					// Do not expose a Running lifecycle until the continuation is
					// durable. If preparation fails before this callback, the UI remains
					// truthfully Completed and can restore the submitted draft.
					followupPersisted = true
					this.steerMessageAwaitingPersistence = false
					// Stop can win after the user receipt commits but before queue ACK joins.
					if (!this.abort && !this.abandoned) this.emit(AlphaCodeEventName.TaskActive, this.taskId)
					resolvePersisted()
				},
				images,
				{
					deferTaskStartedUntilInitialUserContentPersisted: true,
					reuseRetainedHistory: true,
					inputOrigin,
					queuedMessageIds,
					goalAdmission: this.goalHostAdmission,
				},
			)
			this.ownBackgroundLifecycle("resume", lifecycle)
			void lifecycle.then(
				() => {
					if (!followupPersisted) {
						rejectPersisted(new Error("The completed-task follow-up was not persisted"))
					}
				},
				(error) => rejectPersisted(error),
			)
			await persisted
		} catch (error) {
			if (!followupPersisted && completionStateReset) {
				// No provider request was admitted, so restore the terminal flags
				// without publishing a duplicate TaskCompleted event.
				this.markCompleted()
				this.didEmitTaskCompleted = true
			}
			throw error
		} finally {
			if (!followupPersisted) {
				this.performanceRequestPending = false
				this.performanceSubmissionStartedAt = undefined
				try {
					// Guard rejection also leaves input unconsumed. Keep admission owned
					// while release publishes, so its queue callback cannot restart it.
					for (const id of (queuedMessageIds ?? []).slice().reverse())
						this.messageQueueService.releaseMessage(id)
					await this.messageQueueService.flush()
				} finally {
					this.steerMessageAwaitingPersistence = false
				}
			}
		}
	}

	/** Start a rehydrated task with a replacement prompt after the host has rewound its history. */
	public async resumeWithEditedMessage(text: string, images: string[] = []): Promise<void> {
		await this.resumeRehydratedFollowup(text, images, "human")
	}

	/** Wake a saved independent conversation using its durable agent inbox, without answering a human ask. */
	public async resumeWithAgentMessages(): Promise<void> {
		if (this.taskKind !== "primary" || this.parentTaskId || this.diagnosticSession) {
			throw new Error("Only independent primary tasks can accept thread messages")
		}
		if (
			this.activeAsk &&
			this.activeAsk.type !== "resume_task" &&
			this.activeAsk.type !== "resume_completed_task"
		) {
			throw new Error("A thread message cannot answer a human approval or question")
		}
		if (!this.hasPendingAgentMessages()) throw new Error("No agent messages are pending")
		await this.resumeRehydratedFollowup("Continue with the pending agent messages.", [], "agent")
	}

	private async resumeRehydratedFollowup(
		text: string,
		images: string[],
		inputOrigin: "human" | "agent",
	): Promise<void> {
		if (this._started || this.abort) throw new Error("The task has already started or was cancelled")
		if (!text.trim() && images.length === 0) throw new Error("A prompt or image is required")
		this._started = true
		this.skipPrevResponseIdOnce = true
		let persisted = false
		let resolvePersisted!: () => void
		let rejectPersisted!: (error: unknown) => void
		const admission = new Promise<void>((resolve, reject) => {
			resolvePersisted = resolve
			rejectPersisted = reject
		})
		const lifecycle = this.resumeTaskFromHistory(
			text,
			() => {
				persisted = true
				if (!this.abort && !this.abandoned) this.emit(AlphaCodeEventName.TaskActive, this.taskId)
				resolvePersisted()
			},
			images,
			{ deferTaskStartedUntilInitialUserContentPersisted: true, inputOrigin },
		)
		this.ownBackgroundLifecycle("resume", lifecycle)
		void lifecycle.then(() => {
			if (!persisted) rejectPersisted(new Error("The edited prompt was not persisted"))
		}, rejectPersisted)
		try {
			await admission
		} catch (error) {
			if (!persisted && !this.abort && !this.abandoned) this._started = false
			throw error
		}
	}

	private async resumeTaskFromHistory(
		followupText?: string,
		onSubagentSteeringPersisted?: () => Promise<void> | void,
		followupImages?: string[],
		options: {
			deferTaskStartedUntilInitialUserContentPersisted?: boolean
			requireExplicitResume?: boolean
			reuseRetainedHistory?: boolean
			queuedMessageIds?: string[]
			inputOrigin?: "human" | "agent"
			goalAdmission?: GoalInputAdmission
		} = {},
	) {
		if (options.requireExplicitResume) this.resumeRequiresExplicitInput = true
		try {
			const hasDirectFollowup = followupText !== undefined || Boolean(followupImages?.length)
			const useRetainedHistory = options.reuseRetainedHistory === true && hasDirectFollowup

			// A resumed task may have a final legacy/sidecar write queued by the
			// preceding turn. Join it before reading and rewriting the transcript so
			// resume cannot base its next request on an older snapshot.
			await this.flushApiConversationHistoryPersistence()
			if (this.abort || this.abandoned) return
			await this.recoverConversationRewind()
			if (this.abort || this.abandoned) return
			// A retained completed Task already owns the authoritative in-memory
			// transcripts. Its prior lifecycle was joined before entering this method,
			// so re-reading and rewriting both full histories only adds startup latency.
			const modifiedAlphaMessages = useRetainedHistory
				? structuredClone(this.alphaMessages)
				: await this.getSavedAlphaMessages(true)
			if (this.abort || this.abandoned) return
			const savedApiHistoryPromise = useRetainedHistory
				? Promise.resolve(this.apiConversationHistory)
				: this.getSavedApiConversationHistory({ hydrateOnly: true })
			// Own read failures while the preview is pending or throws. Awaiting the
			// original promise below still reports the failure before resuming effects.
			void savedApiHistoryPromise.catch(() => undefined)

			// Remove any resume messages that may have been added before.
			const lastRelevantMessageIndex = findLastIndex(
				modifiedAlphaMessages,
				(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
			)

			if (lastRelevantMessageIndex !== -1) {
				modifiedAlphaMessages.splice(lastRelevantMessageIndex + 1)
			}

			// Only incomplete reasoning belongs to the interrupted preview. Completed
			// reasoning is durable UI history even when it has no separate API record.
			while (modifiedAlphaMessages.length > 0) {
				const last = modifiedAlphaMessages[modifiedAlphaMessages.length - 1]
				if (last.type === "say" && last.say === "reasoning" && last.partial === true) {
					modifiedAlphaMessages.pop()
				} else {
					break
				}
			}

			// Since we don't use `api_req_finished` anymore, we need to check if the
			// last `api_req_started` has a cost value, if it doesn't and no
			// cancellation reason to present, then we remove it since it indicates
			// an api request without any partial content streamed.
			const lastApiReqStartedIndex = findLastIndex(
				modifiedAlphaMessages,
				(m) => m.type === "say" && m.say === "api_req_started",
			)

			if (lastApiReqStartedIndex !== -1) {
				const lastApiReqStarted = modifiedAlphaMessages[lastApiReqStartedIndex]
				const { cost, cancelReason }: AlphaApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")

				if (cost === undefined && cancelReason === undefined) {
					modifiedAlphaMessages.splice(lastApiReqStartedIndex, 1)
				}
			}

			// Paint the cleaned UI transcript before provider history finishes.
			// Continue still waits for both reads; this does not persist or ask.
			this.invalidateBackgroundUsageDrain("The task transcript was resumed")
			this.alphaMessages = modifiedAlphaMessages
			this.observeUiMessageTimestamps()
			this.alphaMessagesHydrated = true
			restoreTodoListForTask(this)
			if (!useRetainedHistory) {
				await this.publishResumedUiPreview()
			}
			const savedApiHistory = await savedApiHistoryPromise
			if (this.abort || this.abandoned) return
			this.apiConversationHistory = savedApiHistory
			await this.reconcileGoalUsageFromHistory()
			await this.recoverIncompleteCanonicalToolCallsForResume()
			const lifecycleSnapshot = this.getCanonicalLifecycleSnapshot()
			const recoveredToolResult = (toolCallId: string): Anthropic.ToolResultBlockParam => {
				const item = lifecycleSnapshot?.items.find(
					(candidate) => candidate.type === "tool_result" && candidate.toolCallId === toolCallId,
				)
				if (!item || item.type !== "tool_result") {
					return {
						type: "tool_result",
						tool_use_id: toolCallId,
						content: "Task was interrupted before this tool call could be completed.",
						is_error: true,
					}
				}
				const output = item.output ?? item.result
				const content =
					typeof output === "string"
						? output
						: Array.isArray(output)
							? output
									.filter(
										(block): block is { type: "text"; text: string } =>
											!!block &&
											typeof block === "object" &&
											block.type === "text" &&
											typeof block.text === "string",
									)
									.map((block) => block.text)
									.join("\n") || "Tool result was recovered from the lifecycle journal."
							: output === undefined
								? "Tool result was recovered from the lifecycle journal."
								: (JSON.stringify(output) ?? String(output))
				return {
					type: "tool_result",
					tool_use_id: toolCallId,
					content: (content || "Tool result was recovered from the lifecycle journal.").slice(0, 16_000),
					is_error: item.status !== "success" && item.status !== "completed",
				}
			}
			if (!useRetainedHistory) {
				await this.reconcileInterruptedSubagentGroups()
				if (this.abort || this.abandoned) return
			}

			if (this.taskKind === "subagent" && !hasDirectFollowup) {
				this.isInitialized = true
				await this.finalizeTaskCompletion()
				await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
				return
			}

			const lastAlphaMessage = this.alphaMessages
				.slice()
				.reverse()
				.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // Could be multiple resume tasks.

			this.isInitialized = true

			let responseText: string | undefined
			let responseImages: string[] | undefined
			let responseQueuedMessageIds: string[] | undefined
			let responseGoalAdmission: GoalInputAdmission | undefined
			let openingMessageTs: number | undefined
			if (hasDirectFollowup) {
				responseText = followupText
				responseImages = followupImages
				responseQueuedMessageIds = options.queuedMessageIds
				if (!(options.inputOrigin === "agent" && this.hasPendingAgentMessages())) {
					const messageType =
						options.inputOrigin === "agent" || this.alphaMessages.length === 0 ? "text" : "user_feedback"
					openingMessageTs = await this.sayOpeningInput(
						messageType,
						followupText,
						followupImages,
						options.queuedMessageIds,
					)
				}
			} else {
				let completedHistory = lastAlphaMessage?.ask === "completion_result"
				if (completedHistory || lastAlphaMessage?.say === "completion_result") {
					// A final-looking row can precede a failed finalizer. Task history,
					// rather than the completed model turn, owns accepted terminality.
					const savedTask = await this.providerRef.deref()?.getTaskWithId(this.taskId, {
						includeApiConversationHistory: false,
					})
					const status = savedTask?.historyItem.status
					completedHistory = status === "completed" || (status === undefined && completedHistory)
					if (this.abort || this.abandoned) return
				}
				const askType: AlphaAsk = completedHistory ? "resume_completed_task" : "resume_task"
				const { response, text, images, queuedMessageIds } = await this.ask(askType) // Calls `postStateToWebview`.
				this.resumeRequiresExplicitInput = false
				responseGoalAdmission = this.consumeGoalAskAdmission(text)

				if (response === "messageResponse") {
					openingMessageTs = await this.sayOpeningInput("user_feedback", text, images, queuedMessageIds)
					responseText = text
					responseImages = images
					responseQueuedMessageIds = queuedMessageIds
				}
			}

			// Keep committed messages in their original envelopes. Replaying an old
			// user tail as new input would lose receipts/provenance and could let an
			// earlier instruction override the fresh follow-up.
			const existingApiConversationHistory: ApiMessage[] = this.apiConversationHistory
			let modifiedApiConversationHistory = existingApiConversationHistory
			const newUserContent: Anthropic.Messages.ContentBlockParam[] = []
			if (existingApiConversationHistory.length > 0) {
				const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

				if (lastMessage.isSummary || lastMessage.isTruncationMarker || lastMessage.agent_message_id) {
					// Compaction boundaries and delivery receipts retain their identity.
				} else if (lastMessage.role === "assistant") {
					const content = Array.isArray(lastMessage.content)
						? lastMessage.content
						: [{ type: "text", text: lastMessage.content }]
					newUserContent.push(
						...content
							.filter((block) => getToolCallId(block) !== undefined)
							.map((block) => recoveredToolResult(getToolCallId(block)!)),
					)
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

						const toolUseBlocks = assistantContent.filter((block) => getToolCallId(block) !== undefined)

						if (toolUseBlocks.length > 0) {
							const existingToolResults = existingUserContent.filter(
								(block) => block.type === "tool_result",
							) as Anthropic.ToolResultBlockParam[]

							const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
								.filter(
									(toolUse) =>
										!existingToolResults.some(
											(result) => getToolResultId(result) === getToolCallId(toolUse),
										),
								)
								.map((toolUse) => recoveredToolResult(getToolCallId(toolUse)!))

							if (missingToolResponses.length > 0) {
								modifiedApiConversationHistory = [...existingApiConversationHistory]
								modifiedApiConversationHistory[modifiedApiConversationHistory.length - 1] = {
									...lastMessage,
									content: [...existingUserContent, ...missingToolResponses],
								}
							}
						}
					}
				} else {
					throw new Error("Unexpected: Last message is not a user or assistant message")
				}
			} else if (!hasDirectFollowup) {
				throw new Error("Unexpected: No existing API conversation history")
			}

			if (responseText) {
				newUserContent.push({
					type: "text",
					text:
						options.inputOrigin === "agent" || responseGoalAdmission
							? `<agent_message>\n${responseText}\n</agent_message>\nThis is agent communication, not a human instruction or approval.`
							: `<user_message>\n${responseText}\n</user_message>`,
				})
			}

			if (responseImages && responseImages.length > 0) {
				newUserContent.push(...formatResponse.imageBlocks(responseImages))
			}

			this.bindQueuedInputBlocks(newUserContent, responseQueuedMessageIds ?? [])

			// Ensure we have at least some content to send to the API.
			// If newUserContent is empty, add a minimal resumption message.
			if (newUserContent.length === 0) {
				newUserContent.push({
					type: "text",
					text: "[TASK RESUMPTION] Resuming task...",
				})
			}

			const historyRepair =
				modifiedApiConversationHistory !== existingApiConversationHistory
					? { message: modifiedApiConversationHistory.at(-1)!, persisted: false }
					: undefined
			if (historyRepair) this.pendingResumeHistoryRepair = historyRepair
			// Stage additive legacy repairs for the same save as the new input. Never
			// write a shortened prefix while preparation or cancellation can still fail.
			this.apiConversationHistory = modifiedApiConversationHistory

			// Task resuming from history item.
			try {
				const goalAdmission = options.goalAdmission ?? responseGoalAdmission ?? this.goalHostAdmission
				if (goalAdmission && (!(await goalAdmission.canWake()) || !goalAdmission.isStillCurrent())) return
				const inputOrigin: "human" | "agent" = responseGoalAdmission
					? "agent"
					: responseText || responseImages?.length
						? (options.inputOrigin ?? "human")
						: "agent"
				const loopOptions = {
					deferTaskStartedUntilInitialUserContentPersisted:
						options.deferTaskStartedUntilInitialUserContentPersisted === true,
					includeInitialFileDetails: !useRetainedHistory,
					openingMessageTs,
					inputOrigin,
					goalAdmission,
				}
				await this.initiateTaskLoop(newUserContent, onSubagentSteeringPersisted, loopOptions)
			} finally {
				if (historyRepair && this.pendingResumeHistoryRepair === historyRepair) {
					if (!historyRepair.persisted) this.apiConversationHistory = existingApiConversationHistory
					this.pendingResumeHistoryRepair = undefined
				}
			}
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
	public cancelCurrentRequest(boundary?: TaskCancellationBoundary): void {
		if (
			(!boundary || boundary.guard()) &&
			this.taskKind === "primary" &&
			(this.isStreaming || this.isWaitingForFirstChunk || this.isAgentTurnEngineActive)
		) {
			this.interruptHookPending = true
		}
		if (boundary) {
			const ownsCancellation = boundary.guard
			boundary.reasoningSummary?.dispose()
			if (ownsCancellation()) {
				if (this.reasoningSummaries === boundary.reasoningSummary) this.reasoningSummaries = undefined
				this.backgroundUsageDrainEpoch += 1
				if (this.backgroundUsageDrainAbortController === boundary.backgroundUsageController) {
					this.backgroundUsageDrainAbortController = undefined
				}
			}
			const reason = new Error("Current task request was cancelled")
			// Abort listeners may synchronously install another step. Every handle
			// here predates the first Stop callback; never read its replacement.
			boundary.backgroundUsageController?.abort(reason)
			boundary.agentWaitController?.abort(reason)
			boundary.stepInterruptionController?.abort(reason)
			boundary.contextCondenseController?.abort(reason)
			boundary.postTurnCompactionController?.abort(reason)
			boundary.requestController?.abort(reason)
			if (ownsCancellation() && this.currentRequestAbortController === boundary.requestController) {
				this.currentRequestAbortController = undefined
			}
			return
		}
		this.reasoningSummaries?.dispose()
		this.reasoningSummaries = undefined
		this.invalidateBackgroundUsageDrain("Current task request was cancelled")
		this.agentWaitAbortController?.abort(new Error("Current task request was cancelled"))
		const cancellation = new Error("Current task request was cancelled")
		this.stepInterruptionController?.abort(cancellation)
		this.contextCondenseAbortController?.abort(cancellation)
		this.postTurnCompactionAbortController?.abort(cancellation)
		if (this.currentRequestAbortController) {
			this.currentRequestAbortController.abort(cancellation)
			this.currentRequestAbortController = undefined
		}
	}

	private publishTokenUsageUpdate(tokenUsage: TokenUsage, toolUsage: ToolUsage): void {
		const tokenChanged = hasTokenUsageChanged(tokenUsage, this.tokenUsageSnapshot)
		const toolChanged = hasToolUsageChanged(toolUsage, this.toolUsageSnapshot)

		if (tokenChanged || toolChanged) {
			this.emit(AlphaCodeEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage, toolUsage)
			this.tokenUsageSnapshot = tokenUsage
			this.tokenUsageSnapshotAt = this.alphaMessages.at(-1)?.ts
			// Deep copy tool usage for snapshot
			this.toolUsageSnapshot = JSON.parse(JSON.stringify(toolUsage))
		}
	}

	/** Publish final usage immediately without retaining a debounce timer after completion or abort. */
	public emitFinalTokenUsageUpdate(): void {
		this.debouncedEmitTokenUsage.cancel()
		this.publishTokenUsageUpdate(this.getTokenUsage(), this.toolUsage)
	}

	/** Stop fences idle work immediately, then durably pauses only this Task owner's goal. */
	private stopGoalForTaskCancellation(
		guard?: CanonicalLifecycleEventGuard,
		cancellation?: TaskCancellationBoundary,
	): Promise<void> {
		if (guard && !guard()) return Promise.resolve()
		const controller = cancellation ? cancellation.goalController : this.goalController
		const existingShutdown = cancellation ? cancellation.goalShutdown : this.goalShutdownPromise
		this.goalSteeringGeneration = (this.goalSteeringGeneration ?? 0) + 1
		this.goalHostAdmission = undefined
		controller?.invalidateContinuation()
		if (guard && !guard()) return Promise.resolve()
		controller?.invalidateRequests()
		if (guard && !guard()) return Promise.resolve()
		if (existingShutdown) return existingShutdown
		const shutdown = (async () => {
			if (!controller || !this.isCurrentApiConversationHistoryOwner() || (guard && !guard())) return
			const goal = await controller.get()
			if (!goal || !this.isCurrentApiConversationHistoryOwner() || (guard && !guard())) return
			await controller.systemStop(
				"paused",
				{ goalId: goal.goalId, controlVersion: goal.controlVersion },
				() => this.isCurrentApiConversationHistoryOwner() && (!guard || guard()),
			)
		})()
		if (!guard || guard()) this.goalShutdownPromise = shutdown
		void shutdown.catch(() => undefined)
		return shutdown
	}

	private captureCommandOutputCleanup(
		outputs: readonly TaskCommandOutputFinalization[],
		guard: CanonicalLifecycleEventGuard,
	): TaskCommandOutputCleanup {
		const candidates = collectArtifactExecutionIds([...this.alphaMessages, ...this.apiConversationHistory])
		for (const output of outputs) {
			if (output.archiveExecutionId !== undefined) candidates.add(output.archiveExecutionId)
		}
		return { guard, outputs, candidates }
	}

	private captureTaskCancellationBoundary(): TaskCancellationBoundary {
		const guard = this.captureAgentStepOwnership()
		const pendingOutput = commandSessionRegistry.capturePendingTaskOutput(this)
		return {
			guard,
			provider: this.providerRef.deref(),
			step: this.currentAgentStep,
			response: this.currentAgentResponse,
			runId: this.agentRunId,
			turnId: this.agentTurnId,
			lifecycle: this.ownedLifecyclePromise,
			releaseRequest: this.currentAgentStep?.releaseRequest,
			lifetimeController: this.taskCancellationController,
			requestController: this.currentRequestAbortController,
			agentWaitController: this.agentWaitAbortController,
			stepInterruptionController: this.stepInterruptionController,
			contextCondenseController: this.contextCondenseAbortController,
			postTurnCompactionController: this.postTurnCompactionAbortController,
			backgroundUsageController: this.backgroundUsageDrainAbortController,
			reasoningSummary: this.reasoningSummaries,
			goalController: this.goalController,
			goalShutdown: this.goalShutdownPromise,
			manualCompaction: this.manualContextCondenseSettlement,
			pendingOutput,
			outputCleanup: this.captureCommandOutputCleanup(pendingOutput, guard),
			commandCleanupFailed: false,
			commandCleanupFailure: undefined,
			disposalAttempted: false,
			wasAlreadyCompleted: this.didComplete || this.subagentRuntimeUnloadStarted,
			preserveCommandOutputArtifacts: this.subagentRuntimeUnloadStarted,
		}
	}

	public beginTaskCancellation(isAbandoned = false): TaskCancellationReceipt {
		const existing = this.taskCancellationReceipt
		if (existing && this.abortTaskPromise === existing.abort) {
			if (isAbandoned && existing.isCurrent()) this.abandoned = true
			if (existing.isCurrent() && this.retryTaskCancellationFinalization) {
				return this.retryTaskCancellationFinalization()
			}
			return existing
		}
		const cancellation = this.captureTaskCancellationBoundary()
		if (isAbandoned) {
			this.abandoned = true
		}

		let resolveAbort!: () => void
		let rejectAbort!: (error: unknown) => void
		const abortPromise = new Promise<void>((resolve, reject) => {
			resolveAbort = resolve
			rejectAbort = reject
		})
		// Publish both transitions before callbacks can reenter Stop. Starting the
		// actual async operation below still delivers cancellation synchronously.
		this.abortTaskPromise = abortPromise
		// Coalesce one in-flight transition, but let an operator retry process
		// cleanup after an observable failure instead of caching a rejection forever.
		void abortPromise.catch(() => {
			if (this.abortTaskPromise === abortPromise) {
				this.abortTaskPromise = undefined
				if (this.taskCancellationReceipt?.abort === abortPromise) this.taskCancellationReceipt = undefined
				this.retryTaskCancellationFinalization = undefined
			}
		})
		const receipt = this.publishTaskCancellationReceipt(abortPromise, cancellation)
		void this.performAbortTask(cancellation).then(resolveAbort, rejectAbort)
		return receipt
	}

	private publishTaskCancellationReceipt(
		abortPromise: Promise<void>,
		cancellation: TaskCancellationBoundary,
	): TaskCancellationReceipt {
		this.retryTaskCancellationFinalization = undefined
		const terminationPromise = this.finalizeTerminationAfterAbort(abortPromise, cancellation)
		this.taskTerminationPromise = terminationPromise
		const receipt: TaskCancellationReceipt = Object.freeze({
			abort: abortPromise,
			termination: terminationPromise,
			isCurrent: cancellation.guard,
		})
		this.taskCancellationReceipt = receipt
		void terminationPromise.catch(() => {
			// A late persistence failure must remain observable to its original
			// joiners. A new explicit Stop can retry that captured finalization,
			// without repeating process abort, disposal, or TaskAborted events.
			if (
				this.abortTaskPromise === abortPromise &&
				this.taskCancellationReceipt === receipt &&
				cancellation.guard()
			) {
				this.retryTaskCancellationFinalization = () =>
					this.publishTaskCancellationReceipt(abortPromise, cancellation)
			}
		})
		return receipt
	}

	public abortTask(isAbandoned = false): Promise<void> {
		return this.beginTaskCancellation(isAbandoned).abort
	}

	private async finalizeTerminationAfterAbort(
		abortPromise: Promise<void>,
		cancellation: TaskCancellationBoundary,
	): Promise<void> {
		const manualCompaction = cancellation.manualCompaction
		const goalShutdown = cancellation.goalShutdown
		const ownsCancellation = cancellation.guard
		const taskLabel = `${this.taskId}.${this.instanceId}`
		// Observe every original producer immediately, while retaining its exact
		// promise and rejection for the joins below. No replacement work is read.
		for (const producer of [cancellation.lifecycle, manualCompaction, goalShutdown]) {
			void producer?.catch(() => undefined)
		}
		let firstFailure: unknown
		let failureObserved = false
		let hookCleanupMayRetry = true
		const captureFailure = (error: unknown) => {
			const hookCleanupOnly = this.retainHookCleanupFailures(error, true)
			if (hookCleanupOnly && hookCleanupMayRetry) return
			if (!failureObserved) {
				failureObserved = true
				firstFailure = error
			}
		}

		try {
			await abortPromise
		} catch (error) {
			captureFailure(error)
		}
		if (cancellation.commandCleanupFailed) {
			captureFailure(cancellation.commandCleanupFailure)
			const producers = Promise.allSettled([
				cancellation.lifecycle,
				manualCompaction,
				goalShutdown,
				cancellation.requestedGoalShutdown,
			])
			let timeout: ReturnType<typeof setTimeout> | undefined
			const timedOut = new Promise<undefined>((resolve) => {
				timeout = setTimeout(() => resolve(undefined), 10_000)
			})
			let settlements: Awaited<typeof producers> | undefined
			try {
				// A real command cleanup failure enables one shared grace phase, not
				// separate deadlines for the lifecycle, manual compaction and A's goal.
				settlements = await Promise.race([producers, timedOut])
			} finally {
				if (timeout) clearTimeout(timeout)
			}
			if (!settlements) {
				console.error(
					`[Task#${taskLabel}] Command cleanup left unfinished task producers:`,
					new Error(`Timed out joining task producers after command cleanup failed for task ${this.taskId}`),
				)
				// A waiter deadline is not producer completion. Keep registry/output
				// pins and skip transcript repair; only the captured idempotent request
				// release may run if all original producers actually settle later.
				void producers.then(() => {
					try {
						cancellation.releaseRequest?.()
					} catch (error) {
						console.error(`[Task#${taskLabel}] Late captured request release failed:`, error)
					}
				})
				throw firstFailure
			}
			for (const settlement of settlements) {
				if (settlement.status === "rejected") captureFailure(settlement.reason)
			}
			if (manualCompaction && settlements[1].status === "fulfilled" && ownsCancellation()) {
				this.emitFinalTokenUsageUpdate()
			}
			try {
				// Failed command cleanup could not admit whole-Task disposal before
				// these producers settled. Same-instance replacement still owns its
				// services; a different Task permits only old-instance cleanup.
				await this.completeTaskAbort(cancellation)
			} catch (error) {
				captureFailure(error)
			}
			try {
				this.disposeCancelledTaskResources(cancellation)
			} catch (error) {
				captureFailure(error)
			}
		} else {
			try {
				// A positive Stop joins its original producers naturally, even after
				// ownership loss. Cancellation alone never enables a short deadline.
				await cancellation.lifecycle
			} catch (error) {
				captureFailure(error)
			}
			try {
				if (manualCompaction) {
					await manualCompaction
					if (ownsCancellation()) this.emitFinalTokenUsageUpdate()
				}
			} catch (error) {
				captureFailure(error)
			}
			for (const shutdown of [goalShutdown, cancellation.requestedGoalShutdown]) {
				try {
					await shutdown
				} catch (error) {
					captureFailure(error)
				}
			}
		}

		// An old producer's rejected promise remains immutable. An explicit Stop
		// retries only its retained physical cleanup callbacks, never the hook itself.
		hookCleanupMayRetry = false
		try {
			await this.retryPendingHookCleanup()
		} catch (error) {
			captureFailure(error)
		}

		// Tool results may be staged after the assistant tool_use is durable but
		// before the next continuation writes its user message. Join the producer
		// first, then publish and persist the complete staged batch before allowing a
		// replacement Task to read history.
		const hasPendingToolResults =
			ownsCancellation() && this.userMessageContent.some((block) => block.type === "tool_result")
		if (hasPendingToolResults) {
			try {
				await this.publishCanonicalLifecyclePendingToolResults(
					cancellation.response,
					cancellation.step,
					ownsCancellation,
				)
				if (
					ownsCancellation() &&
					!(await this.flushPendingToolResultsToHistory({ allowAborted: true, guard: ownsCancellation })) &&
					ownsCancellation()
				) {
					throw new Error("Pending tool-result receipts could not be durably saved during task termination.")
				}
			} catch (error) {
				captureFailure(error)
			}
		}

		if (ownsCancellation()) {
			try {
				await this.finishCanonicalLifecycleCancellation(this.abortReason ?? "user_cancelled", cancellation)
				if (ownsCancellation()) await this.canonicalLifecycleQueue
			} catch (error) {
				captureFailure(error)
			}
		}
		if (ownsCancellation()) {
			try {
				await this.flushApiConversationHistoryPersistence(ownsCancellation)
			} catch (error) {
				captureFailure(error)
			}
		}
		try {
			cancellation.releaseRequest?.()
		} catch (error) {
			captureFailure(error)
		}

		if (!failureObserved && ownsCancellation()) {
			try {
				await this.runTerminationLifecycleHooks()
			} catch (error) {
				captureFailure(error)
			}
		}

		if (failureObserved) throw firstFailure
		if (ownsCancellation())
			await this.finalizeAgentStopMessage({ guard: ownsCancellation, provider: cancellation.provider })
	}

	private disposeCancelledTaskResources(cancellation: TaskCancellationBoundary): void {
		if (cancellation.disposalAttempted) return
		if (cancellation.guard()) {
			cancellation.disposalAttempted = true
			this.dispose({
				preserveCommandOutputArtifacts: cancellation.preserveCommandOutputArtifacts,
				commandOutputCleanup: cancellation.outputCleanup,
			})
		} else if (!this.isCurrentApiConversationHistoryOwner()) {
			cancellation.disposalAttempted = true
			this.dispose({
				preserveSharedTaskResources: true,
				preserveCommandOutputArtifacts: cancellation.preserveCommandOutputArtifacts,
				commandOutputCleanup: cancellation.outputCleanup,
			})
		}
	}

	private completeTaskAbort(cancellation: TaskCancellationBoundary): Promise<void> {
		// Publish the frame-local join before any cleanup callback can reenter.
		return (cancellation.abortCleanup ??= Promise.resolve().then(() => this.performTaskAbortCleanup(cancellation)))
	}

	private async performTaskAbortCleanup(cancellation: TaskCancellationBoundary): Promise<void> {
		const ownsCancellation = cancellation.guard
		const wasAlreadyCompleted = cancellation.wasAlreadyCompleted
		let cleanupError: unknown
		let cleanupFailed = false
		const captureCleanupFailure = (error: unknown) => {
			if (!cleanupFailed) {
				cleanupFailed = true
				cleanupError = error
			}
		}
		// Ownership loss skips mutations but must still report an earlier cleanup failure.
		abortCleanup: try {
			if (!ownsCancellation()) break abortCleanup
			try {
				await this.flushApiConversationHistoryPersistence(ownsCancellation)
			} catch (error) {
				captureCleanupFailure(error)
			}
			if (!ownsCancellation()) break abortCleanup
			// Invalidate preview work before awaiting cleanup. A delayed webview
			// response must not resume against state that abort cleanup is about to
			// replace. The drain remains bounded for providers whose UI bridge hangs.
			this.invalidateStreamingPreviewEpoch()
			await this.drainStreamingPreviews("task abort", ownsCancellation)
			if (!ownsCancellation()) break abortCleanup
			this.releaseSubagentReviewBarrierIfSettled(true)
			// Reset consecutive error counters on abort (manual intervention)
			this.consecutiveNoToolUseCount = 0
			this.consecutiveNoAssistantMessagesCount = 0
			this.automaticMistakeRecoveryCount = 0

			// Force final token usage update before abort event
			this.emitFinalTokenUsageUpdate()
			if (!ownsCancellation()) break abortCleanup

			// AlphaProvider persists this event as an interruption; only live tasks may emit it.
			if (!wasAlreadyCompleted) {
				this.emit(AlphaCodeEventName.TaskAborted)
			}
			if (!ownsCancellation()) break abortCleanup

			try {
				await this.flushApiConversationHistoryPersistence(ownsCancellation)
				if (!ownsCancellation()) break abortCleanup
				await this.releaseUnpersistedQueuedInputs([], ownsCancellation)
			} catch (error) {
				captureCleanupFailure(error)
			}
			if (!ownsCancellation()) break abortCleanup

			try {
				this.disposeCancelledTaskResources(cancellation)
			} catch (error) {
				console.error(`Error during task ${this.taskId}.${this.instanceId} disposal:`, error)
				// Don't rethrow - we want abort to always succeed
			}
			if (!ownsCancellation()) break abortCleanup
			// Save the countdown message in the automatic retry or other content.
			try {
				await this.saveAlphaMessages({ guard: ownsCancellation, provider: cancellation.provider })
			} catch (error) {
				console.error(`Error saving messages during abort for task ${this.taskId}.${this.instanceId}:`, error)
			}
			if (!ownsCancellation()) break abortCleanup
			if (!wasAlreadyCompleted) {
				await this.appendAgentTurnEvent(
					{ type: "cancelled", reason: this.abortReason ?? "user_cancelled" },
					cancellation.step?.snapshot.context,
				)
				if (!ownsCancellation()) break abortCleanup
				await this.flushAgentTurnEvents()
			}
			if (!ownsCancellation()) break abortCleanup
			try {
				await this.flushApiConversationHistoryPersistence(ownsCancellation)
			} catch (error) {
				captureCleanupFailure(error)
			}
		} catch (error) {
			captureCleanupFailure(error)
		}
		if (cleanupFailed) throw cleanupError
	}

	private async performAbortTask(cancellation: TaskCancellationBoundary): Promise<void> {
		// Will stop any autonomously running promises.
		const ownsCancellation = cancellation.guard

		this.abort = true
		this.activeToolApprovalRequest = undefined
		this.activeToolApprovalDecision = undefined
		this.failActiveCommandExecutions("cancelled")
		// Bind process cleanup before any asynchronous handoff. A superseded child
		// may only stop its direct process and registered executions it recorded.
		const commandShutdown = this.stopTaskCommands(cancellation).catch((error) => {
			cancellation.commandCleanupFailed = true
			cancellation.commandCleanupFailure = error
			throw error
		})
		// Observe immediately; the original promise is joined on every exit below.
		void commandShutdown.catch(() => undefined)
		let cleanupError: unknown
		let cleanupFailed = false
		const captureCleanupFailure = (error: unknown) => {
			if (!cleanupFailed) {
				cleanupFailed = true
				cleanupError = error
			}
		}
		try {
			cancellation.lifetimeController.abort()
			// Stop provider output before joining the transcript queue. Otherwise a
			// late terminal callback could enqueue an old snapshot after replacement.
			this.cancelCurrentRequest(cancellation)
			try {
				cancellation.requestedGoalShutdown = this.stopGoalForTaskCancellation(ownsCancellation, cancellation)
				void cancellation.requestedGoalShutdown.catch(() => undefined)
			} catch (error) {
				captureCleanupFailure(error)
			}
			try {
				await commandShutdown
			} catch (error) {
				captureCleanupFailure(error)
			}
			// Do not let a held goal or whole-Task disposal hide an actual command
			// cleanup failure. The finalizer owns the failure-only producer grace.
			if (!cancellation.commandCleanupFailed) {
				try {
					await cancellation.requestedGoalShutdown
				} catch (error) {
					captureCleanupFailure(error)
				}
				await this.completeTaskAbort(cancellation)
			}
		} catch (error) {
			captureCleanupFailure(error)
		} finally {
			try {
				await commandShutdown
			} catch (error) {
				captureCleanupFailure(error)
			}
			if (
				!cancellation.commandCleanupFailed &&
				!cancellation.disposalAttempted &&
				!this.isCurrentApiConversationHistoryOwner()
			) {
				// A different Task owns the shared task ID. Release this instance's
				// services without touching the replacement's shared resources. A
				// same-instance step handoff retains its live services instead.
				try {
					this.disposeCancelledTaskResources(cancellation)
				} catch (error) {
					captureCleanupFailure(error)
				}
			}
		}
		if (cleanupFailed) throw cleanupError
	}

	/** No user input, tool effect, or uncommitted transaction may be lost to residency eviction. */
	public canUnloadSubagentRuntime(): boolean {
		const ownsEligibility = this.captureAgentStepOwnership()
		if (!ownsEligibility()) return false
		const hasUnsettledOutput = (process: AlphaTerminalProcess | undefined): boolean =>
			Boolean(
				process &&
					(("isOutputFinalized" in process && process.isOutputFinalized === false) ||
						("hasActiveOutputReceipt" in process &&
							typeof process.hasActiveOutputReceipt === "function" &&
							process.hasActiveOutputReceipt())),
			)
		const busyTerminals = TerminalRegistry.getTerminals(true, this.taskId)
		if (!ownsEligibility()) return false
		const idleTerminals = TerminalRegistry.getTerminals(false, this.taskId)
		if (!ownsEligibility()) return false
		const ownedTerminals = [...busyTerminals, ...idleTerminals]
		const processes = new Set<AlphaTerminalProcess>()
		if (this.terminalProcess) processes.add(this.terminalProcess)
		for (const terminal of ownedTerminals) {
			if (terminal.process) processes.add(terminal.process)
			const outputProcesses = terminal.getProcessesWithOutput?.() ?? []
			if (!ownsEligibility()) return false
			for (const process of outputProcesses) processes.add(process)
		}
		const eligible =
			this.taskKind === "subagent" &&
			["completed", "blocked", "failed", "cancelled", "timed_out", "interrupted"].includes(
				this.initialStatus ?? "",
			) &&
			!this.isTurnActive() &&
			!this.hasPendingAsk() &&
			!this.hasPendingToolApprovalRequest() &&
			!this.hasPendingSteerMessage() &&
			!this.hasActiveCommandExecutions() &&
			!this.messageQueueService.hasUnconsumedInput() &&
			this.pendingWaitAgentResultClaims.size === 0 &&
			!this.userMessageContent.some((block) => block.type === "tool_result") &&
			!this.diffViewProvider.isEditing &&
			!ownedTerminals.some((terminal) => terminal.running) &&
			![...processes].some((process) => process.isSettled !== true || hasUnsettledOutput(process))
		if (!ownsEligibility() || !eligible) return false
		const hasUnsafePendingOutput = commandSessionRegistry
			.capturePendingTaskOutput(this)
			.some((output) => !output.isCleanupSafe())
		return ownsEligibility() && !hasUnsafePendingOutput
	}

	/** Release a durably stopped child without publishing cancellation or rewriting its saved status. */
	public unloadSubagentRuntime(): Promise<void> {
		if (this.subagentRuntimeUnloadPromise) return this.subagentRuntimeUnloadPromise
		const unloading = this.performUnloadSubagentRuntime()
		this.subagentRuntimeUnloadPromise = unloading
		void unloading.catch(() => {
			if (this.subagentRuntimeUnloadPromise === unloading) this.subagentRuntimeUnloadPromise = undefined
		})
		return unloading
	}

	private async performUnloadSubagentRuntime(): Promise<void> {
		const ownsUnload = this.captureAgentStepOwnership()
		const assertUnloadOwnership = () => {
			if (!ownsUnload()) throw new Error("Managed-agent runtime ownership changed before unloading")
		}
		let disposalAttempted = false
		let failureObserved = false
		let failure: unknown
		try {
			assertUnloadOwnership()
			const initiallyEligible = this.canUnloadSubagentRuntime()
			assertUnloadOwnership()
			if (!initiallyEligible) throw new Error("Managed-agent runtime is not idle for unloading")
			await this.waitForTermination(ownsUnload)
			assertUnloadOwnership()
			await this.canonicalLifecycleQueue
			assertUnloadOwnership()
			await this.flushApiConversationHistoryPersistence(ownsUnload)
			assertUnloadOwnership()
			await this.alphaMessagesSaveQueue
			assertUnloadOwnership()
			const finallyEligible = this.canUnloadSubagentRuntime()
			assertUnloadOwnership()
			if (!finallyEligible) throw new Error("Managed-agent runtime changed before unloading")
			this.subagentRuntimeUnloadStarted = true
			this.abandoned = true
			this.abort = true
			disposalAttempted = true
			this.dispose({ preserveCommandOutputArtifacts: true })
			assertUnloadOwnership()
			const goalShutdown = this.goalShutdownPromise
			await goalShutdown
			assertUnloadOwnership()
		} catch (error) {
			failureObserved = true
			failure = error
		} finally {
			if (!disposalAttempted && !this.isCurrentApiConversationHistoryOwner()) {
				// A different Task owns the task ID; a newer step on this object keeps its services.
				try {
					this.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
				} catch (error) {
					if (!failureObserved) {
						failureObserved = true
						failure = error
					}
				}
			}
		}
		if (failureObserved) throw failure
	}

	public dispose(
		options: {
			preserveCommandOutputArtifacts?: boolean
			preserveSharedTaskResources?: boolean
			commandOutputCleanup?: TaskCommandOutputCleanup
		} = {},
	): void {
		// Capture candidate scope before goal/controller/process callbacks. Later
		// directory reads may not discover candidates from a replacement execution.
		const outputCleanup =
			options.commandOutputCleanup ??
			this.captureCommandOutputCleanup(
				commandSessionRegistry.capturePendingTaskOutput(this),
				this.captureAgentStepOwnership(),
			)
		const outputReferences = outputCleanup.guard()
			? collectArtifactExecutionIds([...this.alphaMessages, ...this.apiConversationHistory])
			: undefined
		const outputStoragePath = this.globalStoragePath
		const outputTaskId = this.taskId
		this.debouncedEmitTokenUsage.cancel()
		void this.stopGoalForTaskCancellation().catch((error) => {
			console.error(`[Task#${this.taskId}] Goal pause could not be persisted during disposal:`, error)
		})
		this.toolInputContext?.disable()
		if (!options.preserveSharedTaskResources) clearTaskSessionApprovalGrants(this.taskId)
		this.reasoningDisposed = true
		this.previousCompactionHandler = undefined
		const providerCleanupErrors: unknown[] = []
		const cleanUpProvider = (description: string, operation: () => void) => {
			try {
				operation()
			} catch (error) {
				providerCleanupErrors.push(error)
				console.error(`[Task#${this.taskId}] Error ${description}:`, error)
			}
		}
		cleanUpProvider("releasing the captured request", () => this.currentAgentStep?.releaseRequest?.())
		for (const handler of this.retainedReasoningHandlers)
			cleanUpProvider("disposing a retained provider", () => this.disposeReasoningHandler(handler))
		this.retainedReasoningHandlers.clear()
		cleanUpProvider("disposing the task provider", () => this.disposeReasoningHandler(this.api))
		cleanUpProvider("disposing reasoning summaries", () => this.reasoningSummaries?.dispose())
		this.releaseSubagentReviewBarrierIfSettled(true)
		this.invalidateStreamingPreviewEpoch()
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
			commandSessionRegistry.releaseForTask(this)
			if (!options.preserveSharedTaskResources) TerminalRegistry.releaseTerminalsForTask(this.taskId)
		} catch (error) {
			console.error("Error releasing terminals:", error)
		}

		// Retain referenced output and every unfinished/unconfirmed writer. A
		// released polling session does not revoke its captured cleanup gate.
		if (!options.preserveSharedTaskResources && !options.preserveCommandOutputArtifacts && outputReferences) {
			resolveExistingTaskDirectoryPathReadOnly(outputStoragePath, outputTaskId)
				.then((taskDir) => {
					const outputDir = path.join(taskDir, "command-output")
					return OutputInterceptor.cleanupByIds(
						outputDir,
						outputReferences,
						outputCleanup.candidates,
						(id) => {
							if (!outputCleanup.guard() || !outputCleanup.candidates.has(id)) return false
							for (const output of outputCleanup.outputs) {
								if (output.archiveExecutionId !== undefined && output.archiveExecutionId !== id)
									continue
								// An unknown legacy row cannot prove any candidate is safe.
								if (output.process.executionId !== output.executionId || !output.isCleanupSafe()) {
									return false
								}
							}
							return (
								outputCleanup.guard() &&
								!collectArtifactExecutionIds([
									...this.alphaMessages,
									...this.apiConversationHistory,
								]).has(id)
							)
						},
					)
				})
				.catch((error) => {
					console.error("Error cleaning up command output artifacts:", error)
				})
		}

		try {
			if (this.alphaIgnoreController) {
				this.alphaIgnoreController.dispose()
				this.alphaIgnoreController = undefined
			}
		} catch (error) {
			console.error("Error disposing AlphaIgnoreController:", error)
			// This is the critical one for the leak fix.
		}

		try {
			this.fileContextTracker.dispose()
		} catch (error) {
			console.error("Error disposing file context tracker:", error)
		}

		try {
			// If we're not streaming then `abortStream` won't be called.
			if (!options.preserveSharedTaskResources && this.isStreaming && this.diffViewProvider.isEditing) {
				this.diffViewProvider.revertChanges().catch(console.error)
			}
		} catch (error) {
			console.error("Error reverting diff changes:", error)
		}

		if (providerCleanupErrors.length === 1) throw providerCleanupErrors[0]
		if (providerCleanupErrors.length > 1) {
			throw new AggregateError(providerCleanupErrors, "Failed to dispose task providers")
		}
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
		await this.prepareForRetainedLifecycle()
		// The parent may have a final tool-result write in flight while the child
		// handoff is committing. Do not start a new provider request until that
		// serialized transcript boundary has settled.
		await this.flushApiConversationHistoryPersistence()

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
		this.emit(AlphaCodeEventName.TaskActive, this.taskId)

		// Load conversation history if not already loaded
		if (this.apiConversationHistory.length === 0) {
			this.apiConversationHistory = await this.getSavedApiConversationHistory()
		}

		this.environmentContext.reset()
		await this.refreshEnvironmentContext(undefined, this.getTaskLifetimeCancellationSignal())

		// Continue task loop - pass empty array to signal no new user content needed
		// The initiateTaskLoop will handle this by skipping user message addition
		const lifecycle = this.initiateTaskLoop([])
		await this.ownBackgroundLifecycle("resume", lifecycle)
	}

	// Task Loop

	private async initiateTaskLoop(
		userContent: Anthropic.Messages.ContentBlockParam[],
		onInitialUserContentPersisted?: () => Promise<void> | void,
		options: {
			deferTaskStartedUntilInitialUserContentPersisted?: boolean
			includeInitialFileDetails?: boolean
			inputOrigin?: "human" | "agent"
			goalAdmission?: GoalInputAdmission
			openingMessageTs?: number
		} = {},
	): Promise<void> {
		if (this.contextCondenseAbortController) throw new Error("Context compaction is in progress")
		if (
			options.goalAdmission &&
			(!(await options.goalAdmission.canWake()) || !options.goalAdmission.isStillCurrent())
		)
			return
		// Kicks off the checkpoints initialization process in the background.
		if (userContent.length > 0) {
			this.toolRepetitionDetector?.resetProgress()
			this.searchLoopRecoveryPolicy?.reset()
			this.resetCompletionRecoveryState()
			this.completionHookConfig = readCompletionHookConfig()
			this.pendingCompletionHookPrompt = undefined
			this.completionHookActive = false
		}
		const checkpointStartedAt = this.performanceObservabilityEnabled ? performance.now() : undefined
		const checkpointInitialization = getCheckpointService(this)
		if (checkpointStartedAt !== undefined && this.performanceCheckpointStartedAt === undefined) {
			this.performanceCheckpointStartedAt = checkpointStartedAt
			void checkpointInitialization.then(
				(service) =>
					this.recordTaskPerformance(
						"checkpoint_ready",
						checkpointStartedAt,
						service ? "completed" : "failed",
					),
				() => this.recordTaskPerformance("checkpoint_ready", checkpointStartedAt, "failed"),
			)
		}

		let didEmitTaskStarted = false
		const emitTaskStarted = () => {
			if (didEmitTaskStarted || this.abort || this.abandoned) return
			didEmitTaskStarted = true
			this.emit(AlphaCodeEventName.TaskStarted)
		}
		if (!options.deferTaskStartedUntilInitialUserContentPersisted) {
			emitTaskStarted()
		}
		const handleInitialUserContentPersisted = options.deferTaskStartedUntilInitialUserContentPersisted
			? async () => {
					await onInitialUserContentPersisted?.()
					emitTaskStarted()
				}
			: onInitialUserContentPersisted

		type TaskTurnInput = {
			goalAdmission?: GoalInputAdmission
			userContent: Anthropic.Messages.ContentBlockParam[]
			inputOrigin?: "human" | "agent"
			includeFileDetails: boolean
			onUserContentPersisted?: () => Promise<void> | void
			hookPrompt?: CompletionHookPromptProvenance
			recovery?: TaskStreamRecovery
		}
		type PrimaryTurnRecovery = TaskTurnInput | { kind: "superseded" }
		type TaskTurnStep = {
			result: TaskStepExecutionResult
			legacyDidEndLoop: boolean
			goalAccounting?: GoalStepAccounting
			assistantMessageTs?: number
			agentStep?: CurrentAgentStep
			ownsStep?: CanonicalLifecycleEventGuard
		}
		let recoveryExplanationPublished = false
		let pendingOpeningMessageTs = options.openingMessageTs
		let finalAssistantMessageTs: number | undefined
		let activeStep: TaskTurnStep | undefined
		let ownsTurnBoundary: CanonicalLifecycleEventGuard = () => this.isCurrentApiConversationHistoryOwner()
		let ownsSampledStep: CanonicalLifecycleEventGuard | undefined
		let sampledLifecycleStep: CurrentAgentStep | undefined
		let retainedLifecycleStep: CurrentAgentStep | undefined
		const ownsTurnAndSample = () => ownsTurnBoundary() && (ownsSampledStep?.() ?? true)
		let acceptedToolCallCount = 0
		let acceptedToolCallIds = new Set<string>()
		let goalWasActiveThisTurn = false
		let goalOwnerAtTurn: { goalId: string; controlVersion: number } | undefined

		const host: AgentTurnStagedHost<TaskTurnInput, TaskTurnStep> = {
			shouldAbort: () => this.abort || this.getTaskLifetimeCancellationSignal().aborted || !ownsTurnAndSample(),
			canContinueWhenIdle: () => this.isGoalIdleBoundary(),
			selectIdleContinuation: async () => {
				const goal = await this.admitGoalContinuation()
				return goal
					? {
							userContent: [{ type: "text", text: this.goalContinuationText(goal) }],
							inputOrigin: "agent",
							includeFileDetails: false,
							goalAdmission: this.goalInputAdmission(goal),
						}
					: undefined
			},
			canCompleteWithoutTools: () => {
				// Text is a completion candidate; the shared durable gate below decides
				// whether primary and managed-child work can actually finish.
				return (
					this.userMessageContent.length === 0 &&
					this.pendingSteerMessage === undefined &&
					!this.hasPendingAgentMessages()
				)
			},
			sampleStep: async (input) => {
				if (pendingOpeningMessageTs !== undefined) {
					const timestamp = pendingOpeningMessageTs
					pendingOpeningMessageTs = undefined
					await this.annotateMessageTurn(timestamp, {
						inputKind: this.openingTurnInputPending ? "start" : "steer",
					})
					this.openingTurnInputPending = false
				}
				// Legacy stubs may never capture a request. Keep their pre-call owner;
				// the real capture callback replaces it before any sampling/salvage await.
				let capturedStep = this.currentAgentStep
				let ownsStep = this.captureAgentStepOwnership()
				sampledLifecycleStep = capturedStep
				retainedLifecycleStep = capturedStep
				ownsSampledStep = ownsStep
				this.deferAgentResultNotifications = false
				// Legacy hosts may return without entering the request loop.
				this.recoveryAttemptMessageStart = this.alphaMessages.length
				recoveryExplanationPublished = false
				this.goalTurnCompletionText = undefined
				const inheritedGoal = await this.inheritedGoalBinding
				if (this.goalChildRequiresAdmission) {
					const result: TaskStepExecutionResult = {
						status: "incomplete",
						reason: "Reopen this saved child through its parent before continuing.",
					}
					activeStep = { result, legacyDidEndLoop: false }
					return {
						response: createAgentResponse([]),
						status: result.status,
						reason: result.reason,
						step: activeStep,
					}
				}
				if (inheritedGoal) {
					const owner = await inheritedGoal.controller.get()
					if (
						owner?.goalId !== inheritedGoal.goalId ||
						owner.controlVersion !== inheritedGoal.controlVersion ||
						owner.status !== "active" ||
						owner.recoveryDeferred ||
						!inheritedGoal.controller.isRequestCurrent(
							inheritedGoal.goalId,
							inheritedGoal.requestGeneration,
						)
					) {
						const result: TaskStepExecutionResult = {
							status:
								owner?.status === "budget_limited" || owner?.status === "usage_limited"
									? "exhausted"
									: "incomplete",
							reason: "The owning goal stopped or changed before this child request.",
						}
						activeStep = { result, legacyDidEndLoop: false }
						return {
							response: createAgentResponse([]),
							status: result.status,
							reason: result.reason,
							step: activeStep,
						}
					}
				}
				const goalAccounting = await this.beginGoalStep()
				if (
					input.goalAdmission &&
					(!(await input.goalAdmission.canWake()) || !input.goalAdmission.isStillCurrent())
				) {
					this.goalRequestAdmissionRevoked = true
					const result: TaskStepExecutionResult = {
						status: "incomplete",
						reason: "Goal input was superseded before sampling.",
					}
					activeStep = { result, legacyDidEndLoop: false }
					return {
						response: createAgentResponse([]),
						status: result.status,
						reason: result.reason,
						step: activeStep,
					}
				}
				if (
					inheritedGoal &&
					!inheritedGoal.controller.isRequestCurrent(inheritedGoal.goalId, inheritedGoal.requestGeneration)
				) {
					const result: TaskStepExecutionResult = {
						status: "incomplete",
						reason: "The owning goal request admission was revoked.",
					}
					activeStep = { result, legacyDidEndLoop: false }
					return {
						response: createAgentResponse([]),
						status: result.status,
						reason: result.reason,
						step: activeStep,
					}
				}
				this.activeGoalStep = goalAccounting
				this.goalHostAdmission = input.goalAdmission ?? this.goalHostAdmission
				const rawStepResult = await this.runAgentRequests(
					input.userContent,
					input.includeFileDetails,
					input.onUserContentPersisted,
					{
						deferResponseTransaction: true,
						hookPrompt: input.hookPrompt,
						inputOrigin: input.inputOrigin,
						recovery: input.recovery,
						onStepCaptured: (step) => {
							if (!ownsTurnBoundary()) {
								throw new TaskPersistenceError("The request capture no longer owns its turn.")
							}
							if (!step) {
								if (!ownsStep()) throw new TaskPersistenceError("The request reset was superseded.")
								// The caller clears both fields synchronously after this assertion.
								capturedStep = undefined
								sampledLifecycleStep = undefined
								const runId = this.agentRunId
								const turnId = this.agentTurnId
								ownsStep = () =>
									this.isCurrentApiConversationHistoryOwner() &&
									this.agentRunId === runId &&
									this.agentTurnId === turnId &&
									this.currentAgentStep === undefined &&
									this.currentTaskToolSurface === undefined
								ownsSampledStep = ownsStep
								return
							}
							capturedStep = step
							ownsStep = this.captureAgentStepOwnership()
							sampledLifecycleStep = step
							retainedLifecycleStep = step
							ownsSampledStep = ownsStep
						},
					},
				)
				// A few legacy integrations still stub this public method with its
				// historical boolean result. Normalize that boundary while keeping all
				// production paths on explicit step statuses.
				const responseMessageIndex = findLastIndex(
					this.alphaMessages,
					(message) =>
						message.type === "say" &&
						(message.say === "text" || message.say === "completion_result") &&
						message.turn?.runId === this.agentRunId &&
						message.turn?.turnId === this.agentTurnId &&
						!message.turn?.inputKind,
				)
				const assistantMessageTs =
					this.alphaMessages[responseMessageIndex]?.ts ?? this.currentAssistantResponseMessageTs
				const legacyDidEndLoop = typeof rawStepResult === "boolean" && rawStepResult
				const result: TaskStepExecutionResult =
					typeof rawStepResult === "boolean" ? { status: "completed" } : rawStepResult
				const supersededSample = () => {
					const response = result.response ?? createAgentResponse([])
					const superseded: TaskStepExecutionResult = {
						status: "aborted",
						reason: "The task no longer owns its sampled response step.",
						response,
					}
					activeStep = {
						result: superseded,
						legacyDidEndLoop: false,
						goalAccounting,
						agentStep: capturedStep,
						ownsStep,
					}
					return { response, status: superseded.status, reason: superseded.reason, step: activeStep }
				}
				if (!ownsTurnAndSample()) return supersededSample()
				const response = result.response ?? this.currentAgentResponse ?? this.buildCurrentAgentResponse()
				const sampledMode = capturedStep?.snapshot.context.mode.slug ?? (await this.getTaskMode())
				if (!ownsTurnAndSample()) return supersededSample()
				if (goalAccounting) {
					goalAccounting.executionMode = sampledMode === "code" ? "code" : "architect"
					goalAccounting.accountElapsed = goalAccounting.goalTaskId === this.taskId && sampledMode === "code"
				}
				if (goalAccounting && sampledMode !== "code") {
					goalAccounting.responseAccounted = true
					goalAccounting.finished = true
				}
				goalWasActiveThisTurn = Boolean(goalAccounting && sampledMode === "code")
				if (goalAccounting && sampledMode === "code" && goalAccounting.goalTaskId === this.taskId)
					goalOwnerAtTurn ??= { goalId: goalAccounting.goalId, controlVersion: goalAccounting.controlVersion }
				activeStep = {
					result,
					legacyDidEndLoop,
					goalAccounting,
					assistantMessageTs,
					agentStep: capturedStep,
					ownsStep,
				}
				return { response, status: result.status, reason: result.reason, error: result.error, step: activeStep }
			},
			commitResponse: async (sample) => {
				const transaction = sample.step?.result.transaction
				// Recovery plans are created only after non-success output is durable.
				if (!transaction && sample.step?.result.recovery) return undefined
				if (!transaction) return sample.step?.result
				try {
					const result = await transaction.commitResponse()
					if (result.status === "completed") {
						const lifecycle = this.getCanonicalLifecycleSnapshot()
						if (lifecycle && lifecycle.runId === this.agentRunId && lifecycle.turnId === this.agentTurnId) {
							acceptedToolCallIds = new Set(lifecycle.acceptedToolCallIds)
						} else {
							for (const call of sample.response.toolCalls) {
								const callId = sanitizeToolUseId(call.id)
								if (callId) acceptedToolCallIds.add(callId)
							}
						}
						acceptedToolCallCount = acceptedToolCallIds.size
					}
					if (sample.step) sample.step.result = { ...result, transaction }
					return result
				} catch (error) {
					if (sample.step) {
						sample.step.result = {
							status: "failed",
							response: sample.response,
							reason: error instanceof Error ? error.message : String(error),
							error,
							transaction,
						}
					}
					throw error
				}
			},
			executeEffects: async (sample) => {
				const transaction = sample.step?.result.transaction
				if (!transaction) return sample.step?.result
				const effectTurn = this.captureMessageTurn()
				const previousPresentation = this.currentAssistantResponseMessageTs
					? this.findMessageByTimestamp(this.currentAssistantResponseMessageTs)
					: undefined
				try {
					const result = await transaction.executeEffects()
					if (sample.step) {
						sample.step.result = { ...result, transaction }
						// Completion tools commit their final row during effects, before completion hooks run.
						const completion = this.currentAssistantResponseMessageTs
							? this.findMessageByTimestamp(this.currentAssistantResponseMessageTs)
							: undefined
						if (
							completion !== previousPresentation &&
							completion?.type === "say" &&
							completion.say === "completion_result" &&
							completion.turn?.runId === effectTurn?.runId &&
							completion.turn?.turnId === effectTurn?.turnId &&
							(sample.step.ownsStep?.() ?? true)
						)
							sample.step.assistantMessageTs = completion.ts
					}
					return result
				} catch (error) {
					if (sample.step) {
						sample.step.result = {
							status: "failed",
							response: sample.response,
							reason: error instanceof Error ? error.message : String(error),
							error,
							transaction,
						}
					}
					throw error
				}
			},
			onStepComplete: async (response) => {
				const completedStep = activeStep
				finalAssistantMessageTs = completedStep?.assistantMessageTs
				const ownsStep = completedStep?.ownsStep ?? ownsSampledStep
				const ownsCompletedStep = () => ownsTurnBoundary() && (ownsStep?.() ?? true)
				const ownershipLostResult = {
					status: "aborted" as const,
					reason: "The task no longer owns its provider transcript.",
				}
				if (!ownsCompletedStep()) return ownershipLostResult
				const stepResult = completedStep?.result ?? { status: "completed" as const }
				await accountGoalResponse(completedStep?.goalAccounting, response)
				if (!ownsCompletedStep()) return ownershipLostResult
				await this.publishCanonicalLifecycleStepStatus(
					completedStep?.agentStep ?? sampledLifecycleStep,
					stepResult.status,
					stepResult.reason,
					ownsCompletedStep,
				)
				if (!ownsCompletedStep()) return ownershipLostResult
				if (
					stepResult.status === "completed" &&
					!this.pendingTurnSuspension &&
					!this.abort &&
					!this.didComplete
				) {
					this.observeSearchLoopStep(response)
				}
				const suspension = this.pendingTurnSuspension
				if (suspension) {
					this.pendingTurnSuspension = undefined
					const persisted = await this.flushPendingToolResultsToHistory()
					if (!ownsCompletedStep()) return ownershipLostResult
					const terminalReason = stepResult.reason ?? suspension.reason
					const terminalStatus =
						stepResult.status === "failed" || stepResult.status === "aborted"
							? stepResult.status
							: "incomplete"
					if (suspension.kind === "blocked" && persisted && stepResult.status === "completed") {
						// Finalize the streamed report as ordinary text; resume keeps the task and its debt open.
						await this.say("text", terminalReason, undefined, false)
					} else {
						await this.say(
							"error",
							persisted
								? terminalReason
								: `${terminalReason}\n\nThe completion error could not be persisted; the task was paused without another model request.`,
						)
					}
					if (!ownsCompletedStep()) return ownershipLostResult
					recoveryExplanationPublished = true
					return { status: terminalStatus, reason: terminalReason, error: stepResult.error }
				}
				const goalStep = completedStep?.goalAccounting
				const stepGoal = await goalStep?.controller.get()
				if (!ownsCompletedStep()) return ownershipLostResult
				if (stepGoal && stepGoal.goalId === goalStep?.goalId && stepGoal.status !== "active") {
					if (stepGoal.status === "budget_limited" || stepGoal.status === "usage_limited") {
						const persisted = await this.flushPendingToolResultsToHistory()
						if (!ownsCompletedStep()) return ownershipLostResult
						if (!persisted)
							return { status: "failed", reason: "Goal tool results could not be durably saved." }
						return { status: "exhausted", reason: "The goal reached its configured work limit." }
					}
					if (stepGoal.status === "paused" || stepGoal.status === "blocked") {
						const persisted = await this.flushPendingToolResultsToHistory()
						if (!ownsCompletedStep()) return ownershipLostResult
						if (!persisted)
							return { status: "failed", reason: "Goal tool results could not be durably saved." }
						return { status: "incomplete", reason: "The goal is paused or blocked." }
					}
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
				return undefined
			},
			selectContinuation: async (sample) => {
				const step = sample.step
				const stepResult = step?.result ?? { status: "completed" as const }
				if (step?.legacyDidEndLoop || stepResult.status !== "completed" || this.abort || this.didComplete) {
					return {
						nextInput: "complete",
						status: stepResult.status,
						reason: stepResult.reason,
						error: stepResult.error,
					}
				}
				if (this.goalTurnCompletionText !== undefined && !this.hasGoalPendingInput()) {
					if (!(await this.flushPendingToolResultsToHistory())) {
						return {
							nextInput: "complete",
							status: "failed",
							reason: "Goal turn receipts could not be saved.",
						}
					}
					return { nextInput: "complete", status: "completed" }
				}

				// A thinking-only response resumes from its committed provider state, without a no-tool correction.
				const responseRequiresContinuation =
					sample.response.outcome?.requiresContinuation === true ||
					(sample.response.toolCalls.length === 0 &&
						!sample.response.text.trim() &&
						sample.response.items.some((item) => item.type === "reasoning"))
				this.deferAgentResultNotifications = this.shouldDeferAgentResultNotifications(sample.response)
				const hasPendingResultNotifications =
					!this.deferAgentResultNotifications &&
					this.providerRef.deref()?.hasPendingAgentResultNotifications?.(this) === true
				let requiresContinuation =
					responseRequiresContinuation ||
					this.userMessageContent.length > 0 ||
					this.hasPendingAgentMessages() ||
					hasPendingResultNotifications ||
					this.pendingSteerMessage !== undefined
				let nextUserContent: Anthropic.Messages.ContentBlockParam[]

				if (this.userMessageContent.length > 0) {
					nextUserContent = [...this.userMessageContent]
				} else if (this.pendingSteerMessage !== undefined) {
					// runAgentRequests consumes durable steering before the next API request.
					nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
				} else if (this.hasPendingAgentMessages() || hasPendingResultNotifications) {
					nextUserContent = []
				} else {
					const isVisibleResponse =
						sample.response.toolCalls.length === 0 && sample.response.text.trim().length > 0
					const queuedMessage =
						isVisibleResponse && !this.messageQueueService.isEmpty()
							? this.dequeueQueuedMessage()
							: undefined

					if (queuedMessage) {
						requiresContinuation = true
						pendingOpeningMessageTs = await this.sayOpeningInput(
							"user_feedback",
							queuedMessage.text,
							queuedMessage.images,
							[queuedMessage.id],
						)
						nextUserContent = this.buildUserMessageContent(queuedMessage.text, queuedMessage.images, [
							queuedMessage.id,
						])
					} else if (responseRequiresContinuation) {
						// Continue from the completed provider response without adding a
						// synthetic no-tool error as new user content.
						nextUserContent = []
					} else {
						nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
					}
				}

				return {
					nextInput: {
						userContent: nextUserContent,
						inputOrigin: this.getQueuedInputReceipts(nextUserContent).length ? "human" : "agent",
						includeFileDetails: false,
					},
					...(requiresContinuation ? { requiresContinuation: true } : {}),
				}
			},
			selectRecovery: async (sample) => {
				const recovery = sample.step?.result.recovery
				if (
					!recovery ||
					recovery.step !== this.currentAgentStep ||
					!this.isCurrentApiConversationHistoryOwner()
				) {
					return undefined
				}
				const goalStep = sample.step?.goalAccounting
				const goalStillAdmitsRecovery = async () => {
					if (!goalStep) return true
					const goal = await goalStep.controller.get()
					return (
						goal?.goalId === goalStep.goalId &&
						goal.status === "active" &&
						!goal.recoveryDeferred &&
						goalStep.controller.isRequestCurrent(goalStep.goalId, goalStep.requestGeneration)
					)
				}
				if (!(await goalStillAdmitsRecovery())) return undefined
				const interruption = new AbortController()
				const previousInterruption = this.stepInterruptionController
				this.stepInterruptionController = interruption
				try {
					await this.waitForRetryDecision(
						recovery.decision,
						recovery.error,
						interruption.signal,
						recovery.retryDeadline,
					)
				} catch (error) {
					if (error instanceof ApiStreamDeadlineError) {
						return { nextInput: "complete", status: "exhausted", reason: error.message }
					}
					if (!this.pendingSteerMessage) throw error
				} finally {
					if (this.stepInterruptionController === interruption)
						this.stepInterruptionController = previousInterruption
				}
				if (
					this.abort ||
					this.getTaskLifetimeCancellationSignal().aborted ||
					!this.isCurrentApiConversationHistoryOwner()
				) {
					return { nextInput: "complete", status: "aborted" }
				}
				if (!(await goalStillAdmitsRecovery())) return undefined
				if (
					this.abort ||
					this.getTaskLifetimeCancellationSignal().aborted ||
					!this.isCurrentApiConversationHistoryOwner()
				) {
					return { nextInput: "complete", status: "aborted" }
				}
				return {
					nextInput: { userContent: [], inputOrigin: "agent", includeFileDetails: false, recovery },
					requiresContinuation: true,
				}
			},
			admitCompletion: async (outcome) => {
				if (outcome.completionReason !== "assistant" && this.goalTurnCompletionText === undefined)
					return undefined
				if (this.abort || this.didComplete) return undefined
				const goal = await this.getGoal()
				if (!this.isCurrentApiConversationHistoryOwner()) return { nextInput: "complete", status: "aborted" }
				if (
					goal &&
					(goalWasActiveThisTurn || this.goalTurnCompletionText !== undefined) &&
					goal.status !== "complete"
				) {
					return undefined
				}
				this.recordCompletionCandidate()
				const decision = await this.waitForCompletionGateDecision()
				if (!this.isCurrentApiConversationHistoryOwner()) return { nextInput: "complete", status: "aborted" }
				if (!decision.allowed) {
					const input = await continueAfterCompletionRejection(decision)
					return input
						? { nextInput: input, requiresContinuation: true }
						: {
								nextInput: "complete",
								status: this.abort ? "aborted" : "incomplete",
								reason: decision.message,
							}
				}
				const hooks = await this.evaluateCompletionHooks(this.goalTurnCompletionText ?? outcome.response.text)
				if (
					this.abort ||
					this.getTaskLifetimeCancellationSignal().aborted ||
					!this.isCurrentApiConversationHistoryOwner()
				) {
					return { nextInput: "complete", status: "aborted" }
				}
				if (!hooks.prompt) return undefined
				return {
					nextInput: {
						userContent: [{ type: "text", text: hooks.prompt }],
						inputOrigin: "agent",
						includeFileDetails: false,
						hookPrompt: hooks.hookPrompt,
					},
					requiresContinuation: true,
				}
			},
			releaseStep: async (sample) => {
				sample.step?.result.transaction?.release()
				try {
					await this.settleGoalStep(sample.step?.goalAccounting)
				} finally {
					if (this.activeGoalStep === sample.step?.goalAccounting) this.activeGoalStep = undefined
					if (activeStep === sample.step) activeStep = undefined
				}
			},
		}

		const engine = new AgentTurnEngine(host)
		const runAgentTurn = async (input: TaskTurnInput) => {
			const openingMessageTs = pendingOpeningMessageTs
			pendingOpeningMessageTs = undefined
			finalAssistantMessageTs = undefined
			if (this.contextCondenseAbortController) {
				throw new Error("Context compaction is in progress")
			}
			const wasAgentTurnEngineActive = this.isAgentTurnEngineActive
			this.isAgentTurnEngineActive = true
			this.goalTurnCompletionText = undefined
			this.completionHookActive = false
			this.pendingCompletionHookPrompt = undefined
			this.goalRequestAdmissionRevoked = false
			acceptedToolCallCount = 0
			acceptedToolCallIds = new Set()
			ownsSampledStep = undefined
			sampledLifecycleStep = undefined
			retainedLifecycleStep = undefined
			try {
				const initialGoal = await this.getGoal()
				goalWasActiveThisTurn = Boolean(
					initialGoal?.status === "active" &&
						!initialGoal.recoveryDeferred &&
						(await this.getTaskMode()) === "code",
				)
				goalOwnerAtTurn =
					goalWasActiveThisTurn && initialGoal
						? { goalId: initialGoal.goalId, controlVersion: initialGoal.controlVersion }
						: undefined
				const resumedTurn = await this.beginCanonicalLifecycleTurn()
				this.openingTurnInputPending = resumedTurn !== true
				if (openingMessageTs !== undefined) {
					await this.annotateMessageTurn(openingMessageTs, { inputKind: resumedTurn ? "steer" : "start" })
					this.openingTurnInputPending = false
				}
				const runId = this.agentRunId
				const turnId = this.agentTurnId
				ownsTurnBoundary = () =>
					this.isCurrentApiConversationHistoryOwner() &&
					this.agentRunId === runId &&
					this.agentTurnId === turnId
				const lifecycle = this.getCanonicalLifecycleSnapshot()
				if (lifecycle && lifecycle.runId === this.agentRunId && lifecycle.turnId === this.agentTurnId) {
					acceptedToolCallIds = new Set(lifecycle.acceptedToolCallIds)
					acceptedToolCallCount = acceptedToolCallIds.size
				}
				this.lifecycleHookStoppedThisTurn = false
				let outcome = await engine.run(input)
				if (!ownsTurnAndSample()) return outcome
				if (shouldCompactAfterTurn(outcome, this.lifecycleHookStoppedThisTurn) && !this.abort) {
					try {
						await this.maybeCompactAfterTurn()
						if (!ownsTurnAndSample()) return outcome
					} catch (error) {
						if (!ownsTurnAndSample()) return outcome
						if (!(error instanceof LifecycleHookStoppedError)) throw error
						outcome = {
							status: "awaiting-user",
							steps: outcome.steps,
							response: outcome.response,
							reason: error.message,
						}
					}
				}
				if (outcome.status === "completed" || outcome.status === "aborted") {
					await this.appendAgentTurnEvent({
						type: "turn_completed",
						status: outcome.status,
						toolCallCount: acceptedToolCallCount,
						retryCount: 0,
					})
				} else if (outcome.status === "failed" || outcome.status === "exhausted") {
					await this.appendAgentTurnEvent({
						type: "turn_failed",
						reason: outcome.reason,
						error: "error" in outcome && outcome.error instanceof Error ? outcome.error.message : undefined,
					})
				} else {
					await this.appendAgentTurnEvent({ type: "turn_incomplete", reason: outcome.reason })
				}
				if (!ownsTurnAndSample()) return outcome
				await this.finishCanonicalLifecycleTurn(
					outcome,
					ownsTurnAndSample,
					retainedLifecycleStep,
					finalAssistantMessageTs,
				)
				if (!ownsTurnAndSample()) return outcome
				await this.flushAgentTurnEvents()
				if (!ownsTurnAndSample()) return outcome
				if (
					goalWasActiveThisTurn &&
					goalOwnerAtTurn &&
					!this.goalRequestAdmissionRevoked &&
					(outcome.status === "failed" ||
						outcome.status === "incomplete" ||
						outcome.status === "exhausted" ||
						outcome.status === "awaiting-user")
				) {
					const usageLimited = outcome.response?.items.some(
						(item) =>
							item.type === "error" &&
							(item.code === "usage_limit_exceeded" || item.code === "insufficient_quota"),
					)
					await this.goalController?.systemStop(
						usageLimited ? "usage_limited" : "blocked",
						goalOwnerAtTurn,
						ownsTurnAndSample,
					)
				}
				return outcome
			} finally {
				try {
					if (ownsTurnAndSample()) await this.settleGoalStep(this.activeGoalStep)
				} finally {
					if (ownsTurnAndSample()) {
						this.activeGoalStep = undefined
						this.isAgentTurnEngineActive = wasAgentTurnEngineActive
					} else (retainedLifecycleStep as CurrentAgentStep | undefined)?.releaseRequest?.()
				}
			}
		}

		const appendTaskTerminalEvent = async (
			status: AgentTurnOutcome["status"],
			reason?: string,
			error?: unknown,
			toolCallCount = acceptedToolCallCount,
		): Promise<void> => {
			if (!ownsTurnAndSample()) return
			if (status === "completed" || status === "aborted") {
				await this.appendAgentTurnEvent({
					type: "task_completed",
					status,
					toolCallCount,
					retryCount: 0,
				})
			} else if (status === "failed" || status === "exhausted") {
				await this.appendAgentTurnEvent({
					type: "task_failed",
					reason,
					error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
				})
			} else {
				await this.appendAgentTurnEvent({ type: "task_incomplete", reason })
			}
			await this.flushAgentTurnEvents()
		}

		let nextTurnInput: TaskTurnInput = {
			goalAdmission: options.goalAdmission,
			userContent,
			inputOrigin: options.inputOrigin,
			includeFileDetails: options.includeInitialFileDetails ?? true,
			onUserContentPersisted: handleInitialUserContentPersisted,
		}
		const continueAfterCompletionRejection = async (
			decision: CompletionGateDecision,
		): Promise<TaskTurnInput | undefined> => {
			if (decision.reasonCode === "interrupted") {
				if (this.hasPendingAgentMessages()) return { userContent: [], includeFileDetails: false }
				if (this.hasPendingSteerMessage()) return { userContent: [], includeFileDetails: false }
				const queued = this.dequeueQueuedMessage()
				if (queued) {
					this.resetCompletionRecoveryState()
					await this.retractCompletionResult()
					pendingOpeningMessageTs = await this.sayOpeningInput("user_feedback", queued.text, queued.images, [
						queued.id,
					])
					return {
						userContent: this.buildUserMessageContent(queued.text, queued.images, [queued.id]),
						includeFileDetails: false,
					}
				}
				if (this.abort) return undefined
			}
			decision = this.recordCompletionRejection(decision)
			const message =
				decision.message ??
				"Cannot complete while managed-agent results or parent verification obligations remain unresolved."
			if (!decision.modelCanResolveRejection) {
				await this.say("error", message)
				return undefined
			}
			// As with attempt_completion, feed repairable rejection back to the model.
			// A visible error belongs to a stopped task, not an ongoing repair turn.
			this.consecutiveMistakeCount++
			return {
				userContent: [{ type: "text", text: formatResponse.toolError(message) }],
				inputOrigin: "agent",
				includeFileDetails: false,
			}
		}
		const waitForPrimaryTurnRecovery = async (failure?: {
			status: "failed" | "incomplete" | "exhausted"
			error?: unknown
		}): Promise<PrimaryTurnRecovery | undefined> => {
			if (this.taskKind !== "primary" || this.abort || this.didComplete) return undefined

			if (failure && !recoveryExplanationPublished) {
				const hasVisibleError = this.alphaMessages.slice(this.recoveryAttemptMessageStart).some((message) => {
					if (message.type !== "say") return false
					if (message.say === "error") return Boolean(message.text?.trim())
					if (message.say !== "api_req_started") return false
					try {
						const info: AlphaApiReqInfo = JSON.parse(message.text || "{}")
						return Boolean(info.streamingFailedMessage?.trim())
					} catch {
						return false
					}
				})
				if (!hasVisibleError) {
					// Outcome reasons may contain provider payloads, prompts, or credentials.
					// Use typed local causes and localized status fallbacks, never raw diagnostics.
					// A say row survives reload; resume asks are hidden and removed from history.
					const message =
						failure.error instanceof AgentControlTransactionError &&
						(failure.error.code === "ELOCKOWNER" || failure.error.code === "ELOCKLEGACY")
							? t("common:errors.task_recovery_lock_repair")
							: failure.error instanceof AgentControlTransactionError &&
								  (failure.error.code === "ELOCKED" || failure.error.code === "EQUEUEFULL")
								? t("common:errors.task_recovery_storage_busy")
								: failure.error instanceof TaskPersistenceError
									? t("common:errors.task_recovery_persistence")
									: failure.status === "exhausted"
										? t("common:errors.task_recovery_exhausted")
										: failure.status === "incomplete"
											? t("common:errors.task_recovery_incomplete")
											: t("common:errors.task_recovery_failed")
					await this.say("error", message)
				}
			}

			let recovery: Awaited<ReturnType<Task["ask"]>>
			try {
				recovery = await this.ask("resume_task")
			} catch (error) {
				if (this.abort || this.didComplete) return undefined
				if (error instanceof AskIgnoredError) {
					// A newer ask owns the task when one is active. The stale loop must
					// stop without publishing a competing terminal event; otherwise an
					// unrelated follow-up can be turned into a failed task.
					if (this.activeAsk) return { kind: "superseded" }

					// If no newer ask is active, the superseded recovery boundary has no
					// consumer left. Close the task rather than leaving an orphaned live
					// session that can never resume.
					this.abortReason = "user_cancelled"
					await this.abortTask()
					return undefined
				}
				throw error
			}
			if (this.abort || this.didComplete) return undefined

			if (recovery.response !== "messageResponse" && recovery.response !== "yesButtonClicked") {
				// A resume boundary is accepted only by an explicit message or Resume
				// response. Denial/structured responses must close the abandoned task;
				// treating them as an empty Resume would silently issue another model
				// request.
				this.abortReason = "user_cancelled"
				await this.abortTask()
				return undefined
			}

			const feedbackText = recovery.text ?? ""
			const goalAdmission = this.consumeGoalAskAdmission(recovery.text)
			// This resumes inside the same loop, bypassing its initial reset. A user
			// retry needs a fresh progress window before the next tool is observed.
			this.toolRepetitionDetector?.resetProgress()
			this.searchLoopRecoveryPolicy?.reset()
			this.resetCompletionRecoveryState()
			const feedbackImages = recovery.images ?? []
			if (feedbackText.trim() || feedbackImages.length > 0) {
				pendingOpeningMessageTs = await this.sayOpeningInput(
					"user_feedback",
					feedbackText,
					feedbackImages,
					recovery.queuedMessageIds,
				)
				return {
					goalAdmission,
					inputOrigin: goalAdmission ? "agent" : "human",
					userContent: this.buildUserMessageContent(feedbackText, feedbackImages, recovery.queuedMessageIds),
					includeFileDetails: false,
				}
			}

			return {
				userContent: [{ type: "text", text: "[TASK RESUMPTION] Resuming task..." }],
				includeFileDetails: false,
			}
		}
		const isSupersededRecovery = (recovery: PrimaryTurnRecovery | undefined): recovery is { kind: "superseded" } =>
			Boolean(recovery && "kind" in recovery)

		while (!this.abort && !this.didComplete) {
			try {
				const outcome = await runAgentTurn(nextTurnInput)
				if (!ownsTurnAndSample()) return
				const goalCompletionText = this.goalTurnCompletionText
				if (
					outcome.status === "incomplete" &&
					this.goalRequestAdmissionRevoked &&
					!this.abort &&
					!this.didComplete &&
					(this.pendingSteerMessage || this.messageQueueService.messages.length > 0)
				) {
					const queued = this.pendingSteerMessage ? undefined : this.dequeueQueuedMessage()
					if (queued)
						pendingOpeningMessageTs = await this.sayOpeningInput(
							"user_feedback",
							queued.text,
							queued.images,
							[queued.id],
						)
					nextTurnInput = {
						userContent: queued
							? this.buildUserMessageContent(queued.text, queued.images, [queued.id])
							: [],
						inputOrigin: "human",
						includeFileDetails: false,
					}
					continue
				}
				const completedBoundary =
					outcome.status === "completed" &&
					(outcome.completionReason === "assistant" || goalCompletionText !== undefined)
				if (
					completedBoundary &&
					!this.abort &&
					!this.didComplete &&
					(this.pendingSteerMessage || this.messageQueueService.messages.length > 0)
				) {
					const queued = this.pendingSteerMessage ? undefined : this.dequeueQueuedMessage()
					if (queued) {
						pendingOpeningMessageTs = await this.sayOpeningInput(
							"user_feedback",
							queued.text,
							queued.images,
							[queued.id],
						)
					}
					nextTurnInput = {
						userContent: queued
							? this.buildUserMessageContent(queued.text, queued.images, [queued.id])
							: [],
						includeFileDetails: false,
					}
					continue
				}

				if (completedBoundary && !this.abort && !this.didComplete) {
					const goalContinuation = await engine.continueIfIdle(outcome)
					if (
						this.abort ||
						this.abandoned ||
						this.didComplete ||
						this.getTaskLifetimeCancellationSignal().aborted ||
						!this.isCurrentApiConversationHistoryOwner()
					) {
						await appendTaskTerminalEvent(
							this.abort ? "aborted" : this.didComplete ? "completed" : "aborted",
						)
						return
					}
					if (goalContinuation) {
						nextTurnInput = goalContinuation
						continue
					}
					// Admission can await storage. A user input arriving in that window
					// must enter the next sample before any retained automatic input.
					if (this.pendingSteerMessage || this.messageQueueService.messages.length > 0) {
						const queued = this.pendingSteerMessage ? undefined : this.dequeueQueuedMessage()
						if (queued) {
							pendingOpeningMessageTs = await this.sayOpeningInput(
								"user_feedback",
								queued.text,
								queued.images,
								[queued.id],
							)
						}
						nextTurnInput = {
							userContent: queued
								? this.buildUserMessageContent(queued.text, queued.images, [queued.id])
								: [],
							inputOrigin: "human",
							includeFileDetails: false,
						}
						continue
					}
					const goal = await this.getGoal()
					if (
						goal &&
						(goalWasActiveThisTurn || goalCompletionText !== undefined) &&
						(goal.status === "budget_limited" ||
							goal.status === "usage_limited" ||
							goal.status === "paused" ||
							goal.status === "blocked")
					) {
						const limited = goal.status === "budget_limited" || goal.status === "usage_limited"
						const recovery = await waitForPrimaryTurnRecovery({
							status: limited ? "exhausted" : "incomplete",
						})
						if (recovery) {
							if (isSupersededRecovery(recovery)) return
							nextTurnInput = recovery
							continue
						}
						await appendTaskTerminalEvent(this.abort ? "aborted" : limited ? "exhausted" : "incomplete")
						return
					}
				}

				if (outcome.status !== "completed" || !completedBoundary || this.abort || this.didComplete) {
					const terminalStatus = this.abort ? "aborted" : outcome.status
					const terminalReason = "reason" in outcome ? outcome.reason : undefined
					const terminalError = "error" in outcome ? outcome.error : undefined
					if (
						this.taskKind === "primary" &&
						!this.abort &&
						!this.didComplete &&
						(terminalStatus === "failed" ||
							terminalStatus === "exhausted" ||
							terminalStatus === "incomplete")
					) {
						const continuation = await waitForPrimaryTurnRecovery({
							status: terminalStatus,
							error: terminalError,
						})
						if (continuation) {
							if (isSupersededRecovery(continuation)) return
							nextTurnInput = continuation
							continue
						}
					}
					await appendTaskTerminalEvent(
						this.abort ? "aborted" : this.didComplete ? "completed" : terminalStatus,
						terminalReason,
						terminalError,
						acceptedToolCallCount,
					)
					return
				}
				const completionText = goalCompletionText ?? outcome.response.text

				// Both task kinds publish through the same verified completion transition.
				// The visible answer does not require a user acknowledgement to finalize.
				await this.presentCompletionResult(completionText)
				if (this.abort || this.didComplete) {
					await appendTaskTerminalEvent(
						this.abort ? "aborted" : "completed",
						undefined,
						undefined,
						acceptedToolCallCount,
					)
					return
				}

				const queuedFollowup = this.dequeueQueuedMessage()
				const feedbackText = queuedFollowup?.text ?? ""
				const feedbackImages = queuedFollowup?.images ?? []

				const shouldFinish = !queuedFollowup || (!feedbackText.trim() && feedbackImages.length === 0)
				if (shouldFinish) {
					// Presentation can yield while descendants or obligations change.
					// Recheck immediately before the terminal write.
					const finalCompletionDecision = await this.waitForCompletionGateDecision()
					if (!finalCompletionDecision.allowed) {
						await this.retractCompletionResult()
						const continuation = await continueAfterCompletionRejection(finalCompletionDecision)
						if (!continuation) {
							const recovery = await waitForPrimaryTurnRecovery()
							if (recovery) {
								if (isSupersededRecovery(recovery)) return
								nextTurnInput = recovery
								continue
							}
							await appendTaskTerminalEvent(
								this.abort ? "aborted" : this.didComplete ? "completed" : "incomplete",
								finalCompletionDecision.message,
							)
							return
						}
						nextTurnInput = continuation
						continue
					}

					const lateQueuedFeedback = this.dequeueQueuedMessage()
					if (lateQueuedFeedback) {
						pendingOpeningMessageTs = await this.sayOpeningInput(
							"user_feedback",
							lateQueuedFeedback.text,
							lateQueuedFeedback.images,
							[lateQueuedFeedback.id],
						)
						nextTurnInput = {
							userContent: this.buildUserMessageContent(
								lateQueuedFeedback.text,
								lateQueuedFeedback.images,
								[lateQueuedFeedback.id],
							),
							includeFileDetails: false,
						}
						continue
					}

					try {
						if (await this.returnCompletionToLegacyParent(completionText)) {
							await appendTaskTerminalEvent("completed", undefined, undefined, acceptedToolCallCount)
							return
						}
					} catch (error) {
						await this.retractCompletionResult()
						const continuation = await continueAfterCompletionRejection({
							allowed: false,
							modelCanResolveRejection: false,
							message: `Cannot finish the delegated child right now: ${error instanceof Error ? error.message : String(error)}`,
						})
						if (!continuation) {
							const recovery = await waitForPrimaryTurnRecovery()
							if (recovery) {
								if (isSupersededRecovery(recovery)) return
								nextTurnInput = recovery
								continue
							}
							await appendTaskTerminalEvent(
								this.abort ? "aborted" : this.didComplete ? "completed" : "incomplete",
								error instanceof Error ? error.message : String(error),
								error,
							)
							return
						}
						nextTurnInput = continuation
						continue
					}

					if (this.taskKind === "subagent") this.subagentCompletionOutcome = "completed"
					const completionGoalSteeringGeneration = this.goalSteeringGeneration ?? 0
					const finalized = await this.finalizeTaskCompletion()
					if (!finalized) {
						if (this.abort || this.didComplete) {
							await appendTaskTerminalEvent(
								this.abort ? "aborted" : "completed",
								undefined,
								undefined,
								acceptedToolCallCount,
							)
							return
						}

						// A follow-up admitted during completion persistence still belongs to
						// the current task's existing input consumer.
						if (this.hasPendingAgentMessages() || this.hasPendingSteerMessage()) {
							nextTurnInput = { userContent: [], includeFileDetails: false }
							continue
						}

						const concurrentFeedback = this.dequeueQueuedMessage()
						if (concurrentFeedback) {
							pendingOpeningMessageTs = await this.sayOpeningInput(
								"user_feedback",
								concurrentFeedback.text,
								concurrentFeedback.images,
								[concurrentFeedback.id],
							)
							nextTurnInput = {
								userContent: this.buildUserMessageContent(
									concurrentFeedback.text,
									concurrentFeedback.images,
									[concurrentFeedback.id],
								),
								includeFileDetails: false,
							}
							continue
						}

						const goal = await this.getGoal()
						if (
							completionGoalSteeringGeneration !== (this.goalSteeringGeneration ?? 0) &&
							goal?.status === "active" &&
							!goal.recoveryDeferred &&
							(await this.getTaskMode()) === "code" &&
							this.isGoalIdleBoundary()
						) {
							// A new explicit host goal superseded terminal completion after
							// the prior idle check. Enter it through this same drained loop.
							nextTurnInput = {
								userContent: [{ type: "text", text: this.goalContinuationText(goal) }],
								inputOrigin: "agent",
								includeFileDetails: false,
								goalAdmission: this.goalInputAdmission(goal),
							}
							continue
						}

						const completionFailureReason =
							this.pendingTurnSuspension?.reason ?? "Task completion was not durably finalized."
						this.pendingTurnSuspension = undefined
						await this.say("error", completionFailureReason)
						const recovery = await waitForPrimaryTurnRecovery()
						if (recovery) {
							if (isSupersededRecovery(recovery)) return
							nextTurnInput = recovery
							continue
						}
						await appendTaskTerminalEvent(
							this.abort ? "aborted" : this.didComplete ? "completed" : "incomplete",
							completionFailureReason,
							undefined,
							acceptedToolCallCount,
						)
						return
					}
					await appendTaskTerminalEvent("completed", undefined, undefined, acceptedToolCallCount)
					return
				}

				// A follow-up starts a new conversational turn; retain the prior answer's durable trace boundary.
				pendingOpeningMessageTs = await this.sayOpeningInput(
					"user_feedback",
					feedbackText,
					feedbackImages,
					queuedFollowup ? [queuedFollowup.id] : undefined,
				)
				nextTurnInput = {
					userContent: this.buildUserMessageContent(
						feedbackText,
						feedbackImages,
						queuedFollowup ? [queuedFollowup.id] : undefined,
					),
					includeFileDetails: false,
				}
			} catch (error) {
				// A superseded frame cannot repair or fail the replacement. Unexpected
				// cleanup failures still reach its owner instead of being swallowed.
				if (!ownsTurnAndSample()) throw error
				if (this.abort || this.abandoned) return
				if (this.didComplete) {
					// Durable completion has already won. A failed projection must not
					// resurrect the task or emit another TaskCompleted event.
					console.error(`[Task#${this.taskId}] Completed task publication failed:`, error)
					return
				}
				try {
					await this.releaseUnpersistedQueuedInputs()
					await this.retractCompletionResult()
				} catch (recoveryError) {
					console.error(`[Task#${this.taskId}] Failed to persist task recovery state:`, recoveryError)
				}
				if (this.taskKind !== "primary") {
					await appendTaskTerminalEvent("failed", undefined, error)
					throw error
				}
				const recovery = await waitForPrimaryTurnRecovery({ status: "failed", error })
				if (recovery) {
					if (isSupersededRecovery(recovery)) return
					nextTurnInput = recovery
					continue
				}
				await appendTaskTerminalEvent(this.abort ? "aborted" : "failed", undefined, error)
				return
			}
		}

		if (this.didComplete) {
			await appendTaskTerminalEvent("completed")
		} else if (this.abort) {
			await appendTaskTerminalEvent("aborted")
		}
	}

	public async runAgentRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
		onInitialUserContentPersisted?: () => Promise<void> | void,
		options: {
			deferResponseTransaction?: boolean
			/** Process-local capture/reset notification; never provider metadata or persisted state. */
			onStepCaptured?: (step: CurrentAgentStep | undefined) => void
			hookPrompt?: CompletionHookPromptProvenance
			queuedMessageIds?: readonly string[]
			inputOrigin?: "human" | "agent"
			recovery?: TaskStreamRecovery
		} = {},
	): Promise<TaskStepExecutionResult | boolean> {
		await this.messageQueueService?.ready
		if (this.contextCondenseAbortController) {
			throw new Error("Context compaction is in progress")
		}
		interface StackItem {
			userContent: Anthropic.Messages.ContentBlockParam[]
			/** Inputs interrupted before commit retain their chronological origin and receipts. */
			precedingMessages?: Array<ApiMessage & { content: Anthropic.Messages.ContentBlockParam[] }>
			inputOrigin?: "human" | "agent"
			queuedMessageIds?: string[]
			includeFileDetails: boolean
			hookPrompt?: CompletionHookPromptProvenance
			retryAttempt?: number
			retryCategory?: AgentRetryCategory
			/** Absolute wall-clock limit shared by every automatically scheduled retry. */
			retryDeadline?: number
			/** Category-local counters keep transport/context/empty retries independent. */
			retryAttempts?: TaskRetryAttempts
			recoveryStep?: CurrentAgentStep
			userMessageWasRemoved?: boolean // Track if user message was removed due to empty response
			steeringPersistence?: Array<() => Promise<void> | void>
		}
		const mergeSteeringPersistence = (item: StackItem, onPersisted?: () => Promise<void> | void) => [
			...(item.steeringPersistence ?? []),
			...(onPersisted ? [onPersisted] : []),
		]

		const stack: StackItem[] = [
			{
				userContent,
				queuedMessageIds: [...(options.queuedMessageIds ?? this.getQueuedInputReceipts(userContent))],
				inputOrigin: options.inputOrigin,
				includeFileDetails,
				hookPrompt: options.hookPrompt ?? this.pendingCompletionHookPrompt,
				retryAttempt: options.recovery?.retryAttempt ?? 0,
				...(options.recovery
					? {
							retryCategory: "transport" as const,
							retryAttempts: options.recovery.retryAttempts,
							retryDeadline: options.recovery.retryDeadline,
							recoveryStep: options.recovery.step,
						}
					: {}),
				...(onInitialUserContentPersisted ? { steeringPersistence: [onInitialUserContentPersisted] } : {}),
			},
		]
		const wasTaskLoopActive = this.isTaskLoopActive
		this.isTaskLoopActive = true
		let retrySequenceStartedAt = options.recovery?.sequenceStartedAt
		const getRetryElapsedMs = () => {
			// Healthy generation does not consume an optional recovery allowance.
			retrySequenceStartedAt ??= performance.now()
			return performance.now() - retrySequenceStartedAt
		}
		const committedRecoveryResult = (
			response: AgentResponse,
			error: Error,
			item: StackItem,
		): TaskStepExecutionResult => {
			const status = response.outcome?.status === "incomplete" ? "incomplete" : "failed"
			const step = this.currentAgentStep
			if (!step) return { status, reason: error.message, error, response }
			const attempts = item.retryAttempts ?? {}
			const attempt = (attempts.transport ?? 0) + 1
			const retryAttempt = (item.retryAttempt ?? 0) + 1
			const elapsedMs = getRetryElapsedMs()
			const decision = this.agentRetryPolicy.decide({
				category: "transport",
				attempt,
				totalAttempt: retryAttempt,
				elapsedMs,
				retryAfterMs: this.retryAfterMs(error),
				hasSemanticOutput: true,
				recovery: "committed-history",
			})
			if (!decision.shouldRetry) {
				return {
					status: "exhausted",
					reason: `Provider retry budget exhausted (${decision.reason ?? "attempts"}).`,
					error,
					response,
				}
			}
			return {
				status,
				reason: error.message,
				error,
				response,
				recovery: {
					step,
					decision,
					error,
					retryAttempt,
					retryAttempts: { ...attempts, transport: attempt },
					retryDeadline: getAgentRetryDeadline(
						this.agentRetryPolicy.maxElapsedMs,
						elapsedMs,
						item.retryDeadline,
					),
					sequenceStartedAt: retrySequenceStartedAt ?? performance.now(),
				},
			}
		}
		let activeStepInterruptionController: AbortController | undefined
		let deferTaskStepCleanup = false
		let taskStepCleanupReleased = false
		let ownsCapturedTaskStep: CanonicalLifecycleEventGuard | undefined
		const releaseTaskStep = () => {
			if (taskStepCleanupReleased) return
			taskStepCleanupReleased = true
			if (
				activeStepInterruptionController &&
				this.stepInterruptionController === activeStepInterruptionController
			) {
				this.stepInterruptionController = undefined
			}
			if (!ownsCapturedTaskStep || ownsCapturedTaskStep()) this.isTaskLoopActive = wasTaskLoopActive
		}

		try {
			while (stack.length > 0) {
				if (this.didComplete) {
					return { status: "completed", response: this.currentAgentResponse }
				}
				const lifecycleInputInvocation = this.captureLifecycleHookInvocation()
				ownsCapturedTaskStep = lifecycleInputInvocation.guard
				await this.runPendingInterruptLifecycleHook(lifecycleInputInvocation)
				this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)

				const currentItem = stack.pop()!
				// A recovered attempt must not hide a later failure, including one
				// before the next provider request has started.
				this.recoveryAttemptMessageStart = this.alphaMessages.length
				const precedingMessages = currentItem.precedingMessages ?? []
				// Capture each source before merging host deliveries or promoting the envelope's display origin.
				this.captureInputBlockOrigins(currentItem.userContent, currentItem.inputOrigin ?? "human")
				for (const message of precedingMessages) {
					this.captureInputBlockOrigins(message.content, message.input_origin ?? "agent")
				}
				const firstPrecedingMessage = precedingMessages[0]
				if (firstPrecedingMessage) {
					// Pending results belong before the fresh steer. Reconcile them once
					// with their original input, rather than duplicating them in both envelopes.
					firstPrecedingMessage.content = this.includeQueuedToolReplyContent(
						this.mergePendingToolResultsIntoUserContent(firstPrecedingMessage.content),
					)
					firstPrecedingMessage.queued_message_ids = [
						...new Set([
							...(firstPrecedingMessage.queued_message_ids ?? []),
							...this.getQueuedInputReceipts(firstPrecedingMessage.content),
						]),
					]
				}
				const currentUserContent = firstPrecedingMessage
					? currentItem.userContent
					: this.includeQueuedToolReplyContent(
							this.mergePendingToolResultsIntoUserContent(currentItem.userContent),
						)
				this.captureInputBlockOrigins(currentUserContent, "agent")
				if (firstPrecedingMessage) this.captureInputBlockOrigins(firstPrecedingMessage.content, "agent")
				currentItem.queuedMessageIds = [
					...new Set([
						...(currentItem.queuedMessageIds ?? []),
						...this.getQueuedInputReceipts(currentUserContent),
					]),
				]
				const currentIncludeFileDetails = currentItem.includeFileDetails

				if (this.abort) {
					throw new Error(`[Task#runAgentRequests] task ${this.taskId}.${this.instanceId} aborted`)
				}

				const pendingSteer = this.pendingSteerMessage
				if (pendingSteer) {
					this.pendingSteerMessage = undefined
					await this.presentSteeringInput(pendingSteer)
					// The failed turn may have re-armed the limit after steering was
					// accepted. Reset again at durable consumption time so this exact
					// guidance reaches the next model request.
					this.resetMistakeRecoveryState()
					const hasUncommittedInput =
						(currentItem.retryAttempt ?? 0) === 0 || currentItem.userMessageWasRemoved
					stack.push({
						precedingMessages: [
							...precedingMessages,
							...(hasUncommittedInput && currentUserContent.length
								? [
										{
											role: "user" as const,
											content: currentUserContent,
											input_origin: currentItem.inputOrigin,
											queued_message_ids: currentItem.queuedMessageIds,
											...(currentItem.hookPrompt ? { hook_prompt: currentItem.hookPrompt } : {}),
										},
									]
								: []),
						],
						queuedMessageIds: pendingSteer.queuedMessageIds,
						userContent: this.buildUserMessageContent(
							pendingSteer.text,
							pendingSteer.images,
							pendingSteer.queuedMessageIds,
						),
						includeFileDetails: currentIncludeFileDetails,
						// A fresh instruction must cross its own save fence even when it
						// arrives while publishing a retry of an already committed input.
						retryAttempt: 0,
						inputOrigin: pendingSteer.inputOrigin,
						steeringPersistence: mergeSteeringPersistence(currentItem, pendingSteer.onPersisted),
					})
					continue
				}

				if (
					activeStepInterruptionController &&
					this.stepInterruptionController === activeStepInterruptionController
				) {
					this.stepInterruptionController = undefined
				}
				activeStepInterruptionController = new AbortController()
				this.stepInterruptionController = activeStepInterruptionController
				const stepInterruptionSignal = activeStepInterruptionController.signal

				if (this.consecutiveMistakeLimit > 0 && this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
					await this.handleConsecutiveMistakeLimit(currentUserContent)
				}
				currentItem.queuedMessageIds = [
					...new Set([
						...(currentItem.queuedMessageIds ?? []),
						...this.getQueuedInputReceipts(currentUserContent),
					]),
				]
				if (currentItem.queuedMessageIds.length) currentItem.inputOrigin = "human"
				this.captureInputBlockOrigins(currentUserContent, "agent")
				const inputHookOutcome = await this.inspectLifecycleHookInput(
					[...precedingMessages.flatMap((message) => message.content), ...currentUserContent],
					stepInterruptionSignal,
					lifecycleInputInvocation,
				)
				this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
				this.throwIfStepInterrupted(stepInterruptionSignal)
				if (inputHookOutcome.shouldStop) {
					await this.persistLifecycleHookContexts(lifecycleInputInvocation.guard, stepInterruptionSignal)
					const provenance = inputHookOutcome.stopProvenance
					if (!provenance)
						throw new TaskPersistenceError("A stopped lifecycle input has no command-run provenance.")
					const rejectionReceipt: Anthropic.Messages.ContentBlockParam[] = [
						{
							type: "text",
							text: provenance.fragments.map(({ text }) => text).join("\n\n"),
						},
					]
					this.captureInputBlockOrigins(rejectionReceipt, "agent")
					const rejectedQueueIds = [
						...new Set([
							...precedingMessages.flatMap((message) => message.queued_message_ids ?? []),
							...currentItem.queuedMessageIds,
						]),
					]
					// Acknowledge the rejected delivery through an explicit durable agent receipt;
					// the blocked user prompt must not be replayed as accepted model input.
					try {
						await this.persistUserContentWithEnvironment(
							rejectionReceipt,
							undefined,
							stepInterruptionSignal,
							async () => {
								const failures: unknown[] = []
								for (const onPersisted of currentItem.steeringPersistence?.splice(0) ?? []) {
									this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
									try {
										await onPersisted()
										this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
									} catch (error) {
										failures.push(error)
									}
								}
								this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
								this.steerMessageAwaitingPersistence = false
								if (failures.length)
									throw new AggregateError(failures, "Failed to acknowledge rejected lifecycle input")
							},
							provenance,
							rejectedQueueIds,
							"agent",
							[],
							lifecycleInputInvocation.guard,
						)
					} finally {
						this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
					}
					if (inputHookOutcome.stopReason)
						await this.publishLifecycleHookMessage(
							inputHookOutcome.stopReason,
							lifecycleInputInvocation,
							stepInterruptionSignal,
						)
					this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
					return {
						status: "awaiting-user",
						reason:
							inputHookOutcome.stopReason ??
							t("common:lifecycleHooks.stopped", { event: provenance.event }),
					}
				}

				// Determine API protocol based on provider and model
				const modelId = getModelId(this.apiConfiguration)
				const apiProvider = this.apiConfiguration.apiProvider
				const retainedProtocol = (
					currentItem.recoveryStep ??
					(currentItem.retryCategory === "transport" || currentItem.retryCategory === "rate-limit"
						? this.currentAgentStep
						: undefined)
				)?.snapshot.context.provider.apiProtocol
				const apiProtocol =
					retainedProtocol === "anthropic" || retainedProtocol === "openai"
						? retainedProtocol
						: getApiProtocol(isProviderName(apiProvider) ? apiProvider : undefined, modelId)

				const provider = this.providerRef.deref()
				let state = provider ? await provider.getState() : undefined

				const showAlphaIgnoredFiles = state?.showAlphaIgnoredFiles ?? false
				const includeDiagnosticMessages = state?.includeDiagnosticMessages ?? true
				const maxDiagnosticMessages = state?.maxDiagnosticMessages ?? 50
				const currentMode = await this.getTaskMode()

				const messagesToPrepare = [
					...precedingMessages,
					{ role: "user" as const, content: currentUserContent, input_origin: currentItem.inputOrigin },
				]
				// Parsing replaces block identities; later deliveries must not enter this save's acknowledgment.
				const inputBlocksToAcknowledge = messagesToPrepare.flatMap((message) => message.content)
				const preparedMessages: typeof messagesToPrepare = []
				const preparedMentionResults: ProcessUserContentMentionsResult[] = []
				let slashCommandMode: string | undefined
				const skillsManager = await provider?.getSkillsManager(this)
				const invocationSkills =
					this.taskKind === "subagent"
						? getSkillLookupForCapturedCatalog(skillsManager, this.subagentContextManifest?.skills ?? [])
						: skillsManager
				for (const message of messagesToPrepare) {
					const prepared = await processUserContentMentions({
						userContent: message.content,
						deferAttachmentBudget: true,
						cwd: this.cwd,
						fileContextTracker: this.fileContextTracker,
						alphaIgnoreController: this.alphaIgnoreController,
						showAlphaIgnoredFiles,
						includeDiagnosticMessages,
						maxDiagnosticMessages,
						skillsManager: invocationSkills,
						inputOrigin: message.input_origin ?? currentItem.inputOrigin,
						inputBlockOrigins: new Map(
							message.content.map((block) => [block, this.inputBlockOrigins.get(block) ?? "agent"]),
						),
						humanFeedbackToolResultIds: getHumanFeedbackToolResultIds(
							this.apiConversationHistory,
							message.content,
						),
						currentMode,
						signal: this.getTaskCancellationSignal(),
						onTicketActivity: async (activity) => {
							await this.say("tool", JSON.stringify({ tool: "ticket", ticketActivity: activity }))
						},
					})
					preparedMentionResults.push(prepared)
					slashCommandMode ??= prepared.mode
					preparedMessages.push({ ...message, content: prepared.content })
				}
				this.getTaskCancellationSignal().throwIfAborted()
				const finalizedMentions = finalizeUserContentMentionAttachments(preparedMentionResults)
				for (const [index, prepared] of finalizedMentions.entries()) {
					preparedMessages[index]!.content = prepared.content
					for (const [block, origin] of prepared.blockOrigins ?? []) {
						if (!this.inputBlockOrigins.has(block) || origin === "agent") {
							this.inputBlockOrigins.set(block, origin)
						}
					}
				}
				// Host-expanded skills carry the same durable identity as skill-tool loads.
				const recordedSkillPaths = new Set<string>()
				for (const prepared of finalizedMentions) {
					for (const skill of prepared.loadedSkills ?? []) {
						this.getTaskCancellationSignal().throwIfAborted()
						if (recordedSkillPaths.has(skill.path)) continue
						recordedSkillPaths.add(skill.path)
						await this.recordLoadedSkill(skill.name, skill.path, skill.digest)
					}
				}
				this.getTaskCancellationSignal().throwIfAborted()
				const parsedUserContent = preparedMessages.pop()!.content

				// Switch mode if specified in a slash command's frontmatter
				if (slashCommandMode && provider) {
					const targetMode = getModeBySlug(slashCommandMode, state?.customModes)
					if (targetMode) {
						await provider.setTaskMode(this.taskId, slashCommandMode)
						state = await provider.getState()
					}
				}

				// Requeued committed content can contain acknowledged terminal/file events.
				// Keep those blocks intact; only a new logical step captures fresh events.

				const finalUserContent = [...parsedUserContent]
				// Only add user message to conversation history if:
				// 1. This is the first attempt (retryAttempt === 0), AND
				// 2. The original userContent was not empty (empty signals delegation resume where
				//    the user message with tool_result and env details is already in history), OR
				// 3. The message was removed in a previous iteration (userMessageWasRemoved === true)
				// A committed retry reuses its saved input; fresh steering starts at attempt zero.
				const isEmptyUserContent = currentUserContent.length === 0
				const shouldAddUserMessage =
					((currentItem.retryAttempt ?? 0) === 0 && !isEmptyUserContent) || currentItem.userMessageWasRemoved
				if (shouldAddUserMessage) {
					let historyPersisted = false
					try {
						const capture =
							(currentItem.retryAttempt ?? 0) === 0
								? await captureEnvironmentDetails(this, currentIncludeFileDetails, state, {
										context: this.environmentContext,
										signal: stepInterruptionSignal,
									})
								: undefined
						if (capture?.details) finalUserContent.push({ type: "text", text: capture.details })
						await this.persistUserContentWithEnvironment(
							finalUserContent,
							capture,
							stepInterruptionSignal,
							async () => {
								this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
								historyPersisted = true
								if (this.userMessageContent?.length) {
									this.acknowledgePersistedUserMessageContent([
										...inputBlocksToAcknowledge,
										...preparedMessages.flatMap((message) => message.content),
										...finalUserContent,
									])
								}
								this.pendingCompletionHookPrompt = undefined
								if (currentItem.steeringPersistence) {
									// One transcript commit acknowledges original admission and
									// fresh steering. Consume each callback once, even if another fails.
									const failures: unknown[] = []
									for (const onPersisted of currentItem.steeringPersistence.splice(0)) {
										this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
										try {
											await onPersisted()
											this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
										} catch (error) {
											this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
											failures.push(error)
										}
									}
									this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
									this.steerMessageAwaitingPersistence = false
									if (failures.length === 1) throw failures[0]
									if (failures.length > 1) {
										throw new AggregateError(failures, "Failed to acknowledge committed input")
									}
								}
							},
							currentItem.hookPrompt,
							currentItem.queuedMessageIds,
							currentItem.inputOrigin,
							preparedMessages,
							lifecycleInputInvocation.guard,
						)
						this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
					} catch (error) {
						this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
						if (
							!historyPersisted &&
							this.pendingSteerMessage &&
							error instanceof SteerRequestInterruptError
						) {
							// Steering may arrive while mentions/environment are being transformed,
							// before the stream's interruption handler owns this boundary.
							stack.push({ ...currentItem, userContent: currentUserContent, retryAttempt: 0 })
							continue
						}
						throw error
					}
					this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
					TelemetryService.instance.captureConversationMessage(this.taskId, "user")
				}
				if ((currentItem.retryAttempt ?? 0) === 0) await this.deliverAgentMessages()
				this.assertLifecycleHookOwnership(lifecycleInputInvocation.guard)
				await this.persistLifecycleHookContexts(lifecycleInputInvocation.guard, stepInterruptionSignal)

				// Persist locally produced tool and child results before entering the
				// interruptible provider throttle. The same profile lane still serializes
				// parent and child requests, but stopping during the wait can no longer
				// discard a result that already completed locally.
				if (this.abort) {
					throw new Error(`[Task#runAgentRequests] task ${this.taskId}.${this.instanceId} aborted`)
				}
				const pacingWaitCountBefore = this.requestPacingWaitCount
				try {
					// Settle admitted Worker effects at the shared model-step boundary.
					// Quarantined proposals remain available without pausing inference.
					await this.waitForPendingSubagentChangeSetReviews()
					this.throwIfStepInterrupted(stepInterruptionSignal)
					await this.maybeWaitForProviderRateLimit(
						currentItem.retryAttempt ?? 0,
						state,
						stepInterruptionSignal,
						currentItem.retryDeadline,
					)
					this.throwIfStepInterrupted(stepInterruptionSignal)
				} catch (error) {
					const pendingSteer = this.pendingSteerMessage
					if (!pendingSteer) throw error

					this.pendingSteerMessage = undefined
					await this.presentSteeringInput(pendingSteer)
					this.resetMistakeRecoveryState()
					stack.push({
						queuedMessageIds: pendingSteer.queuedMessageIds,
						userContent: this.buildUserMessageContent(
							pendingSteer.text,
							pendingSteer.images,
							pendingSteer.queuedMessageIds,
						),
						includeFileDetails: false,
						inputOrigin: pendingSteer.inputOrigin,
						steeringPersistence: mergeSteeringPersistence(currentItem, pendingSteer.onPersisted),
					})
					continue
				}
				if (this.requestPacingWaitCount > pacingWaitCountBefore) {
					if (!(await this.appendRequestPacingUpdateToLatestUserMessage())) {
						throw new TaskPersistenceError(
							"Unable to persist provider pacing metadata before continuing the request.",
						)
					}
				}
				if (this.abort) {
					throw new Error(`[Task#runAgentRequests] task ${this.taskId}.${this.instanceId} aborted`)
				}

				// A new provider boundary invalidates any best-effort usage drain left
				// behind by the preceding response before this request can own cancellation.
				this.invalidateBackgroundUsageDrain("A newer provider request started")
				await this.say(
					"api_req_started",
					JSON.stringify({
						apiProtocol,
					} satisfies AlphaApiReqInfo),
				)

				const lastApiReqIndex = findLastIndex(this.alphaMessages, (m) => m.say === "api_req_started")
				const taskWasCancelled = () =>
					this.abort || this.abandoned || this.getTaskLifetimeCancellationSignal().aborted
				let recoverCancelledResponse: (() => Promise<TaskStepExecutionResult>) | undefined
				let ownsResponseStep = this.captureAgentStepOwnership()
				let canonicalResponse: AgentResponse | undefined
				const supersededResponseResult = (): TaskStepExecutionResult => ({
					status: "aborted",
					reason: "The task no longer owns its provider response step.",
					response: canonicalResponse,
				})

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
						cancelReason?: AlphaApiReqCancelReason,
						streamingFailedMessage?: string,
						expectedMessage?: AlphaMessage,
					): boolean => {
						if (lastApiReqIndex < 0 || !this.alphaMessages[lastApiReqIndex]) {
							return false
						}
						if (expectedMessage && this.alphaMessages[lastApiReqIndex] !== expectedMessage) {
							return false
						}

						const existingData = JSON.parse(this.alphaMessages[lastApiReqIndex].text || "{}")

						// Use the protocol captured for this request. A profile switch after
						// streaming must not recost an older response under the new provider.
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

						this.alphaMessages[lastApiReqIndex].text = JSON.stringify({
							...existingData,
							tokensIn: costResult.totalInputTokens,
							tokensOut: costResult.totalOutputTokens,
							cacheWrites: cacheWriteTokens,
							cacheReads: cacheReadTokens,
							cost: totalCost ?? costResult.totalCost,
							cancelReason,
							agentStopMessageId: cancelReason === "user_cancelled" ? this.agentStopMessageId : undefined,
							streamingFailedMessage,
						} satisfies AlphaApiReqInfo)
						return true
					}

					const abortStream = async (
						cancelReason: AlphaApiReqCancelReason,
						streamingFailedMessage?: string,
						guard?: CanonicalLifecycleEventGuard,
					) => {
						if (guard && !guard()) return
						// Preview presenters share the streaming arrays with the provider
						// loop. Join them before abort cleanup mutates partial messages.
						if (guard) await this.drainStreamingPreviews("stream abort", guard)
						else await this.drainStreamingPreviews("stream abort")
						if (guard && !guard()) return
						this.invalidateStreamingPreviewEpoch()
						if (this.diffViewProvider.isEditing) {
							await this.diffViewProvider.revertChanges() // closes diff view
							if (guard && !guard()) return
						}

						// if last message is a partial we need to update and save it
						const lastMessage = this.getLastNonAgentMessage()

						if (lastMessage && lastMessage.partial) {
							// lastMessage.ts = Date.now() DO NOT update ts since it is used as a ChatRow key
							lastMessage.partial = false
							// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
						}

						// Update `api_req_started` to have cancelled and cost, so that
						// we can display the cost of the partial stream and the cancellation reason
						updateApiReqMsg(cancelReason, streamingFailedMessage)
						await this.saveAlphaMessages()
						if (guard && !guard()) return

						// Signals to provider that it can retrieve the saved messages
						// from disk, as abortTask can not be awaited on in nature.
						this.didFinishAbortingStream = true
					}

					// Reset streaming state for each new API request
					await this.drainStreamingPreviews("starting API request", ownsResponseStep)
					if (!ownsResponseStep()) return supersededResponseResult()
					this.invalidateStreamingPreviewEpoch()
					this.currentStreamingContentIndex = 0
					this.currentStreamingDidCheckpoint = false
					this.assistantMessageContent = []
					this.currentAgentResponse = undefined
					// Transport retries keep the immutable step/surface identity. A
					// context or empty-response retry starts a fresh captured boundary.
					const preserveTransportStep =
						currentItem.retryCategory === "transport" || currentItem.retryCategory === "rate-limit"
					if (!preserveTransportStep) {
						const previousStep = this.currentAgentStep
						options.onStepCaptured?.(undefined)
						// Release only the validated previous capture; retained transport
						// retries do not cross this synchronous reset boundary.
						previousStep?.releaseRequest?.()
						this.currentAgentStep = undefined
						this.currentTaskToolSurface = undefined
						ownsResponseStep = this.captureAgentStepOwnership()
						if (ownsCapturedTaskStep) ownsCapturedTaskStep = () => ownsResponseStep()
					}
					this.currentRequestSignal = undefined
					this.currentAssistantResponseMessageTs = undefined
					this.didCompleteReadingStream = false
					this.userMessageContentReady = false
					this.didRejectTool = false
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
					if (!ownsResponseStep()) return supersededResponseResult()

					// Cache model info once per API request to avoid repeated calls during streaming
					// This is especially important for tools and background usage collection
					this.cachedStreamingModel = (
						currentItem.recoveryStep?.snapshot.runtime.getHandler() ??
						(preserveTransportStep ? this.currentAgentStep?.snapshot.runtime.getHandler() : undefined) ??
						this.api
					).getModel()
					const streamModelInfo = this.cachedStreamingModel.info
					const cachedModelId = this.cachedStreamingModel.id

					// Yields only if the first chunk is successful, otherwise will
					// allow the user to retry the request (most likely due to rate
					// limit error, which gets thrown on the first chunk).
					let responseRunId = this.agentRunId
					let responseTurnId = this.agentTurnId
					let responseStepId = this.currentAgentStep?.stepId
					let streamLifecycleStep: CurrentAgentStep | undefined
					let streamToolSurface: TaskToolSurface | undefined
					const stream = this.attemptApiRequest(currentItem.retryAttempt ?? 0, {
						skipProviderRateLimit: true,
						state,
						retryCategory: currentItem.retryCategory,
						recoveryStep: currentItem.recoveryStep,
						retryDeadline: currentItem.retryDeadline,
						ownerHandlesRetry: true,
						interruptionSignal: stepInterruptionSignal,
						onStepCaptured: (step) => {
							options.onStepCaptured?.(step)
							// Capture before lifecycle/provider awaits, not at a later
							// terminal branch after the live Task could have changed.
							ownsResponseStep = this.captureAgentStepOwnership()
							ownsCapturedTaskStep = () => ownsResponseStep()
							responseRunId = this.agentRunId
							responseTurnId = this.agentTurnId
							responseStepId = step?.stepId
							streamLifecycleStep = step
							streamToolSurface = step?.surface
						},
					})
					let assistantMessage = ""
					let reasoningMessage = ""
					let pendingGroundingSources: GroundingSource[] = []
					const responseAccumulator = new AgentResponseAccumulator()
					let streamContextCaptured = false
					const streamStateSnapshot = state
					const earlyReadSignal = AbortSignal.any([
						stepInterruptionSignal,
						this.getTaskLifetimeCancellationSignal(),
					])
					const streamedToolCallReservations = new Map<
						string,
						{
							call: AgentToolCall
							descriptor: NonNullable<ReturnType<TaskToolSurface["resolve"]>>
						}
					>()
					const streamedToolCallReservationOrder: string[] = []
					let streamedToolCallReservationSurface: TaskToolSurface | undefined
					let streamedToolCallPreflightAvailable = true
					let streamedToolBatchIsolationError: string | undefined
					let streamedToolCallPreflightMatchesCanonical = false
					let streamedEarlyReadMismatch = false
					let providerOutcome: ApiStreamOutcomeChunk | undefined
					let streamRequiresTerminalOutcome = false
					let semanticOutputObserved = false
					let toolIntentObserved = false
					const observedToolCallIds = new Set<string>()
					let unidentifiedToolIntentObserved = false
					let providerErrorObserved = false
					let providerErrorMessage: string | undefined
					let providerErrorRetryable: boolean | undefined
					const earlyReadDispatches: EarlyReadonlyDispatch[] = []
					const committedToolsAllowRecovery = (response: AgentResponse) =>
						!streamedEarlyReadMismatch &&
						!unidentifiedToolIntentObserved &&
						[...observedToolCallIds].every((id) => response.toolCalls.some((call) => call.id === id)) &&
						canContinueFromCommittedHistoryTools({
							response,
							toolIntentObserved,
							reservedToolCalls: streamedToolCallReservationOrder.map(
								(id) => streamedToolCallReservations.get(id)!.call,
							),
							earlyReadDispatches: earlyReadDispatches.map((dispatch) => ({
								...dispatch,
								receiptPersisted: Boolean(
									this.findPersistedProviderToolResult(sanitizeToolUseId(dispatch.call.id)),
								),
							})),
						})
					let earlyReadDispatchTail: Promise<void> = Promise.resolve()
					let earlyReadLaneClosed = false
					let earlyReadDispatchFailure: { status: "failed" | "aborted"; error: Error } | undefined
					const scheduleEarlyReadonlyRead = async (call: AgentToolCall): Promise<void> => {
						if (earlyReadLaneClosed) return
						// User hook commands have unaudited effects; wait for the committed response boundary.
						if (
							this.completionHookConfig?.preToolUse?.length ||
							this.completionHookConfig?.postToolUse?.length ||
							this.completionHookConfig?.permissionRequest?.length
						) {
							earlyReadLaneClosed = true
							return
						}
						const callPosition = streamedToolCallReservationOrder.indexOf(call.id)
						const reservation = streamedToolCallReservations.get(call.id)
						const surface = streamToolSurface
						const step = streamLifecycleStep
						if (
							callPosition !== earlyReadDispatches.length ||
							earlyReadDispatches.length >= 4 ||
							!surface ||
							!step ||
							!streamedToolCallPreflightAvailable ||
							streamedToolCallReservationSurface !== surface ||
							!reservation
						) {
							earlyReadLaneClosed = true
							return
						}
						if (!(await this.isPreEofReadonlyToolCall(call, surface))) {
							earlyReadLaneClosed = true
							return
						}

						const dispatch: EarlyReadonlyDispatch = {
							call,
							surface,
							step,
							runId: this.agentRunId,
							identity: {
								turnId: step.turnId,
								stepId: step.stepId,
								requestId: step.requestId,
								attemptId: step.attemptId,
							},
						}
						earlyReadDispatches.push(dispatch)
						const earlyResponse = createAgentResponse([call])
						const scheduled = earlyReadDispatchTail.then(async () => {
							if (
								earlyReadDispatchFailure ||
								earlyReadSignal.aborted ||
								this.abort ||
								this.pendingSteerMessage
							)
								return
							dispatch.outcome = await this.executeCanonicalToolCalls(
								earlyResponse,
								surface,
								currentMode,
								streamStateSnapshot,
								earlyReadSignal,
								{
									earlyReadStep: step,
									deferResultCommit: true,
									onSchedulerCreated: (scheduler) => {
										dispatch.scheduler = scheduler
									},
								},
							)
							if (dispatch.outcome.status !== "completed") {
								earlyReadLaneClosed = true
								earlyReadDispatchFailure ??= {
									status: dispatch.outcome.status,
									error: new Error(
										dispatch.outcome.failure?.message ??
											(dispatch.outcome.status === "aborted"
												? "Early read execution was cancelled."
												: "Early read execution failed."),
									),
								}
							}
						})
						const settled = scheduled.then(
							() => undefined,
							(error) => {
								dispatch.error = error
								earlyReadDispatchFailure ??= {
									status: "failed",
									error: error instanceof Error ? error : new Error(String(error)),
								}
								earlyReadLaneClosed = true
							},
						)
						earlyReadDispatchTail = settled
					}
					let cancelledResponsePromise: Promise<TaskStepExecutionResult> | undefined
					const cancelResponseBeforeCommit = (): Promise<TaskStepExecutionResult> => {
						cancelledResponsePromise ??= (async () => {
							recoverCancelledResponse = undefined
							earlyReadLaneClosed = true
							const ownershipLostResult: TaskStepExecutionResult = {
								status: "aborted",
								reason: "The task no longer owns its provider transcript.",
								response: canonicalResponse,
							}
							if (!ownsResponseStep()) return ownershipLostResult
							// Cancellation disables the background usage drain. Project only
							// the usage already captured by this request before its final emission.
							updateApiReqMsg("user_cancelled")
							this.emitFinalTokenUsageUpdate()
							await earlyReadDispatchTail
							if (!ownsResponseStep()) return ownershipLostResult
							const reason = "The provider request was cancelled."
							const outcome = { status: "cancelled" as const, reason, retryable: false }
							// finish() is cached. A cancellation arriving during finalization
							// changes the outcome while preserving the finalized provider items.
							canonicalResponse = canonicalResponse
								? createAgentResponse(canonicalResponse.items, outcome)
								: await responseAccumulator.finish(undefined, outcome)
							if (!ownsResponseStep()) return ownershipLostResult
							await this.applyCanonicalAgentResponse(canonicalResponse, ownsResponseStep)
							if (!ownsResponseStep()) return ownershipLostResult
							const persistence = await this.persistTerminalCanonicalResponse(
								canonicalResponse,
								"cancelled",
								reason,
								earlyReadDispatches,
								ownsResponseStep,
							)
							if (!ownsResponseStep()) return ownershipLostResult
							if (this.abort || this.getTaskLifetimeCancellationSignal().aborted) {
								this.abortReason ??= "user_cancelled"
							}
							return {
								status: "aborted",
								reason: persistence.reason,
								...(persistence.error ? { error: persistence.error } : {}),
								response: canonicalResponse,
							}
						})()
						return cancelledResponsePromise
					}
					recoverCancelledResponse = cancelResponseBeforeCommit
					this.isStreaming = true

					try {
						const iterator = stream[Symbol.asyncIterator]()

						// Helper to race iterator.next() with abort signal and the configured API timeout.
						const nextChunkWithAbort = async (
							operationName = `API response stream for ${cachedModelId}`,
							timeoutMs = getApiRequestTimeout(),
							requestController = this.currentRequestAbortController,
							additionalSignal?: AbortSignal,
						) => {
							const boundedTimeoutMs = getTimeoutWithinDeadline(timeoutMs, currentItem.retryDeadline)
							const nextPromise = iterator.next()
							const requestSignal = requestController?.signal
							const abortSignals = [
								...new Set([requestSignal, additionalSignal].filter(Boolean)),
							] as AbortSignal[]
							const removeAbortListeners: Array<() => void> = []

							// Race only signals captured for this read. A delayed usage drain must
							// never observe or abort a controller installed by a later request.
							const abortPromise =
								abortSignals.length > 0
									? new Promise<never>((_, reject) => {
											for (const signal of abortSignals) {
												const onAbort = () => {
													if (this.pendingSteerMessage && signal === requestSignal) {
														reject(new SteerRequestInterruptError())
														return
													}
													reject(
														signal.reason instanceof Error
															? signal.reason
															: new Error("Request cancelled by user"),
													)
												}
												if (signal.aborted) {
													onAbort()
												} else {
													signal.addEventListener("abort", onAbort, { once: true })
													removeAbortListeners.push(() =>
														signal.removeEventListener("abort", onAbort),
													)
												}
											}
										})
									: undefined

							const operation = abortPromise ? Promise.race([nextPromise, abortPromise]) : nextPromise

							try {
								return await withApiRequestTimeout(operation, operationName, boundedTimeoutMs, () => {
									requestController?.abort(
										currentItem.retryDeadline !== undefined &&
											Date.now() >= currentItem.retryDeadline
											? new ApiStreamDeadlineError(
													"Automatic retry deadline exceeded",
													"retry_deadline",
												)
											: new ApiRequestTimeoutError(operationName, boundedTimeoutMs ?? 0),
									)
									const iteratorReturn = iterator.return?.(undefined)
									if (iteratorReturn) {
										void Promise.resolve(iteratorReturn).catch((error) => {
											console.warn("Failed to close stalled API response stream:", error)
										})
									}
								})
							} finally {
								for (const removeAbortListener of removeAbortListeners) removeAbortListener()
							}
						}

						let item = await nextChunkWithAbort()
						while (!item.done) {
							if (!ownsResponseStep()) return supersededResponseResult()
							const chunk = item.value
							if (!chunk) {
								// Sometimes chunk is undefined, no idea that can cause
								// it, but this workaround seems to fix it.
								item = await nextChunkWithAbort()
								continue
							}

							// attemptApiRequest is lazy: it captures the immutable step and
							// tool surface before yielding its first provider chunk. Capture
							// them after next() so this stream owns that exact snapshot.
							if (!streamContextCaptured) {
								streamLifecycleStep = this.currentAgentStep
								streamToolSurface = this.currentTaskToolSurface
								const streamHandler = streamLifecycleStep?.snapshot.runtime.getHandler() ?? this.api
								streamRequiresTerminalOutcome = streamHandler.streamCapabilities?.lifecycle === true
								streamContextCaptured = true
							}

							// Normalize every provider chunk before the legacy parser/UI
							// projection. The parser remains preview-only; the finished
							// accumulator response below is authoritative for effects.
							if (chunk.type.startsWith("tool_call")) {
								toolIntentObserved = true
								// Failed outcomes omit unaccepted fragments from the canonical response.
								// Keep their identities so a settled earlier read cannot hide later intent.
								if ("id" in chunk && typeof chunk.id === "string" && chunk.id)
									observedToolCallIds.add(chunk.id)
								else unidentifiedToolIntentObserved = true
							}
							if (providerErrorObserved && isApiStreamSemanticChunk(chunk)) {
								item = await nextChunkWithAbort()
								continue
							}
							await responseAccumulator.add(
								chunk,
								undefined,
								(call) => {
									const surface = streamToolSurface
									if (
										!surface ||
										this.currentTaskToolSurface !== surface ||
										(streamedToolCallReservationSurface &&
											streamedToolCallReservationSurface !== surface)
									) {
										streamedToolCallPreflightAvailable = false
										return
									}

									const descriptor = this.reserveStreamingToolCall(call)
									if (!descriptor) {
										streamedToolCallPreflightAvailable = false
										return
									}
									streamedToolCallReservationSurface = surface

									if (!streamedToolCallReservations.has(call.id)) {
										streamedToolCallReservationOrder.push(call.id)
									}
									streamedToolCallReservations.set(call.id, { call, descriptor })
									streamedToolBatchIsolationError = getToolBatchIsolationError(
										surface.registry,
										streamedToolCallReservationOrder.map(
											(id) => streamedToolCallReservations.get(id)!.call.name,
										),
									)
								},
								async (call) => {
									await this.publishCompletedCanonicalToolCall(call, streamLifecycleStep)
									await scheduleEarlyReadonlyRead(call)
								},
							)
							if (isApiStreamSemanticChunk(chunk)) semanticOutputObserved = true
							if (chunk.type === "outcome") providerOutcome = chunk
							if (chunk.type === "error") {
								providerErrorObserved = true
								providerErrorMessage = chunk.message || chunk.error
								if (providerErrorRetryable !== false) providerErrorRetryable = chunk.retryable
							}

							switch (chunk.type) {
								case "reasoning": {
									if (!chunk.text) break
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
									this.summarizeReasoning(this.getLastNonAgentMessage())
									break
								}
								case "usage":
									inputTokens += chunk.inputTokens
									outputTokens += chunk.outputTokens
									cacheWriteTokens += chunk.cacheWriteTokens ?? 0
									cacheReadTokens += chunk.cacheReadTokens ?? 0
									totalCost = chunk.totalCost
									await this.appendAgentTurnEvent({
										type: "request_usage",
										purpose: "task",
										usageSource: chunk.usageSource ?? "unknown",
										requestIndex: lastApiReqIndex,
										retry: (currentItem.retryAttempt ?? 0) > 0,
										inputTokens: chunk.inputTokens,
										outputTokens: chunk.outputTokens,
										cacheReadTokens: chunk.cacheReadTokens ?? 0,
										cacheWriteTokens: chunk.cacheWriteTokens ?? 0,
										totalCost: chunk.totalCost,
									})
									break
								case "grounding":
									// Handle grounding sources separately from regular content
									// to prevent state persistence issues - store them separately
									if (chunk.sources && chunk.sources.length > 0) {
										await this.markMemoryExternalContext()
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
									const preceding = this.assistantMessageContent.at(-1)
									if (preceding?.type === "text") preceding.partial = false
									// Legacy: Handle complete tool calls (for backward compatibility)
									// Convert native tool call to ToolUse format
									const toolUse = NativeToolCallParser.parseToolCall({
										id: chunk.id,
										name: chunk.name as ToolName,
										arguments: chunk.arguments,
									})

									if (!toolUse) {
										console.error(
											`Failed to parse tool '${chunk.name}' (call ${chunk.id}) for task ${this.taskId}.`,
										)
										break
									}

									// Add the tool use to assistant message content
									this.assistantMessageContent.push(toolUse)

									// Mark that we have new content to process
									this.userMessageContentReady = false
									this.scheduleStreamingPreview()

									break
								}
								case "text": {
									assistantMessage += chunk.text

									// Native tool calling: text chunks are plain text.
									// Create or update a text content block directly
									const lastBlock =
										this.assistantMessageContent[this.assistantMessageContent.length - 1]
									if (lastBlock?.type === "text" && lastBlock.partial) {
										lastBlock.content += chunk.text
									} else {
										this.assistantMessageContent.push({
											type: "text",
											content: chunk.text,
											partial: true,
										})
										this.userMessageContentReady = false
									}
									// Presentation only previews text; the persisted canonical response
									// reaches the serial ToolScheduler after streaming completes.
									this.scheduleStreamingPreview()
									break
								}
							}

							if (this.abort) {
								if (!this.abandoned && this.isCurrentApiConversationHistoryOwner()) {
									// Only need to gracefully abort if this instance
									// isn't abandoned (sometimes OpenRouter stream
									// hangs, in which case this would affect future
									// instances of Alpha).
									await abortStream("user_cancelled", undefined, ownsResponseStep)
									if (!ownsResponseStep()) return supersededResponseResult()
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
						const usageMessage = this.alphaMessages[lastApiReqIndex]
						const usageDrainOwner = usageMessage
							? this.beginBackgroundUsageDrain(
									this.currentRequestAbortController,
									lastApiReqIndex,
									usageMessage,
								)
							: undefined

						const drainStreamInBackgroundToFindAllUsage = async (owner: BackgroundUsageDrainOwner) => {
							const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS
							const startTime = performance.now()
							const modelId = cachedModelId

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
								messageIndex: number = owner.messageIndex,
							) => {
								if (!this.isBackgroundUsageDrainCurrent(owner)) return
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
									if (!updateApiReqMsg(undefined, undefined, owner.message)) return
									await this.saveAlphaMessages()
									if (!this.isBackgroundUsageDrainCurrent(owner)) return

									// Update the specific message in the webview
									const apiReqMessage = this.alphaMessages[messageIndex]
									if (apiReqMessage) {
										await this.updateAlphaMessage(apiReqMessage)
									}

									if (!this.isBackgroundUsageDrainCurrent(owner)) return
									// Use the provider protocol/model captured at request admission.
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
										owner.requestController,
										owner.controller.signal,
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
										owner.messageIndex,
									)
								} else {
									console.warn(
										`[Background Usage Collection] Suspicious: request ${owner.messageIndex} is complete, but no usage info was found. Model: ${modelId}`,
									)
								}
							} catch (error) {
								if (!this.isBackgroundUsageDrainCurrent(owner)) return
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
										owner.messageIndex,
									)
								}
							} finally {
								if (!this.isBackgroundUsageDrainCurrent(owner)) {
									try {
										void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined)
									} catch {
										// Superseded cleanup must not affect the newer request.
									}
								}
								this.finishBackgroundUsageDrain(owner)
							}
						}

						// Start the background task and handle any errors
						if (usageDrainOwner) {
							drainStreamInBackgroundToFindAllUsage(usageDrainOwner).catch((error) => {
								console.error("Background usage collection failed:", error)
							})
						}
					} catch (error) {
						if (!ownsResponseStep()) return supersededResponseResult()
						if (taskWasCancelled() && !this.isCurrentApiConversationHistoryOwner()) {
							return await cancelResponseBeforeCommit()
						}
						if (error instanceof LifecycleHookStoppedError || error instanceof LifecycleHookOwnershipError)
							throw error
						// Abandoned happens when extension is no longer waiting for the
						// Alpha instance to finish aborting (error is thrown here when
						// any function in the for loop throws due to this.abort).
						if (!this.abandoned) {
							const pendingSteer = this.pendingSteerMessage

							if (pendingSteer) {
								this.pendingSteerMessage = undefined
								await abortStream("user_cancelled", undefined, ownsResponseStep)
								if (!ownsResponseStep()) return supersededResponseResult()
								await this.presentSteeringInput(pendingSteer)

								stack.push({
									queuedMessageIds: pendingSteer.queuedMessageIds,
									userContent: this.buildUserMessageContent(
										pendingSteer.text,
										pendingSteer.images,
										pendingSteer.queuedMessageIds,
									),
									includeFileDetails: false,
									inputOrigin: pendingSteer.inputOrigin,
									steeringPersistence: mergeSteeringPersistence(
										currentItem,
										pendingSteer.onPersisted,
									),
								})

								continue
							}

							// Determine cancellation reason
							const cancelReason: AlphaApiReqCancelReason = this.abort
								? "user_cancelled"
								: "streaming_failed"

							const rawErrorMessage = error.message ?? JSON.stringify(serializeError(error), null, 2)
							const streamingFailedMessage = this.abort
								? undefined
								: `${t("common:interruption.streamTerminatedByProvider")}: ${rawErrorMessage}`

							// Clean up partial state
							await abortStream(cancelReason, streamingFailedMessage, ownsResponseStep)
							if (!ownsResponseStep()) return supersededResponseResult()
							await earlyReadDispatchTail
							if (!ownsResponseStep()) return supersededResponseResult()

							const retryError = error instanceof Error ? error : new Error(String(error))
							const retryMetadata = retryError as Error & {
								firstChunkFailure?: boolean
								retryCategory?: AgentRetryCategory
								retryable?: boolean
								semanticOutputObserved?: boolean
							}
							const timedOut = /timed out|deadline exceeded/i.test(retryError.message)
							const activeRequestSignal = this.currentRequestSignal as AbortSignal | undefined
							const requestWasCancelled =
								!timedOut &&
								(Boolean(activeRequestSignal && activeRequestSignal.aborted) ||
									isApiStreamAbortError(retryError, activeRequestSignal))
							const explicitNonSuccessOutcome =
								providerOutcome !== undefined && providerOutcome.status !== "completed"
							const shouldSalvageTerminalResponse =
								semanticOutputObserved || providerErrorObserved || explicitNonSuccessOutcome

							if (shouldSalvageTerminalResponse) {
								const terminalStatus =
									this.abort || this.taskCancellationController.signal.aborted || requestWasCancelled
										? "cancelled"
										: providerOutcome?.status && providerOutcome.status !== "completed"
											? providerOutcome.status
											: "failed"
								const terminalReason =
									providerErrorMessage ?? providerOutcome?.reason ?? retryError.message
								const terminalRetryable =
									terminalStatus === "cancelled"
										? false
										: (providerErrorRetryable ??
											providerOutcome?.retryable ??
											retryMetadata.retryable ??
											(retryError instanceof ApiStreamDeadlineError ||
												normalizeApiStreamErrorMetadata(error).retryable === true))

								if (terminalStatus === "failed" && !providerErrorObserved) {
									await responseAccumulator.add({
										type: "error",
										error: "StreamError",
										message: terminalReason,
										retryable: terminalRetryable,
										semanticOutputObserved,
										requestId: this.currentAgentStep?.requestId,
										attemptId: this.currentAgentStep?.attemptId,
									})
									if (!ownsResponseStep()) return supersededResponseResult()
								}

								canonicalResponse = await responseAccumulator.finish(undefined, {
									status: terminalStatus,
									reason: terminalReason,
									retryable: terminalRetryable,
								})
								if (!ownsResponseStep()) return supersededResponseResult()
								if (taskWasCancelled()) return await cancelResponseBeforeCommit()
								await this.applyCanonicalAgentResponse(canonicalResponse, ownsResponseStep)
								if (!ownsResponseStep()) return supersededResponseResult()
								if (taskWasCancelled()) return await cancelResponseBeforeCommit()
								recoverCancelledResponse = undefined
								const persistence = await this.persistTerminalCanonicalResponse(
									canonicalResponse,
									terminalStatus,
									terminalReason,
									earlyReadDispatches,
									ownsResponseStep,
								)
								if (!ownsResponseStep()) return supersededResponseResult()

								if (persistence.status === "aborted") {
									if (this.abort || this.getTaskLifetimeCancellationSignal().aborted) {
										this.abortReason = "user_cancelled"
									}
									if (this.abort) await this.abortTask()
									return {
										status: "aborted",
										reason: persistence.reason,
										...(persistence.error ? { error: persistence.error } : {}),
										response: canonicalResponse,
									}
								}
								if (
									semanticOutputObserved &&
									!providerErrorObserved &&
									!explicitNonSuccessOutcome &&
									providerOutcome?.terminal !== true &&
									terminalRetryable &&
									this.retryCategoryForError(error) === "transport" &&
									committedToolsAllowRecovery(canonicalResponse) &&
									persistence.assistantPersisted &&
									persistence.receiptsPersisted &&
									!persistence.error
								) {
									return committedRecoveryResult(canonicalResponse, retryError, currentItem)
								}

								return {
									status: persistence.status,
									reason: persistence.reason,
									error: persistence.error ?? retryError,
									response: canonicalResponse,
								}
							}

							if (this.abort || this.taskCancellationController.signal.aborted || requestWasCancelled) {
								this.abortReason = "user_cancelled"
								if (this.abort) await this.abortTask()
								return {
									status: "aborted",
									reason: "The provider request was cancelled.",
									response: canonicalResponse,
								}
							}

							const firstChunkFailure = retryMetadata.firstChunkFailure === true
							const category = this.retryCategoryForError(error)
							const retryAttempts = currentItem.retryAttempts ?? {}
							const attempt = (retryAttempts[category] ?? 0) + 1
							const hasSemanticOutput =
								semanticOutputObserved || retryMetadata.semanticOutputObserved === true
							const retryElapsedMs = getRetryElapsedMs()
							const decision = this.agentRetryPolicy.decide({
								category,
								attempt,
								totalAttempt: (currentItem.retryAttempt ?? 0) + 1,
								elapsedMs: retryElapsedMs,
								retryAfterMs: this.retryAfterMs(error),
								hasSemanticOutput,
							})

							// A provider explicitly marking an error as non-retryable must not
							// be replayed, even when the category budget remains.
							if (retryMetadata.retryable === false) {
								return {
									status: "failed",
									reason: retryError.message,
									error: retryError,
									response: canonicalResponse,
								}
							}

							// Context recovery and explicitly retryable provider failures do not
							// depend on tool auto-approval. Unknown failures and exhausted automatic
							// retries still offer the existing manual recovery boundary.
							if (
								firstChunkFailure &&
								!state?.autoApprovalEnabled &&
								!((category === "context" || retryMetadata.retryable === true) && decision.shouldRetry)
							) {
								const askResponse = await this.ask("api_req_failed", retryError.message)
								// The existing recovery boundary consumes only Retry. Keep a queued
								// message reply visible for the following human-input boundary.
								for (const id of (askResponse.queuedMessageIds ?? []).slice().reverse())
									this.messageQueueService.releaseMessage(id)
								if (askResponse.queuedMessageIds?.length) await this.messageQueueService.flush()
								if (askResponse.response !== "yesButtonClicked") {
									await this.say("error", retryError.message)
									return { status: "failed", reason: retryError.message, error: retryError }
								}
								await this.say("api_req_retried")
								await this.appendAgentTurnEvent({ type: "retry", attempt, reason: retryError.message })
								stack.push({
									queuedMessageIds: currentItem.queuedMessageIds,
									inputOrigin: currentItem.inputOrigin,
									userContent: currentUserContent,
									includeFileDetails: false,
									retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
									retryCategory: category,
									retryAttempts: { ...retryAttempts, [category]: attempt },
								})
								continue
							}

							if (!decision.shouldRetry) {
								await this.appendAgentTurnEvent({
									type: "response_terminal",
									status: "failed",
									reason: `Provider retry budget exhausted (${decision.reason ?? "attempts"}).`,
								})
								return {
									status: "exhausted",
									reason: `Provider retry budget exhausted (${decision.reason ?? "attempts"}).`,
									error: retryError,
									response: canonicalResponse,
								}
							}
							const automaticRetryDeadline = getAgentRetryDeadline(
								this.agentRetryPolicy.maxElapsedMs,
								retryElapsedMs,
								currentItem.retryDeadline,
							)

							if (category === "context") {
								const failedStep = this.currentAgentStep
								await this.handleContextWindowExceededError(automaticRetryDeadline, failedStep)
								if (!ownsResponseStep()) return supersededResponseResult()
								if (failedStep) {
									const compactionStep = this.agentStepContextBuilder.compaction(
										failedStep.snapshot,
										{
											action: "summary",
										},
									)
									await this.appendAgentTurnEvent(
										{
											type: "compaction_completed",
											action: "summary",
										},
										compactionStep.context,
									)
									if (!ownsResponseStep()) return supersededResponseResult()
								}
								const previousStep = this.currentAgentStep
								options.onStepCaptured?.(undefined)
								previousStep?.releaseRequest?.()
								this.currentAgentStep = undefined
								this.currentTaskToolSurface = undefined
								ownsResponseStep = this.captureAgentStepOwnership()
								if (ownsCapturedTaskStep) ownsCapturedTaskStep = () => ownsResponseStep()
							}

							try {
								await this.waitForRetryDecision(
									decision,
									retryError,
									stepInterruptionSignal,
									automaticRetryDeadline,
								)
							} catch (retryWaitError) {
								const pendingSteer = this.pendingSteerMessage
								if (pendingSteer) {
									this.pendingSteerMessage = undefined
									await this.presentSteeringInput(pendingSteer)
									this.resetMistakeRecoveryState()
									stack.push({
										queuedMessageIds: pendingSteer.queuedMessageIds,
										userContent: this.buildUserMessageContent(
											pendingSteer.text,
											pendingSteer.images,
											pendingSteer.queuedMessageIds,
										),
										includeFileDetails: false,
										inputOrigin: pendingSteer.inputOrigin,
										steeringPersistence: mergeSteeringPersistence(
											currentItem,
											pendingSteer.onPersisted,
										),
									})
									continue
								}
								return {
									status: retryWaitError instanceof ApiStreamDeadlineError ? "exhausted" : "aborted",
									reason:
										retryWaitError instanceof Error
											? retryWaitError.message
											: String(retryWaitError),
									error: retryWaitError,
									response: canonicalResponse,
								}
							}

							stack.push({
								queuedMessageIds: currentItem.queuedMessageIds,
								inputOrigin: currentItem.inputOrigin,
								userContent: currentUserContent,
								includeFileDetails: false,
								retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
								retryCategory: category,
								retryDeadline: automaticRetryDeadline,
								retryAttempts: { ...retryAttempts, [category]: decision.nextAttempt - 1 },
							})
							continue
						}
					} finally {
						if (ownsResponseStep()) this.isStreaming = false
					}

					// The joined producer owns this assistant boundary until external
					// termination permits a replacement Task to claim transcript ownership.
					if (!ownsResponseStep()) return supersededResponseResult()
					if (taskWasCancelled()) return await cancelResponseBeforeCommit()

					this.didCompleteReadingStream = true
					for (const block of this.assistantMessageContent) {
						if (block.type === "text") block.partial = false
					}
					this.scheduleStreamingPreview()

					// The canonical response is the only source allowed to mutate effects.
					// Drain the preview queue before finalizing/replacing its shared parser
					// state, then close this preview epoch before persistence and scheduling.
					await this.drainStreamingPreviews("stream completion", ownsResponseStep)
					if (!ownsResponseStep()) return supersededResponseResult()
					this.invalidateStreamingPreviewEpoch()

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
								}

								// Clean up tracking
								this.streamingToolCallIndices.delete(event.id)

								// Mark that we have new content to process
								this.userMessageContentReady = false
							}
						}
					}

					// The accumulator owns the completed provider response. The legacy
					// NativeToolCallParser above is retained only for incremental UI
					// preview; never use its repaired/partial state to decide effects.
					await earlyReadDispatchTail
					if (!ownsResponseStep()) return supersededResponseResult()
					if (taskWasCancelled()) return await cancelResponseBeforeCommit()
					const missingTerminalOutcome =
						semanticOutputObserved &&
						streamRequiresTerminalOutcome &&
						(!providerOutcome || (providerOutcome.status === "completed" && !providerOutcome.terminal))
					const responseStatus = providerErrorObserved
						? "failed"
						: missingTerminalOutcome
							? "incomplete"
							: (providerOutcome?.status ?? (semanticOutputObserved ? "completed" : undefined))
					const responseReason =
						providerErrorMessage ??
						(missingTerminalOutcome
							? "Provider stream closed before a terminal response outcome."
							: providerOutcome?.reason)
					canonicalResponse = await responseAccumulator.finish(
						undefined,
						responseStatus
							? {
									status: responseStatus,
									...(providerOutcome?.requiresContinuation !== undefined
										? { requiresContinuation: providerOutcome.requiresContinuation }
										: {}),
									...(responseReason ? { reason: responseReason } : {}),
									...((providerErrorRetryable ??
										providerOutcome?.retryable ??
										(missingTerminalOutcome ? true : undefined)) !== undefined
										? { retryable: providerErrorRetryable ?? providerOutcome?.retryable ?? true }
										: {}),
								}
							: undefined,
					)
					if (!ownsResponseStep()) return supersededResponseResult()
					if (taskWasCancelled()) return await cancelResponseBeforeCommit()
					const reservationSurface = streamedToolCallReservationSurface
					const orderedToolCallReservations = streamedToolCallReservationOrder.map(
						(id) => streamedToolCallReservations.get(id)!,
					)
					streamedToolCallPreflightMatchesCanonical =
						streamedToolCallPreflightAvailable &&
						reservationSurface !== undefined &&
						reservationSurface === this.currentTaskToolSurface &&
						orderedToolCallReservations.length === canonicalResponse.toolCalls.length &&
						orderedToolCallReservations.every((reservation, index) => {
							const canonicalCall = canonicalResponse!.toolCalls[index]
							return (
								canonicalCall !== undefined &&
								reservation.call.id === canonicalCall.id &&
								reservation.call.name === canonicalCall.name &&
								JSON.stringify(reservation.call.arguments) ===
									JSON.stringify(canonicalCall.arguments) &&
								reservation.descriptor.name ===
									reservationSurface.registry.canonicalName(canonicalCall.name)
							)
						})
					const completedEarlyReadDispatches = earlyReadDispatches.filter(
						(
							dispatch,
						): dispatch is typeof dispatch & { scheduler: ToolScheduler; outcome: ToolSchedulerOutcome } =>
							dispatch.scheduler !== undefined && dispatch.outcome !== undefined,
					)
					streamedEarlyReadMismatch =
						completedEarlyReadDispatches.length > 0 &&
						(completedEarlyReadDispatches.some((dispatch, index) => {
							const canonicalCall = canonicalResponse!.toolCalls[index]
							return (
								canonicalCall === undefined ||
								dispatch.call.id !== canonicalCall.id ||
								dispatch.call.name !== canonicalCall.name ||
								JSON.stringify(dispatch.call.arguments) !== JSON.stringify(canonicalCall.arguments)
							)
						}) ||
							streamToolSurface !== this.currentTaskToolSurface)
					await this.applyCanonicalAgentResponse(canonicalResponse, ownsResponseStep)
					if (!ownsResponseStep()) return supersededResponseResult()
					if (taskWasCancelled()) return await cancelResponseBeforeCommit()
					assistantMessage = canonicalResponse.text
					reasoningMessage = canonicalResponse.reasoning
					pendingGroundingSources = canonicalResponse.items.flatMap((item) =>
						item.type === "grounding" ? item.sources : [],
					)

					// The canonical projection above is complete. Incremental previews
					// have already drained and must not be presented again here.

					// Note: updateApiReqMsg() is now called from within drainStreamInBackgroundToFindAllUsage
					// to ensure usage data is captured even when the stream is interrupted. The background task
					// uses local variables to accumulate usage data before atomically updating the shared state.

					// Complete the reasoning message if it exists
					// We can't use say() here because the reasoning message may not be the last message
					// (other messages like text blocks or tool uses may have been added after it during streaming)
					if (reasoningMessage) {
						const lastReasoningIndex = findLastIndex(
							this.alphaMessages,
							(m) => m.type === "say" && m.say === "reasoning",
						)

						if (lastReasoningIndex !== -1 && this.alphaMessages[lastReasoningIndex].partial) {
							this.alphaMessages[lastReasoningIndex].partial = false
							await this.updateAlphaMessage(this.alphaMessages[lastReasoningIndex])
							if (!ownsResponseStep()) return supersededResponseResult()
							if (taskWasCancelled()) return await cancelResponseBeforeCommit()
							this.summarizeReasoning(this.alphaMessages[lastReasoningIndex])
						}
					}

					await this.saveAlphaMessages()
					if (!ownsResponseStep()) return supersededResponseResult()
					if (taskWasCancelled()) return await cancelResponseBeforeCommit()
					// A required terminal marker was lost, rather than explicitly reporting
					// an incomplete answer. Keep that attempt incomplete and continue only
					// after its durable history and lifecycle boundary have closed.
					if (
						semanticOutputObserved &&
						missingTerminalOutcome &&
						!providerErrorObserved &&
						(!providerOutcome || (providerOutcome.status === "completed" && !providerOutcome.terminal)) &&
						canonicalResponse.outcome?.retryable !== false &&
						((!toolIntentObserved &&
							canonicalResponse.toolCalls.length === 0 &&
							streamedToolCallReservationOrder.length === 0) ||
							earlyReadDispatches.length > 0)
					) {
						const reason =
							canonicalResponse.outcome?.reason ??
							"Provider stream closed before a terminal response outcome."
						const persistence = await this.persistTerminalCanonicalResponse(
							canonicalResponse,
							canonicalResponse.outcome?.status === "incomplete" ? "incomplete" : "failed",
							reason,
							earlyReadDispatches,
							ownsResponseStep,
						)
						if (!ownsResponseStep()) return supersededResponseResult()
						if (
							!persistence.assistantPersisted ||
							!persistence.receiptsPersisted ||
							persistence.error ||
							persistence.status === "aborted" ||
							!committedToolsAllowRecovery(canonicalResponse)
						) {
							return {
								status: persistence.status,
								reason: persistence.reason,
								error: persistence.error,
								response: canonicalResponse,
							}
						}
						return committedRecoveryResult(canonicalResponse, new Error(reason), currentItem)
					}

					// No legacy text-stream tool parser state to reset.

					// CRITICAL: Save assistant message to API history BEFORE executing tools.
					// This ensures that when new_task triggers delegation and calls flushPendingToolResultsToHistory(),
					// the assistant message is already in history. Otherwise, tool_result blocks would appear
					// BEFORE their corresponding tool_use blocks, causing API errors.

					// Check if we have any canonical content to process. Error items are
					// intentionally considered output so malformed calls terminate as a
					// failed step instead of entering the empty-response retry loop.
					const hasToolUses = canonicalResponse!.toolCalls.length > 0
					const assistantContent = buildCanonicalAssistantHistoryContent(canonicalResponse!)
					// Empty signed/thinking blocks still carry state that the next request must replay.
					const hasAssistantContent =
						assistantContent.some((block) => block.type !== "text" || block.text.length > 0) ||
						reasoningMessage.length > 0 ||
						canonicalResponse!.items.some(
							(item) => item.type === "reasoning" && item.signature !== undefined,
						)
					const hasCanonicalError = canonicalResponse?.items.some((item) => item.type === "error") ?? false
					const responseOutcome = canonicalResponse?.outcome
					const responseRequiresContinuation = responseOutcome?.requiresContinuation === true
					const hasNonCompletedOutcome =
						responseOutcome !== undefined && responseOutcome.status !== "completed"
					let rejectedToolBatchIsolationError: string | undefined
					let responseSafetyError: string | undefined
					let isolationError: string | undefined
					let settleEarlyReadBeforeBarrierRejection = false

					const commitResponse = async (): Promise<TaskStepExecutionResult> => {
						const supersededResult = (error?: Error): TaskStepExecutionResult => ({
							status: "aborted",
							reason: "The task no longer owns its response step.",
							response: canonicalResponse,
							...(error ? { error } : {}),
						})
						const assertResponseOwnership = () => {
							if (!ownsResponseStep()) throw new TaskPersistenceError("The response step was superseded.")
						}
						if (!ownsResponseStep()) return supersededResult()
						if (taskWasCancelled()) return await cancelResponseBeforeCommit()
						if (hasAssistantContent || responseRequiresContinuation) {
							// Reset counter when we get a successful response with content
							this.consecutiveNoAssistantMessagesCount = 0
							// Display grounding sources to the user if they exist
							if (pendingGroundingSources.length > 0) {
								const citationLinks = pendingGroundingSources.map(
									(source, i) => `[${i + 1}](${source.url})`,
								)
								const sourcesText = `${t("common:gemini.sources")} ${citationLinks.join(", ")}`

								try {
									await this.say("text", sourcesText, undefined, false, undefined, undefined, {
										isNonInteractive: true,
									})
								} catch (error) {
									if (taskWasCancelled()) return await cancelResponseBeforeCommit()
									throw error
								}
								if (taskWasCancelled()) return await cancelResponseBeforeCommit()
							}

							// Reject lifecycle barriers before persistence as well as before effects.
							// Use the same captured registry as the scheduler so native/MCP aliases
							// and hidden or invalid barrier calls cannot let a preceding effect run.
							const assistantToolUses = assistantContent.filter(
								(block): block is Anthropic.ToolUseBlockParam => block.type === "tool_use",
							)
							isolationError = this.currentTaskToolSurface
								? streamedToolCallPreflightMatchesCanonical
									? streamedToolBatchIsolationError
									: getToolBatchIsolationError(
											this.currentTaskToolSurface.registry,
											assistantToolUses.map((tool) => tool.name),
										)
								: undefined
							const earlyReadPrefixMatches =
								completedEarlyReadDispatches.length > 0 &&
								completedEarlyReadDispatches.every((dispatch, index) => {
									const canonicalCall = canonicalResponse!.toolCalls[index]
									return (
										canonicalCall !== undefined &&
										canonicalCall.id === dispatch.call.id &&
										canonicalCall.name === dispatch.call.name &&
										JSON.stringify(canonicalCall.arguments) ===
											JSON.stringify(dispatch.call.arguments)
									)
								})
							settleEarlyReadBeforeBarrierRejection =
								isolationError !== undefined && earlyReadPrefixMatches && !streamedEarlyReadMismatch
							if (settleEarlyReadBeforeBarrierRejection) rejectedToolBatchIsolationError = isolationError
							responseSafetyError = streamedEarlyReadMismatch
								? "The finalized provider response did not match a durably accepted early read item."
								: isolationError && !settleEarlyReadBeforeBarrierRejection
									? isolationError
									: undefined

							if (responseSafetyError) {
								rejectedToolBatchIsolationError = responseSafetyError
								for (const tool of assistantToolUses) {
									this.pushToolResultToUserContent({
										type: "tool_result",
										tool_use_id: tool.id,
										content: formatResponse.toolError(responseSafetyError),
										is_error: true,
									})
								}
								let discardError: Error | undefined
								for (const dispatch of completedEarlyReadDispatches) {
									try {
										await dispatch.scheduler.discardDeferredResults()
									} catch (error) {
										discardError ??= error instanceof Error ? error : new Error(String(error))
									}
								}
								if (!ownsResponseStep()) return supersededResult(discardError)
								if (discardError) throw discardError

								this.assistantMessageContent = []
								this.currentStreamingContentIndex = 0
								this.userMessageContentReady = true
							}

							// Save assistant message BEFORE executing tools
							// This is critical for new_task: when it triggers delegation, flushPendingToolResultsToHistory()
							// will save the user message with tool_results. The assistant message must already be in history
							// so that tool_result blocks appear AFTER their corresponding tool_use blocks.
							if (taskWasCancelled()) return await cancelResponseBeforeCommit()
							recoverCancelledResponse = undefined
							const assistantResponsePersisted = await this.persistAssistantResponseBeforeEffects(
								{ role: "assistant", content: assistantContent },
								reasoningMessage || undefined,
								canonicalResponse,
								ownsResponseStep,
							)
							if (!ownsResponseStep()) {
								return {
									status: "aborted",
									reason: "The task no longer owns its response step.",
									response: canonicalResponse,
								}
							}
							if (!assistantResponsePersisted) {
								let discardError: Error | undefined
								if (!responseSafetyError) {
									for (const dispatch of completedEarlyReadDispatches) {
										try {
											await dispatch.scheduler.discardDeferredResults()
										} catch (error) {
											discardError ??= error instanceof Error ? error : new Error(String(error))
										}
									}
								}
								if (!ownsResponseStep()) return supersededResult(discardError)
								if (discardError) throw discardError
								const taskWasCancelled = this.abort || this.getTaskLifetimeCancellationSignal().aborted
								const persistenceReason =
									"The assistant response could not be durably persisted before tool execution."
								const persistenceError = new TaskPersistenceError(persistenceReason)
								await this.appendAgentTurnEvent(
									{
										type: "response_terminal",
										status: taskWasCancelled ? "aborted" : "failed",
										reason: persistenceReason,
										retryable: false,
									},
									streamLifecycleStep?.snapshot.context,
								)
								if (!ownsResponseStep()) return supersededResult(persistenceError)
								return {
									status: taskWasCancelled ? "aborted" : "failed",
									reason: persistenceReason,
									error: persistenceError,
									response: this.currentAgentResponse,
								}
							}

							TelemetryService.instance.captureConversationMessage(this.taskId, "assistant")
							await this.appendAgentTurnEvent(
								{ type: "assistant_committed", response: canonicalResponse! },
								streamLifecycleStep?.snapshot.context,
							)
							if (!ownsResponseStep()) return supersededResult()
							if (streamedEarlyReadMismatch) {
								const canonicalCallIds = new Set(
									canonicalResponse!.toolCalls.map((call) => sanitizeToolUseId(call.id)),
								)
								const missingEarlyCalls = completedEarlyReadDispatches.filter(
									(dispatch) => !canonicalCallIds.has(sanitizeToolUseId(dispatch.call.id)),
								)
								try {
									for (const dispatch of missingEarlyCalls) {
										if (!ownsResponseStep()) return supersededResult()
										await this.publishCanonicalLifecycleToolResult(
											{
												callId: dispatch.call.id,
												status: "error",
												content:
													"The finalized provider response omitted a durably accepted read call.",
											},
											streamLifecycleStep,
											{ durable: true, required: true, guard: ownsResponseStep },
										)
										if (!ownsResponseStep()) return supersededResult()
									}
									if (missingEarlyCalls.length > 0) {
										await this.canonicalLifecycleQueue
										if (!ownsResponseStep()) return supersededResult()
										await this.replayCanonicalLifecycle()
										if (!ownsResponseStep()) return supersededResult()
										const lifecycle = this.getCanonicalLifecycleSnapshot()
										if (
											lifecycle &&
											(lifecycle.runId !== responseRunId ||
												lifecycle.turnId !== responseTurnId ||
												(lifecycle.currentStepId !== undefined &&
													lifecycle.currentStepId !== responseStepId) ||
												!lifecycle.steps.some((step) => step.stepId === responseStepId) ||
												missingEarlyCalls.some(
													(dispatch) =>
														!lifecycle.items.some(
															(item) =>
																item.type === "tool_call" &&
																item.toolCallId ===
																	sanitizeToolUseId(dispatch.call.id) &&
																item.stepId === responseStepId,
														),
												))
										)
											return supersededResult()
										const reconciled =
											lifecycle &&
											(await this.reconcileRecoveredCanonicalToolCallTranscript(
												lifecycle,
												ownsResponseStep,
											))
										if (!ownsResponseStep()) return supersededResult()
										if (!reconciled) {
											throw new TaskPersistenceError(
												"Mismatched early read calls could not be paired in provider history.",
											)
										}
									}
								} catch (error) {
									if (!ownsResponseStep()) return supersededResult()
									throw error
								}
							}
						}

						// A provider terminal status is authoritative. Persist any assistant
						// content first, but never execute calls or ordinary-text-complete a
						// failed, incomplete, or cancelled response.
						if (hasNonCompletedOutcome || hasCanonicalError) {
							this.userMessageContentReady = true
							const terminalReceiptStatus =
								responseOutcome?.status && responseOutcome.status !== "completed"
									? responseOutcome.status
									: "failed"
							const terminalResults = await this.persistTerminalToolResults(
								canonicalResponse!,
								terminalReceiptStatus,
								earlyReadDispatches,
								!responseSafetyError,
								ownsResponseStep,
							)
							if (terminalResults.superseded || !ownsResponseStep()) {
								return {
									status: "aborted",
									reason: "The task no longer owns its terminal response step.",
									...(terminalResults.error ? { error: terminalResults.error } : {}),
									response: canonicalResponse,
								}
							}
							const terminalReceiptPersistenceFailed =
								((canonicalResponse?.toolCalls.length ?? 0) > 0 && !terminalResults.persisted) ||
								terminalResults.error !== undefined
							const terminalReceiptFailureReason = terminalReceiptPersistenceFailed
								? "Terminal tool-result receipts could not be durably saved."
								: undefined
							const terminalReason = [
								responseOutcome?.reason ?? (hasCanonicalError ? "Malformed tool call." : undefined),
								terminalReceiptFailureReason,
								terminalResults.error?.message,
							]
								.filter((reason): reason is string => Boolean(reason))
								.join(" ")
							const providerTerminalStatus =
								responseOutcome?.status === "cancelled"
									? "aborted"
									: responseOutcome?.status && responseOutcome.status !== "completed"
										? responseOutcome.status
										: hasCanonicalError
											? "failed"
											: "incomplete"
							const taskWasCancelled = this.abort || this.getTaskLifetimeCancellationSignal().aborted
							const terminalStatus = taskWasCancelled
								? "aborted"
								: terminalReceiptPersistenceFailed
									? "failed"
									: providerTerminalStatus
							const terminalPersistenceError =
								terminalResults.error ??
								(terminalReceiptPersistenceFailed
									? new TaskPersistenceError(
											"Terminal tool-result receipts could not be durably saved.",
										)
									: undefined)
							await this.appendAgentTurnEvent(
								{
									type: "response_terminal",
									status: terminalStatus,
									reason: terminalReason || undefined,
									retryable: responseOutcome?.retryable,
								},
								this.currentAgentStep?.snapshot.context,
							)
							if (terminalStatus === "aborted") {
								return {
									status: "aborted",
									reason: terminalReason || "Provider cancelled the response.",
									...(terminalPersistenceError ? { error: terminalPersistenceError } : {}),
									response: canonicalResponse,
								}
							}
							return {
								status: terminalStatus,
								reason:
									terminalReason ||
									(hasCanonicalError
										? "The provider returned a malformed tool call."
										: "The provider response was incomplete."),
								...(terminalPersistenceError ? { error: terminalPersistenceError } : {}),
								response: canonicalResponse,
							}
						}
						let earlyResultCommitError: unknown
						if (!responseSafetyError) {
							for (const dispatch of completedEarlyReadDispatches) {
								if (!ownsResponseStep()) return supersededResult()
								if (taskWasCancelled()) break
								dispatch.resultCommitStarted = true
								try {
									await dispatch.scheduler.commitDeferredResults({
										deferBatchFinished: true,
										assertOwnership: assertResponseOwnership,
									})
								} catch (error) {
									earlyResultCommitError ??= error instanceof Error ? error : new Error(String(error))
									break
								}
							}
						}
						if (!ownsResponseStep()) return supersededResult()
						let earlyReadError = earlyResultCommitError ?? earlyReadDispatchFailure?.error
						if (earlyReadError || taskWasCancelled()) {
							const failureMessage =
								earlyReadError instanceof Error
									? earlyReadError.message
									: earlyReadError !== undefined
										? String(earlyReadError)
										: "The task was cancelled while an early read was settling."
							// A rejected commit is not an untouched preview. Close only from
							// actual staged truth; never restage raw scheduler outcomes here.
							const terminalResults = await this.persistTerminalToolResults(
								canonicalResponse!,
								taskWasCancelled() ? "cancelled" : "failed",
								earlyReadDispatches,
								false,
								ownsResponseStep,
							)
							if (terminalResults.superseded || !ownsResponseStep()) return supersededResult()
							let terminalStatus: "aborted" | "failed" = taskWasCancelled()
								? "aborted"
								: earlyResultCommitError || terminalResults.error || !terminalResults.persisted
									? "failed"
									: (earlyReadDispatchFailure?.status ?? "failed")
							if (terminalResults.persisted) {
								for (const dispatch of completedEarlyReadDispatches) {
									if (!dispatch.resultCommitStarted) continue
									if (!ownsResponseStep()) return supersededResult()
									try {
										await dispatch.scheduler.finishDeferredBatch({
											status: taskWasCancelled() ? "aborted" : terminalStatus,
											assertOwnership: assertResponseOwnership,
										})
									} catch (error) {
										if (!ownsResponseStep()) return supersededResult()
										earlyReadError ??= error instanceof Error ? error : new Error(String(error))
										if (!taskWasCancelled()) terminalStatus = "failed"
									}
								}
							}
							if (!ownsResponseStep()) return supersededResult()
							if (taskWasCancelled()) terminalStatus = "aborted"
							this.userMessageContentReady = true
							const reason = !terminalResults.persisted
								? "Early read results could not be durably saved after commit failed."
								: earlyResultCommitError
									? `Early read results could not be fully committed: ${failureMessage}`
									: earlyReadDispatchFailure
										? failureMessage
										: "The task was cancelled while early read results were settling."
							await this.appendAgentTurnEvent(
								{ type: "response_terminal", status: terminalStatus, reason, retryable: false },
								streamLifecycleStep?.snapshot.context,
							)
							if (!ownsResponseStep()) return supersededResult()
							return {
								status: taskWasCancelled() ? "aborted" : terminalStatus,
								reason,
								...(terminalResults.error || earlyReadError || !terminalResults.persisted
									? {
											error:
												terminalResults.error ??
												earlyReadError ??
												new TaskPersistenceError(reason),
										}
									: {}),
								response: canonicalResponse,
							}
						}
						if (!responseSafetyError && settleEarlyReadBeforeBarrierRejection) {
							const earlyCallIds = new Set(
								completedEarlyReadDispatches.map((dispatch) => sanitizeToolUseId(dispatch.call.id)),
							)
							for (const call of canonicalResponse!.toolCalls) {
								if (!ownsResponseStep()) return supersededResult()
								if (earlyCallIds.has(sanitizeToolUseId(call.id))) continue
								const content = formatResponse.toolError(isolationError!)
								this.pushToolResultToUserContent({
									type: "tool_result",
									tool_use_id: sanitizeToolUseId(call.id),
									content,
									is_error: true,
								})
								await this.appendAgentTurnEvent(
									{
										type: "tool_result",
										callId: call.id,
										name: call.name,
										status: "error",
										output: content,
									},
									this.currentAgentStep?.snapshot.context,
								)
								if (!ownsResponseStep()) return supersededResult()
								await this.publishCanonicalLifecycleToolResult(
									{ callId: call.id, status: "error", content },
									streamLifecycleStep,
									{ durable: true, required: true, guard: ownsResponseStep },
								)
								if (!ownsResponseStep()) return supersededResult()
							}
							this.userMessageContentReady = true
						}
						for (const dispatch of completedEarlyReadDispatches) {
							if (!ownsResponseStep()) return supersededResult()
							try {
								await dispatch.scheduler.finishDeferredBatch({
									...(settleEarlyReadBeforeBarrierRejection
										? { status: "failed" as const, batchSize: canonicalResponse!.toolCalls.length }
										: {}),
									assertOwnership: assertResponseOwnership,
								})
							} catch (error) {
								if (!ownsResponseStep()) return supersededResult()
								throw error
							}
						}
						if (!ownsResponseStep()) return supersededResult()
						return { status: "completed", response: canonicalResponse }
					}

					const executeEffects = async (): Promise<TaskStepExecutionResult> => {
						if (!ownsResponseStep()) return supersededResponseResult()
						if (hasAssistantContent || responseRequiresContinuation) {
							// All canonical calls are complete and execution is now owned by the
							// serial scheduler. It commits tool results to the next user message
							// only after the assistant history write above has completed.
							if (hasToolUses && !rejectedToolBatchIsolationError) {
								const earlyCallIds = new Set(
									completedEarlyReadDispatches.map((dispatch) => sanitizeToolUseId(dispatch.call.id)),
								)
								const remainingToolCalls = canonicalResponse!.toolCalls.filter(
									(call) => !earlyCallIds.has(sanitizeToolUseId(call.id)),
								)
								if (remainingToolCalls.length > 0) {
									if (!ownsResponseStep()) return supersededResponseResult()
									try {
										await this.publishCanonicalLifecyclePhase("executing", ownsResponseStep)
									} catch (error) {
										if (!ownsResponseStep()) return supersededResponseResult()
										throw error
									}
									if (!ownsResponseStep()) return supersededResponseResult()
									const remainingIds = new Set(remainingToolCalls.map((call) => call.id))
									const remainingResponse = createAgentResponse(
										canonicalResponse!.items.filter(
											(item) => item.type !== "tool_call" || remainingIds.has(item.id),
										),
										canonicalResponse!.outcome,
									)
									if (!ownsResponseStep()) return supersededResponseResult()
									let schedulerOutcome: ToolSchedulerOutcome
									try {
										schedulerOutcome = await this.executeCanonicalToolCallsForTurn(
											remainingResponse,
											streamToolSurface,
											currentMode,
											streamStateSnapshot,
										)
									} catch (error) {
										if (!ownsResponseStep()) return supersededResponseResult()
										throw error
									}
									if (!ownsResponseStep()) return supersededResponseResult()
									if (schedulerOutcome.status === "aborted") {
										const interruptedBySteering =
											this.pendingSteerMessage !== undefined &&
											!this.abort &&
											!this.getTaskLifetimeCancellationSignal().aborted
										// ToolScheduler preserves results for every canonical call when
										// cancellation wins. Persist that complete receipt batch before
										// returning; otherwise the assistant tool_use boundary would be
										// left unmatched on disk.
										let resultsPersisted: boolean
										try {
											resultsPersisted = await this.flushPendingToolResultsToHistory({
												allowAborted: true,
												guard: ownsResponseStep,
											})
										} catch (error) {
											if (!ownsResponseStep()) return supersededResponseResult()
											throw error
										}
										if (!ownsResponseStep()) return supersededResponseResult()
										if (!resultsPersisted) {
											const persistenceReason =
												"Tool-result receipts could not be durably saved after cancellation."
											const persistenceError = new TaskPersistenceError(persistenceReason)
											await this.appendAgentTurnEvent({
												type: "response_terminal",
												status:
													this.abort || this.getTaskLifetimeCancellationSignal().aborted
														? "aborted"
														: "failed",
												reason: persistenceReason,
												retryable: false,
											})
											if (!ownsResponseStep()) return supersededResponseResult()
											return {
												status:
													this.abort || this.getTaskLifetimeCancellationSignal().aborted
														? "aborted"
														: "failed",
												reason: persistenceReason,
												error: persistenceError,
												response: canonicalResponse,
											}
										}
										if (!interruptedBySteering) {
											return {
												status: "aborted",
												reason: "Tool execution was cancelled.",
												response: canonicalResponse,
											}
										}

										// Steering is a turn interruption, not a task cancellation. The
										// cancelled tool receipts are already durable; report this provider
										// step as closed so AgentTurnEngine can consume the retained message.
										this.userMessageContentReady = true
										await this.appendAgentTurnEvent(
											{ type: "response_terminal", status: "completed" },
											streamLifecycleStep?.snapshot.context,
										)
										if (!ownsResponseStep()) return supersededResponseResult()
										return { status: "completed", response: canonicalResponse }
									}
									if (schedulerOutcome.status === "failed") {
										return {
											status: "failed",
											reason:
												schedulerOutcome.failure?.message ??
												"Tool execution failed before the batch completed.",
											error: new Error(
												schedulerOutcome.failure?.message ??
													"Tool execution failed before the batch completed.",
											),
											response: canonicalResponse,
										}
									}
								}
							}
							if (!ownsResponseStep()) return supersededResponseResult()
							this.userMessageContentReady = true
							await this.appendAgentTurnEvent(
								{ type: "response_terminal", status: "completed" },
								streamLifecycleStep?.snapshot.context,
							)
							if (!ownsResponseStep()) return supersededResponseResult()

							if (this.didComplete) {
								return { status: "completed", response: this.currentAgentResponse }
							}

							// Visible text reaches the shared completion gate in the outer loop.
							// Retain no-content recovery without coercing a valid child answer.
							const didToolUse = hasToolUses

							if (
								!didToolUse &&
								this.taskKind === "subagent" &&
								!canonicalResponse?.text.trim() &&
								!responseRequiresContinuation &&
								!canonicalResponse!.items.some((item) => item.type === "reasoning")
							) {
								// Increment consecutive no-tool-use counter
								this.consecutiveNoToolUseCount++

								// Only show error and count toward mistake limit after 2 consecutive failures
								if (this.consecutiveNoToolUseCount >= 2) {
									await this.say("error", "MODEL_NO_TOOLS_USED")
									if (!ownsResponseStep()) return supersededResponseResult()
									// Only count toward mistake limit after second consecutive failure
									this.consecutiveMistakeCount++
								}

								// Use the task's locked protocol for consistent behavior
								this.userMessageContent.push({
									type: "text",
									text: formatResponse.noToolsUsed(),
								})
							} else {
								// Reset recovery after tools or visible text from either task kind.
								this.consecutiveNoToolUseCount = 0
							}

							// Return after one complete model/tool turn. AgentTurnEngine owns
							// continuation sequencing; keeping this method to one step makes
							// the assistant-response/tool-result boundary explicit.
							return { status: "completed", response: this.currentAgentResponse }
						}
						return { status: "completed", response: canonicalResponse }
					}

					const hasResponseTransaction =
						hasAssistantContent ||
						responseRequiresContinuation ||
						hasNonCompletedOutcome ||
						hasCanonicalError
					if (hasResponseTransaction) {
						let commitPromise: Promise<TaskStepExecutionResult> | undefined
						let effectsPromise: Promise<TaskStepExecutionResult> | undefined
						let committedResult: TaskStepExecutionResult | undefined
						const transaction: TaskStepTransaction = {
							commitResponse: async () => {
								commitPromise ??= commitResponse()
								committedResult = await commitPromise
								return committedResult
							},
							executeEffects: async () => {
								if (!committedResult) {
									return {
										status: "failed",
										reason: "Assistant response effects cannot run before response commit.",
										response: canonicalResponse,
									}
								}
								if (committedResult.status !== "completed") return committedResult
								effectsPromise ??= executeEffects()
								return effectsPromise
							},
							release: releaseTaskStep,
						}

						if (options.deferResponseTransaction) {
							deferTaskStepCleanup = true
							return { status: "completed", response: canonicalResponse, transaction }
						}

						const committed = await transaction.commitResponse()
						if (committed.status !== "completed") return committed
						return transaction.executeEffects()
					}

					{
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

						const emptyResponseError = new Error(
							"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
						)
						const retryAttempts = currentItem.retryAttempts ?? {}

						// Reasoning/tool framing is semantic output too. Once the provider
						// has emitted it, replaying the request could duplicate model work;
						// report an explicit incomplete step instead of entering the empty
						// response retry budget.
						if (semanticOutputObserved) {
							await this.restoreRemovedApiUserMessage(removedUserMessage)
							await this.appendAgentTurnEvent({
								type: "response_terminal",
								status: "incomplete",
								reason: "The provider emitted semantic output without a complete assistant response.",
							})
							return {
								status: "incomplete",
								reason: "The provider emitted semantic output without a complete assistant response.",
								response: canonicalResponse,
							}
						}

						const emptyAttempt = (retryAttempts["empty-response"] ?? 0) + 1
						const retryElapsedMs = getRetryElapsedMs()
						const emptyDecision = this.agentRetryPolicy.decide({
							category: "empty-response",
							attempt: emptyAttempt,
							totalAttempt: (currentItem.retryAttempt ?? 0) + 1,
							elapsedMs: retryElapsedMs,
						})

						if (state?.autoApprovalEnabled && emptyDecision.shouldRetry) {
							const automaticRetryDeadline = getAgentRetryDeadline(
								this.agentRetryPolicy.maxElapsedMs,
								retryElapsedMs,
								currentItem.retryDeadline,
							)
							try {
								await this.waitForRetryDecision(
									emptyDecision,
									emptyResponseError,
									stepInterruptionSignal,
									automaticRetryDeadline,
								)
							} catch (retryWaitError) {
								const pendingSteer = this.pendingSteerMessage
								if (pendingSteer) {
									await this.restoreRemovedApiUserMessage(removedUserMessage)
									this.pendingSteerMessage = undefined
									await this.presentSteeringInput(pendingSteer)
									this.resetMistakeRecoveryState()
									stack.push({
										queuedMessageIds: pendingSteer.queuedMessageIds,
										userContent: this.buildUserMessageContent(
											pendingSteer.text,
											pendingSteer.images,
											pendingSteer.queuedMessageIds,
										),
										includeFileDetails: false,
										inputOrigin: pendingSteer.inputOrigin,
										steeringPersistence: mergeSteeringPersistence(
											currentItem,
											pendingSteer.onPersisted,
										),
									})
									continue
								}
								await this.restoreRemovedApiUserMessage(removedUserMessage)
								return {
									status: retryWaitError instanceof ApiStreamDeadlineError ? "exhausted" : "aborted",
									reason:
										retryWaitError instanceof Error
											? retryWaitError.message
											: String(retryWaitError),
									error: retryWaitError,
									response: canonicalResponse,
								}
							}
							// Context recovery may have replaced this turn with a summary and
							// acknowledged new environment events. Preserve its complete saved
							// message, including summary/truncation metadata, for the retry.
							await this.restoreRemovedApiUserMessage(removedUserMessage)
							this.throwIfStepInterrupted(stepInterruptionSignal)
							stack.push({
								queuedMessageIds: currentItem.queuedMessageIds,
								inputOrigin: currentItem.inputOrigin,
								userContent: [],
								includeFileDetails: false,
								retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
								retryCategory: "empty-response",
								retryDeadline: automaticRetryDeadline,
								retryAttempts: { ...retryAttempts, "empty-response": emptyDecision.nextAttempt - 1 },
								userMessageWasRemoved: false,
							})
							continue
						}

						if (!state?.autoApprovalEnabled) {
							const askResponse = await this.ask("api_req_failed", emptyResponseError.message)
							for (const id of (askResponse.queuedMessageIds ?? []).slice().reverse())
								this.messageQueueService.releaseMessage(id)
							if (askResponse.queuedMessageIds?.length) await this.messageQueueService.flush()
							if (this.abort) {
								await this.restoreRemovedApiUserMessage(removedUserMessage)
								return {
									status: "aborted",
									reason: "Retry was cancelled.",
									response: canonicalResponse,
								}
							}
							if (askResponse.response === "yesButtonClicked") {
								await this.say("api_req_retried")
								await this.appendAgentTurnEvent({
									type: "retry",
									attempt: emptyAttempt,
									reason: emptyResponseError.message,
								})
								await this.restoreRemovedApiUserMessage(removedUserMessage)
								this.throwIfStepInterrupted(stepInterruptionSignal)
								stack.push({
									queuedMessageIds: currentItem.queuedMessageIds,
									inputOrigin: currentItem.inputOrigin,
									userContent: [],
									includeFileDetails: false,
									retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
									retryCategory: "empty-response",
									retryAttempts: { ...retryAttempts, "empty-response": emptyAttempt },
									userMessageWasRemoved: false,
								})
								continue
							}
						}

						await this.restoreRemovedApiUserMessage(removedUserMessage)
						if (emptyDecision.exhausted && state?.autoApprovalEnabled) {
							await this.appendAgentTurnEvent({
								type: "response_terminal",
								status: "failed",
								reason: "Empty-response retry budget exhausted.",
							})
							return {
								status: "exhausted",
								reason: "Empty-response retry budget exhausted.",
								response: canonicalResponse,
								error: emptyResponseError,
							}
						}

						await this.say("error", emptyResponseError.message)
						const failureHistoryPersisted = await this.addToApiConversationHistory({
							role: "assistant",
							content: [{ type: "text", text: "Failure: I did not provide a response." }],
						})
						if (!failureHistoryPersisted) {
							const persistenceError = new TaskPersistenceError(
								"The fallback assistant failure response could not be durably saved.",
							)
							await this.appendAgentTurnEvent({
								type: "response_terminal",
								status: "failed",
								reason: persistenceError.message,
							})
							return {
								status: "failed",
								reason: persistenceError.message,
								response: canonicalResponse,
								error: persistenceError,
							}
						}
						return { status: "incomplete", reason: emptyResponseError.message, response: canonicalResponse }
					}

					// If we reach here without continuing, return false (will always be false for now)
					return {
						status: "incomplete",
						reason: "The model did not provide an assistant response.",
						response: this.currentAgentResponse,
					}
				} catch (error) {
					if (!ownsResponseStep()) return supersededResponseResult()
					if (error instanceof LifecycleHookOwnershipError) {
						return { status: "aborted", reason: error.message, error }
					}
					if (taskWasCancelled() && recoverCancelledResponse) {
						return await recoverCancelledResponse()
					}
					if (error instanceof LifecycleHookStoppedError) {
						return { status: "awaiting-user", reason: error.message, response: this.currentAgentResponse }
					}
					// This should never happen since the only thing that can throw an
					// error is the attemptApiRequest, which is wrapped in a try catch
					// that sends an ask where if noButtonClicked, will clear current
					// task and destroy this instance. However to avoid unhandled
					// promise rejection, we will end this loop which will end execution
					// of this instance (see `startTask`).
					return {
						status: this.abort ? "aborted" : "failed",
						reason: error instanceof Error ? error.message : String(error),
						error,
						response: this.currentAgentResponse,
					} // Explicit failure must not look like completion.
				}
			}

			if (this.didComplete) {
				return { status: "completed", response: this.currentAgentResponse }
			}

			// If we exit the while loop normally (stack is empty), report an
			// incomplete step rather than silently completing the task.
			return { status: "incomplete", reason: "No task step was produced.", response: this.currentAgentResponse }
		} catch (error) {
			if (error instanceof LifecycleHookOwnershipError) {
				return { status: "aborted", reason: error.message, error }
			}
			throw error
		} finally {
			if (!deferTaskStepCleanup) releaseTaskStep()
		}
	}

	/**
	 * Converts the current assistant turn into the provider-neutral response
	 * model used by AgentTurnEngine. API history remains Anthropic-shaped; this
	 * view is only the control-flow boundary between Task and the engine.
	 */
	private buildCurrentAgentResponse(): AgentResponse {
		if (this.currentAgentResponse) return this.currentAgentResponse

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

		return createAgentResponse(items)
	}

	/** Replace the parser's preview with the immutable provider-normalized output. */
	private async applyCanonicalAgentResponse(
		response: AgentResponse,
		guard?: CanonicalLifecycleEventGuard,
	): Promise<void> {
		if (guard && !guard()) return
		// Keep this boundary safe for future callers as well as the live stream
		// path. A canonical response must never race a late preview presenter.
		if (guard) await this.drainStreamingPreviews("canonical response", guard)
		else await this.drainStreamingPreviews("canonical response")
		if (guard && !guard()) return
		this.invalidateStreamingPreviewEpoch()
		this.currentAgentResponse = response
		this.assistantMessageContent = []

		for (const item of response.items) {
			if (item.type === "text") {
				this.assistantMessageContent.push({ type: "text", content: item.text, partial: false })
				continue
			}
			if (item.type !== "tool_call") continue

			const toolUse: ToolUse = {
				type: "tool_use",
				id: item.id,
				name: item.name as ToolName,
				params: {},
				partial: false,
				nativeArgs: item.arguments as never,
			}
			this.assistantMessageContent.push(toolUse)
		}

		this.currentStreamingContentIndex = 0
		this.userMessageContentReady = response.toolCalls.length === 0
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
		const projectInstructionDiscovery =
			(await provider.getSkillsManager?.(this))?.getProjectInstructionDiscoveryOptions?.() ??
			captureProjectInstructionDiscoveryOptions()
		const settings = {
			todoListEnabled: this.apiConfiguration?.todoListEnabled ?? true,
			useAgentRules,
			enableSubfolderRules: state?.enableSubfolderRules ?? false,
			projectInstructionDiscovery,
			newTaskRequireTodos: vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false),
			isStealthModel: this.api.getModel().info?.isStealthModel,
		}
		const agentInstructionSources = useAgentRules
			? await loadApplicableAgentInstructionSources(
					this.cwd,
					settings.enableSubfolderRules,
					settings.projectInstructionDiscovery,
				)
			: []
		const customInstructionText = await addCustomInstructions(
			baseInstructions,
			state?.customInstructions || "",
			this.cwd,
			mode,
			{
				language: state?.language ?? formatLanguage(vscode.env.language),
				alphaIgnoreInstructions: this.alphaIgnoreController?.getInstructions(),
				settings,
				agentInstructionSources,
			},
		)
		// Include learned context in the frozen aggregate so children do not reread it.
		const memoryContext = await this.getMemoryContext()
		const effectiveText = [customInstructionText, memoryContext].filter(Boolean).join("\n\n")
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

	private async getSystemPrompt(
		stateOverride?: TaskRequestState,
		capturedProvider?: CapturedTaskProvider,
		designHandoffOverride?: TaskDesignHandoff | null,
		modeOverride?: string,
		onInstructionFragments?: (fragments: readonly ApiInstructionFragment[]) => void,
		approvalModeOverride?: ApprovalMode,
	): Promise<string> {
		const apiHandler = capturedProvider?.apiHandler ?? this.api
		const instructionModel = apiHandler.getModel()
		const apiConfiguration = capturedProvider?.apiConfiguration ?? this.effectiveApiConfiguration
		const state = stateOverride ?? (await this.providerRef.deref()?.getState())
		const { mcpEnabled } = state ?? {}
		const isSubagent = this.taskKind === "subagent"
		const projectInstructionDiscovery = isSubagent ? undefined : captureProjectInstructionDiscoveryOptions()
		let mcpHub: McpHub | undefined
		if (
			(!isSubagent || this.subagentContextManifest?.runtimePolicy.authorityModel === "parent") &&
			(mcpEnabled ?? true)
		) {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			// The provider initializes MCP in the background. A task should use the
			// currently ready hub, if any, but must not wait up to ten seconds for MCP
			// configuration or connections before its first model request.
			mcpHub = provider.getMcpHub()
		}

		const alphaIgnoreInstructions = this.alphaIgnoreController?.getInstructions()

		const { customModes, customModePrompts, customInstructions, experiments, language, enableSubfolderRules } =
			state ?? {}
		const mode = modeOverride ?? (await this.getTaskMode())
		const subagentAncestry = this.subagentContextManifest?.orchestration?.ancestry
		const effectiveSubagentDelegationPolicy = resolveSubagentDelegationPolicy({
			settingsPolicy: undefined,
			frozenTaskPolicy:
				this.subagentContextManifest?.orchestration?.delegationPolicy.policy ?? this.subagentDelegationPolicy,
			// Retired proactive preferences cannot widen an existing task's
			// captured delegation authority.
			requestedChildPolicy: "explicit-only",
			taskExplicitlyEnabled: this.subagentDelegationExplicitlyEnabled === true,
		}).policy
		const subagentCanDelegate = Boolean(
			isSubagent &&
				this.subagentContextManifest?.runtimePolicy.delegate === true &&
				subagentAncestry &&
				this.getTaskAllowedToolNames()?.includes("spawn_agent"),
		)
		const frozenSubagentInstructions = isSubagent ? await this.getFrozenSubagentInstructions() : undefined
		const memoryContext = isSubagent ? undefined : await this.getMemoryContext()

		const promptFragments = await (async () => {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider not available")
			}

			const modelInfo = apiHandler.getModel().info
			const codexRootDelegationAvailable =
				!isSubagent &&
				this.shouldExposeAgentLifecycleTools() &&
				this.isToolAllowedForTask("spawn_agent") &&
				filterNativeToolsForMode([createSpawnAgentTool()], mode, customModes, experiments, undefined, {
					modelInfo,
					disabledTools: this.getDisabledToolsForStep(state),
				}).some((tool) => tool.type === "function" && tool.function.name === "spawn_agent")

			return SYSTEM_PROMPT_FRAGMENTS(
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
				alphaIgnoreInstructions,
				{
					todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
					useAgentRules:
						vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
					enableSubfolderRules: enableSubfolderRules ?? false,
					projectInstructionDiscovery,
					memoryContext,
					skillCatalogContextWindow: modelInfo?.contextWindow,
					newTaskRequireTodos: vscode.workspace
						.getConfiguration(Package.name)
						.get<boolean>("newTaskRequireTodos", false),
					isStealthModel: modelInfo?.isStealthModel,
					approvalMode: approvalModeOverride ?? migrateApprovalMode(state),
					commandShell: getCommandShell(
						(isSubagent &&
							(this.subagentRole === "worker" || this.subagentContextManifest?.runtimePolicy.execute)) ||
							(state?.terminalShellIntegrationDisabled ?? true),
						BaseTerminal.getExecaShellPath(),
					),
					codexRootDelegationAvailable,
					subagentRole: isSubagent ? this.subagentRole : undefined,
					subagentInheritsPermissions:
						isSubagent && this.subagentContextManifest?.runtimePolicy.authorityModel === "parent",
					subagentHasInheritedSkills: isSubagent
						? Boolean(this.subagentContextManifest?.skills.length)
						: undefined,
					subagentUsesFrozenContext: isSubagent ? this.subagentContextManifest !== undefined : undefined,
					subagentFrozenInstructions: frozenSubagentInstructions,
					subagentCanDelegate: isSubagent ? subagentCanDelegate : undefined,
					subagentDelegationPolicy: effectiveSubagentDelegationPolicy,
				},
				undefined, // todoList
				instructionModel.instructionModelId ?? instructionModel.id,
				isSubagent ? undefined : await provider.getSkillsManager(this, projectInstructionDiscovery),
			)
		})()

		const designHandoff = designHandoffOverride === null ? undefined : (designHandoffOverride ?? this.designHandoff)
		const handoffPrompt =
			this.taskKind === "primary" && mode === defaultModeSlug
				? getDesignHandoffPrompt(designHandoff, {
						taskId: this.taskId,
					})
				: undefined
		const systemPrompt = renderSystemPromptFragments(promptFragments)
		const completePrompt = handoffPrompt ? `${systemPrompt}\n\n${handoffPrompt.text}` : systemPrompt
		const redactedPrompt = redactTaskPrivatePaths(this, completePrompt)
		if (onInstructionFragments) {
			const parts: ApiInstructionFragment[] = promptFragments.instructionParts.map(
				({ role, content, origin }) => ({
					role,
					content: redactTaskPrivatePaths(this, content),
					origin,
				}),
			)
			if (handoffPrompt) {
				parts.push({
					role: "user",
					content: redactTaskPrivatePaths(this, `\n\n${handoffPrompt.text}`),
					origin: "design-handoff",
				})
			}
			// A replacement crossing a part boundary cannot be represented without changing the request text.
			if (parts.map(({ content }) => content).join("") === redactedPrompt) onInstructionFragments(parts)
		}
		return redactedPrompt
	}

	private async handleContextWindowExceededError(
		retryDeadline?: number,
		failedStep?: CurrentAgentStep,
	): Promise<void> {
		const recoveryGuard = failedStep ? this.captureAgentStepOwnership() : undefined
		const contextRecoveryDeadline = getBoundedRequestDeadline(getApiRequestTimeout(), retryDeadline)
		const contextRecoveryDeadlineScope: ApiDeadlineScope =
			retryDeadline !== undefined && contextRecoveryDeadline === retryDeadline
				? "retry_deadline"
				: "compaction_deadline"
		const taskSignal = this.getTaskLifetimeCancellationSignal()
		const stepSignal = this.stepInterruptionController?.signal
		const contextControl = createLinkedAbortController({
			signal: stepSignal ? AbortSignal.any([taskSignal, stepSignal]) : taskSignal,
			deadline: contextRecoveryDeadline,
			deadlineScope: contextRecoveryDeadlineScope,
		})
		const signal = contextControl.signal
		// Receipt settlement can suspend before write admission while Stop preserves the step identity.
		const canCommitRecovery = () =>
			(!recoveryGuard || recoveryGuard()) &&
			!signal.aborted &&
			(contextRecoveryDeadline === undefined || Date.now() < contextRecoveryDeadline)
		let recoveryProvider: CapturedTaskProvider | undefined
		try {
			const assertRecoveryWithinBudget = () => {
				if (failedStep && this.currentAgentStep !== failedStep) throw new LifecycleHookOwnershipError()
				if (recoveryGuard) this.assertLifecycleHookOwnership(recoveryGuard)
				this.throwIfStepInterrupted(signal)
				throwIfAbsoluteDeadlineExceeded(contextRecoveryDeadline, contextRecoveryDeadlineScope)
			}
			const waitForBoundedRecovery = async <T>(operation: PromiseLike<T>): Promise<T> => {
				const result = await this.waitForRequestControl(
					operation,
					signal,
					contextRecoveryDeadline,
					contextRecoveryDeadlineScope,
				)
				assertRecoveryWithinBudget()
				return result
			}
			assertRecoveryWithinBudget()
			// Codex c92700d session/turn.rs keeps mid-turn compaction on its captured step.
			// Raw request inputs preserve schema values and provider state redacted from diagnostics.
			const capturedProvider = failedStep?.getCapturedProvider?.()
			if (failedStep && !capturedProvider) {
				throw new Error("A captured provider route is required for context recovery.")
			}
			const capturedRequest = failedStep?.getRequest()
			const apiHandler = capturedProvider?.apiHandler ?? this.api
			const apiConfiguration = capturedProvider?.apiConfiguration ?? this.effectiveApiConfiguration
			const compactionApiHandler = capturedProvider
				? capturedProvider.compactionApiHandler
				: this.captureCompactionHandler(apiHandler)
			if (capturedProvider && compactionApiHandler) {
				this.reasoningHandlerUsers.set(
					compactionApiHandler,
					(this.reasoningHandlerUsers.get(compactionApiHandler) ?? 0) + 1,
				)
			}
			this.reasoningHandlerUsers.set(apiHandler, (this.reasoningHandlerUsers.get(apiHandler) ?? 0) + 1)
			recoveryProvider = { apiHandler, apiConfiguration, compactionApiHandler }
			const pendingState = this.providerRef.deref()?.getState()
			const state = pendingState ? await waitForBoundedRecovery(pendingState) : undefined
			assertRecoveryWithinBudget()
			const mode = failedStep?.snapshot.context.mode.slug ?? (await waitForBoundedRecovery(this.getTaskMode()))
			assertRecoveryWithinBudget()

			const { contextTokens } = this.getTokenUsage()
			const model = apiHandler.getModel()
			const modelInfo = model.info

			const maxTokens = getModelReservedOutputTokens({
				modelId: model.id,
				model: modelInfo,
				settings: apiConfiguration,
			})

			const contextWindow = modelInfo.contextWindow

			const { triggerTokens } = getContextLimits(
				contextWindow,
				maxTokens,
				resolveCondenseThreshold(state?.autoCondenseContextPercent ?? 100),
			)

			// Log the context window error for debugging
			console.warn(
				`[Task#${this.taskId}] Context window exceeded for model ${apiHandler.getModel().id}. ` +
					`Current tokens: ${contextTokens}, Context window: ${contextWindow}. ` +
					`Recovering within the configured compaction budget.`,
			)
			let contextManagementUiStarted = false
			let contextRecoveryError: unknown
			let contextRecoveryCleanupError: unknown
			const recoveryAccounting = this.createContextCondenseAccounting()
			try {
				contextManagementUiStarted = true
				const contextStartedMessage = this.providerRef
					.deref()
					?.postMessageToWebview({ type: "condenseTaskContextStarted", text: this.taskId })
				if (contextStartedMessage) await waitForBoundedRecovery(contextStartedMessage)
				assertRecoveryWithinBudget()

				// Build tools for condensing metadata (same tools used for normal API calls).
				const provider = this.providerRef.deref()
				let allTools = capturedRequest?.metadata.tools ?? []
				let allowedFunctionNames = capturedRequest?.metadata.allowedFunctionNames
				if (!failedStep && provider) {
					const toolsResult = await waitForBoundedRecovery(
						buildNativeToolsArrayWithRestrictions({
							provider,
							cwd: this.cwd,
							mode,
							customModes: state?.customModes,
							experiments: state?.experiments,
							apiConfiguration,
							disabledTools: this.getDisabledToolsForStep(state),
							waitForQuestionAnswers:
								getFollowupAutoApprovalTimeoutMs(
									this.approvalStateForAsk(state, this.captureTaskApprovalMode(state)),
								) === 0,
							execution: this.captureToolExecutionPolicy(state),
							modelInfo,
							modelIdentity: createModelToolIdentity(apiConfiguration, model),
							includeAllToolsWithRestrictions: supportsFunctionCallingRestrictions(
								apiConfiguration.apiProvider,
							),
							catalogCache: this.toolCatalogCache,
							discoveryHistory: this.apiConversationHistory,
							signal,
							allowedToolNames: this.getTaskAllowedToolNames(),
							taskKind: this.taskKind,
							diagnosticSession: this.diagnosticSession,
							memoryToolsEnabled: this.shouldExposeMemoryTools(),
							diagnosticSourceTaskId: this.diagnosticSourceTaskId,
							enableAgentLifecycleTools: this.shouldExposeAgentLifecycleTools(),
							crossTaskRole: this.getCrossTaskRole(),
							userRequestText: this.getUserRequestTextForCatalog(),
						}),
					)
					allTools = toolsResult.tools
					allowedFunctionNames = toolsResult.allowedFunctionNames
				}
				assertRecoveryWithinBudget()

				const metadata: ApiHandlerCreateMessageMetadata = {
					mode,
					taskId: this.taskId,
					...(capturedRequest?.metadata.instructionFragments
						? { instructionFragments: capturedRequest.metadata.instructionFragments }
						: {}),
					...(signal ? { signal } : {}),
					...(contextRecoveryDeadline !== undefined
						? { deadline: contextRecoveryDeadline, deadlineScope: contextRecoveryDeadlineScope }
						: {}),
					...(allTools.length > 0
						? {
								tools: allTools,
								tool_choice: capturedRequest?.metadata.tool_choice ?? "auto",
								parallelToolCalls: capturedRequest?.metadata.parallelToolCalls ?? true,
								...(allowedFunctionNames ? { allowedFunctionNames } : {}),
							}
						: {}),
				}
				const countContext = createTokenCountContext(apiHandler, {
					signal,
					remoteDeadline: metadata.deadline,
				})
				const systemPrompt =
					capturedRequest?.systemPrompt ??
					(await waitForBoundedRecovery(this.getSystemPrompt(state, { apiHandler, apiConfiguration })))
				assertRecoveryWithinBudget()
				// Provider rejection forces a real reduction under the same captured settings.
				const truncateResult = await waitForBoundedRecovery(
					manageContext({
						beforeCompact: () => this.runCompactionLifecycleHook("PreCompact", "auto", signal),
						messages: this.apiConversationHistory,
						totalTokens: contextTokens || 0,
						maxTokens,
						contextWindow,
						apiHandler,
						compactionApiHandler: this.getCompactionHandler(apiHandler, compactionApiHandler),
						autoCondenseContext: true,
						autoCondenseContextPercent: state?.autoCondenseContextPercent ?? 100,
						forceCompaction: true,
						systemPrompt,
						taskId: this.taskId,
						metadata,
						countContext,
						observeCost: recoveryAccounting.observeCost,
					}).then((result) => {
						recoveryAccounting.observeCost(result.cost)
						return result
					}),
				)
				assertRecoveryWithinBudget()
				this.logCompactionDiagnostic(
					truncateResult.diagnostic && { stage: "summary", automatic: true, ...truncateResult.diagnostic },
				)
				if (truncateResult.status === "exhausted" || truncateResult.status === "no_progress") {
					const errorCost = this.getCondenseErrorCost(truncateResult.cost)
					if (errorCost !== undefined) {
						await waitForBoundedRecovery(
							this.sayCondenseError(
								truncateResult.error ?? t("common:errors.condense_failed"),
								errorCost,
							),
						)
					}
					throw new ContextRecoveryExhaustedError(truncateResult.error)
				}
				const compactionChangedHistory = truncateResult.messages !== this.apiConversationHistory
				if (compactionChangedHistory) {
					let tokens = await waitForBoundedRecovery(
						this.measureCompactedContext(
							apiHandler,
							systemPrompt,
							metadata,
							truncateResult.targetContextTokens,
							getEffectiveApiHistory(truncateResult.messages),
							countContext,
						),
					)
					if (tokens >= truncateResult.prevContextTokens) {
						throw new ContextRecoveryExhaustedError()
					}
					assertRecoveryWithinBudget()
					// Transcript writes are atomic, generation-owned, and queue-capped. Await
					// their commit instead of racing them so no detached stale snapshot can
					// land after this recovery attempt has already reported cancellation.
					const persisted = await this.overwriteApiConversationHistory(
						truncateResult.messages,
						canCommitRecovery,
					)
					assertRecoveryWithinBudget()
					if (!persisted) {
						throw new Error("Unable to persist forced context truncation before continuing.")
					}
					this.environmentContext.reset()
					await this.refreshEnvironmentContext(state, signal)
					assertRecoveryWithinBudget()
					tokens = await waitForBoundedRecovery(
						this.measureCompactedContext(
							apiHandler,
							systemPrompt,
							metadata,
							Math.max(0, triggerTokens - 1),
							getEffectiveApiHistory(this.apiConversationHistory),
							countContext,
						),
					)
					if (tokens >= truncateResult.prevContextTokens) {
						throw new ContextRecoveryExhaustedError()
					}
					truncateResult.newContextTokens = tokens
					truncateResult.newContextTokensAfterTruncation = tokens
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
					await waitForBoundedRecovery(
						this.say(
							"condense_context",
							undefined /* text */,
							undefined /* images */,
							false /* partial */,
							undefined /* checkpoint */,
							undefined /* progressStatus */,
							{ isNonInteractive: true } /* options */,
							contextCondense,
						),
					)
				} else if (truncateResult.truncationId) {
					// Sliding window truncation occurred (fallback when condensing fails or is disabled)
					const contextTruncation: ContextTruncation = {
						truncationId: truncateResult.truncationId,
						messagesRemoved: truncateResult.messagesRemoved ?? 0,
						prevContextTokens: truncateResult.prevContextTokens,
						newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
					}
					await waitForBoundedRecovery(
						this.say(
							"sliding_window_truncation",
							undefined /* text */,
							undefined /* images */,
							false /* partial */,
							undefined /* checkpoint */,
							undefined /* progressStatus */,
							{
								isNonInteractive: true,
								contextCondenseErrorCost: this.getCondenseErrorCost(truncateResult.cost),
							},
							undefined /* contextCondense */,
							contextTruncation,
						),
					)
				}
				assertRecoveryWithinBudget()
				if (compactionChangedHistory) await this.runCompactionLifecycleHook("PostCompact", "auto", signal)
			} catch (error) {
				contextRecoveryError = error
				throw error
			} finally {
				try {
					await recoveryAccounting.persistUnreportedCost(contextRecoveryError !== undefined)
				} finally {
					if (contextManagementUiStarted && (!recoveryGuard || recoveryGuard())) {
						try {
							const contextFinishedMessage = this.providerRef
								.deref()
								?.postMessageToWebview({ type: "condenseTaskContextResponse", text: this.taskId })
							if (contextFinishedMessage) await waitForBoundedRecovery(contextFinishedMessage)
						} catch (cleanupError) {
							if (contextRecoveryError === undefined) contextRecoveryCleanupError = cleanupError
						}
					}
				}
			}
			if (contextRecoveryCleanupError !== undefined) throw contextRecoveryCleanupError
		} finally {
			contextControl.dispose()
			if (recoveryProvider) {
				this.releaseCompactionHandler(recoveryProvider.compactionApiHandler)
				const users = (this.reasoningHandlerUsers.get(recoveryProvider.apiHandler) ?? 1) - 1
				if (users) this.reasoningHandlerUsers.set(recoveryProvider.apiHandler, users)
				else this.reasoningHandlerUsers.delete(recoveryProvider.apiHandler)
				this.retireReasoningHandler(recoveryProvider.apiHandler)
			}
		}
	}

	/**
	 * Enforce the user-configured provider rate limit.
	 *
	 * NOTE: This is intentionally treated as expected behavior and is surfaced via
	 * the `api_req_rate_limit_wait` say type (not an error).
	 */
	private async maybeWaitForProviderRateLimit(
		retryAttempt: number,
		stateOverride?: TaskRequestState,
		interruptionSignal?: AbortSignal,
		retryDeadline?: number,
	): Promise<void> {
		this.throwIfStepInterrupted(interruptionSignal)
		throwIfAbsoluteDeadlineExceeded(retryDeadline)
		// A task owns a frozen provider profile. Background sub-agents may be
		// routed differently from the foreground profile exposed by getState().
		const rateLimitSeconds = this.apiConfiguration?.rateLimitSeconds ?? 0

		if (rateLimitSeconds <= 0) {
			return
		}

		const laneKey = await this.waitForRequestControl(
			this.getProviderRateLimitLaneKey(stateOverride),
			interruptionSignal,
			retryDeadline,
		)
		this.throwIfStepInterrupted(interruptionSignal)
		throwIfAbsoluteDeadlineExceeded(retryDeadline)
		const existingLane = Task.providerRateLimitLanes.get(laneKey)
		const lane = existingLane ?? { queue: Promise.resolve() }
		if (!existingLane) {
			Task.providerRateLimitLanes.set(laneKey, lane)
		}

		// Append the complete wait-and-reserve operation synchronously after resolving
		// the lane key. This removes the check/wait/set race between concurrent tasks.
		const reservation = lane.queue.then(async () => {
			this.throwIfStepInterrupted(interruptionSignal)
			throwIfAbsoluteDeadlineExceeded(retryDeadline)
			const now = performance.now()
			const timeSinceLastRequest = lane.lastRequestTime === undefined ? Infinity : now - lane.lastRequestTime
			const remainingMs = Math.max(0, rateLimitSeconds * 1000 - timeSinceLastRequest)
			const rateLimitDelay = Math.ceil(Math.min(rateLimitSeconds, remainingMs / 1000))

			if (rateLimitDelay > 0) {
				const plannedWaitMs = retryAttempt === 0 ? rateLimitDelay * 1000 : remainingMs
				if (retryAttempt === 0) {
					try {
						for (let i = rateLimitDelay; i > 0; i--) {
							// Send structured JSON data for i18n-safe transport.
							const delayMessage = JSON.stringify({ seconds: i })
							await this.waitForRequestControl(
								this.say("api_req_rate_limit_wait", delayMessage, undefined, true),
								interruptionSignal,
								retryDeadline,
							)
							await this.waitForProviderPacingDelay(1000, interruptionSignal, retryDeadline)
						}
					} finally {
						// Never let a stalled UI/persistence acknowledgement strand the shared
						// provider lane after cancellation or deadline exhaustion.
						await this.waitForRequestControl(
							this.say("api_req_rate_limit_wait", undefined, undefined, false),
							interruptionSignal,
							retryDeadline,
						)
					}
				} else {
					// Retry flows announce their own backoff. Still enforce any remainder
					// introduced by another request on this lane without a second countdown.
					await this.waitForProviderPacingDelay(remainingMs, interruptionSignal, retryDeadline)
				}
				this.requestPacingWaitCount++
				this.requestPacingWaitMs += plannedWaitMs
			}

			this.throwIfStepInterrupted(interruptionSignal)
			throwIfAbsoluteDeadlineExceeded(retryDeadline)
			lane.lastRequestTime = performance.now()
		})

		lane.queue = reservation.catch(() => undefined)
		if (!interruptionSignal && retryDeadline === undefined) {
			await reservation
			return
		}

		await this.waitForRequestControl(reservation, interruptionSignal, retryDeadline)
	}

	private async waitForProviderPacingDelay(
		delayMs: number,
		interruptionSignal?: AbortSignal,
		retryDeadline?: number,
	): Promise<void> {
		this.throwIfStepInterrupted(interruptionSignal)
		throwIfAbsoluteDeadlineExceeded(retryDeadline)
		// An elapsed pacing delay is zero, unlike an unspecified request timeout.
		if (delayMs <= 0) return

		if (retryDeadline !== undefined) {
			const boundedDelayMs = getTimeoutWithinDeadline(delayMs, retryDeadline)
			await delayWithAbort(boundedDelayMs ?? 0, interruptionSignal)
			this.throwIfStepInterrupted(interruptionSignal)
			if (boundedDelayMs !== delayMs) {
				throw new ApiStreamDeadlineError("Automatic retry deadline exceeded", "retry_deadline")
			}
			throwIfAbsoluteDeadlineExceeded(retryDeadline)
			return
		}

		await delayWithAbort(delayMs, interruptionSignal)
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

	public async *attemptApiRequest(retryAttempt = 0, options: TaskRequestOptions = {}): ApiStream {
		const retained = options.retryCategory === "transport" || options.retryCategory === "rate-limit"
		const retainedStep = options.recoveryStep ?? (retained ? this.currentAgentStep : undefined)
		const captured = retainedStep?.getCapturedProvider?.()
		const requestHandler = captured?.apiHandler ?? retainedStep?.snapshot.runtime.getHandler() ?? this.api
		const apiConfiguration = captured?.apiConfiguration ?? this.effectiveApiConfiguration
		const compactionApiHandler = this.captureCompactionHandler(requestHandler)
		this.reasoningHandlerUsers.set(requestHandler, (this.reasoningHandlerUsers.get(requestHandler) ?? 0) + 1)
		try {
			yield* this.attemptCapturedApiRequest(retryAttempt, options, {
				apiHandler: requestHandler,
				compactionApiHandler,
				apiConfiguration,
				profileConfiguration: captured
					? captured.profileConfiguration
					: snapshotProviderSettings(this.apiConfiguration),
				apiConfigName: captured ? captured.apiConfigName : this._taskApiConfigName,
				profileId: captured ? captured.profileId : this.getTaskProviderProfileId(),
			})
		} finally {
			this.releaseCompactionHandler(compactionApiHandler)
			const users = (this.reasoningHandlerUsers.get(requestHandler) ?? 1) - 1
			if (users) this.reasoningHandlerUsers.set(requestHandler, users)
			else this.reasoningHandlerUsers.delete(requestHandler)
			for (const handler of this.retainedReasoningHandlers) this.retireReasoningHandler(handler)
		}
	}

	private async *attemptCapturedApiRequest(
		retryAttempt: number,
		options: TaskRequestOptions,
		capturedProvider: CapturedTaskProvider,
	): ApiStream {
		const goalStep = this.activeGoalStep
		const goalAdmission = this.goalHostAdmission
		const stepInterruptionSignal = options.interruptionSignal
		this.throwIfStepInterrupted(stepInterruptionSignal)
		throwIfAbsoluteDeadlineExceeded(options.retryDeadline)
		const assertPreflightWithinBudget = () => {
			this.throwIfStepInterrupted(stepInterruptionSignal)
			throwIfAbsoluteDeadlineExceeded(options.retryDeadline)
		}
		const waitForBoundedPreflight = <T>(operation: PromiseLike<T>): Promise<T> =>
			this.waitForRequestControl(operation, stepInterruptionSignal, options.retryDeadline)
		let compatibilityRetryStartedAt: number | undefined
		const retainedStep =
			options.recoveryStep ??
			(options.retryCategory === "transport" || options.retryCategory === "rate-limit"
				? this.currentAgentStep
				: undefined)
		const retainedRequest = retainedStep?.getRequest()
		const pendingState = options.state === undefined ? this.providerRef.deref()?.getState() : undefined
		const state = options.state ?? (pendingState ? await waitForBoundedPreflight(pendingState) : undefined)
		assertPreflightWithinBudget()
		const capturedExecution =
			retainedStep?.surface?.policy.execution ??
			retainedStep?.snapshot.context.policy.execution ??
			this.captureToolExecutionPolicy(state)
		const capturedApprovalMode =
			retainedStep?.snapshot.context.policy.approval.mode ?? this.captureTaskApprovalMode(state)
		const waitForQuestionAnswers =
			getFollowupAutoApprovalTimeoutMs(this.approvalStateForAsk(state, capturedApprovalMode)) === 0
		const capturedReviewPolicy = retainedStep
			? (retainedStep.snapshot.context.policy.approval.reviewPolicy ?? CLOSED_TOOL_REVIEW_POLICY)
			: captureToolReviewPolicy(this.approvalStateForAsk(state, capturedApprovalMode))
		const capturedApprovalFlags = deriveAutoApprovalFlags(capturedApprovalMode, {
			alwaysAllowWriteProtected: state?.alwaysAllowWriteProtected === true,
			alwaysAllowMcp: state?.alwaysAllowMcp === true,
		})
		const capturedAutoApprovalPolicy = this.providerRef
			.deref()
			?.snapshotSubagentAutoApprovalPolicy?.({ ...state, approvalMode: capturedApprovalMode }, true)

		const {
			autoApprovalEnabled,
			requestDelaySeconds,
			autoCondenseContext = true,
			autoCondenseContextPercent = 100,
			autoCondenseContextScope = "full-context",
		} = state ?? {}
		const prefillContextTokens =
			autoCondenseContextScope === "after-prefix" ? this.getCompactionWindowPrefillTokens() : undefined
		const mode = retainedStep?.snapshot.context.mode.slug ?? (await waitForBoundedPreflight(this.getTaskMode()))
		assertPreflightWithinBudget()
		if (goalStep) {
			goalStep.executionMode = mode === "code" ? "code" : "architect"
			goalStep.accountElapsed = goalStep.goalTaskId === this.taskId && mode === "code"
			if (mode !== "code") {
				goalStep.responseAccounted = true
				goalStep.finished = true
			}
		}
		const capturedDesignHandoff =
			this.taskKind === "primary" && mode === defaultModeSlug ? structuredClone(this.designHandoff) : undefined
		const { apiHandler: requestHandler } = capturedProvider
		// Preflight, dispatch and retries use the handler captured at admission.
		if (!requestHandler) {
			throw new Error("A captured provider handler is required to retry an agent step.")
		}

		// Get condensing configuration for automatic triggers.
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE

		if (!options.skipProviderRateLimit) {
			await this.maybeWaitForProviderRateLimit(retryAttempt, state, stepInterruptionSignal, options.retryDeadline)
		}
		assertPreflightWithinBudget()
		if (!retainedStep && requestHandler.prepareModel) {
			await waitForBoundedPreflight(
				this.prepareCapturedReasoning(capturedProvider, {
					signal: stepInterruptionSignal,
					deadline: options.retryDeadline,
				}),
			)
			assertPreflightWithinBudget()
		}
		const { apiConfiguration } = capturedProvider
		let instructionFragments: readonly ApiInstructionFragment[] | undefined
		const systemPrompt =
			retainedRequest?.systemPrompt ??
			(await waitForBoundedPreflight(
				this.getSystemPrompt(
					state,
					{ apiHandler: requestHandler, apiConfiguration },
					capturedDesignHandoff ?? null,
					mode,
					(fragments) => {
						instructionFragments = fragments
					},
					capturedApprovalMode,
				),
			))
		assertPreflightWithinBudget()
		const { contextTokens } = this.getTokenUsage()
		let compactedContextLimit: number | undefined
		let contextTokensBeforeCompaction: number | undefined
		let contextCount: TokenCountContext | undefined

		// A retained transport attempt must not compact or reinterpret a different
		// live transcript under the old logical identity. Recovery captures a new step.
		if (contextTokens && !retainedStep) {
			const apiHandler = requestHandler
			const model = apiHandler.getModel()
			const modelInfo = model.info
			const contextManagementTimeoutMs = getApiRequestTimeout()
			const contextManagementDeadline = getBoundedRequestDeadline(
				contextManagementTimeoutMs,
				options.retryDeadline,
			)
			const contextManagementDeadlineScope: ApiDeadlineScope =
				options.retryDeadline !== undefined && contextManagementDeadline === options.retryDeadline
					? "retry_deadline"
					: "compaction_deadline"
			const contextControl = createLinkedAbortController({
				deadline: contextManagementDeadline,
				deadlineScope: contextManagementDeadlineScope,
			})
			// Keep caller cancellation linked after this phase so the shared token-count
			// context remains cancellable at the final dispatched-request measurement.
			const stepInterruptionSignal = AbortSignal.any([
				contextControl.signal,
				options.interruptionSignal ?? this.getTaskLifetimeCancellationSignal(),
			])
			const assertPreflightWithinBudget = () => {
				throwIfAbsoluteDeadlineExceeded(options.retryDeadline)
				this.throwIfStepInterrupted(stepInterruptionSignal)
				throwIfAbsoluteDeadlineExceeded(contextManagementDeadline, contextManagementDeadlineScope)
			}
			const waitForBoundedPreflight = async <T>(operation: PromiseLike<T>): Promise<T> => {
				try {
					return await this.waitForRequestControl(
						operation,
						stepInterruptionSignal,
						contextManagementDeadline,
						contextManagementDeadlineScope,
					)
				} catch (error) {
					if (error instanceof ApiStreamDeadlineError) throwIfAbsoluteDeadlineExceeded(options.retryDeadline)
					throw error
				}
			}
			try {
				const maxTokens = getModelReservedOutputTokens({
					modelId: apiHandler.getModel().id,
					model: modelInfo,
					settings: apiConfiguration,
				})

				const contextWindow = modelInfo.contextWindow

				const { allowedTokens, triggerTokens } = getContextLimits(
					contextWindow,
					maxTokens,
					resolveCondenseThreshold(autoCondenseContextPercent),
				)
				const resumeLimit = autoCondenseContext ? Math.max(0, triggerTokens - 1) : allowedTokens
				contextCount = createTokenCountContext(apiHandler, {
					signal: stepInterruptionSignal,
					remoteDeadline: contextManagementDeadline,
				})
				// Check if context management will likely run (threshold check)
				// This allows us to show an in-progress indicator to the user
				// We use the centralized willManageContext helper to avoid duplicating threshold logic
				const lastMessage = this.apiConversationHistory[this.apiConversationHistory.length - 1]
				const lastMessageContent = lastMessage?.content
				let lastMessageTokens = 0
				if (lastMessageContent) {
					lastMessageTokens = Array.isArray(lastMessageContent)
						? await waitForBoundedPreflight(contextCount.countTokens(lastMessageContent, apiHandler))
						: await waitForBoundedPreflight(
								contextCount.countTokens(
									[{ type: "text", text: lastMessageContent as string }],
									apiHandler,
								),
							)
				}
				assertPreflightWithinBudget()

				const contextManagementWillRun = willManageContext({
					totalTokens: contextTokens,
					contextWindow,
					maxTokens,
					autoCondenseContext,
					autoCondenseContextPercent,
					autoCondenseContextScope,
					prefillContextTokens,
					lastMessageTokens,
				})

				let contextManagementUiStarted = false
				let contextManagementError: unknown
				let contextManagementCleanupError: unknown
				const preflightAccounting = this.createContextCondenseAccounting()
				const automaticCondensationStartedAt =
					this.performanceObservabilityEnabled && contextManagementWillRun && autoCondenseContext
						? performance.now()
						: undefined
				let automaticCondensationStatus: Extract<AgentTurnEvent, { type: "task_performance" }>["status"] =
					"failed"
				try {
					// Send condenseTaskContextStarted BEFORE manageContext to show in-progress indicator.
					// Everything after this notification stays under the matching cleanup boundary.
					if (contextManagementWillRun && autoCondenseContext) {
						contextManagementUiStarted = true
						const contextStartedMessage = this.providerRef
							.deref()
							?.postMessageToWebview({ type: "condenseTaskContextStarted", text: this.taskId })
						if (contextStartedMessage) await waitForBoundedPreflight(contextStartedMessage)
						assertPreflightWithinBudget()
					}

					const contextMgmtMetadata: ApiHandlerCreateMessageMetadata = {
						mode,
						taskId: this.taskId,
						...(stepInterruptionSignal ? { signal: stepInterruptionSignal } : {}),
						...(contextManagementDeadline !== undefined
							? { deadline: contextManagementDeadline, deadlineScope: contextManagementDeadlineScope }
							: {}),
					}
					// The preview can differ from the authoritative count. Let manageContext
					// request tool overhead only when needed, retaining it for post-compaction counts.
					const prepareContextMgmtTools = async () => {
						let contextMgmtTools: OpenAI.Chat.ChatCompletionTool[] = []
						let contextMgmtAllowedFunctionNames: string[] | undefined
						const provider = this.providerRef.deref()
						if (provider) {
							const toolsResult = await waitForBoundedPreflight(
								buildNativeToolsArrayWithRestrictions({
									provider,
									cwd: this.cwd,
									mode,
									customModes: state?.customModes,
									experiments: state?.experiments,
									apiConfiguration,
									disabledTools: this.getDisabledToolsForStep(state),
									waitForQuestionAnswers,
									execution: capturedExecution,
									modelInfo,
									modelIdentity: createModelToolIdentity(apiConfiguration, model),
									includeAllToolsWithRestrictions: supportsFunctionCallingRestrictions(
										apiConfiguration.apiProvider,
									),
									catalogCache: this.toolCatalogCache,
									discoveryHistory: this.apiConversationHistory,
									signal: stepInterruptionSignal,
									allowedToolNames: this.getTaskAllowedToolNames(),
									taskKind: this.taskKind,
									diagnosticSession: this.diagnosticSession,
									memoryToolsEnabled: this.shouldExposeMemoryTools(),
									diagnosticSourceTaskId: this.diagnosticSourceTaskId,
									enableAgentLifecycleTools: this.shouldExposeAgentLifecycleTools(),
									crossTaskRole: this.getCrossTaskRole(),
									userRequestText: this.getUserRequestTextForCatalog(),
								}),
							)
							contextMgmtTools = toolsResult.tools
							contextMgmtAllowedFunctionNames = toolsResult.allowedFunctionNames
						}
						const toolsMetadata =
							contextMgmtTools.length > 0
								? {
										tools: contextMgmtTools,
										tool_choice: "auto" as const,
										parallelToolCalls: true,
										...(contextMgmtAllowedFunctionNames
											? { allowedFunctionNames: contextMgmtAllowedFunctionNames }
											: {}),
									}
								: {}
						Object.assign(contextMgmtMetadata, toolsMetadata)
						return toolsMetadata
					}

					// Get files read by Alpha for code folding - only when context management will run
					const contextMgmtFilesReadByAlpha =
						contextManagementWillRun && autoCondenseContext
							? await waitForBoundedPreflight(this.getFilesReadByAlphaSafely("attemptApiRequest"))
							: undefined

					if (contextManagementWillRun && autoCondenseContext) {
						await waitForBoundedPreflight(
							this.publishCanonicalLifecyclePhase("compacting", () => {
								try {
									assertPreflightWithinBudget()
									return true
								} catch {
									return false
								}
							}),
						)
					}
					const truncateResult = await waitForBoundedPreflight(
						manageContext({
							beforeCompact: () =>
								this.runCompactionLifecycleHook("PreCompact", "auto", stepInterruptionSignal),
							messages: this.apiConversationHistory,
							totalTokens: contextTokens,
							maxTokens,
							contextWindow,
							apiHandler,
							compactionApiHandler: this.getCompactionHandler(
								apiHandler,
								capturedProvider.compactionApiHandler,
							),
							autoCondenseContext,
							autoCondenseContextPercent,
							autoCondenseContextScope,
							prefillContextTokens,
							systemPrompt,
							taskId: this.taskId,
							customCondensingPrompt,
							metadata: contextMgmtMetadata,
							prepareTools: prepareContextMgmtTools,
							filesReadByAlpha: contextMgmtFilesReadByAlpha,
							cwd: this.cwd,
							alphaIgnoreController: this.alphaIgnoreController,
							countContext: contextCount,
							observeCost: preflightAccounting.observeCost,
						}).then((result) => {
							preflightAccounting.observeCost(result.cost)
							return result
						}),
					)
					assertPreflightWithinBudget()
					this.logCompactionDiagnostic(
						truncateResult.diagnostic && {
							stage: "summary",
							automatic: true,
							...truncateResult.diagnostic,
						},
					)
					if (truncateResult.status === "exhausted" || truncateResult.status === "no_progress") {
						const errorCost = this.getCondenseErrorCost(truncateResult.cost)
						if (errorCost !== undefined) {
							await waitForBoundedPreflight(
								this.sayCondenseError(
									truncateResult.error ?? t("common:errors.condense_failed"),
									errorCost,
								),
							)
						}
						throw new ContextRecoveryExhaustedError(truncateResult.error)
					}
					const compactionChangedHistory = truncateResult.messages !== this.apiConversationHistory
					if (compactionChangedHistory) {
						let tokens = await waitForBoundedPreflight(
							this.measureCompactedContext(
								apiHandler,
								systemPrompt,
								contextMgmtMetadata,
								truncateResult.targetContextTokens,
								getEffectiveApiHistory(truncateResult.messages),
								contextCount,
							),
						)
						if (tokens >= truncateResult.prevContextTokens) throw new ContextRecoveryExhaustedError()
						assertPreflightWithinBudget()
						// Do not race this generation-owned, queue-capped transcript write.
						// Completing it before surfacing cancellation prevents a detached
						// compaction snapshot from landing after a newer request begins.
						if (!(await this.overwriteApiConversationHistory(truncateResult.messages))) {
							throw new Error("Unable to persist context recovery before continuing.")
						}
						assertPreflightWithinBudget()
						this.environmentContext.reset()
						await this.refreshEnvironmentContext(state, stepInterruptionSignal)
						assertPreflightWithinBudget()
						tokens = await waitForBoundedPreflight(
							this.measureCompactedContext(
								apiHandler,
								systemPrompt,
								contextMgmtMetadata,
								resumeLimit,
								getEffectiveApiHistory(this.apiConversationHistory),
								contextCount,
							),
						)
						if (tokens >= truncateResult.prevContextTokens) throw new ContextRecoveryExhaustedError()
						truncateResult.newContextTokens = tokens
						truncateResult.newContextTokensAfterTruncation = tokens
						compactedContextLimit = resumeLimit
						contextTokensBeforeCompaction = truncateResult.prevContextTokens
					} else if (truncateResult.status === "unchanged" && truncateResult.error) {
						// Failed proactive compaction can retain fitting history, but the
						// final provider content and dynamic tools are rebuilt below. Check
						// that exact request against the safe limit, not the early trigger.
						compactedContextLimit = allowedTokens
					}
					if (truncateResult.error && truncateResult.status !== "reduced") {
						await waitForBoundedPreflight(this.sayCondenseError(truncateResult.error, truncateResult.cost))
						assertPreflightWithinBudget()
					}
					if (
						truncateResult.status === "unchanged" &&
						!truncateResult.error &&
						this.getCondenseErrorCost(truncateResult.cost) !== undefined
					) {
						await waitForBoundedPreflight(
							this.say(
								"condense_context",
								undefined,
								undefined,
								false,
								undefined,
								undefined,
								{ isNonInteractive: true },
								{
									outcome: "unchanged",
									cost: truncateResult.cost,
									summary: "",
									prevContextTokens: truncateResult.prevContextTokens,
									newContextTokens:
										truncateResult.newContextTokens ?? truncateResult.prevContextTokens,
								},
							),
						)
						assertPreflightWithinBudget()
					} else if (truncateResult.summary) {
						const { summary, cost, prevContextTokens, newContextTokens = 0, condenseId } = truncateResult
						const contextCondense: ContextCondense = {
							summary,
							cost,
							newContextTokens,
							prevContextTokens,
							condenseId,
						}
						await waitForBoundedPreflight(
							this.say(
								"condense_context",
								undefined /* text */,
								undefined /* images */,
								false /* partial */,
								undefined /* checkpoint */,
								undefined /* progressStatus */,
								{ isNonInteractive: true } /* options */,
								contextCondense,
							),
						)
						assertPreflightWithinBudget()
					} else if (truncateResult.truncationId) {
						// Sliding window truncation occurred (fallback when condensing fails or is disabled)
						const contextTruncation: ContextTruncation = {
							truncationId: truncateResult.truncationId,
							messagesRemoved: truncateResult.messagesRemoved ?? 0,
							prevContextTokens: truncateResult.prevContextTokens,
							newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
						}
						await waitForBoundedPreflight(
							this.say(
								"sliding_window_truncation",
								undefined /* text */,
								undefined /* images */,
								false /* partial */,
								undefined /* checkpoint */,
								undefined /* progressStatus */,
								{
									isNonInteractive: true,
									contextCondenseErrorCost: this.getCondenseErrorCost(truncateResult.cost),
								},
								undefined /* contextCondense */,
								contextTruncation,
							),
						)
						assertPreflightWithinBudget()
					}
					automaticCondensationStatus = "completed"
					if (compactionChangedHistory)
						await this.runCompactionLifecycleHook("PostCompact", "auto", stepInterruptionSignal)
				} catch (error) {
					contextManagementError = error
					// Once the compacted history and receipt are saved, a post-hook cannot undo that effect.
					if (automaticCondensationStatus !== "completed") {
						automaticCondensationStatus =
							error instanceof LifecycleHookStoppedError ||
							(error instanceof Error && error.name === "AbortError")
								? "cancelled"
								: "failed"
					}
					throw error
				} finally {
					try {
						await preflightAccounting.persistUnreportedCost(contextManagementError !== undefined)
					} finally {
						if (contextManagementUiStarted) {
							try {
								const contextFinishedMessage = this.providerRef
									.deref()
									?.postMessageToWebview({ type: "condenseTaskContextResponse", text: this.taskId })
								if (contextFinishedMessage) await waitForBoundedPreflight(contextFinishedMessage)
							} catch (cleanupError) {
								// Preserve the initiating failure; cleanup has the same absolute budget
								// and must never replace the actionable cancellation/deadline cause.
								if (contextManagementError === undefined) {
									contextManagementCleanupError = cleanupError
									automaticCondensationStatus = "failed"
								}
							}
						}
						if (automaticCondensationStartedAt !== undefined) {
							this.recordTaskPerformance(
								"condensation",
								automaticCondensationStartedAt,
								automaticCondensationStatus,
							)
						}
					}
				}
				if (contextManagementCleanupError !== undefined) throw contextManagementCleanupError
				assertPreflightWithinBudget()
			} finally {
				contextControl.dispose()
			}
		}

		// Get the effective API history by filtering out condensed messages
		// This allows non-destructive condensing where messages are tagged but not deleted,
		// enabling accurate rewind operations while still sending condensed history to the API.
		let cleanConversationHistory: ReturnType<Task["buildCleanConversationHistory"]>
		if (retainedRequest && !options.recoveryStep) {
			cleanConversationHistory = retainedRequest.messages
		} else {
			const effectiveHistory = getEffectiveApiHistory(this.apiConversationHistory)
			const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)
			// For API only: merge consecutive user messages without mutating stored history.
			const mergedForApi = mergeConsecutiveApiMessages(messagesSinceLastSummary, { roles: ["user"] })
			const messagesWithoutImages = maybeRemoveImageBlocks(mergedForApi, requestHandler)
			cleanConversationHistory = this.buildCleanConversationHistory(messagesWithoutImages as ApiMessage[], {
				apiHandler: requestHandler,
				apiConfiguration,
			})
		}

		// Check auto-approval limits
		const approvalResult = await waitForBoundedPreflight(
			this.autoApprovalHandler.checkAutoApprovalLimits(
				state,
				this.combineMessages(this.alphaMessages.slice(1)),
				async (type, data) => waitForBoundedPreflight(this.ask(type, data)),
				{ currentRequestRecorded: options.ownerHandlesRetry === true },
			),
		)
		assertPreflightWithinBudget()

		if (!approvalResult.shouldProceed) {
			// User did not approve, task should be aborted
			throw new Error("Auto-approval limit reached and user did not approve continuation")
		}

		// Whether we include tools is determined by whether we have any tools to send.
		const model = requestHandler.getModel()
		const modelInfo = model.info

		// Build complete tools array: native tools + dynamic MCP tools
		// When includeAllToolsWithRestrictions is true, returns all tools but provides
		// allowedFunctionNames for providers (like Gemini) that need to see all tool
		// definitions in history while restricting callable tools for the current mode.
		// Only Gemini currently supports this - other providers filter tools normally.
		let allTools: OpenAI.Chat.ChatCompletionTool[] = []
		let allowedFunctionNames: string[] | undefined
		let taskToolSurface: TaskToolSurface | undefined

		// Google transports retain historical declarations, while the captured
		// allow-list and executable surface enforce the current mode's authority.
		const supportsAllowedFunctionNames = supportsFunctionCallingRestrictions(apiConfiguration?.apiProvider)

		if (
			(options.retryCategory === "transport" || options.retryCategory === "rate-limit") &&
			this.currentAgentStep?.surface
		) {
			// Reuse the exact schemas/registry captured for the failed transport
			// attempt. Rebuilding the dynamic MCP catalog here could pair a new
			// provider schema with an old executable surface.
			taskToolSurface = this.currentAgentStep.surface
			allTools = [...taskToolSurface.schemas]
			// The surface stores canonical policy names; the retained provider request
			// stores exact advertised schema names (for example exec_command).
			allowedFunctionNames = retainedRequest?.metadata.allowedFunctionNames
				? [...retainedRequest.metadata.allowedFunctionNames]
				: undefined
		} else {
			const provider = this.providerRef.deref()
			if (!provider) {
				throw new Error("Provider reference lost during tool building")
			}

			const toolsResult = await waitForBoundedPreflight(
				buildNativeToolsArrayWithRestrictions({
					provider,
					cwd: this.cwd,
					mode,
					customModes: state?.customModes,
					experiments: state?.experiments,
					apiConfiguration,
					disabledTools: this.getDisabledToolsForStep(state),
					waitForQuestionAnswers,
					execution: capturedExecution,
					modelInfo,
					modelIdentity: createModelToolIdentity(apiConfiguration, model),
					includeAllToolsWithRestrictions: supportsAllowedFunctionNames,
					catalogCache: this.toolCatalogCache,
					discoveryHistory: this.apiConversationHistory,
					signal: stepInterruptionSignal,
					approvalMode: capturedApprovalMode,
					autoApprovalEnabled: capturedApprovalFlags.autoApprovalEnabled,
					reviewPolicy: capturedReviewPolicy,
					readGrant: {
						enabled:
							this.taskKind === "primary" &&
							capturedApprovalFlags.autoApprovalEnabled &&
							capturedApprovalFlags.alwaysAllowReadOnly,
						workspaceRoot: this.cwd,
						showIgnoredFiles: state?.showAlphaIgnoredFiles === true,
					},
					allowedToolNames: this.getTaskAllowedToolNames(),
					taskKind: this.taskKind,
					diagnosticSession: this.diagnosticSession,
					memoryToolsEnabled: this.shouldExposeMemoryTools(),
					diagnosticSourceTaskId: this.diagnosticSourceTaskId,
					enableAgentLifecycleTools: this.shouldExposeAgentLifecycleTools(),
					crossTaskRole: this.getCrossTaskRole(),
					userRequestText: this.getUserRequestTextForCatalog(),
				}),
			)
			allTools = toolsResult.tools
			allowedFunctionNames = toolsResult.allowedFunctionNames
			taskToolSurface = toolsResult.surface
		}

		const shouldIncludeTools = allTools.length > 0
		assertPreflightWithinBudget()

		const metadata: ApiHandlerCreateMessageMetadata = {
			...(options.recoveryStep ? retainedRequest?.metadata : {}),
			mode: mode,
			taskId: this.taskId,
			suppressPreviousResponseId: options.recoveryStep ? true : this.skipPrevResponseIdOnce,
			...(retainedRequest?.metadata.instructionFragments || instructionFragments
				? { instructionFragments: retainedRequest?.metadata.instructionFragments ?? instructionFragments }
				: {}),
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

		const requestContextLimit =
			compactedContextLimit ??
			(!retainedStep && capturedDesignHandoff
				? getContextLimits(
						modelInfo.contextWindow,
						getModelReservedOutputTokens({
							modelId: model.id,
							model: modelInfo,
							settings: apiConfiguration,
						}),
						100,
					).allowedTokens
				: undefined)
		if (requestContextLimit !== undefined) {
			// Final schemas and provider conversion can differ from the compaction input.
			// Approved designs are mandatory, including on the first step: measure the
			// complete request instead of silently clipping implementation requirements.
			const tokens = await waitForBoundedPreflight(
				this.measureCompactedContext(
					requestHandler,
					systemPrompt,
					{ ...metadata, signal: stepInterruptionSignal },
					requestContextLimit,
					cleanConversationHistory,
					contextCount,
				),
			)
			if (contextTokensBeforeCompaction !== undefined && tokens >= contextTokensBeforeCompaction) {
				throw new ContextRecoveryExhaustedError()
			}
		}
		assertPreflightWithinBudget()

		const configuredRequestTimeoutMs = getApiRequestTimeout()
		// Codex c92700d resets provider idle waits after each application event.
		// Only an explicit caller/recovery limit bounds a progressing response.
		const requestDeadline = options.retryDeadline
		const requestAdmissionDeadline = getBoundedRequestDeadline(configuredRequestTimeoutMs, requestDeadline)
		const admissionDeadlineScope: ApiDeadlineScope =
			requestDeadline !== undefined && requestAdmissionDeadline === requestDeadline
				? "retry_deadline"
				: "request_deadline"
		const requestTimeoutMs = getTimeoutWithinDeadline(configuredRequestTimeoutMs, requestDeadline)
		// Create an AbortController to allow cancelling the request mid-stream
		const requestController = new AbortController()
		const abortSignal = requestController.signal
		const abortFromStep = () => {
			const reason = stepInterruptionSignal?.reason
			requestController.abort(
				reason instanceof Error && reason.name !== "AbortError"
					? reason
					: new Error("Request cancelled by user"),
			)
		}
		const requestId = (options.recoveryStep ? undefined : retainedStep?.requestId) ?? crypto.randomUUID()
		const attemptId = crypto.randomUUID()
		// A retry reuses its original suppression decision; a newly requested reset
		// belongs to the next logical step and must not be consumed here.
		if (!retainedStep) this.skipPrevResponseIdOnce = false
		const attemptMetadata = {
			requestId,
			attemptId,
			signal: abortSignal,
			...(requestDeadline !== undefined
				? { deadline: requestDeadline, deadlineScope: "retry_deadline" as const }
				: {}),
			...(requestHandler.streamCapabilities ? { streamCapabilities: requestHandler.streamCapabilities } : {}),
		}
		const step = this.captureAgentStep(
			retryAttempt,
			systemPrompt,
			cleanConversationHistory as Anthropic.Messages.MessageParam[],
			allTools,
			allowedFunctionNames,
			{ ...metadata, ...attemptMetadata },
			mode,
			modelInfo,
			taskToolSurface,
			retainedStep,
			{ ...capturedProvider, apiHandler: requestHandler, apiConfiguration },
			capturedDesignHandoff ?? null,
			capturedAutoApprovalPolicy,
			options.recoveryStep !== undefined,
		)
		// Capture step and surface together, including a preflight failure before
		// active request ownership is installed.
		this.currentTaskToolSurface = step.surface
		options.onStepCaptured?.(step)
		if (!retainedStep && step.snapshot.context.policy.approval.mode !== capturedApprovalMode) {
			throw new Error("Captured approval mode differs from the tool policy for this step")
		}
		const request = options.recoveryStep ? step.getRequest() : (retainedRequest ?? step.getRequest())
		const requestMetadata: ApiHandlerCreateMessageMetadata = { ...request.metadata, ...attemptMetadata }
		const lifecyclePreflightIsCurrent = () =>
			this.currentAgentStep === step &&
			!stepInterruptionSignal?.aborted &&
			(requestAdmissionDeadline === undefined || Date.now() < requestAdmissionDeadline)
		const lifecyclePreflight = (async () => {
			await this.ensureCanonicalLifecycleStepStarted(step, lifecyclePreflightIsCurrent)
			if (!lifecyclePreflightIsCurrent()) return
			await this.publishCanonicalLifecyclePhase("working", lifecyclePreflightIsCurrent)
			if (!lifecyclePreflightIsCurrent()) return
			// Optional telemetry captures identity when queued and drains at turn/cancellation fences.
			// Its storage latency must not delay provider admission after the canonical lifecycle above.
			void this.appendAgentTurnEvent(
				{ type: "model_request_started", attempt: retryAttempt + 1, purpose: "task" },
				step.snapshot.context,
			)
			if (!lifecyclePreflightIsCurrent()) return
			void this.appendAgentTurnEvent(
				{ type: "policy_snapshot", digest: taskToolSurface?.policy.digest ?? "", toolCount: allTools.length },
				step.snapshot.context,
			)
		})()
		try {
			await this.waitForRequestControl(
				lifecyclePreflight,
				stepInterruptionSignal,
				requestAdmissionDeadline,
				admissionDeadlineScope,
			)
		} catch (error) {
			this.recordProviderRequestTimeout(error, step)
			throw error
		}
		this.throwIfStepInterrupted(stepInterruptionSignal)
		throwIfAbsoluteDeadlineExceeded(requestDeadline)
		if (this.currentAgentStep !== step) {
			throw new Error("Request lifecycle preflight was superseded by a newer agent step")
		}

		// Install request ownership only after lifecycle preflight has succeeded.
		// A failed/aborted lifecycle await therefore cannot strand an active signal.
		let removeFirstChunkAbortListener: (() => void) | undefined
		const clearOwnedRequestController = () => {
			if (this.currentRequestAbortController === requestController) {
				this.currentRequestAbortController = undefined
			}
		}
		const clearRequestOwnership = () => {
			removeFirstChunkAbortListener?.()
			removeFirstChunkAbortListener = undefined
			stepInterruptionSignal?.removeEventListener("abort", abortFromStep)
			abortSignal.removeEventListener("abort", clearOwnedRequestController)
			if (this.currentRequestAbortController === requestController) {
				this.currentRequestAbortController = undefined
			}
			if (this.currentRequestSignal === abortSignal) {
				this.currentRequestSignal = undefined
			}
		}
		if (stepInterruptionSignal?.aborted) abortFromStep()
		else stepInterruptionSignal?.addEventListener("abort", abortFromStep, { once: true })
		this.currentRequestAbortController = requestController
		this.currentRequestSignal = abortSignal
		this.currentTaskToolSurface = taskToolSurface
		abortSignal.addEventListener("abort", clearOwnedRequestController, { once: true })
		if (abortSignal.aborted) {
			clearRequestOwnership()
			if (this.pendingSteerMessage) throw new SteerRequestInterruptError()
			this.throwIfStepInterrupted(stepInterruptionSignal)
			throw new Error("Request cancelled by user")
		}

		if (goalStep && this.currentAgentStep?.snapshot.context.mode.slug !== "architect") {
			try {
				await goalStep.controller.get()
			} catch (error) {
				clearRequestOwnership()
				throw error
			}
		}
		if (
			(goalStep &&
				this.currentAgentStep?.snapshot.context.mode.slug !== "architect" &&
				!goalStep.controller.isRequestCurrent(goalStep.goalId, goalStep.requestGeneration)) ||
			(goalAdmission && !goalAdmission.isStillCurrent())
		) {
			clearRequestOwnership()
			this.goalRequestAdmissionRevoked = true
			yield createApiStreamOutcome({
				status: "incomplete",
				reason: "Goal request admission was revoked before provider execution.",
			})
			return
		}
		let stream: ApiStream
		try {
			if (this.performanceRequestPending && this.performanceSubmissionStartedAt !== undefined) {
				this.recordTaskPerformance(this.performanceRequestPhase, this.performanceSubmissionStartedAt)
				this.performanceRequestPending = false
				this.performanceSubmissionStartedAt = undefined
			}
			stream = requestHandler.createMessage(request.systemPrompt, request.messages, requestMetadata)
		} catch (error) {
			clearRequestOwnership()
			throw error
		}
		const iterator = stream[Symbol.asyncIterator]()
		let activeRequestStep = step
		let streamCompleted = false
		let streamFailure: unknown

		try {
			try {
				// Awaiting first chunk to see if it will throw an error.
				this.isWaitingForFirstChunk = true

				// Race between the first chunk and the abort signal
				const firstChunkPromise = iterator.next()
				const abortPromise = new Promise<never>((_, reject) => {
					const onFirstChunkAbort = () => {
						reject(
							this.pendingSteerMessage
								? new SteerRequestInterruptError()
								: abortSignal.reason instanceof Error && abortSignal.reason.name !== "AbortError"
									? abortSignal.reason
									: new Error("Request cancelled by user"),
						)
					}
					if (abortSignal.aborted) {
						onFirstChunkAbort()
					} else {
						abortSignal.addEventListener("abort", onFirstChunkAbort, { once: true })
						removeFirstChunkAbortListener = () =>
							abortSignal.removeEventListener("abort", onFirstChunkAbort)
					}
				})

				const firstChunk = await withApiRequestTimeout(
					// abortPromise owns normalized user/steer cancellation; this guard owns only the deadline.
					this.waitForRequestControl(
						Promise.race([firstChunkPromise, abortPromise]),
						undefined,
						requestDeadline,
					),
					`API response stream for ${step.snapshot.context.provider.modelId}`,
					requestTimeoutMs,
					() => {
						requestController.abort(
							requestDeadline !== undefined && Date.now() >= requestDeadline
								? new ApiStreamDeadlineError("Automatic retry deadline exceeded", "retry_deadline")
								: new ApiRequestTimeoutError("Provider response stream", requestTimeoutMs ?? 0),
						)
					},
				)
				removeFirstChunkAbortListener?.()
				removeFirstChunkAbortListener = undefined
				this.isWaitingForFirstChunk = false
				this.throwIfStepInterrupted(abortSignal)
				streamCompleted = firstChunk.done === true
				yield firstChunk.value
			} catch (error) {
				const failure = abortSignal.reason instanceof ApiStreamDeadlineError ? abortSignal.reason : error
				this.recordProviderRequestTimeout(failure, step)
				this.isWaitingForFirstChunk = false
				clearRequestOwnership()
				if (error instanceof SteerRequestInterruptError) {
					throw error
				}

				// Retry policy and manual retry UX live in the owning Task loop. Mark
				// this as a first-chunk failure so that loop can decide whether to ask
				// the user or schedule a bounded automatic retry; this generator never
				// recursively invokes itself.
				const retryError = failure instanceof Error ? failure : new Error(String(failure))
				const retryMetadata = retryError as Error & {
					firstChunkFailure?: boolean
					retryCategory?: AgentRetryCategory
				}
				retryMetadata.firstChunkFailure = true
				retryMetadata.retryCategory = this.retryCategoryForError(
					failure,
					checkContextWindowExceededError(failure) ? "context" : "transport",
				)

				// A few legacy integrations call this generator directly instead of
				// running the owning Task loop. Keep that surface compatible with the
				// historical first-chunk retry UX, but make it explicitly bounded and
				// iterative. The production loop passes ownerHandlesRetry so it remains
				// the sole policy owner and does not double-delay or replay a step here.
				if (!options.ownerHandlesRetry && autoApprovalEnabled) {
					const compatibilityRetryPolicy = this.agentRetryPolicy ?? new AgentRetryPolicy()
					compatibilityRetryStartedAt ??= performance.now()
					const compatibilityElapsedMs = performance.now() - compatibilityRetryStartedAt
					const compatibilityRetryDeadline = getAgentRetryDeadline(
						compatibilityRetryPolicy.maxElapsedMs,
						compatibilityElapsedMs,
						options.retryDeadline,
					)
					let compatibilityAttempt = Math.max(1, retryAttempt + 1)
					let compatibilityError: unknown = retryError

					while (true) {
						const category = this.retryCategoryForError(compatibilityError, retryMetadata.retryCategory)
						// Context/empty-response recovery needs a new logical boundary owned
						// by the caller, not another replay of this retained wire request.
						if (category !== "transport" && category !== "rate-limit") break
						const decision = compatibilityRetryPolicy.decide({
							category,
							attempt: compatibilityAttempt,
							elapsedMs: performance.now() - compatibilityRetryStartedAt,
							retryAfterMs: this.retryAfterMs(compatibilityError),
							hasSemanticOutput: false,
						})
						if (!decision.shouldRetry) break

						// Preserve the legacy countdown shape for direct callers. The live
						// Task loop uses waitForRetryDecision, which is abort-aware.
						await this.waitForRequestControl(
							this.backoffAndAnnounce(
								compatibilityAttempt - 1,
								compatibilityError,
								compatibilityRetryDeadline,
								stepInterruptionSignal,
								decision.delayMs,
								decision.retryAt,
							),
							stepInterruptionSignal,
							compatibilityRetryDeadline,
						)
						if (this.abort) break

						const compatibilityDeadline = compatibilityRetryDeadline
						this.throwIfStepInterrupted(stepInterruptionSignal)
						throwIfAbsoluteDeadlineExceeded(compatibilityDeadline)
						const compatibilityRequest = step.getRequest()
						const compatibilityController = new AbortController()
						const abortCompatibilityFromStep = () => {
							const reason = stepInterruptionSignal?.reason
							if (!compatibilityController.signal.aborted) {
								compatibilityController.abort(
									reason instanceof Error && reason.name !== "AbortError"
										? reason
										: new Error("Request cancelled by user"),
								)
							}
						}
						if (stepInterruptionSignal?.aborted) abortCompatibilityFromStep()
						else
							stepInterruptionSignal?.addEventListener("abort", abortCompatibilityFromStep, {
								once: true,
							})
						this.currentRequestAbortController = compatibilityController
						this.currentRequestSignal = compatibilityController.signal
						const compatibilityAttemptId = crypto.randomUUID()
						const compatibilityMetadata: ApiHandlerCreateMessageMetadata = {
							...compatibilityRequest.metadata,
							attemptId: compatibilityAttemptId,
							signal: compatibilityController.signal,
							...(compatibilityDeadline !== undefined
								? { deadline: compatibilityDeadline, deadlineScope: "retry_deadline" as const }
								: {}),
							...(requestHandler.streamCapabilities
								? { streamCapabilities: requestHandler.streamCapabilities }
								: {}),
						}
						let compatibilityIterator: AsyncIterator<ApiStreamChunk> | undefined
						let compatibilityStreamCompleted = false
						try {
							this.throwIfStepInterrupted(stepInterruptionSignal)
							const compatibilityStep = this.captureAgentStep(
								compatibilityAttempt,
								systemPrompt,
								cleanConversationHistory as Anthropic.Messages.MessageParam[],
								allTools,
								allowedFunctionNames,
								compatibilityMetadata,
								mode,
								modelInfo,
								taskToolSurface,
								step,
							)
							activeRequestStep = compatibilityStep
							this.currentTaskToolSurface = compatibilityStep.surface
							options.onStepCaptured?.(compatibilityStep)
							const compatibilityStream = requestHandler.createMessage(
								compatibilityRequest.systemPrompt,
								compatibilityRequest.messages,
								compatibilityMetadata,
							)
							compatibilityIterator = compatibilityStream[Symbol.asyncIterator]()
							const nextCompatibilityChunk = async (): Promise<IteratorResult<ApiStreamChunk>> => {
								const readTimeoutMs = getTimeoutWithinDeadline(
									configuredRequestTimeoutMs,
									compatibilityDeadline,
								)
								const nextPromise = compatibilityIterator!.next()
								let removeAbortListener: (() => void) | undefined
								const abortPromise = new Promise<never>((_resolve, reject) => {
									const onAbort = () => {
										reject(
											compatibilityController.signal.reason instanceof Error &&
												compatibilityController.signal.reason.name !== "AbortError"
												? compatibilityController.signal.reason
												: new Error("Request cancelled by user"),
										)
									}
									if (compatibilityController.signal.aborted) {
										onAbort()
									} else {
										compatibilityController.signal.addEventListener("abort", onAbort, {
											once: true,
										})
										removeAbortListener = () =>
											compatibilityController.signal.removeEventListener("abort", onAbort)
									}
								})
								try {
									try {
										return await withApiRequestTimeout(
											Promise.race([nextPromise, abortPromise]),
											`API response stream for ${step.snapshot.context.provider.modelId}`,
											readTimeoutMs,
											() => {
												compatibilityController.abort(
													compatibilityDeadline !== undefined &&
														Date.now() >= compatibilityDeadline
														? new ApiStreamDeadlineError(
																"Automatic retry deadline exceeded",
																"retry_deadline",
															)
														: new ApiRequestTimeoutError(
																"Provider response stream",
																readTimeoutMs ?? 0,
															),
												)
											},
										)
									} catch (error) {
										if (
											compatibilityRetryDeadline !== undefined &&
											Date.now() >= compatibilityRetryDeadline
										) {
											throw new ApiStreamDeadlineError(
												"Automatic retry deadline exceeded",
												"retry_deadline",
											)
										}
										throw error
									}
								} finally {
									removeAbortListener?.()
								}
							}
							this.isWaitingForFirstChunk = true
							let compatibilityChunk = await nextCompatibilityChunk()
							this.isWaitingForFirstChunk = false
							if (compatibilityChunk.done) {
								throw Object.assign(new Error("Provider returned an empty response"), {
									firstChunkFailure: true,
									retryCategory: "empty-response",
								})
							}
							while (!compatibilityChunk.done) {
								yield compatibilityChunk.value
								compatibilityChunk = await nextCompatibilityChunk()
							}
							compatibilityStreamCompleted = true
							return
						} catch (nextError) {
							this.recordProviderRequestTimeout(nextError, activeRequestStep)
							this.isWaitingForFirstChunk = false
							compatibilityError = nextError
							if (nextError instanceof SteerRequestInterruptError) throw nextError
							if (stepInterruptionSignal?.aborted) this.throwIfStepInterrupted(stepInterruptionSignal)
						} finally {
							stepInterruptionSignal?.removeEventListener("abort", abortCompatibilityFromStep)
							if (!compatibilityStreamCompleted) {
								if (!compatibilityController.signal.aborted) {
									compatibilityController.abort(new Error("Compatibility provider request closed"))
								}
								try {
									void Promise.resolve(compatibilityIterator?.return?.(undefined)).catch(
										() => undefined,
									)
								} catch {
									// Iterator cleanup is best effort after the request has already terminated.
								}
							}
							if (this.currentRequestAbortController === compatibilityController) {
								this.currentRequestAbortController = undefined
							}
							if (this.currentRequestSignal === compatibilityController.signal) {
								this.currentRequestSignal = undefined
							}
						}
						compatibilityAttempt = decision.nextAttempt
					}
					throw compatibilityError
				}
				throw retryError
			}

			// No error, so pass every subsequent chunk through without applying the
			// first-chunk retry UX. The surrounding finally also runs if a consumer
			// closes the generator while it is suspended at the first yield.
			while (!streamCompleted) {
				this.throwIfStepInterrupted(abortSignal)
				const chunk = await withApiRequestTimeout(
					this.waitForRequestControl(iterator.next(), abortSignal, requestDeadline),
					`API response stream for ${step.snapshot.context.provider.modelId}`,
					configuredRequestTimeoutMs,
					() =>
						requestController.abort(
							new ApiRequestTimeoutError("Provider response stream", configuredRequestTimeoutMs ?? 0),
						),
				)
				this.throwIfStepInterrupted(abortSignal)
				streamCompleted = chunk.done === true
				if (!chunk.done) yield chunk.value
			}
		} catch (error) {
			this.recordProviderRequestTimeout(error, activeRequestStep)
			streamFailure = error
			throw error
		} finally {
			if (!streamCompleted) {
				if (!abortSignal.aborted) requestController.abort(streamFailure ?? new Error("Provider request closed"))
				// A provider may ignore abort or block return() behind an outstanding read.
				// Request cleanup must not hold the next logical step behind that transport.
				try {
					void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined)
				} catch {
					// Best effort after termination; late cleanup cannot change the owned result.
				}
			}
			clearRequestOwnership()
		}
	}

	// Shared exponential backoff for retries (first-chunk and mid-stream)
	private async backoffAndAnnounce(
		retryAttempt: number,
		error: any,
		retryDeadline?: number,
		interruptionSignal?: AbortSignal,
		maxWaitMs?: number,
		selectedRetryAt?: number,
	): Promise<void> {
		const admittedAt = Date.now()
		const policyRetryAt =
			selectedRetryAt ??
			(typeof maxWaitMs === "number" && Number.isFinite(maxWaitMs)
				? admittedAt + Math.max(0, maxWaitMs)
				: undefined)
		try {
			this.throwIfStepInterrupted(interruptionSignal)
			throwIfAbsoluteDeadlineExceeded(retryDeadline)
			const pendingState = this.providerRef.deref()?.getState()
			const state = pendingState
				? await this.waitForRequestControl(pendingState, interruptionSignal, retryDeadline)
				: undefined
			// Zero explicitly disables the retry countdown. Using `||` here replaced
			// that valid setting with the five-second default on every retry.
			const baseDelay = state?.requestDelaySeconds ?? 5

			let exponentialDelay = Math.min(
				Math.ceil(baseDelay * Math.pow(2, retryAttempt)),
				MAX_EXPONENTIAL_BACKOFF_SECONDS,
			)

			// Respect this task's routed provider-profile lane.
			const rateLimitDelay = await this.waitForRequestControl(
				this.getProviderRateLimitRemainingSeconds(),
				interruptionSignal,
				retryDeadline,
			)

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

			const requestedDelayMs = Math.max(exponentialDelay, rateLimitDelay) * 1000
			// A selected policy deadline includes the provider's minimum retry hint.
			// Countdown publication consumes this wait; it must not restart or shorten it.
			const retryAt = policyRetryAt ?? admittedAt + requestedDelayMs
			let remainingDelayMs = Math.max(0, retryAt - Date.now())
			if (remainingDelayMs <= 0) {
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
			while (remainingDelayMs > 0) {
				// Check abort flag during countdown to allow early exit
				if (this.abort) {
					throw new Error(`[Task#${this.taskId}] Aborted during retry countdown`)
				}
				this.throwIfStepInterrupted(interruptionSignal)
				throwIfAbsoluteDeadlineExceeded(retryDeadline)

				const secondsRemaining = Math.max(1, Math.ceil(remainingDelayMs / 1000))
				await this.waitForRequestControl(
					this.say(
						"api_req_retry_delayed",
						`${headerText}<retry_timer>${secondsRemaining}</retry_timer>`,
						undefined,
						true,
					),
					interruptionSignal,
					retryDeadline,
				)
				const delaySliceMs = Math.min(1000, Math.max(0, retryAt - Date.now()))
				await this.waitForProviderPacingDelay(delaySliceMs, interruptionSignal, retryDeadline)
				remainingDelayMs = Math.max(0, retryAt - Date.now())
			}

			await this.waitForRequestControl(
				this.say("api_req_retry_delayed", headerText, undefined, false),
				interruptionSignal,
				retryDeadline,
			)
		} catch (err) {
			if (err instanceof ApiStreamDeadlineError) throw err
			if (interruptionSignal?.aborted) this.throwIfStepInterrupted(interruptionSignal)
			const message = err instanceof Error ? err.message : String(err)

			if (this.abort && message.includes("Aborted during retry countdown")) {
				return
			}

			throw err
		}
	}

	// Checkpoints

	public async checkpointSave(force: boolean = false, suppressMessage: boolean = false) {
		return checkpointSave(this, force, suppressMessage)
	}

	private buildCleanConversationHistory(
		messages: ApiMessage[],
		capturedProvider?: CapturedTaskProvider,
	): Array<
		Anthropic.Messages.MessageParam | { type: "reasoning"; encrypted_content: string; id?: string; summary?: any[] }
	> {
		const apiHandler = capturedProvider?.apiHandler ?? this.api
		const apiConfiguration = capturedProvider?.apiConfiguration ?? this.effectiveApiConfiguration
		type ReasoningItemForRequest = {
			type: "reasoning"
			encrypted_content: string
			id?: string
			summary?: any[]
		}

		const cleanConversationHistory: (Anthropic.Messages.MessageParam | ReasoningItemForRequest)[] = []
		const projectAssistantContent = (
			content: Anthropic.Messages.ContentBlockParam[],
		): Anthropic.Messages.MessageParam["content"] => {
			if (content.length === 0) return ""
			const first = content[0]
			// Flatten only legacy unmarked text. A source message ID/phase/index
			// belongs to the block and would be discarded by string conversion.
			if (
				content.length === 1 &&
				first.type === "text" &&
				Object.keys(normalizeAssistantMessageMetadata(first)).length === 0
			) {
				return first.text
			}
			return content
		}

		for (const msg of messages) {
			const replayOpaqueState = canReplayMessageProviderState(msg, {
				provider: apiConfiguration.apiProvider ?? "vertex",
				modelId: apiHandler.getModel().id,
			})
			// Opaque replay state stays on its owning protocol. Keep saved history
			// intact when a task changes providers or resumes through another adapter.
			const requestContent = Array.isArray(msg.content)
				? msg.content.filter((block) => {
						if (!replayOpaqueState && isOpaqueProviderContentBlock(block)) return false
						const type = (block as { type: string }).type
						if (type === "vscode_lm_thinking") {
							return msg.role === "assistant" && apiConfiguration.apiProvider === "vscode-lm"
						}
						if (type === "gemini_response") {
							return (
								msg.role === "assistant" &&
								(apiConfiguration.apiProvider === "gemini" ||
									(apiConfiguration.apiProvider === "vertex" &&
										apiHandler.getModel().id.toLowerCase().startsWith("gemini")))
							)
						}
						return true
					})
				: msg.content
			if (
				Array.isArray(requestContent) &&
				requestContent.length === 0 &&
				Array.isArray(msg.content) &&
				msg.content.length > 0
			) {
				continue
			}
			const sourceMetadata =
				msg.role === "assistant"
					? normalizeAssistantMessageMetadata({ id: msg.messageId, phase: msg.phase })
					: {}
			const assistantSourceMetadata = {
				...(sourceMetadata.id !== undefined ? { messageId: sourceMetadata.id } : {}),
				...(sourceMetadata.phase !== undefined ? { phase: sourceMetadata.phase } : {}),
			}
			const persistedVscodeLmMarker = (msg as ApiMessage & { vscodeLmStatefulMarker?: unknown })
				.vscodeLmStatefulMarker
			const vscodeLmMetadata =
				replayOpaqueState &&
				msg.role === "assistant" &&
				apiConfiguration.apiProvider === "vscode-lm" &&
				typeof persistedVscodeLmMarker === "string"
					? { vscodeLmStatefulMarker: persistedVscodeLmMarker }
					: {}

			// Standalone reasoning: send encrypted, skip plain text
			if (msg.type === "reasoning") {
				if (replayOpaqueState && msg.encrypted_content) {
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
				const rawContent = requestContent

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
				if (
					replayOpaqueState &&
					msgWithDetails.reasoning_details &&
					Array.isArray(msgWithDetails.reasoning_details)
				) {
					// Build the assistant message with reasoning_details
					const assistantContent = projectAssistantContent(contentArray)

					// Create message with reasoning_details property
					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
						...assistantSourceMetadata,
						...vscodeLmMetadata,
						reasoning_details: msgWithDetails.reasoning_details,
					} as any)

					continue
				}

				// Embedded reasoning: encrypted (send) or plain text (skip)
				let encryptedReasoningPrefixLength = 0
				while (
					contentArray[encryptedReasoningPrefixLength] &&
					(contentArray[encryptedReasoningPrefixLength] as any).type === "reasoning" &&
					typeof (contentArray[encryptedReasoningPrefixLength] as any).encrypted_content === "string"
				) {
					encryptedReasoningPrefixLength++
				}
				const hasEncryptedReasoning = encryptedReasoningPrefixLength > 0
				const hasPlainTextReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).text === "string"

				if (hasEncryptedReasoning) {
					for (const reasoningBlock of contentArray.slice(0, encryptedReasoningPrefixLength) as any[]) {
						// Send each opaque provider item independently in its original order.
						cleanConversationHistory.push({
							type: "reasoning",
							summary: reasoningBlock.summary ?? [],
							encrypted_content: reasoningBlock.encrypted_content,
							...(reasoningBlock.id ? { id: reasoningBlock.id } : {}),
						})
					}

					// Send assistant message without reasoning
					const remainingContent = contentArray.slice(encryptedReasoningPrefixLength)
					const assistantContent = projectAssistantContent(remainingContent)

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
						...assistantSourceMetadata,
						...vscodeLmMetadata,
					} as Anthropic.Messages.MessageParam)

					continue
				} else if (hasPlainTextReasoning) {
					// Check if the model's preserveReasoning flag is set
					// If true, include the reasoning block in API requests
					// If false/undefined, strip it out (stored for history only, not sent back to API)
					const shouldPreserveForApi = apiHandler.getModel().info.preserveReasoning === true
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (shouldPreserveForApi) {
						// Include reasoning block in the content sent to API
						assistantContent = contentArray
					} else {
						// Strip reasoning out - stored for history only, not sent back to API
						assistantContent = projectAssistantContent(rest)
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
						...assistantSourceMetadata,
						...vscodeLmMetadata,
					} as Anthropic.Messages.MessageParam)

					continue
				}
			}

			// Default path for regular messages (no embedded reasoning)
			if (msg.role) {
				cleanConversationHistory.push({
					role: msg.role,
					content: requestContent as Anthropic.Messages.ContentBlockParam[] | string,
					...assistantSourceMetadata,
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

	public combineMessages(messages: AlphaMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	public getTokenUsage(): TokenUsage {
		return getApiMetrics(this.combineMessages(this.alphaMessages.slice(1)))
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
			this.emit(AlphaCodeEventName.TaskToolFailed, this.taskId, toolName, error)
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
		// Mailbox admission can await persistence before opening the wait. Steering
		// accepted during those awaits must also interrupt this newly created lease.
		else if (this.pendingSteerMessage) controller.abort(new SteerRequestInterruptError())
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
		void name
		void args
		return this.pendingTurnSuspension !== undefined
	}

	private observeSearchLoopStep(response: AgentResponse): void {
		const progressVersion = this.toolRepetitionDetector?.getProgressVersion?.() ?? 0
		const madeProgress = progressVersion !== (this.lastSearchProgressVersion ?? 0)
		this.lastSearchProgressVersion = progressVersion
		const decision = this.searchLoopRecoveryPolicy?.observe(response.toolCalls, { madeProgress })
		if (!decision || decision.action === "continue") return
		if (decision.action === "recover") {
			this.userMessageContent.push({
				type: "text",
				text: formatSearchLoopRecoveryGuidance(decision.attempt),
			})
			return
		}

		this.suspendAfterCurrentTurn(t("common:errors.search_loop_recovery_paused"), "blocked")
	}

	/** Pure admission check; requesting a blocked retry is settled with its terminal receipt. */
	public getToolRetryBlock(name: string, args: unknown): ToolFailureMetadata | undefined {
		return this.toolRepetitionDetector.getRetryBlock?.(name, args)
	}

	public async recordToolCallForStopping(
		name: string,
		args: unknown,
		status: "success" | "error" | "denied" | "cancelled",
		_commandCategory?: string,
		result?: import("../agent/ToolScheduler").ToolSchedulerResult,
		assertOwnership?: () => void,
	): Promise<void> {
		assertOwnership?.()
		// Completion owns its rejection budget. Cancellation must not rejoin an
		// unresolved publisher after its completion wait has already exited.
		if (name === "attempt_completion" || this.abort || this.didComplete) return
		try {
			await this.waitForRequestControl(
				this.pendingCommandVerification,
				this.getTaskLifetimeCancellationSignal(),
				Date.now() + 30_000,
			)
		} catch (error) {
			assertOwnership?.()
			if (this.abort || this.getTaskLifetimeCancellationSignal().aborted) return
			if (error instanceof ApiStreamDeadlineError) {
				this.suspendAfterCurrentTurn(
					"Task remains incomplete: command evidence did not finish persisting within 30 seconds. Resume after the existing operation settles; do not repeat it.",
					"blocked",
				)
				return
			}
			throw error
		}
		assertOwnership?.()
		if (this.abort) return
		const canonicalName = canonicalizeToolName(name)
		const failure = status === "success" ? undefined : normalizeToolFailure(result?.failure)
		const idleAgentWait = name === "wait_agent" && result?.waitOutcome === "idle"
		const argumentRecord =
			args !== null && typeof args === "object" && !Array.isArray(args)
				? (args as Record<string, unknown>)
				: undefined
		if (
			canonicalName === "exec_command" &&
			status === "denied" &&
			result?.status === "denied" &&
			canonicalizeToolName(result.name) === "exec_command" &&
			result.callId &&
			failure?.effectsStarted === "no" &&
			failure.outcome === "known" &&
			(failure.reason === "policy_denied" || failure.reason === "approval_denied")
		) {
			const command =
				typeof argumentRecord?.command === "string"
					? argumentRecord.command
					: typeof argumentRecord?.cmd === "string"
						? argumentRecord.cmd
						: undefined
			const conflictingCommands =
				typeof argumentRecord?.command === "string" &&
				typeof argumentRecord.cmd === "string" &&
				argumentRecord.command !== argumentRecord.cmd
			if (command && !conflictingCommands) {
				const canonicalCommand = unescapeHtmlEntities(command)
				const deniedBeforeInterception =
					failure.reason === "policy_denied" && failure.affectedScope.kind === "capability"
				// Command-rule capability denials precede interception; effective patch denials stay out.
				if (extractApplyPatchCommand(canonicalCommand)?.kind !== "patch" || deniedBeforeInterception) {
					this.recordDeniedCommandAttempt(result.callId, canonicalCommand)
				}
			}
		}
		const commandRead =
			(canonicalName === "write_stdin" && isCommandArtifactRead(argumentRecord)) ||
			(canonicalName === "manage_command" &&
				(argumentRecord?.action === "read" ||
					(name === "read_command_output" && Object.hasOwn(argumentRecord ?? {}, "artifact_id"))))
		const evidence = result?.callId ? this.commandExecutionEvidence.get(result.callId) : undefined
		const scopes = Object.entries(evidence?.verificationVersions ?? {}).map(([changeSetId, scope]) => ({
			changeSetId,
			matchedFiles: scope.matchedFiles,
			kind: scope.kind,
		}))
		const completedCommandFailure =
			(result?.executionStatus === "error" && typeof result.exitCode === "number") ||
			(failure?.reason === "execution_failed" &&
				failure.outcome === "known" &&
				typeof evidence?.exitCode === "number")
		const scopedCheckFailure =
			canonicalName === "exec_command" &&
			completedCommandFailure &&
			evidence?.status === "failed" &&
			scopes.length > 0
		let failureOwnedByCompletion = false
		if (failure) this.lastToolFailure = { toolName: name, failure }
		if (this.completionRecoveryActive || scopedCheckFailure) {
			let completionDecision: CompletionGateDecision
			try {
				completionDecision = await this.waitForRequestControl(
					this.getCompletionGateDecision(),
					this.getTaskLifetimeCancellationSignal(),
					Date.now() + 30_000,
				)
			} catch (error) {
				assertOwnership?.()
				if (this.abort || this.getTaskLifetimeCancellationSignal().aborted) return
				if (error instanceof ApiStreamDeadlineError) {
					this.suspendAfterCurrentTurn(
						"Task remains incomplete: completion evidence was unavailable for 30 seconds. Resume after task persistence recovers; existing tool results are preserved.",
						"blocked",
					)
					return
				}
				throw error
			}
			assertOwnership?.()
			if (completionDecision.classification === "waiting") {
				// A pending command/child cannot exempt immediate reads or empty waits from stall detection.
				if (!idleAgentWait && !commandRead) return
			} else if (completionDecision.allowed) {
				this.resetCompletionRecoveryState()
			} else {
				const metrics = this.getMutableCompletionStageMetrics()
				metrics.repairToolCount++
				const verification =
					args && typeof args === "object" && "verification" in args ? args.verification : undefined
				const associatedIds =
					verification &&
					typeof verification === "object" &&
					"change_set_ids" in verification &&
					Array.isArray(verification.change_set_ids)
						? verification.change_set_ids.filter((id): id is string => typeof id === "string")
						: []
				// The existing file-version budget owns confirmed verification failures. A second,
				// operation-only budget would block a check even after its relevant inputs were repaired.
				failureOwnedByCompletion = scopedCheckFailure
				const exhausted =
					canonicalName === "exec_command" &&
					(this.completionRecovery ??= new CompletionRecovery()).recordCheck(
						completionDecision,
						scopes.length > 0 ? scopes : associatedIds.map((changeSetId) => ({ changeSetId })),
					)
				if (!completionDecision.modelCanResolveRejection || exhausted) {
					metrics.blockedAt = Date.now()
					metrics.settledUsage = this.getTokenUsage()
					metrics.lastReasonCode = exhausted ? "repair_limit" : completionDecision.reasonCode
					this.suspendAfterCurrentTurn(
						`Task remains incomplete and unverified: repair actions did not resolve the remaining obligation. ${completionDecision.message ?? "Required evidence is missing."}`,
					)
					return
				}
			}
		}
		const polling =
			result?.waitOutcome === "active" &&
			(name === "wait_agent" ||
				name === "write_stdin" ||
				(canonicalName === "manage_command" && argumentRecord?.action === "wait"))
		const read = ["read_file", "list_files", "search_files", "codebase_search"].includes(name) || commandRead
		const trustedExploration =
			canonicalName === "exec_command" && status === "success" ? result?.trustedExploration : undefined
		const state = this.providerRef?.deref()?.getVerificationProgressState?.(this)
		const decision = this.toolRepetitionDetector.recordOutcome({
			toolName: name,
			args,
			status,
			kind: polling
				? "poll"
				: read || trustedExploration
					? "read"
					: canonicalName === "exec_command"
						? "check"
						: "other",
			scope: trustedExploration?.scope ?? this.cwd,
			stateFingerprint: state?.stateFingerprint,
			evidenceFingerprint: state?.evidenceFingerprint,
			evidenceFingerprints: getAcceptanceEvidenceFingerprints(this.workContext),
			...(trustedExploration ? { explorationFingerprint: trustedExploration.semanticFingerprint } : {}),
			...(result?.trustedProgress ? { trustedProgress: result.trustedProgress } : {}),
			...(result?.opaqueResultFingerprint ? { opaqueResultFingerprint: result.opaqueResultFingerprint } : {}),
			...(failure && !failureOwnedByCompletion ? { failure } : {}),
			...(result?.executionStatus ? { executionStatus: result.executionStatus } : {}),
		})
		if (decision.failure) {
			// Failure allowance belongs to the operation, not the whole task. An
			// optional failure must leave inspection and supported alternatives usable.
			const guidance = formatToolFailureGuidance(decision.failure)
			if (decision.reason === "failure-capacity") {
				this.suspendAfterCurrentTurn(
					`Task remains incomplete: unresolved operation failures exceeded the bounded recovery record. ${guidance}`,
				)
			} else if (decision.action !== "continue") {
				// The failed operation has a terminal result; a scoped retry block
				// must not suspend independent repair or inspection.
				this.userMessageContent.push({ type: "text", text: guidance })
			}
		} else if (decision.action === "change-strategy") {
			this.userMessageContent.push({
				type: "text",
				text:
					decision.reason === "unconfirmed-progress"
						? "Repeated external calls returned unchanged results. Use existing results, inspect the relevant postcondition if needed, or choose a different approach. Do not repeat a mutation whose outcome is uncertain."
						: idleAgentWait
							? "Repeated waits returned no usable agent update. Use available child results or continue other work; wait again when agent work or parent control is pending."
							: "Several tool results have not shown a recognized state or verification change. Check the results already available, then continue any remaining work with a concrete next action. Report a blocker only when it actually prevents progress.",
			})
		}
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

	public get taskAsk(): AlphaMessage | undefined {
		return this.idleAsk || this.resumableAsk || this.interactiveAsk
	}

	public get queuedMessages(): QueuedMessage[] {
		return this.messageQueueService.visibleMessages ?? this.messageQueueService.messages
	}

	public get tokenUsage(): TokenUsage | undefined {
		if (this.tokenUsageSnapshot && this.tokenUsageSnapshotAt) {
			return this.tokenUsageSnapshot
		}

		this.tokenUsageSnapshot = this.getTokenUsage()
		this.tokenUsageSnapshotAt = this.alphaMessages.at(-1)?.ts

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
