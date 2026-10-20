import { z } from "zod"
import {
	agentLifecyclePhaseSchema,
	agentMailboxKindSchema,
	agentTurnStatusSchema,
	alphaAskSchema,
	providerNamesSchema,
	retiredProviderNames,
	stellarModels,
	vertexModels,
	vscodeLlmModels,
} from "@alpha-code/types"

import { hashAgentTurnEvidenceId } from "./AgentTurnEventLog"

export const MAX_INCIDENT_RECEIPTS = 32
const MAX_LIFECYCLE_ITEMS = 256
const MAX_ERROR_CHARACTERS = 8_192
const knownModels = new Set([
	...Object.keys(stellarModels),
	...Object.keys(vertexModels),
	...Object.keys(vscodeLlmModels),
])
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timeSchema = z.number().finite().nonnegative()
const diagnosticProviderSchema = providerNamesSchema.or(z.enum(retiredProviderNames))
const identitySchema = z
	.object({
		provider: diagnosticProviderSchema.optional(),
		providerIdSha256: hashSchema.optional(),
		model: z
			.string()
			.refine((value) => knownModels.has(value))
			.optional(),
		modelIdSha256: hashSchema.optional(),
	})
	.strict()

/** An export-only contract. No provider settings, prompt bodies, paths, or arbitrary text fields are accepted. */
export const incidentDiagnosticsSchema = z
	.object({
		version: z.literal(1),
		task: z
			.object({
				idSha256: hashSchema.optional(),
				status: z.enum(["running", "interactive", "resumable", "idle", "none"]).optional(),
				kind: z.enum(["primary", "subagent"]).optional(),
				ask: alphaAskSchema.optional(),
				aborted: z.boolean(),
				abandoned: z.boolean(),
			})
			.strict(),
		provider: identitySchema,
		lifecycle: z
			.object({
				available: z.boolean(),
				runIdSha256: hashSchema.optional(),
				turnIdSha256: hashSchema.optional(),
				status: agentTurnStatusSchema.optional(),
				phase: agentLifecyclePhaseSchema.optional(),
				lastSequence: countSchema.optional(),
				pendingApprovalCount: countSchema,
				pendingApprovals: z
					.array(z.object({ idSha256: hashSchema, toolCallIdSha256: hashSchema.optional() }).strict())
					.max(MAX_INCIDENT_RECEIPTS),
				lastError: z
					.object({
						messageSha256: hashSchema.optional(),
						codeSha256: hashSchema.optional(),
						capturedBytes: countSchema,
						truncated: z.boolean(),
					})
					.strict()
					.optional(),
				truncated: z.boolean(),
			})
			.strict(),
		humanInput: z
			.object({
				pendingCount: countSchema,
				deliveringCount: countSchema,
				receipts: z
					.array(
						z
							.object({
								idSha256: hashSchema,
								state: z.enum(["pending", "delivering"]),
								timestamp: timeSchema.optional(),
							})
							.strict(),
					)
					.max(MAX_INCIDENT_RECEIPTS),
				truncated: z.boolean(),
			})
			.strict(),
		mailbox: z
			.object({
				available: z.boolean(),
				pendingCount: countSchema,
				claimedCount: countSchema,
				receipts: z
					.array(
						z
							.object({
								eventIdSha256: hashSchema,
								kind: agentMailboxKindSchema,
								sequence: countSchema.optional(),
								claimIdSha256: hashSchema.optional(),
								channel: z.enum(["wait", "automatic"]).optional(),
								createdAt: timeSchema.optional(),
							})
							.strict(),
					)
					.max(MAX_INCIDENT_RECEIPTS),
				truncated: z.boolean(),
			})
			.strict(),
		setup: z
			.object({
				contextInitialized: z.boolean().optional(),
				subagentBudgetDefaultsMigration: z.enum(["absent", "started", "done", "invalid", "unavailable"]),
				profiles: z
					.object({
						available: z.boolean(),
						source: z.literal("cached"),
						total: countSchema.optional(),
						invalid: countSchema.optional(),
						unsupported: countSchema.optional(),
					})
					.strict(),
			})
			.strict(),
	})
	.strict()

const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const hash = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 && value.length <= 256 ? hashAgentTurnEvidenceId(value) : undefined
const number = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
const count = (value: unknown): number | undefined => {
	const result = number(value)
	return result !== undefined && Number.isSafeInteger(result) ? result : undefined
}
const member = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
	const parsed = schema.safeParse(value)
	return parsed.success ? parsed.data : undefined
}

/** Known catalog identities may be printed; arbitrary custom/opaque identifiers are represented only by hashes. */
export function projectDiagnosticIdentity(provider: unknown, model: unknown) {
	return identitySchema.parse({
		provider: member(diagnosticProviderSchema, provider),
		providerIdSha256: hash(provider),
		model: typeof model === "string" && knownModels.has(model) ? model : undefined,
		modelIdSha256: hash(model),
	})
}

