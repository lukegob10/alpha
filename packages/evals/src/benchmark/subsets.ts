import fs from "node:fs/promises"

import { parse } from "yaml"
import { z } from "zod"

import type { BenchmarkCatalog, BenchmarkTaskManifest } from "./contracts"

const historySchema = z.object({
	taskVersion: z.number().int().positive().optional(),
	discrimination: z.number().min(0).max(1),
	severity: z.number().min(0).max(1),
	graderConfidence: z.number().min(0).max(1),
	meanCostUsd: z.number().nonnegative(),
	meanLatencyMs: z.number().nonnegative(),
	redundancy: z.number().min(0).max(1),
	regressionValue: z.number().min(0).max(1),
	costLatencyBasis: z.enum(["seeded", "measured"]).default("seeded"),
	observationCount: z.number().int().nonnegative().default(0),
})

export const benchmarkSubsetSchema = z.object({
	schemaVersion: z.literal(1),
	id: z.string().regex(/^[a-z0-9-]+$/),
	suiteIdentity: z.string().regex(/^[a-z0-9-]+@[1-9][0-9]*$/),
	tier: z.literal("t1"),
	historyBasis: z.enum(["seeded-prior-from-legacy-baseline", "mixed", "measured"]),
	measurementRunIds: z.array(z.number().int().positive()).default([]),
	hardCapUsd: z.number().positive().max(0.5),
	taskReservationUsd: z.number().positive(),
	minimumTasks: z.number().int().min(8).max(10),
	maximumTasks: z.number().int().min(8).max(10),
	stableCore: z.array(z.string()).min(5),
	dynamicSlots: z.array(z.object({ id: z.string(), candidates: z.array(z.string()).min(1) })).min(1),
	requiredCoverage: z.record(z.string(), z.number().int().positive()),
	history: z.record(z.string(), historySchema),
})

export type BenchmarkSubsetManifest = z.infer<typeof benchmarkSubsetSchema>
export type SubsetSelection = {
	id: string
	tasks: BenchmarkTaskManifest[]
	estimatedCostUsd: number
	reservedCostUsd: number
	hardCapUsd: number
	coverage: Record<string, number>
	explanation: Array<{ taskId: string; source: "stable-core" | string; score: number; meanCostUsd: number }>
}

export const subsetMeasurementSchema = z
	.object({
		taskId: z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/),
		taskVersion: z
			.number({
				required_error: "Subset measurement task version is required",
				invalid_type_error: "Invalid subset measurement task version",
			})
			.int("Invalid subset measurement task version")
			.positive("Invalid subset measurement task version")
			.safe("Invalid subset measurement task version"),
		costUsd: z
			.number({ invalid_type_error: "Invalid measured cost" })
			.finite("Invalid measured cost")
			.nonnegative("Invalid measured cost"),
		latencyMs: z
			.number({ invalid_type_error: "Invalid measured latency" })
			.finite("Invalid measured latency")
			.nonnegative("Invalid measured latency"),
	})
	.strict()

export type SubsetMeasurement = z.infer<typeof subsetMeasurementSchema>

export async function loadBenchmarkSubset(file: string): Promise<BenchmarkSubsetManifest> {
	return benchmarkSubsetSchema.parse(parse(await fs.readFile(file, "utf8"), { merge: true }))
}

export function selectBenchmarkSubset(catalog: BenchmarkCatalog, manifest: BenchmarkSubsetManifest): SubsetSelection {
	const suite = catalog.suites.find(({ id, version }) => `${id}@${version}` === manifest.suiteIdentity)
	if (!suite) throw new Error(`Subset suite is not loaded: ${manifest.suiteIdentity}`)
	const visible = new Map(
		suite.tasks
			.filter(({ partition }) => partition === "development" || partition === "regression")
			.map((task) => [task.id, task]),
	)
	const selected: BenchmarkTaskManifest[] = []
	const explanation: SubsetSelection["explanation"] = []
	const add = (id: string, source: "stable-core" | string) => {
		const task = visible.get(id)
		const history = manifest.history[id]
		if (!task) throw new Error(`Subset references unknown visible task: ${id}`)
		if (!history) throw new Error(`Subset history is missing for ${id}`)
		if ((history.taskVersion ?? 1) !== task.version)
			throw new Error(`Subset history version does not match ${id}@${task.version}`)
		if (selected.some((entry) => entry.id === id)) throw new Error(`Subset selects ${id} more than once`)
		selected.push(task)
		explanation.push({ taskId: id, source, score: historyScore(history), meanCostUsd: history.meanCostUsd })
	}
	for (const id of manifest.stableCore) add(id, "stable-core")
	for (const slot of manifest.dynamicSlots) {
		const ranked = slot.candidates
			.map((id) => ({ id, history: manifest.history[id] }))
			.filter((entry): entry is { id: string; history: z.infer<typeof historySchema> } => Boolean(entry.history))
			.sort((a, b) => historyScore(b.history) - historyScore(a.history) || a.id.localeCompare(b.id))
		if (!ranked[0]) throw new Error(`Dynamic subset slot has no candidates with history: ${slot.id}`)
		add(ranked[0].id, slot.id)
	}
	if (selected.length < manifest.minimumTasks || selected.length > manifest.maximumTasks)
		throw new Error(
			`Subset task count ${selected.length} is outside ${manifest.minimumTasks}-${manifest.maximumTasks}`,
		)
	const coverage = coverageCounts(selected)
	for (const [key, minimum] of Object.entries(manifest.requiredCoverage))
		if ((coverage[key] ?? 0) < minimum)
			throw new Error(`Subset coverage ${key} requires ${minimum}; found ${coverage[key] ?? 0}`)
	const estimatedCostUsd = sum(selected.map(({ id }) => manifest.history[id]!.meanCostUsd))
	const reservedCostUsd = selected.length * manifest.taskReservationUsd
	if (estimatedCostUsd > manifest.hardCapUsd)
		throw new Error(`Subset estimate $${estimatedCostUsd.toFixed(3)} exceeds hard cap`)
	if (reservedCostUsd > manifest.hardCapUsd)
		throw new Error(`Subset reservation $${reservedCostUsd.toFixed(3)} exceeds hard cap`)
	return {
		id: manifest.id,
		tasks: selected,
		estimatedCostUsd,
		reservedCostUsd,
		hardCapUsd: manifest.hardCapUsd,
		coverage,
		explanation,
	}
}

