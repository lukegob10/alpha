// npx vitest src/components/welcome/__tests__/WelcomeViewProvider.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import * as ExtensionStateContext from "@src/context/ExtensionStateContext"
const { ExtensionStateContextProvider } = ExtensionStateContext

import WelcomeViewProvider from "../WelcomeViewProvider"
import { vscode } from "@src/utils/vscode"

// Mock VSCode components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, onClick }: any) => (
		<button onClick={onClick} data-testid="vscode-link">
			{children}
		</button>
	),
	VSCodeProgressRing: () => <div data-testid="progress-ring">Loading...</div>,
	VSCodeTextField: ({ value, onKeyUp, placeholder }: any) => (
		<input data-testid="text-field" type="text" value={value} onChange={onKeyUp} placeholder={placeholder} />
	),
	VSCodeRadioGroup: ({ children, value, _onChange }: any) => (
		<div data-testid="radio-group" data-value={value}>
			{children}
		</div>
	),
	VSCodeRadio: ({ children, value, onClick }: any) => (
		<div data-testid={`radio-${value}`} data-value={value} onClick={onClick}>
			{children}
		</div>
	),
}))

// Mock Button component
vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, variant }: any) => (
		<button onClick={onClick} data-testid={`button-${variant}`}>
			{children}
		</button>
	),
}))

// Mock ApiOptions
vi.mock("../../settings/ApiOptions", () => ({
	default: () => <div data-testid="api-options">API Options Component</div>,
}))

// Mock Tab components
vi.mock("../../common/Tab", () => ({
	Tab: ({ children }: any) => <div data-testid="tab">{children}</div>,
	TabContent: ({ children }: any) => <div data-testid="tab-content">{children}</div>,
}))

// Mock AlphaHero
vi.mock("../AlphaHero", () => ({
	default: () => <div data-testid="alpha-hero">Alpha Hero</div>,
}))

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
	ArrowLeft: () => <span data-testid="arrow-left-icon">←</span>,
	ArrowRight: () => <span data-testid="arrow-right-icon">→</span>,
	BadgeInfo: () => <span data-testid="badge-info-icon">ℹ</span>,
	Brain: () => <span data-testid="brain-icon">🧠</span>,
	TriangleAlert: () => <span data-testid="triangle-alert-icon">⚠</span>,
}))

// Mock vscode utility
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock react-i18next
vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, children }: any) => <span data-testid={`trans-${i18nKey}`}>{children || i18nKey}</span>,
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
}))

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock buildDocLink
vi.mock("@/utils/docLinks", () => ({
	buildDocLink: (path: string, source: string) =>
		`https://github.com/AlphaInc/Alpha/tree/main/docs/${path}?utm_source=${source}`,
}))

const renderWelcomeViewProvider = (extensionState = {}) => {
	const useExtensionStateMock = vi.spyOn(ExtensionStateContext, "useExtensionState")
	useExtensionStateMock.mockReturnValue({
		apiConfiguration: {},
		currentApiConfigName: "default",
		setApiConfiguration: vi.fn(),
		uriScheme: "vscode",
		cloudIsAuthenticated: false,
		...extensionState,
	} as any)

	render(
		<ExtensionStateContextProvider>
			<WelcomeViewProvider />
		</ExtensionStateContextProvider>,
	)

	return useExtensionStateMock
}

describe("WelcomeViewProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("Landing Screen", () => {
		it("renders landing screen by default", () => {
			renderWelcomeViewProvider()

			expect(screen.getByText("Welcome to Alpha.")).toBeInTheDocument()

			expect(screen.getByTestId("trans-welcome:landing.introduction")).toBeInTheDocument()

			expect(screen.getByTestId("alpha-hero")).toBeInTheDocument()
			expect(screen.getByTestId("button-primary")).toBeInTheDocument()
			expect(screen.getByText("Set up local provider")).toBeInTheDocument()
		})

		it("navigates to provider selection when local provider setup is clicked", () => {
			renderWelcomeViewProvider()

			const getStartedButton = screen.getByTestId("button-primary")
			fireEvent.click(getStartedButton)

			expect(screen.getByTestId("radio-group")).toBeInTheDocument()
			expect(screen.getByTestId("radio-custom")).toBeInTheDocument()
			expect(screen.getByText("Set up local provider")).toBeInTheDocument()
		})
	})

	describe("Provider Selection Screen", () => {
		const navigateToProviderSelection = () => {
			fireEvent.click(screen.getByTestId("button-primary"))
		}

		it("shows the custom provider option", () => {
			renderWelcomeViewProvider()
			navigateToProviderSelection()

			expect(screen.getByTestId("radio-group")).toBeInTheDocument()
			expect(screen.getByTestId("radio-custom")).toBeInTheDocument()
			expect(screen.getByText("3rd-party Provider")).toBeInTheDocument()
			expect(screen.getByText("Enter an API key and get going.")).toBeInTheDocument()
		})

		it("custom provider is selected by default", () => {
			renderWelcomeViewProvider()
			navigateToProviderSelection()

			const radioGroup = screen.getByTestId("radio-group")
			expect(radioGroup).toHaveAttribute("data-value", "custom")
		})

		it("shows API options for custom provider", () => {
			renderWelcomeViewProvider()
			navigateToProviderSelection()

			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		it("saves custom provider config when Finish is clicked", () => {
			renderWelcomeViewProvider({ apiConfiguration: { apiProvider: "openai", openAiApiKey: "test-key" } })
			navigateToProviderSelection()

			const getStartedButton = screen.getByTestId("button-primary")
			fireEvent.click(getStartedButton)

			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "upsertApiConfiguration",
				text: "default",
				apiConfiguration: { apiProvider: "openai", openAiApiKey: "test-key" },
			})
		})

		// Note: We can't easily test radio selection changes in the mocked environment
		// since the VSCodeRadioGroup component's onChange is complex
		// These tests would work in a real browser environment
		it.skip("shows API options when custom provider is selected", () => {
			renderWelcomeViewProvider()
			navigateToProviderSelection()

			// Would simulate selecting custom provider in real environment
			// API options visibility is controlled by CSS transition based on selectedProvider state
		})

		it.skip("validates and saves configuration when Get Started is clicked on custom provider", () => {
			// This test would require properly simulating the radio group onChange
			// which is complex in the mocked environment
		})
	})
})
