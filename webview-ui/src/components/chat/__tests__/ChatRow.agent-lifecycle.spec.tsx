import React from "react"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { render, screen } from "@/utils/test-utils"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"

import { ChatRowContent } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { action?: string; count?: number; error?: string }) => {
			const count = options?.count ?? 0
			const translations: Record<string, string> = {
				"chat:agentLifecycle.actions.list_agents": "Inspect agents",
				"chat:agentLifecycle.actions.wait_agent": "Wait for agent updates",
				"chat:agentLifecycle.list.running": "Inspecting agents...",
				"chat:agentLifecycle.list.completed": `Inspected ${count} ${count === 1 ? "agent" : "agents"}`,
				"chat:agentLifecycle.list.mailbox": `${count} ${count === 1 ? "mailbox update" : "mailbox updates"}`,
				"chat:agentLifecycle.wait.running": "Waiting for agent updates...",
				"chat:agentLifecycle.wait.noActiveAgents": "No active agents to wait for",
				"chat:agentLifecycle.wait.timedOut": "No agent updates before timeout",
				"chat:agentLifecycle.wait.alreadyDelivered": "No new updates; results already delivered",
				"chat:agentLifecycle.wait.completed": "Agent wait completed",
				"chat:error": "Error",
			}
			if (key === "chat:agentLifecycle.failed") {
				return `${options?.action} failed: ${options?.error}`
			}
			return translations[key] ?? key
		},
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

function renderLifecycleRow(payload: Record<string, unknown>, partial = false) {
	const queryClient = new QueryClient()
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatRowContent
					message={{
						type: "say",
						say: "tool",
						ts: Date.now(),
						partial,
						text: JSON.stringify({ tool: "agentLifecycle", ...payload }),
					}}
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
		</ExtensionStateContextProvider>,
	)
}

describe("ChatRow - agent lifecycle status", () => {
	it("renders a compact list_agents result", () => {
		renderLifecycleRow({
			agentAction: "list_agents",
			lifecycleStatus: "completed",
			agentCount: 2,
			mailboxUnreadCount: 1,
		})

		expect(screen.getByText("Inspected 2 agents")).toBeInTheDocument()
		expect(screen.getByText("· 1 mailbox update")).toBeInTheDocument()
	})

	it("renders wait_agent while the bounded wait is active", () => {
		renderLifecycleRow({ agentAction: "wait_agent", lifecycleStatus: "running" }, true)

		expect(screen.getByText("Waiting for agent updates...")).toBeInTheDocument()
		expect(screen.getByLabelText("Agent action in progress")).toBeInTheDocument()
	})

	it("explains when wait_agent has no new result because delivery already happened", () => {
		renderLifecycleRow({
			agentAction: "wait_agent",
			lifecycleStatus: "completed",
			eventCount: 0,
			alreadyDelivered: true,
		})

		expect(screen.getByText("No new updates; results already delivered")).toBeInTheDocument()
	})

	it("explains when wait_agent returns immediately because no agents are active", () => {
		renderLifecycleRow({
			agentAction: "wait_agent",
			lifecycleStatus: "completed",
			eventCount: 0,
			noActiveAgents: true,
		})

		expect(screen.getByText("No active agents to wait for")).toBeInTheDocument()
	})

	it("renders lifecycle failures instead of leaving a blank request", () => {
		renderLifecycleRow({
			agentAction: "list_agents",
			lifecycleStatus: "error",
			content: "Registry unavailable",
		})

		expect(screen.getByText("Inspect agents failed: Registry unavailable")).toBeInTheDocument()
		expect(screen.getByLabelText("Agent action failed")).toBeInTheDocument()
	})
})
