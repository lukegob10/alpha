import React, { useImperativeHandle } from "react"
import { act, fireEvent, render, waitFor } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { ClineMessage } from "@alpha-code/types"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"

import ChatView, { type ChatViewProps } from "../ChatView"

interface ExtensionStateMessage {
	type: "state"
	state: {
		version: string
		clineMessages: ClineMessage[]
		taskHistory: unknown[]
		shouldShowAnnouncement: boolean
		allowedCommands: string[]
		alwaysAllowExecute: boolean
		telemetrySetting: "enabled" | "disabled" | "unset"
	}
}

function nullDefaultModule() {
	return { default: () => null }
}

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("use-sound", () => ({ default: vi.fn().mockImplementation(() => [vi.fn()]) }))
vi.mock("@src/components/cloud/CloudUpsellDialog", () => ({ CloudUpsellDialog: () => null }))
vi.mock("@src/hooks/useCloudUpsell", () => ({
	useCloudUpsell: () => ({
		isOpen: false,
		openUpsell: vi.fn(),
		closeUpsell: vi.fn(),
		handleConnect: vi.fn(),
	}),
}))

vi.mock("../common/TelemetryBanner", nullDefaultModule)
vi.mock("../common/VersionIndicator", nullDefaultModule)
vi.mock("../history/HistoryPreview", nullDefaultModule)
vi.mock("@src/components/welcome/AlphaHero", nullDefaultModule)
vi.mock("@src/components/welcome/AlphaTips", nullDefaultModule)
vi.mock("../Announcement", nullDefaultModule)
vi.mock("../TaskHeader", () => ({
	default: ({ onExpandedChange }: { onExpandedChange?: () => void }) => (
		<button data-testid="task-header" onClick={onExpandedChange}>
			Toggle task header
		</button>
	),
}))
vi.mock("./ProfileViolationWarning", nullDefaultModule)
vi.mock("../common/DismissibleUpsell", nullDefaultModule)
vi.mock("./CheckpointWarning", () => ({ CheckpointWarning: () => null }))
vi.mock("./QueuedMessages", () => ({ QueuedMessages: () => null }))
vi.mock("./WorktreeSelector", () => ({ WorktreeSelector: () => null }))
vi.mock("../FileChangesPanel", () => ({ default: () => <div data-testid="file-changes-panel" /> }))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/components/ui")>()
	return {
		...actual,
		StandardTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	}
})

vi.mock("../ChatTextArea", () => {
	const MockTextArea = React.forwardRef(function MockTextArea(
		props: {
			inputValue?: string
			setInputValue?: (value: string) => void
			onSend: () => void
			sendingDisabled?: boolean
		},
		ref: React.ForwardedRef<{ focus: () => void }>,
	) {
		useImperativeHandle(ref, () => ({ focus: () => {} }))
		return (
			<input
				data-testid="chat-input"
				value={props.inputValue ?? ""}
				onChange={(event) => props.setInputValue?.(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !props.sendingDisabled) {
						props.onSend()
					}
				}}
			/>
		)
	})

	return { default: MockTextArea, ChatTextArea: MockTextArea }
})

vi.mock("../ChatRow", () => ({
	default: ({ message }: { message: ClineMessage }) => <div data-testid="chat-row">{message.ts}</div>,
}))

const props: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const buildMessages = (baseTs: number): ClineMessage[] => [
	{ type: "say", say: "text", ts: baseTs, text: "task" },
	{ type: "say", say: "text", ts: baseTs + 1, text: "row-1" },
	{ type: "say", say: "text", ts: baseTs + 2, text: "row-2" },
]

const buildMessagesWithCheckpoint = (baseTs: number): ClineMessage[] => [
	{ type: "say", say: "text", ts: baseTs, text: "task" },
	{ type: "say", say: "text", ts: baseTs + 1, text: "row-1" },
	{ type: "say", say: "checkpoint_saved", ts: baseTs + 2, text: "checkpoint-1" },
	{ type: "say", say: "text", ts: baseTs + 3, text: "row-2" },
]

const postState = (clineMessages: ClineMessage[]) => {
	const message: ExtensionStateMessage = {
		type: "state",
		state: {
			version: "1.0.0",
			clineMessages,
			taskHistory: [],
			shouldShowAnnouncement: false,
			allowedCommands: [],
			alwaysAllowExecute: false,
			telemetrySetting: "enabled",
		},
	}

	window.dispatchEvent(new MessageEvent("message", { data: message }))
}

const renderView = () =>
	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={new QueryClient()}>
				<ChatView {...props} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

const hydrate = async (clineMessages = buildMessages(Date.now() - 3_000)) => {
	renderView()
	await act(async () => postState(clineMessages))
	await waitFor(() => {
		const content = document.querySelector("[data-testid='chat-transcript-content']")
		expect(content).toBeTruthy()
		expect(content?.getAttribute("data-count")).toBe(String(Math.max(0, clineMessages.length - 1)))
	})
}

const getScrollable = (): HTMLElement => {
	const element = document.querySelector("[data-testid='chat-transcript-scroller']")
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected native chat transcript scroller")
	}
	return element
}

const setScrollGeometry = (
	element: HTMLElement,
	{ scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number },
) => {
	Object.defineProperties(element, {
		scrollHeight: { configurable: true, value: scrollHeight },
		clientHeight: { configurable: true, value: clientHeight },
		scrollTop: { configurable: true, writable: true, value: scrollTop },
	})
}

const seedBottomGeometry = (element: HTMLElement) => {
	setScrollGeometry(element, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 })
	fireEvent.scroll(element)
}

