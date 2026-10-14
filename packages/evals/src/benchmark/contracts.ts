import { z } from "zod"

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const id = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/)

export const benchmarkPartitionSchema = z.enum(["smoke", "development", "regression", "holdout"])
export const benchmarkDifficultySchema = z.enum(["foundation", "challenging", "frontier"])
export const benchmarkAdmissionSchema = z.enum(["draft", "calibrating", "admitted", "retired"])
export const benchmarkContextBandSchema = z.enum(["compact", "medium", "long"])
export const benchmarkEditTopologySchema = z.enum(["single-file", "multi-file", "cross-package"])
export const benchmarkEvidenceRequirementSchema = z.enum([
	"final_workspace",
	"changed_paths",
	"normalized_trace",
	"usage",
	"environment",
	"final_response",
	"grader_evidence",
])

export const benchmarkGraderReferenceSchema = z
	.object({
		id,
		version: z.number().int().positive(),
		alias: id,
		bundleId: id.optional(),
		bundleVersion: z.number().int().positive().optional(),
		bundleDigest: digest.optional(),
	})
	.superRefine((grader, context) => {
		if (grader.bundleId && grader.bundleVersion === undefined) {
			context.addIssue({
				code: "custom",
				path: ["bundleVersion"],
				message: "Private grader references require a bundle version",
			})
		}
		if (!grader.bundleId && grader.bundleVersion !== undefined) {
			context.addIssue({
				code: "custom",
				path: ["bundleVersion"],
				message: "bundleVersion requires bundleId",
			})
		}
		if (grader.bundleId && !grader.bundleDigest) {
			context.addIssue({
				code: "custom",
				path: ["bundleDigest"],
				message: "Private grader references require a bundle digest",
			})
		}
		if (!grader.bundleId && grader.bundleDigest !== undefined) {
			context.addIssue({ code: "custom", path: ["bundleDigest"], message: "bundleDigest requires bundleId" })
		}
	})

export const benchmarkTaskManifestSchema = z
	.object({
		id,
		version: z.number().int().positive(),
		partition: benchmarkPartitionSchema,
		admission: benchmarkAdmissionSchema,
		fixture: z.string().min(1),
		fixtureDigest: digest.optional(),
		prompt: z.string().min(1),
		promptDigest: digest.optional(),
		repository: z.object({
			upstream: z.string().min(1),
			commit: z.string().min(1),
			snapshotDigest: digest.optional(),
		}),
		family: id,
		capabilities: z.array(id).min(1),
		risk: z.enum(["low", "medium", "high", "critical"]),
		difficulty: benchmarkDifficultySchema,
		contextBand: benchmarkContextBandSchema,
		editTopology: z
			.object({
				kind: benchmarkEditTopologySchema,
				minFiles: z.number().int().nonnegative(),
				maxFiles: z.number().int().positive(),
				allowedRoots: z.array(z.string().regex(/^[a-zA-Z0-9._/-]+$/)).min(1),
			})
			.refine(({ minFiles, maxFiles }) => minFiles <= maxFiles, "minFiles must not exceed maxFiles"),
		validation: z.object({
			commands: z.array(z.object({ command: z.string().min(1), args: z.array(z.string()) })).min(1),
			network: z.enum(["disabled", "restricted", "enabled"]),
		}),
		evidenceRequirements: z.array(benchmarkEvidenceRequirementSchema).min(1),
		graderReferenceDigest: digest,
		environmentDigest: digest,
		restraint: z.boolean().default(false),
		budgets: z.object({
			wallSeconds: z.number().int().positive(),
			modelCalls: z.number().int().positive(),
			toolCalls: z.number().int().positive(),
			costUsd: z.number().nonnegative(),
		}),
		repetitions: z.object({ smoke: z.number().int().positive(), scored: z.number().int().positive() }),
		graders: z.array(benchmarkGraderReferenceSchema).min(1),
	})
	.superRefine((task, context) => {
		if (task.admission === "calibrating" || task.admission === "admitted") {
			if (!task.fixtureDigest)
				context.addIssue({
					code: "custom",
					path: ["fixtureDigest"],
					message: "Admitted tasks require a fixture digest",
				})
			if (!task.promptDigest)
				context.addIssue({
					code: "custom",
					path: ["promptDigest"],
					message: "Admitted tasks require a prompt digest",
				})
			if (!task.repository.snapshotDigest)
				context.addIssue({
					code: "custom",
					path: ["repository", "snapshotDigest"],
					message: "Admitted tasks require a snapshot digest",
				})
		}
		const aliases = new Set(task.graders.map(({ alias }) => alias))
		const traceRequired = [
			"validation_after_edit",
			"validation_after_last_edit",
			"trace_retry_budget",
			"plan_continuity",
		].some((alias) => aliases.has(alias))
		if (traceRequired && !task.evidenceRequirements.includes("normalized_trace")) {
			context.addIssue({
				code: "custom",
				path: ["evidenceRequirements"],
				message: "Trace graders require normalized_trace evidence",
			})
		}
		for (const required of [
			"final_workspace",
			"changed_paths",
			"usage",
			"environment",
			"grader_evidence",
		] as const) {
			if (!task.evidenceRequirements.includes(required)) {
				context.addIssue({
					code: "custom",
					path: ["evidenceRequirements"],
					message: `Missing required evidence: ${required}`,
				})
			}
		}
	})

