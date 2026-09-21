import React from "react"
import { render, screen } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatRowContent } from "../ChatRow"
import type { AlphaMessage } from "@alpha-code/types"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { exists: () => true },
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpServers: [],
		alwaysAllowMcp: false,
		currentCheckpoint: null,
		mode: "code",
		apiConfiguration: {},
		clineMessages: [],
		currentTaskItem: undefined,
	}),
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: { supportsImages: true } }),
}))

const queryClient = new QueryClient()

function renderAsk(tool: string) {
	const message = {
		type: "ask",
		ask: "tool",
		ts: Date.now(),
		text: JSON.stringify({ tool }),
	} as AlphaMessage
	return render(
		<QueryClientProvider client={queryClient}>
			<ChatRowContent
				message={message}
				isExpanded={false}
				isLast
				isStreaming={false}
				onToggleExpand={() => {}}
				onSuggestionClick={() => {}}
				onBatchFileResponse={() => {}}
				onFollowUpUnmount={() => {}}
				isFollowUpAnswered={false}
			/>
		</QueryClientProvider>,
	)
}

describe("ChatRow - spawn asks", () => {
	it("does not render an empty spawn or delegate ask row", () => {
		const { container: spawn } = renderAsk("spawnAgent")
		expect(spawn.textContent).toBe("")
		expect(screen.queryByText("chat:approve.title")).not.toBeInTheDocument()

		const { container: delegate } = renderAsk("delegateTask")
		expect(delegate.textContent).toBe("")
	})
})
