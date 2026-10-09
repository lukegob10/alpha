import { useState } from "react"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"
import type { AlphaMessage } from "@alpha-code/types"
import { fireEvent, render, screen } from "@src/utils/test-utils"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import english from "@src/i18n/locales/en/chat.json"
import { ChatRowContent } from "../ChatRow"

const i18n = createInstance()
beforeAll(async () => {
	await i18n.init({ lng: "en", resources: { en: { chat: english } }, interpolation: { escapeValue: false } })
})

function Row({ text }: { text: string }) {
	const [expanded, setExpanded] = useState(false)
	const message: AlphaMessage = { ts: 1, type: "say", say: "codebase_search_result", text }
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

it("renders legacy search evidence without new diagnostic fields", () => {
	render(
		<Row
			text={JSON.stringify({
				content: {
					query: "ready",
					results: [
						{ filePath: "state.ts", startLine: 1, endLine: 1, score: 0.8, codeChunk: "return ready" },
					],
				},
			})}
		/>,
	)
	fireEvent.click(screen.getByRole("button", { name: "Found 1 result" }))
	expect(screen.getByText("state.ts")).toBeVisible()
})

it.each(["{", "null", JSON.stringify({ content: { query: "ready", results: {} } })])(
	"ignores malformed search messages without crashing (%s)",
	(text) => {
		render(<Row text={text} />)
		expect(screen.getByText("Found 0 results")).toBeVisible()
	},
)
