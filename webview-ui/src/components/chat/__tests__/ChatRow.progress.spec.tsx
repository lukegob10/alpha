import type { AlphaMessage } from "@alpha-code/types"
import { render, screen } from "@/utils/test-utils"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { ChatRowContent } from "../ChatRow"

function row(message: AlphaMessage, lastModifiedMessage?: AlphaMessage) {
	return (
		<ExtensionStateContextProvider>
			<ChatRowContent
				message={message}
				lastModifiedMessage={lastModifiedMessage}
				isExpanded={false}
				isLast
				isStreaming
				onToggleExpand={() => {}}
			/>
		</ExtensionStateContextProvider>
	)
}

describe("chat progress indicators", () => {
	it.each([
		{ cost: 0 },
		{ cancelReason: "user_cancelled", cost: 0 },
		{ cancelReason: "streaming_failed", streamingFailedMessage: "Connection closed" },
	])("removes request progress for a terminal receipt %j and restores it on retry", (receipt) => {
		const request: AlphaMessage = { ts: 1, type: "say", say: "api_req_started", text: "{}" }
		const { rerender } = render(row(request))
		const indicator = screen.getByTestId("progress-indicator")
		expect(indicator).toBeVisible()
		expect(indicator).toHaveAttribute("aria-hidden", "true")
		expect(indicator).toHaveAttribute("focusable", "false")

		rerender(row({ ...request, text: JSON.stringify({ tokensIn: 10 }) }))
		expect(screen.getByTestId("progress-indicator")).toBe(indicator)

		rerender(row({ ...request, text: JSON.stringify(receipt) }))
		expect(screen.queryByTestId("progress-indicator")).not.toBeInTheDocument()

		rerender(row(request))
		expect(screen.getByTestId("progress-indicator")).toBeVisible()
	})

	it("removes progress while a failed request awaits a retry", () => {
		const request: AlphaMessage = { ts: 1, type: "say", say: "api_req_started", text: "{}" }
		const { rerender } = render(row(request))
		expect(screen.getByTestId("progress-indicator")).toBeVisible()

		rerender(row(request, { ts: 2, type: "ask", ask: "api_req_failed", text: "Offline" }))
		expect(screen.queryByTestId("progress-indicator")).not.toBeInTheDocument()
	})

	it.each(["condense_context", "sliding_window_truncation"] as const)(
		"removes %s progress when the operation finishes",
		(say) => {
			const message: AlphaMessage = { ts: 1, type: "say", say, partial: true }
			const { rerender } = render(row(message))
			expect(screen.getByTestId("progress-indicator")).toBeVisible()

			rerender(row({ ...message, partial: false }))
			expect(screen.queryByTestId("progress-indicator")).not.toBeInTheDocument()
		},
	)
})
