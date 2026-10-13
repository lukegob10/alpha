import { describe, expect, it } from "vitest"

import { alphaMessageSchema } from "../message.js"

const userInputResponse = {
	questions: [
		{
			header: "Scope",
			question: "Which workspace should I inspect?",
			answers: ["Current workspace (Recommended)", "Keep the existing changes."],
		},
		{ question: "Which validation should I run?", answers: ["Focused tests"] },
	],
}

const feedback = {
	ts: 1,
	type: "say",
	say: "user_feedback",
	text: "Which workspace should I inspect?\nCurrent workspace (Recommended)\nKeep the existing changes.\n\nWhich validation should I run?\nFocused tests",
	images: ["data:image/png;base64,example"],
}

describe("user input response receipts", () => {
	it("round trips question and answer metadata with feedback and attached images", () => {
		const message = { ...feedback, userInputResponse }

		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message)
	})

	it("accepts historical plain feedback without a receipt", () => {
		expect(alphaMessageSchema.parse(feedback)).toEqual(feedback)
	})

	it("preserves valid question and answer bytes for comparison with the feedback text", () => {
		const message = {
			...feedback,
			userInputResponse: {
				questions: [{ header: " Scope ", question: " Which workspace? ", answers: [" Current workspace "] }],
			},
		}

		expect(alphaMessageSchema.parse(message)).toEqual(message)
	})

	it.each([
		{ questions: [] },
		{ questions: "invalid" },
		{ questions: [null] },
		{ questions: [{ question: "", answers: ["Current workspace"] }] },
		{ questions: [{ question: " \n ", answers: ["Current workspace"] }] },
		{ questions: [{ question: 1, answers: ["Current workspace"] }] },
		{ questions: [{ question: "Which workspace?", answers: [] }] },
		{ questions: [{ question: "Which workspace?", answers: [" \n "] }] },
		{ questions: [{ question: "Which workspace?", answers: [1] }] },
		{ questions: [{ question: "Which workspace?", answers: "Current workspace" }] },
		{ questions: [{ question: "Which workspace?" }] },
		{ questions: [{ header: " ", question: "Which workspace?", answers: ["Current workspace"] }] },
	])("rejects malformed nested receipt data %j", (receipt) => {
		expect(alphaMessageSchema.safeParse({ ...feedback, userInputResponse: receipt }).success).toBe(false)
	})

	it.each([
		{ type: "say", say: "text" },
		{ type: "say", say: "user_feedback_diff" },
		{ type: "ask", ask: "followup" },
		{ type: "ask", ask: "followup", say: "user_feedback" },
	])("rejects receipt metadata on another message kind %j", (kind) => {
		expect(alphaMessageSchema.safeParse({ ts: 1, text: feedback.text, ...kind, userInputResponse }).success).toBe(
			false,
		)
	})
})
