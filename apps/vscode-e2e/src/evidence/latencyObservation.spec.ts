import * as assert from "node:assert/strict"
import { test } from "node:test"
import { latencyObservation, summarizeLatencyObservations } from "./latencyObservation"

test("successful timing capture has no implied performance acceptance", () => {
	const verdict = latencyObservation()
	assert.equal(verdict.observationStatus, "observed")
	assert.equal(verdict.performanceAcceptance.status, "not-evaluated")
	assert.ok(verdict.performanceAcceptance.reasons.length > 0)
})

test("a single cold observation cannot become a p95 claim", () => {
	const summary = summarizeLatencyObservations([420])!
	assert.equal(summary.count, 1)
	assert.equal(summary.max, 420)
	assert.equal(summary.p95, null)
	assert.equal(summarizeLatencyObservations([]), null)
})

test("repeated observations remain descriptive and do not reorder original evidence", () => {
	const samples = [300, 100, 200]
	const summary = summarizeLatencyObservations(samples)!
	assert.equal(summary.p50, 200)
	assert.equal(summary.p95, 300)
	assert.match(summary.percentileInterpretation, /no population tail or regression inference/)
	assert.deepEqual(samples, [300, 100, 200])
})

test("invalid timing evidence cannot manufacture a descriptive summary", () => {
	for (const value of [NaN, Infinity, -1]) assert.throws(() => summarizeLatencyObservations([1, value]))
})
