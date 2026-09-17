import { z } from "zod"

import { AlphaCodeEventName } from "./events.js"
import type { AlphaCodeSettings } from "./global-settings.js"
import type { AlphaMessage, QueuedMessage, TokenUsage } from "./message.js"
import type { ProviderSettings } from "./provider-settings.js"
import type { SubagentModelRouteState } from "./subagent.js"
import type { SubagentContextManifest } from "./subagent-context.js"
import type { SubagentDelegationPolicy } from "./subagent-orchestration.js"
import type { ToolUsage, ToolName } from "./tool.js"
import type { StaticAppProperties, GitProperties, TelemetryProperties } from "./telemetry.js"
import type { TodoItem } from "./todo.js"
import type { AgentLifecyclePhase } from "./agent-lifecycle.js"
import type { ModelInfo } from "./model.js"

/**
 * TaskProviderLike
 */

export interface TaskProviderLike {
	// Tasks
	getCurrentTask(): TaskLike | undefined
	getRecentTasks(): string[]
	createTask(
		text?: string,
		images?: string[],
		parentTask?: TaskLike,
		options?: CreateTaskOptions,
		configuration?: AlphaCodeSettings,
	): Promise<TaskLike>
	cancelTask(): Promise<void>
	clearTask(): Promise<void>
	resumeTask(taskId: string): void

	// Modes
	getModes(): Promise<{ slug: string; name: string }[]>
	getMode(): Promise<string>
	setMode(mode: string): Promise<void>

	// Provider Profiles
	getProviderProfiles(): Promise<{ name: string; provider?: string }[]>
	getProviderProfile(): Promise<string>
	setProviderProfile(providerProfile: string): Promise<void>

	// Telemetry
	readonly appProperties: StaticAppProperties
	readonly gitProperties: GitProperties | undefined
	getTelemetryProperties(): Promise<TelemetryProperties>
	readonly cwd: string

	// Event Emitter
	on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this

	off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this

	// @TODO: Find a better way to do this.
	postStateToWebview(): Promise<void>
}

export type TaskProviderEvents = {
	[AlphaCodeEventName.TaskCreated]: [task: TaskLike]
	[AlphaCodeEventName.TaskStarted]: [taskId: string]
	[AlphaCodeEventName.TaskCompleted]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
	[AlphaCodeEventName.TaskAborted]: [taskId: string]
	[AlphaCodeEventName.TaskFocused]: [taskId: string]
	[AlphaCodeEventName.TaskUnfocused]: [taskId: string]
	[AlphaCodeEventName.TaskActive]: [taskId: string]
	[AlphaCodeEventName.TaskInteractive]: [taskId: string]
	[AlphaCodeEventName.TaskResumable]: [taskId: string]
	[AlphaCodeEventName.TaskIdle]: [taskId: string]

	[AlphaCodeEventName.TaskPaused]: [taskId: string]
	[AlphaCodeEventName.TaskUnpaused]: [taskId: string]
	[AlphaCodeEventName.TaskSpawned]: [taskId: string]
	[AlphaCodeEventName.TaskDelegated]: [parentTaskId: string, childTaskId: string]
	[AlphaCodeEventName.TaskDelegationCompleted]: [parentTaskId: string, childTaskId: string, summary: string]
	[AlphaCodeEventName.TaskDelegationResumed]: [parentTaskId: string, childTaskId: string]

	[AlphaCodeEventName.TaskUserMessage]: [taskId: string]

	[AlphaCodeEventName.TaskTokenUsageUpdated]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]

	[AlphaCodeEventName.ModeChanged]: [mode: string]
	[AlphaCodeEventName.ProviderProfileChanged]: [config: { name: string; provider?: string }]
}

/**
 * TaskLike
 */

export interface CreateTaskOptions {
	taskId?: string
	/** Create the task without making it the active foreground task. */
	background?: boolean
	/** Workspace root to use for the task execution context. */
	workspacePath?: string
	/** Mode slug to use for this task without changing the foreground UI mode. */
	taskMode?: string
	/** Provider profile name to use for this task without changing the foreground UI profile. */
	taskApiConfigName?: string
	/** Resolved provider settings for this task lane. Internal callers use this to avoid global profile reads. */
	apiConfiguration?: ProviderSettings
	enableCheckpoints?: boolean
	consecutiveMistakeLimit?: number
	experiments?: Record<string, boolean>
	initialTodos?: TodoItem[]
	/** Initial status for the task's history item (e.g., "active" for child tasks) */
	initialStatus?:
		| "active"
		| "delegated"
		| "completed"
		| "blocked"
		| "failed"
		| "cancelled"
		| "timed_out"
		| "interrupted"
	/** Whether to start the task loop immediately (default: true).
	 *  When false, the caller must invoke `task.start()` manually. */
	startTask?: boolean
	/** Keep other live top-level tasks running when this task is created. */
	preserveExisting?: boolean
	/** Internal task kind. Sub-agents are parent-managed task lanes. */
	taskKind?: "primary" | "subagent"
	/** Frozen task-level policy. Descendants may narrow it but cannot widen it without a trusted user-authored override. */
	subagentDelegationPolicy?: SubagentDelegationPolicy
	/** Trusted user-authored opt-in; never populated from model tool arguments. */
	subagentDelegationExplicitlyEnabled?: boolean
	subagentGroupId?: string
	subagentNickname?: string
	subagentRole?: import("./subagent.js").SubagentRole
	subagentModelRoute?: SubagentModelRouteState
	/** Credential-free audit metadata for the context inherited by this managed child. */
	subagentContextManifest?: SubagentContextManifest
	/** New managed children place the frozen inherited instruction body in the system/developer prompt. */
	subagentInstructionPlacement?: "system"
	subagentWriteScope?: string[]
	subagentChangeSet?: import("./subagent.js").SubagentChangeSetState
	/** Scoped authority prepared and approved by the parent delegation. */
	subagentAuthority?: import("./subagent.js").SubagentAuthorityGrant
	/** Original logical workspace used for task-history grouping. */
	historyWorkspacePath?: string
	/** Private execution root used only to redact managed-worktree paths from model-visible output. */
	subagentPrivateWorkspaceRoot?: string
	/** Absolute time after which a sub-agent must stop researching and synthesize its result. */
	subagentResearchDeadlineAt?: number
}
export enum TaskStatus {
	Running = "running",
	Interactive = "interactive",
	Resumable = "resumable",
	Idle = "idle",
	None = "none",
}

