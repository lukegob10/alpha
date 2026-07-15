import type { CampaignBudgets } from "./types"

export class BudgetExceededError extends Error {
	constructor(
		public readonly budget: keyof CampaignBudgets,
		message: string,
	) {
		super(message)
		this.name = "BudgetExceededError"
	}
}

export class CampaignBudget {
	private commands: number

	constructor(
		private readonly limits: CampaignBudgets,
		private readonly startedAtMs: number,
		initialCommands = 0,
	) {
		this.commands = initialCommands
	}

	beforeCommand(nowMs: number): void {
		if (nowMs - this.startedAtMs >= this.limits.maxCampaignWallMs) {
			throw new BudgetExceededError("maxCampaignWallMs", "Campaign wall-time budget exhausted")
		}
		if (this.commands >= this.limits.maxCommands) {
			throw new BudgetExceededError("maxCommands", "Campaign command-count budget exhausted")
		}
		this.commands += 1
	}

	remainingCommandWallMs(nowMs: number): number {
		const campaignRemaining = this.limits.maxCampaignWallMs - (nowMs - this.startedAtMs)
		return Math.max(1, Math.min(this.limits.maxCommandWallMs, campaignRemaining))
	}
}
