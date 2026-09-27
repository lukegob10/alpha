import { describe, expect, it } from "vitest"

import { taskApprovalModeUpdateResultSchema, taskApprovalModeUpdateSchema } from "../task-approval-mode.js"

describe("task approval mode updates", () => {
	it("requires an explicit task, request, and supported mode", () => {
		expect(
			taskApprovalModeUpdateSchema.parse({
				requestId: "request-1",
				taskId: "task-1",
				approvalMode: "auto",
			}),
		).toEqual({ requestId: "request-1", taskId: "task-1", approvalMode: "auto" })

		expect(
			taskApprovalModeUpdateSchema.safeParse({
				requestId: "request-1",
				approvalMode: "bypass",
			}).success,
		).toBe(false)
	})

	it("distinguishes an applied update from an unavailable task target", () => {
		expect(
			taskApprovalModeUpdateResultSchema.parse({
				requestId: "request-1",
				taskId: "task-1",
				status: "applied",
				approvalMode: "ask",
			}),
		).toMatchObject({ status: "applied", approvalMode: "ask" })

		expect(
			taskApprovalModeUpdateResultSchema.parse({
				requestId: "request-1",
				taskId: "task-1",
				status: "targetUnavailable",
			}),
		).toMatchObject({ status: "targetUnavailable" })

		expect(
			taskApprovalModeUpdateResultSchema.parse({
				requestId: "request-1",
				status: "rejected",
				error: "invalid",
			}),
		).toMatchObject({ status: "rejected", error: "invalid" })
	})

	it("does not allow a rejected result to claim the requested mode was applied", () => {
		expect(
			taskApprovalModeUpdateResultSchema.safeParse({
				requestId: "request-1",
				taskId: "task-1",
				status: "rejected",
				approvalMode: "bypass",
				error: "invalid",
			}).success,
		).toBe(false)

		expect(
			taskApprovalModeUpdateResultSchema.safeParse({ requestId: "request-1", status: "rejected" }).success,
		).toBe(false)
	})
})
