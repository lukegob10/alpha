import { createHash } from "crypto"
import stringify from "safe-stable-stringify"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"
import { normalizeToolFailure, type ToolFailureMetadata } from "./ToolFailure"

export interface ToolProgressObservation {
	toolName: string
	args?: unknown
	status: "success" | "error" | "denied" | "cancelled"
	/** Trusted host classification. Only actual waits/polls of external work qualify as polling. */
	kind: "read" | "check" | "mutation" | "poll" | "other"
	/** Canonical working directory or affected/read scope, resolved by the execution host. */
	scope?: string
	/** Current semantic content state; never a call ID, timestamp, or arbitrary command output. */
	stateFingerprint?: string
	/** Admitted validation evidence or scoped read evidence, excluding execution IDs and timestamps. */
	evidenceFingerprint?: string
	/** Host-issued semantic identity for a supported shell inspection. */
	explorationFingerprint?: string
	/** Trusted execution cause. Unrelated progress cannot renew this blocker's retry allowance. */
	failure?: ToolFailureMetadata
	/** Running command handlers have not established a successful operation outcome. */
	executionStatus?: "running" | "success" | "error" | "denied" | "cancelled"
}

export interface ToolProgressDecision {
	action: "continue" | "change-strategy" | "stop"
	stagnantCalls: number
	retainedOutcomes: number
	reason?: "no-progress" | "unchanged-blocker" | "unknown-outcome" | "failure-capacity"
	/** A per-operation retry decision, never a global stop on independent work. */
	failure?: ToolFailureMetadata
}

export interface ToolProgressOptions {
	/** Stagnant outcomes before one strategy change; twice this number stops the current attempt. */
	noProgressLimit?: number
	/** Recent outcomes retained, hard capped at 128 and at least twice noProgressLimit. */
	historyLimit?: number
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
	return Math.min(maximum, Math.max(1, Math.floor(value !== undefined && Number.isFinite(value) ? value : fallback)))
}

function digest(value: unknown): string {
	return createHash("sha256")
		.update(stringify(value) ?? "")
		.digest("hex")
}

function operationIdentity(toolName: string, args: unknown): string {
	if (toolName === "execute_command" && args && typeof args === "object" && "command" in args) {
		const command = typeof args.command === "string" ? args.command.trim() : args.command
		const cwd = "cwd" in args ? (args.cwd ?? undefined) : undefined
		// Timeout and verification association do not change the requested effect.
		// Preserve whitespace inside shell strings, which can change their meaning.
		return digest({ toolName, command, cwd })
	}
	return digest({ toolName, args })
}

interface FailureAllowance {
	failure: ToolFailureMetadata
	attempts: number
	operations: Set<string>
}

/**
 * Bounded, outcome-aware stopping policy. This is not a completion or verification
 * engine: the execution host admits evidence and owns the resulting lifecycle.
 * `check` retains the legacy pre-execution contract for unmigrated callers.
 */
export class ToolRepetitionDetector {
	private previousToolCallJson: string | null = null
	private consecutiveIdenticalToolCallCount: number = 0
	private readonly consecutiveIdenticalToolCallLimit: number
	private readonly noProgressLimit: number
	private readonly historyLimit: number
	private readonly seenReadIdentities = new Set<string>()
	private readonly seenStateIdentities = new Set<string>()
	private readonly seenStateScopes = new Set<string>()
	private readonly seenEvidenceIdentities = new Set<string>()
	private retainedOutcomeCount = 0
	private stagnantCalls = 0
	private strategyChangeIssued = false
	private stopped = false
	private readonly failureAllowances = new Map<string, FailureAllowance>()
	private failureCapacity?: ToolFailureMetadata

	/**
	 * Creates a new ToolRepetitionDetector
	 * @param limit The maximum number of identical consecutive tool calls allowed
	 */
	constructor(limit: number = 3, options: ToolProgressOptions = {}) {
		this.consecutiveIdenticalToolCallLimit = limit
		this.noProgressLimit = boundedPositiveInteger(
			options.noProgressLimit,
			Number.isFinite(limit) ? limit * 2 : 6,
			64,
		)
		this.historyLimit = Math.max(this.noProgressLimit * 2, boundedPositiveInteger(options.historyLimit, 64, 128))
	}

