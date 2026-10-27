// pnpm --filter @alpha-code/vscode-webview test src/components/chat/__tests__/ChatView.spec.tsx

import React from "react"
import { render, waitFor, act, fireEvent, within } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
	agentLifecycleSnapshotSchema,
	type AlphaMessageTurn,
	type RequestUserInputAnswerMap,
	type ToolApprovalPrompt,
} from "@alpha-code/types"
import { readFileSync } from "node:fs"

import { ExtensionStateContextProvider, useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { installNativeTestFocus } from "@src/utils/test-native-focus"

import ChatView, { ChatViewProps, type ChatViewRef, isContextCondensationRequest } from "../ChatView"

vi.mock("@/i18n/TranslationContext", async () => {
	const { default: i18n } = await import("@/i18n/setup")
	return { useAppTranslation: () => ({ t: (key: string) => key, i18n }) }
})

// Define minimal types needed for testing
interface AlphaMessage {
	type: "say" | "ask"
	say?: string
	ask?: string
	ts: number
	text?: string
	partial?: boolean
	isAnswered?: boolean
	toolApprovalRequest?: ToolApprovalPrompt
	asyncUserInput?: { questions: Array<{ title: string; options?: string[] }> }
	queuedMessageIds?: string[]
	agentMessage?: { id: string; senderTaskId: string }
	turn?: AlphaMessageTurn
	checkpoint?: Record<string, unknown>
}

interface ExtensionState {
	version: string
	clineMessages: AlphaMessage[]
	taskHistory: any[]
	shouldShowAnnouncement: boolean
	allowedCommands: string[]
	alwaysAllowExecute: boolean
	[key: string]: any
}

const nativeInputMessage: AlphaMessage = {
	type: "ask",
	ask: "followup",
	ts: 2,
	text: JSON.stringify({
		requestUserInput: {
			questions: [
				{
					id: "environment",
					header: "Environment",
					question: "Which environment should I use?",
					options: [
						{ label: "Staging", description: "Use the staging environment." },
						{ label: "Production", description: "Use the production environment." },
					],
				},
			],
		},
	}),
}

// Mock vscode API
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock use-sound hook
const mockPlayFunction = vi.fn()
vi.mock("use-sound", () => ({
	default: vi.fn().mockImplementation(() => {
		return [mockPlayFunction]
	}),
}))

// Mock components that use ESM dependencies
vi.mock("../ChatRow", () => ({
	default: function MockChatRow({
		message,
		isTaskPrompt,
		onSuggestionClick,
		onRequestUserInputSubmit,
		onRequestUserInputCancel,
		isFollowUpAnswered,
		onAsyncUserInputSubmit,
		isAsyncUserInputAnswered,
		isAsyncUserInputPending,
		hideSubagentGroups,
		disclosureState,
		onDisclosureChange,
	}: {
		message: AlphaMessage
		isTaskPrompt?: boolean
		onSuggestionClick?: (suggestion: { answer: string; mode?: string }, event?: React.MouseEvent) => void
		onRequestUserInputSubmit?: (answers: RequestUserInputAnswerMap, askMessageTs: number) => boolean | void
		onRequestUserInputCancel?: (askMessageTs: number) => void
		isFollowUpAnswered?: boolean
		onAsyncUserInputSubmit?: (messageTs: number, response: string) => boolean
		isAsyncUserInputAnswered?: boolean
		isAsyncUserInputPending?: boolean
		hideSubagentGroups?: boolean
		disclosureState?: { reasoning?: boolean }
		onDisclosureChange?: (ts: number, facet: "reasoning", expanded: boolean) => void
	}) {
		const [nativeAccepted, setNativeAccepted] = React.useState(false)
		if (hideSubagentGroups && message.type === "say" && message.say === "subagent_group") return null
		return (
			<div data-testid="chat-row">
				{isTaskPrompt ? <span>{message.text}</span> : JSON.stringify(message)}
				{message.say === "reasoning" && (
					<button
						data-testid={`reasoning-disclosure-${message.ts}`}
						aria-expanded={disclosureState?.reasoning ?? false}
						onClick={() => onDisclosureChange?.(message.ts, "reasoning", !disclosureState?.reasoning)}>
						Thinking details
					</button>
				)}
				{message.ask === "followup" && message.text?.includes('"requestUserInput"') && (
					<>
						<button
							data-testid={`native-user-input-submit-${message.ts}`}
							disabled={nativeAccepted || isFollowUpAnswered}
							onClick={() =>
								setNativeAccepted(
									onRequestUserInputSubmit?.(
										{ environment: { answers: ["Staging"] } },
										message.ts,
									) !== false,
								)
							}>
							Send native answers
						</button>
						<button
							data-testid={`native-user-input-cancel-${message.ts}`}
							disabled={nativeAccepted || isFollowUpAnswered}
							onClick={() => onRequestUserInputCancel?.(message.ts)}>
							Cancel native question
						</button>
					</>
				)}
				{message.say === "async_user_input" && (
					<>
						<button
							data-testid={`async-user-input-submit-${message.ts}`}
							disabled={isAsyncUserInputAnswered || isAsyncUserInputPending}
							onClick={() => onAsyncUserInputSubmit?.(message.ts, "Use blue and label it Ready.")}>
							Send async reply
						</button>
						<span data-testid={`async-user-input-status-${message.ts}`}>
							{isAsyncUserInputAnswered
								? "Answers sent"
								: isAsyncUserInputPending
									? "Sending answer"
									: "Awaiting an answer"}
						</span>
					</>
				)}
				{message.ask === "followup" && (
					<button
						data-testid="auto-mode-suggestion"
						onClick={() => onSuggestionClick?.({ answer: "Draft plan", mode: "architect" })}>
						Auto suggestion
					</button>
				)}
				{message.ask === "followup" && (
					<button
						data-testid="copy-mode-suggestion"
						onClick={(event) => onSuggestionClick?.({ answer: "Draft plan", mode: "architect" }, event)}>
						Copy suggestion
					</button>
				)}
			</div>
		)
	},
}))

vi.mock("../FileChangesPanel", () => ({
	default: function MockFileChangesPanel({ clineMessages = [] }: { clineMessages?: AlphaMessage[] }) {
		const [expanded, setExpanded] = React.useState(false)
		const paths = clineMessages.flatMap((message) => {
			if (!message.text) return []
			try {
				const tool = JSON.parse(message.text) as {
					path?: string
					batchDiffs?: Array<{ path?: string; originalContent?: string; finalContent?: string }>
				}
				return (
					tool.batchDiffs
						?.map((file) =>
							file.originalContent !== undefined && file.finalContent !== undefined
								? `${file.path}:snapshot`
								: file.path,
						)
						.filter(Boolean) ?? (tool.path ? [tool.path] : [])
				)
			} catch {
				return []
			}
		})
		return (
			<div data-testid="file-changes-panel">
				<button aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
					Review changes
				</button>
				{paths.join(",")}
			</div>
		)
	},
}))

vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

vi.mock("../Announcement", () => ({
	default: function MockAnnouncement({ hideAnnouncement }: { hideAnnouncement: () => void }) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const React = require("react")
		return React.createElement(
			"div",
			{ "data-testid": "announcement-modal" },
			React.createElement("div", null, "What's New"),
			React.createElement("button", { onClick: hideAnnouncement }, "Close"),
		)
	},
}))

// Mock QueuedMessages component
vi.mock("../QueuedMessages", () => ({
	QueuedMessages: function MockQueuedMessages({
		queue = [],
		onRemove,
		onSteer,
		onEdit,
		onReorder,
		editingMessageId,
		steeringMessageId,
	}: {
		queue?: Array<{ id: string; text: string; images?: string[] }>
		onRemove?: (index: number) => void
		onSteer?: (index: number) => void
		onEdit?: (index: number) => void
		onReorder?: (fromIndex: number, toIndex: number) => void
		editingMessageId?: string
		steeringMessageId?: string
	}) {
		if (!queue || queue.length === 0) {
			return null
		}
		return (
			<div data-testid="queued-messages">
				{queue.map((msg, index) => (
					<div key={msg.id}>
						<span>{msg.text}</span>
						{editingMessageId === msg.id && <span>Editing in composer</span>}
						<button aria-label="Remove message" onClick={() => onRemove?.(index)}>
							Remove
						</button>
						<button aria-label={`Edit ${msg.id}`} onClick={() => onEdit?.(index)}>
							Edit
						</button>
						<button
							aria-label="Steer"
							disabled={steeringMessageId !== undefined}
							onClick={() => onSteer?.(index)}>
							{steeringMessageId === msg.id ? "Steering" : "Steer"}
						</button>
						<button aria-label={`Move ${msg.id} to front`} onClick={() => onReorder?.(index, 0)}>
							Move front
						</button>
					</div>
				))}
			</div>
		)
	},
}))

// Mock AlphaHero component
vi.mock("@src/components/welcome/AlphaHero", () => ({
	default: function MockAlphaHero() {
		return <div data-testid="roo-hero">Hero content</div>
	},
}))

// Mock TelemetryBanner component
vi.mock("../common/TelemetryBanner", () => ({
	default: function MockTelemetryBanner() {
		return null // Don't render anything to avoid interference
	},
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: any) => {
			if (key === "chat:versionIndicator.ariaLabel" && options?.version) {
				return `Version ${options.version}`
			}
			return key
		},
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ i18nKey, children }: { i18nKey: string; children?: React.ReactNode }) => {
		return <>{children || i18nKey}</>
	},
}))

interface ChatTextAreaProps {
	contextControl?: React.ReactNode
	onSend: () => void
	isTaskDraft?: boolean
	draftApprovalMode?: "ask" | "auto" | "bypass"
	onDraftApprovalModeChange?: (mode: "ask" | "auto" | "bypass") => void
	inputValue?: string
	setInputValue?: (value: string) => void
	sendingDisabled?: boolean
	selectApiConfigDisabled?: boolean
	placeholderText?: string
	selectedImages?: string[]
	shouldDisableImages?: boolean
	isEditMode?: boolean
	onCancel?: () => void
	isStreaming?: boolean
	onStop?: () => void
	onEnqueueMessage?: () => void
	enqueueDisabled?: boolean
}

const mockInputRef = React.createRef<HTMLInputElement>()
const mockFocus = vi.fn()

vi.mock("../ChatTextArea", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mockReact = require("react")

	const ChatTextAreaComponent = mockReact.forwardRef(function MockChatTextArea(
		props: ChatTextAreaProps,
		ref: React.ForwardedRef<{ focus: () => void }>,
	) {
		// Use useImperativeHandle to expose the mock focus method
		mockReact.useImperativeHandle(ref, () => ({
			focus: mockFocus,
		}))

		return (
			<div data-testid="chat-textarea" data-is-task-draft={props.isTaskDraft ? "true" : "false"}>
				{props.contextControl}
				{props.isTaskDraft && (
					<button
						data-testid="mock-draft-approval-ask"
						onClick={() => props.onDraftApprovalModeChange?.("ask")}>
						Ask
					</button>
				)}
				<input
					ref={mockInputRef}
					type="text"
					value={props.inputValue || ""}
					onChange={(e) => {
						// Use parent's setInputValue if available
						if (props.setInputValue) {
							props.setInputValue(e.target.value)
						}
					}}
					onKeyDown={(e) => {
						if (props.isEditMode && e.key === "Escape") {
							e.preventDefault()
							props.onCancel?.()
							return
						}
						// Only call onSend when Enter is pressed (simulating real behavior)
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault()
							props.onSend()
						}
					}}
					data-sending-disabled={props.sendingDisabled}
					data-is-streaming={props.isStreaming}
				/>
				<button data-testid="mock-stop" disabled={!props.isStreaming} onClick={props.onStop}>
					Stop
				</button>
				<button data-testid="mock-provider-selector" disabled={props.selectApiConfigDisabled}>
					Provider
				</button>
				<button data-testid="mock-send" disabled={props.sendingDisabled} onClick={props.onSend}>
					Send
				</button>
				<button data-testid="mock-enqueue" disabled={props.enqueueDisabled} onClick={props.onEnqueueMessage}>
					Queue
				</button>
			</div>
		)
	})

	return {
		default: ChatTextAreaComponent,
		ChatTextArea: ChatTextAreaComponent, // Export as named export too
	}
})

// Mock VSCode components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: function MockVSCodeButton({
		children,
		onClick,
		appearance,
	}: {
		children: React.ReactNode
		onClick?: () => void
		appearance?: string
	}) {
		return (
			<button onClick={onClick} data-appearance={appearance}>
				{children}
			</button>
		)
	},
	VSCodeTextField: function MockVSCodeTextField({
		value,
		onInput,
		placeholder,
	}: {
		value?: string
		onInput?: (e: { target: { value: string } }) => void
		placeholder?: string
	}) {
		return (
			<input
				type="text"
				value={value}
				onChange={(e) => onInput?.({ target: { value: e.target.value } })}
				placeholder={placeholder}
			/>
		)
	},
	VSCodeLink: function MockVSCodeLink({ children, href }: { children: React.ReactNode; href?: string }) {
		return <a href={href}>{children}</a>
	},
}))

// Mock window.postMessage to trigger state hydration
const mockPostMessage = (state: Partial<ExtensionState>) => {
	window.postMessage(
		{
			type: "state",
			state: {
				version: "1.0.0",
				clineMessages: [],
				taskHistory: [],
				shouldShowAnnouncement: false,
				allowedCommands: [],
				alwaysAllowExecute: false,
				telemetrySetting: "enabled",
				...state,
			},
		},
		"*",
	)
}

const defaultProps: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const queryClient = new QueryClient()

const renderChatView = (props: Partial<ChatViewProps> = {}, ref?: React.Ref<ChatViewRef>) => {
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatView {...defaultProps} {...props} ref={ref} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("ChatView retired speech playback", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each(["text", "completion_result"])(
		"does not request speech for finalized %s messages or replay",
		async (say) => {
			const view = renderChatView()
			const prompt: AlphaMessage = { type: "say", say: "task", ts: 1, text: "Original prompt" }
			const response: AlphaMessage = { type: "say", say, ts: 2, text: "Completed answer", partial: true }
			const state = { currentTaskId: "speech-retired", ttsEnabled: true, ttsSpeed: 1.5 }
			mockPostMessage({ ...state, clineMessages: [prompt, response] })
			await view.findByText(/Completed answer/)
			vi.mocked(vscode.postMessage).mockClear()

			for (let refresh = 0; refresh < 2; refresh++) {
				await act(async () => {
					window.dispatchEvent(
						new MessageEvent("message", {
							data: {
								type: "state",
								state: { ...state, clineMessages: [prompt, { ...response, partial: false }] },
							},
						}),
					)
				})
				expect(view.getByText(/Completed answer/)).toBeInTheDocument()
				expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "playTts" }))
			}
		},
	)
})

describe("ChatView checkpoint initialization warnings", () => {
	beforeEach(() => vi.clearAllMocks())

	it("keeps checkpoint warnings scoped to the task that emitted them", async () => {
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: "task-a",
			clineMessages: [{ type: "say", say: "task", ts: 1, text: "Task A" }],
		})
		await waitFor(() => expect(view.getByText("Task A")).toBeInTheDocument())

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "checkpointInitWarning",
						taskId: "task-a",
						checkpointWarning: { type: "INIT_TIMEOUT", timeout: 20 },
					},
				}),
			)
		})
		await waitFor(() => expect(view.getByText("errors.init_checkpoint_fail_long_time")).toBeInTheDocument())

		mockPostMessage({
			currentTaskId: "task-b",
			clineMessages: [{ type: "say", say: "task", ts: 2, text: "Task B" }],
		})
		await waitFor(() => expect(view.getByText("Task B")).toBeInTheDocument())
		expect(view.queryByText("errors.init_checkpoint_fail_long_time")).not.toBeInTheDocument()

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "checkpointInitWarning",
						taskId: "task-a",
						checkpointWarning: { type: "INIT_TIMEOUT", timeout: 20 },
					},
				}),
			)
		})
		expect(view.queryByText("errors.init_checkpoint_fail_long_time")).not.toBeInTheDocument()

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "checkpointInitWarning",
						taskId: "task-b",
						checkpointWarning: { type: "INIT_TIMEOUT", timeout: 20 },
					},
				}),
			)
		})
		await waitFor(() => expect(view.getByText("errors.init_checkpoint_fail_long_time")).toBeInTheDocument())

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "checkpointInitWarning", taskId: "task-b", checkpointWarning: undefined },
				}),
			)
		})
		await waitFor(() => expect(view.queryByText("errors.init_checkpoint_fail_long_time")).not.toBeInTheDocument())
	})
})

describe("ChatView toolbar navigation", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each(["secondary view", "another chat"])(
		"closes More when navigating to %s and retains the draft",
		async (target) => {
			const props = { ...defaultProps }
			const tree = () => (
				<ExtensionStateContextProvider>
					<QueryClientProvider client={queryClient}>
						<ChatView {...props} />
					</QueryClientProvider>
				</ExtensionStateContextProvider>
			)
			const view = render(tree())
			const taskState = (id: string): Partial<ExtensionState> => ({
				renderContext: "editor",
				currentTaskId: id,
				currentView: { type: "task", taskId: id },
				currentTaskItem: { id, task: `Original ${id}`, displayName: `Named ${id}`, ts: 1 },
				clineMessages: [{ type: "say", say: "task", ts: 1, text: `Original ${id}` }],
			})
			mockPostMessage(taskState("a"))
			await view.findByRole("button", { name: "history:backToHome" })
			const toolbar = view.getByRole("group", { name: "common:chatToolbar.label" })
			expect(within(toolbar).queryByText("Named a")).not.toBeInTheDocument()
			expect(within(toolbar).getByRole("button", { name: "history:backToHome" })).toBeInTheDocument()
			expect(within(view.getByTestId("chat-transcript-viewport")).getByText("Original a")).toBeInTheDocument()
			const input = view.getByTestId("chat-textarea").querySelector("input")!
			fireEvent.change(input, { target: { value: "Keep unsent guidance" } })
			fireEvent.keyDown(within(toolbar).getByRole("button", { name: "common:chatToolbar.more" }), {
				key: "Enter",
			})
			expect(await view.findByRole("menu")).toBeInTheDocument()

			if (target === "secondary view") {
				props.isHidden = true
				view.rerender(tree())
			} else mockPostMessage(taskState("b"))
			await waitFor(() => expect(view.queryByRole("menu")).not.toBeInTheDocument())

			if (target === "secondary view") {
				expect(view.queryByRole("group", { name: "common:chatToolbar.label" })).not.toBeInTheDocument()
				props.isHidden = false
				view.rerender(tree())
			} else mockPostMessage(taskState("a"))
			await waitFor(() => expect(input).toHaveValue("Keep unsent guidance"))
		},
	)

	it("keeps only task navigation in an active sidebar and preserves the unsent draft while switching", async () => {
		const view = renderChatView()
		const currentTaskItem = {
			id: "sidebar-active",
			task: "Original sidebar prompt",
			displayName: "Sidebar chat",
			ts: 1,
		}
		mockPostMessage({
			renderContext: "sidebar",
			currentTaskId: currentTaskItem.id,
			currentView: { type: "task", taskId: currentTaskItem.id },
			currentTaskItem,
			taskHistory: [
				currentTaskItem,
				{ ...currentTaskItem, id: "sidebar-other", task: "Other chat", displayName: "Other chat" },
			],
			clineMessages: [{ type: "say", say: "task", ts: 1, text: currentTaskItem.task }],
		})
		await view.findByRole("button", { name: "history:backToHome" })
		const toolbar = view.getByRole("group", { name: "common:chatToolbar.label" })
		expect(within(toolbar).queryByText("Sidebar chat")).not.toBeInTheDocument()
		expect(
			within(toolbar)
				.getAllByRole("button")
				.map((button) => button.getAttribute("aria-label")),
		).toEqual(["history:backToHome", "history:switchChat"])
		for (const action of ["newChat", "settings", "tickets", "more"]) {
			expect(
				within(toolbar).queryByRole("button", { name: `common:chatToolbar.${action}` }),
			).not.toBeInTheDocument()
		}
		const input = view.getByTestId("chat-textarea").querySelector("input")!
		fireEvent.change(input, { target: { value: "Keep sidebar guidance" } })
		fireEvent.click(within(toolbar).getByRole("button", { name: "history:switchChat" }))
		fireEvent.click(await view.findByTestId("task-item-sidebar-other"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "sidebar-other" })
		expect(input).toHaveValue("Keep sidebar guidance")
	})

	it.each(["sidebar", "editor"])(
		"returns from a running %s chat to home and restores its draft when reopened",
		async (renderContext) => {
			const view = renderChatView()
			const currentTaskItem = {
				id: `${renderContext}-running`,
				task: "Keep the running task",
				displayName: "A saved chat name",
				ts: 1,
			}
			const taskState: Partial<ExtensionState> = {
				renderContext,
				showWorktreesInHomeScreen: false,
				currentTaskId: currentTaskItem.id,
				currentView: { type: "task", taskId: currentTaskItem.id },
				currentTaskItem,
				taskHistory: [currentTaskItem],
				clineMessages: [
					{ type: "say", say: "task", ts: 1, text: currentTaskItem.task },
					{ type: "say", say: "api_req_started", ts: 2, text: "{}" },
				],
			}
			mockPostMessage(taskState)
			const back = await view.findByRole("button", { name: "history:backToHome" })
			const toolbar = view.getByRole("group", { name: "common:chatToolbar.label" })
			expect(
				within(toolbar)
					.getAllByRole("button")
					.slice(0, 2)
					.map((button) => button.getAttribute("aria-label")),
			).toEqual(["history:backToHome", "history:switchChat"])
			expect(within(toolbar).queryByText(currentTaskItem.displayName)).not.toBeInTheDocument()
			expect(
				within(view.getByTestId("chat-transcript-viewport")).getByText(currentTaskItem.task),
			).toBeInTheDocument()
			fireEvent.change(view.getByTestId("chat-textarea").querySelector("input")!, {
				target: { value: "Keep my task draft" },
			})
			vi.mocked(vscode.postMessage).mockClear()
			fireEvent.click(back)
			await view.findByTestId("alpha-home-brand")
			expect(vi.mocked(vscode.postMessage).mock.calls).toEqual([[{ type: "startBlankTask" }]])
			expect(view.queryByRole("button", { name: "history:backToHome" })).not.toBeInTheDocument()
			expect(view.queryByRole("button", { name: "history:switchChat" })).not.toBeInTheDocument()
			expect(view.getByTestId("chat-textarea").querySelector("input")).toHaveValue("")

			mockPostMessage({
				renderContext,
				showWorktreesInHomeScreen: false,
				currentTaskId: undefined,
				currentView: { type: "newTaskDraft" },
				currentTaskItem: undefined,
				clineMessages: [],
				taskHistory: [currentTaskItem],
			})
			fireEvent.click(await view.findByTestId(`task-item-${currentTaskItem.id}`))
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "showTaskWithId",
				text: currentTaskItem.id,
			})
			mockPostMessage(taskState)
			await view.findByRole("button", { name: "history:backToHome" })
			expect(view.queryByTestId("alpha-home-brand")).not.toBeInTheDocument()
			expect(view.getByTestId("chat-textarea").querySelector("input")).toHaveValue("Keep my task draft")
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "clearTask" }))
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "cancelTask" }))
		},
	)

	it("reopens the same chat before the host acknowledges returning home", async () => {
		const view = renderChatView()
		const currentTaskItem = { id: "reopen-before-draft", task: "Reopen this chat", ts: 1 }
		mockPostMessage({
			currentTaskId: currentTaskItem.id,
			currentView: { type: "task", taskId: currentTaskItem.id },
			currentTaskItem,
			taskHistory: [currentTaskItem],
			clineMessages: [{ type: "say", say: "task", ts: 1, text: currentTaskItem.task }],
		})
		fireEvent.click(await view.findByRole("button", { name: "history:backToHome" }))
		await view.findByTestId("alpha-home-brand")

		// The home snapshot may still be awaiting host publication when the user reopens this chat.
		fireEvent.click(await view.findByTestId(`task-item-${currentTaskItem.id}`))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: currentTaskItem.id })
		await view.findByRole("button", { name: "history:backToHome" })
		expect(view.queryByTestId("alpha-home-brand")).not.toBeInTheDocument()
	})

	it("keeps the complete fallback toolbar on an empty editor chat without adding a New chat heading", async () => {
		const view = renderChatView()
		mockPostMessage({
			renderContext: "editor",
			currentTaskId: undefined,
			currentTaskItem: undefined,
			clineMessages: [],
		})
		const toolbar = await view.findByRole("group", { name: "common:chatToolbar.label" })
		for (const action of ["newChat", "settings", "tickets", "more"]) {
			expect(within(toolbar).getByRole("button", { name: `common:chatToolbar.${action}` })).toBeInTheDocument()
		}
		expect(within(toolbar).queryByText("common:chatToolbar.newChat")).not.toBeInTheDocument()
		expect(within(toolbar).queryByRole("button", { name: "history:backToHome" })).not.toBeInTheDocument()
		expect(within(toolbar).queryByRole("button", { name: "history:switchChat" })).not.toBeInTheDocument()
	})

	it("keeps the context meter inside the new-chat composer", () => {
		const view = renderChatView()
		mockPostMessage({ currentTaskId: undefined, currentTaskItem: undefined, clineMessages: [] })
		expect(within(view.getByTestId("chat-textarea")).getByRole("progressbar")).toBeInTheDocument()
		expect(view.getAllByRole("progressbar")).toHaveLength(1)
	})
})

