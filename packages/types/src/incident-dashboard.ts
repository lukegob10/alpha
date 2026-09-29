import { z } from "zod"
import { toolNamesSchema, type ToolName } from "./tool.js"

const incidentDashboardTimestampSchema = z.number().finite().nonnegative().max(8_640_000_000_000_000)
const incidentDashboardHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const incidentDashboardTaskLabelSchema = z.string().regex(/^Task [a-f0-9]{8}$/)

const incidentDashboardTimelineLabelSchema = z.enum([
	"Turn started",
	"Waiting for approval",
	"Approval requested",
	"Approval resolved",
	"Turn completed",
	"Turn failed",
	"Turn interrupted",
	"Turn cancelled",
	"Step failed",
	"Tool returned an error",
	"Task marked failed",
	"Lifecycle persistence failed",
	"Lifecycle resync required",
])

const incidentDashboardAlertTitleSchema = z.enum([
	"Agent turn failed",
	"Task failed",
	"Lifecycle stream needs resync",
	"Lifecycle evidence write failed",
])

const incidentDashboardAlertSummarySchema = z.enum([
	"A task turn ended in an explicit failure. Review the bounded lifecycle evidence.",
	"Task history records a failure or timeout.",
	"The lifecycle projector could not verify an event sequence or identity.",
	"A lifecycle event could not be persisted, so task evidence may be incomplete.",
])

export const incidentDashboardEvidenceStatusSchema = z.enum(["captured", "absent", "incomplete"])
export const incidentDashboardErrorStatusSchema = z.enum(["failed", "incomplete"])

export const incidentDashboardTaskStateSchema = z.enum([
	"running",
	"waiting",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
	"unknown",
])

export const incidentDashboardTimelineKindSchema = z.enum([
	"task_started",
	"turn_started",
	"turn_completed",
	"turn_failed",
	"approval_requested",
	"approval_resolved",
	"cancelled",
	"interrupted",
	"lifecycle_resync",
	"lifecycle_invalid",
	"task_status_changed",
])

export const incidentDashboardTimelineItemSchema = z
	.object({
		id: incidentDashboardHashSchema,
		at: incidentDashboardTimestampSchema,
		kind: incidentDashboardTimelineKindSchema,
		label: incidentDashboardTimelineLabelSchema,
	})
	.strict()

export const incidentDashboardTaskSchema = z
	.object({
		taskId: incidentDashboardHashSchema,
		label: incidentDashboardTaskLabelSchema,
		state: incidentDashboardTaskStateSchema,
		updatedAt: incidentDashboardTimestampSchema,
		timeline: z.array(incidentDashboardTimelineItemSchema).max(8),
		evidenceStatus: incidentDashboardEvidenceStatusSchema.optional(),
	})
	.strict()

export const incidentDashboardAlertSchema = z
	.object({
		id: incidentDashboardHashSchema,
		severity: z.enum(["error", "warning"]),
		title: incidentDashboardAlertTitleSchema,
		summary: incidentDashboardAlertSummarySchema,
		at: incidentDashboardTimestampSchema,
		taskId: incidentDashboardHashSchema.optional(),
		evidenceStatus: incidentDashboardEvidenceStatusSchema.optional(),
		turnIdSha256: incidentDashboardHashSchema.optional(),
		toolCallIdSha256: incidentDashboardHashSchema.optional(),
		toolName: toolNamesSchema.optional(),
		errorStatus: incidentDashboardErrorStatusSchema,
	})
	.strict()

/** Bounded, privacy-filtered data for the in-extension incident dashboard. */
export const incidentDashboardSnapshotSchema = z
	.object({
		generatedAt: incidentDashboardTimestampSchema,
		tasks: z.array(incidentDashboardTaskSchema).max(12),
		alerts: z.array(incidentDashboardAlertSchema).max(12),
	})
	.strict()

export const incidentDashboardUpdateMessageSchema = z
	.object({
		type: z.literal("incidentDashboardUpdate"),
		snapshot: incidentDashboardSnapshotSchema,
	})
	.strict()

export type IncidentDashboardTimelineKind = z.infer<typeof incidentDashboardTimelineKindSchema>
export type IncidentDashboardTaskState = z.infer<typeof incidentDashboardTaskStateSchema>
export type IncidentDashboardEvidenceStatus = z.infer<typeof incidentDashboardEvidenceStatusSchema>
export type IncidentDashboardErrorStatus = z.infer<typeof incidentDashboardErrorStatusSchema>
export type IncidentDashboardTimelineItem = z.infer<typeof incidentDashboardTimelineItemSchema>
export type IncidentDashboardTask = z.infer<typeof incidentDashboardTaskSchema>
export type IncidentDashboardAlert = z.infer<typeof incidentDashboardAlertSchema> & { toolName?: ToolName }
export type IncidentDashboardSnapshot = z.infer<typeof incidentDashboardSnapshotSchema>
export type IncidentDashboardUpdateMessage = z.infer<typeof incidentDashboardUpdateMessageSchema>
