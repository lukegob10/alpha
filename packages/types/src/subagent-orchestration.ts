import { z } from "zod"

import { subagentRoleSchema, type SubagentRole } from "./subagent.js"

export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 2
export const MIN_MAX_CONCURRENT_SUBAGENTS = 1
export const MAX_MAX_CONCURRENT_SUBAGENTS = 16

export const DEFAULT_SUBAGENT_DELEGATION_POLICY = "explicit-only" as const

export const DEFAULT_SUBAGENT_MAX_DEPTH = 1
export const MIN_SUBAGENT_MAX_DEPTH = 1
export const MAX_SUBAGENT_MAX_DEPTH = 5

export const MIN_SUBAGENT_ROLE_TIMEOUT_MS = 10_000
export const MAX_SUBAGENT_ROLE_TIMEOUT_MS = 3_600_000
export const DEFAULT_SUBAGENT_ROLE_TIMEOUTS_MS = Object.freeze({
	explore: 120_000,
	review: 120_000,
	worker: 900_000,
}) satisfies Readonly<Record<SubagentRole, number>>

export const MIN_SUBAGENT_TOKEN_LIMIT = 1
export const MAX_SUBAGENT_TOKEN_LIMIT = 10_000_000
export const DEFAULT_SUBAGENT_MAX_INPUT_TOKENS = 16_000
export const DEFAULT_SUBAGENT_MAX_OUTPUT_TOKENS = 4_000
export const DEFAULT_SUBAGENT_ROOT_TOKEN_BUDGET = null
export const DEFAULT_SUBAGENT_ROOT_COST_BUDGET = null

export const maxConcurrentSubagentsSchema = z
	.number()
	.int()
	.min(MIN_MAX_CONCURRENT_SUBAGENTS)
	.max(MAX_MAX_CONCURRENT_SUBAGENTS)

export const subagentDelegationPolicySchema = z.enum(["explicit-only", "proactive"])
export type SubagentDelegationPolicy = z.infer<typeof subagentDelegationPolicySchema>

export const subagentMaxDepthSchema = z.number().int().min(MIN_SUBAGENT_MAX_DEPTH).max(MAX_SUBAGENT_MAX_DEPTH)

export const subagentRoleTimeoutMsSchema = z
	.number()
	.int()
	.min(MIN_SUBAGENT_ROLE_TIMEOUT_MS)
	.max(MAX_SUBAGENT_ROLE_TIMEOUT_MS)

/** Persisted settings may override any subset of role defaults. */
export const subagentRoleTimeoutsMsSchema = z
	.object({
		explore: subagentRoleTimeoutMsSchema.optional(),
		review: subagentRoleTimeoutMsSchema.optional(),
		worker: subagentRoleTimeoutMsSchema.optional(),
	})
	.strict()
export type SubagentRoleTimeoutsMs = z.infer<typeof subagentRoleTimeoutsMsSchema>

export const effectiveSubagentRoleTimeoutsMsSchema = z
	.object({
		explore: subagentRoleTimeoutMsSchema,
		review: subagentRoleTimeoutMsSchema,
		worker: subagentRoleTimeoutMsSchema,
	})
	.strict()
export type EffectiveSubagentRoleTimeoutsMs = z.infer<typeof effectiveSubagentRoleTimeoutsMsSchema>

export const subagentTokenLimitSchema = z.number().int().min(MIN_SUBAGENT_TOKEN_LIMIT).max(MAX_SUBAGENT_TOKEN_LIMIT)

export const subagentRootTokenBudgetSchema = subagentTokenLimitSchema.nullable()
export const subagentRootCostBudgetSchema = z.number().finite().positive().nullable()

/** The orchestration-only subset of GlobalSettings, before defaults are applied. */
export const subagentOrchestrationSettingsSchema = z
	.object({
		maxConcurrentSubagents: maxConcurrentSubagentsSchema.optional(),
		subagentDelegationPolicy: subagentDelegationPolicySchema.optional(),
		subagentMaxDepth: subagentMaxDepthSchema.optional(),
		subagentRoleTimeoutsMs: subagentRoleTimeoutsMsSchema.optional(),
		subagentMaxInputTokens: subagentTokenLimitSchema.optional(),
		subagentMaxOutputTokens: subagentTokenLimitSchema.optional(),
		subagentRootTokenBudget: subagentRootTokenBudgetSchema.optional(),
		subagentRootCostBudget: subagentRootCostBudgetSchema.optional(),
	})
	.strict()
export type SubagentOrchestrationSettings = z.infer<typeof subagentOrchestrationSettingsSchema>

