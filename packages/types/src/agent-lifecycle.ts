import { z } from "zod"

/**
 * The lifecycle contract intentionally uses opaque, non-empty identifiers.
 * Providers are free to choose their own identifier format; the lifecycle
 * layer only needs stable values that can be correlated across events.
 */
const lifecycleIdentifierSchema = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => value.trim().length > 0, "Lifecycle identifiers cannot be blank")

const lifecycleTimestampSchema = z.number().finite().nonnegative()
const lifecyclePositiveSequenceSchema = z.number().int().positive()

/** Stable identifiers carried by every canonical lifecycle record. */
export const agentTaskIdSchema = lifecycleIdentifierSchema
export const agentRunIdSchema = lifecycleIdentifierSchema
export const agentTurnIdSchema = lifecycleIdentifierSchema
export const agentStepIdSchema = lifecycleIdentifierSchema
export const agentItemIdSchema = lifecycleIdentifierSchema
export const agentEventIdSchema = lifecycleIdentifierSchema
export const agentToolCallIdSchema = lifecycleIdentifierSchema
export const agentApprovalIdSchema = lifecycleIdentifierSchema

export type AgentTaskId = z.infer<typeof agentTaskIdSchema>
export type AgentRunId = z.infer<typeof agentRunIdSchema>
export type AgentTurnId = z.infer<typeof agentTurnIdSchema>
export type AgentStepId = z.infer<typeof agentStepIdSchema>
export type AgentItemId = z.infer<typeof agentItemIdSchema>
export type AgentEventId = z.infer<typeof agentEventIdSchema>
export type AgentToolCallId = z.infer<typeof agentToolCallIdSchema>
export type AgentApprovalId = z.infer<typeof agentApprovalIdSchema>

/** Unprefixed aliases are useful at boundaries that already live in an agent namespace. */
export const taskIdSchema = agentTaskIdSchema
export const runIdSchema = agentRunIdSchema
export const turnIdSchema = agentTurnIdSchema
export const stepIdSchema = agentStepIdSchema
export const itemIdSchema = agentItemIdSchema
export const eventIdSchema = agentEventIdSchema
export type TaskId = AgentTaskId
export type RunId = AgentRunId
export type TurnId = AgentTurnId
export type StepId = AgentStepId
export type ItemId = AgentItemId
export type EventId = AgentEventId

export const lifecycleTaskIdSchema = agentTaskIdSchema
export const lifecycleRunIdSchema = agentRunIdSchema
export const lifecycleTurnIdSchema = agentTurnIdSchema
export const lifecycleStepIdSchema = agentStepIdSchema
export const lifecycleItemIdSchema = agentItemIdSchema
export const lifecycleEventIdSchema = agentEventIdSchema
export type LifecycleTaskId = AgentTaskId
export type LifecycleRunId = AgentRunId
export type LifecycleTurnId = AgentTurnId
export type LifecycleStepId = AgentStepId
export type LifecycleItemId = AgentItemId
export type LifecycleEventId = AgentEventId

/** Version of the persisted, provider-neutral lifecycle representation. */
export const agentLifecycleVersionSchema = z.literal(1)
export type AgentLifecycleVersion = z.infer<typeof agentLifecycleVersionSchema>
export const lifecycleContractVersionSchema = agentLifecycleVersionSchema
export type LifecycleContractVersion = AgentLifecycleVersion

/** A turn has one active state and one terminal state, if it has finished. */
export const agentTurnStatusSchema = z.enum(["in_progress", "completed", "interrupted", "failed"])
export type AgentTurnStatus = z.infer<typeof agentTurnStatusSchema>

export const agentTurnTerminalStatusSchema = z.enum(["completed", "interrupted", "failed"])
export type AgentTurnTerminalStatus = z.infer<typeof agentTurnTerminalStatusSchema>

/**
 * Phases describe where work is happening; status remains the source of truth
 * for terminality. The values cover the host's loop without leaking provider
 * state-machine names into persisted records.
 */
