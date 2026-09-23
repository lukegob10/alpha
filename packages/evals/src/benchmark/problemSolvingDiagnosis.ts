import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
	problemSolvingDiagnosticFailureCategories,
	problemSolvingDiagnosticFailureCodes,
	problemSolvingFailureClasses,
	type ProblemSolvingDiagnosticFailureCategory,
	type ProblemSolvingDiagnosticFailureCode,
	type ProblemSolvingFailureClass,
} from "./problemSolvingCampaign"
import { loadProblemSolvingSet, type ProblemSolvingTask } from "./problemSolving"

type JsonRecord = Record<string, unknown>
type Outcome = "passed" | "failed" | "blocked" | "cancelled" | "unknown"
type ExecutionState = "started" | "preflight_blocked" | "unknown"
type ExecutionStartEvidence =
	| "request_receipt"
	| "model_request_event"
	| "tool_or_result_event"
	| "verification_event"
	| "turn_or_task_event"
	| "verified_pass"
	| "preflight_blocked"
	| "unknown"
type GraderDecision = "passed" | "outcome_failed" | "safety_failed" | "grader_error"

const MODEL_EXECUTION_EVENT_TYPES = new Set(["model_request_started", "request_usage"])
const TOOL_EXECUTION_EVENT_TYPES = new Set([
	"tool_call_accepted",
	"tool_result_recorded",
	"tool_result",
	"tool_batch_started",
	"tool_batch_finished",
	"approval_request",
	"approval_result",
])
const VERIFICATION_EXECUTION_EVENT_TYPES = new Set(["verification_result"])
const TURN_EXECUTION_EVENT_TYPES = new Set([
	"turn_started",
	"step_started",
	"assistant_committed",
	"response_terminal",
	"turn_completed",
	"task_completed",
	"turn_failed",
	"task_failed",
	"turn_incomplete",
	"task_incomplete",
])

export interface ProblemSolvingAttemptDiagnosis {
	taskId: string
	source: string | null
	lane: string | null
	tags: string[]
	status: Outcome
	executionState: ExecutionState
	executionStartEvidence: ExecutionStartEvidence
	countsAsSolving: boolean
	graderDecision: string | null
	failureClass: ProblemSolvingFailureClass | null
	failureCategory: ProblemSolvingDiagnosticFailureCategory | null
	failureCode: ProblemSolvingDiagnosticFailureCode | null
	usage: { requests: number | null; inputTokens: number | null; outputTokens: number | null; cost: number | null }
	evidence: {
		capture: "complete" | "incomplete" | "missing"
		lifecycleValidation: string
		eventLogValidation: string
		joinStatus: string
		eventCount: number
		extensionBundleSha256: string | null
		policyDigestSha256s: string[]
		usageMatchesTrace: boolean | null
		categorizedToolResults: number
		toolResults: number
	}
	trace: {
		eventCounts: Record<string, number>
		toolResultsByCategory: Record<string, number>
		toolResultsByStatus: Record<string, number>
		approvalDecisions: Record<string, number>
		retries: number
		compactions: number
		contextRefreshes: number
		verificationResults: number
		batchDurationsMs: number[]
		parallelTools: number[]
	}
}

export interface ProblemSolvingDiagnosis {
	schemaVersion: 1
	reportKind: "alpha-problem-solving-diagnosis"
	generatedAt: string
	run: {
		runId: string | null
		startedAt: string | null
		completedAt: string | null
		hostVersion: string | null
		modelId: string | null
		effort: string | null
		buildIdentity: string | null
		workingTreeClean: boolean | null
		workingTreeDigest: string | null
		taskSetSha256: string | null
		expectedExtensionBundleSha256: string | null
		attemptCount: number
		plannedTaskIds: string[]
		plannedRepetitions: number | null
		taskExecutionStartedAttemptCount: number
		preExecutionBlockedAttemptCount: number
		executionStartUnknownAttemptCount: number
		plannedAttemptCount: number | null
		pendingExecutionCount: number | null
		campaignComplete: boolean | null
		stopSignal: string | null
		notAttemptedTaskIds: string[]
	}
	extensionArtifact: {
		observedBundleSha256s: string[]
		missingStartedAttemptDigests: number
		mismatchedStartedAttemptDigests: number
		matchesExpected: boolean | null
	}
	policyArtifacts: {
		policySnapshotEventCount: number
		observedPolicyDigestSha256s: string[]
		startedAttemptsWithoutPolicyDigest: number
		attemptsWithMultiplePolicyDigests: number
	}
	outcomes: {
		passed: number
		failed: number
		blocked: number
		cancelled: number
		unknown: number
		scoredAttempts: number
		passRate: number | null
		wilson95: { lower: number; upper: number } | null
	}
	usage: {
		requests: { count: number; median: number | null; p95: number | null }
		inputTokens: { count: number; median: number | null; p95: number | null }
		outputTokens: { count: number; median: number | null; p95: number | null }
		knownCostAttempts: number
		unknownCostAttempts: number
	}
	coverage: {
		sources: Record<string, number>
		lanes: Record<string, number>
		tags: Record<string, number>
		candidateGaps: Array<{ area: string; tags: string[]; matchingTasks: string[] }>
	}
	failureReasons: Record<string, number>
	evidence: {
		completeCaptures: number
		incompleteCaptures: number
		missingCaptures: number
		validatedLifecycleTraces: number
		validatedEventTraces: number
		capturedJoins: number
		incompleteJoins: number
		missingJoins: number
		categorizedToolResultCoverage: number | null
		usageTraceMatches: number
		usageTraceMismatches: number
		usageTraceUnavailable: number
		eventCounts: Record<string, number>
		toolResultsByCategory: Record<string, number>
		toolResultsByStatus: Record<string, number>
		approvalDecisions: Record<string, number>
		retries: number
		compactions: number
		contextRefreshes: number
		verificationResults: number
		batchDurationMs: { count: number; median: number | null; p95: number | null }
		parallelTools: { count: number; median: number | null; p95: number | null }
	}
	attempts: ProblemSolvingAttemptDiagnosis[]
	hypotheses: Array<{ priority: "high" | "medium" | "low"; finding: string; evidence: string; nextCheck: string }>
	limitations: string[]
}

function record(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

function countInto(counts: Record<string, number>, key: unknown): void {
	if (typeof key === "string" && key.length > 0) counts[key] = (counts[key] ?? 0) + 1
}

function numeric(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function safeSha256(value: unknown): string | null {
	return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null
}

function percentile(values: number[], fraction: number): number | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((left, right) => left - right)
	const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1)
	return sorted[index] ?? null
}

