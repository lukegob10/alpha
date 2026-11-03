import assert from "node:assert/strict"
import test from "node:test"

import {
	assistantVisibleText,
	finalAssistantResponse,
	hasIntegerResult,
	isUnansweredCommandReview,
} from "../suite/live-transcript-support"

test("integer results accept ordinary thousands grouping without changing the numeric value", () => {
	for (const answer of [
		"1562",
		"**1,562**",
		"22 × 71 = 1,562.",
		"The thread returned 1,562, using the saved profile.",
	])
		assert.equal(hasIntegerResult(answer, 1562), true, answer)
	assert.equal(hasIntegerResult("The result is -1,562.", -1562), true)
	assert.equal(hasIntegerResult("0", 0), true)
})

test("integer results reject wrong values, partial numbers, signs, decimals, and malformed grouping", () => {
	for (const answer of [
		"1563",
		"11562",
		"15620",
		"1,562,000",
		"15,62",
		"1,5620",
		"-1,562",
		"−1562",
		"1562.5",
		"1.1562",
		"1562%",
		"1562/10",
		"result1562",
		"1562nd",
	])
		assert.equal(hasIntegerResult(answer, 1562), false, answer)
	assert.equal(hasIntegerResult("1562", Number.NaN), false)
	assert.equal(hasIntegerResult("1562", 1562.5), false)
})

test("only the chronological final ordinary assistant response supplies final visible text", () => {
	const completion = {
		role: "assistant",
		content: [{ type: "tool_use", id: "finish", name: "attempt_completion", input: { result: "250" } }],
	}
	const prior = { role: "assistant", content: "Earlier commentary mentions 400." }
	assert.deepEqual(
		finalAssistantResponse([
			prior,
			completion,
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "finish", is_error: true, content: "rejected" }],
			},
			{ role: "assistant", content: [{ type: "text", text: "400" }] },
		]),
		{ text: "400", toolCallCount: 0 },
	)
	assert.deepEqual(
		finalAssistantResponse([
			prior,
			completion,
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "finish", content: "(tool did not return anything)" }],
			},
		]),
		{ text: "", toolCallCount: 1 },
		"earlier commentary cannot become the final answer of a tool completion",
	)
	assert.deepEqual(
		finalAssistantResponse([
			{ role: "user", content: "question" },
			{ role: "assistant", content: "250" },
		]),
		{ text: "250", toolCallCount: 0 },
	)
	assert.deepEqual(
		finalAssistantResponse([prior, { role: "assistant", content: [{ type: "reasoning", text: "250" }] }]),
		{ text: "", toolCallCount: 0 },
	)
	assert.deepEqual(
		finalAssistantResponse([
			{
				...completion,
				content: [{ type: "text", text: "I will finish with 400." }, ...completion.content],
			},
		]),
		{ text: "", toolCallCount: 1 },
		"commentary in a completion call is separate from its terminal answer",
	)
})

for (const answer of ["700", "250", "no refund window is stated"]) {
	test(`the visible answer ${JSON.stringify(answer)} excludes reasoning and its summary`, () => {
		assert.equal(
			assistantVisibleText([
				{ type: "reasoning", text: "The decoys are 900, 400, and 30 days", summary: "Consider 250" },
				{ type: "text", text: answer },
			]),
			answer,
		)
	})
}

test("plain historical assistant text remains readable", () => {
	assert.equal(assistantVisibleText("TICKET-1842"), "TICKET-1842")
})

test("only visible text blocks contribute in their original order", () => {
	assert.equal(
		assistantVisibleText([
			{ type: "text", text: "first" },
			{ type: "tool_use", text: "not an answer", input: { result: "not an answer" } },
			{ type: "reasoning", text: "not an answer" },
			{ type: "text", text: "second" },
		]),
		"first\nsecond",
	)
	assert.equal(assistantVisibleText([{ type: "reasoning", text: "private deliberation" }]), "")
})

test("automatically resolved command asks are not unanswered human reviews", () => {
	assert.equal(
		isUnansweredCommandReview({
			type: "ask",
			ask: "command",
			partial: false,
			isAnswered: true,
			text: "gh --version",
		}),
		false,
	)
})

test("a finalized unresolved command ask remains a human review", () => {
	for (const text of ["gh --version", "echo completion"]) {
		for (const isAnswered of [undefined, false]) {
			assert.equal(
				isUnansweredCommandReview({ type: "ask", ask: "command", partial: false, isAnswered, text }),
				true,
			)
		}
	}
})

test("partial command drafts and other message kinds are not command reviews", () => {
	assert.equal(isUnansweredCommandReview({ type: "ask", ask: "command", partial: true }), false)
	assert.equal(isUnansweredCommandReview({ type: "ask", ask: "completion_result", partial: false }), false)
	assert.equal(isUnansweredCommandReview({ type: "say", ask: "command", partial: false }), false)
})
