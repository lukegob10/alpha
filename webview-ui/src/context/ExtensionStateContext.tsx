import React, { useCallback, useContext, useEffect, useRef, useState } from "react"

import { ExtensionStateContext, ShellStateContext } from "./ExtensionStateContextStore"

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
	type ApprovalMode,
	type AlphaMessage,
	settingsForApprovalMode,
	type LiveTaskMetadata,
	type MarketplaceInstalledMetadata,
	type SkillMetadata,
	type Command,
	type McpServer,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
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
	setEnableSubfolderRules: (value: boolean) => void
	setShowAnnouncement: (value: boolean) => void
	setAllowedCommands: (value: string[]) => void
	setDeniedCommands: (value: string[]) => void
	setAllowedMaxRequests: (value: number | undefined) => void
	setAllowedMaxCost: (value: number | undefined) => void
	setSoundEnabled: (value: boolean) => void
	setSoundVolume: (value: number) => void
	terminalShellIntegrationTimeout?: number
	setTerminalShellIntegrationTimeout: (value: number) => void
	terminalShellIntegrationDisabled?: boolean
	setTerminalShellIntegrationDisabled: (value: boolean) => void
	terminalZdotdir?: boolean
	setTerminalZdotdir: (value: boolean) => void
	setTtsEnabled: (value: boolean) => void
	setTtsSpeed: (value: number) => void
	setEnableCheckpoints: (value: boolean) => void
	checkpointTimeout: number
	setCheckpointTimeout: (value: number) => void
	setWriteDelayMs: (value: number) => void
	terminalOutputPreviewSize?: "small" | "medium" | "large"
	setTerminalOutputPreviewSize: (value: "small" | "medium" | "large") => void
	mcpEnabled: boolean
	setMcpEnabled: (value: boolean) => void
	setCurrentApiConfigName: (value: string) => void
	setListApiConfigMeta: (value: ProviderSettingsEntry[]) => void
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
	setCustomModes: (value: ModeConfig[]) => void
	setMaxOpenTabsContext: (value: number) => void
	maxWorkspaceFiles: number
	setMaxWorkspaceFiles: (value: number) => void
	setTelemetrySetting: (value: TelemetrySetting) => void
	awsUsePromptCache?: boolean
	setAwsUsePromptCache: (value: boolean) => void
	maxImageFileSize: number
	setMaxImageFileSize: (value: number) => void
	maxTotalImageSize: number
	setMaxTotalImageSize: (value: number) => void
	machineId?: string
	pinnedApiConfigs?: Record<string, boolean>
	setPinnedApiConfigs: (value: Record<string, boolean>) => void
	togglePinnedApiConfig: (configName: string) => void
	setHistoryPreviewCollapsed: (value: boolean) => void
	setReasoningBlockCollapsed: (value: boolean) => void
	enterBehavior?: "send" | "newline"
	setEnterBehavior: (value: "send" | "newline") => void
	autoCondenseContext: boolean
	setAutoCondenseContext: (value: boolean) => void
	autoCondenseContextPercent: number
	setAutoCondenseContextPercent: (value: number) => void
	includeDiagnosticMessages?: boolean
	setIncludeDiagnosticMessages: (value: boolean) => void
	maxDiagnosticMessages?: number
	setMaxDiagnosticMessages: (value: number) => void
	includeTaskHistoryInEnhance?: boolean
	setIncludeTaskHistoryInEnhance: (value: boolean) => void
	includeCurrentTime?: boolean
	setIncludeCurrentTime: (value: boolean) => void
	includeCurrentCost?: boolean
	setIncludeCurrentCost: (value: boolean) => void
	showWorktreesInHomeScreen: boolean
	setShowWorktreesInHomeScreen: (value: boolean) => void
	getCachedTranscriptRevision: (taskId: string) => number | undefined
	skills?: SkillMetadata[]
}

export { ExtensionStateContext, ShellStateContext }

interface CachedTaskTranscript {
	messages: AlphaMessage[]
	revision: number
}

type TaskTranscriptCache = Map<string, CachedTaskTranscript>

