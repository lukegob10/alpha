import type { ReactNode } from "react"
import { act, render, screen } from "@/utils/test-utils"
import type { ClineMessage } from "@alpha-code/types"

import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

const mockUseExtensionState = vi.fn(() => {
	throw new Error("virtualized rows must not subscribe to root extension state")
})

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { exists: () => true },
	}),
	Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

const resizeObserverHarness = {
	callback: (() => {}) as ResizeObserverCallback,
	disconnect: vi.fn(),
	observe: vi.fn(),
}

class TestResizeObserver {
	constructor(callback: ResizeObserverCallback) {
		resizeObserverHarness.callback = callback
	}

	observe = resizeObserverHarness.observe
	disconnect = resizeObserverHarness.disconnect
	unobserve = vi.fn()
}

const originalResizeObserver = globalThis.ResizeObserver

describe("ChatRow render isolation", () => {
	beforeEach(() => {
		resizeObserverHarness.callback = () => {}
		resizeObserverHarness.disconnect.mockClear()
		resizeObserverHarness.observe.mockClear()
		globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
	})

	afterAll(() => {
		globalThis.ResizeObserver = originalResizeObserver
	})

	it("renders a virtualized row from its stable environment without reading root transcript state", () => {
		const message: ClineMessage = {
			ts: 1,
			type: "say",
			say: "text",
			text: "completed response",
			partial: false,
		}
		const environment: ChatRowEnvironment = {
			mcpServers: [],
			alwaysAllowMcp: false,
			mode: "code",
			reasoningBlockCollapsed: true,
			modelSupportsImages: true,
			getClineMessages: () => [message],
		}

		render(
			<ChatRow
				message={message}
				environment={environment}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={() => {}}
				onHeightChange={() => {}}
			/>,
		)

		expect(screen.getByText("completed response")).toBeInTheDocument()
		expect(mockUseExtensionState).not.toHaveBeenCalled()
		expect(resizeObserverHarness.observe).not.toHaveBeenCalled()
	})

	it("observes only the final row and reports actual growth after the initial measurement", () => {
		const onHeightChange = vi.fn()
		const message: ClineMessage = {
			ts: 2,
			type: "say",
			say: "text",
			text: "streaming response",
			partial: true,
		}
		const environment: ChatRowEnvironment = {
			mcpServers: [],
			alwaysAllowMcp: false,
			mode: "code",
			reasoningBlockCollapsed: true,
			modelSupportsImages: true,
			getClineMessages: () => [message],
		}

		render(
			<ChatRow
				message={message}
				environment={environment}
				isExpanded={false}
				isLast={true}
				isStreaming={true}
				onToggleExpand={() => {}}
				onHeightChange={onHeightChange}
			/>,
		)

		expect(resizeObserverHarness.observe).toHaveBeenCalledTimes(1)
		act(() => {
			resizeObserverHarness.callback(
				[{ contentRect: { height: 100 } } as ResizeObserverEntry],
				{} as ResizeObserver,
			)
			resizeObserverHarness.callback(
				[{ contentRect: { height: 140 } } as ResizeObserverEntry],
				{} as ResizeObserver,
			)
		})

		expect(onHeightChange).toHaveBeenCalledTimes(1)
		expect(onHeightChange).toHaveBeenCalledWith(true)
	})
})
