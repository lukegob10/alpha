import { z } from "zod"

import { subagentModelRouteStateSchema, subagentRoleSchema } from "./subagent.js"
import {
	finalizedSubagentManifestOrchestrationSchema,
	subagentManifestOrchestrationSchema,
} from "./subagent-orchestration.js"

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

/**
 * The user's effective approval grant at the point a managed child is created.
 * Runtime settings may narrow this grant, but descendants may never widen it.
 */
export const subagentCommandApprovalRuleSchema = z
	.object({
		/** UTF-16 code-unit length of the normalized command prefix. */
		prefixLength: z.number().int().positive(),
		/** Salted digest of the normalized prefix; the prefix itself is never persisted. */
		digest: subagentContextDigestSchema,
	})
	.strict()
export type SubagentCommandApprovalRule = z.infer<typeof subagentCommandApprovalRuleSchema>

export const subagentCommandApprovalPolicySchema = z
	.object({
		algorithm: z.literal("sha256-salted-prefix-v1"),
		salt: subagentContextDigestSchema,
		allowAll: z.boolean(),
		denyAll: z.boolean(),
		allowed: z.array(subagentCommandApprovalRuleSchema),
		denied: z.array(subagentCommandApprovalRuleSchema),
	})
	.strict()
export type SubagentCommandApprovalPolicy = z.infer<typeof subagentCommandApprovalPolicySchema>

export const subagentAutoApprovalPolicySchema = z
	.object({
		autoApprovalEnabled: z.boolean(),
		alwaysAllowReadOnly: z.boolean(),
		alwaysAllowReadOnlyOutsideWorkspace: z.boolean(),
		alwaysAllowWrite: z.boolean(),
		alwaysAllowWriteOutsideWorkspace: z.boolean(),
		alwaysAllowWriteProtected: z.boolean(),
		alwaysAllowExecute: z.boolean(),
		alwaysAllowSubagents: z.boolean(),
		commandApproval: subagentCommandApprovalPolicySchema,
		/** Additional frozen command-policy ceilings inherited across nested launches. Every ceiling must approve. */
		commandApprovalCeilings: z.array(subagentCommandApprovalPolicySchema).max(16).optional(),
	})
	.strict()
export type SubagentAutoApprovalPolicy = z.infer<typeof subagentAutoApprovalPolicySchema>

/** Fail-closed ceiling for retained children whose legacy manifest predates approval capture. */
export const disabledSubagentAutoApprovalPolicy: SubagentAutoApprovalPolicy = subagentAutoApprovalPolicySchema.parse({
	autoApprovalEnabled: false,
	alwaysAllowReadOnly: false,
	alwaysAllowReadOnlyOutsideWorkspace: false,
	alwaysAllowWrite: false,
	alwaysAllowWriteOutsideWorkspace: false,
	alwaysAllowWriteProtected: false,
	alwaysAllowExecute: false,
	alwaysAllowSubagents: false,
	commandApproval: {
		algorithm: "sha256-salted-prefix-v1",
		salt: "0".repeat(64),
		allowAll: false,
		denyAll: false,
		allowed: [],
		denied: [],
	},
})

/** Persisted record of child authority that excludes plaintext command rules and credentials. */
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
		/** Entries in writeScope that grant one exact file rather than a directory subtree. */
		fileWriteScope: z.array(z.string().min(1)).max(12).optional(),
		/**
		 * Approval ceiling inherited from the parent. Optional only for retained
		 * manifests created before approval inheritance was introduced.
		 */
		autoApproval: subagentAutoApprovalPolicySchema.optional(),
		digest: subagentContextDigestSchema,
	})
	.strict()
	.superRefine(({ role, execute, mutate, writeScope, fileWriteScope }, context) => {
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
		if (role !== "worker" && fileWriteScope !== undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "only worker context policy may retain exact-file write scope",
				path: ["fileWriteScope"],
			})
		}
		for (const exactFile of fileWriteScope ?? []) {
			if (!writeScope?.includes(exactFile)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "exact-file write scope must be included in writeScope",
					path: ["fileWriteScope"],
				})
				break
			}
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
		/**
		 * Frozen guardrails for new managed children. Optional only so retained
		 * pre-guardrail manifests remain readable during conservative migration.
		 */
		orchestration: subagentManifestOrchestrationSchema.optional(),
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

/** Required orchestration form for every newly created managed-child record. */
export const subagentOrchestratedContextManifestSchema = z.intersection(
	subagentContextManifestSchema,
	z.object({ orchestration: subagentManifestOrchestrationSchema }),
)
export type SubagentOrchestratedContextManifest = z.infer<typeof subagentOrchestratedContextManifestSchema>

/** Finalized form required before a managed child may launch or relaunch after recovery. */
export const finalizedSubagentContextManifestSchema = z.intersection(
	subagentContextManifestSchema,
	z.object({ orchestration: finalizedSubagentManifestOrchestrationSchema }),
)
export type FinalizedSubagentContextManifest = z.infer<typeof finalizedSubagentContextManifestSchema>
