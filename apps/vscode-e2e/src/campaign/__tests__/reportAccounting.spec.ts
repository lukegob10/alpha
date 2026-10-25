import { strict as assert } from "node:assert"
import { test } from "node:test"
import { campaignAccountingMatches, summarizeCampaignSamples } from "../reportAccounting"
import { campaignExitCode } from "../../runCampaign"
import type { CampaignAttempt, CampaignReport } from "../types"

function report(): CampaignReport {
	const attempts: CampaignAttempt[] = [1, 2].map((sample) => ({
		request: {
			campaignId: "accounting",
			attemptId: `sample-${sample}`,
			host: { version: "1.138.0" },
			scenarioId: "case",
			sample,
			phase: "sample",
			provider: { mode: "scripted" },
			requestLimit: 5,
		},
		result: { status: "passed", usage: { requests: 1, inputTokens: null, outputTokens: null, cost: null } },
		elapsedMs: 1,
	}))
	const evaluationPlan = { scenarioIds: ["case"], hostVersions: ["1.138.0" as const], samples: 2 }
	return {
		version: 1,
		id: "accounting",
		mode: "report-only",
		collectionMode: "sample-only",
		requestedProvider: { mode: "scripted" },
		startedAt: "now",
		stopReason: "completed",
		counts: { passed: 2, failed: 0, blocked: 0 },
		usage: { requests: 2, inputTokens: null, outputTokens: null, cost: null },
		attempts,
		repairs: [],
		evaluationPlan,
		sampling: summarizeCampaignSamples(evaluationPlan, attempts),
	}
}

test("sample accounting rejects forged totals, duplicate cells and incomplete completed matrices", () => {
	assert.equal(campaignAccountingMatches(report()), true)
	for (const alter of [
		(value: CampaignReport) => value.counts.passed++,
		(value: CampaignReport) => value.sampling!.passed++,
		(value: CampaignReport) => value.sampling!.diagnosticAttempts++,
		(value: CampaignReport) => {
			value.attempts[1]!.request.sample = 1
		},
		(value: CampaignReport) => {
			value.attempts[1]!.request.phase = "reproduce"
		},
		(value: CampaignReport) => {
			value.attempts.pop()
			value.counts.passed--
			value.sampling = summarizeCampaignSamples(value.evaluationPlan!, value.attempts)
		},
	]) {
		const value = report()
		alter(value)
		assert.equal(campaignAccountingMatches(value), false)
		assert.equal(campaignExitCode(value), 2)
	}
})

test("interrupted reports retain missing original cells and legacy summaries remain optional", () => {
	const value = report()
	value.attempts.pop()
	value.counts.passed--
	value.stopReason = "request_budget"
	value.sampling = summarizeCampaignSamples(value.evaluationPlan!, value.attempts)
	assert.equal(value.sampling.notRun, 1)
	assert.equal(campaignAccountingMatches(value), true)
	assert.equal(campaignExitCode(value), 2)
	const legacy = report()
	delete legacy.sampling
	delete legacy.collectionMode
	assert.equal(campaignAccountingMatches(legacy), true)
	assert.equal(campaignExitCode(legacy), 0)
})

test("saved success counters cannot conceal a contradictory failure or missing evidence", () => {
	for (const alter of [
		(value: CampaignReport) => {
			value.attempts[0]!.result.failure = { class: "assertion", fingerprint: "failed" }
		},
		(value: CampaignReport) => {
			value.attempts[0]!.result.retentionFailed = true
		},
		(value: CampaignReport) => {
			value.attempts[0]!.evidenceFailed = true
		},
	]) {
		const value = report()
		alter(value)
		assert.equal(campaignAccountingMatches(value), false)
		assert.equal(campaignExitCode(value), 2)
	}
})

test("diagnostic successes cannot fill original cells and cannot precede the complete collection", () => {
	const value = report()
	value.collectionMode = "sample-then-diagnose"
	value.attempts[0]!.result.status = "failed"
	value.attempts[0]!.result.failure = { class: "assertion", fingerprint: "missing-effect" }
	const diagnostic = structuredClone(value.attempts[0]!)
	diagnostic.request.attemptId = "diagnostic"
	diagnostic.request.phase = "reproduce"
	diagnostic.result.status = "passed"
	delete diagnostic.result.failure
	value.attempts.push(diagnostic)
	value.counts = { passed: 2, failed: 1, blocked: 0 }
	value.sampling = summarizeCampaignSamples(value.evaluationPlan!, value.attempts)
	assert.equal(value.sampling.passed, 1)
	assert.equal(value.sampling.diagnosticAttempts, 1)
	assert.equal(campaignAccountingMatches(value), true)
	assert.equal(campaignExitCode(value), 1)
	value.attempts.splice(1, 0, value.attempts.pop()!)
	assert.equal(campaignAccountingMatches(value), false)
})

test("untrusted sample plans cannot allocate an unbounded matrix", () => {
	assert.throws(() => summarizeCampaignSamples({ ...report().evaluationPlan!, samples: Infinity }, []))
	assert.throws(() => summarizeCampaignSamples({ ...report().evaluationPlan!, samples: 1_000_000 }, []))
})
