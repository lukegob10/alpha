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

const call = (name: string, result: string, isError = false, path?: string): QualityCall => ({
	name,
	result,
	isError,
	...(path ? { input: { path } } : {}),
})
const commandRead = (path: string, result: string, isError = false): QualityCall => ({
	name: "exec_command",
	input: { cmd: `rg -n . ${path}` },
	result,
	isError,
})

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

test("a Codex-style command read scores both dimensions", () => {
	const report = scoreQuality(supported, {
		answer: "700",
		calls: [
			commandRead(
				supported.sourcePath,
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
		calls: [call("read_file", "item.cents * item.quantity", false, supported.sourcePath)],
	})
	assert.equal(score.passed, false)
	assert.match(score.reason, /decoy/)
})

test("an errored retrieval does not count as evidence", () => {
	const score = scoreGroundedness(supported, {
		answer: "700",
		calls: [commandRead(supported.sourcePath, "item.cents * item.quantity", true)],
	})
	assert.match(score.reason, /evidence/)
})

test("a correct answer and matching text from a different file do not prove the requested source", () => {
	const report = scoreQuality(supported, {
		answer: "700",
		calls: [commandRead("live-quality/supported-total/notes.md", "item.cents * item.quantity")],
	})
	assert.equal(report.passed, false)
	assert.match(report.scores[0]!.reason, /evidence/)
})

test("a number containing the expected digits is not the requested outcome", () => {
	const score = scoreGroundedness(supported, {
		answer: "1700",
		calls: [call("read_file", "item.cents * item.quantity", false, supported.sourcePath)],
	})
	assert.equal(score.passed, false)
	assert.match(score.reason, /claim/)
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
	assert.equal(scoreToolCorrectness(["read_file"], [call("read_file", "failed", true)]).value, 0)
})

test("a long-file lookup accepts successful bounded command evidence", () => {
	const late = LIVE_QUALITY_CASES.find((item) => item.id === "late-span")!
	const answer = "TICKET-1842"
	const read = commandRead(late.sourcePath, late.evidence)
	assert.equal(scoreQuality(late, { answer, calls: [read] }).passed, true)
	assert.equal(scoreQuality(late, { answer, calls: [read, read] }).passed, true)
	assert.equal(scoreToolCorrectness(late.milestones, [commandRead(late.sourcePath, late.evidence, true)]).value, 0)
})

test("attempt_completion is not a trajectory step", () => {
	const calls = [
		call("read_file", "item.cents * item.quantity", false, supported.sourcePath),
		{ name: "attempt_completion", input: { result: "700" }, result: "", isError: false },
	]
	assert.equal(scoreStepEfficiency(3, calls).value, 1)
	assert.equal(scoreToolCorrectness(["read_file"], calls).value, 1)
})

test("absence requires the required phrase, no invented window, and a read of the real file", () => {
	const absence = LIVE_QUALITY_CASES.find((item) => item.id === "refund-absence")!
	const read = commandRead(absence.sourcePath, "Standard shipping is 5 business days.")
	assert.equal(scoreQuality(absence, { answer: "no refund window is stated", calls: [read] }).passed, true)
	assert.equal(scoreGroundedness(absence, { answer: "no refund window is stated", calls: [] }).passed, false)
	assert.equal(scoreGroundedness(absence, { answer: "The refund window is 30 days", calls: [read] }).passed, false)
	assert.equal(
		scoreGroundedness(absence, { answer: "no refund window is stated, probably", calls: [read] }).passed,
		false,
	)
})

test("a relative command read is tied to its workdir and exact filename", () => {
	const absence = LIVE_QUALITY_CASES.find((item) => item.id === "refund-absence")!
	const relative: QualityCall = {
		name: "exec_command",
		input: { cmd: 'rg -n "^" shipping.md', workdir: "C:/test/workspace/live-quality/refund-absence" },
		result: "Standard shipping is 5 business days.",
		isError: false,
	}
	assert.equal(scoreQuality(absence, { answer: "no refund window is stated", calls: [relative] }).passed, true)
	assert.equal(
		scoreQuality(absence, {
			answer: "no refund window is stated",
			calls: [{ ...relative, input: { ...relative.input, workdir: "C:/test/workspace/unrelated" } }],
		}).passed,
		false,
	)
})

test("each case can be passed by a minimal retrieval and does not leak the answer into the prompt", () => {
	const seen = new Set<string>()
	for (const item of LIVE_QUALITY_CASES) {
		assert.equal(seen.has(item.id), false)
		seen.add(item.id)
		assert.deepEqual(item.tools, ["exec_command"], `${item.id} must expose the current read entry point`)
		assert.ok(item.evidence.length > 0)
		assert.ok(item.maxSteps >= item.milestones.length)
		const body = Object.values(item.files).join("\n")
		assert.ok(body.includes(item.evidence))
		assert.ok(item.sourcePath in item.files)
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
		calls: item.milestones.map((milestone) => {
			const name = typeof milestone === "string" ? milestone : milestone[0]!
			if (name === "exec_command") return commandRead(item.sourcePath, item.evidence)
			return name === "search_files"
				? call(name, `${item.sourcePath}: ${item.evidence}`)
				: call(name, item.evidence, false, item.sourcePath)
		}),
	}
}
