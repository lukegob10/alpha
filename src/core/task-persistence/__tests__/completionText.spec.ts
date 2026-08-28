import type { ClineMessage } from "@alpha-code/types"
import { describe, expect, it } from "vitest"

import { getLatestTaskCompletionText } from "../completionText"

const message = (overrides: Partial<ClineMessage>): ClineMessage => ({
	ts: 1,
	type: "say",
	...overrides,
})

describe("getLatestTaskCompletionText", () => {
	it("returns provider-neutral plain assistant text before an empty completion boundary", () => {
		const messages = [
			message({ type: "say", say: "text", text: "Plain provider response" }),
			message({ type: "ask", ask: "completion_result", text: "" }),
		]

		expect(getLatestTaskCompletionText(messages)).toBe("Plain provider response")
	})

	it("prefers an explicit completion result over assistant text in the same turn", () => {
		const messages = [
			message({ type: "say", say: "text", text: "Work is complete." }),
			message({ type: "say", say: "completion_result", text: "Authoritative final result" }),
			message({ type: "ask", ask: "completion_result", text: "" }),
		]

		expect(getLatestTaskCompletionText(messages)).toBe("Authoritative final result")
	})

	it("ignores empty and partial completion content", () => {
		const messages = [
			message({ type: "say", say: "text", text: "Complete assistant response" }),
			message({ type: "say", say: "completion_result", text: "   " }),
			message({ type: "say", say: "completion_result", text: "Incomplete", partial: true }),
			message({ type: "ask", ask: "completion_result", text: "" }),
		]

		expect(getLatestTaskCompletionText(messages)).toBe("Complete assistant response")
	})

	it("does not cross a previous completion boundary when the latest turn has no result", () => {
		const messages = [
			message({ type: "say", say: "text", text: "Stale first result" }),
			message({ type: "ask", ask: "completion_result", text: "" }),
			message({ type: "say", say: "user_feedback", text: "Try again" }),
			message({ type: "ask", ask: "completion_result", text: "" }),
		]

		expect(getLatestTaskCompletionText(messages)).toBeUndefined()
	})

	it("returns the result from the latest completed turn", () => {
		const messages = [
			message({ type: "say", say: "completion_result", text: "First result" }),
			message({ type: "ask", ask: "completion_result", text: "" }),
			message({ type: "say", say: "user_feedback", text: "Make one more change" }),
			message({ type: "say", say: "text", text: "Updated plain response" }),
			message({ type: "ask", ask: "completion_result", text: "" }),
		]

		expect(getLatestTaskCompletionText(messages)).toBe("Updated plain response")
	})

	it("supports legacy non-empty completion asks", () => {
		const messages = [
			message({ type: "say", say: "text", text: "Fallback text" }),
			message({ type: "ask", ask: "completion_result", text: "Legacy final result" }),
		]

		expect(getLatestTaskCompletionText(messages)).toBe("Legacy final result")
	})

	it("falls back to the latest assistant response when no boundary was persisted", () => {
		const messages = [
			message({ type: "say", say: "text", text: "Earlier response" }),
			message({ type: "say", say: "text", text: "Latest response" }),
		]

		expect(getLatestTaskCompletionText(messages)).toBe("Latest response")
	})
})
