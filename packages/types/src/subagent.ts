import { z } from "zod"

/** Persisted, credential-free snapshot of the model route selected for a sub-agent. */
export const subagentModelRouteStateSchema = z.object({
	source: z.enum(["parent", "default", "role"]),
	resolution: z.enum(["selected", "fallback"]),
	profileId: z.string().optional(),
	profileName: z.string(),
	provider: z.string().optional(),
	modelId: z.string().optional(),
	requestedProfileId: z.string().optional(),
	fallbackReason: z.enum(["missing", "unconfigured"]).optional(),
})

export type SubagentModelRouteState = z.infer<typeof subagentModelRouteStateSchema>

export const subagentRoleSchema = z.enum(["explore", "review", "worker"])
export type SubagentRole = z.infer<typeof subagentRoleSchema>

export const subagentAuthorityGrantSchema = z.discriminatedUnion("role", [
	z.object({
		role: z.enum(["explore", "review"]),
		logicalWorkspace: z.string(),
		approvalProvenance: z.enum(["group", "auto"]),
	}),
	z.object({
		role: z.literal("worker"),
		logicalWorkspace: z.string(),
		writeScope: z.array(z.string()).min(1).max(12),
		fileWriteScope: z.array(z.string()).optional(),
		approvalProvenance: z.enum(["group", "auto"]),
	}),
])
export type SubagentAuthorityGrant = z.infer<typeof subagentAuthorityGrantSchema>

export const subagentVerificationSchema = z.object({
	label: z.string(),
	status: z.enum(["running", "passed", "failed", "not_run"]),
	detail: z.string().optional(),
})
export type SubagentVerification = z.infer<typeof subagentVerificationSchema>

export const subagentChangeSetStatusSchema = z.enum([
	"pending_review",
	"conflicted",
	"applied",
	"discarded",
	"scope_violation",
	"unavailable",
])

export const subagentChangeSetStateSchema = z.object({
	id: z.string(),
	status: subagentChangeSetStatusSchema,
	changedFiles: z.array(z.string()),
	createdAt: z.number(),
	updatedAt: z.number(),
	partial: z.boolean().optional(),
	conflictPaths: z.array(z.string()).optional(),
	error: z.string().optional(),
})
export type SubagentChangeSetState = z.infer<typeof subagentChangeSetStateSchema>
