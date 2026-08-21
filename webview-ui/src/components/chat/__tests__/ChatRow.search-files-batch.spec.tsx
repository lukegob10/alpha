import React from "react"

import { render, screen } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { ChatRowContent } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: { count?: number }) => {
			if (key === "chat:directoryOperations.wantsToSearchMultiple") {
				return `Alpha wants to run ${values?.count} file searches`
			}
			if (key === "chat:directoryOperations.didSearchMultiple") {
				return `Alpha ran ${values?.count} file searches`
			}
			return key
		},
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => undefined },
}))

const queryClient = new QueryClient()

const renderMessage = (type: "ask" | "say") =>
	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatRowContent
					message={{
						type,
						...(type === "ask" ? { ask: "tool" } : { say: "tool" }),
						ts: Date.now(),
						text: JSON.stringify({
							tool: "searchFiles",
							batchSearches: [
								{
									path: "frontend/src/(*.tsx)",
									regex: "fetch|submit",
									content: "frontend result",
								},
								{
									path: "backend/app/(*.py)",
									regex: "@router|def ",
									content: "backend result",
								},
							],
						}),
					}}
					isExpanded={false}
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => undefined}
					onSuggestionClick={() => undefined}
					onBatchFileResponse={() => undefined}
					onFollowUpUnmount={() => undefined}
					isFollowUpAnswered={false}
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

describe("ChatRow - search_files batch", () => {
	it("renders every query in a grouped approval row", () => {
		renderMessage("ask")

		expect(screen.getByText("Alpha wants to run 2 file searches")).toBeInTheDocument()
		expect(screen.getByText("fetch|submit")).toBeInTheDocument()
		expect(screen.getByText("@router|def")).toBeInTheDocument()
	})
})
