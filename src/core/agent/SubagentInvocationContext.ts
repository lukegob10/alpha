import type { ApiInstructionFragment } from "../../api"
import type { ProviderSettings, SubagentAutoApprovalPolicy, SubagentModelRouteState } from "@alpha-code/types"
import type { ApiMessage } from "../task-persistence/apiMessages"
import { selectInheritedInstructionFragments } from "../prompts/inherited-instructions"
import type { AgentResponseItem } from "./AgentResponse"
import type { SubagentContextInstructionSourceInput } from "./SubagentContextCapture"

/** Private step-owned launch data; never a wire message or public task-history field. */
export interface SubagentInvocationContext {
	mode: string
	apiConfiguration: ProviderSettings
	apiConfigName?: string
	modelRoute: SubagentModelRouteState
	history: ApiMessage[]
	finalAssistantMessageIndexes: number[]
	/** Captured grant ceiling; a live settings change can only narrow it at launch. */
	autoApprovalPolicy?: SubagentAutoApprovalPolicy
	instructions: {
		effectiveText: string
		sources: SubagentContextInstructionSourceInput[]
	}
}

export function captureInheritedStepInstructions(
	taskId: string,
	stepId: string,
	fragments: readonly ApiInstructionFragment[],
): SubagentInvocationContext["instructions"] {
	const inherited = selectInheritedInstructionFragments(fragments)
	return {
		effectiveText: inherited.map(({ content }) => content).join("\n\n"),
		sources: inherited.map(({ origin, content }, index) => ({
			kind: origin ?? "captured-user-instructions",
			ref: `task:${taskId}:step:${stepId}:instruction:${index}`,
			text: content,
		})),
	}
}

type PassiveResponseItem = Exclude<AgentResponseItem, { type: "tool_call" | "error" }>

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string"
}

function isTokenCount(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isPassiveResponseItem(value: unknown): value is PassiveResponseItem {
	if (!isRecord(value)) return false
	switch (value.type) {
		case "text":
			return typeof value.text === "string"
		case "reasoning":
			return typeof value.text === "string" && isOptionalString(value.signature)
		case "usage":
			return (
				isTokenCount(value.inputTokens) &&
				isTokenCount(value.outputTokens) &&
				["cacheWriteTokens", "cacheReadTokens", "reasoningTokens", "totalCost"].every(
					(key) => value[key] === undefined || isTokenCount(value[key]),
				)
			)
		case "grounding":
			return (
				Array.isArray(value.sources) &&
				value.sources.every(
					(source) =>
						isRecord(source) &&
						typeof source.title === "string" &&
						typeof source.url === "string" &&
						isOptionalString(source.snippet),
				)
			)
		default:
			// Tool calls, errors, and unknown future semantics cannot establish finality.
			return false
	}
}

function hasCompletedResponseOutcome(value: unknown): boolean {
	// AgentResponse.outcome is optional; the turn engine derives tool-free completion.
	if (value === undefined) return true
	return (
		isRecord(value) &&
		value.status === "completed" &&
		(value.requiresContinuation === undefined || value.requiresContinuation === false) &&
		isOptionalString(value.reason) &&
		(value.retryable === undefined || typeof value.retryable === "boolean")
	)
}

/**
 * Alpha completes a tool-free visible response unless continuation is pending.
 * Legacy assistant text without canonical response evidence remains unclassified.
 * Staged completion-tool results do not prove the host accepted their final report.
 */
export function getFinalAssistantMessageIndexes(history: readonly ApiMessage[]): number[] {
	return history.flatMap((message, index) => {
		if (message.role !== "assistant" || message.type === "reasoning") return []
		const canonical = message as ApiMessage & {
			agentResponseItems?: unknown
			agentResponseOutcome?: unknown
		}
		const items = canonical.agentResponseItems
		if (!Array.isArray(items) || !items.every(isPassiveResponseItem)) return []
		if (!items.some((item) => item.type === "text" && item.text.trim().length > 0)) return []
		if (!hasCompletedResponseOutcome(canonical.agentResponseOutcome)) return []
		return [index]
	})
}
