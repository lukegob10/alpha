import type { AlphaMessage } from "@alpha-code/types"

import { render, screen } from "@/utils/test-utils"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"

import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

const groupMessage: AlphaMessage = {
	ts: 10,
	type: "say",
	say: "subagent_group",
	subagentGroup: {
		groupId: "group-1",
		parentTaskId: "parent-1",
		status: "running",
		createdAt: 1,
		agents: [
			{
				taskId: "child-1",
				nickname: "Maple",
				role: "explore",
				objective: "Review navigation",
				status: "running",
				usage: { durationMs: 0 },
			},
		],
	},
}
const prompt: AlphaMessage = { ts: 20, type: "say", say: "user_feedback", text: "Keep the context bar" }
const environment: ChatRowEnvironment = {
	mcpServers: [],
	alwaysAllowMcp: false,
	mode: "code",
	currentTaskId: "parent-1",
	reasoningBlockCollapsed: true,
	getAlphaMessages: () => [groupMessage, prompt],
}

function rows(hideSubagentGroups?: boolean) {
	return (
		<ExtensionStateContextProvider>
			{[groupMessage, prompt].map((message) => (
				<ChatRow
					key={message.ts}
					message={message}
					environment={environment}
					hideSubagentGroups={hideSubagentGroups}
					isExpanded
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => {}}
				/>
			))}
		</ExtensionStateContextProvider>
	)
}

it("retains the transcript group by default and hides only its duplicate presentation when a dock owns it", () => {
	const { rerender } = render(rows())
	expect(screen.getByRole("button", { name: /Open Maple/ })).toBeInTheDocument()
	rerender(rows(true))
	expect(screen.queryByRole("button", { name: /Open Maple/ })).not.toBeInTheDocument()
	expect(screen.getByText(prompt.text!)).toBeInTheDocument()
	expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled()
	expect(screen.getByRole("button", { name: "Edit and resend" })).toBeEnabled()
	rerender(rows(false))
	expect(screen.getByRole("button", { name: /Open Maple/ })).toBeInTheDocument()
})
