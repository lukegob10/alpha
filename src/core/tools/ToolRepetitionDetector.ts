import { createHash } from "crypto"
import stringify from "safe-stable-stringify"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

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
}

export interface ToolProgressDecision {
	action: "continue" | "change-strategy" | "stop"
	stagnantCalls: number
	retainedOutcomes: number
	reason?: "no-progress"
}

export interface ToolProgressOptions {
	/** Stagnant outcomes before one strategy change; twice this number stops the current attempt. */
	noProgressLimit?: number
	/** Recent outcomes retained, hard capped at 128 and at least twice noProgressLimit. */
	historyLimit?: number
}

interface RecentToolOutcome {
	identity: string
	scope: string
	status: ToolProgressObservation["status"]
	kind: ToolProgressObservation["kind"]
	state?: string
	evidence?: string
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
	return Math.min(maximum, Math.max(1, Math.floor(value !== undefined && Number.isFinite(value) ? value : fallback)))
}

function digest(value: unknown): string {
	return createHash("sha256")
		.update(stringify(value) ?? "")
		.digest("hex")
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
	private readonly recentOutcomes: RecentToolOutcome[] = []
	private stagnantCalls = 0
	private strategyChangeIssued = false
	private stopped = false

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
		if (this.consecutiveIdenticalToolCallLimit <= 0) return this.progressDecision("continue")
		if (this.stopped) return this.progressDecision("stop")

		const outcome: RecentToolOutcome = {
			identity: digest({ toolName: observation.toolName, args: observation.args }),
			scope: digest(observation.scope),
			status: observation.status,
			kind: observation.kind,
			...(observation.stateFingerprint !== undefined ? { state: digest(observation.stateFingerprint) } : {}),
			...(observation.status === "success" && observation.evidenceFingerprint !== undefined
				? { evidence: digest(observation.evidenceFingerprint) }
				: {}),
		}
		const sameScope = this.recentOutcomes.filter((previous) => previous.scope === outcome.scope)
		const stateChanged =
			outcome.state !== undefined &&
			sameScope.some((previous) => previous.state !== undefined) &&
			!sameScope.some((previous) => previous.state === outcome.state)
		const freshEvidence =
			outcome.evidence !== undefined && !sameScope.some((previous) => previous.evidence === outcome.evidence)
		const freshRead =
			observation.status === "success" &&
			observation.kind === "read" &&
			observation.scope !== undefined &&
			!sameScope.some(
				(previous) =>
					previous.status === "success" && previous.kind === "read" && previous.identity === outcome.identity,
			)
		const progressed = stateChanged || freshEvidence || freshRead
		if (observation.kind === "poll" && observation.status === "success" && !progressed) {
			return this.progressDecision("continue")
		}

		this.recentOutcomes.push(outcome)
		if (this.recentOutcomes.length > this.historyLimit) this.recentOutcomes.shift()
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
		this.recentOutcomes.length = 0
		this.stagnantCalls = 0
		this.strategyChangeIssued = false
		this.stopped = false
	}

	private progressDecision(action: ToolProgressDecision["action"]): ToolProgressDecision {
		return {
			action,
			stagnantCalls: this.stagnantCalls,
			retainedOutcomes: this.recentOutcomes.length,
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
