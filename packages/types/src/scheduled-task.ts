import { z } from "zod"

export const scheduledTaskRunStatusSchema = z.enum([
	"pending",
	"queued",
	"running",
	"waiting_for_approval",
	"succeeded",
	"failed",
	"skipped",
	"canceled",
])

export type ScheduledTaskRunStatus = z.infer<typeof scheduledTaskRunStatusSchema>

export const scheduledTaskScheduleSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("once"),
		startAt: z.number(),
		timezone: z.string(),
	}),
	z.object({
		type: z.literal("hourly"),
		startAt: z.number(),
		timezone: z.string(),
		intervalHours: z.number().int().positive().default(1),
		endAt: z.number().optional(),
	}),
	z.object({
		type: z.literal("daily"),
		startAt: z.number(),
		timezone: z.string(),
		intervalDays: z.number().int().positive().default(1),
		endAt: z.number().optional(),
	}),
	z.object({
		type: z.literal("weekly"),
		startAt: z.number(),
		timezone: z.string(),
		intervalWeeks: z.number().int().positive().default(1),
		endAt: z.number().optional(),
	}),
	z.object({
		type: z.literal("monthly"),
		startAt: z.number(),
		timezone: z.string(),
		intervalMonths: z.number().int().positive().default(1),
		endAt: z.number().optional(),
	}),
	z.object({
		type: z.literal("customInterval"),
		startAt: z.number(),
		timezone: z.string(),
		intervalMs: z.number().int().positive(),
		endAt: z.number().optional(),
	}),
])

export type ScheduledTaskSchedule = z.infer<typeof scheduledTaskScheduleSchema>

export const scheduledTaskPermissionSetSchema = z.object({
	readFiles: z.boolean().default(true),
	runCommands: z.boolean().default(false),
	editFiles: z.boolean().default(false),
	stageChanges: z.boolean().default(false),
	commitChanges: z.boolean().default(false),
	pushBranches: z.boolean().default(false),
	openPullRequests: z.boolean().default(false),
	sendNotifications: z.boolean().default(false),
})

export type ScheduledTaskPermissionSet = z.infer<typeof scheduledTaskPermissionSetSchema>

export const scheduledTaskNotificationPreferenceSchema = z.enum([
	"before_run",
	"on_completion",
	"on_failure",
	"approval_required",
	"never",
])

export type ScheduledTaskNotificationPreference = z.infer<typeof scheduledTaskNotificationPreferenceSchema>

export const scheduledTaskExecutionSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("prompt"),
	}),
	z.object({
		type: z.literal("command"),
		command: z.string(),
		timeoutMs: z.number().int().positive().optional(),
	}),
	z.object({
		type: z.literal("skill"),
		skillName: z.string(),
		arguments: z.string().optional(),
	}),
	z.object({
		type: z.literal("plugin"),
		pluginName: z.string(),
		arguments: z.string().optional(),
	}),
])

export type ScheduledTaskExecution = z.infer<typeof scheduledTaskExecutionSchema>

export const scheduledTaskAutoApprovalSchema = z.object({
	autoApprovalEnabled: z.boolean().default(true),
	alwaysAllowReadOnly: z.boolean().default(true),
	alwaysAllowReadOnlyOutsideWorkspace: z.boolean().default(false),
	alwaysAllowWrite: z.boolean().default(false),
	alwaysAllowWriteOutsideWorkspace: z.boolean().default(false),
	alwaysAllowWriteProtected: z.boolean().default(false),
	alwaysAllowExecute: z.boolean().default(false),
	alwaysAllowMcp: z.boolean().default(false),
	alwaysAllowModeSwitch: z.boolean().default(false),
	alwaysAllowSubtasks: z.boolean().default(false),
	allowedCommands: z.array(z.string()).default([]),
	deniedCommands: z.array(z.string()).default([]),
})

export type ScheduledTaskAutoApproval = z.infer<typeof scheduledTaskAutoApprovalSchema>

export const scheduledTaskSchema = z.object({
	id: z.string(),
	name: z.string(),
	prompt: z.string(),
	execution: scheduledTaskExecutionSchema.optional(),
	mode: z.string().optional(),
	autoApproval: scheduledTaskAutoApprovalSchema.optional(),
	workspace: z.string().optional(),
	enabled: z.boolean(),
	schedule: scheduledTaskScheduleSchema,
	permissions: scheduledTaskPermissionSetSchema,
	notificationPreference: scheduledTaskNotificationPreferenceSchema,
	createdAt: z.number(),
	updatedAt: z.number(),
	nextRunAt: z.number().optional(),
	lastRunId: z.string().optional(),
	lastRunStatus: scheduledTaskRunStatusSchema.optional(),
	lastRunSummary: z.string().optional(),
})

export type ScheduledTask = z.infer<typeof scheduledTaskSchema>

export const scheduledTaskRunSchema = z.object({
	id: z.string(),
	taskId: z.string(),
	alphaTaskId: z.string().optional(),
	status: scheduledTaskRunStatusSchema,
	trigger: z.enum(["schedule", "manual", "missed", "system"]),
	scheduledFor: z.number(),
	queuedAt: z.number().optional(),
	startedAt: z.number().optional(),
	finishedAt: z.number().optional(),
	summary: z.string().optional(),
	error: z.string().optional(),
	skipReason: z.string().optional(),
	execution: scheduledTaskExecutionSchema.optional(),
	mode: z.string().optional(),
	autoApproval: scheduledTaskAutoApprovalSchema.optional(),
	output: z.string().optional(),
	exitCode: z.number().optional(),
	workspace: z.string().optional(),
	prompt: z.string(),
})

export type ScheduledTaskRun = z.infer<typeof scheduledTaskRunSchema>

export const scheduledTaskStateSchema = z.object({
	tasks: z.array(scheduledTaskSchema),
	runs: z.array(scheduledTaskRunSchema),
})

export type ScheduledTaskState = z.infer<typeof scheduledTaskStateSchema>

export type CreateScheduledTaskPayload = {
	name: string
	prompt: string
	execution?: ScheduledTaskExecution
	mode?: string
	autoApproval?: ScheduledTaskAutoApproval
	schedule: ScheduledTaskSchedule
	workspace?: string
	notificationPreference?: ScheduledTaskNotificationPreference
}

export type UpdateScheduledTaskPayload = Partial<CreateScheduledTaskPayload> & {
	enabled?: boolean
	permissions?: ScheduledTaskPermissionSet
}
