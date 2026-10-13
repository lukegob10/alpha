import { z } from "zod"

/** Existing-profile saves address persisted identity independently of an editable display name. */
export const providerProfileSaveIdSchema = z.string().min(1)

export type ProviderProfileSaveId = z.infer<typeof providerProfileSaveIdSchema>

const requestIdSchema = z.string().min(1).max(128)

/** Correlate a modern saved-profile write without granting authority through its display name. */
export const providerProfileSaveRequestSchema = z
	.object({ requestId: requestIdSchema, id: providerProfileSaveIdSchema })
	.strict()

export type ProviderProfileSaveRequest = z.infer<typeof providerProfileSaveRequestSchema>

export const providerProfileSaveErrorSchema = z.enum(["invalid", "notFound", "saveFailed"])
export type ProviderProfileSaveErrorCode = z.infer<typeof providerProfileSaveErrorSchema>

export const providerProfileSaveResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			requestId: requestIdSchema,
			status: z.literal("success"),
			id: providerProfileSaveIdSchema,
			name: z.string(),
		})
		.strict(),
	z
		.object({
			requestId: requestIdSchema,
			status: z.literal("error"),
			error: providerProfileSaveErrorSchema,
		})
		.strict(),
])

export type ProviderProfileSaveResult = z.infer<typeof providerProfileSaveResultSchema>
