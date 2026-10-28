import { z } from "zod"

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const text = z.string().min(1).max(256)

/** Executed observations are separate from the controller's intended experiment assignment. */
export const executedExperimentVariantSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: text,
		extensionCommit: text,
		workingTreeDigest: digest,
		extensionBuildDigest: digest,
		model: text,
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
		networkMode: text,
		retryPolicyDigest: digest,
	})
	.strict()
export type ExecutedExperimentVariant = z.infer<typeof executedExperimentVariantSchema>

export const executedExperimentRequestObservationSchema = z
	.object({
		index: z.number().int().nonnegative().max(199),
		startedAt: z.string().datetime(),
		model: text,
		reasoningEffort: text,
		modelSettingsDigest: digest,
		messagesDigest: digest,
		toolSchemaDigest: digest,
		optionsDigest: digest,
	})
	.strict()
export type ExecutedExperimentRequestObservation = z.infer<typeof executedExperimentRequestObservationSchema>

/** Public predeclared labels and process requirements; contains no hidden grader or proposed variant. */
export const nativeExperimentContextSchema = z
	.object({
		runId: text,
		decisionPlanDigest: digest,
		pairDigest: digest,
		validationCommands: z
			.array(z.object({ command: text, args: z.array(z.string().max(32768)).max(128) }).strict())
			.max(32),
		requirements: z
			.object({
				initialValidation: z.boolean(),
				finalValidation: z.boolean(),
				instructions: z
					.array(
						z
							.object({
								id: text,
								digest,
								role: z.enum(["system", "developer", "user", "assistant", "tool"]).optional(),
								before: z.enum(["first-edit", "first-model-request"]),
							})
							.strict(),
					)
					.max(32),
				hooks: z
					.array(z.object({ id: text, digest, before: z.enum(["first-edit", "completion"]) }).strict())
					.max(32),
			})
			.strict(),
	})
	.strict()
export type NativeExperimentContext = z.infer<typeof nativeExperimentContextSchema>

const provenance = z
	.object({
		source: text,
		digest,
		scope: z.enum(["observed", "conservative-whole-source"]),
	})
	.strict()

/** Conditions fixed by the native trial protocol; Alpha's own scheduler and retries remain treatment. */
export const NATIVE_EXPERIMENT_CONDITION_SCOPES = {
	resourceProfile: "native-host-external-budget-and-observed-machine-v1",
	retryPolicy: "native-host-provider-transport-and-controller-retries-v1",
	alphaRuntimeRetries: "treatment",
	resourceEnvelope: "observed-native-host-without-os-envelope",
} as const

export const nativeExperimentConditionScopesSchema = z
	.object({
		resourceProfile: z.literal(NATIVE_EXPERIMENT_CONDITION_SCOPES.resourceProfile),
		retryPolicy: z.literal(NATIVE_EXPERIMENT_CONDITION_SCOPES.retryPolicy),
		alphaRuntimeRetries: z.literal(NATIVE_EXPERIMENT_CONDITION_SCOPES.alphaRuntimeRetries),
		resourceEnvelope: z.literal(NATIVE_EXPERIMENT_CONDITION_SCOPES.resourceEnvelope),
	})
	.strict()

/** Build-owned boundary observations assume no concurrent writes; resolver metadata is not byte-intercepted. */
export const NATIVE_BUILD_SOURCE_ASSOCIATION_SCOPE = {
	kind: "controlled-build-boundary-observation",
	compilerLoaderBytes: "captured",
	resolverMetadataBytes: "unobserved",
	concurrentFilesystemWrites: "assumed-absent",
	immutableFilesystem: false,
	authentication: "none",
} as const

export const nativeBuildSourceAssociationSchema = z
	.object({
		kind: z.literal(NATIVE_BUILD_SOURCE_ASSOCIATION_SCOPE.kind),
		compilerLoaderBytes: z.literal(NATIVE_BUILD_SOURCE_ASSOCIATION_SCOPE.compilerLoaderBytes),
		resolverMetadataBytes: z.literal(NATIVE_BUILD_SOURCE_ASSOCIATION_SCOPE.resolverMetadataBytes),
		concurrentFilesystemWrites: z.literal(NATIVE_BUILD_SOURCE_ASSOCIATION_SCOPE.concurrentFilesystemWrites),
		immutableFilesystem: z.literal(false),
		authentication: z.literal(NATIVE_BUILD_SOURCE_ASSOCIATION_SCOPE.authentication),
	})
	.strict()
