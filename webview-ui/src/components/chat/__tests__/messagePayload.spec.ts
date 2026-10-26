import type { AlphaMessage } from "@alpha-code/types"

import { createMessagePayloadSelector } from "../utils/messagePayload"

describe("message payload projections", () => {
	it("reuses completed projections without retaining unrelated fields in the selected value", () => {
		const select = vi.fn((payload: Record<string, unknown> | undefined) => ({ tool: payload?.tool }))
		const project = createMessagePayloadSelector(select)
		const message: AlphaMessage = {
			ts: 1,
			type: "say",
			say: "tool",
			text: JSON.stringify({ tool: "readFile", content: "Large file contents" }),
		}
		const first = project(message)
		expect(first).toEqual({ tool: "readFile" })
		expect(project(message)).toBe(first)
		expect(select).toHaveBeenCalledTimes(1)

		message.text = JSON.stringify({ tool: "appliedDiff", content: "+changed" })
		expect(project(message)).toEqual({ tool: "appliedDiff" })
		expect(select).toHaveBeenCalledTimes(2)
	})

	it("does not cache partial payloads and refreshes replacements sharing a timestamp", () => {
		const select = vi.fn((payload: Record<string, unknown> | undefined) => payload?.tool)
		const project = createMessagePayloadSelector(select)
		const message: AlphaMessage = { ts: 1, type: "say", say: "tool", text: '{"tool":"readFile"}', partial: true }
		project(message)
		project(message)
		expect(select).toHaveBeenCalledTimes(2)
		message.partial = false
		project(message)
		project(message)
		expect(select).toHaveBeenCalledTimes(3)
		expect(project({ ...message, text: '{"tool":"appliedDiff"}' })).toBe("appliedDiff")
		expect(select).toHaveBeenCalledTimes(4)
	})

	it.each(["{", "null", "[]", '"text"', "123"])(
		"caches an absent projection for invalid object payload %s",
		(text) => {
			const select = vi.fn((payload: Record<string, unknown> | undefined) => payload?.tool)
			const project = createMessagePayloadSelector(select)
			const message: AlphaMessage = { ts: 1, type: "say", say: "tool", text }
			expect(project(message)).toBeUndefined()
			expect(project(message)).toBeUndefined()
			expect(select).toHaveBeenCalledTimes(1)
			expect(select).toHaveBeenCalledWith(undefined)
		},
	)
})
