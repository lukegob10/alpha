import React, { useCallback, useContext, useEffect, useRef, useState } from "react"

import { ExtensionStateContext, ShellStateContext, retainUnchangedExtensionState } from "./ExtensionStateContextStore"

import {
	type ProviderSettings,
	type ProviderSettingsEntry,
	type CustomModePrompts,
	type ModeConfig,
	type ExperimentId,
	type TodoItem,
	type TelemetrySetting,
	type ExtensionMessage,
	type ExtensionState,
	type EditorChatState,
	type ApprovalMode,
	type AlphaMessage,
	type LiveTaskMetadata,
	type MarketplaceInstalledMetadata,
	type SkillMetadata,
	type Command,
	type McpServer,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT,
	normalizeExtensionMessageTranscript,
} from "@alpha-code/types"

import { findLastIndex } from "@alpha/array"

import { checkExistKey } from "@alpha/checkExistApiConfig"
import { Mode, defaultModeSlug, defaultPrompts } from "@alpha/modes"
import { CustomSupportPrompts } from "@alpha/support-prompt"
import { experimentDefault } from "@alpha/experiments"

import { vscode } from "@src/utils/vscode"
import { convertTextMateToHljs } from "@src/utils/textMateToHljs"
import {
	applyLifecycleEventToExtensionState,
	applyLifecycleDegradedToExtensionState,
	applyLifecycleSnapshotToExtensionState,
	applyLifecycleSnapshotsToExtensionState,
	mergeAgentLifecycleDegradedSignals,
	mergeAgentLifecycleSnapshots,
} from "./agentLifecycleState"

export interface ExtensionStateContextType extends ExtensionState {
	managedSteeringDrafts?: Record<string, ManagedSteeringDraft>
	updateManagedSteeringDraft?: (key: string, draft?: ManagedSteeringDraft) => void
	historyPreviewCollapsed?: boolean // Add the new state property
	didHydrateState: boolean
	showWelcome: boolean
	theme: any
	mcpServers: McpServer[]
	currentCheckpoint?: string
	currentTaskTodos?: TodoItem[] // Initial todos for the current task
	filePaths: string[]
	openedTabs: Array<{ label: string; isActive: boolean; path?: string }>
	commands: Command[]
	hasOpenedModeSelector: boolean // New property to track if user has opened mode selector
	setHasOpenedModeSelector: (value: boolean) => void // Setter for the new property
	alwaysAllowFollowupQuestions: boolean // New property for follow-up questions auto-approve
	setAlwaysAllowFollowupQuestions: (value: boolean) => void // Setter for the new property
	followupAutoApproveTimeoutMs: number | undefined // Timeout in ms for auto-approving follow-up questions
	setFollowupAutoApproveTimeoutMs: (value: number) => void // Setter for the timeout
	marketplaceItems?: any[]
	marketplaceInstalledMetadata?: MarketplaceInstalledMetadata
	profileThresholds: Record<string, number>
	setProfileThresholds: (value: Record<string, number>) => void
	setApiConfiguration: (config: ProviderSettings) => void
	setCustomInstructions: (value?: string) => void
	setAlwaysAllowReadOnly: (value: boolean) => void
	setAlwaysAllowReadOnlyOutsideWorkspace: (value: boolean) => void
	setAlwaysAllowWrite: (value: boolean) => void
	setAlwaysAllowWriteOutsideWorkspace: (value: boolean) => void
	setAlwaysAllowWriteProtected: (value: boolean) => void
	setAlwaysAllowExecute: (value: boolean) => void
	setAlwaysAllowMcp: (value: boolean) => void
	setAlwaysAllowSubtasks: (value: boolean) => void
	setAlwaysAllowSubagents: (value: boolean) => void
	setAlwaysAllowTickets: (value: boolean) => void
	setShowAlphaIgnoredFiles: (value: boolean) => void
	setShowAnnouncement: (value: boolean) => void
	setAllowedCommands: (value: string[]) => void
	setDeniedCommands: (value: string[]) => void
	terminalShellIntegrationTimeout?: number
	terminalShellIntegrationDisabled?: boolean
	terminalZdotdir?: boolean
	setTerminalZdotdir: (value: boolean) => void
	checkpointTimeout: number
	terminalOutputPreviewSize?: "small" | "medium" | "large"
	mcpEnabled: boolean
	mode: Mode
	setMode: (value: Mode) => void
	setCustomModePrompts: (value: CustomModePrompts) => void
	setCustomSupportPrompts: (value: CustomSupportPrompts) => void
	enhancementApiConfigId?: string
	setEnhancementApiConfigId: (value: string) => void
	setExperimentEnabled: (id: ExperimentId, enabled: boolean) => void
	setAutoApprovalEnabled: (value: boolean) => void
	setApprovalMode: (value: ApprovalMode) => void
	setApprovalModeBypassAcknowledged: (value: boolean) => void
	customModes: ModeConfig[]
	maxWorkspaceFiles: number
	setTelemetrySetting: (value: TelemetrySetting) => void
	awsUsePromptCache?: boolean
	maxImageFileSize: number
	maxTotalImageSize: number
	machineId?: string
	pinnedApiConfigs?: Record<string, boolean>
	togglePinnedApiConfig: (configName: string) => void
	setHistoryPreviewCollapsed: (value: boolean) => void
	enterBehavior?: "send" | "newline"
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	autoCondenseContextScope: NonNullable<ExtensionState["autoCondenseContextScope"]>
	postTurnCondenseContextPercent: number
	includeDiagnosticMessages?: boolean
	maxDiagnosticMessages?: number
	includeTaskHistoryInEnhance?: boolean
	setIncludeTaskHistoryInEnhance: (value: boolean) => void
	includeCurrentTime?: boolean
	includeCurrentCost?: boolean
	showWorktreesInHomeScreen: boolean
	getCachedTranscriptRevision: (taskId: string) => number | undefined
	skills?: SkillMetadata[]
}

export interface ManagedSteeringDraft {
	parentTaskId: string
	groupId: string
	taskId: string
	text: string
	pendingRequestId?: string
	rejected?: boolean
}

export { ExtensionStateContext, ShellStateContext }

interface CachedTaskTranscript {
	messages: AlphaMessage[]
	revision: number
}

type TaskTranscriptCache = Map<string, CachedTaskTranscript>

const MAX_CACHED_TASK_TRANSCRIPTS = 2

