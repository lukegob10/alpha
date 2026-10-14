import { TOOL_ALIASES } from "../../shared/tools"
import { getCommandSearchSource } from "../tools/CommandExploration"
import type { AgentToolCall } from "./AgentResponse"

const DEFAULT_SEARCH_ONLY_STEP_LIMIT = 3
const DEFAULT_MAX_AUTOMATIC_RECOVERIES = 2

export interface SearchLoopRecoveryOptions {
	/** Consecutive model steps containing only repository searches before a recovery checkpoint. */
	searchOnlyStepLimit?: number
	/** Recovery prompts issued before the task reaches a recoverable pause boundary. */
	maxAutomaticRecoveries?: number
}

export interface SearchLoopProgressObservation {
	/** Progress admitted by the host's outcome observer, not inferred from model call counts. */
	madeProgress: boolean
}

export type SearchLoopRecoveryDecision =
	| {
			action: "continue"
			consecutiveSearchOnlySteps: number
			recoveryAttempts: number
	  }
	| {
			action: "recover"
			attempt: number
			consecutiveSearchOnlySteps: number
			recoveryAttempts: number
	  }
	| {
			action: "pause"
			consecutiveSearchOnlySteps: number
			recoveryAttempts: number
	  }

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return fallback
	return Math.min(maximum, Math.max(minimum, Math.floor(value as number)))
}

function canonicalToolName(name: string): string {
	return TOOL_ALIASES[name] ?? name
}

function isRepositorySearch(call: AgentToolCall): boolean {
	const name = canonicalToolName(call.name)
	if (name === "search_files" || name === "codebase_search") return true
	if (name !== "exec_command" || !call.arguments || typeof call.arguments !== "object") return false

	const args = call.arguments as Record<string, unknown>
	const command = typeof args.cmd === "string" ? args.cmd : args.command
	return typeof command === "string" && getCommandSearchSource(command) !== undefined
}

/**
 * Detects a search treadmill at the model-step boundary.
 *
 * Raw tool-call counts are deliberately irrelevant: a single step may contain
 * many independent searches. Admitted outcome progress renews the recovery
 * window; call shape alone cannot establish that successful exploration stalled.
 * Mixed or non-search steps also leave this search-specific recovery window.
 */
export class SearchLoopRecoveryPolicy {
	private readonly searchOnlyStepLimit: number
	private readonly maxAutomaticRecoveries: number
	private consecutiveSearchOnlySteps = 0
	private stepsSinceRecovery = 0
	private recoveryAttempts = 0

	constructor(options: SearchLoopRecoveryOptions = {}) {
		this.searchOnlyStepLimit = boundedInteger(options.searchOnlyStepLimit, DEFAULT_SEARCH_ONLY_STEP_LIMIT, 1, 16)
		this.maxAutomaticRecoveries = boundedInteger(
			options.maxAutomaticRecoveries,
			DEFAULT_MAX_AUTOMATIC_RECOVERIES,
			0,
			4,
		)
	}

	public observe(
		toolCalls: readonly AgentToolCall[],
		progress?: SearchLoopProgressObservation,
	): SearchLoopRecoveryDecision {
		if (progress?.madeProgress || toolCalls.length === 0 || !toolCalls.every(isRepositorySearch)) {
			this.reset()
			return this.continueDecision()
		}

		const maximumTrackedSteps = this.searchOnlyStepLimit * (this.maxAutomaticRecoveries + 1)
		this.consecutiveSearchOnlySteps = Math.min(maximumTrackedSteps, this.consecutiveSearchOnlySteps + 1)
		this.stepsSinceRecovery++
		if (this.stepsSinceRecovery < this.searchOnlyStepLimit) return this.continueDecision()

		this.stepsSinceRecovery = 0
		if (this.recoveryAttempts >= this.maxAutomaticRecoveries) {
			return {
				action: "pause",
				consecutiveSearchOnlySteps: this.consecutiveSearchOnlySteps,
				recoveryAttempts: this.recoveryAttempts,
			}
		}

		this.recoveryAttempts++
		return {
			action: "recover",
			attempt: this.recoveryAttempts,
			consecutiveSearchOnlySteps: this.consecutiveSearchOnlySteps,
			recoveryAttempts: this.recoveryAttempts,
		}
	}

	public reset(): void {
		this.consecutiveSearchOnlySteps = 0
		this.stepsSinceRecovery = 0
		this.recoveryAttempts = 0
	}

	private continueDecision(): SearchLoopRecoveryDecision {
		return {
			action: "continue",
			consecutiveSearchOnlySteps: this.consecutiveSearchOnlySteps,
			recoveryAttempts: this.recoveryAttempts,
		}
	}
}

export function formatSearchLoopRecoveryGuidance(attempt: number): string {
	if (attempt <= 1) {
		return "Search-loop recovery checkpoint: several consecutive model steps have only searched the repository. Before another search, consolidate what the returned evidence establishes, choose the best candidate file or symbol, and name the one unresolved hypothesis. Then inspect that candidate, make the requested change, run one consolidated search tied to a genuinely new hypothesis, or ask for the specific missing information. Rewording a query alone is not progress."
	}

	return "Search-loop recovery checkpoint (final automatic attempt): the previous checkpoint did not produce a concrete action. Use the best existing evidence to inspect or act, or ask for the specific missing information. Run another search only if it tests one genuinely new hypothesis, and follow it with a concrete action."
}
