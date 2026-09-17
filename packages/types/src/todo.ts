import { z } from "zod"

/**
 * TodoStatus
 */
export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"] as const)

export type TodoStatus = z.infer<typeof todoStatusSchema>

/**
 * TodoItem
 */
export const todoItemSchema = z.object({
	id: z.string(),
	content: z.string(),
	status: todoStatusSchema,
})

export type TodoItem = z.infer<typeof todoItemSchema>

/** Edits apply only to the identified pending approval in the addressed live task. */
export const todoApprovalEditSchema = z.object({
	approvalId: z.string().min(1),
	todos: z.array(
		todoItemSchema.extend({
			id: z.string().min(1),
			content: z.string().refine((value) => value.trim().length > 0),
		}),
	),
})

export type TodoApprovalEdit = z.infer<typeof todoApprovalEditSchema>