	/**
	 * Observe each terminal tool result once, in committed model order. Handler
	 * success alone is not progress. Novel successful scoped reads are exploration;
	 * fresh admitted evidence or a semantic state delta are meaningful progress.
	 * The first state fingerprint establishes a baseline, and previously seen states
	 * do not reset stagnation when edits alternate between equivalent contents.
	 *
	 * Successful unchanged polls do not consume the window or reset stagnation.
	 * Keep this instance across compaction. Explicit user guidance, reload or rewind
	 * can reset the ephemeral window; durable verification remains the host's job.
	 */
	public recordOutcome(observation: ToolProgressObservation): ToolProgressDecision {
		const failure = observation.status === "success" ? undefined : normalizeToolFailure(observation.failure)
		if (this.failureCapacity) return this.failureCapacityDecision(this.failureCapacity)
		if (this.consecutiveIdenticalToolCallLimit <= 0 && failure?.outcome !== "unknown")
			return this.progressDecision("continue")
		if (this.stopped) return this.progressDecision("stop")
		const operation = operationIdentity(observation.toolName, observation.args)
		if (failure && (failure.reason !== "cancelled" || failure.outcome === "unknown")) {
			const key = digest([failure.reason, failure.affectedScope])
			let allowance = this.failureAllowances.get(key)
			if (
				(!allowance && this.failureAllowances.size >= this.historyLimit) ||
				(allowance && !allowance.operations.has(operation) && allowance.operations.size >= this.historyLimit)
			) {
				this.failureCapacity = failure
				return this.failureCapacityDecision(failure)
			}
			if (!allowance && this.failureAllowances.size < this.historyLimit) {
				allowance = { failure, attempts: 0, operations: new Set() }
				this.failureAllowances.set(key, allowance)
			}
			if (allowance) {
				if (allowance.failure.outcome !== "unknown") allowance.failure = failure
				allowance.attempts = Math.min(this.noProgressLimit * 2, allowance.attempts + 1)
				if (allowance.operations.size < this.historyLimit) allowance.operations.add(operation)
				this.retainedOutcomeCount = Math.min(this.historyLimit, this.retainedOutcomeCount + 1)
				const unknown = allowance.failure.outcome === "unknown"
				return {
					action:
						unknown || allowance.attempts >= this.noProgressLimit * 2
							? "stop"
							: allowance.attempts === this.noProgressLimit
								? "change-strategy"
								: "continue",
					stagnantCalls: allowance.attempts,
					retainedOutcomes: this.retainedOutcomeCount,
					reason: unknown ? "unknown-outcome" : "unchanged-blocker",
					failure: allowance.failure,
				}
			}
		} else if (observation.status === "success" && observation.executionStatus !== "running") {
			for (const [key, allowance] of this.failureAllowances) {
				if (allowance.failure.outcome === "known" && allowance.operations.has(operation)) {
					this.failureAllowances.delete(key)
				}
			}
		}

		const outcome = {
			identity: digest(
				observation.explorationFingerprint === undefined
					? { toolName: observation.toolName, args: observation.args }
					: { exploration: observation.explorationFingerprint },
			),
			scope: digest(observation.scope),
			...(observation.stateFingerprint !== undefined ? { state: digest(observation.stateFingerprint) } : {}),
			...(observation.status === "success" && observation.evidenceFingerprint !== undefined
				? { evidence: digest(observation.evidenceFingerprint) }
				: {}),
		}
		const stateScopeWasSeen = this.seenStateScopes.has(outcome.scope)
		const freshState =
			outcome.state !== undefined &&
			this.rememberNovelty(this.seenStateIdentities, digest({ scope: outcome.scope, state: outcome.state }))
		if (outcome.state !== undefined && freshState && this.seenStateScopes.size < this.historyLimit) {
			this.seenStateScopes.add(outcome.scope)
		}
		const stateChanged = freshState && stateScopeWasSeen
		const freshEvidence =
			outcome.evidence !== undefined &&
			this.rememberNovelty(
				this.seenEvidenceIdentities,
				digest({ scope: outcome.scope, evidence: outcome.evidence }),
			)
		const freshRead =
			observation.status === "success" &&
			observation.kind === "read" &&
			observation.scope !== undefined &&
			this.rememberNovelty(this.seenReadIdentities, digest({ scope: outcome.scope, identity: outcome.identity }))
		const progressed = stateChanged || freshEvidence || freshRead
		if (observation.kind === "poll" && observation.status === "success" && !progressed) {
			return this.progressDecision("continue")
		}

		this.retainedOutcomeCount = Math.min(this.historyLimit, this.retainedOutcomeCount + 1)
		if (progressed) {
			this.stagnantCalls = 0
			this.strategyChangeIssued = false
			return this.progressDecision("continue")
		}

		this.stagnantCalls += 1
		if (this.stagnantCalls >= this.noProgressLimit * 2) {
			this.stopped = true
			return this.progressDecision("stop")
		}
		if (this.stagnantCalls >= this.noProgressLimit && !this.strategyChangeIssued) {
			this.strategyChangeIssued = true
			return this.progressDecision("change-strategy")
		}
		return this.progressDecision("continue")
	}

