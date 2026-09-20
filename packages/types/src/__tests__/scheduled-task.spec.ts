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