export const agentLifecyclePhaseSchema = z.enum([
	"queued",
	"starting",
	"planning",
	"working",
	"executing",
	"waiting",
	"awaiting_approval",
	"steering",
	"compacting",
	"reporting",
	"finalizing",
])
export type AgentLifecyclePhase = z.infer<typeof agentLifecyclePhaseSchema>
export const lifecyclePhaseSchema = agentLifecyclePhaseSchema
export type LifecyclePhase = AgentLifecyclePhase
export const agentPhaseSchema = agentLifecyclePhaseSchema
export type AgentPhase = AgentLifecyclePhase

const lifecycleItemBaseFields = {
	itemId: agentItemIdSchema,
	stepId: agentStepIdSchema.optional(),
	createdAt: lifecycleTimestampSchema.optional(),
}

/** User-authored input retained as a normalized text item. */
export const agentLifecycleUserItemSchema = z
	.object({
		...lifecycleItemBaseFields,
		type: z.literal("user"),
		text: z.string(),
	})
	.strict()

/** Visible assistant text. */
export const agentLifecycleAssistantTextItemSchema = z
	.object({
		...lifecycleItemBaseFields,
		type: z.literal("assistant_text"),
		text: z.string(),
	})
	.strict()

/**
 * Provider-neutral assistant reasoning. Only normalized text is persisted;
 * provider signatures, encrypted thoughts, and raw SDK payloads do not belong
 * in this contract.
 */
export const agentLifecycleAssistantReasoningItemSchema = z
	.object({
		...lifecycleItemBaseFields,
		type: z.literal("assistant_reasoning"),
		text: z.string(),
	})
	.strict()

export const agentToolCallStatusSchema = z.enum(["accepted", "rejected", "cancelled"])
export type AgentToolCallStatus = z.infer<typeof agentToolCallStatusSchema>

/** A normalized tool invocation. An accepted invocation must eventually result. */
export const agentLifecycleToolCallItemSchema = z
	.object({
		...lifecycleItemBaseFields,
		type: z.literal("tool_call"),
		toolCallId: agentToolCallIdSchema,
		name: z.string().min(1),
		arguments: z.unknown(),
		status: agentToolCallStatusSchema.default("accepted"),
		/** Compatibility marker for producers that model acceptance as a boolean. */
		accepted: z.boolean().optional(),
	})
	.strict()

export const agentToolResultStatusSchema = z.enum(["completed", "success", "failed", "error", "denied", "cancelled"])
export type AgentToolResultStatus = z.infer<typeof agentToolResultStatusSchema>

/** A terminal result for one accepted tool call. */
const agentLifecycleToolResultItemShapeSchema = z
	.object({
		...lifecycleItemBaseFields,
		type: z.literal("tool_result"),
		toolCallId: agentToolCallIdSchema,
		status: agentToolResultStatusSchema,
		output: z.unknown().optional(),
		/** `result` is accepted as a neutral alias for hosts that use that term. */
		result: z.unknown().optional(),
	})
	.strict()

export const agentLifecycleToolResultItemSchema = agentLifecycleToolResultItemShapeSchema.superRefine(
	(item, context) => {
		if (item.output === undefined && item.result === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["output"],
				message: "A tool result must include output or result",
			})
		}
	},
)

export const agentApprovalStatusSchema = z.enum(["requested", "approved", "denied", "cancelled"])
export type AgentApprovalStatus = z.infer<typeof agentApprovalStatusSchema>

/** Approval request and its terminal decision, linked by approvalId. */
export const agentLifecycleApprovalItemSchema = z
	.object({
		...lifecycleItemBaseFields,
		type: z.literal("approval"),
		approvalId: agentApprovalIdSchema,
		toolCallId: agentToolCallIdSchema.optional(),
		status: agentApprovalStatusSchema,
		reason: z.string().optional(),
	})
	.strict()

