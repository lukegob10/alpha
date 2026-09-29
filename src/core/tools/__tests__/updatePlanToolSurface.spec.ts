import { describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { createAgentResponse } from "../../agent/AgentResponse"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { createTaskToolSurface } from "../TaskToolSurface"
import { ToolRegistry } from "../ToolRegistry"

describe("update_plan tool surface", () => {
	it.each(["code", "architect"])(
		"dispatches saved plan compatibility only through the %s action surface",
		async (mode) => {
			const schemas = getNativeTools({ planMode: mode === "architect" })
			const registry = new ToolRegistry({ nativeTools: schemas })
			const surface = createTaskToolSurface({ registry, schemas, mode })
			const isPlan = mode === "architect"
			expect(schemas.some((schema) => schema.type === "function" && schema.function.name === "update_plan")).toBe(
				!isPlan,
			)
			expect(
				schemas.some((schema) => schema.type === "function" && schema.function.name === "update_todo_list"),
			).toBe(false)
			if (isPlan) {
				expect(registry.resolve("update_plan")).toBeUndefined()
				expect(surface.allowedFunctionNames).not.toContain("update_plan")
				expect(surface.policy.allowedTools).not.toContain("update_plan")
				expect(surface.resolve("update_plan")).toBeUndefined()
				return
			}
			expect(registry.resolve("update_plan")?.name).toBe("update_plan")
			expect(registry.resolve("update_todo_list")?.name).toBe("update_plan")
			expect(registry.getSchema("update_plan")).toMatchObject({
				function: {
					name: "update_plan",
					strict: false,
					parameters: { required: ["plan"], properties: { explanation: { type: "string" } } },
				},
			})
			expect(surface.allowedFunctionNames).toContain("update_plan")
			expect(surface.allowedFunctionNames).not.toContain("update_todo_list")
			expect(surface.policy.allowedTools).toContain("update_plan")
			const userMessageContent: ToolExecutionHost["userMessageContent"] = []
			const task = {
				taskId: "update-plan-contract",
				cwd: process.cwd(),
				abort: false,
				didToolFailInCurrentTurn: false,
				consecutiveMistakeCount: 0,
				todoList: [],
				providerRef: { deref: () => undefined },
				askKind: "primary",
				recordToolError: vi.fn(),
				updateWorkPlan: vi.fn(),
				ask: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
				say: vi.fn(async () => undefined),
				recordToolUsage: vi.fn(),
			} as unknown as Task
			const host: ToolExecutionHost = {
				taskId: task.taskId,
				cwd: task.cwd,
				taskFacade: task,
				userMessageContent,
				ask: async () => ({ response: "yesButtonClicked" }),
				say: async () => undefined,
				recordToolUsage: vi.fn(),
				pushToolResultToUserContent: (result) => {
					userMessageContent.push(result)
					return true
				},
			}
			const scheduler = new ToolScheduler({
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode,
			})

			const planOutcome = await scheduler.run(
				createAgentResponse([
					{
						type: "tool_call",
						id: "new-plan-call",
						name: "update_plan",
						arguments: { plan: [{ step: "Implement contract", status: "in_progress" }] },
					},
				]),
			)

			expect(planOutcome.results[0]).toMatchObject({
				callId: "new-plan-call",
				name: "update_plan",
				status: "success",
			})
			expect(task.todoList).toEqual([
				expect.objectContaining({ content: "Implement contract", status: "in_progress" }),
			])
			expect(task.updateWorkPlan).not.toHaveBeenCalled()

			const legacyOutcome = await scheduler.run(
				createAgentResponse([
					{
						type: "tool_call",
						id: "saved-todo-call",
						name: "update_todo_list",
						arguments: { todos: "[ ] Preserve the saved transcript" },
					},
				]),
			)
			expect(legacyOutcome.results[0]).toMatchObject({
				callId: "saved-todo-call",
				name: "update_todo_list",
				status: "success",
			})
			expect(
				userMessageContent.flatMap((result) => (result.type === "tool_result" ? [result.tool_use_id] : [])),
			).toEqual(["new-plan-call", "saved-todo-call"])
			expect(task.todoList).toEqual([
				expect.objectContaining({ content: "Preserve the saved transcript", status: "pending" }),
			])
		},
	)
})
