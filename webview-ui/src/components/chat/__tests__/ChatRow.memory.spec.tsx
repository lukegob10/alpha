import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AlphaMessage } from "@alpha-code/types"

import { render, screen } from "@/utils/test-utils"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { ChatRowContent } from "../ChatRow"

describe("memory note approval", () => {
	it("shows the exact request and host directory as inert text before approval", () => {
		const content = "Remember <script>alert(1)</script> as literal text."
		const notePath = "/alpha/memories_v2/extensions/ad_hoc/notes"
		const message: AlphaMessage = {
			type: "ask",
			ask: "tool",
			ts: 1,
			text: JSON.stringify({ tool: "memory", content, path: notePath }),
		}
		const { container } = render(
			<ExtensionStateContextProvider>
				<QueryClientProvider client={new QueryClient()}>
					<ChatRowContent
						message={message}
						isExpanded={false}
						isLast={false}
						isStreaming={false}
						onToggleExpand={() => {}}
					/>
				</QueryClientProvider>
			</ExtensionStateContextProvider>,
		)
		expect(screen.getByRole("group", { name: "Memory note approval" })).toBeInTheDocument()
		expect(screen.getByText("Save this request as an Alpha memory note")).toBeInTheDocument()
		expect(screen.getByText(content)).toBeInTheDocument()
		expect(screen.getByText(notePath)).toBeInTheDocument()
		expect(container.querySelector("script")).toBeNull()
	})
})
