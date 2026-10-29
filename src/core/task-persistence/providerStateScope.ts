import { z } from "zod"
import type { ApiMessage } from "./apiMessages"

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

/** An explicit route boundary revokes replay even when legacy provenance is unknown. */
export function canReplayMessageProviderState(
	message: { provider_state_scope?: unknown; provider_state_replay_disabled?: unknown },
	destination: ProviderStateScope,
): boolean {
	return (
		message.provider_state_replay_disabled === undefined &&
		canReplayProviderState(message.provider_state_scope, destination)
	)
}

/** Keep canonical evidence intact while durably preventing continuation through another account or endpoint. */
export function invalidateOpaqueProviderStateReplay(messages: readonly ApiMessage[]): ApiMessage[] {
	return messages.map((message) => {
		if (
			(message.role !== "assistant" && !(message.role === undefined && message.type === "reasoning")) ||
			!hasOpaqueProviderState(message) ||
			message.provider_state_replay_disabled === true
		) {
			return message
		}
		return { ...message, provider_state_replay_disabled: true }
	})
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