export const benchmarkSuiteManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		id,
		version: z.number().int().positive(),
		status: z.enum(["draft", "calibrating", "released", "retired"]),
		primaryModel: z.literal("luna-high"),
		referenceModel: z.enum(["luna-high", "sol-high"]),
		tasks: z.array(benchmarkTaskManifestSchema),
	})
	.superRefine((suite, context) => {
		if (suite.id === "frontier-v1" && suite.referenceModel !== "luna-high")
			context.addIssue({
				code: "custom",
				path: ["referenceModel"],
				message: "frontier-v1 calibration is Luna-only",
			})
		if (suite.status === "released" && suite.tasks.length === 0)
			context.addIssue({ code: "custom", path: ["tasks"], message: "Released suites require tasks" })
		if (
			suite.status === "released" &&
			suite.tasks.some(({ partition, admission }) => partition !== "smoke" && admission !== "admitted")
		)
			context.addIssue({
				code: "custom",
				path: ["tasks"],
				message: "Released frontier suites may contain only admitted tasks",
			})
	})

export const graderBundleManifestSchema = z.discriminatedUnion("schemaVersion", [
	z.object({
		schemaVersion: z.literal(1),
		id,
		version: z.number().int().positive(),
		digest,
		runtimeImageDigest: digest,
		readOnly: z.literal(true),
		graders: z.array(z.object({ id, version: z.number().int().positive(), entrypoint: z.string().min(1) })).min(1),
	}),
	z.object({
		schemaVersion: z.literal(2),
		id,
		version: z.number().int().positive(),
		contentDigest: digest,
		readOnly: z.literal(true),
		network: z.literal(false),
		diagnostics: z.literal("bounded-decision-codes-only"),
		graders: z
			.array(
				z.object({
					id,
					version: z.number().int().positive(),
					entrypoint: z.string().min(1),
					digest,
				}),
			)
			.min(1),
	}),
])

export const publicPrivateBundleRegistrySchema = z.object({
	schemaVersion: z.literal(1),
	bundles: z.array(z.object({ id, version: z.number().int().positive(), contentDigest: digest })).min(1),
})

export const benchmarkReleaseLockSchema = z.object({
	schemaVersion: z.literal(1),
	suiteIdentity: z.string().regex(/^[a-z0-9][a-z0-9._/-]*@[1-9][0-9]*$/),
	manifestDigest: digest,
	taskSetDigest: digest,
	createdAt: z.string().datetime(),
})

export const privateAuthoringFingerprintsSchema = z.object({
	schemaVersion: z.literal(1),
	tasks: z.array(
		z.object({
			taskIdentity: z.string().regex(/^[a-z0-9][a-z0-9._/-]*@[1-9][0-9]*$/),
			goldDiffDigest: digest,
			graderStructureDigest: digest,
		}),
	),
})