const MAX_CACHED_TASK_TRANSCRIPTS = 2

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
	const agentLifecycleSnapshots = mergeAgentLifecycleSnapshots(
		prevState.agentLifecycleSnapshots,
		newState.agentLifecycleSnapshots,
	)
	const agentLifecycleDegraded = mergeAgentLifecycleDegradedSignals(
		prevState.agentLifecycleDegraded,
		newState.agentLifecycleDegraded,
	)

	const hasDedicatedDomainSequence =
		newState.taskStateSeq !== undefined ||
		newState.messageQueueSeq !== undefined ||
		newState.currentTaskTodosSeq !== undefined
	const legacyDomainSequence = hasDedicatedDomainSequence ? undefined : newState.clineMessagesSeq
	const incomingTaskStateSeq = newState.taskStateSeq ?? legacyDomainSequence
	const incomingQueueSeq = newState.messageQueueSeq ?? legacyDomainSequence
	const incomingTodosSeq = newState.currentTaskTodosSeq ?? legacyDomainSequence
	const previousTaskStateSeq =
		prevState.taskStateSeq ?? (hasDedicatedDomainSequence ? undefined : prevState.clineMessagesSeq)
	const previousQueueSeq =
		prevState.messageQueueSeq ?? (hasDedicatedDomainSequence ? undefined : prevState.clineMessagesSeq)
	const previousTodosSeq =
		prevState.currentTaskTodosSeq ?? (hasDedicatedDomainSequence ? undefined : prevState.clineMessagesSeq)
	const isStale = (incoming: number | undefined, previous: number | undefined) =>
		incoming !== undefined && previous !== undefined && incoming <= previous

	// Transcript, lifecycle, queue, and todos are delivered independently. Guard
	// each domain separately so a tiny queue patch cannot suppress a valid later
	// lifecycle snapshot (or let an older full snapshot erase a newer queue).
	if (isStale(newState.clineMessagesSeq, prevState.clineMessagesSeq)) {
		rest.clineMessages = prevState.clineMessages
		rest.clineMessagesSeq = prevState.clineMessagesSeq
	}

	const taskStateIsStale = isStale(incomingTaskStateSeq, previousTaskStateSeq)
	const patchHasNoTaskStateSequence = hasDedicatedDomainSequence && incomingTaskStateSeq === undefined
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
	}
	// A late transcript from an older navigation can carry a higher message
	// sequence. Reject it so it cannot replace the task that is now on screen.
	// An equal task sequence is the transcript for the accepted navigation.
	if (
		typeof newState.taskStateSeq === "number" &&
		typeof prevState.taskStateSeq === "number" &&
		newState.taskStateSeq < prevState.taskStateSeq &&
		Object.prototype.hasOwnProperty.call(newState, "clineMessages")
	) {
		rest.clineMessages = prevState.clineMessages
		rest.clineMessagesSeq = prevState.clineMessagesSeq
	}

	const targetsDifferentTask =
		newState.currentTaskId !== undefined && newState.currentTaskId !== prevState.currentTaskId
	const acceptedTaskSnapshot = !taskStateIsStale && !patchHasNoTaskStateSequence
	if (
		acceptedTaskSnapshot &&
		"currentTaskId" in newState &&
		newState.currentTaskId !== prevState.currentTaskId &&
		!("taskReasoning" in newState)
	) {
		rest.taskReasoning = undefined
	}
	if ("currentTaskId" in newState && newState.currentTaskId == null) {
		rest.currentTaskId = undefined
	}
	if ("currentTaskItem" in newState && newState.currentTaskItem == null) {
		rest.currentTaskItem = undefined
	}
	if ("activeTaskId" in newState && newState.activeTaskId == null) {
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
				prevState.clineMessages,
				prevState.liveTasksById?.[previousTaskId]?.transcriptRevision,
			)
		}

		if (
			taskChanged &&
			currentTaskId &&
			newState.currentTaskId === currentTaskId &&
			Array.isArray(newState.clineMessages) &&
			newState.clineMessages.length === 0
		) {
			const cached = getCachedTaskTranscript(transcriptCache, currentTaskId)
			const revision = mergedState.liveTasksById?.[currentTaskId]?.transcriptRevision
			if (cached && revision !== undefined && cached.revision === revision) {
				mergedState.clineMessages = cached.messages
			}
		}

		if (
			currentTaskId &&
			newState.currentTaskId === currentTaskId &&
			Array.isArray(newState.clineMessages) &&
			newState.clineMessages.length > 0
		) {
			cacheTaskTranscript(
				transcriptCache,
				currentTaskId,
				mergedState.clineMessages,
				mergedState.liveTasksById?.[currentTaskId]?.transcriptRevision,
			)
		}
	}

	return applyLifecycleSnapshotsToExtensionState(mergedState, agentLifecycleSnapshots)
}

