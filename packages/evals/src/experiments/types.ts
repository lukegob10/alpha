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
				"toolImplementationDigest",
				"skillBundleDigest",
				"policyDigest",
				"compactionDigest",
			]),
		)
		.min(1)
		.optional(),
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

export const trialObservationSchema = pairKeySchema.extend({
	variantIdentity: z.string().min(1),
	status: observationStatusSchema,
	firstAttemptStatus: observationStatusSchema,
	retryAssisted: z.boolean(),
	cost: z.number().nonnegative(),
	latencyMs: z.number().nonnegative(),
	capabilities: z.array(z.string().min(1)).min(1),
	risk: z.enum(["low", "medium", "high", "critical"]),
	family: z.string().min(1),
	difficulty: z.enum(["foundation", "challenging", "frontier"]),
})

export type ObservationStatus = z.infer<typeof observationStatusSchema>
export type TrialObservation = z.infer<typeof trialObservationSchema>

export type PairedTrial = { key: PairKey; control: TrialObservation; candidate: TrialObservation }
