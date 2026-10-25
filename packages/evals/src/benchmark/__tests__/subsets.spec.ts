import path from "node:path"

import {
	applySubsetMeasurements,
	loadBenchmarkCatalog,
	loadBenchmarkSubset,
	selectBenchmarkSubset,
	type SubsetMeasurement,
} from "../index"

const publicRoot = path.resolve(process.cwd(), "../../evals")
const subsetFile = path.join(publicRoot, "subsets", "frontier-t1.yaml")

describe("high-value benchmark subset", () => {
	it("rejects stale incoming measurements instead of assigning them the current task version", async () => {
		const manifest = freshHistory(await loadBenchmarkSubset(subsetFile))
		const before = structuredClone(manifest)
		expect(() =>
			applySubsetMeasurements(
				manifest,
				[{ taskId: "repo-stream-backpressure", taskVersion: 1, costUsd: 0.01, latencyMs: 20 }],
				99,
			),
		).toThrow("Subset measurement version does not match repo-stream-backpressure@2")
		expect(manifest).toEqual(before)
	})

	it("requires a version on new measurements even when historical rows are unversioned", async () => {
		const manifest = freshHistory(await loadBenchmarkSubset(subsetFile))
		expect(manifest.history["repo-cache-invalidation"]!.taskVersion).toBeUndefined()
		const unversioned = {
			taskId: "repo-cache-invalidation",
			costUsd: 0.01,
			latencyMs: 20,
		} as unknown as SubsetMeasurement
		expect(() => applySubsetMeasurements(manifest, [unversioned], 99)).toThrow(/task version/i)
	})

	it("does not reuse historical measured values as new-version observations", async () => {
		const catalog = await loadBenchmarkCatalog(publicRoot)
		const manifest = await loadBenchmarkSubset(subsetFile)
		const changed = manifest.history["repo-stream-backpressure"]!
		expect(changed).toMatchObject({ taskVersion: 2, costLatencyBasis: "seeded", observationCount: 0 })
		expect(() =>
			selectBenchmarkSubset(catalog, {
				...manifest,
				history: { ...manifest.history, "repo-stream-backpressure": { ...changed, taskVersion: 1 } },
			}),
		).toThrow("Subset history version")
	})

	it("keeps legacy v1 history readable and records the explicit version of new observations", async () => {
		const catalog = await loadBenchmarkCatalog(publicRoot)
		const manifest = await loadBenchmarkSubset(subsetFile)
		const legacy = structuredClone(manifest.history["repo-cache-invalidation"]!)
		expect(legacy).not.toHaveProperty("taskVersion")
		expect(selectBenchmarkSubset(catalog, manifest).tasks[0]).toMatchObject({
			id: "repo-cache-invalidation",
			version: 1,
		})
		const updated = applySubsetMeasurements(
			manifest,
			[{ taskId: "repo-cache-invalidation", taskVersion: 1, costUsd: 0.01, latencyMs: 20 }],
			99,
		)
		expect(updated.history["repo-cache-invalidation"]).toMatchObject({
			taskVersion: 1,
			observationCount: legacy.observationCount + 1,
		})
		expect(manifest.history["repo-cache-invalidation"]).toEqual(legacy)
		expect(updated.history["alpha-repository-rules"]).toEqual(manifest.history["alpha-repository-rules"])
	})

	it("accepts zero cost and latency only for the current explicit task version", async () => {
		const manifest = freshHistory(await loadBenchmarkSubset(subsetFile))
		const updated = applySubsetMeasurements(
			manifest,
			[{ taskId: "repo-stream-backpressure", taskVersion: 2, costUsd: 0, latencyMs: 0 }],
			99,
		)
		expect(updated.history["repo-stream-backpressure"]).toMatchObject({
			taskVersion: 2,
			meanCostUsd: 0,
			meanLatencyMs: 0,
			costLatencyBasis: "measured",
			observationCount: 1,
		})
	})

	it("accepts canonical task IDs containing namespace, underscore, and dot separators", async () => {
		const manifest = freshHistory(await loadBenchmarkSubset(subsetFile))
		const taskId = "team/task_v1.fixture"
		manifest.history[taskId] = { ...manifest.history["repo-stream-backpressure"]! }
		const updated = applySubsetMeasurements(
			manifest,
			[{ taskId, taskVersion: 2, costUsd: 0.02, latencyMs: 30 }],
			99,
		)
		expect(updated.history[taskId]).toMatchObject({
			taskVersion: 2,
			meanCostUsd: 0.02,
			meanLatencyMs: 30,
			costLatencyBasis: "measured",
			observationCount: 1,
		})
	})

	it("does not publish a valid first row when a later row has a stale or future version", async () => {
		const manifest = freshHistory(await loadBenchmarkSubset(subsetFile))
		const before = structuredClone(manifest)
		for (const taskVersion of [1, 3]) {
			expect(() =>
				applySubsetMeasurements(
					manifest,
					[
						{ taskId: "repo-cache-invalidation", taskVersion: 1, costUsd: 0.03, latencyMs: 40_000 },
						{ taskId: "repo-stream-backpressure", taskVersion, costUsd: 0.04, latencyMs: 50_000 },
					],
					99,
				),
			).toThrow("Subset measurement version does not match repo-stream-backpressure@2")
			expect(manifest).toEqual(before)
		}
	})

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null])(
		"rejects invalid incoming task version %s",
		async (taskVersion) => {
			const manifest = freshHistory(await loadBenchmarkSubset(subsetFile))
			const measurement = {
				taskId: "repo-cache-invalidation",
				taskVersion,
				costUsd: 0.01,
				latencyMs: 20,
			} as unknown as SubsetMeasurement
			expect(() => applySubsetMeasurements(manifest, [measurement], 99)).toThrow(/task version/i)
			expect(manifest.measurementRunIds).toEqual([])
		},
	)

	it.each([
		{ costUsd: -1, latencyMs: 20 },
		{ costUsd: Number.POSITIVE_INFINITY, latencyMs: 20 },
		{ costUsd: Number.NaN, latencyMs: 20 },
		{ costUsd: 0.01, latencyMs: -1 },
		{ costUsd: 0.01, latencyMs: Number.POSITIVE_INFINITY },
		{ costUsd: 0.01, latencyMs: Number.NaN },
	])("rejects invalid finite/nonnegative metrics %j", async (metrics) => {
		const manifest = freshHistory(await loadBenchmarkSubset(subsetFile))
		expect(() =>
			applySubsetMeasurements(manifest, [{ taskId: "repo-cache-invalidation", taskVersion: 1, ...metrics }], 99),
		).toThrow(/Invalid measured (cost|latency)/)
		expect(manifest.measurementRunIds).toEqual([])
	})

	it("rejects empty batches and inherited object properties without consuming a run id", async () => {
		const manifest = freshHistory(await loadBenchmarkSubset(subsetFile))
		expect(() => applySubsetMeasurements(manifest, [], 99)).toThrow("Subset measurements must not be empty")
		expect(() =>
			applySubsetMeasurements(
				manifest,
				[{ taskId: "constructor", taskVersion: 1, costUsd: 0, latencyMs: 0 }],
				99,
			),
		).toThrow("unknown task")
		expect(manifest.measurementRunIds).toEqual([])
	})
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
			[{ taskId: "repo-cache-invalidation", taskVersion: 1, costUsd: 0.0360317, latencyMs: 42_645 }],
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
					{ taskId: "repo-cache-invalidation", taskVersion: 1, costUsd: 0.03, latencyMs: 40_000 },
					{ taskId: "repo-cache-invalidation", taskVersion: 1, costUsd: 0.04, latencyMs: 50_000 },
				],
				12,
			),
		).toThrow("Duplicate subset measurement")
		expect(() =>
			applySubsetMeasurements(
				manifest,
				[{ taskId: "missing", taskVersion: 1, costUsd: 0.03, latencyMs: 40_000 }],
				12,
			),
		).toThrow("unknown task")
		expect(() =>
			applySubsetMeasurements(
				manifest,
				[{ taskId: "repo-cache-invalidation", taskVersion: 1, costUsd: Number.NaN, latencyMs: 40_000 }],
				12,
			),
		).toThrow("Invalid measured cost")
		const once = applySubsetMeasurements(
			manifest,
			[{ taskId: "repo-cache-invalidation", taskVersion: 1, costUsd: 0.03, latencyMs: 40_000 }],
			12,
		)
		expect(() =>
			applySubsetMeasurements(
				once,
				[{ taskId: "repo-cache-invalidation", taskVersion: 1, costUsd: 0.03, latencyMs: 40_000 }],
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
