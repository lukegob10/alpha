import { z } from "zod"

import { deprecatedToolGroups, toolGroupsSchema } from "./tool.js"

/**
 * GroupOptions
 */

export const groupOptionsSchema = z.object({
	fileRegex: z
		.string()
		.optional()
		.refine(
			(pattern) => {
				if (!pattern) {
					return true // Optional, so empty is valid.
				}

				try {
					new RegExp(pattern)
					return true
				} catch {
					return false
				}
			},
			{ message: "Invalid regular expression pattern" },
		),
	description: z.string().optional(),
})

export type GroupOptions = z.infer<typeof groupOptionsSchema>

/**
 * GroupEntry
 */

export const groupEntrySchema = z.union([toolGroupsSchema, z.tuple([toolGroupsSchema, groupOptionsSchema])])

export type GroupEntry = z.infer<typeof groupEntrySchema>

/**
 * ModeConfig
 */

/**
 * Checks if a group entry references a deprecated tool group.
 * Handles both string entries and tuple entries.
 */
function isDeprecatedGroupEntry(entry: unknown): boolean {
	if (typeof entry === "string") {
		return deprecatedToolGroups.includes(entry)
	}
	if (Array.isArray(entry) && entry.length >= 1 && typeof entry[0] === "string") {
		return deprecatedToolGroups.includes(entry[0])
	}
	return false
}

/**
 * Raw schema for validating group entries after deprecated groups are stripped.
 */
const rawGroupEntryArraySchema = z.array(groupEntrySchema).refine(
	(groups) => {
		const seen = new Set()

		return groups.every((group) => {
			// For tuples, check the group name (first element).
			const groupName = Array.isArray(group) ? group[0] : group

			if (seen.has(groupName)) {
				return false
			}

			seen.add(groupName)
			return true
		})
	},
	{ message: "Duplicate groups are not allowed" },
)

/**
 * Schema for mode group entries. Preprocesses the input to strip deprecated
 * legacy tool groups before validation, ensuring backward compatibility
 * with older user configs.
 *
 * The type assertion to `z.ZodType<GroupEntry[], z.ZodTypeDef, GroupEntry[]>` is
 * required because `z.preprocess` erases the input type to `unknown`, which
 * propagates through `modeConfigSchema → alphaCodeSettingsSchema → createRunSchema`
 * and breaks `zodResolver` generic inference in downstream consumers (e.g., web-evals).
 */
export const groupEntryArraySchema = z.preprocess((val) => {
	if (!Array.isArray(val)) return val
	return val.filter((entry) => !isDeprecatedGroupEntry(entry))
}, rawGroupEntryArraySchema) as z.ZodType<GroupEntry[], z.ZodTypeDef, GroupEntry[]>

export const modeConfigSchema = z.object({
	slug: z.string().regex(/^[a-zA-Z0-9-]+$/, "Slug must contain only letters numbers and dashes"),
	name: z.string().min(1, "Name is required"),
	roleDefinition: z.string().min(1, "Role definition is required"),
	whenToUse: z.string().optional(),
	description: z.string().optional(),
	customInstructions: z.string().optional(),
	groups: groupEntryArraySchema,
	source: z.enum(["global", "project"]).optional(),
})

export type ModeConfig = z.infer<typeof modeConfigSchema>

/**
 * CustomModesSettings
 */

export const customModesSettingsSchema = z.object({
	customModes: z.array(modeConfigSchema).refine(
		(modes) => {
			const slugs = new Set()

			return modes.every((mode) => {
				if (slugs.has(mode.slug)) {
					return false
				}

				slugs.add(mode.slug)
				return true
			})
		},
		{
			message: "Duplicate mode slugs are not allowed",
		},
	),
})

export type CustomModesSettings = z.infer<typeof customModesSettingsSchema>

/**
 * PromptComponent
 */

export const promptComponentSchema = z.object({
	roleDefinition: z.string().optional(),
	whenToUse: z.string().optional(),
	description: z.string().optional(),
	customInstructions: z.string().optional(),
})

export type PromptComponent = z.infer<typeof promptComponentSchema>

/**
 * CustomModePrompts
 */

export const customModePromptsSchema = z.record(z.string(), promptComponentSchema.optional())

export type CustomModePrompts = z.infer<typeof customModePromptsSchema>

