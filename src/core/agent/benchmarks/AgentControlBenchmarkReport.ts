import { isDeepStrictEqual } from "node:util"
import { z } from "zod"

import { AGENT_CONTROL_OPERATIONS } from "../AgentControlTransaction"

const duration = z.number().finite().nonnegative()
const count = duration.int().safe()
const diagnosticSchema = z
	.object({
		operation: z.enum(AGENT_CONTROL_OPERATIONS),
		outcome: z.literal("success"),
		queueWaitMs: duration,
		acquisitionWaitMs: duration,
		holdMs: duration,
		releaseMs: duration,
		attempts: count.positive(),
		ownerState: z.enum(["none", "live", "dead", "released", "legacy", "unreadable"]),
		ownerPid: count.positive().optional(),
		ownerOperation: z.enum(AGENT_CONTROL_OPERATIONS).optional(),
		committed: z.literal(true),
		releaseFailed: z.literal(false),
	})
	.passthrough()
const transactionSchema = z.object({
	wait: duration,
	body: duration,
	releaseAndFence: duration,
	phases: z.object({ read: duration, jsonParse: duration, validation: duration, copy: duration, write: duration }),
	writes: z.literal(1),
	diagnostic: diagnosticSchema,
})
const sampleSchema = z.object({
	command: z.literal("reserve-settle"),
	iteration: count.max(59),
	worker: count.max(1),
	total: duration,
	error: z.never().optional(),
	transactions: z.array(transactionSchema).length(2),
})
const workerSchema = z.object({
	samples: z.array(sampleSchema).length(60),
	eventLoop: z
		.object({ p50: duration, p95: duration, max: duration, count: count.positive() })
		.nullable()
		.default(null),
})
const caseSchema = z.object({
	options: z
		.object({
			retainedAgentCount: z.union([z.literal(1), z.literal(5_000)]),
			writers: z.union([z.literal(1), z.literal(2)]),
			samples: z.literal(60),
			warmups: z.literal(5),
			commands: z.tuple([z.literal("reserve-settle")]),
		})
		.passthrough(),
	initialBytes: count.positive(),
	finalBytes: count.positive(),
	fixture: z
		.object({
			retainedAgentCount: count,
			projectCount: z.literal(4),
			mailboxEntriesPerAgent: z.literal(4),
			mailboxPayloadBytes: z.literal(512),
			verificationObligationsPerAgent: z.literal(1),
			ownerId: z.string().min(1),
		})
		.passthrough(),
	workers: z.array(workerSchema).min(1).max(2),
})
const reportSchema = z.object({
	version: z.literal(1),
	sourceIdentity: z.record(z.string(), z.string().regex(/^(?:[a-f0-9]{64}|absent)$/)),
	runtime: z
		.object({
			node: z.string().min(1),
			packageManager: z.string().min(1),
			platform: z.string().min(1),
			arch: z.string().min(1),
			os: z.string().min(1),
			cpu: z.string().min(1),
			logicalCpus: count.positive(),
			memoryBytes: count.positive(),
		})
		.passthrough(),
	conditions: z
		.object({
			quietWindow: z.string().trim().min(1),
			cache: z.string().min(1),
			units: z.literal("milliseconds"),
			phases: z.string().min(1),
		})
		.passthrough(),
	cases: z.array(caseSchema).length(4),
})

const requiredSources = [
	"src/core/agent/AgentControlStore.ts",
	"src/core/agent/AgentControlTransaction.ts",
	"src/core/agent/ParentVerification.ts",
	"src/utils/safeWriteJson.ts",
	"src/core/agent/benchmarks/AgentControlStore.benchmark.ts",
	"src/core/agent/benchmarks/AgentControlBenchmarkWorkers.ts",
	"src/core/agent/__tests__/fixtures/agentControlBenchmarkFixture.ts",
	"packages/types/dist/index.cjs",
	"packages/types/dist/index.js",
	"pnpm-lock.yaml",
]
const mutableSources = new Set(["src/core/agent/AgentControlStore.ts", "src/utils/safeWriteJson.ts"])
const placeholder =
	/not granted|diagnostic|placeholder|unspecified|unavailable|pending|\btbd\b|\btodo\b|^(?:unknown|none|n\/a|no|false|-+)$|^<.*>$|^\[.*\]$/i
type ReportCase = z.infer<typeof caseSchema>
type Report = z.infer<typeof reportSchema>

const p95 = (values: number[]) => [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]
const caseKey = (entry: ReportCase) => `${entry.options.retainedAgentCount}/${entry.options.writers}`
const measure = (entry: ReportCase) => {
	const samples = entry.workers.flatMap((worker) => worker.samples)
	const transactions = samples.flatMap((sample) => sample.transactions)
	return {
		bodyP95: p95(transactions.map((transaction) => transaction.body)),
		totalP95: p95(samples.map((sample) => sample.total)),
		transactions: transactions.length,
		writes: transactions.reduce((sum, transaction) => sum + transaction.writes, 0),
		workers: entry.workers.map((worker, index) => ({ worker: index, ...worker })),
	}
}

