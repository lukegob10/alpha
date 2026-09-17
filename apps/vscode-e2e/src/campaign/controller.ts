import { performance } from "node:perf_hooks"
import { validateScenarioResult } from "./resultValidation"
import { getPatchFailureReceipt, type PatchReceipt } from "./patchPlan"
import { CampaignStorageError } from "./types"

import type {
	AttemptPhase,
	CampaignAttempt,
	CampaignConfig,
	CampaignHost,
	CampaignOperations,
	CampaignReport,
	CampaignUsage,
	ScenarioRequest,
	ScenarioResult,
	StopReason,
} from "./types"

class CampaignStopped extends Error {
	constructor(readonly reason: StopReason) {
		super(reason)
	}
}

const emptyUsage = (): CampaignUsage => ({ requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 })
const unknownUsage = (): CampaignUsage => ({ requests: null, inputTokens: null, outputTokens: null, cost: null })
const sameFailure = (first: ScenarioResult, next: ScenarioResult): boolean =>
	Boolean(first.failure && next.failure) &&
	first.status === "failed" &&
	next.status === "failed" &&
	first.failure?.class === next.failure?.class &&
	first.failure?.fingerprint === next.failure?.fingerprint

/** Sequential by design: persistent-profile ownership and mutations must not overlap. */
export async function runCampaign(
	config: CampaignConfig,
	operations: CampaignOperations,
	signal?: AbortSignal,
	options: { reproduceFailures?: boolean } = {},
): Promise<CampaignReport> {
	if (options.reproduceFailures === false && config.repair) {
		throw new Error("Reviewed repairs require failure reproduction")
	}
	const now = operations.now ?? (() => performance.now())
	const wallTime = operations.wallTime ?? (() => new Date().toISOString())
	const started = now()
	const report: CampaignReport = {
		version: 1,
		id: config.id,
		mode: config.repair ? "reviewed-patch" : "report-only",
		requestedProvider: config.provider,
		startedAt: wallTime(),
		counts: { passed: 0, failed: 0, blocked: 0 },
		usage: emptyUsage(),
		attempts: [],
		repairs: [],
	}
	const checkpoint = () => operations.persistReport(structuredClone(report))
	const stop = (reason: StopReason): never => {
		throw new CampaignStopped(reason)
	}
	const checkBudget = () => {
		if (signal?.aborted) stop("cancelled")
		if (now() - started >= config.budgets.maxDurationMs) stop("time_budget")
		if (report.attempts.length >= config.budgets.maxIterations) stop("iteration_budget")
		if (report.usage.requests === null) stop("usage_unavailable")
		if (report.usage.requests! >= config.budgets.maxRequests) stop("request_budget")
	}
	const withDeadline = async <T>(operation: (innerSignal: AbortSignal) => Promise<T>): Promise<T> => {
		if (signal?.aborted) stop("cancelled")
		const timeout = Math.min(config.budgets.attemptTimeoutMs, config.budgets.maxDurationMs - (now() - started))
		if (timeout <= 0) stop("time_budget")
		const abort = new AbortController()
		const onAbort = () => abort.abort()
		signal?.addEventListener("abort", onAbort, { once: true })
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			abort.abort()
		}, timeout)
		try {
			// Implementations must settle after their owned-process cleanup, not on abort notification alone.
			const result = await operation(abort.signal)
			if (signal?.aborted) stop("cancelled")
			if (timedOut) stop("time_budget")
			return result
		} catch (error) {
			if (signal?.aborted) stop("cancelled")
			if (timedOut) stop("time_budget")
			throw error
		} finally {
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
		}
	}
	const attempt = async (
		host: CampaignHost,
		scenarioId: string,
		sample: number,
		phase: AttemptPhase,
	): Promise<ScenarioResult> => {
		checkBudget()
		const request: ScenarioRequest = {
			campaignId: config.id,
			attemptId: `attempt-${String(report.attempts.length + 1).padStart(4, "0")}`,
			host,
			scenarioId,
			sample,
			phase,
			provider: config.provider,
			requestLimit: config.budgets.maxRequests - report.usage.requests!,
		}
		const attemptStarted = now()
		let result: ScenarioResult
		let termination: StopReason | undefined
		try {
			result = validateScenarioResult(
				await withDeadline((innerSignal) => operations.runScenario(request, innerSignal)),
			)
		} catch (error) {
			termination = error instanceof CampaignStopped ? error.reason : "infrastructure"
			result = {
				status: "blocked",
				failure: { class: "infrastructure", fingerprint: termination },
				usage: unknownUsage(),
			}
		}
		const record: CampaignAttempt = { request, result, elapsedMs: Math.max(0, now() - attemptStarted) }
		report.attempts.push(record)
		report.counts[result.status]++
		for (const key of ["requests", "inputTokens", "outputTokens", "cost"] as const) {
			const value = result.usage[key]
			report.usage[key] = report.usage[key] === null || value === null ? null : report.usage[key]! + value
		}
		// Evidence is awaited even after cancellation. No next launch/repair can precede it.
		try {
			record.evidence = await operations.preserveEvidence(request, result)
		} catch {
			record.evidenceFailed = true
			termination ??= result.failure?.class === "authentication" ? "authentication" : "evidence_failed"
		}
		await checkpoint()
		if (termination) stop(termination)
		if (result.failure?.class === "authentication") stop("authentication")
		if (result.failure?.class === "usage_limit") stop("usage_limit")
		if (result.failure?.class === "unsafe_repair") stop("unsafe_repair")
		if (result.retentionFailed) stop("retention_failed")
		if (result.status === "blocked" && result.failure?.class === "infrastructure") {
			if (result.failure.fingerprint === "storage_budget") stop("storage_budget")
			if (result.failure.fingerprint === "scan_incomplete") stop("scan_incomplete")
			if (result.failure.fingerprint === "retention_failed") stop("retention_failed")
		}
		if (result.status === "blocked") stop("infrastructure")
		if (result.usage.requests === null) stop("usage_unavailable")
		if (result.usage.requests! > request.requestLimit) stop("request_budget")
		return result
	}

	await checkpoint()
	try {
		const hosts = [...config.hosts].sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
		for (const host of hosts) {
			for (let sample = 1; sample <= config.samples; sample++) {
				for (const scenarioId of config.scenarioIds) {
					const initial = await attempt(host, scenarioId, sample, "sample")
					if (initial.status === "passed" || options.reproduceFailures === false) continue
					let reproduced = false
					for (let retry = 0; retry < config.maxReproductions; retry++) {
						const reproduction = await attempt(host, scenarioId, sample, "reproduce")
						if (sameFailure(initial, reproduction)) {
							reproduced = true
							break
						}
					}
					if (!reproduced) stop("unreproduced")
					const repair = config.repair?.plans.find((plan) => plan.scenarioId === scenarioId)
					if (!repair) continue
					if (!operations.applyPatch || !operations.build) stop("unsafe_repair")
					const regression = await attempt(host, repair.regressionScenarioId, sample, "regression-before")
					if (regression.status !== "failed" || regression.failure?.class !== "assertion")
						stop("unreproduced")
					checkBudget()
					let receipt: PatchReceipt | undefined
					try {
						await withDeadline(async (innerSignal) => {
							try {
								receipt = await operations.applyPatch!(repair, innerSignal)
							} catch (error) {
								receipt = getPatchFailureReceipt(error)
								throw error
							}
						})
					} catch (error) {
						// A deadline arriving after publication must not erase a completed mutation receipt.
						if (receipt) {
							report.repairs.push({ diagnosisId: repair.diagnosisId, receipt, verified: false })
							await checkpoint()
						}
						if (error instanceof CampaignStorageError) {
							report.storageAdmission = error.receipt
							stop(error.code)
						}
						stop(error instanceof CampaignStopped ? error.reason : "unsafe_repair")
					}
					const repairRecord = { diagnosisId: repair.diagnosisId, receipt: receipt!, verified: false }
					report.repairs.push(repairRecord)
					await checkpoint()
					if (!(await withDeadline((innerSignal) => operations.build!(innerSignal)))) stop("build_failed")
					for (const check of [repair.regressionScenarioId, scenarioId]) {
						if ((await attempt(host, check, sample, "verify-fix")).status !== "passed")
							stop("verification_failed")
					}
					for (const neighbor of repair.neighborScenarioIds) {
						if ((await attempt(host, neighbor, sample, "neighbor")).status !== "passed")
							stop("verification_failed")
					}
					repairRecord.verified = true
					await checkpoint()
				}
			}
		}
		report.stopReason = "completed"
	} catch (error) {
		if (error instanceof CampaignStorageError) {
			report.storageAdmission = error.receipt
			report.stopReason = error.code
		} else report.stopReason = error instanceof CampaignStopped ? error.reason : "infrastructure"
	}
	report.finishedAt = wallTime()
	await checkpoint()
	if (operations.finalizeRetention) {
		try {
			report.retention = await operations.finalizeRetention(structuredClone(report))
		} catch {
			report.retention = { status: "failed" }
		}
		// The terminal checkpoint above is the eligibility barrier; this records secondary retention outcomes.
		await checkpoint()
	}
	return report
}
