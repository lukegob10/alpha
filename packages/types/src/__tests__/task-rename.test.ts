import { describe, expect, it } from "vitest"

import { getTaskDisplayName, historyItemSchema } from "../history.js"
import { taskRenameRequestSchema, taskRenameResultSchema } from "../task-rename.js"

const legacy = { id: "task", number: 1, ts: 1, task: "Original prompt", tokensIn: 0, tokensOut: 0, totalCost: 0 }

describe("chat display names", () => {
	it("reads legacy records and retains the original prompt alongside a custom name", () => {
		expect(getTaskDisplayName(historyItemSchema.parse(legacy))).toBe("Original prompt")
		const generated = historyItemSchema.parse({ ...legacy, generatedTitle: "Summarize task" })
		expect(getTaskDisplayName(generated)).toBe("Summarize task")
		const renamed = historyItemSchema.parse({ ...legacy, displayName: "  Chat name  " })
		expect(getTaskDisplayName(renamed)).toBe("Chat name")
		expect(renamed.task).toBe("Original prompt")
	})

	it("limits generated titles to 36 Unicode characters", () => {
		expect(historyItemSchema.safeParse({ ...legacy, generatedTitle: "x".repeat(36) }).success).toBe(true)
		expect(historyItemSchema.safeParse({ ...legacy, generatedTitle: "x".repeat(37) }).success).toBe(false)
		expect(historyItemSchema.safeParse({ ...legacy, generatedTitle: "😀".repeat(36) }).success).toBe(true)
		expect(historyItemSchema.safeParse({ ...legacy, generatedTitle: "😀".repeat(37) }).success).toBe(false)
	})

	it("bounds and trims user labels, without allowing unrelated fields in a rename", () => {
		const request = { taskId: "task", requestId: "request", displayName: "  Useful name  " }
		expect(taskRenameRequestSchema.parse(request).displayName).toBe("Useful name")
		for (const displayName of ["", "   ", "x".repeat(97)]) {
			expect(taskRenameRequestSchema.safeParse({ ...request, displayName }).success).toBe(false)
		}
		expect(taskRenameRequestSchema.safeParse({ ...request, task: "Replace prompt" }).success).toBe(false)
	})

	it("requires the matching outcome payload and bounded request identity", () => {
		const identity = { taskId: "task", requestId: "request" }
		expect(taskRenameResultSchema.safeParse({ ...identity, status: "success", displayName: "Chat" }).success).toBe(
			true,
		)
		expect(
			taskRenameResultSchema.safeParse({ ...identity, status: "error", error: "wrongWorkspace" }).success,
		).toBe(true)
		expect(taskRenameResultSchema.safeParse({ ...identity, status: "success" }).success).toBe(false)
		expect(
			taskRenameResultSchema.safeParse({
				...identity,
				requestId: "x".repeat(129),
				status: "error",
				error: "invalid",
			}).success,
		).toBe(false)
	})
})
