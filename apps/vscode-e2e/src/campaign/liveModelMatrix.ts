import { campaignConfigDigest } from "./config"
import { createDevelopmentSuite, type DevelopmentSuiteOptions } from "./developmentSuites"
import { finishCampaignEvaluationIdentity } from "./evaluationIdentity"
import { assertLiveGateConfig, evaluateLiveGate } from "./liveGate"
import type { CampaignConfig, CampaignEvaluationIdentity, CampaignReport } from "./types"

export const LIVE_MODEL_MATRIX_HOST = "1.138.0" as const
export const LIVE_MODEL_MATRIX_MODELS = Object.freeze([
	Object.freeze({ key: "luna", modelId: "gpt-6-luna", effort: "max" }),
	Object.freeze({ key: "haiku", modelId: "claude-haiku-5.5", effort: "high" }),
	Object.freeze({ key: "grok", modelId: "grok-4.6", effort: "low" }),
])

export type LiveModelMatrixOptions = Omit<DevelopmentSuiteOptions, "provider" | "modelId" | "effort" | "collectionMode">

export interface LiveModelMatrixPlan {
	id: string
	hostVersion: typeof LIVE_MODEL_MATRIX_HOST
	campaigns: CampaignConfig[]
}

/** A runner exit alone cannot establish live acceptance. Retain its canonical report and artifact verdict. */
export interface CampaignExecutionResult {
	exitCode: number
	report?: CampaignReport
	resultPath?: string
	artifactsUnchanged?: boolean
}

interface LiveModelMatrixEntry {
	campaignId: string
	modelId: string
	effort: string
	status: "not-run" | "running" | "passed" | "failed" | "blocked"
	exitCode?: number
	reason?: "execution_failed" | "conditions_changed" | "acceptance_failed"
	resultPath?: string
	verdict?: ReturnType<typeof evaluateLiveGate>
}

export interface LiveModelMatrixReport {
	schemaVersion: 1
	kind: "alpha-live-model-matrix"
	id: string
	hostVersion: typeof LIVE_MODEL_MATRIX_HOST
	status: "running" | "passed" | "failed" | "blocked" | "cancelled"
	maxRequests: number
	counts: { passed: number; failed: number; blocked: number; notRun: number }
	entries: LiveModelMatrixEntry[]
}

export function createLiveModelMatrix(options: LiveModelMatrixOptions): LiveModelMatrixPlan {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/.test(options.id)) throw new Error("Invalid live matrix identifier")
	if (options.host && options.host.version !== LIVE_MODEL_MATRIX_HOST)
		throw new Error("Live model matrices require exact VS Code 1.138.0")
	const plan: LiveModelMatrixPlan = {
		id: options.id,
		hostVersion: LIVE_MODEL_MATRIX_HOST,
		campaigns: LIVE_MODEL_MATRIX_MODELS.map(({ key, modelId, effort }) =>
			createDevelopmentSuite({
				...options,
				id: `${options.id}-${key}`,
				provider: "live-copilot",
				modelId,
				effort,
				collectionMode: "sample-only",
				host: { ...options.host, version: LIVE_MODEL_MATRIX_HOST },
			}),
		),
	}
	assertLiveModelMatrix(plan)
	return plan
}

function assertLiveModelMatrix(plan: LiveModelMatrixPlan): void {
	if (plan.hostVersion !== LIVE_MODEL_MATRIX_HOST || plan.campaigns.length !== LIVE_MODEL_MATRIX_MODELS.length)
		throw new Error("Invalid live model matrix")
	const workload = campaignConfigDigest(plan.campaigns[0]!)
	for (const [index, config] of plan.campaigns.entries()) {
		const expected = LIVE_MODEL_MATRIX_MODELS[index]!
		assertLiveGateConfig(config)
		if (
			config.id !== `${plan.id}-${expected.key}` ||
			config.provider.modelId !== expected.modelId ||
			config.provider.effort !== expected.effort ||
			config.hosts.length !== 1 ||
			config.hosts[0]!.version !== LIVE_MODEL_MATRIX_HOST ||
			campaignConfigDigest(config) !== workload
		)
			throw new Error("Live matrix requires the fixed model order, exact host and identical workloads")
	}
}

