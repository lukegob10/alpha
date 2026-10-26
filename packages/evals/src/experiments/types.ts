import { z } from "zod"

export const experimentTemplateSchema = z.enum(["harness_only", "model_only"])

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)

export const experimentVariantSchema = z.object({
	schemaVersion: z.literal(1),
	id: z.string().min(1),
	extensionCommit: z.string().min(1),
	workingTreeDigest: digest,
	extensionBuildDigest: digest,
	model: z.string().min(1),
	modelSettingsDigest: digest,
	promptDigest: digest,
	toolSchemaDigest: digest,
	toolImplementationDigest: digest,
	skillBundleDigest: digest,
	policyDigest: digest,
	compactionDigest: digest,
	runnerImageDigest: digest,
	resourceProfileDigest: digest,
	permissionDigest: digest,
	networkMode: z.string().min(1),
	retryPolicyDigest: digest,
})

export const taskSetManifestSchema = z.object({
	schemaVersion: z.literal(1),
	id: z.string().min(1),
	version: z.number().int().positive(),
	tasks: z.array(z.object({ id: z.string(), version: z.number().int().positive(), digest })).min(1),
})

export const pairKeySchema = z.object({
	taskId: z.string(),
	taskVersion: z.number().int().positive(),
	seed: z.number().int(),
	repetition: z.number().int().nonnegative(),
	resourceProfileDigest: digest,
	permissionDigest: digest,
	networkMode: z.string(),
	retryPolicyDigest: digest,
	timeWindow: z.string(),
})

// Capture this digest before execution; a declaration reconstructed from outcomes is descriptive only.
export const experimentDecisionPlanSchema = z.object({
	id: z.string().min(1),
	declaredAt: z.string().datetime(),
	claim: z.literal("fixed-system-paired-outcome"),
	population: z.string().min(1),
	taskSetIdentity: z.string().min(1),
	controlRunId: z.string().min(1),
	candidateRunId: z.string().min(1),
	sampling: z.literal("independent-units"),
	objective: z.enum(["noninferiority", "improvement"]),
	margin: z.number().finite().min(0).max(1),
	independentUnit: z.enum(["task", "repository", "family"]),
	weights: z.literal("equal-independent-unit"),
	exclusionRule: z.literal("paired-scoreable"),
	decisionSchedule: z.literal("fixed-final"),
	confidence: z.literal(0.95),
	minimumIndependentUnits: z.number().int().positive(),
	plannedPairs: z.number().int().positive(),
	minimumPairedCoverage: z.number().finite().positive().max(1),
	maximumIntervalWidth: z.number().finite().positive().max(2),
	requiredFamilies: z
		.array(z.string().min(1))
		.min(1)
		.refine((values) => new Set(values).size === values.length, "Task families must be unique"),
	timeBlocks: z
		.array(
			z
				.object({
					id: z.string().min(1),
					startsAt: z.string().datetime(),
					endsAt: z.string().datetime(),
				})
				.refine(
					(block) => Date.parse(block.startsAt) < Date.parse(block.endsAt),
					"Time block must have positive duration",
				),
		)
		.min(1)
		.refine(
			(blocks) => new Set(blocks.map(({ id }) => id)).size === blocks.length,
			"Time block IDs must be unique",
		),
	resourceProtocolDigest: digest,
	cacheProtocolDigest: digest,
})

export type ExperimentDecisionPlan = z.infer<typeof experimentDecisionPlanSchema>

export const experimentManifestSchema = z.object({
	schemaVersion: z.literal(1),
	id: z.string().min(1),
	template: experimentTemplateSchema,
	taskSetIdentity: z.string().min(1),
	controlVariantIdentity: z.string().min(1),
	candidateVariantIdentity: z.string().min(1),
	pairs: z.array(pairKeySchema).min(1),
	allowedDifferenceFields: z
		.array(
			z.enum([
				"extensionCommit",
				"workingTreeDigest",
				"extensionBuildDigest",
				"model",
				"modelSettingsDigest",
				"promptDigest",
				"toolSchemaDigest",
				"toolImplementationDigest",
				"skillBundleDigest",
				"policyDigest",
				"compactionDigest",
			]),
		)
		.min(1)
		.optional(),
	independentUnit: z.enum(["task", "repository", "family", "attempt"]).optional(),
	decisionPlan: experimentDecisionPlanSchema.optional(),
})

export type ExperimentTemplate = z.infer<typeof experimentTemplateSchema>
export type ExperimentVariant = z.infer<typeof experimentVariantSchema>
export type TaskSetManifest = z.infer<typeof taskSetManifestSchema>
export type PairKey = z.infer<typeof pairKeySchema>
export type ExperimentManifest = z.infer<typeof experimentManifestSchema>

export const observationStatusSchema = z.enum([
	"passed",
	"outcome_failed",
	"safety_failed",
	"budget_exhausted",
	"agent_error",
	"infrastructure_error",
	"grader_error",
	"cancelled",
	"human_handoff",
])

export const performanceMetricNames = [
	"firstResponseMs",
	"firstUsefulResponseMs",
	"hostOverheadMs",
	"providerMs",
	"retryDelayMs",
	"toolsMs",
	"providerRetries",
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens",
] as const

const measurement = z.number().finite().nonnegative().nullable().optional()
export const trialPerformanceSchema = z.object({
	firstResponseMs: measurement,
	firstUsefulResponseMs: measurement,
	hostOverheadMs: measurement,
	providerMs: measurement,
	retryDelayMs: measurement,
	toolsMs: measurement,
	providerRetries: measurement,
	inputTokens: measurement,
	outputTokens: measurement,
	cacheReadTokens: measurement,
	cacheWriteTokens: measurement,
	reasoningTokens: measurement,
})

export const trialObservationSchema = pairKeySchema.extend({
	variantIdentity: z.string().min(1),
	runId: z.string().min(1).optional(),
	status: observationStatusSchema,
	firstAttemptStatus: observationStatusSchema,
	retryAssisted: z.boolean(),
	cost: z.number().finite().nonnegative().nullable(),
	tokens: z.number().int().nonnegative().nullable().optional(),
	repository: z.string().min(1).optional(),
	latencyMs: z.number().finite().nonnegative(),
	performance: trialPerformanceSchema.optional(),
	decisionPlanDigest: digest.optional(),
	startedAt: z.string().datetime().optional(),
	capturedTimeWindow: z.string().min(1).optional(),
	capabilities: z.array(z.string().min(1)).min(1),
	risk: z.enum(["low", "medium", "high", "critical"]),
	family: z.string().min(1),
	difficulty: z.enum(["foundation", "challenging", "frontier"]),
})

export type ObservationStatus = z.infer<typeof observationStatusSchema>
export type TrialObservation = z.infer<typeof trialObservationSchema>

export type PairedTrial = { key: PairKey; control: TrialObservation; candidate: TrialObservation }
