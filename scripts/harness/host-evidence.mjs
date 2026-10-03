import { readdir } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { readExecutionJson } from "./execution-evidence.mjs"

export const smokeHostFiles = [
	"extension.test",
	"modes.test",
	"approval-mode.test",
	"command-path-approval.test",
	"command-file-diff.test",
	"tool-search.acceptance.test",
	"alpha-tickets.acceptance.test",
	"request-user-input-async.test",
	"update-plan.acceptance.test",
	"view-image.acceptance.test",
	"compaction-acceptance.test",
	"vscode-lm-contract.test",
	"background-command-completion.test",
]
export const confidenceHostFiles = [
	...smokeHostFiles,
	"core-loop.test",
	"core-loop-boundaries.test",
	"completion-idle.test",
	"managed-agents.acceptance.test",
	"long-context-fanout.test",
]
export const outcomeScenarioIds = ["dev-git-inspect", "dev-repo-bootstrap", "review-edit-test-commit-followup"]
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const integer = (value) => Number.isSafeInteger(value) && value >= 0

export function validateHostReceipt(value) {
	const counts = value?.testCounts
	if (
		value?.schemaVersion !== 1 ||
		value.kind !== "alpha-extension-test-run" ||
		typeof value.runId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId) ||
		typeof value.testFile !== "string" ||
		!/^[\w./-]+\.test$/.test(value.testFile) ||
		value.testFile.split("/").some((part) => !part || part === "." || part === "..") ||
		!Number.isFinite(Date.parse(value.startedAt)) ||
		!Number.isFinite(Date.parse(value.completedAt)) ||
		Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
		value.requestedHostVersion !== "1.125.0" ||
		value.actualHostVersion !== "1.125.0" ||
		!["scripted", "vscode-lm-fixture"].includes(value.providerMode) ||
		value.execution !== "extension-host" ||
		value.hostExitObserved !== true ||
		value.ownershipGate !== "verified" ||
		value.status !== "passed" ||
		value.exitCode !== 0 ||
		value.requireAllTests !== true ||
		value.failure != null ||
		value.captureComplete !== true ||
		value.retentionStatus !== "complete" ||
		!["persistent", "disposable"].includes(value.profile?.kind) ||
		!hash(value.profile?.sha256) ||
		!counts ||
		!["total", "passed", "pending", "executed", "failed"].every((key) => integer(counts[key])) ||
		counts.total !== counts.passed + counts.failed + counts.pending ||
		counts.executed !== counts.passed + counts.failed ||
		counts.passed === 0 ||
		counts.failed !== 0 ||
		counts.pending !== 0
	)
		throw new Error("Invalid, skipped, or incomplete exact-host receipt")
	return {
		schemaVersion: 1,
		kind: "alpha-extension-test-run",
		requestedHostVersion: "1.125.0",
		status: "passed",
		exitCode: 0,
		hostExitObserved: true,
		ownershipGate: "verified",
		runId: value.runId,
		testFile: value.testFile,
		scenarioId: value.scenarioId ?? null,
		scenarioPhase: value.scenarioPhase ?? null,
		failure: null,
		startedAt: value.startedAt,
		completedAt: value.completedAt,
		actualHostVersion: value.actualHostVersion,
		providerMode: value.providerMode,
		execution: value.execution,
		requireAllTests: true,
		captureComplete: true,
		retentionStatus: "complete",
		profile: { kind: value.profile.kind, sha256: value.profile.sha256 },
		testCounts: { total: counts.total, passed: counts.passed, failed: 0, pending: 0, executed: counts.executed },
	}
}

export async function readHostReceipts(directory, startedAt) {
	const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort()
	if (!files.length || files.length > 100) throw new Error("Missing or oversized host receipt set")
	const receipts = []
	const identities = new Set()
	for (const file of files) {
		const receipt = validateHostReceipt(await readExecutionJson(path.join(directory, file)))
		if (identities.has(receipt.runId) || Date.parse(receipt.startedAt) < Date.parse(startedAt))
			throw new Error("Duplicate or stale host execution receipt")
		identities.add(receipt.runId)
		receipts.push(receipt)
	}
	return receipts
}

