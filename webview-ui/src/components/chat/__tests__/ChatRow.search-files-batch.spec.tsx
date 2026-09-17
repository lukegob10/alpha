import React, { useState } from "react"

import { fireEvent, render, screen, within } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"
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

const SearchRow = ({ type }: { type: "ask" | "say" }) => {
	const [expanded, setExpanded] = useState(false)
	return (
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
									path: "frontend/src",
									filePattern: "*.tsx",
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
					isExpanded={expanded}
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => setExpanded((value) => !value)}
					onSuggestionClick={() => undefined}
					onBatchFileResponse={() => undefined}
					onFollowUpUnmount={() => undefined}
					isFollowUpAnswered={false}
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>
	)
}

describe("ChatRow - search_files batch", () => {
	it.each(["ask", "say"] as const)("drills into a %s batch one search at a time", (type) => {
		render(<SearchRow type={type} />)
		const toggle = screen.getByRole("button", { name: /Alpha (wants to run|ran) 2 file searches/ })
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByText("fetch|submit")).not.toBeInTheDocument()
		expect(screen.queryByText("frontend result")).not.toBeInTheDocument()
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		const list = screen.getByRole("list", { name: /2 file searches/ })
		expect(within(list).getAllByRole("listitem")).toHaveLength(2)
		const frontend = within(list).getByRole("button", { name: "frontend/src/(*.tsx)", expanded: false })
		const backend = within(list).getByRole("button", { name: "backend/app/(*.py)", expanded: false })
		expect(screen.queryByText("fetch|submit")).not.toBeInTheDocument()
		expect(screen.queryByText("frontend result")).not.toBeInTheDocument()

		fireEvent.click(frontend)
		expect(screen.getByText("fetch|submit")).toBeVisible()
		expect(screen.getByText("fetch|submit")).toHaveStyle({ color: "var(--vscode-foreground)" })
		expect(screen.getByText("frontend result")).toBeVisible()
		expect(screen.queryByText("backend result")).not.toBeInTheDocument()
		expect(toggle).toHaveAttribute("aria-expanded", "true")

		fireEvent.click(backend)
		expect(screen.getByText("backend result")).toBeVisible()
		fireEvent.click(frontend)
		expect(screen.queryByText("frontend result")).not.toBeInTheDocument()
		expect(screen.getByText("backend result")).toBeVisible()
		fireEvent.click(toggle)
		expect(list).not.toBeVisible()
		fireEvent.click(toggle)
		expect(backend).toHaveAttribute("aria-expanded", "true")
		expect(frontend).toHaveAttribute("aria-expanded", "false")
	})

	it("supports keyboard drill-down without closing the batch", async () => {
		// The shared FAST setup stubs focus. Use an untouched DOM focus implementation for this interaction.
		const frame = document.createElement("iframe")
		document.body.append(frame)
		const originalFocus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!
		Object.defineProperty(HTMLElement.prototype, "focus", {
			configurable: true,
			value: frame.contentDocument!.createElement("button").focus,
		})
		try {
			const user = userEvent.setup()
			render(<SearchRow type="say" />)
			const toggle = screen.getByRole("button", { name: /Alpha ran 2 file searches/ })
			toggle.focus()
			await user.keyboard("{Enter}{Tab}")
			const frontend = screen.getByRole("button", { name: "frontend/src/(*.tsx)" })
			expect(frontend).toHaveFocus()
			await user.keyboard(" ")
			expect(frontend).toHaveAttribute("aria-expanded", "true")
			expect(document.getElementById(frontend.getAttribute("aria-controls")!)).toBeVisible()
			expect(toggle).toHaveAttribute("aria-expanded", "true")
		} finally {
			Object.defineProperty(HTMLElement.prototype, "focus", originalFocus)
			frame.remove()
		}
	})
})
