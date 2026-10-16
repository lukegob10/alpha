import assert from "node:assert/strict"
import test from "node:test"

import { assistantVisibleText, isUnansweredCommandReview } from "../suite/live-transcript-support"

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
