import { test } from "node:test"
import * as assert from "node:assert/strict"

import {
	LIVE_QUALITY_CASES,
	scoreGroundedness,
	scoreQuality,
	scoreStepEfficiency,
	scoreToolCorrectness,
	visibleAnswer,
	type QualityCall,
	type QualityCase,
} from "./liveQuality"

const call = (name: string, result: string, isError = false): QualityCall => ({ name, result, isError })

const supported = LIVE_QUALITY_CASES[0]!

test("completion text is the answer, and transcript decoys stay out of it", () => {
	const answer = visibleAnswer(
		[
			call("read_file", "source"),
			{ name: "attempt_completion", input: { result: "700" }, result: "ok", isError: false },
		],
		"The comment says 250 and the note says 900",
	)
	assert.equal(answer, "700")
	assert.equal(visibleAnswer([call("read_file", "source")], "700"), "700")
})

test("a supported read scores both dimensions", () => {
	const report = scoreQuality(supported, {
		answer: "700",
		calls: [
			call(
				"read_file",
				"exports.total = (items) => items.reduce((sum, item) => sum + item.cents * item.quantity, 0)",
			),
		],
	})
	assert.equal(report.passed, true)
	assert.deepEqual(
		report.scores.map((item) => item.value),
		[1, 1, 1],
	)
})

test("a correct number without a supporting read fails groundedness", () => {
	const score = scoreGroundedness(supported, { answer: "700", calls: [] })
	assert.equal(score.passed, false)
	assert.match(score.reason, /evidence/)
	assert.equal(score.value, 2 / 3)
})

test("a decoy in the answer fails groundedness even when the true value is present", () => {
	const score = scoreGroundedness(supported, {
		answer: "700, though the note says 900",
		calls: [call("read_file", "item.cents * item.quantity")],
	})
	assert.equal(score.passed, false)
	assert.match(score.reason, /decoy/)
})

test("an errored retrieval does not count as evidence", () => {
	const score = scoreGroundedness(supported, {
		answer: "700",
		calls: [call("read_file", "item.cents * item.quantity", true)],
	})
	assert.match(score.reason, /evidence/)
})

test("tool correctness is a subsequence and extra calls only affect step efficiency", () => {
	const calls = [
		call("list_files", "invoice.cjs"),
		call("read_file", "item.cents * item.quantity"),
		call("read_file", "again"),
	]
	assert.equal(scoreToolCorrectness(["read_file"], calls).value, 1)
	const efficiency = scoreStepEfficiency(3, calls)
	assert.equal(efficiency.value, 1)
	assert.equal(scoreStepEfficiency(3, [...calls, call("search_files", "extra")]).value, 3 / 4)
	assert.equal(scoreToolCorrectness(["search_files"], [call("read_file", "body")]).value, 0)
})

test("attempt_completion is not a trajectory step", () => {
	const calls = [
		call("read_file", "item.cents * item.quantity"),
		{ name: "attempt_completion", input: { result: "700" }, result: "", isError: false },
	]
	assert.equal(scoreStepEfficiency(3, calls).value, 1)
	assert.equal(scoreToolCorrectness(["read_file"], calls).value, 1)
})

test("absence requires the required phrase, no invented window, and a read of the real file", () => {
	const absence = LIVE_QUALITY_CASES.find((item) => item.id === "refund-absence")!
	const read = call("read_file", "Standard shipping is 5 business days.")
	assert.equal(scoreQuality(absence, { answer: "no refund window is stated", calls: [read] }).passed, true)
	assert.equal(scoreGroundedness(absence, { answer: "no refund window is stated", calls: [] }).passed, false)
	assert.equal(scoreGroundedness(absence, { answer: "The refund window is 30 days", calls: [read] }).passed, false)
})

test("each case can be passed by a minimal retrieval and does not leak the answer into the prompt", () => {
	const seen = new Set<string>()
	for (const item of LIVE_QUALITY_CASES) {
		assert.equal(seen.has(item.id), false)
		seen.add(item.id)
		assert.ok(item.evidence.length > 0)
		assert.ok(item.maxSteps >= item.milestones.length)
		const body = Object.values(item.files).join("\n")
		assert.ok(body.includes(item.evidence))
		for (const forbidden of item.forbidden) assert.equal(item.prompt.includes(forbidden), false)
		if (!item.absence) {
			assert.equal(item.prompt.includes(item.expected), false)
			assert.equal(item.scope.includes(item.expected), false)
		} else {
			assert.equal(body.includes(item.expected), false)
		}
		const passing = minimalObservation(item)
		assert.equal(scoreQuality(item, passing).passed, true, item.id)
	}
})

function minimalObservation(item: QualityCase): { answer: string; calls: QualityCall[] } {
	return {
		answer: item.expected,
		calls: item.milestones.map((name) => call(name, item.evidence)),
	}
}