const beginBrowsing = async (element: HTMLElement) => {
	fireEvent.wheel(element, { deltaY: -120 })
	element.scrollTop = 450
	fireEvent.scroll(element)
	await waitFor(() => expect(getScrollToBottomButton()).toBeVisible())
}

const getScrollToBottomButton = (): HTMLButtonElement => {
	const button = document.querySelector("button[aria-label='chat:scrollToBottom']")
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error("Expected scroll-to-bottom button")
	}
	return button
}

describe("ChatView native scroll behavior", () => {
	it("uses a real bounded scroller with exact non-virtualized content", async () => {
		await hydrate()
		const scroller = getScrollable()
		const content = document.querySelector("[data-testid='chat-transcript-content']")

		expect(scroller).toHaveStyle({ overflowAnchor: "none" })
		expect(scroller).toHaveClass("overflow-y-auto", "overscroll-contain")
		expect(content).toContainElement(document.querySelector("[data-testid='chat-message-0']"))
		expect(document.querySelector("[data-testid='virtuoso-scroller']")).toBeNull()
	})

	it("keeps the input dock outside the bounded transcript scroller", async () => {
		await hydrate()
		const scrollable = getScrollable()
		const viewport = scrollable.parentElement
		const dock = document.querySelector("[data-testid='chat-bottom-dock']")

		expect(viewport).toHaveAttribute("data-testid", "chat-transcript-viewport")
		expect(viewport).toHaveClass("min-h-0", "flex-1", "overflow-hidden")
		expect(dock).toHaveClass("flex", "shrink-0", "flex-col")
		expect(viewport?.nextElementSibling).toBe(dock)
		expect(dock).not.toContainElement(scrollable)
		expect(dock).toContainElement(document.querySelector("[data-testid='file-changes-panel']"))
		expect(dock).toContainElement(document.querySelector("[data-testid='chat-input']"))
	})

	it("restores the exact bottom after composer-driven viewport changes", async () => {
		await hydrate()
		const scrollable = getScrollable()
		seedBottomGeometry(scrollable)

		setScrollGeometry(scrollable, { scrollHeight: 1_000, clientHeight: 250, scrollTop: 600 })
		fireEvent.scroll(scrollable)

		await waitFor(() => expect(scrollable.scrollTop).toBe(750))
		expect(scrollable.scrollHeight - scrollable.clientHeight - scrollable.scrollTop).toBe(0)
		expect(document.querySelector("button[aria-label='chat:scrollToBottom']")).toBeNull()
	})

	it("does not let streamed output steal a deliberate history position", async () => {
		await hydrate()
		const scrollable = getScrollable()
		seedBottomGeometry(scrollable)
		await beginBrowsing(scrollable)

		setScrollGeometry(scrollable, { scrollHeight: 1_400, clientHeight: 400, scrollTop: 450 })
		fireEvent.load(scrollable)
		await new Promise((resolve) => window.setTimeout(resolve, 30))

		expect(scrollable.scrollTop).toBe(450)
		expect(getScrollToBottomButton()).toBeVisible()
	})

	it("reattaches when native scrolling reaches the true bottom during a row resize", async () => {
		await hydrate()
		const scrollable = getScrollable()
		seedBottomGeometry(scrollable)
		await beginBrowsing(scrollable)

		setScrollGeometry(scrollable, { scrollHeight: 1_100, clientHeight: 400, scrollTop: 700 })
		fireEvent.scroll(scrollable)

		await waitFor(() => expect(document.querySelector("button[aria-label='chat:scrollToBottom']")).toBeNull())
		expect(scrollable.scrollHeight - scrollable.clientHeight - scrollable.scrollTop).toBe(0)
	})

	it("re-anchors the explicit bottom action to the exact native maximum", async () => {
		await hydrate()
		const scrollable = getScrollable()
		seedBottomGeometry(scrollable)
		await beginBrowsing(scrollable)

		fireEvent.click(getScrollToBottomButton())

		await waitFor(() => expect(scrollable.scrollTop).toBe(600))
		expect(document.querySelector("button[aria-label='chat:scrollToBottom']")).toBeNull()
	})

	it("uses stable message keys and native checkpoint navigation", async () => {
		const scrollIntoView = vi.fn()
		const messages = buildMessagesWithCheckpoint(Date.now() - 3_000)
		await hydrate(messages)
		const checkpoint = document.querySelector<HTMLElement>("[data-chat-message-index='1']")
		expect(checkpoint).toBeTruthy()
		Object.defineProperty(checkpoint!, "scrollIntoView", { configurable: true, value: scrollIntoView })

		fireEvent.click(document.querySelector("[data-testid='task-header']") as HTMLElement)
		const checkpointButton = await waitFor(() => {
			const button = document.querySelector("button[aria-label='chat:scrollToLatestCheckpoint']")
			expect(button).toBeInstanceOf(HTMLButtonElement)
			return button as HTMLButtonElement
		})
		fireEvent.click(checkpointButton)

		expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" })
	})

	it("keeps wheel scrolling active over the floating controls", async () => {
		await hydrate()
		const scrollable = getScrollable()
		const scrollBy = vi.fn()
		Object.defineProperty(scrollable, "scrollBy", { configurable: true, value: scrollBy })
		seedBottomGeometry(scrollable)
		await beginBrowsing(scrollable)

		fireEvent.wheel(getScrollToBottomButton(), { deltaY: 120 })
		expect(scrollBy).toHaveBeenCalledWith({ top: 120, behavior: "auto" })
	})
})
