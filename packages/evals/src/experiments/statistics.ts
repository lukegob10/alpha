import type { PairedTrial, TrialObservation } from "./types"

export type ExperimentStatistics = {
	outcome: {
		successes: number
		failures: number
		excluded: number
		rate: number | null
		bootstrap95: [number, number] | null
	}
	paired: { wins: number; losses: number; ties: number }
	consistencyAtK: number | null
	passAtK: number | null
	costPerSuccess: number | null
	latencyMs: { p50: number | null; p95: number | null }
	infrastructureErrorRate: number
	graderErrorRate: number
	firstAttemptReliability: number
	retryAssistedCapability: number | null
	coverage?: {
		observations: number
		scoreable: number
		pairedScoreable: number
		pairedExcluded: number
		knownCost: number
		knownTokens: number
		retryAssisted: number
	}
	uncertainty?: {
		independentUnit: "task" | "repository" | "attempt"
		clusters: number
		mean: number | null
		bootstrap95: [number, number] | null
		binaryWilson95: [number, number] | null
		pairedClusters: number
		pairedDelta: number | null
		pairedBootstrap95: [number, number] | null
	}
}

export type SegmentedExperimentStatistics = {
	overall: ExperimentStatistics
	byCapability: Record<string, ExperimentStatistics>
	byRisk: Record<TrialObservation["risk"], ExperimentStatistics | undefined>
	byFamily: Record<string, ExperimentStatistics>
	byDifficulty: Record<TrialObservation["difficulty"], ExperimentStatistics | undefined>
}

const scored = new Set(["passed", "outcome_failed", "safety_failed", "agent_error", "budget_exhausted"])

export function summarizeExperiment(
	observations: TrialObservation[],
	pairs: PairedTrial[],
	options: {
		bootstrapSamples?: number
		bootstrapSeed?: number
		consistencyK?: number
		passK?: number
		independentUnit?: "task" | "repository" | "attempt"
	} = {},
): ExperimentStatistics {
	const eligible = observations.filter(({ status }) => scored.has(status))
	const values: number[] = eligible.map(({ status }) => (status === "passed" ? 1 : 0))
	const successes = values.reduce((sum, value) => sum + value, 0)
	const paired = { wins: 0, losses: 0, ties: 0 }
	const eligiblePairs = pairs.filter(
		({ control, candidate }) => scored.has(control.status) && scored.has(candidate.status),
	)
	for (const pair of eligiblePairs) {
		const control = pair.control.status === "passed"
		const candidate = pair.candidate.status === "passed"
		if (candidate === control) paired.ties++
		else if (candidate) paired.wins++
		else paired.losses++
	}
	const retryAssisted = eligible.filter((value) => value.retryAssisted)
	const independentUnit = options.independentUnit ?? "task"
	const clusterKey = (value: TrialObservation) => {
		if (independentUnit === "repository") {
			if (!value.repository)
				throw new Error("Repository uncertainty requires repository identity on every observation")
			return value.repository
		}
		return JSON.stringify([
			value.repository ?? null,
			value.taskId,
			value.taskVersion,
			...(independentUnit === "attempt" ? [value.seed, value.repetition] : []),
		])
	}
	const clusterMeans = (rows: { observation: TrialObservation; value: number }[]) => {
		const groups = new Map<string, Map<string, number[]>>()
		for (const row of rows) {
			const key = clusterKey(row.observation)
			const tasks = groups.get(key) ?? new Map<string, number[]>()
			const task = JSON.stringify([row.observation.taskId, row.observation.taskVersion])
			tasks.set(task, [...(tasks.get(task) ?? []), row.value])
			groups.set(key, tasks)
		}
		return [...groups.values()].map((tasks) => {
			const means = [...tasks.values()].map(
				(values) => values.reduce((sum, value) => sum + value, 0) / values.length,
			)
			return means.reduce((sum, value) => sum + value, 0) / means.length
		})
	}
	const clusters = clusterMeans(
		eligible.map((observation) => ({ observation, value: Number(observation.status === "passed") })),
	)
	const deltas = clusterMeans(
		eligiblePairs.map(({ control, candidate }) => ({
			observation: candidate,
			value: Number(candidate.status === "passed") - Number(control.status === "passed"),
		})),
	)
	const mean = (values: number[]) =>
		values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
	const interval = (values: number[]) =>
		values.length ? bootstrapMean95(values, options.bootstrapSamples ?? 2_000, options.bootstrapSeed ?? 9412) : null
	return {
		coverage: {
			observations: observations.length,
			scoreable: eligible.length,
			pairedScoreable: eligiblePairs.length,
			pairedExcluded: pairs.length - eligiblePairs.length,
			knownCost: observations.filter(({ cost }) => cost !== null).length,
			knownTokens: observations.filter(({ tokens }) => tokens != null).length,
			retryAssisted: retryAssisted.length,
		},
		uncertainty: {
			independentUnit,
			clusters: clusters.length,
			mean: mean(clusters),
			bootstrap95: interval(clusters),
			binaryWilson95:
				clusters.length === eligible.length
					? wilson95(
							clusters.reduce<number>((sum, value) => sum + value, 0),
							clusters.length,
						)
					: null,
			pairedClusters: deltas.length,
			pairedDelta: mean(deltas),
			pairedBootstrap95: interval(deltas),
		},
		outcome: {
			successes,
			failures: eligible.length - successes,
			excluded: observations.length - eligible.length,
			rate: eligible.length ? successes / eligible.length : null,
			bootstrap95: values.length
				? bootstrapMean95(values, options.bootstrapSamples ?? 2_000, options.bootstrapSeed ?? 9412)
				: null,
		},
		paired,
		consistencyAtK: consistencyAtK(observations, options.consistencyK ?? 3),
		passAtK: passAtK(observations, options.passK ?? 1),
		costPerSuccess:
			successes && observations.every(({ cost }) => cost !== null)
				? observations.reduce((sum, { cost }) => sum + (cost ?? 0), 0) / successes
				: null,
		latencyMs: {
			p50: quantile(
				observations.map(({ latencyMs }) => latencyMs),
				0.5,
			),
			p95: quantile(
				observations.map(({ latencyMs }) => latencyMs),
				0.95,
			),
		},
		infrastructureErrorRate: fraction(observations, ({ status }) => status === "infrastructure_error"),
		graderErrorRate: fraction(observations, ({ status }) => status === "grader_error"),
		firstAttemptReliability: fraction(observations, ({ firstAttemptStatus }) => firstAttemptStatus === "passed"),
		retryAssistedCapability: retryAssisted.length
			? fraction(retryAssisted, ({ status }) => status === "passed")
			: null,
	}
}

