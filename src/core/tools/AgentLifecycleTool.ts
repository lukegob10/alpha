import type { ToolName } from "@alpha-code/types"

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

export async function runAgentLifecycleOperation(
	name: AgentLifecycleToolName,
	method: keyof AgentLifecycleControlProvider,
	task: Task,
	callbacks: ToolCallbacks,
	operation: (provider: AgentLifecycleControlProvider) => Promise<unknown>,
): Promise<void> {
	const provider = task.providerRef.deref() as (Partial<AgentLifecycleControlProvider> & object) | undefined
	if (typeof provider?.[method] !== "function") {
		recordLifecycleToolError(
			name,
			task,
			callbacks,
			new Error(`agent lifecycle capability ${method} is unavailable`),
		)
		return
	}

	try {
		const result = await operation(provider as AgentLifecycleControlProvider)
		const serialized = JSON.stringify(result)
		if (serialized === undefined) {
			throw new Error(`agent lifecycle capability ${method} returned no JSON result`)
		}
		callbacks.pushToolResult(serialized)
	} catch (error) {
		recordLifecycleToolError(name, task, callbacks, error)
	}
}
