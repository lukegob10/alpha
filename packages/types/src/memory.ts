import { z } from "zod"

/** Citation locations are memory-relative data, never arbitrary filesystem or command targets. */
export const memoryCitationPathSchema = z
	.string()
	.regex(/^(?:MEMORY\.md|memory_summary\.md|rollout_summaries\/[A-Za-z0-9][A-Za-z0-9_-]{0,180}\.md)$/)

export const memoryCitationEntrySchema = z
	.object({
		path: memoryCitationPathSchema,
		lineStart: z.number().int().min(1).max(999_999_999),
		lineEnd: z.number().int().min(1).max(999_999_999),
		note: z
			.string()
			.max(160)
			.regex(/^[^\r\n[\]<>]*$/),
	})
	.strict()
	.refine((entry) => entry.lineStart <= entry.lineEnd, "Memory citation line range is reversed")

export const memoryCitationSchema = z
	.object({
		entries: z.array(memoryCitationEntrySchema).max(128),
		rolloutIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/)).max(128),
	})
	.strict()

export type MemoryCitationEntry = z.infer<typeof memoryCitationEntrySchema>
export type MemoryCitation = z.infer<typeof memoryCitationSchema>

/**
 * Native Alpha settings for Codex CLI's current memory contract.
 * Reference: openai/codex 970111f6cb62cc02fe36a82ea7d71b37a2889c97 (2026-10-23).
 * The feature is opt-in; disabling it retains the host-local memory store.
 */
export const memorySettingsSchema = z.object({
	enabled: z.boolean().default(false),
	useMemories: z.boolean().default(true),
	generateMemories: z.boolean().default(true),
	disableOnExternalContext: z.boolean().default(false),
	dedicatedTools: z.boolean().default(false),
	maxRolloutsPerStartup: z.number().int().min(1).max(128).default(2),
	maxRolloutAgeDays: z.number().int().min(0).max(90).default(10),
	minRolloutIdleHours: z.number().int().min(1).max(48).default(6),
	minRateLimitRemainingPercent: z.number().int().min(0).max(100).default(25),
	maxMemoriesForConsolidation: z.number().int().min(1).max(4096).default(256),
	maxUnusedDays: z.number().int().min(0).max(365).default(30),
	extractModel: z.string().trim().min(1).max(256).optional(),
	consolidationModel: z.string().trim().min(1).max(256).optional(),
})

export type MemorySettings = z.infer<typeof memorySettingsSchema>

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = Object.freeze(memorySettingsSchema.parse({}))

/** Reading is captured when a conversation starts; generation remains user-controlled. */
export const taskMemoryStateSchema = z.object({
	version: z.literal("v2"),
	useMemories: z.boolean(),
	generateMemories: z.boolean(),
	externalContext: z.boolean().optional(),
})

export type TaskMemoryState = z.infer<typeof taskMemoryStateSchema>
