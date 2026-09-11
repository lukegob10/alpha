import type { ReactNode } from "react"
import { render, screen } from "@/utils/test-utils"
import type { ClineMessage } from "@alpha-code/types"

import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

const mockUseExtensionState = vi.fn(() => {
	throw new Error("virtualized rows must not subscribe to root extension state")
})

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { exists: () => true },
	}),
	Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

describe("ChatRow render isolation", () => {
	it.each(["interrupted", "blocked", "failed", undefined] as const)(
		"does not label a completion report as task success when the task status is %s",
		(status) => {
			const message: ClineMessage = {
				ts: 2,
				type: "say",
				say: "completion_result",
				text: "The task record ended as interrupted.",
				partial: false,
			}
			const environment: ChatRowEnvironment = {
				mcpServers: [],
				alwaysAllowMcp: false,
				mode: "code",
				reasoningBlockCollapsed: true,
				currentTaskId: "original-task",
				currentTaskItem: {
					id: "original-task",
					number: 1,
					ts: 1,
					task: "Build HTML",
					status,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
				getClineMessages: () => [message],
			}
			const row = (nextEnvironment: ChatRowEnvironment) => (
				<ChatRow
					message={message}
					environment={nextEnvironment}
					isExpanded={false}
					isLast={true}
					isStreaming={false}
					onToggleExpand={() => {}}
				/>
			)
			const { rerender } = render(row(environment))
			expect(screen.queryByRole("article", { name: "chat:taskCompleted" })).not.toBeInTheDocument()
			expect(screen.getByRole("article", { name: "chat:completionReport" })).toBeInTheDocument()
			expect(screen.getByText(message.text!)).toBeInTheDocument()
			const completed = { ...environment.currentTaskItem!, status: "completed" as const }
			rerender(row({ ...environment, currentTaskItem: completed }))
			expect(screen.getByRole("article", { name: "chat:taskCompleted" })).toBeInTheDocument()
			expect(screen.queryByRole("article", { name: "chat:completionReport" })).not.toBeInTheDocument()
			// A stale snapshot for a different task cannot authorize the success label.
			rerender(row({ ...environment, currentTaskItem: { ...completed, id: "another-task" } }))
			expect(screen.queryByRole("article", { name: "chat:taskCompleted" })).not.toBeInTheDocument()
			expect(screen.getByRole("article", { name: "chat:completionReport" })).toBeInTheDocument()
			expect(mockUseExtensionState).not.toHaveBeenCalled()
		},
	)

	it("renders from its stable environment without reading root transcript state", () => {
		const message: ClineMessage = {
			ts: 1,
			type: "say",
			say: "text",
			text: "completed response",
			partial: false,
		}
		const environment: ChatRowEnvironment = {
			mcpServers: [],
			alwaysAllowMcp: false,
			mode: "code",
			reasoningBlockCollapsed: true,
			modelSupportsImages: true,
			getClineMessages: () => [message],
		}

		render(
			<ChatRow
				message={message}
				environment={environment}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={() => {}}
			/>,
		)

		expect(screen.getByText("completed response")).toBeInTheDocument()
		expect(mockUseExtensionState).not.toHaveBeenCalled()
	})
})
