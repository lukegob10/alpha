// npx vitest run src/__tests__/App.spec.tsx

import React from "react"
import { render, screen, act, cleanup, fireEvent, waitFor } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"
import {
	ExtensionStateContext,
	ShellStateContext,
	type ExtensionStateContextType,
} from "@src/context/ExtensionStateContext"

import AppWithProviders from "../App"

const mockChatCommands = vi.hoisted(() => ({ acceptInput: vi.fn(), sendAndSteer: vi.fn(), startNewChat: vi.fn() }))
const mockCheckUnsavedChanges = vi.hoisted(() => vi.fn<(onContinue: () => void) => void>())
const mockStateSubscriptionRead = vi.hoisted(() => vi.fn())

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock the ErrorBoundary component
vi.mock("@src/components/ErrorBoundary", () => ({
	__esModule: true,
	default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock the telemetry client
vi.mock("@src/utils/TelemetryClient", () => ({
	telemetryClient: {
		capture: vi.fn(),
		updateTelemetryState: vi.fn(),
	},
}))

vi.mock("@src/components/chat/ChatView", async () => {
	const React = await import("react")
	const { default: ChatToolbar } = await import("../components/chat/ChatToolbar")
	const { chatToolbarActions } = await import("../components/chat/chatToolbarActions")
	return {
		__esModule: true,
		default: React.forwardRef(function ChatView(
			{ isHidden, historyFocusRequest }: { isHidden: boolean; historyFocusRequest: number },
			ref,
		) {
			React.useImperativeHandle(ref, () => mockChatCommands)
			return (
				<div
					data-testid="chat-view"
					data-hidden={isHidden}
					data-history-request={historyFocusRequest}
					hidden={isHidden}>
					<ChatToolbar
						{...chatToolbarActions}
						renderContext={mockUseExtensionState().renderContext}
						debug={mockUseExtensionState().debug === true}
						onNewChat={mockChatCommands.startNewChat}
					/>
					<input aria-label="Draft" defaultValue="" />
					Chat View
				</div>
			)
		}),
	}
})

vi.mock("@src/components/settings/SettingsView", async () => {
	const React = await import("react")
	return {
		__esModule: true,
		default: React.forwardRef(function SettingsView({ onDone }: { onDone: () => void }, ref) {
			React.useImperativeHandle(ref, () => ({ checkUnsaveChanges: mockCheckUnsavedChanges }))
			return (
				<div data-testid="settings-view" className="app-shell" onClick={onDone}>
					Settings View
				</div>
			)
		}),
	}
})

vi.mock("@src/components/scheduled-tasks/ScheduledTasksView", () => ({
	default: ({ targetTaskId }: { targetTaskId?: string }) => (
		<div data-testid="scheduled-tasks-view" data-target={targetTaskId} />
	),
}))

vi.mock("@src/components/mcp/McpView", () => ({
	__esModule: true,
	default: function McpView() {
		return <div data-testid="mcp-view">MCP View</div>
	},
}))

vi.mock("@src/components/modes/ModesView", () => ({
	__esModule: true,
	default: function ModesView() {
		return <div data-testid="prompts-view">Modes View</div>
	},
}))

vi.mock("@src/components/marketplace/MarketplaceView", () => ({
	MarketplaceView: function MarketplaceView({ onDone }: { onDone: () => void }) {
		return (
			<div data-testid="marketplace-view" onClick={onDone}>
				Marketplace View
			</div>
		)
	},
}))

vi.mock("@src/components/cloud/CloudView", () => ({
	CloudView: function CloudView() {
		return <div data-testid="cloud-view">Cloud View</div>
	},
}))

const mockUseExtensionState = vi.fn()

// Mock i18next and react-i18next
vi.mock("i18next", () => {
	const tFunction = (key: string) => key
	const i18n = {
		t: tFunction,
		use: () => i18n,
		init: () => Promise.resolve(tFunction),
		changeLanguage: vi.fn(() => Promise.resolve()),
	}
	return { default: i18n }
})

vi.mock("react-i18next", () => {
	const tFunction = (key: string) => key
	return {
		withTranslation: () => (Component: any) => {
			const MockedComponent = (props: any) => {
				return <Component t={tFunction} i18n={{ t: tFunction }} tReady {...props} />
			}
			MockedComponent.displayName = `withTranslation(${Component.displayName || Component.name || "Component"})`
			return MockedComponent
		},
		Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
		useTranslation: () => {
			return {
				t: tFunction,
				i18n: {
					t: tFunction,
					changeLanguage: vi.fn(() => Promise.resolve()),
				},
			}
		},
		initReactI18next: {
			type: "3rdParty",
			init: vi.fn(),
		},
	}
})

// Mock TranslationProvider to pass through children
vi.mock("@src/i18n/TranslationContext", () => {
	const tFunction = (key: string) => key
	return {
		__esModule: true,
		default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
		useAppTranslation: () => ({
			t: tFunction,
			i18n: {
				t: tFunction,
				changeLanguage: vi.fn(() => Promise.resolve()),
			},
		}),
	}
})

vi.mock("@src/context/ExtensionStateContext", async () => {
	const React = await import("react")
	const ExtensionStateContext = React.createContext<ExtensionStateContextType | undefined>(undefined)
	const ShellStateContext = React.createContext<ExtensionStateContextType | undefined>(undefined)
	return {
		ExtensionStateContext,
		ShellStateContext,
		useExtensionState: () => {
			mockStateSubscriptionRead()
			return React.useContext(ExtensionStateContext) ?? mockUseExtensionState()
		},
		useShellState: () => {
			mockStateSubscriptionRead()
			return React.useContext(ShellStateContext) ?? mockUseExtensionState()
		},
		ExtensionStateContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	}
})

// Mock environment variables
vi.mock("process.env", () => ({
	NODE_ENV: "test",
	PKG_VERSION: "1.0.0-test",
}))

describe("App", () => {
	it.each([false, true])("restores inline edit focus on cancel (checkpoint: %s)", async (hasCheckpoint) => {
		render(<AppWithProviders />)
		const editContainer = document.createElement("div")
		editContainer.dataset.messageEditorTaskId = "original-task"
		editContainer.dataset.messageEditorTs = "10"
		const editor = document.createElement("textarea")
		editor.value = "Keep this revised prompt"
		editContainer.append(editor)
		screen.getByTestId("chat-view").append(editContainer)
		const focus = vi.fn()
		Object.defineProperty(editor, "focus", { configurable: true, value: focus })
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "showEditMessageDialog",
						messageTs: 10,
						taskId: "original-task",
						text: editor.value,
						hasCheckpoint,
					},
				}),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: "common:answers.cancel" }))
		await waitFor(() => expect(focus).toHaveBeenCalledWith({ preventScroll: true }))
		expect(editor).toHaveValue("Keep this revised prompt")
		expect(editor.isConnected).toBe(true)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editMessageConfirm" }))
	})

	it.each([false, true])("skips removed editors on cancel (checkpoint: %s)", async (hasCheckpoint) => {
		render(<AppWithProviders />)
		const editContainer = document.createElement("div")
		editContainer.dataset.messageEditorTaskId = "original-task"
		editContainer.dataset.messageEditorTs = "10"
		const editor = document.createElement("textarea")
		editContainer.append(editor)
		screen.getByTestId("chat-view").append(editContainer)
		const focus = vi.fn()
		Object.defineProperty(editor, "focus", { configurable: true, value: focus })
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "showEditMessageDialog",
						messageTs: 10,
						taskId: "original-task",
						text: "Revised prompt",
						hasCheckpoint,
					},
				}),
			),
		)
		editContainer.remove()
		fireEvent.click(screen.getByRole("button", { name: "common:answers.cancel" }))
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
		expect(focus).not.toHaveBeenCalled()
	})

	it.each([false, true])("sends one edit confirmation for repeated activation (checkpoint: %s)", (hasCheckpoint) => {
		render(<AppWithProviders />)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "showEditMessageDialog",
						messageTs: 10,
						taskId: "original-task",
						text: "Revised prompt",
						hasCheckpoint,
					},
				}),
			),
		)
		const confirm = screen.getByRole("button", {
			name: hasCheckpoint ? "common:confirmation.editOnly" : "common:confirmation.proceed",
		})
		act(() => {
			confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }))
			confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }))
		})
		expect(
			vi.mocked(vscode.postMessage).mock.calls.filter(([message]) => message.type === "editMessageConfirm"),
		).toHaveLength(1)
	})

	it.each([false, true])("confirms a restart with its original task and images (checkpoint: %s)", (hasCheckpoint) => {
		const { rerender } = render(<AppWithProviders />)
		const images = ["data:image/png;base64,aGVsbG8="]
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "showEditMessageDialog",
						messageTs: 10,
						taskId: "original-task",
						text: "",
						images,
						hasCheckpoint,
						messageAction: "restart",
					},
				}),
			),
		)
		expect(screen.getByRole("heading", { name: "chat:messageActions.restart" })).toBeInTheDocument()
		mockUseExtensionState.mockReturnValue({ ...mockUseExtensionState(), currentTaskId: "different-task" })
		rerender(<AppWithProviders />)
		fireEvent.click(
			screen.getByRole("button", {
				name: hasCheckpoint ? "common:confirmation.restoreToCheckpoint" : "common:confirmation.proceed",
			}),
		)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "editMessageConfirm",
			taskId: "original-task",
			messageTs: 10,
			text: "",
			images,
			...(hasCheckpoint ? { restoreCheckpoint: true } : {}),
		})
	})

	it("can cancel restart without changing the task", () => {
		render(<AppWithProviders />)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "showEditMessageDialog",
						messageTs: 10,
						taskId: "original-task",
						text: "Original prompt",
						messageAction: "restart",
					},
				}),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: "common:answers.cancel" }))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editMessageConfirm" }))
	})
	beforeEach(() => {
		vi.clearAllMocks()
		mockCheckUnsavedChanges.mockImplementation((onContinue) => onContinue())
		window.removeEventListener("message", () => {})

		// Set up default mock return value
		mockUseExtensionState.mockReturnValue({
			renderContext: "editor",
			didHydrateState: true,
			showWelcome: false,
			shouldShowAnnouncement: false,
			experiments: {},
			language: "en",
			telemetrySetting: "enabled",
		})
	})

	afterEach(() => {
		cleanup()
		window.removeEventListener("message", () => {})
	})

	const triggerMessage = (action: string) => {
		const messageEvent = new MessageEvent("message", {
			data: {
				type: "action",
				action,
			},
		})
		window.dispatchEvent(messageEvent)
	}

	it("reports iframe focus changes once and releases focus when unmounted", () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true)
		const { unmount } = render(<AppWithProviders />)
		const messages = () =>
			vi
				.mocked(vscode.postMessage)
				.mock.calls.map(([message]) => message)
				.filter((m) => m.type === "webviewFocusChanged")
		expect(messages()).toEqual([{ type: "webviewFocusChanged", focused: true }])
		act(() => {
			window.dispatchEvent(new Event("focus"))
			window.dispatchEvent(new Event("blur"))
			window.dispatchEvent(new Event("blur"))
			window.dispatchEvent(new Event("focus"))
		})
		expect(messages()).toEqual([
			{ type: "webviewFocusChanged", focused: true },
			{ type: "webviewFocusChanged", focused: false },
			{ type: "webviewFocusChanged", focused: true },
		])
		unmount()
		expect(messages().at(-1)).toEqual({ type: "webviewFocusChanged", focused: false })
		const count = messages().length
		window.dispatchEvent(new Event("focus"))
		expect(messages()).toHaveLength(count)
		hasFocus.mockRestore()
	})

	it("forwards the captured steering target to the composer without invoking ordinary accept", () => {
		render(<AppWithProviders />)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "sendAndSteer", taskId: "captured-task" } }),
			),
		)
		expect(mockChatCommands.sendAndSteer).toHaveBeenCalledWith("captured-task")
		expect(mockChatCommands.acceptInput).not.toHaveBeenCalled()
	})

	const triggerForcedChatMessage = () => {
		const messageEvent = new MessageEvent("message", {
			data: {
				type: "action",
				action: "chatButtonClicked",
				values: { force: true },
			},
		})
		window.dispatchEvent(messageEvent)
	}

	it("shows chat view by default", () => {
		render(<AppWithProviders />)

		const chatView = screen.getByTestId("chat-view")
		expect(chatView).toBeInTheDocument()
		expect(chatView.getAttribute("data-hidden")).toBe("false")
	}, 10000)

	it("keeps the app shell stable over transcript updates while observing task and welcome changes", () => {
		const initialState = mockUseExtensionState()
		const app = <AppWithProviders />
		let updateTranscript: React.Dispatch<React.SetStateAction<ExtensionStateContextType>> | undefined
		let updateShell: React.Dispatch<React.SetStateAction<ExtensionStateContextType>> | undefined
		function StateUpdates() {
			const [fullState, setFullState] = React.useState<ExtensionStateContextType>(initialState)
			const [shellState, setShellState] = React.useState<ExtensionStateContextType>(initialState)
			updateTranscript = setFullState
			updateShell = setShellState
			return (
				<ExtensionStateContext.Provider value={fullState}>
					<ShellStateContext.Provider value={shellState}>{app}</ShellStateContext.Provider>
				</ExtensionStateContext.Provider>
			)
		}
		render(<StateUpdates />)
		expect(mockStateSubscriptionRead).toHaveBeenCalledTimes(1)
		for (let sequence = 1; sequence <= 100; sequence++) {
			act(() => updateTranscript?.((state) => ({ ...state, clineMessagesSeq: sequence })))
		}
		expect(mockStateSubscriptionRead).toHaveBeenCalledTimes(1)

		act(() => updateShell?.((state) => ({ ...state, currentTaskId: "latest-task" })))
		expect(mockStateSubscriptionRead).toHaveBeenCalledTimes(2)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "showDeleteMessageDialog", messageTs: 10 },
				}),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: "common:confirmation.proceed" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "deleteMessageConfirm",
			taskId: "latest-task",
			messageTs: 10,
		})
		act(() => updateShell?.((state) => ({ ...state, showWelcome: true })))
		expect(screen.getByText("Welcome to Alpha.")).toBeInTheDocument()
		expect(screen.queryByTestId("chat-view")).not.toBeInTheDocument()
	})

	it("has no duplicate toolbar row on a new sidebar chat", () => {
		mockUseExtensionState.mockReturnValue({ ...mockUseExtensionState(), renderContext: "sidebar" })
		render(<AppWithProviders />)
		expect(screen.getByTestId("chat-view")).toBeVisible()
		expect(screen.queryByRole("group", { name: "common:chatToolbar.label" })).not.toBeInTheDocument()
		for (const action of ["newChat", "settings", "tickets", "more"]) {
			expect(screen.queryByRole("button", { name: `common:chatToolbar.${action}` })).not.toBeInTheDocument()
		}
	})

	it.each([
		{ tab: "settings", pane: "settings-view", label: "settings" },
		{ tab: "marketplace", pane: "marketplace-view", label: "marketplace" },
		{ tab: "scheduledTasks", pane: "scheduled-tasks-view", label: "scheduledTasks" },
	])("keeps the sidebar secondary $tab title without duplicating native actions", async ({ tab, pane, label }) => {
		mockUseExtensionState.mockReturnValue({ ...mockUseExtensionState(), renderContext: "sidebar" })
		render(<AppWithProviders />)
		fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "Sidebar draft" } })
		act(() =>
			window.dispatchEvent(new MessageEvent("message", { data: { type: "action", action: "switchTab", tab } })),
		)
		await screen.findByTestId(pane)
		expect(screen.getByText(`common:chatToolbar.${label}`)).toBeInTheDocument()
		expect(screen.getAllByRole("group", { name: "common:chatToolbar.label" })).toHaveLength(1)
		for (const action of ["newChat", "settings", "tickets", "more"]) {
			expect(screen.queryByRole("button", { name: `common:chatToolbar.${action}` })).not.toBeInTheDocument()
		}
		expect(screen.getByRole("textbox", { name: "Draft", hidden: true })).toHaveValue("Sidebar draft")
		act(() => triggerMessage("chatButtonClicked"))
		expect(screen.getByTestId("chat-view")).toBeVisible()
		expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("Sidebar draft")
		expect(screen.queryByRole("group", { name: "common:chatToolbar.label" })).not.toBeInTheDocument()
	})

	it.each([
		{ tab: "settings", pane: "settings-view", label: "settings" },
		{ tab: "marketplace", pane: "marketplace-view", label: "marketplace" },
		{ tab: "scheduledTasks", pane: "scheduled-tasks-view", label: "scheduledTasks" },
	])("keeps one visible shared toolbar when visiting $tab and starting a new chat", async ({ tab, pane, label }) => {
		render(<AppWithProviders />)
		const chat = screen.getByTestId("chat-view")
		const toolbarName = "common:chatToolbar.label"
		expect(screen.getAllByRole("group", { name: toolbarName })).toHaveLength(1)
		fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "Preserved draft" } })
		act(() =>
			window.dispatchEvent(new MessageEvent("message", { data: { type: "action", action: "switchTab", tab } })),
		)
		const secondaryPane = await screen.findByTestId(pane)
		expect(chat).toHaveAttribute("data-hidden", "true")
		expect(chat).not.toBeVisible()
		expect(screen.getByRole("textbox", { name: "Draft", hidden: true })).toHaveValue("Preserved draft")
		expect(screen.getAllByRole("group", { name: toolbarName })).toHaveLength(1)
		expect(screen.getByText(`common:chatToolbar.${label}`)).toBeInTheDocument()
		expect(secondaryPane.parentElement).toHaveClass("relative", "min-h-0", "flex-1")
		fireEvent.click(screen.getByRole("button", { name: "common:chatToolbar.newChat" }))
		expect(mockChatCommands.startNewChat).toHaveBeenCalledTimes(1)
		expect(chat).toBe(screen.getByTestId("chat-view"))
		expect(chat).toBeVisible()
		expect(screen.queryByTestId(pane)).not.toBeInTheDocument()
		expect(screen.getAllByRole("group", { name: toolbarName })).toHaveLength(1)
	})

	it("waits for Settings unsaved changes approval before starting a new chat", async () => {
		render(<AppWithProviders />)
		act(() => triggerMessage("settingsButtonClicked"))
		await screen.findByTestId("settings-view")
		let continueNavigation: (() => void) | undefined
		mockCheckUnsavedChanges.mockImplementation((onContinue) => {
			continueNavigation = onContinue
		})
		fireEvent.click(screen.getByRole("button", { name: "common:chatToolbar.newChat" }))
		expect(mockCheckUnsavedChanges).toHaveBeenCalledTimes(1)
		expect(mockChatCommands.startNewChat).not.toHaveBeenCalled()
		expect(screen.getByTestId("settings-view")).toBeInTheDocument()
		expect(screen.getByTestId("chat-view")).not.toBeVisible()
		act(() => continueNavigation?.())
		expect(mockChatCommands.startNewChat).toHaveBeenCalledTimes(1)
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
		expect(screen.getByTestId("chat-view")).toBeVisible()
	})

	it("waits for the Settings guard before starting one chat from the native sidebar action", async () => {
		mockUseExtensionState.mockReturnValue({ ...mockUseExtensionState(), renderContext: "sidebar" })
		render(<AppWithProviders />)
		act(() => triggerMessage("settingsButtonClicked"))
		await screen.findByTestId("settings-view")
		let continueNavigation: (() => void) | undefined
		mockCheckUnsavedChanges.mockImplementation((onContinue) => {
			continueNavigation = onContinue
		})
		act(() => triggerMessage("newChatButtonClicked"))
		expect(mockCheckUnsavedChanges).toHaveBeenCalledTimes(1)
		expect(mockChatCommands.startNewChat).not.toHaveBeenCalled()
		expect(screen.getByTestId("settings-view")).toBeInTheDocument()
		act(() => continueNavigation?.())
		expect(mockChatCommands.startNewChat).toHaveBeenCalledTimes(1)
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
		expect(screen.getByTestId("chat-view")).toBeVisible()
	})

	it("keeps Settings and the draft when its guard cancels the native sidebar New chat action", async () => {
		mockUseExtensionState.mockReturnValue({ ...mockUseExtensionState(), renderContext: "sidebar" })
		render(<AppWithProviders />)
		fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), {
			target: { value: "Do not lose this draft" },
		})
		act(() => triggerMessage("settingsButtonClicked"))
		await screen.findByTestId("settings-view")
		mockCheckUnsavedChanges.mockImplementation(() => {})
		act(() => triggerMessage("newChatButtonClicked"))
		expect(mockCheckUnsavedChanges).toHaveBeenCalledTimes(1)
		expect(mockChatCommands.startNewChat).not.toHaveBeenCalled()
		expect(screen.getByTestId("settings-view")).toBeInTheDocument()
		expect(screen.getByRole("textbox", { name: "Draft", hidden: true })).toHaveValue("Do not lose this draft")
	})

	it("starts exactly one chat from the native sidebar action when no Settings guard is active", () => {
		mockUseExtensionState.mockReturnValue({ ...mockUseExtensionState(), renderContext: "sidebar" })
		render(<AppWithProviders />)
		act(() => triggerMessage("newChatButtonClicked"))
		expect(mockChatCommands.startNewChat).toHaveBeenCalledTimes(1)
		expect(mockCheckUnsavedChanges).not.toHaveBeenCalled()
	})

	it("keeps Settings and the chat intact if its unsaved changes guard cancels New chat", async () => {
		render(<AppWithProviders />)
		act(() => triggerMessage("settingsButtonClicked"))
		await screen.findByTestId("settings-view")
		mockCheckUnsavedChanges.mockImplementation(() => {})
		fireEvent.click(screen.getByRole("button", { name: "common:chatToolbar.newChat" }))
		expect(mockCheckUnsavedChanges).toHaveBeenCalledTimes(1)
		expect(mockChatCommands.startNewChat).not.toHaveBeenCalled()
		expect(screen.getByTestId("settings-view")).toBeInTheDocument()
		expect(screen.getByTestId("chat-view")).not.toBeVisible()
	})

	it("dispatches the owning toolbar's typed host routes from secondary views", async () => {
		mockUseExtensionState.mockReturnValue({ ...mockUseExtensionState(), debug: true })
		render(<AppWithProviders />)
		act(() => triggerMessage("settingsButtonClicked"))
		await screen.findByTestId("settings-view")
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(screen.getByRole("button", { name: "common:chatToolbar.settings" }))
		fireEvent.click(screen.getByRole("button", { name: "common:chatToolbar.tickets" }))
		for (const label of ["incidentDashboard", "scheduledTasks", "marketplace"]) {
			fireEvent.keyDown(screen.getByRole("button", { name: "common:chatToolbar.more" }), { key: "Enter" })
			fireEvent.click(screen.getByRole("menuitem", { name: `common:chatToolbar.${label}` }))
		}
		const actionMessages = vi
			.mocked(vscode.postMessage)
			.mock.calls.map(([message]) => message)
			.filter((message) => message.type !== "focusPanelRequest")
		expect(actionMessages).toEqual([
			{ type: "switchTab", tab: "settings" },
			{ type: "openTickets" },
			{ type: "openIncidentDashboard" },
			{ type: "switchTab", tab: "scheduledTasks" },
			{ type: "switchTab", tab: "marketplace" },
		])
	})

	it.each(["goalSeek", "unknownTab"])("ignores an unavailable tab request for %s", (tab) => {
		render(<AppWithProviders />)
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "action", action: "switchTab", tab } }))
		})
		expect(screen.getByTestId("chat-view")).toHaveAttribute("data-hidden", "false")
	})

	it("still opens a targeted scheduled task through switchTab", async () => {
		render(<AppWithProviders />)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "action",
						action: "switchTab",
						tab: "scheduledTasks",
						values: { scheduledTaskId: "saved-schedule" },
					},
				}),
			)
		})
		expect(await screen.findByTestId("scheduled-tasks-view")).toHaveAttribute("data-target", "saved-schedule")
		expect(screen.getByTestId("chat-view")).toHaveAttribute("data-hidden", "true")
	})

	it("keeps the shared popover portal outside the hidden chat view", () => {
		render(<AppWithProviders />)

		const chatView = screen.getByTestId("chat-view")
		const portal = document.getElementById("alpha-portal")

		expect(portal).toBeInTheDocument()
		expect(chatView).not.toContainElement(portal)
	})

	it("switches to settings view when receiving settingsButtonClicked action", async () => {
		render(<AppWithProviders />)

		act(() => {
			triggerMessage("settingsButtonClicked")
		})

		const settingsView = await screen.findByTestId("settings-view")
		expect(settingsView).toBeInTheDocument()

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("true")
	})

	it.each([
		{ action: "historyButtonClicked" },
		{ action: "switchTab", tab: "history" },
		{ action: "historyButtonClicked", values: { force: true } },
	])("opens Chats in the mounted chat for $action", async (request) => {
		render(<AppWithProviders />)
		const chat = screen.getByTestId("chat-view")
		fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "Unsent draft" } })
		act(() => triggerMessage("settingsButtonClicked"))
		await screen.findByTestId("settings-view")
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "action", ...request } }))
		})
		expect(screen.getByTestId("chat-view")).toBe(chat)
		expect(chat).toHaveAttribute("data-hidden", "false")
		expect(chat).toHaveAttribute("data-history-request", "1")
		expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("Unsent draft")
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "clearTask" }))
		act(() => triggerMessage("historyButtonClicked"))
		expect(chat).toHaveAttribute("data-history-request", "2")
	})

	it("forces chat view when receiving a forced chatButtonClicked action", async () => {
		render(<AppWithProviders />)
		act(() => triggerMessage("settingsButtonClicked"))
		await screen.findByTestId("settings-view")
		act(() => triggerForcedChatMessage())
		expect(screen.getByTestId("chat-view")).toHaveAttribute("data-hidden", "false")
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
	})

	it("returns to chat view when clicking done in settings view", async () => {
		render(<AppWithProviders />)

		act(() => {
			triggerMessage("settingsButtonClicked")
		})

		const settingsView = await screen.findByTestId("settings-view")

		act(() => {
			settingsView.click()
		})

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("false")
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
	})

	it("switches to marketplace view when receiving marketplaceButtonClicked action", async () => {
		render(<AppWithProviders />)

		act(() => {
			triggerMessage("marketplaceButtonClicked")
		})

		const marketplaceView = await screen.findByTestId("marketplace-view")
		expect(marketplaceView).toBeInTheDocument()

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("true")
	})

	it("returns to chat view when clicking done in marketplace view", async () => {
		render(<AppWithProviders />)

		act(() => {
			triggerMessage("marketplaceButtonClicked")
		})

		const marketplaceView = await screen.findByTestId("marketplace-view")

		act(() => {
			marketplaceView.click()
		})

		const chatView = screen.getByTestId("chat-view")
		expect(chatView.getAttribute("data-hidden")).toBe("false")
		expect(screen.queryByTestId("marketplace-view")).not.toBeInTheDocument()
	})
})
