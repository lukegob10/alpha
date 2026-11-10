import React, { useCallback, useEffect, useRef, useState } from "react"
import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { ExtensionMessage } from "@alpha-code/types"

import TranslationProvider from "./i18n/TranslationContext"

import { vscode } from "./utils/vscode"
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
const ScheduledTasksView = React.lazy(() => import("./components/scheduled-tasks/ScheduledTasksView"))
const WorktreesManagerView = React.lazy(() => import("./components/worktrees/WorktreesManagerView"))
const AboutView = React.lazy(() => import("./components/settings/AboutView"))

const supportedTabs = ["settings", "history", "chat", "scheduledTasks", "worktrees", "about"] as const
type Tab = (typeof supportedTabs)[number]

function resolveSettingsUtilityTab(tab: Tab, section?: string): Tab {
	return tab === "settings" && (section === "worktrees" || section === "about") ? section : tab
}

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
}

const App = () => {
	const { didHydrateState, showWelcome, shouldShowAnnouncement, renderContext, currentTaskId, debug } =
		useShellState()
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
		(newTab: Tab, section?: string, scheduledTaskId?: string) => {
			const navigate = () => {
				const targetTab = resolveSettingsUtilityTab(newTab, section)
				setCurrentSection(targetTab === "settings" ? section : undefined)
				if (targetTab === "scheduledTasks") setScheduledTaskTargetId(scheduledTaskId)
				navigateToTab(targetTab)
			}
			if (settingsRef.current?.checkUnsaveChanges) {
				settingsRef.current.checkUnsaveChanges(navigate)
			} else {
				navigate()
			}
		},
		[navigateToTab],
	)

	const [currentSection, setCurrentSection] = useState<string | undefined>(undefined)
	const startNewChat = useCallback(() => {
		const start = () => {
			setCurrentSection(undefined)
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
					const targetSection =
						typeof message.values?.section === "string" ? message.values.section : undefined
					const scheduledTaskId =
						typeof message.values?.scheduledTaskId === "string" ? message.values.scheduledTaskId : undefined
					switchTab(targetTab, targetSection, scheduledTaskId)
				} else {
					// Handle other actions using the mapping
					const newTab = tabsByMessageAction[message.action]
					const section = typeof message.values?.section === "string" ? message.values.section : undefined

					if (newTab) {
						if (message.values?.force === true) {
							const targetTab = resolveSettingsUtilityTab(newTab, section)
							setCurrentSection(targetTab === "settings" ? section : undefined)
							navigateToTab(targetTab)
						} else {
							switchTab(newTab, section)
						}
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
								{t(
									tab === "worktrees"
										? "worktrees:title"
										: tab === "about"
											? "settings:sections.about"
											: `common:chatToolbar.${tab}`,
								)}
							</span>
						}
					/>
					<div className="relative min-h-0 flex-1 [&>.app-shell]:absolute">
						<React.Suspense
							fallback={
								<div role="status" className="p-4 text-sm text-vscode-descriptionForeground">
									{t("chat:reasoning.loading")}
								</div>
							}>
							{tab === "settings" && (
								<SettingsView
									ref={settingsRef}
									onDone={() => setTab("chat")}
									targetSection={currentSection}
								/>
							)}
							{tab === "scheduledTasks" && (
								<ScheduledTasksView
									onDone={() => switchTab("chat")}
									targetTaskId={scheduledTaskTargetId}
								/>
							)}
							{tab === "worktrees" && <WorktreesManagerView onDone={() => switchTab("chat")} />}
							{tab === "about" && <AboutView onDone={() => switchTab("chat")} />}
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