function summarize(values: Array<number | null>) {
	const known = values.filter((value): value is number => value !== null)
	return { count: known.length, median: percentile(known, 0.5), p95: percentile(known, 0.95) }
}

function wilson95(passed: number, total: number): { lower: number; upper: number } | null {
	if (total <= 0) return null
	const z = 1.959963984540054
	const rate = passed / total
	const denominator = 1 + (z * z) / total
	const center = (rate + (z * z) / (2 * total)) / denominator
	const margin = (z * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total))) / denominator
	return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) }
}

function attemptOutcome(value: JsonRecord, profileBusy: boolean): Outcome {
	if (profileBusy) return "blocked"
	if (value.countsAsSolving === true) return "passed"
	if (value.status === "blocked") return "blocked"
	if (value.status === "cancelled") return "cancelled"
	if (value.status === "failed") return "failed"
	return "unknown"
}

function aggregateCounts(
	attempts: ProblemSolvingAttemptDiagnosis[],
	pick: (attempt: ProblemSolvingAttemptDiagnosis) => Record<string, number>,
) {
	const result: Record<string, number> = {}
	for (const attempt of attempts) {
		for (const [key, value] of Object.entries(pick(attempt))) result[key] = (result[key] ?? 0) + value
	}
	return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)))
}

function countStatuses(attempts: ProblemSolvingAttemptDiagnosis[], expected: string): number {
	return attempts.filter(
		(attempt) => attempt.evidence[expected as keyof ProblemSolvingAttemptDiagnosis["evidence"]] === "validated",
	).length
}

function candidateCoverageGaps(
	tasks: readonly ProblemSolvingTask[],
): ProblemSolvingDiagnosis["coverage"]["candidateGaps"] {
	const areas = [
		{ area: "Git branch, commit, and worktree operations", tags: ["worktree", "branch", "commit", "git-branch"] },
		{
			area: "GitHub issue and live pull request workflows",
			tags: ["github", "issue", "pull-request", "github-actions"],
		},
		{
			area: "Concurrent and stale workspace edits",
			tags: ["concurrent-edit", "stale-content", "conflict-resolution"],
		},
		{ area: "Agent delegation and result integration", tags: ["delegation", "subagent", "parallel-agent"] },
	]
	return areas.map(({ area, tags }) => ({
		area,
		tags,
		matchingTasks: tasks.filter((task) => task.tags.some((tag) => tags.includes(tag))).map(({ id }) => id),
	}))
}

async function readJson(filePath: string): Promise<JsonRecord | undefined> {
	try {
		return record(JSON.parse(await fs.readFile(filePath, "utf8")))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw new Error(`Cannot read campaign evidence JSON (${path.basename(filePath)})`)
	}
}

