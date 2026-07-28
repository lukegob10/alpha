import React, { useCallback, useEffect, useImperativeHandle } from "react"
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

interface MockVirtuosoHandle {
	scrollBy: (options: { top: number; behavior?: "auto" | "smooth" }) => void
	scrollTo: (options: { top: number; behavior?: "auto" | "smooth" }) => void
	scrollToIndex: (options: {
		index: number | "LAST"
		align?: "end" | "start" | "center"
		behavior?: "auto" | "smooth"
	}) => void
}

interface MockVirtuosoProps {
	data: ClineMessage[]
	itemContent: (index: number, item: ClineMessage) => React.ReactNode
	computeItemKey?: (index: number, item: ClineMessage) => React.Key
	className?: string
	style?: React.CSSProperties
	onScroll?: React.UIEventHandler<HTMLElement>
	onLoadCapture?: React.ReactEventHandler<HTMLElement>
	scrollerRef?: (element: HTMLElement | Window | null) => void
	isScrolling?: (isScrolling: boolean) => void
	totalListHeightChanged?: (height: number) => void
	followOutput?: unknown
	atBottomStateChange?: unknown
	atBottomThreshold?: unknown
	initialItemCount?: unknown
	skipAnimationFrameInResizeObserver?: unknown
	components?: {
		Footer?: React.ComponentType
	}
}

interface VirtuosoHarnessState {
	scrollCalls: number
	scrollByArgs: Array<{ top: number; behavior?: "auto" | "smooth" }>
	scrollToIndexArgs: Array<{
		index: number | "LAST"
		align?: "end" | "start" | "center"
		behavior?: "auto" | "smooth"
	}>
	scrollToArgs: Array<{ top: number; behavior?: "auto" | "smooth" }>
	emitScrollIdle: (isScrolling: boolean) => void
	emitContentHeightChange: (height: number) => void
	computedItemKeys: React.Key[]
	scrollerStyle: React.CSSProperties | undefined
	scrollerElement: HTMLElement | null
	legacyAutomaticProps: {
		followOutput: unknown
		atBottomStateChange: unknown
		atBottomThreshold: unknown
		initialItemCount: unknown
		skipAnimationFrameInResizeObserver: unknown
	}
}

const harness = vi.hoisted<VirtuosoHarnessState>(() => ({
	scrollCalls: 0,
	scrollByArgs: [],
	scrollToIndexArgs: [],
	scrollToArgs: [],
	emitScrollIdle: () => {},
	emitContentHeightChange: () => {},
	computedItemKeys: [],
	scrollerStyle: undefined,
	scrollerElement: null,
	legacyAutomaticProps: {
		followOutput: undefined,
		atBottomStateChange: undefined,
		atBottomThreshold: undefined,
		initialItemCount: undefined,
		skipAnimationFrameInResizeObserver: undefined,
	},
}))

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