describe("ChatView async user input", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each(["askResponse", "queueMessage", "resumeCompletedTask"] as const)(
		"allows a rejected async answer to retry through %s with a new receipt",
		async (command) => {
			const taskId = `async-rejected-${command}`
			const view = renderChatView()
			mockPostMessage({
				currentTaskId: taskId,
				currentView: { type: "task", taskId },
				liveTasksById: {
					[taskId]: {
						id: taskId,
						status: command === "queueMessage" ? "running" : "idle",
						lifecycle: command === "resumeCompletedTask" ? "completed" : "running",
						isActive: true,
						isStreaming: command === "queueMessage",
						isTurnActive: command === "queueMessage",
						isWaitingForInput: false,
						lastUpdatedAt: 3,
						queueCount: 0,
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				},
				clineMessages: [
					{ type: "say", say: "task", ts: 1, text: "Keep the async question" },
					{
						type: "say",
						say: "async_user_input",
						ts: 2,
						asyncUserInput: { questions: [{ title: "Which color?" }] },
					},
				],
			})
			const submit = await waitFor(() => view.getByTestId("async-user-input-submit-2"))
			const status = view.getByTestId("async-user-input-status-2")
			const sendReceipt = async (requestId: string, result: "accepted" | "rejected", owner = taskId) => {
				await act(async () => {
					window.postMessage(
						{
							type: "chatCommandResult",
							chatCommandResult: { requestId, taskId: owner, command, status: result },
						},
						"*",
					)
				})
			}
			vi.mocked(vscode.postMessage).mockClear()
			fireEvent.click(submit)
			await waitFor(() => expect(status).toHaveTextContent("Sending answer"))
			const first = vi.mocked(vscode.postMessage).mock.calls.find(([message]) => message.type === command)![0]
			expect(first.asyncUserInputMessageTs).toBe(2)
			expect(submit).toBeDisabled()
			await sendReceipt(first.requestId!, "accepted", "another-task")
			expect(status).toHaveTextContent("Sending answer")
			await sendReceipt(first.requestId!, "rejected")
			await waitFor(() => expect(status).toHaveTextContent("Awaiting an answer"))
			expect(submit).not.toBeDisabled()

			fireEvent.click(submit)
			await waitFor(() => expect(status).toHaveTextContent("Sending answer"))
			const requests = vi.mocked(vscode.postMessage).mock.calls.filter(([message]) => message.type === command)
			expect(requests).toHaveLength(2)
			const second = requests[1][0]
			expect(second).toMatchObject({ taskId, asyncUserInputMessageTs: 2 })
			expect(second.requestId).not.toBe(first.requestId)
			await sendReceipt(first.requestId!, "accepted")
			expect(status).toHaveTextContent("Sending answer")
			await sendReceipt(second.requestId!, "accepted")
			await waitFor(() => expect(status).toHaveTextContent("Answers sent"))
			expect(submit).toBeDisabled()
		},
	)

	it("sends a submitted card as one ordinary message after later progress", async () => {
		const taskId = "async-question-task"
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Update the status indicator" },
				{
					type: "say",
					say: "async_user_input",
					ts: 2,
					asyncUserInput: { questions: [{ title: "Which color?", options: ["Blue", "Green"] }] },
				},
				{ type: "say", say: "text", ts: 3, text: "I am continuing while you decide." },
			],
		})

		const submit = await waitFor(() => view.getByTestId("async-user-input-submit-2"))
		expect(view.getByTestId("async-user-input-status-2")).toHaveTextContent("Awaiting an answer")
		expect(view.getByTestId("chat-message-1")).toHaveTextContent("I am continuing while you decide.")
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(submit)

		await waitFor(() => expect(view.getByTestId("async-user-input-status-2")).toHaveTextContent("Sending answer"))
		expect(
			vi
				.mocked(vscode.postMessage)
				.mock.calls.map(([message]) => message)
				.filter((message) => ["askResponse", "queueMessage", "newTask"].includes(message.type)),
		).toEqual([
			{
				type: "askResponse",
				askResponse: "messageResponse",
				text: "Use blue and label it Ready.",
				requestId: expect.any(String),
				askMessageTs: undefined,
				images: [],
				taskId,
				asyncUserInputMessageTs: 2,
			},
		])
		const request = vi.mocked(vscode.postMessage).mock.calls.find(([message]) => message.type === "askResponse")![0]
		await act(async () => {
			window.postMessage(
				{
					type: "chatCommandResult",
					chatCommandResult: {
						command: "askResponse",
						requestId: request.requestId,
						taskId,
						status: "accepted",
					},
				},
				"*",
			)
		})
		await waitFor(() => expect(view.getByTestId("async-user-input-status-2")).toHaveTextContent("Answers sent"))
	})

	it("keeps an acknowledged card answered after task state reload", async () => {
		const taskId = "reloaded-async-question-task"
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Update the status indicator" },
				{
					type: "say",
					say: "async_user_input",
					ts: 2,
					isAnswered: true,
					asyncUserInput: { questions: [{ title: "Which color?", options: ["Blue", "Green"] }] },
				},
			],
		})

		await waitFor(() => expect(view.getByTestId("async-user-input-status-2")).toHaveTextContent("Answers sent"))
	})

	it("keeps the card unanswered when a completed-task resume is already pending", async () => {
		const taskId = "completed-async-question-task"
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			liveTasksById: {
				[taskId]: {
					id: taskId,
					status: "idle",
					lifecycle: "completed",
					isActive: false,
					isStreaming: false,
					isTurnActive: false,
					isWaitingForInput: false,
					lastUpdatedAt: 3,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Update the status indicator" },
				{
					type: "say",
					say: "async_user_input",
					ts: 2,
					asyncUserInput: { questions: [{ title: "Which color?", options: ["Blue", "Green"] }] },
				},
				{ type: "say", say: "text", ts: 3, text: "The task completed." },
			],
		})
		const input = (await waitFor(() =>
			view.getByTestId("chat-textarea").querySelector("input"),
		)) as HTMLInputElement
		await waitFor(() => view.getByTestId("async-user-input-submit-2"))
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.change(input, { target: { value: "Resume the task" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "resumeCompletedTask",
				requestId: expect.any(String),
				taskId,
				text: "Resume the task",
				images: [],
			}),
		)
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(view.getByTestId("async-user-input-submit-2"))

		await waitFor(() =>
			expect(view.getByTestId("async-user-input-status-2")).toHaveTextContent("Awaiting an answer"),
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})

describe("ChatView activity trace", () => {
	const focusDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!
	beforeEach(() => installNativeTestFocus())
	afterEach(() => Object.defineProperty(HTMLElement.prototype, "focus", focusDescriptor))
	const turn = (id: string): AlphaMessageTurn => ({ runId: `run-${id}`, turnId: id })
	const runningTask = (id: string) => ({
		id,
		status: "running",
		lifecycle: "running",
		isActive: true,
		isStreaming: true,
		isTurnActive: true,
		isWaitingForInput: false,
		lastUpdatedAt: 1,
		queueCount: 0,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	})

	it("folds one canonical turn across steering and retains its ordinary final during a follow-up and reload", async () => {
		const id = "canonical-turn"
		const first = turn("first")
		const second = turn("second")
		const messages: AlphaMessage[] = [
			{
				ts: 100,
				type: "say",
				say: "task",
				text: "Update the implementation",
				turn: { ...first, inputKind: "start" },
			},
			{ ts: 200, type: "say", say: "text", text: "Inspecting the code", turn: first },
			{ ts: 300, type: "ask", ask: "command", text: "git status", isAnswered: true, turn: first },
			{
				ts: 350,
				type: "say",
				say: "user_feedback",
				text: "Keep the public API",
				turn: { ...first, inputKind: "steer" },
			},
			{ ts: 400, type: "say", say: "reasoning", text: "Preserve compatibility", turn: first },
			{
				ts: 450,
				type: "say",
				say: "tool",
				text: JSON.stringify({ tool: "appliedDiff", path: "src/agent.ts", diff: "+fixed" }),
				turn: first,
			},
			{
				ts: 500,
				type: "say",
				say: "async_user_input",
				asyncUserInput: { questions: [{ title: "Which follow-up?", options: ["Tests", "Types"] }] },
				turn: first,
			},
			{
				ts: 600,
				type: "say",
				say: "text",
				text: "Implementation updated",
				turn: { ...first, terminalStatus: "completed" },
			},
			{
				ts: 700,
				type: "say",
				say: "user_feedback",
				text: "Now verify it",
				turn: { ...second, inputKind: "start" },
			},
			{ ts: 800, type: "ask", ask: "command", text: "pnpm test", isAnswered: true, turn: second },
		]
		const publish = () =>
			mockPostMessage({ currentTaskId: id, clineMessages: messages, liveTasksById: { [id]: runningTask(id) } })
		const view = renderChatView()
		publish()
		const parent = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.workedFor/ }))
		for (const index of [0, 1, 2, 3, 4]) expect(view.getByTestId(`chat-message-${index}`)).not.toBeVisible()
		for (const index of [5, 6, 7]) expect(view.getByTestId(`chat-message-${index}`)).toBeVisible()
		expect(view.getAllByTestId("file-changes-panel")).toHaveLength(1)
		expect(view.getByTestId("file-changes-panel")).toHaveTextContent("src/agent.ts")
		fireEvent.click(parent)
		expect(view.getByTestId("chat-message-2")).toBeVisible()
		expect(view.getByTestId("chat-message-3")).toBeVisible()
		expect(view.getByTestId("chat-message-8")).not.toBeVisible()
		view.unmount()
		const restored = renderChatView()
		publish()
		await waitFor(() =>
			expect(restored.getByRole("button", { name: /chat:activityTrace.workedFor/ })).toHaveAttribute(
				"aria-expanded",
				"false",
			),
		)
		expect(restored.getByTestId("chat-message-2")).not.toBeVisible()
		expect(restored.getByTestId("chat-message-6")).toBeVisible()
	})

	it("restores nested disclosure choices after its completed parent unmounts the details", async () => {
		const first = turn("nested")
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: "nested",
			clineMessages: [
				{
					ts: 100,
					type: "say",
					say: "task",
					text: "Inspect the implementation",
					turn: { ...first, inputKind: "start" },
				},
				{ ts: 200, type: "say", say: "reasoning", text: "Inspection details", turn: first },
				{
					ts: 300,
					type: "say",
					say: "text",
					text: "Inspection complete",
					turn: { ...first, terminalStatus: "completed" },
				},
			],
		})
		const parent = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.workedFor/ }))
		fireEvent.click(parent)
		fireEvent.click(view.getByTestId("reasoning-disclosure-200"))
		expect(view.getByTestId("reasoning-disclosure-200")).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(parent)
		expect(view.queryByTestId("reasoning-disclosure-200")).not.toBeInTheDocument()
		fireEvent.click(parent)
		expect(view.getByTestId("reasoning-disclosure-200")).toHaveAttribute("aria-expanded", "true")
	})

	it("keeps one parent per canonical turn when late output arrives around another completed turn", async () => {
		const view = renderChatView()
		const first = turn("late-first")
		const second = turn("late-second")
		mockPostMessage({
			currentTaskId: "late-output",
			clineMessages: [
				{ ts: 100, type: "say", say: "task", text: "First request", turn: { ...first, inputKind: "start" } },
				{ ts: 200, type: "say", say: "text", text: "First progress", turn: first },
				{
					ts: 300,
					type: "say",
					say: "text",
					text: "First answer",
					turn: { ...first, terminalStatus: "completed" },
				},
				{
					ts: 400,
					type: "say",
					say: "user_feedback",
					text: "Second request",
					turn: { ...second, inputKind: "start" },
				},
				{ ts: 450, type: "say", say: "reasoning", text: "Second progress", turn: second },
				{
					ts: 500,
					type: "say",
					say: "text",
					text: "Second answer",
					turn: { ...second, terminalStatus: "completed" },
				},
				{ ts: 600, type: "ask", ask: "command", text: "Late first-turn output", isAnswered: true, turn: first },
			],
		})
		const parents = await waitFor(() => {
			const controls = view.getAllByRole("button", { name: /chat:activityTrace.workedFor/ })
			expect(controls).toHaveLength(2)
			return controls
		})
		expect(parents[0].getAttribute("aria-controls")!.split(" ")).toHaveLength(2)
		for (const index of [0, 3, 5]) expect(view.getByTestId(`chat-message-${index}`)).not.toBeVisible()
		fireEvent.click(parents[0])
		fireEvent.click(view.getByRole("button", { name: /chat:activityTrace.runningCommands/ }))
		expect(view.getByTestId("chat-message-0")).toBeVisible()
		expect(view.getByTestId("chat-message-5")).toBeVisible()
		expect(view.getByTestId("chat-message-3")).not.toBeVisible()
		for (const index of [1, 2, 4]) expect(view.getByTestId(`chat-message-${index}`)).toBeVisible()
	})

	it("settles completed-turn disclosures beyond the bounded preference cache", () => {
		const view = renderChatView()
		const messages: AlphaMessage[] = Array.from({ length: 2_049 }, (_, index) => {
			const attributedTurn = turn(`bounded-${index}`)
			return [
				{
					ts: index * 3 + 100,
					type: "say" as const,
					say: "user_feedback",
					text: `Prompt ${index}`,
					turn: { ...attributedTurn, inputKind: "start" as const },
				},
				{
					ts: index * 3 + 101,
					type: "say" as const,
					say: "reasoning",
					text: "Inspecting",
					turn: attributedTurn,
				},
				{
					ts: index * 3 + 102,
					type: "say" as const,
					say: "text",
					text: `Answer ${index}`,
					turn: { ...attributedTurn, terminalStatus: "completed" as const },
				},
			]
		}).flat()
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "state", state: { currentTaskId: "bounded-disclosures", clineMessages: messages } },
				}),
			)
		})
		expect(view.getByTestId(`chat-message-${messages.length - 2}`)).toHaveTextContent("Answer 2048")
		const latestTurn = view.getAllByRole("button", { name: /chat:activityTrace.workedFor/ }).at(-1)!
		fireEvent.click(latestTurn)
		expect(latestTurn).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(latestTurn)
		expect(latestTurn).toHaveAttribute("aria-expanded", "false")
	})

	it("retains independent task disclosure choices through navigation and an empty hydration packet", async () => {
		const view = renderChatView()
		const state = (id: string) => ({
			currentTaskId: id,
			currentTaskItem: { id, task: `Prompt ${id}`, ts: 100 },
			clineMessages: [
				{
					ts: 100,
					type: "say" as const,
					say: "task",
					text: `Prompt ${id}`,
					turn: { ...turn(id), inputKind: "start" as const },
				},
				{ ts: 200, type: "say" as const, say: "reasoning", text: `Reasoning ${id}`, turn: turn(id) },
				{
					ts: 300,
					type: "say" as const,
					say: "text",
					text: `Answer ${id}`,
					turn: { ...turn(id), terminalStatus: "completed" as const },
				},
			],
		})
		mockPostMessage(state("a"))
		fireEvent.click(await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.workedFor/ })))
		fireEvent.click(view.getByTestId("reasoning-disclosure-200"))
		mockPostMessage(state("b"))
		await waitFor(() => expect(view.getByText("Prompt b")).toBeVisible())
		expect(view.getByRole("button", { name: /chat:activityTrace.workedFor/ })).toHaveAttribute(
			"aria-expanded",
			"false",
		)
		mockPostMessage({ currentTaskId: "a", currentTaskItem: state("a").currentTaskItem, clineMessages: [] })
		await waitFor(() => expect(view.getByText("Prompt a")).toBeVisible())
		mockPostMessage(state("a"))
		await waitFor(() =>
			expect(view.getByTestId("reasoning-disclosure-200")).toHaveAttribute("aria-expanded", "true"),
		)
		expect(view.getByRole("button", { name: /chat:activityTrace.workedFor/ })).toHaveAttribute(
			"aria-expanded",
			"true",
		)
	})

	it("transfers keyboard focus from an untouched live action header to its completed parent", async () => {
		const user = userEvent.setup()
		const view = renderChatView()
		const first = turn("keyboard")
		const messages: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "task", text: "Check the code", turn: { ...first, inputKind: "start" } },
			{ ts: 200, type: "say", say: "text", text: "Inspecting", turn: first },
			{ ts: 300, type: "ask", ask: "command", text: "git status", isAnswered: true, turn: first },
		]
		mockPostMessage({
			currentTaskId: "keyboard",
			clineMessages: messages,
			liveTasksById: { keyboard: runningTask("keyboard") },
		})
		const action = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.runningCommands/ }))
		view.getByTestId("chat-transcript-scroller").focus()
		await user.tab()
		expect(action).toHaveFocus()
		mockPostMessage({
			currentTaskId: "keyboard",
			clineMessages: [
				...messages,
				{
					ts: 350,
					type: "say",
					say: "user_feedback",
					text: "Also check types",
					turn: { ...first, inputKind: "steer" },
				},
				{ ts: 400, type: "say", say: "text", text: "Checked", turn: { ...first, terminalStatus: "completed" } },
			],
		})
		const parent = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.workedFor/ }))
		expect(action).not.toBeInTheDocument()
		expect(parent).toHaveFocus()
		await user.keyboard("{Enter}")
		expect(parent).toHaveAttribute("aria-expanded", "true")
		await user.keyboard(" ")
		expect(parent).toHaveAttribute("aria-expanded", "false")
	})

	it("retains focused activity and mounted ARIA targets when the live transcript window advances", async () => {
		const user = userEvent.setup()
		const view = renderChatView()
		const publish = (count: number) =>
			mockPostMessage({
				currentTaskId: "window-focus",
				liveTasksById: { "window-focus": runningTask("window-focus") },
				clineMessages: [
					{ ts: 100, type: "say", say: "task", text: "Run checks" },
					...Array.from({ length: count }, (_, index) => ({
						ts: 1000 + index,
						type: "ask" as const,
						ask: "command",
						text: `check ${index}`,
						isAnswered: true,
					})),
				],
			})
		publish(100)
		const previous = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.runningCommands/ }))
		view.getByTestId("chat-load-all").focus()
		await user.tab()
		expect(previous).toHaveFocus()
		publish(101)
		await waitFor(() => expect(previous).not.toBeInTheDocument())
		const current = view.getByRole("button", { name: /chat:activityTrace.runningCommands/ })
		expect(current).toHaveFocus()
		expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-rendered-count", "80")
		for (const id of current.getAttribute("aria-controls")!.split(" "))
			expect(document.getElementById(id)).not.toBeNull()
	})

	it.each(["readFile", "listFilesTopLevel", "appliedDiff"])(
		"keeps a pending or partial %s approval separate from an answered historical row",
		async (tool) => {
			const view = renderChatView()
			const approval: ToolApprovalPrompt = {
				requestId: "pending-approval",
				taskId: "batch-safety",
				toolName: "read_file",
				availableDecisions: ["approve_once", "deny"],
			}
			const publish = (partial: boolean) =>
				mockPostMessage({
					currentTaskId: "batch-safety",
					liveTasksById: { "batch-safety": runningTask("batch-safety") },
					clineMessages: [
						{ ts: 100, type: "say", say: "task", text: "Inspect files" },
						{
							ts: 200,
							type: "ask",
							ask: "tool",
							text: JSON.stringify({ tool, path: "first.ts" }),
							isAnswered: true,
						},
						{
							ts: 300,
							type: "ask",
							ask: "tool",
							text: JSON.stringify({ tool, path: "pending.ts" }),
							partial,
							toolApprovalRequest: approval,
						},
					],
				})
			publish(false)
			const pending = await waitFor(() => view.getByTestId("chat-message-1"))
			expect(pending).toBeVisible()
			expect(pending).toHaveTextContent("pending-approval")
			expect(pending).not.toHaveTextContent("first.ts")
			publish(true)
			await waitFor(() => expect(pending).toHaveTextContent('"partial":true'))
			expect(pending).toBeVisible()
			expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-count", "2")
		},
	)

	it("retains row identity and disclosure when an earlier checkpoint is filtered", async () => {
		const view = renderChatView()
		const publish = (suppressed: boolean) =>
			mockPostMessage({
				currentTaskId: "stable-row",
				clineMessages: [
					{ ts: 100, type: "say", say: "task", text: "Inspect the code" },
					{
						ts: 150,
						type: "say",
						say: "checkpoint_saved",
						text: "checkpoint",
						checkpoint: { suppressMessage: suppressed },
					},
					{ ts: 200, type: "say", say: "reasoning", text: "Stable reasoning" },
				],
			})
		publish(false)
		const reasoning = await waitFor(() => view.getByTestId("reasoning-disclosure-200"))
		fireEvent.click(reasoning)
		publish(true)
		await waitFor(() => expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-count", "1"))
		expect(view.getByTestId("reasoning-disclosure-200")).toBe(reasoning)
		expect(reasoning).toHaveAttribute("aria-expanded", "true")
	})

	it("does not move composer focus when a canonical turn completes", async () => {
		const view = renderChatView()
		const first = turn("composer-focus")
		const messages: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "task", text: "Run checks", turn: { ...first, inputKind: "start" } },
			{ ts: 200, type: "ask", ask: "command", text: "pnpm test", isAnswered: true, turn: first },
		]
		mockPostMessage({ currentTaskId: "composer-focus", clineMessages: messages })
		await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.runningCommands/ }))
		const input = view.getByTestId("chat-textarea").querySelector("input")!
		input.focus()
		mockPostMessage({
			currentTaskId: "composer-focus",
			clineMessages: [
				...messages,
				{ ts: 300, type: "say", say: "text", text: "Done", turn: { ...first, terminalStatus: "completed" } },
			],
		})
		await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.workedFor/ }))
		expect(input).toHaveFocus()
	})

	it("animates a folded trace only while it contains the active tail work", async () => {
		const view = renderChatView()
		const taskId = "active-trace"
		const messages: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "task", text: "Run the checks" },
			{ ts: 200, type: "ask", ask: "command", text: "pnpm test", isAnswered: true },
		]
		const runningTask = {
			id: taskId,
			status: "running",
			lifecycle: "running",
			isActive: true,
			isStreaming: true,
			isTurnActive: true,
			isWaitingForInput: false,
			lastUpdatedAt: 200,
			queueCount: 0,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		mockPostMessage({ currentTaskId: taskId, clineMessages: messages, liveTasksById: { [taskId]: runningTask } })

		const toggle = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.runningCommands/ }))
		expect(toggle).toHaveAttribute("aria-busy", "true")
		expect(toggle).toHaveClass("activity-trace-toggle--active")

		mockPostMessage({
			currentTaskId: taskId,
			clineMessages: [...messages, { ts: 300, type: "say", say: "text", text: "The command finished." }],
			liveTasksById: { [taskId]: { ...runningTask, lastUpdatedAt: 300 } },
		})
		await waitFor(() => expect(toggle).not.toHaveClass("activity-trace-toggle--active"))
		expect(toggle).not.toHaveAttribute("aria-busy")
	})

	it("folds live action runs between visible progress messages and preserves pending approvals", async () => {
		const view = renderChatView()
		const messages: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "task", text: "Update the code" },
			{ ts: 200, type: "say", say: "text", text: "I am inspecting the implementation." },
			{ ts: 300, type: "ask", ask: "command", text: "rg -n implementation src" },
			{ ts: 400, type: "say", say: "command_output", text: "src/agent.ts:10" },
			{ ts: 500, type: "say", say: "reasoning", text: "The execution path needs a change." },
			{
				ts: 600,
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "editedExistingFile", path: "src/agent.ts" }),
			},
			{ ts: 700, type: "say", say: "text", text: "The edit is in place." },
		]
		mockPostMessage({
			currentTaskId: "live-actions",
			clineMessages: messages,
			liveTasksById: {
				"live-actions": {
					id: "live-actions",
					status: "running",
					lifecycle: "running",
					isActive: true,
					isStreaming: true,
					isTurnActive: true,
					isWaitingForInput: false,
					lastUpdatedAt: 700,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
		})
		await waitFor(() => expect(view.getByTestId("chat-message-0")).toBeVisible())
		for (const index of [0, 2, 4]) expect(view.getByTestId(`chat-message-${index}`)).toBeVisible()
		for (const index of [1, 3]) expect(view.getByTestId(`chat-message-${index}`)).not.toBeVisible()
		expect(within(view.getByTestId("chat-message-1")).getByTestId("chat-row")).toBeInTheDocument()
		const toggles = view.getAllByRole("button", { name: /chat:activityTrace\.(runningCommands|editingFiles)/ })
		expect(toggles).toHaveLength(2)
		fireEvent.click(toggles[0])
		expect(view.getByTestId("chat-message-1")).toBeVisible()
		expect(view.getByTestId("chat-message-3")).not.toBeVisible()

		mockPostMessage({
			currentTaskId: "live-actions",
			clineMessages: [
				...messages,
				{
					ts: 800,
					type: "ask",
					ask: "command",
					text: "pnpm test",
					toolApprovalRequest: {
						requestId: "approval-1",
						taskId: "live-actions",
						toolName: "exec_command",
						availableDecisions: ["approve_once", "deny", "abort"],
					},
				},
			],
		})
		await waitFor(() => expect(view.getByTestId("chat-message-5")).toBeVisible())
		expect(view.getByTestId("chat-message-5")).toHaveTextContent("pnpm test")
	})

	it("keeps the API failure row visible when the failure ask is filtered from the trace", async () => {
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: "failed-api",
			clineMessages: [
				{ ts: 1, type: "say", say: "task", text: "Run a check" },
				{ ts: 2, type: "say", say: "api_req_started", text: "{}" },
				{ ts: 3, type: "ask", ask: "api_req_failed", text: "The provider is unavailable" },
			],
		})
		await waitFor(() => expect(view.getByTestId("chat-message-0")).toBeVisible())
		expect(view.queryByRole("button", { name: /chat:activityTrace.working/ })).not.toBeInTheDocument()
	})

	it("folds completed turns while keeping a live follow-up independently expandable", async () => {
		const taskId = "successive-traces"
		const firstTurn: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "task", text: "Run the tests" },
			{ ts: 1000, type: "say", say: "reasoning", text: "Inspecting tests" },
			{ ts: 2000, type: "ask", ask: "command", text: "pnpm test", isAnswered: true },
			{ ts: 3000, type: "say", say: "completion_result", text: "First answer" },
		]
		const followup: AlphaMessage[] = [
			{ ts: 4000, type: "say", say: "user_feedback", text: "Now check the types" },
			{ ts: 5000, type: "say", say: "reasoning", text: "Checking types" },
			{ ts: 6000, type: "ask", ask: "command", text: "pnpm check-types", isAnswered: true },
		]
		const publish = (clineMessages: AlphaMessage[]) => mockPostMessage({ currentTaskId: taskId, clineMessages })
		const view = renderChatView()
		publish(firstTurn)
		const completedTrace = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.workedFor/ }))
		for (const index of [0, 1]) expect(view.getByTestId(`chat-message-${index}`)).not.toBeVisible()
		expect(view.getByTestId("chat-message-2")).toBeVisible()
		publish([...firstTurn, ...followup])
		await waitFor(() => expect(view.getByTestId("chat-message-3")).toBeVisible())
		for (const index of [0, 1, 5]) expect(view.getByTestId(`chat-message-${index}`)).not.toBeVisible()
		for (const index of [2, 3, 4]) expect(view.getByTestId(`chat-message-${index}`)).toBeVisible()
		expect(view.getAllByRole("button", { name: /chat:activityTrace.runningCommands/ })).toHaveLength(1)
		fireEvent.click(completedTrace)
		expect(view.getByTestId("chat-message-0")).toBeVisible()
		expect(view.getByTestId("chat-message-1")).not.toBeVisible()
		fireEvent.click(view.getAllByRole("button", { name: /chat:activityTrace.runningCommands/ })[0])
		expect(view.getByTestId("chat-message-1")).toBeVisible()
		expect(view.getByTestId("chat-message-5")).not.toBeVisible()
		view.unmount()
		const reloaded = renderChatView()
		publish([...firstTurn, ...followup])
		await waitFor(() => expect(reloaded.getByTestId("chat-message-3")).toBeVisible())
		for (const index of [0, 1, 5]) expect(reloaded.getByTestId(`chat-message-${index}`)).not.toBeVisible()
	})

	it("keeps completed trace details unmounted during a live follow-up", async () => {
		const view = renderChatView()
		const taskId = "long-completed-trace"
		const historicalDetailCount = 256
		const firstTurn: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "task", text: "Inspect the implementation" },
			...Array.from(
				{ length: historicalDetailCount },
				(_, index): AlphaMessage => ({
					ts: 200 + index,
					type: "say",
					say: "reasoning",
					text: `Inspection detail ${index}`,
				}),
			),
			{ ts: 1000, type: "say", say: "completion_result", text: "Inspection complete." },
		]
		mockPostMessage({ currentTaskId: taskId, clineMessages: firstTurn })
		fireEvent.click(await waitFor(() => view.getByTestId("chat-load-all")))
		const completedTrace = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.workedFor/ }))
		expect(view.getAllByTestId("chat-row")).toHaveLength(2)

		mockPostMessage({
			currentTaskId: taskId,
			clineMessages: [
				...firstTurn,
				{ ts: 2000, type: "say", say: "user_feedback", text: "Now run the checks" },
				{ ts: 3000, type: "ask", ask: "command", text: "pnpm check-types", isAnswered: true },
			],
			liveTasksById: {
				[taskId]: {
					id: taskId,
					status: "running",
					lifecycle: "running",
					isActive: true,
					isStreaming: true,
					isTurnActive: true,
					isWaitingForInput: false,
					lastUpdatedAt: 3000,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
		})
		const liveAction = await waitFor(() => view.getByTestId(`chat-message-${historicalDetailCount + 2}`))
		const liveRow = within(liveAction).getByTestId("chat-row")
		expect(liveAction).not.toBeVisible()
		expect(view.getAllByTestId("chat-row").length).toBe(4)
		for (const index of [0, historicalDetailCount - 1]) {
			expect(within(view.getByTestId(`chat-message-${index}`)).queryByTestId("chat-row")).not.toBeInTheDocument()
		}

		fireEvent.click(completedTrace)
		expect(view.getAllByTestId("chat-row").length).toBe(historicalDetailCount + 4)
		expect(view.getByTestId("chat-message-0")).toBeVisible()
		expect(within(liveAction).getByTestId("chat-row")).toBe(liveRow)
		fireEvent.click(completedTrace)
		expect(view.getAllByTestId("chat-row").length).toBe(4)
		expect(within(liveAction).getByTestId("chat-row")).toBe(liveRow)
	})

	it("preserves an opened action group when the task completes and still allows closing it", async () => {
		const view = renderChatView()
		const taskId = "completed-actions"
		const messages: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "task", text: "Run the tests" },
			{ ts: 200, type: "ask", ask: "command", text: "pnpm test", isAnswered: true },
			{ ts: 300, type: "say", say: "text", text: "Tests are done." },
		]
		const runningTask = {
			id: taskId,
			status: "running",
			lifecycle: "running",
			isActive: true,
			isStreaming: true,
			isTurnActive: true,
			isWaitingForInput: false,
			lastUpdatedAt: 200,
			queueCount: 0,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		mockPostMessage({ currentTaskId: taskId, clineMessages: messages, liveTasksById: { [taskId]: runningTask } })
		const toggle = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.runningCommands/ }))
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(view.getByTestId("chat-message-0")).toBeVisible()

		mockPostMessage({
			currentTaskId: taskId,
			clineMessages: messages,
			liveTasksById: {
				[taskId]: {
					...runningTask,
					status: "completed",
					lifecycle: "completed",
					isActive: false,
					isStreaming: false,
					isTurnActive: false,
				},
			},
		})
		await waitFor(() => expect(toggle).not.toHaveAttribute("aria-busy"))
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(view.getByTestId("chat-message-0")).toBeVisible()
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(view.getByTestId("chat-message-0")).not.toBeVisible()
	})

	it("preserves an opened action group at the completion prompt before lifecycle state catches up", async () => {
		const view = renderChatView()
		const taskId = "completion-prompt-actions"
		const messages: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "task", text: "Run the tests" },
			{ ts: 200, type: "ask", ask: "command", text: "pnpm test", isAnswered: true },
			{ ts: 300, type: "say", say: "text", text: "Tests are done." },
		]
		mockPostMessage({ currentTaskId: taskId, clineMessages: messages })
		const toggle = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.runningCommands/ }))
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-expanded", "true")

		mockPostMessage({
			currentTaskId: taskId,
			clineMessages: [
				...messages,
				{ ts: 400, type: "say", say: "completion_result", text: "Done." },
				{ ts: 500, type: "ask", ask: "completion_result", text: "" },
			],
		})
		await waitFor(() => expect(view.getByTestId("chat-message-2")).toBeVisible())
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(view.getByTestId("chat-message-0")).toBeVisible()
	})

	it("keeps independent action disclosure choices when a completed turn gains a worked summary", async () => {
		const view = renderChatView()
		const messages: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "task", text: "Check and edit" },
			{ ts: 200, type: "say", say: "text", text: "Inspecting the implementation" },
			{ ts: 300, type: "ask", ask: "command", text: "git status", isAnswered: true },
			{ ts: 400, type: "say", say: "text", text: "Now updating the file" },
			{
				ts: 500,
				type: "say",
				say: "tool",
				text: JSON.stringify({ tool: "appliedDiff", path: "src/one.ts", diff: "+one" }),
			},
		]
		mockPostMessage({ currentTaskId: "independent-actions", clineMessages: messages })
		const commands = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.runningCommands/ }))
		const edits = view.getByRole("button", { name: /chat:activityTrace.editingFiles/ })
		fireEvent.click(commands)
		fireEvent.click(commands)
		fireEvent.click(edits)
		const progressing: AlphaMessage[] = [
			...messages,
			{ ts: 550, type: "say", say: "text", text: "Verifying the edit", partial: true },
			{ ts: 560, type: "ask", ask: "command", text: "pnpm test", isAnswered: true },
		]
		mockPostMessage({ currentTaskId: "independent-actions", clineMessages: progressing })
		await waitFor(() =>
			expect(view.getAllByRole("button", { name: /chat:activityTrace.runningCommands/ })).toHaveLength(2),
		)
		expect(commands).toHaveAttribute("aria-expanded", "false")
		expect(edits).toHaveAttribute("aria-expanded", "true")
		expect(view.getAllByRole("button", { name: /chat:activityTrace.runningCommands/ })[1]).toHaveAttribute(
			"aria-expanded",
			"false",
		)
		const completed: AlphaMessage[] = [
			...progressing,
			{ ts: 600, type: "say", say: "completion_result", text: "Done" },
		]
		mockPostMessage({
			currentTaskId: "independent-actions",
			clineMessages: completed,
		})
		await waitFor(() => expect(view.getByTestId("chat-message-6")).toBeVisible())
		const parent = view.getByRole("button", { name: /chat:activityTrace.workedFor/ })
		expect(parent).toHaveAttribute("aria-expanded", "true")
		expect(commands).toBeInTheDocument()
		expect(commands).toHaveAttribute("aria-expanded", "false")
		expect(edits).toBeInTheDocument()
		expect(edits).toHaveAttribute("aria-expanded", "true")
		expect(view.getByTestId("chat-message-1")).not.toBeVisible()
		expect(view.getByTestId("chat-message-3")).toBeVisible()
		fireEvent.click(parent)
		for (const index of [0, 1, 2, 3, 4, 5]) expect(view.getByTestId(`chat-message-${index}`)).not.toBeVisible()
		fireEvent.click(parent)
		const reopenedCommands = view.getAllByRole("button", { name: /chat:activityTrace.runningCommands/ })[0]
		const reopenedEdits = view.getByRole("button", { name: /chat:activityTrace.editingFiles/ })
		expect(reopenedCommands).toHaveAttribute("aria-expanded", "false")
		expect(reopenedEdits).toHaveAttribute("aria-expanded", "true")
		const nextTurn: AlphaMessage[] = [
			...completed,
			{ ts: 700, type: "say", say: "user_feedback", text: "Check the types too" },
			{ ts: 800, type: "ask", ask: "command", text: "pnpm check-types", isAnswered: true },
			{ ts: 900, type: "say", say: "completion_result", text: "Types checked" },
		]
		mockPostMessage({ currentTaskId: "independent-actions", clineMessages: nextTurn })
		const untouchedTurn = await waitFor(() => {
			const turns = view.getAllByRole("button", { name: /chat:activityTrace.workedFor/ })
			expect(turns).toHaveLength(2)
			return turns[1]
		})
		expect(untouchedTurn).toHaveAttribute("aria-expanded", "false")
		expect(reopenedCommands).toHaveAttribute("aria-expanded", "false")
		expect(reopenedEdits).toHaveAttribute("aria-expanded", "true")
		mockPostMessage({ currentTaskId: "another-actions-task", clineMessages: nextTurn })
		await waitFor(() =>
			expect(view.getAllByRole("button", { name: /chat:activityTrace.workedFor/ })).toHaveLength(2),
		)
		for (const toggle of view.getAllByRole("button", { name: /chat:activityTrace.workedFor/ })) {
			expect(toggle).toHaveAttribute("aria-expanded", "false")
		}
	})

	it("restores focus to the action toggle when collapsing focused details", async () => {
		const view = renderChatView()
		const messages: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "task", text: "Run tests" },
			{ ts: 200, type: "say", say: "text", text: "Checking" },
			{ ts: 300, type: "ask", ask: "command", text: "pnpm test" },
			{ ts: 400, type: "say", say: "text", text: "The command finished." },
		]
		mockPostMessage({ currentTaskId: "focus-actions", clineMessages: messages })
		const toggle = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.runningCommands/ }))
		fireEvent.click(toggle)
		const focusedElements: HTMLElement[] = []
		Object.defineProperty(HTMLElement.prototype, "focus", {
			configurable: true,
			value: function (this: HTMLElement) {
				focusedElements.push(this)
			},
		})
		fireEvent.focus(view.getByTestId("chat-message-1"))
		fireEvent.click(toggle)
		expect(view.getByTestId("chat-message-1")).not.toBeVisible()
		expect(focusedElements).toContain(toggle)
	})
	it("does not mount transcript rows while the chat tab is hidden", async () => {
		const view = renderChatView({ isHidden: true })
		mockPostMessage({
			currentTaskId: "hidden-tab",
			clineMessages: [
				{ ts: 100, type: "say", say: "task", text: "Run the tests" },
				{ ts: 1000, type: "say", say: "text", text: "Working" },
			],
		})
		await waitFor(() => expect(view.getByTestId("chat-view")).toHaveClass("hidden"))
		expect(view.queryByTestId("chat-message-0")).not.toBeInTheDocument()
		expect(view.queryByText("Working")).not.toBeInTheDocument()
	})

	it("keeps older transcript rows unmounted until Load older is clicked", async () => {
		const view = renderChatView()
		const clineMessages: AlphaMessage[] = Array.from({ length: 90 }, (_, index) => ({
			ts: index + 1,
			type: "say",
			say: index === 0 ? "task" : "text",
			text: `row-${index}`,
		}))
		mockPostMessage({ currentTaskId: "long-task", clineMessages })
		await waitFor(() => expect(view.getByTestId("chat-load-older")).toBeInTheDocument())
		expect(view.queryByTestId("chat-message-0")).not.toBeInTheDocument()
		fireEvent.click(view.getByTestId("chat-load-all"))
		await waitFor(() => expect(view.getByTestId("chat-message-0")).toBeInTheDocument())
		expect(view.queryByTestId("chat-load-older")).not.toBeInTheDocument()
	})

	it("bounds a restored live transcript when mounted after state hydration", async () => {
		// App mounts ChatView only after hydration; mounting before it masks a fixed render-window start.
		function HydratedChatView() {
			const { didHydrateState } = useExtensionState()
			return didHydrateState ? <ChatView {...defaultProps} /> : null
		}
		const view = render(
			<ExtensionStateContextProvider>
				<QueryClientProvider client={queryClient}>
					<HydratedChatView />
				</QueryClientProvider>
			</ExtensionStateContextProvider>,
		)
		const taskId = "restored-long-running-task"
		const state = {
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			liveTasksById: {
				[taskId]: {
					id: taskId,
					status: "running",
					lifecycle: "running",
					isActive: true,
					isTurnActive: true,
					isStreaming: true,
					isWaitingForInput: false,
				},
			},
		}
		const prompt: AlphaMessage = { ts: 1, type: "say", say: "task", text: "Continue the large project" }
		mockPostMessage({ ...state, clineMessages: [prompt] })
		await view.findByTestId("chat-transcript-content")

		const messages: AlphaMessage[] = Array.from({ length: 2_000 }, (_, index) => ({
			ts: index + 2,
			type: "say",
			say: "tool",
			text: JSON.stringify({ tool: "readFile", path: `src/file-${index}.ts`, content: `src/file-${index}.ts` }),
		}))
		for (let count = 100; count <= messages.length; count += 100) {
			mockPostMessage({ ...state, clineMessages: [prompt, ...messages.slice(0, count)] })
			await waitFor(() =>
				expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-count", String(count)),
			)
		}

		expect(view.getByRole("group", { name: "common:chatToolbar.label" })).toBeInTheDocument()
		expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-rendered-count", "80")
		expect(view.container.querySelectorAll("[data-chat-message-index]")).toHaveLength(80)

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "condenseTaskContextStarted", text: taskId } }),
			)
		})
		expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-count", "2001")
		expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-rendered-count", "80")
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "condenseTaskContextResponse", text: taskId } }),
			)
		})
		expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-count", "2000")
		expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-rendered-count", "80")
		expect(view.getByRole("group", { name: "common:chatToolbar.label" })).toBeInTheDocument()
	})

	it("preserves browsing rows and checkpoint navigation until returning to the latest output", async () => {
		const view = renderChatView()
		const taskId = "browsing-long-running-task"
		const messages: AlphaMessage[] = Array.from({ length: 400 }, (_, index) => ({
			ts: index + 2,
			type: "say",
			say: index === 30 ? "checkpoint_saved" : "text",
			text: index === 30 ? "checkpoint-30" : `Progress ${index}`,
		}))
		const publish = (count: number) =>
			mockPostMessage({
				currentTaskId: taskId,
				currentView: { type: "task", taskId },
				liveTasksById: {
					[taskId]: {
						id: taskId,
						status: "running",
						lifecycle: "running",
						isActive: true,
						isTurnActive: true,
						isStreaming: true,
						isWaitingForInput: false,
					},
				},
				clineMessages: [
					{ ts: 1, type: "say", say: "task", text: "Continue the large project" },
					...messages.slice(0, count),
				],
			})
		publish(200)
		const firstBrowsingRow = await view.findByTestId("chat-message-120")
		const scroller = view.getByTestId("chat-transcript-scroller")
		Object.defineProperties(scroller, {
			scrollHeight: { configurable: true, value: 10_000 },
			clientHeight: { configurable: true, value: 400 },
			scrollTop: { configurable: true, writable: true, value: 9_000 },
		})
		fireEvent.wheel(scroller, { deltaY: -100 })
		await view.findByRole("button", { name: "chat:scrollToBottom" })

		publish(300)
		await waitFor(() => expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-count", "300"))
		expect(view.getByTestId("chat-message-120")).toBe(firstBrowsingRow)
		expect(scroller.scrollTop).toBe(9_000)

		fireEvent.click(view.getByRole("button", { name: "chat:scrollToLatestCheckpoint" }))
		const checkpointRow = await view.findByTestId("chat-message-30")
		expect(checkpointRow.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" })
		publish(400)
		await waitFor(() => expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-count", "400"))
		expect(view.getByTestId("chat-message-30")).toBe(checkpointRow)

		fireEvent.click(view.getByTestId("chat-load-older"))
		expect(view.getByTestId("chat-message-0")).toBeInTheDocument()
		expect(view.queryByTestId("chat-load-older")).not.toBeInTheDocument()
		const retainedLatestRow = view.getByTestId("chat-message-399")
		fireEvent.click(view.getByRole("button", { name: "chat:scrollToBottom" }))
		expect(view.getByTestId("chat-transcript-content")).toHaveAttribute("data-rendered-count", "80")
		expect(view.queryByTestId("chat-message-30")).not.toBeInTheDocument()
		expect(view.getByTestId("chat-message-399")).toBe(retainedLatestRow)
	})
})

describe("ChatView file-change summaries", () => {
	it("preserves each turn panel's disclosure while its last message changes", async () => {
		const view = renderChatView()
		const messages: AlphaMessage[] = [
			{ type: "say", say: "task", ts: 100, text: "Edit a file" },
			{
				type: "say",
				say: "tool",
				ts: 200,
				text: JSON.stringify({ tool: "appliedDiff", path: "first.ts", diff: "+first" }),
			},
		]
		const publish = (clineMessages: AlphaMessage[], taskId = "sticky-file-review") =>
			mockPostMessage({ currentTaskId: taskId, clineMessages })
		publish(messages)
		const panel = await waitFor(() => view.getByTestId("file-changes-panel"))
		const toggle = within(panel).getByRole("button", { name: "Review changes" })
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(toggle)
		const progressing = [
			...messages,
			{ type: "say", say: "text", ts: 300, text: "Checking", partial: true } as AlphaMessage,
		]
		publish(progressing)
		await waitFor(() => expect(view.getByTestId("chat-message-1")).toHaveTextContent("Checking"))
		expect(view.getByTestId("file-changes-panel")).toBe(panel)
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		publish([
			...progressing.slice(0, -1),
			{ type: "say", say: "completion_result", ts: 300, text: "First response" },
		])
		await waitFor(() => expect(view.getByTestId("chat-message-1")).toHaveTextContent("First response"))
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(toggle)
		const nextTurn: AlphaMessage[] = [
			...messages,
			{ type: "say", say: "completion_result", ts: 300, text: "First response" },
			{ type: "say", say: "user_feedback", ts: 400, text: "Another file" },
			{
				type: "say",
				say: "tool",
				ts: 500,
				text: JSON.stringify({ tool: "appliedDiff", path: "second.ts", diff: "+second" }),
			},
		]
		publish(nextTurn)
		await waitFor(() => expect(view.getAllByTestId("file-changes-panel")).toHaveLength(2))
		expect(view.getAllByTestId("file-changes-panel")[0]).toBe(panel)
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(within(view.getAllByTestId("file-changes-panel")[1]).getByRole("button")).toHaveAttribute(
			"aria-expanded",
			"false",
		)
		publish(messages, "another-task")
		await waitFor(() => expect(view.getAllByTestId("file-changes-panel")).toHaveLength(1))
		expect(within(view.getByTestId("file-changes-panel")).getByRole("button")).toHaveAttribute(
			"aria-expanded",
			"false",
		)
	})

	it("collapses a completed turn into one worked-for trace and leaves its summary and diff visible", async () => {
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: "completed-turn-trace",
			clineMessages: [
				{ type: "say", say: "task", ts: 100, text: "Organize the ignore files" },
				{ type: "say", say: "text", ts: 200, text: "I’ll inspect the ignore rules." },
				{ type: "ask", ask: "command", ts: 300, text: "git status --short", isAnswered: true },
				{ type: "say", say: "command_output", ts: 400, text: " M .gitignore" },
				{
					type: "say",
					say: "tool",
					ts: 500,
					text: JSON.stringify({
						tool: "appliedDiff",
						path: ".gitignore",
						content: "--- old\\n+++ new",
						originalContent: "old\\n",
						finalContent: "new\\n",
					}),
				},
				{ type: "say", say: "completion_result", ts: 700, text: "The ignore rules are organized." },
			],
		})

		const toggle = await waitFor(() => view.getByRole("button", { name: /chat:activityTrace.workedFor/ }))
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		for (const index of [0, 1, 2]) expect(view.getByTestId(`chat-message-${index}`)).not.toBeVisible()
		expect(view.getByText("Organize the ignore files")).toBeVisible()
		expect(view.getByTestId("chat-message-3")).toBeVisible()
		expect(view.getByTestId("file-changes-panel")).toHaveTextContent(".gitignore")

		fireEvent.click(toggle)
		expect(view.getByTestId("chat-message-0")).toBeVisible()
		for (const index of [1, 2]) expect(view.getByTestId(`chat-message-${index}`)).not.toBeVisible()
		fireEvent.click(view.getByRole("button", { name: /chat:activityTrace.working/ }))
		for (const index of [0, 1, 2]) expect(view.getByTestId(`chat-message-${index}`)).toBeVisible()
		expect(view.getByTestId("chat-message-3")).toBeVisible()
		expect(view.getByTestId("file-changes-panel")).toBeVisible()
	})

	it("preserves snapshots when consecutive completed file edits are grouped", async () => {
		const view = renderChatView()
		const edit = (ts: number, path: string): AlphaMessage => ({
			type: "ask",
			ask: "tool",
			ts,
			isAnswered: true,
			text: JSON.stringify({
				tool: "appliedDiff",
				path,
				content: `--- ${path}\n+++ ${path}\n@@ -1 +1 @@\n-old\n+new`,
				originalContent: "old\n",
				finalContent: "new\n",
			}),
		})
		mockPostMessage({
			currentTaskId: "grouped-diff-task",
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Edit two files" },
				edit(2, "bootstrap.py"),
				edit(3, "config.py"),
				{ type: "say", say: "completion_result", ts: 4, text: "Done." },
			],
		})
		await waitFor(() => expect(view.getByTestId("file-changes-panel")).toHaveTextContent("bootstrap.py:snapshot"))
		expect(view.getByTestId("file-changes-panel")).toHaveTextContent("config.py:snapshot")
	})

	it("keeps each turn's applied edits below that turn instead of aggregating them", async () => {
		const view = renderChatView()
		const edit = (ts: number, path: string): AlphaMessage => ({
			type: "ask",
			ask: "tool",
			ts,
			isAnswered: true,
			text: JSON.stringify({ tool: "appliedDiff", path, diff: `+${path}` }),
		})
		const messages: AlphaMessage[] = [
			{ type: "say", say: "task", ts: 1, text: "Initial request" },
			edit(2, "first.ts"),
			{ type: "say", say: "completion_result", ts: 3, text: "First response" },
			{ type: "say", say: "user_feedback", ts: 4, text: "Make another change" },
			edit(5, "second.ts"),
			{ type: "say", say: "completion_result", ts: 6, text: "Second response" },
		]

		mockPostMessage({ currentTaskId: "diff-task", clineMessages: messages })

		await waitFor(() => expect(view.getAllByTestId("file-changes-panel")).toHaveLength(2))
		const panels = view.getAllByTestId("file-changes-panel")
		expect(panels[0]).toHaveTextContent("first.ts")
		expect(panels[1]).toHaveTextContent("second.ts")
		const secondTurnPrompt = view.getByTestId("chat-message-2")
		expect(panels[0].compareDocumentPosition(secondTurnPrompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})
})