export type NativeBuildSourceAssociation = z.infer<typeof nativeBuildSourceAssociationSchema>

export const executedExperimentCaptureSchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.literal("alpha-executed-experiment-capture"),
		status: z.enum(["captured", "incomplete"]),
		producer: z.literal("native-extension-host"),
		attemptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
		assignmentDigest: digest.optional(),
		pairDigest: digest.optional(),
		task: z.object({ id: text, version: z.number().int().positive(), digest }).strict(),
		taskLabelAuthority: z.literal("controller-public-task-label"),
		capturedAt: z.string().datetime(),
		observedVariant: executedExperimentVariantSchema.nullable(),
		identityScope: z.enum(["component", "conservative-whole-source"]),
		/** Fixed trial protocol conditions. Product scheduler/backoff behavior remains part of the treatment. */
		conditionScopes: nativeExperimentConditionScopesSchema.optional(),
		measurementProvenance: z.record(provenance),
		missing: z.array(text).max(100),
		observed: z
			.object({
				entrypointDigest: digest.optional(),
				extensionManifestDigest: digest.optional(),
				extensionBuildDigest: digest.optional(),
				model: text.optional(),
				reasoningEffort: text.optional(),
				modelSettingsDigest: digest.optional(),
				policyDigest: digest.optional(),
				taskPromptDigest: digest.optional(),
				configurationDigest: digest.optional(),
				initialWorkspaceDigest: digest.optional(),
				stagedFixtureDigest: digest.optional(),
				stagedFixtureAlgorithm: z.literal("source-tree-pretty-json-v1").optional(),
				requestCount: z.number().int().nonnegative().max(200),
			})
			.strict(),
		requests: z.array(executedExperimentRequestObservationSchema).max(200),
		processCoverage: z
			.object({
				sourceVersions: z.enum(["complete", "partial", "unavailable"]),
				instructionDelivery: z.enum(["complete", "partial", "unavailable"]),
				hookDelivery: z.enum(["complete", "partial", "unavailable"]),
			})
			.strict(),
		buildProvenance: z
			.object({
				status: z.enum(["verified", "unavailable", "invalid"]),
				manifestDigest: digest.optional(),
				sourceAssociation: nativeBuildSourceAssociationSchema.optional(),
				missing: z.array(text).max(100),
			})
			.strict(),
		digest,
	})
	.strict()
	.superRefine((capture, context) => {
		if (capture.observed.requestCount !== capture.requests.length)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Request coverage differs from observed requests",
			})
		if (
			new Set(capture.requests.map((request) => request.index)).size !== capture.requests.length ||
			capture.requests.some((request, index) => request.index !== index)
		)
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Request indexes must be contiguous and unique" })
		if (capture.status === "captured") {
			if (!capture.conditionScopes)
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Complete capture requires explicit fixed-condition scopes",
				})
			if (!capture.observedVariant || capture.missing.length > 0 || capture.requests.length === 0)
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Complete capture requires observed identity and requests",
				})
			if (capture.observedVariant) {
				for (const field of Object.keys(capture.observedVariant).filter((field) => field !== "schemaVersion")) {
					if (!capture.measurementProvenance[field])
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Missing measured provenance: ${field}`,
						})
				}
				if (
					capture.observedVariant.model !== capture.observed.model ||
					capture.observedVariant.modelSettingsDigest !== capture.observed.modelSettingsDigest
				)
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Variant model differs from observed provider",
					})
				if (
					capture.requests.some(
						(request) =>
							request.model !== capture.observedVariant!.model ||
							request.modelSettingsDigest !== capture.observedVariant!.modelSettingsDigest,
					)
				)
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Provider identity drifted during the attempt",
					})
			}
			if (
				capture.identityScope === "conservative-whole-source" &&
				(capture.buildProvenance.status !== "verified" || !capture.buildProvenance.sourceAssociation)
			)
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Whole-source identity requires verified build association",
				})
		} else if (capture.observedVariant !== null || capture.missing.length === 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Incomplete capture must preserve missing identity",
			})
		}
	})
export type ExecutedExperimentCapture = z.infer<typeof executedExperimentCaptureSchema>
