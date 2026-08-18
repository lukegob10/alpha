import type { ClineSayTool, ToolName } from "@alpha-code/types"

import type { Task } from "../task/Task"

import type { ToolCallbacks } from "./BaseTool"

export const WAIT_AGENT_MIN_TIMEOUT_MS = 10_000
export const WAIT_AGENT_DEFAULT_TIMEOUT_MS = 30_000
export const WAIT_AGENT_MAX_TIMEOUT_MS = 300_000

export type AgentLifecycleToolName =
	| "list_agents"
	| "wait_agent"
	| "send_message"
	| "followup_task"
	| "interrupt_agent"
	| "cancel_agent"
	| "close_agent"

type VisibleAgentLifecycleToolName = Extract<AgentLifecycleToolName, "list_agents" | "wait_agent">

const visibleAgentLifecycleTools = new Set<AgentLifecycleToolName>(["list_agents", "wait_agent"])

/** Minimal host surface required by the model-facing lifecycle tools. */
export interface AgentLifecycleControlProvider {
	listAgents(parent: Task, pathPrefix?: string): Promise<unknown>
	waitForAgent(parent: Task, timeoutMs?: number): Promise<unknown>
	sendMessageToAgent(parent: Task, target: string, message: string): Promise<unknown>
	followupAgentTask(parent: Task, target: string, message: string): Promise<unknown>
	interruptAgent(parent: Task, target: string): Promise<unknown>
	cancelAgent(parent: Task, target: string, reason?: string): Promise<unknown>
	closeAgent(parent: Task, target: string): Promise<unknown>
}

const AGENT_TARGET_PATTERN = /^(?:\/root(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*|[A-Za-z0-9][A-Za-z0-9._:-]*)$/
const CANONICAL_AGENT_PATH_PATTERN = /^\/root(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/

export function requireAgentTarget(value: unknown): string {
	if (typeof value !== "string" || !AGENT_TARGET_PATTERN.test(value)) {
		throw new Error("target must be a nonempty task ID or canonical agent path such as /root/review")
	}
	return value
}

export function optionalCanonicalPath(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value !== "string" || !CANONICAL_AGENT_PATH_PATTERN.test(value)) {
		throw new Error("path_prefix must be a canonical agent path such as /root/review")
	}
	return value
}

export function requireNonEmptyMessage(value: unknown, field = "message"): string {
	if (typeof value !== "string") {
		throw new Error(`${field} must be a string between 1 and 2,000 characters`)
	}
	const normalized = value.trim()
	if (normalized.length === 0 || normalized.length > 2_000) {
		throw new Error(`${field} must be a string between 1 and 2,000 characters`)
	}
	return normalized
}

export function optionalReason(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	return requireNonEmptyMessage(value, "reason")
}

export function resolveWaitTimeout(value: unknown): number {
	if (value === undefined || value === null) return WAIT_AGENT_DEFAULT_TIMEOUT_MS
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < WAIT_AGENT_MIN_TIMEOUT_MS ||
		value > WAIT_AGENT_MAX_TIMEOUT_MS
	) {
		throw new Error(
			`timeout_ms must be an integer from ${WAIT_AGENT_MIN_TIMEOUT_MS} to ${WAIT_AGENT_MAX_TIMEOUT_MS}`,
		)
	}
	return value
}

export function recordLifecycleToolError(
	name: AgentLifecycleToolName,
	task: Task,
	callbacks: ToolCallbacks,
	error: unknown,
): void {
	const message = error instanceof Error ? error.message : String(error)
	task.recordToolError(name as ToolName, message)
	task.didToolFailInCurrentTurn = true
	callbacks.setResultMetadata?.({ status: "error" })
	callbacks.pushToolResult(JSON.stringify({ error: message }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	return typeof record[key] === "boolean" ? record[key] : undefined
}

function lifecyclePresentation(
	name: VisibleAgentLifecycleToolName,
	status: NonNullable<ClineSayTool["lifecycleStatus"]>,
	result?: unknown,
	error?: unknown,
): ClineSayTool {
	const record = isRecord(result) ? result : {}
	const mailbox = isRecord(record.mailbox) ? record.mailbox : {}
	const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error)

	return {
		tool: "agentLifecycle",
		agentAction: name,
		lifecycleStatus: status,
		...(message ? { content: message } : {}),
		...(name === "list_agents"
			? {
					agentCount: Array.isArray(record.agents) ? record.agents.length : 0,
					mailboxUnreadCount:
						typeof mailbox.unreadCount === "number" && Number.isFinite(mailbox.unreadCount)
							? Math.max(0, Math.trunc(mailbox.unreadCount))
							: 0,
				}
			: {
					eventCount: Array.isArray(record.events) ? record.events.length : 0,
					timedOut: optionalBoolean(record, "timedOut"),
					alreadyDelivered: optionalBoolean(record, "alreadyDelivered"),
					cancelled: optionalBoolean(record, "cancelled"),
					noActiveAgents: optionalBoolean(record, "noActiveAgents"),
				}),
	}
}

async function publishLifecyclePresentation(
	name: AgentLifecycleToolName,
	task: Task,
	status: NonNullable<ClineSayTool["lifecycleStatus"]>,
	partial: boolean,
	result?: unknown,
	error?: unknown,
): Promise<void> {
	if (!visibleAgentLifecycleTools.has(name)) return
	const payload = lifecyclePresentation(name as VisibleAgentLifecycleToolName, status, result, error)
	// Presentation must never change lifecycle-tool execution or its model-facing result.
	await task
		.say("tool", JSON.stringify(payload), undefined, partial, undefined, undefined, { isNonInteractive: true })
		.catch(() => undefined)
}

export async function runAgentLifecycleOperation(
	name: AgentLifecycleToolName,
	method: keyof AgentLifecycleControlProvider,
	task: Task,
	callbacks: ToolCallbacks,
	operation: (provider: AgentLifecycleControlProvider) => Promise<unknown>,
): Promise<void> {
	const provider = task.providerRef.deref() as (Partial<AgentLifecycleControlProvider> & object) | undefined
	if (typeof provider?.[method] !== "function") {
		const error = new Error(`agent lifecycle capability ${method} is unavailable`)
		await publishLifecyclePresentation(name, task, "error", false, undefined, error)
		recordLifecycleToolError(name, task, callbacks, error)
		return
	}

	await publishLifecyclePresentation(name, task, "running", true)
	try {
		const result = await operation(provider as AgentLifecycleControlProvider)
		const serialized = JSON.stringify(result)
		if (serialized === undefined) {
			throw new Error(`agent lifecycle capability ${method} returned no JSON result`)
		}
		callbacks.pushToolResult(serialized)
		await publishLifecyclePresentation(name, task, "completed", false, result)
	} catch (error) {
		await publishLifecyclePresentation(name, task, "error", false, undefined, error)
		recordLifecycleToolError(name, task, callbacks, error)
	}
}
