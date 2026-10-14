export type CampaignTier = "t0" | "t1" | "t2" | "t3" | "t4" | "t5"

export type TierBudget = {
	tier: CampaignTier
	taskCount: number
	iterations: number
	estimatedCostUsd: number
	taskReservationUsd: number
	reservedCostUsd: number
	hardCapUsd: number
	requiresExplicitApproval: boolean
}

const tierDefaults: Record<
	CampaignTier,
	Omit<TierBudget, "tier" | "estimatedCostUsd" | "reservedCostUsd"> & { meanCostUsd: number }
> = {
	t0: {
		taskCount: 0,
		iterations: 0,
		meanCostUsd: 0,
		taskReservationUsd: 0,
		hardCapUsd: 0,
		requiresExplicitApproval: false,
	},
	t1: {
		taskCount: 8,
		iterations: 1,
		meanCostUsd: 0.04,
		taskReservationUsd: 0.05,
		hardCapUsd: 0.5,
		requiresExplicitApproval: false,
	},
	t2: {
		taskCount: 20,
		iterations: 1,
		meanCostUsd: 0.04,
		taskReservationUsd: 0.05,
		hardCapUsd: 1,
		requiresExplicitApproval: false,
	},
	t3: {
		taskCount: 40,
		iterations: 1,
		meanCostUsd: 0.04,
		taskReservationUsd: 0.05,
		hardCapUsd: 2,
		requiresExplicitApproval: false,
	},
	t4: {
		taskCount: 8,
		iterations: 3,
		meanCostUsd: 0.04,
		taskReservationUsd: 0.08,
		hardCapUsd: 2,
		requiresExplicitApproval: false,
	},
	t5: {
		taskCount: 40,
		iterations: 5,
		meanCostUsd: 0.052,
		taskReservationUsd: 0.08,
		hardCapUsd: 16,
		requiresExplicitApproval: true,
	},
}

export function estimateTierBudget(
	tier: CampaignTier,
	overrides: Partial<Pick<TierBudget, "taskCount" | "iterations" | "hardCapUsd" | "taskReservationUsd">> & {
		meanCostUsd?: number
	} = {},
): TierBudget {
	const defaults = tierDefaults[tier]
	const taskCount = overrides.taskCount ?? defaults.taskCount
	const iterations = overrides.iterations ?? defaults.iterations
	const hardCapUsd = overrides.hardCapUsd ?? defaults.hardCapUsd
	const taskReservationUsd = overrides.taskReservationUsd ?? defaults.taskReservationUsd
	const estimatedCostUsd = money(taskCount * iterations * (overrides.meanCostUsd ?? defaults.meanCostUsd))
	const reservedCostUsd = money(taskCount * iterations * taskReservationUsd)
	return {
		tier,
		taskCount,
		iterations,
		estimatedCostUsd,
		taskReservationUsd,
		reservedCostUsd,
		hardCapUsd,
		requiresExplicitApproval: defaults.requiresExplicitApproval || hardCapUsd > 2,
	}
}

export function assertCampaignBudgetAuthorized(budget: TierBudget, approved: boolean): void {
	if (budget.reservedCostUsd > budget.hardCapUsd)
		throw new Error(
			`Reserved cost $${budget.reservedCostUsd.toFixed(2)} exceeds campaign hard cap $${budget.hardCapUsd.toFixed(2)}`,
		)
	if (budget.requiresExplicitApproval && !approved)
		throw new Error(`${budget.tier.toUpperCase()} or a campaign cap above $2 requires explicit approval`)
}

export class CampaignCostLedger {
	private reserved = 0
	private consumed = 0
	constructor(readonly hardCapUsd: number) {}
	reserve(amount: number): void {
		if (amount < 0) throw new Error("Reservation must be nonnegative")
		if (money(this.consumed + this.reserved + amount) > this.hardCapUsd)
			throw new Error("Insufficient campaign budget for the next task reservation")
		this.reserved = money(this.reserved + amount)
	}
	settle(reservation: number, actual: number): void {
		if (actual < 0 || reservation < 0) throw new Error("Campaign costs must be nonnegative")
		this.reserved = money(Math.max(0, this.reserved - reservation))
		this.consumed = money(this.consumed + actual)
		if (this.consumed > this.hardCapUsd) throw new Error("Campaign hard cap exceeded")
	}
	snapshot() {
		return {
			hardCapUsd: this.hardCapUsd,
			reservedUsd: this.reserved,
			consumedUsd: this.consumed,
			remainingUsd: money(this.hardCapUsd - this.reserved - this.consumed),
		}
	}
}

export function evaluateEfficiencyRegression(input: {
	baselineCostPerSuccess: number
	candidateCostPerSuccess: number
	baselineMedianLatencyMs: number
	candidateMedianLatencyMs: number
	capabilityImproved: boolean
}): { accepted: boolean; reasons: string[] } {
	const reasons: string[] = []
	if (!input.capabilityImproved && input.candidateCostPerSuccess > input.baselineCostPerSuccess * 1.2)
		reasons.push("cost_per_success_regression_over_20_percent")
	if (!input.capabilityImproved && input.candidateMedianLatencyMs > input.baselineMedianLatencyMs * 1.25)
		reasons.push("median_latency_regression_over_25_percent")
	return { accepted: reasons.length === 0, reasons }
}

function money(value: number): number {
	return Number(value.toFixed(6))
}
