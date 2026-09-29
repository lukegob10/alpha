import { z } from "zod"

import { subagentChangeSetStateSchema, subagentModelRouteStateSchema, subagentRoleSchema } from "./subagent.js"
import { subagentContextManifestSchema } from "./subagent-context.js"
import { subagentDelegationPolicySchema, subagentStopReasonSchema } from "./subagent-orchestration.js"
import { taskWorkContextSchema } from "./task-work-context.js"
import { taskDesignHandoffSchema } from "./task-design-handoff.js"
import { taskReasoningPreferenceSchema, taskReasoningStateSchema } from "./task-reasoning.js"
import { approvalModeSchema } from "./approval-mode.js"

export const diagnosticTaskIdentitySchema = z.string().trim().min(1).max(128)

/**
 * HistoryItem
 */

export const historyItemSchema = z.object({
	id: z.string(),
	/** True only for host-created Alpha diagnostic sessions with a constrained read-only tool surface. */
	diagnosticSession: z.boolean().optional(),
	/** Bounded host-generated incident identity used to deduplicate diagnostics across reloads. */
	diagnosticIncidentId: diagnosticTaskIdentitySchema.optional(),
	/** Bounded source task identity whose redacted evidence a diagnostic session may inspect. */
	diagnosticSourceTaskId: diagnosticTaskIdentitySchema.optional(),
	/** Independent primary conversation launched by this task; distinct from managed-agent/delegation parentTaskId. */
	orchestrationParentTaskId: z.string().min(1).optional(),
	orchestrationWorkspaceMode: z.enum(["shared", "worktree"]).optional(),
	/** Workspace path below the Git root for restoring an isolated task worktree. Empty means Git root. */
	orchestrationWorkspaceRelativePath: z.string().optional(),
	orchestrationWorkspaceBaselineCommit: z
		.string()
		.regex(/^[0-9a-f]{40,64}$/i)
		.optional(),
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
	reasoningPreference: taskReasoningPreferenceSchema.optional(),
	reasoningState: taskReasoningStateSchema.optional(),
	/** Effective task approval mode, including a task-scoped override. Missing values keep legacy behavior. */
	approvalMode: approvalModeSchema.optional(),
	workContext: taskWorkContextSchema.optional(),
	designHandoff: taskDesignHandoffSchema.optional(),
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
