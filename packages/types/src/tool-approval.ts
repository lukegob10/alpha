import { z } from "zod"

import { alphaAskSchema } from "./message.js"
import {
	exactCommandApprovalAmendmentSchema,
	persistentCommandPrefixAmendmentSchema,
} from "./tool-approval-amendment.js"

export {
	exactCommandApprovalAmendmentSchema,
	persistentCommandPrefixAmendmentSchema,
	toolApprovalAmendmentSchema,
} from "./tool-approval-amendment.js"
export type { PersistentCommandPrefixAmendment, ToolApprovalAmendment } from "./tool-approval-amendment.js"

export const TOOL_APPROVAL_DECISION_KINDS = [
	"approve_once",
	"approve_session",
	"approve_with_amendment",
	"approve_persistently",
	"deny",
	"abort",
	"timeout",
] as const

export const TOOL_APPROVAL_AVAILABLE_DECISIONS = [
	"approve_once",
	"approve_session",
	"approve_with_amendment",
	"approve_persistently",
	"deny",
	"abort",
] as const

export const toolApprovalDecisionSchema = z.discriminatedUnion("decision", [
	z.object({ decision: z.literal("approve_once") }).strict(),
	z.object({ decision: z.literal("approve_session") }).strict(),
	z
		.object({
			decision: z.literal("approve_with_amendment"),
			amendment: exactCommandApprovalAmendmentSchema,
		})
		.strict(),
	z
		.object({
			decision: z.literal("approve_persistently"),
			amendment: persistentCommandPrefixAmendmentSchema,
		})
		.strict(),
	z
		.object({
			decision: z.literal("deny"),
			feedback: z.string().max(20_000).optional(),
		})
		.strict(),
	z.object({ decision: z.literal("abort") }).strict(),
	z.object({ decision: z.literal("timeout") }).strict(),
])

export type ToolApprovalDecision = z.infer<typeof toolApprovalDecisionSchema>
export type ToolApprovalDecisionKind = (typeof TOOL_APPROVAL_DECISION_KINDS)[number]
export type ToolApprovalAvailableDecision = (typeof TOOL_APPROVAL_AVAILABLE_DECISIONS)[number]

export const toolApprovalRequestSchema = z
	.object({
		requestId: z.string().min(1).max(512),
		taskId: z.string().min(1).max(512),
		callId: z.string().min(1).max(512),
		toolName: z.string().min(1).max(128),
		askType: alphaAskSchema,
		/** The reviewed action summary. Tool arguments are intentionally not included. */
		description: z.string().max(100_000).optional(),
		/** Effective working directory shown for command approvals; never used as an authority grant. */
		cwd: z.string().min(1).max(4_096).optional(),
		forceApproval: z.boolean(),
		requiresExplicitApproval: z.boolean(),
		commandPathApproval: z
			.object({
				outsidePaths: z.array(z.string().min(1).max(4096)).max(128),
				unresolved: z.boolean(),
			})
			.strict()
			.optional(),
		availableDecisions: z.array(z.enum(TOOL_APPROVAL_AVAILABLE_DECISIONS)).min(1),
		/** Present only when the exact reviewed command can be granted for this task session. */
		proposedAmendment: exactCommandApprovalAmendmentSchema.optional(),
		/** Present only when a static reviewed command can be saved as a persistent allow prefix. */
		proposedPersistentAmendment: persistentCommandPrefixAmendmentSchema.optional(),
	})
	.strict()
	.superRefine((request, context) => {
		if (request.cwd !== undefined && request.askType !== "command") {
			context.addIssue({
				code: "custom",
				message: "A working directory can only be included with a command approval.",
				path: ["cwd"],
			})
		}
		const decisions = new Set(request.availableDecisions)
		if (decisions.has("approve_session") && (request.forceApproval || request.requiresExplicitApproval)) {
			context.addIssue({
				code: "custom",
				message: "Session approval is unavailable for forced or explicit approval requests.",
				path: ["availableDecisions"],
			})
		}
		if (decisions.has("approve_with_amendment") && (request.forceApproval || request.requiresExplicitApproval)) {
			context.addIssue({
				code: "custom",
				message: "A task-session exact-command grant is unavailable for forced or explicit approvals.",
				path: ["availableDecisions"],
			})
		}
		if (decisions.has("approve_with_amendment") !== (request.proposedAmendment !== undefined)) {
			context.addIssue({
				code: "custom",
				message: "An exact-command session grant must be offered with its reviewed command.",
				path: ["availableDecisions"],
			})
		}
		if (decisions.has("approve_persistently") !== (request.proposedPersistentAmendment !== undefined)) {
			context.addIssue({
				code: "custom",
				message: "A persistent command approval must include its reviewed prefix.",
				path: ["availableDecisions"],
			})
		}
		if (decisions.has("approve_persistently") && (request.forceApproval || request.requiresExplicitApproval)) {
			context.addIssue({
				code: "custom",
				message: "A persistent command approval is unavailable for forced or explicit approvals.",
				path: ["availableDecisions"],
			})
		}
		if (
			request.proposedPersistentAmendment &&
			(request.askType !== "command" ||
				request.description?.trim() !== request.proposedPersistentAmendment.prefix)
		) {
			context.addIssue({
				code: "custom",
				message: "A persistent command prefix must match the command shown for approval.",
				path: ["proposedPersistentAmendment"],
			})
		}
		if (decisions.has("approve_with_amendment") && request.commandPathApproval) {
			context.addIssue({
				code: "custom",
				message: "An exact-command session grant cannot widen an out-of-scope path request.",
				path: ["availableDecisions"],
			})
		}
		if (decisions.has("approve_persistently") && request.commandPathApproval) {
			context.addIssue({
				code: "custom",
				message: "A persistent command approval cannot widen an out-of-scope path request.",
				path: ["availableDecisions"],
			})
		}
		if (
			request.proposedAmendment &&
			(request.askType !== "command" || request.description !== request.proposedAmendment.command)
		) {
			context.addIssue({
				code: "custom",
				message: "An exact-command session grant must match the command shown for approval.",
				path: ["proposedAmendment"],
			})
		}
	})

export type ToolApprovalRequest = z.infer<typeof toolApprovalRequestSchema>
