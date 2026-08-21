import { z } from "zod"

import { subagentContextManifestSchema } from "./subagent-context.js"
import { parentVerificationObligationSchema } from "./subagent.js"
import { subagentStopReasonSchema, subagentUsageSchema } from "./subagent-orchestration.js"

/** Durable lifecycle states shared by the agent registry and its consumers. */
export const agentLifecycleStatusSchema = z.enum([
	"pending",
	"running",
	"cancelling",
	"interrupted",
	"completed",
	"blocked",
	"failed",
	"cancelled",
	"timed_out",
])

export type AgentLifecycleStatus = z.infer<typeof agentLifecycleStatusSchema>

export const activeAgentLifecycleStatusSchema = z.enum(["pending", "running", "cancelling"])
export type ActiveAgentLifecycleStatus = z.infer<typeof activeAgentLifecycleStatusSchema>

export const terminalAgentLifecycleStatusSchema = z.enum(["completed", "blocked", "failed", "cancelled", "timed_out"])
export type TerminalAgentLifecycleStatus = z.infer<typeof terminalAgentLifecycleStatusSchema>

export const agentControlRoleSchema = z.enum(["root", "explore", "review", "worker"])
export type AgentControlRole = z.infer<typeof agentControlRoleSchema>

/** A canonical path is scoped to one root task. Different roots may both contain `/root/review`. */
export const agentCanonicalPathSchema = z.string().regex(/^\/root(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/)
export type AgentCanonicalPath = z.infer<typeof agentCanonicalPathSchema>

/** Credential-free runtime data useful for list/status views. */
export const agentRuntimeSnapshotSchema = z.object({
	phase: z.string().optional(),
	summary: z.string().optional(),
	stopReason: subagentStopReasonSchema.optional(),
	modelRouteId: z.string().optional(),
	requiresParentVerification: z.boolean().optional(),
	contextManifest: subagentContextManifestSchema.optional(),
	usage: z.record(z.string(), z.number()).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
})
export type AgentRuntimeSnapshot = z.infer<typeof agentRuntimeSnapshotSchema>

/** Compact terminal result data retained until an agent is explicitly closed. */
export const agentTerminalResultMetadataSchema = z.object({
	status: terminalAgentLifecycleStatusSchema,
	summary: z.string().optional(),
	error: z.string().optional(),
	stopReason: subagentStopReasonSchema.optional(),
	changedFiles: z.array(z.string()).optional(),
	requiresParentVerification: z.boolean().optional(),
	usage: subagentUsageSchema.optional(),
	completedAt: z.number(),
	metadata: z.record(z.string(), z.unknown()).optional(),
})
export type AgentTerminalResultMetadata = z.infer<typeof agentTerminalResultMetadataSchema>

export const agentRecordSchema = z.object({
	taskId: z.string().min(1),
	path: agentCanonicalPathSchema,
	parentTaskId: z.string().min(1).optional(),
	parentPath: agentCanonicalPathSchema.optional(),
	rootTaskId: z.string().min(1),
	groupId: z.string().min(1).optional(),
	nickname: z.string().min(1),
	role: agentControlRoleSchema,
	objective: z.string(),
	status: agentLifecycleStatusSchema,
	createdAt: z.number(),
	updatedAt: z.number(),
	startedAt: z.number().optional(),
	interruptedAt: z.number().optional(),
	finishedAt: z.number().optional(),
	snapshot: agentRuntimeSnapshotSchema.optional(),
	terminalResult: agentTerminalResultMetadataSchema.optional(),
})
export type AgentRecord = z.infer<typeof agentRecordSchema>

export const closedAgentTombstoneSchema = z.object({
	taskId: z.string().min(1),
	path: agentCanonicalPathSchema,
	parentTaskId: z.string().min(1).optional(),
	rootTaskId: z.string().min(1),
	status: z.union([terminalAgentLifecycleStatusSchema, z.literal("interrupted")]),
	stopReason: subagentStopReasonSchema.optional(),
	closedAt: z.number(),
})
export type ClosedAgentTombstone = z.infer<typeof closedAgentTombstoneSchema>

/** Broad mailbox categories; `name` carries the concrete lifecycle/control event. */
export const agentMailboxKindSchema = z.enum(["lifecycle", "message", "followup", "control", "result"])
export type AgentMailboxKind = z.infer<typeof agentMailboxKindSchema>

export const agentMailboxEntrySchema = z.object({
	eventId: z.string().min(1),
	sequence: z.number().int().positive(),
	rootTaskId: z.string().min(1),
	senderTaskId: z.string().min(1).optional(),
	senderPath: agentCanonicalPathSchema.optional(),
	recipientTaskId: z.string().min(1),
	recipientPath: agentCanonicalPathSchema,
	kind: agentMailboxKindSchema,
	name: z.string().min(1),
	payload: z.record(z.string(), z.unknown()).optional(),
	createdAt: z.number(),
	claimId: z.string().min(1).optional(),
	claimedAt: z.number().optional(),
	claimChannel: z.enum(["wait", "automatic"]).optional(),
	deliveredAt: z.number().optional(),
	acknowledgedAt: z.number().optional(),
})
export type AgentMailboxEntry = z.infer<typeof agentMailboxEntrySchema>

export const agentMailboxCursorSchema = z.object({
	recipientTaskId: z.string().min(1),
	recipientPath: agentCanonicalPathSchema,
	lastDeliveredSequence: z.number().int().nonnegative(),
	lastAcknowledgedSequence: z.number().int().nonnegative(),
	updatedAt: z.number(),
})
export type AgentMailboxCursor = z.infer<typeof agentMailboxCursorSchema>

export const agentControlStateSchema = z.object({
	version: z.literal(1),
	updatedAt: z.number(),
	nextSequence: z.number().int().positive(),
	agents: z.array(agentRecordSchema),
	tombstones: z.array(closedAgentTombstoneSchema),
	mailbox: z.array(agentMailboxEntrySchema),
	mailboxCursors: z.record(z.string(), agentMailboxCursorSchema),
	verificationObligations: z.array(parentVerificationObligationSchema).default([]),
})
export type AgentControlState = z.infer<typeof agentControlStateSchema>
