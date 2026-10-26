import type { ReactNode } from "react"
import { render, screen } from "@/utils/test-utils"
import type { AlphaMessage } from "@alpha-code/types"

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
	it.each(["completed", "interrupted", "failed", undefined] as const)(
		"keeps the report's %s terminal attribution when the current task status changes",
		(terminalStatus) => {
			const message: AlphaMessage = {
				ts: 2,
				type: "say",
				say: "completion_result",
				text: "A historical response.",
				partial: false,
				...(terminalStatus === undefined
					? {}
					: { turn: { runId: "run-one", turnId: "turn-one", terminalStatus } }),
			}
			const environment: ChatRowEnvironment = {
				mcpServers: [],
				alwaysAllowMcp: false,
				mode: "code",
				reasoningBlockCollapsed: true,
				currentTaskId: "original-task",
				currentTaskItem: {
					id: "original-task",
					status: "active",
				},
				getAlphaMessages: () => [message],
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
			const label = terminalStatus === "completed" ? "chat:taskCompleted" : "chat:completionReport"
			expect(screen.getByRole("article", { name: label })).toBeInTheDocument()
			expect(screen.getByText(message.text!)).toBeInTheDocument()
			const completed = { ...environment.currentTaskItem!, status: "completed" as const }
			rerender(row({ ...environment, currentTaskItem: completed }))
			expect(screen.getByRole("article", { name: label })).toBeInTheDocument()
			rerender(row({ ...environment, currentTaskItem: { ...completed, status: "interrupted" } }))
			expect(screen.getByRole("article", { name: label })).toBeInTheDocument()
			rerender(row({ ...environment, currentTaskItem: { ...completed, id: "another-task" } }))
			expect(screen.getByRole("article", { name: label })).toBeInTheDocument()
			if (terminalStatus !== "completed")
				expect(screen.queryByRole("article", { name: "chat:taskCompleted" })).not.toBeInTheDocument()
			expect(mockUseExtensionState).not.toHaveBeenCalled()
		},
	)

	it("keeps a partial completion report neutral before its terminal row is accepted", () => {
		const message: AlphaMessage = {
			ts: 2,
			type: "say",
			say: "completion_result",
			text: "Still streaming",
			partial: true,
			turn: { runId: "run-one", turnId: "turn-one", terminalStatus: "completed" },
		}
		render(
			<ChatRow
				message={message}
				environment={{
					mcpServers: [],
					alwaysAllowMcp: false,
					mode: "code",
					reasoningBlockCollapsed: true,
					getAlphaMessages: () => [message],
				}}
				isExpanded={false}
				isLast={true}
				isStreaming={true}
				onToggleExpand={() => {}}
			/>,
		)
		expect(screen.getByRole("article", { name: "chat:completionReport" })).toBeInTheDocument()
		expect(screen.queryByRole("article", { name: "chat:taskCompleted" })).not.toBeInTheDocument()
	})

	it("renders from its stable environment without reading root transcript state", () => {
		const message: AlphaMessage = {
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
			getAlphaMessages: () => [message],
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
