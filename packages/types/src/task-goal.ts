import { z } from "zod"

export const MAX_TASK_GOAL_OBJECTIVE_CHARS = 4_000
export const DEFAULT_TASK_GOAL_MAX_CONTINUATIONS = 20
export const MAX_TASK_GOAL_CONTINUATIONS = 1_000

const goalIdentifierSchema = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => value.trim().length > 0)
const goalCounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const taskGoalObjectiveSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_TASK_GOAL_OBJECTIVE_CHARS * 2)
	.refine((value) => Array.from(value).length <= MAX_TASK_GOAL_OBJECTIVE_CHARS, "Goal objective is too long")

export const taskGoalTokenBudgetSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const taskGoalMaxContinuationsSchema = z.number().int().positive().max(MAX_TASK_GOAL_CONTINUATIONS)

export const taskGoalStatusSchema = z.enum([
	"active",
	"paused",
	"blocked",
	"complete",
	"budget_limited",
	"usage_limited",
])
export type TaskGoalStatus = z.infer<typeof taskGoalStatusSchema>

/** A task has one explicit objective; ordinary turns do not implicitly create one. */
export const taskGoalSchema = z
	.object({
		goalId: goalIdentifierSchema,
		taskId: goalIdentifierSchema,
		objective: taskGoalObjectiveSchema,
		status: taskGoalStatusSchema,
		tokenBudget: taskGoalTokenBudgetSchema.optional(),
		tokensUsed: goalCounterSchema,
		timeUsedMs: goalCounterSchema,
		version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		/** User consent follows control mutations; provider usage may advance version independently. */
		controlVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
		createdAt: z.number().finite().nonnegative(),
		updatedAt: z.number().finite().nonnegative(),
		maxContinuations: taskGoalMaxContinuationsSchema,
		continuationCount: goalCounterSchema,
		/** Recovery displays the saved goal but requires an explicit host resume before admission. */
		recoveryDeferred: z.boolean(),
	})
	.strict()
	.refine((goal) => goal.continuationCount <= goal.maxContinuations, "Goal continuation count exceeds its limit")
export type TaskGoal = z.infer<typeof taskGoalSchema>

export const taskGoalCreateInputSchema = z
	.object({
		objective: taskGoalObjectiveSchema,
		tokenBudget: taskGoalTokenBudgetSchema.optional(),
		maxContinuations: taskGoalMaxContinuationsSchema.optional(),
	})
	.strict()
export type TaskGoalCreateInput = z.infer<typeof taskGoalCreateInputSchema>

export const taskGoalResumeInputSchema = z
	.object({
		tokenBudget: taskGoalTokenBudgetSchema.nullable().optional(),
		maxContinuations: taskGoalMaxContinuationsSchema.optional(),
	})
	.strict()
export type TaskGoalResumeInput = z.infer<typeof taskGoalResumeInputSchema>

export type TaskGoalExpectation = { goalId: string; version?: number; controlVersion?: number }

export type TaskGoalCreateExpectation = { goalId: string | null; version?: number; controlVersion?: number }

/** Host-authored checkpoint committed with the response before the goal ledger is charged. */
export const taskGoalUsageReceiptSchema = z
	.object({
		goalTaskId: goalIdentifierSchema,
		goalId: goalIdentifierSchema,
		eventId: goalIdentifierSchema,
		tokens: goalCounterSchema,
		timeMs: goalCounterSchema,
	})
	.strict()
export type TaskGoalUsageReceipt = z.infer<typeof taskGoalUsageReceiptSchema>
export const taskGoalUsageReceiptsSchema = z.array(taskGoalUsageReceiptSchema).max(2)
