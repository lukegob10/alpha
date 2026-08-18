import {
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	DEFAULT_SUBAGENT_DELEGATION_POLICY,
	DEFAULT_SUBAGENT_MAX_DEPTH,
	DEFAULT_SUBAGENT_MAX_INPUT_TOKENS,
	DEFAULT_SUBAGENT_MAX_OUTPUT_TOKENS,
	DEFAULT_SUBAGENT_ROLE_TIMEOUTS_MS,
	GLOBAL_STATE_KEYS,
	createSubagentEffectiveLimits,
	finalizeSubagentDelegationPolicy,
	finalizedSubagentContextManifestSchema,
	finalizedSubagentEffectiveDelegationPolicySchema,
	globalSettingsSchema,
	resolveSubagentDelegationPolicy,
	resolveSubagentOrchestrationSettings,
	subagentContextManifestSchema,
	subagentOrchestratedContextManifestSchema,
	subagentManifestOrchestrationSchema,
	subagentStopReasonSchema,
} from "../index.js"

const digest = (value: string) => value.repeat(64)

const orchestration = {
	ancestry: {
		rootTaskId: "root-1",
		parentTaskId: "parent-1",
		depth: 2,
		maxDepth: 3,
	},
	delegationPolicy: {
		policy: "explicit-only" as const,
		source: "task" as const,
		authorization: "task-opt-in" as const,
		explicitUserRequest: true,
	},
	limits: {
		maxConcurrentTasks: 8,
		maxConcurrentSubagents: 4,
		maxInputTokens: 24_000,
		maxOutputTokens: 6_000,
		roleTimeoutsMs: {
			explore: 120_000,
			review: 300_000,
			worker: 900_000,
		},
		timeoutMs: 300_000,
		rootTokenBudget: 120_000,
		rootCostBudget: 12.5,
	},
}

const legacyManifest = {
	version: 1 as const,
	parentTaskId: "parent-1",
	capturedAt: 1_700_000_000_000,
	requestedForkTurns: "none" as const,
	selectedUserTurns: { count: 0, refs: [] },
	contextRefs: ["parent:parent-1:instructions"],
	workspace: { cwd: "F:/workspace", roots: ["F:/workspace"] },
	instructions: {
		digest: digest("a"),
		sources: [{ kind: "agents", ref: "F:/workspace/AGENTS.md", digest: digest("b") }],
	},
	skills: [],
	modelRoute: {
		source: "parent" as const,
		resolution: "selected" as const,
		profileName: "Default",
		provider: "openai-native",
		modelId: "gpt-5",
	},
	runtimePolicy: {
		role: "review" as const,
		read: true,
		execute: false,
		mutate: false,
		delegate: false,
		network: false,
		externalSideEffects: false,
		requireApproval: true,
		allowedTools: ["read_file", "attempt_completion"],
		workspaceRoots: ["F:/workspace"],
		digest: digest("c"),
	},
	manifestDigest: digest("d"),
}

