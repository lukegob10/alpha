import { canonicalJson, sha256 } from "../evidence/index"
import { immutableIdentity } from "./identity"
import { pairTrials } from "./pairing"
import { segmentExperiment, type SegmentedExperimentStatistics } from "./statistics"
import {
	experimentManifestSchema,
	experimentVariantSchema,
	taskSetManifestSchema,
	trialObservationSchema,
	type ExperimentManifest,
	type ExperimentVariant,
	type PairKey,
	type TaskSetManifest,
	type TrialObservation,
} from "./types"
import { diffVariants, validateDeclaredVariantDiff, validateTemplateDiff, type VariantDifference } from "./variantDiff"

export type PairedExperimentReport = {
	schemaVersion: 1
	controlVariantIdentity: string
	candidateVariantIdentity: string
	fullyPaired: true
	pairCount: number
	control: SegmentedExperimentStatistics
	candidate: SegmentedExperimentStatistics
	safetyFailures: number
	highRiskRegressions: number
	variantDifferences: VariantDifference[]
	digest: string
}

export type PairedExperimentContext = {
	manifest: ExperimentManifest
	taskSet: TaskSetManifest
	controlVariant: ExperimentVariant
	candidateVariant: ExperimentVariant
}

export function buildPairedExperimentReport(
	controlValue: unknown,
	candidateValue: unknown,
	contextValue: PairedExperimentContext,
): PairedExperimentReport {
	const control = parseObservations(controlValue, "control")
	const candidate = parseObservations(candidateValue, "candidate")
	const context = parseContext(contextValue)
	const pairs = pairTrials(control, candidate)
	const controlVariantIdentity = singleVariant(control, "control")
	const candidateVariantIdentity = singleVariant(candidate, "candidate")
	validateContext(
		context,
		controlVariantIdentity,
		candidateVariantIdentity,
		pairs.map(({ key }) => key),
		control,
	)
	const variantDifferences = diffVariants(context.controlVariant, context.candidateVariant)
	validateTemplateDiff(context.manifest.template, variantDifferences)
	if (!context.manifest.allowedDifferenceFields?.length)
		throw new Error("Paired reports require explicit allowedDifferenceFields")
	validateDeclaredVariantDiff(variantDifferences, context.manifest.allowedDifferenceFields)
	const body = {
		schemaVersion: 1 as const,
		controlVariantIdentity,
		candidateVariantIdentity,
		fullyPaired: true as const,
		pairCount: pairs.length,
		control: segmentExperiment(control, pairs),
		candidate: segmentExperiment(candidate, pairs),
		safetyFailures: candidate.filter(({ status }) => status === "safety_failed").length,
		highRiskRegressions: pairs.filter(
			({ control: baseline, candidate: changed }) =>
				(baseline.risk === "high" || baseline.risk === "critical") &&
				baseline.status === "passed" &&
				changed.status !== "passed",
		).length,
		variantDifferences,
	}
	return { ...body, digest: sha256(canonicalJson(body)) }
}

function parseContext(value: PairedExperimentContext): PairedExperimentContext {
	return {
		manifest: experimentManifestSchema.parse(value.manifest),
		taskSet: taskSetManifestSchema.parse(value.taskSet),
		controlVariant: experimentVariantSchema.parse(value.controlVariant),
		candidateVariant: experimentVariantSchema.parse(value.candidateVariant),
	}
}

function validateContext(
	context: PairedExperimentContext,
	controlIdentity: string,
	candidateIdentity: string,
	pairKeys: PairKey[],
	observations: TrialObservation[],
): void {
	if (controlIdentity !== immutableIdentity(context.controlVariant))
		throw new Error("Control observation variant identity does not match its manifest")
	if (candidateIdentity !== immutableIdentity(context.candidateVariant))
		throw new Error("Candidate observation variant identity does not match its manifest")
	if (
		context.manifest.controlVariantIdentity !== controlIdentity ||
		context.manifest.candidateVariantIdentity !== candidateIdentity
	)
		throw new Error("Experiment manifest variant identities do not match observations")
	if (context.manifest.taskSetIdentity !== immutableIdentity(context.taskSet))
		throw new Error("Experiment manifest task-set identity does not match its manifest")
	const declaredPairs = new Set(context.manifest.pairs.map((pair) => canonicalJson(pair)))
	const observedPairs = new Set(
		pairKeys.map((pair) =>
			canonicalJson({
				taskId: pair.taskId,
				taskVersion: pair.taskVersion,
				seed: pair.seed,
				repetition: pair.repetition,
				resourceProfileDigest: pair.resourceProfileDigest,
				permissionDigest: pair.permissionDigest,
				networkMode: pair.networkMode,
				retryPolicyDigest: pair.retryPolicyDigest,
				timeWindow: pair.timeWindow,
			}),
		),
	)
	if (declaredPairs.size !== observedPairs.size || [...declaredPairs].some((pair) => !observedPairs.has(pair)))
		throw new Error("Observed pairs do not exactly match the immutable experiment manifest")
	const tasks = new Set(context.taskSet.tasks.map(({ id, version }) => `${id}@${version}`))
	if (observations.some(({ taskId, taskVersion }) => !tasks.has(`${taskId}@${taskVersion}`)))
		throw new Error("Observation task is outside the immutable task set")
}

function parseObservations(value: unknown, label: string): TrialObservation[] {
	const observations = trialObservationSchema.array().min(1).parse(value)
	if (new Set(observations.map(({ taskId, repetition }) => `${taskId}@${repetition}`)).size !== observations.length)
		throw new Error(`${label} observations contain duplicate task repetitions`)
	return observations
}

function singleVariant(observations: TrialObservation[], label: string): string {
	const identities = [...new Set(observations.map(({ variantIdentity }) => variantIdentity))]
	if (identities.length !== 1) throw new Error(`${label} observations must use one immutable variant identity`)
	return identities[0]!
}
