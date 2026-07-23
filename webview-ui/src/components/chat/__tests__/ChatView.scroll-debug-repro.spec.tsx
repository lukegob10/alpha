import React, { useEffect, useImperativeHandle, useRef } from "react"
import { act, fireEvent, render, waitFor } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { ClineMessage } from "@alpha-code/types"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"

import ChatView, { type ChatViewProps } from "../ChatView"

type FollowOutput = ((isAtBottom: boolean) => "auto" | false) | "auto" | false

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
	autoscrollToBottom: () => void
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
	atBottomStateChange?: (isAtBottom: boolean) => void
	followOutput?: FollowOutput
	className?: string
	initialTopMostItemIndex?: number | { index: number; align: "end"; offset?: number }
	atBottomThreshold?: number
	components?: {
		Footer?: React.ComponentType
	}
}

interface VirtuosoHarnessState {
	scrollCalls: number
	autoscrollCalls: number
	scrollToIndexArgs: Array<{
		index: number | "LAST"
		align?: "end" | "start" | "center"
		behavior?: "auto" | "smooth"
	}>
	scrollToArgs: Array<{ top: number; behavior?: "auto" | "smooth" }>
	atBottomAfterCalls: number
	signalDelayMs: number
	emitFalseOnDataChange: boolean
	delayedGrowthMs: number | null
	initialTopMostItemIndex: MockVirtuosoProps["initialTopMostItemIndex"]
	followOutput: FollowOutput | undefined
	emitAtBottom: (isAtBottom: boolean) => void
	emitLastRowHeightChange: (isTaller: boolean) => void
	emitComposerHeightChange: (height: number) => void
	atBottomThreshold: number | undefined
	computedItemKeys: React.Key[]
}

const harness = vi.hoisted<VirtuosoHarnessState>(() => ({
	scrollCalls: 0,
	autoscrollCalls: 0,
	scrollToIndexArgs: [],
	scrollToArgs: [],
	atBottomAfterCalls: Number.POSITIVE_INFINITY,
	signalDelayMs: 20,
	emitFalseOnDataChange: true,
	delayedGrowthMs: null,
	initialTopMostItemIndex: undefined,
	followOutput: undefined,
	emitAtBottom: () => {},
	emitLastRowHeightChange: () => {},
	emitComposerHeightChange: () => {},
	atBottomThreshold: undefined,
	computedItemKeys: [],
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
			onHeightChange?: (height: number) => void
		},
		ref: React.ForwardedRef<{ focus: () => void }>,
	) {
		useImperativeHandle(ref, () => ({ focus: () => {} }))
		harness.emitComposerHeightChange = props.onHeightChange ?? (() => {})

		return (
			<input
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
	default: ({
		message,
		isLast,
		onHeightChange,
	}: {
		message: ClineMessage
		isLast: boolean
		onHeightChange: (isTaller: boolean) => void
	}) => {
		if (isLast) {
			harness.emitLastRowHeightChange = onHeightChange
		}
		return <div data-testid="chat-row">{message.ts}</div>
	},
}))

