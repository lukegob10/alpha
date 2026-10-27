import React, { useCallback, useEffect, useRef, useState, useMemo } from "react"
import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { type ExtensionMessage, TelemetryEventName } from "@alpha-code/types"

import TranslationProvider from "./i18n/TranslationContext"
import { MarketplaceViewStateManager } from "./components/marketplace/MarketplaceViewStateManager"

import { vscode } from "./utils/vscode"
import { telemetryClient } from "./utils/TelemetryClient"
import { initializeSourceMaps } from "./utils/sourceMapInitializer"
import { initializeWebviewErrorReporting } from "./utils/webviewErrors"
import { ExtensionStateContextProvider, useShellState } from "./context/ExtensionStateContext"
import ChatView, { ChatViewRef } from "./components/chat/ChatView"
import ChatToolbar from "./components/chat/ChatToolbar"
import { chatToolbarActions } from "./components/chat/chatToolbarActions"
import type { SettingsViewRef } from "./components/settings/SettingsView"
import WelcomeView from "./components/welcome/WelcomeViewProvider"
import { CheckpointRestoreDialog } from "./components/chat/CheckpointRestoreDialog"
import { DeleteMessageDialog, EditMessageDialog } from "./components/chat/MessageModificationConfirmationDialog"
import ErrorBoundary from "./components/ErrorBoundary"
import { useAddNonInteractiveClickListener } from "./components/ui/hooks/useNonInteractiveClick"
import { TooltipProvider } from "./components/ui/tooltip"
import { STANDARD_TOOLTIP_DELAY } from "./components/ui/standard-tooltip"
import { useAppTranslation } from "./i18n/TranslationContext"

const webviewAppStartedAt = performance.now()

const SettingsView = React.lazy(() => import("./components/settings/SettingsView"))
const MarketplaceView = React.lazy(() =>
	import("./components/marketplace/MarketplaceView").then(({ MarketplaceView }) => ({ default: MarketplaceView })),
)
const ScheduledTasksView = React.lazy(() => import("./components/scheduled-tasks/ScheduledTasksView"))

const supportedTabs = ["settings", "history", "chat", "marketplace", "scheduledTasks"] as const
type Tab = (typeof supportedTabs)[number]

interface DeleteMessageDialogState {
	isOpen: boolean
	taskId?: string
	messageTs: number
	hasCheckpoint: boolean
}

interface EditMessageDialogState {
	isOpen: boolean
	taskId?: string
	messageAction?: "restart"
	messageTs: number
	text: string
	hasCheckpoint: boolean
	images?: string[]
}

// Memoize dialog components to prevent unnecessary re-renders
const MemoizedDeleteMessageDialog = React.memo(DeleteMessageDialog)
const MemoizedEditMessageDialog = React.memo(EditMessageDialog)
const MemoizedCheckpointRestoreDialog = React.memo(CheckpointRestoreDialog)
const tabsByMessageAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, Tab>> = {
	chatButtonClicked: "chat",
	settingsButtonClicked: "settings",
	historyButtonClicked: "history",
	marketplaceButtonClicked: "marketplace",
}

