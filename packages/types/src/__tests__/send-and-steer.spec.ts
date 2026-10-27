import { describe, expect, it } from "vitest"

import { sendAndSteerMessageSchema, steerNextQueuedMessageSchema } from "../vscode-extension-host.js"

describe("queue-only steering wire contract", () => {
	const request = { type: "steerNextQueuedMessage", taskId: "task", requestId: "request", expectedTurnId: "turn" }
	it("requires task and request identity without accepting composer text or images", () => {
		expect(steerNextQueuedMessageSchema.safeParse(request).success).toBe(true)
		for (const field of ["taskId", "requestId"] as const) {
			expect(steerNextQueuedMessageSchema.safeParse({ ...request, [field]: "" }).success).toBe(false)
			expect(steerNextQueuedMessageSchema.safeParse({ ...request, [field]: undefined }).success).toBe(false)
		}
		expect(steerNextQueuedMessageSchema.safeParse({ ...request, text: "unsent draft" }).success).toBe(false)
		expect(steerNextQueuedMessageSchema.safeParse({ ...request, images: [] }).success).toBe(false)
		expect(steerNextQueuedMessageSchema.safeParse({ ...request, expectedTurnId: "" }).success).toBe(false)
	})
})

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

	it("accepts historical callers and validates an optional expected turn", () => {
		expect(sendAndSteerMessageSchema.parse({ ...submission, expectedTurnId: "turn-1" }).expectedTurnId).toBe(
			"turn-1",
		)
		expect(sendAndSteerMessageSchema.safeParse({ ...submission, expectedTurnId: "" }).success).toBe(false)
		expect(sendAndSteerMessageSchema.safeParse({ ...submission, expectedTurnId: 42 }).success).toBe(false)
		expect(sendAndSteerMessageSchema.parse(submission).expectedTurnId).toBeUndefined()
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
