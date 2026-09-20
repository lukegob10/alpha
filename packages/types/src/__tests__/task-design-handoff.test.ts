import { describe, expect, it } from "vitest"

import { historyItemSchema } from "../history.js"
import { MAX_DESIGN_HANDOFF_CHARS, taskDesignHandoffSchema } from "../task-design-handoff.js"
import { taskWorkPlanSchema } from "../task-work-context.js"

const handoff = {
	title: "Durable design",
	markdown: "# Durable design\n\n- Persist the current revision.",
	sourceTaskId: "primary-task",
	digest: "a".repeat(64),
	updatedAt: 1_700_000_000_000,
}

const historyBase = {
	id: "primary-task",
	number: 1,
	ts: 1,
	task: "Implement the design",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}

describe("task design handoff schema", () => {
	it("round-trips a handoff through history persistence", () => {
		const parsed = taskDesignHandoffSchema.parse(JSON.parse(JSON.stringify(handoff)))
		const history = historyItemSchema.parse(JSON.parse(JSON.stringify({ ...historyBase, designHandoff: parsed })))

		expect(parsed).toEqual(handoff)
		expect(history.designHandoff).toEqual(handoff)
	})

	it("continues to parse old history items without a handoff", () => {
		expect(historyItemSchema.parse(historyBase)).toEqual(historyBase)
	})

	it("keeps the bounded work plan contract separate from the design handoff", () => {
		const workPlan = {
			objective: "Implement the design",
			constraints: ["Keep the current task mode behavior"],
			notes: ["Verify the persisted handoff after reload"],
			checks: [
				{
					id: "unit-tests",
					description: "Run focused persistence tests",
					command: "pnpm --dir src test",
					cwd: null,
					paths: ["src/core/task"],
					reusable: true,
				},
			],
		}
		const parsedPlan = taskWorkPlanSchema.parse(JSON.parse(JSON.stringify(workPlan)))
		const history = historyItemSchema.parse({
			...historyBase,
			workContext: { plan: parsedPlan, receipts: [], skills: [] },
		})

		expect(parsedPlan).toEqual(workPlan)
		expect(history.workContext?.plan).toEqual(workPlan)
		expect(history.designHandoff).toBeUndefined()
	})

	it("enforces the handoff body and digest bounds", () => {
		expect(
			taskDesignHandoffSchema.safeParse({ ...handoff, markdown: "x".repeat(MAX_DESIGN_HANDOFF_CHARS + 1) })
				.success,
		).toBe(false)
		expect(taskDesignHandoffSchema.safeParse({ ...handoff, digest: "A".repeat(64) }).success).toBe(false)
	})
})
