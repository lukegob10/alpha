import React, { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useEvent } from "react-use"
import DynamicTextArea from "react-textarea-autosize"
import { VolumeX, Image, WandSparkles, SendHorizontal, X, ListEnd, Square } from "lucide-react"

import type { ExtensionMessage } from "@alpha-code/types"

import { mentionRegex, mentionRegexGlobal, commandRegexGlobal, unescapeSpaces } from "@alpha/context-mentions"
import { WebviewMessage } from "@alpha/WebviewMessage"
import { Mode, codeModeSlug, getAllModes, planModeSlug } from "@alpha/modes"

import { vscode } from "@src/utils/vscode"
import { getUserFacingModeOptions } from "@src/utils/modePresentation"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	ContextMenuOptionType,
	getContextMenuOptions,
	insertMention,
	removeMention,
	shouldShowContextMenu,
	SearchResult,
} from "@src/utils/context-mentions"
import { cn } from "@src/lib/utils"
import { convertToMentionPath } from "@src/utils/path-mentions"
import { StandardTooltip } from "@src/components/ui"

import Thumbnails from "../common/Thumbnails"
import { ModeSelector } from "./ModeSelector"
import { ApiConfigSelector } from "./ApiConfigSelector"
import { AutoApproveDropdown } from "./AutoApproveDropdown"
import { MAX_IMAGES_PER_MESSAGE } from "./ChatView"
import ContextMenu from "./ContextMenu"
import { IndexingStatusBadge } from "./IndexingStatusBadge"
import { usePromptHistory } from "./hooks/usePromptHistory"

interface ChatTextAreaProps {
	inputValue: string
	setInputValue: (value: string) => void
	sendingDisabled: boolean
	selectApiConfigDisabled: boolean
	placeholderText: string
	selectedImages: string[]
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
	onSend: () => void
	onSelectImages: () => void
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
}

