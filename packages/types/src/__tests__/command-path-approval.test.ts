import { describe, expect, it } from "vitest"
import { toolProgressStatusSchema } from "../message.js"

describe("command path approval presentation", () => {
	it("keeps old progress messages readable", () => {
		expect(toolProgressStatusSchema.parse({ text: "project" })).toEqual({ text: "project" })
	})
	it("retains the review details through serialization", () => {
		const progress = { text: "project", commandPathApproval: { outsidePaths: ["/other/file"], unresolved: true } }
		expect(toolProgressStatusSchema.parse(JSON.parse(JSON.stringify(progress)))).toEqual(progress)
	})
	it("rejects malformed path review details", () => {
		expect(
			toolProgressStatusSchema.safeParse({ commandPathApproval: { outsidePaths: [7], unresolved: false } })
				.success,
		).toBe(false)
	})
})