const App = () => {
	const {
		didHydrateState,
		showWelcome,
		shouldShowAnnouncement,
		telemetrySetting,
		telemetryKey,
		machineId,
		renderContext,
		currentTaskId,
		debug,
	} = useShellState()
	const { t } = useAppTranslation()
	const didReportUiReady = useRef(false)

	useEffect(() => {
		if (!didHydrateState || didReportUiReady.current) return
		let secondFrame = 0
		const firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => {
				didReportUiReady.current = true
				vscode.postMessage({
					type: "webviewUiReady",
					durationMs: Math.max(0, Math.round(performance.now() - webviewAppStartedAt)),
				})
			})
		})
		return () => {
			cancelAnimationFrame(firstFrame)
			if (secondFrame) cancelAnimationFrame(secondFrame)
		}
	}, [didHydrateState])

	// Create a persistent state manager
	const marketplaceStateManager = useMemo(() => new MarketplaceViewStateManager(), [])

	const [showAnnouncement, setShowAnnouncement] = useState(false)
	const [tab, setTab] = useState<Exclude<Tab, "history">>("chat")
	const [historyFocusRequest, setHistoryFocusRequest] = useState(0)
	const [scheduledTaskTargetId, setScheduledTaskTargetId] = useState<string | undefined>(undefined)

	const [deleteMessageDialogState, setDeleteMessageDialogState] = useState<DeleteMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		hasCheckpoint: false,
	})

	const [editMessageDialogState, setEditMessageDialogState] = useState<EditMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		text: "",
		hasCheckpoint: false,
		images: [],
	})
	const editMessageConfirmedRef = useRef(false)
	const handleEditMessageConfirm = useCallback(
		(restoreCheckpoint?: boolean) => {
			if (!editMessageDialogState.isOpen || editMessageConfirmedRef.current) return
			editMessageConfirmedRef.current = true
			vscode.postMessage({
				type: "editMessageConfirm",
				taskId: editMessageDialogState.taskId,
				messageTs: editMessageDialogState.messageTs,
				text: editMessageDialogState.text,
				images: editMessageDialogState.images,
				...(restoreCheckpoint === undefined ? {} : { restoreCheckpoint }),
			})
			setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
		},
		[editMessageDialogState],
	)
	const handleEditDialogCloseAutoFocus = useCallback(
		(event: Event) => {
			if (editMessageConfirmedRef.current || editMessageDialogState.messageAction === "restart") return
			const editor = Array.from(document.querySelectorAll<HTMLElement>("[data-message-editor-task-id]"))
				.find(
					(element) =>
						element.dataset.messageEditorTaskId === editMessageDialogState.taskId &&
						element.dataset.messageEditorTs === String(editMessageDialogState.messageTs),
				)
				?.querySelector<HTMLTextAreaElement>("textarea")
			if (!editor?.isConnected || editor.closest("[hidden]")) return
			event.preventDefault()
			editor.focus({ preventScroll: true })
		},
		[editMessageDialogState.messageAction, editMessageDialogState.messageTs, editMessageDialogState.taskId],
	)

	const settingsRef = useRef<SettingsViewRef>(null)
	const chatViewRef = useRef<ChatViewRef>(null)

	const navigateToTab = useCallback((newTab: Tab) => {
		if (newTab === "history") {
			setHistoryFocusRequest((request) => request + 1)
			setTab("chat")
		} else {
			setTab(newTab)
		}
	}, [])

	const switchTab = useCallback(
		(newTab: Tab) => {
			setCurrentSection(undefined)
			setCurrentMarketplaceTab(undefined)

			if (settingsRef.current?.checkUnsaveChanges) {
				settingsRef.current.checkUnsaveChanges(() => navigateToTab(newTab))
			} else {
				navigateToTab(newTab)
			}
		},
		[navigateToTab],
	)

	const [currentSection, setCurrentSection] = useState<string | undefined>(undefined)
	const [currentMarketplaceTab, setCurrentMarketplaceTab] = useState<string | undefined>(undefined)
	const startNewChat = useCallback(() => {
		const start = () => {
			setCurrentSection(undefined)
			setCurrentMarketplaceTab(undefined)
			navigateToTab("chat")
			chatViewRef.current?.startNewChat()
		}
		if (settingsRef.current?.checkUnsaveChanges) settingsRef.current.checkUnsaveChanges(start)
		else start()
	}, [navigateToTab])

	const onMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			if (message.type === "action" && message.action) {
				if (message.action === "newChatButtonClicked") {
					startNewChat()
				} else if (message.action === "switchTab" && message.tab) {
					const targetTab = supportedTabs.find((tab) => tab === message.tab)
					if (!targetTab) return
					if (targetTab === "scheduledTasks") {
						setScheduledTaskTargetId(message.values?.scheduledTaskId as string | undefined)
					}
					switchTab(targetTab)
					// Extract targetSection from values if provided
					const targetSection = message.values?.section as string | undefined
					setCurrentSection(targetSection)
					setCurrentMarketplaceTab(undefined)
				} else {
					// Handle other actions using the mapping
					const newTab = tabsByMessageAction[message.action]
					const section = message.values?.section as string | undefined
					const marketplaceTab = message.values?.marketplaceTab as string | undefined

					if (newTab) {
						if (message.values?.force === true) {
							setCurrentSection(undefined)
							setCurrentMarketplaceTab(undefined)
							navigateToTab(newTab)
						} else {
							switchTab(newTab)
						}
						setCurrentSection(section)
						setCurrentMarketplaceTab(marketplaceTab)
					}
				}
			}

			if (message.type === "showDeleteMessageDialog" && message.messageTs) {
				setDeleteMessageDialogState({
					isOpen: true,
					taskId: message.taskId ?? currentTaskId,
					messageTs: message.messageTs,
					hasCheckpoint: message.hasCheckpoint || false,
				})
			}

			if (
				message.type === "showEditMessageDialog" &&
				message.messageTs &&
				(message.text || message.images?.length)
			) {
				editMessageConfirmedRef.current = false
				setEditMessageDialogState({
					isOpen: true,
					taskId: message.taskId ?? currentTaskId,
					messageAction: message.messageAction,
					messageTs: message.messageTs,
					text: message.text ?? "",
					hasCheckpoint: message.hasCheckpoint || false,
					images: message.images || [],
				})
			}

			if (message.type === "acceptInput") {
				chatViewRef.current?.acceptInput()
			}
			if (message.type === "sendAndSteer") {
				chatViewRef.current?.sendAndSteer(message.taskId)
			}
			if (message.type === "steerNextQueuedMessage") {
				chatViewRef.current?.steerNextQueuedMessage(message.taskId)
			}
		},
		[switchTab, navigateToTab, startNewChat, currentTaskId],
	)

	useEvent("message", onMessage)

	useEffect(() => {
		if (shouldShowAnnouncement && tab === "chat") {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement, tab])

	useEffect(() => {
		if (didHydrateState) {
			telemetryClient.updateTelemetryState(telemetrySetting, telemetryKey, machineId)
		}
	}, [telemetrySetting, telemetryKey, machineId, didHydrateState])

	useEffect(() => {
		let lastFocused: boolean | undefined
		const reportFocus = (focused: boolean) => {
			if (focused === lastFocused) return
			lastFocused = focused
			vscode.postMessage({ type: "webviewFocusChanged", focused })
		}
		const onFocus = () => reportFocus(true)
		const onBlur = () => reportFocus(false)
		window.addEventListener("focus", onFocus)
		window.addEventListener("blur", onBlur)
		reportFocus(document.hasFocus())
		return () => {
			window.removeEventListener("focus", onFocus)
			window.removeEventListener("blur", onBlur)
			if (lastFocused) reportFocus(false)
		}
	}, [])

	// Initialize source map support for better error reporting
	useEffect(() => {
		const disposeErrorReporting = initializeWebviewErrorReporting()
		// Initialize source maps for better error reporting in production
		const disposeSourceMaps = initializeSourceMaps()
		return () => {
			disposeSourceMaps()
			disposeErrorReporting()
		}
	}, [])

	// Focus the WebView when non-interactive content is clicked (only in editor/tab mode)
	useAddNonInteractiveClickListener(
		useCallback(() => {
			// Only send focus request if we're in editor (tab) mode, not sidebar
			if (renderContext === "editor") {
				vscode.postMessage({ type: "focusPanelRequest" })
			}
		}, [renderContext]),
	)
	// Track marketplace tab views
	useEffect(() => {
		if (tab === "marketplace") {
			telemetryClient.capture(TelemetryEventName.MARKETPLACE_TAB_VIEWED)
		}
	}, [tab])

	if (!didHydrateState) {
		return null
	}

	// Do not conditionally load ChatView, it's expensive and there's state we
	// don't want to lose (user input, disableInput, askResponse promise, etc.)
	return showWelcome ? (
		<WelcomeView />
	) : (
		<>
			{tab !== "chat" && (
				<div className="app-shell fixed inset-0 flex min-h-0 flex-col overflow-hidden">
					<ChatToolbar
						{...chatToolbarActions}
						renderContext={renderContext}
						debug={debug === true}
						onNewChat={startNewChat}
						navigation={
							<span className="min-w-0 truncate px-1 text-vscode-foreground">
								{t(`common:chatToolbar.${tab === "scheduledTasks" ? "scheduledTasks" : tab}`)}
							</span>
						}
					/>
					<div className="relative min-h-0 flex-1 [&>.app-shell]:absolute">
						<React.Suspense fallback={null}>
							{tab === "settings" && (
								<SettingsView
									ref={settingsRef}
									onDone={() => setTab("chat")}
									targetSection={currentSection}
								/>
							)}
							{tab === "marketplace" && (
								<MarketplaceView
									stateManager={marketplaceStateManager}
									onDone={() => switchTab("chat")}
									targetTab={currentMarketplaceTab as "mcp" | "mode" | undefined}
								/>
							)}
							{tab === "scheduledTasks" && (
								<ScheduledTasksView
									onDone={() => switchTab("chat")}
									targetTaskId={scheduledTaskTargetId}
								/>
							)}
						</React.Suspense>
					</div>
				</div>
			)}
			<ChatView
				ref={chatViewRef}
				isHidden={tab !== "chat"}
				historyFocusRequest={historyFocusRequest}
				showAnnouncement={showAnnouncement}
				hideAnnouncement={() => setShowAnnouncement(false)}
			/>
			<div id="alpha-portal" />
			{deleteMessageDialogState.hasCheckpoint ? (
				<MemoizedCheckpointRestoreDialog
					open={deleteMessageDialogState.isOpen}
					type="delete"
					hasCheckpoint={deleteMessageDialogState.hasCheckpoint}
					onOpenChange={(open: boolean) => setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onConfirm={(restoreCheckpoint: boolean) => {
						vscode.postMessage({
							type: "deleteMessageConfirm",
							taskId: deleteMessageDialogState.taskId,
							messageTs: deleteMessageDialogState.messageTs,
							restoreCheckpoint,
						})
						setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
					}}
				/>
			) : (
				<MemoizedDeleteMessageDialog
					open={deleteMessageDialogState.isOpen}
					onOpenChange={(open: boolean) => setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onConfirm={() => {
						vscode.postMessage({
							type: "deleteMessageConfirm",
							taskId: deleteMessageDialogState.taskId,
							messageTs: deleteMessageDialogState.messageTs,
						})
						setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
					}}
				/>
			)}
			{editMessageDialogState.hasCheckpoint ? (
				<MemoizedCheckpointRestoreDialog
					open={editMessageDialogState.isOpen}
					type={editMessageDialogState.messageAction ?? "edit"}
					hasCheckpoint={editMessageDialogState.hasCheckpoint}
					onOpenChange={(open: boolean) => setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onCloseAutoFocus={handleEditDialogCloseAutoFocus}
					onConfirm={handleEditMessageConfirm}
				/>
			) : (
				<MemoizedEditMessageDialog
					open={editMessageDialogState.isOpen}
					type={editMessageDialogState.messageAction ?? "edit"}
					onOpenChange={(open: boolean) => setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onCloseAutoFocus={handleEditDialogCloseAutoFocus}
					onConfirm={() => handleEditMessageConfirm()}
				/>
			)}
		</>
	)
}

const queryClient = new QueryClient()

const AppWithProviders = () => (
	<ErrorBoundary>
		<ExtensionStateContextProvider>
			<TranslationProvider>
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>
						<App />
					</TooltipProvider>
				</QueryClientProvider>
			</TranslationProvider>
		</ExtensionStateContextProvider>
	</ErrorBoundary>
)

export default AppWithProviders
