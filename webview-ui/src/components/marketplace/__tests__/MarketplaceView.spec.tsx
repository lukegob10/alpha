import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

import { MarketplaceView } from "../MarketplaceView"
import { MarketplaceViewStateManager } from "../MarketplaceViewStateManager"
import { DEFAULT_CHECKPOINT_TIMEOUT_SECONDS, type MarketplaceItem } from "@alpha-code/types"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("MarketplaceView", () => {
	let stateManager: MarketplaceViewStateManager
	let mockExtensionState: any

	beforeEach(() => {
		vi.clearAllMocks()
		stateManager = new MarketplaceViewStateManager()

		mockExtensionState = {
			organizationSettingsVersion: 1,
			// Add other required properties for the context
			didHydrateState: true,
			showWelcome: false,
			theme: {},
			mcpServers: [],
			filePaths: [],
			openedTabs: [],
			commands: [],
			organizationAllowList: { allowAll: true, providers: {} },
			hasOpenedModeSelector: false,
			setHasOpenedModeSelector: vi.fn(),
			alwaysAllowFollowupQuestions: false,
			setAlwaysAllowFollowupQuestions: vi.fn(),
			followupAutoApproveTimeoutMs: 60000,
			setFollowupAutoApproveTimeoutMs: vi.fn(),
			profileThresholds: {},
			setProfileThresholds: vi.fn(),
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			// ... other required context properties
		}
	})

	it("owns one subscription and ingests each window message once across remounts", () => {
		const handleMessage = vi.spyOn(stateManager, "handleMessage")
		const subscribe = vi.spyOn(stateManager, "onStateChange")
		const cleanup = vi.spyOn(stateManager, "cleanup")
		const view = (
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>
		)
		const firstMount = render(view)
		expect(subscribe).toHaveBeenCalledTimes(1)

		act(() => {
			for (let version = 0; version < 100; version++) {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "state", state: { organizationSettingsVersion: version } },
					}),
				)
			}
		})
		expect(handleMessage).toHaveBeenCalledTimes(100)

		firstMount.unmount()
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: {} } }))
		expect(handleMessage).toHaveBeenCalledTimes(100)
		expect(cleanup).not.toHaveBeenCalled()

		render(view)
		expect(subscribe).toHaveBeenCalledTimes(2)
		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: {} } }))
		})
		expect(handleMessage).toHaveBeenCalledTimes(101)
	})

	it("projects incoming catalogs and preserves installed metadata and filters on reentry", () => {
		const items: MarketplaceItem[] = [
			{
				id: "test-mcp",
				name: "Test MCP",
				description: "The installed MCP server matching the search filter",
				type: "mcp",
				content: "Test content",
				url: "https://example.com/test",
				tags: ["test"],
			},
			{
				id: "other-mcp",
				name: "Other MCP",
				description: "An uninstalled MCP server excluded by the search filter",
				type: "mcp",
				content: "Other content",
				url: "https://example.com/other",
			},
		]
		const installedMetadata = { project: {}, global: { "test-mcp": { type: "mcp" } } }
		mockExtensionState.marketplaceInstalledMetadata = installedMetadata
		const view = (
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>
		)
		const firstMount = render(view)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "marketplaceData",
						marketplaceItems: items,
						marketplaceInstalledMetadata: installedMetadata,
					},
				}),
			)
		})
		expect(screen.getByText("Test MCP")).toBeInTheDocument()
		expect(screen.getByText("Other MCP")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "marketplace:items.card.remove" })).toBeInTheDocument()

		fireEvent.change(screen.getByPlaceholderText("marketplace:filters.search.placeholderMcp"), {
			target: { value: "Test" },
		})
		expect(screen.queryByText("Other MCP")).not.toBeInTheDocument()
		expect(stateManager.getState().filters.search).toBe("Test")
		expect(stateManager.getState().installedMetadata).toEqual(installedMetadata)

		firstMount.unmount()
		vi.mocked(vscode.postMessage).mockClear()
		render(view)
		expect(screen.getByPlaceholderText("marketplace:filters.search.placeholderMcp")).toHaveValue("Test")
		expect(screen.getByText("Test MCP")).toBeInTheDocument()
		expect(screen.queryByText("Other MCP")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "fetchMarketplaceData" })
	})

	it("settles an empty catalog without refetching on unrelated state updates", () => {
		render(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "marketplaceData", marketplaceItems: [] } }),
			)
			window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: {} } }))
		})
		expect(screen.getByText("marketplace:items.empty.noItems")).toBeInTheDocument()
		expect(screen.queryByText("marketplace:items.refresh.refreshing")).not.toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "fetchMarketplaceData" })
	})

	it("should trigger fetchMarketplaceData on initial mount when no marketplace data is loaded", async () => {
		render(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "fetchMarketplaceData",
			})
		})
	})

	it("projects legacy mode targets and state onto the MCP-only marketplace", async () => {
		stateManager.transition({ type: "SET_ACTIVE_TAB", payload: { tab: "mode" } })

		render(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} targetTab="mode" />
			</ExtensionStateContext.Provider>,
		)

		expect(screen.queryByRole("button", { name: "Modes" })).not.toBeInTheDocument()
		expect(screen.getByPlaceholderText("marketplace:filters.search.placeholderMcp")).toBeInTheDocument()
		await waitFor(() => expect(stateManager.getState().activeTab).toBe("mcp"))
	})

	it("should not trigger fetchMarketplaceData when marketplace data is already loaded", async () => {
		stateManager.transition({
			type: "FETCH_COMPLETE",
			payload: {
				items: [
					{
						id: "test-mcp",
						name: "Test MCP",
						type: "mcp" as const,
						description: "Test MCP server",
						tags: ["test"],
						content: "Test content",
						url: "https://test.com",
						author: "Test Author",
					},
				],
			},
		})

		const { rerender } = render(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		expect(vscode.postMessage).not.toHaveBeenCalledWith({
			type: "fetchMarketplaceData",
		})

		mockExtensionState = {
			...mockExtensionState,
			organizationSettingsVersion: 2,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		}

		// Re-render with updated context
		rerender(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		expect(vscode.postMessage).not.toHaveBeenCalledWith({
			type: "fetchMarketplaceData",
		})
	})

	it("should trigger fetchMarketplaceData when mounted with no data and organization version starts at -1", async () => {
		mockExtensionState = {
			...mockExtensionState,
			organizationSettingsVersion: -1,
		}

		render(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "fetchMarketplaceData",
			})
		})
	})

	it("should not trigger fetchMarketplaceData when organization settings version remains the same", async () => {
		stateManager.transition({
			type: "FETCH_COMPLETE",
			payload: {
				items: [
					{
						id: "test-mcp",
						name: "Test MCP",
						type: "mcp" as const,
						description: "Test MCP server",
						tags: ["test"],
						content: "Test content",
						url: "https://test.com",
						author: "Test Author",
					},
				],
			},
		})

		const { rerender } = render(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		// Re-render with same version
		rerender(
			<ExtensionStateContext.Provider value={mockExtensionState}>
				<MarketplaceView stateManager={stateManager} />
			</ExtensionStateContext.Provider>,
		)

		// Should not trigger fetch when version hasn't changed
		await waitFor(() => {
			expect(vscode.postMessage).not.toHaveBeenCalledWith({
				type: "fetchMarketplaceData",
			})
		})
	})
})
