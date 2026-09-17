import type { PatchPlan, PatchReceipt } from "./patchPlan"

export const HOST_VERSIONS = ["1.122.1", "1.136.1"] as const
export type HostVersion = (typeof HOST_VERSIONS)[number]
export const FAILURE_CLASSES = [
	"provider",
	"tool",
	"persistence",
	"lifecycle",
	"assertion",
	"authentication",
	"usage_limit",
	"unsafe_repair",
	"infrastructure",
] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]
export type AttemptPhase = "sample" | "reproduce" | "regression-before" | "verify-fix" | "neighbor"
export type StopReason =
	| "completed"
	| "cancelled"
	| "time_budget"
	| "iteration_budget"
	| "request_budget"
	| "usage_unavailable"
	| "authentication"
	| "usage_limit"
	| "unsafe_repair"
	| "unreproduced"
	| "evidence_failed"
	| "build_failed"
	| "verification_failed"
	| "infrastructure"
	| "storage_budget"
	| "scan_incomplete"
	| "retention_failed"

export class CampaignStorageError extends Error {
	constructor(
		readonly code: "storage_budget" | "scan_incomplete",
		readonly receipt: string,
	) {
		super(code)
	}
}

export interface CampaignHost {
	version: HostVersion
	executable?: string
}

export interface CampaignUsage {
	requests: number | null
	inputTokens: number | null
	outputTokens: number | null
	cost: number | null
}

export interface ScenarioResult {
	status: "passed" | "failed" | "blocked"
	retentionFailed?: true
	failure?: { class: FailureClass; fingerprint: string }
	usage: CampaignUsage
	/** Verified by the host adapter, not inferred from the requested configuration. */
	actualHostVersion?: HostVersion
	model?: { id: string; effort?: string }
	taskIds?: string[]
}

export interface CampaignRepair {
	scenarioId: string
	regressionScenarioId: string
	neighborScenarioIds: string[]
	/** A reviewed diagnosis and patch are input, never model-selected shell authority. */
	diagnosisId: string
	patch: PatchPlan
}

export interface CampaignConfig {
	id: string
	hosts: CampaignHost[]
	scenarioIds: string[]
	samples: number
	provider: { mode: "scripted" | "live-copilot"; modelId?: string; effort?: string }
	budgets: { maxIterations: number; maxRequests: number; maxDurationMs: number; attemptTimeoutMs: number }
	maxReproductions: number
	storageBudget?: { maxBytes: number; maxEntries: number; maxDepth: number }
	/** Source repair is absent by default. Paths must be explicitly allowed by the user. */
	repair?: { enabled: true; sourceRoot: string; allowedPaths: string[]; plans: CampaignRepair[] }
}

export interface ScenarioRequest {
	campaignId: string
	attemptId: string
	host: CampaignHost
	scenarioId: string
	sample: number
	phase: AttemptPhase
	provider: CampaignConfig["provider"]
	/** The host must enforce this before every provider request, including retries. */
	requestLimit: number
}

export interface CampaignAttempt {
	request: ScenarioRequest
	result: ScenarioResult
	elapsedMs: number
	evidence?: string
	evidenceFailed?: true
}

export interface CampaignReport {
	version: 1
	id: string
	mode: "report-only" | "reviewed-patch"
	requestedProvider: CampaignConfig["provider"]
	startedAt: string
	finishedAt?: string
	stopReason?: StopReason
	counts: { passed: number; failed: number; blocked: number }
	usage: CampaignUsage
	attempts: CampaignAttempt[]
	repairs: { diagnosisId: string; receipt: PatchReceipt; verified: boolean }[]
	storageAdmission?: string
	retention?: { status: "complete" | "blocked" | "failed"; receipt?: string }
}

export interface CampaignOperations {
	runScenario(request: ScenarioRequest, signal: AbortSignal): Promise<ScenarioResult>
	/** Retain evidence before any restart or source mutation; return a relative manifest path. */
	preserveEvidence(request: ScenarioRequest, result: ScenarioResult): Promise<string>
	/** Write an immutable checkpoint or atomically replace only this campaign's owned report. */
	persistReport(report: CampaignReport): Promise<void>
	/** Runs only after the terminal report is durable. Current campaign evidence remains pinned. */
	finalizeRetention?(report: CampaignReport): Promise<NonNullable<CampaignReport["retention"]>>
	applyPatch?(repair: CampaignRepair, signal: AbortSignal): Promise<PatchReceipt>
	build?(signal: AbortSignal): Promise<boolean>
	/** Monotonic clock; injectable for race and budget tests. */
	now?: () => number
	wallTime?: () => string
}