describe("ChatView - Plan command", () => {
	beforeEach(() => vi.clearAllMocks())

	it("shows the first prompt immediately and claims its admission before the host responds", async () => {
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: undefined,
			currentTaskItem: undefined,
			currentView: { type: "newTaskDraft" },
			clineMessages: [],
		})
		const input = await waitFor(() => view.getByTestId("chat-textarea").querySelector("input")!)
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.change(input, { target: { value: "Inspect the slow first prompt" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Inspect the slow first prompt")
		expect(view.getByRole("status")).toHaveTextContent("chat:taskStartup.starting")
		expect(input).toHaveAttribute("data-sending-disabled", "true")
		fireEvent.change(input, { target: { value: "Inspect the slow first prompt" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		const submissions = vi.mocked(vscode.postMessage).mock.calls.filter(([message]) => message.type === "newTask")
		expect(submissions).toHaveLength(1)
		expect(submissions[0][0]).toMatchObject({ taskId: expect.any(String), requestId: expect.any(String) })
	})

	it("keeps the first prompt visible through admission and replaces it once the host transcript arrives", async () => {
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: undefined,
			currentTaskItem: undefined,
			currentView: { type: "newTaskDraft" },
			clineMessages: [],
		})
		const input = await waitFor(() => view.getByTestId("chat-textarea").querySelector("input")!)
		fireEvent.change(input, { target: { value: "Keep this prompt visible" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		const submission = vi
			.mocked(vscode.postMessage)
			.mock.calls.findLast(([message]) => message.type === "newTask")![0]
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "chatCommandResult",
						chatCommandResult: {
							command: "newTask",
							taskId: submission.taskId,
							requestId: submission.requestId,
							status: "accepted",
						},
					},
				}),
			)
		})
		mockPostMessage({
			currentTaskId: submission.taskId,
			currentView: { type: "task", taskId: submission.taskId },
			clineMessages: [],
		})
		expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Keep this prompt visible")
		expect(input).toHaveAttribute("data-sending-disabled", "true")
		mockPostMessage({ clineMessages: [{ ts: 123, type: "say", say: "text", text: "Keep this prompt visible" }] })
		await waitFor(() => expect(input).toHaveAttribute("data-sending-disabled", "false"))
		expect(view.getAllByText("Keep this prompt visible")).toHaveLength(1)
		expect(input).toHaveAttribute("data-sending-disabled", "false")
		expect(view.queryByText("chat:taskStartup.starting")).not.toBeInTheDocument()
	})

	it("restores a rejected first prompt once without changing another chat's draft", async () => {
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: undefined,
			currentTaskItem: undefined,
			currentView: { type: "newTaskDraft" },
			clineMessages: [],
		})
		const input = await waitFor(() => view.getByTestId("chat-textarea").querySelector("input")!)
		fireEvent.change(input, { target: { value: "Recover my first prompt" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		const submission = vi
			.mocked(vscode.postMessage)
			.mock.calls.findLast(([message]) => message.type === "newTask")![0]
		mockPostMessage({
			currentTaskId: "other-chat",
			currentView: { type: "task", taskId: "other-chat" },
			clineMessages: [{ ts: 50, type: "say", say: "text", text: "Other chat" }],
		})
		await waitFor(() => expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Other chat"))
		fireEvent.change(input, { target: { value: "Other chat draft" } })
		const reject = {
			type: "chatCommandResult",
			chatCommandResult: {
				command: "newTask",
				taskId: submission.taskId,
				requestId: submission.requestId,
				status: "rejected",
			},
		}
		await act(async () => {
			window.dispatchEvent(new MessageEvent("message", { data: reject }))
			window.dispatchEvent(new MessageEvent("message", { data: reject }))
		})
		expect(input).toHaveValue("Other chat draft")
		expect(view.queryByText("Recover my first prompt")).not.toBeInTheDocument()
		mockPostMessage({
			currentTaskId: undefined,
			currentTaskItem: undefined,
			currentView: { type: "newTaskDraft" },
			clineMessages: [],
		})
		await waitFor(() => expect(input).toHaveValue("Recover my first prompt"))
		expect(view.getByRole("alert")).toHaveTextContent("chat:taskStartup.failed")
		expect(input).toHaveAttribute("data-sending-disabled", "false")
	})

	it("restores the first prompt if admission fails after the empty task has been selected", async () => {
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: undefined,
			currentTaskItem: undefined,
			currentView: { type: "newTaskDraft" },
			clineMessages: [],
		})
		const input = await waitFor(() => view.getByTestId("chat-textarea").querySelector("input")!)
		fireEvent.change(input, { target: { value: "Recover after partial admission" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		const submission = vi
			.mocked(vscode.postMessage)
			.mock.calls.findLast(([message]) => message.type === "newTask")![0]
		mockPostMessage({
			currentTaskId: submission.taskId,
			currentView: { type: "task", taskId: submission.taskId },
			clineMessages: [],
		})
		await view.findByRole("button", { name: "history:backToHome" })
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "chatCommandResult",
						chatCommandResult: {
							command: "newTask",
							taskId: submission.taskId,
							requestId: submission.requestId,
							status: "rejected",
						},
					},
				}),
			)
		})
		await waitFor(() => expect(input).toHaveValue("Recover after partial admission"))
		expect(view.getByRole("alert")).toHaveTextContent("chat:taskStartup.failed")
		expect(input).toHaveAttribute("data-sending-disabled", "false")
	})

	it("includes a selected draft approval mode in the first new task request", async () => {
		const { getByTestId } = renderChatView()
		mockPostMessage({
			mode: "code",
			currentTaskId: undefined,
			currentView: { type: "newTaskDraft" },
			clineMessages: [],
		})

		const composer = await waitFor(() => getByTestId("chat-textarea"))
		expect(composer).toHaveAttribute("data-is-task-draft", "true")
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(getByTestId("mock-draft-approval-ask"))

		const input = composer.querySelector("input") as HTMLInputElement
		fireEvent.change(input, { target: { value: "Start with Ask" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "newTask",
				text: "Start with Ask",
				images: [],
				taskId: expect.any(String),
				requestId: expect.any(String),
				taskApprovalMode: "ask",
			})
		})
	})

	it("sends an inline Plan command as one atomic host request", async () => {
		const { getByTestId } = renderChatView()
		mockPostMessage({ mode: "code", clineMessages: [] })

		const input = await waitFor(() => getByTestId("chat-textarea").querySelector("input") as HTMLInputElement)
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.change(input, { target: { value: "/plan inspect the provider flow" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledTimes(1)
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "newTask",
				text: "/plan inspect the provider flow",
				images: [],
				taskId: expect.any(String),
				requestId: expect.any(String),
			})
		})
		expect(input).toHaveValue("")
	})

	it("uses the mode-only message for /plan without an inline prompt", async () => {
		const { getByTestId } = renderChatView()
		mockPostMessage({ mode: "code", clineMessages: [] })

		const input = await waitFor(() => getByTestId("chat-textarea").querySelector("input") as HTMLInputElement)
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.change(input, { target: { value: "/plan" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledTimes(1)
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "mode", text: "architect" })
		})
		expect(input).toHaveValue("")
	})

	it("keeps /plan attached to a follow-up response for atomic host admission", async () => {
		const { getByTestId } = renderChatView()
		mockPostMessage({
			mode: "code",
			currentTaskId: "active-task",
			currentView: { type: "task", taskId: "active-task" },
			currentTaskItem: { id: "active-task", task: "Current task", ts: 1 },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Current task" },
				{ type: "ask", ask: "followup", ts: 2, text: "What should I inspect?" },
			],
		})

		const input = await waitFor(() => getByTestId("chat-textarea").querySelector("input") as HTMLInputElement)
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.change(input, { target: { value: "/plan inspect the provider flow" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "askResponse",
					askResponse: "messageResponse",
					text: "/plan inspect the provider flow",
					images: [],
					taskId: "active-task",
				}),
			)
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mode" }))
	})

	it("leaves /plan unavailable and unqueued while the model is working", async () => {
		const { getByTestId } = renderChatView()
		mockPostMessage({
			mode: "code",
			currentTaskId: "active-task",
			currentView: { type: "task", taskId: "active-task" },
			currentTaskItem: { id: "active-task", task: "Current task", ts: 1 },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Current task" },
				{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "openai" }) },
			],
		})

		const input = await waitFor(() => getByTestId("chat-textarea").querySelector("input") as HTMLInputElement)
		await waitFor(() => expect(input.getAttribute("data-is-streaming")).toBe("true"))
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.change(input, { target: { value: "/plan inspect the provider flow" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mode" }))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
		expect(input).toHaveValue("/plan inspect the provider flow")
	})
})