/** Pure observation of already-owned state: never resume, flush, ACK, retry, or contact a provider. */
export function projectIncidentDiagnostics(value: unknown): z.infer<typeof incidentDiagnosticsSchema> {
	const input = object(value)
	const task = object(input.task)
	const provider = object(input.provider)
	const lifecycle = object(input.lifecycle)
	const allItems = array(lifecycle.items)
	const items = allItems.slice(-MAX_LIFECYCLE_ITEMS).map(object)
	const pendingApprovals = items.filter((item) => item.type === "approval" && item.status === "requested")
	const error = items
		.slice()
		.reverse()
		.find((item) => item.type === "error")
	const errorMessage = typeof error?.message === "string" ? error.message.slice(-MAX_ERROR_CHARACTERS) : undefined
	const messages = array(input.queuedMessages).map(object)
	const mailbox = object(input.mailbox)
	const mailboxEntries = array(mailbox.entries)
	const setup = object(input.setup)
	const profiles = object(setup.profiles)
	return incidentDiagnosticsSchema.parse({
		version: 1,
		task: {
			idSha256: hash(task.id),
			status: member(incidentDiagnosticsSchema.shape.task.shape.status, task.status),
			kind: member(incidentDiagnosticsSchema.shape.task.shape.kind, task.kind),
			ask: member(alphaAskSchema, task.ask),
			aborted: task.aborted === true,
			abandoned: task.abandoned === true,
		},
		provider: projectDiagnosticIdentity(provider.name, provider.modelId),
		lifecycle: {
			available:
				input.lifecycle !== null && typeof input.lifecycle === "object" && !Array.isArray(input.lifecycle),
			runIdSha256: hash(lifecycle.runId),
			turnIdSha256: hash(lifecycle.turnId),
			status: member(agentTurnStatusSchema, lifecycle.status),
			phase: member(agentLifecyclePhaseSchema, lifecycle.phase),
			lastSequence: count(lifecycle.lastSequence),
			pendingApprovalCount: pendingApprovals.length,
			pendingApprovals: pendingApprovals.slice(-MAX_INCIDENT_RECEIPTS).flatMap((item) => {
				const idSha256 = hash(item.approvalId)
				return idSha256 ? [{ idSha256, toolCallIdSha256: hash(item.toolCallId) }] : []
			}),
			lastError: error
				? {
						messageSha256: errorMessage ? hashAgentTurnEvidenceId(errorMessage) : undefined,
						codeSha256: hash(error.code),
						capturedBytes: errorMessage ? Buffer.byteLength(errorMessage, "utf8") : 0,
						truncated: typeof error.message === "string" && error.message.length > MAX_ERROR_CHARACTERS,
					}
				: undefined,
			truncated: allItems.length > MAX_LIFECYCLE_ITEMS || pendingApprovals.length > MAX_INCIDENT_RECEIPTS,
		},
		humanInput: {
			pendingCount: messages.filter((message) => message.deliveryState !== "delivering").length,
			deliveringCount: messages.filter((message) => message.deliveryState === "delivering").length,
			receipts: messages.slice(-MAX_INCIDENT_RECEIPTS).flatMap((message) => {
				const idSha256 = hash(message.id)
				return idSha256
					? [
							{
								idSha256,
								state: message.deliveryState === "delivering" ? "delivering" : "pending",
								timestamp: number(message.timestamp),
							},
						]
					: []
			}),
			truncated: messages.length > MAX_INCIDENT_RECEIPTS,
		},
		mailbox: {
			available: mailbox.available === true,
			pendingCount: count(mailbox.pendingCount) ?? 0,
			claimedCount: count(mailbox.claimedCount) ?? 0,
			receipts: mailboxEntries.slice(-MAX_INCIDENT_RECEIPTS).flatMap((value) => {
				const entry = object(value)
				const eventIdSha256 = hash(entry.eventId)
				const kind = member(agentMailboxKindSchema, entry.kind)
				return eventIdSha256 && kind
					? [
							{
								eventIdSha256,
								kind,
								sequence: count(entry.sequence),
								claimIdSha256: hash(entry.claimId),
								channel: member(z.enum(["wait", "automatic"]), entry.claimChannel),
								createdAt: number(entry.createdAt),
							},
						]
					: []
			}),
			truncated: mailbox.truncated === true || mailboxEntries.length > MAX_INCIDENT_RECEIPTS,
		},
		setup: {
			contextInitialized: typeof setup.contextInitialized === "boolean" ? setup.contextInitialized : undefined,
			subagentBudgetDefaultsMigration:
				setup.subagentBudgetDefaultsMigration === undefined
					? "absent"
					: setup.subagentBudgetDefaultsMigration === "started" ||
						  setup.subagentBudgetDefaultsMigration === "done" ||
						  setup.subagentBudgetDefaultsMigration === "unavailable"
						? setup.subagentBudgetDefaultsMigration
						: "invalid",
			profiles: {
				available: profiles.available === true,
				source: "cached",
				total: count(profiles.total),
				invalid: count(profiles.invalid),
				unsupported: count(profiles.unsupported),
			},
		},
	})
}
