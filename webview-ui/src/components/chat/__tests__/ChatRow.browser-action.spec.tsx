import React from "react"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { render, screen } from "@/utils/test-utils"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import "@src/i18n/setup"

import { ChatRowContent } from "../ChatRow"

function renderBrowserRow(payload: Record<string, unknown>, partial = false, approval?: "pending" | "answered") {
	const queryClient = new QueryClient()
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatRowContent
					message={{
						...(approval
							? { type: "ask", ask: "tool", isAnswered: approval === "answered" }
							: { type: "say", say: "tool" }),
						ts: Date.now(),
						partial,
						text: JSON.stringify({ tool: "browserAction", ...payload }),
					}}
					isExpanded={false}
					isLast={approval !== undefined}
					isStreaming={false}
					messageActionsDisabled={approval !== undefined}
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
	it.each(["pending", "answered"] as const)("does not show an execution spinner for a %s approval", (approval) => {
		renderBrowserRow({ action: "list_browser_pages", status: "running" }, false, approval)

		expect(screen.getByText("List browser pages")).toBeInTheDocument()
		expect(
			screen.getByText(approval === "pending" ? "Awaiting browser approval" : "Browser approval request"),
		).toBeInTheDocument()
		expect(screen.queryByLabelText("Browser action in progress")).not.toBeInTheDocument()
	})

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