export function segmentExperiment(
	observations: TrialObservation[],
	pairs: PairedTrial[],
	options: Parameters<typeof summarizeExperiment>[2] = {},
): SegmentedExperimentStatistics {
	const capabilities = [...new Set(observations.flatMap(({ capabilities }) => capabilities))].sort()
	const families = [...new Set(observations.map(({ family }) => family))].sort()
	const risks = ["low", "medium", "high", "critical"] as const
	const difficulties = ["foundation", "challenging", "frontier"] as const
	const segment = (predicate: (observation: TrialObservation) => boolean) =>
		summarizeExperiment(
			observations.filter(predicate),
			pairs.filter(({ candidate }) => predicate(candidate)),
			options,
		)
	return {
		overall: summarizeExperiment(observations, pairs, options),
		byCapability: Object.fromEntries(
			capabilities.map((capability) => [
				capability,
				summarizeExperiment(
					observations.filter(({ capabilities: values }) => values.includes(capability)),
					pairs.filter(({ candidate }) => candidate.capabilities.includes(capability)),
					options,
				),
			]),
		),
		byRisk: Object.fromEntries(
			risks.map((risk) => {
				const values = observations.filter(({ risk: value }) => value === risk)
				return [risk, values.length ? segment(({ risk: value }) => value === risk) : undefined]
			}),
		) as SegmentedExperimentStatistics["byRisk"],
		byFamily: Object.fromEntries(
			families.map((family) => [family, segment(({ family: value }) => value === family)]),
		),
		byDifficulty: Object.fromEntries(
			difficulties.map((difficulty) => {
				const values = observations.filter(({ difficulty: value }) => value === difficulty)
				return [
					difficulty,
					values.length ? segment(({ difficulty: value }) => value === difficulty) : undefined,
				]
			}),
		) as SegmentedExperimentStatistics["byDifficulty"],
	}
}

export function bootstrapMean95(values: number[], samples: number, seed: number): [number, number] {
	if (values.length === 0 || samples < 1) throw new Error("Bootstrap requires values and samples")
	const random = mulberry32(seed)
	const means = Array.from({ length: samples }, () => {
		let total = 0
		for (let index = 0; index < values.length; index++) total += values[Math.floor(random() * values.length)]!
		return total / values.length
	}).sort((left, right) => left - right)
	return [quantile(means, 0.025)!, quantile(means, 0.975)!]
}

export function quantile(values: number[], probability: number): number | null {
	if (values.length === 0) return null
	if (probability < 0 || probability > 1) throw new Error("Probability must be between zero and one")
	const sorted = [...values].sort((left, right) => left - right)
	const position = (sorted.length - 1) * probability
	const lower = Math.floor(position)
	const upper = Math.ceil(position)
	return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

export function consistencyAtK(values: TrialObservation[], k: number): number | null {
	const groups = groupByTask(values).filter((group) => group.length >= k)
	return groups.length
		? groups.filter((group) => group.slice(0, k).every(({ status }) => status === "passed")).length / groups.length
		: null
}

export function passAtK(values: TrialObservation[], k: number): number | null {
	const groups = groupByTask(values).filter((group) => group.length >= k)
	if (groups.length === 0) return null
	return (
		groups.reduce((sum, group) => {
			const correct = group.filter(({ status }) => status === "passed").length
			return sum + (correct === 0 ? 0 : 1 - combination(group.length - correct, k) / combination(group.length, k))
		}, 0) / groups.length
	)
}

function groupByTask(values: TrialObservation[]): TrialObservation[][] {
	const groups = new Map<string, TrialObservation[]>()
	for (const value of values) {
		const key = JSON.stringify([value.repository ?? null, value.taskId, value.taskVersion])
		groups.set(key, [...(groups.get(key) ?? []), value])
	}
	return [...groups.values()].map((group) => group.sort((left, right) => left.repetition - right.repetition))
}

function combination(n: number, k: number): number {
	if (k > n) return 0
	let value = 1
	for (let index = 1; index <= k; index++) value = (value * (n - index + 1)) / index
	return value
}

/** Binary independent-unit interval; repeated attempts are not independent task samples. */
export function wilson95(successes: number, total: number): [number, number] | null {
	if (!total) return null
	const z = 1.959963984540054
	const rate = successes / total
	const denominator = 1 + (z * z) / total
	const center = (rate + (z * z) / (2 * total)) / denominator
	const radius = (z * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total))) / denominator
	return [Math.max(0, center - radius), Math.min(1, center + radius)]
}

function fraction<T>(values: T[], predicate: (value: T) => boolean): number {
	return values.length ? values.filter(predicate).length / values.length : 0
}

function mulberry32(seed: number): () => number {
	let value = seed >>> 0
	return () => {
		value += 0x6d2b79f5
		let next = value
		next = Math.imul(next ^ (next >>> 15), next | 1)
		next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
		return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296
	}
}