/** Coordinates existing single-model campaigns; it never executes agent turns or retries failed samples. */
export async function runLiveModelMatrix(
	input: LiveModelMatrixPlan,
	operations: {
		run(config: CampaignConfig, signal?: AbortSignal): Promise<CampaignExecutionResult>
		persist(report: LiveModelMatrixReport): Promise<void>
	},
	signal?: AbortSignal,
): Promise<LiveModelMatrixReport> {
	const plan = structuredClone(input)
	assertLiveModelMatrix(plan)
	const report: LiveModelMatrixReport = {
		schemaVersion: 1,
		kind: "alpha-live-model-matrix",
		id: plan.id,
		hostVersion: LIVE_MODEL_MATRIX_HOST,
		status: "running",
		maxRequests: plan.campaigns.reduce((sum, config) => sum + config.budgets.maxRequests, 0),
		counts: { passed: 0, failed: 0, blocked: 0, notRun: plan.campaigns.length },
		entries: plan.campaigns.map((config) => ({
			campaignId: config.id,
			modelId: config.provider.modelId!,
			effort: config.provider.effort!,
			status: "not-run",
		})),
	}
	const checkpoint = async () => {
		report.counts = {
			passed: report.entries.filter((entry) => entry.status === "passed").length,
			failed: report.entries.filter((entry) => entry.status === "failed").length,
			blocked: report.entries.filter((entry) => entry.status === "blocked").length,
			notRun: report.entries.filter((entry) => entry.status === "not-run").length,
		}
		await operations.persist(structuredClone(report))
	}
	let identity: CampaignEvaluationIdentity | undefined
	let provider: CampaignReport["attempts"][number]["result"]["providerIdentity"]
	await checkpoint()
	for (const [index, config] of plan.campaigns.entries()) {
		if (signal?.aborted) break
		const entry = report.entries[index]!
		entry.status = "running"
		await checkpoint()
		let result: CampaignExecutionResult
		try {
			result = await operations.run(structuredClone(config), signal)
		} catch {
			// An unexpected executor failure cannot prove that the previous host released its resources.
			entry.status = "blocked"
			entry.reason = "execution_failed"
			await checkpoint()
			break
		}
		entry.exitCode = result.exitCode
		entry.resultPath = result.resultPath
		const campaign = result.report
		if (campaign) entry.verdict = evaluateLiveGate(config, campaign)
		const observedProvider = campaign?.attempts[0]?.result.providerIdentity
		const conditionsChanged =
			result.artifactsUnchanged === false ||
			campaign?.evaluationIdentity?.unchanged === false ||
			(identity !== undefined &&
				(!campaign?.evaluationIdentity ||
					!finishCampaignEvaluationIdentity(identity, campaign.evaluationIdentity).unchanged)) ||
			(provider !== undefined &&
				observedProvider !== undefined &&
				(provider.before.version !== observedProvider.before.version ||
					provider.before.entrypointSha256 !== observedProvider.before.entrypointSha256))
		entry.status =
			result.exitCode === 0 && result.artifactsUnchanged === true && entry.verdict?.status === "passed"
				? "passed"
				: result.exitCode === 2 || !campaign
					? "blocked"
					: "failed"
		if (entry.status !== "passed") entry.reason = "acceptance_failed"
		if (conditionsChanged) {
			entry.status = "blocked"
			entry.reason = "conditions_changed"
		}
		identity ??= campaign?.evaluationIdentity
		provider ??= observedProvider
		await checkpoint()
		if (conditionsChanged) break
	}
	report.status = signal?.aborted
		? "cancelled"
		: report.entries.every((entry) => entry.status === "passed")
			? "passed"
			: report.counts.failed > 0
				? "failed"
				: "blocked"
	await checkpoint()
	return report
}
