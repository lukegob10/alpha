import { z } from "zod"

import { parallelAgentStatusSchema, workspaceStrategySchema } from "./parallel-agent.js"

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
	status: z.enum(["active", "completed", "delegated"]).optional(),
	delegatedToId: z.string().optional(), // Last child this parent delegated to
	childIds: z.array(z.string()).optional(), // All children spawned by this task
	runningChildIds: z.array(z.string()).optional(), // Parallel children currently running
	completedChildIds: z.array(z.string()).optional(), // Parallel children completed
	failedChildIds: z.array(z.string()).optional(), // Parallel children failed or cancelled
	awaitingChildId: z.string().optional(), // Child currently awaited (set when delegated)
	completedByChildId: z.string().optional(), // Child that completed and resumed this parent
	completionResultSummary: z.string().optional(), // Summary from completed child
	agentStatus: parallelAgentStatusSchema.optional(),
	agentRole: z.string().optional(),
	workspaceStrategy: workspaceStrategySchema.optional(),
	workspacePath: z.string().optional(),
	baseBranch: z.string().optional(),
	agentResultSummary: z.string().optional(),
	agentChangedFiles: z.array(z.string()).optional(),
	agentValidation: z.string().optional(),
	agentIntegrated: z.boolean().optional(),
})

export type HistoryItem = z.infer<typeof historyItemSchema>