export const ChatTextArea = forwardRef<HTMLTextAreaElement, ChatTextAreaProps>(
	(
		{
			inputValue,
			setInputValue,
			sendingDisabled,
			selectApiConfigDisabled,
			placeholderText,
			selectedImages,
			setSelectedImages,
			onSend,
			onSelectImages,
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
		},
		ref,
	) => {
		const { t } = useAppTranslation()
		const {
			filePaths,
			openedTabs,
			currentApiConfigName,
			listApiConfigMeta,
			customModes,
			customModePrompts,
			cwd,
			pinnedApiConfigs,
			togglePinnedApiConfig,
			taskHistory,
			clineMessages,
			commands,
			enterBehavior,
		} = useExtensionState()

		// Find the ID and display text for the currently selected API configuration.
		const { currentConfigId, displayName } = useMemo(() => {
			const currentConfig = listApiConfigMeta?.find((config) => config.name === currentApiConfigName)
			return {
				currentConfigId: currentConfig?.id || "",
				displayName: currentApiConfigName || "", // Use the name directly for display.
			}
		}, [listApiConfigMeta, currentApiConfigName])

		const [gitCommits, setGitCommits] = useState<any[]>([])
		const [showDropdown, setShowDropdown] = useState(false)
		const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([])
		const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false)
		const searchRequestIdRef = useRef("")

		// Close dropdown when clicking outside.
		useEffect(() => {
			const handleClickOutside = () => {
				if (showDropdown) {
					setShowDropdown(false)
				}
			}

			document.addEventListener("mousedown", handleClickOutside)
			return () => document.removeEventListener("mousedown", handleClickOutside)
		}, [showDropdown])

		// Handle enhanced prompt response and search results.
		useEffect(() => {
			const messageHandler = (event: MessageEvent) => {
				const message = event.data

				if (message.type === "enhancedPrompt" && isEnhancingPrompt) {
					if (message.text && textAreaRef.current) {
						try {
							// Use execCommand to replace text while preserving undo history
							if (document.execCommand) {
								// Use native browser methods to preserve undo stack
								const textarea = textAreaRef.current

								// Focus the textarea to ensure it's the active element
								textarea.focus()

								// Select all text first
								textarea.select()
								document.execCommand("insertText", false, message.text)
							} else {
								setInputValue(message.text)
							}
						} catch {
							setInputValue(message.text)
						}
					}

					setIsEnhancingPrompt(false)
				} else if (message.type === "insertTextIntoTextarea") {
					if (message.text && textAreaRef.current) {
						// Insert the command text at the current cursor position
						const textarea = textAreaRef.current
						const currentValue = inputValue
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
						setTimeout(() => {
							if (textAreaRef.current) {
								textAreaRef.current.focus()
								textAreaRef.current.setSelectionRange(newCursorPos, newCursorPos)
							}
						}, 0)
					}
				} else if (message.type === "commitSearchResults") {
					const commits = message.commits.map((commit: any) => ({
						type: ContextMenuOptionType.Git,
						value: commit.hash,
						label: commit.subject,
						description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
						icon: "$(git-commit)",
					}))

					setGitCommits(commits)
				} else if (message.type === "fileSearchResults") {
					if (message.requestId === searchRequestIdRef.current) {
						setFileSearchResults(message.results || [])
					}
				}
			}

			window.addEventListener("message", messageHandler)
			return () => window.removeEventListener("message", messageHandler)
		}, [setInputValue, inputValue, isEnhancingPrompt])

		const [isDraggingOver, setIsDraggingOver] = useState(false)
		const [textAreaBaseHeight, setTextAreaBaseHeight] = useState<number | undefined>(undefined)
		const [showContextMenu, setShowContextMenu] = useState(false)
		const [cursorPosition, setCursorPosition] = useState(0)
		const [searchQuery, setSearchQuery] = useState("")
		const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
		const isMouseDownOnMenuRef = useRef(false)
		const highlightLayerRef = useRef<HTMLDivElement>(null)
		const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
		const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
		const [justDeletedSpaceAfterMention, setJustDeletedSpaceAfterMention] = useState(false)
		const [intendedCursorPosition, setIntendedCursorPosition] = useState<number | null>(null)
		const contextMenuContainerRef = useRef<HTMLDivElement>(null)
		const contextMenuId = useId()
		const [isFocused, setIsFocused] = useState(false)

		// Use custom hook for prompt history navigation
		const { handleHistoryNavigation, resetHistoryNavigation, resetOnInputChange } = usePromptHistory({
			clineMessages,
			taskHistory,
			cwd,
			inputValue,
			setInputValue,
		})

		// Fetch git commits when Git is selected or when typing a hash.
		useEffect(() => {
			if (selectedType === ContextMenuOptionType.Git || /^[a-f0-9]+$/i.test(searchQuery)) {
				const message: WebviewMessage = {
					type: "searchCommits",
					query: searchQuery || "",
				} as const
				vscode.postMessage(message)
			}
		}, [selectedType, searchQuery])

		const handleEnhancePrompt = useCallback(() => {
			if (isEnhancingPrompt) {
				return
			}

			const trimmedInput = inputValue.trim()

			if (trimmedInput) {
				setIsEnhancingPrompt(true)
				vscode.postMessage({ type: "enhancePrompt" as const, text: trimmedInput })
			} else {
				setInputValue(t("chat:enhancePromptDescription"))
			}
		}, [inputValue, isEnhancingPrompt, setInputValue, t])

		const allModes = useMemo(() => getUserFacingModeOptions(getAllModes(customModes), mode), [customModes, mode])
		const modeSwitchDisabled = isStreaming || isEditMode
		const contextMenuModes = useMemo(() => (modeSwitchDisabled ? [] : allModes), [allModes, modeSwitchDisabled])

		// Memoized check for whether the input has content (text or images)
		const hasInputContent = useMemo(() => {
			return inputValue.trim().length > 0 || selectedImages.length > 0
		}, [inputValue, selectedImages])
		const sendDisabled = sendingDisabled && !isStreaming && !isEditMode

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

		const queryItems = useMemo(() => {
			return [
				{ type: ContextMenuOptionType.Problems, value: "problems" },
				{ type: ContextMenuOptionType.Terminal, value: "terminal" },
				...gitCommits,
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

		const contextMenuOptions = useMemo(
			() =>
				getContextMenuOptions(
					searchQuery,
					selectedType,
					queryItems,
					fileSearchResults,
					contextMenuModes,
					commands,
				),
			[searchQuery, selectedType, queryItems, fileSearchResults, contextMenuModes, commands],
		)

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
					setIntendedCursorPosition(commandMention.length + 1)

					// Focus the textarea
					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.focus()
						}
					}, 0)
					return
				}

				if (
					type === ContextMenuOptionType.File ||
					type === ContextMenuOptionType.Folder ||
					type === ContextMenuOptionType.Git
				) {
					if (!value) {
						setSelectedType(type)
						setSearchQuery("")
						setSelectedMenuIndex(0)
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
					const isSlashCommand = type === ContextMenuOptionType.Mode || type === ContextMenuOptionType.Command

					const { newValue, mentionIndex } = insertMention(
						textAreaRef.current.value,
						cursorPosition,
						insertValue,
						isSlashCommand,
					)

					setInputValue(newValue)
					const newCursorPosition = newValue.indexOf(" ", mentionIndex + insertValue.length) + 1
					setCursorPosition(newCursorPosition)
					setIntendedCursorPosition(newCursorPosition)

					// Scroll to cursor.
					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.blur()
							textAreaRef.current.focus()
						}
					}, 0)
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
				if (showContextMenu) {
					if (event.key === "Tab" && event.shiftKey) {
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

							// Find selectable options (non-URL types)
							const selectableOptions = options.filter(
								(option) =>
									option.type !== ContextMenuOptionType.URL &&
									option.type !== ContextMenuOptionType.NoResults &&
									option.type !== ContextMenuOptionType.SectionHeader,
							)

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
					if ((event.key === "Enter" || event.key === "Tab") && selectedMenuIndex !== -1) {
						event.preventDefault()
						const selectedOption = contextMenuOptions[selectedMenuIndex]
						if (
							selectedOption &&
							selectedOption.type !== ContextMenuOptionType.URL &&
							selectedOption.type !== ContextMenuOptionType.NoResults &&
							selectedOption.type !== ContextMenuOptionType.SectionHeader
						) {
							handleMentionSelect(selectedOption.type, selectedOption.value)
						}
						return
					}
				}

				const isComposing = event.nativeEvent?.isComposing ?? false
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
					if (sendDisabled) {
						event.preventDefault()
						return
					}
					if (isEditMode && !event.shiftKey) {
						event.preventDefault()
						resetHistoryNavigation()
						onSend()
						return
					}

					if (enterBehavior === "newline") {
						// New behavior: Enter = newline, Shift+Enter or Ctrl+Enter = send
						if (event.shiftKey || event.ctrlKey || event.metaKey) {
							event.preventDefault()
							resetHistoryNavigation()
							onSend()
						}
						// Otherwise, let Enter create newline (don't preventDefault)
					} else {
						// Default behavior: Enter = send, Shift+Enter = newline
						if (!event.shiftKey) {
							event.preventDefault()
							resetHistoryNavigation()
							onSend()
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
							setIntendedCursorPosition(newPosition) // Store the new cursor position in state
						}

						setJustDeletedSpaceAfterMention(false)
						setShowContextMenu(false)
					} else {
						setJustDeletedSpaceAfterMention(false)
					}
				}
			},
			[
				onSend,
				showContextMenu,
				selectedMenuIndex,
				handleMentionSelect,
				selectedType,
				inputValue,
				cursorPosition,
				setInputValue,
				justDeletedSpaceAfterMention,
				contextMenuOptions,
				handleHistoryNavigation,
				resetHistoryNavigation,
				enterBehavior,
				isEditMode,
				modeSwitchDisabled,
				togglePrimaryMode,
				sendDisabled,
			],
		)

		useLayoutEffect(() => {
			if (intendedCursorPosition !== null && textAreaRef.current) {
				textAreaRef.current.setSelectionRange(intendedCursorPosition, intendedCursorPosition)
				setIntendedCursorPosition(null) // Reset the state.
			}
		}, [inputValue, intendedCursorPosition])

		// Ref to store the search timeout.
		const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

		const cancelPendingFileSearch = useCallback(() => {
			if (searchTimeoutRef.current) {
				clearTimeout(searchTimeoutRef.current)
				searchTimeoutRef.current = null
			}
			searchRequestIdRef.current = ""
		}, [])

		useEffect(() => {
			return () => cancelPendingFileSearch()
		}, [cancelPendingFileSearch])

		const handleInputChange = useCallback(
			(e: React.ChangeEvent<HTMLTextAreaElement>) => {
				const newValue = e.target.value
				cancelPendingFileSearch()
				setInputValue(newValue)

				// Reset history navigation when user types
				resetOnInputChange()

				const newCursorPosition = e.target.selectionStart
				setCursorPosition(newCursorPosition)

				const showMenu = shouldShowContextMenu(newValue, newCursorPosition)
				setShowContextMenu(showMenu)

				if (showMenu) {
					if (newValue.startsWith("/") && !newValue.includes(" ")) {
						// Handle slash command - request fresh commands
						const query = newValue
						setSearchQuery(query)
						// Set to first selectable item (skip section headers)
						setSelectedMenuIndex(1) // Section header is at 0, first command is at 1
						// Request commands fresh each time slash menu is shown
						vscode.postMessage({ type: "requestCommands" })
					} else {
						// Existing @ mention handling.
						const lastAtIndex = newValue.lastIndexOf("@", newCursorPosition - 1)
						const query = newValue.slice(lastAtIndex + 1, newCursorPosition)
						setSearchQuery(query)

						// Send file search request if query is not empty.
						if (query.length > 0) {
							setSelectedMenuIndex(0)

							// Don't clear results until we have new ones. This
							// prevents flickering.

							// Set a timeout to debounce the search requests.
							searchTimeoutRef.current = setTimeout(() => {
								// Generate a request ID for this search.
								const reqId = Math.random().toString(36).substring(2, 9)
								searchTimeoutRef.current = null
								searchRequestIdRef.current = reqId

								// Send message to extension to search files.
								vscode.postMessage({
									type: "searchFiles",
									query: unescapeSpaces(query),
									requestId: reqId,
								})
							}, 200) // 200ms debounce.
						} else {
							setSelectedMenuIndex(3) // Set to "File" option by default.
						}
					}
				} else {
					setSearchQuery("")
					setSelectedMenuIndex(-1)
					setFileSearchResults([]) // Clear file search results.
				}
			},
			[cancelPendingFileSearch, setInputValue, setFileSearchResults, resetOnInputChange],
		)

		useEffect(() => {
			if (!showContextMenu) {
				cancelPendingFileSearch()
				setSelectedType(null)
			}
		}, [cancelPendingFileSearch, showContextMenu])

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
				setIntendedCursorPosition(newCursorPosition)
				setShowContextMenu(false)

				setTimeout(() => {
					if (textAreaRef.current) {
						textAreaRef.current.focus()
						textAreaRef.current.setSelectionRange(newCursorPosition, newCursorPosition)
					}
				}, 0)
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

		const handlePaste = useCallback(
			async (e: React.ClipboardEvent) => {
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

					const imagePromises = imageItems.map((item) => {
						return new Promise<string | null>((resolve) => {
							const blob = item.getAsFile()

							if (!blob) {
								resolve(null)
								return
							}

							const reader = new FileReader()

							reader.onloadend = () => {
								if (reader.error) {
									console.error(t("chat:errorReadingFile"), reader.error)
									resolve(null)
								} else {
									const result = reader.result
									resolve(typeof result === "string" ? result : null)
								}
							}

							reader.readAsDataURL(blob)
						})
					})

					const imageDataArray = await Promise.all(imagePromises)
					const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)

					if (dataUrls.length > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...dataUrls].slice(0, MAX_IMAGES_PER_MESSAGE))
					} else {
						console.warn(t("chat:noValidImages"))
					}
				}
			},
			[
				cwd,
				getClipboardUriList,
				getVsCodeResourcePaths,
				insertTextAtSelection,
				shouldDisableImages,
				setSelectedImages,
				t,
			],
		)

		const handleMenuMouseDown = useCallback(() => {
			isMouseDownOnMenuRef.current = true
		}, [])

		const handleMenuMouseUp = useCallback(() => {
			isMouseDownOnMenuRef.current = false
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

			highlightLayerRef.current.scrollTop = textAreaRef.current.scrollTop
			highlightLayerRef.current.scrollLeft = textAreaRef.current.scrollLeft
		}, [commands])

		useLayoutEffect(() => {
			updateHighlights()
		}, [inputValue, updateHighlights])

		const updateCursorPosition = useCallback(() => {
			if (textAreaRef.current) {
				setCursorPosition(textAreaRef.current.selectionStart)
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
			async (e: React.DragEvent<HTMLDivElement>) => {
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
						setIntendedCursorPosition(newCursorPosition)
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
						const imagePromises = imageFiles.map((file) => {
							return new Promise<string | null>((resolve) => {
								const reader = new FileReader()

								reader.onloadend = () => {
									if (reader.error) {
										console.error(t("chat:errorReadingFile"), reader.error)
										resolve(null)
									} else {
										const result = reader.result
										resolve(typeof result === "string" ? result : null)
									}
								}

								reader.readAsDataURL(file)
							})
						})

						const imageDataArray = await Promise.all(imagePromises)
						const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)

						if (dataUrls.length > 0) {
							setSelectedImages((prevImages) =>
								[...prevImages, ...dataUrls].slice(0, MAX_IMAGES_PER_MESSAGE),
							)

							if (typeof vscode !== "undefined") {
								vscode.postMessage({ type: "draggedImages", dataUrls: dataUrls })
							}
						} else {
							console.warn(t("chat:noValidImages"))
						}
					}
				}
			},
			[
				cursorPosition,
				cwd,
				inputValue,
				setInputValue,
				setCursorPosition,
				setIntendedCursorPosition,
				shouldDisableImages,
				setSelectedImages,
				t,
			],
		)

		const [isTtsPlaying, setIsTtsPlaying] = useState(false)

		useEvent("message", (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "ttsStart") {
				setIsTtsPlaying(true)
			} else if (message.type === "ttsStop") {
				setIsTtsPlaying(false)
			}
		})

		const placeholderBottomText = `\n(${t("chat:addContext")}${shouldDisableImages ? `, ${t("chat:dragFiles")}` : `, ${t("chat:dragFilesImages")}`})`

		// Common mode selector handler
		const handleModeChange = useCallback(
			(value: Mode) => {
				setMode(value)
				vscode.postMessage({ type: "mode", text: value })
			},
			[setMode],
		)

		// Helper function to handle API config change
		const handleApiConfigChange = useCallback((value: string) => {
			vscode.postMessage({ type: "loadApiConfigurationById", text: value })
		}, [])

		return (
			<div
				className={cn(
					"box-border flex flex-col gap-1 outline-none",
					isEditMode ? "w-full p-2" : "surface-raised relative mx-auto w-[calc(100%-16px)] rounded-2xl p-1.5",
				)}>
				<div className={cn(!isEditMode && "relative")}>
					<div
						className={cn("chat-text-area", !isEditMode && "relative", "flex", "flex-col", "outline-none")}
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
									selectedIndex={selectedMenuIndex}
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
								"overflow-hidden",
								"rounded-xl",
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
									"text-vscode-editor-font-size",
									"leading-vscode-editor-line-height",
									isFocused
										? "border border-[var(--alpha-accent)] outline outline-[var(--alpha-accent)]"
										: isDraggingOver
											? "border-2 border-dashed border-vscode-focusBorder"
											: "border border-transparent",
									"pl-2",
									"py-2",
									isEditMode ? "pr-20" : "pr-9",
									"z-10",
									"forced-color-adjust-none",
									"rounded-xl",
								)}
								style={{
									color: "transparent",
								}}
							/>
							<DynamicTextArea
								ref={(el) => {
									if (typeof ref === "function") {
										ref(el)
									} else if (ref) {
										ref.current = el
									}
									textAreaRef.current = el
								}}
								value={inputValue}
								aria-label={placeholderText}
								aria-keyshortcuts={modeSwitchDisabled ? undefined : "Shift+Tab"}
								aria-autocomplete="list"
								aria-controls={showContextMenu ? contextMenuId : undefined}
								aria-expanded={showContextMenu}
								aria-activedescendant={
									showContextMenu && selectedMenuIndex >= 0
										? `${contextMenuId}-option-${selectedMenuIndex}`
										: undefined
								}
								onChange={(e) => {
									handleInputChange(e)
									updateHighlights()
								}}
								onFocus={() => setIsFocused(true)}
								onKeyDown={(e) => {
									// Handle ESC to cancel in edit mode
									if (isEditMode && e.key === "Escape" && !e.nativeEvent?.isComposing) {
										e.preventDefault()
										onCancel?.()
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
									"text-vscode-input-foreground",
									"font-vscode-font-family",
									"text-vscode-editor-font-size",
									"leading-vscode-editor-line-height",
									"cursor-text",
									"py-2 pl-2",
									isFocused
										? "border border-[var(--alpha-accent)] outline outline-[var(--alpha-accent)]"
										: isDraggingOver
											? "border-2 border-dashed border-vscode-focusBorder"
											: "border border-transparent",
									isDraggingOver
										? "bg-[color-mix(in_srgb,var(--vscode-input-background)_95%,var(--vscode-focusBorder))]"
										: "bg-[var(--surface-sunken)]",
									"transition-background-color duration-150 ease-in-out",
									"will-change-background-color",
									"min-h-[94px]",
									"box-border",
									"rounded-xl",
									"resize-none",
									"overflow-x-hidden",
									"overflow-y-auto",
									isEditMode ? "pr-20" : "pr-9",
									"flex-none flex-grow",
									"z-[2]",
									"scrollbar-none",
									"scrollbar-hide",
								)}
								onScroll={() => updateHighlights()}
							/>

							<div className="absolute bottom-2 right-1 z-30 flex flex-col items-center gap-0">
								<StandardTooltip content={t("chat:addImages")}>
									<button
										aria-label={t("chat:addImages")}
										disabled={shouldDisableImages}
										onClick={!shouldDisableImages ? onSelectImages : undefined}
										className={cn(
											"relative inline-flex items-center justify-center",
											"bg-transparent border-none p-1.5",
											"rounded-md min-w-[28px] min-h-[28px]",
											"text-vscode-descriptionForeground hover:text-vscode-foreground",
											"transition-[color,background-color,opacity,transform] duration-150",
											"cursor-pointer",
											!shouldDisableImages
												? "opacity-60 hover:opacity-100 pointer-events-auto"
												: "opacity-0 pointer-events-none",
											!shouldDisableImages &&
												"hover:bg-vscode-toolbar-hoverBackground active:scale-95",
											"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
											shouldDisableImages &&
												"cursor-not-allowed grayscale-[30%] hover:bg-transparent active:bg-transparent",
										)}>
										<Image className="w-4 h-4" />
									</button>
								</StandardTooltip>
								{isEditMode ? (
									<StandardTooltip content={t("chat:cancel.title")}>
										<button
											aria-label={t("chat:cancel.title")}
											disabled={false}
											onClick={onCancel}
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
								) : (
									<StandardTooltip content={t("chat:enhancePrompt")}>
										<button
											aria-label={t("chat:enhancePrompt")}
											disabled={isEnhancingPrompt}
											onClick={handleEnhancePrompt}
											className={cn(
												"relative inline-flex items-center justify-center",
												"bg-transparent border-none p-1.5",
												"rounded-md min-w-[28px] min-h-[28px]",
												"text-vscode-descriptionForeground hover:text-vscode-foreground",
												"transition-[color,background-color,opacity,transform] duration-150",
												"cursor-pointer",
												hasInputContent
													? "opacity-60 hover:opacity-100 pointer-events-auto"
													: "opacity-0 pointer-events-none",
												hasInputContent &&
													"hover:bg-vscode-toolbar-hoverBackground active:scale-95",
												"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
											)}>
											<WandSparkles
												className={cn("w-4 h-4", isEnhancingPrompt && "animate-spin")}
											/>
										</button>
									</StandardTooltip>
								)}
								{/* Queue button - shown when streaming and user has typed content */}
								{!isEditMode && isStreaming && hasInputContent && onEnqueueMessage && (
									<StandardTooltip content={t("chat:enqueueMessage")}>
										<button
											aria-label={t("chat:enqueueMessage")}
											disabled={enqueueDisabled}
											onClick={enqueueDisabled ? undefined : onEnqueueMessage}
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
								{/* Send/Stop button - morphs based on streaming state, always visible in edit mode */}
								<StandardTooltip
									content={
										isEditMode
											? t("chat:pressToSend", { keyCombination: sendKeyCombination })
											: isStreaming
												? t("chat:stop.title")
												: t("chat:pressToSend", { keyCombination: sendKeyCombination })
									}>
									<button
										aria-label={
											isEditMode
												? t("chat:pressToSend", { keyCombination: sendKeyCombination })
												: isStreaming
													? t("chat:stop.title")
													: t("chat:pressToSend", { keyCombination: sendKeyCombination })
										}
										disabled={sendDisabled}
										onClick={
											sendDisabled
												? undefined
												: isEditMode
													? onSend
													: isStreaming
														? onStop
														: onSend
										}
										className={cn(
											"relative inline-flex items-center justify-center",
											"border-none p-1.5",
											"rounded-full min-w-[28px] min-h-[28px]",
											"transition-[color,background-color,opacity,transform] duration-150",
											isEditMode || isStreaming || hasInputContent
												? "opacity-100 hover:opacity-100 pointer-events-auto"
												: "opacity-0 pointer-events-none",
											(isEditMode || isStreaming || hasInputContent) &&
												"bg-[var(--alpha-accent)] text-[var(--alpha-accent-contrast)] shadow-[var(--shadow-accent)] hover:bg-[var(--alpha-accent-hover)] active:scale-95",
											"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
											(isEditMode || isStreaming || hasInputContent) &&
												(sendDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"),
											!(isEditMode || isStreaming || hasInputContent) &&
												"bg-transparent text-vscode-descriptionForeground",
										)}>
										{!isEditMode && isStreaming ? (
											<Square className="size-4 stroke-none fill-vscode-button-foreground" />
										) : (
											<SendHorizontal className="size-4" />
										)}
									</button>
								</StandardTooltip>
							</div>

							{!inputValue && (
								<div
									className={cn(
										"absolute left-2 z-30 flex items-center h-8 font-vscode-font-family text-vscode-editor-font-size leading-vscode-editor-line-height",
										isEditMode ? "pr-20" : "pr-9",
									)}
									style={{
										bottom: "0.75rem",
										color: "color-mix(in oklab, var(--vscode-input-foreground) 50%, transparent)",
										userSelect: "none",
										pointerEvents: "none",
									}}>
									{placeholderBottomText}
								</div>
							)}
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

				<div className="flex items-center gap-2 px-1 pt-0.5">
					<div className="flex items-center gap-2 min-w-0 overflow-clip flex-1">
						<ModeSelector
							value={mode}
							title={t("chat:selectMode")}
							onChange={handleModeChange}
							disabled={modeSwitchDisabled}
							triggerClassName="text-ellipsis overflow-hidden flex-shrink-0"
							modeShortcutText={modeShortcutText}
							customModes={customModes}
							customModePrompts={customModePrompts}
						/>
						<ApiConfigSelector
							value={currentConfigId}
							displayName={displayName}
							disabled={selectApiConfigDisabled}
							title={t("chat:selectApiConfig")}
							onChange={handleApiConfigChange}
							triggerClassName="min-w-[28px] text-ellipsis overflow-hidden flex-shrink"
							listApiConfigMeta={listApiConfigMeta || []}
							pinnedApiConfigs={pinnedApiConfigs}
							togglePinnedApiConfig={togglePinnedApiConfig}
						/>
						<AutoApproveDropdown triggerClassName="min-w-[28px] text-ellipsis overflow-hidden flex-shrink" />
					</div>
					<div className={cn("flex flex-shrink-0 items-center gap-0.5 h-5 leading-none", "pr-2")}>
						{isTtsPlaying && (
							<StandardTooltip content={t("chat:stopTts")}>
								<button
									aria-label={t("chat:stopTts")}
									onClick={() => vscode.postMessage({ type: "stopTts" })}
									className={cn(
										"relative inline-flex items-center justify-center",
										"bg-transparent border-none p-1.5",
										"rounded-md min-w-[28px] min-h-[28px]",
										"text-vscode-foreground opacity-85",
										"transition-all duration-150",
										"hover:bg-vscode-toolbar-hoverBackground hover:opacity-100 active:scale-95",
										"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
										"cursor-pointer",
									)}>
									<VolumeX className="w-4 h-4" />
								</button>
							</StandardTooltip>
						)}
						{!isEditMode ? <IndexingStatusBadge /> : null}
					</div>
				</div>
			</div>
		)
	},
)
