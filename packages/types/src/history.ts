import { z } from "zod"

import { subagentChangeSetStateSchema, subagentModelRouteStateSchema, subagentRoleSchema } from "./subagent.js"
import { subagentContextManifestSchema } from "./subagent-context.js"
import { subagentDelegationPolicySchema, subagentStopReasonSchema } from "./subagent-orchestration.js"

/**
 * HistoryItem
 */

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	mode: z.string().optional(),
	apiConfigName: z.string().optional(), // Provider profile name for sticky profile feature
	status: z
		.enum(["active", "completed", "blocked", "delegated", "failed", "cancelled", "timed_out", "interrupted"])
		.optional(),
	delegatedToId: z.string().optional(), // Last child this parent delegated to
	childIds: z.array(z.string()).optional(), // All children spawned by this task
	awaitingChildId: z.string().optional(), // Child currently awaited (set when delegated)
	completedByChildId: z.string().optional(), // Child that completed and resumed this parent
	completionResultSummary: z.string().optional(), // Summary from completed child
	taskKind: z.enum(["primary", "subagent"]).optional(),
	/** Frozen effective task policy used on reload instead of current settings. */
	subagentDelegationPolicy: subagentDelegationPolicySchema.optional(),
	/** Trusted, persisted user-authored opt-in required for auto-approved explicit-only delegation. */
	subagentDelegationExplicitlyEnabled: z.boolean().optional(),
	stopReason: subagentStopReasonSchema.optional(),
	subagentGroupId: z.string().optional(),
	subagentNickname: z.string().optional(),
	subagentRole: subagentRoleSchema.optional(),
	subagentWriteScope: z.array(z.string()).optional(),
	subagentChangeSet: subagentChangeSetStateSchema.optional(),
	subagentModelRoute: subagentModelRouteStateSchema.optional(),
	subagentContextManifest: subagentContextManifestSchema.optional(),
	subagentInstructionPlacement: z.literal("system").optional(),
})

export type HistoryItem = z.infer<typeof historyItemSchema>
