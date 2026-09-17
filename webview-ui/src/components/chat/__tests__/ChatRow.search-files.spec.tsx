import { useState } from "react"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"
import type { ClineMessage } from "@alpha-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import english from "@src/i18n/locales/en/chat.json"
import { ChatRowContent } from "../ChatRow"

const i18n = createInstance()
beforeAll(async () => {
	await i18n.init({ lng: "en", resources: { en: { chat: english } }, interpolation: { escapeValue: false } })
})

function Row({ message }: { message: ClineMessage }) {
	const [expanded, setExpanded] = useState(false)
	return (
		<I18nextProvider i18n={i18n}>
			<ExtensionStateContextProvider>
				<ChatRowContent
					message={message}
					isExpanded={expanded}
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => setExpanded((value) => !value)}
				/>
			</ExtensionStateContextProvider>
		</I18nextProvider>
	)
}

describe("search activity labels", () => {
	it.each([
		{ type: "ask", outside: false, label: "Alpha wants to search a directory" },
		{ type: "say", outside: false, label: "Alpha searched a directory" },
		{ type: "ask", outside: true, label: "Alpha wants to search a directory (outside workspace)" },
		{ type: "say", outside: true, label: "Alpha searched a directory (outside workspace)" },
	] as const)(
		"keeps $type search details behind the generic label (outside: $outside)",
		({ type, outside, label }) => {
			render(
				<Row
					message={{
						ts: 1,
						type,
						...(type === "ask" ? { ask: "tool" } : { say: "tool" }),
						reasoningSummary: "This synopsis belongs only on a Thinking row.",
						text: JSON.stringify({
							tool: "searchFiles",
							path: "frontend/src",
							regex: "XYZ|submit",
							filePattern: "*.tsx",
							content: "matching search result",
							isOutsideWorkspace: outside,
						}),
					}}
				/>,
			)
			const toggle = screen.getByRole("button", { name: label, expanded: false })
			expect(toggle).not.toHaveTextContent("XYZ")
			expect(screen.queryByText(/This synopsis/)).not.toBeInTheDocument()
			expect(screen.getByText("XYZ|submit")).not.toBeVisible()
			fireEvent.click(toggle)
			expect(toggle).toHaveAttribute("aria-expanded", "true")
			expect(screen.getByText("XYZ|submit")).toBeVisible()
			expect(screen.getByText(/frontend\/src\/\(\*\.tsx\)/)).toBeVisible()
			expect(screen.getByText("matching search result")).toBeVisible()
			fireEvent.click(toggle)
			expect(screen.getByText("XYZ|submit")).not.toBeVisible()
			expect(screen.queryByText("matching search result")).not.toBeInTheDocument()
		},
	)

	it("keeps descriptive summaries attached to Thinking rows", () => {
		render(
			<Row
				message={{
					ts: 1,
					type: "say",
					say: "reasoning",
					reasoningSummary: "Checking submission handlers to locate the validation gap.",
					text: "The complete original reasoning remains available when this row is opened.",
				}}
			/>,
		)
		const toggle = screen.getByRole("button", { name: /Thinking.*Checking submission handlers/ })
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(toggle)
		expect(screen.getByText(/The complete original reasoning/)).toBeVisible()
	})
})
