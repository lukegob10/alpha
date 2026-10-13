import { z } from "zod"
import { taskGoalObjectiveSchema, taskGoalTokenBudgetSchema } from "./task-goal.js"

/** Concrete goal changes displayed by the existing explicit tool-approval channel. */
export const goalToolApprovalSchema = z.object({
	operation: z.enum(["create", "pause"]),
	objective: taskGoalObjectiveSchema,
	tokenBudget: taskGoalTokenBudgetSchema.optional(),
})

export type GoalToolApproval = z.infer<typeof goalToolApprovalSchema>
