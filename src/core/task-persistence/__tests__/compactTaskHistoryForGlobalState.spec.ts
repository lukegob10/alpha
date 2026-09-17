import type { HistoryItem } from "@alpha-code/types"

import {
	compactTaskHistoryForGlobalState,
	TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES,
} from "../compactTaskHistoryForGlobalState"

const item = (overrides: Partial<HistoryItem> = {}): HistoryItem => ({
	id: overrides.id ?? "task-1",
	number: overrides.number ?? 1,
	ts: overrides.ts ?? 1,
	task: overrides.task ?? "Root task",
	tokensIn: overrides.tokensIn ?? 0,
	tokensOut: overrides.tokensOut ?? 0,
	totalCost: overrides.totalCost ?? 0,
	...overrides,
})

describe("compactTaskHistoryForGlobalState", () => {
	it("keeps a bounded root-only downgrade mirror without managed-child payloads", () => {
		const root = item({
			id: "root",
			ts: 2,
			childIds: ["child"],
			completionResultSummary: "root summary",
		})
		const child = item({
			id: "child",
			rootTaskId: "root",
			parentTaskId: "root",
			taskKind: "subagent",
			task: "x".repeat(100_000),
		})

		const result = compactTaskHistoryForGlobalState([child, root])

		expect(result).toEqual([
			expect.objectContaining({ id: "root", task: "Root task", completionResultSummary: "root summary" }),
		])
		expect(result[0]).not.toHaveProperty("childIds")
		expect(JSON.stringify(result)).not.toContain('"id":"child"')
	})

	it("keeps the newest roots that fit and never exceeds the byte budget", () => {
		const roots = Array.from({ length: 30 }, (_, index) =>
			item({ id: `root-${index}`, number: index, ts: index, task: `${index}-${"é".repeat(2_000)}` }),
		)
		const budgetBytes = 12_000

		const result = compactTaskHistoryForGlobalState(roots, budgetBytes)

		expect(result[0]?.id).toBe("root-29")
		expect(result.length).toBeLessThan(roots.length)
		expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(budgetBytes)
	})

	it("does not mutate authoritative history while truncating compatibility text", () => {
		const longTask = "a".repeat(TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES)
		const original = item({ task: longTask })

		const result = compactTaskHistoryForGlobalState([original])

		expect(original.task).toBe(longTask)
		expect(result[0]?.task.length).toBeLessThan(longTask.length)
	})
})
