// npx vitest run src/__tests__/App.spec.tsx

import React from "react"
import { render, screen, act, cleanup, fireEvent } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import AppWithProviders from "../App"

const mockChatCommands = vi.hoisted(() => ({ acceptInput: vi.fn(), sendAndSteer: vi.fn() }))

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
	return {
		__esModule: true,
		default: React.forwardRef(function ChatView(
			{ isHidden, historyFocusRequest }: { isHidden: boolean; historyFocusRequest: number },
			ref,
		) {
			React.useImperativeHandle(ref, () => mockChatCommands)
			return (
				<div data-testid="chat-view" data-hidden={isHidden} data-history-request={historyFocusRequest}>
					<input aria-label="Draft" defaultValue="" />
					Chat View
				</div>
			)
		}),
	}
})

vi.mock("@src/components/settings/SettingsView", () => ({
	__esModule: true,
	default: function SettingsView({ onDone }: { onDone: () => void }) {
		return (
			<div data-testid="settings-view" onClick={onDone}>
				Settings View
			</div>
		)
	},
}))

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

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
	ExtensionStateContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock environment variables
vi.mock("process.env", () => ({
	NODE_ENV: "test",
	PKG_VERSION: "1.0.0-test",
}))

describe("App", () => {
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
		window.removeEventListener("message", () => {})

		// Set up default mock return value
		mockUseExtensionState.mockReturnValue({
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