describe("ChatView - Context Condensation Requests", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each(["compact the context", "Please condense this conversation.", "can you compact the thread?"])(
		"recognizes explicit condensation request: %s",
		(text) => {
			expect(isContextCondensationRequest(text)).toBe(true)
		},
	)

	it.each(["compact the context and continue", "how much context is left?", "please compact my code"])(
		"does not intercept ordinary messages: %s",
		(text) => {
			expect(isContextCondensationRequest(text)).toBe(false)
		},
	)

	it("routes an explicit request to context condensation for the visible task", async () => {
		const { getByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-to-compact",
			currentView: { type: "task", taskId: "task-to-compact" },
			currentTaskItem: {
				id: "task-to-compact",
				number: 1,
				ts: 100,
				task: "Long-running task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				workspace: "/test/workspace",
			},
			clineMessages: [{ type: "say", say: "task", ts: 100, text: "Long-running task" }],
		})

		const input = await waitFor(() => getByTestId("chat-textarea").querySelector("input") as HTMLInputElement)
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.change(input, { target: { value: "compact the context" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "condenseTaskContextRequest",
				text: "task-to-compact",
			})
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: expect.stringMatching(/^(?:newTask|queueMessage|askResponse)$/) }),
		)
		expect(input).toHaveValue("")
	})
})

describe("ChatView - Follow-up suggestion copy", () => {
	it.each([true, false])("changes mode only for a user click (manual=%s)", async (manual) => {
		const { getByTestId } = renderChatView()
		mockPostMessage({
			mode: "code",
			alwaysAllowModeSwitch: true,
			autoApprovalEnabled: true,
			currentTaskId: "mode-choice",
			currentView: { type: "task", taskId: "mode-choice" },
			clineMessages: [
				{ type: "say", say: "task", ts: 100, text: "Test" },
				{ type: "ask", ask: "followup", ts: 101, text: "Choose" },
			],
		})
		const suggestion = await waitFor(() => getByTestId(manual ? "copy-mode-suggestion" : "auto-mode-suggestion"))
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(suggestion)
		if (manual) expect(vscode.postMessage).toHaveBeenCalledWith({ type: "mode", text: "architect" })
		else expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mode" }))
	})
	beforeEach(() => vi.clearAllMocks())

	it("cancels follow-up auto-approval for the visible task when typing begins", async () => {
		const { getByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-with-followup",
			currentView: { type: "task", taskId: "task-with-followup" },
			clineMessages: [
				{ type: "say", say: "task", ts: 100, text: "Test follow-up" },
				{ type: "ask", ask: "followup", ts: 101, text: "Choose an answer" },
			],
		})

		const input = await waitFor(() => getByTestId("chat-textarea").querySelector("input") as HTMLInputElement)
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.change(input, { target: { value: "I am answering" } })

		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "cancelAutoApproval",
				taskId: "task-with-followup",
			}),
		)
	})

	it("copies a suggested answer without committing its suggested mode", async () => {
		const { getByTestId } = renderChatView()

		mockPostMessage({
			mode: "code",
			currentTaskId: "task-with-followup",
			currentView: { type: "task", taskId: "task-with-followup" },
			currentTaskItem: {
				id: "task-with-followup",
				number: 1,
				ts: 100,
				task: "Test follow-up",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				workspace: "/test/workspace",
			},
			clineMessages: [
				{ type: "say", say: "task", ts: 100, text: "Test follow-up" },
				{ type: "ask", ask: "followup", ts: 101, text: "Choose an answer" },
			],
		})

		const copySuggestion = await waitFor(() => getByTestId("copy-mode-suggestion"))
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(copySuggestion, { shiftKey: true })

		await waitFor(() => expect(mockInputRef.current).toHaveValue("Draft plan"))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mode" }))
	})
})

describe("ChatView - Sound Playing Tests", () => {
	beforeEach(() => vi.clearAllMocks())

	it("plays celebration sound for completion results", async () => {
		renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Add completion result
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now(),
					text: "Task completed successfully",
					partial: false, // Ensure it's not partial
				},
			],
		})

		// Wait for sound to be played
		await waitFor(() => {
			expect(mockPlayFunction).toHaveBeenCalled()
		})
	})

	it("plays progress_loop sound for api failures", async () => {
		renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Add API failure
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "api_req_failed",
					ts: Date.now(),
					text: "API request failed",
					partial: false, // Ensure it's not partial
				},
			],
		})

		// Wait for sound to be played
		await waitFor(() => {
			expect(mockPlayFunction).toHaveBeenCalled()
		})
	})

	it("does not play sound when resuming a task from history", () => {
		renderChatView()

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Hydrate state with a task that has a resumeTaskId (indicating it's resumed from history)
		mockPostMessage({
			resumeTaskId: "task-123",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Resumed task",
				},
				{
					type: "ask",
					ask: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "readFile", path: "test.txt" }),
				},
			],
		})

		// Should not play sound when resuming from history
		expect(mockPlayFunction).not.toHaveBeenCalled()
	})

	it("does not play sound when resuming a completed task from history", () => {
		renderChatView()

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Hydrate state with a completed task that has a resumeTaskId
		mockPostMessage({
			resumeTaskId: "task-123",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Resumed task",
				},
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now(),
					text: "Task completed",
				},
			],
		})

		// Should not play sound for completion when resuming from history
		expect(mockPlayFunction).not.toHaveBeenCalled()
	})
})

describe("ChatView - Focus Grabbing Tests", () => {
	beforeEach(() => vi.clearAllMocks())

	it("does not grab focus when follow-up question presented", async () => {
		const { getByTestId } = renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Wait for the component to fully render and settle before clearing mocks
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Wait for the debounced focus effect to fire (50ms debounce + buffer for CI variability)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100))
		})

		// Clear any initial calls after state has settled
		mockFocus.mockClear()

		// Add follow-up question
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "followup",
					ts: Date.now(),
					text: "Should I continue?",
				},
			],
		})

		// Wait for state update to complete
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Should not grab focus for follow-up questions
		expect(mockFocus).not.toHaveBeenCalled()
	})
})

describe("ChatView - Inline Chats navigation", () => {
	const focusedElements: HTMLElement[] = []
	const focusDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!
	beforeEach(() => {
		vi.clearAllMocks()
		focusedElements.length = 0
		// The shared FAST/JSDOM setup replaces native focus with a no-op.
		Object.defineProperty(HTMLElement.prototype, "focus", {
			configurable: true,
			value: function (this: HTMLElement) {
				focusedElements.push(this)
			},
		})
	})
	afterEach(() => Object.defineProperty(HTMLElement.prototype, "focus", focusDescriptor))

	it("expands View all in place and restores compact home chats on close", async () => {
		const view = renderChatView()
		mockPostMessage({
			clineMessages: [],
			taskHistory: Array.from({ length: 7 }, (_, index) => ({
				id: `recent-${index}`,
				ts: 100 - index,
				task: `Recent chat ${index}`,
			})),
		})
		const expand = await view.findByRole("button", { name: "history:viewAllHistory" })
		const composer = view.getByTestId("chat-textarea").querySelector("input")!
		fireEvent.change(composer, { target: { value: "Home draft" } })
		expect(view.queryByRole("searchbox")).not.toBeInTheDocument()
		expect(view.queryByText("Recent chat 5")).not.toBeInTheDocument()
		fireEvent.click(expand)
		expect(focusedElements.at(-1)).toBe(view.getByRole("searchbox"))
		expect(composer).toHaveValue("Home draft")
		fireEvent.click(view.getByRole("button", { name: "history:closeChats" }))
		expect(view.queryByRole("searchbox")).not.toBeInTheDocument()
		expect(view.getByRole("button", { name: "history:viewAllHistory" })).toBeInTheDocument()
		expect(view.getByTestId("chat-textarea").querySelector("input")).toBe(composer)
		expect(composer).toHaveValue("Home draft")
		fireEvent.click(view.getByRole("button", { name: "history:viewAllHistory" }))
		expect(focusedElements.at(-1)).toBe(view.getByRole("searchbox"))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "clearTask" }))
	})

	it("keeps the active transcript and draft mounted while opening Chats", async () => {
		const props = { ...defaultProps, historyFocusRequest: 0 }
		const tree = () => (
			<ExtensionStateContextProvider>
				<QueryClientProvider client={queryClient}>
					<ChatView {...props} />
				</QueryClientProvider>
			</ExtensionStateContextProvider>
		)
		const view = render(tree())
		mockPostMessage({
			currentTaskId: "active-chat",
			clineMessages: [{ ts: 1, type: "say", say: "text", text: "Active chat" }],
			taskHistory: [{ id: "active-chat", ts: 1, task: "Active chat" }],
		})
		const transcript = await view.findByTestId("chat-transcript-viewport")
		const composer = view.getByTestId("chat-textarea").querySelector("input")!
		fireEvent.change(composer, { target: { value: "Unsent draft" } })
		props.historyFocusRequest = 1
		view.rerender(tree())
		expect(view.getByRole("heading", { name: "history:chats" })).toBeInTheDocument()
		expect(view.getByTestId("chat-transcript-viewport")).toBe(transcript)
		expect(view.getByTestId("chat-textarea").querySelector("input")).toBe(composer)
		expect(composer).toHaveValue("Unsent draft")
		fireEvent.click(view.getByRole("button", { name: "history:closeChats" }))
		expect(view.queryByRole("searchbox")).not.toBeInTheDocument()
		props.historyFocusRequest = 2
		view.rerender(tree())
		expect(focusedElements.at(-1)).toBe(view.getByRole("searchbox"))
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "taskOpenResult", taskId: "active-chat", success: false },
				}),
			),
		)
		expect(view.getByRole("heading", { name: "history:chats" })).toBeInTheDocument()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "taskOpenResult", taskId: "active-chat", success: true },
				}),
			),
		)
		expect(view.queryByRole("heading", { name: "history:chats" })).not.toBeInTheDocument()
		expect(view.getByTestId("chat-transcript-viewport")).toBe(transcript)
		expect(composer).toHaveValue("Unsent draft")
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "clearTask" }))
	})
})

describe("ChatView - Empty chat home", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each([0, 3, 7])("shows only the centered Alpha mark when there are %i recent chats", async (historyCount) => {
		const { getByTestId, getByRole, queryByTestId, queryByRole } = renderChatView()
		const taskHistory = Array.from({ length: historyCount }, (_, index) => ({
			id: `task-${index + 1}`,
			ts: Date.now() - index * 1000,
			task: `Recent task ${index + 1}`,
			workspace: "/test/workspace",
		}))

		mockPostMessage({ cwd: "/test/workspace", taskHistory, clineMessages: [] })
		if (historyCount > 0) {
			await waitFor(() => expect(getByTestId("history-preview-list")).toBeInTheDocument())
		}

		expect(getByTestId("alpha-home-brand")).toBeInTheDocument()
		expect(getByTestId("roo-hero")).toBeInTheDocument()
		expect(queryByTestId("version-indicator")).not.toBeInTheDocument()
		expect(queryByRole("group", { name: "common:chatToolbar.label" })).not.toBeInTheDocument()
		expect(queryByRole("button", { name: "common:chatToolbar.newChat" })).not.toBeInTheDocument()

		if (historyCount > 0) {
			expect(getByRole("region", { name: "history:chats" })).toBeInTheDocument()
			expect(getByTestId("history-preview-list")).toBeInTheDocument()
		}
	})
})

describe("ChatView - Managed agent monitor", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(vscode.postMessage).mockClear()
	})

	it("mounts a compact live task strip and opens the selected descendant", async () => {
		const { getByRole, queryByRole, queryByText } = renderChatView()
		const now = Date.now()

		mockPostMessage({
			currentTaskId: "root-1",
			currentView: { type: "task", taskId: "root-1" },
			currentTaskItem: {
				id: "root-1",
				number: 1,
				ts: now - 5_000,
				task: "Coordinate the UI milestone",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				workspace: "/test/workspace",
			},
			maxConcurrentSubagents: 2,
			managedAgentTree: {
				version: 1,
				rootTaskId: "root-1",
				observedAt: now,
				nodes: [
					{
						taskId: "root-1",
						rootTaskId: "root-1",
						path: "/root",
						nickname: "Coordinate the UI milestone",
						role: "root",
						objective: "Coordinate the UI milestone",
						status: "running",
						createdAt: now - 5_000,
						updatedAt: now,
						depth: 0,
						usage: { durationMs: 5_000 },
					},
					{
						taskId: "child-1",
						rootTaskId: "root-1",
						parentTaskId: "root-1",
						groupId: "group-1",
						path: "/root/maple",
						nickname: "Maple",
						role: "worker",
						objective: "Implement the monitor",
						status: "running",
						createdAt: now - 4_000,
						updatedAt: now,
						startedAt: now - 3_000,
						depth: 1,
						usage: { durationMs: 3_000 },
					},
				],
				activity: [],
				capacity: { active: 1, queued: 0, terminal: 0, limit: 2 },
				budgets: { tokenLimit: null, costLimit: null },
				omittedNodeCount: 0,
				omittedActivityCount: 0,
			},
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: now - 5_000,
					text: "Coordinate the UI milestone",
				},
				{
					type: "say",
					say: "subagent_group",
					ts: now - 4_000,
					subagentGroup: {
						groupId: "group-1",
						parentTaskId: "root-1",
						status: "running",
						createdAt: now - 4_000,
						agents: [
							{
								taskId: "child-1",
								nickname: "Maple",
								role: "worker",
								objective: "Implement the monitor",
								status: "running",
								phase: "working",
								startedAt: now - 3_000,
								usage: { durationMs: 3_000 },
							},
						],
					},
				} as AlphaMessage,
			],
			liveTasksById: {
				"root-1": {
					id: "root-1",
					status: "running",
					lifecycle: "running",
					isActive: true,
					isStreaming: true,
					isWaitingForInput: false,
					lastUpdatedAt: now,
					queueCount: 0,
					tokensIn: 100,
					tokensOut: 50,
					totalCost: 0.01,
				},
			},
		})

		const taskStrip = await waitFor(() => getByRole("region", { name: "subagentDock.title" }))
		expect(within(taskStrip).getByRole("button", { name: "subagentDock.expand" })).toHaveAttribute(
			"aria-expanded",
			"false",
		)
		fireEvent.click(within(taskStrip).getByRole("button", { name: "subagentDock.expand" }))
		expect(queryByRole("heading", { name: "Managed agents" })).not.toBeInTheDocument()
		expect(queryByText("Mailbox & activity")).not.toBeInTheDocument()
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(within(taskStrip).getByRole("button", { name: /Open Maple · Working/i }))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "showTaskWithId",
			text: "child-1",
		})
	})

	it("renders durable nested registry state after reload without transcript groups", async () => {
		const { getByRole, queryByText } = renderChatView()
		const now = Date.now()

		mockPostMessage({
			currentTaskId: "root-1",
			currentView: { type: "task", taskId: "root-1" },
			currentTaskItem: {
				id: "root-1",
				number: 1,
				ts: now - 10_000,
				task: "Coordinate durable agents",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				workspace: "/test/workspace",
			},
			clineMessages: [],
			managedAgentTree: {
				version: 1,
				rootTaskId: "root-1",
				observedAt: now,
				reloadedAt: now - 1_000,
				nodes: [
					{
						taskId: "root-1",
						rootTaskId: "root-1",
						path: "/root",
						nickname: "Coordinate durable agents",
						role: "root",
						objective: "Coordinate durable agents",
						status: "running",
						createdAt: now - 10_000,
						updatedAt: now,
						depth: 0,
						usage: { durationMs: 10_000 },
					},
					{
						taskId: "parent-1",
						rootTaskId: "root-1",
						parentTaskId: "root-1",
						groupId: "group-parent",
						path: "/root/cinder",
						nickname: "Cinder",
						role: "worker",
						objective: "Implement the bridge",
						status: "running",
						createdAt: now - 8_000,
						updatedAt: now,
						depth: 1,
						usage: { durationMs: 8_000, inputTokens: 100, outputTokens: 50, cost: 0.3 },
					},
					{
						taskId: "child-2",
						rootTaskId: "root-1",
						parentTaskId: "parent-1",
						groupId: "group-child",
						path: "/root/cinder/iris",
						nickname: "Iris",
						role: "review",
						objective: "Review the bridge",
						status: "completed",
						createdAt: now - 7_000,
						updatedAt: now - 500,
						finishedAt: now - 500,
						depth: 2,
						stopReason: "completed",
						usage: { durationMs: 6_500, inputTokens: 80, outputTokens: 20, cost: 0.2 },
					},
				],
				activity: [],
				capacity: { active: 1, queued: 0, terminal: 1, limit: 3 },
				budgets: { tokenLimit: 1_000, costLimit: 2 },
				omittedNodeCount: 0,
				omittedActivityCount: 0,
			},
		})

		const taskStrip = await waitFor(() => getByRole("region", { name: "subagentDock.title" }))
		expect(within(taskStrip).getByRole("button", { name: "subagentDock.expand" })).toHaveAttribute(
			"aria-expanded",
			"false",
		)
		fireEvent.click(within(taskStrip).getByRole("button", { name: "subagentDock.expand" }))
		expect(within(taskStrip).getByRole("button", { name: /Open Cinder · Working/i })).toBeInTheDocument()
		const nestedTask = within(taskStrip).getByRole("button", { name: /Open Iris · Completed/i })
		expect(queryByText("1 of 3 active")).not.toBeInTheDocument()
		expect(queryByText("$0.50")).not.toBeInTheDocument()
		expect(queryByText("Restored after reload")).not.toBeInTheDocument()

		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(nestedTask)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-2" })
	})

	it("shows one parent return control in an opened managed child", async () => {
		const { getAllByRole, queryByText, queryByRole } = renderChatView()
		const now = Date.now()

		mockPostMessage({
			currentTaskId: "child-1",
			currentView: { type: "task", taskId: "child-1" },
			currentTaskItem: {
				id: "child-1",
				number: 2,
				ts: now - 2_000,
				task: "Inspect the compact task UX",
				taskKind: "subagent",
				parentTaskId: "root-1",
				subagentRole: "review",
				subagentNickname: "Maple",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				workspace: "/test/workspace",
			},
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: now - 2_000,
					text: "Inspect the compact task UX",
				},
			],
		})

		await waitFor(() => expect(getAllByRole("button", { name: "Return to parent" })).toHaveLength(1))
		expect(queryByText("Transcript is read-only")).not.toBeInTheDocument()
		expect(queryByRole("textbox")).not.toBeInTheDocument()
	})

	it("keeps a persisted recovery error visible while hiding the resume ask after rehydration", async () => {
		const { getAllByTestId } = renderChatView()
		const taskId = "recovery-task"
		const recoveryMessage = {
			type: "say" as const,
			say: "error",
			ts: 2,
			text: "The turn stopped because an operation failed. You can resume the task or send new guidance.",
		}
		const state = {
			currentTaskId: taskId,
			currentView: { type: "task" as const, taskId },
			currentTaskItem: {
				id: taskId,
				number: 1,
				ts: 1,
				task: "Recover the task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				workspace: "/test/workspace",
			},
			liveTasksById: {
				[taskId]: {
					id: taskId,
					status: "interactive",
					lifecycle: "waiting",
					isActive: true,
					isStreaming: false,
					isWaitingForInput: true,
					waitingReason: "resumable",
					lastUpdatedAt: 3,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			clineMessages: [
				{ type: "say" as const, say: "task", ts: 1, text: "Recover the task" },
				recoveryMessage,
				{ type: "ask" as const, ask: "resume_task", ts: 3, text: "" },
			],
		}

		const assertRehydratedTranscript = async () => {
			await waitFor(() => {
				const rows = getAllByTestId("chat-row")
				expect(rows).toHaveLength(2)
				expect(rows[0]).toHaveTextContent("Recover the task")
				expect(rows[1]).toHaveTextContent(recoveryMessage.text)
				expect(rows.map((row) => row.textContent).join(" ")).not.toContain('"resume_task"')
			})
		}

		mockPostMessage(state)
		await assertRehydratedTranscript()

		// A second full state post models the extension reload/rehydration path.
		mockPostMessage(state)
		await assertRehydratedTranscript()
	})
})