/** Token and cost counters in a provider-neutral shape. */
export const agentLifecycleUsageItemSchema = z
	.object({
		...lifecycleItemBaseFields,
		type: z.literal("usage"),
		inputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		cacheReadTokens: z.number().int().nonnegative().optional(),
		cacheWriteTokens: z.number().int().nonnegative().optional(),
		reasoningTokens: z.number().int().nonnegative().optional(),
		cost: z.number().finite().nonnegative().optional(),
	})
	.strict()

/** Provider-neutral error information; stack traces and SDK objects stay out of the record. */
export const agentLifecycleErrorItemSchema = z
	.object({
		...lifecycleItemBaseFields,
		type: z.literal("error"),
		message: z.string(),
		code: z.string().optional(),
		retryable: z.boolean().optional(),
	})
	.strict()

export const agentCompactionStatusSchema = z.enum(["started", "completed"])
export type AgentCompactionStatus = z.infer<typeof agentCompactionStatusSchema>

/** Context compaction marker; the summary itself is deliberately optional. */
export const agentLifecycleCompactionItemSchema = z
	.object({
		...lifecycleItemBaseFields,
		type: z.literal("compaction"),
		status: agentCompactionStatusSchema,
		removedItemCount: z.number().int().nonnegative().optional(),
		previousTokens: z.number().int().nonnegative().optional(),
		newTokens: z.number().int().nonnegative().optional(),
		summary: z.string().optional(),
	})
	.strict()

/** Bounded, human-readable progress with no provider payload. */
const agentLifecycleProgressItemShapeSchema = z
	.object({
		...lifecycleItemBaseFields,
		type: z.literal("progress"),
		message: z.string().optional(),
		text: z.string().optional(),
		percent: z.number().finite().min(0).max(100).optional(),
	})
	.strict()

export const agentLifecycleProgressItemSchema = agentLifecycleProgressItemShapeSchema.superRefine((item, context) => {
	if (item.message === undefined && item.text === undefined) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["message"],
			message: "A progress item must include message or text",
		})
	}
})

/** Every persisted lifecycle item is discriminated by its normalized type. */
export const agentLifecycleItemSchema = z
	.discriminatedUnion("type", [
		agentLifecycleUserItemSchema,
		agentLifecycleAssistantTextItemSchema,
		agentLifecycleAssistantReasoningItemSchema,
		agentLifecycleToolCallItemSchema,
		agentLifecycleToolResultItemShapeSchema,
		agentLifecycleApprovalItemSchema,
		agentLifecycleUsageItemSchema,
		agentLifecycleErrorItemSchema,
		agentLifecycleCompactionItemSchema,
		agentLifecycleProgressItemShapeSchema,
	])
	.superRefine((item, context) => {
		// Zod 3's discriminatedUnion requires plain object options, so the
		// specialized refinements cannot be supplied as union members directly.
		// Re-apply them at the union boundary; otherwise item_added/item_updated
		// silently accept malformed tool results and progress records.
		if (item.type === "tool_result" && item.output === undefined && item.result === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["output"],
				message: "A tool result must include output or result",
			})
		}
		if (item.type === "progress" && item.message === undefined && item.text === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["message"],
				message: "A progress item must include message or text",
			})
		}
	})
export type AgentLifecycleItem = z.infer<typeof agentLifecycleItemSchema>
export type AgentLifecycleUserItem = z.infer<typeof agentLifecycleUserItemSchema>
export type AgentLifecycleAssistantTextItem = z.infer<typeof agentLifecycleAssistantTextItemSchema>
export type AgentLifecycleAssistantReasoningItem = z.infer<typeof agentLifecycleAssistantReasoningItemSchema>
export type AgentLifecycleToolCallItem = z.infer<typeof agentLifecycleToolCallItemSchema>
export type AgentLifecycleToolResultItem = z.infer<typeof agentLifecycleToolResultItemSchema>
export type AgentLifecycleApprovalItem = z.infer<typeof agentLifecycleApprovalItemSchema>
export type AgentLifecycleUsageItem = z.infer<typeof agentLifecycleUsageItemSchema>
export type AgentLifecycleErrorItem = z.infer<typeof agentLifecycleErrorItemSchema>
export type AgentLifecycleCompactionItem = z.infer<typeof agentLifecycleCompactionItemSchema>
export type AgentLifecycleProgressItem = z.infer<typeof agentLifecycleProgressItemSchema>
export const lifecycleItemSchema = agentLifecycleItemSchema
export type LifecycleItem = AgentLifecycleItem