export const resolvedSubagentOrchestrationSettingsSchema = z
	.object({
		maxConcurrentSubagents: maxConcurrentSubagentsSchema,
		delegationPolicy: subagentDelegationPolicySchema,
		maxDepth: subagentMaxDepthSchema,
		roleTimeoutsMs: effectiveSubagentRoleTimeoutsMsSchema,
		maxInputTokens: subagentTokenLimitSchema,
		maxOutputTokens: subagentTokenLimitSchema,
		rootTokenBudget: subagentRootTokenBudgetSchema,
		rootCostBudget: subagentRootCostBudgetSchema,
	})
	.strict()
export type ResolvedSubagentOrchestrationSettings = z.infer<typeof resolvedSubagentOrchestrationSettingsSchema>

function parseOrDefault<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
	const parsed = schema.safeParse(value)
	return parsed.success ? parsed.data : fallback
}

/**
 * Resolve persisted values without trusting their runtime shape. Invalid or
 * missing legacy values fall back to frozen conservative defaults.
 */
export function resolveSubagentOrchestrationSettings(
	settings: Partial<Record<keyof SubagentOrchestrationSettings, unknown>> = {},
): ResolvedSubagentOrchestrationSettings {
	const timeoutOverrides = parseOrDefault(subagentRoleTimeoutsMsSchema, settings.subagentRoleTimeoutsMs, {})

	return resolvedSubagentOrchestrationSettingsSchema.parse({
		maxConcurrentSubagents: parseOrDefault(
			maxConcurrentSubagentsSchema,
			settings.maxConcurrentSubagents,
			DEFAULT_MAX_CONCURRENT_SUBAGENTS,
		),
		delegationPolicy: parseOrDefault(
			subagentDelegationPolicySchema,
			settings.subagentDelegationPolicy,
			DEFAULT_SUBAGENT_DELEGATION_POLICY,
		),
		maxDepth: parseOrDefault(subagentMaxDepthSchema, settings.subagentMaxDepth, DEFAULT_SUBAGENT_MAX_DEPTH),
		roleTimeoutsMs: { ...DEFAULT_SUBAGENT_ROLE_TIMEOUTS_MS, ...timeoutOverrides },
		maxInputTokens: parseOrDefault(
			subagentTokenLimitSchema,
			settings.subagentMaxInputTokens,
			DEFAULT_SUBAGENT_MAX_INPUT_TOKENS,
		),
		maxOutputTokens: parseOrDefault(
			subagentTokenLimitSchema,
			settings.subagentMaxOutputTokens,
			DEFAULT_SUBAGENT_MAX_OUTPUT_TOKENS,
		),
		rootTokenBudget: parseOrDefault(
			subagentRootTokenBudgetSchema,
			settings.subagentRootTokenBudget,
			DEFAULT_SUBAGENT_ROOT_TOKEN_BUDGET,
		),
		rootCostBudget: parseOrDefault(
			subagentRootCostBudgetSchema,
			settings.subagentRootCostBudget,
			DEFAULT_SUBAGENT_ROOT_COST_BUDGET,
		),
	})
}

export const subagentDelegationPolicySourceSchema = z.enum(["default", "settings", "task"])
export type SubagentDelegationPolicySource = z.infer<typeof subagentDelegationPolicySourceSchema>

export const subagentDelegationAuthorizationSchema = z.enum([
	"pending-approval",
	"group-approval",
	"task-opt-in",
	"proactive-policy",
])
export type SubagentDelegationAuthorization = z.infer<typeof subagentDelegationAuthorizationSchema>

export const subagentFinalDelegationAuthorizationSchema = z.enum(["group-approval", "task-opt-in", "proactive-policy"])
export type SubagentFinalDelegationAuthorization = z.infer<typeof subagentFinalDelegationAuthorizationSchema>

/** Trusted, per-spawn delegation decision frozen into the child manifest. */
export const subagentEffectiveDelegationPolicySchema = z
	.object({
		policy: subagentDelegationPolicySchema,
		source: subagentDelegationPolicySourceSchema,
		authorization: subagentDelegationAuthorizationSchema,
		/** Determined from trusted user/task state, never from model tool arguments. */
		explicitUserRequest: z.boolean(),
	})
	.strict()
	.superRefine(({ policy, authorization, explicitUserRequest }, context) => {
		const requiresExplicitRequest = policy === "explicit-only" && authorization !== "pending-approval"
		const recordsExplicitRequest = authorization === "group-approval" || authorization === "task-opt-in"
		if (requiresExplicitRequest && !recordsExplicitRequest) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["authorization"],
				message: "explicit-only delegation requires a trusted explicit user request",
			})
		}
		if (explicitUserRequest !== recordsExplicitRequest) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["explicitUserRequest"],
				message: "explicitUserRequest must agree with delegation authorization provenance",
			})
		}
		if (authorization === "proactive-policy" && policy !== "proactive") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["authorization"],
				message: "proactive-policy authorization requires proactive delegation policy",
			})
		}
	})
