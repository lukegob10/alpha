import React, { memo, useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation, Trans } from "react-i18next"
import deepEqual from "fast-deep-equal"
import removeMd from "remove-markdown"
import { VSCodeBadge } from "@vscode/webview-ui-toolkit/react"

import type {
	ClineMessage,
	FollowUpData,
	SuggestionItem,
	ClineApiReqInfo,
	ClineAskUseMcpServer,
	ClineSayTool,
} from "@alpha-code/types"

import { Mode } from "@alpha/modes"

import { COMMAND_OUTPUT_STRING } from "@alpha/combineCommandSequences"
import { safeJsonParse } from "@alpha/core"

import { type ExtensionStateContextType, useExtensionState } from "@src/context/ExtensionStateContext"
import { findMatchingResourceOrTemplate } from "@src/utils/mcp"
import { vscode } from "@src/utils/vscode"
import { formatPathTooltip } from "@src/utils/formatPathTooltip"

import { ToolUseBlock, ToolUseBlockHeader } from "../common/ToolUseBlock"
import UpdateTodoListToolBlock from "./UpdateTodoListToolBlock"
import { TodoChangeDisplay } from "./TodoChangeDisplay"
import CodeAccordion from "../common/CodeAccordion"
import MarkdownBlock from "../common/MarkdownBlock"
import { ReasoningBlock } from "./ReasoningBlock"
import Thumbnails from "../common/Thumbnails"
import ImageBlock from "../common/ImageBlock"
import ErrorRow from "./ErrorRow"
import WarningRow from "./WarningRow"

import McpResourceRow from "../mcp/McpResourceRow"