export enum TaskLifecycleState {
	Initializing = "initializing",
	Running = "running",
	Waiting = "waiting",
	Completed = "completed",
	Failed = "failed",
	Closing = "closing",
	Closed = "closed",
}

export type CurrentTaskView =
	| {
			type: "newTaskDraft"
	  }
	| {
			type: "task"
			taskId: string
	  }

export interface LiveTaskMetadata {
	id: string
	/** Resolved provider capabilities for this task; absent on older hosts. */
	model?: { id: string; info: ModelInfo }
	status: TaskStatus
	lifecycle: TaskLifecycleState
	isActive: boolean
	isStreaming: boolean
	/** True while any model-step phase (including preflight/compaction) is still running. */
	isTurnActive?: boolean
	/** True when Stop/steer can interrupt the current turn immediately. */
	canInterrupt?: boolean
	/** Canonical phase used for task-scoped progress and stall diagnostics. */
	activityPhase?: AgentLifecyclePhase
	/** A durable steering message has been accepted and is awaiting consumption. */
	hasPendingSteer?: boolean
	isWaitingForInput: boolean
	lastUpdatedAt: number
	waitingReason?: string
	queueCount: number
	tokensIn: number
	tokensOut: number
	totalCost: number
}

export const taskMetadataSchema = z.object({
	task: z.string().optional(),
	images: z.array(z.string()).optional(),
})

export type TaskMetadata = z.infer<typeof taskMetadataSchema>

export interface TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	readonly taskKind?: "primary" | "subagent"
	readonly subagentDelegationPolicy?: SubagentDelegationPolicy
	readonly subagentDelegationExplicitlyEnabled?: boolean
	readonly childTaskId?: string
	readonly metadata: TaskMetadata
	readonly taskStatus: TaskStatus
	readonly taskAsk: AlphaMessage | undefined
	readonly queuedMessages: QueuedMessage[]
	readonly tokenUsage: TokenUsage | undefined

	on<K extends keyof TaskEvents>(event: K, listener: (...args: TaskEvents[K]) => void | Promise<void>): this
	off<K extends keyof TaskEvents>(event: K, listener: (...args: TaskEvents[K]) => void | Promise<void>): this

	approveAsk(options?: { text?: string; images?: string[] }): void
	denyAsk(options?: { text?: string; images?: string[] }): void
	submitUserMessage(text: string, images?: string[], mode?: string, providerProfile?: string): Promise<void>
	abortTask(): void
}

export type TaskEvents = {
	// Task Lifecycle
	[AlphaCodeEventName.TaskStarted]: []
	[AlphaCodeEventName.TaskCompleted]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
	[AlphaCodeEventName.TaskAborted]: []
	[AlphaCodeEventName.TaskFocused]: []
	[AlphaCodeEventName.TaskUnfocused]: []
	[AlphaCodeEventName.TaskActive]: [taskId: string]
	[AlphaCodeEventName.TaskInteractive]: [taskId: string]
	[AlphaCodeEventName.TaskResumable]: [taskId: string]
	[AlphaCodeEventName.TaskIdle]: [taskId: string]

	// Subtask Lifecycle
	[AlphaCodeEventName.TaskPaused]: [taskId: string]
	[AlphaCodeEventName.TaskUnpaused]: [taskId: string]
	[AlphaCodeEventName.TaskSpawned]: [taskId: string]

	// Task Execution
	[AlphaCodeEventName.Message]: [{ action: "created" | "updated"; message: AlphaMessage }]
	[AlphaCodeEventName.TaskModeSwitched]: [taskId: string, mode: string]
	[AlphaCodeEventName.TaskAskResponded]: []
	[AlphaCodeEventName.TaskUserMessage]: [taskId: string]
	[AlphaCodeEventName.QueuedMessagesUpdated]: [taskId: string, messages: QueuedMessage[]]

	// Task Analytics
	[AlphaCodeEventName.TaskToolFailed]: [taskId: string, tool: ToolName, error: string]
	[AlphaCodeEventName.TaskTokenUsageUpdated]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
}