vi.mock("react-virtuoso", () => {
	const MockVirtuoso = React.forwardRef<MockVirtuosoHandle, MockVirtuosoProps>(function MockVirtuoso(props, ref) {
		const {
			data,
			itemContent,
			computeItemKey,
			className,
			components,
			style,
			onScroll,
			onLoadCapture,
			scrollerRef,
			isScrolling,
			totalListHeightChanged,
		} = props

		harness.scrollerStyle = style
		harness.computedItemKeys = data.map((item, index) => computeItemKey?.(index, item) ?? index)
		harness.emitScrollIdle = (scrolling: boolean) => isScrolling?.(scrolling)
		harness.emitContentHeightChange = (height: number) => totalListHeightChanged?.(height)
		harness.legacyAutomaticProps = {
			followOutput: props.followOutput,
			atBottomStateChange: props.atBottomStateChange,
			atBottomThreshold: props.atBottomThreshold,
			initialItemCount: props.initialItemCount,
			skipAnimationFrameInResizeObserver: props.skipAnimationFrameInResizeObserver,
		}

		const setScrollerElement = useCallback(
			(element: HTMLDivElement | null) => {
				harness.scrollerElement = element
				scrollerRef?.(element)
			},
			[scrollerRef],
		)

		useImperativeHandle(ref, () => ({
			scrollBy: (options) => {
				harness.scrollByArgs.push(options)
			},
			scrollTo: (options) => {
				harness.scrollToArgs.push(options)
				harness.scrollCalls += 1
				const element = harness.scrollerElement
				if (element && options.top === Number.MAX_SAFE_INTEGER) {
					element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
				}
			},
			scrollToIndex: (options) => {
				harness.scrollToIndexArgs.push(options)
				harness.scrollCalls += 1
			},
		}))

		useEffect(() => {
			totalListHeightChanged?.(data.length * 100)
		}, [data.length, totalListHeightChanged])

		const Footer = components?.Footer
		return (
			<div
				ref={setScrollerElement}
				data-testid="virtuoso-item-list"
				className={className}
				data-count={data.length}
				style={style}
				onScroll={onScroll}
				onLoadCapture={onLoadCapture}>
				{data.map((item, index) => (
					<div key={item.ts} data-testid={`virtuoso-item-${index}`}>
						{itemContent(index, item)}
					</div>
				))}
				{Footer && <Footer />}
			</div>
		)
	})

	return { Virtuoso: MockVirtuoso }
})

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
	await act(async () => {
		postState(clineMessages)
	})
	await waitFor(() => {
		const list = document.querySelector("[data-testid='virtuoso-item-list']")
		expect(list).toBeTruthy()
		expect(list?.getAttribute("data-count")).toBe(String(Math.max(0, clineMessages.length - 1)))
	})
}

const getScrollable = (): HTMLElement => {
	const element = document.querySelector(".scrollable")
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected ChatView scrollable container")
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

const getScrollToBottomButton = (): HTMLButtonElement => {
	const button = document.querySelector("button[aria-label='chat:scrollToBottom']")
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error("Expected scroll-to-bottom button")
	}
	return button
}

