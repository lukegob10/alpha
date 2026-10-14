import path from "node:path"

import { applySubsetMeasurements, loadBenchmarkCatalog, loadBenchmarkSubset, selectBenchmarkSubset } from "../index"

const publicRoot = path.resolve(process.cwd(), "../../evals")
const subsetFile = path.join(publicRoot, "subsets", "frontier-t1.yaml")

describe("high-value benchmark subset", () => {
	it("selects a deterministic, capability-balanced eight-task T1", async () => {
		const catalog = await loadBenchmarkCatalog(publicRoot)
		const manifest = await loadBenchmarkSubset(subsetFile)
		const first = selectBenchmarkSubset(catalog, manifest)
		const second = selectBenchmarkSubset(catalog, manifest)
		expect(second).toEqual(first)
		expect(first.tasks).toHaveLength(8)
		expect(first.tasks.map(({ id }) => id)).toEqual([
			"repo-cache-invalidation",
			"alpha-repository-rules",
			"safety-path-policy",
			"stateful-api-idempotency",
			"repo-stream-backpressure",
			"alpha-tool-result-integrity",
			"alpha-resume-idempotency",
			"repo-transaction-outbox",
		])
		expect(first.coverage).toMatchObject({
			"real-repository": 3,
			"alpha-extension": 2,
			"safety-stateful": 2,
			regression: 4,
		})
		expect(first.estimatedCostUsd).toBeLessThanOrEqual(0.5)
		expect(first.reservedCostUsd).toBeLessThanOrEqual(0.5)
	})

	it("rejects missing coverage and reservation over the cap before scheduling", async () => {
		const catalog = await loadBenchmarkCatalog(publicRoot)
		const manifest = await loadBenchmarkSubset(subsetFile)
		expect(() =>
			selectBenchmarkSubset(catalog, {
				...manifest,
				requiredCoverage: { ...manifest.requiredCoverage, "safety-stateful": 4 },
			}),
		).toThrow("Subset coverage safety-stateful")
		expect(() => selectBenchmarkSubset(catalog, { ...manifest, taskReservationUsd: 0.07 })).toThrow(
			"Subset reservation",
		)
	})

	it("records measured cost and latency without relabeling unobserved priors", async () => {
		const manifest = freshHistory(await loadBenchmarkSubset(subsetFile))
		const updated = applySubsetMeasurements(
			manifest,
			[{ taskId: "repo-cache-invalidation", costUsd: 0.0360317, latencyMs: 42_645 }],
			99,
		)
		expect(updated.historyBasis).toBe("mixed")
		expect(updated.measurementRunIds).toEqual([99])
		expect(updated.history["repo-cache-invalidation"]).toMatchObject({
			meanCostUsd: 0.0360317,
			meanLatencyMs: 42_645,
			costLatencyBasis: "measured",
			observationCount: 1,
		})
		expect(updated.history["repo-config-precedence"]).toBeUndefined()
		expect(updated.history["repo-stream-backpressure"]).toMatchObject({
			costLatencyBasis: "seeded",
			observationCount: 0,
		})
	})

	it("rejects duplicate, unknown, and invalid measurements", async () => {
		const manifest = freshHistory(await loadBenchmarkSubset(subsetFile))
		expect(() =>
			applySubsetMeasurements(
				manifest,
				[
					{ taskId: "repo-cache-invalidation", costUsd: 0.03, latencyMs: 40_000 },
					{ taskId: "repo-cache-invalidation", costUsd: 0.04, latencyMs: 50_000 },
				],
				12,
			),
		).toThrow("Duplicate subset measurement")
		expect(() =>
			applySubsetMeasurements(manifest, [{ taskId: "missing", costUsd: 0.03, latencyMs: 40_000 }], 12),
		).toThrow("unknown task")
		expect(() =>
			applySubsetMeasurements(
				manifest,
				[{ taskId: "repo-cache-invalidation", costUsd: Number.NaN, latencyMs: 40_000 }],
				12,
			),
		).toThrow("Invalid measured cost")
		const once = applySubsetMeasurements(
			manifest,
			[{ taskId: "repo-cache-invalidation", costUsd: 0.03, latencyMs: 40_000 }],
			12,
		)
		expect(() =>
			applySubsetMeasurements(
				once,
				[{ taskId: "repo-cache-invalidation", costUsd: 0.03, latencyMs: 40_000 }],
				12,
			),
		).toThrow("already contains run 12")
	})
})

function freshHistory(manifest: Awaited<ReturnType<typeof loadBenchmarkSubset>>) {
	return {
		...manifest,
		historyBasis: "seeded-prior-from-legacy-baseline" as const,
		measurementRunIds: [],
		history: Object.fromEntries(
			Object.entries(manifest.history).map(([id, value]) => [
				id,
				{ ...value, costLatencyBasis: "seeded" as const, observationCount: 0 },
			]),
		),
	}
}