describe("ChatView - Message Queueing Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Reset the mock to clear any initial calls
		vi.mocked(vscode.postMessage).mockClear()
	})

	describe("active follow-up replies", () => {
		const queuedMessages = [
			{ id: "first", text: "First next-turn instruction", images: [] },
			{ id: "second", text: "Second next-turn instruction", images: [] },
		]
		const followUp: AlphaMessage = {
			type: "ask",
			ask: "followup",
			ts: 101,
			text: JSON.stringify({ question: "Choose an answer", suggest: [] }),
			partial: false,
			isAnswered: false,
		}
		const taskMessage: AlphaMessage = { type: "say", say: "task", ts: 100, text: "Test follow-up" }
		const waitingTask = {
			id: "task-with-followup",
			status: "interactive",
			lifecycle: "waiting",
			isActive: true,
			isStreaming: false,
			isTurnActive: true,
			canInterrupt: false,
			isWaitingForInput: true,
			waitingReason: "followup",
			lastUpdatedAt: 101,
			queueCount: queuedMessages.length,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const waitingState = {
			currentTaskId: waitingTask.id,
			currentView: { type: "task", taskId: waitingTask.id },
			liveTasksById: { [waitingTask.id]: waitingTask },
			clineMessages: [taskMessage, followUp],
			messageQueue: queuedMessages,
		}

		it.each(["followup", "tool"])("keeps the pending %s actionable behind an incoming chat bubble", async (ask) => {
			const view = renderChatView()
			const incoming: AlphaMessage = {
				type: "say",
				say: "agent_message",
				ts: 103,
				text: "A finding from another chat",
				agentMessage: { id: "incoming-1", senderTaskId: "peer" },
			}
			mockPostMessage({
				...waitingState,
				clineMessages: [
					taskMessage,
					{
						...followUp,
						ask,
						text: ask === "tool" ? JSON.stringify({ tool: "readFile", path: "parser.ts" }) : followUp.text,
					},
					incoming,
				],
			})
			await waitFor(() => expect(view.getAllByTestId("chat-row").at(-1)).toHaveTextContent(incoming.text!))
			if (ask === "tool") {
				expect(view.getByRole("button", { name: "chat:approve.title" })).toBeEnabled()
			} else {
				expect(view.getByTestId("copy-mode-suggestion")).toBeInTheDocument()
			}
			vi.mocked(vscode.postMessage).mockClear()
			await act(async () => {
				window.dispatchEvent(
					new MessageEvent("message", { data: { type: "invoke", invoke: "sendMessage", text: "My answer" } }),
				)
			})
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: ask === "followup" ? "askResponse" : "queueMessage",
					text: "My answer",
					taskId: waitingTask.id,
				}),
			)
		})

		it("waits for the reopened task transcript before dispatching a targeted host send", async () => {
			const taskId = "reopened-completed-task"
			const { getByTestId } = renderChatView()
			mockPostMessage({
				currentTaskId: undefined,
				currentView: { type: "newTaskDraft" },
				taskStateSeq: 1,
				clineMessagesSeq: 1,
				clineMessages: [],
			})
			await waitFor(() => expect(getByTestId("chat-textarea")).toBeInTheDocument())
			vi.mocked(vscode.postMessage).mockClear()

			await act(async () => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "invoke", invoke: "sendMessage", taskId, text: "Continue the reopened task" },
					}),
				)
			})
			expect(vscode.postMessage).not.toHaveBeenCalled()

			const completedTask = {
				id: taskId,
				status: "completed",
				lifecycle: "completed",
				isActive: true,
				isStreaming: false,
				isWaitingForInput: false,
				lastUpdatedAt: 10,
				queueCount: 0,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			mockPostMessage({
				currentTaskId: taskId,
				currentView: { type: "task", taskId },
				currentTaskItem: { id: taskId, task: "Reopened task", ts: 1 },
				liveTasksById: { [taskId]: completedTask },
				taskStateSeq: 2,
				clineMessagesSeq: 2,
				clineMessages: [],
			})
			await waitFor(() => expect(getByTestId("chat-textarea")).toBeInTheDocument())
			expect(vscode.postMessage).not.toHaveBeenCalled()

			mockPostMessage({
				currentTaskId: taskId,
				currentView: { type: "task", taskId },
				currentTaskItem: { id: taskId, task: "Reopened task", ts: 1 },
				liveTasksById: { [taskId]: completedTask },
				taskStateSeq: 2,
				clineMessagesSeq: 3,
				clineMessages: [
					{ type: "say", say: "task", ts: 1, text: "Reopened task" },
					{ type: "say", say: "completion_result", ts: 2, text: "Previous answer" },
					{ type: "ask", ask: "resume_completed_task", ts: 3, text: "", partial: false },
				],
			})

			await waitFor(() =>
				expect(vscode.postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "askResponse",
						askResponse: "messageResponse",
						text: "Continue the reopened task",
						images: [],
						taskId,
					}),
				),
			)
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "newTask" }))
		})

		it.each(
			(["invoke", "suggestion"] as const).flatMap((method) =>
				[false, true].map((switchTask) => ({ method, switchTask })),
			),
		)(
			"answers a fast $method immediately after the follow-up DOM commits (switch task=$switchTask)",
			async ({ method, switchTask }) => {
				const { container, getByTestId, queryByTestId } = renderChatView()
				const initialTaskId = switchTask ? "previous-task" : waitingTask.id
				mockPostMessage({
					...waitingState,
					currentTaskId: initialTaskId,
					currentView: { type: "task", taskId: initialTaskId },
					liveTasksById: { [initialTaskId]: { ...waitingTask, id: initialTaskId } },
					clineMessages: [taskMessage],
				})
				await waitFor(() => expect(getByTestId("queued-messages")).toBeInTheDocument())
				await act(async () => {})
				const queuedText = getByTestId("queued-messages").textContent
				const text = method === "suggestion" ? "Draft plan" : "Immediate answer"
				vi.mocked(vscode.postMessage).mockClear()

				// Mutation delivery observes the committed row before passive ask-control
				// effects settle. Do not insert a wait or input event before submitting.
				const observer = new MutationObserver(() => {
					const suggestion = queryByTestId("copy-mode-suggestion")
					if (!suggestion) return
					observer.disconnect()
					if (method === "suggestion") suggestion.click()
					else {
						window.dispatchEvent(
							new MessageEvent("message", {
								data: { type: "invoke", invoke: "sendMessage", text },
							}),
						)
					}
				})
				observer.observe(container, { childList: true, subtree: true })
				try {
					mockPostMessage(waitingState)
					await waitFor(() => {
						const submissions = vi
							.mocked(vscode.postMessage)
							.mock.calls.map(([message]) => message)
							.filter((message) => ["askResponse", "queueMessage", "newTask"].includes(message.type))
						expect(submissions).toEqual([
							{
								type: "askResponse",
								askMessageTs: followUp.ts,
								requestId: expect.any(String),
								askResponse: "messageResponse",
								text,
								images: [],
								taskId: waitingTask.id,
							},
						])
					})
					expect(getByTestId("queued-messages").textContent).toBe(queuedText)
				} finally {
					observer.disconnect()
				}
			},
		)

		it("queues a second submission before the first follow-up answer is acknowledged", async () => {
			const { getByTestId } = renderChatView()
			mockPostMessage(waitingState)
			await waitFor(() => getByTestId("copy-mode-suggestion"))
			vi.mocked(vscode.postMessage).mockClear()

			await act(async () => {
				for (const text of ["My answer", "Next instruction"]) {
					window.dispatchEvent(
						new MessageEvent("message", { data: { type: "invoke", invoke: "sendMessage", text } }),
					)
				}
			})
			const submissions = vi
				.mocked(vscode.postMessage)
				.mock.calls.map(([message]) => message)
				.filter((message) => ["askResponse", "queueMessage", "newTask"].includes(message.type))
			expect(submissions).toEqual([
				{
					type: "askResponse",
					askMessageTs: followUp.ts,
					askResponse: "messageResponse",
					text: "My answer",
					requestId: expect.any(String),
					images: [],
					taskId: waitingTask.id,
				},
				{
					type: "queueMessage",
					clientSubmittedAt: expect.any(Number),
					text: "Next instruction",
					images: [],
					taskId: waitingTask.id,
					requestId: expect.any(String),
				},
			])
			// The local answer guard must survive a render while the host still
			// publishes the same unanswered question; the queue admission is in flight.
			await act(async () => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "invoke", invoke: "sendMessage", text: "Third input" },
					}),
				)
			})
			expect(
				vi.mocked(vscode.postMessage).mock.calls.filter(([message]) => message.type === "askResponse"),
			).toHaveLength(1)
			expect(
				vi.mocked(vscode.postMessage).mock.calls.filter(([message]) => message.type === "queueMessage"),
			).toHaveLength(1)
		})

		it.each(["new question", "different task"] as const)(
			"allows a %s after a locally submitted follow-up",
			async (nextBoundary) => {
				const { getByTestId, getByText } = renderChatView()
				const invokeAnswer = () =>
					window.dispatchEvent(
						new MessageEvent("message", {
							data: { type: "invoke", invoke: "sendMessage", text: "My answer" },
						}),
					)
				mockPostMessage(waitingState)
				await waitFor(() => getByTestId("copy-mode-suggestion"))
				await act(async () => {
					invokeAnswer()
				})
				vi.mocked(vscode.postMessage).mockClear()

				const taskId = nextBoundary === "different task" ? "next-task" : waitingTask.id
				mockPostMessage({
					...waitingState,
					currentTaskId: taskId,
					currentView: { type: "task", taskId },
					liveTasksById: { [taskId]: { ...waitingTask, id: taskId } },
					clineMessages: [
						taskMessage,
						{
							...followUp,
							ts: nextBoundary === "different task" ? followUp.ts : followUp.ts + 1,
							text: "Another follow-up question",
						},
					],
				})
				await waitFor(() => getByText(/Another follow-up question/))
				await act(async () => {
					invokeAnswer()
				})
				expect(vscode.postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "askResponse",
						askResponse: "messageResponse",
						text: "My answer",
						images: [],
						taskId,
					}),
				)
				expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
			},
		)

		it.each(
			[
				{ method: "keyboard", hasQueuedWork: false },
				{ method: "keyboard", hasQueuedWork: true },
				{ method: "invoke", hasQueuedWork: false },
				{ method: "invoke", hasQueuedWork: true },
				{ method: "suggestion", hasQueuedWork: true },
			].flatMap((testCase) => [true, false].map((isWaitingForInput) => ({ ...testCase, isWaitingForInput }))),
		)(
			"answers the current follow-up via $method with queued work=$hasQueuedWork and waiting metadata=$isWaitingForInput",
			async ({ method, hasQueuedWork, isWaitingForInput }) => {
				const { getByTestId, queryByTestId } = renderChatView()
				mockPostMessage({
					...waitingState,
					liveTasksById: {
						[waitingTask.id]: {
							...waitingTask,
							status: isWaitingForInput ? "interactive" : "running",
							lifecycle: isWaitingForInput ? "waiting" : "running",
							isWaitingForInput,
							lastUpdatedAt: followUp.ts + 10,
							queueCount: hasQueuedWork ? 2 : 0,
						},
					},
					messageQueue: hasQueuedWork ? queuedMessages : [],
				})
				const suggestion = await waitFor(() => getByTestId("copy-mode-suggestion"))
				const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
				expect(input).toHaveAttribute("data-sending-disabled", "false")
				expect(input).toHaveAttribute("data-is-streaming", String(!isWaitingForInput))
				const queuedText = queryByTestId("queued-messages")?.textContent
				const images = method === "suggestion" ? [] : ["data:image/png;base64,answer-image"]
				const text = method === "suggestion" ? "Draft plan" : "Use the first option"
				vi.mocked(vscode.postMessage).mockClear()

				if (method === "invoke") {
					await act(async () => {
						window.dispatchEvent(
							new MessageEvent("message", {
								data: { type: "invoke", invoke: "sendMessage", text, images },
							}),
						)
					})
				} else if (method === "suggestion") {
					fireEvent.click(suggestion)
				} else {
					await act(async () => {
						window.dispatchEvent(new MessageEvent("message", { data: { type: "selectedImages", images } }))
					})
					fireEvent.change(input, { target: { value: text } })
					fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
				}

				const submissions = vi
					.mocked(vscode.postMessage)
					.mock.calls.map(([message]) => message)
					.filter((message) => ["askResponse", "queueMessage", "newTask"].includes(message.type))
				expect(submissions).toEqual([
					{
						type: "askResponse",
						requestId: expect.any(String),
						askMessageTs: followUp.ts,
						askResponse: "messageResponse",
						text,
						images,
						taskId: waitingTask.id,
					},
				])
				expect(queryByTestId("queued-messages")?.textContent).toBe(queuedText)
				expect(input).toHaveValue("")
			},
		)

		it.each([true, false])(
			"answers a current follow-up after a status message with waiting metadata=%s",
			async (isWaitingForInput) => {
				const { getByTestId, getByText } = renderChatView()
				mockPostMessage(waitingState)
				await waitFor(() => getByTestId("copy-mode-suggestion"))
				mockPostMessage({
					...waitingState,
					liveTasksById: { [waitingTask.id]: { ...waitingTask, isWaitingForInput, lastUpdatedAt: 103 } },
					clineMessages: [
						...waitingState.clineMessages,
						{ type: "say", say: "text", ts: 102, text: "Still awaiting your answer" },
					],
				})
				await waitFor(() => getByText(/Still awaiting your answer/))
				vi.mocked(vscode.postMessage).mockClear()

				await act(async () => {
					window.dispatchEvent(
						new MessageEvent("message", {
							data: { type: "invoke", invoke: "sendMessage", text: "My answer" },
						}),
					)
				})

				expect(vscode.postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "askResponse",
						askResponse: "messageResponse",
						text: "My answer",
						images: [],
						taskId: waitingTask.id,
					}),
				)
				expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
			},
		)

		it.each([
			{ boundary: "partial follow-up", currentAsk: { ...followUp, partial: true }, isWaitingForInput: true },
			{ boundary: "answered follow-up", currentAsk: { ...followUp, isAnswered: true }, isWaitingForInput: true },
			...(["tool", "command", "use_mcp_server", "command_output"] as const).map((ask) => ({
				boundary: ask,
				currentAsk: { ...followUp, ts: 102, ask, text: "{}" },
				isWaitingForInput: true,
			})),
		])("preserves queue routing at $boundary", async ({ currentAsk, isWaitingForInput }) => {
			const { getByTestId, getAllByTestId, getByRole, queryByRole } = renderChatView()
			mockPostMessage(waitingState)
			await waitFor(() => getByTestId("copy-mode-suggestion"))
			mockPostMessage({
				...waitingState,
				liveTasksById: { [waitingTask.id]: { ...waitingTask, isWaitingForInput } },
				clineMessages: [waitingState.clineMessages[0], currentAsk],
			})
			await waitFor(() => {
				if (currentAsk.ask === "command_output") {
					expect(queryByRole("button", { name: "chat:proceedWhileRunning.title" })).not.toBeInTheDocument()
					expect(getByRole("button", { name: "chat:killCommand.title" })).toBeInTheDocument()
				} else {
					expect(getAllByTestId("chat-row").at(-1)).toHaveTextContent(JSON.stringify(currentAsk))
				}
				expect(getByTestId("chat-textarea").querySelector("input")).toHaveAttribute(
					"data-is-streaming",
					String(!isWaitingForInput),
				)
			})
			vi.mocked(vscode.postMessage).mockClear()

			await act(async () => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "invoke", invoke: "sendMessage", text: "Next instruction" },
					}),
				)
			})

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				clientSubmittedAt: expect.any(Number),
				text: "Next instruction",
				images: [],
				taskId: waitingTask.id,
				requestId: expect.any(String),
			})
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
		})

		it.each(["api_req_started", "user_feedback"])(
			"does not re-answer a stale follow-up after a newer %s boundary",
			async (say) => {
				const { getByTestId, getByText } = renderChatView()
				mockPostMessage(waitingState)
				await waitFor(() => getByTestId("copy-mode-suggestion"))
				// A batched refresh can skip rendering the intermediate request/response
				// boundary, while both the old ask and waiting metadata remain visible.
				mockPostMessage({
					...waitingState,
					clineMessages: [
						...waitingState.clineMessages,
						{ type: "say", say, ts: 102, text: "{}" },
						{ type: "say", say: "text", ts: 103, text: "Continued after the previous question" },
					],
				})
				await waitFor(() => getByText(/Continued after the previous question/))
				vi.mocked(vscode.postMessage).mockClear()

				await act(async () => {
					window.dispatchEvent(
						new MessageEvent("message", {
							data: { type: "invoke", invoke: "sendMessage", text: "Next instruction" },
						}),
					)
				})

				expect(vscode.postMessage).toHaveBeenCalledWith({
					type: "queueMessage",
					clientSubmittedAt: expect.any(Number),
					text: "Next instruction",
					images: [],
					taskId: waitingTask.id,
					requestId: expect.any(String),
				})
				expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
			},
		)

		it("keeps explicit Queue as next-turn work while a follow-up waits", async () => {
			const { getByTestId } = renderChatView()
			mockPostMessage(waitingState)
			await waitFor(() => getByTestId("copy-mode-suggestion"))
			const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
			vi.mocked(vscode.postMessage).mockClear()

			fireEvent.change(input, { target: { value: "Save this for the next turn" } })
			fireEvent.click(getByTestId("mock-enqueue"))

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				clientSubmittedAt: expect.any(Number),
				text: "Save this for the next turn",
				images: [],
				taskId: waitingTask.id,
				requestId: expect.any(String),
			})
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
			expect(input).toHaveValue("Save this for the next turn")
		})
	})

	it("uses live task metadata when a turn is active before an API transcript marker exists", async () => {
		const { getByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			liveTasksById: {
				"task-1": {
					id: "task-1",
					status: "running",
					lifecycle: "running",
					isActive: true,
					isStreaming: false,
					isTurnActive: true,
					canInterrupt: true,
					activityPhase: "thinking",
					isWaitingForInput: false,
					lastUpdatedAt: Date.now(),
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			clineMessages: [{ type: "say", say: "task", ts: Date.now(), text: "Preparing the request" }],
		})

		const input = (await waitFor(() => getByTestId("chat-textarea").querySelector("input"))) as HTMLInputElement
		await waitFor(() => expect(input).toHaveAttribute("data-is-streaming", "true"))
		expect(getByTestId("mock-stop")).toBeEnabled()
		expect(getByTestId("mock-provider-selector")).toBeDisabled()
	})

	it("ignores a stale API transcript marker when live task metadata says the turn is idle", async () => {
		const { getByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			liveTasksById: {
				"task-1": {
					id: "task-1",
					status: "idle",
					lifecycle: "running",
					isActive: true,
					isStreaming: true,
					isTurnActive: false,
					canInterrupt: false,
					isWaitingForInput: false,
					lastUpdatedAt: Date.now(),
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Initial task" },
				{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "openai" }) },
			],
		})

		const input = (await waitFor(() => getByTestId("chat-textarea").querySelector("input"))) as HTMLInputElement
		await waitFor(() => expect(input).toHaveAttribute("data-is-streaming", "false"))
		expect(getByTestId("mock-stop")).toBeDisabled()
	})

	it("does not freeze the composer when historical API request metadata is malformed", async () => {
		const { getByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Initial task" },
				{ type: "say", say: "api_req_started", ts: 2, text: "{not valid JSON" },
			],
		})

		const input = (await waitFor(() => getByTestId("chat-textarea").querySelector("input"))) as HTMLInputElement
		expect(input).toHaveAttribute("data-is-streaming", "false")
		expect(input).toHaveAttribute("data-sending-disabled", "false")
	})

	it("shows delayed model feedback while preserving the Stop control", async () => {
		const { getByRole, getByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			liveTasksById: {
				"task-1": {
					id: "task-1",
					status: "running",
					lifecycle: "running",
					isActive: true,
					isStreaming: true,
					isTurnActive: true,
					canInterrupt: true,
					activityPhase: "working",
					isWaitingForInput: false,
					lastUpdatedAt: Date.now() - 31_000,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			clineMessages: [{ type: "say", say: "task", ts: 1, text: "Initial task" }],
		})

		await waitFor(() => expect(getByRole("status")).toHaveTextContent("chat:modelResponseDelayed"))
		expect(getByTestId("mock-stop")).toBeEnabled()
	})

	describe("model response delay", () => {
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
			vi.setSystemTime(new Date("2026-09-10T18:00:00Z"))
		})
		afterEach(() => vi.useRealTimers())

		const publishActivity = (
			phase: string | undefined,
			overrides: Partial<ExtensionState> = {},
			hostLifecycle?: { turnId?: string; hasPendingToolCalls: boolean },
		) => {
			mockPostMessage({
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				liveTasksById: {
					"task-1": {
						id: "task-1",
						status: "running",
						lifecycle: "running",
						isActive: true,
						isStreaming: true,
						isTurnActive: true,
						canInterrupt: true,
						activityPhase: phase,
						isWaitingForInput: false,
						lastUpdatedAt: Date.now(),
						queueCount: 0,
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
						...hostLifecycle,
					},
				},
				clineMessages: [{ type: "say", say: "task", ts: 1, text: "Waiting test" }],
				...overrides,
			})
		}

		it.each([
			"executing",
			"waiting",
			"awaiting_approval",
			"compacting",
			"starting",
			"queued",
			"finalizing",
			undefined,
		])("does not treat the %s phase as a delayed model response", async (phase) => {
			const { getByTestId, queryByText } = renderChatView()
			publishActivity(phase)
			await waitFor(() => expect(getByTestId("mock-stop")).toBeEnabled())
			act(() => vi.advanceTimersByTime(300_000))
			expect(queryByText("chat:modelResponseDelayed")).not.toBeInTheDocument()
		})

		it("does not flag an accepted wait_agent call before its execution phase arrives", async () => {
			const { getByTestId, queryByText } = renderChatView()
			publishActivity("working", {
				agentLifecycleSnapshots: {
					"task-1": agentLifecycleSnapshotSchema.parse({
						version: 1,
						taskId: "task-1",
						runId: "run",
						turnId: "turn",
						status: "in_progress",
						phase: "working",
						lastSequence: 0,
						items: [
							{
								type: "tool_call",
								itemId: "wait",
								toolCallId: "call-wait",
								name: "wait_agent",
								arguments: {},
							},
						],
						steps: [],
						acceptedToolCallIds: ["call-wait"],
						terminalToolCallIds: [],
						processedEvents: [],
					}),
				},
			})
			await waitFor(() => expect(getByTestId("mock-stop")).toBeEnabled())
			act(() => vi.advanceTimersByTime(300_000))
			expect(queryByText("chat:modelResponseDelayed")).not.toBeInTheDocument()
		})

		it.each([false, true])("uses compact host pending-tool state (%s)", async (hasPendingToolCalls) => {
			const { getByTestId, queryByText } = renderChatView()
			publishActivity("working", {}, { turnId: "compact-turn", hasPendingToolCalls })
			await waitFor(() => expect(getByTestId("mock-stop")).toBeEnabled())
			act(() => vi.advanceTimersByTime(30_000))
			expect(Boolean(queryByText("chat:modelResponseDelayed"))).toBe(!hasPendingToolCalls)
		})

		it.each(["completed", "error", "cancelled"])(
			"still detects a quiet model after a tool has %s",
			async (status) => {
				const { getByTestId, getByRole } = renderChatView()
				publishActivity("working", {
					agentLifecycleSnapshots: {
						"task-1": agentLifecycleSnapshotSchema.parse({
							version: 1,
							taskId: "task-1",
							runId: "run",
							turnId: "turn",
							status: "in_progress",
							phase: "working",
							lastSequence: 0,
							items: [
								{ type: "tool_result", itemId: "result", toolCallId: "call-wait", status, output: {} },
							],
							steps: [],
							acceptedToolCallIds: ["call-wait"],
							terminalToolCallIds: ["call-wait"],
							processedEvents: [],
						}),
					},
				})
				await waitFor(() => expect(getByTestId("mock-stop")).toBeEnabled())
				act(() => vi.advanceTimersByTime(30_000))
				expect(getByRole("status")).toHaveTextContent("chat:modelResponseDelayed")
			},
		)

		it("does not use another task's activity to diagnose the visible model", async () => {
			const { getByTestId, getByRole } = renderChatView()
			publishActivity("working", {
				agentLifecycleSnapshots: {
					"other-task": agentLifecycleSnapshotSchema.parse({
						version: 1,
						taskId: "other-task",
						runId: "other-run",
						turnId: "other-turn",
						status: "in_progress",
						phase: "executing",
						lastSequence: 0,
						items: [],
						steps: [],
						acceptedToolCallIds: ["other-call"],
						terminalToolCallIds: [],
						processedEvents: [],
					}),
				},
			})
			await waitFor(() => expect(getByTestId("mock-stop")).toBeEnabled())
			act(() => vi.advanceTimersByTime(30_000))
			expect(getByRole("status")).toHaveTextContent("chat:modelResponseDelayed")
		})

		it("starts a fresh delay after tools finish and clears it when model activity resumes", async () => {
			const { getByTestId, queryByText, getByRole } = renderChatView()
			publishActivity("executing")
			await waitFor(() => expect(getByTestId("mock-stop")).toBeEnabled())
			act(() => vi.advanceTimersByTime(300_000))
			expect(queryByText("chat:modelResponseDelayed")).not.toBeInTheDocument()
			publishActivity("working")
			await waitFor(() => expect(queryByText("chat:modelResponseDelayed")).not.toBeInTheDocument())
			act(() => vi.advanceTimersByTime(25_000))
			expect(queryByText("chat:modelResponseDelayed")).not.toBeInTheDocument()
			act(() => vi.advanceTimersByTime(5_000))
			expect(getByRole("status")).toHaveTextContent("chat:modelResponseDelayed")
			publishActivity("working")
			await waitFor(() => expect(queryByText("chat:modelResponseDelayed")).not.toBeInTheDocument())
			expect(getByTestId("mock-stop")).toBeEnabled()
		})
	})

	it("keeps an idle completion-tool review out of the stalled running state", async () => {
		const { getByTestId, queryByText } = renderChatView()
		const taskId = "completion-review"
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			liveTaskIds: [taskId],
			liveTasksById: {
				[taskId]: {
					id: taskId,
					status: "idle",
					lifecycle: "waiting",
					isActive: true,
					isStreaming: false,
					isTurnActive: true,
					canInterrupt: false,
					isWaitingForInput: true,
					waitingReason: "completion",
					activityPhase: "executing",
					lastUpdatedAt: Date.now() - 35_000,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			agentLifecycleSnapshots: {
				[taskId]: agentLifecycleSnapshotSchema.parse({
					version: 1,
					taskId,
					runId: "run",
					turnId: "turn",
					status: "in_progress",
					phase: "executing",
					lastSequence: 0,
					items: [],
					steps: [],
					acceptedToolCallIds: [],
					terminalToolCallIds: [],
					processedEvents: [],
				}),
			},
			clineMessages: [
				{ type: "say", say: "completion_result", ts: 1, text: "Implementation verified.", partial: false },
				{ type: "ask", ask: "completion_result", ts: 2, text: "" },
			],
		})
		await waitFor(() =>
			expect(getByTestId("chat-textarea").querySelector("input")).toHaveAttribute("data-is-streaming", "false"),
		)
		expect(queryByText("chat:modelResponseDelayed")).not.toBeInTheDocument()
	})
	if (process.env.ALPHA_COMPLETION_IDLE_EVIDENCE)
		it("replays the isolated live completion-idle capture through the rendered chat", async () => {
			const evidence = JSON.parse(readFileSync(process.env.ALPHA_COMPLETION_IDLE_EVIDENCE!, "utf8"))
			expect(evidence.schemaVersion).toBe(1)
			expect(evidence.elapsedMs).toBeGreaterThanOrEqual(30_000)
			expect(evidence.requestsAfterIdle).toBe(evidence.requestsAtReview)
			expect(evidence.states).toHaveLength(2)
			const { getByTestId, queryByText } = renderChatView()
			for (const state of evidence.states) {
				expect(state.currentTaskId).toBe(evidence.taskId)
				agentLifecycleSnapshotSchema.parse(state.agentLifecycleSnapshots[evidence.taskId])
				mockPostMessage(state)
				await waitFor(() =>
					expect(getByTestId("chat-textarea").querySelector("input")).toHaveAttribute(
						"data-is-streaming",
						"false",
					),
				)
				expect(queryByText("chat:modelResponseDelayed")).not.toBeInTheDocument()
			}
		})

	it("shows the task chat shell when a focused task exists before its first message arrives", async () => {
		const { getByTestId, queryByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-2",
			currentTaskItem: {
				id: "task-2",
				number: 2,
				ts: 123,
				task: "Second task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				workspace: "/test/workspace",
			},
			clineMessages: [],
		})

		await waitFor(() => {
			expect(getByTestId("chat-view")).toBeInTheDocument()
		})

		expect(within(getByTestId("chat-transcript-viewport")).getByText("Second task")).toBeInTheDocument()
		expect(queryByTestId("alpha-home-brand")).not.toBeInTheDocument()
	})

	it("enters an empty new-task window before backend state clears the old running task", async () => {
		const { getByTestId, queryByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			currentTaskItem: {
				id: "task-1",
				number: 1,
				ts: 100,
				task: "Old running task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				workspace: "/test/workspace",
			},
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: 100,
					text: "Old running task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: 101,
					text: JSON.stringify({ apiProtocol: "anthropic" }),
				},
			],
		})

		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		vi.mocked(vscode.postMessage).mockClear()

		await act(async () => {
			window.postMessage({ type: "invoke", invoke: "newChat" }, "*")
		})

		await waitFor(() => {
			const input = getByTestId("chat-textarea").querySelector("input")!
			expect(input.getAttribute("data-sending-disabled")).toBe("false")
			expect(queryByTestId("alpha-home-brand")).toBeInTheDocument()
		})

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			currentTaskItem: {
				id: "task-1",
				number: 1,
				ts: 100,
				task: "Old running task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				workspace: "/test/workspace",
			},
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: 100,
					text: "Old running task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: 102,
					text: JSON.stringify({ apiProtocol: "anthropic" }),
				},
			],
		})

		await waitFor(() => {
			expect(queryByTestId("alpha-home-brand")).toBeInTheDocument()
		})

		const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement

		await act(async () => {
			fireEvent.change(input, { target: { value: "Second task" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "newTask",
				text: "Second task",
				images: [],
				taskId: expect.any(String),
				requestId: expect.any(String),
			})
		})
	})

	it("opens the source task on the first click after entering the new-task window", async () => {
		const { getByTestId, queryByTestId } = renderChatView()

		const taskItem = {
			id: "task-1",
			number: 1,
			ts: 100,
			task: "Original task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workspace: "/test/workspace",
		}

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			currentTaskItem: taskItem,
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: 100,
					text: "Original task",
				},
			],
		})

		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		await act(async () => {
			window.postMessage({ type: "invoke", invoke: "newChat" }, "*")
		})

		mockPostMessage({
			currentTaskId: undefined,
			currentView: { type: "newTaskDraft" },
			currentTaskItem: undefined,
			clineMessages: [],
			taskHistory: [taskItem],
		})

		await waitFor(() => {
			expect(queryByTestId("alpha-home-brand")).toBeInTheDocument()
		})

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			currentTaskItem: taskItem,
			clineMessages: [],
			taskHistory: [taskItem],
		})

		await waitFor(() => {
			expect(queryByTestId("alpha-home-brand")).not.toBeInTheDocument()
			expect(within(getByTestId("chat-transcript-viewport")).getByText("Original task")).toBeInTheDocument()
		})
	})

	it("opens the same running task after the provider confirms the new-task window", async () => {
		const { getByTestId, queryByTestId } = renderChatView()

		const taskItem = {
			id: "task-1",
			number: 1,
			ts: 100,
			task: "Original task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workspace: "/test/workspace",
		}

		const taskMessages = [
			{
				type: "say" as const,
				say: "task" as const,
				ts: 100,
				text: "Original task",
			},
			{
				type: "say" as const,
				say: "api_req_started" as const,
				ts: 101,
				text: JSON.stringify({ apiProtocol: "anthropic" }),
			},
		]

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			currentTaskItem: taskItem,
			clineMessages: taskMessages,
		})

		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		await act(async () => {
			window.postMessage({ type: "invoke", invoke: "newChat" }, "*")
		})

		mockPostMessage({
			currentTaskId: undefined,
			currentView: { type: "newTaskDraft" },
			currentTaskItem: undefined,
			clineMessages: [],
			taskHistory: [taskItem],
		})

		await waitFor(() => {
			expect(queryByTestId("alpha-home-brand")).toBeInTheDocument()
		})

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			currentTaskItem: taskItem,
			clineMessages: taskMessages,
			taskHistory: [taskItem],
		})

		await waitFor(() => {
			expect(queryByTestId("alpha-home-brand")).not.toBeInTheDocument()
			expect(within(getByTestId("chat-transcript-viewport")).getByText("Original task")).toBeInTheDocument()
		})
	})

	it("shows sending is disabled when task is active", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with active task that should disable sending
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 1000,
					text: "Task in progress",
				},
				{
					type: "ask",
					ask: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "readFile", path: "test.txt" }),
					partial: true, // Partial messages disable sending
				},
			],
		})

		// Wait for state to be updated and check that the active turn exposes Stop/Queue controls.
		await waitFor(() => {
			const chatTextArea = getByTestId("chat-textarea")
			const input = chatTextArea.querySelector("input")!
			expect(input.getAttribute("data-is-streaming")).toBe("true")
		})
	})

	it("shows sending is enabled when no task is active", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with completed task
		mockPostMessage({
			clineMessages: [
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now(),
					text: "Task completed",
					partial: false,
				},
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Check that sending is enabled
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")!
		expect(input.getAttribute("data-sending-disabled")).toBe("false")
	})

	it("queues messages when API request is in progress (spinner visible)", async () => {
		const { getByTestId } = renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Clear any initial calls
		vi.mocked(vscode.postMessage).mockClear()

		// Add api_req_started without cost (spinner state - API request in progress)
		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }), // No cost = still streaming
				},
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user typing and sending a message during the spinner
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		// Trigger message send by simulating typing and Enter key press
		await act(async () => {
			// Use fireEvent to properly trigger React's onChange handler
			fireEvent.change(input, { target: { value: "follow-up question during spinner" } })

			// Simulate pressing Enter to send
			fireEvent.click(getByTestId("mock-enqueue"))
		})

		// Verify that the message was queued, not sent as askResponse
		let queuedRequest: any
		await waitFor(() => {
			queuedRequest = vi
				.mocked(vscode.postMessage)
				.mock.calls.map(([message]) => message)
				.find((message) => message.type === "queueMessage")
			expect(queuedRequest).toEqual({
				type: "queueMessage",
				clientSubmittedAt: expect.any(Number),
				text: "follow-up question during spinner",
				images: [],
				taskId: "task-1",
				requestId: expect.any(String),
			})
		})
		expect(input.value).toBe("follow-up question during spinner")

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "chatCommandResult",
						taskId: "task-1",
						requestId: queuedRequest.requestId,
						chatCommandResult: {
							requestId: queuedRequest.requestId,
							taskId: "task-1",
							command: "queueMessage",
							status: "accepted",
						},
					},
				}),
			)
		})
		await waitFor(() => {
			expect(input.value).toBe("")
		})

		// Verify it was NOT sent as a direct askResponse (which would get lost)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "messageResponse",
			}),
		)
	})

	it("keeps the draft when a queued message has no active task target", async () => {
		const { getByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: undefined,
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }),
				},
			],
		})

		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		vi.mocked(vscode.postMessage).mockClear()
		const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement

		await act(async () => {
			fireEvent.change(input, { target: { value: "keep this draft" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
		expect(input.value).toBe("keep this draft")
	})

	it("keeps a queued draft visible when the host rejects admission", async () => {
		const { getByRole, getByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Initial task" },
				{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "openai" }) },
			],
		})

		const input = (await waitFor(() => getByTestId("chat-textarea").querySelector("input"))) as HTMLInputElement
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.change(input, { target: { value: "do not lose this draft" } })
		fireEvent.click(getByTestId("mock-enqueue"))

		const request = await waitFor(() => {
			const posted = vi
				.mocked(vscode.postMessage)
				.mock.calls.map(([message]) => message)
				.find((message) => message.type === "queueMessage") as any
			expect(posted?.requestId).toEqual(expect.any(String))
			return posted
		})
		expect(input).toHaveValue("do not lose this draft")

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "chatCommandResult",
						taskId: "task-1",
						requestId: request.requestId,
						chatCommandResult: {
							requestId: request.requestId,
							taskId: "task-1",
							command: "queueMessage",
							status: "rejected",
							errorCode: "task_unavailable",
						},
					},
				}),
			)
		})

		expect(input).toHaveValue("do not lose this draft")
		expect(getByRole("alert")).toHaveTextContent("chat:queuedMessages.queueFailed")
	})

	it.each(["legacy", "compact"])(
		"submits a %s steering draft once and retains new typing until its receipt",
		async (source) => {
			const observedTurnId = source === "compact" ? "compact-turn" : "observed-turn"
			const ref = React.createRef<ChatViewRef>()
			const view = renderChatView({}, ref)
			mockPostMessage({
				currentTaskId: "task-1",
				...(source === "compact"
					? {
							liveTasksById: {
								"task-1": {
									id: "task-1",
									status: "running",
									lifecycle: "running",
									isActive: true,
									isStreaming: true,
									isTurnActive: true,
									canInterrupt: true,
									isWaitingForInput: false,
									turnId: observedTurnId,
									hasPendingToolCalls: false,
									queueCount: 0,
									tokensIn: 0,
									tokensOut: 0,
									totalCost: 0,
								},
							},
						}
					: {}),
				agentLifecycleSnapshots: {
					"task-1": agentLifecycleSnapshotSchema.parse({
						version: 1,
						taskId: "task-1",
						runId: "run-1",
						turnId: "observed-turn",
						status: "in_progress",
						phase: "working",
						lastSequence: 0,
						items: [],
						steps: [],
						acceptedToolCallIds: [],
						terminalToolCallIds: [],
						processedEvents: [],
					}),
				},
				clineMessages: [
					{ type: "say", say: "task", ts: 1, text: "Initial task" },
					{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "openai" }) },
				],
			})
			const input = await waitFor(
				() => view.getByTestId("chat-textarea").querySelector("input") as HTMLInputElement,
			)
			fireEvent.change(input, { target: { value: "Use the existing parser" } })
			vi.mocked(vscode.postMessage).mockClear()
			act(() => {
				ref.current!.sendAndSteer("task-1")
				ref.current!.sendAndSteer("task-1")
			})
			const requests = vi
				.mocked(vscode.postMessage)
				.mock.calls.map(([request]) => request)
				.filter((request) => request.type === "sendAndSteer")
			expect(requests).toHaveLength(1)
			const request = requests[0]
			expect(request).toMatchObject({
				taskId: "task-1",
				expectedTurnId: observedTurnId,
				text: "Use the existing parser",
				images: [],
				requestId: expect.any(String),
			})
			fireEvent.click(view.getByTestId("mock-stop"))
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "cancelTask",
				taskId: "task-1",
				expectedTurnId: observedTurnId,
			})
			expect(input).toHaveValue("Use the existing parser")
			fireEvent.change(input, { target: { value: "Next instruction" } })
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "chatCommandResult",
							chatCommandResult: {
								command: "sendAndSteer",
								taskId: "task-1",
								requestId: request.requestId,
								status: "accepted",
							},
						},
					}),
				),
			)
			expect(input).toHaveValue("Next instruction")
		},
	)

	describe.each([undefined, false, true])("ordinary submission with autoSteer=%s", (autoSteer) => {
		it.each(["Enter", "click", "host command"] as const)(
			"uses the configured active-turn delivery for %s",
			async (submission) => {
				const ref = React.createRef<ChatViewRef>()
				const view = renderChatView({}, ref)
				mockPostMessage({
					currentTaskId: "task-1",
					...(autoSteer === undefined ? {} : { autoSteer }),
					clineMessages: [
						{ type: "say", say: "task", ts: 1, text: "Initial task" },
						{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "openai" }) },
					],
				})
				await waitFor(() => expect(view.getByText("Initial task")).toBeInTheDocument())
				const input = view.getByTestId("chat-textarea").querySelector("input") as HTMLInputElement
				vi.mocked(vscode.postMessage).mockClear()
				fireEvent.change(input, { target: { value: "Use the new direction" } })
				expect(vscode.postMessage).not.toHaveBeenCalled()
				if (submission === "Enter") fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
				else if (submission === "click") fireEvent.click(view.getByTestId("mock-send"))
				else act(() => ref.current!.acceptInput())
				expect(vscode.postMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						type: autoSteer ? "sendAndSteer" : "queueMessage",
						taskId: "task-1",
						text: "Use the new direction",
						requestId: expect.any(String),
					}),
				)
				expect(vscode.postMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ type: autoSteer ? "queueMessage" : "sendAndSteer" }),
				)
				expect(input).toHaveValue("Use the new direction")
			},
		)
	})

	it("keeps the explicit Queue action when auto-steer is enabled", async () => {
		const view = renderChatView()
		mockPostMessage({
			currentTaskId: "task-1",
			autoSteer: true,
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Initial task" },
				{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "openai" }) },
			],
		})
		await waitFor(() => expect(view.getByText("Initial task")).toBeInTheDocument())
		const input = view.getByTestId("chat-textarea").querySelector("input") as HTMLInputElement
		fireEvent.change(input, { target: { value: "Save this instruction for later" } })
		fireEvent.click(view.getByTestId("mock-enqueue"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "queueMessage",
				taskId: "task-1",
				text: "Save this instruction for later",
			}),
		)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "sendAndSteer" }))
	})

	it("reports a retained steering message without keeping a duplicate draft", async () => {
		const ref = React.createRef<ChatViewRef>()
		const view = renderChatView({}, ref)
		const runningMessages: AlphaMessage[] = [
			{ type: "say", say: "task", ts: 1, text: "Initial task" },
			{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "openai" }) },
		]
		mockPostMessage({ currentTaskId: "task-1", clineMessages: runningMessages })
		const input = await waitFor(() => view.getByTestId("chat-textarea").querySelector("input") as HTMLInputElement)
		fireEvent.change(input, { target: { value: "Retain this correction" } })
		vi.mocked(vscode.postMessage).mockClear()
		act(() => ref.current!.sendAndSteer("task-1"))
		const request = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "sendAndSteer")![0]
		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: runningMessages,
			messageQueue: [{ id: request.requestId!, text: request.text!, images: [] }],
		})
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "chatCommandResult",
						chatCommandResult: {
							command: "sendAndSteer",
							taskId: "task-1",
							requestId: request.requestId,
							status: "accepted",
							deliveryState: "queued",
						},
					},
				}),
			),
		)
		expect(input).toHaveValue("")
		await waitFor(() => expect(view.getByTestId("queued-messages")).toHaveTextContent("Retain this correction"))
		expect(view.getByRole("alert")).toHaveTextContent("chat:queuedMessages.steerRetained")
	})

	it("answers a complete follow-up through send-and-steer even before waiting metadata arrives", async () => {
		const ref = React.createRef<ChatViewRef>()
		const view = renderChatView({}, ref)
		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Initial task" },
				{ type: "ask", ask: "followup", ts: 2, text: "Which parser?" },
			],
			liveTasksById: {
				"task-1": {
					id: "task-1",
					status: "running",
					lifecycle: "running",
					isActive: true,
					isStreaming: false,
					isTurnActive: true,
					isWaitingForInput: false,
					lastUpdatedAt: 2,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
		})
		const input = await waitFor(() => view.getByTestId("chat-textarea").querySelector("input") as HTMLInputElement)
		fireEvent.change(input, { target: { value: "Use the existing parser" } })
		vi.mocked(vscode.postMessage).mockClear()
		act(() => ref.current!.sendAndSteer("task-1"))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "messageResponse",
				askMessageTs: 2,
				taskId: "task-1",
				text: "Use the existing parser",
			}),
		)
	})

	it("preserves a steering draft when its provider is retired", async () => {
		const ref = React.createRef<ChatViewRef>()
		const view = renderChatView({}, ref)
		mockPostMessage({
			currentTaskId: "task-1",
			apiConfiguration: { apiProvider: "bedrock" },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Initial task" },
				{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "anthropic" }) },
			],
		})
		const input = await waitFor(() => view.getByTestId("chat-textarea").querySelector("input") as HTMLInputElement)
		fireEvent.change(input, { target: { value: "Keep this draft" } })
		vi.mocked(vscode.postMessage).mockClear()
		act(() => ref.current!.sendAndSteer("task-1"))
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(input).toHaveValue("Keep this draft")
		expect(view.getByText("chat:retiredProvider.message")).toBeInTheDocument()
	})

	it.each(["rejected", "accepted"] as const)(
		"handles a %s steering receipt after switching tasks without losing either draft",
		async (status) => {
			const ref = React.createRef<ChatViewRef>()
			const view = renderChatView({}, ref)
			const runningMessages = [
				{ type: "say" as const, say: "task", ts: 1, text: "Initial task" },
				{
					type: "say" as const,
					say: "api_req_started",
					ts: 2,
					text: JSON.stringify({ apiProtocol: "openai" }),
				},
			]
			mockPostMessage({ currentTaskId: "task-1", clineMessages: runningMessages })
			const input = await waitFor(
				() => view.getByTestId("chat-textarea").querySelector("input") as HTMLInputElement,
			)
			fireEvent.change(input, { target: { value: "Steering correction" } })
			vi.mocked(vscode.postMessage).mockClear()
			act(() => ref.current!.sendAndSteer("task-1"))
			const request = vi
				.mocked(vscode.postMessage)
				.mock.calls.find(([message]) => message.type === "sendAndSteer")![0]
			mockPostMessage({ currentTaskId: "task-2", clineMessages: runningMessages })
			await waitFor(() => expect(input).toHaveValue(""))
			fireEvent.change(input, { target: { value: "Other task draft" } })
			vi.mocked(vscode.postMessage).mockClear()
			act(() => ref.current!.sendAndSteer("task-1"))
			expect(vscode.postMessage).not.toHaveBeenCalled()
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "chatCommandResult",
							chatCommandResult: {
								command: "sendAndSteer",
								taskId: "task-1",
								requestId: request.requestId,
								status,
							},
						},
					}),
				),
			)
			expect(input).toHaveValue("Other task draft")
			mockPostMessage({ currentTaskId: "task-1", clineMessages: runningMessages })
			await waitFor(() => expect(input).toHaveValue(status === "accepted" ? "" : "Steering correction"))
		},
	)

	it.each(["sendAndSteer", "steerNextQueuedMessage"] as const)(
		"preserves a hidden composer's draft for %s",
		async (command) => {
			const ref = React.createRef<ChatViewRef>()
			const view = renderChatView({ isHidden: true }, ref)
			mockPostMessage({
				currentTaskId: "task-1",
				clineMessages: [
					{ type: "say", say: "task", ts: 1, text: "Initial task" },
					{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "openai" }) },
				],
			})
			const input = await waitFor(
				() => view.getByTestId("chat-textarea").querySelector("input") as HTMLInputElement,
			)
			fireEvent.change(input, { target: { value: "Draft for later" } })
			vi.mocked(vscode.postMessage).mockClear()
			act(() => ref.current![command]("task-1"))
			expect(vscode.postMessage).not.toHaveBeenCalled()
			expect(input).toHaveValue("Draft for later")
		},
	)

	it("does not approve a pending action when send-and-steer has an empty draft", async () => {
		const ref = React.createRef<ChatViewRef>()
		const view = renderChatView({}, ref)
		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Initial task" },
				{
					type: "ask",
					ask: "tool",
					ts: 2,
					text: JSON.stringify({ tool: "editedExistingFile", path: "test.js" }),
				},
			],
		})
		await waitFor(() => view.getByTestId("chat-textarea"))
		vi.mocked(vscode.postMessage).mockClear()
		act(() => ref.current!.sendAndSteer("task-1"))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it.each([false, true])("steers the host queue without submitting the composer (empty queue: %s)", async (empty) => {
		const ref = React.createRef<ChatViewRef>()
		const view = renderChatView({}, ref)
		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Initial task" },
				{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "anthropic" }) },
			],
			messageQueue: empty ? [] : [{ id: "queued-1", text: "first queued input", images: [] }],
		})
		const input = await view.findByRole("textbox")
		fireEvent.change(input, { target: { value: "leave this unsent draft alone" } })
		vi.mocked(vscode.postMessage).mockClear()
		act(() => {
			ref.current!.steerNextQueuedMessage("task-1")
			ref.current!.steerNextQueuedMessage("task-1")
		})
		const requests = () =>
			vi
				.mocked(vscode.postMessage)
				.mock.calls.flatMap(([message]) => (message.type === "steerNextQueuedMessage" ? [message] : []))
		expect(requests()).toHaveLength(1)
		const request = requests()[0]
		expect(request).not.toHaveProperty("text")
		expect(request).not.toHaveProperty("images")
		expect(input).toHaveValue("leave this unsent draft alone")
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "chatCommandResult",
						taskId: "task-1",
						requestId: request.requestId,
						chatCommandResult: {
							requestId: request.requestId,
							taskId: "task-1",
							command: "steerNextQueuedMessage",
							status: "accepted",
						},
					},
				}),
			),
		)
		// The host selects the next item even if the displayed queue has not refreshed yet.
		act(() => ref.current!.steerNextQueuedMessage("task-1"))
		expect(requests()).toHaveLength(2)
		expect(requests()[1].requestId).not.toBe(request.requestId)
		expect(input).toHaveValue("leave this unsent draft alone")
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "sendAndSteer" }))
	})

	it("renders a steer button for queued messages and posts steerQueuedMessage with the task id", async () => {
		const { getByTestId, getByLabelText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			agentLifecycleSnapshots: {
				"task-1": agentLifecycleSnapshotSchema.parse({
					version: 1,
					taskId: "task-1",
					runId: "queued-run",
					turnId: "observed-queued-turn",
					status: "in_progress",
					phase: "working",
					lastSequence: 0,
					items: [],
					steps: [],
					acceptedToolCallIds: [],
					terminalToolCallIds: [],
					processedEvents: [],
				}),
			},
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }),
				},
			],
			messageQueue: [{ id: "msg1", text: "queued message 1", images: [] }],
		})

		await waitFor(() => {
			expect(getByTestId("queued-messages")).toBeInTheDocument()
		})

		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(getByLabelText("Steer"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "steerQueuedMessage",
			text: "msg1",
			taskId: "task-1",
			requestId: expect.any(String),
			expectedTurnId: "observed-queued-turn",
		})
	})

	it("keeps a queued message retryable when steering is rejected", async () => {
		const { getByLabelText, getByRole, getByText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Initial task" },
				{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "openai" }) },
			],
			messageQueue: [{ id: "msg1", text: "keep this queued message", images: [] }],
		})

		const steer = await waitFor(() => getByLabelText("Steer"))
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(steer)
		const request = vi.mocked(vscode.postMessage).mock.calls[0][0] as any
		expect(request.requestId).toEqual(expect.any(String))
		expect(getByText("keep this queued message")).toBeInTheDocument()
		expect(steer).toBeDisabled()

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "chatCommandResult",
						taskId: "task-1",
						requestId: request.requestId,
						chatCommandResult: {
							requestId: request.requestId,
							taskId: "task-1",
							command: "steerQueuedMessage",
							status: "rejected",
							errorCode: "steer_pending",
						},
					},
				}),
			)
		})

		expect(getByText("keep this queued message")).toBeInTheDocument()
		expect(getByRole("alert")).toHaveTextContent("chat:queuedMessages.steerFailed")
		expect(steer).toBeEnabled()
	})

	it("edits a queued message from the composer and preserves the queued id", async () => {
		const { getByTestId, getByLabelText, getByText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }),
				},
			],
			messageQueue: [{ id: "msg1", text: "queued message 1", images: ["img1.png"] }],
		})

		await waitFor(() => {
			expect(getByTestId("queued-messages")).toBeInTheDocument()
		})

		const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(getByLabelText("Edit msg1"))

		await waitFor(() => {
			expect(input.value).toBe("queued message 1")
			expect(getByText("Editing in composer")).toBeInTheDocument()
		})

		await act(async () => {
			fireEvent.change(input, { target: { value: "edited queued message" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "editQueuedMessage",
				requestId: expect.any(String),
				payload: {
					id: "msg1",
					text: "edited queued message",
					images: ["img1.png"],
				},
				taskId: "task-1",
			})
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
	})

	it("cancels queued message editing and restores the prior composer draft", async () => {
		const { getByTestId, getByLabelText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }),
				},
			],
			messageQueue: [{ id: "msg1", text: "queued message 1", images: [] }],
		})

		await waitFor(() => {
			expect(getByTestId("queued-messages")).toBeInTheDocument()
		})

		const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "unsent draft" } })
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(getByLabelText("Edit msg1"))
		await waitFor(() => expect(input.value).toBe("queued message 1"))

		fireEvent.keyDown(input, { key: "Escape", code: "Escape" })

		await waitFor(() => expect(input.value).toBe("unsent draft"))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editQueuedMessage" }))
	})

	it("keeps native answers retryable instead of overwriting an instruction being edited in the queue", async () => {
		const view = renderChatView()
		const taskId = "native-queue-edit"
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Choose an environment" },
				{ ...nativeInputMessage },
			],
			messageQueue: [{ id: "native-queued-instruction", text: "Keep this queued instruction", images: [] }],
		})
		const submit = await waitFor(() => view.getByTestId("native-user-input-submit-2"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Separate composer draft" } })
		fireEvent.click(view.getByLabelText("Edit native-queued-instruction"))
		await waitFor(() => expect(input).toHaveValue("Keep this queued instruction"))
		fireEvent.change(input, { target: { value: "Edited queued instruction" } })
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(submit)

		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editQueuedMessage" }))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
		expect(input).toHaveValue("Edited queued instruction")
		expect(view.getByText("Editing in composer")).toBeInTheDocument()
		expect(submit).toBeEnabled()

		fireEvent.keyDown(input, { key: "Escape", code: "Escape" })
		await waitFor(() => expect(input).toHaveValue("Separate composer draft"))
		fireEvent.click(submit)
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askMessageTs: 2,
				text: JSON.stringify({ answers: { environment: { answers: ["Staging"] } } }),
				taskId,
			}),
		)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editQueuedMessage" }))
	})

	it("rejects native answers from an older question after a newer input boundary instead of queueing its packet", async () => {
		const view = renderChatView()
		const taskId = "stale-native-question"
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Inspect the environment" },
				{ ...nativeInputMessage },
				{ type: "say", say: "api_req_started", ts: 3, text: JSON.stringify({ apiProtocol: "openai" }) },
			],
			liveTasksById: {
				[taskId]: { id: taskId, status: "running", isActive: true, isTurnActive: true, isStreaming: true },
			},
		})
		const submit = await waitFor(() => view.getByTestId("native-user-input-submit-2"))
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(submit)

		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
		expect(submit).toBeEnabled()
	})

	it("keeps native answers bound to their originating question identity when a newer question is visible", async () => {
		const view = renderChatView()
		const taskId = "native-question-identity"
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Inspect the environment" },
				{ ...nativeInputMessage },
				{ ...nativeInputMessage, ts: 3 },
			],
		})
		const olderSubmit = await waitFor(() => view.getByTestId("native-user-input-submit-2"))
		const currentSubmit = view.getByTestId("native-user-input-submit-3")
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Keep this unrelated draft" } })
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(olderSubmit)

		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
		expect(input).toHaveValue("Keep this unrelated draft")
		expect(olderSubmit).toBeEnabled()
		fireEvent.click(currentSubmit)
		const replies = vi.mocked(vscode.postMessage).mock.calls.filter(([sent]) => sent.type === "askResponse")
		expect(replies).toHaveLength(1)
		expect(replies[0]![0]).toMatchObject({
			askMessageTs: 3,
			taskId,
			text: JSON.stringify({ answers: { environment: { answers: ["Staging"] } } }),
		})
	})

	it("keeps native cancellation bound to its originating question when a newer question is visible", async () => {
		const view = renderChatView()
		const taskId = "native-cancel-identity"
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Inspect the environment" },
				{ ...nativeInputMessage },
				{ ...nativeInputMessage, ts: 3 },
			],
		})
		const olderCancel = await waitFor(() => view.getByTestId("native-user-input-cancel-2"))
		const currentCancel = view.getByTestId("native-user-input-cancel-3")
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Keep this composer draft" } })
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(olderCancel)

		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
		expect(input).toHaveValue("Keep this composer draft")
		expect(currentCancel).toBeEnabled()
		fireEvent.click(currentCancel)
		const cancellations = vi.mocked(vscode.postMessage).mock.calls.filter(([sent]) => sent.type === "askResponse")
		expect(cancellations).toHaveLength(1)
		expect(cancellations[0]![0]).toMatchObject({
			askMessageTs: 3,
			askResponse: "noButtonClicked",
			taskId,
		})
	})

	it("keeps queued composer edits intact when cancelling the current native question", async () => {
		const view = renderChatView()
		const taskId = "native-cancel-queue-edit"
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Inspect the environment" },
				{ ...nativeInputMessage },
			],
			messageQueue: [{ id: "queued-edit", text: "Queued instruction", images: ["image.png"] }],
		})
		const cancel = await waitFor(() => view.getByTestId("native-user-input-cancel-2"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.click(view.getByLabelText("Edit queued-edit"))
		await waitFor(() => expect(input).toHaveValue("Queued instruction"))
		fireEvent.change(input, { target: { value: "Edited queued instruction" } })
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(cancel)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "askResponse", askResponse: "noButtonClicked", askMessageTs: 2, taskId }),
		)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editQueuedMessage" }))
		expect(input).toHaveValue("Edited queued instruction")
		expect(view.getByText("Editing in composer")).toBeInTheDocument()
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "editQueuedMessage",
				payload: { id: "queued-edit", text: "Edited queued instruction", images: ["image.png"] },
				taskId,
			}),
		)
	})

	it.each(["submit", "cancel"] as const)(
		"preserves separate composer text and images after a current native %s",
		async (action) => {
			const view = renderChatView()
			const taskId = `native-preserved-draft-${action}`
			const images = ["data:image/png;base64,separate-composer-image"]
			mockPostMessage({
				currentTaskId: taskId,
				currentView: { type: "task", taskId },
				clineMessages: [
					{ type: "say", say: "task", ts: 1, text: "Inspect the environment" },
					{ ...nativeInputMessage },
				],
			})
			const nativeAction = await waitFor(() => view.getByTestId(`native-user-input-${action}-2`))
			const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
			fireEvent.change(input, { target: { value: "Keep this separate composer message" } })
			act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "selectedImages", images } })))
			vi.mocked(vscode.postMessage).mockClear()

			fireEvent.click(nativeAction)

			const replies = vi.mocked(vscode.postMessage).mock.calls.filter(([sent]) => sent.type === "askResponse")
			expect(replies).toHaveLength(1)
			expect(replies[0]![0]).toMatchObject({
				taskId,
				askMessageTs: 2,
				...(action === "submit"
					? {
							askResponse: "messageResponse",
							text: JSON.stringify({ answers: { environment: { answers: ["Staging"] } } }),
							images: [],
						}
					: { askResponse: "noButtonClicked" }),
			})
			expect(input).toHaveValue("Keep this separate composer message")
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "queueMessage",
					taskId,
					text: "Keep this separate composer message",
					images,
				}),
			)
		},
	)

	it.each(["", "Keep this separate composer message"])(
		"keeps composer draft '%s' separate from native answer JSON when its acknowledgement is rejected",
		async (composerDraft) => {
			const view = renderChatView()
			const taskId = "native-rejected-ack-draft"
			mockPostMessage({
				currentTaskId: taskId,
				currentView: { type: "task", taskId },
				clineMessages: [
					{ type: "say", say: "task", ts: 1, text: "Inspect the environment" },
					{ ...nativeInputMessage },
				],
			})
			const submit = await waitFor(() => view.getByTestId("native-user-input-submit-2"))
			const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
			fireEvent.change(input, { target: { value: composerDraft } })
			vi.mocked(vscode.postMessage).mockClear()
			fireEvent.click(submit)
			const request = vi.mocked(vscode.postMessage).mock.calls.find(([sent]) => sent.type === "askResponse")![0]

			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "chatCommandResult",
							chatCommandResult: {
								command: "askResponse",
								requestId: request.requestId,
								taskId,
								status: "rejected",
							},
						},
					}),
				),
			)

			expect(input).toHaveValue(composerDraft)
			expect(view.getByRole("alert")).toHaveTextContent("chat:queuedMessages.answerFailed")
		},
	)

	it.each(["failed", "closed"] as const)(
		"rejects native answers in a %s task instead of creating a new task from its answer packet",
		async (lifecycle) => {
			const view = renderChatView()
			const taskId = `terminal-native-${lifecycle}`
			mockPostMessage({
				currentTaskId: taskId,
				currentView: { type: "task", taskId },
				clineMessages: [
					{ type: "say", say: "task", ts: 1, text: "Inspect the environment" },
					{ ...nativeInputMessage },
				],
				liveTasksById: {
					[taskId]: {
						id: taskId,
						status: "idle",
						lifecycle,
						isActive: false,
						isStreaming: false,
						isWaitingForInput: false,
					},
				},
			})
			const submit = await waitFor(() => view.getByTestId("native-user-input-submit-2"))
			const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
			fireEvent.change(input, { target: { value: "Preserve this composer draft" } })
			vi.mocked(vscode.postMessage).mockClear()

			fireEvent.click(submit)

			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "newTask" }))
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
			expect(input).toHaveValue("Preserve this composer draft")
			expect(submit).toBeEnabled()
		},
	)

	it("posts reorderQueuedMessage when moving a queued message to the front", async () => {
		const { getByTestId, getByLabelText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }),
				},
			],
			messageQueue: [
				{ id: "msg1", text: "queued message 1", images: [] },
				{ id: "msg2", text: "queued message 2", images: [] },
			],
		})

		await waitFor(() => {
			expect(getByTestId("queued-messages")).toBeInTheDocument()
		})

		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(getByLabelText("Move msg2 to front"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "reorderQueuedMessage",
			payload: {
				id: "msg2",
				toIndex: 0,
			},
			taskId: "task-1",
		})
	})

	it("does not attach composer text when approving a tool request", async () => {
		const { getByTestId, getByText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "readFile", path: "test.txt" }),
					partial: false,
				},
			],
		})

		await waitFor(() => {
			expect(getByText("chat:approve.title")).toBeInTheDocument()
		})

		const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "run this after approval" } })

		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(getByText("chat:approve.title"))

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "yesButtonClicked",
				taskId: "task-1",
			}),
		)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				text: "run this after approval",
			}),
		)
		expect(input.value).toBe("run this after approval")
	})

	it.each([
		{
			button: "chat:approveOnce.title",
			decision: { decision: "approve_once" },
			availableDecisions: ["approve_once", "deny", "abort"] as const,
		},
		{
			button: "chat:reject.title",
			feedback: "Please leave that file alone.",
			decision: { decision: "deny", feedback: "Please leave that file alone." },
			availableDecisions: ["approve_once", "deny", "abort"] as const,
		},
		{
			button: "chat:approvalAbort.title",
			decision: { decision: "abort" },
			availableDecisions: ["approve_once", "deny", "abort"] as const,
		},
		{
			button: "chat:approveSession.title",
			decision: { decision: "approve_session" },
			availableDecisions: ["approve_once", "approve_session", "deny", "abort"] as const,
		},
		{
			button: "chat:approveCommand.title",
			decision: {
				decision: "approve_with_amendment",
				amendment: { kind: "exact_command", command: "node scripts/check.js" },
			},
			availableDecisions: ["approve_once", "approve_with_amendment", "deny", "abort"] as const,
			proposedAmendment: { kind: "exact_command" as const, command: "node scripts/check.js" },
			cwd: "/workspace/packages",
		},
		{
			button: "chat:approvePersistentCommand.title",
			decision: {
				decision: "approve_persistently",
				amendment: { kind: "command_prefix", prefix: "node scripts/check.js" },
			},
			availableDecisions: ["approve_once", "approve_persistently", "deny", "abort"] as const,
			proposedPersistentAmendment: { kind: "command_prefix" as const, prefix: "node scripts/check.js" },
		},
	])(
		"routes typed approval choice from $button with its request id",
		async ({
			button,
			feedback,
			decision,
			availableDecisions,
			proposedAmendment,
			proposedPersistentAmendment,
			cwd,
		}) => {
			const { getByTestId, getByText, queryByText } = renderChatView()

			mockPostMessage({
				currentTaskId: "task-1",
				clineMessages: [
					{
						type: "say",
						say: "task",
						ts: Date.now() - 2000,
						text: "Initial task",
					},
					{
						type: "ask",
						ask: "command",
						ts: Date.now(),
						text: "Read src/main.ts",
						toolApprovalRequest: {
							requestId: "task-1:call-1",
							taskId: "task-1",
							toolName: "read_file",
							description: "Read src/main.ts",
							availableDecisions: [...availableDecisions],
							...(proposedAmendment ? { proposedAmendment } : {}),
							...(proposedPersistentAmendment ? { proposedPersistentAmendment } : {}),
							...(cwd ? { cwd } : {}),
						},
					},
				],
			})

			await waitFor(() => {
				expect(getByText(button)).toBeInTheDocument()
			})
			if (!availableDecisions.some((choice) => choice === "approve_session")) {
				expect(queryByText("chat:approveSession.title")).not.toBeInTheDocument()
			}
			if (!availableDecisions.some((choice) => choice === "approve_with_amendment")) {
				expect(queryByText("chat:approveCommand.title")).not.toBeInTheDocument()
			}
			if (!availableDecisions.some((choice) => choice === "approve_persistently")) {
				expect(queryByText("chat:approvePersistentCommand.title")).not.toBeInTheDocument()
			}
			if (proposedAmendment) {
				expect(getByText(proposedAmendment.command)).toBeInTheDocument()
			}
			if (proposedPersistentAmendment) {
				expect(getByText(proposedPersistentAmendment.prefix)).toBeInTheDocument()
			}
			if (cwd) {
				expect(getByText("chat:approveCommand.cwdLabel")).toBeInTheDocument()
				expect(getByText(cwd)).toBeInTheDocument()
			}
			if (feedback) {
				const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
				fireEvent.change(input, { target: { value: feedback } })
			}

			vi.mocked(vscode.postMessage).mockClear()
			fireEvent.click(getByText(button))

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "toolApprovalResponse",
				taskId: "task-1",
				approvalRequestId: "task-1:call-1",
				toolApprovalDecision: decision,
			})
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "cancelTask" }))
		},
	)

	it("keeps an auto-approved command in the expandable actions without approval controls", async () => {
		const { getByTestId, getByRole, queryByText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "command",
					ts: Date.now(),
					text: "pnpm test",
					isAnswered: true,
					toolApprovalRequest: {
						requestId: "task-1:call-1",
						taskId: "task-1",
						toolName: "exec_command",
						description: "pnpm test",
						availableDecisions: ["approve_once", "deny", "abort"],
					},
				},
			],
		})

		const toggle = await waitFor(() => getByRole("button", { name: /chat:activityTrace.runningCommands/ }))
		expect(getByTestId("chat-message-0")).not.toBeVisible()
		fireEvent.click(toggle)
		expect(getByTestId("chat-transcript-content").textContent).toContain("pnpm test")
		expect(queryByText("chat:approveOnce.title")).not.toBeInTheDocument()
		expect(queryByText("chat:reject.title")).not.toBeInTheDocument()
	})

	it("keeps a partially parsed command visible without showing disabled approval controls", async () => {
		const { getByTestId, queryByRole, queryByText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "command",
					ts: Date.now(),
					text: "pnpm test",
					partial: true,
				},
			],
		})

		await waitFor(() => expect(getByTestId("chat-message-0")).toBeVisible())
		expect(queryByRole("button", { name: /chat:activityTrace.runningCommands/ })).not.toBeInTheDocument()
		expect(getByTestId("chat-transcript-content").textContent).toContain("pnpm test")
		expect(queryByText("chat:runCommand.title")).not.toBeInTheDocument()
		expect(queryByText("chat:reject.title")).not.toBeInTheDocument()
	})

	it("queues composer text submitted while a tool approval is pending", async () => {
		const { getByTestId, getByText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "readFile", path: "test.txt" }),
					partial: false,
				},
			],
		})

		await waitFor(() => {
			expect(getByText("chat:approve.title")).toBeInTheDocument()
		})

		const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement

		vi.mocked(vscode.postMessage).mockClear()
		await act(async () => {
			fireEvent.change(input, { target: { value: "run this after approval" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "queueMessage",
			clientSubmittedAt: expect.any(Number),
			text: "run this after approval",
			images: [],
			taskId: "task-1",
			requestId: expect.any(String),
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
			}),
		)
	})

	it("does not show orphan composer Approve buttons for a spawn ask", async () => {
		const { queryByText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "spawnAgent", agent: { role: "explore" } }),
					partial: false,
				},
			],
		})

		await waitFor(() => {
			expect(queryByText("chat:approve.title")).not.toBeInTheDocument()
			expect(queryByText("chat:reject.title")).not.toBeInTheDocument()
		})
	})

	it("sends messages normally when API request is complete (cost present)", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with completed API request (cost present)
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({
						apiProtocol: "anthropic",
						cost: 0.05, // Cost present = streaming complete
						tokensIn: 100,
						tokensOut: 50,
					}),
				},
				{
					type: "say",
					say: "text",
					ts: Date.now(),
					text: "Response from API",
				},
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user sending a message when API is done
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		await act(async () => {
			// Use fireEvent to properly trigger React's onChange handler
			fireEvent.change(input, { target: { value: "follow-up after completion" } })

			// Simulate pressing Enter to send
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the message was sent as askResponse, not queued
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "askResponse",
					askResponse: "messageResponse",
					text: "follow-up after completion",
					images: [],
				}),
			)
		})

		// Verify it was NOT queued
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "queueMessage",
			}),
		)
	})

	it("releases queue mode when an ordinary response publishes its hidden completion boundary", async () => {
		const { getByTestId } = renderChatView()
		const taskMessage = {
			type: "say" as const,
			say: "task",
			ts: 1,
			text: "Initial task",
		}
		const requestStarted = {
			type: "say" as const,
			say: "api_req_started",
			ts: 2,
			text: JSON.stringify({ apiProtocol: "openai" }),
		}
		const taskState = {
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			currentTaskItem: { id: "task-1", task: "Initial task", ts: 1 },
		}

		mockPostMessage({
			...taskState,
			clineMessages: [taskMessage, requestStarted],
		})

		const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		await waitFor(() => expect(input.getAttribute("data-is-streaming")).toBe("true"))

		mockPostMessage({
			...taskState,
			clineMessages: [
				taskMessage,
				{
					...requestStarted,
					text: JSON.stringify({ apiProtocol: "openai", cost: 0, tokensIn: 10, tokensOut: 3 }),
				},
				{ type: "say", say: "completion_result", ts: 3, text: "Hello world!", partial: false },
				{ type: "ask", ask: "completion_result", ts: 4, text: "", partial: false },
			],
		})

		await waitFor(() => expect(input.getAttribute("data-sending-disabled")).toBe("false"))
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.change(input, { target: { value: "continue in this task" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "askResponse",
					askResponse: "messageResponse",
					text: "continue in this task",
					images: [],
					taskId: "task-1",
				}),
			)
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
	})

	it("keeps a follow-up in the current task when its model turn finishes before the completion ask appears", async () => {
		const { getByTestId } = renderChatView()
		const completedTurn = agentLifecycleSnapshotSchema.parse({
			version: 1,
			taskId: "task-1",
			runId: "run-1",
			turnId: "turn-1",
			status: "completed",
			phase: "finalizing",
			lastSequence: 1,
			terminalEventId: "event-1",
			terminalAt: 3,
			items: [],
			steps: [],
			acceptedToolCallIds: [],
			terminalToolCallIds: [],
			processedEvents: [{ eventId: "event-1", sequence: 1, fingerprint: "event-1" }],
		})

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			liveTaskIds: ["task-1"],
			liveTasksById: {
				"task-1": {
					id: "task-1",
					status: "running",
					lifecycle: "running",
					isActive: true,
					isStreaming: false,
					isWaitingForInput: false,
					lastUpdatedAt: 3,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			agentLifecycleSnapshots: { "task-1": completedTurn },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Initial task" },
				{ type: "say", say: "text", ts: 2, text: "Answer from the finished turn" },
			],
		})

		const input = (await waitFor(() => getByTestId("chat-textarea").querySelector("input"))) as HTMLInputElement
		await waitFor(() => expect(input).toHaveAttribute("data-sending-disabled", "false"))
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.change(input, { target: { value: "evaluate that answer" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "askResponse",
					askResponse: "messageResponse",
					text: "evaluate that answer",
					images: [],
					taskId: "task-1",
				}),
			)
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "newTask" }))
	})

	it.each([
		["followup", true],
		["followup", false],
		["mistake_limit_reached", true],
		["mistake_limit_reached", false],
		["api_req_failed", true],
		["api_req_failed", false],
	] as const)("answers the live %s boundary once (active turn: %s)", async (ask, isTurnActive) => {
		const view = renderChatView()
		const taskId = "active-recovery-boundary"
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			liveTasksById: {
				[taskId]: {
					id: taskId,
					status: "idle",
					lifecycle: "waiting",
					isActive: true,
					isStreaming: false,
					isTurnActive,
					isWaitingForInput: true,
					waitingReason: "idle",
				},
			},
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Inspect the parser" },
				{ type: "ask", ask, ts: 2, text: "How should I continue?", partial: false },
			],
		})
		const input = (await waitFor(() =>
			view.getByTestId("chat-textarea").querySelector("input"),
		)) as HTMLInputElement
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.change(input, { target: { value: "Use the smaller repair" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				requestId: expect.any(String),
				askMessageTs: 2,
				askResponse: "messageResponse",
				taskId,
				text: "Use the smaller repair",
			}),
		)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))

		fireEvent.change(input, { target: { value: "Keep this for the next turn" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		expect(vi.mocked(vscode.postMessage).mock.calls.filter(([sent]) => sent.type === "askResponse")).toHaveLength(1)
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "queueMessage", taskId, text: "Keep this for the next turn" }),
		)
	})

	it.each([
		["mistake_limit_reached", "partial"],
		["mistake_limit_reached", "answered"],
		["mistake_limit_reached", "superseded"],
		["api_req_failed", "partial"],
		["api_req_failed", "answered"],
		["api_req_failed", "superseded"],
	] as const)("keeps input queued behind a %s recovery ask that is %s", async (ask, boundaryState) => {
		const view = renderChatView()
		const taskId = "unavailable-recovery-boundary"
		mockPostMessage({
			currentTaskId: taskId,
			currentView: { type: "task", taskId },
			liveTasksById: {
				[taskId]: {
					id: taskId,
					status: "running",
					lifecycle: "running",
					isActive: true,
					isStreaming: true,
					isTurnActive: true,
					isWaitingForInput: false,
				},
			},
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Inspect the parser" },
				{
					type: "ask",
					ask,
					ts: 2,
					text: "How should I continue?",
					partial: boundaryState === "partial",
					isAnswered: boundaryState === "answered",
				},
				...(boundaryState === "superseded"
					? [{ type: "say" as const, say: "api_req_started", ts: 3, text: "{}" }]
					: []),
			],
		})
		const input = (await waitFor(() =>
			view.getByTestId("chat-textarea").querySelector("input"),
		)) as HTMLInputElement
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.change(input, { target: { value: "Keep this for the next turn" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "queueMessage", taskId, text: "Keep this for the next turn" }),
		)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
	})

	it.each(["completion_result", "followup"] as const)(
		"shows a pending state while resuming a completed live task with a stale %s ask",
		async (staleAsk) => {
			const { getByTestId, queryByRole, queryByTestId } = renderChatView()

			mockPostMessage({
				currentTaskId: "task-1",
				liveTasksById: {
					"task-1": {
						id: "task-1",
						status: "running",
						lifecycle: "completed",
						isActive: true,
						isStreaming: false,
						isWaitingForInput: false,
						lastUpdatedAt: Date.now(),
						queueCount: 0,
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				},
				clineMessages: [
					{
						type: "say",
						say: "task",
						ts: Date.now() - 2000,
						text: "Initial task",
					},
					{
						type: "ask",
						ask: staleAsk,
						ts: Date.now(),
						text:
							staleAsk === "completion_result"
								? "Accepted task completion"
								: JSON.stringify({ question: "Stale question?", suggest: [] }),
						partial: false,
					},
				],
			})

			await waitFor(() => {
				expect(getByTestId("chat-textarea")).toBeInTheDocument()
			})
			expect(queryByRole("button", { name: "chat:startNewTask.title" })).not.toBeInTheDocument()

			vi.mocked(vscode.postMessage).mockClear()
			const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement

			await act(async () => {
				fireEvent.change(input, { target: { value: "new work" } })
				fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
			})

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "resumeCompletedTask",
				requestId: expect.any(String),
				taskId: "task-1",
				text: "new work",
				images: [],
			})
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "newTask" }))
			expect(vscode.postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({
					type: "askResponse",
				}),
			)
			expect(getByTestId("completed-task-resume-pending")).toBeInTheDocument()
			expect(queryByRole("button", { name: "chat:startNewTask.title" })).not.toBeInTheDocument()
			expect(input).toHaveAttribute("data-sending-disabled", "true")

			fireEvent.change(input, { target: { value: "do not submit twice" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

			expect(vscode.postMessage).toHaveBeenCalledTimes(1)
			expect(input).toHaveValue("do not submit twice")

			await act(async () => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "chatCommandResult",
							chatCommandResult: {
								command: "resumeCompletedTask",
								taskId: "task-1",
								status: "rejected",
								requestId: vi
									.mocked(vscode.postMessage)
									.mock.calls.find(([message]) => message.type === "resumeCompletedTask")?.[0]
									.requestId,
							},
						},
					}),
				)
				await Promise.resolve()
			})

			await waitFor(() => {
				expect(queryByTestId("completed-task-resume-pending")).not.toBeInTheDocument()
				expect(queryByRole("button", { name: "chat:startNewTask.title" })).not.toBeInTheDocument()
				expect(input).toHaveAttribute("data-sending-disabled", "false")
				expect(input).toHaveValue("do not submit twice new work")
			})
		},
	)

	it.each(["failed", "closed"] as const)(
		"starts a new task with the submitted prompt when the visible task is %s",
		async (lifecycle) => {
			const { getByTestId } = renderChatView()

			mockPostMessage({
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				liveTasksById: {
					"task-1": {
						id: "task-1",
						status: "idle",
						lifecycle,
						isActive: false,
						isStreaming: false,
						isWaitingForInput: false,
						lastUpdatedAt: 101,
						queueCount: 0,
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				},
				clineMessages: [
					{ type: "say", say: "task", ts: 100, text: "Initial task" },
					{ type: "say", say: "error", ts: 101, text: `Task ${lifecycle}` },
				],
			})

			const input = (await waitFor(() => getByTestId("chat-textarea").querySelector("input"))) as HTMLInputElement
			await waitFor(() => {
				expect(input).toHaveAttribute("data-is-streaming", "false")
				expect(input).toHaveAttribute("data-sending-disabled", "false")
			})
			vi.mocked(vscode.postMessage).mockClear()

			fireEvent.change(input, { target: { value: "continue with this prompt" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

			await waitFor(() => {
				expect(vscode.postMessage).toHaveBeenCalledWith({
					type: "newTask",
					text: "continue with this prompt",
					images: [],
					taskId: expect.any(String),
					requestId: expect.any(String),
				})
			})
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
		},
	)

	it.each(["completed", "failed", "closed"] as const)(
		"clears stale approval controls when canonical lifecycle becomes %s after a say row",
		async (lifecycle) => {
			const { getByTestId, getByRole, queryByRole } = renderChatView()
			mockPostMessage({
				currentTaskId: "task-1",
				clineMessages: [
					{ type: "ask", ask: "tool", ts: 100, text: JSON.stringify({ tool: "readFile" }), partial: false },
				],
			})
			await waitFor(() => expect(getByRole("button", { name: "chat:approve.title" })).toBeInTheDocument())

			mockPostMessage({
				currentTaskId: "task-1",
				liveTasksById: {
					"task-1": {
						id: "task-1",
						status: "idle",
						lifecycle,
						isActive: false,
						isStreaming: false,
						isWaitingForInput: false,
						lastUpdatedAt: 101,
						queueCount: 0,
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				},
				clineMessages: [
					{ type: "ask", ask: "tool", ts: 100, text: JSON.stringify({ tool: "readFile" }), partial: false },
					{ type: "say", say: "error", ts: 101, text: "Terminal" },
				],
			})

			await waitFor(() => expect(queryByRole("button", { name: "chat:approve.title" })).not.toBeInTheDocument())
			const input = getByTestId("chat-textarea").querySelector("input")!
			expect(input).toHaveAttribute("data-is-streaming", "false")
			expect(input).toHaveAttribute("data-sending-disabled", "false")
		},
	)

	it("ignores stale canonical terminal state immediately after lifecycle degradation", async () => {
		const { getByTestId } = renderChatView()
		const completedSnapshot = agentLifecycleSnapshotSchema.parse({
			version: 1,
			taskId: "task-1",
			runId: "run-1",
			turnId: "turn-1",
			status: "completed",
			phase: "finalizing",
			lastSequence: 2,
			terminalEventId: "event-2",
			terminalAt: 2,
			items: [],
			steps: [],
			acceptedToolCallIds: [],
			terminalToolCallIds: [],
			processedEvents: [
				{ eventId: "event-1", sequence: 1, fingerprint: "event-1" },
				{ eventId: "event-2", sequence: 2, fingerprint: "event-2" },
			],
		})

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			currentTaskItem: { id: "task-1", task: "Legacy task", ts: 1 },
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Legacy task" },
				{ type: "say", say: "text", ts: 2, text: "Still running" },
			],
			liveTasksById: {
				"task-1": {
					id: "task-1",
					status: "idle",
					lifecycle: "completed",
					isActive: false,
					isStreaming: false,
					isWaitingForInput: false,
					lastUpdatedAt: 2,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			agentLifecycleSnapshots: { "task-1": completedSnapshot },
		})

		const input = (await waitFor(() => getByTestId("chat-textarea").querySelector("input"))) as HTMLInputElement
		vi.mocked(vscode.postMessage).mockClear()

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "agentLifecycleDegraded",
						taskId: "task-1",
						payload: {
							version: 1,
							taskId: "task-1",
							degraded: true,
							reason: "append_rejected",
							occurredAt: 3,
						},
					},
				}),
			)
		})

		fireEvent.change(input, { target: { value: "continue the legacy task" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "askResponse",
					askResponse: "messageResponse",
					text: "continue the legacy task",
					images: [],
					taskId: "task-1",
				}),
			)
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "newTask" }))
	})

	it.each([
		["completion_result", "waiting", true, "completion"],
		["resume_completed_task", "completed", false, undefined],
	] as const)(
		"continues the same task when the composer is submitted at %s",
		async (completionAsk, lifecycle, isWaitingForInput, waitingReason) => {
			const { getByTestId } = renderChatView()

			mockPostMessage({
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
				liveTasksById: {
					"task-1": {
						id: "task-1",
						status: "running",
						lifecycle,
						isActive: true,
						isStreaming: false,
						isWaitingForInput,
						waitingReason,
						lastUpdatedAt: Date.now(),
						queueCount: 0,
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				},
				clineMessages: [
					{
						type: "say",
						say: "task",
						ts: Date.now() - 2000,
						text: "Initial task",
					},
					{
						type: "ask",
						ask: completionAsk,
						ts: Date.now(),
						text: "Task completed",
						partial: false,
					},
				],
			})

			await waitFor(() => {
				expect(getByTestId("chat-textarea")).toBeInTheDocument()
			})

			vi.mocked(vscode.postMessage).mockClear()
			const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement

			await act(async () => {
				fireEvent.change(input, { target: { value: "follow up in this thread" } })
				fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
			})

			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "askResponse",
					askResponse: "messageResponse",
					text: "follow up in this thread",
					images: [],
					taskId: "task-1",
				}),
			)
			expect(vscode.postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({
					type: "newTask",
				}),
			)
		},
	)

	it("hides the standalone New Chat action at an open completion boundary", async () => {
		const { queryByRole, getByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			liveTasksById: {
				"task-1": {
					id: "task-1",
					status: "idle",
					lifecycle: "completed",
					isActive: true,
					isStreaming: false,
					isTurnActive: true,
					isWaitingForInput: false,
					lastUpdatedAt: 101,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			clineMessages: [
				{ type: "say", say: "task", ts: 100, text: "Initial task" },
				{
					type: "ask",
					ask: "completion_result",
					ts: 101,
					text: "Task completed",
					partial: false,
				},
			],
		})

		await waitFor(() => expect(getByTestId("mock-provider-selector")).not.toBeDisabled())
		expect(queryByRole("button", { name: "chat:startNewTask.title" })).not.toBeInTheDocument()
		expect(getByTestId("mock-provider-selector")).not.toBeDisabled()
	})

	it("hides the standalone New Chat action at a completed-task resume boundary", async () => {
		const { getByTestId, queryByRole } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			clineMessages: [
				{ type: "say", say: "task", ts: 100, text: "Initial task" },
				{
					type: "ask",
					ask: "resume_completed_task",
					ts: 101,
					text: "Task completed",
					partial: false,
				},
			],
		})

		await waitFor(() => expect(getByTestId("chat-textarea")).toBeInTheDocument())
		expect(queryByRole("button", { name: "chat:startNewTask.title" })).not.toBeInTheDocument()
		expect(getByTestId("chat-textarea").querySelector("input")).toBeInTheDocument()
	})

	it("keeps an empty new-task draft usable while stale completed-task state is in flight", async () => {
		const { getByTestId, queryByTestId } = renderChatView()
		const completedState = {
			currentTaskId: "task-1",
			currentView: { type: "task" as const, taskId: "task-1" },
			clineMessages: [
				{ type: "say" as const, say: "task", ts: 100, text: "Initial task" },
				{
					type: "ask" as const,
					ask: "completion_result",
					ts: 101,
					text: "Task completed",
					partial: false,
				},
			],
		}

		mockPostMessage(completedState)
		await act(async () => {
			window.postMessage({ type: "invoke", invoke: "newChat" }, "*")
		})

		await waitFor(() => {
			expect(queryByTestId("alpha-home-brand")).toBeInTheDocument()
			expect(getByTestId("chat-textarea").querySelector("input")!.getAttribute("data-sending-disabled")).toBe(
				"false",
			)
		})

		mockPostMessage(completedState)
		await waitFor(() => expect(queryByTestId("alpha-home-brand")).toBeInTheDocument())

		const input = getByTestId("chat-textarea").querySelector("input")!
		fireEvent.change(input, { target: { value: "new task after transition" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "newTask",
			text: "new task after transition",
			images: [],
			taskId: expect.any(String),
			requestId: expect.any(String),
		})
	})

	it("queues input instead of re-answering an already answered follow-up", async () => {
		const { getByTestId } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "followup",
					ts: Date.now(),
					text: JSON.stringify({ question: "Answered question?", suggest: [] }),
					partial: false,
					isAnswered: true,
				},
			],
		})

		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		vi.mocked(vscode.postMessage).mockClear()
		const input = getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement

		await act(async () => {
			fireEvent.change(input, { target: { value: "next message" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "queueMessage",
			clientSubmittedAt: expect.any(Number),
			text: "next message",
			images: [],
			taskId: "task-1",
			requestId: expect.any(String),
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
			}),
		)
	})

	it("preserves message order when messages sent during queue drain", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with API request in progress and existing queue
		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }), // No cost = still streaming
				},
			],
			messageQueue: [
				{ id: "msg1", text: "queued message 1", images: [] },
				{ id: "msg2", text: "queued message 2", images: [] },
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user sending a new message while queue has items
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		await act(async () => {
			fireEvent.change(input, { target: { value: "message during queue drain" } })
			fireEvent.click(getByTestId("mock-enqueue"))
		})

		// Verify that the new message was queued (not sent directly) to preserve order
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				clientSubmittedAt: expect.any(Number),
				text: "message during queue drain",
				images: [],
				taskId: "task-1",
				requestId: expect.any(String),
			})
		})

		// Verify it was NOT sent as askResponse (which would break ordering)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "messageResponse",
			}),
		)
	})

	it("queues messages during command_output state instead of losing them", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with command_output ask (Proceed While Running state)
		mockPostMessage({
			currentTaskId: "task-1",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "command_output",
					ts: Date.now(),
					text: "",
					partial: false, // Non-partial so buttons are enabled
				},
			],
		})

		// Wait for state to be updated - need to allow time for React effects to propagate
		// (alphaAsk state update -> alphaAskRef.current update)
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Allow React effects to complete (alphaAsk -> alphaAskRef sync)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50))
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user typing and sending a message during command execution
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		await act(async () => {
			fireEvent.change(input, { target: { value: "message during command execution" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the message was queued (not lost via terminalOperation)
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				clientSubmittedAt: expect.any(Number),
				text: "message during command execution",
				images: [],
				taskId: "task-1",
				requestId: expect.any(String),
			})
		})

		// Verify it was NOT sent as terminalOperation (which would lose the message)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "terminalOperation",
			}),
		)
	})
})

