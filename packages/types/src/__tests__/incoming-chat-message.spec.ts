import { describe, expect, it } from "vitest"

import { alphaMessageSchema } from "../message.js"

describe("incoming chat message receipts", () => {
	const message = {
		ts: 1,
		type: "say",
		say: "agent_message",
		text: "Review is ready",
		agentMessage: { id: "message-1", senderTaskId: "peer" },
	}

	it("preserves sender identity and message content through persistence", () => {
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message)
	})

	it.each(["requested", "stopped"])("round-trips a %s peer stop receipt", (stopStatus) => {
		const receipt = { ...message, agentMessage: { ...message.agentMessage, stopStatus } }
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt)
	})

	it.each([
		{ ...message, agentMessage: undefined },
		{ ...message, say: "user_feedback" },
		{ ...message, type: "ask", ask: "tool" },
		{ ...message, agentMessage: { id: "", senderTaskId: "peer" } },
		{ ...message, agentMessage: { id: "message-1", senderTaskId: "x".repeat(257) } },
		{ ...message, agentMessage: { ...message.agentMessage, stopStatus: "complete" } },
	])("rejects an invalid or misattributed receipt: %j", (value) => {
		expect(alphaMessageSchema.safeParse(value).success).toBe(false)
	})

	it("keeps existing saved human and assistant messages readable", () => {
		for (const say of ["text", "user_feedback"]) {
			const legacy = { ts: 1, type: "say", say, text: "Existing conversation" }
			expect(alphaMessageSchema.parse(legacy)).toEqual(legacy)
		}
	})
})
