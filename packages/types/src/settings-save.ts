import { z } from "zod"

import { globalSettingsSchema } from "./global-settings.js"

const requestIdSchema = z.string().min(1).max(128)
const booleanSettingChangeSchema = z.object({ expected: z.boolean(), value: z.boolean() }).strict()

// Older settings editors can include retired reporting and output-preview preferences.
// Strip only those keys; every other unknown expectation must remain invalid.
const expectedSettingsSchema = z.preprocess((value) => {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(!Object.hasOwn(value, "telemetrySetting") && !Object.hasOwn(value, "terminalOutputPreviewSize"))
	) {
		return value
	}
	return Object.fromEntries(
		Object.entries(value).filter(([key]) => key !== "telemetrySetting" && key !== "terminalOutputPreviewSize"),
	)
}, globalSettingsSchema.strict())

/** A settings editor submits only changed preferences and the values from which those edits started. */
export const settingsSaveRequestSchema = z
	.object({
		requestId: requestIdSchema,
		expectedSettings: expectedSettingsSchema,
		debug: booleanSettingChangeSchema.optional(),
		terminalInheritEnv: booleanSettingChangeSchema.optional(),
	})
	.strict()

export type SettingsSaveRequest = z.infer<typeof settingsSaveRequestSchema>

export const settingsSaveResultSchema = z.discriminatedUnion("status", [
	z.object({ requestId: requestIdSchema, status: z.literal("success") }).strict(),
	z
		.object({
			requestId: requestIdSchema,
			status: z.literal("error"),
			error: z.enum(["invalid", "conflict", "saveFailed"]),
			conflictingKeys: z.array(z.string()).optional(),
			/** Durable portions of a failed save become the editor's new comparison baseline. */
			appliedKeys: z.preprocess(
				(value) =>
					Array.isArray(value)
						? value.filter((key) => key !== "telemetrySetting" && key !== "terminalOutputPreviewSize")
						: value,
				z.array(globalSettingsSchema.keyof()).optional(),
			),
			debugApplied: z.boolean().optional(),
			terminalInheritEnvApplied: z.boolean().optional(),
		})
		.strict(),
])

export type SettingsSaveResult = z.infer<typeof settingsSaveResultSchema>
