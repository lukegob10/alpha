import { z } from "zod"

export const parallelAgentStatuses = ["running", "completed", "failed", "cancelled", "closed"] as const

export const parallelAgentStatusSchema = z.enum(parallelAgentStatuses)

export const workspaceStrategies = ["auto", "sameWorktree", "newWorktree"] as const

export const workspaceStrategySchema = z.enum(workspaceStrategies)

export const resolvedWorkspaceStrategies = ["sameWorktree", "newWorktree"] as const

export const resolvedWorkspaceStrategySchema = z.enum(resolvedWorkspaceStrategies)

export const parallelAgentResultSchema = z.object({
	summary: z.string(),
	changedFiles: z.array(z.string()).default([]),
	validation: z.string().optional(),
	workspacePath: z.string().optional(),
	integrated: z.boolean().optional(),
})

export const parallelAgentRecordSchema = z.object({
	id: z.string(),
	parentTaskId: z.string(),
	childTaskId: z.string().optional(),
	taskName: z.string(),
	message: z.string(),
	mode: z.string().optional(),
	agentRole: z.string().optional(),
	status: parallelAgentStatusSchema,
	workspaceStrategy: workspaceStrategySchema,
	resolvedWorkspaceStrategy: resolvedWorkspaceStrategySchema,
	workspacePath: z.string().optional(),
	baseBranch: z.string().optional(),
	branch: z.string().optional(),
	writeScopes: z.array(z.string()).default([]),
	createdAt: z.number(),
	updatedAt: z.number(),
	completedAt: z.number().optional(),
	error: z.string().optional(),
	result: parallelAgentResultSchema.optional(),
})

export type ParallelAgentStatus = z.infer<typeof parallelAgentStatusSchema>
export type WorkspaceStrategy = z.infer<typeof workspaceStrategySchema>
export type ResolvedWorkspaceStrategy = z.infer<typeof resolvedWorkspaceStrategySchema>
export type ParallelAgentResult = z.infer<typeof parallelAgentResultSchema>
export type ParallelAgentRecord = z.infer<typeof parallelAgentRecordSchema>
