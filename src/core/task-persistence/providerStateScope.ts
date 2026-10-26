import { z } from "zod"

/** Host provenance for opaque state; it never becomes a provider request field. */
export const providerStateScopeSchema = z
	.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(1_024) })
	.strict()
export type ProviderStateScope = z.infer<typeof providerStateScopeSchema>

/** Old transcripts have no scope; retain their established replay behavior without guessing an origin. */
export function canReplayProviderState(scope: unknown, destination: ProviderStateScope): boolean {
	if (scope === undefined) return true
	const parsed = providerStateScopeSchema.safeParse(scope)
	return (
		parsed.success && parsed.data.provider === destination.provider && parsed.data.modelId === destination.modelId
	)
}

export function isOpaqueProviderContentBlock(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false
	const block = value as Record<string, unknown>
	return (
		(block.type === "reasoning" && (block.encrypted_content !== undefined || block.signature !== undefined)) ||
		block.type === "thinking" ||
		block.type === "redacted_thinking" ||
		block.type === "thoughtSignature" ||
		block.type === "gemini_response" ||
		block.type === "vscode_lm_thinking"
	)
}

export function hasOpaqueProviderState(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false
	const message = value as Record<string, unknown>
	return (
		message.encrypted_content !== undefined ||
		message.vscodeLmStatefulMarker !== undefined ||
		(Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0) ||
		(Array.isArray(message.content) && message.content.some(isOpaqueProviderContentBlock))
	)
}
