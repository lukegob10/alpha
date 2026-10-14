import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import {
	immutableIdentity,
	POLICIES,
	type ExperimentStatistics,
	type ExperimentVariant,
	type TaskSetManifest,
} from "../../../experiments/index"
import { promoteBaseline } from "../../../experiments/governance"
import { client } from "../../db"
import { baselines, experiments, promotions } from "../../schema"
import {
	createBaselineRecord,
	createExperiment,
	findBaseline,
	listPromotions,
	persistExperimentReport,
	registerExperimentTaskSet,
	registerExperimentVariant,
} from "../experiments"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const statistics: ExperimentStatistics = {
	outcome: { successes: 10, failures: 0, excluded: 0, rate: 1, bootstrap95: [1, 1] },
	paired: { wins: 1, losses: 0, ties: 9 },
	consistencyAtK: 1,
	passAtK: 1,
	costPerSuccess: 1,
	latencyMs: { p50: 100, p95: 100 },
	infrastructureErrorRate: 0,
	graderErrorRate: 0,
	firstAttemptReliability: 1,
	retryAssistedCapability: 1,
}

describe("immutable experiment and baseline governance", () => {
	it("persists identities, paired reports, reviewed promotion, and append-only rollback audit", async () => {
		const taskSet: TaskSetManifest = {
			schemaVersion: 1,
			id: "tasks-m7",
			version: 1,
			tasks: [{ id: "task", version: 1, digest: digest("a") }],
		}
		const variant: ExperimentVariant = {
			schemaVersion: 1,
			id: "variant-m7",
			extensionCommit: "abc",
			workingTreeDigest: digest("1"),
			extensionBuildDigest: digest("2"),
			model: "fixed",
			modelSettingsDigest: digest("3"),
			promptDigest: digest("4"),
			toolSchemaDigest: digest("5"),
			toolImplementationDigest: digest("6"),
			skillBundleDigest: digest("7"),
			policyDigest: digest("8"),
			compactionDigest: digest("9"),
			runnerImageDigest: digest("a"),
			resourceProfileDigest: digest("b"),
			permissionDigest: digest("c"),
			networkMode: "disabled",
			retryPolicyDigest: digest("d"),
		}
		const taskSetIdentity = immutableIdentity(taskSet)
		const controlIdentity = immutableIdentity({ ...variant, id: "control-m7" })
		const candidateIdentity = immutableIdentity({ ...variant, id: "candidate-m7", promptDigest: digest("e") })
		await registerExperimentTaskSet(taskSetIdentity, taskSet)
		await registerExperimentVariant(controlIdentity, { ...variant, id: "control-m7" })
		await registerExperimentVariant(candidateIdentity, {
			...variant,
			id: "candidate-m7",
			promptDigest: digest("e"),
		})
		const manifest = {
			schemaVersion: 1 as const,
			id: "experiment-m7",
			template: "harness_only" as const,
			taskSetIdentity,
			controlVariantIdentity: controlIdentity,
			candidateVariantIdentity: candidateIdentity,
			pairs: [
				{
					taskId: "task",
					taskVersion: 1,
					seed: 1,
					repetition: 0,
					resourceProfileDigest: variant.resourceProfileDigest,
					permissionDigest: variant.permissionDigest,
					networkMode: variant.networkMode,
					retryPolicyDigest: variant.retryPolicyDigest,
					timeWindow: "2026-07-12T22:00Z",
				},
			],
		}
		const experiment = await createExperiment(immutableIdentity(manifest), manifest)
		await persistExperimentReport(experiment.id, {
			control: statistics,
			candidate: statistics,
			confounders: ["promptDigest"],
		})
		await createBaselineRecord({
			identity: "baseline-old",
			variantIdentity: controlIdentity,
			taskSetIdentity,
			reportDigest: digest("f"),
			createdBy: "reviewer",
		})
		const promoted = await promoteBaseline(
			{
				baselineIdentity: "baseline-new",
				rollbackBaselineIdentity: "baseline-old",
				experimentIdentity: immutableIdentity(manifest),
				variantIdentity: candidateIdentity,
				taskSetIdentity,
				report: { control: statistics, candidate: statistics },
				policy: POLICIES["release-candidate-v1"],
				reviewer: "quality-owner",
				rationale: "paired improvement with no regressions",
				safetyFailures: 0,
				highRiskRegressions: 0,
				paired: true,
			},
			async () => undefined,
		)
		expect(promoted).toEqual({ promoted: true, reasons: [] })
		expect(await findBaseline("baseline-new")).toMatchObject({
			variantIdentity: candidateIdentity,
			createdBy: "quality-owner",
		})
		expect(await listPromotions()).toEqual([
			expect.objectContaining({
				baselineIdentity: "baseline-new",
				rollbackBaselineIdentity: "baseline-old",
				decision: "accepted",
			}),
		])

		await expect(
			client.update(baselines).set({ createdBy: "mutated" }).where(eq(baselines.identity, "baseline-new")),
		).rejects.toThrow()
		await expect(client.delete(promotions).where(eq(promotions.baselineIdentity, "baseline-new"))).rejects.toThrow()
		await expect(
			client.update(experiments).set({ template: "model_only" }).where(eq(experiments.id, experiment.id)),
		).rejects.toThrow()
		expect(await findBaseline("baseline-new")).toMatchObject({ createdBy: "quality-owner" })
		expect(await listPromotions()).toHaveLength(1)
	})

	it("records a rejected promotion without creating a baseline", async () => {
		const rejected = await promoteBaseline(
			{
				baselineIdentity: "baseline-rejected",
				rollbackBaselineIdentity: "baseline-old",
				experimentIdentity: "experiment-rejected",
				variantIdentity: "candidate",
				taskSetIdentity: "tasks",
				report: { control: statistics, candidate: { ...statistics, infrastructureErrorRate: 1 } },
				policy: POLICIES["pr-v1"],
				reviewer: "quality-owner",
				rationale: "audit rejection",
				safetyFailures: 1,
				highRiskRegressions: 1,
				paired: true,
			},
			async () => {
				throw new Error("certification failed")
			},
		)
		expect(rejected.promoted).toBe(false)
		expect(await findBaseline("baseline-rejected")).toBeUndefined()
		expect((await listPromotions()).at(-1)).toMatchObject({
			baselineIdentity: "baseline-rejected",
			decision: "rejected",
		})
	})
})