function shouldApplyIncrementalLiveTask(existing: LiveTaskMetadata | undefined, incoming: LiveTaskMetadata): boolean {
	if (!existing) return true
	// Every host message publication advances this task's revision. A state
	// snapshot at the same revision may already contain a later lifecycle boundary.
	if (existing.transcriptRevision !== undefined && incoming.transcriptRevision !== undefined) {
		return incoming.transcriptRevision > existing.transcriptRevision
	}
	return incoming.lastUpdatedAt >= existing.lastUpdatedAt
}

function cacheTaskTranscript(
	cache: TaskTranscriptCache,
	taskId: string | undefined,
	messages: AlphaMessage[],
	revision: number | undefined,
): void {
	if (!taskId || !messages.length || revision === undefined) return
	cache.delete(taskId)
	cache.set(taskId, { messages, revision })
	while (cache.size > MAX_CACHED_TASK_TRANSCRIPTS) {
		const oldestTaskId = cache.keys().next().value
		if (oldestTaskId === undefined) break
		cache.delete(oldestTaskId)
	}
}

function getCachedTaskTranscript(cache: TaskTranscriptCache, taskId: string): CachedTaskTranscript | undefined {
	const cached = cache.get(taskId)
	if (!cached) return undefined
	cache.delete(taskId)
	cache.set(taskId, cached)
	return cached
}

