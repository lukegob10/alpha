import { useState, useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { Tab, TabContent, TabHeader } from "../common/Tab"
import { MarketplaceViewStateManager } from "./MarketplaceViewStateManager"
import { useStateManager } from "./useStateManager"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { MarketplaceListView } from "./MarketplaceListView"
import { TooltipProvider } from "@/components/ui/tooltip"

interface MarketplaceViewProps {
	onDone?: () => void
	stateManager: MarketplaceViewStateManager
	targetTab?: "mcp" | "mode"
}
export function MarketplaceView({ stateManager, onDone }: MarketplaceViewProps) {
	const { t } = useAppTranslation()
	const [state, manager] = useStateManager(stateManager)
	const [hasReceivedInitialState, setHasReceivedInitialState] = useState(false)

	// Track when we receive the initial state
	useEffect(() => {
		// Check if we already have items (state might have been received before mount)
		if (state.allItems.length > 0 && !hasReceivedInitialState) {
			setHasReceivedInitialState(true)
		}
	}, [state.allItems, hasReceivedInitialState])

	// Legacy callers and persisted view state may still request the hidden mode
	// catalog. Keep that state compatible, but project this ordinary surface to MCP.
	useEffect(() => {
		if (state.activeTab === "mode") {
			manager.transition({ type: "SET_ACTIVE_TAB", payload: { tab: "mcp" } })
		}
	}, [state.activeTab, manager])

	// Ensure marketplace state manager processes messages when component mounts
	useEffect(() => {
		// When the marketplace view first mounts, we need to trigger a state update
		// to ensure we get the current marketplace items. We do this by sending
		// a filter message with empty filters, which will cause the extension to
		// send back the full state including all marketplace items.
		if (!hasReceivedInitialState && state.allItems.length === 0) {
			// Fetch marketplace data on demand
			// Note: isFetching is already true by default for initial load
			vscode.postMessage({
				type: "fetchMarketplaceData",
			})
		}

		// Listen for state changes to know when initial data arrives
		const unsubscribe = manager.onStateChange((newState) => {
			// Mark as received initial state when we get any state update
			// This prevents infinite loops and ensures proper state handling
			if (!hasReceivedInitialState && (newState.allItems.length > 0 || newState.displayItems !== undefined)) {
				setHasReceivedInitialState(true)
			}
		})

		const handleVisibilityMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "webviewVisible" && message.visible === true) {
				// Data will be automatically fresh when panel becomes visible
				// No manual fetching needed since we removed caching
			}
		}

		window.addEventListener("message", handleVisibilityMessage)
		return () => {
			window.removeEventListener("message", handleVisibilityMessage)
			unsubscribe()
		}
	}, [manager, hasReceivedInitialState, state.allItems.length])

	// Memoize all available tags
	const allTags = useMemo(
		() => Array.from(new Set(state.allItems.flatMap((item) => item.tags || []))).sort(),
		[state.allItems],
	)

	// Memoize filtered tags
	const filteredTags = useMemo(() => allTags, [allTags])

	return (
		<TooltipProvider delayDuration={300}>
			<Tab>
				<TabHeader className="flex flex-col sticky top-0 z-10 px-3 py-2">
					<div className="flex items-center justify-between gap-2 px-2">
						<div className="flex items-center gap-2">
							<Button
								variant="ghost"
								className="px-1.5 -ml-2"
								onClick={() => onDone?.()}
								aria-label={t("settings:back")}>
								<ArrowLeft />
								<span className="sr-only">{t("settings:back")}</span>
							</Button>
							<h3 className="font-bold m-0">{t("marketplace:title")}</h3>
						</div>
					</div>
				</TabHeader>

				<TabContent className="p-3 pt-2">
					<MarketplaceListView
						stateManager={stateManager}
						allTags={allTags}
						filteredTags={filteredTags}
						filterByType="mcp"
					/>
				</TabContent>
			</Tab>
		</TooltipProvider>
	)
}
