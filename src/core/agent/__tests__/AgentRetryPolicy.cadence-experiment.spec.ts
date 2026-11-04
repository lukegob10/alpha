import {
	AgentRetryPolicy,
	delayWithAbort,
	type AgentRetryCategory,
	type AgentRetryExhaustionReason,
	type AgentRetryPolicyOptions,
} from "../AgentRetryPolicy"

// Experiment only: Codex ac558 async-utils/backoff.rs uses 200ms and [0.9, 1.1) jitter.
// Keep production guards and Alpha's local cap; do not install this cadence as a supported profile.
class CandidateCadence extends AgentRetryPolicy {
	constructor(
		private readonly quantile: number,
		options: AgentRetryPolicyOptions = {},
	) {
		super({ baseDelayMs: 200, jitter: "none", ...options })
	}

	override getDelayMs(attempt: number, retryAfterMs?: number): number {
		const delay = super.getDelayMs(attempt, retryAfterMs)
		if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return delay
		return Math.min(this.maxDelayMs, Math.floor(delay * (0.9 + 0.2 * this.quantile)))
	}
}

type Status = "completed" | "exhausted" | "cancelled"
type Expected = readonly [requests: number, elapsedMs: number, status: Status]
interface Workload {
	name: string
	failAttempts?: number
	outageUntilMs?: number
	category?: AgentRetryCategory
	alternateCategories?: boolean
	retryAfterMs?: number
	pacingMs?: number
	maxElapsedMs?: number
	hasSemanticOutput?: boolean
	cancelAtMs?: number
	baseline: Expected
	candidate: Expected
}
interface Measurement {
	requests: number
	elapsedMs: number
	status: Status
	reason?: AgentRetryExhaustionReason
}

// Frozen before the experiment; successful outcomes and request counts qualify cadence changes.
// In particular, a faster exhausted result is not a successful latency improvement.
const WORKLOADS: readonly Workload[] = Object.freeze([
	{
		name: "one transient failure",
		failAttempts: 1,
		baseline: [2, 500, "completed"],
		candidate: [2, 200, "completed"],
	},
	{
		name: "two transient failures",
		failAttempts: 2,
		baseline: [3, 1500, "completed"],
		candidate: [3, 600, "completed"],
	},
	{
		name: "100ms outage",
		outageUntilMs: 100,
		baseline: [2, 500, "completed"],
		candidate: [2, 200, "completed"],
	},
	{
		name: "500ms outage",
		outageUntilMs: 500,
		baseline: [2, 500, "completed"],
		candidate: [3, 600, "completed"],
	},
	{
		name: "2000ms outage",
		outageUntilMs: 2000,
		baseline: [4, 3500, "completed"],
		candidate: [4, 1400, "exhausted"],
	},
	{
		name: "persistent outage",
		failAttempts: 20,
		baseline: [4, 3500, "exhausted"],
		candidate: [4, 1400, "exhausted"],
	},
	{
		name: "advised 2000ms rate-limit outage",
		outageUntilMs: 2000,
		category: "rate-limit",
		retryAfterMs: 1000,
		baseline: [3, 2000, "completed"],
		candidate: [3, 2000, "completed"],
	},
	{
		name: "60000ms server advice",
		failAttempts: 1,
		category: "rate-limit",
		retryAfterMs: 60000,
		baseline: [2, 60000, "completed"],
		candidate: [2, 60000, "completed"],
	},
	{
		name: "1000ms pacing floor",
		failAttempts: 2,
		pacingMs: 1000,
		baseline: [3, 2000, "completed"],
		candidate: [3, 2000, "completed"],
	},
	{
		name: "alternating categories",
		failAttempts: 3,
		alternateCategories: true,
		baseline: [4, 2000, "completed"],
		candidate: [4, 800, "completed"],
	},
	{
		name: "empty-response category cap",
		failAttempts: 20,
		category: "empty-response",
		baseline: [2, 500, "exhausted"],
		candidate: [2, 200, "exhausted"],
	},
	{
		name: "semantic-output replay guard",
		failAttempts: 1,
		hasSemanticOutput: true,
		baseline: [1, 0, "exhausted"],
		candidate: [1, 0, "exhausted"],
	},
	{
		name: "server advice beyond deadline",
		failAttempts: 1,
		retryAfterMs: 2000,
		maxElapsedMs: 1000,
		baseline: [1, 0, "exhausted"],
		candidate: [1, 0, "exhausted"],
	},
	{
		name: "cancellation during wait",
		failAttempts: 1,
		cancelAtMs: 50,
		baseline: [1, 50, "cancelled"],
		candidate: [1, 50, "cancelled"],
	},
])

