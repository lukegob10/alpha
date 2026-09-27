import { z } from "zod"

import { approvalModeSchema } from "./approval-mode.js"

/** Change the approval mode for one live task without changing saved defaults. */
export const taskApprovalModeUpdateSchema = z
	.object({
		requestId: z.string().min(1).max(128),
		taskId: z.string().min(1).max(512),
		approvalMode: approvalModeSchema,
	})
	.strict()

export type TaskApprovalModeUpdate = z.infer<typeof taskApprovalModeUpdateSchema>

export const taskApprovalModeUpdateResultSchema = z
	.object({
		requestId: z.string().min(1).max(128),
		taskId: z.string().min(1).max(512).optional(),
		status: z.enum(["applied", "targetUnavailable", "rejected"]),
		approvalMode: approvalModeSchema.optional(),
		error: z.enum(["invalid", "notMutable"]).optional(),
	})
	.strict()
	.superRefine((result, context) => {
		if (result.status === "applied" && (result.approvalMode === undefined || result.taskId === undefined)) {
			context.addIssue({
				code: "custom",
				message: "An applied task approval mode update must include the task and resulting mode.",
				path: ["taskId"],
			})
		}
		if (result.status === "targetUnavailable" && result.taskId === undefined) {
			context.addIssue({
				code: "custom",
				message: "An unavailable task approval mode update must include the addressed task.",
				path: ["taskId"],
			})
		}
		if (result.status !== "applied" && result.approvalMode !== undefined) {
			context.addIssue({
				code: "custom",
				message: "A rejected task approval mode update cannot include an applied mode.",
				path: ["approvalMode"],
			})
		}
		if (result.status === "rejected" && result.error === undefined) {
			context.addIssue({
				code: "custom",
				message: "A rejected task approval mode update must include a reason.",
				path: ["error"],
			})
		}
		if (result.status !== "rejected" && result.error !== undefined) {
			context.addIssue({
				code: "custom",
				message: "Only a rejected task approval mode update can include an error.",
				path: ["error"],
			})
		}
	})

export type TaskApprovalModeUpdateResult = z.infer<typeof taskApprovalModeUpdateResultSchema>