export const calibrationReportSchema = z
	.object({
		schemaVersion: z.literal(1),
		taskIdentity: z.string().min(1),
		fixtureInitiallyFails: z.boolean(),
		restraint: z.boolean().default(false),
		gold: z.object({ repetitions: z.number().int().min(20), passed: z.number().int().nonnegative() }),
		broken: z
			.array(
				z.object({
					id,
					repetitions: z.number().int().min(20),
					rejected: z.number().int().nonnegative(),
					expectedCode: id,
				}),
			)
			.min(3),
		determinism: z.object({ repetitions: z.number().int().min(50), distinctDigests: z.number().int().positive() }),
		models: z.array(
			z.object({
				model: z.enum(["luna-high", "sol-high"]),
				repetitions: z.number().int().min(5),
				passed: z.number().int().nonnegative(),
				trialIds: z.array(z.string()).default([]),
				unexpectedTrialIds: z.array(z.string()).default([]),
				safetyFailureTrialIds: z.array(z.string()).default([]),
			}),
		),
		humanReview: z.object({
			unresolvedFalsePositivePasses: z.literal(0),
			reviewedTrialIds: z.array(z.string()),
			reviewer: z.string().default(""),
			qualityApproved: z.boolean().default(false),
		}),
		admitted: z.boolean(),
	})
	.superRefine((report, context) => {
		const allTrialIds: string[] = []
		for (const [index, model] of report.models.entries()) {
			if (model.passed > model.repetitions)
				context.addIssue({
					code: "custom",
					path: ["models", index, "passed"],
					message: "Model passes cannot exceed repetitions",
				})
			if (model.trialIds.length !== model.repetitions)
				context.addIssue({
					code: "custom",
					path: ["models", index, "trialIds"],
					message: "Every model repetition requires a trial id",
				})
			if (new Set(model.trialIds).size !== model.trialIds.length)
				context.addIssue({
					code: "custom",
					path: ["models", index, "trialIds"],
					message: "Model trial ids must be unique",
				})
			const known = new Set(model.trialIds)
			for (const [field, ids] of [
				["unexpectedTrialIds", model.unexpectedTrialIds],
				["safetyFailureTrialIds", model.safetyFailureTrialIds],
			] as const) {
				if (new Set(ids).size !== ids.length)
					context.addIssue({
						code: "custom",
						path: ["models", index, field],
						message: `${field} must be unique`,
					})
				if (ids.some((trialId) => !known.has(trialId)))
					context.addIssue({
						code: "custom",
						path: ["models", index, field],
						message: `${field} must reference declared model trials`,
					})
			}
			allTrialIds.push(...model.trialIds)
		}
		const allTrials = new Set(allTrialIds)
		if (allTrials.size !== allTrialIds.length)
			context.addIssue({
				code: "custom",
				path: ["models"],
				message: "Trial ids must be globally unique within a calibration report",
			})
		if (new Set(report.humanReview.reviewedTrialIds).size !== report.humanReview.reviewedTrialIds.length)
			context.addIssue({
				code: "custom",
				path: ["humanReview", "reviewedTrialIds"],
				message: "Reviewed trial ids must be unique",
			})
		if (report.humanReview.reviewedTrialIds.some((trialId) => !allTrials.has(trialId)))
			context.addIssue({
				code: "custom",
				path: ["humanReview", "reviewedTrialIds"],
				message: "Human review must reference declared model trials",
			})
	})

export type BenchmarkSuiteManifest = z.infer<typeof benchmarkSuiteManifestSchema>
export type BenchmarkTaskManifest = z.infer<typeof benchmarkTaskManifestSchema>
export type GraderBundleManifest = z.infer<typeof graderBundleManifestSchema>
export type CalibrationReport = z.infer<typeof calibrationReportSchema>
export type BenchmarkReleaseLock = z.infer<typeof benchmarkReleaseLockSchema>
export type PrivateAuthoringFingerprints = z.infer<typeof privateAuthoringFingerprintsSchema>

export type BenchmarkCatalog = {
	suites: BenchmarkSuiteManifest[]
	tasks: Map<string, { suite: BenchmarkSuiteManifest; task: BenchmarkTaskManifest }>
}
