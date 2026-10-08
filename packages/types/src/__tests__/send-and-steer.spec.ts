import { describe, expect, it } from "vitest"

import { sendAndSteerMessageSchema } from "../vscode-extension-host.js"

describe("direct steering wire contract", () => {
	const submission = {
		type: "sendAndSteer",
		taskId: "task-1",
		requestId: "receipt-1",
		text: "Use the existing parser",
		images: [],
	}

	it("requires an explicit task and receipt identity", () => {
		expect(sendAndSteerMessageSchema.safeParse(submission).success).toBe(true)
		for (const field of ["taskId", "requestId"] as const) {
			expect(sendAndSteerMessageSchema.safeParse({ ...submission, [field]: undefined }).success).toBe(false)
			expect(sendAndSteerMessageSchema.safeParse({ ...submission, [field]: "" }).success).toBe(false)
		}
	})

	it("rejects malformed text and attachments while allowing image-only input", () => {
		expect(sendAndSteerMessageSchema.safeParse({ ...submission, text: 42 }).success).toBe(false)
		expect(sendAndSteerMessageSchema.safeParse({ ...submission, images: [42] }).success).toBe(false)
		expect(
			sendAndSteerMessageSchema.safeParse({ ...submission, text: "", images: ["data:image/png;base64,eA=="] })
				.success,
		).toBe(true)
	})
})