describe("sub-agent orchestration contracts", () => {
	it("resolves conservative defaults for missing or invalid persisted settings", () => {
		expect(resolveSubagentOrchestrationSettings()).toEqual({
			maxConcurrentSubagents: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
			delegationPolicy: DEFAULT_SUBAGENT_DELEGATION_POLICY,
			maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
			roleTimeoutsMs: DEFAULT_SUBAGENT_ROLE_TIMEOUTS_MS,
			maxInputTokens: DEFAULT_SUBAGENT_MAX_INPUT_TOKENS,
			maxOutputTokens: DEFAULT_SUBAGENT_MAX_OUTPUT_TOKENS,
			rootTokenBudget: null,
			rootCostBudget: null,
		})

		expect(
			resolveSubagentOrchestrationSettings({
				maxConcurrentSubagents: 0,
				subagentDelegationPolicy: "automatic",
				subagentMaxDepth: 99,
				subagentRoleTimeoutsMs: { review: 1 },
				subagentMaxInputTokens: -1,
				subagentMaxOutputTokens: Number.NaN,
				subagentRootTokenBudget: 0,
				subagentRootCostBudget: -1,
			}),
		).toEqual({
			maxConcurrentSubagents: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
			delegationPolicy: DEFAULT_SUBAGENT_DELEGATION_POLICY,
			maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
			roleTimeoutsMs: DEFAULT_SUBAGENT_ROLE_TIMEOUTS_MS,
			maxInputTokens: DEFAULT_SUBAGENT_MAX_INPUT_TOKENS,
			maxOutputTokens: DEFAULT_SUBAGENT_MAX_OUTPUT_TOKENS,
			rootTokenBudget: null,
			rootCostBudget: null,
		})
	})

	it("merges a partial role-timeout override without changing other defaults", () => {
		expect(
			resolveSubagentOrchestrationSettings({
				maxConcurrentSubagents: 6,
				subagentDelegationPolicy: "proactive",
				subagentMaxDepth: 4,
				subagentRoleTimeoutsMs: { worker: 1_200_000 },
				subagentMaxInputTokens: 32_000,
				subagentMaxOutputTokens: 8_000,
				subagentRootTokenBudget: 200_000,
				subagentRootCostBudget: 25,
			}),
		).toEqual({
			maxConcurrentSubagents: 6,
			delegationPolicy: "proactive",
			maxDepth: 4,
			roleTimeoutsMs: {
				explore: DEFAULT_SUBAGENT_ROLE_TIMEOUTS_MS.explore,
				review: DEFAULT_SUBAGENT_ROLE_TIMEOUTS_MS.review,
				worker: 1_200_000,
			},
			maxInputTokens: 32_000,
			maxOutputTokens: 8_000,
			rootTokenBudget: 200_000,
			rootCostBudget: 25,
		})
	})

	it.each([
		["maxConcurrentSubagents", 0],
		["maxConcurrentSubagents", 17],
		["subagentDelegationPolicy", "automatic"],
		["subagentMaxDepth", 0],
		["subagentMaxDepth", 6],
		["subagentRoleTimeoutsMs", { explore: 9_999 }],
		["subagentRoleTimeoutsMs", { worker: 3_600_001 }],
		["subagentMaxInputTokens", 0],
		["subagentMaxOutputTokens", 10_000_001],
		["subagentRootTokenBudget", 0],
		["subagentRootCostBudget", 0],
	])("rejects invalid persisted %s value %j", (key, value) => {
		expect(globalSettingsSchema.safeParse({ [key]: value }).success).toBe(false)
	})

	it("registers every orchestration setting as durable global state", () => {
		expect(GLOBAL_STATE_KEYS).toEqual(
			expect.arrayContaining([
				"maxConcurrentSubagents",
				"subagentDelegationPolicy",
				"subagentMaxDepth",
				"subagentRoleTimeoutsMs",
				"subagentMaxInputTokens",
				"subagentMaxOutputTokens",
				"subagentRootTokenBudget",
				"subagentRootCostBudget",
			]),
		)
	})

	it("keeps explicit-only delegation provisional until trusted approval", () => {
		const provisional = resolveSubagentDelegationPolicy({})
		expect(provisional).toEqual({
			policy: "explicit-only",
			source: "default",
			authorization: "pending-approval",
			explicitUserRequest: false,
		})
		expect(finalizedSubagentEffectiveDelegationPolicySchema.safeParse(provisional).success).toBe(false)
		expect(
			finalizeSubagentDelegationPolicy(provisional, {
				authorization: "group-approval",
				groupApproved: true,
			}),
		).toEqual({
			policy: "explicit-only",
			source: "default",
			authorization: "group-approval",
			explicitUserRequest: true,
		})
		expect(() =>
			finalizeSubagentDelegationPolicy(provisional, {
				authorization: "group-approval",
				groupApproved: false,
			}),
		).toThrow("Group approval evidence")
	})

	it("authorizes trusted task opt-in and proactive policy without conflating their provenance", () => {
		expect(resolveSubagentDelegationPolicy({ taskExplicitlyEnabled: true })).toEqual({
			policy: "explicit-only",
			source: "default",
			authorization: "task-opt-in",
			explicitUserRequest: true,
		})
		const proactive = resolveSubagentDelegationPolicy({ settingsPolicy: "proactive" })
		expect(proactive).toEqual({
			policy: "proactive",
			source: "settings",
			authorization: "proactive-policy",
			explicitUserRequest: false,
		})
		expect(finalizedSubagentEffectiveDelegationPolicySchema.safeParse(proactive).success).toBe(true)
		expect(() =>
			finalizeSubagentDelegationPolicy(resolveSubagentDelegationPolicy({}), {
				authorization: "task-opt-in",
				taskExplicitlyEnabled: false,
			}),
		).toThrow("persisted task opt-in")
	})

	it("prevents descendant policy widening without a trusted user-authored override", () => {
		expect(() =>
			resolveSubagentDelegationPolicy({
				frozenTaskPolicy: "explicit-only",
				requestedChildPolicy: "proactive",
				taskExplicitlyEnabled: true,
			}),
		).toThrow("cannot widen")
		expect(
			resolveSubagentDelegationPolicy({
				frozenTaskPolicy: "explicit-only",
				requestedChildPolicy: "proactive",
				allowUserAuthoredWidening: true,
			}),
		).toEqual({
			policy: "proactive",
			source: "task",
			authorization: "proactive-policy",
			explicitUserRequest: false,
		})
	})

	it("freezes ancestry and effective limits while retaining legacy manifests", () => {
		expect(subagentContextManifestSchema.parse(legacyManifest).orchestration).toBeUndefined()
		expect(subagentOrchestratedContextManifestSchema.safeParse(legacyManifest).success).toBe(false)
		expect(subagentContextManifestSchema.parse({ ...legacyManifest, orchestration }).orchestration).toEqual(
			orchestration,
		)
		expect(subagentOrchestratedContextManifestSchema.safeParse({ ...legacyManifest, orchestration }).success).toBe(
			true,
		)
		expect(finalizedSubagentContextManifestSchema.safeParse({ ...legacyManifest, orchestration }).success).toBe(
			true,
		)
		expect(
			finalizedSubagentContextManifestSchema.safeParse({
				...legacyManifest,
				orchestration: {
					...orchestration,
					delegationPolicy: resolveSubagentDelegationPolicy({}),
				},
			}).success,
		).toBe(false)
		expect(
			subagentManifestOrchestrationSchema.safeParse({
				...orchestration,
				ancestry: { ...orchestration.ancestry, depth: 4 },
			}).success,
		).toBe(false)

		const settings = resolveSubagentOrchestrationSettings({
			maxConcurrentSubagents: 3,
			subagentRoleTimeoutsMs: { review: 240_000 },
			subagentMaxInputTokens: 20_000,
			subagentMaxOutputTokens: 5_000,
			subagentRootTokenBudget: null,
			subagentRootCostBudget: null,
		})
		expect(createSubagentEffectiveLimits(settings, "review", 9)).toEqual({
			maxConcurrentTasks: 9,
			maxConcurrentSubagents: 3,
			maxInputTokens: 20_000,
			maxOutputTokens: 5_000,
			roleTimeoutsMs: {
				...DEFAULT_SUBAGENT_ROLE_TIMEOUTS_MS,
				review: 240_000,
			},
			timeoutMs: 240_000,
			rootTokenBudget: null,
			rootCostBudget: null,
		})
	})

	it.each([
		"completed",
		"cancelled",
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
	])("accepts stable terminal stop reason %s", (reason) => {
		expect(subagentStopReasonSchema.parse(reason)).toBe(reason)
	})

	it("rejects an unstable free-form terminal stop reason", () => {
		expect(subagentStopReasonSchema.safeParse("ran_out_of_stuff").success).toBe(false)
	})
})
