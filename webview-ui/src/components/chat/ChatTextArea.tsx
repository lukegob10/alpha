import React, {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import DynamicTextArea from "react-textarea-autosize"
import { SendHorizontal, X, ListEnd, Square } from "lucide-react"

import {
	restoreTaskMode,
	type AlphaMessage,
	type ApprovalMode,
	type Command,
	type ExtensionMessage,
} from "@alpha-code/types"

import { mentionRegex, mentionRegexGlobal, commandRegexGlobal, unescapeSpaces } from "@alpha/context-mentions"
import { Mode, codeModeSlug, getAllModes, planModeSlug } from "@alpha/modes"

import { vscode } from "@src/utils/vscode"
import { createDebounce } from "@src/utils/debounce"
import { getUserFacingModeOptions } from "@src/utils/modePresentation"
import { useShellState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	ContextMenuOptionType,
	type ContextMenuQueryItem,
	getContextMenuOptions,
	insertMention,
	isContextMenuOptionSelectable,
	removeMention,
	shouldShowContextMenu,
	SearchResult,
} from "@src/utils/context-mentions"
import { cn } from "@src/lib/utils"
import { convertToMentionPath } from "@src/utils/path-mentions"
import { StandardTooltip } from "@src/components/ui"
import {} from "@src/components/ui/dropdown-menu"

import Thumbnails from "../common/Thumbnails"
import { ApiConfigSelector } from "./ApiConfigSelector"
import { AutoApproveDropdown } from "./AutoApproveDropdown"
import { ChatReasoningControl } from "../reasoning/ChatReasoningControl"
import { MAX_IMAGES_PER_MESSAGE } from "./ChatView"
import ContextMenu from "./ContextMenu"
import { IndexingStatusBadge } from "./IndexingStatusBadge"
import { usePromptHistory, type RestoreHistoryDraft } from "./hooks/usePromptHistory"
import { useTicketSearch } from "./hooks/useTicketSearch"
import { forkChatCommandName, parseForkChatCommand } from "./forkChatCommand"

type ComposerSearchTarget = { value: string; caret: number }

interface ChatTextAreaProps {
	appearance?: "default" | "newTask"
	isVisible?: boolean
	contextControl?: React.ReactNode
	inputValue: string
	setInputValue: (value: string) => void
	sendingDisabled: boolean
	selectApiConfigDisabled: boolean
	placeholderText: string
	selectedImages: string[]
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
	onImageReadsPendingChange?: (taskId: string | undefined, pending: boolean) => void
	onSend: () => void
	canForkChat?: boolean
	shouldDisableImages: boolean
	onHeightChange?: (height: number) => void
	mode: Mode
	setMode: (value: Mode) => void
	modeShortcutText: string
	// Edit mode props
	isEditMode?: boolean
	onCancel?: () => void
	// Stop/Queue functionality
	isStreaming?: boolean
	onStop?: () => void
	onEnqueueMessage?: () => void
	enqueueDisabled?: boolean
	conversationAlphaMessages?: AlphaMessage[]
	conversationTaskId?: string
	isInTask?: boolean
	isTaskDraft?: boolean
	draftApprovalMode?: ApprovalMode
	onDraftApprovalModeChange?: (mode: ApprovalMode) => void
	onRestoreHistoryDraft?: RestoreHistoryDraft
}

export const ChatTextArea = memo(
	forwardRef<HTMLTextAreaElement, ChatTextAreaProps>(
		(
			{
				appearance = "default",
				isVisible = true,
				contextControl,
				inputValue,
				setInputValue,
				sendingDisabled,
				selectApiConfigDisabled,
				placeholderText,
				selectedImages,
				setSelectedImages,
				onImageReadsPendingChange,
				onSend,
				canForkChat = false,
				shouldDisableImages,
				onHeightChange,
				mode,
				setMode,
				modeShortcutText,
				isEditMode = false,
				onCancel,
				isStreaming = false,
				onStop,
				onEnqueueMessage,
				enqueueDisabled = false,
				conversationAlphaMessages,
				conversationTaskId,
				isInTask,
				isTaskDraft = false,
				draftApprovalMode,
				onDraftApprovalModeChange,
				onRestoreHistoryDraft,
			},
			ref,
		) => {
			const isNewTask = appearance === "newTask" && !isEditMode
			const { t } = useAppTranslation()
			const {
				filePaths,
				openedTabs,
				currentApiConfigName,
				listApiConfigMeta,
				customModes,
				cwd,
				pinnedApiConfigs,
				togglePinnedApiConfig,
				taskHistory,
				alphaMessages,
				enterBehavior,
				autoSteer = false,
				taskReasoning,
				currentTaskId,
			} = useShellState()
			const taskId = conversationAlphaMessages !== undefined ? conversationTaskId : currentTaskId
			const [reasoningProfileLoading, setReasoningProfileLoading] = useState(false)
			useEffect(() => setReasoningProfileLoading(false), [taskReasoning, currentTaskId, currentApiConfigName])

			// Find the ID and display text for the currently selected API configuration.
			const { currentConfigId, displayName } = useMemo(() => {
				const currentConfig = listApiConfigMeta?.find((config) => config.name === currentApiConfigName)
				return {
					currentConfigId: currentConfig?.id || "",
					displayName: currentApiConfigName || "", // Use the name directly for display.
				}
			}, [listApiConfigMeta, currentApiConfigName])

			const [commitSearchResult, setCommitSearchResult] = useState<{
				taskId?: string
				cwd?: string
				query: string
				items: ContextMenuQueryItem[]
			}>()
			const [fileSearchResult, setFileSearchResult] = useState<{
				target: ComposerSearchTarget
				query: string
				results: SearchResult[]
			}>()
			const pendingFileSearch = useRef<{ requestId: string; target: ComposerSearchTarget; query: string }>()
			// Handle inserted text and search results.
			useEffect(() => {
				const messageHandler = (event: MessageEvent) => {
					const message = event.data

					if (message.type === "insertTextIntoTextarea") {
						if (message.text && textAreaRef.current) {
							// Insert the command text at the current cursor position
							const textarea = textAreaRef.current
							const currentValue = textarea.value
							const cursorPos = textarea.selectionStart || 0

							// Check if we need to add a space before the command
							const textBefore = currentValue.slice(0, cursorPos)
							const needsSpaceBefore = textBefore.length > 0 && !textBefore.endsWith(" ")
							const prefix = needsSpaceBefore ? " " : ""

							// Insert the text at cursor position
							const newValue =
								currentValue.slice(0, cursorPos) +
								prefix +
								message.text +
								" " +
								currentValue.slice(cursorPos)
							setInputValue(newValue)

							// Set cursor position after the inserted text
							const newCursorPos = cursorPos + prefix.length + message.text.length + 1
							setCursorPosition(newCursorPos)
							setCursorSelection({ position: newCursorPos, focus: "focus" })
						}
					} else if (message.type === "fileSearchResults") {
						const pending = pendingFileSearch.current
						if (!pending || message.requestId !== pending.requestId) return
						pendingFileSearch.current = undefined
						const textarea = textAreaRef.current
						if (
							textarea?.value !== pending.target.value ||
							textarea.selectionStart !== pending.target.caret
						) {
							return
						}
						setFileSearchResult({
							target: pending.target,
							query: pending.query,
							results: message.results || [],
						})
					}
				}

				window.addEventListener("message", messageHandler)
				return () => window.removeEventListener("message", messageHandler)
			}, [setInputValue])

			const [isDraggingOver, setIsDraggingOver] = useState(false)
			const [textAreaBaseHeight, setTextAreaBaseHeight] = useState<number | undefined>(undefined)
			const [showContextMenu, setShowContextMenu] = useState(false)
			const [cursorPosition, setCursorPosition] = useState(0)
			const [searchQuery, setSearchQuery] = useState("")
			const menuTarget = useRef<ComposerSearchTarget>()
			const fileSearchResults =
				showContextMenu &&
				fileSearchResult?.target.value === inputValue &&
				fileSearchResult.target.caret === cursorPosition &&
				fileSearchResult.query === searchQuery
					? fileSearchResult.results
					: undefined
			const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
			const setTextAreaRef = useCallback(
				(element: HTMLTextAreaElement | null) => {
					if (typeof ref === "function") {
						ref(element)
					} else if (ref) {
						ref.current = element
					}
					textAreaRef.current = element
				},
				[ref],
			)
			const isMouseDownOnMenuRef = useRef(false)
			const highlightLayerRef = useRef<HTMLDivElement>(null)
			const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
			const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
			const ticketOptions = useTicketSearch(
				showContextMenu &&
					(selectedType === ContextMenuOptionType.Ticket ||
						(selectedType === null && /^[a-z]{2,4}$/i.test(searchQuery))),
				searchQuery,
				cwd ?? "",
				taskId,
			)
			const [justDeletedSpaceAfterMention, setJustDeletedSpaceAfterMention] = useState(false)
			const [cursorSelection, setCursorSelection] = useState<{
				position: number
				focus?: "focus" | "refocus"
			} | null>(null)
			const contextMenuContainerRef = useRef<HTMLDivElement>(null)
			const contextMenuId = useId()
			const [isFocused, setIsFocused] = useState(false)
			useLayoutEffect(() => {
				if (!isVisible || (menuTarget.current && menuTarget.current.value !== inputValue)) {
					setShowContextMenu(false)
				}
			}, [inputValue, isVisible])

			const commandScope = useMemo(() => ({ taskId, cwd, mode }), [taskId, cwd, mode])
			const [commandCatalog, setCommandCatalog] = useState<{ scope: typeof commandScope; commands: Command[] }>()
			const commands = commandCatalog?.scope === commandScope ? commandCatalog.commands : undefined
			const slashSearchActive =
				isVisible && showContextMenu && searchQuery.startsWith("/") && searchQuery === inputValue
			useLayoutEffect(() => {
				if (!slashSearchActive) return
				setCommandCatalog(undefined)
				const requestId = crypto.randomUUID()
				const receive = ({ data }: MessageEvent<ExtensionMessage>) => {
					if (data?.type !== "commands" || data.requestId !== requestId || !Array.isArray(data.commands)) {
						return
					}
					setCommandCatalog({ scope: commandScope, commands: data.commands })
				}
				window.addEventListener("message", receive)
				vscode.postMessage({
					type: "requestCommands",
					requestId,
					...(commandScope.taskId ? { taskId: commandScope.taskId } : { workspaceScope: true }),
				})
				return () => window.removeEventListener("message", receive)
			}, [commandScope, slashSearchActive])

			// Use custom hook for prompt history navigation
			const { handleHistoryNavigation, resetHistoryNavigation, resetOnInputChange } = usePromptHistory({
				taskId,
				alphaMessages: conversationAlphaMessages ?? alphaMessages,
				taskHistory,
				cwd,
				inputValue,
				setInputValue,
				isInTask: conversationAlphaMessages !== undefined ? isInTask : undefined,
				onRestoreHistoryDraft,
			})

			const commitSearchActive =
				showContextMenu &&
				(selectedType === ContextMenuOptionType.Git ||
					(selectedType !== ContextMenuOptionType.Ticket && /^[a-f0-9]+$/i.test(searchQuery)))
			useEffect(() => {
				setCommitSearchResult(undefined)
				if (!commitSearchActive) return

				const requestId = crypto.randomUUID()
				const receive = ({ data }: MessageEvent<ExtensionMessage>) => {
					if (
						data?.type !== "commitSearchResults" ||
						data.requestId !== requestId ||
						data.taskId !== taskId ||
						!Array.isArray(data.commits)
					) {
						return
					}
					setCommitSearchResult({
						taskId,
						cwd,
						query: searchQuery,
						items: data.commits.map((commit) => ({
							type: ContextMenuOptionType.Git,
							value: commit.hash,
							label: commit.subject,
							description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
							icon: "$(git-commit)",
						})),
					})
				}
				window.addEventListener("message", receive)
				vscode.postMessage({ type: "searchCommits", query: searchQuery, requestId, taskId })
				return () => window.removeEventListener("message", receive)
			}, [commitSearchActive, searchQuery, taskId, cwd])
			const gitCommits =
				commitSearchActive &&
				commitSearchResult?.taskId === taskId &&
				commitSearchResult?.cwd === cwd &&
				commitSearchResult?.query === searchQuery
					? commitSearchResult.items
					: undefined

			const imageReadBatches = useRef(new Map<string | undefined, { pending: number }>())
			const [imageReadOwners, setImageReadOwners] = useState<ReadonlySet<string | undefined>>(new Set())
			const imagesLoading = imageReadOwners.has(conversationTaskId)
			const publishImageReads = useCallback(
				(owner: string | undefined, pending: boolean) => {
					onImageReadsPendingChange?.(owner, pending)
					setImageReadOwners(new Set(imageReadBatches.current.keys()))
				},
				[onImageReadsPendingChange],
			)
			const handleSend = useCallback(() => {
				if (imageReadBatches.current.has(conversationTaskId)) return
				resetHistoryNavigation()
				onSend()
			}, [conversationTaskId, resetHistoryNavigation, onSend])
			const handleCancelEdit = useCallback(() => {
				if (imageReadBatches.current.delete(conversationTaskId)) publishImageReads(conversationTaskId, false)
				onCancel?.()
			}, [conversationTaskId, onCancel, publishImageReads])
			const handleStop = useCallback(() => {
				onStop?.()
			}, [onStop])

			const allModes = useMemo(
				() => getUserFacingModeOptions(getAllModes(customModes), mode),
				[customModes, mode],
			)
			const modeSwitchDisabled = isStreaming || isEditMode
			const contextMenuModes = useMemo(() => (modeSwitchDisabled ? [] : allModes), [allModes, modeSwitchDisabled])

			// Memoized check for whether the input has content (text or images)
			const hasInputContent = useMemo(() => {
				return inputValue.trim().length > 0 || selectedImages.length > 0
			}, [inputValue, selectedImages])
			const isStopAction = isStreaming && !isEditMode && !hasInputContent
			const isForkCommand = !isEditMode && parseForkChatCommand(inputValue) !== undefined
			const sendDisabled =
				(imagesLoading && !isStopAction) ||
				(!isForkCommand &&
					((!hasInputContent && !isStopAction) ||
						(sendingDisabled && (isEditMode || !isStreaming)) ||
						(isStreaming && !isEditMode && hasInputContent && enqueueDisabled)))

			// Compute the key combination text for the send button tooltip based on enterBehavior
			const sendKeyCombination = useMemo(() => {
				if (enterBehavior === "newline") {
					// When Enter = newline, Ctrl/Cmd+Enter sends
					const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0
					return isMac ? "⌘+Enter" : "Ctrl+Enter"
				}
				// Default: Enter sends
				return "Enter"
			}, [enterBehavior])
			const sendActionLabel = isStopAction
				? t("chat:stop.title")
				: t(
						isStreaming && !isEditMode && !isForkCommand
							? autoSteer
								? "chat:pressToSteer"
								: "chat:pressToQueue"
							: "chat:pressToSend",
						{ keyCombination: sendKeyCombination },
					)

			const queryItems = useMemo(() => {
				return [
					{ type: ContextMenuOptionType.Problems, value: "problems" },
					{ type: ContextMenuOptionType.Terminal, value: "terminal" },
					...(gitCommits ?? []),
					...openedTabs
						.filter((tab) => tab.path)
						.map((tab) => ({
							type: ContextMenuOptionType.OpenedFile,
							value: "/" + tab.path,
						})),
					...filePaths
						.map((file) => "/" + file)
						.filter((path) => !openedTabs.some((tab) => tab.path && "/" + tab.path === path)) // Filter out paths that are already in openedTabs
						.map((path) => ({
							type: path.endsWith("/") ? ContextMenuOptionType.Folder : ContextMenuOptionType.File,
							value: path,
						})),
				]
			}, [filePaths, gitCommits, openedTabs])

			const builtInCommands = useMemo<ContextMenuQueryItem[]>(
				() =>
					canForkChat && !isEditMode
						? [
								{
									type: ContextMenuOptionType.Command,
									value: forkChatCommandName,
									slashCommand: `/${forkChatCommandName}`,
									description: t("chat:forkChat.description"),
									argumentHint: t("chat:forkChat.nameHint"),
								},
							]
						: [],
				[canForkChat, isEditMode, t],
			)
			const skillCommands = useMemo(
				() => commands?.filter((command) => command.name !== forkChatCommandName),
				[commands],
			)
			const contextMenuOptions = useMemo(
				() =>
					getContextMenuOptions(
						searchQuery,
						selectedType,
						queryItems,
						fileSearchResults,
						contextMenuModes,
						skillCommands,
						ticketOptions,
						builtInCommands,
					),
				[
					searchQuery,
					selectedType,
					queryItems,
					fileSearchResults,
					contextMenuModes,
					skillCommands,
					ticketOptions,
					builtInCommands,
				],
			)
			const selectedOption = contextMenuOptions[selectedMenuIndex]
			const hasSelectedOption = isContextMenuOptionSelectable(selectedOption)

			useEffect(() => {
				const handleClickOutside = (event: MouseEvent) => {
					if (
						contextMenuContainerRef.current &&
						!contextMenuContainerRef.current.contains(event.target as Node)
					) {
						setShowContextMenu(false)
					}
				}

				if (showContextMenu) {
					document.addEventListener("mousedown", handleClickOutside)
				}

				return () => {
					document.removeEventListener("mousedown", handleClickOutside)
				}
			}, [showContextMenu, setShowContextMenu])

			const handleMentionSelect = useCallback(
				(type: ContextMenuOptionType, value?: string) => {
					isMouseDownOnMenuRef.current = false
					if (type === ContextMenuOptionType.NoResults) {
						return
					}

					if (type === ContextMenuOptionType.Mode && value) {
						if (modeSwitchDisabled) {
							setShowContextMenu(false)
							return
						}

						// Handle mode selection.
						setMode(value)
						setInputValue("")
						setShowContextMenu(false)
						vscode.postMessage({ type: "mode", text: value })
						return
					}

					if (type === ContextMenuOptionType.Command && value) {
						// Handle command selection.
						setSelectedMenuIndex(-1)
						setInputValue("")
						setShowContextMenu(false)

						// Insert the command mention into the textarea
						const commandMention = `/${value}`
						setInputValue(commandMention + " ")
						setCursorPosition(commandMention.length + 1)
						setCursorSelection({ position: commandMention.length + 1, focus: "focus" })
						return
					}

					if (
						type === ContextMenuOptionType.File ||
						type === ContextMenuOptionType.Folder ||
						type === ContextMenuOptionType.Git ||
						type === ContextMenuOptionType.Ticket
					) {
						if (!value) {
							setSelectedType(type)
							setSearchQuery("")
							setSelectedMenuIndex(0)
							if (type === ContextMenuOptionType.Ticket && textAreaRef.current) {
								const before = textAreaRef.current.value.slice(0, cursorPosition)
								const start = before.lastIndexOf("@")
								const value =
									before.slice(0, start) +
									"@ticket:" +
									textAreaRef.current.value.slice(cursorPosition)
								menuTarget.current = { value, caret: start + 8 }
								setInputValue(value)
								setCursorPosition(start + 8)
								setCursorSelection({ position: start + 8, focus: "focus" })
							}
							return
						}
					}

					setShowContextMenu(false)
					setSelectedType(null)

					if (textAreaRef.current) {
						let insertValue = value || ""

						if (type === ContextMenuOptionType.URL) {
							insertValue = value || ""
						} else if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
							insertValue = value || ""
						} else if (type === ContextMenuOptionType.Problems) {
							insertValue = "problems"
						} else if (type === ContextMenuOptionType.Terminal) {
							insertValue = "terminal"
						} else if (type === ContextMenuOptionType.Git) {
							insertValue = value || ""
						} else if (type === ContextMenuOptionType.Command) {
							insertValue = value ? `/${value}` : ""
						}

						// Determine if this is a slash command selection
						const isSlashCommand =
							type === ContextMenuOptionType.Mode || type === ContextMenuOptionType.Command

						const { newValue, mentionIndex } = insertMention(
							textAreaRef.current.value,
							cursorPosition,
							insertValue,
							isSlashCommand,
							type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder,
						)

						setInputValue(newValue)
						const newCursorPosition = newValue.indexOf(" ", mentionIndex + insertValue.length) + 1
						setCursorPosition(newCursorPosition)
						setCursorSelection({ position: newCursorPosition, focus: "refocus" })
					}
				},
				[setInputValue, cursorPosition, modeSwitchDisabled, setMode],
			)

			const togglePrimaryMode = useCallback(() => {
				const nextMode: Mode = mode === codeModeSlug ? planModeSlug : codeModeSlug
				setMode(nextMode)
				vscode.postMessage({ type: "mode", text: nextMode })
			}, [mode, setMode])

			const handleKeyDown = useCallback(
				(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
					const isComposing = event.nativeEvent?.isComposing ?? false
					if (isComposing) return
					if (showContextMenu) {
						if (event.key === "Tab" && (event.shiftKey || !hasSelectedOption)) {
							return
						}

						if (event.key === "Escape") {
							event.preventDefault()
							if (selectedType) {
								setSelectedType(null)
								setSearchQuery("")
								setSelectedMenuIndex(3) // File by default
							} else {
								setShowContextMenu(false)
								setSelectedMenuIndex(-1)
							}
							return
						}

						if (event.key === "ArrowUp" || event.key === "ArrowDown") {
							event.preventDefault()
							setSelectedMenuIndex((prevIndex) => {
								const direction = event.key === "ArrowUp" ? -1 : 1
								const options = contextMenuOptions
								const optionsLength = options.length

								if (optionsLength === 0) return prevIndex

								const selectableOptions = options.filter(isContextMenuOptionSelectable)

								if (selectableOptions.length === 0) return -1 // No selectable options

								// Find the index of the next selectable option
								const currentSelectableIndex = selectableOptions.findIndex(
									(option) => option === options[prevIndex],
								)

								const newSelectableIndex =
									(currentSelectableIndex + direction + selectableOptions.length) %
									selectableOptions.length

								// Find the index of the selected option in the original options array
								return options.findIndex((option) => option === selectableOptions[newSelectableIndex])
							})
							return
						}
						if (
							(event.key === "Enter" || event.key === "Tab") &&
							selectedMenuIndex !== -1 &&
							!(event.key === "Enter" && inputValue === `/${forkChatCommandName}` && !isEditMode)
						) {
							event.preventDefault()
							if (hasSelectedOption) {
								handleMentionSelect(selectedOption.type, selectedOption.value)
							}
							return
						}
					}

					if (
						!event.defaultPrevented &&
						!showContextMenu &&
						!modeSwitchDisabled &&
						event.key === "Tab" &&
						event.shiftKey &&
						!event.ctrlKey &&
						!event.altKey &&
						!event.metaKey &&
						!event.repeat &&
						!isComposing
					) {
						event.preventDefault()
						togglePrimaryMode()
						return
					}

					// Handle prompt history navigation using custom hook
					if (handleHistoryNavigation(event, showContextMenu, isComposing)) {
						return
					}

					// Handle Enter key based on enterBehavior setting
					if (event.key === "Enter" && !isComposing) {
						const shouldSubmit =
							(isEditMode && !event.shiftKey) ||
							(enterBehavior === "newline"
								? event.shiftKey || event.ctrlKey || event.metaKey
								: !event.shiftKey)
						if (shouldSubmit) {
							event.preventDefault()
							if (!sendDisabled) {
								setShowContextMenu(false)
								handleSend()
							}
						}
					}

					if (event.key === "Backspace" && !isComposing) {
						const charBeforeCursor = inputValue[cursorPosition - 1]
						const charAfterCursor = inputValue[cursorPosition + 1]

						const charBeforeIsWhitespace =
							charBeforeCursor === " " || charBeforeCursor === "\n" || charBeforeCursor === "\r\n"

						const charAfterIsWhitespace =
							charAfterCursor === " " || charAfterCursor === "\n" || charAfterCursor === "\r\n"

						// Checks if char before cursor is whitespace after a mention.
						if (
							charBeforeIsWhitespace &&
							// "$" is added to ensure the match occurs at the end of the string.
							inputValue.slice(0, cursorPosition - 1).match(new RegExp(mentionRegex.source + "$"))
						) {
							const newCursorPosition = cursorPosition - 1
							// If mention is followed by another word, then instead
							// of deleting the space separating them we just move
							// the cursor to the end of the mention.
							if (!charAfterIsWhitespace) {
								event.preventDefault()
								textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
								setCursorPosition(newCursorPosition)
							}

							setCursorPosition(newCursorPosition)
							setJustDeletedSpaceAfterMention(true)
						} else if (justDeletedSpaceAfterMention) {
							const { newText, newPosition } = removeMention(inputValue, cursorPosition)

							if (newText !== inputValue) {
								event.preventDefault()
								setInputValue(newText)
								setCursorSelection({ position: newPosition })
							}

							setJustDeletedSpaceAfterMention(false)
							setShowContextMenu(false)
						} else {
							setJustDeletedSpaceAfterMention(false)
						}
					}
				},
				[
					handleSend,
					showContextMenu,
					selectedMenuIndex,
					selectedOption,
					hasSelectedOption,
					handleMentionSelect,
					selectedType,
					inputValue,
					cursorPosition,
					setInputValue,
					justDeletedSpaceAfterMention,
					contextMenuOptions,
					handleHistoryNavigation,
					enterBehavior,
					isEditMode,
					modeSwitchDisabled,
					togglePrimaryMode,
					sendDisabled,
				],
			)

			useLayoutEffect(() => {
				const textarea = textAreaRef.current
				if (!cursorSelection || !textarea) return
				if (cursorSelection.focus === "refocus") textarea.blur()
				textarea.setSelectionRange(cursorSelection.position, cursorSelection.position)
				if (cursorSelection.focus) textarea.focus()
				setCursorSelection(null)
			}, [inputValue, cursorSelection])

			const fileSearch = useMemo(() => createDebounce(200), [])

			const cancelPendingFileSearch = useCallback(() => {
				fileSearch.cancel()
				pendingFileSearch.current = undefined
				setFileSearchResult(undefined)
			}, [fileSearch])

			useLayoutEffect(() => {
				// Changing task or workspace invalidates the pending mention lookup.
				return cancelPendingFileSearch
			}, [taskId, cwd, cancelPendingFileSearch])

			const handleInputChange = useCallback(
				(e: React.ChangeEvent<HTMLTextAreaElement>) => {
					const newValue = e.target.value
					pendingFileSearch.current = undefined
					setFileSearchResult(undefined)
					setInputValue(newValue)

					// Reset history navigation when user types
					resetOnInputChange()

					const newCursorPosition = e.target.selectionStart
					setCursorPosition(newCursorPosition)

					const lastAtIndex = newValue.lastIndexOf("@", newCursorPosition - 1)
					const mentionQuery = newValue.slice(lastAtIndex + 1, newCursorPosition)
					const ticketPrefix = /^tickets?:/.exec(mentionQuery)?.[0]
					const searchingTickets =
						lastAtIndex >= 0 &&
						(lastAtIndex === 0 || /\s/.test(newValue[lastAtIndex - 1])) &&
						!/[\r\n]/.test(mentionQuery) &&
						((ticketPrefix &&
							(selectedType === ContextMenuOptionType.Ticket || !mentionQuery.includes(" "))) ||
							/^[a-z]{2,4}-\d{0,10}$/i.test(mentionQuery))
					const showMenu = searchingTickets || shouldShowContextMenu(newValue, newCursorPosition)
					const target = { value: newValue, caret: newCursorPosition }
					menuTarget.current = showMenu ? target : undefined
					setShowContextMenu(showMenu)

					if (showMenu) {
						if (newValue.startsWith("/") && !newValue.includes(" ")) {
							fileSearch.cancel()
							setSelectedType(null)
							setSearchQuery(newValue)
							// Set to first selectable item (skip section headers)
							setSelectedMenuIndex(1) // Section header is at 0, first command is at 1
						} else {
							// Existing @ mention handling.
							const query =
								searchingTickets && ticketPrefix
									? mentionQuery.slice(ticketPrefix.length)
									: mentionQuery
							setSearchQuery(query)
							if (searchingTickets) {
								fileSearch.cancel()
								setSelectedType(ContextMenuOptionType.Ticket)
								setSelectedMenuIndex(0)
								return
							}
							if (selectedType === ContextMenuOptionType.Ticket) setSelectedType(null)

							// Send file search request if query is not empty.
							if (query.length > 0) {
								setSelectedMenuIndex(0)

								fileSearch.schedule(() => {
									if (menuTarget.current !== target) return
									const requestId = crypto.randomUUID()
									pendingFileSearch.current = { target, query, requestId }

									vscode.postMessage({
										type: "searchFiles",
										query: unescapeSpaces(query),
										requestId,
										...(taskId ? { taskId } : { workspaceScope: true }),
									})
								})
							} else {
								fileSearch.cancel()
								setSelectedMenuIndex(3) // Set to "File" option by default.
							}
						}
					} else {
						fileSearch.cancel()
						setSearchQuery("")
						setSelectedMenuIndex(-1)
					}
				},
				[fileSearch, setInputValue, resetOnInputChange, selectedType, taskId],
			)

			useLayoutEffect(() => {
				if (!showContextMenu || selectedType === ContextMenuOptionType.Ticket) cancelPendingFileSearch()
				if (!showContextMenu) {
					menuTarget.current = undefined
					setSelectedType(null)
				}
			}, [cancelPendingFileSearch, showContextMenu, selectedType])

			const handleBlur = useCallback(() => {
				// Only hide the context menu if the user didn't click on it.
				if (!isMouseDownOnMenuRef.current) {
					setShowContextMenu(false)
				}

				setIsFocused(false)
			}, [])

			const insertTextAtSelection = useCallback(
				(textarea: HTMLTextAreaElement, text: string, options: { addTrailingSpace?: boolean } = {}) => {
					const selectionStart = textarea.selectionStart ?? textarea.value.length
					const selectionEnd = textarea.selectionEnd ?? selectionStart
					const textAfterSelection = textarea.value.slice(selectionEnd)
					const trailingSpace = options.addTrailingSpace && !textAfterSelection.startsWith(" ") ? " " : ""
					const newValue = textarea.value.slice(0, selectionStart) + text + trailingSpace + textAfterSelection
					const newCursorPosition = selectionStart + text.length + trailingSpace.length

					setInputValue(newValue)
					setCursorPosition(newCursorPosition)
					setCursorSelection({ position: newCursorPosition, focus: "focus" })
					setShowContextMenu(false)
				},
				[setInputValue],
			)

			const getClipboardUriList = useCallback((clipboardData: DataTransfer) => {
				const uriList =
					clipboardData.getData("application/vnd.code.uri-list") ||
					clipboardData.getData("text/uri-list") ||
					clipboardData.getData("text/x-moz-url")

				return uriList
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => line && !line.startsWith("#"))
			}, [])

			const getVsCodeResourcePaths = useCallback((text: string) => {
				if (!text.includes('"fsPath"')) {
					return []
				}

				return Array.from(text.matchAll(/"fsPath"\s*:\s*"((?:\\.|[^"\\])+)"/g))
					.map((match) => {
						try {
							return JSON.parse(`"${match[1]}"`) as string
						} catch {
							return match[1].replace(/\\\\/g, "\\")
						}
					})
					.filter(Boolean)
			}, [])

			const pendingImageReadsRef = useRef(new Map<FileReader, () => void>())
			const imageReadsDisposedRef = useRef(false)
			useLayoutEffect(() => {
				const pendingImageReads = pendingImageReadsRef.current
				const batches = imageReadBatches.current
				imageReadsDisposedRef.current = false
				return () => {
					imageReadsDisposedRef.current = true
					for (const [reader, cancel] of pendingImageReads) {
						reader.onloadend = null
						if (reader.readyState === 1) reader.abort()
						cancel()
					}
					pendingImageReads.clear()
					for (const owner of batches.keys()) onImageReadsPendingChange?.(owner, false)
					batches.clear()
				}
			}, [onImageReadsPendingChange])
			const readImageFile = useCallback(
				(blob: Blob) =>
					new Promise<string | null>((resolve) => {
						const reader = new FileReader()
						pendingImageReadsRef.current.set(reader, () => resolve(null))
						reader.onloadend = () => {
							pendingImageReadsRef.current.delete(reader)
							reader.onloadend = null
							if (reader.error) {
								console.error(t("chat:errorReadingFile"), reader.error)
								resolve(null)
							} else {
								resolve(typeof reader.result === "string" ? reader.result : null)
							}
						}
						try {
							reader.readAsDataURL(blob)
						} catch (error) {
							pendingImageReadsRef.current.delete(reader)
							reader.onloadend = null
							console.error(t("chat:errorReadingFile"), error)
							resolve(null)
						}
					}),
				[t],
			)

			const appendImages = useCallback(
				async (files: File[]) => {
					const owner = conversationTaskId
					const batches = imageReadBatches.current
					const existing = batches.get(owner)
					const batch = existing ?? { pending: 0 }
					batch.pending++
					if (!existing) {
						batches.set(owner, batch)
						publishImageReads(owner, true)
					}
					try {
						const images = await Promise.all(files.map(readImageFile))
						if (imageReadsDisposedRef.current || batches.get(owner) !== batch) return
						const dataUrls = images.filter((image): image is string => image !== null)
						if (!dataUrls.length) {
							console.warn(t("chat:noValidImages"))
							return
						}
						setSelectedImages((previous) => [...previous, ...dataUrls].slice(0, MAX_IMAGES_PER_MESSAGE))
					} finally {
						batch.pending--
						if (batch.pending === 0 && batches.get(owner) === batch) {
							batches.delete(owner)
							publishImageReads(owner, false)
						}
					}
				},
				[conversationTaskId, publishImageReads, readImageFile, setSelectedImages, t],
			)

			const handlePaste = useCallback(
				(e: React.ClipboardEvent) => {
					const items = e.clipboardData.items

					const uriList = getClipboardUriList(e.clipboardData)
					if (uriList.length > 0) {
						e.preventDefault()
						const mentionText = uriList.map((uri) => convertToMentionPath(uri, cwd)).join(" ")
						insertTextAtSelection(e.currentTarget as HTMLTextAreaElement, mentionText, {
							addTrailingSpace: true,
						})
						return
					}

					const pastedText = e.clipboardData.getData("text")
					const resourcePaths = getVsCodeResourcePaths(pastedText)
					if (resourcePaths.length > 0) {
						e.preventDefault()
						const mentionText = resourcePaths.map((path) => convertToMentionPath(path, cwd)).join(" ")
						insertTextAtSelection(e.currentTarget as HTMLTextAreaElement, mentionText, {
							addTrailingSpace: true,
						})
						return
					}

					// Check if the pasted content is a URL, add space after so user
					// can easily delete if they don't want it.
					const urlRegex = /^\S+:\/\/\S+$/
					if (urlRegex.test(pastedText.trim())) {
						e.preventDefault()
						insertTextAtSelection(e.currentTarget as HTMLTextAreaElement, pastedText.trim(), {
							addTrailingSpace: true,
						})
						return
					}

					const acceptedTypes = ["png", "jpeg", "webp"]

					const imageItems = Array.from(items).filter((item) => {
						const [type, subtype] = item.type.split("/")
						return type === "image" && acceptedTypes.includes(subtype)
					})

					if (!shouldDisableImages && imageItems.length > 0) {
						e.preventDefault()

						const files = imageItems.map((item) => item.getAsFile()).filter((file) => file !== null)
						void appendImages(files).catch((error) => console.error(t("chat:errorReadingFile"), error))
					}
				},
				[
					cwd,
					getClipboardUriList,
					getVsCodeResourcePaths,
					insertTextAtSelection,
					shouldDisableImages,
					appendImages,
					t,
				],
			)

			const handleMenuMouseDown = useCallback(() => {
				isMouseDownOnMenuRef.current = true
			}, [])

			const handleMenuMouseUp = useCallback(() => {
				isMouseDownOnMenuRef.current = false
			}, [])

			const syncHighlightScroll = useCallback(() => {
				if (!textAreaRef.current || !highlightLayerRef.current) return
				highlightLayerRef.current.scrollTop = textAreaRef.current.scrollTop
				highlightLayerRef.current.scrollLeft = textAreaRef.current.scrollLeft
			}, [])

			const updateHighlights = useCallback(() => {
				if (!textAreaRef.current || !highlightLayerRef.current) return

				const text = textAreaRef.current.value

				// Helper function to check if a command is valid
				const isValidCommand = (commandName: string): boolean => {
					return commands?.some((cmd) => cmd.name === commandName) || false
				}

				// Process the text to highlight mentions and valid commands
				let processedText = text
					.replace(/\n$/, "\n\n")
					.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c)
					.replace(mentionRegexGlobal, '<mark class="mention-context-textarea-highlight">$&</mark>')

				// Custom replacement for commands - only highlight valid ones
				processedText = processedText.replace(commandRegexGlobal, (match, commandName) => {
					// Only highlight if the command exists in the valid commands list
					if (isValidCommand(commandName)) {
						// Check if the match starts with a space
						const startsWithSpace = match.startsWith(" ")
						const commandPart = `/${commandName}`

						if (startsWithSpace) {
							// Keep the space but only highlight the command part
							return ` <mark class="mention-context-textarea-highlight">${commandPart}</mark>`
						} else {
							// Highlight the entire command (starts at beginning of line)
							return `<mark class="mention-context-textarea-highlight">${commandPart}</mark>`
						}
					}
					return match // Return unhighlighted if command is not valid
				})

				highlightLayerRef.current.innerHTML = processedText

				syncHighlightScroll()
			}, [commands, syncHighlightScroll])

			useLayoutEffect(() => {
				updateHighlights()
			}, [inputValue, updateHighlights])

			const updateCursorPosition = useCallback(() => {
				const textarea = textAreaRef.current
				if (!textarea) return
				const { selectionStart, selectionEnd } = textarea
				setCursorPosition(selectionStart)
				if (
					menuTarget.current &&
					(selectionStart !== menuTarget.current.caret || selectionStart !== selectionEnd)
				) {
					menuTarget.current = undefined
					setShowContextMenu(false)
				}
			}, [])

			const handleKeyUp = useCallback(
				(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
					if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
						updateCursorPosition()
					}
				},
				[updateCursorPosition],
			)

			const handleDrop = useCallback(
				(e: React.DragEvent<HTMLDivElement>) => {
					e.preventDefault()
					setIsDraggingOver(false)

					const textFieldList = e.dataTransfer.getData("text")
					const textUriList = e.dataTransfer.getData("application/vnd.code.uri-list")
					// When textFieldList is empty, it may attempt to use textUriList obtained from drag-and-drop tabs; if not empty, it will use textFieldList.
					const text = textFieldList || textUriList
					if (text) {
						// Split text on newlines to handle multiple files
						const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "")

						if (lines.length > 0) {
							// Process each line as a separate file path
							let newValue = inputValue.slice(0, cursorPosition)
							let totalLength = 0

							// Using a standard for loop instead of forEach for potential performance gains.
							for (let i = 0; i < lines.length; i++) {
								const line = lines[i]
								// Convert each path to a mention-friendly format
								const mentionText = convertToMentionPath(line, cwd)
								newValue += mentionText
								totalLength += mentionText.length

								// Add space after each mention except the last one
								if (i < lines.length - 1) {
									newValue += " "
									totalLength += 1
								}
							}

							// Add space after the last mention and append the rest of the input
							newValue += " " + inputValue.slice(cursorPosition)
							totalLength += 1

							setInputValue(newValue)
							const newCursorPosition = cursorPosition + totalLength
							setCursorPosition(newCursorPosition)
							setCursorSelection({ position: newCursorPosition })
						}

						return
					}

					const files = Array.from(e.dataTransfer.files)

					if (files.length > 0) {
						const acceptedTypes = ["png", "jpeg", "webp"]

						const imageFiles = files.filter((file) => {
							const [type, subtype] = file.type.split("/")
							return type === "image" && acceptedTypes.includes(subtype)
						})

						if (!shouldDisableImages && imageFiles.length > 0) {
							void appendImages(imageFiles).catch((error) =>
								console.error(t("chat:errorReadingFile"), error),
							)
						}
					}
				},
				[
					cursorPosition,
					cwd,
					inputValue,
					setInputValue,
					setCursorPosition,
					shouldDisableImages,
					appendImages,
					t,
				],
			)

			// Helper function to handle API config change
			const handleApiConfigChange = useCallback((value: string) => {
				setReasoningProfileLoading(true)
				vscode.postMessage({ type: "loadApiConfigurationById", text: value })
			}, [])

			return (
				<div
					className={cn(
						"chat-composer-shell box-border flex flex-col outline-none",
						isEditMode || isNewTask ? "w-full" : "mx-auto w-[calc(100%-24px)]",
					)}>
					<div
						className={cn(
							"chat-composer relative w-full rounded-2xl border border-transparent p-2",
							isNewTask && "new-task-composer",
							isEditMode && "chat-composer-edit",
						)}>
						{!isEditMode && contextControl && <div className="chat-composer-context">{contextControl}</div>}
						<div className={cn(!isEditMode && "relative")}>
							<div
								className={cn(
									"chat-text-area",
									!isEditMode && "relative",
									"flex",
									"flex-col",
									"outline-none",
								)}
								onDrop={handleDrop}
								onDragOver={(e) => {
									// Only allowed to drop images/files on shift key pressed.
									if (!e.shiftKey) {
										setIsDraggingOver(false)
										return
									}

									e.preventDefault()
									setIsDraggingOver(true)
									e.dataTransfer.dropEffect = "copy"
								}}
								onDragLeave={(e) => {
									e.preventDefault()
									const rect = e.currentTarget.getBoundingClientRect()

									if (
										e.clientX <= rect.left ||
										e.clientX >= rect.right ||
										e.clientY <= rect.top ||
										e.clientY >= rect.bottom
									) {
										setIsDraggingOver(false)
									}
								}}>
								{showContextMenu && (
									<div
										ref={contextMenuContainerRef}
										className={cn(
											"absolute",
											"bottom-full",
											isEditMode ? "left-6" : "left-0",
											"right-0",
											"z-[1000]",
											isEditMode ? "-mb-3" : "mb-2",
											"filter",
											"drop-shadow-md",
										)}>
										<ContextMenu
											id={contextMenuId}
											onSelect={handleMentionSelect}
											searchQuery={searchQuery}
											onMouseDown={handleMenuMouseDown}
											onMouseUp={handleMenuMouseUp}
											selectedIndex={hasSelectedOption ? selectedMenuIndex : -1}
											setSelectedIndex={setSelectedMenuIndex}
											options={contextMenuOptions}
										/>
									</div>
								)}

								<div
									className={cn(
										"relative",
										"flex-1",
										"flex",
										"flex-col-reverse",
										"min-h-0",
										isNewTask ? "overflow-visible" : "overflow-hidden",
										// The outer composer owns rounding; text scrolls through a square viewport.
										"rounded-none",
									)}>
									<div
										ref={highlightLayerRef}
										data-testid="highlight-layer"
										aria-hidden="true"
										className={cn(
											"absolute",
											"inset-0",
											"pointer-events-none",
											"whitespace-pre-wrap",
											"break-words",
											"text-transparent",
											"overflow-hidden",
											"font-vscode-font-family",
											"chat-composer-text",
											isFocused
												? "border border-transparent"
												: isDraggingOver
													? "border-2 border-dashed border-vscode-focusBorder"
													: "border border-transparent",
											"px-0 py-1",
											"pr-0",
											"z-10",
											"forced-color-adjust-none",
											"rounded-none",
										)}
										style={{
											color: "transparent",
										}}
									/>
									<DynamicTextArea
										ref={setTextAreaRef}
										value={inputValue}
										aria-label={placeholderText}
										aria-keyshortcuts={modeSwitchDisabled ? undefined : "Shift+Tab"}
										aria-autocomplete="list"
										aria-controls={showContextMenu ? contextMenuId : undefined}
										aria-expanded={showContextMenu}
										aria-activedescendant={
											showContextMenu && hasSelectedOption
												? `${contextMenuId}-option-${selectedMenuIndex}`
												: undefined
										}
										onChange={handleInputChange}
										onFocus={() => setIsFocused(true)}
										onKeyDown={(e) => {
											// Handle ESC to cancel in edit mode
											if (isEditMode && e.key === "Escape" && !e.nativeEvent?.isComposing) {
												e.preventDefault()
												handleCancelEdit()
												return
											}
											handleKeyDown(e)
										}}
										onKeyUp={handleKeyUp}
										onBlur={handleBlur}
										onPaste={handlePaste}
										onSelect={updateCursorPosition}
										onMouseUp={updateCursorPosition}
										onHeightChange={(height) => {
											if (textAreaBaseHeight === undefined || height < textAreaBaseHeight) {
												setTextAreaBaseHeight(height)
											}

											onHeightChange?.(height)
										}}
										placeholder={placeholderText}
										minRows={3}
										maxRows={15}
										autoFocus={true}
										className={cn(
											"w-full",
											"text-[var(--chat-foreground)]",
											"font-vscode-font-family",
											"chat-composer-text",
											"cursor-text",
											"px-0 py-1",
											isFocused
												? "border border-transparent focus:outline-0 focus-visible:ring-0"
												: isDraggingOver
													? "border-2 border-dashed border-vscode-focusBorder"
													: "border border-transparent",
											isDraggingOver
												? "bg-[color-mix(in_srgb,var(--vscode-input-background)_95%,var(--vscode-focusBorder))]"
												: "bg-transparent",
											"transition-background-color duration-150 ease-in-out",
											"will-change-background-color",
											"min-h-[94px]",
											"box-border",
											"rounded-none",
											"resize-none",
											"overflow-x-hidden",
											"overflow-y-auto",
											"pr-0",
											"flex-none flex-grow",
											"z-[2]",
											"scrollbar-none",
											"scrollbar-hide",
										)}
										onScroll={syncHighlightScroll}
									/>
								</div>
							</div>
						</div>

						{selectedImages.length > 0 && (
							<Thumbnails
								images={selectedImages}
								setImages={setSelectedImages}
								style={{
									left: "16px",
									zIndex: 2,
									marginBottom: 0,
								}}
							/>
						)}

						<div className="chat-composer-footer">
							<div className="chat-composer-settings" aria-label={t("chat:composer.settings")}>
								<ApiConfigSelector
									isVisible={isVisible}
									value={currentConfigId}
									displayName={displayName}
									disabled={selectApiConfigDisabled}
									title={t("chat:selectApiConfig")}
									onChange={handleApiConfigChange}
									triggerClassName="chat-composer-profile"
									listApiConfigMeta={listApiConfigMeta || []}
									pinnedApiConfigs={pinnedApiConfigs}
									togglePinnedApiConfig={togglePinnedApiConfig}
								/>
								<ChatReasoningControl
									isVisible={isVisible}
									profileLoading={reasoningProfileLoading}
									isDraft={isTaskDraft || isNewTask}
								/>
								<AutoApproveDropdown
									isVisible={isVisible && !isEditMode}
									isDraft={isTaskDraft}
									draftApprovalMode={draftApprovalMode}
									onDraftApprovalModeChange={onDraftApprovalModeChange}
									triggerClassName="chat-composer-approval"
								/>
								{restoreTaskMode(mode) === planModeSlug && (
									<StandardTooltip
										className="lowercase"
										content={t("chat:composer.planModeTooltip", { shortcut: modeShortcutText })}>
										<span
											className="chat-composer-plan"
											data-testid="plan-mode-badge"
											role="status">
											{t("chat:composer.planMode")}
										</span>
									</StandardTooltip>
								)}
							</div>
							<div className="chat-composer-actions">
								{isEditMode && (
									<StandardTooltip content={t("chat:cancel.title")}>
										<button
											aria-label={t("chat:cancel.title")}
											disabled={false}
											onClick={handleCancelEdit}
											className={cn(
												"relative inline-flex items-center justify-center",
												"bg-transparent border-none p-1.5",
												"rounded-md min-w-[28px] min-h-[28px]",
												"opacity-60 hover:opacity-100 text-vscode-descriptionForeground hover:text-vscode-foreground",
												"transition-all duration-150",
												"hover:bg-vscode-toolbar-hoverBackground active:scale-95",
												"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
												"cursor-pointer",
											)}>
											<X className="w-4 h-4" />
										</button>
									</StandardTooltip>
								)}
								{/* Auto-steer keeps an explicit queue action beside the primary submission. */}
								{!isEditMode &&
									!isForkCommand &&
									isStreaming &&
									autoSteer &&
									hasInputContent &&
									onEnqueueMessage && (
										<StandardTooltip
											content={
												imagesLoading ? t("chat:loadingAttachments") : t("chat:enqueueMessage")
											}>
											<button
												aria-label={t("chat:enqueueMessage")}
												disabled={enqueueDisabled || imagesLoading}
												onClick={
													enqueueDisabled || imagesLoading ? undefined : onEnqueueMessage
												}
												className={cn(
													"relative inline-flex items-center justify-center",
													"bg-transparent border-none p-1.5",
													"rounded-md min-w-[28px] min-h-[28px]",
													"text-vscode-descriptionForeground hover:text-vscode-foreground",
													"transition-all duration-200",
													"opacity-100 hover:opacity-100 pointer-events-auto",
													"hover:bg-vscode-toolbar-hoverBackground active:scale-95",
													"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
													"cursor-pointer",
												)}>
												<ListEnd className="w-4 h-4" />
											</button>
										</StandardTooltip>
									)}
								{isStreaming && !isEditMode && hasInputContent && (
									<StandardTooltip content={t("chat:stop.title")}>
										<button
											type="button"
											aria-label={t("chat:stop.title")}
											onClick={handleStop}
											className="composer-control chat-composer-icon">
											<Square aria-hidden="true" className="size-4 stroke-none fill-current" />
										</button>
									</StandardTooltip>
								)}
								{/* Keep the primary action in place as empty Send becomes ready Send or Stop. */}
								<StandardTooltip
									content={
										imagesLoading && !isStopAction ? t("chat:loadingAttachments") : sendActionLabel
									}>
									<button
										aria-label={sendActionLabel}
										disabled={sendDisabled}
										onClick={sendDisabled ? undefined : isStopAction ? handleStop : handleSend}
										className={cn(
											"relative inline-flex items-center justify-center",
											"border-none p-1.5",
											"rounded-full min-w-[28px] min-h-[28px]",
											"transition-[color,background-color,opacity,transform] duration-150",
											"pointer-events-auto",
											sendDisabled
												? "cursor-default bg-vscode-button-secondaryBackground text-vscode-descriptionForeground opacity-50"
												: "cursor-pointer bg-[var(--control-primary-background)] text-[var(--control-primary-foreground)] opacity-100 hover:opacity-90",
											"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
										)}>
										{isStopAction ? (
											<Square className="size-4 stroke-none fill-current" />
										) : (
											<SendHorizontal className="size-4" />
										)}
									</button>
								</StandardTooltip>
							</div>
						</div>
					</div>
					{!isEditMode && (
						<div className="chat-composer-utility">
							<span className="chat-composer-help">
								{enterBehavior === "newline"
									? t("chat:composer.helpSend", { keyCombination: sendKeyCombination })
									: t("chat:composer.help")}
							</span>
							<IndexingStatusBadge />
						</div>
					)}
				</div>
			)
		},
	),
)
ChatTextArea.displayName = "ChatTextArea"