async function measure(policy: AgentRetryPolicy, workload: Workload): Promise<Measurement> {
	vi.setSystemTime(0)
	const counts = new Map<AgentRetryCategory, number>()
	const controller = new AbortController()
	const cancellation =
		workload.cancelAtMs === undefined
			? undefined
			: setTimeout(() => controller.abort(new Error("experiment cancelled")), workload.cancelAtMs)
	try {
		for (let requests = 1; requests <= policy.maxAttempts; requests++) {
			const elapsedMs = Date.now()
			if (requests > (workload.failAttempts ?? 0) && elapsedMs >= (workload.outageUntilMs ?? 0)) {
				return { requests, elapsedMs, status: "completed" }
			}
			const category = workload.alternateCategories
				? requests % 2 === 0
					? "rate-limit"
					: "transport"
				: (workload.category ?? "transport")
			const attempt = (counts.get(category) ?? 0) + 1
			counts.set(category, attempt)
			const decision = policy.decide({
				category,
				attempt,
				totalAttempt: requests,
				elapsedMs,
				retryAfterMs: workload.retryAfterMs,
				hasSemanticOutput: workload.hasSemanticOutput,
			})
			if (!decision.shouldRetry) return { requests, elapsedMs, status: "exhausted", reason: decision.reason }
			const wait = Math.max(decision.delayMs, workload.pacingMs ?? 0)
			const pending = delayWithAbort(wait, controller.signal).then(
				() => true,
				(error: unknown) => {
					if (error !== controller.signal.reason) throw error
					return false
				},
			)
			await vi.advanceTimersByTimeAsync(
				workload.cancelAtMs === undefined ? wait : Math.min(wait, Math.max(0, workload.cancelAtMs - elapsedMs)),
			)
			if (!(await pending)) return { requests, elapsedMs: Date.now(), status: "cancelled" }
		}
		throw new Error("Production policy failed to enforce its finite total-attempt cap")
	} finally {
		clearTimeout(cancellation)
	}
}

function expected([requests, elapsedMs, status]: Expected): Measurement {
	return { requests, elapsedMs, status }
}

const QUANTILES = [
	{
		quantile: 0,
		baseline: 0,
		candidate: 180,
	},
	{
		quantile: 0.1,
		baseline: 100,
		candidate: 184,
	},
	{
		quantile: 0.5,
		baseline: 500,
		candidate: 200,
	},
	{
		quantile: 0.9,
		baseline: 900,
		candidate: 216,
	},
]

describe("AgentRetryPolicy fixed cadence experiment", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		try {
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it.each(WORKLOADS)("measures unchanged guards for $name", async (workload) => {
		const options = { maxElapsedMs: workload.maxElapsedMs }
		const baseline = await measure(new AgentRetryPolicy({ ...options, random: () => 0.5 }), workload)
		const candidate = await measure(new CandidateCadence(0.5, options), workload)
		expect(baseline).toMatchObject(expected(workload.baseline))
		expect(candidate).toMatchObject(expected(workload.candidate))
		if (workload.hasSemanticOutput) {
			expect(baseline.reason).toBe("semantic-output")
			expect(candidate.reason).toBe("semantic-output")
		}
		if (workload.maxElapsedMs !== undefined) {
			expect(baseline.reason).toBe("elapsed-budget")
			expect(candidate.reason).toBe("elapsed-budget")
		}
	})

	it.each(QUANTILES)("measures first-retry jitter at quantile $quantile", ({ quantile, baseline, candidate }) => {
		expect(new AgentRetryPolicy({ random: () => quantile }).getDelayMs(1)).toBe(baseline)
		expect(new CandidateCadence(quantile).getDelayMs(1)).toBe(candidate)
	})
})
