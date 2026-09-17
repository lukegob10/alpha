import React from "react"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { render, screen } from "@/utils/test-utils"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"

import { ChatRowContent } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

function renderBrowserRow(payload: Record<string, unknown>, partial = false) {
	const queryClient = new QueryClient()
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatRowContent
					message={{
						type: "say",
						say: "tool",
						ts: Date.now(),
						partial,
						text: JSON.stringify({ tool: "browserAction", ...payload }),
					}}
					isExpanded={false}
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => {}}
					onSuggestionClick={() => {}}
					onBatchFileResponse={() => {}}
					onFollowUpUnmount={() => {}}
					isFollowUpAnswered={false}
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("ChatRow - VS Code browser action status", () => {
	it("renders a running browser action with its URL", () => {
		renderBrowserRow({ action: "open_browser_page", status: "running", url: "http://localhost:3000" }, true)

		expect(screen.getByText("Open browser page")).toBeInTheDocument()
		expect(screen.getByText("· http://localhost:3000")).toBeInTheDocument()
		expect(screen.getByLabelText("Browser action in progress")).toBeInTheDocument()
	})

	it("renders browser action failures instead of leaving a blank row", () => {
		renderBrowserRow({ action: "click_element", status: "error", element: "Submit button" })

		expect(screen.getByText("Click browser element failed")).toBeInTheDocument()
		expect(screen.getByText("· Submit button")).toBeInTheDocument()
		expect(screen.getByLabelText("Browser action failed")).toBeInTheDocument()
	})
})