export function applySubsetMeasurements(
	manifest: BenchmarkSubsetManifest,
	measurements: SubsetMeasurement[],
	sourceRunId: number,
): BenchmarkSubsetManifest {
	if (!Number.isInteger(sourceRunId) || sourceRunId < 1) throw new Error("Measurement source run id must be positive")
	if (manifest.measurementRunIds.includes(sourceRunId))
		throw new Error(`Subset history already contains run ${sourceRunId}`)
	const parsed = z.array(subsetMeasurementSchema).min(1, "Subset measurements must not be empty").parse(measurements)
	const seen = new Set<string>()
	for (const measurement of parsed) {
		if (seen.has(measurement.taskId)) throw new Error(`Duplicate subset measurement: ${measurement.taskId}`)
		seen.add(measurement.taskId)
		if (!Object.hasOwn(manifest.history, measurement.taskId))
			throw new Error(`Subset measurement references unknown task: ${measurement.taskId}`)
		const current = manifest.history[measurement.taskId]!
		// Unversioned history retains its original v1 identity; new observations must declare theirs explicitly.
		const expectedVersion = current.taskVersion ?? 1
		if (measurement.taskVersion !== expectedVersion)
			throw new Error(`Subset measurement version does not match ${measurement.taskId}@${expectedVersion}`)
	}
	const history = structuredClone(manifest.history)
	for (const measurement of parsed) {
		const current = history[measurement.taskId]!
		const count = current.costLatencyBasis === "measured" ? current.observationCount : 0
		const nextCount = count + 1
		history[measurement.taskId] = {
			...current,
			taskVersion: measurement.taskVersion,
			meanCostUsd: rollingMean(current.meanCostUsd, count, measurement.costUsd),
			meanLatencyMs: rollingMean(current.meanLatencyMs, count, measurement.latencyMs),
			costLatencyBasis: "measured",
			observationCount: nextCount,
		}
	}
	const bases = Object.values(history).map(({ costLatencyBasis }) => costLatencyBasis)
	const historyBasis = bases.every((basis) => basis === "measured")
		? "measured"
		: bases.some((basis) => basis === "measured")
			? "mixed"
			: "seeded-prior-from-legacy-baseline"
	return benchmarkSubsetSchema.parse({
		...manifest,
		historyBasis,
		measurementRunIds: [...manifest.measurementRunIds, sourceRunId].sort((a, b) => a - b),
		history,
	})
}

function historyScore(value: z.infer<typeof historySchema>): number {
	return (
		value.discrimination * 0.3 +
		value.severity * 0.2 +
		value.graderConfidence * 0.2 +
		value.regressionValue * 0.15 -
		value.redundancy * 0.1 -
		Math.min(value.meanCostUsd / 0.1, 1) * 0.04 -
		Math.min(value.meanLatencyMs / 120_000, 1) * 0.01
	)
}

function coverageCounts(tasks: BenchmarkTaskManifest[]): Record<string, number> {
	const count = (predicate: (task: BenchmarkTaskManifest) => boolean) => tasks.filter(predicate).length
	return {
		"real-repository": count(({ family }) => family === "real-repository"),
		"alpha-extension": count(({ family }) => family === "alpha-extension"),
		"safety-stateful": count(({ family }) => family === "safety-stateful"),
		"long-or-multifile": count(
			({ contextBand, editTopology }) => contextBand === "long" || editTopology.kind !== "single-file",
		),
		regression: count(({ partition }) => partition === "regression"),
		"tool-or-recovery": count(({ capabilities }) => capabilities.some((value) => /tool|recovery/.test(value))),
	}
}

function sum(values: number[]): number {
	return Number(values.reduce((total, value) => total + value, 0).toFixed(6))
}

function rollingMean(previous: number, count: number, next: number): number {
	return Number(((previous * count + next) / (count + 1)).toFixed(7))
}