describe("ChatView - Context Condensing Indicator Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each([false, true])(
		"reenables the composer after a failed manual summary (batched reply=%s)",
		async (batched) => {
			const view = renderChatView()
			mockPostMessage({
				currentTaskId: "small-window-task",
				currentView: { type: "task", taskId: "small-window-task" },
				currentTaskItem: { id: "small-window-task", task: "Fill the small window", ts: 1 },
				clineMessages: [{ type: "say", say: "task", ts: 1, text: "Fill the small window" }],
			})
			const input = await waitFor(
				() => view.getByTestId("chat-textarea").querySelector("input") as HTMLInputElement,
			)
			await waitFor(() => expect(view.getByTestId("mock-send")).not.toBeDisabled())
			fireEvent.change(input, { target: { value: "compact the context" } })
			const complete = () =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "condenseTaskContextResponse", text: "small-window-task" },
					}),
				)
			await act(async () => {
				fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
				if (batched) complete()
			})
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "condenseTaskContextRequest",
				text: "small-window-task",
			})
			if (!batched) {
				expect(view.getByTestId("mock-send")).toBeDisabled()
				await act(async () => {
					complete()
				})
			}
			await waitFor(() => expect(view.getByTestId("mock-send")).not.toBeDisabled())
			fireEvent.change(input, { target: { value: "Continue after the rejected summary." } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ text: "Continue after the rejected summary." }),
			)
		},
	)

	it("should add a condensing message to groupedMessages when isCondensing is true", async () => {
		// This test verifies that when the condenseTaskContextStarted message is received,
		// the isCondensing state is set to true and a synthetic condensing message is added
		// to the grouped messages list
		const { getByTestId, container } = renderChatView()

		// First hydrate state with an active task
		mockPostMessage({
			currentTaskId: "active-task",
			currentView: { type: "task", taskId: "active-task" },
			currentTaskItem: { id: "active-task", task: "Initial task", ts: Date.now() - 2000 },
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now() - 1000,
					text: JSON.stringify({ apiProtocol: "anthropic" }),
				},
			],
		})

		// Wait for component to render
		await waitFor(() => {
			expect(getByTestId("chat-view")).toBeInTheDocument()
		})

		// Allow time for useEvent hook to register message listener
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10))
		})

		// A background task must not change the visible task's condensation state.
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "condenseTaskContextStarted", text: "background-task" },
				}),
			)
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
		expect(container.textContent).not.toContain('"say":"condense_context"')

		// The task-scoped event for the visible task starts the indicator.
		await act(async () => {
			const event = new MessageEvent("message", {
				data: {
					type: "condenseTaskContextStarted",
					text: "active-task",
				},
			})
			window.dispatchEvent(event)
			// Wait for React state updates
			await new Promise((resolve) => setTimeout(resolve, 0))
		})

		// Check that groupedMessages now includes a condensing message.
		await waitFor(
			() => {
				const rows = container.querySelectorAll('[data-testid="chat-row"]')
				// Check for the actual message structure: partial condense_context message
				const condensingRow = Array.from(rows).find((row) => {
					const text = row.textContent || ""
					return text.includes('"say":"condense_context"') && text.includes('"partial":true')
				})
				expect(condensingRow).toBeTruthy()
			},
			{ timeout: 2000 },
		)
	})
})

