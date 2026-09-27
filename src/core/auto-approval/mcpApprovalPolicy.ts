import type { McpToolAnnotations } from "@alpha-code/types"

export type McpToolApprovalMode = "auto" | "prompt" | "writes" | "approve"

const KNOWN_ANNOTATION_KEYS = new Set([
	"title",
	"audience",
	"priority",
	"lastModified",
	"readOnlyHint",
	"destructiveHint",
	"idempotentHint",
	"openWorldHint",
])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasValidAnnotations(value: unknown): value is McpToolAnnotations {
	if (!isRecord(value) || Object.keys(value).some((key) => !KNOWN_ANNOTATION_KEYS.has(key))) {
		return false
	}

	if (value.title !== undefined && typeof value.title !== "string") return false
	if (
		value.audience !== undefined &&
		(!Array.isArray(value.audience) || value.audience.some((item) => item !== "user" && item !== "assistant"))
	) {
		return false
	}
	if (value.priority !== undefined && (typeof value.priority !== "number" || !Number.isFinite(value.priority))) {
		return false
	}
	if (value.lastModified !== undefined && typeof value.lastModified !== "string") return false
	if (
		["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].some(
			(key) => value[key] !== undefined && typeof value[key] !== "boolean",
		)
	) {
		return false
	}

	return true
}

/**
 * Decide whether an MCP tool needs a user prompt under the selected policy.
 * Missing, malformed, and unrecognized annotations always require review.
 */
export function requiresMcpToolApproval(mode: unknown, annotations?: unknown): boolean {
	if (mode === "approve") return false
	if (mode === "prompt" || (mode !== "auto" && mode !== "writes")) return true
	if (!hasValidAnnotations(annotations)) return true

	if (mode === "writes") {
		return annotations.readOnlyHint !== true || annotations.destructiveHint === true
	}

	if (annotations.destructiveHint === true) return true
	if (annotations.readOnlyHint === true) return false
	return annotations.destructiveHint !== false || annotations.openWorldHint !== false
}
