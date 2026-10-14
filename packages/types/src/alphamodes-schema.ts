/**
 * Builds the Zod schema for .alphamodes configuration files and converts it
 * to JSON Schema (draft-07). This module is the single source of truth for
 * both the generator script (scripts/generate-alphamodes-schema.ts) and the
 * drift-detection test.
 */

import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"

import { groupEntrySchema, modeConfigSchema } from "./mode.js"

// Build the RuleFile schema (used during import/export but not part of the
// core Zod types).
const ruleFileSchema = z.object({
	relativePath: z.string(),
	content: z.string().optional(),
})

// Build an extended ModeConfig schema that includes rulesFiles.
const exportedModeConfigSchema = modeConfigSchema.omit({ groups: true }).extend({
	groups: z.array(groupEntrySchema),
	rulesFiles: z.array(ruleFileSchema).optional(),
})

// Build the top-level .alphamodes schema.
const alphamodesZodSchema = z
	.object({
		customModes: z.array(exportedModeConfigSchema),
	})
	.strict()

/**
 * Generates the JSON Schema object for .alphamodes configuration files.
 * Includes metadata fields ($id, title, description).
 */
export function generateAlphamodesJsonSchema(): Record<string, unknown> {
	const jsonSchema = zodToJsonSchema(alphamodesZodSchema, {
		$refStrategy: "none",
		target: "jsonSchema7",
	}) as Record<string, unknown>

	jsonSchema["$id"] = "https://github.com/AlphaInc/Alpha/blob/main/schemas/alphamodes.json"
	jsonSchema["title"] = "Alpha Custom Modes"
	jsonSchema["description"] = "Schema for .alphamodes configuration files used by Alpha to define custom modes."

	return jsonSchema
}
