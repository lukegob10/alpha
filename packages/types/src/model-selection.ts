import { z } from "zod"

import { reasoningEffortExtendedSchema } from "./model.js"
import { providerNamesSchema } from "./provider-settings.js"

/** Credential-free model selection; the host resolves saved profiles and preserves execution authority. */
export const modelSelectionParamsSchema = z
	.object({
		provider: providerNamesSchema.optional(),
		profile: z.string().trim().min(1).optional(),
		model: z.string().trim().min(1).max(256).optional(),
		reasoning_effort: reasoningEffortExtendedSchema.optional(),
	})
	.strict()

export type ModelSelectionParams = z.infer<typeof modelSelectionParamsSchema>

/** Read-only discovery of current saved connection metadata. */
export const listProviderProfilesParamsSchema = z
	.object({
		query: z.string().trim().max(256).nullish(),
		cursor: z.string().max(128).nullish(),
	})
	.strict()

export type ListProviderProfilesParams = z.infer<typeof listProviderProfilesParamsSchema>
