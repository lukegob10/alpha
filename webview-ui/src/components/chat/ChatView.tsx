import React, {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import { useDeepCompareEffect, useEvent } from "react-use"
import removeMd from "remove-markdown"
import useSound from "use-sound"
import { LRUCache } from "lru-cache"

import { useDebounceEffect } from "@src/utils/useDebounceEffect"
import { appendImages } from "@src/utils/imageUtils"
import { getCostBreakdownIfNeeded } from "@src/utils/costFormatting"
import { batchConsecutive } from "@src/utils/batchConsecutive"

import type {
	AlphaAsk,
	AlphaSayTool,
	AlphaMessage,
	RequestUserInputAnswerMap,
	ToolApprovalDecision,
	ToolApprovalPrompt,
	ExtensionMessage,
	AudioType,
	QueuedMessage,
	ApprovalMode,
} from "@alpha-code/types"
import { isRetiredProvider, TaskLifecycleState } from "@alpha-code/types"

import { findLast } from "@alpha/array"
import { planModeSlug } from "@alpha/modes"
import { parsePlanModeCommand } from "@alpha/plan-mode"
import { SuggestionItem } from "@alpha-code/types"
import { combineApiRequests } from "@alpha/combineApiRequests"
import { combineCommandSequences } from "@alpha/combineCommandSequences"
import { getApiMetrics } from "@alpha/getApiMetrics"
import { getLatestTodo } from "@alpha/todo"

import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"
import { normalizeUserFacingSuggestionMode } from "@src/utils/modePresentation"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { projectLegacyLiveTaskMetadata } from "@src/context/agentLifecycleState"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import AlphaHero from "@src/components/welcome/AlphaHero"
import { StandardTooltip, Button } from "@src/components/ui"

import TelemetryBanner from "../common/TelemetryBanner"
import HistoryPreview from "../history/HistoryPreview"
import { ManagedAgentTree } from "../agents/ManagedAgentTree"
import { CrossTaskPanel } from "./CrossTaskPanel"
import Announcement from "./Announcement"
import ChatRow, { type ChatRowEnvironment } from "./ChatRow"
import WarningRow from "./WarningRow"
import { ChatTextArea } from "./ChatTextArea"
import TaskHeader from "./TaskHeader"
import { CheckpointWarning } from "./CheckpointWarning"
import { QueuedMessages } from "./QueuedMessages"
import { WorktreeSelector } from "./WorktreeSelector"
import FileChangesPanel from "./FileChangesPanel"
import { ActivityTraceToggle } from "./ActivityTraceToggle"
import { getActionActivity, getCompletedTurnActivity, type ActionActivity } from "./actionActivity"
import { fileChangeTurnsFromMessages, type FileChangeTurn } from "./utils/fileChangesFromMessages"
import { useProgressiveTranscript } from "./hooks/useProgressiveTranscript"
import { useTaskComposer } from "./hooks/useTaskComposer"
import { useChatScrollController, type ChatScrollReleaseReason } from "@src/hooks/useChatScrollController"

export interface ChatViewProps {
	historyFocusRequest?: number
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
}

export interface ChatViewRef {
	acceptInput: () => void
	sendAndSteer: (taskId?: string) => void
}

export const MAX_IMAGES_PER_MESSAGE = 20 // This is the Anthropic limit.

const messageResponseAskTypes = new Set<AlphaAsk>([
	"followup",
	"completion_result",
	"resume_task",
	"resume_completed_task",
	"mistake_limit_reached",
])
const completedTaskResponseAskTypes = new Set<AlphaAsk>(["completion_result", "resume_completed_task"])
const approvalAskTypes = new Set<AlphaAsk>(["tool", "command", "use_mcp_server"])
const MODEL_RESPONSE_DELAY_MS = 30_000
const MAX_PENDING_HOST_SENDS = 16

type PendingHostSend = { taskId: string; text: string; images: string[] }

const computeChatItemKey = (index: number, message: AlphaMessage) => `${message.ts}:${index}`

const isCompletedTaskResponseAsk = (ask: AlphaAsk | undefined) => Boolean(ask && completedTaskResponseAskTypes.has(ask))

/**
 * Recognizes an explicit user request to run context condensation without
 * treating ordinary requests that merely mention context as commands.
 */
export const isContextCondensationRequest = (text: string): boolean =>
	/^(?:(?:please|can you|could you|would you)\s+)?(?:compact|condense)\s+(?:(?:the|this)\s+)?(?:context|conversation|chat|thread)\s*[.!?]*$/i.test(
		text.trim(),
	)

function useStableConversationPromptMessages(messages: AlphaMessage[]): AlphaMessage[] {
	const key = messages
		.filter((message) => message.type === "say" && message.say === "user_feedback" && message.text?.trim())
		.map((message) => `${message.ts}:${message.text}`)
		.join("\0")
	const cached = useRef({ key: "", value: [] as AlphaMessage[] })
	if (cached.current.key !== key) {
		cached.current = {
			key,
			value: messages.filter(
				(message) => message.type === "say" && message.say === "user_feedback" && message.text?.trim(),
			),
		}
	}
	return cached.current.value
}

interface ChatTranscriptRowsProps {
	isHidden: boolean
	transcriptTaskKey: string | undefined
	transcriptStartIndex: number
	hasOlderTranscript: boolean
	task: AlphaMessage
	expandedRows: Record<number, boolean>
	isTurnActive: boolean
	chatRowEnvironment: ChatRowEnvironment
	toggleRowExpansion: (ts: number) => void
	renderedGroupedMessages: AlphaMessage[]
	actionActivity: Map<number, ActionActivity>
	expandedTraces: Record<number, boolean>
	fileChangeTurnsByEndIndex: Map<number, FileChangeTurn>
	itemContent: (index: number, message: AlphaMessage) => React.ReactNode
	loadOlderTranscript: () => void
	revealTranscriptIndex: (index: number) => void
	releaseFollow: (reason: ChatScrollReleaseReason) => void
	setTraceExpanded: (id: number, expanded: boolean) => void
	handleFileChangesExpandedChange: () => void
	loadOlderLabel: string
	loadAllLabel: string
}

const ChatTranscriptRows = memo(function ChatTranscriptRows({
	isHidden,
	transcriptTaskKey,
	transcriptStartIndex,
	hasOlderTranscript,
	task,
	expandedRows,
	isTurnActive,
	chatRowEnvironment,
	toggleRowExpansion,
	renderedGroupedMessages,
	actionActivity,
	expandedTraces,
	fileChangeTurnsByEndIndex,
	itemContent,
	loadOlderTranscript,
	revealTranscriptIndex,
	releaseFollow,
	setTraceExpanded,
	handleFileChangesExpandedChange,
	loadOlderLabel,
	loadAllLabel,
}: ChatTranscriptRowsProps) {
	if (isHidden) {
		return null
	}
	const lastRenderedMessageIndex = transcriptStartIndex + renderedGroupedMessages.length - 1

	return (
		<>
			{/* Keep the prompt outside assistant activity groups and prepend it with the oldest rows. */}
			{transcriptStartIndex === 0 && (
				<ChatRow
					key={`${transcriptTaskKey}:prompt`}
					message={task}
					isTaskPrompt
					environment={chatRowEnvironment}
					isExpanded={expandedRows[task.ts] || false}
					isLast={false}
					isStreaming={false}
					messageActionsDisabled={isTurnActive}
					onToggleExpand={toggleRowExpansion}
				/>
			)}
			{hasOlderTranscript && (
				<div className="flex justify-center gap-2 px-[15px] py-2">
					<Button
						variant="secondary"
						size="sm"
						data-testid="chat-load-older"
						onClick={() => {
							releaseFollow("load-older")
							loadOlderTranscript()
						}}>
						{loadOlderLabel}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						data-testid="chat-load-all"
						onClick={() => {
							releaseFollow("load-older")
							revealTranscriptIndex(0)
						}}>
						{loadAllLabel}
					</Button>
				</div>
			)}
			{renderedGroupedMessages.map((message, localIndex) => {
				const index = transcriptStartIndex + localIndex
				const trace = actionActivity.get(index)
				const traceExpanded = trace ? Boolean(expandedTraces[trace.id]) : false
				const fileChangeTurn = fileChangeTurnsByEndIndex.get(index)
				return (
					<div key={`${transcriptTaskKey}:${computeChatItemKey(index, message)}`}>
						{trace && index === Math.max(trace.startIndex, transcriptStartIndex) && (
							<ActivityTraceToggle
								traceId={trace.id}
								kind={trace.kind}
								count={trace.count}
								durationMs={trace.durationMs}
								active={
									isTurnActive &&
									trace.kind !== "worked" &&
									trace.endIndex === lastRenderedMessageIndex
								}
								expanded={traceExpanded}
								controls={Array.from(
									{ length: trace.endIndex - index + 1 },
									(_, offset) => `activity-row-${index + offset}`,
								).join(" ")}
								onToggle={() => {
									releaseFollow("row-expansion")
									setTraceExpanded(trace.id, !traceExpanded)
								}}
							/>
						)}
						{/* Live actions keep their listeners mounted while their details are visually folded. */}
						<div
							id={`activity-row-${index}`}
							hidden={Boolean(trace) && !traceExpanded}
							data-chat-message-index={index}
							data-testid={`chat-message-${index}`}>
							{(!trace || traceExpanded || isTurnActive) && itemContent(index, message)}
						</div>
						{fileChangeTurn && (
							<FileChangesPanel
								key={`file-changes:${fileChangeTurn.key}`}
								clineMessages={fileChangeTurn.messages}
								taskId={fileChangeTurn.key}
								onExpandedChange={handleFileChangesExpandedChange}
							/>
						)}
					</div>
				)
			})}
		</>
	)
})

const ChatViewComponent: React.ForwardRefRenderFunction<ChatViewRef, ChatViewProps> = (
	{ isHidden, showAnnouncement, hideAnnouncement, historyFocusRequest = 0 },
	ref,
) => {
	const [dismissedHistoryRequest, setDismissedHistoryRequest] = useState(0)
	const [isHistoryExpanded, setIsHistoryExpanded] = useState(false)
	const showChatsPanel = isHistoryExpanded || historyFocusRequest > dismissedHistoryRequest

	const [audioBaseUri] = useState(() => {
		return (window as unknown as { AUDIO_BASE_URI?: string }).AUDIO_BASE_URI || ""
	})

	const { t } = useAppTranslation()
	const modeShortcutText = "Shift + Tab"

	const extensionState = useExtensionState()
	const {
		clineMessages: messages,
		currentTaskId,
		currentView,
		currentTaskItem,
		currentTaskTodos,
		taskHistory,
		apiConfiguration,
		mode,
		telemetrySetting,
		soundEnabled,
		soundVolume,
		messageQueue = [],
		liveTasksById,
		agentLifecycleSnapshots,
		agentLifecycleDegraded,
		managedAgentTree,
		showWorktreesInHomeScreen,
		mcpServers,
		alwaysAllowMcp,
		currentCheckpoint,
		reasoningBlockCollapsed,
		setMode,
		getCachedTranscriptRevision,
	} = extensionState
	// Show a WarningRow when the user sends a message with a retired provider.
	const [showRetiredProviderWarning, setShowRetiredProviderWarning] = useState(false)

	// When the provider changes, clear the retired-provider warning.
	const providerName = apiConfiguration?.apiProvider
	useEffect(() => {
		setShowRetiredProviderWarning(false)
	}, [providerName])

	const [isBlankTaskView, setIsBlankTaskView] = useState(false)
	const [draftApprovalMode, setDraftApprovalMode] = useState<ApprovalMode | undefined>()
	const blankTaskSourceIdRef = useRef<string | undefined>(undefined)
	const hasSeenProviderDraftRef = useRef(false)
	const lastFocusedTaskIdRef = useRef<string | undefined>(currentTaskId)
	const isProviderDraftView = currentView?.type === "newTaskDraft" && !currentTaskId && messages.length === 0
	const isDraftView = isBlankTaskView || isProviderDraftView
	const draftTaskApprovalMode = isDraftView ? draftApprovalMode : undefined
	const previousDraftViewRef = useRef(isDraftView)
	useEffect(() => {
		if (previousDraftViewRef.current === isDraftView) return
		previousDraftViewRef.current = isDraftView
		setDraftApprovalMode(undefined)
	}, [isDraftView])
	const activeMessages = useMemo(() => (isDraftView ? [] : messages), [isDraftView, messages])
	const conversationPromptMessages = useStableConversationPromptMessages(activeMessages)
	const projectedMessageQueue = useMemo(() => (isDraftView ? [] : messageQueue), [isDraftView, messageQueue])
	const visibleCurrentTaskId = isDraftView ? undefined : currentTaskId
	const visibleTaskPayload = useMemo(
		() => (visibleCurrentTaskId ? { taskId: visibleCurrentTaskId } : {}),
		[visibleCurrentTaskId],
	)
	const openTaskWithCache = useCallback(
		(taskId: string) => {
			const cachedTranscriptRevision = getCachedTranscriptRevision(taskId)
			vscode.postMessage({
				type: "showTaskWithId",
				text: taskId,
				...(cachedTranscriptRevision === undefined ? {} : { values: { cachedTranscriptRevision } }),
			})
		},
		[getCachedTranscriptRevision],
	)
	const visibleLiveTask = visibleCurrentTaskId ? liveTasksById?.[visibleCurrentTaskId] : undefined
	const isVisibleTaskLifecycleDegraded = Boolean(
		visibleCurrentTaskId && agentLifecycleDegraded?.[visibleCurrentTaskId]?.degraded,
	)
	const legacyVisibleLiveTask =
		visibleCurrentTaskId && isVisibleTaskLifecycleDegraded
			? projectLegacyLiveTaskMetadata(extensionState, visibleCurrentTaskId, visibleLiveTask)
			: undefined
	const effectiveVisibleLiveTask = isVisibleTaskLifecycleDegraded ? legacyVisibleLiveTask : visibleLiveTask
	const isVisibleTaskCompleted = effectiveVisibleLiveTask?.lifecycle === TaskLifecycleState.Completed
	const visibleCurrentTaskItem = isDraftView ? undefined : currentTaskItem
	const isManagedSubagent = visibleCurrentTaskItem?.taskKind === "subagent"
	const canShowCrossTaskPanel = Boolean(
		visibleCurrentTaskId &&
			!visibleCurrentTaskItem?.parentTaskId &&
			!visibleCurrentTaskItem?.orchestrationParentTaskId &&
			!liveTasksById?.[visibleCurrentTaskId]?.orchestrationParentTaskId &&
			!isManagedSubagent,
	)
	const managedAgentGroups = useMemo(
		() => activeMessages.flatMap((message) => (message.subagentGroup ? [message.subagentGroup] : [])),
		[activeMessages],
	)
	const managedAgentTreeProjection =
		managedAgentTree !== undefined &&
		managedAgentTree.rootTaskId === visibleCurrentTaskId &&
		managedAgentTree.nodes.length > 1
			? managedAgentTree
			: undefined
	const showManagedAgentTree =
		!isManagedSubagent &&
		Boolean(visibleCurrentTaskId) &&
		(Boolean(managedAgentTreeProjection) || managedAgentGroups.length > 0)
	const visibleCurrentTaskTodos = useMemo(
		() => (isDraftView ? [] : currentTaskTodos),
		[isDraftView, currentTaskTodos],
	)
	const messagesRef = useRef(activeMessages)
	const isBlankTaskPendingRef = useRef(false)
	const pendingHostSendsRef = useRef<PendingHostSend[]>([])
	const getAlphaMessages = useCallback(() => messagesRef.current, [])

	// Interaction routing must observe the transcript that committed with the
	// visible row, before passive ask-control effects can update their state.
	useLayoutEffect(() => {
		messagesRef.current = activeMessages
	}, [activeMessages])

	useEffect(() => {
		if (currentTaskId) {
			lastFocusedTaskIdRef.current = currentTaskId
		}
	}, [currentTaskId])

	useEffect(() => {
		if (currentView?.type === "newTaskDraft") {
			hasSeenProviderDraftRef.current = true
		}

		if (!isBlankTaskView) {
			return
		}

		const providerSelectedTask =
			currentView?.type === "task" &&
			currentTaskId &&
			(hasSeenProviderDraftRef.current || currentTaskId !== blankTaskSourceIdRef.current)
		const legacySelectedDifferentTask =
			!currentView && currentTaskId && currentTaskId !== blankTaskSourceIdRef.current

		if (providerSelectedTask || legacySelectedDifferentTask) {
			setIsBlankTaskView(false)
			isBlankTaskPendingRef.current = false
		}
	}, [currentTaskId, currentView, isBlankTaskView, messages.length])

	// Leaving this less safe version here since if the first message is not a
	// task, then the extension is in a bad state and needs to be debugged (see
	// Alpha.abort).
	const task = useMemo(() => {
		const firstMessage = activeMessages.at(0)

		if (firstMessage) {
			return firstMessage
		}

		if (!visibleCurrentTaskId) {
			return undefined
		}

		return {
			ts: visibleCurrentTaskItem?.ts ?? 0,
			type: "say" as const,
			say: "text" as const,
			text: visibleCurrentTaskItem?.task ?? "",
		}
	}, [visibleCurrentTaskId, visibleCurrentTaskItem?.task, visibleCurrentTaskItem?.ts, activeMessages])

	const latestTodos = useMemo(() => {
		// First check if we have initial todos from the state (for new subtasks)
		if (visibleCurrentTaskTodos && visibleCurrentTaskTodos.length > 0) {
			// Check if there are any todo updates in messages
			const messageBasedTodos = getLatestTodo(activeMessages)
			// If there are message-based todos, they take precedence (user has updated them)
			if (messageBasedTodos && messageBasedTodos.length > 0) {
				return messageBasedTodos
			}
			// Otherwise use the initial todos from state
			return visibleCurrentTaskTodos
		}
		// Fall back to extracting from messages
		return getLatestTodo(activeMessages)
	}, [activeMessages, visibleCurrentTaskTodos])

	const {
		inputValue,
		setInputValue,
		selectedImages,
		setSelectedImages,
		editingQueuedMessage,
		setEditingQueuedMessage,
		pendingQueueRequest,
		setPendingQueueRequest,
		pendingSteerRequest,
		setPendingSteerRequest,
		pendingEditRequest,
		setPendingEditRequest,
		pendingResumeRequest,
		setPendingResumeRequest,
		pendingAskRequests,
		setPendingAskRequests,
		chatCommandError,
		setChatCommandError,
		getTaskDraft,
		updateTaskDraft,
	} = useTaskComposer(visibleCurrentTaskId)
	const [answeredAsyncUserInputTs, setAnsweredAsyncUserInputTs] = useState<Set<string>>(() => new Set())
	const pendingAsyncUserInputTs = useMemo(
		() =>
			new Set(
				[pendingQueueRequest, pendingResumeRequest, ...pendingAskRequests].flatMap((submission) =>
					submission?.asyncUserInputMessageTs === undefined ? [] : [submission.asyncUserInputMessageTs],
				),
			),
		[pendingQueueRequest, pendingResumeRequest, pendingAskRequests],
	)
	const transcriptQueuedMessageIds = useMemo(
		() => new Set(activeMessages.flatMap((message) => message.queuedMessageIds ?? [])),
		[activeMessages],
	)
	// A completed-chat submission is already the next user message. Its durable
	// queue receipt protects delivery but should not move it into the queue UI.
	const visibleMessageQueue = useMemo(
		() =>
			projectedMessageQueue.filter(
				(message) =>
					message.id !== pendingResumeRequest?.requestId &&
					!(message.deliveryState === "delivering" && transcriptQueuedMessageIds.has(message.id)),
			),
		[projectedMessageQueue, pendingResumeRequest?.requestId, transcriptQueuedMessageIds],
	)
	const pendingResumeMessage = useMemo<AlphaMessage | undefined>(
		() =>
			pendingResumeRequest && !transcriptQueuedMessageIds.has(pendingResumeRequest.requestId)
				? {
						type: "say",
						say: "user_feedback",
						ts: pendingResumeRequest.clientSubmittedAt ?? 0,
						text: pendingResumeRequest.text,
						images: pendingResumeRequest.images,
						queuedMessageIds: [pendingResumeRequest.requestId],
					}
				: undefined,
		[pendingResumeRequest, transcriptQueuedMessageIds],
	)
	const modifiedMessages = useMemo(() => {
		const combined = combineApiRequests(combineCommandSequences(activeMessages.slice(1)))
		return pendingResumeMessage ? [...combined, pendingResumeMessage] : combined
	}, [activeMessages, pendingResumeMessage])
	// Has to be after api_req_finished are all reduced into api_req_started messages.
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])
	// Host admission is asynchronous. Show the exact submitted input until the
	// task-owned queue projection arrives, without granting local queue authority.
	const pendingQueuePreview =
		pendingQueueRequest && !visibleMessageQueue.some((message) => message.id === pendingQueueRequest.requestId)
			? {
					id: pendingQueueRequest.requestId,
					timestamp: pendingQueueRequest.clientSubmittedAt ?? 0,
					text: pendingQueueRequest.text,
					images: pendingQueueRequest.images,
				}
			: undefined
	const displayedMessageQueue = pendingQueuePreview
		? [...visibleMessageQueue, pendingQueuePreview]
		: visibleMessageQueue
	const inputValueRef = useRef(inputValue)
	const textAreaRef = useRef<HTMLTextAreaElement>(null)
	const closeChatsPanel = useCallback(() => {
		setIsHistoryExpanded(false)
		setDismissedHistoryRequest(historyFocusRequest)
		textAreaRef.current?.focus()
	}, [historyFocusRequest])
	const [sendingDisabled, setSendingDisabled] = useState(false)
	const selectedImagesRef = useRef(selectedImages)
	const pendingQueueRequestRef = useRef(pendingQueueRequest)
	const pendingSteerRequestRef = useRef(pendingSteerRequest)
	const pendingEditRequestRef = useRef(pendingEditRequest)
	const pendingResumeRequestRef = useRef(pendingResumeRequest)
	const pendingAskRequestsRef = useRef(pendingAskRequests)
	useEffect(() => {
		if (!pendingResumeRequest || !transcriptQueuedMessageIds.has(pendingResumeRequest.requestId)) return
		if (pendingResumeRequestRef.current?.requestId === pendingResumeRequest.requestId) {
			pendingResumeRequestRef.current = null
		}
		setPendingResumeRequest((current) => (current?.requestId === pendingResumeRequest.requestId ? null : current))
	}, [pendingResumeRequest, transcriptQueuedMessageIds, setPendingResumeRequest])
	useLayoutEffect(() => {
		inputValueRef.current = inputValue
		selectedImagesRef.current = selectedImages
		pendingQueueRequestRef.current = pendingQueueRequest
		pendingSteerRequestRef.current = pendingSteerRequest
		pendingEditRequestRef.current = pendingEditRequest
		pendingResumeRequestRef.current = pendingResumeRequest
		pendingAskRequestsRef.current = pendingAskRequests
	}, [
		inputValue,
		selectedImages,
		pendingQueueRequest,
		pendingSteerRequest,
		pendingEditRequest,
		pendingResumeRequest,
		pendingAskRequests,
	])
	const [activityClock, setActivityClock] = useState(() => Date.now())
	const [notificationTaskIds, setNotificationTaskIds] = useState<string[]>([])
	useEffect(() => {
		setNotificationTaskIds((current) => current.filter((taskId) => taskId !== visibleCurrentTaskId))
	}, [visibleCurrentTaskId])

	// We need to hold on to the ask because useEffect > lastMessage will always
	// let us know when an ask comes in and handle it, but by the time
	// handleMessage is called, the last message might not be the ask anymore
	// (it could be a say that followed).
	const [alphaAsk, setAlphaAsk] = useState<AlphaAsk | undefined>(undefined)
	const [enableButtons, setEnableButtons] = useState<boolean>(false)
	const [primaryButtonText, setPrimaryButtonText] = useState<string | undefined>(undefined)
	const [secondaryButtonText, setSecondaryButtonText] = useState<string | undefined>(undefined)
	const [tertiaryButtonText, setTertiaryButtonText] = useState<string | undefined>(undefined)
	const [toolApprovalRequest, setToolApprovalRequest] = useState<ToolApprovalPrompt | undefined>(undefined)
	const approvalTaskIdRef = useRef(visibleCurrentTaskId)
	const isCompletedTaskResumePending = Boolean(
		visibleCurrentTaskId && pendingResumeRequest?.taskId === visibleCurrentTaskId,
	)
	const latestVisibleMessage = activeMessages.at(-1)
	const completedTaskResponseAsk = isCompletedTaskResponseAsk(alphaAsk)
		? alphaAsk
		: latestVisibleMessage?.type === "ask" && isCompletedTaskResponseAsk(latestVisibleMessage.ask)
			? latestVisibleMessage.ask
			: undefined
	const hasCompletedTranscriptBoundary = isVisibleTaskCompleted || completedTaskResponseAsk !== undefined
	const hasOpenCompletedTaskResponseBoundary =
		completedTaskResponseAsk === "resume_completed_task" ||
		(completedTaskResponseAsk === "completion_result" && !isVisibleTaskCompleted)
	// A completion ask is a user-facing review boundary, even if the task
	// metadata still reports the underlying model turn as active. Keep the
	// provider selector usable at that boundary so a stale turn flag cannot
	// leave the completed-task composer partially disabled.
	const isCompletedTaskResponseBoundary = completedTaskResponseAsk !== undefined
	const isVisibleTaskFailedOrClosed =
		effectiveVisibleLiveTask?.lifecycle === TaskLifecycleState.Failed ||
		effectiveVisibleLiveTask?.lifecycle === TaskLifecycleState.Closed
	const shouldClearTerminalControls =
		isVisibleTaskFailedOrClosed || (isVisibleTaskCompleted && !hasOpenCompletedTaskResponseBoundary)
	useEffect(() => {
		// If fallback metadata recovers a task from stale terminal state, clear the
		// disabled controls; the transcript effect below restores any ask/streaming
		// controls that still apply.
		if (isVisibleTaskLifecycleDegraded && !shouldClearTerminalControls) {
			setSendingDisabled(false)
			setAlphaAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)
			return
		}
		if (!shouldClearTerminalControls) return
		setSendingDisabled(true)
		setAlphaAsk(undefined)
		setEnableButtons(false)
		setPrimaryButtonText(undefined)
		setSecondaryButtonText(undefined)
	}, [isVisibleTaskLifecycleDegraded, shouldClearTerminalControls, visibleCurrentTaskId])
	const [_didClickCancel, setDidClickCancel] = useState(false)
	const transcriptScrollerRef = useRef<HTMLDivElement | null>(null)
	const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
	const prevExpandedRowsRef = useRef<Record<number, boolean>>()
	const lastTtsRef = useRef<string>("")
	const [wasStreaming, setWasStreaming] = useState<boolean>(false)
	const [checkpointWarningState, setCheckpointWarningState] = useState<
		| {
				taskId: string
				warning: { type: "WAIT_TIMEOUT" | "INIT_TIMEOUT"; timeout: number }
		  }
		| undefined
	>(undefined)
	const [isCondensing, setIsCondensing] = useState<boolean>(false)
	const everVisibleMessagesTsRef = useRef<LRUCache<number, boolean>>(
		new LRUCache({
			max: 100,
			ttl: 1000 * 60 * 5,
		}),
	)
	const autoApproveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const userRespondedRef = useRef<boolean>(false)
	const [currentFollowUpTs, setCurrentFollowUpTs] = useState<number | null>(null)
	const submittedFollowUpRef = useRef<{ taskId: string | undefined; ts: number }>()
	const [aggregatedCostsMap, setAggregatedCostsMap] = useState<
		Map<
			string,
			{
				totalCost: number
				ownCost: number
				childrenCost: number
			}
		>
	>(new Map())

	const alphaAskRef = useRef(alphaAsk)
	useEffect(() => {
		alphaAskRef.current = alphaAsk
	}, [alphaAsk])

	// Keep inputValueRef in sync with inputValue state
	useEffect(() => {
		inputValueRef.current = inputValue
	}, [inputValue])

	useEffect(() => {
		selectedImagesRef.current = selectedImages
	}, [selectedImages])

	// Compute whether auto-approval is paused (user is typing in a followup)
	const isFollowUpAutoApprovalPaused = useMemo(() => {
		return !!(inputValue && inputValue.trim().length > 0 && alphaAsk === "followup")
	}, [inputValue, alphaAsk])

	// Cancel auto-approval timeout when user starts typing
	useEffect(() => {
		// Only send cancel if there's actual input (user is typing)
		// and we have a pending follow-up question
		if (isFollowUpAutoApprovalPaused) {
			vscode.postMessage({ type: "cancelAutoApproval", ...visibleTaskPayload })
		}
	}, [isFollowUpAutoApprovalPaused, visibleTaskPayload])

	const isProfileDisabled = false

	// UI layout depends on the last 2 messages (since it relies on the content
	// of these messages, we are deep comparing) i.e. the button state after
	// hitting button sets enableButtons to false,  and this effect otherwise
	// would have to true again even if messages didn't change.
	const lastMessage = useMemo(() => activeMessages.at(-1), [activeMessages])
	const secondLastMessage = useMemo(() => activeMessages.at(-2), [activeMessages])
	const isLastFollowUpAnswered = lastMessage?.ask === "followup" && lastMessage.isAnswered === true

	const volume = typeof soundVolume === "number" ? soundVolume : 0.5
	const [playNotification] = useSound(`${audioBaseUri}/notification.wav`, { volume, soundEnabled, interrupt: true })
	const [playCelebration] = useSound(`${audioBaseUri}/celebration.wav`, { volume, soundEnabled, interrupt: true })
	const [playProgressLoop] = useSound(`${audioBaseUri}/progress_loop.wav`, { volume, soundEnabled, interrupt: true })

	const lastPlayedRef = useRef<Record<string, number>>({})

	const playSound = useCallback(
		(audioType: AudioType) => {
			if (!soundEnabled) {
				return
			}

			const now = Date.now()
			const lastPlayed = lastPlayedRef.current[audioType] ?? 0
			if (now - lastPlayed < 100) {
				return
			} // debounce: skip if played within 100ms
			lastPlayedRef.current[audioType] = now

			switch (audioType) {
				case "notification":
					playNotification()
					break
				case "celebration":
					playCelebration()
					break
				case "progress_loop":
					playProgressLoop()
					break
				default:
					console.warn(`Unknown audio type: ${audioType}`)
			}
		},
		[soundEnabled, playNotification, playCelebration, playProgressLoop],
	)

	function playTts(text: string) {
		vscode.postMessage({ type: "playTts", text })
	}

	useDeepCompareEffect(() => {
		if (approvalTaskIdRef.current !== visibleCurrentTaskId) {
			approvalTaskIdRef.current = visibleCurrentTaskId
			setToolApprovalRequest(undefined)
			setTertiaryButtonText(undefined)
			setAlphaAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)
			setSendingDisabled(false)
		}
		// if last message is an ask, show user ask UI
		// if user finished a task, then start a new task with a new conversation history since in this moment that the extension is waiting for user response, the user could close the extension and the conversation history would be lost.
		// basically as long as a task is active, the conversation history will be persisted
		if (lastMessage) {
			if (lastMessage.type !== "ask") {
				setToolApprovalRequest(undefined)
				setTertiaryButtonText(undefined)
			}
			switch (lastMessage.type) {
				case "ask":
					// Reset user response flag when a new ask arrives to allow auto-approval
					userRespondedRef.current = false
					if (
						lastMessage.toolApprovalRequest &&
						lastMessage.toolApprovalRequest.taskId !== visibleCurrentTaskId
					) {
						setToolApprovalRequest(undefined)
						setTertiaryButtonText(undefined)
						setAlphaAsk(undefined)
						setEnableButtons(false)
						setPrimaryButtonText(undefined)
						setSecondaryButtonText(undefined)
						break
					}
					if (lastMessage.isAnswered) {
						setToolApprovalRequest(undefined)
						setTertiaryButtonText(undefined)
						setAlphaAsk(undefined)
						setEnableButtons(false)
						setSendingDisabled(false)
						setPrimaryButtonText(undefined)
						setSecondaryButtonText(undefined)
						break
					}
					setToolApprovalRequest(lastMessage.toolApprovalRequest)
					setTertiaryButtonText(undefined)
					const isPartial = lastMessage.partial === true
					switch (lastMessage.ask) {
						case "api_req_failed":
							playSound("progress_loop")
							setSendingDisabled(true)
							setAlphaAsk("api_req_failed")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:retry.title"))
							setSecondaryButtonText(t("chat:startNewTask.title"))
							break
						case "mistake_limit_reached":
							playSound("progress_loop")
							setSendingDisabled(false)
							setAlphaAsk("mistake_limit_reached")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:proceedAnyways.title"))
							setSecondaryButtonText(t("chat:startNewTask.title"))
							break
						case "followup":
							if (lastMessage.isAnswered || isVisibleTaskCompleted) {
								setSendingDisabled(false)
								setAlphaAsk(undefined)
								setEnableButtons(false)
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(undefined)
								break
							}
							setSendingDisabled(isPartial)
							setAlphaAsk("followup")
							// setting enable buttons to `false` would trigger a focus grab when
							// the text area is enabled which is undesirable.
							// We have no buttons for this tool, so no problem having them "enabled"
							// to workaround this issue.  See #1358.
							setEnableButtons(true)
							setPrimaryButtonText(undefined)
							setSecondaryButtonText(undefined)
							break
						case "tool":
							setSendingDisabled(isPartial)
							setAlphaAsk("tool")
							setEnableButtons(!isPartial)
							if (isPartial) {
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(undefined)
								break
							}
							if (lastMessage.toolApprovalRequest) {
								setPrimaryButtonText(t("chat:approveOnce.title"))
								setSecondaryButtonText(t("chat:reject.title"))
								setTertiaryButtonText(t("chat:approvalAbort.title"))
								break
							}
							const tool = JSON.parse(lastMessage.text || "{}") as AlphaSayTool
							switch (tool.tool) {
								case "editedExistingFile":
								case "appliedDiff":
								case "newFileCreated":
									if (tool.batchDiffs && Array.isArray(tool.batchDiffs)) {
										setPrimaryButtonText(t("chat:edit-batch.approve.title"))
										setSecondaryButtonText(t("chat:edit-batch.deny.title"))
									} else {
										setPrimaryButtonText(t("chat:save.title"))
										setSecondaryButtonText(t("chat:reject.title"))
									}
									break
								case "generateImage":
									setPrimaryButtonText(t("chat:save.title"))
									setSecondaryButtonText(t("chat:reject.title"))
									break
								case "finishTask":
									setPrimaryButtonText(t("chat:completeSubtaskAndReturn"))
									setSecondaryButtonText(undefined)
									break
								case "spawnAgent":
								case "delegateTask":
									setPrimaryButtonText(undefined)
									setSecondaryButtonText(undefined)
									break
								case "readFile":
									if (tool.batchFiles && Array.isArray(tool.batchFiles)) {
										setPrimaryButtonText(t("chat:read-batch.approve.title"))
										setSecondaryButtonText(t("chat:read-batch.deny.title"))
									} else {
										setPrimaryButtonText(t("chat:approve.title"))
										setSecondaryButtonText(t("chat:reject.title"))
									}
									break
								case "listFilesTopLevel":
								case "listFilesRecursive":
									if (tool.batchDirs && Array.isArray(tool.batchDirs)) {
										setPrimaryButtonText(t("chat:list-batch.approve.title"))
										setSecondaryButtonText(t("chat:list-batch.deny.title"))
									} else {
										setPrimaryButtonText(t("chat:approve.title"))
										setSecondaryButtonText(t("chat:reject.title"))
									}
									break
								default:
									setPrimaryButtonText(t("chat:approve.title"))
									setSecondaryButtonText(t("chat:reject.title"))
									break
							}
							break
						case "command":
							setSendingDisabled(isPartial)
							setAlphaAsk("command")
							setEnableButtons(!isPartial)
							if (isPartial) {
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(undefined)
								break
							}
							if (lastMessage.toolApprovalRequest) {
								setPrimaryButtonText(t("chat:approveOnce.title"))
								setSecondaryButtonText(t("chat:reject.title"))
								setTertiaryButtonText(t("chat:approvalAbort.title"))
								break
							}
							setPrimaryButtonText(t("chat:runCommand.title"))
							setSecondaryButtonText(t("chat:reject.title"))
							break
						case "command_output":
							setSendingDisabled(false)
							setAlphaAsk("command_output")
							setEnableButtons(true)
							setPrimaryButtonText(undefined)
							setSecondaryButtonText(t("chat:killCommand.title"))
							break
						case "use_mcp_server":
							setSendingDisabled(isPartial)
							setAlphaAsk("use_mcp_server")
							setEnableButtons(!isPartial)
							if (isPartial) {
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(undefined)
								break
							}
							if (lastMessage.toolApprovalRequest) {
								setPrimaryButtonText(t("chat:approveOnce.title"))
								setSecondaryButtonText(t("chat:reject.title"))
								setTertiaryButtonText(t("chat:approvalAbort.title"))
								break
							}
							setPrimaryButtonText(t("chat:approve.title"))
							setSecondaryButtonText(t("chat:reject.title"))
							break
						case "completion_result":
							// The button starts a separate task. Composer submission remains a follow-up
							// in this task so the current thread and its context are preserved.
							// Only play celebration sound if there are no queued messages.
							if (!isPartial && visibleMessageQueue.length === 0) {
								playSound("celebration")
							}
							setSendingDisabled(isPartial)
							setAlphaAsk("completion_result")
							setEnableButtons(!isPartial)
							setPrimaryButtonText(t("chat:startNewTask.title"))
							setSecondaryButtonText(undefined)
							break
						case "resume_task":
							setSendingDisabled(false)
							setAlphaAsk("resume_task")
							setEnableButtons(true)
							// For completed subtasks, show the new-chat action instead of "Resume"
							// A subtask is considered completed if:
							// - It has a parentTaskId AND
							// - Its messages contain a completion_result (either ask or say)
							const isCompletedSubtask =
								visibleCurrentTaskItem?.parentTaskId &&
								activeMessages.some(
									(msg) => msg.ask === "completion_result" || msg.say === "completion_result",
								)
							if (isCompletedSubtask) {
								setPrimaryButtonText(t("chat:startNewTask.title"))
								setSecondaryButtonText(undefined)
							} else {
								setPrimaryButtonText(t("chat:resumeTask.title"))
								setSecondaryButtonText(t("chat:terminate.title"))
							}
							setDidClickCancel(false) // special case where we reset the cancel button state
							break
						case "resume_completed_task":
							setSendingDisabled(false)
							setAlphaAsk("resume_completed_task")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:startNewTask.title"))
							setSecondaryButtonText(undefined)
							setDidClickCancel(false)
							break
					}
					break
				case "say":
					// Don't want to reset since there could be a "say" after
					// an "ask" while ask is waiting for response.
					switch (lastMessage.say) {
						case "api_req_retry_delayed":
						case "api_req_rate_limit_wait":
							setSendingDisabled(true)
							break
						case "api_req_started":
							// Clear button state when a new API request starts
							// This fixes buttons persisting when the task continues
							setSendingDisabled(true)
							// Note: Do NOT clear selectedImages here. This handler fires
							// every time the backend starts an API call, which would wipe
							// images the user has pasted while the chat is in progress.
							// Images are already cleared in the appropriate user-action
							// handlers (handleSendMessage, handlePrimaryButtonClick, etc.).
							setAlphaAsk(undefined)
							setEnableButtons(false)
							setPrimaryButtonText(undefined)
							setSecondaryButtonText(undefined)
							break
						case "api_req_finished":
						case "error":
						case "text":
						case "command_output":
						case "mcp_server_request_started":
						case "mcp_server_response":
						case "completion_result":
							break
					}
					break
			}
		}
	}, [lastMessage, secondLastMessage, isVisibleTaskCompleted, visibleCurrentTaskId])

	// Update button text when messages change (e.g., completion_result is added) for subtasks in resume_task state
	useEffect(() => {
		if (alphaAsk === "resume_task" && visibleCurrentTaskItem?.parentTaskId) {
			const hasCompletionResult = activeMessages.some(
				(msg) => msg.ask === "completion_result" || msg.say === "completion_result",
			)
			if (hasCompletionResult) {
				setPrimaryButtonText(t("chat:startNewTask.title"))
				setSecondaryButtonText(undefined)
			}
		}
	}, [alphaAsk, visibleCurrentTaskItem?.parentTaskId, activeMessages, t])

	useEffect(() => {
		if (activeMessages.length === 0) {
			setSendingDisabled(false)
			setAlphaAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)
		}
	}, [activeMessages.length])

	// Reset UI states when task changes. The scroll controller has its own
	// task-keyed layout effect.
	useEffect(() => {
		setExpandedRows({})
		everVisibleMessagesTsRef.current.clear()
		setCurrentFollowUpTs(null)
		setIsCondensing(false)

		if (autoApproveTimeoutRef.current) {
			clearTimeout(autoApproveTimeoutRef.current)
			autoApproveTimeoutRef.current = null
		}
		userRespondedRef.current = false
	}, [task?.ts])

	const taskTs = task?.ts

	// Request aggregated costs when task changes and has childIds
	useEffect(() => {
		if (taskTs && visibleCurrentTaskItem?.childIds && visibleCurrentTaskItem.childIds.length > 0) {
			vscode.postMessage({
				type: "getTaskWithAggregatedCosts",
				text: visibleCurrentTaskItem.id,
			})
		}
	}, [taskTs, visibleCurrentTaskItem?.id, visibleCurrentTaskItem?.childIds])

	useEffect(() => {
		const cache = everVisibleMessagesTsRef.current
		return () => {
			cache.clear()
		}
	}, [])

	const legacyIsStreaming = useMemo(() => {
		// Checking alphaAsk isn't enough since messages effect may be called
		// again for a tool for example, set alphaAsk to its value, and if the
		// next message is not an ask then it doesn't reset. This is likely due
		// to how much more often we're updating messages as compared to before,
		// and should be resolved with optimizations as it's likely a rendering
		// bug. But as a final guard for now, the cancel button will show if the
		// last message is not an ask.
		const isLastAsk = !!modifiedMessages.at(-1)?.ask

		const isToolCurrentlyAsking =
			isLastAsk && alphaAsk !== undefined && enableButtons && primaryButtonText !== undefined

		if (isToolCurrentlyAsking) {
			return false
		}

		const isLastMessagePartial = modifiedMessages.at(-1)?.partial === true

		if (isLastMessagePartial) {
			return true
		} else {
			const lastApiReqStarted = findLast(
				modifiedMessages,
				(message: AlphaMessage) => message.say === "api_req_started",
			)

			if (
				lastApiReqStarted &&
				lastApiReqStarted.text !== null &&
				lastApiReqStarted.text !== undefined &&
				lastApiReqStarted.say === "api_req_started"
			) {
				let cost: unknown
				try {
					cost = (JSON.parse(lastApiReqStarted.text) as { cost?: unknown }).cost
				} catch {
					// Corrupt or pre-migration transcript data must not crash the composer.
					return false
				}

				if (cost === undefined) {
					return true // API request has not finished yet.
				}
			}
		}

		return false
	}, [modifiedMessages, alphaAsk, enableButtons, primaryButtonText])
	const isTurnActive =
		effectiveVisibleLiveTask?.isTurnActive ?? effectiveVisibleLiveTask?.isStreaming ?? legacyIsStreaming
	const isToolCurrentlyAsking =
		Boolean(modifiedMessages.at(-1)?.ask) &&
		alphaAsk !== undefined &&
		enableButtons &&
		primaryButtonText !== undefined
	const isStreaming = isTurnActive && !effectiveVisibleLiveTask?.isWaitingForInput && !isToolCurrentlyAsking
	const visibleLifecycleSnapshot = visibleCurrentTaskId ? agentLifecycleSnapshots?.[visibleCurrentTaskId] : undefined
	const hasPendingToolCalls = useMemo(() => {
		if (!visibleLifecycleSnapshot) return false
		const completed = new Set(visibleLifecycleSnapshot.terminalToolCallIds)
		return visibleLifecycleSnapshot.acceptedToolCallIds.some((id) => !completed.has(id))
	}, [visibleLifecycleSnapshot])
	// Silence is expected while tools (including wait_agent), compaction, or other runtime phases run.
	// Missing/degraded phase data cannot establish that the model is the source of a delay.
	const isModelResponseDelayed =
		isStreaming &&
		!isVisibleTaskLifecycleDegraded &&
		effectiveVisibleLiveTask?.activityPhase === "working" &&
		!hasPendingToolCalls &&
		Boolean(effectiveVisibleLiveTask?.lastUpdatedAt) &&
		activityClock - (effectiveVisibleLiveTask?.lastUpdatedAt ?? activityClock) >= MODEL_RESPONSE_DELAY_MS

	useEffect(() => {
		if (!isTurnActive) return
		setActivityClock(Date.now())
		const interval = setInterval(() => setActivityClock(Date.now()), 5_000)
		return () => clearInterval(interval)
	}, [isTurnActive, visibleCurrentTaskId])

	const markFollowUpAsAnswered = useCallback(() => {
		const lastFollowUpMessage = messagesRef.current.findLast((msg: AlphaMessage) => msg.ask === "followup")
		if (lastFollowUpMessage) {
			setCurrentFollowUpTs(lastFollowUpMessage.ts)
		}
	}, [])

	const handleChatReset = useCallback(() => {
		// Clear any pending auto-approval timeout
		if (autoApproveTimeoutRef.current) {
			clearTimeout(autoApproveTimeoutRef.current)
			autoApproveTimeoutRef.current = null
		}
		// Reset user response flag for new message
		userRespondedRef.current = false

		// Only reset message-specific state, preserving mode.
		setInputValue("")
		setSendingDisabled(true)
		setSelectedImages([])
		setAlphaAsk(undefined)
		setEnableButtons(false)
		// Do not reset mode here as it should persist.
		// setPrimaryButtonText(undefined)
		// setSecondaryButtonText(undefined)
	}, [setInputValue, setSelectedImages])

	const enterBlankTaskView = useCallback(() => {
		setShowRetiredProviderWarning(false)
		blankTaskSourceIdRef.current = currentTaskId ?? lastFocusedTaskIdRef.current
		hasSeenProviderDraftRef.current = currentView?.type === "newTaskDraft"
		isBlankTaskPendingRef.current = true
		messagesRef.current = []
		setIsBlankTaskView(true)
		// Keep the chat's draft while navigating to the separate new-chat composer.
		setAlphaAsk(undefined)
		setEnableButtons(false)
		setSendingDisabled(false)
		setPrimaryButtonText(undefined)
		setSecondaryButtonText(undefined)

		setTimeout(() => textAreaRef.current?.focus(), 0)
	}, [currentTaskId, currentView?.type])

	const startNewTask = useCallback(
		(text?: string, images: string[] = []) => {
			const trimmedInput = text?.trim() ?? ""
			enterBlankTaskView()

			if (trimmedInput || images.length > 0) {
				isBlankTaskPendingRef.current = false
				vscode.postMessage({
					type: "newTask",
					text: trimmedInput,
					images,
					...(draftTaskApprovalMode ? { taskApprovalMode: draftTaskApprovalMode } : {}),
				})
				return
			}

			vscode.postMessage({ type: "startBlankTask" })
		},
		[draftTaskApprovalMode, enterBlankTaskView],
	)
	const getCurrentAskMessageTs = useCallback(
		() =>
			alphaAskRef.current
				? messagesRef.current.findLast(
						(message) =>
							message.type === "ask" &&
							message.ask === alphaAskRef.current &&
							!message.partial &&
							!message.isAnswered,
					)?.ts
				: undefined,
		[],
	)

	const handleCondenseContext = useCallback(
		(taskId: string) => {
			if (isCondensing || sendingDisabled) {
				return
			}
			setIsCondensing(true)
			setSendingDisabled(true)
			vscode.postMessage({ type: "condenseTaskContextRequest", text: taskId })
		},
		[isCondensing, sendingDisabled],
	)

	const postQueuedMessage = useCallback(
		(text: string, images: string[], asyncUserInputMessageTs?: number, steer = false) => {
			// Queue messages are task-scoped on the extension side. Preserve the draft
			// during transient view/task state instead of posting a request it will reject.
			if (!visibleCurrentTaskId || pendingQueueRequestRef.current) {
				return false
			}

			const requestId = crypto.randomUUID()
			const request = {
				requestId,
				taskId: visibleCurrentTaskId,
				text,
				images: [...images],
				clientSubmittedAt: Date.now(),
				...(steer ? { command: "sendAndSteer" as const } : {}),
				...(asyncUserInputMessageTs === undefined ? {} : { asyncUserInputMessageTs }),
			}
			pendingQueueRequestRef.current = request
			setPendingQueueRequest(request)
			setChatCommandError(undefined)
			vscode.postMessage({
				type: steer ? "sendAndSteer" : "queueMessage",
				text,
				images,
				taskId: visibleCurrentTaskId,
				requestId,
				clientSubmittedAt: request.clientSubmittedAt,
				...(asyncUserInputMessageTs === undefined ? {} : { asyncUserInputMessageTs }),
			})
			return true
		},
		[visibleCurrentTaskId, setChatCommandError, setPendingQueueRequest],
	)

	/**
	 * Handles sending messages to the extension
	 * @param text - The message text to send
	 * @param images - Array of image data URLs to send with the message
	 */
	const handleSendMessage = useCallback(
		(text: string, images: string[], asyncUserInputMessageTs?: number, steer = false): boolean => {
			text = text.trim()
			const planCommand = parsePlanModeCommand(text)

			if (!text && images.length === 0) {
				return false
			}
			if (pendingResumeRequestRef.current || pendingEditRequestRef.current) {
				return false
			}

			if (editingQueuedMessage) {
				if (editingQueuedMessage.taskId !== visibleCurrentTaskId) return false
				const requestId = crypto.randomUUID()
				const request = {
					requestId,
					taskId: editingQueuedMessage.taskId,
					messageId: editingQueuedMessage.id,
					text,
					images: [...images],
				}
				pendingEditRequestRef.current = request
				setPendingEditRequest(request)
				setChatCommandError(undefined)
				vscode.postMessage({
					type: "editQueuedMessage",
					requestId,
					payload: {
						id: editingQueuedMessage.id,
						text,
						images,
					},
					taskId: editingQueuedMessage.taskId,
				})
				return true
			}

			// Intercept when the active provider is retired; show a WarningRow instead of sending.
			if (apiConfiguration?.apiProvider && isRetiredProvider(apiConfiguration.apiProvider)) {
				setShowRetiredProviderWarning(true)
				return false
			}

			if (planCommand) {
				const isPlanCommandUnavailable =
					isTurnActive ||
					visibleMessageQueue.length > 0 ||
					isLastFollowUpAnswered ||
					alphaAskRef.current === "command_output" ||
					(alphaAskRef.current !== undefined && approvalAskTypes.has(alphaAskRef.current))

				// Match the CLI contract: mode commands do not become queued user
				// messages while the current turn or an approval boundary is active.
				if (isPlanCommandUnavailable) return false

				if (!planCommand.prompt && images.length === 0) {
					if (mode !== planModeSlug) {
						setMode(planModeSlug)
						vscode.postMessage({ type: "mode", text: planModeSlug })
					}
					setInputValue("")
					setSelectedImages([])
					return true
				}

				// Keep `/plan` attached to the user message. The extension host parses
				// and admits the mode transition before persisting or sending the turn,
				// so a rejected Plan transition can never leak this prompt into Code.
			}

			if (isVisibleTaskCompleted && !hasOpenCompletedTaskResponseBoundary && visibleCurrentTaskId) {
				const requestId = crypto.randomUUID()
				const request = {
					requestId,
					taskId: visibleCurrentTaskId,
					text,
					images: [...images],
					clientSubmittedAt: Math.max(Date.now(), (messagesRef.current.at(-1)?.ts ?? 0) + 1),
					...(asyncUserInputMessageTs === undefined ? {} : { asyncUserInputMessageTs }),
				}
				pendingResumeRequestRef.current = request
				setPendingResumeRequest(request)
				vscode.postMessage({
					type: "resumeCompletedTask",
					requestId,
					taskId: visibleCurrentTaskId,
					text,
					images,
					...(asyncUserInputMessageTs === undefined ? {} : { asyncUserInputMessageTs }),
				})
				handleChatReset()
				setPrimaryButtonText(undefined)
				setSecondaryButtonText(undefined)
				return true
			}

			if (isVisibleTaskFailedOrClosed) {
				startNewTask(text, images)
				return true
			}

			const currentInputBoundary = messagesRef.current.findLast(
				(message) =>
					message.type === "ask" ||
					(message.type === "say" && (message.say === "api_req_started" || message.say === "user_feedback")),
			)
			const isFollowUpLocallyAnswered =
				currentInputBoundary?.ask === "followup" &&
				submittedFollowUpRef.current?.taskId === visibleCurrentTaskId &&
				submittedFollowUpRef.current?.ts === currentInputBoundary.ts
			if (isLastFollowUpAnswered || isFollowUpLocallyAnswered) {
				return postQueuedMessage(text, images, asyncUserInputMessageTs, steer && isStreaming)
			}

			const isCurrentFollowUpResponse =
				currentInputBoundary?.ask === "followup" &&
				currentInputBoundary.partial !== true &&
				currentInputBoundary.isAnswered !== true

			// A follow-up answer unblocks the current turn, which remains active while
			// waiting. Existing queued instructions belong to later turns, not this ask.
			// Waiting metadata can lag the complete ask; use conversation boundaries
			// instead so an immediate reply works without re-answering a stale question.
			const shouldQueueMessage =
				!isCurrentFollowUpResponse &&
				(isTurnActive ||
					pendingAskRequestsRef.current.some(
						(request) => request.askMessageTs === currentInputBoundary?.ts,
					) ||
					visibleMessageQueue.length > 0 ||
					alphaAskRef.current === "command_output" ||
					(alphaAskRef.current !== undefined && approvalAskTypes.has(alphaAskRef.current)))

			if (shouldQueueMessage) {
				return postQueuedMessage(text, images, asyncUserInputMessageTs, steer && isStreaming)
			}

			// Composer operations apply only at an eligible idle boundary. Active
			// turns and queued edits retain ordinary input routing regardless of text.
			if (visibleCurrentTaskId && images.length === 0 && isContextCondensationRequest(text)) {
				if (isCondensing || sendingDisabled) return false
				handleCondenseContext(visibleCurrentTaskId)
				setInputValue("")
				setSelectedImages([])
				return true
			}

			// Mark that user has responded - this prevents any pending auto-approvals.
			userRespondedRef.current = true

			if (isBlankTaskPendingRef.current || messagesRef.current.length === 0) {
				isBlankTaskPendingRef.current = false
				vscode.postMessage({
					type: "newTask",
					text,
					images,
					...(draftTaskApprovalMode ? { taskApprovalMode: draftTaskApprovalMode } : {}),
				})
			} else if (
				isCurrentFollowUpResponse ||
				!alphaAskRef.current ||
				messageResponseAskTypes.has(alphaAskRef.current)
			) {
				if (visibleCurrentTaskId && pendingAskRequestsRef.current.length >= MAX_PENDING_HOST_SENDS) {
					setChatCommandError(t("chat:queuedMessages.deliveryPending"))
					return false
				}
				if (isCurrentFollowUpResponse) {
					// Claim synchronously: another invoke/click can precede the render or
					// host acknowledgement that marks this question answered.
					submittedFollowUpRef.current = { taskId: visibleCurrentTaskId, ts: currentInputBoundary.ts }
					markFollowUpAsAnswered()
				}
				const askMessageTs =
					asyncUserInputMessageTs === undefined
						? isCurrentFollowUpResponse
							? currentInputBoundary.ts
							: getCurrentAskMessageTs()
						: undefined
				const requestId = crypto.randomUUID()
				if (visibleCurrentTaskId) {
					const request = {
						requestId,
						taskId: visibleCurrentTaskId,
						text,
						images: [...images],
						askMessageTs,
						...(asyncUserInputMessageTs === undefined ? {} : { asyncUserInputMessageTs }),
					}
					pendingAskRequestsRef.current = [...pendingAskRequestsRef.current, request]
					setPendingAskRequests(pendingAskRequestsRef.current)
					setChatCommandError(undefined)
				}

				vscode.postMessage({
					type: "askResponse",
					requestId,
					askMessageTs,
					askResponse: "messageResponse",
					text,
					images,
					...visibleTaskPayload,
					...(asyncUserInputMessageTs === undefined ? {} : { asyncUserInputMessageTs }),
				})
			} else {
				return false
			}

			handleChatReset()
			return true
		},
		[
			handleChatReset,
			getCurrentAskMessageTs,
			setChatCommandError,
			setInputValue,
			setSelectedImages,
			setPendingEditRequest,
			setPendingResumeRequest,
			setPendingAskRequests,
			t,
			markFollowUpAsAnswered,
			isTurnActive,
			isStreaming,
			visibleMessageQueue.length,
			apiConfiguration?.apiProvider,
			visibleTaskPayload,
			editingQueuedMessage,
			isVisibleTaskFailedOrClosed,
			isVisibleTaskCompleted,
			hasOpenCompletedTaskResponseBoundary,
			isLastFollowUpAnswered,
			postQueuedMessage,
			startNewTask,
			handleCondenseContext,
			isCondensing,
			sendingDisabled,
			visibleCurrentTaskId,
			mode,
			draftTaskApprovalMode,
			setMode,
		], // messagesRef and alphaAskRef are stable
	)
	const handleHostSendMessage = useCallback(
		(text: string, images: string[]) => {
			const owner = visibleCurrentTaskId
			const draft = getTaskDraft(owner)
			if (
				draft.editingQueuedMessage ||
				draft.pendingEditRequest ||
				draft.pendingResumeRequest ||
				draft.pendingQueueRequest
			)
				return false
			const accepted = handleSendMessage(text, images)
			if (accepted)
				updateTaskDraft(owner, (current) => ({
					...current,
					inputValue: draft.inputValue,
					selectedImages: draft.selectedImages,
				}))
			return accepted
		},
		[visibleCurrentTaskId, getTaskDraft, updateTaskDraft, handleSendMessage],
	)
	const committedSendMessageRef = useRef(handleHostSendMessage)
	useLayoutEffect(() => {
		committedSendMessageRef.current = handleHostSendMessage
	}, [handleHostSendMessage])

	useEffect(() => {
		if (!visibleCurrentTaskId || messagesRef.current.length === 0) return

		const pending = pendingHostSendsRef.current
		const ready = pending.filter((invoke) => invoke.taskId === visibleCurrentTaskId)
		if (ready.length === 0) return

		const retained = pending.filter((invoke) => invoke.taskId !== visibleCurrentTaskId)
		for (const invoke of ready) {
			if (!committedSendMessageRef.current(invoke.text, invoke.images)) retained.push(invoke)
		}
		pendingHostSendsRef.current = retained
	}, [
		activeMessages.length,
		visibleCurrentTaskId,
		pendingQueueRequest,
		pendingResumeRequest,
		pendingAskRequests,
		pendingEditRequest,
		editingQueuedMessage,
	])

	const handleSetChatBoxMessage = useCallback(
		(text: string, images: string[], taskId?: string) => {
			// Unscoped legacy insertions are only safe in the blank new-chat draft.
			if (!taskId && visibleCurrentTaskId) return
			updateTaskDraft(taskId, (draft) => ({
				...draft,
				inputValue: draft.inputValue ? `${draft.inputValue} ${text}` : text,
				selectedImages: [...draft.selectedImages, ...images],
			}))
		},
		[updateTaskDraft, visibleCurrentTaskId],
	)

	// Handle stop button click from textarea
	const handleStopTask = useCallback(() => {
		vscode.postMessage({ type: "cancelTask", ...visibleTaskPayload })
		setDidClickCancel(true)
	}, [visibleTaskPayload, setDidClickCancel])

	const handleComposerSend = useCallback(() => {
		handleSendMessage(inputValue, selectedImages, undefined, !isManagedSubagent)
	}, [handleSendMessage, inputValue, selectedImages, isManagedSubagent])

	// Handle enqueue button click from textarea
	const handleEnqueueCurrentMessage = useCallback(() => {
		const text = inputValue.trim()
		if (text || selectedImages.length > 0) postQueuedMessage(text, selectedImages)
	}, [inputValue, postQueuedMessage, selectedImages])

	const startQueuedMessageEdit = useCallback(
		(message: QueuedMessage) => {
			if (!visibleCurrentTaskId || pendingEditRequestRef.current) return
			setEditingQueuedMessage({
				taskId: visibleCurrentTaskId,
				id: message.id,
				priorText: editingQueuedMessage?.priorText ?? inputValueRef.current,
				priorImages: editingQueuedMessage?.priorImages ?? selectedImagesRef.current,
			})
			setInputValue(message.text)
			setSelectedImages(message.images ?? [])
			setTimeout(() => textAreaRef.current?.focus(), 0)
		},
		[editingQueuedMessage, visibleCurrentTaskId, setEditingQueuedMessage, setInputValue, setSelectedImages],
	)

	const cancelQueuedMessageEdit = useCallback(() => {
		if (pendingEditRequestRef.current) return
		if (!editingQueuedMessage) {
			return
		}

		setInputValue(editingQueuedMessage.priorText)
		setSelectedImages(editingQueuedMessage.priorImages)
		setEditingQueuedMessage(null)
		setTimeout(() => textAreaRef.current?.focus(), 0)
	}, [editingQueuedMessage, setEditingQueuedMessage, setInputValue, setSelectedImages])

	// This logic depends on the useEffect[messages] above to set alphaAsk,
	// after which buttons are shown and we then send an askResponse to the
	// extension.
	const sendToolApprovalDecision = useCallback(
		(
			decision:
				| "approve_once"
				| "approve_session"
				| "approve_with_amendment"
				| "approve_persistently"
				| "deny"
				| "abort",
			feedback?: string,
		) => {
			if (
				!toolApprovalRequest ||
				!visibleCurrentTaskId ||
				!toolApprovalRequest.availableDecisions.includes(decision)
			) {
				return false
			}
			let toolApprovalDecision: ToolApprovalDecision
			if (decision === "approve_with_amendment") {
				if (!toolApprovalRequest.proposedAmendment) return false
				toolApprovalDecision = { decision, amendment: toolApprovalRequest.proposedAmendment }
			} else if (decision === "approve_persistently") {
				if (!toolApprovalRequest.proposedPersistentAmendment) return false
				toolApprovalDecision = { decision, amendment: toolApprovalRequest.proposedPersistentAmendment }
			} else if (decision === "deny") {
				toolApprovalDecision = { decision, ...(feedback?.trim() ? { feedback: feedback.trim() } : {}) }
			} else {
				toolApprovalDecision = { decision }
			}
			vscode.postMessage({
				type: "toolApprovalResponse",
				taskId: visibleCurrentTaskId,
				approvalRequestId: toolApprovalRequest.requestId,
				toolApprovalDecision,
			})
			userRespondedRef.current = true
			setSendingDisabled(true)
			setAlphaAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)
			setTertiaryButtonText(undefined)
			setToolApprovalRequest(undefined)
			return true
		},
		[toolApprovalRequest, visibleCurrentTaskId],
	)

	const handlePrimaryButtonClick = useCallback(
		(text?: string, images?: string[]) => {
			if (isVisibleTaskFailedOrClosed || pendingResumeRequestRef.current) {
				return
			}
			// Mark that user has responded
			userRespondedRef.current = true

			const trimmedInput = text?.trim()
			if (isCompletedTaskResponseAsk(alphaAsk)) {
				startNewTask(trimmedInput, images)
				return
			}

			switch (alphaAsk) {
				case "api_req_failed":
				case "mistake_limit_reached":
					// Only send text/images if they exist
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askMessageTs: getCurrentAskMessageTs(),
							askResponse: "yesButtonClicked",
							text: trimmedInput,
							images: images,
							...visibleTaskPayload,
						})
						// Clear input state after sending
						setInputValue("")
						setSelectedImages([])
					} else {
						vscode.postMessage({
							type: "askResponse",
							askMessageTs: getCurrentAskMessageTs(),
							askResponse: "yesButtonClicked",
							...visibleTaskPayload,
						})
					}
					break
				case "command":
				case "tool":
				case "use_mcp_server":
					if (toolApprovalRequest) {
						sendToolApprovalDecision("approve_once")
						break
					}
					vscode.postMessage({
						type: "askResponse",
						askMessageTs: getCurrentAskMessageTs(),
						askResponse: "yesButtonClicked",
						...visibleTaskPayload,
					})
					break
				case "resume_task":
					// For completed subtasks (tasks with a parentTaskId and a completion_result),
					// start a new task instead of resuming since the subtask is done
					const isCompletedSubtaskForClick =
						visibleCurrentTaskItem?.parentTaskId &&
						messagesRef.current.some(
							(msg) => msg.ask === "completion_result" || msg.say === "completion_result",
						)
					if (isCompletedSubtaskForClick) {
						startNewTask(trimmedInput, images)
						return
					} else {
						// Only send text/images if they exist
						if (trimmedInput || (images && images.length > 0)) {
							vscode.postMessage({
								type: "askResponse",
								askMessageTs: getCurrentAskMessageTs(),
								askResponse: "yesButtonClicked",
								text: trimmedInput,
								images: images,
								...visibleTaskPayload,
							})
							// Clear input state after sending
							setInputValue("")
							setSelectedImages([])
						} else {
							vscode.postMessage({
								type: "askResponse",
								askMessageTs: getCurrentAskMessageTs(),
								askResponse: "yesButtonClicked",
								...visibleTaskPayload,
							})
						}
					}
					break
				case "command_output":
					vscode.postMessage({
						type: "terminalOperation",
						terminalOperation: "continue",
						...visibleTaskPayload,
					})
					break
			}

			setSendingDisabled(true)
			setAlphaAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)
		},
		[
			alphaAsk,
			getCurrentAskMessageTs,
			setInputValue,
			setSelectedImages,
			visibleTaskPayload,
			startNewTask,
			visibleCurrentTaskItem?.parentTaskId,
			isVisibleTaskFailedOrClosed,
			toolApprovalRequest,
			sendToolApprovalDecision,
		],
	)

	const handleSecondaryButtonClick = useCallback(() => {
		if (isVisibleTaskFailedOrClosed) return
		// Mark that user has responded
		userRespondedRef.current = true

		if (isStreaming && !toolApprovalRequest) {
			vscode.postMessage({ type: "cancelTask", ...visibleTaskPayload })
			setDidClickCancel(true)
			return
		}

		switch (alphaAsk) {
			case "api_req_failed":
			case "mistake_limit_reached":
			case "resume_task":
				startNewTask()
				return
			case "command":
			case "tool":
			case "use_mcp_server":
				if (toolApprovalRequest) {
					const feedback = inputValue.trim()
					if (sendToolApprovalDecision("deny", feedback) && feedback) {
						setInputValue("")
					}
					break
				}
				// Responds to the API with a "This operation failed" and lets it try again.
				vscode.postMessage({
					type: "askResponse",
					askMessageTs: getCurrentAskMessageTs(),
					askResponse: "noButtonClicked",
					...visibleTaskPayload,
				})
				break
			case "command_output":
				vscode.postMessage({
					type: "terminalOperation",
					terminalOperation: "abort",
					...visibleTaskPayload,
				})
				break
		}
		setSendingDisabled(true)
		setAlphaAsk(undefined)
		setEnableButtons(false)
	}, [
		alphaAsk,
		getCurrentAskMessageTs,
		setInputValue,
		visibleTaskPayload,
		startNewTask,
		isStreaming,
		setDidClickCancel,
		isVisibleTaskFailedOrClosed,
		toolApprovalRequest,
		inputValue,
		sendToolApprovalDecision,
	])

	const { info: model } = useSelectedModel(apiConfiguration)
	const visibleCurrentTaskItemId = visibleCurrentTaskItem?.id
	const visibleCurrentTaskItemStatus = visibleCurrentTaskItem?.status
	const visibleCurrentTaskItemDesignHandoff = visibleCurrentTaskItem?.designHandoff
	const visibleCurrentTaskItemKind = visibleCurrentTaskItem?.taskKind
	const visibleCurrentTaskItemChildIds = visibleCurrentTaskItem?.childIds
	const visibleCurrentTaskItemCompletedByChildId = visibleCurrentTaskItem?.completedByChildId
	const chatRowTaskItem = useMemo(() => {
		if (!visibleCurrentTaskItemId) {
			return undefined
		}
		return {
			id: visibleCurrentTaskItemId,
			status: visibleCurrentTaskItemStatus,
			designHandoff: visibleCurrentTaskItemDesignHandoff,
			taskKind: visibleCurrentTaskItemKind,
			childIds: visibleCurrentTaskItemChildIds,
			completedByChildId: visibleCurrentTaskItemCompletedByChildId,
		}
	}, [
		visibleCurrentTaskItemId,
		visibleCurrentTaskItemStatus,
		visibleCurrentTaskItemDesignHandoff,
		visibleCurrentTaskItemKind,
		visibleCurrentTaskItemCompletedByChildId,
		visibleCurrentTaskItemChildIds,
	])
	const chatRowEnvironment = useMemo<ChatRowEnvironment>(
		() => ({
			mcpServers,
			alwaysAllowMcp,
			currentCheckpoint,
			mode,
			currentTaskItem: chatRowTaskItem,
			currentTaskId: visibleCurrentTaskId,
			reasoningBlockCollapsed,
			modelSupportsImages: model?.supportsImages,
			getAlphaMessages,
			onShowTask: openTaskWithCache,
		}),
		[
			mcpServers,
			alwaysAllowMcp,
			currentCheckpoint,
			mode,
			chatRowTaskItem,
			visibleCurrentTaskId,
			reasoningBlockCollapsed,
			model?.supportsImages,
			getAlphaMessages,
			openTaskWithCache,
		],
	)

	const selectImages = useCallback(() => vscode.postMessage({ type: "selectImages" }), [])

	const shouldDisableImages = !model?.supportsImages || selectedImages.length >= MAX_IMAGES_PER_MESSAGE

	const handleMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			switch (message.type) {
				case "action":
					switch (message.action!) {
						case "didBecomeVisible":
							if (!isHidden && !sendingDisabled && !enableButtons) {
								textAreaRef.current?.focus()
							}
							break
						case "focusInput":
							textAreaRef.current?.focus()
							break
					}
					break
				case "selectedImages":
					// Only handle selectedImages if it's not for editing context
					// When context is "edit", ChatRow will handle the images
					if (message.context !== "edit") {
						setSelectedImages((prevImages: string[]) =>
							appendImages(prevImages, message.images, MAX_IMAGES_PER_MESSAGE),
						)
					}
					break
				case "invoke":
					switch (message.invoke!) {
						case "newChat":
							enterBlankTaskView()
							break
						case "sendMessage":
							const hostOwner = message.taskId ?? visibleCurrentTaskId
							const hostDraft = getTaskDraft(hostOwner)
							// The window listener refreshes passively; route an immediate host
							// invoke through the callback from the latest committed task view.
							if (
								hostOwner &&
								(hostOwner !== visibleCurrentTaskId ||
									messagesRef.current.length === 0 ||
									hostDraft.editingQueuedMessage ||
									hostDraft.pendingEditRequest ||
									hostDraft.pendingResumeRequest ||
									hostDraft.pendingQueueRequest)
							) {
								const pending = pendingHostSendsRef.current
								if (pending.length < MAX_PENDING_HOST_SENDS) {
									pending.push({
										taskId: hostOwner,
										text: message.text ?? "",
										images: message.images ?? [],
									})
								} else {
									setChatCommandError(
										t("chat:hostMessages.deliveryBackpressure", { taskId: hostOwner }),
									)
									console.warn(
										"Dropping host sendMessage while the requested task transcript is unavailable",
									)
								}
								break
							}
							committedSendMessageRef.current(message.text ?? "", message.images ?? [])
							break
						case "setChatBoxMessage":
							handleSetChatBoxMessage(message.text ?? "", message.images ?? [], message.taskId)
							break
						case "primaryButtonClick":
							handlePrimaryButtonClick(message.text ?? "", message.images ?? [])
							break
						case "secondaryButtonClick":
							handleSecondaryButtonClick()
							break
					}
					break
				case "condenseTaskContextStarted":
					// Concurrent tasks share this message channel; only update the visible task.
					if (message.text === visibleCurrentTaskId) {
						setIsCondensing(true)
						// Note: sendingDisabled is only set for manual condensation via handleCondenseContext
						// Automatic condensation doesn't disable sending since the task is already running
					}
					break
				case "condenseTaskContextResponse":
					if (message.text === visibleCurrentTaskId) {
						if (isCondensing && sendingDisabled) {
							setSendingDisabled(false)
						}
						setIsCondensing(false)
					}
					break
				case "chatCommandResult": {
					const result = message.chatCommandResult
					if (!result?.taskId) break
					const owner = result.taskId
					const draft = getTaskDraft(owner)
					const queueRequest = draft.pendingQueueRequest
					const askRequest = draft.pendingAskRequests.find(
						(request) => request.requestId === result.requestId,
					)
					const asyncSubmission =
						result.command === "askResponse"
							? askRequest
							: result.command === "queueMessage" || result.command === "sendAndSteer"
								? queueRequest
								: result.command === "resumeCompletedTask"
									? draft.pendingResumeRequest
									: undefined
					if (
						result.status === "accepted" &&
						asyncSubmission?.requestId === result.requestId &&
						asyncSubmission.asyncUserInputMessageTs !== undefined
					) {
						const key = `${owner}:${asyncSubmission.asyncUserInputMessageTs}`
						setAnsweredAsyncUserInputTs((current) => new Set(current).add(key))
					}
					if (result.command === "askResponse" && askRequest) {
						const submission = askRequest
						if (owner === visibleCurrentTaskId) {
							pendingAskRequestsRef.current = pendingAskRequestsRef.current.filter(
								(request) => request.requestId !== result.requestId,
							)
							if (result.status === "rejected") {
								if (
									submittedFollowUpRef.current?.taskId === owner &&
									submittedFollowUpRef.current.ts === submission.askMessageTs
								) {
									submittedFollowUpRef.current = undefined
									setCurrentFollowUpTs(null)
								}
								setSendingDisabled(false)
							}
						}
						updateTaskDraft(owner, (current) => ({
							...current,
							pendingAskRequests: current.pendingAskRequests.filter(
								(request) => request.requestId !== result.requestId,
							),
							...(result.status === "rejected"
								? {
										inputValue: current.inputValue
											? `${current.inputValue} ${submission.text}`
											: submission.text,
										selectedImages: [...current.selectedImages, ...submission.images],
									}
								: {}),
							chatCommandError:
								result.status === "accepted" ? undefined : t("chat:queuedMessages.answerFailed"),
						}))
					}

					if (
						(result.command === "queueMessage" || result.command === "sendAndSteer") &&
						queueRequest?.requestId === result.requestId &&
						result.command === (queueRequest.command ?? "queueMessage")
					) {
						if (owner === visibleCurrentTaskId) pendingQueueRequestRef.current = null
						updateTaskDraft(owner, (current) => {
							const unchangedText = current.inputValue.trim() === queueRequest.text
							const unchangedImages =
								current.selectedImages.length === queueRequest.images.length &&
								current.selectedImages.every((image, index) => image === queueRequest.images[index])
							const unchanged = unchangedText && unchangedImages
							return {
								...current,
								pendingQueueRequest: null,
								...(result.status === "accepted" && unchanged
									? { inputValue: "", selectedImages: [] }
									: {}),
								...(result.status === "rejected"
									? {
											inputValue: unchangedText
												? current.inputValue
												: [current.inputValue, queueRequest.text].filter(Boolean).join("\n\n"),
											selectedImages: unchangedImages
												? current.selectedImages
												: [...current.selectedImages, ...queueRequest.images],
										}
									: {}),
								chatCommandError:
									result.status === "accepted"
										? result.command === "sendAndSteer" && result.deliveryState === "queued"
											? t("chat:queuedMessages.steerRetained")
											: undefined
										: t(
												result.command === "sendAndSteer"
													? "chat:queuedMessages.steerFailed"
													: "chat:queuedMessages.queueFailed",
											),
							}
						})
					}

					if (
						result.command === "steerQueuedMessage" &&
						draft.pendingSteerRequest?.requestId === result.requestId
					) {
						if (owner === visibleCurrentTaskId) pendingSteerRequestRef.current = null
						updateTaskDraft(owner, (current) => ({
							...current,
							pendingSteerRequest: null,
							chatCommandError:
								result.status === "accepted" ? undefined : t("chat:queuedMessages.steerFailed"),
						}))
					}
					if (
						result.command === "editQueuedMessage" &&
						draft.pendingEditRequest?.requestId === result.requestId
					) {
						const submission = draft.pendingEditRequest
						if (owner === visibleCurrentTaskId) pendingEditRequestRef.current = null
						updateTaskDraft(owner, (current) => ({
							...current,
							pendingEditRequest: null,
							...(result.status === "accepted" && current.editingQueuedMessage
								? {
										inputValue:
											current.inputValue.trim() === submission.text
												? current.editingQueuedMessage.priorText
												: current.inputValue,
										selectedImages:
											current.selectedImages.length === submission.images.length &&
											current.selectedImages.every(
												(image, index) => image === submission.images[index],
											)
												? current.editingQueuedMessage.priorImages
												: current.selectedImages,
										editingQueuedMessage: null,
									}
								: {}),
							chatCommandError:
								result.status === "accepted" ? undefined : t("chat:queuedMessages.editFailed"),
						}))
					}
					if (
						result.command === "resumeCompletedTask" &&
						draft.pendingResumeRequest?.requestId === result.requestId &&
						(result.status === "rejected" ||
							result.deliveryState === "queued" ||
							messagesRef.current.some((message) => message.queuedMessageIds?.includes(result.requestId)))
					) {
						const submission = draft.pendingResumeRequest
						if (owner === visibleCurrentTaskId) pendingResumeRequestRef.current = null
						updateTaskDraft(owner, (current) => ({
							...current,
							pendingResumeRequest: null,
							...(result.status === "rejected"
								? {
										inputValue: current.inputValue
											? `${current.inputValue} ${submission.text}`
											: submission.text,
										selectedImages: [...current.selectedImages, ...submission.images],
									}
								: {}),
							chatCommandError:
								result.status === "rejected"
									? t("chat:queuedMessages.resumeFailed")
									: result.deliveryState === "queued"
										? t("chat:queuedMessages.resumeQueued")
										: undefined,
						}))
					}
					break
				}
				case "taskOpenResult":
					if (message.success === true && typeof message.taskId === "string") {
						setIsHistoryExpanded(false)
						setDismissedHistoryRequest(historyFocusRequest)
					}
					if (message.success === false && typeof message.taskId === "string") {
						pendingHostSendsRef.current = pendingHostSendsRef.current.filter(
							(invoke) => invoke.taskId !== message.taskId,
						)
					}
					break
				case "checkpointInitWarning":
					// Concurrent and recently viewed tasks share this message channel.
					// Never project one task's checkpoint state onto another task.
					if (typeof message.taskId === "string" && message.taskId === visibleCurrentTaskId) {
						setCheckpointWarningState(
							message.checkpointWarning
								? { taskId: message.taskId, warning: message.checkpointWarning }
								: undefined,
						)
					}
					break
				case "interactionRequired":
					if (!message.taskId) break
					playSound("notification")
					setNotificationTaskIds((current) =>
						[...current.filter((taskId) => taskId !== message.taskId), message.taskId!].slice(-50),
					)
					break
				case "taskWithAggregatedCosts":
					if (message.text && message.aggregatedCosts) {
						setAggregatedCostsMap((prev) => {
							const newMap = new Map(prev)
							newMap.set(message.text!, message.aggregatedCosts!)
							return newMap
						})
					}
					break
			}
			// textAreaRef.current is not explicitly required here since React
			// guarantees that ref will be stable across re-renders, and we're
			// not using its value but its reference.
		},
		[
			isCondensing,
			getTaskDraft,
			updateTaskDraft,
			setSelectedImages,
			setChatCommandError,
			historyFocusRequest,
			isHidden,
			sendingDisabled,
			enableButtons,
			enterBlankTaskView,
			handleSetChatBoxMessage,
			handlePrimaryButtonClick,
			handleSecondaryButtonClick,
			setCheckpointWarningState,
			playSound,
			visibleCurrentTaskId,
			t,
		],
	)

	const committedMessageHandlerRef = useRef(handleMessage)
	useLayoutEffect(() => {
		committedMessageHandlerRef.current = handleMessage
	}, [handleMessage])
	const dispatchCommittedMessage = useCallback((event: MessageEvent) => committedMessageHandlerRef.current(event), [])
	useEvent("message", dispatchCommittedMessage)

	const visibleMessages = useMemo(() => {
		// Pre-compute checkpoint hashes that have associated user messages for O(1) lookup
		const userMessageCheckpointHashes = new Set<string>()
		modifiedMessages.forEach((msg) => {
			if (
				msg.say === "user_feedback" &&
				msg.checkpoint &&
				msg.checkpoint["type"] === "user_message" &&
				msg.checkpoint["hash"]
			) {
				userMessageCheckpointHashes.add(msg.checkpoint["hash"] as string)
			}
		})

		// Filter presentation-only rows. Checkpoint jump uses grouped indices plus
		// revealIndex; collapsed finished activity is unmounted, not hidden-mounted.
		const newVisibleMessages = modifiedMessages.filter((message) => {
			// Filter out checkpoint_saved messages that should be suppressed
			if (message.say === "checkpoint_saved") {
				// Check if this checkpoint has the suppressMessage flag set
				if (
					message.checkpoint &&
					typeof message.checkpoint === "object" &&
					"suppressMessage" in message.checkpoint &&
					message.checkpoint.suppressMessage
				) {
					return false
				}
				// Also filter out checkpoint messages associated with user messages (legacy behavior)
				if (message.text && userMessageCheckpointHashes.has(message.text)) {
					return false
				}
			}

			if (everVisibleMessagesTsRef.current.has(message.ts)) {
				const alwaysHiddenOnceProcessedAsk: AlphaAsk[] = [
					"api_req_failed",
					"resume_task",
					"resume_completed_task",
				]
				const alwaysHiddenOnceProcessedSay = [
					"api_req_finished",
					"api_req_retried",
					"api_req_deleted",
					"mcp_server_request_started",
				]
				if (message.ask && alwaysHiddenOnceProcessedAsk.includes(message.ask)) return false
				if (message.say && alwaysHiddenOnceProcessedSay.includes(message.say)) return false
				if (message.say === "text" && (message.text ?? "") === "" && (message.images?.length ?? 0) === 0) {
					return false
				}
				return true
			}

			switch (message.ask) {
				case "completion_result":
					if (message.text === "") return false
					break
				case "api_req_failed":
				case "resume_task":
				case "resume_completed_task":
					return false
			}
			switch (message.say) {
				case "api_req_finished":
				case "api_req_retried":
				case "api_req_deleted":
					return false
				case "api_req_retry_delayed":
				case "api_req_rate_limit_wait":
					const last1 = modifiedMessages.at(-1)
					const last2 = modifiedMessages.at(-2)
					if (last1?.ask === "resume_task" && last2 === message) {
						return true
					} else if (message !== last1) {
						return false
					}
					break
				case "text":
					if ((message.text ?? "") === "" && (message.images?.length ?? 0) === 0) return false
					break
				case "mcp_server_request_started":
					return false
			}
			return true
		})

		const viewportStart = Math.max(0, newVisibleMessages.length - 100)
		newVisibleMessages
			.slice(viewportStart)
			.forEach((msg: AlphaMessage) => everVisibleMessagesTsRef.current.set(msg.ts, true))

		return newVisibleMessages
	}, [modifiedMessages])

	useEffect(() => {
		const cleanupInterval = setInterval(() => {
			const cache = everVisibleMessagesTsRef.current
			const currentMessageIds = new Set(modifiedMessages.map((m: AlphaMessage) => m.ts))
			const viewportMessages = visibleMessages.slice(Math.max(0, visibleMessages.length - 100))
			const viewportMessageIds = new Set(viewportMessages.map((m: AlphaMessage) => m.ts))

			cache.forEach((_value: boolean, key: number) => {
				if (!currentMessageIds.has(key) && !viewportMessageIds.has(key)) {
					cache.delete(key)
				}
			})
		}, 60000)

		return () => clearInterval(cleanupInterval)
	}, [modifiedMessages, visibleMessages])

	useDebounceEffect(
		() => {
			if (!isHidden && !sendingDisabled && !enableButtons) {
				textAreaRef.current?.focus()
			}
		},
		50,
		[isHidden, sendingDisabled, enableButtons],
	)

	useEffect(() => {
		// This ensures the first message is not read, future user messages are
		// labeled as `user_feedback`.
		if (lastMessage && activeMessages.length > 1) {
			if (
				typeof lastMessage.text === "string" && // has text (must be string for startsWith)
				(lastMessage.say === "text" || lastMessage.say === "completion_result") && // is a text message
				!lastMessage.partial && // not a partial message
				!lastMessage.text.startsWith("{") // not a json object
			) {
				let text = lastMessage?.text || ""
				const mermaidRegex = /```mermaid[\s\S]*?```/g
				// remove mermaid diagrams from text
				text = text.replace(mermaidRegex, "")
				// remove markdown from text
				text = removeMd(text)

				// ensure message is not a duplicate of last read message
				if (text !== lastTtsRef.current) {
					try {
						playTts(text)
						lastTtsRef.current = text
					} catch (error) {
						console.error("Failed to execute text-to-speech:", error)
					}
				}
			}
		}

		// Update previous value.
		setWasStreaming(isStreaming)
	}, [isStreaming, lastMessage, wasStreaming, activeMessages.length])

	const groupedMessages = useMemo(() => {
		const filtered: AlphaMessage[] = visibleMessages

		// Helper to check if a message is a read_file ask that should be batched
		const isReadFileAsk = (msg: AlphaMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool") return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return tool.tool === "readFile" && !tool.batchFiles // Don't re-batch already batched
			} catch {
				return false
			}
		}

		// Helper to check if a message is a list_files ask that should be batched
		const isListFilesAsk = (msg: AlphaMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool") return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return (
					(tool.tool === "listFilesTopLevel" || tool.tool === "listFilesRecursive") && !tool.batchDirs // Don't re-batch already batched
				)
			} catch {
				return false
			}
		}

		// Set of tool names that represent file-editing operations
		const editFileTools = new Set([
			"editedExistingFile",
			"appliedDiff",
			"newFileCreated",
			"insertContent",
			"searchAndReplace",
		])

		// Helper to check if a message is a file-edit ask that should be batched
		const isEditFileAsk = (msg: AlphaMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool") return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return editFileTools.has(tool.tool) && !tool.batchDiffs // Don't re-batch already batched
			} catch {
				return false
			}
		}

		// Synthesize a batch of consecutive read_file asks into a single message
		const synthesizeReadFileBatch = (batch: AlphaMessage[]): AlphaMessage => {
			const batchFiles = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						lineSnippet: tool.reason || "",
						isOutsideWorkspace: tool.isOutsideWorkspace || false,
						key: `${tool.path}${tool.reason ? ` (${tool.reason})` : ""}`,
						content: tool.content || "",
					}
				} catch {
					return { path: "", lineSnippet: "", key: "", content: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchFiles }),
			}
		}

		// Synthesize a batch of consecutive list_files asks into a single message
		const synthesizeListFilesBatch = (batch: AlphaMessage[]): AlphaMessage => {
			const batchDirs = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						recursive: tool.tool === "listFilesRecursive",
						isOutsideWorkspace: tool.isOutsideWorkspace || false,
						key: tool.path || "",
					}
				} catch {
					return { path: "", recursive: false, key: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchDirs }),
			}
		}

		// Synthesize a batch of consecutive file-edit asks into a single message
		const synthesizeEditFileBatch = (batch: AlphaMessage[]): AlphaMessage => {
			const batchDiffs = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						changeCount: 1,
						key: tool.path || "",
						content: tool.content ?? tool.diff ?? "",
						diffStats: tool.diffStats,
						originalContent: tool.originalContent,
						finalContent: tool.finalContent,
					}
				} catch {
					return { path: "", changeCount: 0, key: "", content: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchDiffs }),
			}
		}

		// Consolidate consecutive ask messages into batches
		const readFileBatched = batchConsecutive(filtered, isReadFileAsk, synthesizeReadFileBatch)
		const listFilesBatched = batchConsecutive(readFileBatched, isListFilesAsk, synthesizeListFilesBatch)
		const result = batchConsecutive(listFilesBatched, isEditFileAsk, synthesizeEditFileBatch)

		if (isCondensing) {
			result.push({
				type: "say",
				say: "condense_context",
				ts: Date.now(),
				partial: true,
			} as AlphaMessage)
		}
		return result
	}, [isCondensing, visibleMessages])
	const fileChangeTurns = useMemo(
		() => fileChangeTurnsFromMessages(groupedMessages, visibleCurrentTaskId ?? (task ? String(task.ts) : "task")),
		[groupedMessages, task, visibleCurrentTaskId],
	)
	const fileChangeTurnsByEndIndex = useMemo(
		() => new Map(fileChangeTurns.map((turn) => [turn.endIndex, turn] as const)),
		[fileChangeTurns],
	)
	const transcriptRootMessageTs = activeMessages.at(0)?.ts
	const transcriptIdentity = visibleCurrentTaskId ?? (task ? String(task.ts) : undefined)
	const transcriptTaskKey = transcriptIdentity
		? `${transcriptIdentity}:${transcriptRootMessageTs ?? "pending"}`
		: undefined
	const pendingApprovalTs =
		lastMessage?.type === "ask" &&
		lastMessage.isAnswered !== true &&
		lastMessage.ask !== undefined &&
		approvalAskTypes.has(lastMessage.ask) &&
		enableButtons
			? lastMessage.ts
			: undefined
	const failedApiRequestTs = useMemo(() => {
		if (lastMessage?.ask !== "api_req_failed") return undefined
		for (let index = activeMessages.length - 1; index >= 0; index--) {
			if (activeMessages[index].say === "api_req_started") return activeMessages[index].ts
		}
		return undefined
	}, [activeMessages, lastMessage])
	const actionActivity = useMemo(() => {
		const activity = getActionActivity(groupedMessages, pendingApprovalTs, failedApiRequestTs)
		for (const [index, trace] of getCompletedTurnActivity(
			groupedMessages,
			task?.ts,
			hasCompletedTranscriptBoundary || isVisibleTaskCompleted,
		)) {
			activity.set(index, trace)
		}
		return activity
	}, [
		groupedMessages,
		pendingApprovalTs,
		failedApiRequestTs,
		task?.ts,
		hasCompletedTranscriptBoundary,
		isVisibleTaskCompleted,
	])
	const [traceExpansion, setTraceExpansion] = useState<{ taskKey?: string; expanded: Record<number, boolean> }>({
		expanded: {},
	})
	const traceCompletionRef = useRef<{ taskKey?: string; completed: boolean }>({ completed: false })
	const focusedActivityRef = useRef<{ taskKey?: string; index: number }>()
	useEffect(() => {
		// Removed or replaced action groups must not reuse an old expansion choice.
		const traceIds = new Set(Array.from(actionActivity.values(), (trace) => trace.id))
		setTraceExpansion((current) => {
			if (current.taskKey !== transcriptTaskKey) return { taskKey: transcriptTaskKey, expanded: {} }
			const entries = Object.entries(current.expanded)
			const retained = entries.filter(([id]) => traceIds.has(Number(id)))
			return retained.length === entries.length ? current : { ...current, expanded: Object.fromEntries(retained) }
		})
	}, [actionActivity, transcriptTaskKey])
	useEffect(() => {
		const previous = traceCompletionRef.current
		traceCompletionRef.current = { taskKey: transcriptTaskKey, completed: hasCompletedTranscriptBoundary }
		if (previous.taskKey !== transcriptTaskKey || previous.completed || !hasCompletedTranscriptBoundary) return
		// Finishing a turn folds details opened while actions were running; the reader can reopen them.
		setTraceExpansion((current) =>
			current.taskKey === transcriptTaskKey && Object.keys(current.expanded).length > 0
				? { ...current, expanded: {} }
				: current,
		)
	}, [hasCompletedTranscriptBoundary, transcriptTaskKey])
	const expandedTraces = useMemo(
		() => (traceExpansion.taskKey === transcriptTaskKey ? traceExpansion.expanded : {}),
		[traceExpansion, transcriptTaskKey],
	)
	const setTraceExpanded = useCallback(
		(id: number, expanded: boolean) => {
			setTraceExpansion((current) => ({
				taskKey: transcriptTaskKey,
				expanded: { ...(current.taskKey === transcriptTaskKey ? current.expanded : {}), [id]: expanded },
			}))
		},
		[transcriptTaskKey],
	)
	const {
		items: renderedGroupedMessages,
		startIndex: transcriptStartIndex,
		hasOlder: hasOlderTranscript,
		loadOlder: loadOlderTranscript,
		revealIndex: revealTranscriptIndex,
	} = useProgressiveTranscript(groupedMessages, transcriptTaskKey, false)

	const checkpointIndices = useMemo(() => {
		const indices: number[] = []
		for (let i = 0; i < groupedMessages.length; i++) {
			if (groupedMessages[i]?.say === "checkpoint_saved") {
				indices.push(i)
			}
		}
		return indices
	}, [groupedMessages])

	const hasLatestCheckpoint = checkpointIndices.length > 0
	const checkpointJumpCursorRef = useRef<number | null>(null)
	const pendingCheckpointIndexRef = useRef<number | null>(null)

	useEffect(() => {
		checkpointJumpCursorRef.current = null
	}, [task?.ts, checkpointIndices])

	// Native DOM geometry keeps the scrollbar range exact while chat rows stream,
	// expand, or load asynchronous content. This controller is the sole owner of
	// automatic bottom pinning.
	const {
		showScrollToBottom,
		handleScrollToBottomClick,
		releaseFollow,
		setScrollerRef,
		setContentRef,
		handleScrollerScroll,
		handleScrollerWheel,
		handleScrollerPointerDown,
		handleScrollerPointerUp,
		handleContentLoad,
	} = useChatScrollController({
		taskTs: task?.ts,
		itemCount: renderedGroupedMessages.length,
	})

	const bindTranscriptScroller = useCallback(
		(element: HTMLDivElement | null) => {
			transcriptScrollerRef.current = element
			setScrollerRef(element)
		},
		[setScrollerRef],
	)
	useLayoutEffect(() => {
		const focused = document.activeElement
		const activity = focusedActivityRef.current
		if (!activity || activity.taskKey !== transcriptTaskKey) return
		// Hiding a focused element may already have returned focus to body before
		// layout effects run. The capture handler retains the previous row identity.
		if (focused !== document.body && !transcriptScrollerRef.current?.contains(focused)) return
		const trace = actionActivity.get(activity.index)
		if (trace && !expandedTraces[trace.id]) {
			transcriptScrollerRef.current
				?.querySelector<HTMLButtonElement>(`[data-activity-trace-id="${trace.id}"]`)
				?.focus({ preventScroll: true })
		}
	}, [actionActivity, expandedTraces, transcriptTaskKey])

	// The floating controls are siblings of the transcript scroller, so wheel input
	// over a button would otherwise stop at the overflow-hidden viewport wrapper.
	const handleScrollControlsWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
		event.preventDefault()
		transcriptScrollerRef.current?.scrollBy({ top: event.deltaY, behavior: "auto" })
	}, [])

	// Expanding a row indicates the user is browsing; disable sticky follow.
	// Placed after the hook call so releaseFollow is defined.
	useEffect(() => {
		const prev = prevExpandedRowsRef.current
		let wasAnyRowExpandedByUser = false
		if (prev) {
			for (const [tsKey, isExpanded] of Object.entries(expandedRows)) {
				const ts = Number(tsKey)
				if (isExpanded && !(prev[ts] ?? false)) {
					wasAnyRowExpandedByUser = true
					break
				}
			}
		}

		if (wasAnyRowExpandedByUser) {
			releaseFollow("row-expansion")
		}

		prevExpandedRowsRef.current = expandedRows
	}, [expandedRows, releaseFollow])

	const handleSetExpandedRow = useCallback(
		(ts: number, expand?: boolean) => {
			setExpandedRows((prev: Record<number, boolean>) => ({
				...prev,
				[ts]: expand === undefined ? !prev[ts] : expand,
			}))
		},
		[setExpandedRows], // setExpandedRows is stable
	)

	const toggleRowExpansion = useCallback(
		(ts: number) => {
			// Release following before either size change, including collapsing a long user message.
			releaseFollow("row-expansion")
			handleSetExpandedRow(ts)
		},
		[handleSetExpandedRow, releaseFollow],
	)

	// Checkpoint warnings are ephemeral state for the visible task.
	useEffect(() => {
		setCheckpointWarningState(undefined)
	}, [visibleCurrentTaskId])

	// Clear the visible task's warning when its chat is hidden or removed.
	useEffect(() => {
		if (isHidden || !task) {
			setCheckpointWarningState(undefined)
		}
	}, [isHidden, task])
	const checkpointWarning =
		checkpointWarningState && checkpointWarningState.taskId === visibleCurrentTaskId
			? checkpointWarningState.warning
			: undefined

	const placeholderText = task ? t("chat:typeMessage") : t("chat:typeTask")

	const switchToMode = useCallback(
		(modeSlug: string): void => {
			// Update local state and notify extension to sync mode change.
			setMode(modeSlug)

			// Send the mode switch message.
			vscode.postMessage({ type: "mode", text: modeSlug })
		},
		[setMode],
	)

	const handleSuggestionClickInRow = useCallback(
		(suggestion: SuggestionItem, event?: React.MouseEvent) => {
			// Mark that user has responded if this is a manual click (not auto-approval)
			if (event) {
				userRespondedRef.current = true
			}

			// Suggestions may contain legacy mode hints. Keep the visible workflow
			// within Plan/Code and ignore unknown custom-mode hints.
			const suggestedMode = normalizeUserFacingSuggestionMode(suggestion.mode)
			// Only a user click may change execution mode; auto-approved replies stay in the current mode.
			if (suggestedMode && event && !event.shiftKey) {
				switchToMode(suggestedMode)
			}

			if (event?.shiftKey) {
				// Always append to existing text, don't overwrite
				setInputValue((currentValue: string) => {
					return currentValue !== "" ? `${currentValue} \n${suggestion.answer}` : suggestion.answer
				})
			} else {
				// Don't clear the input value when sending a follow-up choice
				// The message should be sent but the text area should preserve what the user typed
				const preservedInput = inputValueRef.current
				handleSendMessage(suggestion.answer, [])
				// Restore the input value after sending
				setInputValue(preservedInput)
			}
		},
		[handleSendMessage, setInputValue, switchToMode],
	)

	const handleRequestUserInputSubmit = useCallback(
		(answers: RequestUserInputAnswerMap) => {
			void handleSendMessage(JSON.stringify({ answers }), [])
		},
		[handleSendMessage],
	)

	const handleAsyncUserInputSubmit = useCallback(
		(messageTs: number, response: string) => {
			if (
				!visibleCurrentTaskId ||
				pendingResumeRequestRef.current ||
				editingQueuedMessage ||
				isVisibleTaskFailedOrClosed ||
				isBlankTaskPendingRef.current ||
				messagesRef.current.length === 0
			) {
				return false
			}
			if (apiConfiguration?.apiProvider && isRetiredProvider(apiConfiguration.apiProvider)) {
				setShowRetiredProviderWarning(true)
				return false
			}
			const key = `${visibleCurrentTaskId}:${messageTs}`
			const question = messagesRef.current.find(
				(message) => message.ts === messageTs && message.type === "say" && message.say === "async_user_input",
			)
			const draft = getTaskDraft(visibleCurrentTaskId)
			const pending = [draft.pendingQueueRequest, draft.pendingResumeRequest, ...draft.pendingAskRequests].some(
				(submission) => submission?.asyncUserInputMessageTs === messageTs,
			)
			if (!question || question.isAnswered || answeredAsyncUserInputTs.has(key) || pending) {
				return false
			}

			if (!handleSendMessage(response, [], messageTs)) return false
			return true
		},
		[
			handleSendMessage,
			visibleCurrentTaskId,
			editingQueuedMessage,
			isVisibleTaskFailedOrClosed,
			apiConfiguration?.apiProvider,
			answeredAsyncUserInputTs,
			getTaskDraft,
		],
	)

	const handleRequestUserInputCancel = useCallback(() => {
		if (alphaAskRef.current !== "followup") return

		const pendingFollowUp = messagesRef.current.findLast(
			(message) => message.type === "ask" && message.ask === "followup" && !message.isAnswered,
		)
		if (pendingFollowUp && visibleCurrentTaskId) {
			submittedFollowUpRef.current = { taskId: visibleCurrentTaskId, ts: pendingFollowUp.ts }
		}
		userRespondedRef.current = true
		markFollowUpAsAnswered()
		vscode.postMessage({
			type: "askResponse",
			askMessageTs: getCurrentAskMessageTs(),
			askResponse: "noButtonClicked",
			...visibleTaskPayload,
		})
		handleChatReset()
	}, [handleChatReset, getCurrentAskMessageTs, markFollowUpAsAnswered, visibleCurrentTaskId, visibleTaskPayload])

	const handleBatchFileResponse = useCallback(
		(response: { [key: string]: boolean }) => {
			// Handle batch file response, e.g., for file uploads
			vscode.postMessage({
				type: "askResponse",
				askMessageTs: getCurrentAskMessageTs(),
				askResponse: "objectResponse",
				text: JSON.stringify(response),
				...visibleTaskPayload,
			})
		},
		[visibleTaskPayload, getCurrentAskMessageTs],
	)
	// Cancel backend auto-approval timeout when FollowUpSuggest's countdown effect cleans up.
	// This is called when auto-approve is toggled off, a suggestion is clicked, or the component unmounts.
	const handleFollowUpUnmount = useCallback(() => {
		vscode.postMessage({ type: "cancelAutoApproval", ...visibleTaskPayload })
	}, [visibleTaskPayload])

	const handleScrollToBottomAndResetCheckpointCursor = useCallback(() => {
		checkpointJumpCursorRef.current = null
		handleScrollToBottomClick()
	}, [handleScrollToBottomClick])

	const handleTaskHeaderExpandedChange = useCallback(() => {
		releaseFollow("task-header-toggle")
	}, [releaseFollow])
	const handleFileChangesExpandedChange = useCallback(() => {
		releaseFollow("row-expansion")
	}, [releaseFollow])

	const handleScrollToLatestCheckpoint = useCallback(() => {
		if (checkpointIndices.length === 0) {
			return
		}

		const previousCursor = checkpointJumpCursorRef.current
		const nextCursor = previousCursor === null ? checkpointIndices.length - 1 : Math.max(0, previousCursor - 1)
		const nextCheckpointIndex = checkpointIndices[nextCursor]
		checkpointJumpCursorRef.current = nextCursor

		releaseFollow("checkpoint-navigation")
		const trace = actionActivity.get(nextCheckpointIndex)
		if (trace && !expandedTraces[trace.id]) {
			pendingCheckpointIndexRef.current = nextCheckpointIndex
			setTraceExpanded(trace.id, true)
			revealTranscriptIndex(nextCheckpointIndex)
			return
		}
		const checkpoint = transcriptScrollerRef.current?.querySelector<HTMLElement>(
			`[data-chat-message-index="${nextCheckpointIndex}"]`,
		)
		if (checkpoint) {
			checkpoint.scrollIntoView({ block: "center", behavior: "smooth" })
			return
		}

		pendingCheckpointIndexRef.current = nextCheckpointIndex
		revealTranscriptIndex(nextCheckpointIndex)
	}, [checkpointIndices, releaseFollow, revealTranscriptIndex, actionActivity, expandedTraces, setTraceExpanded])

	useEffect(() => {
		const pendingCheckpointIndex = pendingCheckpointIndexRef.current
		if (pendingCheckpointIndex === null || pendingCheckpointIndex < transcriptStartIndex) {
			return
		}

		const checkpoint = transcriptScrollerRef.current?.querySelector<HTMLElement>(
			`[data-chat-message-index="${pendingCheckpointIndex}"]`,
		)
		if (checkpoint) {
			pendingCheckpointIndexRef.current = null
			checkpoint.scrollIntoView({ block: "center", behavior: "smooth" })
		}
	}, [renderedGroupedMessages.length, transcriptStartIndex, expandedTraces])

	const itemContent = useCallback(
		(index: number, messageOrGroup: AlphaMessage) => {
			const isLast = index === groupedMessages.length - 1

			// regular message
			return (
				<ChatRow
					key={messageOrGroup.ts}
					message={messageOrGroup}
					environment={chatRowEnvironment}
					isExpanded={expandedRows[messageOrGroup.ts] || false}
					onToggleExpand={toggleRowExpansion} // This was already stabilized
					lastModifiedMessage={isLast ? modifiedMessages.at(-1) : undefined}
					isLast={isLast}
					isStreaming={isLast && isStreaming}
					messageActionsDisabled={isTurnActive || isCompletedTaskResumePending}
					onSuggestionClick={handleSuggestionClickInRow} // This was already stabilized
					onRequestUserInputSubmit={handleRequestUserInputSubmit}
					onRequestUserInputCancel={handleRequestUserInputCancel}
					onAsyncUserInputSubmit={handleAsyncUserInputSubmit}
					isAsyncUserInputPending={pendingAsyncUserInputTs.has(messageOrGroup.ts)}
					isAsyncUserInputAnswered={
						messageOrGroup.type === "say" &&
						messageOrGroup.say === "async_user_input" &&
						(messageOrGroup.isAnswered === true ||
							answeredAsyncUserInputTs.has(`${visibleCurrentTaskId}:${messageOrGroup.ts}`))
					}
					onBatchFileResponse={handleBatchFileResponse}
					onFollowUpUnmount={handleFollowUpUnmount}
					isFollowUpAnswered={
						messageOrGroup.isAnswered === true ||
						messageOrGroup.ts === currentFollowUpTs ||
						isVisibleTaskCompleted
					}
					isFollowUpAutoApprovalPaused={isFollowUpAutoApprovalPaused}
					editable={
						messageOrGroup.type === "ask" &&
						messageOrGroup.ask === "tool" &&
						(() => {
							let tool: any = {}
							try {
								tool = JSON.parse(messageOrGroup.text || "{}")
							} catch (_) {
								if (messageOrGroup.text?.includes("updateTodoList")) {
									tool = { tool: "updateTodoList" }
								}
							}
							return tool.tool === "updateTodoList" && enableButtons && !!primaryButtonText
						})()
					}
					hasCheckpoint={hasLatestCheckpoint}
					onJumpToPreviousCheckpoint={handleScrollToLatestCheckpoint}
				/>
			)
		},
		[
			chatRowEnvironment,
			expandedRows,
			toggleRowExpansion,
			modifiedMessages,
			groupedMessages.length,
			isStreaming,
			isTurnActive,
			isCompletedTaskResumePending,
			handleSuggestionClickInRow,
			handleRequestUserInputSubmit,
			handleRequestUserInputCancel,
			handleAsyncUserInputSubmit,
			answeredAsyncUserInputTs,
			pendingAsyncUserInputTs,
			visibleCurrentTaskId,
			handleBatchFileResponse,
			handleFollowUpUnmount,
			currentFollowUpTs,
			isVisibleTaskCompleted,
			isFollowUpAutoApprovalPaused,
			enableButtons,
			primaryButtonText,
			handleScrollToLatestCheckpoint,
			hasLatestCheckpoint,
		],
	)

	const isStandaloneNewTaskAction =
		primaryButtonText === t("chat:startNewTask.title") &&
		!secondaryButtonText &&
		!tertiaryButtonText &&
		!toolApprovalRequest

	useImperativeHandle(ref, () => ({
		sendAndSteer: (taskId) => {
			if (
				taskId !== visibleCurrentTaskId ||
				isHidden ||
				isManagedSubagent ||
				isProfileDisabled ||
				isCondensing ||
				editingQueuedMessage ||
				pendingQueueRequestRef.current ||
				pendingSteerRequestRef.current ||
				pendingResumeRequestRef.current ||
				pendingEditRequestRef.current
			)
				return
			handleSendMessage(inputValue, selectedImages, undefined, true)
		},
		acceptInput: () => {
			const hasInput = inputValue.trim() || selectedImages.length > 0

			if (hasInput) {
				// The host Enter shortcut and textarea submit share input routing.
				// Approval buttons remain explicit actions when no draft is present.
				if (!isProfileDisabled && !isCondensing)
					handleSendMessage(inputValue, selectedImages, undefined, !isManagedSubagent)
				return
			}

			if (enableButtons && primaryButtonText && !isStandaloneNewTaskAction) {
				handlePrimaryButtonClick(inputValue, selectedImages)
			}
		},
	}))

	const areActionButtonsVisible = primaryButtonText || secondaryButtonText || tertiaryButtonText
	const shouldShowActionButtons =
		areActionButtonsVisible && !isStandaloneNewTaskAction && !isManagedSubagent && !isCompletedTaskResumePending

	return (
		<div
			data-testid="chat-view"
			onFocusCapture={(event) => {
				const row = event.target.closest<HTMLElement>("[data-chat-message-index]")
				focusedActivityRef.current = row
					? { taskKey: transcriptTaskKey, index: Number(row.dataset.chatMessageIndex) }
					: undefined
			}}
			className={isHidden ? "hidden" : "app-shell fixed inset-0 flex flex-col overflow-hidden"}>
			{telemetrySetting === "unset" && <TelemetryBanner />}
			{showAnnouncement && <Announcement hideAnnouncement={hideAnnouncement} />}
			{task ? (
				<>
					<TaskHeader
						apiConfiguration={apiConfiguration}
						currentTaskItem={visibleCurrentTaskItem}
						taskModel={
							visibleCurrentTaskItem ? liveTasksById?.[visibleCurrentTaskItem.id]?.model : undefined
						}
						tokensIn={apiMetrics.totalTokensIn}
						tokensOut={apiMetrics.totalTokensOut}
						cacheWrites={apiMetrics.totalCacheWrites}
						cacheReads={apiMetrics.totalCacheReads}
						totalCost={apiMetrics.totalCost}
						aggregatedCost={
							visibleCurrentTaskItem?.id && aggregatedCostsMap.has(visibleCurrentTaskItem.id)
								? aggregatedCostsMap.get(visibleCurrentTaskItem.id)!.totalCost
								: undefined
						}
						hasSubtasks={
							!!(
								visibleCurrentTaskItem?.id &&
								aggregatedCostsMap.has(visibleCurrentTaskItem.id) &&
								aggregatedCostsMap.get(visibleCurrentTaskItem.id)!.childrenCost > 0
							)
						}
						parentTaskId={visibleCurrentTaskItem?.parentTaskId}
						launcherTaskId={
							visibleCurrentTaskItem?.orchestrationParentTaskId ??
							visibleLiveTask?.orchestrationParentTaskId
						}
						onShowTask={openTaskWithCache}
						isManagedSubagent={isManagedSubagent}
						costBreakdown={
							visibleCurrentTaskItem?.id && aggregatedCostsMap.has(visibleCurrentTaskItem.id)
								? getCostBreakdownIfNeeded(aggregatedCostsMap.get(visibleCurrentTaskItem.id)!, {
										own: t("common:costs.own"),
										subtasks: t("common:costs.subtasks"),
									})
								: undefined
						}
						contextTokens={apiMetrics.contextTokens}
						buttonsDisabled={sendingDisabled}
						handleCondenseContext={handleCondenseContext}
						todos={latestTodos}
						onExpandedChange={handleTaskHeaderExpandedChange}
					/>

					{showManagedAgentTree && visibleCurrentTaskId && (
						<div className="px-3 pb-1">
							<ManagedAgentTree
								rootTaskId={visibleCurrentTaskId}
								groups={managedAgentGroups}
								projection={managedAgentTreeProjection}
								liveTasksById={liveTasksById}
								onShowTask={openTaskWithCache}
								isVisible={!isHidden}
							/>
						</div>
					)}

					{canShowCrossTaskPanel && visibleCurrentTaskId && (
						<CrossTaskPanel
							parentTaskId={visibleCurrentTaskId}
							taskHistory={taskHistory}
							liveTasksById={liveTasksById}
							onOpen={openTaskWithCache}
						/>
					)}

					{checkpointWarning && (
						<div className="px-3">
							<CheckpointWarning warning={checkpointWarning} />
						</div>
					)}
				</>
			) : (
				<div className="new-task-home relative flex min-h-0 flex-1 flex-col overflow-y-auto">
					<div className="chat-column flex min-h-0 flex-1 flex-col">
						{(taskHistory.length > 0 || showChatsPanel) && (
							<HistoryPreview
								expanded={showChatsPanel}
								onExpand={() => setIsHistoryExpanded(true)}
								focusRequest={historyFocusRequest}
								onClose={closeChatsPanel}
							/>
						)}
						{/* Keep the decorative watermark from forcing a scrollbar when history fills the panel. */}
						<div
							data-testid="alpha-home-brand"
							className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
							<AlphaHero variant="watermark" />
						</div>
					</div>
				</div>
			)}

			{task && showChatsPanel && (
				<div className="max-h-[40vh] shrink-0 overflow-y-auto px-3 pb-2">
					<HistoryPreview expanded focusRequest={historyFocusRequest} onClose={closeChatsPanel} />
				</div>
			)}

			{!task && showWorktreesInHomeScreen && <WorktreeSelector />}

			{task && (
				<div data-testid="chat-transcript-viewport" className="relative mb-2 min-h-0 flex-1 overflow-hidden">
					<div
						ref={bindTranscriptScroller}
						key={task.ts}
						data-testid="chat-transcript-scroller"
						data-chat-transcript-scroller="true"
						tabIndex={0}
						className="scrollable h-full min-h-0 w-full overflow-y-auto overscroll-contain"
						style={{ overflowAnchor: "none", scrollbarGutter: "stable both-edges" }}
						onScroll={handleScrollerScroll}
						onWheel={handleScrollerWheel}
						onPointerDown={handleScrollerPointerDown}
						onPointerUp={handleScrollerPointerUp}
						onPointerCancel={handleScrollerPointerUp}
						onLoadCapture={handleContentLoad}>
						<div
							ref={setContentRef}
							className="chat-column chat-transcript py-3"
							data-testid="chat-transcript-content"
							data-count={groupedMessages.length}
							data-rendered-count={renderedGroupedMessages.length}>
							<ChatTranscriptRows
								isHidden={isHidden}
								transcriptTaskKey={transcriptTaskKey}
								transcriptStartIndex={transcriptStartIndex}
								hasOlderTranscript={hasOlderTranscript}
								task={task}
								expandedRows={expandedRows}
								isTurnActive={isTurnActive}
								chatRowEnvironment={chatRowEnvironment}
								toggleRowExpansion={toggleRowExpansion}
								renderedGroupedMessages={renderedGroupedMessages}
								actionActivity={actionActivity}
								expandedTraces={expandedTraces}
								fileChangeTurnsByEndIndex={fileChangeTurnsByEndIndex}
								itemContent={itemContent}
								loadOlderTranscript={loadOlderTranscript}
								revealTranscriptIndex={revealTranscriptIndex}
								releaseFollow={releaseFollow}
								setTraceExpanded={setTraceExpanded}
								handleFileChangesExpandedChange={handleFileChangesExpandedChange}
								loadOlderLabel={t("chat:transcript.loadOlder")}
								loadAllLabel={t("chat:transcript.loadAll")}
							/>
						</div>
					</div>
					{showScrollToBottom && (
						<div
							data-testid="chat-scroll-controls"
							className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex h-9 items-center justify-center gap-2 px-[15px]"
							onWheel={handleScrollControlsWheel}>
							<StandardTooltip content={t("chat:scrollToBottom")}>
								<Button
									variant="secondary"
									size="icon"
									className="pointer-events-auto rounded-full"
									onClick={handleScrollToBottomAndResetCheckpointCursor}
									aria-label={t("chat:scrollToBottom")}>
									<span className="codicon codicon-chevron-down"></span>
								</Button>
							</StandardTooltip>
							{hasLatestCheckpoint && (
								<StandardTooltip content={t("chat:scrollToLatestCheckpoint")}>
									<Button
										variant="secondary"
										size="icon"
										className="pointer-events-auto rounded-full"
										onClick={handleScrollToLatestCheckpoint}
										aria-label={t("chat:scrollToLatestCheckpoint")}>
										<span className="codicon codicon-history"></span>
									</Button>
								</StandardTooltip>
							)}
						</div>
					)}
				</div>
			)}

			<div
				data-testid="chat-bottom-dock"
				className={cn("chat-column relative z-20 flex shrink-0 flex-col", !task && "new-task-dock")}>
				{task && (
					<>
						{isCompletedTaskResumePending && !isManagedSubagent && (
							<div
								data-testid="completed-task-resume-pending"
								role="status"
								aria-live="polite"
								className="mb-1 flex h-9 shrink-0 items-center justify-center gap-2 px-[15px] text-vscode-descriptionForeground">
								<span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />
								<span>{t("chat:resumeTask.title")}…</span>
							</div>
						)}
						{shouldShowActionButtons && (
							<>
								{toolApprovalRequest?.cwd && (
									<div
										role="note"
										className="mx-[15px] mb-1 rounded-md border border-vscode-panel-border px-3 py-2 text-xs text-vscode-descriptionForeground">
										<span>{t("chat:approveCommand.cwdLabel")}</span>
										<code className="mt-1 block max-h-16 overflow-auto whitespace-pre-wrap break-all font-mono text-vscode-foreground">
											{toolApprovalRequest.cwd}
										</code>
									</div>
								)}
								{toolApprovalRequest?.proposedAmendment && (
									<div
										role="note"
										className="mx-[15px] mb-1 rounded-md border border-vscode-panel-border px-3 py-2 text-xs text-vscode-descriptionForeground">
										<span>{t("chat:approveCommand.review")}</span>
										<code className="mt-1 block max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-vscode-foreground">
											{toolApprovalRequest.proposedAmendment.command}
										</code>
									</div>
								)}
								{toolApprovalRequest?.proposedPersistentAmendment && (
									<div
										role="note"
										className="mx-[15px] mb-1 rounded-md border border-vscode-panel-border px-3 py-2 text-xs text-vscode-descriptionForeground">
										<span>{t("chat:approvePersistentCommand.review")}</span>
										<code className="mt-1 block max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-vscode-foreground">
											{toolApprovalRequest.proposedPersistentAmendment.prefix}
										</code>
									</div>
								)}
								<div
									className={`mb-1 flex h-9 shrink-0 items-center px-[15px] ${enableButtons ? "opacity-100" : "opacity-50"}`}>
									{primaryButtonText && (
										<StandardTooltip
											content={
												primaryButtonText === t("chat:retry.title")
													? t("chat:retry.tooltip")
													: primaryButtonText === t("chat:save.title")
														? t("chat:save.tooltip")
														: primaryButtonText === t("chat:approve.title")
															? t("chat:approve.tooltip")
															: primaryButtonText === t("chat:runCommand.title")
																? t("chat:runCommand.tooltip")
																: primaryButtonText === t("chat:startNewTask.title")
																	? t("chat:startNewTask.tooltip")
																	: primaryButtonText === t("chat:resumeTask.title")
																		? t("chat:resumeTask.tooltip")
																		: primaryButtonText ===
																			  t("chat:proceedAnyways.title")
																			? t("chat:proceedAnyways.tooltip")
																			: primaryButtonText ===
																				  t("chat:proceedWhileRunning.title")
																				? t("chat:proceedWhileRunning.tooltip")
																				: undefined
											}>
											<Button
												variant="primary"
												disabled={!enableButtons}
												className={secondaryButtonText ? "flex-1 mr-[6px]" : "flex-[2] mr-0"}
												onClick={() => handlePrimaryButtonClick(inputValue, selectedImages)}>
												{primaryButtonText}
											</Button>
										</StandardTooltip>
									)}
									{secondaryButtonText && (
										<StandardTooltip
											content={
												secondaryButtonText === t("chat:startNewTask.title")
													? t("chat:startNewTask.tooltip")
													: secondaryButtonText === t("chat:reject.title")
														? t("chat:reject.tooltip")
														: secondaryButtonText === t("chat:terminate.title")
															? t("chat:terminate.tooltip")
															: secondaryButtonText === t("chat:killCommand.title")
																? t("chat:killCommand.tooltip")
																: undefined
											}>
											<Button
												variant="secondary"
												disabled={!enableButtons}
												className={tertiaryButtonText ? "flex-1 mx-[3px]" : "flex-1 ml-[6px]"}
												onClick={() => handleSecondaryButtonClick()}>
												{secondaryButtonText}
											</Button>
										</StandardTooltip>
									)}
									{tertiaryButtonText && (
										<Button
											variant="secondary"
											disabled={!enableButtons}
											className="flex-1 ml-[3px]"
											aria-label={tertiaryButtonText}
											onClick={() => {
												if (toolApprovalRequest) sendToolApprovalDecision("abort")
											}}>
											{tertiaryButtonText}
										</Button>
									)}
								</div>
								{toolApprovalRequest &&
									(toolApprovalRequest.availableDecisions.includes("approve_session") ||
										toolApprovalRequest.availableDecisions.includes("approve_with_amendment") ||
										toolApprovalRequest.availableDecisions.includes("approve_persistently")) && (
										<div
											className={`mb-2 grid shrink-0 grid-cols-3 gap-1 px-[15px] ${enableButtons ? "opacity-100" : "opacity-50"}`}>
											{toolApprovalRequest.availableDecisions.includes("approve_session") && (
												<StandardTooltip content={t("chat:approveSession.tooltip")}>
													<Button
														variant="secondary"
														disabled={!enableButtons}
														aria-label={t("chat:approveSession.title")}
														onClick={() => sendToolApprovalDecision("approve_session")}>
														{t("chat:approveSession.title")}
													</Button>
												</StandardTooltip>
											)}
											{toolApprovalRequest.availableDecisions.includes(
												"approve_persistently",
											) && (
												<StandardTooltip content={t("chat:approvePersistentCommand.tooltip")}>
													<Button
														variant="secondary"
														disabled={!enableButtons}
														aria-label={t("chat:approvePersistentCommand.title")}
														onClick={() =>
															sendToolApprovalDecision("approve_persistently")
														}>
														{t("chat:approvePersistentCommand.title")}
													</Button>
												</StandardTooltip>
											)}
											{toolApprovalRequest.availableDecisions.includes(
												"approve_with_amendment",
											) && (
												<StandardTooltip content={t("chat:approveCommand.tooltip")}>
													<Button
														variant="secondary"
														disabled={!enableButtons}
														aria-label={t("chat:approveCommand.title")}
														onClick={() =>
															sendToolApprovalDecision("approve_with_amendment")
														}>
														{t("chat:approveCommand.title")}
													</Button>
												</StandardTooltip>
											)}
										</div>
									)}
							</>
						)}
					</>
				)}

				{!isManagedSubagent && (
					<QueuedMessages
						queue={displayedMessageQueue}
						pendingMessageId={
							pendingQueuePreview?.id ??
							pendingResumeRequest?.requestId ??
							projectedMessageQueue.find(
								(message) =>
									message.deliveryState === "delivering" &&
									transcriptQueuedMessageIds.has(message.id),
							)?.id
						}
						editingMessageId={editingQueuedMessage?.id}
						steeringMessageId={pendingSteerRequest?.messageId}
						onRemove={(index) => {
							if (visibleMessageQueue[index]) {
								vscode.postMessage({
									type: "removeQueuedMessage",
									text: visibleMessageQueue[index].id,
									...visibleTaskPayload,
								})
							}
						}}
						onSteer={(index) => {
							if (visibleMessageQueue[index] && visibleCurrentTaskId && !pendingSteerRequestRef.current) {
								const requestId = crypto.randomUUID()
								const request = {
									requestId,
									taskId: visibleCurrentTaskId,
									messageId: visibleMessageQueue[index].id,
								}
								pendingSteerRequestRef.current = request
								setPendingSteerRequest(request)
								setChatCommandError(undefined)
								vscode.postMessage({
									type: "steerQueuedMessage",
									text: visibleMessageQueue[index].id,
									taskId: visibleCurrentTaskId,
									requestId,
								})
							}
						}}
						onEdit={(index) => {
							if (visibleMessageQueue[index]) {
								startQueuedMessageEdit(visibleMessageQueue[index])
							}
						}}
						onReorder={(fromIndex, toIndex) => {
							if (visibleMessageQueue[fromIndex]) {
								vscode.postMessage({
									type: "reorderQueuedMessage",
									payload: {
										id: visibleMessageQueue[fromIndex].id,
										toIndex,
									},
									...visibleTaskPayload,
								})
							}
						}}
					/>
				)}
				{notificationTaskIds
					.filter((taskId) => taskId !== visibleCurrentTaskId)
					.map((taskId) => (
						<div
							key={taskId}
							role="status"
							className="mx-[15px] mb-2 flex items-center gap-2 text-xs text-vscode-descriptionForeground">
							<span className="min-w-0 flex-1 truncate">
								{t("chat:taskAttention.waiting", {
									name: taskHistory.find((item) => item.id === taskId)?.task ?? taskId,
								})}
							</span>
							<Button
								variant="secondary"
								size="sm"
								aria-label={t("chat:taskAttention.openNamed", {
									name: taskHistory.find((item) => item.id === taskId)?.task ?? taskId,
								})}
								onClick={() => {
									openTaskWithCache(taskId)
									setNotificationTaskIds((current) => current.filter((id) => id !== taskId))
								}}>
								{t("chat:taskAttention.open")}
							</Button>
						</div>
					))}
				{chatCommandError && (
					<div
						role="alert"
						className="mx-[15px] mb-2 rounded-md border border-vscode-inputValidation-errorBorder bg-vscode-inputValidation-errorBackground px-3 py-2 text-sm text-vscode-inputValidation-errorForeground">
						{chatCommandError}
					</div>
				)}
				{isModelResponseDelayed && (
					<div
						role="status"
						className="mx-[15px] mb-2 rounded-md border border-vscode-panel-border px-3 py-2 text-sm text-vscode-descriptionForeground">
						{t("chat:modelResponseDelayed")}
					</div>
				)}
				{showRetiredProviderWarning && (
					<div className="px-[15px] py-1">
						<WarningRow
							title={t("chat:retiredProvider.title")}
							message={t("chat:retiredProvider.message")}
							actionText={t("chat:retiredProvider.openSettings")}
							onAction={() => vscode.postMessage({ type: "switchTab", tab: "settings" })}
						/>
					</div>
				)}
				{!isManagedSubagent && (
					<ChatTextArea
						ref={textAreaRef}
						appearance={task ? "default" : "newTask"}
						inputValue={inputValue}
						setInputValue={setInputValue}
						sendingDisabled={
							isProfileDisabled ||
							isCompletedTaskResumePending ||
							isCondensing ||
							Boolean(pendingQueueRequest || pendingEditRequest)
						}
						selectApiConfigDisabled={
							isTurnActive && !isCompletedTaskResponseBoundary && alphaAsk !== "api_req_failed"
						}
						placeholderText={placeholderText}
						selectedImages={selectedImages}
						setSelectedImages={setSelectedImages}
						onSend={handleComposerSend}
						onSelectImages={selectImages}
						shouldDisableImages={shouldDisableImages}
						mode={mode}
						setMode={setMode}
						modeShortcutText={modeShortcutText}
						isEditMode={Boolean(editingQueuedMessage)}
						onCancel={cancelQueuedMessageEdit}
						isStreaming={isStreaming}
						onStop={handleStopTask}
						onEnqueueMessage={handleEnqueueCurrentMessage}
						enqueueDisabled={Boolean(pendingQueueRequest)}
						conversationClineMessages={conversationPromptMessages}
						conversationTaskId={visibleCurrentTaskId}
						isInTask={Boolean(task)}
						isTaskDraft={isDraftView}
						draftApprovalMode={draftApprovalMode}
						onDraftApprovalModeChange={setDraftApprovalMode}
					/>
				)}
			</div>
		</div>
	)
}

const ChatView = forwardRef(ChatViewComponent)

export default ChatView
