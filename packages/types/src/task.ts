import { z } from "zod"

import { RooCodeEventName } from "./events.js"
import type { RooCodeSettings } from "./global-settings.js"
import type { ClineMessage, QueuedMessage, TokenUsage } from "./message.js"
import type { ProviderSettings } from "./provider-settings.js"
import type { SubagentModelRouteState } from "./subagent.js"
import type { SubagentContextManifest } from "./subagent-context.js"
import type { SubagentDelegationPolicy } from "./subagent-orchestration.js"
import type { ToolUsage, ToolName } from "./tool.js"
import type { StaticAppProperties, GitProperties, TelemetryProperties } from "./telemetry.js"
import type { TodoItem } from "./todo.js"

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
		configuration?: RooCodeSettings,
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
	[RooCodeEventName.TaskCreated]: [task: TaskLike]
	[RooCodeEventName.TaskStarted]: [taskId: string]
	[RooCodeEventName.TaskCompleted]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
	[RooCodeEventName.TaskAborted]: [taskId: string]
	[RooCodeEventName.TaskFocused]: [taskId: string]
	[RooCodeEventName.TaskUnfocused]: [taskId: string]
	[RooCodeEventName.TaskActive]: [taskId: string]
	[RooCodeEventName.TaskInteractive]: [taskId: string]
	[RooCodeEventName.TaskResumable]: [taskId: string]
	[RooCodeEventName.TaskIdle]: [taskId: string]

	[RooCodeEventName.TaskPaused]: [taskId: string]
	[RooCodeEventName.TaskUnpaused]: [taskId: string]
	[RooCodeEventName.TaskSpawned]: [taskId: string]
	[RooCodeEventName.TaskDelegated]: [parentTaskId: string, childTaskId: string]
	[RooCodeEventName.TaskDelegationCompleted]: [parentTaskId: string, childTaskId: string, summary: string]
	[RooCodeEventName.TaskDelegationResumed]: [parentTaskId: string, childTaskId: string]

	[RooCodeEventName.TaskUserMessage]: [taskId: string]

	[RooCodeEventName.TaskTokenUsageUpdated]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]

	[RooCodeEventName.ModeChanged]: [mode: string]
	[RooCodeEventName.ProviderProfileChanged]: [config: { name: string; provider?: string }]
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
	status: TaskStatus
	lifecycle: TaskLifecycleState
	isActive: boolean
	isStreaming: boolean
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
	readonly taskAsk: ClineMessage | undefined
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
	[RooCodeEventName.TaskStarted]: []
	[RooCodeEventName.TaskCompleted]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
	[RooCodeEventName.TaskAborted]: []
	[RooCodeEventName.TaskFocused]: []
	[RooCodeEventName.TaskUnfocused]: []
	[RooCodeEventName.TaskActive]: [taskId: string]
	[RooCodeEventName.TaskInteractive]: [taskId: string]
	[RooCodeEventName.TaskResumable]: [taskId: string]
	[RooCodeEventName.TaskIdle]: [taskId: string]

	// Subtask Lifecycle
	[RooCodeEventName.TaskPaused]: [taskId: string]
	[RooCodeEventName.TaskUnpaused]: [taskId: string]
	[RooCodeEventName.TaskSpawned]: [taskId: string]

	// Task Execution
	[RooCodeEventName.Message]: [{ action: "created" | "updated"; message: ClineMessage }]
	[RooCodeEventName.TaskModeSwitched]: [taskId: string, mode: string]
	[RooCodeEventName.TaskAskResponded]: []
	[RooCodeEventName.TaskUserMessage]: [taskId: string]
	[RooCodeEventName.QueuedMessagesUpdated]: [taskId: string, messages: QueuedMessage[]]

	// Task Analytics
	[RooCodeEventName.TaskToolFailed]: [taskId: string, tool: ToolName, error: string]
	[RooCodeEventName.TaskTokenUsageUpdated]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
}