describe("ChatView single-owner scroll behavior", () => {
	beforeEach(() => {
		harness.scrollCalls = 0
		harness.scrollByArgs = []
		harness.scrollToIndexArgs = []
		harness.scrollToArgs = []
		harness.emitScrollIdle = () => {}
		harness.emitContentHeightChange = () => {}
		harness.computedItemKeys = []
		harness.scrollerStyle = undefined
		harness.scrollerElement = null
		harness.legacyAutomaticProps = {
			followOutput: undefined,
			atBottomStateChange: undefined,
			atBottomThreshold: undefined,
			initialItemCount: undefined,
			skipAnimationFrameInResizeObserver: undefined,
		}
	})

	it("uses one exact-bottom command and no legacy automatic scroll mechanisms", async () => {
		await hydrate()
		await waitFor(() => expect(harness.scrollToArgs.length).toBeGreaterThanOrEqual(1))

		expect(harness.scrollToArgs.at(-1)).toEqual({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
		expect(harness.scrollToIndexArgs).toHaveLength(0)
		expect(harness.legacyAutomaticProps).toEqual({
			followOutput: undefined,
			atBottomStateChange: undefined,
			atBottomThreshold: undefined,
			initialItemCount: undefined,
			skipAnimationFrameInResizeObserver: undefined,
		})
		expect(harness.scrollerStyle).toMatchObject({ overflowAnchor: "none" })
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

	it("coalesces rapid content-height revisions through the same bottom path", async () => {
		await hydrate()
		await waitFor(() => expect(harness.scrollToArgs.length).toBeGreaterThanOrEqual(1))
		const callsBeforeGrowth = harness.scrollToArgs.length

		act(() => {
			for (let index = 0; index < 10; index += 1) {
				harness.emitContentHeightChange(400 + index)
			}
		})

		await waitFor(() => expect(harness.scrollToArgs).toHaveLength(callsBeforeGrowth + 1))
	})

	it("treats composer-driven viewport changes as layout and restores the true bottom", async () => {
		await hydrate()
		await waitFor(() => expect(harness.scrollToArgs.length).toBeGreaterThanOrEqual(1))
		const scrollable = getScrollable()
		seedBottomGeometry(scrollable)
		const callsBeforeResize = harness.scrollToArgs.length

		setScrollGeometry(scrollable, { scrollHeight: 1_000, clientHeight: 250, scrollTop: 450 })
		fireEvent.scroll(scrollable)

		await waitFor(() => expect(harness.scrollToArgs).toHaveLength(callsBeforeResize + 1))
		expect(scrollable.scrollHeight - scrollable.clientHeight - scrollable.scrollTop).toBe(0)
		expect(document.querySelector("button[aria-label='chat:scrollToBottom']")).toBeNull()
	})

	it("does not let streamed output steal a deliberate history position", async () => {
		await hydrate()
		await waitFor(() => expect(harness.scrollToArgs.length).toBeGreaterThanOrEqual(1))
		const scrollable = getScrollable()
		seedBottomGeometry(scrollable)
		scrollable.scrollTop = 450
		fireEvent.scroll(scrollable)
		const callsWhileBrowsing = harness.scrollToArgs.length

		expect(getScrollToBottomButton()).toBeVisible()
		act(() => harness.emitContentHeightChange(1_400))
		await new Promise((resolve) => window.setTimeout(resolve, 30))

		expect(harness.scrollToArgs).toHaveLength(callsWhileBrowsing)
		expect(getScrollToBottomButton()).toBeVisible()
	})

	it("magnetically captures downward scrolling in the final five percent", async () => {
		await hydrate()
		await waitFor(() => expect(harness.scrollToArgs.length).toBeGreaterThanOrEqual(1))
		const scrollable = getScrollable()
		seedBottomGeometry(scrollable)
		scrollable.scrollTop = 450
		fireEvent.scroll(scrollable)
		expect(getScrollToBottomButton()).toBeVisible()

		scrollable.scrollTop = 580
		fireEvent.scroll(scrollable)

		await waitFor(() => expect(document.querySelector("button[aria-label='chat:scrollToBottom']")).toBeNull())
		expect(harness.scrollToArgs.at(-1)).toEqual({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
	})

	it("re-anchors the explicit bottom action with one command", async () => {
		await hydrate()
		await waitFor(() => expect(harness.scrollToArgs.length).toBeGreaterThanOrEqual(1))
		const scrollable = getScrollable()
		seedBottomGeometry(scrollable)
		scrollable.scrollTop = 450
		fireEvent.scroll(scrollable)
		const callsBeforeClick = harness.scrollToArgs.length

		fireEvent.click(getScrollToBottomButton())

		await waitFor(() => expect(harness.scrollToArgs).toHaveLength(callsBeforeClick + 1))
		expect(harness.scrollToArgs.at(-1)).toEqual({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
	})

	it("preserves stable message keys and explicit checkpoint navigation", async () => {
		const messages = buildMessagesWithCheckpoint(Date.now() - 3_000)
		await hydrate(messages)
		await waitFor(() => expect(harness.scrollToArgs.length).toBeGreaterThanOrEqual(1))

		expect(harness.computedItemKeys).toEqual(messages.slice(1).map((message) => message.ts))
		fireEvent.click(document.querySelector("[data-testid='task-header']") as HTMLElement)
		const checkpointButton = await waitFor(() => {
			const button = document.querySelector("button[aria-label='chat:scrollToLatestCheckpoint']")
			expect(button).toBeInstanceOf(HTMLButtonElement)
			return button as HTMLButtonElement
		})
		fireEvent.click(checkpointButton)

		expect(harness.scrollToIndexArgs.at(-1)).toMatchObject({ index: 1, align: "center", behavior: "smooth" })
	})

	it("keeps wheel scrolling active over the floating controls", async () => {
		await hydrate()
		await waitFor(() => expect(harness.scrollToArgs.length).toBeGreaterThanOrEqual(1))
		const scrollable = getScrollable()
		seedBottomGeometry(scrollable)
		scrollable.scrollTop = 450
		fireEvent.scroll(scrollable)

		fireEvent.wheel(getScrollToBottomButton(), { deltaY: 120 })
		expect(harness.scrollByArgs).toEqual([{ top: 120, behavior: "auto" }])
	})
})
