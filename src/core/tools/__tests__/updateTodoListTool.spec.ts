import { describe, it, expect, beforeEach, vi } from "vitest"
import {
	parseMarkdownChecklist,
	setTodoListForTask,
	setPendingTodoList,
	updateTodoListTool,
} from "../UpdateTodoListTool"
import { TodoItem, type TaskWorkPlan } from "@alpha-code/types"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"

describe("TODO approval isolation", () => {
	function harness() {
		const task = {
			taskId: "task",
			todoList: [],
			say: vi.fn(),
			providerRef: { deref: () => undefined },
		} as unknown as Task
		const callbacks = {
			askApproval: vi.fn<ToolCallbacks["askApproval"]>().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		return { task, callbacks }
	}

	it("accepts only validated edits for the addressed pending approval", async () => {
		const { task, callbacks } = harness()
		const edited: TodoItem[] = [{ id: "edited", content: "Human edit", status: "pending" }]
		let approvalId = ""
		callbacks.askApproval.mockImplementation(async (_kind, message) => {
			approvalId = JSON.parse(message!).approvalId
			expect(setPendingTodoList(task, { approvalId: "stale", todos: edited })).toBe(false)
			expect(setPendingTodoList(task, { approvalId, todos: [{ ...edited[0], status: "invalid" }] })).toBe(false)
			expect(setPendingTodoList(task, { approvalId, todos: [edited[0], edited[0]] })).toBe(false)
			expect(setPendingTodoList(task, { approvalId, todos: edited })).toBe(true)
			return true
		})
		await updateTodoListTool.execute({ todos: "- [ ] Original" }, task, callbacks)
		expect(task.todoList).toEqual(edited)
		expect(task.say).toHaveBeenCalledWith("user_edit_todos", expect.stringContaining("Human edit"))
		expect(setPendingTodoList(task, { approvalId, todos: [] })).toBe(false)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it.each(["denied", "cancelled", "task-aborted", "error"] as const)(
		"discards pending edits after %s",
		async (outcome) => {
			const { task, callbacks } = harness()
			const controller = new AbortController()
			let approvalId = ""
			callbacks.askApproval.mockImplementation(async (_kind, message) => {
				approvalId = JSON.parse(message!).approvalId
				if (outcome === "cancelled") {
					controller.abort()
					expect(setPendingTodoList(task, { approvalId, todos: [] })).toBe(false)
				}
				if (outcome === "task-aborted") task.abort = true
				if (outcome === "error") throw new Error("Approval failed")
				return outcome !== "denied"
			})
			await updateTodoListTool.execute({ todos: "- [ ] Original" }, task, {
				...callbacks,
				signal: controller.signal,
			})
			expect(task.todoList).toEqual([])
			expect(setPendingTodoList(task, { approvalId, todos: [] })).toBe(false)
			if (outcome !== "error")
				expect(callbacks.setResultMetadata).toHaveBeenCalledWith({
					status: outcome === "denied" ? "denied" : "cancelled",
				})
		},
	)

	it("rejects an earlier invocation's approval ID in a later invocation of the same task", async () => {
		const { task, callbacks } = harness()
		let oldId = ""
		callbacks.askApproval.mockImplementationOnce(async (_kind, message) => {
			oldId = JSON.parse(message!).approvalId
			return false
		})
		await updateTodoListTool.execute({ todos: "- [ ] First" }, task, callbacks)
		callbacks.askApproval.mockImplementationOnce(async (_kind, message) => {
			expect(JSON.parse(message!).approvalId).not.toBe(oldId)
			expect(setPendingTodoList(task, { approvalId: oldId, todos: [] })).toBe(false)
			return true
		})
		await updateTodoListTool.execute({ todos: "- [ ] Second" }, task, callbacks)
		expect(task.todoList?.map((todo) => todo.content)).toEqual(["Second"])
	})

	it("keeps concurrent tasks' proposals separate while approval is pending", async () => {
		const makeTask = (taskId: string) =>
			({ taskId, todoList: [], say: vi.fn(), providerRef: { deref: () => undefined } }) as unknown as Task
		const first = makeTask("first")
		const second = makeTask("second")
		let approveFirst!: (approved: boolean) => void
		const firstApproval = new Promise<boolean>((resolve) => {
			approveFirst = resolve
		})
		const callbacks: ToolCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		}
		const firstRun = updateTodoListTool.execute({ todos: "- [ ] First task work" }, first, {
			...callbacks,
			askApproval: () => firstApproval,
		})
		await updateTodoListTool.execute({ todos: "- [ ] Second task work" }, second, callbacks)
		approveFirst(true)
		await firstRun
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(first.todoList?.map((todo) => todo.content)).toEqual(["First task work"])
		expect(second.todoList?.map((todo) => todo.content)).toEqual(["Second task work"])
	})
})

describe("optional work_plan", () => {
	const workPlan: TaskWorkPlan = {
		objective: "Implement the change",
		constraints: ["Preserve public API"],
		notes: [],
		checks: [
			{
				id: "behavior",
				description: "Run the focused unit test",
				command: "pnpm --dir src test src/core/tools/__tests__/updateTodoListTool.spec.ts",
				cwd: null,
				paths: ["src/core/tools/UpdateTodoListTool.ts"],
				reusable: true,
			},
		],
	}

	function harness() {
		const task = {
			taskId: "task",
			todoList: [],
			say: vi.fn(),
			providerRef: { deref: () => undefined },
			updateWorkPlan: vi.fn().mockResolvedValue(undefined),
		} as unknown as Task
		const callbacks = {
			askApproval: vi.fn<ToolCallbacks["askApproval"]>().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		return { task, callbacks }
	}

	it("does not set a work plan or acceptance checks when called with todos only", async () => {
		const { task, callbacks } = harness()

		await updateTodoListTool.execute({ todos: "[ ] Look up the handler" }, task, callbacks)

		expect(task.updateWorkPlan).not.toHaveBeenCalled()
		expect(task.todoList?.map((todo) => todo.content)).toEqual(["Look up the handler"])
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("does not set a work plan when work_plan is null", async () => {
		const { task, callbacks } = harness()

		await updateTodoListTool.execute({ todos: "[ ] Look up the handler", work_plan: null }, task, callbacks)

		expect(task.updateWorkPlan).not.toHaveBeenCalled()
		expect(task.todoList?.map((todo) => todo.content)).toEqual(["Look up the handler"])
	})

	it("still records a work plan with acceptance checks when supplied", async () => {
		const { task, callbacks } = harness()

		await updateTodoListTool.execute(
			{
				todos: "[-] Implement the change\n[ ] Run required checks",
				work_plan: workPlan,
			},
			task,
			callbacks,
		)

		expect(task.updateWorkPlan).toHaveBeenCalledExactlyOnceWith(workPlan)
		expect(task.todoList?.map((todo) => todo.content)).toEqual(["Implement the change", "Run required checks"])
	})
})

describe("parseMarkdownChecklist", () => {
	describe("standard checkbox format (without dash prefix)", () => {
		it("should parse pending tasks", () => {
			const md = `[ ] Task 1
[ ] Task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Task 1")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Task 2")
			expect(result[1].status).toBe("pending")
		})

		it("should parse completed tasks with lowercase x", () => {
			const md = `[x] Completed task 1
[x] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse completed tasks with uppercase X", () => {
			const md = `[X] Completed task 1
[X] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse in-progress tasks with dash", () => {
			const md = `[-] In progress task 1
[-] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})

		it("should parse in-progress tasks with tilde", () => {
			const md = `[~] In progress task 1
[~] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})
	})

	describe("dash-prefixed checkbox format", () => {
		it("should parse pending tasks with dash prefix", () => {
			const md = `- [ ] Task 1
- [ ] Task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Task 1")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Task 2")
			expect(result[1].status).toBe("pending")
		})

		it("should parse completed tasks with dash prefix and lowercase x", () => {
			const md = `- [x] Completed task 1
- [x] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse completed tasks with dash prefix and uppercase X", () => {
			const md = `- [X] Completed task 1
- [X] Completed task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Completed task 1")
			expect(result[0].status).toBe("completed")
			expect(result[1].content).toBe("Completed task 2")
			expect(result[1].status).toBe("completed")
		})

		it("should parse in-progress tasks with dash prefix and dash marker", () => {
			const md = `- [-] In progress task 1
- [-] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})

		it("should parse in-progress tasks with dash prefix and tilde marker", () => {
			const md = `- [~] In progress task 1
- [~] In progress task 2`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("In progress task 1")
			expect(result[0].status).toBe("in_progress")
			expect(result[1].content).toBe("In progress task 2")
			expect(result[1].status).toBe("in_progress")
		})
	})

	describe("mixed formats", () => {
		it("should parse mixed formats correctly", () => {
			const md = `[ ] Task without dash
- [ ] Task with dash
[x] Completed without dash
- [X] Completed with dash
[-] In progress without dash
- [~] In progress with dash`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(6)

			expect(result[0].content).toBe("Task without dash")
			expect(result[0].status).toBe("pending")

			expect(result[1].content).toBe("Task with dash")
			expect(result[1].status).toBe("pending")

			expect(result[2].content).toBe("Completed without dash")
			expect(result[2].status).toBe("completed")

			expect(result[3].content).toBe("Completed with dash")
			expect(result[3].status).toBe("completed")

			expect(result[4].content).toBe("In progress without dash")
			expect(result[4].status).toBe("in_progress")

			expect(result[5].content).toBe("In progress with dash")
			expect(result[5].status).toBe("in_progress")
		})
	})

	describe("edge cases", () => {
		it("should handle empty strings", () => {
			const result = parseMarkdownChecklist("")
			expect(result).toEqual([])
		})

		it("should handle non-string input", () => {
			const result = parseMarkdownChecklist(null as any)
			expect(result).toEqual([])
		})

		it("should handle undefined input", () => {
			const result = parseMarkdownChecklist(undefined as any)
			expect(result).toEqual([])
		})

		it("should ignore non-checklist lines", () => {
			const md = `This is not a checklist
[ ] Valid task
Just some text
- Not a checklist item
- [x] Valid completed task
[not valid] Invalid format`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(2)
			expect(result[0].content).toBe("Valid task")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Valid completed task")
			expect(result[1].status).toBe("completed")
		})

		it("should handle extra spaces", () => {
			const md = `  [ ]   Task with spaces
-  [ ]  Task with dash and spaces
  [x]  Completed with spaces
-   [X]   Completed with dash and spaces`
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(4)
			expect(result[0].content).toBe("Task with spaces")
			expect(result[1].content).toBe("Task with dash and spaces")
			expect(result[2].content).toBe("Completed with spaces")
			expect(result[3].content).toBe("Completed with dash and spaces")
		})

		it("should handle Windows line endings", () => {
			const md = "[ ] Task 1\r\n- [x] Task 2\r\n[-] Task 3"
			const result = parseMarkdownChecklist(md)
			expect(result).toHaveLength(3)
			expect(result[0].content).toBe("Task 1")
			expect(result[0].status).toBe("pending")
			expect(result[1].content).toBe("Task 2")
			expect(result[1].status).toBe("completed")
			expect(result[2].content).toBe("Task 3")
			expect(result[2].status).toBe("in_progress")
		})
	})

	describe("ID generation", () => {
		it("should generate consistent IDs for the same content and status", () => {
			const md1 = `[ ] Task 1
[x] Task 2`
			const md2 = `[ ] Task 1
[x] Task 2`
			const result1 = parseMarkdownChecklist(md1)
			const result2 = parseMarkdownChecklist(md2)

			expect(result1[0].id).toBe(result2[0].id)
			expect(result1[1].id).toBe(result2[1].id)
		})

		it("should generate different IDs for different content", () => {
			const md = `[ ] Task 1
[ ] Task 2`
			const result = parseMarkdownChecklist(md)
			expect(result[0].id).not.toBe(result[1].id)
		})

		it("should generate different IDs for same content but different status", () => {
			const md = `[ ] Task 1
[x] Task 1`
			const result = parseMarkdownChecklist(md)
			expect(result[0].id).not.toBe(result[1].id)
		})

		it("should generate same IDs regardless of dash prefix", () => {
			const md1 = `[ ] Task 1`
			const md2 = `- [ ] Task 1`
			const result1 = parseMarkdownChecklist(md1)
			const result2 = parseMarkdownChecklist(md2)
			expect(result1[0].id).toBe(result2[0].id)
		})
	})
})

describe("setTodoListForTask", () => {
	it("publishes a targeted todo update", async () => {
		const postTaskTodosToWebview = vi.fn().mockResolvedValue(undefined)
		const task = {
			taskId: "task-1",
			todoList: [],
			providerRef: { deref: () => ({ postTaskTodosToWebview }) },
		} as any
		const todos: TodoItem[] = [{ id: "todo-1", content: "Verify performance", status: "in_progress" }]

		await setTodoListForTask(task, todos)

		expect(task.todoList).toEqual(todos)
		expect(postTaskTodosToWebview).toHaveBeenCalledWith("task-1", todos)
	})
})