/**
 * CustomSupportPrompts
 */

export const customSupportPromptsSchema = z.record(z.string(), z.string().optional())

export type CustomSupportPrompts = z.infer<typeof customSupportPromptsSchema>

/**
 * DEFAULT_MODES
 */

const CODE_MODE_INSTRUCTIONS = `Before consequential code changes, ground the approach in relevant repository architecture and conventions, component responsibilities and data flow, states and failure paths, constraints and compatibility. Share a plan when requested or a material choice needs discussion.

Implement the smallest coherent solution: the least unnecessary complexity, not compressed code, monolithic responsibilities, or the fewest files. Preserve sound patterns and maintainable boundaries. For user-facing work, handle relevant validation, loading, empty, error, and recovery states. Write tests that establish requested behavior and important integration boundaries rather than merely exercising implementation details.

If a required verification approach cannot work, repair it or use equivalent evidence at the same behavioral level while preserving explicit requirements. Do not optimize for file count, code volume, test count, token output, or superficial checklist coverage.`

export const PLAN_MODE_INSTRUCTIONS = `You are in strict Plan collaboration mode until the host or user changes modes. Plan the work; do not implement it.

Use only non-mutating repository inspection. Read, list, and search repository evidence before asking questions. You may run only host-approved inspection or source-non-mutating verification commands and read their output. Verification may execute trusted repository test/config code and create ordinary tool caches, but it cannot target output, temp, cache, config, or plugin paths. You may coordinate managed Explore or Review sub-agents for bounded read-only investigation, but never launch or advance a Worker or request file changes, configuration changes, commits, or other side effects.

Resolve facts from the request and available evidence first. Ask a concise follow-up question only when an undiscoverable product or technical choice would materially change the plan. Do not ask the user to choose details that repository inspection can answer.

When the plan is decision-complete, return exactly one handoff block and no text outside it:

<proposed_plan>
# Plan title

A concise summary of the intended outcome and approach.

## Implementation
- Ordered, specific changes with relevant files, components, interfaces, data flow, edge cases, and compatibility constraints.

## Verification
- Tests and checks that establish the requested behavior.

## Assumptions
- Only material assumptions or defaults that remain; write "None" when there are none.
</proposed_plan>

Do not use a todo-management tool as the plan, write a plan file, ask whether the plan is approved, offer to proceed, or switch modes yourself.`

/** The persisted identifier for Plan remains architect. */
export const primaryModeSlugs = ["architect", "code"] as const
export type PrimaryMode = (typeof primaryModeSlugs)[number]

export function isPrimaryMode(mode: unknown): mode is PrimaryMode {
	return mode === "code" || mode === "architect"
}

export function assertPrimaryMode(mode: unknown): asserts mode is PrimaryMode {
	if (!isPrimaryMode(mode)) throw new Error("Unsupported mode. Only Code (code) and Plan (architect) are available.")
}

/** Missing mode predates mode persistence; retired modes resume without write authority. */
export function restoreTaskMode(mode: string | undefined): PrimaryMode {
	return mode === undefined || mode === "" ? "code" : isPrimaryMode(mode) ? mode : "architect"
}

export const DEFAULT_MODES: readonly ModeConfig[] = [
	{
		slug: "architect",
		name: "Plan",
		roleDefinition:
			"You are Alpha in Plan collaboration mode. Investigate the user's request and produce an evidence-grounded, decision-complete implementation plan without making changes.",
		whenToUse:
			"Use Plan mode to investigate a request, clarify only material unresolved decisions, and produce a concrete implementation handoff before any changes are made.",
		description: "Investigate and produce an implementation-ready plan",
		groups: ["read", "command", "agents"],
		customInstructions: PLAN_MODE_INSTRUCTIONS,
	},
	{
		slug: "code",
		name: "Code",
		roleDefinition:
			"You are Alpha, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
		whenToUse:
			"Use this mode when you need to write, modify, or refactor code. Ideal for implementing features, fixing bugs, creating new files, or making code improvements across any programming language or framework.",
		description: "Write, modify, and refactor code",
		groups: ["read", "edit", "command", "mcp", "github", "agents", "browser"],
		customInstructions: CODE_MODE_INSTRUCTIONS,
	},
] as const
