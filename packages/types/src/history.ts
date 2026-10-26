import { z } from "zod"

import { subagentChangeSetStateSchema, subagentModelRouteStateSchema, subagentRoleSchema } from "./subagent.js"
import { subagentContextManifestSchema } from "./subagent-context.js"
import { subagentDelegationPolicySchema, subagentStopReasonSchema } from "./subagent-orchestration.js"
import { taskWorkContextSchema } from "./task-work-context.js"
import { taskDesignHandoffSchema } from "./task-design-handoff.js"
import { taskReasoningPreferenceSchema, taskReasoningStateSchema } from "./task-reasoning.js"
import { approvalModeSchema } from "./approval-mode.js"
import { taskMemoryStateSchema } from "./memory.js"

export const diagnosticTaskIdentitySchema = z.string().trim().min(1).max(128)

/** User-owned label; the original task prompt remains unchanged. */
export const taskDisplayNameSchema = z.string().trim().min(1).max(96)

/** Automatically generated short label; the original task prompt remains unchanged. */
export const taskGeneratedTitleSchema = z
	.string()
	.trim()
	.min(1)
	.refine((value) => Array.from(value).length <= 36, "Generated titles must be at most 36 characters")

/** Delivery receipts contain identities only; result text stays in the task transcript and recipient inbox. */
export const orchestrationCompletionNotificationSchema = z.object({
	id: z.string().min(1).max(256),
	turnId: z.string().min(1).max(128),
	completionMessageTs: z.number().finite(),
	createdAt: z.number().finite(),
	deliveredAt: z.number().finite().optional(),
	deliveredVia: z.enum(["inbox", "wait"]).optional(),
})

/**
 * HistoryItem
 */

export const historyItemSchema = z.object({
	id: z.string(),
	memory: taskMemoryStateSchema.optional(),
	/** True only for host-created Alpha diagnostic sessions with a constrained read-only tool surface. */
	diagnosticSession: z.boolean().optional(),
	/** Bounded host-generated incident identity used to deduplicate diagnostics across reloads. */
	diagnosticIncidentId: diagnosticTaskIdentitySchema.optional(),
	/** Bounded source task identity whose redacted evidence a diagnostic session may inspect. */
	diagnosticSourceTaskId: diagnosticTaskIdentitySchema.optional(),
	/** Independent primary conversation launched by this task; distinct from managed-agent/delegation parentTaskId. */
	orchestrationParentTaskId: z.string().min(1).optional(),
	/** Legacy task creation reports automatically; native thread tools observe results with wait_threads. */
	orchestrationNotifyCompletion: z.boolean().optional(),
	/** Bounded durable completion outbox. Undelivered receipts must never be evicted. */
	orchestrationCompletionNotifications: z.array(orchestrationCompletionNotificationSchema).max(100).optional(),
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
	displayName: taskDisplayNameSchema.optional(),
	generatedTitle: taskGeneratedTitleSchema.optional(),
	/** Persisted host opt-out of optional automatic title and reasoning-synopsis model calls. */
	presentationModelCalls: z.literal(false).optional(),
	/** Archived conversations remain readable and restorable, outside the active thread inventory. */
	archived: z.boolean().optional(),
	/** Source conversation identity; a fork has its own lifecycle, mailbox, and accounting. */
	forkedFromId: z.string().min(1).max(64).optional(),
	/** A fork may share the source's managed worktree without claiming ownership of that directory. */
	orchestrationWorkspaceTaskId: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
		.optional(),
	/** Explicit task-local model selection; provider credentials and policy remain in the saved profile. */
	threadModelOverride: z.string().trim().min(1).max(256).optional(),
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

export function getTaskDisplayName(
	item: Pick<HistoryItem, "task"> & Partial<Pick<HistoryItem, "displayName" | "generatedTitle">>,
): string {
	return item.displayName?.trim() || item.generatedTitle?.trim() || item.task
}