export function hostSuiteVerdict(receipts, suite) {
	if (!["smoke", "confidence"].includes(suite)) return { status: "failed", reason: "unknown_host_suite" }
	try {
		receipts = receipts.map(validateHostReceipt)
	} catch {
		return { status: "failed", reason: "invalid_host_receipt" }
	}
	const expected = suite === "smoke" ? smokeHostFiles : confidenceHostFiles
	const observed = receipts.map((receipt) => receipt.testFile)
	if (new Set(receipts.map((receipt) => receipt.runId)).size !== receipts.length)
		return { status: "failed", reason: "duplicate_host_run" }
	if (
		observed.length !== expected.length ||
		new Set(observed).size !== expected.length ||
		expected.some((file) => !observed.includes(file))
	)
		return { status: "failed", reason: "incomplete_host_suite" }
	if (
		receipts.some(
			(receipt) =>
				receipt.providerMode !==
				(receipt.testFile === "vscode-lm-contract.test" ? "vscode-lm-fixture" : "scripted"),
		)
	)
		return { status: "failed", reason: "wrong_host_provider" }
	return { status: "passed", kind: "exact-host-suite", suite, receipts }
}

/** Reuse the smoke campaign's independently asserted repository outcomes, not its controller unit tests. */
export function outcomeCampaignVerdict(report, receipts, expectedId) {
	try {
		receipts = receipts.map(validateHostReceipt)
	} catch {
		return { status: "failed", reason: "invalid_host_receipt" }
	}
	const identity = report?.evaluationIdentity
	const plan = report?.evaluationPlan
	if (
		report?.version !== 1 ||
		report.id !== expectedId ||
		report.mode !== "report-only" ||
		report.requestedProvider?.mode !== "scripted" ||
		report.stopReason !== "completed" ||
		!Number.isFinite(Date.parse(report.startedAt)) ||
		!Number.isFinite(Date.parse(report.finishedAt)) ||
		Date.parse(report.finishedAt) < Date.parse(report.startedAt) ||
		report.retention?.status !== "complete" ||
		identity?.unchanged !== true ||
		!Array.isArray(identity.missing) ||
		identity.missing.length !== 0 ||
		!/^[a-f0-9]{40}$/.test(identity.extensionCommit ?? "") ||
		![
			"workingTreeDigest",
			"extensionBuildDigest",
			"harnessDigest",
			"configDigest",
			"taskSetDigest",
			"sourceComponentsDigest",
		].every((key) => hash(identity[key])) ||
		!plan ||
		!Array.isArray(plan.hostVersions) ||
		!Array.isArray(plan.scenarioIds) ||
		plan.samples !== 1 ||
		plan.hostVersions?.length !== 1 ||
		plan.hostVersions[0] !== "1.125.0" ||
		plan.scenarioIds?.length !== outcomeScenarioIds.length ||
		new Set(plan.scenarioIds).size !== outcomeScenarioIds.length ||
		outcomeScenarioIds.some((id) => !plan.scenarioIds.includes(id)) ||
		!Array.isArray(report.attempts) ||
		report.attempts.length !== outcomeScenarioIds.length ||
		report.counts?.passed !== outcomeScenarioIds.length ||
		report.counts.failed !== 0 ||
		report.counts.blocked !== 0 ||
		receipts.length !== outcomeScenarioIds.length ||
		new Set(receipts.map((receipt) => receipt.runId)).size !== receipts.length
	)
		return { status: "failed", reason: "invalid_outcome_campaign" }
	const seen = new Set()
	const seenAttempts = new Set()
	const seenEvidence = new Set()
	const scenarios = []
	for (const attempt of report.attempts) {
		const request = attempt?.request
		const result = attempt?.result
		// Persisted campaigns use native relative paths; normalize separators without collapsing path segments.
		const evidence = typeof attempt?.evidence === "string" ? attempt.evidence.replaceAll("\\", "/") : undefined
		const receipt = receipts.find(
			(value) => value.scenarioId === request?.scenarioId && value.scenarioPhase === "run",
		)
		const expectedRunId = `${createHash("sha256").update(expectedId).digest("hex")}-${request?.attemptId}-run`
		if (
			!outcomeScenarioIds.includes(request?.scenarioId) ||
			seen.has(request.scenarioId) ||
			seenAttempts.has(request.attemptId) ||
			seenEvidence.has(evidence) ||
			request.campaignId !== expectedId ||
			request.sample !== 1 ||
			request.phase !== "sample" ||
			!/^attempt-\d{4}$/.test(request.attemptId ?? "") ||
			request.host?.version !== "1.125.0" ||
			request.provider?.mode !== "scripted" ||
			result?.status !== "passed" ||
			result.actualHostVersion !== "1.125.0" ||
			result.failure != null ||
			result.retentionFailed === true ||
			attempt.evidenceFailed ||
			evidence !== `${request.attemptId}/evidence-index.json` ||
			!receipt ||
			receipt.runId !== expectedRunId ||
			receipt.testFile !== "workflow.test" ||
			receipt.providerMode !== "scripted" ||
			Date.parse(receipt.startedAt) < Date.parse(report.startedAt) ||
			Date.parse(receipt.completedAt) > Date.parse(report.finishedAt)
		)
			return { status: "failed", reason: "incomplete_outcome_sample" }
		seen.add(request.scenarioId)
		seenAttempts.add(request.attemptId)
		seenEvidence.add(evidence)
		scenarios.push({
			id: request.scenarioId,
			sample: 1,
			state: "executed-pass",
			hostRunId: receipt.runId,
			evidence,
		})
	}
	return {
		status: "passed",
		kind: "scripted-task-outcomes",
		scenarios,
		receipts,
		evaluationIdentity: Object.fromEntries(
			[
				"extensionCommit",
				"workingTreeDigest",
				"extensionBuildDigest",
				"harnessDigest",
				"configDigest",
				"taskSetDigest",
				"sourceComponentsDigest",
				"unchanged",
				"missing",
			].map((key) => [key, identity[key]]),
		),
		campaign: {
			version: 1,
			id: expectedId,
			mode: "report-only",
			requestedProvider: { mode: "scripted" },
			startedAt: report.startedAt,
			finishedAt: report.finishedAt,
			stopReason: "completed",
			retention: { status: "complete" },
			evaluationIdentity: Object.fromEntries(
				[
					"extensionCommit",
					"workingTreeDigest",
					"extensionBuildDigest",
					"harnessDigest",
					"configDigest",
					"taskSetDigest",
					"sourceComponentsDigest",
					"unchanged",
					"missing",
				].map((key) => [key, identity[key]]),
			),
			evaluationPlan: { scenarioIds: [...outcomeScenarioIds], hostVersions: ["1.125.0"], samples: 1 },
			counts: { passed: outcomeScenarioIds.length, failed: 0, blocked: 0 },
			attempts: report.attempts.map((attempt) => ({
				request: {
					campaignId: expectedId,
					attemptId: attempt.request.attemptId,
					scenarioId: attempt.request.scenarioId,
					sample: 1,
					phase: "sample",
					host: { version: "1.125.0" },
					provider: { mode: "scripted" },
				},
				result: { status: "passed", actualHostVersion: "1.125.0", taskIds: attempt.result.taskIds },
				evidence: `${attempt.request.attemptId}/evidence-index.json`,
			})),
		},
		limitation:
			"Three scripted tasks with independent repository assertions; live model capability and full task-bank coverage remain unavailable",
	}
}
