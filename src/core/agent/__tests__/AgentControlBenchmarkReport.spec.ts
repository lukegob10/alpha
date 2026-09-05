import { compareAgentControlBenchmarkReports } from "../benchmarks/AgentControlBenchmarkReport"

const sourcePaths = [
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

const report = (candidate = false) => ({
	version: 1,
	sourceIdentity: Object.fromEntries(sourcePaths.map((source) => [source, "a".repeat(64)])),
	runtime: {
		node: "v20.19.2",
		packageManager: "pnpm/10.8.1",
		platform: "win32",
		arch: "x64",
		os: "test-os",
		cpu: "test-cpu",
		logicalCpus: 8,
		memoryBytes: 16_000_000_000,
	},
	conditions: {
		quietWindow: "orchestrator window 123",
		cache: "warm filesystem",
		units: "milliseconds",
		phases: "raw",
	},
	cases: [1, 5_000].flatMap((retainedAgentCount) =>
		[1, 2].map((writers) => {
			const body = retainedAgentCount === 5_000 ? (candidate ? 75 : 100) : 2
			return {
				options: { retainedAgentCount, writers, samples: 60, warmups: 5, commands: ["reserve-settle"] },
				initialBytes: 10_000,
				finalBytes: 10_000,
				fixture: {
					retainedAgentCount,
					projectCount: 4,
					mailboxEntriesPerAgent: 4,
					mailboxPayloadBytes: 512,
					verificationObligationsPerAgent: 1,
					ownerId: "fixture-owner",
				},
				summary: [{ failures: 0, body: { p95: 0 }, total: { p95: 0 } }],
				workers: Array.from({ length: writers }, (_, worker) => ({
					eventLoop: { count: 10, p50: 1, p95: 2, max: 3 },
					samples: Array.from({ length: 60 }, (_, iteration) => ({
						command: "reserve-settle",
						worker,
						iteration,
						total: retainedAgentCount === 5_000 ? body * 2 + 10 : 10,
						transactions: Array.from({ length: 2 }, () => ({
							wait: 0,
							body,
							releaseAndFence: 0,
							writes: 1,
							phases: { read: 0, jsonParse: 0, validation: 0, copy: 0, write: 0 },
							diagnostic: {
								operation: "mutation",
								outcome: "success",
								queueWaitMs: 0,
								acquisitionWaitMs: 0,
								holdMs: body,
								releaseMs: 0,
								attempts: 1,
								ownerState: "none",
								committed: true,
								releaseFailed: false,
							},
						})),
					})),
				})),
			}
		}),
	),
})

describe("AgentControlBenchmarkReport", () => {
	it("accepts complete raw evidence and preserves per-worker samples and diagnostics", () => {
		const candidate = report(true)
		candidate.sourceIdentity["src/core/agent/AgentControlStore.ts"] = "b".repeat(64)
		candidate.sourceIdentity["src/utils/safeWriteJson.ts"] = "c".repeat(64)
		const result = compareAgentControlBenchmarkReports(report(), candidate)
		expect(result.passed).toBe(true)
		expect(result.failures).toEqual([])
		expect(result.cases).toHaveLength(4)
		for (const entry of result.cases) {
			expect(entry.baseline.transactions).toBe(120 * entry.writers)
			expect(entry.candidate.writes).toBe(120 * entry.writers)
			expect(entry.candidate.workers).toHaveLength(entry.writers)
			expect(entry.candidate.workers[0].samples[0].transactions[0].diagnostic.outcome).toBe("success")
			if (entry.retainedAgentCount === 5_000) expect(entry.bodyImprovementPercent).toBe(25)
		}
	})

	it("uses nearest-rank raw p95 and rejects a failing writer count despite optimistic summaries", () => {
		const candidate = report(true)
		const samples = candidate.cases[3].workers.flatMap((worker) => worker.samples)
		const transactions = samples.flatMap((sample) => sample.transactions)
		for (const transaction of transactions.slice(-13)) transaction.body = 76
		const result = compareAgentControlBenchmarkReports(report(), candidate)
		expect(result.passed).toBe(false)
		expect(result.cases[2].passed).toBe(true)
		expect(result.cases[3].candidate.bodyP95).toBe(76)
		expect(result.cases[3].passed).toBe(false)
		expect(result.failures).toContain("5000/2: 25% body p95 improvement")
	})

	it.each([
		{ baseline: 10, candidate: 12, passed: true },
		{ baseline: 30, candidate: 33, passed: true },
		{ baseline: 10, candidate: 12.01, passed: false },
		{ baseline: 0, candidate: 2, passed: true },
		{ baseline: 0, candidate: 2.01, passed: false },
	])("applies both strict small-case regression thresholds: $baseline to $candidate", (input) => {
		const baseline = report()
		const candidate = report(true)
		for (const sample of baseline.cases[0].workers[0].samples) sample.total = input.baseline
		for (const sample of candidate.cases[0].workers[0].samples) sample.total = input.candidate
		const result = compareAgentControlBenchmarkReports(baseline, candidate)
		expect(result.passed).toBe(input.passed)
		expect(result.cases[0].totalRegressionMs).toBeCloseTo(input.candidate - input.baseline)
	})

	it("represents absent event-loop evidence as unavailable instead of measured zero", () => {
		const candidate = report(true)
		Reflect.deleteProperty(candidate.cases[0].workers[0], "eventLoop")
		const result = compareAgentControlBenchmarkReports(report(), candidate)
		expect(result.passed).toBe(true)
		expect(result.cases[0].candidate.workers[0].eventLoop).toBeNull()
		candidate.cases[1].workers[0].eventLoop.count = 0
		expect(compareAgentControlBenchmarkReports(report(), candidate).passed).toBe(false)
	})

	it.each([
		{ label: "missing case", mutate: (value: ReturnType<typeof report>) => value.cases.pop() },
		{ label: "duplicate case", mutate: (value: ReturnType<typeof report>) => (value.cases[3] = value.cases[2]) },
		{ label: "missing worker", mutate: (value: ReturnType<typeof report>) => value.cases[1].workers.pop() },
		{
			label: "missing sample",
			mutate: (value: ReturnType<typeof report>) => value.cases[0].workers[0].samples.pop(),
		},
		{
			label: "missing transaction",
			mutate: (value: ReturnType<typeof report>) => value.cases[0].workers[0].samples[0].transactions.pop(),
		},
		{
			label: "duplicate iteration",
			mutate: (value: ReturnType<typeof report>) => (value.cases[0].workers[0].samples[1].iteration = 0),
		},
		{
			label: "wrong worker",
			mutate: (value: ReturnType<typeof report>) => (value.cases[1].workers[1].samples[0].worker = 0),
		},
		{
			label: "wrong sample count",
			mutate: (value: ReturnType<typeof report>) => (value.cases[0].options.samples = 59),
		},
		{ label: "wrong warmups", mutate: (value: ReturnType<typeof report>) => (value.cases[0].options.warmups = 4) },
		{
			label: "extra command",
			mutate: (value: ReturnType<typeof report>) => value.cases[0].options.commands.push("snapshot-read"),
		},
		{
			label: "negative duration",
			mutate: (value: ReturnType<typeof report>) => (value.cases[0].workers[0].samples[0].total = -1),
		},
		{
			label: "infinite duration",
			mutate: (value: ReturnType<typeof report>) =>
				(value.cases[0].workers[0].samples[0].transactions[0].body = Infinity),
		},
		{
			label: "NaN phase",
			mutate: (value: ReturnType<typeof report>) =>
				(value.cases[0].workers[0].samples[0].transactions[0].phases.copy = NaN),
		},
		{
			label: "missing write",
			mutate: (value: ReturnType<typeof report>) =>
				(value.cases[0].workers[0].samples[0].transactions[0].writes = 0),
		},
		{
			label: "sample error",
			mutate: (value: ReturnType<typeof report>) =>
				Object.assign(value.cases[0].workers[0].samples[0], { error: "ELOCKED" }),
		},
		{
			label: "missing diagnostic",
			mutate: (value: ReturnType<typeof report>) =>
				Reflect.deleteProperty(value.cases[0].workers[0].samples[0].transactions[0], "diagnostic"),
		},
		{
			label: "acquisition failure",
			mutate: (value: ReturnType<typeof report>) =>
				(value.cases[0].workers[0].samples[0].transactions[0].diagnostic.outcome = "error"),
		},
		{
			label: "uncommitted transaction",
			mutate: (value: ReturnType<typeof report>) =>
				(value.cases[0].workers[0].samples[0].transactions[0].diagnostic.committed = false),
		},
		{
			label: "release failure",
			mutate: (value: ReturnType<typeof report>) =>
				(value.cases[0].workers[0].samples[0].transactions[0].diagnostic.releaseFailed = true),
		},
		{
			label: "invalid diagnostic count",
			mutate: (value: ReturnType<typeof report>) =>
				(value.cases[0].workers[0].samples[0].transactions[0].diagnostic.attempts = 0),
		},
	])("rejects incomplete or invalid raw evidence: $label", ({ mutate }) => {
		const candidate = report(true)
		mutate(candidate)
		const result = compareAgentControlBenchmarkReports(report(), candidate)
		expect(result.passed).toBe(false)
		expect(result.failures.length).toBeGreaterThan(0)
	})

	it.each(
		sourcePaths.filter(
			(source) => !["src/core/agent/AgentControlStore.ts", "src/utils/safeWriteJson.ts"].includes(source),
		),
	)("rejects unrelated source drift: %s", (source) => {
		const candidate = report(true)
		candidate.sourceIdentity[source] = "b".repeat(64)
		expect(compareAgentControlBenchmarkReports(report(), candidate).passed).toBe(false)
	})

	it("rejects missing identities, placeholders, and changed runtime or workload conditions", () => {
		const mutations = [
			(value: ReturnType<typeof report>) => Reflect.deleteProperty(value.sourceIdentity, "pnpm-lock.yaml"),
			(value: ReturnType<typeof report>) => (value.sourceIdentity["pnpm-lock.yaml"] = "absent"),
			(value: ReturnType<typeof report>) => (value.conditions.quietWindow = "not granted; diagnostic run only"),
			(value: ReturnType<typeof report>) => (value.conditions.quietWindow = "<granted window>"),
			(value: ReturnType<typeof report>) => (value.conditions.cache = "cold filesystem"),
			(value: ReturnType<typeof report>) => (value.runtime.node = "v22.0.0"),
			(value: ReturnType<typeof report>) => (value.cases[0].fixture.mailboxPayloadBytes = 1),
			(value: ReturnType<typeof report>) => (value.cases[0].initialBytes = 1),
		]
		for (const mutate of mutations) {
			const candidate = report(true)
			mutate(candidate)
			expect(compareAgentControlBenchmarkReports(report(), candidate).passed).toBe(false)
		}
	})
})
