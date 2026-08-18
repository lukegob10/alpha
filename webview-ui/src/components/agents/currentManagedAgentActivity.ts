import type { ClineMessage, SubagentRunState } from "@alpha-code/types"

import type { ManagedAgentActivity } from "./managedAgentTreeAdapter"

interface AgentLifecyclePresentation {
	tool: "agentLifecycle"
	agentAction?: "list_agents" | "wait_agent"
	lifecycleStatus?: "running" | "completed" | "error"
	agentCount?: number
	mailboxUnreadCount?: number
	eventCount?: number
	timedOut?: boolean
	alreadyDelivered?: boolean
	cancelled?: boolean
	noActiveAgents?: boolean
	content?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const asCount = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0

const parseLifecyclePresentation = (message: ClineMessage): AgentLifecyclePresentation | undefined => {
	if (message.type !== "say" || message.say !== "tool" || !message.text) return undefined

	try {
		const candidate: unknown = JSON.parse(message.text)
		if (!isRecord(candidate) || candidate.tool !== "agentLifecycle") return undefined
		return candidate as unknown as AgentLifecyclePresentation
	} catch {
		return undefined
	}
}

const lifecycleSummary = (presentation: AgentLifecyclePresentation): string => {
	if (presentation.lifecycleStatus === "error") {
		return presentation.content
			? `Managed-agent action failed: ${presentation.content}`
			: "Managed-agent action failed"
	}

	if (presentation.agentAction === "list_agents") {
		if (presentation.lifecycleStatus === "running") return "Refreshing the managed-agent snapshot"
		const agents = asCount(presentation.agentCount)
		const unread = asCount(presentation.mailboxUnreadCount)
		return `Agent snapshot: ${agents} ${agents === 1 ? "agent" : "agents"}${
			unread > 0 ? `, ${unread} unread mailbox ${unread === 1 ? "update" : "updates"}` : ""
		}`
	}

	if (presentation.lifecycleStatus === "running") return "Waiting for managed-agent activity"
	if (presentation.noActiveAgents) return "No active managed agents remain"
	if (presentation.cancelled) return "Managed-agent activity wait was cancelled"
	if (presentation.timedOut) return "No managed-agent activity arrived before the wait ended"
	if (presentation.alreadyDelivered) return "No new activity; terminal results were already delivered"

	const events = asCount(presentation.eventCount)
	return events > 0
		? `Received ${events} managed-agent ${events === 1 ? "update" : "updates"}`
		: "Managed-agent activity wait completed"
}

const agentActivityTime = (agent: SubagentRunState, fallback: number): number =>
	agent.completedAt ?? agent.phaseStartedAt ?? agent.startedAt ?? fallback

const agentActivitySummary = (agent: SubagentRunState): string => {
	const state = agent.phase ? `${agent.status} · ${agent.phase}` : agent.status
	const detail = agent.error ?? agent.summary
	return `${agent.nickname} is ${state.replaceAll("_", " ")}${detail ? `: ${detail}` : ""}`
}

/**
 * Builds the best activity stream available to the webview today. The durable
 * mailbox projection can replace this input without changing ManagedAgentTree.
 */
export function buildCurrentManagedAgentActivity(messages: readonly ClineMessage[]): ManagedAgentActivity[] {
	const activity: ManagedAgentActivity[] = []

	messages.forEach((message, messageIndex) => {
		const group = message.subagentGroup
		if (group) {
			group.agents.forEach((agent) => {
				const createdAt = agentActivityTime(agent, group.createdAt || message.ts)
				activity.push({
					id: `agent:${group.groupId}:${agent.taskId}:${agent.status}:${createdAt}`,
					createdAt,
					summary: agentActivitySummary(agent),
					taskId: agent.taskId,
					kind: agent.status === "completed" ? "result" : "status",
					name: agent.status,
					unread: Boolean(agent.pendingApproval),
				})
			})
			return
		}

		const presentation = parseLifecyclePresentation(message)
		if (!presentation) return
		activity.push({
			id: `lifecycle:${message.ts}:${messageIndex}`,
			createdAt: message.ts,
			summary: lifecycleSummary(presentation),
			kind: presentation.agentAction === "wait_agent" ? "lifecycle" : "status",
			name: presentation.agentAction,
			unread: asCount(presentation.mailboxUnreadCount) > 0 || asCount(presentation.eventCount) > 0,
		})
	})

	return activity.sort((left, right) => right.createdAt - left.createdAt)
}
