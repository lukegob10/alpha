import { createHash } from "crypto"
import stringify from "safe-stable-stringify"
import { z } from "zod"

/** Only trusted runtime callbacks may supply this metadata; tool output is never parsed into it. */
const toolFailureSchema = z.object({
	reason: z.enum([
		"invalid_arguments",
		"capability_unavailable",
		"policy_denied",
		"approval_denied",
		"pre_launch_rejected",
		"execution_failed",
		"outcome_unknown",
		"cancelled",
	]),
	affectedScope: z.object({
		kind: z.enum(["capability", "workspace", "operation"]),
		fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	}),
	effectsStarted: z.enum(["no", "yes", "unknown"]),
	outcome: z.enum(["known", "unknown"]),
	recovery: z.object({
		kind: z.enum(["repair", "alternative", "verify-outcome", "user-action", "none"]),
		toolName: z
			.string()
			.regex(/^[a-z][a-z0-9_.-]{0,127}$/)
			.optional(),
	}),
})

export type ToolFailureMetadata = z.infer<typeof toolFailureSchema>

export function normalizeToolFailure(value: unknown): ToolFailureMetadata | undefined {
	const parsed = toolFailureSchema.safeParse(value)
	if (!parsed.success) return undefined
	const failure = parsed.data
	// Unknown effects require observation before another effect, regardless of a
	// caller's suggested retry strategy. No command, path or error text is retained.
	return failure.outcome === "unknown" || failure.reason === "outcome_unknown"
		? { ...failure, outcome: "unknown", recovery: { kind: "verify-outcome" } }
		: failure
}

export function createToolFailure(
	failure: Omit<ToolFailureMetadata, "affectedScope"> & {
		scopeKind: ToolFailureMetadata["affectedScope"]["kind"]
		scopeIdentity: unknown
	},
): ToolFailureMetadata {
	const { scopeKind, scopeIdentity, ...metadata } = failure
	return {
		...metadata,
		affectedScope: {
			kind: scopeKind,
			fingerprint: createHash("sha256")
				.update(stringify(scopeIdentity) ?? "")
				.digest("hex"),
		},
	}
}

export function formatToolFailureGuidance(failure: ToolFailureMetadata): string {
	if (failure.outcome === "unknown") {
		return "The operation's outcome is unknown. Inspect and reconcile the existing effects before repeating it. Do not report the requested outcome as completed without evidence."
	}
	const cause = {
		invalid_arguments: "The operation was rejected because its arguments are invalid.",
		capability_unavailable: "The required execution capability is unavailable.",
		policy_denied: "The operation is denied by the current execution policy.",
		approval_denied: "The requested operation was not approved.",
		pre_launch_rejected: "The operation did not start because its execution prerequisite failed.",
		execution_failed: "The operation finished unsuccessfully.",
		outcome_unknown: "The operation's outcome is unknown.",
		cancelled: "The operation was cancelled.",
	}[failure.reason]
	const recovery = {
		repair: "Correct the reported prerequisite or failure before retrying the same operation.",
		alternative: `Use the supported ${failure.recovery.toolName ?? "alternative"} path if it is authorized for the requested outcome.`,
		"verify-outcome": "Inspect and reconcile the existing effects before repeating the operation.",
		"user-action": "Continue independent authorized work, or report the limitation if this operation is required.",
		none: "Use the existing evidence and report any remaining limitation accurately.",
	}[failure.recovery.kind]
	return `${cause} ${recovery}`
}