export interface AgentControlBenchmarkComparison {
	passed: boolean
	checks: string[]
	failures: string[]
	cases: Array<{
		retainedAgentCount: number
		writers: number
		baseline: ReturnType<typeof measure>
		candidate: ReturnType<typeof measure>
		bodyImprovementPercent: number | null
		totalRegressionPercent: number | null
		totalRegressionMs: number
		passed: boolean
	}>
}

/** Acceptance uses complete raw samples; supplied summaries are never evidence. */
export function compareAgentControlBenchmarkReports(
	baseline: unknown,
	candidate: unknown,
): AgentControlBenchmarkComparison {
	const result: AgentControlBenchmarkComparison = { passed: false, checks: [], failures: [], cases: [] }
	const check = (valid: boolean, description: string) => {
		;(valid ? result.checks : result.failures).push(description)
	}
	const parse = (input: unknown, label: string): Report | undefined => {
		const parsed = reportSchema.safeParse(input)
		if (!parsed.success) {
			for (const issue of parsed.error.issues.slice(0, 20)) {
				result.failures.push(`${label}.${issue.path.join(".")}: ${issue.message}`)
			}
			return undefined
		}
		check(true, `${label}: complete finite raw samples, successful diagnostics, and required options`)
		return parsed.data
	}
	const before = parse(baseline, "baseline")
	const after = parse(candidate, "candidate")
	if (!before || !after) return result

	for (const [label, report] of [
		["baseline", before],
		["candidate", after],
	] as const) {
		check(!placeholder.test(report.conditions.quietWindow), `${label}: granted quiet window`)
		check(
			requiredSources.every(
				(source) => report.sourceIdentity[source] && report.sourceIdentity[source] !== "absent",
			),
			`${label}: all required source hashes present`,
		)
		check(new Set(report.cases.map(caseKey)).size === 4, `${label}: all four distinct workload cases`)
		for (const entry of report.cases) {
			const prefix = `${label} ${caseKey(entry)}`
			check(
				entry.fixture.retainedAgentCount === entry.options.retainedAgentCount,
				`${prefix}: matching fixture size`,
			)
			check(entry.workers.length === entry.options.writers, `${prefix}: complete worker count`)
			for (const [index, worker] of entry.workers.entries()) {
				check(
					worker.samples.every((sample) => sample.worker === index),
					`${prefix}: worker ${index} identity`,
				)
				check(
					new Set(worker.samples.map((sample) => sample.iteration)).size === 60,
					`${prefix}: worker ${index} iterations`,
				)
			}
		}
	}
	check(isDeepStrictEqual(before.runtime, after.runtime), "matching runtime and hardware")
	const { quietWindow: _beforeWindow, ...beforeConditions } = before.conditions
	const { quietWindow: _afterWindow, ...afterConditions } = after.conditions
	check(isDeepStrictEqual(beforeConditions, afterConditions), "matching cache and measurement conditions")
	check(
		isDeepStrictEqual(Object.keys(before.sourceIdentity).sort(), Object.keys(after.sourceIdentity).sort()) &&
			Object.keys(before.sourceIdentity).every(
				(source) =>
					mutableSources.has(source) || before.sourceIdentity[source] === after.sourceIdentity[source],
			),
		"only AgentControlStore.ts and safeWriteJson.ts source hashes may differ",
	)
	if (result.failures.length > 0) return result

	for (const entry of before.cases) {
		const matching = after.cases.find((value) => caseKey(value) === caseKey(entry))!
		const first = measure(entry)
		const second = measure(matching)
		const compatible =
			isDeepStrictEqual(entry.options, matching.options) &&
			isDeepStrictEqual(entry.fixture, matching.fixture) &&
			entry.initialBytes === matching.initialBytes
		check(compatible, `${caseKey(entry)}: matching workload options and fixture`)
		const bodyImprovementPercent =
			first.bodyP95 === 0 ? null : ((first.bodyP95 - second.bodyP95) / first.bodyP95) * 100
		const totalRegressionPercent =
			first.totalP95 === 0 ? null : ((second.totalP95 - first.totalP95) / first.totalP95) * 100
		const totalRegressionMs = second.totalP95 - first.totalP95
		const thresholdPassed =
			entry.options.retainedAgentCount === 5_000
				? first.bodyP95 > 0 && second.bodyP95 <= first.bodyP95 * 0.75
				: !(second.totalP95 > first.totalP95 * 1.1 && totalRegressionMs > 2)
		check(
			thresholdPassed,
			`${caseKey(entry)}: ${entry.options.retainedAgentCount === 5_000 ? "25% body p95 improvement" : "small cycle p95 regression guard"}`,
		)
		result.cases.push({
			retainedAgentCount: entry.options.retainedAgentCount,
			writers: entry.options.writers,
			baseline: first,
			candidate: second,
			bodyImprovementPercent,
			totalRegressionPercent,
			totalRegressionMs,
			passed: compatible && thresholdPassed,
		})
	}
	result.passed = result.failures.length === 0
	return result
}
