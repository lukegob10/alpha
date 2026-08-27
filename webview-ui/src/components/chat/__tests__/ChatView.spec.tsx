// pnpm --filter @alpha-code/vscode-webview test src/components/chat/__tests__/ChatView.spec.tsx

import React from "react"
import { render, waitFor, act, fireEvent, within } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView, { ChatViewProps, isContextCondensationRequest } from "../ChatView"

// Define minimal types needed for testing
interface ClineMessage {
	type: "say" | "ask"
	say?: string
	ask?: string
	ts: number
	text?: string
	partial?: boolean
	isAnswered?: boolean
}

interface ExtensionState {
	version: string
	clineMessages: ClineMessage[]
	taskHistory: any[]
	shouldShowAnnouncement: boolean
	allowedCommands: string[]
	alwaysAllowExecute: boolean
	[key: string]: any
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
	default: function MockChatRow({ message }: { message: ClineMessage }) {
		return <div data-testid="chat-row">{JSON.stringify(message)}</div>
	},
}))

vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

// Mock VersionIndicator - returns null by default to prevent rendering in tests
vi.mock("../../common/VersionIndicator", () => ({
	default: vi.fn(() => null),
}))

// Get the mock function after the module is mocked
const mockVersionIndicator = vi.mocked((await import("../../common/VersionIndicator")).default)

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