export const mergeExtensionState = (
	prevState: ExtensionState,
	newState: Partial<ExtensionState>,
	transcriptCache?: TaskTranscriptCache,
) => {
	const { customModePrompts: prevCustomModePrompts, experiments: prevExperiments, ...prevRest } = prevState

	const {
		apiConfiguration,
		customModePrompts: newCustomModePrompts,
		customSupportPrompts,
		experiments: newExperiments,
		...newRest
	} = newState

	const customModePrompts = newCustomModePrompts
		? { ...prevCustomModePrompts, ...newCustomModePrompts }
		: prevCustomModePrompts
	const experiments = newExperiments ? { ...prevExperiments, ...newExperiments } : prevExperiments
	const rest = { ...prevRest, ...newRest }
	const agentLifecycleDegraded = mergeAgentLifecycleDegradedSignals(
		prevState.agentLifecycleDegraded,
		newState.agentLifecycleDegraded,
	)

	const hasDedicatedDomainSequence =
		newState.taskStateSeq !== undefined ||
		newState.messageQueueSeq !== undefined ||
		newState.currentTaskTodosSeq !== undefined
	const legacyDomainSequence = hasDedicatedDomainSequence ? undefined : newState.alphaMessagesSeq
	const incomingTaskStateSeq = newState.taskStateSeq ?? legacyDomainSequence
	const incomingQueueSeq = newState.messageQueueSeq ?? legacyDomainSequence
	const incomingTodosSeq = newState.currentTaskTodosSeq ?? legacyDomainSequence
	const previousTaskStateSeq =
		prevState.taskStateSeq ?? (hasDedicatedDomainSequence ? undefined : prevState.alphaMessagesSeq)
	const previousQueueSeq =
		prevState.messageQueueSeq ?? (hasDedicatedDomainSequence ? undefined : prevState.alphaMessagesSeq)
	const previousTodosSeq =
		prevState.currentTaskTodosSeq ?? (hasDedicatedDomainSequence ? undefined : prevState.alphaMessagesSeq)
	const isStale = (incoming: number | undefined, previous: number | undefined) =>
		incoming !== undefined && previous !== undefined && incoming <= previous

	// Transcript, lifecycle, queue, and todos are delivered independently. Guard
	// each domain separately so a tiny queue patch cannot suppress a valid later
	// lifecycle snapshot (or let an older full snapshot erase a newer queue).
	if (isStale(newState.alphaMessagesSeq, prevState.alphaMessagesSeq)) {
		rest.alphaMessages = prevState.alphaMessages
		rest.alphaMessagesSeq = prevState.alphaMessagesSeq
	}

	const taskStateIsStale = isStale(incomingTaskStateSeq, previousTaskStateSeq)
	const patchHasNoTaskStateSequence = hasDedicatedDomainSequence && incomingTaskStateSeq === undefined
	const acceptedTaskSnapshot = !taskStateIsStale && !patchHasNoTaskStateSequence
	// Task maps replace host membership; lifecycle-only state envelopes remain deltas.
	const authoritativeTasks =
		acceptedTaskSnapshot && newState.liveTasksById !== undefined
			? newState.liveTasksById
			: prevState.taskStateSeq !== undefined
				? prevState.liveTasksById
				: undefined
	const agentLifecycleSnapshots = mergeAgentLifecycleSnapshots(
		prevState.agentLifecycleSnapshots,
		taskStateIsStale || patchHasNoTaskStateSequence ? undefined : newState.agentLifecycleSnapshots,
		incomingTaskStateSeq !== undefined && !taskStateIsStale && !patchHasNoTaskStateSequence,
		authoritativeTasks
			? {
					// Compact host metadata supersedes retained legacy lifecycle histories.
					taskIds: new Set(
						Object.keys(authoritativeTasks).filter(
							(taskId) => authoritativeTasks[taskId].hasPendingToolCalls === undefined,
						),
					),
					replaceSnapshots: acceptedTaskSnapshot && newState.liveTasksById !== undefined,
				}
			: undefined,
	)
	if (taskStateIsStale || patchHasNoTaskStateSequence) {
		rest.currentTaskId = prevState.currentTaskId
		rest.taskReasoning = prevState.taskReasoning
		rest.currentTaskItem = prevState.currentTaskItem
		rest.currentView = prevState.currentView
		rest.currentTaskAutoApprovalRestricted = prevState.currentTaskAutoApprovalRestricted
		rest.activeTaskId = prevState.activeTaskId
		rest.liveTaskIds = prevState.liveTaskIds
		rest.liveTasksById = prevState.liveTasksById
		rest.managedAgentTree = prevState.managedAgentTree
		rest.taskStateSeq = prevState.taskStateSeq
	} else if (newState.liveTasksById && prevState.liveTasksById) {
		// State assembly may await managed-agent projections after capturing live
		// metadata. Preserve newer message publications until the host refreshes it.
		let liveTasksById = newState.liveTasksById
		for (const [taskId, incoming] of Object.entries(newState.liveTasksById)) {
			const previous = prevState.liveTasksById[taskId]
			if (
				previous?.transcriptRevision !== undefined &&
				incoming.transcriptRevision !== undefined &&
				incoming.transcriptRevision < previous.transcriptRevision
			) {
				if (liveTasksById === newState.liveTasksById) liveTasksById = { ...liveTasksById }
				liveTasksById[taskId] = previous
			}
		}
		rest.liveTasksById = liveTasksById
	}
	// A late transcript from an older navigation can carry a higher message
	// sequence. Reject it so it cannot replace the task that is now on screen.
	// An equal task sequence is the transcript for the accepted navigation.
	if (
		typeof newState.taskStateSeq === "number" &&
		typeof prevState.taskStateSeq === "number" &&
		newState.taskStateSeq < prevState.taskStateSeq &&
		Object.prototype.hasOwnProperty.call(newState, "alphaMessages")
	) {
		rest.alphaMessages = prevState.alphaMessages
		rest.alphaMessagesSeq = prevState.alphaMessagesSeq
	}

	const targetsDifferentTask =
		newState.currentTaskId !== undefined && newState.currentTaskId !== prevState.currentTaskId
	if (
		acceptedTaskSnapshot &&
		"currentTaskId" in newState &&
		newState.currentTaskId !== prevState.currentTaskId &&
		!("taskReasoning" in newState)
	) {
		rest.taskReasoning = undefined
	}
	if (acceptedTaskSnapshot && "currentTaskId" in newState && newState.currentTaskId == null) {
		rest.currentTaskId = undefined
	}
	if (acceptedTaskSnapshot && "currentTaskItem" in newState && newState.currentTaskItem == null) {
		rest.currentTaskItem = undefined
	}
	if (acceptedTaskSnapshot && "activeTaskId" in newState && newState.activeTaskId == null) {
		rest.activeTaskId = undefined
	}
	// VS Code webview postMessage drops undefined properties, so a new-chat
	// snapshot cannot clear task identity by sending currentTaskId: undefined.
	if (acceptedTaskSnapshot && newState.currentView?.type === "newTaskDraft") {
		if (!("currentTaskId" in newState) || newState.currentTaskId == null) {
			rest.currentTaskId = undefined
		}
		if (!("currentTaskItem" in newState) || newState.currentTaskItem == null) {
			rest.currentTaskItem = undefined
		}
		if (!("activeTaskId" in newState) || newState.activeTaskId == null) {
			rest.activeTaskId = undefined
		}
		if (!("taskReasoning" in newState)) {
			rest.taskReasoning = undefined
		}
	}
	const rejectScopedDomains = targetsDifferentTask && (taskStateIsStale || patchHasNoTaskStateSequence)
	if (rejectScopedDomains) {
		// A consumed-input queue receipt may include its transcript. A late receipt
		// cannot project that transcript onto a chat selected by another navigation.
		rest.alphaMessages = prevState.alphaMessages
		rest.alphaMessagesSeq = prevState.alphaMessagesSeq
	}
	if (rejectScopedDomains || isStale(incomingQueueSeq, previousQueueSeq)) {
		rest.messageQueue = prevState.messageQueue
		rest.messageQueueSeq = prevState.messageQueueSeq
	}
	if (rejectScopedDomains || isStale(incomingTodosSeq, previousTodosSeq)) {
		rest.currentTaskTodos = prevState.currentTaskTodos
		rest.currentTaskTodosSeq = prevState.currentTaskTodosSeq
	}

	// Note that we completely replace the previous apiConfiguration and customSupportPrompts objects
	// with new ones since the state that is broadcast is the entire objects so merging is not necessary.
	const mergedState = {
		...rest,
		apiConfiguration: apiConfiguration ?? prevState.apiConfiguration,
		customModePrompts,
		customSupportPrompts: customSupportPrompts ?? prevState.customSupportPrompts,
		experiments,
		agentLifecycleSnapshots,
		agentLifecycleDegraded,
	}

	if (transcriptCache) {
		const previousTaskId = prevState.currentTaskId
		const currentTaskId = mergedState.currentTaskId
		const taskChanged = previousTaskId !== currentTaskId
		if (taskChanged && previousTaskId) {
			cacheTaskTranscript(
				transcriptCache,
				previousTaskId,
				prevState.alphaMessages,
				prevState.liveTasksById?.[previousTaskId]?.transcriptRevision,
			)
		}

		if (
			taskChanged &&
			currentTaskId &&
			newState.currentTaskId === currentTaskId &&
			Array.isArray(newState.alphaMessages) &&
			newState.alphaMessages.length === 0
		) {
			const cached = getCachedTaskTranscript(transcriptCache, currentTaskId)
			const revision = mergedState.liveTasksById?.[currentTaskId]?.transcriptRevision
			if (cached && revision !== undefined && cached.revision === revision) {
				mergedState.alphaMessages = cached.messages
			}
		}

		if (
			currentTaskId &&
			newState.currentTaskId === currentTaskId &&
			Array.isArray(newState.alphaMessages) &&
			newState.alphaMessages.length > 0
		) {
			cacheTaskTranscript(
				transcriptCache,
				currentTaskId,
				mergedState.alphaMessages,
				mergedState.liveTasksById?.[currentTaskId]?.transcriptRevision,
			)
		}
	}

	return retainUnchangedExtensionState(
		prevState,
		applyLifecycleSnapshotsToExtensionState(mergedState, agentLifecycleSnapshots),
	)
}

const TRANSCRIPT_STATE_KEYS = [
	"alphaMessages",
	"alphaMessagesSeq",
	"messageQueue",
	"messageQueueSeq",
	"currentTaskTodos",
	"currentTaskTodosSeq",
	"liveTasksById",
	"liveTaskIds",
	"agentLifecycleSnapshots",
	"agentLifecycleDegraded",
	"taskStateSeq",
	"currentTaskItem",
	"managedAgentTree",
] as const

const TRANSCRIPT_STATE_KEY_SET = new Set<string>(TRANSCRIPT_STATE_KEYS)

function pickShellSnapshot(value: ExtensionStateContextType): Record<string, unknown> {
	const snapshot: Record<string, unknown> = {}
	for (const [key, field] of Object.entries(value)) {
		if (typeof field === "function" || TRANSCRIPT_STATE_KEY_SET.has(key)) {
			continue
		}
		snapshot[key] = field
	}
	return snapshot
}