describe("ChatView chat-owned composer commands", () => {
	beforeEach(() => vi.clearAllMocks())
	const recoveryState = (id: string, ask: "mistake_limit_reached" | "api_req_failed"): Partial<ExtensionState> => ({
		currentTaskId: id,
		currentView: { type: "task", taskId: id },
		currentTaskItem: { id, task: `Prompt ${id}`, ts: 1 },
		liveTasksById: {
			[id]: {
				id,
				status: "idle",
				lifecycle: "waiting",
				isActive: true,
				isStreaming: false,
				isTurnActive: true,
				isWaitingForInput: true,
			},
		},
		clineMessages: [
			{ type: "say", say: "task", ts: 1, text: `Prompt ${id}` },
			{ type: "ask", ask, ts: 2, text: "How should I continue?", partial: false },
		],
		messageQueue: [],
	})
	const runningState = (id: string, queue: Array<{ id: string; text: string }> = []): Partial<ExtensionState> => ({
		currentTaskId: id,
		currentView: { type: "task", taskId: id },
		currentTaskItem: { id, task: `Prompt ${id}`, ts: 1 },
		clineMessages: [
			{ type: "say", say: "task", ts: 1, text: `Prompt ${id}` },
			{ type: "say", say: "api_req_started", ts: 2, text: JSON.stringify({ apiProtocol: "anthropic" }) },
		],
		messageQueue: queue,
	})
	const receipt = (command: string, requestId: string, taskId: string, status: string, deliveryState?: "queued") =>
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "chatCommandResult",
						chatCommandResult: { command, requestId, taskId, status, deliveryState },
					},
				}),
			),
		)
	it.each([
		["mistake_limit_reached", false],
		["mistake_limit_reached", true],
		["api_req_failed", false],
		["api_req_failed", true],
	] as const)(
		"keeps an accepted %s recovery reply claimed until its transcript moves (switch chat: %s)",
		async (ask, switchChat) => {
			const view = renderChatView()
			const stateA = recoveryState("a", ask)
			mockPostMessage(stateA)
			await waitFor(() => expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Prompt a"))
			const input = (await waitFor(() =>
				view.getByTestId("chat-textarea").querySelector("input"),
			)) as HTMLInputElement
			vi.mocked(vscode.postMessage).mockClear()
			fireEvent.change(input, { target: { value: "Recover chat A" } })
			fireEvent.keyDown(input, { key: "Enter" })
			const request = vi.mocked(vscode.postMessage).mock.calls.find(([sent]) => sent.type === "askResponse")![0]

			if (switchChat) {
				mockPostMessage(recoveryState("b", ask))
				await waitFor(() => expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Prompt b"))
				fireEvent.change(input, { target: { value: "Recover chat B" } })
				fireEvent.keyDown(input, { key: "Enter" })
				const requestB = vi
					.mocked(vscode.postMessage)
					.mock.calls.find(([sent]) => sent.type === "askResponse" && sent.taskId === "b")![0]
				receipt("askResponse", requestB.requestId!, "b", "accepted")
				fireEvent.change(input, { target: { value: "Preserve B's draft" } })
			}
			receipt("askResponse", request.requestId!, "a", "accepted")
			if (switchChat) {
				mockPostMessage(stateA)
				await waitFor(() => expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Prompt a"))
			}

			fireEvent.change(input, { target: { value: "Then inspect the tests" } })
			fireEvent.keyDown(input, { key: "Enter" })
			expect(
				vi
					.mocked(vscode.postMessage)
					.mock.calls.filter(([sent]) => sent.type === "askResponse" && sent.taskId === "a"),
			).toHaveLength(1)
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "queueMessage", taskId: "a", text: "Then inspect the tests" }),
			)
			if (switchChat) {
				mockPostMessage(recoveryState("b", ask))
				await waitFor(() => expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Prompt b"))
				expect(input).toHaveValue("Preserve B's draft")
			}
		},
	)

	it.each(["mistake_limit_reached", "api_req_failed"] as const)(
		"releases a rejected %s recovery reply for its owning background chat",
		async (ask) => {
			const view = renderChatView()
			const stateA = recoveryState("a", ask)
			mockPostMessage(stateA)
			await waitFor(() => expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Prompt a"))
			const input = (await waitFor(() =>
				view.getByTestId("chat-textarea").querySelector("input"),
			)) as HTMLInputElement
			vi.mocked(vscode.postMessage).mockClear()
			fireEvent.change(input, { target: { value: "Recover chat A" } })
			fireEvent.keyDown(input, { key: "Enter" })
			const request = vi.mocked(vscode.postMessage).mock.calls.find(([sent]) => sent.type === "askResponse")![0]
			mockPostMessage(recoveryState("b", ask))
			await waitFor(() => expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Prompt b"))
			fireEvent.change(input, { target: { value: "Preserve B's draft" } })
			receipt("askResponse", request.requestId!, "a", "rejected")
			expect(input).toHaveValue("Preserve B's draft")

			mockPostMessage(stateA)
			await waitFor(() => expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Prompt a"))
			expect(input).toHaveValue("Recover chat A")
			fireEvent.keyDown(input, { key: "Enter" })
			expect(
				vi
					.mocked(vscode.postMessage)
					.mock.calls.filter(([sent]) => sent.type === "askResponse" && sent.taskId === "a"),
			).toHaveLength(2)
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
		},
	)

	it("shows a completed-chat follow-up immediately in the transcript throughout durable admission", async () => {
		const view = renderChatView()
		const completedState: Partial<ExtensionState> = {
			currentTaskId: "a",
			currentView: { type: "task", taskId: "a" },
			currentTaskItem: { id: "a", task: "Prompt a", ts: 1 },
			liveTasksById: {
				a: {
					id: "a",
					status: "idle",
					lifecycle: "completed",
					isActive: true,
					isTurnActive: false,
					isStreaming: false,
					isWaitingForInput: false,
					lastUpdatedAt: 2,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Prompt a" },
				{ type: "say", say: "completion_result", ts: 2, text: "Finished." },
			],
			messageQueue: [],
		}
		mockPostMessage(completedState)
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Explain the result" } })
		fireEvent.keyDown(input, { key: "Enter" })
		const request = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "resumeCompletedTask")![0]
		const feedbackRows = () =>
			view
				.getAllByTestId("chat-row")
				.filter(
					(row) =>
						row.textContent?.includes('"say":"user_feedback"') &&
						row.textContent.includes("Explain the result"),
				)
		expect(feedbackRows()).toHaveLength(1)
		expect(view.queryByTestId("queued-messages")).not.toBeInTheDocument()

		const queued = { id: request.requestId!, timestamp: 3, text: "Explain the result", deliveryState: "delivering" }
		mockPostMessage({ ...completedState, messageQueue: [queued] })
		receipt("resumeCompletedTask", request.requestId!, "a", "accepted")
		expect(feedbackRows()).toHaveLength(1)
		expect(view.queryByTestId("queued-messages")).not.toBeInTheDocument()

		mockPostMessage({
			...completedState,
			messageQueue: [queued],
			clineMessages: [
				...completedState.clineMessages!,
				{
					type: "say",
					say: "user_feedback",
					ts: 4,
					text: "Explain the result",
					queuedMessageIds: [request.requestId!],
				},
			],
		})
		await waitFor(() => {
			expect(feedbackRows()).toHaveLength(1)
			expect(feedbackRows()[0]).toHaveTextContent('"ts":4')
			expect(view.queryByTestId("completed-task-resume-pending")).not.toBeInTheDocument()
		})
		expect(view.queryByTestId("queued-messages")).not.toBeInTheDocument()
	})

	it("releases the completed-chat composer when accepted input needs queued recovery", async () => {
		const view = renderChatView()
		const state: Partial<ExtensionState> = {
			...runningState("a"),
			liveTasksById: {
				a: {
					id: "a",
					status: "idle",
					lifecycle: "completed",
					isActive: true,
					isTurnActive: false,
					isStreaming: false,
					isWaitingForInput: false,
					lastUpdatedAt: 2,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Prompt a" },
				{ type: "say", say: "completion_result", ts: 2, text: "Finished." },
			],
		}
		mockPostMessage(state)
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Explain the retained result" } })
		fireEvent.keyDown(input, { key: "Enter" })
		const request = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "resumeCompletedTask")![0]
		mockPostMessage({
			...state,
			messageQueue: [{ id: request.requestId!, text: "Explain the retained result", timestamp: 3 }],
		})
		receipt("resumeCompletedTask", request.requestId!, "a", "accepted", "queued")
		await waitFor(() => expect(input).toHaveAttribute("data-sending-disabled", "false"))
		expect(input).toHaveValue("")
		expect(view.queryByTestId("completed-task-resume-pending")).not.toBeInTheDocument()
		expect(view.getByTestId("queued-messages")).toHaveTextContent("Explain the retained result")
		expect(view.getByText("chat:queuedMessages.resumeQueued")).toBeInTheDocument()
	})

	it("keeps released input actionable when its feedback row exists before provider-history persistence", async () => {
		const view = renderChatView()
		const queued = { id: "released-input", text: "Retry the retained input", timestamp: 3 }
		const state = runningState("a", [queued])
		mockPostMessage({
			...state,
			clineMessages: [
				...state.clineMessages!,
				{
					type: "say",
					say: "user_feedback",
					ts: 4,
					text: queued.text,
					queuedMessageIds: [queued.id],
				},
			],
		})
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		expect(view.getByTestId("queued-messages")).toHaveTextContent(queued.text)
	})

	it("keeps submitted input in a queue preview until authoritative admission and preserves a later draft", async () => {
		const view = renderChatView()
		mockPostMessage(runningState("a"))
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Review the remaining changes" } })
		fireEvent.click(view.getByTestId("mock-enqueue"))
		const request = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "queueMessage")![0]
		expect(view.getByTestId("queued-messages")).toHaveTextContent("Review the remaining changes")
		fireEvent.change(input, { target: { value: "Another draft" } })
		mockPostMessage(runningState("a", [{ id: request.requestId!, text: "Review the remaining changes" }]))
		await waitFor(() => expect(view.getAllByText("Review the remaining changes")).toHaveLength(1))
		receipt("queueMessage", request.requestId!, "a", "accepted")
		expect(input).toHaveValue("Another draft")
		expect(view.getByTestId("queued-messages")).toHaveTextContent("Review the remaining changes")
	})
	it.each(["queueMessage", "sendAndSteer"] as const)(
		"removes the optimistic %s preview once its receipt is in the transcript without retiring admission",
		async (command) => {
			const ref = React.createRef<ChatViewRef>()
			const view = renderChatView({}, ref)
			const state = runningState("a")
			mockPostMessage(state)
			await waitFor(() => expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Prompt a"))
			const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
			fireEvent.change(input, { target: { value: "Review the retained input" } })
			vi.mocked(vscode.postMessage).mockClear()
			if (command === "queueMessage") fireEvent.click(view.getByTestId("mock-enqueue"))
			else act(() => ref.current!.sendAndSteer("a"))
			const request = vi.mocked(vscode.postMessage).mock.calls.find(([message]) => message.type === command)![0]
			fireEvent.change(input, { target: { value: "A later draft" } })
			mockPostMessage({
				...state,
				messageQueue: [
					{
						id: request.requestId!,
						text: "Review the retained input",
						timestamp: 3,
						deliveryState: "delivering",
					},
					{ id: "identical-other-input", text: "Review the retained input", timestamp: 4 },
				],
				clineMessages: [
					...state.clineMessages!,
					{
						ts: 5,
						type: "say",
						say: "user_feedback",
						text: "Review the retained input",
						queuedMessageIds: [request.requestId!],
					},
				],
			})
			await waitFor(() => expect(view.queryByLabelText(`Edit ${request.requestId}`)).not.toBeInTheDocument())
			expect(view.getByLabelText("Edit identical-other-input")).toBeInTheDocument()
			expect(view.getByTestId("chat-transcript-viewport")).toHaveTextContent("Review the retained input")
			expect(input).toHaveValue("A later draft")
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
			expect(
				vi.mocked(vscode.postMessage).mock.calls.filter(([message]) => message.type === command),
			).toHaveLength(1)
			receipt(command, request.requestId!, "a", "accepted")
			await waitFor(() => expect(input).toHaveAttribute("data-sending-disabled", "false"))
			expect(input).toHaveValue("A later draft")
		},
	)
	it("restores rejected queue input alongside a draft typed while awaiting admission", async () => {
		const view = renderChatView()
		mockPostMessage(runningState("a"))
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Review the remaining changes" } })
		fireEvent.click(view.getByTestId("mock-enqueue"))
		const request = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "queueMessage")![0]
		fireEvent.change(input, { target: { value: "Another draft" } })
		receipt("queueMessage", request.requestId!, "a", "rejected")
		expect(input.value).toContain("Review the remaining changes")
		expect(input.value).toContain("Another draft")
		expect(view.getByRole("alert")).toHaveTextContent("chat:queuedMessages.queueFailed")
	})
	it.each([false, true])(
		"routes operation text during streaming with autoSteer=%s without starting compaction",
		async (autoSteer) => {
			const view = renderChatView()
			mockPostMessage({ ...runningState("a"), autoSteer })
			await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
			const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
			fireEvent.change(input, { target: { value: "compact the context" } })
			fireEvent.keyDown(input, { key: "Enter" })
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: autoSteer ? "sendAndSteer" : "queueMessage",
					taskId: "a",
					text: "compact the context",
				}),
			)
			expect(input).toHaveValue("compact the context")
			expect(vscode.postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "condenseTaskContextRequest" }),
			)
		},
	)
	it("edits queued input even when its text resembles a composer operation", async () => {
		const view = renderChatView()
		mockPostMessage({
			...runningState("a", [{ id: "queued-a", text: "Review the remaining changes" }]),
			autoSteer: true,
		})
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		fireEvent.click(view.getByLabelText("Edit queued-a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "compact the context" } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "editQueuedMessage",
				taskId: "a",
				payload: { id: "queued-a", text: "compact the context", images: [] },
			}),
		)
		expect(input).toHaveValue("compact the context")
	})
	it.each(
		(["streaming", "command", "tool"] as const).flatMap((boundary) =>
			[false, true].map((autoSteer) => ({ boundary, autoSteer })),
		),
	)(
		"routes typed input through the host Enter command during $boundary with autoSteer=$autoSteer",
		async ({ boundary, autoSteer }) => {
			const ref = React.createRef<ChatViewRef>()
			const view = renderChatView({}, ref)
			mockPostMessage({
				...runningState("a"),
				autoSteer,
				// A complete ask must govern input even before the live waiting flag catches up.
				liveTasksById: {
					a: {
						id: "a",
						status: "running",
						isActive: true,
						isTurnActive: true,
						isStreaming: true,
						isWaitingForInput: false,
					},
				},
				...(boundary === "streaming"
					? {}
					: {
							clineMessages: [
								{ type: "say", say: "task", ts: 1, text: "Prompt a" },
								{
									type: "ask",
									ask: boundary,
									ts: 2,
									text:
										boundary === "tool"
											? JSON.stringify({ tool: "readFile", path: "a.ts" })
											: "build",
									partial: false,
								},
							],
						}),
			})
			await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
			const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
			fireEvent.change(input, { target: { value: "Review the remaining changes" } })
			vi.mocked(vscode.postMessage).mockClear()
			act(() => ref.current!.acceptInput())
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: autoSteer && boundary === "streaming" ? "sendAndSteer" : "queueMessage",
					taskId: "a",
					text: "Review the remaining changes",
				}),
			)
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
			expect(vscode.postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "toolApprovalDecision" }),
			)
			expect(input).toHaveValue("Review the remaining changes")
		},
	)
	it("restores a rejected reply to its owning chat and ignores duplicate receipts", async () => {
		const view = renderChatView()
		const waiting: Partial<ExtensionState> = {
			...runningState("a"),
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Prompt a" },
				{ type: "ask", ask: "followup", ts: 2, text: "Which option?" },
			],
		}
		mockPostMessage(waiting)
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Choose option one" } })
		fireEvent.keyDown(input, { key: "Enter" })
		const request = vi.mocked(vscode.postMessage).mock.calls.find(([message]) => message.type === "askResponse")![0]
		expect(request).toMatchObject({ requestId: expect.any(String), taskId: "a", askMessageTs: 2 })
		mockPostMessage(runningState("b"))
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt b"))
		fireEvent.change(input, { target: { value: "Draft b" } })
		receipt("askResponse", request.requestId!, "a", "rejected")
		receipt("askResponse", request.requestId!, "a", "rejected")
		expect(input).toHaveValue("Draft b")
		mockPostMessage(waiting)
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		expect(input).toHaveValue("Choose option one")
		expect(view.getByRole("alert")).toHaveTextContent("chat:queuedMessages.answerFailed")
	})

	it("an accepted reply receipt preserves newly typed input", async () => {
		const view = renderChatView()
		mockPostMessage({
			...runningState("a"),
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Prompt a" },
				{ type: "ask", ask: "completion_result", ts: 2, text: "Completed report" },
			],
		})
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Continue this chat" } })
		fireEvent.keyDown(input, { key: "Enter" })
		const request = vi.mocked(vscode.postMessage).mock.calls.find(([message]) => message.type === "askResponse")![0]
		fireEvent.change(input, { target: { value: "New draft" } })
		receipt("askResponse", request.requestId!, "a", "accepted")
		expect(input).toHaveValue("New draft")
	})
	it("keeps edits and late receipts on their originating chat across navigation", async () => {
		const view = renderChatView()
		mockPostMessage(runningState("a", [{ id: "queue-a", text: "Original queued text" }]))
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Prior draft a" } })
		fireEvent.click(view.getByLabelText("Edit queue-a"))
		fireEvent.change(input, { target: { value: "Edited queued text" } })
		fireEvent.keyDown(input, { key: "Enter" })
		const edit = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "editQueuedMessage")![0]
		expect(edit).toMatchObject({
			taskId: "a",
			requestId: expect.any(String),
			payload: { id: "queue-a", text: "Edited queued text" },
		})
		mockPostMessage(runningState("b"))
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt b"))
		expect(input).toHaveValue("")
		fireEvent.change(input, { target: { value: "Draft b" } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "queueMessage", taskId: "b", text: "Draft b" }),
		)
		expect(
			vi.mocked(vscode.postMessage).mock.calls.filter(([message]) => message.type === "editQueuedMessage"),
		).toHaveLength(1)
		receipt("editQueuedMessage", edit.requestId!, "a", "rejected")
		expect(input).toHaveValue("Draft b")
		mockPostMessage(runningState("a", [{ id: "queue-a", text: "Original queued text" }]))
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		expect(input).toHaveValue("Edited queued text")
		expect(view.getByRole("alert")).toHaveTextContent("chat:queuedMessages.editFailed")
		fireEvent.keyDown(input, { key: "Enter" })
		const retry = vi
			.mocked(vscode.postMessage)
			.mock.calls.filter(([message]) => message.type === "editQueuedMessage")
			.at(-1)![0]
		receipt("editQueuedMessage", retry.requestId!, "a", "accepted")
		expect(input).toHaveValue("Prior draft a")
	})
	it.each([false, true])(
		"uses the committed chat identity for receipts after navigation with autoSteer=%s",
		async (autoSteer) => {
			const command = autoSteer ? "sendAndSteer" : "queueMessage"
			const listeners = new Set<EventListenerOrEventListenerObject>()
			const addListener = window.addEventListener.bind(window)
			const removeListener = window.removeEventListener.bind(window)
			const addSpy = vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
				if (type === "message") listeners.add(listener)
				addListener(type, listener, options)
			})
			const removeSpy = vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) => {
				if (type === "message") listeners.delete(listener)
				removeListener(type, listener, options)
			})
			const view = renderChatView()
			mockPostMessage({ ...runningState("b"), autoSteer })
			await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt b"))
			const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
			fireEvent.change(input, { target: { value: "Queued b" } })
			fireEvent.keyDown(input, { key: "Enter" })
			mockPostMessage({ ...runningState("a"), autoSteer })
			await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
			fireEvent.change(input, { target: { value: "Queued a" } })
			fireEvent.keyDown(input, { key: "Enter" })
			const requestA = vi
				.mocked(vscode.postMessage)
				.mock.calls.find(([message]) => message.type === command && message.taskId === "a")![0]
			// Retain the subscribed callbacks to model a receipt dispatched in the
			// commit-to-passive-effect window, independently of React's test scheduler.
			const subscribed = [...listeners]
			try {
				mockPostMessage({ ...runningState("b"), autoSteer })
				await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt b"))
				const event = new MessageEvent("message", {
					data: {
						type: "chatCommandResult",
						chatCommandResult: {
							command,
							requestId: requestA.requestId,
							taskId: "a",
							status: "accepted",
						},
					},
				})
				act(() => {
					for (const listener of subscribed) {
						if (typeof listener === "function") listener.call(window, event)
						else listener.handleEvent(event)
					}
				})
				fireEvent.keyDown(input, { key: "Enter" })
				expect(
					vi
						.mocked(vscode.postMessage)
						.mock.calls.filter(([message]) => message.type === command && message.taskId === "b"),
				).toHaveLength(1)
			} finally {
				addSpy.mockRestore()
				removeSpy.mockRestore()
			}
		},
	)
	it("restores rejected completed-chat guidance only to its owner", async () => {
		const view = renderChatView()
		const completed: Partial<ExtensionState> = {
			...runningState("a"),
			clineMessages: [
				{ type: "say", say: "task", ts: 1, text: "Prompt a" },
				{ type: "say", say: "completion_result", ts: 2, text: "Done" },
			],
			liveTasksById: {
				a: {
					id: "a",
					status: "completed",
					lifecycle: "completed",
					isActive: true,
					isStreaming: false,
					isWaitingForInput: false,
					lastUpdatedAt: 3,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
		}
		mockPostMessage(completed)
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Continue a" } })
		fireEvent.keyDown(input, { key: "Enter" })
		const request = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "resumeCompletedTask")![0]
		mockPostMessage(runningState("b"))
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt b"))
		fireEvent.change(input, { target: { value: "Keep draft b" } })
		receipt("resumeCompletedTask", request.requestId!, "a", "rejected")
		expect(input).toHaveValue("Keep draft b")
		mockPostMessage(completed)
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		expect(input).toHaveValue("Continue a")
	})
	it("defers API guidance during an edit and preserves the separate composer draft", async () => {
		const view = renderChatView()
		mockPostMessage(runningState("a", [{ id: "queue-a", text: "Queued a" }]))
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Human draft" } })
		fireEvent.click(view.getByLabelText("Edit queue-a"))
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "invoke", invoke: "sendMessage", taskId: "a", text: "API guidance", images: [] },
				}),
			),
		)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editQueuedMessage" }))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "queueMessage" }))
		fireEvent.keyDown(input, { key: "Escape" })
		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "queueMessage", text: "API guidance", taskId: "a" }),
			),
		)
		expect(input).toHaveValue("Human draft")
		const request = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "queueMessage")![0]
		receipt("queueMessage", request.requestId!, "a", "accepted")
		expect(input).toHaveValue("Human draft")
	})
	it("opens the background chat named by its attention notification", async () => {
		const view = renderChatView()
		mockPostMessage(runningState("b"))
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt b"))
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "interactionRequired", taskId: "attention-a" } }),
			),
		)
		fireEvent.click(view.getByRole("button", { name: "chat:taskAttention.openNamed" }))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "showTaskWithId", text: "attention-a" }),
		)
	})
	it("makes deferred host-send overflow observable without replacing the composer", async () => {
		const view = renderChatView()
		mockPostMessage(runningState("a"))
		await waitFor(() => within(view.getByTestId("chat-transcript-viewport")).getByText("Prompt a"))
		const input = view.getByTestId("chat-textarea").querySelector("input")! as HTMLInputElement
		fireEvent.change(input, { target: { value: "Keep human draft" } })
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			act(() => {
				for (let index = 0; index < 17; index++)
					window.dispatchEvent(
						new MessageEvent("message", {
							data: {
								type: "invoke",
								invoke: "sendMessage",
								taskId: "not-selected",
								text: `External ${index}`,
							},
						}),
					)
			})
			expect(view.getByRole("alert")).toHaveTextContent("chat:hostMessages.deliveryBackpressure")
			expect(input).toHaveValue("Keep human draft")
		} finally {
			warning.mockRestore()
		}
	})
})