export type SubagentEffectiveDelegationPolicy = z.infer<typeof subagentEffectiveDelegationPolicySchema>

/** Launch/persistence form: provisional approval state is no longer accepted. */
export const finalizedSubagentEffectiveDelegationPolicySchema = subagentEffectiveDelegationPolicySchema.superRefine(
	({ authorization }, context) => {
		if (authorization === "pending-approval") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["authorization"],
				message: "delegation authorization must be finalized before launch",
			})
		}
	},
)
export type FinalizedSubagentEffectiveDelegationPolicy = z.infer<
	typeof finalizedSubagentEffectiveDelegationPolicySchema
>

export interface ResolveSubagentDelegationPolicyOptions {
	settingsPolicy?: unknown
	frozenTaskPolicy?: unknown
	requestedChildPolicy?: unknown
	/** Trusted persisted task opt-in. Model tool arguments must never populate this. */
	taskExplicitlyEnabled?: boolean
}

/**
 * Resolve a per-spawn policy. Descendants may always narrow proactive to
 * explicit-only; no per-task or descendant override may widen explicit-only
 * to proactive.
 */
export function resolveSubagentDelegationPolicy({
	settingsPolicy,
	frozenTaskPolicy,
	requestedChildPolicy,
	taskExplicitlyEnabled = false,
}: ResolveSubagentDelegationPolicyOptions): SubagentEffectiveDelegationPolicy {
	const parsedSettings = subagentDelegationPolicySchema.safeParse(settingsPolicy)
	const parsedFrozen = subagentDelegationPolicySchema.safeParse(frozenTaskPolicy)
	const parsedRequested = subagentDelegationPolicySchema.safeParse(requestedChildPolicy)

	let policy: SubagentDelegationPolicy = parsedFrozen.success
		? parsedFrozen.data
		: parsedSettings.success
			? parsedSettings.data
			: DEFAULT_SUBAGENT_DELEGATION_POLICY
	let source: SubagentDelegationPolicySource = parsedFrozen.success
		? "task"
		: parsedSettings.success
			? "settings"
			: "default"

	if (parsedRequested.success && parsedRequested.data !== policy) {
		const narrows = policy === "proactive" && parsedRequested.data === "explicit-only"
		if (!narrows) {
			throw new Error("A task cannot widen explicit-only delegation policy to proactive")
		}
		policy = parsedRequested.data
		source = "task"
	}

	const resolvedAuthorization: SubagentDelegationAuthorization = taskExplicitlyEnabled
		? "task-opt-in"
		: policy === "proactive"
			? "proactive-policy"
			: "pending-approval"
	const recordsExplicitRequest = resolvedAuthorization === "task-opt-in"

	return subagentEffectiveDelegationPolicySchema.parse({
		policy,
		source,
		authorization: resolvedAuthorization,
		explicitUserRequest: recordsExplicitRequest,
	})
}

export type FinalizeSubagentDelegationPolicyAuthorization =
	| { authorization: "group-approval"; groupApproved: boolean }
	| { authorization: "task-opt-in"; taskExplicitlyEnabled: boolean }
	| { authorization: "proactive-policy" }

/** Finalize a trusted approval decision immediately before launch/persistence. */
export function finalizeSubagentDelegationPolicy(
	decision: SubagentEffectiveDelegationPolicy,
	evidence: FinalizeSubagentDelegationPolicyAuthorization,
): FinalizedSubagentEffectiveDelegationPolicy {
	if (evidence.authorization === "group-approval" && evidence.groupApproved !== true) {
		throw new Error("Group approval evidence is required to authorize explicit-only delegation")
	}
	if (evidence.authorization === "task-opt-in" && evidence.taskExplicitlyEnabled !== true) {
		throw new Error("A persisted task opt-in is required to auto-approve explicit-only delegation")
	}
	const authorization: SubagentFinalDelegationAuthorization = evidence.authorization
	const explicitUserRequest = authorization === "group-approval" || authorization === "task-opt-in"
	return finalizedSubagentEffectiveDelegationPolicySchema.parse({
		...decision,
		authorization,
		explicitUserRequest,
	})
}

/** Root-relative child ancestry. Root tasks are depth 0; their direct children are depth 1. */
export const subagentAncestrySchema = z
	.object({
		rootTaskId: z.string().min(1),
		parentTaskId: z.string().min(1),
		depth: z.number().int().min(1),
		maxDepth: subagentMaxDepthSchema,
	})
	.strict()
	.refine(({ depth, maxDepth }) => depth <= maxDepth, {
		path: ["depth"],
		message: "sub-agent depth cannot exceed maxDepth",
	})
