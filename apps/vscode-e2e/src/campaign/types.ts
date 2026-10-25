import type { PatchPlan, PatchReceipt } from "./patchPlan"
import type { LiveProviderIdentityReceipt } from "../liveProviderIdentity"

export const HOST_VERSIONS = ["1.138.0"] as const
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

export const PERFORMANCE_METRICS = [
	"firstResponseMs",
	"firstUsefulResponseMs",
	"hostOverheadMs",
	"providerMs",
	"retryDelayMs",
	"toolsMs",
	"providerRetries",
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens",
] as const
export type CampaignPerformance = Partial<Record<(typeof PERFORMANCE_METRICS)[number], number | null>>
export type CampaignCollectionMode = "sample-only" | "sample-then-diagnose"
export type CampaignCounts = { passed: number; failed: number; blocked: number }
export interface CampaignSampling extends CampaignCounts {
	planned: number
	/** Original attempts with a terminal result, including blocked attempts. */
	completed: number
	notRun: number
	diagnosticAttempts: number
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
	providerIdentity?: LiveProviderIdentityReceipt
	/** Available observations only; absence or null never implies zero work. */
	performance?: CampaignPerformance
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
	/** Omitted legacy configurations collect original samples; repairs always reproduce synchronously. */
	collectionMode?: CampaignCollectionMode
	/** Identity of a decision plan declared before these attempts; absent means no predeclared decision claim. */
	decisionPlanDigest?: string
	decisionTimeWindow?: string
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
	startedAt?: string
	decisionPlanDigest?: string
	timeWindow?: string
}

export interface CampaignAttempt {
	request: ScenarioRequest
	result: ScenarioResult
	elapsedMs: number
	evidence?: string
	evidenceFailed?: true
	/** A late observed result can retain usage while remaining a non-passing terminal attempt. */
	termination?: "cancelled" | "timeout"
}

export interface CampaignEvaluationIdentity {
	extensionCommit: string | null
	workingTreeDigest: string | null
	extensionBuildDigest: string | null
	harnessDigest: string | null
	configDigest: string
	taskSetDigest: string | null
	sourceComponentsDigest: string | null
	unchanged: boolean
	missing: string[]
}

export interface CampaignReport {
	version: 1
	/** Projection of source/build receipts; absent in legacy reports, never inferred from fixture HEAD. */
	evaluationIdentity?: CampaignEvaluationIdentity
	evaluationPlan?: { scenarioIds: string[]; hostVersions: HostVersion[]; samples: number }
	id: string
	mode: "report-only" | "reviewed-patch"
	collectionMode?: CampaignCollectionMode | "reviewed-repair"
	requestedProvider: CampaignConfig["provider"]
	startedAt: string
	finishedAt?: string
	stopReason?: StopReason
	/** Legacy totals cover every phase; use sampling for original-trial outcomes. */
	counts: CampaignCounts
	/** Absent in historical reports; current checkpoints retain the complete original-trial denominator. */
	sampling?: CampaignSampling
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
