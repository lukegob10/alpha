import { z } from "zod"

import { subagentModelRouteStateSchema, subagentRoleSchema } from "./subagent.js"

export const SUBAGENT_CONTEXT_MANIFEST_VERSION = 1 as const

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/
const CANONICAL_POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/

export const subagentContextDigestSchema = z.string().regex(SHA256_HEX_PATTERN)
export type SubagentContextDigest = z.infer<typeof subagentContextDigestSchema>

/**
 * The model-facing `fork_turns` value. Numeric selections are strings so strict
 * tool schemas do not need to accept an unbounded integer union.
 */
export const subagentForkTurnsSchema = z.union([
	z.literal("none"),
	z.literal("all"),
	z
		.string()
		.regex(CANONICAL_POSITIVE_INTEGER_PATTERN)
		.refine((value) => Number.isSafeInteger(Number(value)), "fork_turns must be a safe positive integer"),
])
export type SubagentForkTurns = z.infer<typeof subagentForkTurnsSchema>

export function isSubagentForkTurns(value: unknown): value is SubagentForkTurns {
	return subagentForkTurnsSchema.safeParse(value).success
}

export const subagentContextTurnRefSchema = z
	.object({
		ref: z.string().min(1),
		/** Zero-based ordinal of the user-led turn in the parent conversation. */
		ordinal: z.number().int().nonnegative(),
		/** Zero-based parent API-message indexes selected for this user-led turn. */
		sourceMessageIndexes: z.array(z.number().int().nonnegative()).min(1),
		digest: subagentContextDigestSchema,
	})
	.strict()
export type SubagentContextTurnRef = z.infer<typeof subagentContextTurnRefSchema>

export const subagentContextSelectedUserTurnsSchema = z
	.object({
		count: z.number().int().nonnegative(),
		refs: z.array(subagentContextTurnRefSchema),
	})
	.strict()
	.refine(({ count, refs }) => count === refs.length, {
		message: "selected user-turn count must match refs length",
		path: ["count"],
	})
export type SubagentContextSelectedUserTurns = z.infer<typeof subagentContextSelectedUserTurnsSchema>

export const subagentContextWorkspaceSchema = z
	.object({
		cwd: z.string().min(1),
		roots: z.array(z.string().min(1)).min(1),
	})
	.strict()
export type SubagentContextWorkspace = z.infer<typeof subagentContextWorkspaceSchema>

export const subagentContextInstructionSourceSchema = z
	.object({
		kind: z.string().min(1),
		ref: z.string().min(1),
		digest: subagentContextDigestSchema,
	})
	.strict()
export type SubagentContextInstructionSource = z.infer<typeof subagentContextInstructionSourceSchema>

export const subagentContextInstructionsSchema = z
	.object({
		digest: subagentContextDigestSchema,
		sources: z.array(subagentContextInstructionSourceSchema).min(1),
	})
	.strict()
export type SubagentContextInstructions = z.infer<typeof subagentContextInstructionsSchema>

export const subagentContextSkillSchema = z
	.object({
		name: z.string().min(1),
		path: z.string().min(1),
		digest: subagentContextDigestSchema,
	})
	.strict()
export type SubagentContextSkill = z.infer<typeof subagentContextSkillSchema>

/** Persisted, credential-free record of the authority actually applied to the child. */
export const subagentContextRuntimePolicySchema = z
	.object({
		role: subagentRoleSchema,
		read: z.boolean(),
		execute: z.boolean(),
		mutate: z.boolean(),
		delegate: z.boolean(),
		network: z.boolean(),
		externalSideEffects: z.boolean(),
		requireApproval: z.boolean(),
		allowedTools: z.array(z.string().min(1)).min(1),
		workspaceRoots: z.array(z.string().min(1)).min(1),
		writeScope: z.array(z.string().min(1)).min(1).max(12).optional(),
		digest: subagentContextDigestSchema,
	})
	.strict()
	.superRefine(({ role, execute, mutate, writeScope }, context) => {
		if ((role === "explore" || role === "review") && (execute || mutate)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `${role} context policy must remain read-only`,
				path: [execute ? "execute" : "mutate"],
			})
		}
		if (role === "worker" && !writeScope) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "worker context policy requires writeScope",
				path: ["writeScope"],
			})
		}
	})
export type SubagentContextRuntimePolicy = z.infer<typeof subagentContextRuntimePolicySchema>

/**
 * Durable audit metadata for explicit child-context inheritance. Conversation
 * bodies and provider credentials intentionally live outside this manifest.
 */
export const subagentContextManifestSchema = z
	.object({
		version: z.literal(SUBAGENT_CONTEXT_MANIFEST_VERSION),
		parentTaskId: z.string().min(1),
		capturedAt: z.number().int().nonnegative(),
		requestedForkTurns: subagentForkTurnsSchema,
		selectedUserTurns: subagentContextSelectedUserTurnsSchema,
		contextRefs: z.array(z.string().min(1)).min(1),
		workspace: subagentContextWorkspaceSchema,
		instructions: subagentContextInstructionsSchema,
		skills: z.array(subagentContextSkillSchema),
		modelRoute: subagentModelRouteStateSchema.strict(),
		runtimePolicy: subagentContextRuntimePolicySchema,
		manifestDigest: subagentContextDigestSchema,
	})
	.strict()
	.superRefine(({ requestedForkTurns, selectedUserTurns }, context) => {
		if (requestedForkTurns === "none" && selectedUserTurns.count !== 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "fork_turns none cannot select parent turns",
				path: ["selectedUserTurns", "count"],
			})
		}

		if (
			requestedForkTurns !== "none" &&
			requestedForkTurns !== "all" &&
			selectedUserTurns.count > Number(requestedForkTurns)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "selected parent-turn count exceeds fork_turns",
				path: ["selectedUserTurns", "count"],
			})
		}
	})
export type SubagentContextManifest = z.infer<typeof subagentContextManifestSchema>