const lifecycleEventEnvelopeFields = {
	version: agentLifecycleVersionSchema,
	eventId: agentEventIdSchema,
	sequence: lifecyclePositiveSequenceSchema,
	taskId: agentTaskIdSchema,
	runId: agentRunIdSchema,
	turnId: agentTurnIdSchema,
	stepId: agentStepIdSchema.optional(),
	occurredAt: lifecycleTimestampSchema,
	/** Correlation is optional for compatibility, but stable when supplied. */
	correlationId: agentEventIdSchema.optional(),
	/** A causation ID points at the event that caused this event. */
	causationId: agentEventIdSchema.optional(),
}

const turnStartedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("turn_started"),
		payload: z
			.object({
				phase: agentLifecyclePhaseSchema.optional(),
			})
			.strict(),
	})
	.strict()

const phaseChangedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("phase_changed"),
		payload: z
			.object({
				phase: agentLifecyclePhaseSchema,
			})
			.strict(),
	})
	.strict()

const stepStartedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		stepId: agentStepIdSchema,
		type: z.literal("step_started"),
		payload: z
			.object({
				phase: agentLifecyclePhaseSchema.optional(),
			})
			.strict(),
	})
	.strict()

const stepStatusChangedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		stepId: agentStepIdSchema,
		type: z.literal("step_status_changed"),
		payload: z
			.object({
				status: z.enum(["in_progress", "completed", "interrupted", "failed"]),
				phase: agentLifecyclePhaseSchema.optional(),
				reason: z.string().optional(),
			})
			.strict(),
	})
	.strict()

const itemAddedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("item_added"),
		payload: z
			.object({
				item: agentLifecycleItemSchema,
			})
			.strict(),
	})
	.strict()

const itemUpdatedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("item_updated"),
		payload: z
			.object({
				item: agentLifecycleItemSchema,
			})
			.strict(),
	})
	.strict()

const toolCallAcceptedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("tool_call_accepted"),
		payload: z
			.object({
				item: agentLifecycleToolCallItemSchema,
			})
			.strict(),
	})
	.strict()

const toolResultRecordedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("tool_result_recorded"),
		payload: z
			.object({
				item: agentLifecycleToolResultItemSchema,
			})
			.strict(),
	})
	.strict()

const approvalRequestedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("approval_requested"),
		payload: z
			.object({
				item: agentLifecycleApprovalItemSchema,
			})
			.strict(),
	})
	.strict()

const approvalResolvedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("approval_resolved"),
		payload: z
			.object({
				item: agentLifecycleApprovalItemSchema,
			})
			.strict(),
	})
	.strict()

const turnStatusChangedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("turn_status_changed"),
		payload: z
			.object({
				status: agentTurnStatusSchema,
				reason: z.string().optional(),
				error: z.string().optional(),
			})
			.strict(),
	})
	.strict()

const turnTerminalEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("turn_terminal"),
		payload: z
			.object({
				status: agentTurnTerminalStatusSchema,
				reason: z.string().optional(),
				error: z.string().optional(),
			})
			.strict(),
	})
	.strict()

const turnCompletedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("turn_completed"),
		payload: z
			.object({
				status: z.literal("completed").default("completed"),
				reason: z.string().optional(),
			})
			.strict(),
	})
	.strict()

const turnInterruptedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("turn_interrupted"),
		payload: z
			.object({
				status: z.literal("interrupted").default("interrupted"),
				reason: z.string().optional(),
			})
			.strict(),
	})
	.strict()

const turnCancelledEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("turn_cancelled"),
		payload: z
			.object({
				reason: z.string().optional(),
			})
			.strict(),
	})
	.strict()

const turnFailedEventSchema = z
	.object({
		...lifecycleEventEnvelopeFields,
		type: z.literal("turn_failed"),
		payload: z
			.object({
				status: z.literal("failed").default("failed"),
				reason: z.string().optional(),
				error: z.string().optional(),
			})
			.strict(),
	})
	.strict()

/**
 * Versioned provider-neutral event envelope. Correlation and causation are
 * references, never provider payloads, and event sequence is checked by the
 * pure reducer rather than by this shape schema.
 */
export const agentLifecycleEventSchema = z.discriminatedUnion("type", [
	turnStartedEventSchema,
	phaseChangedEventSchema,
	stepStartedEventSchema,
	stepStatusChangedEventSchema,
	itemAddedEventSchema,
	itemUpdatedEventSchema,
	toolCallAcceptedEventSchema,
	toolResultRecordedEventSchema,
	approvalRequestedEventSchema,
	approvalResolvedEventSchema,
	turnStatusChangedEventSchema,
	turnTerminalEventSchema,
	turnCompletedEventSchema,
	turnInterruptedEventSchema,
	turnCancelledEventSchema,
	turnFailedEventSchema,
])
export type AgentLifecycleEvent = z.infer<typeof agentLifecycleEventSchema>
export type AgentLifecycleEventType = AgentLifecycleEvent["type"]
export const lifecycleEventSchema = agentLifecycleEventSchema
export type LifecycleEvent = AgentLifecycleEvent
export const agentLifecycleEnvelopeSchema = agentLifecycleEventSchema
export const lifecycleEventEnvelopeSchema = agentLifecycleEventSchema

/**
 * A best-effort lifecycle publisher can temporarily lose its durable
 * projection while the legacy transcript remains usable. This signal is
 * deliberately task-scoped so consumers can fall back without disabling
 * canonical lifecycle state for unrelated tasks.
 */
export const agentLifecycleDegradedSignalSchema = z
	.object({
		version: agentLifecycleVersionSchema,
		taskId: agentTaskIdSchema,
		degraded: z.boolean(),
		reason: z.string().min(1).max(256).optional(),
		error: z.string().max(2_000).optional(),
		occurredAt: lifecycleTimestampSchema,
	})
	.strict()
export type AgentLifecycleDegradedSignal = z.infer<typeof agentLifecycleDegradedSignalSchema>

/** Compatibility aliases for hosts that call the signal an envelope. */
export const agentLifecycleDegradedEnvelopeSchema = agentLifecycleDegradedSignalSchema
export type AgentLifecycleDegradedEnvelope = AgentLifecycleDegradedSignal
export const lifecycleDegradedSignalSchema = agentLifecycleDegradedSignalSchema
export type LifecycleDegradedSignal = AgentLifecycleDegradedSignal

export const agentLifecycleStepStatusSchema = z.enum(["in_progress", "completed", "interrupted", "failed"])
export type AgentLifecycleStepStatus = z.infer<typeof agentLifecycleStepStatusSchema>

/** Durable projection of one step inside a turn. */
export const agentLifecycleStepSnapshotSchema = z
	.object({
		stepId: agentStepIdSchema,
		status: agentLifecycleStepStatusSchema,
		phase: agentLifecyclePhaseSchema.optional(),
		startedAt: lifecycleTimestampSchema.optional(),
		endedAt: lifecycleTimestampSchema.optional(),
		reason: z.string().optional(),
	})
	.strict()
export type AgentLifecycleStepSnapshot = z.infer<typeof agentLifecycleStepSnapshotSchema>

/** Compact event receipt retained for deterministic replay/conflict checks. */
export const agentLifecycleEventReceiptSchema = z
	.object({
		eventId: agentEventIdSchema,
		sequence: lifecyclePositiveSequenceSchema,
		fingerprint: z.string().min(1),
	})
	.strict()
