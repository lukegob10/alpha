// npx vitest run src/components/chat/__tests__/ChatView.keyboard-fix.spec.tsx

import React from "react"
import { render, screen } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView, { ChatViewProps } from "../ChatView"

// Mock vscode API
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock use-sound hook
vi.mock("use-sound", () => ({
	default: vi.fn().mockImplementation(() => {
		return [vi.fn()]
	}),
}))

// Mock components
vi.mock("../ChatRow", () => ({
	default: () => null,
}))

vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

vi.mock("../../common/VersionIndicator", () => ({
	default: () => null,
}))

vi.mock("@src/components/modals/Announcement", () => ({
	default: () => null,
}))

vi.mock("@src/components/welcome/RooCloudCTA", () => ({
	default: () => null,
}))

vi.mock("@src/components/welcome/AlphaTips", () => ({
	default: () => null,
}))

vi.mock("@src/components/welcome/AlphaHero", () => ({
	default: () => null,
}))

vi.mock("../common/TelemetryBanner", () => ({
	default: () => null,
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}))

vi.mock("../ChatTextArea", () => {
	const ChatTextAreaComponent = React.forwardRef(function MockChatTextArea(
		props: any,
		ref: React.ForwardedRef<{ focus: () => void }>,
	) {
		React.useImperativeHandle(ref, () => ({
			focus: vi.fn(),
		}))
		return <div data-testid="chat-textarea" data-mode-shortcut={props.modeShortcutText} />
	})

	return {
		default: ChatTextAreaComponent,
		ChatTextArea: ChatTextAreaComponent, // Export as named export too
	}
})

// Mock VSCode components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
}))

// Mock window.postMessage to trigger state hydration
const mockPostMessage = (state: any) => {
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
				mode: "code",
				customModes: [],
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

describe("ChatView mode shortcut scoping", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("advertises Shift+Tab for mode switching", () => {
		renderChatView()

		expect(screen.getByTestId("chat-textarea")).toHaveAttribute("data-mode-shortcut", "Shift + Tab")
	})

	it.each([
		{ key: ".", ctrlKey: true },
		{ key: ".", metaKey: true },
		{ key: ".", ctrlKey: true, shiftKey: true },
		{ key: "Tab", shiftKey: true },
	])("does not install a global mode shortcut for $key", (keyboardInit) => {
		renderChatView()
		mockPostMessage({
			mode: "code",
			customModes: [],
		})
		vi.clearAllMocks()

		const event = new KeyboardEvent("keydown", {
			...keyboardInit,
			bubbles: true,
			cancelable: true,
		})
		window.dispatchEvent(event)

		expect(event.defaultPrevented).toBe(false)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mode" }))
	})
})