// Mock DismissibleUpsell component
vi.mock("@/components/common/DismissibleUpsell", () => ({
	default: function MockDismissibleUpsell({ children }: { children: React.ReactNode }) {
		return <div data-testid="dismissible-upsell">{children}</div>
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
	}: {
		queue?: Array<{ id: string; text: string; images?: string[] }>
		onRemove?: (index: number) => void
		onSteer?: (index: number) => void
		onEdit?: (index: number) => void
		onReorder?: (fromIndex: number, toIndex: number) => void
		editingMessageId?: string
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
						<button aria-label="Steer" onClick={() => onSteer?.(index)}>
							Steer
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

// Mock AlphaTips component
vi.mock("@src/components/welcome/AlphaTips", () => ({
	default: function MockAlphaTips() {
		return <div data-testid="roo-tips">Tips content</div>
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
	onSend: () => void
	inputValue?: string
	setInputValue?: (value: string) => void
	sendingDisabled?: boolean
	placeholderText?: string
	selectedImages?: string[]
	shouldDisableImages?: boolean
	isEditMode?: boolean
	onCancel?: () => void
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
			<div data-testid="chat-textarea">
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
				/>
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

const renderChatView = (props: Partial<ChatViewProps> = {}) => {
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatView {...defaultProps} {...props} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

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

describe("ChatView - Version Indicator Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Reset the mock to return null by default
		mockVersionIndicator.mockReturnValue(null)
	})

	it("displays version indicator button", () => {
		// Mock VersionIndicator to return a button
		mockVersionIndicator.mockReturnValue(
			React.createElement("button", {
				"data-testid": "version-indicator",
				"aria-label": "Version 1.0.0",
				className: "version-indicator-button",
			}),
		)

		const { getByTestId } = renderChatView()

		// Hydrate state with no active task
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		// Should display version indicator
		expect(getByTestId("version-indicator")).toBeInTheDocument()
	})

	it("opens announcement modal when version indicator is clicked", async () => {
		// Mock VersionIndicator to return a button with onClick
		mockVersionIndicator.mockImplementation(({ onClick }: { onClick?: () => void }) =>
			React.createElement("button", {
				"data-testid": "version-indicator",
				onClick,
			}),
		)

		const { getByTestId, queryByTestId } = renderChatView({ showAnnouncement: false })

		// Hydrate state
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		// Wait for component to render
		await waitFor(() => {
			expect(getByTestId("version-indicator")).toBeInTheDocument()
		})

		// Click version indicator
		const versionIndicator = getByTestId("version-indicator")
		act(() => {
			versionIndicator.click()
		})

		// Wait for announcement modal to appear
		await waitFor(() => {
			expect(queryByTestId("announcement-modal")).toBeInTheDocument()
		})
	})

	it("version indicator has correct styling classes", () => {
		// Mock VersionIndicator to return a button with specific classes
		mockVersionIndicator.mockReturnValue(
			React.createElement("button", {
				"data-testid": "version-indicator",
				className: "version-indicator-button absolute top-2 right-2",
			}),
		)

		const { getByTestId } = renderChatView()

		// Hydrate state
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		const versionIndicator = getByTestId("version-indicator")
		expect(versionIndicator.className).toContain("version-indicator-button")
		expect(versionIndicator.className).toContain("absolute")
		expect(versionIndicator.className).toContain("top-2")
		expect(versionIndicator.className).toContain("right-2")
	})

	it("version indicator has proper accessibility attributes", () => {
		// Mock VersionIndicator to return a button with aria-label
		mockVersionIndicator.mockReturnValue(
			React.createElement("button", {
				"data-testid": "version-indicator",
				"aria-label": "Version 1.0.0",
				role: "button",
			}),
		)

		const { getByTestId } = renderChatView()

		// Hydrate state
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		const versionIndicator = getByTestId("version-indicator")
		expect(versionIndicator.getAttribute("aria-label")).toBe("Version 1.0.0")
		expect(versionIndicator.getAttribute("role")).toBe("button")
	})

	it("does not display version indicator when there is an active task", () => {
		// Mock VersionIndicator to return null (simulating hidden state)
		mockVersionIndicator.mockReturnValue(null)

		const { queryByTestId } = renderChatView()

		// Hydrate state with active task
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now(),
					text: "Active task",
				},
			],
		})

		// Should not display version indicator during active task
		expect(queryByTestId("version-indicator")).not.toBeInTheDocument()
	})

	it("displays version indicator only on welcome screen (no task)", () => {
		// Mock VersionIndicator to return a button
		mockVersionIndicator.mockReturnValue(React.createElement("button", { "data-testid": "version-indicator" }))

		const { queryByTestId } = renderChatView()

		// Hydrate state with no active task
		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		// Should display version indicator on welcome screen
		expect(queryByTestId("version-indicator")).toBeInTheDocument()
	})
})

describe("ChatView - DismissibleUpsell Display Tests", () => {
	beforeEach(() => vi.clearAllMocks())

	it("does not show DismissibleUpsell when user is authenticated to Cloud", () => {
		const { queryByTestId } = renderChatView()

		// Hydrate state with user authenticated to cloud
		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 3000 },
				{ id: "2", ts: Date.now() - 2000 },
				{ id: "3", ts: Date.now() - 1000 },
				{ id: "4", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		// Should not show DismissibleUpsell when authenticated
		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
	})

	it("does not show DismissibleUpsell when user has only run 3 tasks in their history", () => {
		const { queryByTestId } = renderChatView()

		// Hydrate state with user not authenticated but only 3 tasks
		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 2000 },
				{ id: "2", ts: Date.now() - 1000 },
				{ id: "3", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		// Should not show DismissibleUpsell with less than 4 tasks
		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
	})

	it("does not show DismissibleUpsell when user has run 6 or more tasks", async () => {
		const { queryByTestId } = renderChatView()

		// Hydrate state with user not authenticated and 4 tasks
		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 6000 },
				{ id: "2", ts: Date.now() - 5000 },
				{ id: "3", ts: Date.now() - 4000 },
				{ id: "4", ts: Date.now() - 3000 },
				{ id: "5", ts: Date.now() - 2000 },
				{ id: "6", ts: Date.now() - 1000 },
				{ id: "7", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		// Cloud upsell surfaces are removed, so the welcome screen should stay on Alpha tips.
		await waitFor(() => {
			expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
		})
	})

	it("does not show DismissibleUpsell when there is an active task (regardless of auth status)", async () => {
		const { queryByTestId } = renderChatView()

		// Hydrate state with active task
		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 3000 },
				{ id: "2", ts: Date.now() - 2000 },
				{ id: "3", ts: Date.now() - 1000 },
				{ id: "4", ts: Date.now() },
			],
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now(),
					text: "Active task",
				},
			],
		})

		// Wait for component to render with active task
		await waitFor(() => {
			// Should not show DismissibleUpsell during active task
			expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
			// Should not show AlphaTips either since the entire welcome screen is hidden during active tasks
			expect(queryByTestId("roo-tips")).not.toBeInTheDocument()
			// Should not show AlphaHero either since the entire welcome screen is hidden during active tasks
			expect(queryByTestId("roo-hero")).not.toBeInTheDocument()
		})
	})

	it("shows AlphaTips when user is authenticated (instead of DismissibleUpsell)", () => {
		const { queryByTestId, getByTestId } = renderChatView()

		// Hydrate state with user authenticated to cloud
		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 3000 },
				{ id: "2", ts: Date.now() - 2000 },
				{ id: "3", ts: Date.now() - 1000 },
				{ id: "4", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		// Should not show DismissibleUpsell but should show AlphaTips
		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
		expect(getByTestId("roo-tips")).toBeInTheDocument()
	})

	it("shows AlphaTips when user has fewer than 6 tasks (instead of DismissibleUpsell)", () => {
		const { queryByTestId, getByTestId } = renderChatView()

		// Hydrate state with user not authenticated but fewer than 4 tasks
		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 2000 },
				{ id: "2", ts: Date.now() - 1000 },
				{ id: "3", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		// Should not show DismissibleUpsell but should show AlphaTips
		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
		expect(getByTestId("roo-tips")).toBeInTheDocument()
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
				} as ClineMessage,
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

		const taskStrip = await waitFor(() => getByRole("region", { name: "Sub-agent tasks" }))
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

		const taskStrip = await waitFor(() => getByRole("region", { name: "Sub-agent tasks" }))
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
})

