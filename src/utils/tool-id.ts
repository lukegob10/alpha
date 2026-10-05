import * as crypto from "crypto"

export class ToolHistoryError extends Error {
	constructor(
		readonly code:
			| "conflicting_tool_call_ids"
			| "conflicting_tool_result_ids"
			| "invalid_tool_call"
			| "invalid_tool_result_id"
			| "conflicting_tool_results"
			| "duplicate_open_tool_call",
	) {
		super(`Invalid tool history: ${code}`)
		this.name = "ToolHistoryError"
	}
}

/** Resolve accepted persisted aliases without changing the model-visible ID. */
export function getToolCallId(block: unknown): string | undefined {
	if (!isRecord(block) || (block.type !== "tool_use" && block.type !== "tool_call")) return undefined
	return resolveToolId(block.id, block.tool_call_id, "conflicting_tool_call_ids")
}

/** Empty legacy/canonical fields may fall back; different nonempty IDs are ambiguous. */
export function getToolResultId(block: unknown): string | undefined {
	if (!isRecord(block) || block.type !== "tool_result") return undefined
	return resolveToolId(block.tool_use_id, block.tool_call_id, "conflicting_tool_result_ids")
}

function resolveToolId(
	canonical: unknown,
	legacy: unknown,
	conflict: "conflicting_tool_call_ids" | "conflicting_tool_result_ids",
): string | undefined {
	const canonicalId = typeof canonical === "string" && canonical.length > 0 ? canonical : undefined
	const legacyId = typeof legacy === "string" && legacy.length > 0 ? legacy : undefined
	if (canonicalId !== undefined && legacyId !== undefined && canonicalId !== legacyId) {
		throw new ToolHistoryError(conflict)
	}
	return canonicalId ?? legacyId
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * OpenAI Responses API maximum length for call_id field.
 * This limit applies to both function_call and function_call_output items.
 */
export const OPENAI_CALL_ID_MAX_LENGTH = 64

/**
 * Sanitize a tool_use ID to match API validation pattern: ^[a-zA-Z0-9_-]+$
 * Replaces any invalid character with underscore.
 */
export function sanitizeToolUseId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * Truncate a call_id to fit within OpenAI's 64-character limit.
 * Uses a hash suffix to maintain uniqueness when truncation is needed.
 *
 * @param id - The original call_id
 * @param maxLength - Maximum length (defaults to OpenAI's 64-char limit)
 * @returns The truncated ID, or original if already within limits
 */
export function truncateOpenAiCallId(id: string, maxLength: number = OPENAI_CALL_ID_MAX_LENGTH): string {
	if (id.length <= maxLength) {
		return id
	}

	// Use 8-char hash suffix for uniqueness (from MD5, sufficient for collision resistance in this context)
	const hashSuffixLength = 8
	const separator = "_"
	// Reserve space for separator + hash
	const prefixMaxLength = maxLength - separator.length - hashSuffixLength

	// Create hash of the full original ID for uniqueness
	const hash = crypto.createHash("md5").update(id).digest("hex").slice(0, hashSuffixLength)

	// Take the prefix and append hash
	const prefix = id.slice(0, prefixMaxLength)
	return `${prefix}${separator}${hash}`
}

/**
 * Sanitize and truncate a tool call ID for OpenAI's Responses API.
 * This combines character sanitization with length truncation.
 *
 * @param id - The original call_id
 * @param maxLength - Maximum length (defaults to OpenAI's 64-char limit)
 * @returns The sanitized and truncated ID
 */
export function sanitizeOpenAiCallId(id: string, maxLength: number = OPENAI_CALL_ID_MAX_LENGTH): string {
	// First sanitize characters, then truncate
	const sanitized = sanitizeToolUseId(id)
	return truncateOpenAiCallId(sanitized, maxLength)
}
