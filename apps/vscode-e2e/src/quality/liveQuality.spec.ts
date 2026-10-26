import { test } from "node:test"
import * as assert from "node:assert/strict"

import {
	LIVE_QUALITY_CASES,
	scoreGroundedness as inspectGroundedness,
	scoreQuality as inspectQuality,
	scoreStepEfficiency,
	scoreToolCorrectness,
	visibleAnswer,
	type QualityCall,
	type QualityCase,
	type QualityObservation,
} from "./liveQuality"

const workspace = "C:/test/workspace"
const scoreQuality = (spec: QualityCase, observation: QualityObservation) =>
	inspectQuality(spec, { workspace, ...observation })
const scoreGroundedness = (spec: QualityCase, observation: QualityObservation) =>
	inspectGroundedness(spec, { workspace, ...observation })

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

test("an accepted legacy completion supplies the answer when the final response has no ordinary text", () => {
	const answer = visibleAnswer(
		[
			call("read_file", "source"),
			{
				name: "attempt_completion",
				input: { result: "700" },
				result: "(tool did not return anything)",
				isError: false,
			},
		],
		"",
	)
	assert.equal(answer, "700")
	assert.equal(visibleAnswer([call("read_file", "source")], "700"), "700")
})

test("rejected completion candidates cannot replace the actual final assistant answer", () => {
	const spec = LIVE_QUALITY_CASES.find((item) => item.id === "exported-symbol")!
	for (const candidate of [
		{ result: "completion rejected", isError: true },
		{ result: "Error: cancelled", isError: false },
		{ result: '{"status":"denied"}', isError: false },
	]) {
		const calls: QualityCall[] = [
			commandRead(spec.sourcePath, spec.files[spec.sourcePath]!),
			{ name: "attempt_completion", input: { result: "250" }, ...candidate },
		]
		assert.equal(visibleAnswer(calls, "400"), "400")
		assert.equal(scoreQuality(spec, { answer: visibleAnswer(calls, "400"), calls }).passed, false)
		assert.equal(visibleAnswer(calls, ""), "", "a rejected candidate is not a final answer")
	}
})

test("the final ordinary response supersedes an earlier accepted completion", () => {
	const completion: QualityCall = {
		name: "attempt_completion",
		input: { result: "250" },
		result: "(tool did not return anything)",
		isError: false,
	}
	assert.equal(visibleAnswer([completion], "400"), "400")
	assert.equal(visibleAnswer([completion], "250"), "250")
	assert.equal(visibleAnswer([completion, call("read_file", "later work")], ""), "")
	assert.equal(
		visibleAnswer(
			[
				completion,
				{ ...completion, input: { result: "400" }, result: '{"status":"success","outcome":"completed"}' },
			],
			"",
		),
		"400",
	)
	assert.equal(visibleAnswer([{ ...completion, input: { result: "250", outcome: "blocked" } }], ""), "")
	assert.equal(visibleAnswer([{ ...completion, result: '{"status":"success","goalContinues":true}' }], ""), "")
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

test("an export declaration without the value definition cannot ground a guessed correct answer", () => {
	const spec = LIVE_QUALITY_CASES.find((item) => item.id === "exported-symbol")!
	assert.equal(
		scoreQuality(spec, { answer: "250", calls: [commandRead(spec.sourcePath, "7:module.exports = { total }")] })
			.passed,
		false,
	)
	assert.equal(
		scoreQuality(spec, {
			answer: "250",
			calls: [
				commandRead(spec.sourcePath, "4:function total() {\n5-  return 250\n6-}\n7:module.exports = { total }"),
			],
		}).passed,
		true,
	)
})

test("source provenance uses the actual read operand within the captured workspace", () => {
	const spec = LIVE_QUALITY_CASES.find((item) => item.id === "exported-symbol")!
	const result = spec.files[spec.sourcePath]!
	for (const cmd of [
		`rg -n . ${spec.sourcePath}.bak`,
		`rg -n ${spec.sourcePath} notes.md`,
		`node -e "console.log('${spec.sourcePath}')"`,
		`rg -n . ${spec.sourcePath} notes.md`,
		`rg -n . ${spec.sourcePath} && echo done`,
	])
		assert.equal(
			scoreQuality(spec, {
				answer: "250",
				calls: [{ name: "exec_command", input: { cmd }, result, isError: false }],
			}).passed,
			false,
			cmd,
		)
	for (const cmd of [
		`rg -n -A 3 -e total -- "${workspace}/${spec.sourcePath}"`,
		`rg -n . ./${spec.sourcePath}`,
		`cut -c 1-120 ${spec.sourcePath}`,
	])
		assert.equal(
			scoreQuality(spec, {
				answer: "250",
				calls: [{ name: "exec_command", input: { cmd }, result, isError: false }],
			}).passed,
			true,
			cmd,
		)
	assert.equal(
		scoreQuality(spec, {
			answer: "250",
			calls: [
				{
					name: "exec_command",
					input: { cmd: `rg -n . ${spec.sourcePath}`, workdir: "C:/other" },
					result,
					isError: false,
				},
			],
		}).passed,
		false,
	)
	const legacy = inspectQuality(spec, { answer: "250", calls: [commandRead(spec.sourcePath, result)] })
	assert.equal(legacy.passed, false, "unavailable workspace provenance is not grounding evidence")
	assert.match(legacy.scores[0]!.reason, /workspace provenance/)
})

test("transformed command output cannot manufacture grounding for an unread definition", () => {
	const spec = LIVE_QUALITY_CASES.find((item) => item.id === "exported-symbol")!
	const fabricated = "function total() { return 250 } module.exports = { total }"
	for (const cmd of [
		`rg -n --replace="${fabricated}" -e 'module.exports.*' ${spec.sourcePath}`,
		`rg -n -r"${fabricated}" -e 'module.exports.*' ${spec.sourcePath}`,
		`rg -nr"${fabricated}" -e 'module.exports.*' ${spec.sourcePath}`,
		`rg --pre="fixture-reader" -e total ${spec.sourcePath}`,
		`cut -f 1,2 --output-delimiter="${fabricated}" ${spec.sourcePath}`,
	]) {
		const report = scoreQuality(spec, {
			answer: "250",
			calls: [{ name: "exec_command", input: { cmd }, result: fabricated, isError: false }],
		})
		assert.equal(report.passed, false, cmd)
		assert.match(report.scores[0]!.reason, /evidence/, cmd)
	}
	for (const cmd of [`rg -n -e 'return|total' ${spec.sourcePath}`, `rg -ng'*.cjs' . ${spec.sourcePath}`])
		assert.equal(
			scoreQuality(spec, {
				answer: "250",
				calls: [{ name: "exec_command", input: { cmd }, result: spec.files[spec.sourcePath]!, isError: false }],
			}).passed,
			true,
			cmd,
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
			if (name === "exec_command") return commandRead(item.sourcePath, item.files[item.sourcePath]!)
			return name === "search_files"
				? call(name, `${item.sourcePath}: ${item.evidence}`)
				: call(name, item.evidence, false, item.sourcePath)
		}),
	}
}