describe("ChatView - Message Queueing Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Reset the mock to clear any initial calls
		vi.mocked(vscode.postMessage).mockClear()
	})

	it("shows the task chat shell when a focused task exists before its first message arrives", async () => {
		const { getByTestId, queryByTestId, queryByText } = renderChatView()

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

		expect(queryByText("Second task")).toBeInTheDocument()
		expect(queryByTestId("roo-tips")).not.toBeInTheDocument()
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
			expect(queryByTestId("roo-tips")).toBeInTheDocument()
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
			expect(queryByTestId("roo-tips")).toBeInTheDocument()
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
			})
		})
	})

	it("opens the source task on the first click after entering the new-task window", async () => {
		const { getByTestId, queryByTestId, queryByText } = renderChatView()

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
			expect(queryByTestId("roo-tips")).toBeInTheDocument()
		})

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			currentTaskItem: taskItem,
			clineMessages: [],
			taskHistory: [taskItem],
		})

		await waitFor(() => {
			expect(queryByTestId("roo-tips")).not.toBeInTheDocument()
			expect(queryByText("Original task")).toBeInTheDocument()
		})
	})

	it("opens the same running task after the provider confirms the new-task window", async () => {
		const { getByTestId, queryByTestId, queryByText } = renderChatView()

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
			expect(queryByTestId("roo-tips")).toBeInTheDocument()
		})

		mockPostMessage({
			currentTaskId: "task-1",
			currentView: { type: "task", taskId: "task-1" },
			currentTaskItem: taskItem,
			clineMessages: taskMessages,
			taskHistory: [taskItem],
		})

		await waitFor(() => {
			expect(queryByTestId("roo-tips")).not.toBeInTheDocument()
			expect(queryByText("Original task")).toBeInTheDocument()
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

		// Wait for state to be updated and check that sending is disabled
		await waitFor(() => {
			const chatTextArea = getByTestId("chat-textarea")
			const input = chatTextArea.querySelector("input")!
			expect(input.getAttribute("data-sending-disabled")).toBe("true")
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
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the message was queued, not sent as askResponse
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				text: "follow-up question during spinner",
				images: [],
				taskId: "task-1",
			})
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

	it("renders a steer button for queued messages and posts steerQueuedMessage with the task id", async () => {
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

		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(getByLabelText("Steer"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "steerQueuedMessage",
			text: "msg1",
			taskId: "task-1",
		})
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

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "askResponse",
			askResponse: "yesButtonClicked",
			taskId: "task-1",
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				text: "run this after approval",
			}),
		)
		expect(input.value).toBe("run this after approval")
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
			text: "run this after approval",
			images: [],
			taskId: "task-1",
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
			}),
		)
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
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "follow-up after completion",
				images: [],
			})
		})

		// Verify it was NOT queued
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "queueMessage",
			}),
		)
	})

	it("starts a new task instead of answering a stale follow-up on a completed live task", async () => {
		const { getByTestId } = renderChatView()

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
					ask: "followup",
					ts: Date.now(),
					text: JSON.stringify({ question: "Stale question?", suggest: [] }),
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
			fireEvent.change(input, { target: { value: "new work" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "newTask",
			text: "new work",
			images: [],
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
			}),
		)
	})

	it.each(["completion_result", "resume_completed_task"] as const)(
		"continues the same task when the composer is submitted at %s",
		async (completionAsk) => {
			const { getByTestId } = renderChatView()

			mockPostMessage({
				currentTaskId: "task-1",
				currentView: { type: "task", taskId: "task-1" },
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

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "follow up in this thread",
				images: [],
				taskId: "task-1",
			})
			expect(vscode.postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({
					type: "newTask",
				}),
			)
		},
	)

	it("submits an existing draft when Start New Task is clicked", async () => {
		const { getByTestId, getByRole, queryByTestId, queryByText } = renderChatView()

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

		const input = await waitFor(() => getByTestId("chat-textarea").querySelector("input"))
		fireEvent.change(input!, { target: { value: "new task from button" } })
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(getByRole("button", { name: "chat:startNewTask.title" }))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "newTask",
			text: "new task from button",
			images: [],
		})
		expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "startBlankTask" })
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "askResponse" }))
		expect(queryByTestId("roo-tips")).toBeInTheDocument()

		mockPostMessage({
			currentTaskId: "task-2",
			currentView: { type: "task", taskId: "task-2" },
			clineMessages: [{ type: "say", say: "task", ts: 200, text: "new task from button" }],
		})

		await waitFor(() => {
			expect(queryByTestId("roo-tips")).not.toBeInTheDocument()
			expect(queryByText("new task from button")).toBeInTheDocument()
		})
	})

	it("keeps an empty new-task draft usable while stale completed-task state is in flight", async () => {
		const { getByTestId, getByRole, queryByTestId } = renderChatView()
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
		await waitFor(() => getByRole("button", { name: "chat:startNewTask.title" }))
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(getByRole("button", { name: "chat:startNewTask.title" }))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "startBlankTask" })
		await waitFor(() => {
			expect(queryByTestId("roo-tips")).toBeInTheDocument()
			expect(getByTestId("chat-textarea").querySelector("input")!.getAttribute("data-sending-disabled")).toBe(
				"false",
			)
		})

		mockPostMessage(completedState)
		await waitFor(() => expect(queryByTestId("roo-tips")).toBeInTheDocument())

		const input = getByTestId("chat-textarea").querySelector("input")!
		fireEvent.change(input, { target: { value: "new task after transition" } })
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "newTask",
			text: "new task after transition",
			images: [],
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
			text: "next message",
			images: [],
			taskId: "task-1",
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
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the new message was queued (not sent directly) to preserve order
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				text: "message during queue drain",
				images: [],
				taskId: "task-1",
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
		// (clineAsk state update -> clineAskRef.current update)
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Allow React effects to complete (clineAsk -> clineAskRef sync)
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
				text: "message during command execution",
				images: [],
				taskId: "task-1",
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

	it("should add a condensing message to groupedMessages when isCondensing is true", async () => {
		// This test verifies that when the condenseTaskContextStarted message is received,
		// the isCondensing state is set to true and a synthetic condensing message is added
		// to the grouped messages list
		const { getByTestId, container } = renderChatView()

		// First hydrate state with an active task
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

		// Dispatch a MessageEvent directly to trigger the message handler
		// This simulates the VSCode extension sending a message to the webview
		await act(async () => {
			const event = new MessageEvent("message", {
				data: {
					type: "condenseTaskContextStarted",
					text: "test-task-id",
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
