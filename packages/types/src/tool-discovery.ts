import { z } from "zod"

const discoveredToolNameSchema = z.string().min(1).max(256)
const schemaDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)

/** Arguments accepted by the ordinary native tool used to search deferred MCP tools. */
export const discoverToolsParamsSchema = z
	.object({
		query: z.string().trim().min(1).max(256),
		limit: z.number().int().min(1).max(5).default(3),
	})
	.strict()

// This is the caller-facing input type: the schema supplies the default for an omitted limit.
export type DiscoverToolsParams = z.input<typeof discoverToolsParamsSchema>

/** Stable identity for a discovered function definition. */
export const discoveredToolReferenceSchema = z
	.object({
		name: discoveredToolNameSchema,
		schemaDigest: schemaDigestSchema,
	})
	.strict()

export type DiscoveredToolReference = z.infer<typeof discoveredToolReferenceSchema>

const discoveredFunctionDefinitionSchema = z
	.object({
		name: discoveredToolNameSchema,
		parameters: z.record(z.string(), z.unknown()),
		description: z.string().optional(),
		strict: z.boolean().nullable().optional(),
	})
	.passthrough()

const discoveredFunctionToolSchema = z
	.object({
		type: z.literal("function"),
		function: discoveredFunctionDefinitionSchema,
	})
	.passthrough()

const discoveredToolResultEntrySchema = discoveredToolReferenceSchema
	.extend({ schema: discoveredFunctionToolSchema })
	.superRefine((entry, context) => {
		if (entry.schema.function.name !== entry.name) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["schema", "function", "name"],
				message: "schema.function.name must match name",
			})
		}
	})

/** Successful bounded discovery receipt. The caller owns serialized-size enforcement. */
export const discoverToolsResultSchema = z
	.object({
		version: z.literal(1),
		status: z.literal("success"),
		activation: z.literal("next_step"),
		tools: z.array(discoveredToolResultEntrySchema).max(5),
		message: z.string().max(512).optional(),
	})
	.strict()

export type DiscoverToolsResult = z.infer<typeof discoverToolsResultSchema>