function shellSnapshotsEqual(left: Record<string, unknown> | undefined, right: Record<string, unknown>): boolean {
	if (left === right) {
		return true
	}
	if (!left) {
		return false
	}
	const leftKeys = Object.keys(left)
	const rightKeys = Object.keys(right)
	if (leftKeys.length !== rightKeys.length) {
		return false
	}
	return leftKeys.every((key) => left[key] === right[key])
}

function omitTranscriptState(value: ExtensionStateContextType): ExtensionStateContextType {
	const shell = { ...value } as ExtensionStateContextType & Record<string, unknown>
	for (const key of TRANSCRIPT_STATE_KEYS) {
		delete shell[key]
	}
	return shell
}

const EMPTY_PROFILE_THRESHOLDS: Record<string, number> = {}

export const ExtensionStateContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [managedSteeringDrafts, setManagedSteeringDrafts] = useState<Record<string, ManagedSteeringDraft>>({})
	const updateManagedSteeringDraft = useCallback((key: string, draft?: ManagedSteeringDraft) => {
		setManagedSteeringDrafts((current) => {
			const previous = current[key]
			if (
				draft &&
				previous &&
				previous.parentTaskId === draft.parentTaskId &&
				previous.groupId === draft.groupId &&
				previous.taskId === draft.taskId &&
				previous.text === draft.text &&
				previous.pendingRequestId === draft.pendingRequestId &&
				previous.rejected === draft.rejected
			)
				return current
			if (!draft && !current[key]) return current
			const next = { ...current }
			if (draft) next[key] = draft
			else delete next[key]
			return next
		})
	}, [])
	const transcriptCacheRef = useRef<TaskTranscriptCache>(new Map())
	const getCachedTranscriptRevision = useCallback((taskId: string) => {
		return getCachedTaskTranscript(transcriptCacheRef.current, taskId)?.revision
	}, [])
	const [state, setState] = useState<ExtensionState>({
		apiConfiguration: {},
		version: "",
		alphaMessages: [],
		taskHistory: [],
		scheduledTasks: [],
		scheduledTaskRuns: [],
		currentView: { type: "newTaskDraft" },
		liveTaskIds: [],
		liveTasksById: {},
		agentLifecycleDegraded: {},
		shouldShowAnnouncement: false,
		allowedCommands: [],
		deniedCommands: [],
		soundEnabled: false,
		soundVolume: 0.5,
		enableCheckpoints: true,
		checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS, // Default to 15 seconds
		language: "en", // Default language code
		writeDelayMs: 1000,
		maxConcurrentTasks: 3,
		terminalShellIntegrationTimeout: 4000,
		mcpEnabled: true,
		currentApiConfigName: "default",
		listApiConfigMeta: [],
		mode: defaultModeSlug,
		customModePrompts: defaultPrompts,
		customSupportPrompts: {},
		experiments: experimentDefault,
		enhancementApiConfigId: "",
		hasOpenedModeSelector: false, // Default to false (not opened yet)
		autoApprovalEnabled: true,
		approvalMode: "auto",
		approvalModeBypassAcknowledged: false,
		alwaysAllowTickets: true,
		customModes: [],
		maxOpenTabsContext: 20,
		maxWorkspaceFiles: 200,
		cwd: "",
		telemetrySetting: "unset",
		showAlphaIgnoredFiles: true, // Default to showing .alphaignore'd files with lock symbol (current behavior).
		enableSubfolderRules: false, // Default to disabled - must be enabled to load rules from subdirectories
		renderContext: "sidebar",
		maxReadFileLine: -1, // Default max line limit for read_file tool (-1 for default)
		maxImageFileSize: 5, // Default max image file size in MB
		maxTotalImageSize: 20, // Default max total image size in MB
		pinnedApiConfigs: {}, // Empty object for pinned API configs
		terminalZshOhMy: false, // Default Oh My Zsh integration setting
		terminalZshP10k: false, // Default Powerlevel10k integration setting
		terminalZdotdir: false, // Default ZDOTDIR handling setting
		historyPreviewCollapsed: false, // Initialize the new state (default to expanded)
		reasoningBlockCollapsed: true,
		enterBehavior: "send", // Default: Enter sends, Shift+Enter creates newline
		autoSteer: false,
		autoCondenseContext: true,
		autoCondenseContextPercent: 100,
		autoCondenseContextScope: "full-context",
		postTurnCondenseContextPercent: DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT,
		profileThresholds: {},
		codebaseIndexConfig: {
			codebaseIndexEnabled: true,
			codebaseIndexVectorStoreProvider: "lancedb",
			codebaseIndexLocalIndexPath: ".alpha/code-index/lancedb",
			codebaseIndexQdrantUrl: "http://localhost:6333",
			codebaseIndexEmbedderProvider: "vertex",
			codebaseIndexEmbedderBaseUrl: "",
			codebaseIndexEmbedderModelId: "",
			codebaseIndexSearchMaxResults: undefined,
			codebaseIndexSearchMinScore: undefined,
			codebaseIndexVertexProjectId: "",
			codebaseIndexVertexRegion: "",
			codebaseIndexVertexKeyFile: "",
			codebaseIndexVertexGatewayBaseUrl: "",
			codebaseIndexVertexGatewayCaBundlePath: "",
			codebaseIndexVertexGatewayHelixCommand: "",
			codebaseIndexVertexGatewayTokenRefreshMinutes: undefined,
			codebaseIndexVertexGatewayModelRoutingMap: "",
		},
		codebaseIndexModels: { vertex: {} },
		includeDiagnosticMessages: true,
		maxDiagnosticMessages: 50,
		includeCurrentTime: true,
		includeCurrentCost: true,
		lockApiConfigAcrossModes: false,
	})

	const [didHydrateState, setDidHydrateState] = useState(false)
	const [providerSetupRequired, setProviderSetupRequired] = useState(false)
	const [observedActiveTaskId, setObservedActiveTaskId] = useState<string>()
	const [theme, setTheme] = useState<any>(undefined)
	const [filePaths, setFilePaths] = useState<string[]>([])
	const [openedTabs, setOpenedTabs] = useState<Array<{ label: string; isActive: boolean; path?: string }>>([])
	const [commands, setCommands] = useState<Command[]>([])
	const [mcpServers, setMcpServers] = useState<McpServer[]>([])
	const [currentCheckpoint, setCurrentCheckpoint] = useState<string>()
	const [marketplaceItems, setMarketplaceItems] = useState<any[]>([])
	const [alwaysAllowFollowupQuestions, setAlwaysAllowFollowupQuestions] = useState(false) // Add state for follow-up questions auto-approve
	const [followupAutoApproveTimeoutMs, setFollowupAutoApproveTimeoutMs] = useState<number | undefined>(undefined) // Will be set from global settings
	const [marketplaceInstalledMetadata, setMarketplaceInstalledMetadata] = useState<MarketplaceInstalledMetadata>({
		project: {},
		global: {},
	})
	const [skills, setSkills] = useState<SkillMetadata[]>([])
	const [includeTaskHistoryInEnhance, setIncludeTaskHistoryInEnhance] = useState(true)
	const [includeCurrentTime, setIncludeCurrentTime] = useState(true)
	const [includeCurrentCost, setIncludeCurrentCost] = useState(true)
	const latestTaskStateSeqRef = useRef<number>()
	const latestMessageQueueSeqRef = useRef<number>()
	const latestTaskTodosSeqRef = useRef<number>()
	type IncrementalMessage = {
		taskId?: string
		alphaMessage: AlphaMessage
		alphaMessagesSeq?: number
		liveTask?: LiveTaskMetadata
	}
	const pendingMessageUpdatesRef = useRef(new Map<string, IncrementalMessage>())
	const messageUpdateFrameRef = useRef<number | undefined>(undefined)
	const shellSnapshotRef = useRef<Record<string, unknown>>()
	const shellValueRef = useRef<ExtensionStateContextType>()
	const didAnnounceLaunch = useRef(false)

	const setListApiConfigMeta = useCallback(
		(value: ProviderSettingsEntry[]) => setState((prevState) => ({ ...prevState, listApiConfigMeta: value })),
		[],
	)

	const setApiConfiguration = useCallback((value: ProviderSettings) => {
		setState((prevState) => ({
			...prevState,
			apiConfiguration: {
				...prevState.apiConfiguration,
				...value,
			},
		}))
	}, [])

	const applyMessageUpdates = useCallback((updates: IncrementalMessage[]) => {
		if (updates.length === 0) return

		setState((prevState) => {
			let nextMessages = prevState.alphaMessages
			let nextSequence = prevState.alphaMessagesSeq
			let didChange = false
			let liveTasksById = prevState.liveTasksById

			for (const { taskId, alphaMessage, alphaMessagesSeq, liveTask } of updates) {
				const isVisibleTask = !taskId || taskId === prevState.currentTaskId
				// The live metadata belongs to the same publication as the transcript.
				// Reject both before a delayed update can restore stale running controls.
				if (
					isVisibleTask &&
					alphaMessagesSeq !== undefined &&
					nextSequence !== undefined &&
					alphaMessagesSeq <= nextSequence
				) {
					continue
				}
				const existingLiveTask = liveTask ? liveTasksById?.[liveTask.id] : undefined
				if (liveTask && shouldApplyIncrementalLiveTask(existingLiveTask, liveTask)) {
					// Share one copy across the frame while checking each task's latest revision.
					if (!liveTasksById || liveTasksById === prevState.liveTasksById) {
						liveTasksById = { ...(liveTasksById ?? {}) }
					}
					liveTasksById[liveTask.id] = liveTask
				}
				if (!isVisibleTask) continue

				const index = findLastIndex(nextMessages, (msg) => msg.ts === alphaMessage.ts)
				if (index === -1) {
					console.warn(
						`[messageUpdated] Received update for unknown message ts=${alphaMessage.ts}, dropping. ` +
							`Frontend has ${nextMessages.length} messages.`,
					)
					continue
				}

				if (!didChange) {
					nextMessages = [...nextMessages]
					didChange = true
				}
				nextMessages[index] = alphaMessage
				if (alphaMessagesSeq !== undefined) nextSequence = alphaMessagesSeq
			}

			return didChange || liveTasksById !== prevState.liveTasksById
				? { ...prevState, alphaMessages: nextMessages, alphaMessagesSeq: nextSequence, liveTasksById }
				: prevState
		})
	}, [])

	const applyMessageCreation = useCallback(
		({ taskId, alphaMessage, alphaMessagesSeq, liveTask }: IncrementalMessage) => {
			setState((prevState) => {
				const isVisibleTask = !taskId || taskId === prevState.currentTaskId
				if (
					isVisibleTask &&
					alphaMessagesSeq !== undefined &&
					prevState.alphaMessagesSeq !== undefined &&
					alphaMessagesSeq <= prevState.alphaMessagesSeq
				) {
					return prevState
				}
				const existingLiveTask = liveTask ? prevState.liveTasksById?.[liveTask.id] : undefined
				const liveTasksById =
					liveTask && shouldApplyIncrementalLiveTask(existingLiveTask, liveTask)
						? { ...(prevState.liveTasksById ?? {}), [liveTask.id]: liveTask }
						: prevState.liveTasksById
				if (!isVisibleTask) {
					return liveTasksById === prevState.liveTasksById ? prevState : { ...prevState, liveTasksById }
				}

				const existingIndex = findLastIndex(
					prevState.alphaMessages,
					(message) => message.ts === alphaMessage.ts,
				)
				const alphaMessages = [...prevState.alphaMessages]
				if (existingIndex === -1) {
					alphaMessages.push(alphaMessage)
				} else {
					alphaMessages[existingIndex] = alphaMessage
				}

				return {
					...prevState,
					alphaMessages,
					alphaMessagesSeq: alphaMessagesSeq ?? prevState.alphaMessagesSeq,
					liveTasksById,
				}
			})
		},
		[],
	)

	const takePendingMessageUpdates = useCallback(() => {
		const updates = Array.from(pendingMessageUpdatesRef.current.values())
		pendingMessageUpdatesRef.current.clear()
		// Replacing a Map value retains its original insertion position. Sort by the
		// latest wire sequence so interleaved updates for multiple messages all apply.
		updates.sort((left, right) => {
			if (left.alphaMessagesSeq === undefined || right.alphaMessagesSeq === undefined) return 0
			return left.alphaMessagesSeq - right.alphaMessagesSeq
		})
		return updates
	}, [])

	const flushPendingMessageUpdates = useCallback(() => {
		if (messageUpdateFrameRef.current !== undefined) {
			cancelAnimationFrame(messageUpdateFrameRef.current)
			messageUpdateFrameRef.current = undefined
		}

		applyMessageUpdates(takePendingMessageUpdates())
	}, [applyMessageUpdates, takePendingMessageUpdates])

	const queuePartialMessageUpdate = useCallback(
		(
			taskId: string | undefined,
			alphaMessage: AlphaMessage,
			alphaMessagesSeq?: number,
			liveTask?: LiveTaskMetadata,
		) => {
			const key = `${taskId ?? ""}:${alphaMessage.ts}`
			const pending = pendingMessageUpdatesRef.current.get(key)
			if (
				alphaMessagesSeq !== undefined &&
				pending?.alphaMessagesSeq !== undefined &&
				alphaMessagesSeq <= pending.alphaMessagesSeq
			) {
				return
			}
			pendingMessageUpdatesRef.current.set(key, { taskId, alphaMessage, alphaMessagesSeq, liveTask })

			if (messageUpdateFrameRef.current !== undefined) return
			messageUpdateFrameRef.current = requestAnimationFrame(() => {
				messageUpdateFrameRef.current = undefined
				applyMessageUpdates(takePendingMessageUpdates())
			})
		},
		[applyMessageUpdates, takePendingMessageUpdates],
	)

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			if (!event.data || typeof event.data !== "object" || typeof event.data.type !== "string") return
			const message = normalizeExtensionMessageTranscript(event.data as ExtensionMessage)
			if (!message) return
			switch (message.type) {
				case "chatCommandResult": {
					const result = message.chatCommandResult
					if (result?.command !== "steerSubagent" || !result.taskId) break
					setManagedSteeringDrafts((current) => {
						const next = { ...current }
						let changed = false
						for (const [key, draft] of Object.entries(current)) {
							if (draft.parentTaskId !== result.taskId || draft.pendingRequestId !== result.requestId)
								continue
							changed = true
							if (result.status === "accepted") delete next[key]
							else next[key] = { ...draft, pendingRequestId: undefined, rejected: true }
						}
						return changed ? next : current
					})
					break
				}
				case "agentLifecycleEvent": {
					setState((prevState) => applyLifecycleEventToExtensionState(prevState, message))
					break
				}
				case "agentLifecycleSnapshot": {
					setState((prevState) => applyLifecycleSnapshotToExtensionState(prevState, message))
					break
				}
				case "agentLifecycleDegraded": {
					setState((prevState) => applyLifecycleDegradedToExtensionState(prevState, message))
					break
				}
				case "state": {
					// Preserve event ordering: a newer state snapshot must not be followed by
					// a previously queued partial update.
					flushPendingMessageUpdates()
					const newState = message.state ?? {}
					setState((prevState) => mergeExtensionState(prevState, newState, transcriptCacheRef.current))

					// Queue/todo fast paths can arrive before the full task snapshot. They
					// intentionally do not own task-domain state, but a fresh patch for a
					// concrete task is still authoritative evidence that a chat is active.
					// Track that evidence separately so onboarding can never flash over it.
					const taskStateSeq = newState.taskStateSeq
					if (taskStateSeq !== undefined && taskStateSeq > (latestTaskStateSeqRef.current ?? -1)) {
						latestTaskStateSeqRef.current = taskStateSeq
						setObservedActiveTaskId(newState.currentTaskId)
					} else if (taskStateSeq === undefined && newState.currentTaskId !== undefined) {
						const hasFreshQueueSignal =
							newState.messageQueueSeq !== undefined &&
							newState.messageQueueSeq > (latestMessageQueueSeqRef.current ?? -1)
						const hasFreshTodosSignal =
							newState.currentTaskTodosSeq !== undefined &&
							newState.currentTaskTodosSeq > (latestTaskTodosSeqRef.current ?? -1)
						if (hasFreshQueueSignal || hasFreshTodosSignal) {
							setObservedActiveTaskId(newState.currentTaskId)
						}
					}
					if (
						newState.messageQueueSeq !== undefined &&
						newState.messageQueueSeq > (latestMessageQueueSeqRef.current ?? -1)
					) {
						latestMessageQueueSeqRef.current = newState.messageQueueSeq
					}
					if (
						newState.currentTaskTodosSeq !== undefined &&
						newState.currentTaskTodosSeq > (latestTaskTodosSeqRef.current ?? -1)
					) {
						latestTaskTodosSeqRef.current = newState.currentTaskTodosSeq
					}

					// Configuration-less state messages are partial transport patches, not
					// evidence that provider setup is missing.
					if (newState.apiConfiguration !== undefined) {
						setProviderSetupRequired(!checkExistKey(newState.apiConfiguration))
					}
					setDidHydrateState(true)
					// Update alwaysAllowFollowupQuestions if present in state message
					if ((newState as any).alwaysAllowFollowupQuestions !== undefined) {
						setAlwaysAllowFollowupQuestions((newState as any).alwaysAllowFollowupQuestions)
					}
					// Update followupAutoApproveTimeoutMs if present in state message
					if ((newState as any).followupAutoApproveTimeoutMs !== undefined) {
						setFollowupAutoApproveTimeoutMs((newState as any).followupAutoApproveTimeoutMs)
					}
					// Update includeTaskHistoryInEnhance if present in state message
					if ((newState as any).includeTaskHistoryInEnhance !== undefined) {
						setIncludeTaskHistoryInEnhance((newState as any).includeTaskHistoryInEnhance)
					}
					// Update includeCurrentTime if present in state message
					if ((newState as any).includeCurrentTime !== undefined) {
						setIncludeCurrentTime((newState as any).includeCurrentTime)
					}
					// Update includeCurrentCost if present in state message
					if ((newState as any).includeCurrentCost !== undefined) {
						setIncludeCurrentCost((newState as any).includeCurrentCost)
					}
					// Handle marketplace data if present in state message
					if (newState.marketplaceItems !== undefined) {
						setMarketplaceItems(newState.marketplaceItems)
					}
					if (newState.marketplaceInstalledMetadata !== undefined) {
						setMarketplaceInstalledMetadata(newState.marketplaceInstalledMetadata)
					}
					break
				}
				case "theme": {
					if (message.text) {
						setTheme(convertTextMateToHljs(JSON.parse(message.text)))
					}
					break
				}
				case "workspaceUpdated": {
					const paths = message.filePaths ?? []
					const tabs = message.openedTabs ?? []

					setFilePaths(paths)
					setOpenedTabs(tabs)
					break
				}
				case "commands": {
					setCommands(message.commands ?? [])
					break
				}
				case "messageUpdated": {
					const alphaMessage = message.alphaMessage
					if (!alphaMessage) break
					const key = `${message.taskId ?? ""}:${alphaMessage.ts}`

					if (alphaMessage.partial) {
						queuePartialMessageUpdate(
							message.taskId,
							alphaMessage,
							message.alphaMessagesSeq,
							message.liveTask,
						)
					} else {
						// A terminal update supersedes any partial for the same message and is
						// applied immediately so completion controls never lag behind the stream.
						flushPendingMessageUpdates()
						pendingMessageUpdatesRef.current.delete(key)
						applyMessageUpdates([
							{
								taskId: message.taskId,
								alphaMessage,
								alphaMessagesSeq: message.alphaMessagesSeq,
								liveTask: message.liveTask,
							},
						])
					}
					break
				}
				case "messageCreated": {
					if (!message.alphaMessage) break
					flushPendingMessageUpdates()
					applyMessageCreation({
						taskId: message.taskId,
						alphaMessage: message.alphaMessage,
						alphaMessagesSeq: message.alphaMessagesSeq,
						liveTask: message.liveTask,
					})
					break
				}
				case "skills": {
					if (message.skills) {
						setSkills(message.skills)
					}
					break
				}
				case "mcpServers": {
					setMcpServers(message.mcpServers ?? [])
					break
				}
				case "currentCheckpointUpdated": {
					setCurrentCheckpoint(message.text)
					break
				}
				case "listApiConfig": {
					setListApiConfigMeta(message.listApiConfig ?? [])
					break
				}
				case "marketplaceData": {
					if (message.marketplaceItems !== undefined) {
						setMarketplaceItems(message.marketplaceItems)
					}
					if (message.marketplaceInstalledMetadata !== undefined) {
						setMarketplaceInstalledMetadata(message.marketplaceInstalledMetadata)
					}
					break
				}
				case "taskHistoryUpdated": {
					// Efficiently update just the task history without replacing entire state
					if (message.taskHistory !== undefined) {
						setState((prevState) => ({
							...prevState,
							taskHistory: message.taskHistory!,
						}))
					}
					break
				}
				case "taskHistoryItemUpdated": {
					const item = message.taskHistoryItem
					if (!item) {
						break
					}
					setState((prevState) => {
						const existingIndex = prevState.taskHistory.findIndex((h) => h.id === item.id)
						let nextHistory: typeof prevState.taskHistory
						if (existingIndex === -1) {
							nextHistory = [item, ...prevState.taskHistory]
						} else {
							nextHistory = [...prevState.taskHistory]
							nextHistory[existingIndex] = item
						}
						// Keep UI semantics consistent with extension: newest-first ordering.
						nextHistory.sort((a, b) => b.ts - a.ts)
						return {
							...prevState,
							taskHistory: nextHistory,
							currentTaskItem:
								prevState.currentTaskItem?.id === item.id ? item : prevState.currentTaskItem,
						}
					})
					break
				}
				case "scheduledTasksUpdated": {
					setState((prevState) => ({
						...prevState,
						scheduledTasks: message.scheduledTasks ?? message.scheduledTaskState?.tasks ?? [],
						scheduledTaskRuns: message.scheduledTaskRuns ?? message.scheduledTaskState?.runs ?? [],
					}))
					break
				}
			}
		},
		[
			applyMessageCreation,
			applyMessageUpdates,
			flushPendingMessageUpdates,
			queuePartialMessageUpdate,
			setListApiConfigMeta,
		],
	)

	useEffect(() => {
		const pendingUpdates = pendingMessageUpdatesRef.current
		window.addEventListener("message", handleMessage)
		return () => {
			window.removeEventListener("message", handleMessage)
			if (messageUpdateFrameRef.current !== undefined) {
				cancelAnimationFrame(messageUpdateFrameRef.current)
			}
			pendingUpdates.clear()
		}
	}, [handleMessage])

	useEffect(() => {
		if (didAnnounceLaunch.current) return
		didAnnounceLaunch.current = true
		// The state listener above owns readiness, including React's development effect replay.
		vscode.postMessage({ type: "webviewDidLaunch" })
	}, [])

	const editorViewType = state.currentView?.type
	const editorTaskId = state.currentView?.type === "task" ? state.currentView.taskId : undefined
	const hasAcceptedTaskState = typeof state.taskStateSeq === "number"
	useEffect(() => {
		if (!didHydrateState || state.renderContext !== "editor" || !hasAcceptedTaskState) return
		if (editorViewType !== "newTaskDraft" && (editorViewType !== "task" || !editorTaskId)) return
		// VS Code serializes this selection across reloads. Runtime state and the
		// transcript are always restored by the host from the saved task instead.
		const editorChatState: EditorChatState = {
			version: 1,
			currentView:
				editorViewType === "task" && editorTaskId
					? { type: "task", taskId: editorTaskId }
					: { type: "newTaskDraft" },
		}
		const previousState = vscode.getState()
		const retainedState =
			typeof previousState === "object" && previousState !== null && !Array.isArray(previousState)
				? previousState
				: {}
		vscode.setState({ ...retainedState, alphaEditorChat: editorChatState })
	}, [didHydrateState, state.renderContext, hasAcceptedTaskState, editorViewType, editorTaskId])

	// Provider setup is onboarding for a new-task draft, never an overlay for an
	// established chat. Deriving the task guard from the sequence-aware merged
	// state also prevents stale lifecycle patches from hiding the current view.
	const showWelcome =
		providerSetupRequired &&
		state.currentView?.type !== "task" &&
		state.currentTaskId === undefined &&
		observedActiveTaskId === undefined

	const contextValue: ExtensionStateContextType = {
		...state,
		managedSteeringDrafts,
		updateManagedSteeringDraft,
		autoCondenseContextScope: state.autoCondenseContextScope ?? "full-context",
		postTurnCondenseContextPercent:
			state.postTurnCondenseContextPercent ?? DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT,
		reasoningBlockCollapsed: state.reasoningBlockCollapsed ?? true,
		didHydrateState,
		showWelcome,
		theme,
		mcpServers,
		currentCheckpoint,
		filePaths,
		openedTabs,
		commands,
		soundVolume: state.soundVolume,
		writeDelayMs: state.writeDelayMs,
		marketplaceItems,
		marketplaceInstalledMetadata,
		profileThresholds: state.profileThresholds ?? EMPTY_PROFILE_THRESHOLDS,
		alwaysAllowFollowupQuestions,
		followupAutoApproveTimeoutMs,
		setExperimentEnabled: (id, enabled) =>
			setState((prevState) => ({ ...prevState, experiments: { ...prevState.experiments, [id]: enabled } })),
		setApiConfiguration,
		setCustomInstructions: (value) => setState((prevState) => ({ ...prevState, customInstructions: value })),
		setAlwaysAllowReadOnly: (value) => setState((prevState) => ({ ...prevState, alwaysAllowReadOnly: value })),
		setAlwaysAllowReadOnlyOutsideWorkspace: (value) =>
			setState((prevState) => ({ ...prevState, alwaysAllowReadOnlyOutsideWorkspace: value })),
		setAlwaysAllowWrite: (value) => setState((prevState) => ({ ...prevState, alwaysAllowWrite: value })),
		setAlwaysAllowWriteOutsideWorkspace: (value) =>
			setState((prevState) => ({ ...prevState, alwaysAllowWriteOutsideWorkspace: value })),
		setAlwaysAllowWriteProtected: (value) =>
			setState((prevState) => ({ ...prevState, alwaysAllowWriteProtected: value })),
		setAlwaysAllowExecute: (value) => setState((prevState) => ({ ...prevState, alwaysAllowExecute: value })),
		setAlwaysAllowMcp: (value) => setState((prevState) => ({ ...prevState, alwaysAllowMcp: value })),
		setAlwaysAllowSubtasks: (value) => setState((prevState) => ({ ...prevState, alwaysAllowSubtasks: value })),
		setAlwaysAllowSubagents: (value) => setState((prevState) => ({ ...prevState, alwaysAllowSubagents: value })),
		setAlwaysAllowTickets: (value) => setState((prevState) => ({ ...prevState, alwaysAllowTickets: value })),
		setAlwaysAllowFollowupQuestions,
		setFollowupAutoApproveTimeoutMs: (value) =>
			setState((prevState) => ({ ...prevState, followupAutoApproveTimeoutMs: value })),
		setShowAnnouncement: (value) => setState((prevState) => ({ ...prevState, shouldShowAnnouncement: value })),
		setAllowedCommands: (value) => setState((prevState) => ({ ...prevState, allowedCommands: value })),
		setDeniedCommands: (value) => setState((prevState) => ({ ...prevState, deniedCommands: value })),
		setTerminalZdotdir: (value) => setState((prevState) => ({ ...prevState, terminalZdotdir: value })),
		setMode: (value: Mode) => setState((prevState) => ({ ...prevState, mode: value })),
		setCustomModePrompts: (value) => setState((prevState) => ({ ...prevState, customModePrompts: value })),
		setCustomSupportPrompts: (value) => setState((prevState) => ({ ...prevState, customSupportPrompts: value })),
		setEnhancementApiConfigId: (value) =>
			setState((prevState) => ({ ...prevState, enhancementApiConfigId: value })),
		setAutoApprovalEnabled: (value) => setState((prevState) => ({ ...prevState, autoApprovalEnabled: value })),
		setApprovalMode: (value) => setState((prevState) => ({ ...prevState, approvalMode: value })),
		setApprovalModeBypassAcknowledged: (value) =>
			setState((prevState) => ({ ...prevState, approvalModeBypassAcknowledged: value })),
		setTelemetrySetting: (value) => setState((prevState) => ({ ...prevState, telemetrySetting: value })),
		setShowAlphaIgnoredFiles: (value) => setState((prevState) => ({ ...prevState, showAlphaIgnoredFiles: value })),
		togglePinnedApiConfig: (configId) =>
			setState((prevState) => {
				const currentPinned = prevState.pinnedApiConfigs || {}
				const newPinned = {
					...currentPinned,
					[configId]: !currentPinned[configId],
				}

				// If the config is now unpinned, remove it from the object
				if (!newPinned[configId]) {
					delete newPinned[configId]
				}

				return { ...prevState, pinnedApiConfigs: newPinned }
			}),
		setHistoryPreviewCollapsed: (value) =>
			setState((prevState) => ({ ...prevState, historyPreviewCollapsed: value })),
		enterBehavior: state.enterBehavior ?? "send",
		autoSteer: state.autoSteer === true,
		setHasOpenedModeSelector: (value) => setState((prevState) => ({ ...prevState, hasOpenedModeSelector: value })),
		setProfileThresholds: (value) => setState((prevState) => ({ ...prevState, profileThresholds: value })),
		includeDiagnosticMessages: state.includeDiagnosticMessages,
		maxDiagnosticMessages: state.maxDiagnosticMessages,
		includeTaskHistoryInEnhance,
		setIncludeTaskHistoryInEnhance,
		includeCurrentTime,
		includeCurrentCost,
		skills,
		showWorktreesInHomeScreen: state.showWorktreesInHomeScreen ?? true,
		getCachedTranscriptRevision,
	}

	const shellSnapshot = pickShellSnapshot(contextValue)
	if (!shellValueRef.current || !shellSnapshotsEqual(shellSnapshotRef.current, shellSnapshot)) {
		shellSnapshotRef.current = shellSnapshot
		shellValueRef.current = omitTranscriptState(contextValue)
	}

	return (
		<ExtensionStateContext.Provider value={contextValue}>
			<ShellStateContext.Provider value={shellValueRef.current}>{children}</ShellStateContext.Provider>
		</ExtensionStateContext.Provider>
	)
}

export const useExtensionState = () => {
	const context = useContext(ExtensionStateContext)

	if (context === undefined) {
		throw new Error("useExtensionState must be used within an ExtensionStateContextProvider")
	}

	return context
}

/** Read the current cache on interaction without subscribing opening controls to transcript ticks. */
export const useCachedTranscriptRevisionReader = () => {
	const context = useContext(ShellStateContext)
	return context?.getCachedTranscriptRevision
}

export const useShellState = () => {
	const context = useContext(ShellStateContext)

	if (context === undefined) {
		throw new Error("useShellState must be used within an ExtensionStateContextProvider")
	}

	return context
}
