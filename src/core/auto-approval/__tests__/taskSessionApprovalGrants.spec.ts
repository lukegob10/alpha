import { describe, expect, it } from "vitest"

import {
	clearTaskSessionApprovalGrants,
	createTaskSessionApprovalKey,
	grantTaskSessionApproval,
	hasTaskSessionApproval,
} from "../taskSessionApprovalGrants"

const identity = (overrides: Partial<Parameters<typeof createTaskSessionApprovalKey>[0]> = {}) => ({
	taskId: "task-1",
	toolName: "execute_command",
	askType: "command" as const,
	description: "git status --short",
	argumentsValue: { command: "git status --short", cwd: "." },
	cwd: "C:/workspace",
	...overrides,
})

describe("task-scoped exact approval grants", () => {
	it("binds a grant to the task, exact command, complete arguments, and cwd", () => {
		const key = createTaskSessionApprovalKey(identity())!
		expect(createTaskSessionApprovalKey(identity({ cwd: undefined }))).toBeUndefined()
		const controller = new AbortController()
		expect(grantTaskSessionApproval(key, "task-1", controller.signal)).toBe(true)

		expect(hasTaskSessionApproval(createTaskSessionApprovalKey(identity())!)).toBe(true)
		expect(hasTaskSessionApproval(createTaskSessionApprovalKey(identity({ description: "git diff" }))!)).toBe(false)
		expect(
			hasTaskSessionApproval(
				createTaskSessionApprovalKey(
					identity({ argumentsValue: { command: "git status --short", cwd: "../other" } }),
				)!,
			),
		).toBe(false)
		expect(hasTaskSessionApproval(createTaskSessionApprovalKey(identity({ cwd: "C:/other" }))!)).toBe(false)
		expect(hasTaskSessionApproval(createTaskSessionApprovalKey(identity({ policyDigest: "new-policy" }))!)).toBe(
			false,
		)
		expect(hasTaskSessionApproval(createTaskSessionApprovalKey(identity({ taskId: "task-2" }))!)).toBe(false)
		expect(hasTaskSessionApproval(createTaskSessionApprovalKey(identity({ policyDigest: "new-policy" }))!)).toBe(
			false,
		)

		clearTaskSessionApprovalGrants("task-1")
	})

	it("does not grant an approval after cancellation", () => {
		const key = createTaskSessionApprovalKey(identity())!
		const controller = new AbortController()
		controller.abort(new Error("cancelled"))

		expect(grantTaskSessionApproval(key, "task-1", controller.signal)).toBe(false)
		expect(hasTaskSessionApproval(key)).toBe(false)
	})

	it("evicts the oldest grant at the fixed session cap", () => {
		const controller = new AbortController()
		const keys = Array.from({ length: 129 }, (_, index) => {
			const taskId = `bounded-task-${index}`
			const key = createTaskSessionApprovalKey(identity({ taskId }))!
			expect(grantTaskSessionApproval(key, taskId, controller.signal)).toBe(true)
			return key
		})

		expect(hasTaskSessionApproval(keys[0]!)).toBe(false)
		expect(hasTaskSessionApproval(keys.at(-1)!)).toBe(true)
		for (let index = 1; index < 129; index += 1) {
			clearTaskSessionApprovalGrants(`bounded-task-${index}`)
		}
	})
})
