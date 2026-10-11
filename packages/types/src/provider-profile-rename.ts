import { z } from "zod"

/** Rename a persisted profile without granting authority to save provider settings. */
export const providerProfileRenameRequestSchema = z
	.object({
		requestId: z.string().min(1).max(128),
		id: z.string().min(1),
		newName: z.string().trim().min(1),
	})
	.strict()

export type ProviderProfileRenameRequest = z.infer<typeof providerProfileRenameRequestSchema>

export const providerProfileRenameErrorSchema = z.enum(["invalid", "notFound", "nameInUse", "saveFailed"])
export type ProviderProfileRenameErrorCode = z.infer<typeof providerProfileRenameErrorSchema>

export const providerProfileRenameResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			requestId: z.string().min(1).max(128),
			status: z.literal("success"),
			id: z.string().min(1),
			oldName: z.string(),
			newName: z.string().min(1),
		})
		.strict(),
	z
		.object({
			requestId: z.string().min(1).max(128),
			status: z.literal("error"),
			error: providerProfileRenameErrorSchema,
			/** Saved identity after compensation, even if a later state projection cannot be delivered. */
			profile: z
				.object({ id: z.string().min(1), name: z.string().min(1) })
				.strict()
				.optional(),
		})
		.strict(),
])

export type ProviderProfileRenameResult = z.infer<typeof providerProfileRenameResultSchema>
