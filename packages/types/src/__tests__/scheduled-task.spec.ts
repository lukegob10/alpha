import { describe, expect, it } from "vitest"
import {
	scheduledTaskSchema,
	scheduledTaskRunSchema,
	scheduledTaskExecutionSchema,
	scheduledTaskCreationResultSchema,
} from "../scheduled-task.js"

const legacy = {
	id: "schedule",
	name: "Review",
	prompt: "Review the repository",
	enabled: true,
	schedule: { type: "daily", startAt: 1, timezone: "UTC" },
	permissions: {},
	notificationPreference: "never",
	createdAt: 1,
	updatedAt: 1,
}

describe("scheduled setup contracts", () => {
	it("preserves legacy UUID-like creation and owner identities", () => {
		const legacyId = "12345678-1234-1234-1234-123456789abc"
		expect(scheduledTaskSchema.parse({ ...legacy, creationRequestId: legacyId }).creationRequestId).toBe(legacyId)
		expect(
			scheduledTaskCreationResultSchema.parse({ requestId: legacyId, status: "error", error: "save_failed" })
				.requestId,
		).toBe(legacyId)
		expect(
			scheduledTaskRunSchema.parse({
				id: "run",
				taskId: "schedule",
				ownerId: legacyId,
				status: "succeeded",
				trigger: "manual",
				scheduledFor: 1,
				prompt: legacy.prompt,
			}).ownerId,
		).toBe(legacyId)
	})

	it("round trips creation correlation without requiring it on legacy records", () => {
		const requestId = "d5b82d17-3f59-4ba9-883c-b9a865cd1234"
		const task = scheduledTaskSchema.parse({ ...legacy, creationRequestId: requestId })
		expect(task.creationRequestId).toBe(requestId)
		expect(scheduledTaskSchema.parse(legacy).creationRequestId).toBeUndefined()
		expect(scheduledTaskCreationResultSchema.parse({ requestId, status: "success", task })).toEqual({
			requestId,
			status: "success",
			task,
		})
		expect(scheduledTaskCreationResultSchema.parse({ requestId, status: "error", error: "save_failed" })).toEqual({
			requestId,
			status: "error",
			error: "save_failed",
		})
		expect(
			scheduledTaskCreationResultSchema.safeParse({
				requestId,
				status: "error",
				error: "secret exception details",
			}).success,
		).toBe(false)
		expect(scheduledTaskSchema.safeParse({ ...legacy, creationRequestId: "" }).success).toBe(false)
	})
	it("reads legacy tasks and runs without a profile or execution type", () => {
		expect(scheduledTaskSchema.parse(legacy).apiConfig).toBeUndefined()
		expect(
			scheduledTaskRunSchema.parse({
				id: "run",
				taskId: "schedule",
				status: "succeeded",
				trigger: "manual",
				scheduledFor: 1,
				prompt: legacy.prompt,
			}).resolvedApiConfig,
		).toBeUndefined()
	})
	it("reads legacy approval switches and round trips each current approval mode", () => {
		expect(
			scheduledTaskSchema.parse({
				...legacy,
				autoApproval: { autoApprovalEnabled: true, alwaysAllowReadOnly: true, deniedCommands: ["rm"] },
			}).autoApproval,
		).toEqual({ autoApprovalEnabled: true, alwaysAllowReadOnly: true, deniedCommands: ["rm"] })
		for (const approvalMode of ["ask", "auto", "bypass"] as const) {
			expect(scheduledTaskSchema.parse({ ...legacy, autoApproval: { approvalMode } }).autoApproval).toEqual({
				approvalMode,
			})
		}
		expect(scheduledTaskSchema.safeParse({ ...legacy, autoApproval: { approvalMode: "invalid" } }).success).toBe(
			false,
		)
	})
	it("round trips the selected profile and exact skill location", () => {
		const task = {
			...legacy,
			apiConfig: { id: "internal", name: "Internal" },
			reasoningPreference: { kind: "effort", effort: "high" },
			execution: {
				type: "skill",
				skillName: "review",
				skillPath: "/project/.agents/skills/review/SKILL.md",
				arguments: "weekly",
			},
			prompt: "",
		}
		expect(scheduledTaskSchema.parse(task)).toMatchObject(task)
	})
	it("round trips a queued reasoning preference independently of the profile", () => {
		const run = {
			id: "run",
			taskId: "schedule",
			status: "queued" as const,
			trigger: "manual" as const,
			scheduledFor: 1,
			prompt: legacy.prompt,
			reasoningPreference: { kind: "off" as const },
		}
		expect(scheduledTaskRunSchema.parse(run)).toMatchObject(run)
	})
	it("rejects malformed profile identities instead of discarding them", () => {
		expect(scheduledTaskSchema.safeParse({ ...legacy, apiConfig: { name: "Internal" } }).success).toBe(false)
		expect(scheduledTaskSchema.safeParse({ ...legacy, apiConfig: { id: "", name: "Internal" } }).success).toBe(
			false,
		)
	})
	it("rejects malformed reasoning preferences instead of silently falling back", () => {
		expect(
			scheduledTaskSchema.safeParse({ ...legacy, reasoningPreference: { kind: "effort", effort: "turbo" } })
				.success,
		).toBe(false)
	})
	it("drops stale skill fields from prompt execution", () => {
		expect(scheduledTaskExecutionSchema.parse({ type: "prompt", skillName: "review", arguments: "old" })).toEqual({
			type: "prompt",
		})
	})
})
