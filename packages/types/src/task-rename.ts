import { z } from "zod"

import { taskDisplayNameSchema } from "./history.js"

const taskRenameIdentitySchema = z.string().min(1).max(128)

export const taskRenameRequestSchema = z
	.object({
		taskId: taskRenameIdentitySchema,
		requestId: taskRenameIdentitySchema,
		displayName: taskDisplayNameSchema,
	})
	.strict()

export type TaskRenameRequest = z.infer<typeof taskRenameRequestSchema>

export const taskRenameErrorSchema = z.enum(["invalid", "notFound", "wrongWorkspace", "saveFailed"])
export type TaskRenameErrorCode = z.infer<typeof taskRenameErrorSchema>

export const taskRenameResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			taskId: taskRenameIdentitySchema,
			requestId: taskRenameIdentitySchema,
			status: z.literal("success"),
			displayName: taskDisplayNameSchema,
		})
		.strict(),
	z
		.object({
			taskId: taskRenameIdentitySchema,
			requestId: taskRenameIdentitySchema,
			status: z.literal("error"),
			error: taskRenameErrorSchema,
		})
		.strict(),
])

export type TaskRenameResult = z.infer<typeof taskRenameResultSchema>