export type AgentLifecycleEventReceipt = z.infer<typeof agentLifecycleEventReceiptSchema>

/**
 * Snapshot consumed by persistence/UI code. The event receipt ledger is part
 * of the snapshot so a restarted host can distinguish exact replay from a
 * conflicting duplicate without retaining provider-specific event payloads.
 */
export const agentLifecycleSnapshotSchema = z
	.object({
		version: agentLifecycleVersionSchema,
		taskId: agentTaskIdSchema,
		runId: agentRunIdSchema,
		turnId: agentTurnIdSchema,
		status: agentTurnStatusSchema,
		phase: agentLifecyclePhaseSchema,
		currentStepId: agentStepIdSchema.optional(),
		lastSequence: z.number().int().nonnegative(),
		terminalEventId: agentEventIdSchema.optional(),
		terminalAt: lifecycleTimestampSchema.optional(),
		items: z.array(agentLifecycleItemSchema),
		steps: z.array(agentLifecycleStepSnapshotSchema),
		acceptedToolCallIds: z.array(agentToolCallIdSchema),
		terminalToolCallIds: z.array(agentToolCallIdSchema),
		processedEvents: z.array(agentLifecycleEventReceiptSchema),
	})
	.strict()
	.superRefine((snapshot, context) => {
		const itemIds = new Set<string>()
		for (const [index, item] of snapshot.items.entries()) {
			if (itemIds.has(item.itemId)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["items", index, "itemId"],
					message: "Lifecycle item IDs must be unique",
				})
			}
			itemIds.add(item.itemId)
		}

		const stepIds = new Set<string>()
		for (const [index, step] of snapshot.steps.entries()) {
			if (stepIds.has(step.stepId)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["steps", index, "stepId"],
					message: "Lifecycle step IDs must be unique",
				})
			}
			stepIds.add(step.stepId)
		}

		const accepted = new Set(snapshot.acceptedToolCallIds)
		const terminal = new Set(snapshot.terminalToolCallIds)
		if (accepted.size !== snapshot.acceptedToolCallIds.length) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["acceptedToolCallIds"],
				message: "Accepted tool call IDs must be unique",
			})
		}
		if (terminal.size !== snapshot.terminalToolCallIds.length) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["terminalToolCallIds"],
				message: "Terminal tool call IDs must be unique",
			})
		}
		for (const [index, toolCallId] of snapshot.terminalToolCallIds.entries()) {
			if (!accepted.has(toolCallId)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["terminalToolCallIds", index],
					message: "A terminal tool result must belong to an accepted tool call",
				})
			}
		}

		const receipts = snapshot.processedEvents
		const receiptIds = new Set<string>()
		for (const [index, receipt] of receipts.entries()) {
			if (receiptIds.has(receipt.eventId)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["processedEvents", index, "eventId"],
					message: "Processed lifecycle event IDs must be unique",
				})
			}
			receiptIds.add(receipt.eventId)
			if (receipt.sequence !== index + 1) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["processedEvents", index, "sequence"],
					message: "Processed lifecycle event sequences must be contiguous",
				})
			}
		}
		if ((receipts.at(-1)?.sequence ?? 0) !== snapshot.lastSequence) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["lastSequence"],
				message: "lastSequence must match the latest processed event",
			})
		}

		const isTerminal = snapshot.status !== "in_progress"
		if (isTerminal && snapshot.terminalEventId === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["terminalEventId"],
				message: "A terminal turn must retain its terminal event ID",
			})
		}
		if (!isTerminal && (snapshot.terminalEventId !== undefined || snapshot.terminalAt !== undefined)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["terminalEventId"],
				message: "An in-progress turn cannot have terminal metadata",
			})
		}
	})
export type AgentLifecycleSnapshot = z.infer<typeof agentLifecycleSnapshotSchema>
export const lifecycleSnapshotSchema = agentLifecycleSnapshotSchema
export type LifecycleSnapshot = AgentLifecycleSnapshot