async function readProjectedFile(directory: string, suffix: string): Promise<JsonRecord | undefined> {
	let entries: import("node:fs").Dirent[]
	try {
		entries = await fs.readdir(directory, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
	const candidate = entries.find((entry) => entry.isFile() && entry.name.endsWith(suffix))
	return candidate ? readJson(path.join(directory, candidate.name)) : undefined
}

function safeFailureCategory(value: unknown): ProblemSolvingDiagnosticFailureCategory | null {
	return problemSolvingDiagnosticFailureCategories.find((category) => category === value) ?? null
}

function safeFailureCode(value: unknown): ProblemSolvingDiagnosticFailureCode | null {
	return problemSolvingDiagnosticFailureCodes.find((code) => code === value) ?? null
}

function safeRunnerFailureCategory(value: unknown): ProblemSolvingDiagnosticFailureCategory | null {
	if (value === "profile-busy") return "runner"
	if (typeof value !== "string") return null
	if (/timeout|deadline/i.test(value)) return "timeout"
	if (/request.*limit|limit.*request/i.test(value)) return "provider"
	return null
}

function safeRunnerFailureCode(value: unknown): ProblemSolvingDiagnosticFailureCode | null {
	if (typeof value !== "string" || value.length === 0) return null
	if (value === "profile-busy") return "profile_busy"
	const exact = safeFailureCode(value)
	if (exact) return exact
	if (/timeout|deadline/i.test(value)) return "runner_timeout"
	if (/request.*limit|limit.*request/i.test(value)) return "runner_request_limit"
	return "runner_failure"
}

function isCommandGateFailure(attempt: ProblemSolvingAttemptDiagnosis): boolean {
	return (
		attempt.status === "failed" &&
		attempt.failureClass === "infrastructure" &&
		attempt.failureCategory === "policy" &&
		attempt.failureCode?.startsWith("unexpected_command") === true
	)
}

async function diagnoseAttempt(
	root: string,
	value: unknown,
	tasks: Map<string, ProblemSolvingTask>,
): Promise<ProblemSolvingAttemptDiagnosis> {
	const attempt = record(value) ?? {}
	const requestedTaskId = typeof attempt.taskId === "string" ? attempt.taskId : ""
	const task = tasks.get(requestedTaskId)
	const taskId = task?.id ?? "unknown-task"
	const attemptId =
		typeof attempt.attemptId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(attempt.attemptId)
			? attempt.attemptId
			: "invalid-attempt"
	const artifactDirectory = path.join(root, attemptId, "artifacts", attemptId)
	const [evidenceManifest, turnProjection, lifecycleProjection, joinProjection, workflowReceipt, runnerReceipt] =
		await Promise.all([
			readJson(path.join(artifactDirectory, "manifest.json")),
			readProjectedFile(artifactDirectory, "agent_turn_events.jsonl.projection.json"),
			readProjectedFile(artifactDirectory, "agent_lifecycle_events.jsonl.projection.json"),
			readProjectedFile(artifactDirectory, "evidence-join.json"),
			readJson(path.join(artifactDirectory, "workflow-result.json")),
			readJson(path.join(artifactDirectory, "run-result.json")),
		])
	const turnData = record(turnProjection?.projection)
	const lifecycleData = record(lifecycleProjection?.projection)
	const events = Array.isArray(turnData?.events) ? (turnData.events.map(record).filter(Boolean) as JsonRecord[]) : []
	const eventCounts: Record<string, number> = {}
	const toolResultsByCategory: Record<string, number> = {}
	const policyDigestSha256s = new Set<string>()
	const toolResultsByStatus: Record<string, number> = {}
	const approvalDecisions: Record<string, number> = {}
	const batchDurationsMs: number[] = []
	const parallelTools: number[] = []
	let toolResults = 0
	let categorizedToolResults = 0
	let retries = 0
	let compactions = 0
	let contextRefreshes = 0
	let verificationResults = 0
	let eventInputTokens = 0
	let eventOutputTokens = 0
	let eventUsageRecords = 0
	for (const event of events) {
		countInto(eventCounts, event.type)
		if (event.type === "policy_snapshot") {
			const policyDigest = safeSha256(event.policyDigestSha256)
			if (policyDigest) policyDigestSha256s.add(policyDigest)
		}
		if (event.type === "tool_result") {
			toolResults++
			if (typeof event.toolCategory === "string") {
				categorizedToolResults++
				countInto(toolResultsByCategory, event.toolCategory)
			}
			countInto(toolResultsByStatus, event.status)
		}
		if (event.type === "approval_result") countInto(approvalDecisions, event.decision)
		if (event.type === "retry") retries++
		if (event.type === "compaction_completed") compactions++
		if (event.type === "context_refreshed") contextRefreshes++
		if (event.type === "verification_result") verificationResults++
		if (event.type === "tool_batch_finished") {
			const duration = numeric(event.durationMs)
			const parallel = numeric(event.parallelToolCount)
			if (duration !== null) batchDurationsMs.push(duration)
			if (parallel !== null) parallelTools.push(parallel)
		}
		if (event.type === "request_usage") {
			const input = numeric(event.inputTokens)
			const output = numeric(event.outputTokens)
			if (input !== null && output !== null) {
				eventInputTokens += input
				eventOutputTokens += output
				eventUsageRecords++
			}
		}
	}
	const usage = record(attempt.usage)
	const requestCount = numeric(usage?.requests)
	const inputTokens = numeric(usage?.inputTokens)
	const outputTokens = numeric(usage?.outputTokens)
	const usageMatchesTrace =
		inputTokens !== null && outputTokens !== null && eventUsageRecords > 0
			? inputTokens === eventInputTokens && outputTokens === eventOutputTokens
			: null
	const lifecycleValidation =
		typeof lifecycleData?.validationStatus === "string" ? lifecycleData.validationStatus : "missing"
	const eventLogValidation = typeof turnData?.validationStatus === "string" ? turnData.validationStatus : "missing"
	const capture =
		evidenceManifest?.captureComplete === true ? "complete" : evidenceManifest ? "incomplete" : "missing"
	const workflowFailure = record(workflowReceipt?.failure)
	const runnerFailure = runnerReceipt?.failure === "profile-busy" ? runnerReceipt.failure : null
	const profileBusy = runnerFailure === "profile-busy"
	const failureCategory =
		safeFailureCategory(workflowFailure?.category) ??
		safeFailureCategory(attempt.failureCategory) ??
		safeRunnerFailureCategory(runnerReceipt?.failure)
	const failureCode =
		safeFailureCode(workflowFailure?.code) ??
		safeRunnerFailureCode(runnerReceipt?.failure) ??
		safeFailureCode(attempt.failureCode)
	const failureClass = profileBusy
		? "profile_busy"
		: (problemSolvingFailureClasses.find((value) => value === attempt.failureClass) ?? null)
	const graderDecision = (["passed", "outcome_failed", "safety_failed", "grader_error"] as const).find(
		(value): value is GraderDecision => value === attempt.graderDecision,
	)
	const eventTypes = new Set(events.flatMap((event) => (typeof event.type === "string" ? [event.type] : [])))
	const executionStartEvidence: ExecutionStartEvidence = profileBusy
		? "preflight_blocked"
		: requestCount !== null && requestCount > 0
			? "request_receipt"
			: [...MODEL_EXECUTION_EVENT_TYPES].some((type) => eventTypes.has(type))
				? "model_request_event"
				: [...TOOL_EXECUTION_EVENT_TYPES].some((type) => eventTypes.has(type))
					? "tool_or_result_event"
					: [...VERIFICATION_EXECUTION_EVENT_TYPES].some((type) => eventTypes.has(type))
						? "verification_event"
						: [...TURN_EXECUTION_EVENT_TYPES].some((type) => eventTypes.has(type))
							? "turn_or_task_event"
							: attempt.countsAsSolving === true
								? "verified_pass"
								: "unknown"
	const executionState: ExecutionState =
		executionStartEvidence === "preflight_blocked"
			? "preflight_blocked"
			: executionStartEvidence === "unknown"
				? "unknown"
				: "started"
	return {
		taskId,
		source: task?.source ?? null,
		lane: task?.lane ?? (typeof attempt.lane === "string" ? attempt.lane : null),
		tags: task?.tags ?? [],
		status: attemptOutcome(attempt, profileBusy),
		executionState,
		executionStartEvidence,
		countsAsSolving: attempt.countsAsSolving === true,
		graderDecision: graderDecision ?? null,
		failureClass,
		failureCategory,
		failureCode,
		usage: {
			requests: requestCount,
			inputTokens,
			outputTokens,
			cost: numeric(usage?.cost),
		},
		evidence: {
			capture,
			lifecycleValidation,
			eventLogValidation,
			joinStatus: typeof joinProjection?.status === "string" ? joinProjection.status : "missing",
			eventCount: events.length,
			extensionBundleSha256: safeSha256(evidenceManifest?.bundleSha256),
			policyDigestSha256s: [...policyDigestSha256s].sort(),
			usageMatchesTrace,
			categorizedToolResults,
			toolResults,
		},
		trace: {
			eventCounts: Object.fromEntries(
				Object.entries(eventCounts).sort(([left], [right]) => left.localeCompare(right)),
			),
			toolResultsByCategory: Object.fromEntries(
				Object.entries(toolResultsByCategory).sort(([left], [right]) => left.localeCompare(right)),
			),
			toolResultsByStatus: Object.fromEntries(
				Object.entries(toolResultsByStatus).sort(([left], [right]) => left.localeCompare(right)),
			),
			approvalDecisions: Object.fromEntries(
				Object.entries(approvalDecisions).sort(([left], [right]) => left.localeCompare(right)),
			),
			retries,
			compactions,
			contextRefreshes,
			verificationResults,
			batchDurationsMs,
			parallelTools,
		},
	}
}

export async function diagnoseProblemSolvingCampaign(input: {
	reportPath: string
	evalRoot: string
	now?: Date
}): Promise<ProblemSolvingDiagnosis> {
	const reportPath = path.resolve(input.reportPath)
	const runRoot = path.dirname(reportPath)
	const campaign = await readJson(reportPath)
	if (!campaign || !Array.isArray(campaign.attempts))
		throw new Error("Campaign report must contain an attempts array")
	const manifest = await loadProblemSolvingSet(path.resolve(input.evalRoot))
	const taskMap = new Map(manifest.tasks.map((task) => [task.id, task]))
	const attempts = await Promise.all(campaign.attempts.map((attempt) => diagnoseAttempt(runRoot, attempt, taskMap)))
	const selection = record(campaign.selection)
	const selectedTaskCount = numeric(selection?.selected)
	const repetitions = numeric(selection?.repetitions)
	const plannedRepetitions = repetitions !== null && Number.isSafeInteger(repetitions) ? repetitions : null
	const plannedAttemptCount =
		selectedTaskCount !== null &&
		plannedRepetitions !== null &&
		Number.isSafeInteger(selectedTaskCount * plannedRepetitions)
			? selectedTaskCount * plannedRepetitions
			: null
	const selectedTaskIds = Array.isArray(selection?.taskIds)
		? selection.taskIds.filter((taskId): taskId is string => typeof taskId === "string" && taskMap.has(taskId))
		: []
	const executionAttempts = attempts.filter((attempt) => attempt.executionState === "started")
	const taskExecutionStartedAttemptCount = executionAttempts.length
	const preExecutionBlockedAttemptCount = attempts.filter(
		(attempt) => attempt.executionState === "preflight_blocked",
	).length
	const executionStartUnknownAttemptCount = attempts.filter((attempt) => attempt.executionState === "unknown").length
	const pendingExecutionCount =
		plannedAttemptCount === null ? null : Math.max(0, plannedAttemptCount - taskExecutionStartedAttemptCount)
	const expectedExtensionBundleSha256 = safeSha256(campaign.extensionBundleSha256)
	const taskSetSha256 = safeSha256(campaign.taskSetSha256)
	const observedExtensionBundleSha256s = [
		...new Set(
			executionAttempts
				.map((attempt) => attempt.evidence.extensionBundleSha256)
				.filter((value): value is string => value !== null),
		),
	].sort()
	const missingStartedAttemptDigests = executionAttempts.filter(
		(attempt) => attempt.evidence.extensionBundleSha256 === null,
	).length
	const mismatchedStartedAttemptDigests = expectedExtensionBundleSha256
		? executionAttempts.filter(
				(attempt) =>
					attempt.evidence.extensionBundleSha256 !== null &&
					attempt.evidence.extensionBundleSha256 !== expectedExtensionBundleSha256,
			).length
		: 0
	const bundleDigestMatchesExpected =
		expectedExtensionBundleSha256 === null || executionAttempts.length === 0
			? null
			: mismatchedStartedAttemptDigests > 0
				? false
				: missingStartedAttemptDigests > 0
					? null
					: true
	const observedPolicyDigestSha256s = [
		...new Set(executionAttempts.flatMap((attempt) => attempt.evidence.policyDigestSha256s)),
	].sort()
	const startedAttemptsWithoutPolicyDigest = executionAttempts.filter(
		(attempt) => attempt.evidence.policyDigestSha256s.length === 0,
	).length
	const attemptsWithMultiplePolicyDigests = executionAttempts.filter(
		(attempt) => attempt.evidence.policyDigestSha256s.length > 1,
	).length
	const policySnapshotEventCount = attempts.reduce(
		(sum, attempt) => sum + (attempt.trace.eventCounts.policy_snapshot ?? 0),
		0,
	)
	const executionsByTask = new Map<string, number>()
	for (const attempt of executionAttempts) {
		executionsByTask.set(attempt.taskId, (executionsByTask.get(attempt.taskId) ?? 0) + 1)
	}
	const notAttemptedTaskIds = selectedTaskIds.filter(
		(taskId) => (executionsByTask.get(taskId) ?? 0) < (plannedRepetitions ?? 1),
	)
	const campaignComplete =
		plannedAttemptCount === null
			? null
			: attempts.length === plannedAttemptCount && taskExecutionStartedAttemptCount === plannedAttemptCount
	const finalAttempt = attempts.at(-1)
	const stopSignal =
		campaignComplete === false && finalAttempt
			? `${finalAttempt.failureClass ?? "unknown"}/${finalAttempt.failureCategory ?? "unknown"}/${finalAttempt.failureCode ?? "unknown"}`
			: null
	const statuses: Record<Outcome, number> = { passed: 0, failed: 0, blocked: 0, cancelled: 0, unknown: 0 }
	for (const attempt of attempts) statuses[attempt.status]++
	const scoredAttempts = attempts.filter(
		({ status, graderDecision }) =>
			status === "passed" ||
			(status === "failed" && (graderDecision === "outcome_failed" || graderDecision === "safety_failed")),
	).length
	const failureReasons: Record<string, number> = {}
	for (const attempt of attempts) {
		if (attempt.status === "passed") continue
		countInto(
			failureReasons,
			`${attempt.failureClass ?? "unknown"}/${attempt.failureCategory ?? "unknown"}/${attempt.failureCode ?? "unknown"}`,
		)
	}
	const sources: Record<string, number> = {}
	const lanes: Record<string, number> = {}
	const tags: Record<string, number> = {}
	for (const attempt of executionAttempts) {
		countInto(sources, attempt.source ?? "unmapped")
		countInto(lanes, attempt.lane ?? "unmapped")
		for (const tag of attempt.tags) countInto(tags, tag)
	}
	const requestStats = summarize(attempts.map(({ usage }) => usage.requests))
	const inputStats = summarize(attempts.map(({ usage }) => usage.inputTokens))
	const outputStats = summarize(attempts.map(({ usage }) => usage.outputTokens))
	const allToolResults = attempts.reduce((sum, attempt) => sum + attempt.evidence.toolResults, 0)
	const categorizedToolResults = attempts.reduce((sum, attempt) => sum + attempt.evidence.categorizedToolResults, 0)
	const joins = attempts.filter((attempt) => attempt.evidence.joinStatus === "captured").length
	const incompleteJoins = attempts.filter((attempt) => attempt.evidence.joinStatus === "incomplete").length
	const missingJoins = attempts.filter(
		(attempt) => attempt.evidence.joinStatus !== "captured" && attempt.evidence.joinStatus !== "incomplete",
	).length
	const usageMatches = attempts.filter((attempt) => attempt.evidence.usageMatchesTrace === true).length
	const usageMismatches = attempts.filter((attempt) => attempt.evidence.usageMatchesTrace === false).length
	const usageUnavailable = attempts.length - usageMatches - usageMismatches
	const eventCounts = aggregateCounts(attempts, ({ trace }) => trace.eventCounts)
	const toolResultsByCategory = aggregateCounts(attempts, ({ trace }) => trace.toolResultsByCategory)
	const toolResultsByStatus = aggregateCounts(attempts, ({ trace }) => trace.toolResultsByStatus)
	const approvalDecisions = aggregateCounts(attempts, ({ trace }) => trace.approvalDecisions)
	const batchDurations = attempts.flatMap(({ trace }) => trace.batchDurationsMs)
	const parallelCounts = attempts.flatMap(({ trace }) => trace.parallelTools)
	const attemptsWithKnownCost = attempts.filter(({ usage }) => usage.cost !== null).length
	const hypotheses: ProblemSolvingDiagnosis["hypotheses"] = []
	const commandGateFailures = attempts.filter(isCommandGateFailure).length
	const profileBusyBlocks = attempts.filter(
		(attempt) => attempt.status === "blocked" && attempt.failureClass === "profile_busy",
	).length
	const otherFailureReasons: Record<string, number> = {}
	for (const attempt of attempts) {
		if (attempt.status === "failed" && !isCommandGateFailure(attempt)) {
			countInto(
				otherFailureReasons,
				`${attempt.failureClass ?? "unknown"}/${attempt.failureCategory ?? "unknown"}/${attempt.failureCode ?? "unknown"}`,
			)
		}
	}
	const commandGateGraderFailures = attempts.filter(
		(attempt) =>
			attempt.failureClass === "infrastructure" &&
			attempt.failureCategory === "policy" &&
			attempt.failureCode?.startsWith("unexpected_command") &&
			attempt.graderDecision === "outcome_failed",
	).length
	if (taskExecutionStartedAttemptCount > 0 && mismatchedStartedAttemptDigests > 0) {
		hypotheses.push({
			priority: "high",
			finding: "The runner-captured extension bundle digest differs from the prelaunch fingerprint.",
			evidence: `${mismatchedStartedAttemptDigests}/${taskExecutionStartedAttemptCount} task-execution attempts captured a bundle digest that did not match the campaign's prelaunch digest.`,
			nextCheck:
				"Treat this campaign as a mixed-artifact comparison; rebuild once, capture the prelaunch bundle digest, and start a fresh run after confirming each runner-captured digest matches it.",
		})
	} else if (taskExecutionStartedAttemptCount > 0 && observedExtensionBundleSha256s.length > 1) {
		hypotheses.push({
			priority: "high",
			finding: "Multiple runner-captured extension bundle digests occurred within this campaign.",
			evidence: `${observedExtensionBundleSha256s.length} distinct entrypoint-file digests were captured across ${taskExecutionStartedAttemptCount} task-execution attempts, so the run cannot be treated as one-artifact evidence.`,
			nextCheck:
				"Check whether a rebuild or file replacement occurred during the run; repeat from a frozen source snapshot and require one prelaunch digest to match every E2E capture.",
		})
	} else if (taskExecutionStartedAttemptCount > 0 && missingStartedAttemptDigests > 0) {
		hypotheses.push({
			priority: "high",
			finding: "The extension bundle identity is missing for some task-execution attempts.",
			evidence: `${missingStartedAttemptDigests}/${taskExecutionStartedAttemptCount} started attempts lack a runner-captured extension bundle digest.`,
			nextCheck:
				"Repair E2E bundle evidence capture before using this run as a controlled comparison; keep artifact identity separate from grader outcomes.",
		})
	} else if (taskExecutionStartedAttemptCount > 0 && expectedExtensionBundleSha256 === null) {
		hypotheses.push({
			priority: "medium",
			finding: "No prelaunch extension bundle fingerprint was recorded for this campaign.",
			evidence: `${observedExtensionBundleSha256s.length} distinct runner-captured extension bundle digest(s) are available, but there is no prelaunch digest to confirm the planned artifact.`,
			nextCheck:
				"Capture the extension bundle digest before the campaign and compare it with each E2E capture manifest before pairing live results.",
		})
	}
	if (profileBusyBlocks > 0) {
		hypotheses.push({
			priority: "high",
			finding: "A busy VS Code profile lease blocked campaign execution.",
			evidence: `${profileBusyBlocks}/${attempts.length} recorded attempts ended before task execution with a profile_busy runner signal; these attempts are excluded from the grader score, and campaign completeness is reported separately.`,
			nextCheck:
				"Wait for the existing VS Code profile lease to release, then rerun the declared selection in a fresh run root, including every pre-execution block and planned repetition; do not interpret this as model quality or start a competing live run.",
		})
	}
	if (commandGateFailures > 0) {
		hypotheses.push({
			priority: "high",
			finding:
				"The E2E command approval gate stopped multiple live attempts, and the resulting workspaces did not pass grading.",
			evidence: `${commandGateFailures}/${attempts.length} attempts ended with a safe infrastructure/policy/unexpected_command signal; ${commandGateGraderFailures} then received grader outcome_failed. This measures the gate interaction and resulting workspace state, not model capability after an admitted command.`,
			nextCheck:
				"Use the new content-free rejection-reason categories to inspect the policy boundary without relaxing approvals; rerun a small representative live cohort before tuning prompts or the core engine.",
		})
	}
	if (incompleteJoins > 0) {
		hypotheses.push({
			priority: "high",
			finding: "Cross-stream trace attribution is incomplete.",
			evidence: `${incompleteJoins}/${attempts.length} attempts have incomplete evidence joins, even though lifecycle and event-log validation are measured independently.`,
			nextCheck:
				"Join the streams by shared task, turn, and step IDs while retaining each journal's run ID as producer-local metadata.",
		})
	}
	if (allToolResults > 0 && categorizedToolResults / allToolResults < 0.8) {
		hypotheses.push({
			priority: "high",
			finding:
				"The current evidence does not reliably distinguish discovery, edits, commands, and workflow tools.",
			evidence: `${categorizedToolResults}/${allToolResults} tool results have a privacy-safe category.`,
			nextCheck:
				"Add allowlisted coarse tool categories and compare category coverage on the next live campaign; never export names, arguments, paths, or output.",
		})
	}
	if (
		executionAttempts.length > 0 &&
		statuses.passed === attempts.length &&
		executionAttempts.length === new Set(executionAttempts.map(({ taskId }) => taskId)).size
	) {
		hypotheses.push({
			priority: "medium",
			finding:
				"This one-sample-per-task campaign shows no task failures, so it does not identify a prompt, engine, or scheduler defect.",
			evidence: `${statuses.passed}/${attempts.length} attempts passed; there is one observation per task and the Wilson 95% interval is ${formatInterval(wilson95(statuses.passed, attempts.length))}.`,
			nextCheck:
				"Repeat the declared subset on the same live host/model setup before selecting an agent-behavior change; then vary one harness component and compare the same tasks.",
		})
	}
	if (Object.keys(otherFailureReasons).length > 0) {
		const reasons = Object.entries(otherFailureReasons)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([signal, count]) => `${signal} ${count}`)
			.join(", ")
		const otherFailureCount = Object.values(otherFailureReasons).reduce((sum, count) => sum + count, 0)
		hypotheses.push({
			priority: "high",
			finding: "Other failed attempts need separate attribution from the command approval gate.",
			evidence: `${otherFailureCount} failed ${otherFailureCount === 1 ? "attempt has" : "attempts have"} these safe signals: ${reasons}.`,
			nextCheck:
				"Investigate each remaining runner or budget signal separately; do not infer a prompt or engine issue until a task execution reaches the behavior under evaluation.",
		})
	}
	if (
		joins > 0 &&
		joins / attempts.length >= 0.8 &&
		incompleteJoins === 0 &&
		(allToolResults === 0 || categorizedToolResults / allToolResults >= 0.8)
	) {
		hypotheses.push({
			priority: "low",
			finding: "The event projection now has enough structure for a first-pass trajectory comparison.",
			evidence: `${joins}/${attempts.length} attempts have captured joins and ${categorizedToolResults}/${allToolResults} tool results have categories.`,
			nextCheck:
				"Use the same task subset for a controlled prompt or engine change and compare completion, requests, tool categories, retries, validation, and trace integrity.",
		})
	}
	const selectedTasks = executionAttempts.flatMap((attempt) => {
		const task = taskMap.get(attempt.taskId)
		return task ? [task] : []
	})
	const gapGroups = executionAttempts.length > 0 ? candidateCoverageGaps(selectedTasks) : []
	return {
		schemaVersion: 1,
		reportKind: "alpha-problem-solving-diagnosis",
		generatedAt: (input.now ?? new Date()).toISOString(),
		run: {
			runId: typeof campaign.runId === "string" ? campaign.runId : null,
			startedAt: typeof campaign.startedAt === "string" ? campaign.startedAt : null,
			completedAt: typeof campaign.generatedAt === "string" ? campaign.generatedAt : null,
			hostVersion: typeof campaign.hostVersion === "string" ? campaign.hostVersion : null,
			modelId: typeof campaign.modelId === "string" ? campaign.modelId : null,
			effort: typeof campaign.effort === "string" ? campaign.effort : null,
			buildIdentity: typeof campaign.buildIdentity === "string" ? campaign.buildIdentity : null,
			workingTreeClean: typeof campaign.workingTreeClean === "boolean" ? campaign.workingTreeClean : null,
			workingTreeDigest: typeof campaign.workingTreeDigest === "string" ? campaign.workingTreeDigest : null,
			taskSetSha256,
			expectedExtensionBundleSha256,
			attemptCount: attempts.length,
			plannedTaskIds: selectedTaskIds,
			plannedRepetitions,
			taskExecutionStartedAttemptCount,
			preExecutionBlockedAttemptCount,
			executionStartUnknownAttemptCount,
			plannedAttemptCount,
			pendingExecutionCount,
			campaignComplete,
			stopSignal,
			notAttemptedTaskIds,
		},
		extensionArtifact: {
			observedBundleSha256s: observedExtensionBundleSha256s,
			missingStartedAttemptDigests,
			mismatchedStartedAttemptDigests,
			matchesExpected: bundleDigestMatchesExpected,
		},
		policyArtifacts: {
			policySnapshotEventCount,
			observedPolicyDigestSha256s,
			startedAttemptsWithoutPolicyDigest,
			attemptsWithMultiplePolicyDigests,
		},
		outcomes: {
			...statuses,
			scoredAttempts,
			passRate: scoredAttempts ? statuses.passed / scoredAttempts : null,
			wilson95: wilson95(statuses.passed, scoredAttempts),
		},
		usage: {
			requests: requestStats,
			inputTokens: inputStats,
			outputTokens: outputStats,
			knownCostAttempts: attemptsWithKnownCost,
			unknownCostAttempts: attempts.length - attemptsWithKnownCost,
		},
		coverage: {
			sources: Object.fromEntries(Object.entries(sources).sort(([left], [right]) => left.localeCompare(right))),
			lanes: Object.fromEntries(Object.entries(lanes).sort(([left], [right]) => left.localeCompare(right))),
			tags: Object.fromEntries(Object.entries(tags).sort(([left], [right]) => left.localeCompare(right))),
			candidateGaps: gapGroups.filter(({ matchingTasks }) => matchingTasks.length === 0),
		},
		failureReasons: Object.fromEntries(
			Object.entries(failureReasons).sort(([left], [right]) => left.localeCompare(right)),
		),
		evidence: {
			completeCaptures: attempts.filter(({ evidence }) => evidence.capture === "complete").length,
			incompleteCaptures: attempts.filter(({ evidence }) => evidence.capture === "incomplete").length,
			missingCaptures: attempts.filter(({ evidence }) => evidence.capture === "missing").length,
			validatedLifecycleTraces: countStatuses(attempts, "lifecycleValidation"),
			validatedEventTraces: countStatuses(attempts, "eventLogValidation"),
			capturedJoins: joins,
			incompleteJoins,
			missingJoins,
			categorizedToolResultCoverage: allToolResults ? categorizedToolResults / allToolResults : null,
			usageTraceMatches: usageMatches,
			usageTraceMismatches: usageMismatches,
			usageTraceUnavailable: usageUnavailable,
			eventCounts,
			toolResultsByCategory,
			toolResultsByStatus,
			approvalDecisions,
			retries: attempts.reduce((sum, attempt) => sum + attempt.trace.retries, 0),
			compactions: attempts.reduce((sum, attempt) => sum + attempt.trace.compactions, 0),
			contextRefreshes: attempts.reduce((sum, attempt) => sum + attempt.trace.contextRefreshes, 0),
			verificationResults: attempts.reduce((sum, attempt) => sum + attempt.trace.verificationResults, 0),
			batchDurationMs: summarize(batchDurations),
			parallelTools: summarize(parallelCounts),
		},
		attempts,
		hypotheses,
		limitations: [
			"No prompt, assistant text, tool arguments, paths, or tool output is copied into this report.",
			"Execution start requires a positive model-request receipt, a model-request, tool/approval, verification, or turn/task event, or a verified pass; profile/policy initialization alone does not count. Otherwise start status is unknown and the planned execution remains pending.",
			"A grader pass measures the declared fixture and checks; it does not establish correctness on every workflow shape.",
			"One sample per task cannot estimate run-to-run variance or confidently select a harness change.",
			"Terminal-Bench tasks remain outside this local live score because their published verifiers and environments are container-bound.",
			"Coverage gaps are based on manifest tags; review task instructions before treating an absent tag as an absent behavior.",
			"Cost remains unknown when Copilot supplies no positive price; missing cost is not zero.",
		],
	}
}

function formatInterval(value: { lower: number; upper: number } | null): string {
	return value ? `${(value.lower * 100).toFixed(1)}%–${(value.upper * 100).toFixed(1)}%` : "unavailable"
}

function displayNumber(value: number | null): string {
	return value === null ? "unavailable" : Math.round(value).toLocaleString("en-US")
}

export function problemSolvingDiagnosisMarkdown(report: ProblemSolvingDiagnosis): string {
	const tagRows = Object.entries(report.coverage.tags)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([tag, count]) => `| ${tag} | ${count} |`)
	const gapRows =
		report.run.taskExecutionStartedAttemptCount > 0
			? report.coverage.candidateGaps.map(({ area, tags }) => `| ${area} | ${tags.join(", ")} |`)
			: []
	const failureRows = Object.entries(report.failureReasons)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([reason, count]) => `| ${reason} | ${count} |`)
	const hypothesisRows = report.hypotheses.map(
		({ priority, finding, evidence, nextCheck }) => `| ${priority} | ${finding} ${evidence} | ${nextCheck} |`,
	)
	const attemptRows = report.attempts.map((attempt) => {
		const failureSignal =
			attempt.failureClass || attempt.failureCategory || attempt.failureCode
				? `${attempt.failureClass ?? "unknown"}/${attempt.failureCategory ?? "unknown"}/${attempt.failureCode ?? "unknown"}`
				: "—"
		const graderRecord =
			attempt.status === "blocked"
				? `excluded from score${attempt.graderDecision ? ` (recorded ${attempt.graderDecision})` : " (no grader result)"}`
				: (attempt.graderDecision ?? "none")
		return `| ${attempt.taskId} | ${attempt.source ?? "unknown"} | ${attempt.lane ?? "unknown"} | ${attempt.status} | ${attempt.executionStartEvidence} | ${failureSignal} | ${graderRecord} | ${displayNumber(attempt.usage.requests)} | ${attempt.evidence.joinStatus} |`
	})
	const campaignCompletion =
		report.run.campaignComplete === null
			? "Completion status unavailable; the planned selection was not recorded."
			: report.run.campaignComplete
				? "Campaign execution complete: " +
					report.run.taskExecutionStartedAttemptCount +
					"/" +
					report.run.plannedAttemptCount +
					" planned task executions started (recorded attempts: " +
					report.run.attemptCount +
					")."
				: "Campaign execution incomplete: " +
					report.run.attemptCount +
					"/" +
					report.run.plannedAttemptCount +
					" attempts recorded; " +
					report.run.taskExecutionStartedAttemptCount +
					" task executions started; " +
					report.run.preExecutionBlockedAttemptCount +
					" blocked before execution; " +
					report.run.executionStartUnknownAttemptCount +
					" execution starts unknown; " +
					report.run.pendingExecutionCount +
					" planned execution(s) pending. Last safe signal " +
					(report.run.stopSignal ?? "unknown") +
					". Pending task IDs for remaining repetitions: " +
					(report.run.notAttemptedTaskIds.join(", ") || "unavailable") +
					"."
	const executionSummary =
		"Execution evidence: " +
		report.run.taskExecutionStartedAttemptCount +
		" task execution(s) started; " +
		report.run.preExecutionBlockedAttemptCount +
		" blocked before execution; " +
		report.run.executionStartUnknownAttemptCount +
		" start(s) unknown."
	const bundleDigestSummary =
		"Extension bundle SHA-256: prelaunch " +
		(report.run.expectedExtensionBundleSha256 ?? "not recorded") +
		"; runner-captured " +
		(report.extensionArtifact.observedBundleSha256s.join(", ") || "none") +
		"; missing on started attempts " +
		report.extensionArtifact.missingStartedAttemptDigests +
		"; mismatches " +
		report.extensionArtifact.mismatchedStartedAttemptDigests +
		"; prelaunch match " +
		(report.extensionArtifact.matchesExpected === null
			? "unverified"
			: report.extensionArtifact.matchesExpected
				? "confirmed"
				: "failed") +
		"."
	const policyDigestSummary =
		"Effective tool-policy hashes captured: " +
		report.policyArtifacts.observedPolicyDigestSha256s.length +
		" unique digest(s); " +
		report.policyArtifacts.policySnapshotEventCount +
		" policy_snapshot event(s); " +
		report.policyArtifacts.startedAttemptsWithoutPolicyDigest +
		" started attempt(s) without a captured digest; " +
		report.policyArtifacts.attemptsWithMultiplePolicyDigests +
		" attempt(s) with multiple digests. These hashes include workspace scope, so differences across tasks or runs can be expected."
	const plannedSelection = report.run.plannedTaskIds.length
		? `Planned selection: ${report.run.plannedTaskIds.length} task(s) × ${report.run.plannedRepetitions ?? "unknown"} repetition(s): ${report.run.plannedTaskIds.join(", ")}.`
		: "Planned task IDs unavailable in the campaign report."
	return [
		"# Live problem-solving campaign diagnosis",
		"",
		`Generated: ${report.generatedAt}`,
		`Run: ${report.run.runId ?? "unknown"} · VS Code ${report.run.hostVersion ?? "unknown"} · ${report.run.modelId ?? "unknown"} · ${report.run.effort ?? "unknown"}`,
		`Build: ${report.run.buildIdentity ?? "unknown"}`,
		`Working tree: ${report.run.workingTreeClean === null ? "not recorded" : report.run.workingTreeClean ? "clean" : "dirty"}`,
		`Working-tree input digest: ${report.run.workingTreeDigest ?? "not recorded"}`,
		`Task-set SHA-256: ${report.run.taskSetSha256 ?? "not recorded"}`,
		plannedSelection,
		`Campaign completeness: ${campaignCompletion}`,
		executionSummary,
		"",
		"## What this run says",
		"",
		`- Verified passes: ${report.outcomes.passed}/${report.outcomes.scoredAttempts} grader-scored attempts (${report.outcomes.passRate === null ? "no scored attempts" : `${(report.outcomes.passRate * 100).toFixed(1)}%`}; Wilson 95% interval ${formatInterval(report.outcomes.wilson95)}). ${report.run.attemptCount - report.outcomes.scoredAttempts} ${report.run.attemptCount - report.outcomes.scoredAttempts === 1 ? "attempt had" : "attempts had"} no usable grader score.`,
		"- Blocked attempts are excluded from the quality score; any recorded grader decision on them is retained only as a historical record.",
		`- Requests per attempt: n=${report.usage.requests.count}, median ${displayNumber(report.usage.requests.median)}, p95 ${displayNumber(report.usage.requests.p95)}.`,
		`- Input tokens: median ${displayNumber(report.usage.inputTokens.median)}, p95 ${displayNumber(report.usage.inputTokens.p95)}. Output tokens: median ${displayNumber(report.usage.outputTokens.median)}, p95 ${displayNumber(report.usage.outputTokens.p95)}.`,
		`- Cost recorded for ${report.usage.knownCostAttempts}/${report.run.attemptCount} attempts; the remainder is unknown, not zero.`,
		"",
		"## Evidence quality",
		"",
		`- ${bundleDigestSummary}`,
		`- ${policyDigestSummary}`,
		`- Complete E2E capture manifests: ${report.evidence.completeCaptures}/${report.run.attemptCount}. Lifecycle projections validated: ${report.evidence.validatedLifecycleTraces}; turn projections validated: ${report.evidence.validatedEventTraces}.`,
		`- Cross-stream joins captured: ${report.evidence.capturedJoins}; incomplete: ${report.evidence.incompleteJoins}; missing: ${report.evidence.missingJoins}.`,
		`- Tool-category coverage: ${report.evidence.categorizedToolResultCoverage === null ? "unavailable" : `${(report.evidence.categorizedToolResultCoverage * 100).toFixed(1)}%`}. Usage receipts match event totals: ${report.evidence.usageTraceMatches}; mismatch: ${report.evidence.usageTraceMismatches}; unavailable: ${report.evidence.usageTraceUnavailable}.`,
		`- Retries: ${report.evidence.retries}; compactions: ${report.evidence.compactions}; context refreshes: ${report.evidence.contextRefreshes}; verification_result trajectory events: ${report.evidence.verificationResults} (grader outcomes are reported separately).`,
		"",
		"## Coverage",
		"",
		"Coverage uses attempts with task execution start evidence; profile-busy preflight blocks are excluded. Manifest tags describe task assignments, not demonstrated capability.",
		"",
		`Sources: ${
			Object.entries(report.coverage.sources)
				.map(([name, count]) => `${name} ${count}`)
				.join(", ") || "none"
		}. Lanes: ${
			Object.entries(report.coverage.lanes)
				.map(([name, count]) => `${name} ${count}`)
				.join(", ") || "none"
		}.`,
		"",
		"| Tag | Task execution attempts |",
		"| --- | ---: |",
		...(tagRows.length ? tagRows : ["| none | 0 |"]),
		"",
		report.run.taskExecutionStartedAttemptCount > 0
			? "Candidate areas with no matching manifest tag (review task text before calling these true gaps):"
			: "Candidate gap analysis not run because no task execution start was evidenced.",
		"",
		"| Area | Tags checked |",
		"| --- | --- |",
		...(gapRows.length
			? gapRows
			: report.run.taskExecutionStartedAttemptCount > 0
				? ["| None | — |"]
				: ["| Not assessed | No task execution start was evidenced |"]),
		"",
		"## Findings and next checks",
		"",
		"| Priority | Finding and evidence | Next check |",
		"| --- | --- | --- |",
		...(hypothesisRows.length
			? hypothesisRows
			: ["| — | No diagnosis supported by the available evidence. | Gather a repeated live baseline. |"]),
		"",
		"## Safe failure signals",
		"",
		"| Failure class / category / code | Attempts |",
		"| --- | ---: |",
		...(failureRows.length ? failureRows : ["| none | 0 |"]),
		"",
		"## Attempt summary",
		"",
		"| Task | Source | Lane | Outcome | Execution-start evidence | Safe failure signal | Grader record / score treatment | Requests | Trace join |",
		"| --- | --- | --- | --- | --- | --- | --- | ---: | --- |",
		...(attemptRows.length ? attemptRows : ["| none | — | — | — | — | — | — | — | — |"]),
		"",
		"## Limits",
		"",
		...report.limitations.map((limitation) => `- ${limitation}`),
		"",
	].join("\n")
}

function argument(name: string, fallback?: string): string {
	const index = process.argv.indexOf(name)
	const value = index >= 0 ? process.argv[index + 1] : undefined
	if (value) return value
	if (fallback) return fallback
	throw new Error(`Missing ${name}`)
}

const isDirectRun = process.argv[1]?.replaceAll("\\", "/").endsWith("problemSolvingDiagnosis.ts")
if (isDirectRun) {
	const reportPath = path.resolve(argument("--report"))
	const evalRoot = path.resolve(argument("--eval-root", path.resolve(import.meta.dirname, "../../../../evals")))
	const outputPath = path.resolve(argument("--output", path.join(path.dirname(reportPath), "diagnosis.json")))
	const diagnosis = await diagnoseProblemSolvingCampaign({ reportPath, evalRoot })
	const markdownPath = outputPath.replace(/\.json$/i, ".md")
	await fs.writeFile(outputPath, `${JSON.stringify(diagnosis, null, 2)}\n`, { flag: "wx" })
	await fs.writeFile(markdownPath, problemSolvingDiagnosisMarkdown(diagnosis), { flag: "wx" })
	console.log(JSON.stringify({ outputPath, markdownPath, attempts: diagnosis.run.attemptCount }, null, 2))
}
