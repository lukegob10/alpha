import { eq } from "drizzle-orm"

import { canonicalJson, sha256 } from "../../evidence/index"
import type {
	ExperimentManifest,
	ExperimentStatistics,
	ExperimentVariant,
	TaskSetManifest,
} from "../../experiments/index"
import { client as db } from "../db"
import {
	baselines,
	experimentPairs,
	experimentReports,
	experiments,
	experimentTaskSets,
	experimentVariants,
	promotions,
} from "../schema"

export function registerExperimentTaskSet(identity: string, manifest: TaskSetManifest) {
	return db
		.insert(experimentTaskSets)
		.values({ identity, manifest, digest: sha256(canonicalJson(manifest)), createdAt: new Date() })
		.returning()
}

export function registerExperimentVariant(identity: string, manifest: ExperimentVariant) {
	return db
		.insert(experimentVariants)
		.values({ identity, manifest, digest: sha256(canonicalJson(manifest)), createdAt: new Date() })
		.returning()
}

export async function createExperiment(identity: string, manifest: ExperimentManifest) {
	return db.transaction(async (tx) => {
		const [experiment] = await tx
			.insert(experiments)
			.values({
				identity,
				template: manifest.template,
				taskSetIdentity: manifest.taskSetIdentity,
				controlVariantIdentity: manifest.controlVariantIdentity,
				candidateVariantIdentity: manifest.candidateVariantIdentity,
				manifest,
				digest: sha256(canonicalJson(manifest)),
				createdAt: new Date(),
			})
			.returning()
		if (!experiment) throw new Error("Experiment was not created")
		await tx.insert(experimentPairs).values(
			manifest.pairs.map((pairKey) => ({
				experimentId: experiment.id,
				pairKey,
				pairDigest: sha256(canonicalJson(pairKey)),
				createdAt: new Date(),
			})),
		)
		return experiment
	})
}

export function persistExperimentReport(
	experimentId: number,
	report: { control: ExperimentStatistics; candidate: ExperimentStatistics; confounders: unknown[] },
) {
	return db
		.insert(experimentReports)
		.values({ experimentId, report, digest: sha256(canonicalJson(report)), createdAt: new Date() })
		.returning()
}

export function createBaselineRecord(input: {
	identity: string
	variantIdentity: string
	taskSetIdentity: string
	reportDigest: string
	createdBy: string
}) {
	return db
		.insert(baselines)
		.values({ ...input, createdAt: new Date() })
		.returning()
}

export function appendPromotionRecord(input: {
	baselineIdentity: string
	rollbackBaselineIdentity: string
	experimentIdentity: string
	policyId: string
	reviewer: string
	rationale: string
	decision: "accepted" | "rejected"
	reasons: string[]
}) {
	return db
		.insert(promotions)
		.values({ ...input, createdAt: new Date() })
		.returning()
}

export function recordPromotionOutcome(
	promotion: Parameters<typeof appendPromotionRecord>[0],
	baseline?: Parameters<typeof createBaselineRecord>[0],
) {
	return db.transaction(async (tx) => {
		const [record] = await tx
			.insert(promotions)
			.values({ ...promotion, createdAt: new Date() })
			.returning()
		if (baseline) await tx.insert(baselines).values({ ...baseline, createdAt: new Date() })
		return record
	})
}

export const findBaseline = (identity: string) =>
	db.query.baselines.findFirst({ where: eq(baselines.identity, identity) })
export const listPromotions = () => db.query.promotions.findMany({ orderBy: promotions.id })