vi.mock("react-virtuoso", () => {
	const MockVirtuoso = React.forwardRef<MockVirtuosoHandle, MockVirtuosoProps>(function MockVirtuoso(
		{
			data,
			itemContent,
			computeItemKey,
			atBottomStateChange,
			followOutput,
			className,
			initialTopMostItemIndex,
			atBottomThreshold,
			components,
		},
		ref,
	) {
		const atBottomRef = useRef(atBottomStateChange)
		const timeoutIdsRef = useRef<number[]>([])

		harness.followOutput = followOutput
		harness.initialTopMostItemIndex = initialTopMostItemIndex
		harness.atBottomThreshold = atBottomThreshold
		harness.computedItemKeys = data.map((item, index) => computeItemKey?.(index, item) ?? index)
		harness.emitAtBottom = (isAtBottom: boolean) => {
			atBottomRef.current?.(isAtBottom)
		}

		const recordScroll = () => {
			harness.scrollCalls += 1
			const reachedBottom = harness.scrollCalls >= harness.atBottomAfterCalls
			const timeoutId = window.setTimeout(() => {
				atBottomRef.current?.(reachedBottom)
			}, harness.signalDelayMs)
			timeoutIdsRef.current.push(timeoutId)
		}

		useImperativeHandle(ref, () => ({
			autoscrollToBottom: () => {
				harness.autoscrollCalls += 1
			},
			scrollTo: (options) => {
				harness.scrollToArgs.push(options)
				recordScroll()
			},
			scrollToIndex: (options) => {
				harness.scrollToIndexArgs.push(options)
				recordScroll()
			},
		}))

		useEffect(() => {
			atBottomRef.current = atBottomStateChange
		}, [atBottomStateChange])

		useEffect(() => {
			if (harness.emitFalseOnDataChange) {
				atBottomStateChange?.(false)
			}

			if (harness.delayedGrowthMs !== null) {
				const timeoutId = window.setTimeout(() => {
					atBottomRef.current?.(false)
				}, harness.delayedGrowthMs)
				timeoutIdsRef.current.push(timeoutId)
			}
		}, [data.length, atBottomStateChange])

		useEffect(
			() => () => {
				timeoutIdsRef.current.forEach((id) => window.clearTimeout(id))
				timeoutIdsRef.current = []
			},
			[],
		)

		const Footer = components?.Footer

		return (
			<div data-testid="virtuoso-item-list" className={className} data-count={data.length}>
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

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

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

const buildMessagesWithMultipleCheckpoints = (baseTs: number): ClineMessage[] => [
	{ type: "say", say: "text", ts: baseTs, text: "task" },
	{ type: "say", say: "checkpoint_saved", ts: baseTs + 1, text: "checkpoint-1" },
	{ type: "say", say: "text", ts: baseTs + 2, text: "row-2" },
	{ type: "say", say: "checkpoint_saved", ts: baseTs + 3, text: "checkpoint-2" },
	{ type: "say", say: "text", ts: baseTs + 4, text: "row-4" },
	{ type: "say", say: "checkpoint_saved", ts: baseTs + 5, text: "checkpoint-3" },
	{ type: "say", say: "text", ts: baseTs + 6, text: "row-6" },
]

const resolveFollowOutput = (isAtBottom: boolean): "auto" | false => {
	const followOutput = harness.followOutput
	if (typeof followOutput === "function") {
		return followOutput(isAtBottom)
	}
	return followOutput === "auto" ? "auto" : false
}

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

	window.dispatchEvent(
		new MessageEvent("message", {
			data: message,
		}),
	)
}

const renderView = () =>
	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={new QueryClient()}>
				<ChatView {...props} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

const hydrate = async (atBottomAfterCalls: number, clineMessages = buildMessages(Date.now() - 3_000)) => {
	harness.atBottomAfterCalls = atBottomAfterCalls
	renderView()
	await act(async () => {
		await Promise.resolve()
	})
	await act(async () => {
		postState(clineMessages)
	})
	await waitFor(() => {
		const list = document.querySelector("[data-testid='virtuoso-item-list']")
		expect(list).toBeTruthy()
		expect(list?.getAttribute("data-count")).toBe(String(Math.max(0, clineMessages.length - 1)))
	})
}

const waitForCalls = async (min: number, timeout = 1_500) => {
	await waitFor(() => expect(harness.scrollCalls).toBeGreaterThanOrEqual(min), { timeout })
}

const waitForCallsSettled = async (idleMs = 80, timeoutMs = 2_000) => {
	const deadline = Date.now() + timeoutMs
	let lastSeen = harness.scrollCalls

	while (Date.now() < deadline) {
		await sleep(idleMs)
		const current = harness.scrollCalls

		if (current === lastSeen) {
			await sleep(idleMs)
			if (harness.scrollCalls === current) {
				return
			}
		}

		lastSeen = current
	}

	throw new Error(`Expected scroll calls to settle within ${timeoutMs}ms, last count: ${harness.scrollCalls}`)
}

const getScrollable = (): HTMLElement => {
	const scrollable = document.querySelector(".scrollable")
	if (!(scrollable instanceof HTMLElement)) {
		throw new Error("Expected ChatView scrollable container")
	}
	return scrollable
}

const getScrollToBottomButton = (): HTMLButtonElement => {
	const icon = document.querySelector(".codicon-chevron-down")
	if (!(icon instanceof HTMLElement)) {
		throw new Error("Expected scroll-to-bottom icon")
	}

	const button = icon.closest("button")
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error("Expected scroll-to-bottom button")
	}

	return button
}

const getScrollToCheckpointButton = (): HTMLButtonElement => {
	const button = document.querySelector("button[aria-label='chat:scrollToLatestCheckpoint']")
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error("Expected scroll-to-checkpoint button")
	}

	return button
}

describe("ChatView scroll behavior regression coverage", () => {
	beforeEach(() => {
		harness.scrollCalls = 0
		harness.autoscrollCalls = 0
		harness.scrollToIndexArgs = []
		harness.scrollToArgs = []
		harness.atBottomAfterCalls = Number.POSITIVE_INFINITY
		harness.signalDelayMs = 20
		harness.emitFalseOnDataChange = true
		harness.delayedGrowthMs = null
		harness.initialTopMostItemIndex = undefined
		harness.followOutput = undefined
		harness.emitAtBottom = () => {}
		harness.emitLastRowHeightChange = () => {}
		harness.emitComposerHeightChange = () => {}
		harness.atBottomThreshold = undefined
		harness.computedItemKeys = []
	})

	it("existing-task entry starts at the final virtualized row", async () => {
		await hydrate(2)
		expect(harness.initialTopMostItemIndex).toEqual({ index: 1, align: "end" })
	})

	it("uses a practical near-bottom follow zone", async () => {
		await hydrate(2)
		expect(harness.atBottomThreshold).toBeGreaterThanOrEqual(48)
	})

	it("keeps breathing room below the final chat row", async () => {
		await hydrate(2)
		expect(document.querySelector("[data-testid='chat-bottom-spacer']")).toHaveStyle({ height: "32px" })
	})

	it("bounds the transcript and leaves a physical gap above the composer", async () => {
		await hydrate(2)

		const scrollable = getScrollable()
		const transcriptViewport = scrollable.parentElement

		expect(transcriptViewport).toHaveClass("mb-8", "min-h-0", "flex-1", "overflow-hidden")
		expect(scrollable).toHaveClass("h-full", "min-h-0", "w-full")
		expect(scrollable).not.toHaveClass("mb-1", "flex-1")
		expect(transcriptViewport?.nextElementSibling).not.toContainElement(scrollable)
	})

	it("rehydration uses one bounded bottom fallback", async () => {
		await hydrate(Number.POSITIVE_INFINITY)
		await waitForCalls(1, 1_200)
		await waitForCallsSettled()
		expect(harness.scrollCalls).toBe(1)
		expect(harness.scrollToIndexArgs).toHaveLength(1)
		expect(harness.scrollToIndexArgs).toEqual([{ index: 1, align: "end", behavior: "auto" }])
		expect(resolveFollowOutput(false)).toBe("auto")
		expect(document.querySelector(".codicon-chevron-down")).toBeNull()
	})

	it("uses stable message identities for virtualized rows", async () => {
		const messages = buildMessages(Date.now() - 3_000)
		await hydrate(2, messages)

		expect(harness.computedItemKeys).toEqual(messages.slice(1).map((message) => message.ts))
	})

	it("transient hydration-time not-at-bottom signals do not disable sticky follow", async () => {
		await hydrate(1)
		await waitForCalls(1, 1_200)
		expect(resolveFollowOutput(false)).toBe("auto")
		expect(document.querySelector(".codicon-chevron-down")).toBeNull()

		await act(async () => {
			harness.emitAtBottom(false)
		})

		expect(resolveFollowOutput(false)).toBe("auto")
		expect(document.querySelector(".codicon-chevron-down")).toBeNull()

		await waitForCalls(1, 1_200)
		await waitForCallsSettled()
		expect(harness.scrollCalls).toBe(1)
		expect(resolveFollowOutput(false)).toBe("auto")
	})

	it("delayed last-row growth during hydration keeps anchored follow with one bounded repin", async () => {
		harness.delayedGrowthMs = 320
		await hydrate(1)
		await waitForCalls(1, 1_200)

		await sleep(950)

		expect(harness.scrollCalls).toBe(1)
		expect(resolveFollowOutput(false)).toBe("auto")
		expect(document.querySelector(".codicon-chevron-down")).toBeNull()
	})

	it("exposes recovery without recursively scrolling when anchored follow loses physical bottom", async () => {
		const messages = buildMessages(Date.now() - 3_000)
		messages[messages.length - 1] = { ...messages[messages.length - 1], partial: true }
		await hydrate(1, messages)
		await waitForCalls(1)
		await waitForCallsSettled()

		const callsBeforeSignal = harness.scrollCalls
		await act(async () => {
			harness.emitAtBottom(false)
		})
		await sleep(50)

		expect(harness.scrollCalls).toBe(callsBeforeSignal)
		expect(resolveFollowOutput(false)).toBe("auto")
		expect(getScrollToBottomButton()).toHaveAttribute("aria-label", "chat:scrollToBottom")
	})

	it("coalesces bursty anchored-row growth into one exact-bottom correction", async () => {
		const messages = buildMessages(Date.now() - 3_000)
		await hydrate(1, messages)
		await waitForCalls(1)
		await waitForCallsSettled()

		const imperativeCallsBeforeGrowth = harness.scrollCalls
		const followCallsBeforeGrowth = harness.autoscrollCalls
		await act(async () => {
			for (let index = 0; index < 8; index += 1) {
				harness.emitLastRowHeightChange(true)
			}
			await sleep(25)
		})

		expect(harness.autoscrollCalls).toBe(followCallsBeforeGrowth)
		expect(harness.scrollCalls).toBe(imperativeCallsBeforeGrowth + 1)
		expect(harness.scrollToIndexArgs.at(-1)).toEqual({ index: 1, align: "end", behavior: "auto" })
	})

	it("re-pins streamed row growth after Virtuoso already reported physical detachment", async () => {
		const messages = buildMessages(Date.now() - 3_000)
		await hydrate(1, messages)
		await waitForCalls(1)
		await waitForCallsSettled()

		const callsBeforeGrowth = harness.scrollCalls
		const followCallsBeforeGrowth = harness.autoscrollCalls
		await act(async () => {
			harness.emitAtBottom(false)
			harness.emitLastRowHeightChange(true)
		})

		await waitFor(() => expect(harness.scrollCalls).toBe(callsBeforeGrowth + 1), { timeout: 1_200 })
		expect(harness.autoscrollCalls).toBe(followCallsBeforeGrowth)
		expect(harness.scrollToIndexArgs.at(-1)).toEqual({ index: 1, align: "end", behavior: "auto" })
		await waitFor(() => expect(document.querySelector(".codicon-chevron-down")).toBeNull(), { timeout: 1_200 })
	})

	it("lets Virtuoso own appended-message following without a second imperative correction", async () => {
		const messages = buildMessages(Date.now() - 3_000)
		await hydrate(1, messages)
		await waitForCalls(1)
		await waitForCallsSettled()

		const callsBeforeAppend = harness.scrollCalls
		await act(async () => {
			postState([...messages, { type: "say", say: "text", ts: Date.now(), text: "row-3" }])
			await sleep(50)
		})

		expect(harness.scrollCalls).toBe(callsBeforeAppend)
		expect(resolveFollowOutput(false)).toBe("auto")
	})

	it("lets Virtuoso own composer viewport resizing without a competing imperative correction", async () => {
		await hydrate(1)
		await waitForCalls(1)
		await waitForCallsSettled()

		const callsBeforeResize = harness.scrollCalls
		await act(async () => {
			harness.emitComposerHeightChange(160)
			await sleep(25)
		})

		expect(harness.scrollCalls).toBe(callsBeforeResize)
		expect(resolveFollowOutput(false)).toBe("auto")

		await act(async () => {
			fireEvent.keyDown(window, { key: "PageUp" })
			harness.emitComposerHeightChange(200)
			await sleep(25)
		})

		expect(harness.scrollCalls).toBe(callsBeforeResize)
	})

	it("task-header layout changes disengage sticky follow before resizing the viewport", async () => {
		await hydrate(1)
		await waitForCalls(1)
		await waitForCallsSettled()
		expect(resolveFollowOutput(false)).toBe("auto")

		await act(async () => {
			fireEvent.click(document.querySelector("[data-testid='task-header']") as HTMLElement)
		})

		expect(resolveFollowOutput(false)).toBe(false)
	})

	it("user escape hatch during hydration prevents repinning", async () => {
		await hydrate(Number.POSITIVE_INFINITY)
		await waitForCalls(1, 1_200)

		await act(async () => {
			fireEvent.keyDown(window, { key: "PageUp" })
		})

		expect(resolveFollowOutput(false)).toBe(false)

		await act(async () => {
			harness.emitAtBottom(true)
		})

		expect(resolveFollowOutput(false)).toBe(false)

		await waitFor(() => expect(document.querySelector(".codicon-chevron-down")).toBeTruthy(), {
			timeout: 1_200,
		})
	})

	it("non-wheel upward intent disengages sticky follow", async () => {
		await hydrate(1)
		await waitForCalls(1)
		await waitForCallsSettled()
		expect(resolveFollowOutput(false)).toBe("auto")

		const scrollable = getScrollable()
		scrollable.scrollTop = 240

		await act(async () => {
			fireEvent.pointerDown(scrollable)
			scrollable.scrollTop = 120
			fireEvent.scroll(scrollable)
			fireEvent.pointerUp(window)
		})

		expect(resolveFollowOutput(false)).toBe(false)
	})

	it("nested scroller scroll events do not falsely disengage sticky follow", async () => {
		await hydrate(1)
		await waitForCalls(1)
		await waitForCallsSettled()
		expect(resolveFollowOutput(false)).toBe("auto")

		const scrollable = getScrollable()
		const nestedScrollable = document.createElement("div")
		nestedScrollable.style.overflowY = "auto"
		nestedScrollable.scrollTop = 0
		scrollable.appendChild(nestedScrollable)

		scrollable.scrollTop = 240

		await act(async () => {
			fireEvent.pointerDown(nestedScrollable)
			nestedScrollable.scrollTop = 120
			fireEvent.scroll(nestedScrollable)
			fireEvent.pointerUp(window)
		})

		expect(resolveFollowOutput(false)).toBe("auto")
		expect(document.querySelector(".codicon-chevron-down")).toBeNull()
	})

	it("wheel-up intent disengages sticky follow", async () => {
		await hydrate(1)
		await waitForCalls(1)
		await waitForCallsSettled()
		expect(resolveFollowOutput(false)).toBe("auto")

		const scrollable = getScrollable()

		await act(async () => {
			fireEvent.wheel(scrollable, { deltaY: -120 })
		})

		expect(resolveFollowOutput(false)).toBe(false)
		await waitFor(() => expect(document.querySelector(".codicon-chevron-down")).toBeTruthy(), {
			timeout: 1_200,
		})

		const jumpControls = document.querySelector("[data-testid='chat-scroll-controls']")
		expect(jumpControls).toHaveClass("absolute")
		expect(jumpControls?.parentElement).toBe(scrollable.parentElement)
		expect(scrollable.parentElement).toHaveClass("relative", "min-h-0")
		expect(getScrollToBottomButton()).toHaveAttribute("aria-label", "chat:scrollToBottom")

		const callsWhileBrowsing = harness.scrollCalls
		const followCallsWhileBrowsing = harness.autoscrollCalls
		await act(async () => {
			harness.emitLastRowHeightChange(true)
			harness.emitComposerHeightChange(200)
			await sleep(25)
		})
		expect(harness.scrollCalls).toBe(callsWhileBrowsing)
		expect(harness.autoscrollCalls).toBe(followCallsWhileBrowsing)
	})

	it("hydration completion cannot override user escape hatch", async () => {
		await hydrate(Number.POSITIVE_INFINITY)
		await waitForCalls(1, 1_200)

		await act(async () => {
			fireEvent.keyDown(window, { key: "PageUp" })
		})

		expect(resolveFollowOutput(false)).toBe(false)

		await sleep(700)

		expect(resolveFollowOutput(false)).toBe(false)
		await waitFor(() => expect(document.querySelector(".codicon-chevron-down")).toBeTruthy(), {
			timeout: 1_200,
		})
	})

	it("scroll-to-bottom CTA re-anchors with one interaction", async () => {
		await hydrate(1)
		await waitForCalls(1)
		await waitForCallsSettled()
		expect(resolveFollowOutput(false)).toBe("auto")

		await act(async () => {
			fireEvent.keyDown(window, { key: "PageUp" })
		})

		expect(resolveFollowOutput(false)).toBe(false)
		await waitFor(() => expect(document.querySelector(".codicon-chevron-down")).toBeTruthy(), {
			timeout: 1_200,
		})

		const callsBeforeClick = harness.scrollCalls
		harness.atBottomAfterCalls = callsBeforeClick + 2

		await act(async () => {
			getScrollToBottomButton().click()
		})

		expect(resolveFollowOutput(false)).toBe("auto")
		await waitFor(() => expect(harness.scrollCalls).toBe(callsBeforeClick + 2), {
			timeout: 1_200,
		})
		await waitFor(() => expect(document.querySelector(".codicon-chevron-down")).toBeNull(), { timeout: 1_200 })
	})

	it("shows jump-to-checkpoint button and scrolls to latest checkpoint", async () => {
		await hydrate(1, buildMessagesWithCheckpoint(Date.now() - 3_000))
		await waitForCalls(1)
		await waitForCallsSettled()

		await act(async () => {
			fireEvent.keyDown(window, { key: "PageUp" })
		})

		await waitFor(() => expect(document.querySelector(".codicon-chevron-down")).toBeTruthy(), {
			timeout: 1_200,
		})

		const checkpointButton = document.querySelector("button[aria-label='chat:scrollToLatestCheckpoint']")
		expect(checkpointButton).toBeInstanceOf(HTMLButtonElement)

		const callsBeforeClick = harness.scrollCalls

		await act(async () => {
			;(checkpointButton as HTMLButtonElement).click()
		})

		expect(harness.scrollCalls).toBe(callsBeforeClick + 1)
		expect(harness.scrollToIndexArgs.at(-1)).toMatchObject({
			index: 1,
			align: "center",
			behavior: "smooth",
		})
	})

	it("repeated checkpoint clicks step backward through previous checkpoints", async () => {
		await hydrate(1, buildMessagesWithMultipleCheckpoints(Date.now() - 3_000))
		await waitForCalls(1)
		await waitForCallsSettled()

		await act(async () => {
			fireEvent.keyDown(window, { key: "PageUp" })
		})

		await waitFor(() => expect(document.querySelector(".codicon-chevron-down")).toBeTruthy(), {
			timeout: 1_200,
		})

		const checkpointButton = getScrollToCheckpointButton()

		await act(async () => {
			;(checkpointButton as HTMLButtonElement).click()
		})
		expect(harness.scrollToIndexArgs.at(-1)).toMatchObject({ index: 4, align: "center", behavior: "smooth" })

		await act(async () => {
			;(checkpointButton as HTMLButtonElement).click()
		})
		expect(harness.scrollToIndexArgs.at(-1)).toMatchObject({ index: 2, align: "center", behavior: "smooth" })

		await act(async () => {
			;(checkpointButton as HTMLButtonElement).click()
		})
		expect(harness.scrollToIndexArgs.at(-1)).toMatchObject({ index: 0, align: "center", behavior: "smooth" })

		// Once at the oldest checkpoint, additional clicks keep targeting it.
		await act(async () => {
			;(checkpointButton as HTMLButtonElement).click()
		})
		expect(harness.scrollToIndexArgs.at(-1)).toMatchObject({ index: 0, align: "center", behavior: "smooth" })
	})
})