import { Mention } from "./Mention"
import { CheckpointSaved } from "./checkpoints/CheckpointSaved"
import { FollowUpSuggest } from "./FollowUpSuggest"
import { BatchFilePermission } from "./BatchFilePermission"
import { BatchListFilesPermission } from "./BatchListFilesPermission"
import { BatchDiffApproval } from "./BatchDiffApproval"
import { ProgressIndicator } from "./ProgressIndicator"
import { Markdown } from "./Markdown"
import { CommandExecution } from "./CommandExecution"
import { CommandExecutionError } from "./CommandExecutionError"
import { AutoApprovedRequestLimitWarning } from "./AutoApprovedRequestLimitWarning"
import { InProgressRow, CondensationResultRow, CondensationErrorRow, TruncationResultRow } from "./context-management"
import CodebaseSearchResultsDisplay, { type CodebaseSearchMatch } from "./CodebaseSearchResultsDisplay"
import { CodebaseSearchActivity } from "./CodebaseSearchActivity"
import { FileSearchBatch } from "./FileSearchBatch"
import { appendImages } from "@src/utils/imageUtils"
import { McpExecution } from "./McpExecution"
import { ChatTextArea } from "./ChatTextArea"
import { MAX_IMAGES_PER_MESSAGE } from "./ChatView"
import { useSelectedModel } from "../ui/hooks/useSelectedModel"
import {
	Eye,
	FileDiff,
	ListTree,
	Edit,
	Trash2,
	MessageCircleQuestionMark,
	SquareArrowOutUpRight,
	FileCode2,
	PocketKnife,
	FolderTree,
	TerminalSquare,
	MessageCircle,
	Repeat2,
	Split,
	ArrowRight,
	Check,
	CircleAlert,
	Clock3,
	LoaderCircle,
	Globe2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { PathTooltip } from "../ui/PathTooltip"
import { OpenMarkdownPreviewButton } from "./OpenMarkdownPreviewButton"
import { SubagentGroupCard } from "./SubagentGroupCard"
import { TicketActivity } from "./TicketActivity"
import { ActivityStep } from "./ActivityStep"

// Helper function to get previous todos before a specific message
function getPreviousTodos(messages: ClineMessage[], currentMessageTs: number): any[] {
	// Find the previous updateTodoList message before the current one
	const previousUpdateIndex = messages
		.slice()
		.reverse()
		.findIndex((msg) => {
			if (msg.ts >= currentMessageTs) return false
			if (msg.type === "ask" && msg.ask === "tool") {
				try {
					const tool = JSON.parse(msg.text || "{}")
					return tool.tool === "updateTodoList"
				} catch {
					return false
				}
			}
			return false
		})

	if (previousUpdateIndex !== -1) {
		const previousMessage = messages.slice().reverse()[previousUpdateIndex]
		try {
			const tool = JSON.parse(previousMessage.text || "{}")
			return tool.todos || []
		} catch {
			return []
		}
	}

	// If no previous updateTodoList message, return empty array
	return []
}

export interface ChatRowEnvironment
	extends Pick<
		ExtensionStateContextType,
		| "mcpServers"
		| "alwaysAllowMcp"
		| "currentCheckpoint"
		| "mode"
		| "currentTaskItem"
		| "currentTaskId"
		| "reasoningBlockCollapsed"
	> {
	modelSupportsImages?: boolean
	getClineMessages: () => ClineMessage[]
}

interface ChatRowProps {
	message: ClineMessage
	environment: ChatRowEnvironment
	lastModifiedMessage?: ClineMessage
	isExpanded: boolean
	isLast: boolean
	isStreaming: boolean
	onToggleExpand: (ts: number) => void
	onSuggestionClick?: (suggestion: SuggestionItem, event?: React.MouseEvent) => void
	onBatchFileResponse?: (response: { [key: string]: boolean }) => void
	onFollowUpUnmount?: () => void
	isFollowUpAnswered?: boolean
	isFollowUpAutoApprovalPaused?: boolean
	editable?: boolean
	hasCheckpoint?: boolean
	onJumpToPreviousCheckpoint?: () => void
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ChatRowContentProps extends Omit<ChatRowProps, "environment"> {}

interface ChatRowContentInnerProps extends ChatRowContentProps {
	environment: ChatRowEnvironment
}

const ChatRow = memo(
	(props: ChatRowProps) => {
		// ChatView filters non-rendered messages before constructing this row.
		return (
			<div
				className={cn(
					"px-[15px] pr-[6px]",
					props.message.say === "user_feedback" ||
						props.message.say === "completion_result" ||
						props.message.ask === "completion_result" ||
						props.message.ask === "followup"
						? "py-[10px]"
						: "py-1",
				)}>
				<ChatRowContentInner {...props} />
			</div>
		)
	},
	// memo does shallow comparison of props, so we need to do deep comparison of arrays/objects whose properties might change
	deepEqual,
)

export default ChatRow

// Compatibility wrapper for focused row tests and non-virtualized consumers.
// ChatView passes a stable environment directly to ChatRow so streamed transcript
// updates do not make every visible row subscribe to the root extension state.
export const ChatRowContent = (props: ChatRowContentProps) => {
	const extensionState = useExtensionState()
	const { info: model } = useSelectedModel(extensionState.apiConfiguration)
	const environment: ChatRowEnvironment = {
		mcpServers: extensionState.mcpServers,
		alwaysAllowMcp: extensionState.alwaysAllowMcp,
		currentCheckpoint: extensionState.currentCheckpoint,
		mode: extensionState.mode,
		currentTaskItem: extensionState.currentTaskItem,
		currentTaskId: extensionState.currentTaskId,
		reasoningBlockCollapsed: extensionState.reasoningBlockCollapsed,
		modelSupportsImages: model?.supportsImages,
		getClineMessages: () => extensionState.clineMessages,
	}

	return <ChatRowContentInner {...props} environment={environment} />
}

const ChatRowContentInner = ({
	message,
	environment,
	lastModifiedMessage,
	isExpanded,
	isLast,
	isStreaming,
	onToggleExpand,
	onSuggestionClick,
	onFollowUpUnmount,
	onBatchFileResponse,
	isFollowUpAnswered,
	isFollowUpAutoApprovalPaused,
	onJumpToPreviousCheckpoint,
}: ChatRowContentInnerProps) => {
	const { t, i18n } = useTranslation()

	const {
		mcpServers,
		alwaysAllowMcp,
		currentCheckpoint,
		mode,
		currentTaskItem,
		currentTaskId,
		reasoningBlockCollapsed,
		modelSupportsImages,
		getClineMessages,
	} = environment
	// A completion report can survive an interrupted finalization; only the projected task status confirms success.
	const isTaskCompleted = currentTaskItem?.id === currentTaskId && currentTaskItem?.status === "completed"
	const clineMessages = getClineMessages()
	const [isEditing, setIsEditing] = useState(false)
	const [editedContent, setEditedContent] = useState("")
	const [editMode, setEditMode] = useState<Mode>(mode || "code")
	const [editImages, setEditImages] = useState<string[]>([])

	// Handle message events for image selection during edit mode
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const msg = event.data
			if (msg.type === "selectedImages" && msg.context === "edit" && msg.messageTs === message.ts && isEditing) {
				setEditImages((prevImages) => appendImages(prevImages, msg.images, MAX_IMAGES_PER_MESSAGE))
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [isEditing, message.ts])

	// Memoized callback to prevent re-renders caused by inline arrow functions.
	const handleToggleExpand = useCallback(() => {
		onToggleExpand(message.ts)
	}, [onToggleExpand, message.ts])
	const activityProps = { isExpanded, onToggleExpand: handleToggleExpand }

	// Handle edit button click
	const handleEditClick = useCallback(() => {
		setIsEditing(true)
		setEditedContent(message.text || "")
		setEditImages(message.images || [])
		setEditMode(mode || "code")
		// Edit mode is now handled entirely in the frontend
		// No need to notify the backend
	}, [message.text, message.images, mode])

	// Handle cancel edit
	const handleCancelEdit = useCallback(() => {
		setIsEditing(false)
		setEditedContent(message.text || "")
		setEditImages(message.images || [])
		setEditMode(mode || "code")
	}, [message.text, message.images, mode])

	// Handle save edit
	const handleSaveEdit = useCallback(() => {
		setIsEditing(false)
		// Send edited message to backend
		vscode.postMessage({
			type: "submitEditedMessage",
			value: message.ts,
			editedMessageContent: editedContent,
			images: editImages,
			taskId: currentTaskId,
		})
	}, [message.ts, editedContent, editImages, currentTaskId])

	// Handle image selection for editing
	const handleSelectImages = useCallback(() => {
		vscode.postMessage({ type: "selectImages", context: "edit", messageTs: message.ts })
	}, [message.ts])

	const [cost, apiReqCancelReason, apiReqStreamingFailedMessage] = useMemo(() => {
		if (message.text !== null && message.text !== undefined && message.say === "api_req_started") {
			const info = safeJsonParse<ClineApiReqInfo>(message.text)
			return [info?.cost, info?.cancelReason, info?.streamingFailedMessage]
		}

		return [undefined, undefined, undefined]
	}, [message.text, message.say])

	// When resuming task, last won't be api_req_failed but a resume_task
	// message, so api_req_started will show loading spinner. That's why we just
	// remove the last api_req_started that failed without streaming anything.
	const apiRequestFailedMessage =
		isLast && lastModifiedMessage?.ask === "api_req_failed" // if request is retried then the latest message is a api_req_retried
			? lastModifiedMessage?.text
			: undefined

	const isCommandExecuting =
		isLast && lastModifiedMessage?.ask === "command" && lastModifiedMessage?.text?.includes(COMMAND_OUTPUT_STRING)

	const isMcpServerResponding = isLast && lastModifiedMessage?.say === "mcp_server_request_started"

	const type = message.type === "ask" ? message.ask : message.say

	const normalColor = "var(--vscode-foreground)"
	const errorColor = "var(--vscode-errorForeground)"
	const successColor = "var(--vscode-charts-green)"
	const cancelledColor = "var(--vscode-descriptionForeground)"

	const [icon, title] = useMemo(() => {
		switch (type) {
			case "error":
			case "mistake_limit_reached":
				return [null, null] // These will be handled by ErrorRow component
			case "command":
				return [
					isCommandExecuting ? (
						<ProgressIndicator />
					) : (
						<TerminalSquare className="size-4" aria-label="Terminal icon" />
					),
					<span className="shrink-0 text-sm">{t("chat:commandExecution.command")}</span>,
				]
			case "use_mcp_server":
				const mcpServerUse = safeJsonParse<ClineAskUseMcpServer>(message.text)
				if (mcpServerUse === undefined) {
					return [null, null]
				}
				return [
					isMcpServerResponding ? (
						<ProgressIndicator />
					) : (
						<span
							className="codicon codicon-server"
							style={{ color: normalColor, marginBottom: "-1.5px" }}></span>
					),
					<span style={{ color: normalColor, fontWeight: "bold" }}>
						{mcpServerUse.type === "use_mcp_tool"
							? t("chat:mcp.wantsToUseTool", { serverName: mcpServerUse.serverName })
							: t("chat:mcp.wantsToAccessResource", { serverName: mcpServerUse.serverName })}
					</span>,
				]
			case "completion_result":
				return [
					isTaskCompleted ? (
						<span
							className="codicon codicon-check"
							style={{ color: successColor, marginBottom: "-1.5px" }}></span>
					) : (
						<MessageCircle className="w-4 shrink-0" aria-hidden="true" />
					),
					<span style={{ color: isTaskCompleted ? successColor : normalColor, fontWeight: "bold" }}>
						{t(isTaskCompleted ? "chat:taskCompleted" : "chat:completionReport")}
					</span>,
				]
			case "api_req_rate_limit_wait":
				return []
			case "api_req_retry_delayed":
				return []
			case "api_req_started":
				const getIconSpan = (iconName: string, color: string) => (
					<div
						style={{
							width: 16,
							height: 16,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
						}}>
						<span
							className={`codicon codicon-${iconName}`}
							style={{ color, fontSize: 16, marginBottom: "-1.5px" }}
						/>
					</div>
				)
				return [
					apiReqCancelReason !== null && apiReqCancelReason !== undefined ? (
						apiReqCancelReason === "user_cancelled" ? (
							getIconSpan("error", cancelledColor)
						) : (
							getIconSpan("error", errorColor)
						)
					) : cost !== null && cost !== undefined ? (
						getIconSpan("arrow-swap", normalColor)
					) : apiRequestFailedMessage ? (
						getIconSpan("error", errorColor)
					) : isLast ? (
						<ProgressIndicator />
					) : (
						getIconSpan("arrow-swap", normalColor)
					),
					apiReqCancelReason !== null && apiReqCancelReason !== undefined ? (
						apiReqCancelReason === "user_cancelled" ? (
							<span style={{ color: normalColor, fontWeight: "bold" }}>
								{t("chat:apiRequest.cancelled")}
							</span>
						) : (
							<span style={{ color: errorColor, fontWeight: "bold" }}>
								{t("chat:apiRequest.streamingFailed")}
							</span>
						)
					) : cost !== null && cost !== undefined ? (
						<span style={{ color: normalColor }}>{t("chat:apiRequest.title")}</span>
					) : apiRequestFailedMessage ? (
						<span style={{ color: errorColor }}>{t("chat:apiRequest.failed")}</span>
					) : (
						<span style={{ color: normalColor }}>{t("chat:apiRequest.streaming")}</span>
					),
				]
			case "followup":
				return [
					<MessageCircleQuestionMark className="w-4 shrink-0" aria-label="Question icon" />,
					<span style={{ color: normalColor, fontWeight: "bold" }}>{t("chat:questions.hasQuestion")}</span>,
				]
			default:
				return [null, null]
		}
	}, [
		type,
		isCommandExecuting,
		message,
		isMcpServerResponding,
		apiReqCancelReason,
		cost,
		apiRequestFailedMessage,
		t,
		isLast,
		isTaskCompleted,
	])

	const headerStyle: React.CSSProperties = {
		display: "flex",
		alignItems: "center",
		gap: "10px",
		cursor: "default",
		marginBottom: "10px",
		wordBreak: "break-word",
	}

	const tool = useMemo(() => {
		if (message.ask === "tool") {
			return safeJsonParse<ClineSayTool>(message.text)
		}

		if (message.type === "say" && message.say === "tool") {
			const sayTool = safeJsonParse<ClineSayTool>(message.text)
			return sayTool &&
				["listFilesTopLevel", "listFilesRecursive", "readFile", "searchFiles"].includes(sayTool.tool)
				? sayTool
				: null
		}

		return null
	}, [message.type, message.ask, message.say, message.text])

	// Unified diff content (provided by backend when relevant)
	const unifiedDiff = useMemo(() => {
		if (!tool) return undefined
		return (tool.content ?? tool.diff) as string | undefined
	}, [tool])

	const onJumpToCreatedFile = useMemo(() => {
		if (!tool || tool.tool !== "newFileCreated" || !tool.path) {
			return undefined
		}

		return () => vscode.postMessage({ type: "openFile", text: "./" + tool.path })
	}, [tool])

	const followUpData = useMemo(() => {
		if (message.type === "ask" && message.ask === "followup" && !message.partial) {
			return safeJsonParse<FollowUpData>(message.text)
		}
		return null
	}, [message.type, message.ask, message.partial, message.text])
	const renderError = (props: React.ComponentProps<typeof ErrorRow>) => (
		<ActivityStep
			{...activityProps}
			summary={
				<>
					<CircleAlert className="size-4 shrink-0 text-vscode-errorForeground" />
					<span>{props.title ?? t("chat:error")}</span>
				</>
			}>
			<ErrorRow {...props} />
		</ActivityStep>
	)

	if (tool) {
		const toolIcon = (name: string) => (
			<span
				className={`codicon codicon-${name}`}
				style={{ color: "var(--vscode-foreground)", marginBottom: "-1.5px" }}></span>
		)
		if (tool.batchDirs?.length) {
			return (
				<ActivityStep
					{...activityProps}
					summary={
						<>
							{toolIcon("list-tree")}
							<span>{t("chat:directoryOperations.wantsToViewMultipleDirectories")}</span>
						</>
					}>
					<BatchListFilesPermission dirs={tool.batchDirs} ts={message.ts} />
				</ActivityStep>
			)
		}

		switch (tool.tool as string) {
			case "editedExistingFile":
			case "appliedDiff":
			case "newFileCreated":
			case "searchAndReplace":
			case "search_and_replace":
			case "search_replace":
			case "edit":
			case "edit_file":
			case "apply_patch":
			case "apply_diff":
				// Check if this is a batch diff request
				if (message.type === "ask" && tool.batchDiffs && Array.isArray(tool.batchDiffs)) {
					return (
						<ActivityStep
							{...activityProps}
							summary={
								<>
									<FileDiff className="w-4 shrink-0" aria-label="Batch diff icon" />
									<span style={{ fontWeight: "normal" }}>
										{t("chat:fileOperations.wantsToApplyBatchChanges")}
									</span>
								</>
							}>
							<BatchDiffApproval files={tool.batchDiffs} ts={message.ts} />
						</ActivityStep>
					)
				}

				// Regular single file diff
				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								{tool.isProtected ? (
									<span
										className="codicon codicon-lock"
										style={{
											color: "var(--vscode-editorWarning-foreground)",
											marginBottom: "-1.5px",
										}}
									/>
								) : (
									toolIcon("diff")
								)}
								<span style={{ fontWeight: "normal" }}>
									{tool.isProtected
										? t("chat:fileOperations.wantsToEditProtected")
										: tool.isOutsideWorkspace
											? t("chat:fileOperations.wantsToEditOutsideWorkspace")
											: t("chat:fileOperations.wantsToEdit")}
								</span>
							</>
						}>
						<div className="pl-6">
							<CodeAccordion
								path={tool.path}
								code={unifiedDiff ?? tool.content ?? tool.diff ?? ""}
								language="diff"
								progressStatus={message.progressStatus}
								isLoading={message.partial}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
								onJumpToFile={onJumpToCreatedFile}
								diffStats={tool.diffStats}
							/>
						</div>
					</ActivityStep>
				)
			case "insertContent":
				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								{tool.isProtected ? (
									<span
										className="codicon codicon-lock"
										style={{
											color: "var(--vscode-editorWarning-foreground)",
											marginBottom: "-1.5px",
										}}
									/>
								) : (
									toolIcon("insert")
								)}
								<span style={{ fontWeight: "normal" }}>
									{tool.isProtected
										? t("chat:fileOperations.wantsToEditProtected")
										: tool.isOutsideWorkspace
											? t("chat:fileOperations.wantsToEditOutsideWorkspace")
											: tool.lineNumber === 0
												? t("chat:fileOperations.wantsToInsertAtEnd")
												: t("chat:fileOperations.wantsToInsertWithLineNumber", {
														lineNumber: tool.lineNumber,
													})}
								</span>
							</>
						}>
						<div className="pl-6">
							<CodeAccordion
								path={tool.path}
								code={unifiedDiff ?? tool.diff}
								language="diff"
								progressStatus={message.progressStatus}
								isLoading={message.partial}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
								diffStats={tool.diffStats}
							/>
						</div>
					</ActivityStep>
				)
			case "codebaseSearch": {
				return <CodebaseSearchActivity {...activityProps} query={tool.query} path={tool.path} />
			}
			case "ticket":
				return <TicketActivity tool={tool} />
			case "updateTodoList" as any: {
				const todos = (tool as any).todos || []
				// Get previous todos from the latest todos in the task context
				const previousTodos = getPreviousTodos(clineMessages, message.ts)

				return <TodoChangeDisplay previousTodos={previousTodos} newTodos={todos} />
			}
			case "readFile":
				// Check if this is a batch file permission request
				const isBatchRequest = message.type === "ask" && tool.batchFiles && Array.isArray(tool.batchFiles)

				if (isBatchRequest) {
					return (
						<ActivityStep
							{...activityProps}
							summary={
								<>
									<Eye className="w-4 shrink-0" aria-label="View files icon" />
									<span style={{ fontWeight: "normal" }}>
										{t("chat:fileOperations.wantsToReadMultiple")}
									</span>
								</>
							}>
							<BatchFilePermission
								files={tool.batchFiles || []}
								onPermissionResponse={(response) => {
									onBatchFileResponse?.(response)
								}}
								ts={message?.ts}
							/>
						</ActivityStep>
					)
				}

				// Regular single file read request
				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								<FileCode2 className="w-4 shrink-0" aria-label="Read file icon" />
								<span style={{ fontWeight: "normal" }}>
									{message.type === "ask"
										? tool.isOutsideWorkspace
											? t("chat:fileOperations.wantsToReadOutsideWorkspace")
											: tool.additionalFileCount && tool.additionalFileCount > 0
												? t("chat:fileOperations.wantsToReadAndXMore", {
														count: tool.additionalFileCount,
													})
												: t("chat:fileOperations.wantsToRead")
										: t("chat:fileOperations.didRead")}
								</span>
							</>
						}>
						<div className="pl-6">
							<ToolUseBlock>
								<ToolUseBlockHeader
									className="group"
									onClick={() =>
										vscode.postMessage({
											type: "openFile",
											text: tool.content,
											values: tool.startLine ? { line: tool.startLine } : undefined,
										})
									}>
									{tool.path?.startsWith(".") && <span>.</span>}
									<PathTooltip content={formatPathTooltip(tool.path, tool.reason)}>
										<span className="whitespace-nowrap overflow-hidden text-ellipsis text-left mr-2 rtl">
											{formatPathTooltip(tool.path, tool.reason)}
										</span>
									</PathTooltip>
									<div style={{ flexGrow: 1 }}></div>
									<SquareArrowOutUpRight
										className="w-4 shrink-0 codicon codicon-link-external opacity-0 group-hover:opacity-100 transition-opacity"
										style={{ fontSize: 13.5, margin: "1px 0" }}
									/>
								</ToolUseBlockHeader>
							</ToolUseBlock>
						</div>
					</ActivityStep>
				)
			case "skill": {
				const skillInfo = tool
				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								{toolIcon("book")}
								<span style={{ fontWeight: "normal" }}>
									{message.type === "ask" ? t("chat:skill.wantsToLoad") : t("chat:skill.didLoad")}
								</span>
							</>
						}>
						<div
							style={{
								marginTop: "4px",
								backgroundColor: "var(--vscode-editor-background)",
								border: "1px solid var(--vscode-editorGroup-border)",
								borderRadius: "4px",
								overflow: "hidden",
								cursor: "pointer",
							}}
							onClick={handleToggleExpand}>
							<ToolUseBlockHeader
								className="group"
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									padding: "10px 12px",
								}}>
								<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
									<span style={{ fontWeight: "500", fontSize: "var(--vscode-font-size)" }}>
										{skillInfo.skill}
									</span>
									{skillInfo.source && (
										<VSCodeBadge style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
											{skillInfo.source}
										</VSCodeBadge>
									)}
								</div>
								<span
									className={`codicon codicon-chevron-${isExpanded ? "up" : "down"} opacity-0 group-hover:opacity-100 transition-opacity duration-200`}></span>
							</ToolUseBlockHeader>
							{isExpanded && (skillInfo.args || skillInfo.description) && (
								<div
									style={{
										padding: "12px 16px",
										borderTop: "1px solid var(--vscode-editorGroup-border)",
										display: "flex",
										flexDirection: "column",
										gap: "8px",
									}}>
									{skillInfo.description && (
										<div style={{ color: "var(--vscode-descriptionForeground)" }}>
											{skillInfo.description}
										</div>
									)}
									{skillInfo.args && (
										<div>
											<span style={{ fontWeight: "500" }}>Arguments: </span>
											<span style={{ color: "var(--vscode-descriptionForeground)" }}>
												{skillInfo.args}
											</span>
										</div>
									)}
								</div>
							)}
						</div>
					</ActivityStep>
				)
			}
			case "listFilesTopLevel":
				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								<ListTree className="w-4 shrink-0" aria-label="List files icon" />
								<span style={{ fontWeight: "normal" }}>
									{message.type === "ask"
										? tool.isOutsideWorkspace
											? t("chat:directoryOperations.wantsToViewTopLevelOutsideWorkspace")
											: t("chat:directoryOperations.wantsToViewTopLevel")
										: tool.isOutsideWorkspace
											? t("chat:directoryOperations.didViewTopLevelOutsideWorkspace")
											: t("chat:directoryOperations.didViewTopLevel")}
								</span>
							</>
						}>
						<div className="pl-6">
							<CodeAccordion
								path={tool.path}
								code={tool.content}
								language="shell-session"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</ActivityStep>
				)
			case "listFilesRecursive":
				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								<FolderTree className="w-4 shrink-0" aria-label="Folder tree icon" />
								<span style={{ fontWeight: "normal" }}>
									{message.type === "ask"
										? tool.isOutsideWorkspace
											? t("chat:directoryOperations.wantsToViewRecursiveOutsideWorkspace")
											: t("chat:directoryOperations.wantsToViewRecursive")
										: tool.isOutsideWorkspace
											? t("chat:directoryOperations.didViewRecursiveOutsideWorkspace")
											: t("chat:directoryOperations.didViewRecursive")}
								</span>
							</>
						}>
						<div className="pl-6">
							<CodeAccordion
								path={tool.path}
								code={tool.content}
								language="shellsession"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</ActivityStep>
				)
			case "searchFiles":
				if (tool.batchSearches?.length) {
					return (
						<FileSearchBatch
							{...activityProps}
							searches={tool.batchSearches}
							label={t(
								message.type === "ask"
									? "chat:directoryOperations.wantsToSearchMultiple"
									: "chat:directoryOperations.didSearchMultiple",
								{ count: tool.batchSearches.length },
							)}
						/>
					)
				}

				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								{toolIcon("search")}
								<span style={{ fontWeight: "normal" }}>
									{message.type === "ask" ? (
										<Trans
											i18nKey={
												tool.isOutsideWorkspace
													? "chat:directoryOperations.wantsToSearchOutsideWorkspace"
													: "chat:directoryOperations.wantsToSearch"
											}
											components={{
												code: (
													<code className="font-medium" style={{ color: normalColor }}>
														{tool.regex}
													</code>
												),
											}}
											values={{ regex: tool.regex }}
										/>
									) : (
										<Trans
											i18nKey={
												tool.isOutsideWorkspace
													? "chat:directoryOperations.didSearchOutsideWorkspace"
													: "chat:directoryOperations.didSearch"
											}
											components={{
												code: (
													<code className="font-medium" style={{ color: normalColor }}>
														{tool.regex}
													</code>
												),
											}}
											values={{ regex: tool.regex }}
										/>
									)}
								</span>
							</>
						}>
						<div className="pl-6">
							<CodeAccordion
								path={tool.path! + (tool.filePattern ? `/(${tool.filePattern})` : "")}
								code={tool.content}
								language="shellsession"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</ActivityStep>
				)
			case "switchMode":
				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								<PocketKnife className="w-4 shrink-0" aria-label="Switch mode icon" />
								<span style={{ fontWeight: "bold" }}>
									{message.type === "ask" ? (
										<>
											{tool.reason ? (
												<Trans
													i18nKey="chat:modes.wantsToSwitchWithReason"
													components={{
														code: <code className="font-medium">{tool.mode}</code>,
													}}
													values={{ mode: tool.mode, reason: tool.reason }}
												/>
											) : (
												<Trans
													i18nKey="chat:modes.wantsToSwitch"
													components={{
														code: <code className="font-medium">{tool.mode}</code>,
													}}
													values={{ mode: tool.mode }}
												/>
											)}
										</>
									) : (
										<>
											{tool.reason ? (
												<Trans
													i18nKey="chat:modes.didSwitchWithReason"
													components={{
														code: <code className="font-medium">{tool.mode}</code>,
													}}
													values={{ mode: tool.mode, reason: tool.reason }}
												/>
											) : (
												<Trans
													i18nKey="chat:modes.didSwitch"
													components={{
														code: <code className="font-medium">{tool.mode}</code>,
													}}
													values={{ mode: tool.mode }}
												/>
											)}
										</>
									)}
								</span>
							</>
						}>
						<div className="pl-6 whitespace-pre-wrap break-words">{tool.reason || tool.mode}</div>
					</ActivityStep>
				)
			case "newTask":
				// Find all newTask messages to determine which child task ID corresponds to this message
				const newTaskMessages = clineMessages.filter((msg) => {
					if (msg.type === "ask" && msg.ask === "tool") {
						const t = safeJsonParse<ClineSayTool>(msg.text)
						return t?.tool === "newTask"
					}
					return false
				})
				const thisNewTaskIndex = newTaskMessages.findIndex((msg) => msg.ts === message.ts)
				const childIds = currentTaskItem?.childIds || []

				// Only get the child task ID if this newTask has been approved (has a corresponding entry in childIds)
				// This prevents showing a link to a previous task when the current newTask is still awaiting approval
				// Note: We don't use delegatedToId here because it persists after child tasks complete and would
				// incorrectly point to the previous task when a new newTask is awaiting approval
				const childTaskId =
					thisNewTaskIndex >= 0 && thisNewTaskIndex < childIds.length ? childIds[thisNewTaskIndex] : undefined

				// Check if the next message is a subtask_result - if so, don't show the button
				// since the result is displayed right after this message
				const currentMessageIndex = clineMessages.findIndex((msg) => msg.ts === message.ts)
				const nextMessage = currentMessageIndex >= 0 ? clineMessages[currentMessageIndex + 1] : undefined
				const isFollowedBySubtaskResult = nextMessage?.type === "say" && nextMessage?.say === "subtask_result"

				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								<Split className="size-4" />
								<span style={{ fontWeight: "normal" }}>
									<Trans
										i18nKey="chat:subtasks.wantsToCreate"
										components={{ code: <code>{tool.mode}</code> }}
										values={{ mode: tool.mode }}
									/>
								</span>
							</>
						}>
						<div className="border-l border-muted-foreground/80 ml-2 pl-4 pb-1">
							<MarkdownBlock markdown={tool.content} />
							<div>
								{childTaskId && !isFollowedBySubtaskResult && (
									<button
										className="cursor-pointer flex gap-1 items-center mt-2 text-vscode-descriptionForeground hover:text-vscode-descriptionForeground hover:underline font-normal"
										onClick={() =>
											vscode.postMessage({ type: "showTaskWithId", text: childTaskId })
										}>
										{t("chat:subtasks.goToSubtask")}
										<ArrowRight className="size-3" />
									</button>
								)}
							</div>
						</div>
					</ActivityStep>
				)
			case "delegateTask":
				// The persisted inline SubagentGroupCard is the single presentation surface.
				// ChatView still renders the standard approval controls for this ask.
				return null
			case "finishTask":
				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								{toolIcon("check-all")}
								<span style={{ fontWeight: "normal" }}>{t("chat:subtasks.wantsToFinish")}</span>
							</>
						}>
						<div className="text-muted-foreground pl-6">
							<MarkdownBlock markdown={t("chat:subtasks.completionInstructions")} />
						</div>
					</ActivityStep>
				)
			case "runSlashCommand": {
				const slashCommandInfo = tool
				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								{toolIcon("play")}
								<span style={{ fontWeight: "normal" }}>
									{message.type === "ask"
										? t("chat:slashCommand.wantsToRun")
										: t("chat:slashCommand.didRun")}
								</span>
							</>
						}>
						<div
							style={{
								marginTop: "4px",
								backgroundColor: "var(--vscode-editor-background)",
								border: "1px solid var(--vscode-editorGroup-border)",
								borderRadius: "4px",
								overflow: "hidden",
								cursor: "pointer",
							}}
							onClick={handleToggleExpand}>
							<ToolUseBlockHeader
								className="group"
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									padding: "10px 12px",
								}}>
								<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
									<span style={{ fontWeight: "500", fontSize: "var(--vscode-font-size)" }}>
										/{slashCommandInfo.command}
									</span>
									{slashCommandInfo.source && (
										<VSCodeBadge style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
											{slashCommandInfo.source}
										</VSCodeBadge>
									)}
								</div>
								<span
									className={`codicon codicon-chevron-${isExpanded ? "up" : "down"} opacity-0 group-hover:opacity-100 transition-opacity duration-200`}></span>
							</ToolUseBlockHeader>
							{isExpanded && (slashCommandInfo.args || slashCommandInfo.description) && (
								<div
									style={{
										padding: "12px 16px",
										borderTop: "1px solid var(--vscode-editorGroup-border)",
										display: "flex",
										flexDirection: "column",
										gap: "8px",
									}}>
									{slashCommandInfo.args && (
										<div>
											<span style={{ fontWeight: "500" }}>Arguments: </span>
											<span style={{ color: "var(--vscode-descriptionForeground)" }}>
												{slashCommandInfo.args}
											</span>
										</div>
									)}
									{slashCommandInfo.description && (
										<div style={{ color: "var(--vscode-descriptionForeground)" }}>
											{slashCommandInfo.description}
										</div>
									)}
								</div>
							)}
						</div>
					</ActivityStep>
				)
			}
			case "generateImage":
				return (
					<ActivityStep
						{...activityProps}
						summary={
							<>
								{tool.isProtected ? (
									<span
										className="codicon codicon-lock"
										style={{
											color: "var(--vscode-editorWarning-foreground)",
											marginBottom: "-1.5px",
										}}
									/>
								) : (
									toolIcon("file-media")
								)}
								<span style={{ fontWeight: "normal" }}>
									{message.type === "ask"
										? tool.isProtected
											? t("chat:fileOperations.wantsToGenerateImageProtected")
											: tool.isOutsideWorkspace
												? t("chat:fileOperations.wantsToGenerateImageOutsideWorkspace")
												: t("chat:fileOperations.wantsToGenerateImage")
										: t("chat:fileOperations.didGenerateImage")}
								</span>
							</>
						}>
						{message.type === "ask" && (
							<div className="pl-6">
								<ToolUseBlock>
									<div className="p-2">
										<div className="mb-2 break-words">{tool.content}</div>
										<div className="flex items-center gap-1 text-xs text-vscode-descriptionForeground">
											{tool.path}
										</div>
									</div>
								</ToolUseBlock>
							</div>
						)}
					</ActivityStep>
				)
			default:
				return null
		}
	}

	switch (message.type) {
		case "say":
			switch (message.say) {
				case "subagent_group":
					return message.subagentGroup ? (
						<ActivityStep
							{...activityProps}
							summary={
								<>
									<Split className="size-4 shrink-0" />
									<span>
										{t("common:costs.subtasks")} ({message.subagentGroup.agents.length})
									</span>
									{message.subagentGroup.agents.some(
										(agent) =>
											agent.pendingApproval ||
											agent.parentVerification?.blocking ||
											(agent.changeSet &&
												["pending_review", "conflicted"].includes(agent.changeSet.status)),
									) && (
										<>
											<CircleAlert className="size-4 shrink-0" aria-hidden="true" />
											<span>{t("chat:activityTrace.needsAttention")}</span>
										</>
									)}
								</>
							}>
							<SubagentGroupCard group={message.subagentGroup} parentTaskId={currentTaskId} />
						</ActivityStep>
					) : null
				case "diff_error":
					return (
						<ErrorRow
							type="diff_error"
							message={message.text || ""}
							expandable={true}
							showCopyButton={true}
						/>
					)
				case "subtask_result":
					// Get the child task ID that produced this result
					const completedChildTaskId = currentTaskItem?.completedByChildId
					return (
						<ActivityStep
							{...activityProps}
							summary={
								<>
									<span>{t("chat:subtasks.resultContent")}</span>
									<Check className="size-3" />
								</>
							}>
							<MarkdownBlock markdown={message.text} />
							{completedChildTaskId && (
								<button
									className="cursor-pointer flex gap-1 items-center mt-2 text-vscode-descriptionForeground hover:text-vscode-descriptionForeground hover:underline font-normal"
									onClick={() =>
										vscode.postMessage({ type: "showTaskWithId", text: completedChildTaskId })
									}>
									{t("chat:subtasks.goToSubtask")}
									<ArrowRight className="size-3" />
								</button>
							)}
						</ActivityStep>
					)
				case "reasoning":
					return (
						<ReasoningBlock
							content={message.text || ""}
							ts={message.ts}
							isStreaming={isStreaming}
							isLast={isLast}
							collapsedByDefault={reasoningBlockCollapsed}
						/>
					)
				case "api_req_started":
					// Determine if the API request is in progress
					const isApiRequestInProgress =
						apiReqCancelReason === undefined && apiRequestFailedMessage === undefined && cost === undefined

					return (
						<>
							<div
								className={`group text-sm transition-opacity ${
									isApiRequestInProgress ? "opacity-100" : "opacity-40 hover:opacity-100"
								}`}
								style={{
									...headerStyle,
									marginBottom:
										((cost === null || cost === undefined) && apiRequestFailedMessage) ||
										apiReqStreamingFailedMessage
											? 10
											: 0,
									justifyContent: "space-between",
								}}>
								<div style={{ display: "flex", alignItems: "center", gap: "10px", flexGrow: 1 }}>
									{icon}
									{title}
								</div>
								<div
									className="text-xs text-vscode-dropdown-foreground border-vscode-dropdown-border/50 border px-1.5 py-0.5 rounded-lg"
									style={{ opacity: cost !== null && cost !== undefined && cost > 0 ? 1 : 0 }}>
									${Number(cost || 0)?.toFixed(4)}
								</div>
							</div>
							{(((cost === null || cost === undefined) && apiRequestFailedMessage) ||
								apiReqStreamingFailedMessage) && (
								<ErrorRow
									type="api_failure"
									message={apiRequestFailedMessage || apiReqStreamingFailedMessage || ""}
									docsURL={
										apiRequestFailedMessage?.toLowerCase().includes("powershell")
											? "https://github.com/cline/cline/wiki/TroubleShooting-%E2%80%90-%22PowerShell-is-not-recognized-as-an-internal-or-external-command%22"
											: undefined
									}
									errorDetails={apiReqStreamingFailedMessage}
								/>
							)}
						</>
					)
				case "api_req_retry_delayed":
					let body = t(`chat:apiRequest.failed`)
					let retryInfo, rawError, code, docsURL
					if (message.text !== undefined) {
						// Try to show richer error message for that code, if available
						const potentialCode = parseInt(message.text.substring(0, 3))
						if (!isNaN(potentialCode) && potentialCode >= 400) {
							code = potentialCode
							const stringForError = `chat:apiRequest.errorMessage.${code}`
							if (i18n.exists(stringForError)) {
								body = t(stringForError)
								// Fill this out in upcoming PRs
								// Do not remove this
								// switch(code) {
								// 	case ERROR_CODE:
								// 		docsURL = ???
								// 		break;
								// }
							} else {
								// Non-HTTP-status-code error message - store full text as errorDetails
								body = t("chat:apiRequest.errorMessage.unknown")
								docsURL =
									"mailto:support@alpha.invalid?subject=Unknown API Error&body=[Please include full error details]"
							}
						}

						// This isn't pretty, but since the retry logic happens at a lower level
						// and the message object is just a flat string, we need to extract the
						// retry information using this "tag" as a convention
						const retryTimerMatch = message.text.match(/<retry_timer>(.*?)<\/retry_timer>/)
						const retryTimer = retryTimerMatch && retryTimerMatch[1] ? parseInt(retryTimerMatch[1], 10) : 0
						rawError = message.text.replace(/<retry_timer>(.*?)<\/retry_timer>/, "").trim()
						retryInfo = retryTimer > 0 && (
							<p
								className={cn(
									"mt-2 font-light text-xs  text-vscode-descriptionForeground cursor-default flex items-center gap-1 transition-all duration-1000",
									retryTimer === 0 ? "opacity-0 max-h-0" : "max-h-2 opacity-100",
								)}>
								<Repeat2 className="size-3" strokeWidth={1.5} />
								<span>{retryTimer}s</span>
							</p>
						)
					}
					return (
						<ErrorRow
							type="api_req_retry_delayed"
							code={code}
							message={body}
							docsURL={docsURL}
							additionalContent={retryInfo}
							errorDetails={rawError}
						/>
					)
				case "api_req_rate_limit_wait": {
					const isWaiting = message.partial === true

					const waitSeconds = (() => {
						if (!message.text) return undefined
						try {
							const data = JSON.parse(message.text)
							return typeof data.seconds === "number" ? data.seconds : undefined
						} catch {
							return undefined
						}
					})()

					return isWaiting && waitSeconds !== undefined ? (
						<div
							className={`group text-sm transition-opacity opacity-100`}
							style={{
								...headerStyle,
								marginBottom: 0,
								justifyContent: "space-between",
							}}>
							<div style={{ display: "flex", alignItems: "center", gap: "10px", flexGrow: 1 }}>
								<ProgressIndicator />
								<span style={{ color: normalColor }}>{t("chat:apiRequest.rateLimitWait")}</span>
							</div>
							<span className="text-xs font-light text-vscode-descriptionForeground">{waitSeconds}s</span>
						</div>
					) : null
				}
				case "api_req_finished":
					return null // we should never see this message type
				case "text":
					return (
						<ActivityStep
							{...activityProps}
							summary={
								<>
									<MessageCircle className="size-4 shrink-0" />
									<span>
										{removeMd((message.text || "").split(/\r?\n/, 1)[0]).trim() ||
											t("chat:text.rooSaid")}
									</span>
								</>
							}>
							{isExpanded && (
								<article className="group" aria-label={t("chat:text.rooSaid")}>
									<Markdown
										markdown={message.text}
										partial={message.partial}
										actions={<OpenMarkdownPreviewButton markdown={message.text} />}
									/>
									{message.images && message.images.length > 0 && (
										<div style={{ marginTop: "10px" }}>
											{message.images.map((image, index) => (
												<ImageBlock key={index} imageData={image} />
											))}
										</div>
									)}
								</article>
							)}
						</ActivityStep>
					)
				case "user_feedback":
					return (
						<article className="group flex justify-end" aria-label={t("chat:feedback.youSaid")}>
							<div
								className={cn(
									"min-w-0 overflow-hidden whitespace-pre-wrap",
									isEditing
										? "w-full rounded-xl bg-vscode-editor-background text-vscode-editor-foreground"
										: "user-message max-w-[92%] cursor-text px-3 py-2",
								)}>
								{isEditing ? (
									<div className="flex flex-col gap-2">
										<ChatTextArea
											inputValue={editedContent}
											setInputValue={setEditedContent}
											sendingDisabled={false}
											selectApiConfigDisabled={true}
											placeholderText={t("chat:editMessage.placeholder")}
											selectedImages={editImages}
											setSelectedImages={setEditImages}
											onSend={handleSaveEdit}
											onSelectImages={handleSelectImages}
											shouldDisableImages={!modelSupportsImages}
											mode={editMode}
											setMode={setEditMode}
											modeShortcutText=""
											isEditMode={true}
											onCancel={handleCancelEdit}
										/>
									</div>
								) : (
									<div className="flex justify-between">
										<div
											className="flex-grow px-2 py-1 wrap-anywhere rounded-lg transition-colors"
											onClick={(e) => {
												e.stopPropagation()
												if (!isStreaming) {
													handleEditClick()
												}
											}}
											title={t("chat:queuedMessages.clickToEdit")}>
											<Mention text={message.text} withShadow />
										</div>
										<div className="flex items-center gap-2 pl-2">
											<button
												type="button"
												aria-label={t("chat:queuedMessages.edit")}
												className="cursor-pointer shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity bg-transparent border-0 p-0"
												style={{ visibility: isStreaming ? "hidden" : "visible" }}
												onClick={(e) => {
													e.stopPropagation()
													handleEditClick()
												}}>
												<Edit className="w-4 shrink-0" aria-hidden="true" />
											</button>
											<button
												type="button"
												aria-label={t("common:confirmation.deleteMessage")}
												className="cursor-pointer shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity bg-transparent border-0 p-0"
												style={{ visibility: isStreaming ? "hidden" : "visible" }}
												onClick={(e) => {
													e.stopPropagation()
													vscode.postMessage({
														type: "deleteMessage",
														value: message.ts,
														taskId: currentTaskId,
													})
												}}>
												<Trash2 className="w-4 shrink-0" aria-hidden="true" />
											</button>
										</div>
									</div>
								)}
								{!isEditing && message.images && message.images.length > 0 && (
									<Thumbnails images={message.images} style={{ marginTop: "8px" }} />
								)}
							</div>
						</article>
					)
				case "user_feedback_diff":
					const tool = safeJsonParse<ClineSayTool>(message.text)
					return (
						<div style={{ marginTop: -10, width: "100%" }}>
							<CodeAccordion
								code={tool?.diff}
								language="diff"
								isFeedback={true}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					)
				case "error":
					// Check if this is a model response error based on marker strings from backend
					const isNoToolsUsedError = message.text === "MODEL_NO_TOOLS_USED"
					const isNoAssistantMessagesError = message.text === "MODEL_NO_ASSISTANT_MESSAGES"

					if (isNoToolsUsedError) {
						return renderError({
							type: "error",
							title: t("chat:modelResponseIncomplete"),
							message: t("chat:modelResponseErrors.noToolsUsed"),
							errorDetails: t("chat:modelResponseErrors.noToolsUsedDetails"),
						})
					}

					if (isNoAssistantMessagesError) {
						return renderError({
							type: "error",
							title: t("chat:modelResponseIncomplete"),
							message: t("chat:modelResponseErrors.noAssistantMessages"),
							errorDetails: t("chat:modelResponseErrors.noAssistantMessagesDetails"),
						})
					}

					// Fallback for generic errors
					return renderError({
						type: "error",
						message: message.text || t("chat:error"),
						errorDetails: message.text,
					})
				case "completion_result":
					return (
						<article
							className="group"
							aria-label={t(isTaskCompleted ? "chat:taskCompleted" : "chat:completionReport")}>
							<Markdown
								markdown={message.text}
								partial={message.partial}
								actions={<OpenMarkdownPreviewButton markdown={message.text} />}
							/>
						</article>
					)
				case "shell_integration_warning":
					return <CommandExecutionError />
				case "checkpoint_saved":
					return (
						<CheckpointSaved
							ts={message.ts!}
							commitHash={message.text!}
							currentHash={currentCheckpoint}
							checkpoint={message.checkpoint}
							onJumpToPreviousCheckpoint={onJumpToPreviousCheckpoint}
						/>
					)
				case "condense_context":
					// In-progress state
					if (message.partial) {
						return <InProgressRow eventType="condense_context" />
					}
					// Completed state
					if (message.contextCondense) {
						return <CondensationResultRow data={message.contextCondense} />
					}
					return null
				case "condense_context_error":
					return <CondensationErrorRow errorText={message.text} />
				case "sliding_window_truncation":
					// In-progress state
					if (message.partial) {
						return <InProgressRow eventType="sliding_window_truncation" />
					}
					// Completed state
					if (message.contextTruncation) {
						return <TruncationResultRow data={message.contextTruncation} />
					}
					return null
				case "codebase_search_result":
					let parsed: {
						content: {
							query: string
							results: CodebaseSearchMatch[]
						}
					} | null = null

					try {
						if (message.text) {
							parsed = JSON.parse(message.text)
						}
					} catch (error) {
						console.error("Failed to parse codebaseSearch content:", error)
					}

					if (parsed && !parsed?.content) {
						console.error("Invalid codebaseSearch content structure:", parsed.content)
						return <div>Error displaying search results.</div>
					}

					const { results = [] } = parsed?.content || {}

					return <CodebaseSearchResultsDisplay results={results} {...activityProps} />
				case "user_edit_todos":
					return <UpdateTodoListToolBlock userEdited onChange={() => {}} />
				case "tool" as any:
					// Handle say tool messages
					const sayTool = safeJsonParse<ClineSayTool>(message.text)
					if (!sayTool) return null

					switch (sayTool.tool) {
						case "ticket":
							return <TicketActivity tool={sayTool} />
						case "browserAction": {
							const labels: Record<NonNullable<ClineSayTool["action"]>, string> = {
								open_browser_page: "Open browser page",
								list_browser_pages: "List browser pages",
								read_page: "Read browser page",
								screenshot_page: "Capture browser page",
								navigate_page: "Navigate browser page",
								click_element: "Click browser element",
								type_in_page: "Type in browser page",
								hover_element: "Hover over browser element",
								drag_element: "Drag browser element",
								handle_dialog: "Handle browser dialog",
								run_playwright_code: "Run browser automation",
							}
							const status = sayTool.status ?? "completed"
							const label = sayTool.action ? labels[sayTool.action] : "Use integrated browser"
							const detail = sayTool.url ?? sayTool.element ?? sayTool.pageId
							const browserIcon =
								status === "running" ? (
									<LoaderCircle
										className="size-4 shrink-0 animate-spin"
										aria-label="Browser action in progress"
									/>
								) : status === "error" ? (
									<CircleAlert
										className="size-4 shrink-0 text-vscode-errorForeground"
										aria-label="Browser action failed"
									/>
								) : (
									<Globe2 className="size-4 shrink-0" aria-label="Integrated browser action" />
								)

							return (
								<div data-testid="browser-action-status" style={headerStyle}>
									{browserIcon}
									<span style={{ fontWeight: "bold" }}>
										{label}
										{status === "cancelled" ? " cancelled" : status === "error" ? " failed" : ""}
									</span>
									{detail && (
										<span className="truncate text-xs text-vscode-descriptionForeground">
											· {detail}
										</span>
									)}
								</div>
							)
						}
						case "runSlashCommand": {
							const slashCommandInfo = sayTool
							return (
								<ActivityStep
									{...activityProps}
									summary={
										<>
											<span
												className="codicon codicon-terminal-cmd"
												style={{
													color: "var(--vscode-foreground)",
													marginBottom: "-1.5px",
												}}></span>
											<span style={{ fontWeight: "normal" }}>
												{t("chat:slashCommand.didRun")}
											</span>
										</>
									}>
									<div className="pl-6">
										<ToolUseBlock>
											<ToolUseBlockHeader
												style={{
													display: "flex",
													flexDirection: "column",
													alignItems: "flex-start",
													gap: "4px",
													padding: "10px 12px",
												}}>
												<div
													style={{
														display: "flex",
														alignItems: "center",
														gap: "8px",
														width: "100%",
													}}>
													<span
														style={{
															fontWeight: "500",
															fontSize: "var(--vscode-font-size)",
														}}>
														/{slashCommandInfo.command}
													</span>
													{slashCommandInfo.args && (
														<span
															style={{
																color: "var(--vscode-descriptionForeground)",
																fontSize: "var(--vscode-font-size)",
															}}>
															{slashCommandInfo.args}
														</span>
													)}
												</div>
												{slashCommandInfo.description && (
													<div
														style={{
															color: "var(--vscode-descriptionForeground)",
															fontSize: "calc(var(--vscode-font-size) - 1px)",
														}}>
														{slashCommandInfo.description}
													</div>
												)}
												{slashCommandInfo.source && (
													<div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
														<VSCodeBadge
															style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
															{slashCommandInfo.source}
														</VSCodeBadge>
													</div>
												)}
											</ToolUseBlockHeader>
										</ToolUseBlock>
									</div>
								</ActivityStep>
							)
						}
						case "readCommandOutput": {
							const formatBytes = (bytes: number) => {
								if (bytes < 1024) return `${bytes} B`
								if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
								return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
							}

							// Determine if this is a search operation
							const isSearch = sayTool.searchPattern !== undefined

							let infoText = ""
							if (isSearch) {
								// Search mode: show pattern and match count
								const matchText =
									sayTool.matchCount !== undefined
										? sayTool.matchCount === 1
											? "1 match"
											: `${sayTool.matchCount} matches`
										: ""
								infoText = `search: "${sayTool.searchPattern}"${matchText ? ` • ${matchText}` : ""}`
							} else if (
								sayTool.readStart !== undefined &&
								sayTool.readEnd !== undefined &&
								sayTool.totalBytes !== undefined
							) {
								// Read mode: show byte range
								infoText = `${formatBytes(sayTool.readStart)} - ${formatBytes(sayTool.readEnd)} of ${formatBytes(sayTool.totalBytes)}`
							} else if (sayTool.totalBytes !== undefined) {
								infoText = formatBytes(sayTool.totalBytes)
							}

							return (
								<div style={headerStyle}>
									<FileCode2 className="w-4 shrink-0" aria-label="Read command output icon" />
									<span style={{ fontWeight: "bold" }}>{t("chat:readCommandOutput.title")}</span>
									{infoText && (
										<span
											className="text-xs ml-1"
											style={{ color: "var(--vscode-descriptionForeground)" }}>
											({infoText})
										</span>
									)}
								</div>
							)
						}
						case "agentLifecycle": {
							const status = sayTool.lifecycleStatus
							const action = sayTool.agentAction
							let label: string
							let detail: string | undefined

							if (status === "error") {
								label = t("chat:agentLifecycle.failed", {
									action: t(`chat:agentLifecycle.actions.${action ?? "unknown"}`),
									error: sayTool.content || t("chat:error"),
								})
							} else if (action === "list_agents") {
								label =
									status === "running"
										? t("chat:agentLifecycle.list.running")
										: t("chat:agentLifecycle.list.completed", { count: sayTool.agentCount ?? 0 })
								if (status === "completed" && (sayTool.mailboxUnreadCount ?? 0) > 0) {
									detail = t("chat:agentLifecycle.list.mailbox", {
										count: sayTool.mailboxUnreadCount,
									})
								}
							} else if (status === "running") {
								label = t("chat:agentLifecycle.wait.running")
							} else if (sayTool.noActiveAgents) {
								label = t("chat:agentLifecycle.wait.noActiveAgents")
							} else if (sayTool.cancelled) {
								label = t("chat:agentLifecycle.wait.cancelled")
							} else if (sayTool.timedOut) {
								label = t("chat:agentLifecycle.wait.timedOut")
							} else if (sayTool.alreadyDelivered) {
								label = t("chat:agentLifecycle.wait.alreadyDelivered")
							} else if ((sayTool.eventCount ?? 0) > 0) {
								label = t("chat:agentLifecycle.wait.received", { count: sayTool.eventCount })
							} else {
								label = t("chat:agentLifecycle.wait.completed")
							}

							const lifecycleIcon =
								status === "running" ? (
									<LoaderCircle
										className="size-4 shrink-0 animate-spin"
										aria-label="Agent action in progress"
									/>
								) : status === "error" ? (
									<CircleAlert
										className="size-4 shrink-0 text-vscode-errorForeground"
										aria-label="Agent action failed"
									/>
								) : action === "list_agents" ? (
									<ListTree className="size-4 shrink-0" aria-label="Agent list inspected" />
								) : (
									<Clock3 className="size-4 shrink-0" aria-label="Agent wait completed" />
								)

							return (
								<div data-testid="agent-lifecycle-status" style={headerStyle}>
									{lifecycleIcon}
									<span style={{ fontWeight: "bold" }}>{label}</span>
									{detail && (
										<span className="text-xs text-vscode-descriptionForeground">· {detail}</span>
									)}
								</div>
							)
						}
						default:
							return null
					}
				case "image":
					// Parse the JSON to get imageUri and imagePath
					const imageInfo = safeJsonParse<{ imageUri: string; imagePath: string }>(message.text || "{}")
					if (!imageInfo) {
						return null
					}
					return (
						<div style={{ marginTop: "10px" }}>
							<ImageBlock imageUri={imageInfo.imageUri} imagePath={imageInfo.imagePath} />
						</div>
					)
				case "too_many_tools_warning": {
					const warningData = safeJsonParse<{
						toolCount: number
						serverCount: number
						threshold: number
					}>(message.text || "{}")
					if (!warningData) return null
					const toolsPart = t("chat:tooManyTools.toolsPart", { count: warningData.toolCount })
					const serversPart = t("chat:tooManyTools.serversPart", { count: warningData.serverCount })
					return (
						<WarningRow
							title={t("chat:tooManyTools.title")}
							message={t("chat:tooManyTools.messageTemplate", {
								tools: toolsPart,
								servers: serversPart,
								threshold: warningData.threshold,
							})}
							actionText={t("chat:tooManyTools.openMcpSettings")}
							onAction={() =>
								window.postMessage(
									{ type: "action", action: "settingsButtonClicked", values: { section: "mcp" } },
									"*",
								)
							}
						/>
					)
				}
				default:
					return (
						<>
							{title && (
								<div style={headerStyle}>
									{icon}
									{title}
								</div>
							)}
							<div style={{ paddingTop: 10 }}>
								<Markdown markdown={message.text} partial={message.partial} />
							</div>
						</>
					)
			}
		case "ask":
			switch (message.ask) {
				case "mistake_limit_reached":
					return <ErrorRow type="mistake_limit" message={message.text || ""} errorDetails={message.text} />
				case "command":
					return (
						<CommandExecution
							executionId={message.ts.toString()}
							onToggleExpand={handleToggleExpand}
							text={message.text}
							icon={icon}
							title={title}
						/>
					)
				case "use_mcp_server":
					// Parse the message text to get the MCP server request
					const messageJson = safeJsonParse<any>(message.text, {})

					// Extract the response field if it exists
					const { response, ...mcpServerRequest } = messageJson

					// Create the useMcpServer object with the response field
					const useMcpServer: ClineAskUseMcpServer = {
						...mcpServerRequest,
						response,
					}

					if (!useMcpServer) {
						return null
					}

					const server = mcpServers.find((server) => server.name === useMcpServer.serverName)

					return (
						<ActivityStep
							{...activityProps}
							summary={
								<>
									{icon}
									{title}
								</>
							}>
							<div className="w-full bg-vscode-editor-background border border-vscode-border rounded-xs p-2 mt-2">
								{useMcpServer.type === "access_mcp_resource" && (
									<McpResourceRow
										item={{
											// Use the matched resource/template details, with fallbacks
											...(findMatchingResourceOrTemplate(
												useMcpServer.uri || "",
												server?.resources,
												server?.resourceTemplates,
											) || {
												name: "",
												mimeType: "",
												description: "",
											}),
											// Always use the actual URI from the request
											uri: useMcpServer.uri || "",
										}}
									/>
								)}
								{useMcpServer.type === "use_mcp_tool" && (
									<McpExecution
										executionId={message.ts.toString()}
										text={useMcpServer.arguments !== "{}" ? useMcpServer.arguments : undefined}
										serverName={useMcpServer.serverName}
										toolName={useMcpServer.toolName}
										isArguments={true}
										server={server}
										useMcpServer={useMcpServer}
										alwaysAllowMcp={alwaysAllowMcp}
									/>
								)}
							</div>
						</ActivityStep>
					)
				case "completion_result":
					if (message.text) {
						return (
							<article
								className="group"
								aria-label={t(isTaskCompleted ? "chat:taskCompleted" : "chat:completionReport")}>
								<Markdown
									markdown={message.text}
									partial={message.partial}
									actions={<OpenMarkdownPreviewButton markdown={message.text} />}
								/>
							</article>
						)
					} else {
						return null // Don't render anything when we get a completion_result ask without text
					}
				case "followup":
					return (
						<>
							{title && (
								<div style={headerStyle}>
									{icon}
									{title}
								</div>
							)}
							<div className="flex flex-col gap-2 ml-6">
								<Markdown
									markdown={message.partial === true ? message?.text : followUpData?.question}
								/>
								<FollowUpSuggest
									suggestions={followUpData?.suggest}
									onSuggestionClick={onSuggestionClick}
									ts={message?.ts}
									onCancelAutoApproval={onFollowUpUnmount}
									isAnswered={isFollowUpAnswered}
									isFollowUpAutoApprovalPaused={isFollowUpAutoApprovalPaused}
								/>
							</div>
						</>
					)
				case "auto_approval_max_req_reached": {
					return <AutoApprovedRequestLimitWarning message={message} />
				}
				default:
					return null
			}
	}
}
