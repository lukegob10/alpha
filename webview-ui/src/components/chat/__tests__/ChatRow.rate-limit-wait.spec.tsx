import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AlphaMessage } from "@alpha-code/types"

import { render, screen } from "@/utils/test-utils"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import english from "@src/i18n/locales/en/chat.json"
import { ChatRowContent } from "../ChatRow"

const i18n = createInstance()
const queryClient = new QueryClient()

beforeAll(async () => {
	await i18n.init({ lng: "en", resources: { en: { chat: english } }, interpolation: { escapeValue: false } })
})

function renderWaitRow(text?: string, partial = true) {
	const message: AlphaMessage = { type: "say", say: "api_req_rate_limit_wait", ts: 1, partial, text }
	return render(
		<I18nextProvider i18n={i18n}>
			<ExtensionStateContextProvider>
				<QueryClientProvider client={queryClient}>
					<ChatRowContent
						message={message}
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
			</ExtensionStateContextProvider>
		</I18nextProvider>,
	)
}

describe("ChatRow wait status", () => {
	it("shows the provider pacing countdown", () => {
		renderWaitRow(JSON.stringify({ seconds: 1, reason: "command_running" }))

		expect(screen.getByText("Configured request pacing")).toBeVisible()
		expect(screen.getByText("1s")).toBeVisible()
		expect(screen.queryByText("Details")).not.toBeInTheDocument()
	})

	it.each([{ kind: "completion", reason: "command_running" }, { seconds: 1 }, undefined])(
		"hides a cleared wait row with payload %j",
		(payload) => {
			const { container } = renderWaitRow(JSON.stringify(payload), false)

			expect(container.firstChild).toBeNull()
		},
	)

	it.each([
		["command_running", "Waiting for command to finish"],
		["evidence_pending", "Waiting for verification results"],
		["receipt_pending", "Waiting for changes to be recorded"],
		["descendants_running", "Waiting for subagents to finish"],
	])("shows a progress row for %s", (reason, label) => {
		renderWaitRow(JSON.stringify({ kind: "completion", reason, seconds: 1 }))

		expect(screen.getByText(label)).toBeVisible()
		expect(screen.queryByText("Details")).not.toBeInTheDocument()
		expect(screen.queryByText("1s")).not.toBeInTheDocument()
	})

	it.each([undefined, "future_reason", 42])("shows the generic completion wait for reason %j", (reason) => {
		renderWaitRow(JSON.stringify({ kind: "completion", reason }))

		expect(screen.getByText("Waiting before the task can finish")).toBeVisible()
	})

	it.each([undefined, "{", "null", '"completion"'])("ignores an invalid wait payload %s", (text) => {
		const { container } = renderWaitRow(text)

		expect(container.firstChild).toBeNull()
	})
})
