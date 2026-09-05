import type { ParentVerificationObligation } from "@alpha-code/types"

interface CompletionDebtDecision {
	allowed: boolean
	message?: string
	blockerKey?: string
	blockingObligations?: readonly ParentVerificationObligation[]
}

interface RepairDebt {
	key: string
	changeSetId?: string
	file?: string
	kind?: string
}

interface RepairAllowance extends RepairDebt {
	rejections: number
	unsuccessfulChecks: number
}

export interface CompletionCheckScope {
	changeSetId: string
	matchedFiles?: readonly string[]
	kind?: string
}

function debtsFor(decision: CompletionDebtDecision): RepairDebt[] {
	const debts: RepairDebt[] = []
	for (const obligation of decision.blockingObligations ?? []) {
		for (const file of obligation.changedFiles) {
			const passed = new Set(obligation.verifiedChecks?.[file] ?? [])
			const required = obligation.verificationRequirements?.[file] ?? []
			const missing: string[] = required.filter((kind) => !passed.has(kind))
			if (required.length === 0 && passed.size === 0) missing.push("supported_check")
			const failure =
				obligation.status === "failed" &&
				(obligation.verification?.matchedFiles ?? obligation.changedFiles).includes(file)
			if (failure) missing.push(`failed:${obligation.verification?.kind ?? "supported_check"}`)
			for (const kind of new Set(missing)) {
				debts.push({
					// Aggregate versions also change for unrelated edits. Only this file's
					// receipt and missing check identify its repair allowance.
					key: JSON.stringify([obligation.id, file, obligation.fileVersions?.[file] ?? "legacy", kind]),
					changeSetId: obligation.changeSetId,
					file,
					kind: kind.replace(/^failed:/, ""),
				})
			}
		}
	}
	if (debts.length === 0 && !decision.allowed)
		debts.push({ key: decision.blockerKey ?? `completion:${decision.message ?? "unresolved"}` })
	return debts
}

function matchesScope(debt: RepairDebt, scopes: readonly CompletionCheckScope[]): boolean {
	return scopes.some(
		(scope) =>
			scope.changeSetId === debt.changeSetId &&
			(!scope.matchedFiles || (debt.file !== undefined && scope.matchedFiles.includes(debt.file))) &&
			(!scope.kind || debt.kind === "supported_check" || debt.kind === scope.kind),
	)
}

/** Ephemeral accounting derived from durable debt; investigation never fabricates resolution. */
export class CompletionRecovery {
	private readonly allowances = new Map<string, RepairAllowance>()

	reset(): void {
		this.allowances.clear()
	}

	private synchronize(decision: CompletionDebtDecision): RepairAllowance[] {
		const debts = debtsFor(decision)
		const keys = new Set(debts.map((debt) => debt.key))
		const resolved: RepairAllowance[] = []
		for (const [key, allowance] of this.allowances) {
			if (!keys.has(key)) {
				resolved.push(allowance)
				this.allowances.delete(key)
			}
		}
		// Preserve existing unresolved allowances under cap pressure. New unrelated
		// debt cannot evict old keys and thereby manufacture a fresh repair budget.
		for (const debt of debts) {
			if (this.allowances.size >= 128) break
			if (!this.allowances.has(debt.key))
				this.allowances.set(debt.key, { ...debt, rejections: 0, unsuccessfulChecks: 0 })
		}
		return resolved
	}

	reject(decision: CompletionDebtDecision): boolean {
		this.synchronize(decision)
		for (const allowance of this.allowances.values()) allowance.rejections++
		return [...this.allowances.values()].some((allowance) => allowance.rejections >= 3)
	}

	recordCheck(decision: CompletionDebtDecision, scopes: readonly CompletionCheckScope[]): boolean {
		const resolved = this.synchronize(decision)
		// A check that resolves other covered debt is progress, never an unsuccessful
		// attempt against the remaining files. Novel reads use the normal exploration
		// detector and leave both completion counters untouched.
		if (decision.allowed || resolved.some((debt) => matchesScope(debt, scopes))) return false
		for (const allowance of this.allowances.values()) {
			if (matchesScope(allowance, scopes)) allowance.unsuccessfulChecks++
		}
		return [...this.allowances.values()].some((allowance) => allowance.unsuccessfulChecks >= 8)
	}
}
