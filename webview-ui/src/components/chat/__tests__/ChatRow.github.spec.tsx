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

function renderApproval(payload: Record<string, unknown>) {
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={new QueryClient()}>
				<ChatRowContent
					message={{
						type: "ask",
						ask: "tool",
						ts: 1,
						text: JSON.stringify({ tool: "githubApi", ...payload }),
					}}
					isExpanded={false}
					isLast
					isStreaming={false}
					onToggleExpand={() => {}}
					onSuggestionClick={() => {}}
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("GitHub approval review", () => {
	it("shows the full proposed body and destination even when the row is collapsed", () => {
		const body = "First line\n<script>alert('untrusted')</script>\nLast line"
		renderApproval({ github: { action: "comment", owner: "owner", repo: "repo", issue_number: 3, body } })
		expect(screen.getByText("owner/repo")).toBeVisible()
		expect(screen.getByText(body, { exact: true, normalizer: (text) => text })).toBeVisible()
		expect(document.querySelector("script")).toBeNull()
	})

	it("keeps historical flat GitHub approval messages readable", () => {
		renderApproval({
			action: "create_pull_request",
			owner: "owner",
			repo: "repo",
			title: "Old PR",
			head: "feature",
			base: "main",
		})
		expect(screen.getByText("Old PR")).toBeVisible()
		expect(screen.getByText(/feature/)).toBeVisible()
	})

	it("reads historical merge approvals with explicit null optional fields", () => {
		renderApproval({
			action: "merge_pull_request",
			owner: "owner",
			repo: "repo",
			pull_number: 4,
			title: null,
			merge_method: null,
		})
		expect(screen.getByText("owner/repo")).toBeVisible()
		expect(screen.getByText(/pull_number/)).toBeVisible()
	})
})
