import { taskGoalUsageReceiptsSchema } from "@alpha-code/types"

import { invalidPersistedApiMessages } from "../validatePersistedApiMessages"

const receipt = { goalTaskId: "task-1", goalId: "goal-1", eventId: "step-1", tokens: 10, timeMs: 4 }

describe("goal usage write-ahead receipts", () => {
	it("keeps old transcripts valid without goal metadata", () => {
		expect(invalidPersistedApiMessages([{ role: "assistant", content: "Completed ordinary work" }])).toBeUndefined()
	})

	it("accepts provider-neutral own and inherited usage checkpoints without changing persisted bytes", () => {
		const history = [
			{
				role: "assistant",
				content: "Worked",
				goal_usage_receipts: [receipt, { ...receipt, goalTaskId: "parent", goalId: "parent-goal" }],
			},
		]
		const before = structuredClone(history)
		expect(invalidPersistedApiMessages(history)).toBeUndefined()
		expect(history).toEqual(before)
		expect(taskGoalUsageReceiptsSchema.parse(history[0].goal_usage_receipts)).toEqual(
			history[0].goal_usage_receipts,
		)
	})

	it.each([
		{},
		[{ ...receipt, tokens: -1 }],
		[{ ...receipt, timeMs: Infinity }],
		[{ ...receipt, goalId: "" }],
		[{ ...receipt, eventId: "x".repeat(257) }],
		[receipt, receipt, receipt],
	])("rejects malformed or unbounded goal receipts before string-content early return (%j)", (receipts) => {
		const history = [{ role: "assistant", content: "private response", goal_usage_receipts: receipts }]
		expect(invalidPersistedApiMessages(history)).toBe("message 0 has invalid goal usage receipts")
	})

	it("rejects user-authored accounting metadata", () => {
		expect(invalidPersistedApiMessages([{ role: "user", content: "Text", goal_usage_receipts: [receipt] }])).toBe(
			"message 0 has invalid goal usage receipts",
		)
	})
})
