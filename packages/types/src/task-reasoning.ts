import { z } from "zod"

import { reasoningEffortExtendedSchema, type ReasoningEffortExtended } from "./model.js"

/**
 * A task-level reasoning choice. This value is deliberately separate from a
 * saved provider profile: selecting a different level must not rewrite the
 * profile or create a second profile.
 */
export const taskReasoningCustomTokenPattern = /^[a-z0-9_-]{1,32}$/
export const taskReasoningCustomTokenSchema = z.string().regex(taskReasoningCustomTokenPattern)

export const taskReasoningPreferenceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("default") }),
	z.object({ kind: z.literal("effort"), effort: reasoningEffortExtendedSchema }),
	z.object({ kind: z.literal("off") }),
	z.object({ kind: z.literal("on") }),
	z.object({ kind: z.literal("custom"), value: taskReasoningCustomTokenSchema }),
])

export type TaskReasoningPreference = z.infer<typeof taskReasoningPreferenceSchema>

export const taskReasoningCapabilityKinds = ["effort", "binary", "budget", "custom", "unavailable"] as const
export const taskReasoningCapabilityKindSchema = z.enum(taskReasoningCapabilityKinds)

export const taskReasoningCapabilitiesSchema = z.object({
	kind: taskReasoningCapabilityKindSchema,
	efforts: z.array(reasoningEffortExtendedSchema).optional(),
	canDisable: z.boolean(),
	budgetTokens: z.number().int().positive().optional(),
})

export type TaskReasoningCapabilities = z.infer<typeof taskReasoningCapabilitiesSchema>

/** Stable machine values for explaining why a requested choice was changed. */
export const taskReasoningFallbackReasons = [
	"unsupported",
	"unavailable",
	"required",
	"budget-only",
	"invalid-custom",
] as const
export const taskReasoningFallbackReasonSchema = z.enum(taskReasoningFallbackReasons)
export type TaskReasoningFallbackReason = z.infer<typeof taskReasoningFallbackReasonSchema>

export const taskReasoningStateSchema = z.object({
	requested: taskReasoningPreferenceSchema,
	effective: taskReasoningPreferenceSchema,
	capabilities: taskReasoningCapabilitiesSchema,
	fallbackReason: taskReasoningFallbackReasonSchema.optional(),
})

export type TaskReasoningState = z.infer<typeof taskReasoningStateSchema>

/** Narrow runtime-only extension used by the Stellar adapter for custom tokens. */
export type TaskReasoningCustomEffort = Extract<TaskReasoningPreference, { kind: "custom" }>["value"]

export const isReasoningEffort = (value: unknown): value is ReasoningEffortExtended =>
	reasoningEffortExtendedSchema.safeParse(value).success
