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
export type SubagentChangeSetStatus = z.infer<typeof subagentChangeSetStatusSchema>

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

/** Authoritative runtime decision for a parent-side external mutation. */
export interface ExternalMutationCapability {
	allowed: boolean
	state: "available" | "busy" | "unavailable"
	reason: string
}

/** Webview-facing capability for one quarantined Worker change set. */
export interface SubagentChangeSetActionCapability extends ExternalMutationCapability {
	taskId: string
	groupId: string
	changeSetId: string
}

export type SubagentChangeSetAction = "apply" | "discard"

/** Explicit provider result returned for Apply/Discard requests. */
export interface SubagentChangeSetActionResult {
	action: SubagentChangeSetAction
	taskId: string
	groupId: string
	changeSetId: string
	success: boolean
	changeSetStatus?: SubagentChangeSetStatus
	message: string
	capability?: SubagentChangeSetActionCapability
}

/**
 * Durable parent-verification lifecycle for one material Worker change set.
 *
 * `required` is intentionally nonblocking: the proposal is still quarantined.
 * Only applied changes (`pending` or `failed`) block parent completion.
 */
export const parentVerificationStatusSchema = z.enum([
	"required",
	"pending",
	"satisfied",
	"failed",
	"superseded",
	"not_applicable",
])
export type ParentVerificationStatus = z.infer<typeof parentVerificationStatusSchema>

export const parentVerificationReviewSchema = z.object({
	decision: z.enum(["approved", "rejected"]),
	source: z.enum(["apply", "discard", "recovered_application", "recovered_disposition"]),
	recordedAt: z.number().int().nonnegative(),
})
export type ParentVerificationReview = z.infer<typeof parentVerificationReviewSchema>

export const parentVerificationEvidenceSchema = z.object({
	status: z.enum(["passed", "failed"]),
	toolCallId: z.string().min(1),
	executionId: z.string().min(1),
	startedAt: z.number().int().nonnegative(),
	completedAt: z.number().int().nonnegative(),
	exitCode: z.number().int().optional(),
	signalName: z.string().optional(),
	/** Credential-free explanation of why this command was relevant. */
	matchedFiles: z.array(z.string().min(1)).min(1).optional(),
})
export type ParentVerificationEvidence = z.infer<typeof parentVerificationEvidenceSchema>

export const parentVerificationObligationSchema = z
	.object({
		id: z.string().min(1),
		rootTaskId: z.string().min(1),
		parentTaskId: z.string().min(1),
		workerTaskId: z.string().min(1),
		workerPath: z.string().min(1).optional(),
		workerNickname: z.string().min(1),
		groupId: z.string().min(1),
		changeSetId: z.string().min(1),
		changedFiles: z.array(z.string().min(1)).min(1),
		status: parentVerificationStatusSchema,
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
		review: parentVerificationReviewSchema.optional(),
		appliedAt: z.number().int().nonnegative().optional(),
		verification: parentVerificationEvidenceSchema.optional(),
		supersededByChangeSetId: z.string().min(1).optional(),
		reason: z.string().min(1).optional(),
	})
	.superRefine((obligation, context) => {
		const applied = ["pending", "satisfied", "failed"].includes(obligation.status)
		if (applied && (obligation.review?.decision !== "approved" || obligation.appliedAt === undefined)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Applied verification obligations require an approved review and appliedAt",
				path: ["status"],
			})
		}
		if (obligation.status === "satisfied" && obligation.verification?.status !== "passed") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Satisfied verification obligations require passing evidence",
				path: ["verification"],
			})
		}
		if (obligation.status === "failed" && obligation.verification?.status !== "failed") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Failed verification obligations require failing evidence",
				path: ["verification"],
			})
		}
		if (obligation.status === "superseded" && !obligation.supersededByChangeSetId) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Superseded verification obligations require a replacement change-set ID",
				path: ["supersededByChangeSetId"],
			})
		}
	})
export type ParentVerificationObligation = z.infer<typeof parentVerificationObligationSchema>

/** Compact projection used by lifecycle/list/chat surfaces. */
export const parentVerificationSummarySchema = z.object({
	status: parentVerificationStatusSchema,
	blocking: z.boolean(),
	obligationCount: z.number().int().positive(),
	unresolvedCount: z.number().int().nonnegative(),
	changeSetId: z.string().min(1).optional(),
	updatedAt: z.number().int().nonnegative(),
	message: z.string().min(1),
})
export type ParentVerificationSummary = z.infer<typeof parentVerificationSummarySchema>
