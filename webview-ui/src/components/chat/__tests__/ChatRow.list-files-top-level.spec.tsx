import React from "react"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { render, screen } from "@/utils/test-utils"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"

import { ChatRowContent } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			if (key === "chat:directoryOperations.wantsToViewTopLevel") {
				return "Alpha wants to view top-level files"
			}
			if (key === "chat:directoryOperations.didViewTopLevel") {
				return "Alpha viewed top-level files"
			}
			return key
		},
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => undefined },
}))

const renderListing = (type: "ask" | "say") =>
	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={new QueryClient()}>
				<ChatRowContent
					message={{
						type,
						...(type === "ask" ? { ask: "tool" } : { say: "tool" }),
						ts: Date.now(),
						text: JSON.stringify({
							tool: "listFilesTopLevel",
							path: "src",
							content: "alpha.ts\nbeta.ts",
							isOutsideWorkspace: false,
						}),
					}}
					isExpanded={true}
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

describe("ChatRow - top-level list_files output", () => {
	it("renders a say result as a completed view with its path and content", () => {
		renderListing("say")

		expect(screen.getByText("Alpha viewed top-level files")).toBeInTheDocument()
		expect(screen.getByText(/src/)).toBeInTheDocument()
		expect(screen.getByText(/alpha\.ts/)).toBeInTheDocument()
		expect(screen.getByText(/beta\.ts/)).toBeInTheDocument()
		expect(screen.queryByText("Alpha wants to view top-level files")).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /allow|approve|deny/i })).not.toBeInTheDocument()
	})

	it("keeps ask rows in the wants-to-view state", () => {
		renderListing("ask")

		expect(screen.getByText("Alpha wants to view top-level files")).toBeInTheDocument()
		expect(screen.queryByText("Alpha viewed top-level files")).not.toBeInTheDocument()
	})
})
