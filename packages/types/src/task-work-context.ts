import { z } from "zod"

const boundedText = z.string().trim().min(1).max(2_000)
export const acceptanceCheckSchema = z.object({
	id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
	description: boundedText,
	command: z.string().min(1).max(4_096),
	cwd: z.string().max(4_096).nullable(),
	paths: z.array(z.string().min(1).max(4_096)).min(1).max(64),
	/** External/live checks cannot be reused after a new user request or reload. */
	reusable: z.boolean(),
})

export const taskWorkPlanSchema = z
	.object({
		objective: boundedText,
		constraints: z.array(boundedText).max(16),
		notes: z.array(boundedText).max(16),
		checks: z.array(acceptanceCheckSchema).max(16),
	})
	.refine((plan) => new Set(plan.checks.map((check) => check.id)).size === plan.checks.length, "Duplicate check IDs")
	.refine((plan) => JSON.stringify(plan).length <= 12_000, "Task plan exceeds 12,000 characters")
	.refine(
		(plan) => new Set(plan.checks.flatMap((check) => check.paths)).size <= 64,
		"Task check input count exceeds 64",
	)

export const acceptanceReceiptSchema = z.object({
	checkId: z.string(),
	definitionDigest: z.string(),
	executionId: z.string(),
	status: z.enum(["running", "passed", "failed", "stale", "unavailable"]),
	files: z.record(z.string()).optional(),
	exitCode: z.number().optional(),
	observedAt: z.number(),
})

export const taskWorkContextSchema = z.object({
	plan: taskWorkPlanSchema.optional(),
	receipts: z.array(acceptanceReceiptSchema).max(16),
	skills: z.array(z.object({ name: boundedText, path: z.string().max(4_096), digest: z.string() })).max(16),
})

export type AcceptanceCheck = z.infer<typeof acceptanceCheckSchema>
export type AcceptanceReceipt = z.infer<typeof acceptanceReceiptSchema>
export type TaskWorkPlan = z.infer<typeof taskWorkPlanSchema>
export type TaskWorkContext = z.infer<typeof taskWorkContextSchema>
