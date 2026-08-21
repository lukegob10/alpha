import { z } from "zod"

import {
	agentCanonicalPathSchema,
	agentControlRoleSchema,
	agentLifecycleStatusSchema,
	agentMailboxKindSchema,
} from "./agent-control.js"
import {
	subagentDelegationPolicySchema,
	subagentEffectiveLimitsSchema,
	subagentRootCostBudgetSchema,
	subagentRootTokenBudgetSchema,
	subagentStopReasonSchema,
	subagentUsageSchema,
} from "./subagent-orchestration.js"

export const MAX_MANAGED_AGENT_TREE_NODES = 256
export const MAX_MANAGED_AGENT_TREE_ACTIVITY = 50

export const managedAgentTreeAttentionSchema = z
	.object({
		kind: z.enum(["approval", "input"]),
		label: z.string().min(1).max(240),
	})
	.strict()
export type ManagedAgentTreeAttention = z.infer<typeof managedAgentTreeAttentionSchema>

/** Credential- and report-body-free node projected from the durable agent registry. */
export const managedAgentTreeNodeProjectionSchema = z
	.object({
		taskId: z.string().min(1),
		rootTaskId: z.string().min(1),
		parentTaskId: z.string().min(1).optional(),
		groupId: z.string().min(1).optional(),
		path: agentCanonicalPathSchema,
		nickname: z.string().min(1).max(120),
		role: agentControlRoleSchema,
		objective: z.string().max(1_000),
		status: agentLifecycleStatusSchema,
		phase: z.string().min(1).max(100).optional(),
		createdAt: z.number().nonnegative(),
		updatedAt: z.number().nonnegative(),
		startedAt: z.number().nonnegative().optional(),
		finishedAt: z.number().nonnegative().optional(),
		depth: z.number().int().nonnegative(),
		maxDepth: z.number().int().nonnegative().optional(),
		delegationPolicy: subagentDelegationPolicySchema.optional(),
		effectiveLimits: subagentEffectiveLimitsSchema.optional(),
		stopReason: subagentStopReasonSchema.optional(),
		usage: subagentUsageSchema,
		attention: managedAgentTreeAttentionSchema.optional(),
	})
	.strict()
export type ManagedAgentTreeNodeProjection = z.infer<typeof managedAgentTreeNodeProjectionSchema>

/** Bounded activity metadata. Durable mailbox payload/report bodies are intentionally omitted. */
export const managedAgentTreeActivityProjectionSchema = z
	.object({
		eventId: z.string().min(1),
		sequence: z.number().int().positive(),
		createdAt: z.number().nonnegative(),
		senderTaskId: z.string().min(1).optional(),
		senderPath: agentCanonicalPathSchema.optional(),
		kind: agentMailboxKindSchema,
		name: z.string().min(1).max(120),
		summary: z.string().min(1).max(240),
		unread: z.boolean(),
	})
	.strict()
export type ManagedAgentTreeActivityProjection = z.infer<typeof managedAgentTreeActivityProjectionSchema>

export const managedAgentTreeProjectionSchema = z
	.object({
		version: z.literal(1),
		rootTaskId: z.string().min(1),
		observedAt: z.number().nonnegative(),
		reloadedAt: z.number().nonnegative().optional(),
		nodes: z.array(managedAgentTreeNodeProjectionSchema).min(1).max(MAX_MANAGED_AGENT_TREE_NODES),
		activity: z.array(managedAgentTreeActivityProjectionSchema).max(MAX_MANAGED_AGENT_TREE_ACTIVITY),
		capacity: z
			.object({
				active: z.number().int().nonnegative(),
				queued: z.number().int().nonnegative(),
				terminal: z.number().int().nonnegative(),
				limit: z.number().int().positive(),
			})
			.strict(),
		budgets: z
			.object({
				tokenLimit: subagentRootTokenBudgetSchema,
				costLimit: subagentRootCostBudgetSchema,
			})
			.strict(),
		omittedNodeCount: z.number().int().nonnegative(),
		omittedActivityCount: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine(({ rootTaskId, nodes, capacity, omittedNodeCount }, context) => {
		const seenTaskIds = new Set<string>()
		for (const [index, node] of nodes.entries()) {
			if (node.rootTaskId !== rootTaskId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "managed-agent node rootTaskId must match the projection root",
					path: ["nodes", index, "rootTaskId"],
				})
			}
			if (seenTaskIds.has(node.taskId)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "managed-agent node taskId must be unique within the projection",
					path: ["nodes", index, "taskId"],
				})
			}
			seenTaskIds.add(node.taskId)
		}

		const roots = nodes.filter((node) => node.role === "root")
		const root = roots[0]
		if (
			roots.length !== 1 ||
			root === undefined ||
			root.taskId !== rootTaskId ||
			root.path !== "/root" ||
			root.depth !== 0 ||
			root.parentTaskId !== undefined
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "managed-agent projection must contain exactly one canonical root node",
				path: ["nodes"],
			})
		}

		const projectedDescendantCount = Math.max(0, nodes.length - 1) + omittedNodeCount
		if (capacity.active + capacity.queued + capacity.terminal !== projectedDescendantCount) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "managed-agent capacity counts must cover every projected or omitted descendant",
				path: ["capacity"],
			})
		}
	})
export type ManagedAgentTreeProjection = z.infer<typeof managedAgentTreeProjectionSchema>
