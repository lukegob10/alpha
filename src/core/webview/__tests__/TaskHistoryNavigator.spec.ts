import type { HistoryItem } from "@alpha-code/types"
import { TaskHistoryNavigator } from "../TaskHistoryNavigator"

const row = (id: string, ts: number, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts,
	task: id,
	number: ts,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})
const context = { generation: 0, workspace: "/workspace" }
const history = [row("middle", 2), row("oldest", 1), row("newest", 3)]

describe("TaskHistoryNavigator", () => {
	it("walks all saved chats in both directions without wrapping or reopening the endpoint", () => {
		const navigator = new TaskHistoryNavigator()
		expect(navigator.select(history, "newest", -1, context)).toBe("middle")
		expect(navigator.select(history, "middle", -1, context)).toBe("oldest")
		expect(navigator.select(history, "oldest", -1, context)).toBeUndefined()
		expect(navigator.select(history, "oldest", 1, context)).toBe("middle")
		expect(navigator.select(history, "middle", 1, context)).toBe("newest")
		expect(navigator.select(history, "newest", 1, context)).toBeUndefined()
	})

	it("keeps traversal stable when activity reorders history and keypresses outpace restoration", () => {
		const navigator = new TaskHistoryNavigator()
		expect(navigator.select(history, "newest", -1, context)).toBe("middle")
		navigator.recordOpen(1)
		const reordered = [row("middle", 5), row("newest", 4), row("oldest", 1)]
		expect(navigator.select(reordered, "newest", -1, { ...context, generation: 1 })).toBe("oldest")
		navigator.recordOpen(2)
		expect(navigator.select(reordered, "middle", -1, { ...context, generation: 2 })).toBeUndefined()
	})

	it("starts a fresh walk after explicit navigation, workspace changes, or a failed restore", () => {
		const navigator = new TaskHistoryNavigator()
		expect(navigator.select(history, "newest", -1, context)).toBe("middle")
		expect(navigator.select(history, "newest", -1, { ...context, generation: 1 })).toBe("middle")
		expect(navigator.select(history, "newest", -1, { ...context, workspace: "/other" })).toBe("middle")
		navigator.reset()
		expect(navigator.select(history, "newest", -1, context)).toBe("middle")
	})

	it("skips archived and managed chats and nested children, matching root history conversations", () => {
		const navigator = new TaskHistoryNavigator()
		const rows = [
			row("newest", 10),
			row("archived", 9, { archived: true }),
			row("managed", 8, { taskKind: "subagent" }),
			row("nested", 7, { parentTaskId: "newest" }),
			row("empty", 6, { task: "" }),
			row("orphan", 5, { parentTaskId: "missing" }),
			row("independent", 4, { orchestrationParentTaskId: "newest" }),
		]
		expect(navigator.select(rows, "newest", -1, context)).toBe("orphan")
		expect(navigator.select(rows, "orphan", -1, context)).toBe("independent")
	})

	it("skips chats deleted or archived during a walk without replacing its order", () => {
		const navigator = new TaskHistoryNavigator()
		expect(navigator.select(history, "newest", -1, context)).toBe("middle")
		const changed = [row("newest", 3), row("middle", 2, { archived: true }), row("oldest", 1)]
		expect(navigator.select(changed, "middle", -1, context)).toBe("oldest")
		expect(navigator.select(changed, "oldest", 1, context)).toBe("newest")
	})

	it("starts at the newest chat from a blank view and handles empty or single-chat histories", () => {
		const navigator = new TaskHistoryNavigator()
		expect(navigator.select([], undefined, -1, context)).toBeUndefined()
		navigator.reset()
		expect(navigator.select([row("only", 1)], undefined, -1, context)).toBe("only")
		expect(navigator.select([row("only", 1)], "only", -1, context)).toBeUndefined()
		expect(navigator.select([row("only", 1)], "only", 1, context)).toBeUndefined()
	})
})
