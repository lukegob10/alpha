import { z } from "zod"
import type { ProviderSettings } from "./provider-settings.js"

/** The configuration and save precondition must come from the same persisted read. */
export type ProviderProfileSnapshot = {
	id: string
	name: string
	version: string
	configuration: ProviderSettings
}

/** Existing-profile saves address persisted identity independently of an editable display name. */
export const providerProfileSaveIdSchema = z.string().min(1)

export type ProviderProfileSaveId = z.infer<typeof providerProfileSaveIdSchema>

const requestIdSchema = z.string().min(1).max(128)

/** Opaque content identity; no provider settings or credentials are returned in Save receipts. */
export const providerProfileVersionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/** Correlate a modern saved-profile write without granting authority through its display name. */
export const providerProfileSaveRequestSchema = z
	.object({
		requestId: requestIdSchema,
		id: providerProfileSaveIdSchema,
		expectedVersion: providerProfileVersionSchema.optional(),
	})
	.strict()

export type ProviderProfileSaveRequest = z.infer<typeof providerProfileSaveRequestSchema>

/** Initial setup may create the still-unsaved selected profile; existing profiles always require their saved ID. */
export const providerProfileCreateRequestSchema = z
	.object({ requestId: requestIdSchema, name: z.string().min(1), returnVersion: z.literal(true).optional() })
	.strict()

export const providerProfileSaveErrorSchema = z.enum(["invalid", "notFound", "conflict", "saveFailed", "applyFailed"])
export type ProviderProfileSaveErrorCode = z.infer<typeof providerProfileSaveErrorSchema>

export const providerProfileSavedReceiptSchema = z
	.object({
		id: providerProfileSaveIdSchema,
		name: z.string(),
		version: providerProfileVersionSchema,
	})
	.strict()
export type ProviderProfileSavedReceipt = z.infer<typeof providerProfileSavedReceiptSchema>

export const providerProfileSaveResultSchema = z
	.discriminatedUnion("status", [
		z
			.object({
				requestId: requestIdSchema,
				status: z.literal("success"),
				id: providerProfileSaveIdSchema,
				name: z.string(),
				version: providerProfileVersionSchema.optional(),
			})
			.strict(),
		z
			.object({
				requestId: requestIdSchema,
				status: z.literal("error"),
				error: providerProfileSaveErrorSchema,
				saved: providerProfileSavedReceiptSchema.optional(),
			})
			.strict(),
	])
	.superRefine((result, context) => {
		if (result.status === "error" && result.saved !== undefined && result.error !== "applyFailed") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["saved"],
				message: "Only an apply failure carries a committed receipt",
			})
		}
	})

export type ProviderProfileSaveResult = z.infer<typeof providerProfileSaveResultSchema>