export type SubagentAncestry = z.infer<typeof subagentAncestrySchema>

/** Effective, immutable ceilings applied to one child for its entire retained lifetime. */
export const subagentEffectiveLimitsSchema = z
	.object({
		maxConcurrentTasks: z.number().int().positive(),
		maxConcurrentSubagents: maxConcurrentSubagentsSchema,
		maxInputTokens: subagentTokenLimitSchema,
		maxOutputTokens: subagentTokenLimitSchema,
		/** Frozen root role map used when a child creates a differently typed descendant. */
		roleTimeoutsMs: effectiveSubagentRoleTimeoutsMsSchema,
		/** Selected timeout for this child role. */
		timeoutMs: subagentRoleTimeoutMsSchema,
		rootTokenBudget: subagentRootTokenBudgetSchema,
		rootCostBudget: subagentRootCostBudgetSchema,
	})
	.strict()
export type SubagentEffectiveLimits = z.infer<typeof subagentEffectiveLimitsSchema>

/** Root-wide ceilings shown before a role-specific child timeout is selected. */
export const subagentRootEffectiveLimitsSchema = subagentEffectiveLimitsSchema.omit({ timeoutMs: true })
export type SubagentRootEffectiveLimits = z.infer<typeof subagentRootEffectiveLimitsSchema>

/** Compact list_agents view of the settings that the root is using for new descendants. */
export const subagentRootOrchestrationSummarySchema = z
	.object({
		source: z.enum(["configured", "frozen"]),
		delegationPolicy: subagentDelegationPolicySchema,
		maxDepth: subagentMaxDepthSchema,
		limits: subagentRootEffectiveLimitsSchema,
	})
	.strict()
export type SubagentRootOrchestrationSummary = z.infer<typeof subagentRootOrchestrationSummarySchema>

export const subagentManifestOrchestrationSchema = z
	.object({
		ancestry: subagentAncestrySchema,
		delegationPolicy: subagentEffectiveDelegationPolicySchema,
		limits: subagentEffectiveLimitsSchema,
	})
	.strict()
export type SubagentManifestOrchestration = z.infer<typeof subagentManifestOrchestrationSchema>

/** Launch/recovery form; pending approval provenance is not sufficient to execute. */
export const finalizedSubagentManifestOrchestrationSchema = z
	.object({
		ancestry: subagentAncestrySchema,
		delegationPolicy: finalizedSubagentEffectiveDelegationPolicySchema,
		limits: subagentEffectiveLimitsSchema,
	})
	.strict()
export type FinalizedSubagentManifestOrchestration = z.infer<typeof finalizedSubagentManifestOrchestrationSchema>

export function createSubagentEffectiveLimits(
	settings: ResolvedSubagentOrchestrationSettings,
	role: SubagentRole,
	maxConcurrentTasks: number,
): SubagentEffectiveLimits {
	return subagentEffectiveLimitsSchema.parse({
		maxConcurrentTasks,
		maxConcurrentSubagents: settings.maxConcurrentSubagents,
		maxInputTokens: settings.maxInputTokens,
		maxOutputTokens: settings.maxOutputTokens,
		roleTimeoutsMs: structuredClone(settings.roleTimeoutsMs),
		timeoutMs: settings.roleTimeoutsMs[subagentRoleSchema.parse(role)],
		rootTokenBudget: settings.rootTokenBudget,
		rootCostBudget: settings.rootCostBudget,
	})
}

/** Persisted usage used for both per-child and root-tree budget accounting. */
export const subagentUsageSchema = z.object({
	inputTokens: z.number().int().nonnegative().optional(),
	outputTokens: z.number().int().nonnegative().optional(),
	cost: z.number().finite().nonnegative().optional(),
	durationMs: z.number().nonnegative(),
	rateLimitWaitCount: z.number().int().nonnegative().optional(),
	rateLimitWaitMs: z.number().nonnegative().optional(),
	rateLimitIntervalSeconds: z.number().nonnegative().optional(),
})
export type SubagentUsage = z.infer<typeof subagentUsageSchema>

/** Stable terminal cause used by persistence, mailbox results, recovery, and UI projections. */
export const subagentStopReasonSchema = z.enum([
	"completed",
	"cancelled",
	"never_launched",
	"parent_cancelled",
	"ancestor_cancelled",
	"interrupted",
	"timeout",
	"input_token_limit",
	"output_token_limit",
	"root_token_budget",
	"root_cost_budget",
	"depth_limit",
	"authority_denied",
	"orphaned",
	"recovery_failed",
	"failed",
])
export type SubagentStopReason = z.infer<typeof subagentStopReasonSchema>
