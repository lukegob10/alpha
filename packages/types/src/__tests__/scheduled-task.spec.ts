import { describe, expect, it } from "vitest"
import { scheduledTaskSchema, scheduledTaskRunSchema, scheduledTaskExecutionSchema } from "../scheduled-task.js"

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
	it("round trips the selected profile and exact skill location", () => {
		const task = {
			...legacy,
			apiConfig: { id: "internal", name: "Internal" },
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
	it("rejects malformed profile identities instead of discarding them", () => {
		expect(scheduledTaskSchema.safeParse({ ...legacy, apiConfig: { name: "Internal" } }).success).toBe(false)
		expect(scheduledTaskSchema.safeParse({ ...legacy, apiConfig: { id: "", name: "Internal" } }).success).toBe(
			false,
		)
	})
	it("drops stale skill fields from prompt execution", () => {
		expect(scheduledTaskExecutionSchema.parse({ type: "prompt", skillName: "review", arguments: "old" })).toEqual({
			type: "prompt",
		})
	})
})