const TRANSCRIPT_STATE_KEYS = [
	"clineMessages",
	"clineMessagesSeq",
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
	const transcriptCacheRef = useRef<TaskTranscriptCache>(new Map())
	const getCachedTranscriptRevision = useCallback((taskId: string) => {
		return getCachedTaskTranscript(transcriptCacheRef.current, taskId)?.revision
	}, [])
	const [state, setState] = useState<ExtensionState>({
		apiConfiguration: {},
		version: "",
		clineMessages: [],
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
		ttsEnabled: false,
		ttsSpeed: 1.0,
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
		showRooIgnoredFiles: true, // Default to showing .alphaignore'd files with lock symbol (current behavior).
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
		reasoningBlockCollapsed: true, // Default to collapsed
		enterBehavior: "send", // Default: Enter sends, Shift+Enter creates newline
		autoCondenseContext: true,
		autoCondenseContextPercent: 100,
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
		clineMessage: AlphaMessage
		clineMessagesSeq?: number
		liveTask?: LiveTaskMetadata
	}
	const pendingMessageUpdatesRef = useRef(new Map<string, IncrementalMessage>())
	const messageUpdateFrameRef = useRef<number | undefined>(undefined)
	const shellSnapshotRef = useRef<Record<string, unknown>>()
	const shellValueRef = useRef<ExtensionStateContextType>()

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
			let nextMessages = prevState.clineMessages
			let nextSequence = prevState.clineMessagesSeq
			let didChange = false
			let liveTasksById = prevState.liveTasksById

			for (const { taskId, clineMessage, clineMessagesSeq, liveTask } of updates) {
				const existingLiveTask = liveTask ? liveTasksById?.[liveTask.id] : undefined
				if (liveTask && (!existingLiveTask || liveTask.lastUpdatedAt >= existingLiveTask.lastUpdatedAt)) {
					liveTasksById = { ...(liveTasksById ?? {}), [liveTask.id]: liveTask }
				}
				if (taskId && taskId !== prevState.currentTaskId) continue
				if (clineMessagesSeq !== undefined && nextSequence !== undefined && clineMessagesSeq <= nextSequence) {
					continue
				}

				const index = findLastIndex(nextMessages, (msg) => msg.ts === clineMessage.ts)
				if (index === -1) {
					console.warn(
						`[messageUpdated] Received update for unknown message ts=${clineMessage.ts}, dropping. ` +
							`Frontend has ${nextMessages.length} messages.`,
					)
					continue
				}

				if (!didChange) {
					nextMessages = [...nextMessages]
					didChange = true
				}
				nextMessages[index] = clineMessage
				if (clineMessagesSeq !== undefined) nextSequence = clineMessagesSeq
			}

			return didChange || liveTasksById !== prevState.liveTasksById
				? { ...prevState, clineMessages: nextMessages, clineMessagesSeq: nextSequence, liveTasksById }
				: prevState
		})
	}, [])

	const applyMessageCreation = useCallback(
		({ taskId, clineMessage, clineMessagesSeq, liveTask }: IncrementalMessage) => {
			setState((prevState) => {
				const existingLiveTask = liveTask ? prevState.liveTasksById?.[liveTask.id] : undefined
				const liveTasksById =
					liveTask && (!existingLiveTask || liveTask.lastUpdatedAt >= existingLiveTask.lastUpdatedAt)
						? { ...(prevState.liveTasksById ?? {}), [liveTask.id]: liveTask }
						: prevState.liveTasksById
				if (taskId && taskId !== prevState.currentTaskId) {
					return liveTasksById === prevState.liveTasksById ? prevState : { ...prevState, liveTasksById }
				}
				if (
					clineMessagesSeq !== undefined &&
					prevState.clineMessagesSeq !== undefined &&
					clineMessagesSeq <= prevState.clineMessagesSeq
				) {
					return liveTasksById === prevState.liveTasksById ? prevState : { ...prevState, liveTasksById }
				}

				const existingIndex = findLastIndex(
					prevState.clineMessages,
					(message) => message.ts === clineMessage.ts,
				)
				const clineMessages = [...prevState.clineMessages]
				if (existingIndex === -1) {
					clineMessages.push(clineMessage)
				} else {
					clineMessages[existingIndex] = clineMessage
				}

				return {
					...prevState,
					clineMessages,
					clineMessagesSeq: clineMessagesSeq ?? prevState.clineMessagesSeq,
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
			if (left.clineMessagesSeq === undefined || right.clineMessagesSeq === undefined) return 0
			return left.clineMessagesSeq - right.clineMessagesSeq
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
			clineMessage: AlphaMessage,
			clineMessagesSeq?: number,
			liveTask?: LiveTaskMetadata,
		) => {
			const key = `${taskId ?? ""}:${clineMessage.ts}`
			pendingMessageUpdatesRef.current.set(key, { taskId, clineMessage, clineMessagesSeq, liveTask })

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
			const message: ExtensionMessage = event.data
			switch (message.type) {
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
				case "action": {
					if (message.action === "toggleAutoApprove") {
						setState((prevState) => {
							const nextMode = prevState.approvalMode === "ask" ? "auto" : "ask"
							const settings = settingsForApprovalMode(nextMode, {
								alwaysAllowWriteProtected:
									nextMode === "auto" ? prevState.alwaysAllowWriteProtected === true : undefined,
								alwaysAllowMcp: prevState.alwaysAllowMcp === true,
								approvalModeBypassAcknowledged: prevState.approvalModeBypassAcknowledged === true,
							})
							vscode.postMessage({ type: "updateSettings", updatedSettings: settings })
							return { ...prevState, ...settings }
						})
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
					const clineMessage = message.clineMessage!
					const key = `${message.taskId ?? ""}:${clineMessage.ts}`

					if (clineMessage.partial) {
						queuePartialMessageUpdate(
							message.taskId,
							clineMessage,
							message.clineMessagesSeq,
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
								clineMessage,
								clineMessagesSeq: message.clineMessagesSeq,
								liveTask: message.liveTask,
							},
						])
					}
					break
				}
				case "messageCreated": {
					flushPendingMessageUpdates()
					applyMessageCreation({
						taskId: message.taskId,
						clineMessage: message.clineMessage!,
						clineMessagesSeq: message.clineMessagesSeq,
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
		vscode.postMessage({ type: "webviewDidLaunch" })
	}, [])

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
		ttsSpeed: state.ttsSpeed,
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
		setAllowedMaxRequests: (value) => setState((prevState) => ({ ...prevState, allowedMaxRequests: value })),
		setAllowedMaxCost: (value) => setState((prevState) => ({ ...prevState, allowedMaxCost: value })),
		setSoundEnabled: (value) => setState((prevState) => ({ ...prevState, soundEnabled: value })),
		setSoundVolume: (value) => setState((prevState) => ({ ...prevState, soundVolume: value })),
		setTtsEnabled: (value) => setState((prevState) => ({ ...prevState, ttsEnabled: value })),
		setTtsSpeed: (value) => setState((prevState) => ({ ...prevState, ttsSpeed: value })),
		setEnableCheckpoints: (value) => setState((prevState) => ({ ...prevState, enableCheckpoints: value })),
		setCheckpointTimeout: (value) => setState((prevState) => ({ ...prevState, checkpointTimeout: value })),
		setWriteDelayMs: (value) => setState((prevState) => ({ ...prevState, writeDelayMs: value })),
		setTerminalOutputPreviewSize: (value) =>
			setState((prevState) => ({ ...prevState, terminalOutputPreviewSize: value })),
		setTerminalShellIntegrationTimeout: (value) =>
			setState((prevState) => ({ ...prevState, terminalShellIntegrationTimeout: value })),
		setTerminalShellIntegrationDisabled: (value) =>
			setState((prevState) => ({ ...prevState, terminalShellIntegrationDisabled: value })),
		setTerminalZdotdir: (value) => setState((prevState) => ({ ...prevState, terminalZdotdir: value })),
		setMcpEnabled: (value) => setState((prevState) => ({ ...prevState, mcpEnabled: value })),
		setCurrentApiConfigName: (value) => setState((prevState) => ({ ...prevState, currentApiConfigName: value })),
		setListApiConfigMeta,
		setMode: (value: Mode) => setState((prevState) => ({ ...prevState, mode: value })),
		setCustomModePrompts: (value) => setState((prevState) => ({ ...prevState, customModePrompts: value })),
		setCustomSupportPrompts: (value) => setState((prevState) => ({ ...prevState, customSupportPrompts: value })),
		setEnhancementApiConfigId: (value) =>
			setState((prevState) => ({ ...prevState, enhancementApiConfigId: value })),
		setAutoApprovalEnabled: (value) => setState((prevState) => ({ ...prevState, autoApprovalEnabled: value })),
		setApprovalMode: (value) => setState((prevState) => ({ ...prevState, approvalMode: value })),
		setApprovalModeBypassAcknowledged: (value) =>
			setState((prevState) => ({ ...prevState, approvalModeBypassAcknowledged: value })),
		setCustomModes: (value) => setState((prevState) => ({ ...prevState, customModes: value })),
		setMaxOpenTabsContext: (value) => setState((prevState) => ({ ...prevState, maxOpenTabsContext: value })),
		setMaxWorkspaceFiles: (value) => setState((prevState) => ({ ...prevState, maxWorkspaceFiles: value })),
		setTelemetrySetting: (value) => setState((prevState) => ({ ...prevState, telemetrySetting: value })),
		setShowAlphaIgnoredFiles: (value) => setState((prevState) => ({ ...prevState, showRooIgnoredFiles: value })),
		setEnableSubfolderRules: (value) => setState((prevState) => ({ ...prevState, enableSubfolderRules: value })),
		setAwsUsePromptCache: (value) => setState((prevState) => ({ ...prevState, awsUsePromptCache: value })),
		setMaxImageFileSize: (value) => setState((prevState) => ({ ...prevState, maxImageFileSize: value })),
		setMaxTotalImageSize: (value) => setState((prevState) => ({ ...prevState, maxTotalImageSize: value })),
		setPinnedApiConfigs: (value) => setState((prevState) => ({ ...prevState, pinnedApiConfigs: value })),
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
		setReasoningBlockCollapsed: (value) =>
			setState((prevState) => ({ ...prevState, reasoningBlockCollapsed: value })),
		enterBehavior: state.enterBehavior ?? "send",
		setEnterBehavior: (value) => setState((prevState) => ({ ...prevState, enterBehavior: value })),
		setHasOpenedModeSelector: (value) => setState((prevState) => ({ ...prevState, hasOpenedModeSelector: value })),
		setAutoCondenseContext: (value) => setState((prevState) => ({ ...prevState, autoCondenseContext: value })),
		setAutoCondenseContextPercent: (value) =>
			setState((prevState) => ({ ...prevState, autoCondenseContextPercent: value })),
		setProfileThresholds: (value) => setState((prevState) => ({ ...prevState, profileThresholds: value })),
		includeDiagnosticMessages: state.includeDiagnosticMessages,
		setIncludeDiagnosticMessages: (value) => {
			setState((prevState) => ({ ...prevState, includeDiagnosticMessages: value }))
		},
		maxDiagnosticMessages: state.maxDiagnosticMessages,
		setMaxDiagnosticMessages: (value) => {
			setState((prevState) => ({ ...prevState, maxDiagnosticMessages: value }))
		},
		includeTaskHistoryInEnhance,
		setIncludeTaskHistoryInEnhance,
		includeCurrentTime,
		setIncludeCurrentTime,
		includeCurrentCost,
		setIncludeCurrentCost,
		skills,
		showWorktreesInHomeScreen: state.showWorktreesInHomeScreen ?? true,
		setShowWorktreesInHomeScreen: (value) =>
			setState((prevState) => ({ ...prevState, showWorktreesInHomeScreen: value })),
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

/** Read the revision of a task transcript cached by the current webview. */
export const useCachedTranscriptRevision = (taskId: string): number | undefined => {
	const context = useContext(ExtensionStateContext)
	return context?.getCachedTranscriptRevision(taskId)
}

export const useShellState = () => {
	const context = useContext(ShellStateContext)

	if (context === undefined) {
		throw new Error("useShellState must be used within an ExtensionStateContextProvider")
	}

	return context
}
