import { z } from "zod"

/** Message meaning reported by the provider; absence remains "phase unknown". */
export const assistantMessagePhaseSchema = z.enum(["commentary", "partial_answer", "final_answer"])
export type AssistantMessagePhase = z.infer<typeof assistantMessagePhaseSchema>

/** Additive source metadata for one assistant output message, independent from turn lifecycle. */
export const assistantMessageMetadataSchema = z.object({
	id: z.string().min(1).optional(),
	phase: assistantMessagePhaseSchema.optional(),
	outputIndex: z.number().int().nonnegative().safe().optional(),
})
export type AssistantMessageMetadata = z.infer<typeof assistantMessageMetadataSchema>

/**
 * Read provider or older persisted metadata field by field. A provider which
 * omits a phase or adds an unknown phase still has useful message boundaries.
 */
export function normalizeAssistantMessageMetadata(value: unknown): AssistantMessageMetadata {
	if (!value || typeof value !== "object") return {}
	const source = value as Record<string, unknown>
	const phase = source.phase
	return {
		...(typeof source.id === "string" && source.id.length > 0 ? { id: source.id } : {}),
		...(phase === "commentary" || phase === "partial_answer" || phase === "final_answer" ? { phase } : {}),
		...(typeof source.outputIndex === "number" &&
		Number.isSafeInteger(source.outputIndex) &&
		source.outputIndex >= 0
			? { outputIndex: source.outputIndex }
			: {}),
	}
}