	public resetProgress(): void {
		this.failureCapacity = undefined
		this.failureAllowances.clear()
		this.seenReadIdentities.clear()
		this.seenStateIdentities.clear()
		this.seenStateScopes.clear()
		this.seenEvidenceIdentities.clear()
		this.retainedOutcomeCount = 0
		this.stagnantCalls = 0
		this.strategyChangeIssued = false
		this.stopped = false
	}

	/** Pure, bounded gate for previously failed effects; inspection and alternatives remain available. */
	public getRetryBlock(toolName: string, args: unknown): ToolFailureMetadata | undefined {
		if (this.failureCapacity) return this.failureCapacity
		const operation = operationIdentity(toolName, args)
		let blocked: ToolFailureMetadata | undefined
		for (const allowance of this.failureAllowances.values()) {
			if (
				allowance.operations.has(operation) &&
				(allowance.failure.outcome === "unknown" || allowance.attempts >= this.noProgressLimit * 2)
			) {
				if (allowance.failure.outcome === "unknown") return allowance.failure
				blocked = allowance.failure
			}
		}
		return blocked
	}

	private failureCapacityDecision(failure: ToolFailureMetadata): ToolProgressDecision {
		return {
			action: "stop",
			stagnantCalls: this.stagnantCalls,
			retainedOutcomes: this.retainedOutcomeCount,
			reason: "failure-capacity",
			failure,
		}
	}

	private rememberNovelty(seen: Set<string>, identity: string): boolean {
		if (seen.has(identity) || seen.size >= this.historyLimit) return false
		seen.add(identity)
		return true
	}

	private progressDecision(action: ToolProgressDecision["action"]): ToolProgressDecision {
		return {
			action,
			stagnantCalls: this.stagnantCalls,
			retainedOutcomes: this.retainedOutcomeCount,
			...(action !== "continue" ? { reason: "no-progress" as const } : {}),
		}
	}

	/**
	 * Checks if the current tool call is identical to the previous one
	 * and determines if execution should be allowed
	 *
	 * @param currentToolCallBlock ToolUse object representing the current tool call
	 * @returns Object indicating if execution is allowed and a message to show if not
	 */
	public check(currentToolCallBlock: ToolUse): {
		allowExecution: boolean
		askUser?: {
			messageKey: string
			messageDetail: string
		}
	} {
		// Serialize the block to a canonical JSON string for comparison
		const currentToolCallJson = this.serializeToolUse(currentToolCallBlock)

		// Compare with previous tool call
		if (this.previousToolCallJson === currentToolCallJson) {
			this.consecutiveIdenticalToolCallCount++
		} else {
			this.consecutiveIdenticalToolCallCount = 0 // Reset to 0 for a new tool
			this.previousToolCallJson = currentToolCallJson
		}

		// Check if limit is reached (0 means unlimited)
		if (
			this.consecutiveIdenticalToolCallLimit > 0 &&
			this.consecutiveIdenticalToolCallCount >= this.consecutiveIdenticalToolCallLimit
		) {
			// Reset counters to allow recovery if user guides the AI past this point
			this.consecutiveIdenticalToolCallCount = 0
			this.previousToolCallJson = null

			// Return result indicating execution should not be allowed
			return {
				allowExecution: false,
				askUser: {
					messageKey: "mistake_limit_reached",
					messageDetail: t("tools:toolRepetitionLimitReached", { toolName: currentToolCallBlock.name }),
				},
			}
		}

		// Execution is allowed
		return { allowExecution: true }
	}

	/**
	 * Serializes a ToolUse object into a canonical JSON string for comparison
	 *
	 * @param toolUse The ToolUse object to serialize
	 * @returns JSON string representation of the tool use with sorted parameter keys
	 */
	private serializeToolUse(toolUse: ToolUse): string {
		const toolObject: Record<string, any> = {
			name: toolUse.name,
			params: toolUse.params,
		}

		// Only include nativeArgs if it has content
		if (toolUse.nativeArgs && Object.keys(toolUse.nativeArgs).length > 0) {
			toolObject.nativeArgs = toolUse.nativeArgs
		}

		return stringify(toolObject)
	}
}
