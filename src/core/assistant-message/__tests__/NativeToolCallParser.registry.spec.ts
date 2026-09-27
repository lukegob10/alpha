import { afterEach, describe, expect, it, vi } from "vitest"

import { NativeToolCallParser } from "../NativeToolCallParser"
import { createAgentResponse } from "../../agent/AgentResponse"
import { ToolScheduler } from "../../agent/ToolScheduler"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../../tools/BaseTool"
import { executeCommandTool } from "../../tools/ExecuteCommandTool"
import { manageCommandTool } from "../../tools/ManageCommandTool"
import { commandSessionRegistry } from "../../tools/CommandSessionRegistry"
import { requestUserInputTool } from "../../tools/RequestUserInputTool"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { discoverTools, toolSearch } from "../../prompts/tools/native-tools/discover_tools"
import { updateTodoListTool } from "../../tools/UpdateTodoListTool"
import type { CrossTaskOrchestrationProvider } from "../../webview/CrossTaskOrchestration"
import { getNativeTools } from "../../prompts/tools/native-tools"
import type { ToolUse } from "../../../shared/tools"

afterEach(() => {
	vi.restoreAllMocks()
	NativeToolCallParser.clearAllStreamingToolCalls()
})

function callbacks(): ToolCallbacks {
	return {
		askApproval: vi.fn(),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
	} as unknown as ToolCallbacks
}

function parseToolUse(name: string, args: Record<string, unknown>): ToolUse {
	const result = NativeToolCallParser.parseToolCall({
		id: `action-${name}`,
		name: name as ToolUse["name"],
		arguments: JSON.stringify(args),
	})
	expect(result?.type).toBe("tool_use")
	return result as ToolUse
}

describe("NativeToolCallParser registry dispatch", () => {
	it.each([
		{ name: "tool_search", args: { query: "calendar", limit: 8 }, expectedLimit: 8 },
		{ name: "discover_tools", args: { query: "calendar", limit: 5 }, expectedLimit: 5 },
	] as const)(
		"dispatches $name through the canonical tool_search descriptor",
		async ({ name, args, expectedLimit }) => {
			const call = parseToolUse(name, args)
			Object.assign(call, { id: `action-${name}` })
			const search = vi.fn((params: { query: string; limit: number }) => JSON.stringify(params))
			const registry = new ToolRegistry({
				nativeTools: [toolSearch, discoverTools],
				discovery: { execute: search, maxOutputChars: 24_000 },
			})
			const descriptor = registry.resolve(call.name)
			const toolCallbacks = callbacks()

			expect(call.id).toBe(`action-${name}`)
			expect(call.name).toBe("tool_search")
			expect(call.originalName).toBe(name === "tool_search" ? undefined : "discover_tools")
			expect(descriptor?.name).toBe("tool_search")
			await descriptor!.execute({ task: {} as Task, call, callbacks: toolCallbacks })

			expect(search).toHaveBeenCalledWith({ query: "calendar", limit: expectedLimit }, undefined)
			expect(toolCallbacks.pushToolResult).toHaveBeenCalledWith(
				JSON.stringify({ query: "calendar", limit: expectedLimit }),
			)
		},
	)

	it("parses persisted read_file calls without registering a legacy executor", () => {
		const args = { path: "src/legacy.ts", offset: 0, limit: 24 }
		const call = parseToolUse("read_file", args)
		const currentSchemas = getNativeTools()
		const currentNames = currentSchemas.flatMap((schema) =>
			schema.type === "function" ? [schema.function.name] : [],
		)
		const registry = new ToolRegistry({ nativeTools: currentSchemas })

		expect(currentNames).not.toContain("read_file")
		expect(call.name).toBe("read_file")
		expect(call.nativeArgs).toEqual(args)
		expect(registry.resolve(call.name)).toBeUndefined()
	})

	it.each([
		["list_mcp_resources", { server: "docs", cursor: "page-2" }],
		["list_mcp_resource_templates", {}],
		["read_mcp_resource", { server: "docs", uri: "doc://one" }],
	] as const)("parses and resolves the current %s tool", (name, args) => {
		const call = parseToolUse(name, args)
		const registry = new ToolRegistry({ nativeTools: getNativeTools({ mcpResourcesAvailable: true }) })
		expect(call.nativeArgs).toEqual(
			name === "list_mcp_resource_templates" ? { server: undefined, cursor: undefined } : args,
		)
		expect(registry.resolve(call.name)?.name).toBe(name)
	})

	it("parses saved resource access without advertising its retired schema", () => {
		const call = parseToolUse("access_mcp_resource", { server_name: "docs", uri: "doc://one" })
		expect(call.nativeArgs).toEqual({ server_name: "docs", uri: "doc://one" })
		expect(new ToolRegistry().resolve(call.name)).toBeUndefined()
	})

	it("accepts the current spawn_agent agent_type field without reporting it as unknown", () => {
		const args = {
			task_name: "outer_worker",
			message: "Inspect the task and report your findings.",
			agent_type: "worker",
			fork_turns: "none",
		}
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		const call = parseToolUse("spawn_agent", args)

		expect(warning).not.toHaveBeenCalled()
		expect(call.params.agent_type).toBe(args.agent_type)
		expect(call.nativeArgs).toEqual(args)
	})

	it("dispatches parsed exec_command through the canonical registry descriptor", async () => {
		const args = {
			cmd: "pnpm --version",
			workdir: "src",
			yield_time_ms: 10_000,
			max_output_tokens: 128,
			verification: { change_set_ids: ["applied-change-set"] },
		}
		const call = parseToolUse("exec_command", args)
		const taskResults: unknown[] = []
		const task = {
			abort: false,
			taskId: "native-parser-command",
			cwd: process.cwd(),
			providerRef: { deref: () => undefined },
			didToolFailInCurrentTurn: false,
			userMessageContent: taskResults,
			userMessageContentReady: false,
			async ask() {
				return { response: "yesButtonClicked" as const }
			},
			async say() {},
			recordToolUsage: vi.fn(),
			pushToolResultToUserContent(result: unknown) {
				taskResults.push(result)
				return true
			},
		} as unknown as Task
		const execute = vi.spyOn(executeCommandTool, "execute").mockResolvedValue(undefined)
		const registry = new ToolRegistry()
		const descriptor = registry.resolve("exec_command")
		expect(descriptor?.name).toBe("exec_command")

		const response = createAgentResponse([
			{
				type: "tool_call",
				id: "action-exec-command",
				name: call.originalName ?? call.name,
				arguments: call.nativeArgs,
			},
		])
		const outcome = await new ToolScheduler({ task, registry, mode: "code", validateCall: () => {} }).run(response)

		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0].status, JSON.stringify(outcome.results[0])).toBe("success")
		expect(outcome.results[0]).toMatchObject({
			callId: "action-exec-command",
			name: "exec_command",
			status: "success",
		})
		expect(execute).toHaveBeenCalledOnce()
		expect(execute.mock.calls[0][0]).toEqual({
			command: args.cmd,
			cwd: args.workdir,
			timeout: 10,
			verification: args.verification,
		})
		expect(execute.mock.calls[0][2].commandResultMaxOutputTokens).toBe(args.max_output_tokens)
		expect(execute.mock.calls[0][2].commandResultFormat).toBe("codex")
	})

	it("routes parsed write_stdin input to the task command adapter", async () => {
		const args = { session_id: 42, chars: "yes\n", yield_time_ms: 1_200, max_output_tokens: 256 }
		const call = parseToolUse("write_stdin", args)
		const execute = vi.spyOn(manageCommandTool, "execute").mockResolvedValue(undefined)
		vi.spyOn(commandSessionRegistry, "resolve").mockReturnValue({
			executionId: "physical-execution-42",
			process: {} as never,
		})
		const descriptor = new ToolRegistry().resolve(call.name)
		expect(descriptor?.name).toBe("write_stdin")

		await descriptor!.execute({ task: {} as Task, call, callbacks: callbacks() })

		expect(execute).toHaveBeenCalledOnce()
		expect(execute.mock.calls[0][0]).toEqual({
			execution_id: "physical-execution-42",
			action: "input",
			input: args.chars,
			timeout_ms: args.yield_time_ms,
		})
		expect(execute.mock.calls[0][2].commandResultMaxOutputTokens).toBe(args.max_output_tokens)
	})

	it("passes update_plan payload unchanged to the canonical plan handler", async () => {
		const args = {
			explanation: "The first step is underway.",
			plan: [{ step: "Inspect the parser", status: "in_progress" as const }],
		}
		const call = parseToolUse("update_plan", args)
		const execute = vi.spyOn(updateTodoListTool, "execute").mockResolvedValue(undefined)
		const descriptor = new ToolRegistry().resolve(call.name)
		expect(descriptor?.name).toBe("update_plan")

		await descriptor!.execute({ task: {} as Task, call, callbacks: callbacks() })

		expect(execute).toHaveBeenCalledOnce()
		expect(execute.mock.calls[0][0]).toEqual(args)
	})

	it("dispatches saved update_todo_list payloads through the same canonical plan handler", async () => {
		const args = { todos: "[-] Preserve a saved checklist", work_plan: null }
		const call = parseToolUse("update_todo_list", args)
		const execute = vi.spyOn(updateTodoListTool, "execute").mockResolvedValue(undefined)
		const descriptor = new ToolRegistry().resolve(call.name)
		expect(call.name).toBe("update_plan")
		expect(call.originalName).toBe("update_todo_list")
		expect(descriptor?.name).toBe("update_plan")

		await descriptor!.execute({ task: {} as Task, call, callbacks: callbacks() })

		expect(execute).toHaveBeenCalledOnce()
		expect(execute.mock.calls[0][0]).toEqual(args)
	})

	it("dispatches parsed request_user_input to its registered user-input handler", async () => {
		const args = {
			questions: [
				{
					id: "provider_choice",
					header: "Provider",
					question: "Which provider should run this request?",
					options: [
						{ label: "OpenAI", description: "Use the OpenAI provider." },
						{ label: "Claude", description: "Use the Claude provider." },
					],
				},
			],
		}
		const call = parseToolUse("request_user_input", args)
		expect(call.params.questions).toBe(JSON.stringify(args.questions))
		const handle = vi.spyOn(requestUserInputTool, "handle").mockResolvedValue(undefined)
		const descriptor = new ToolRegistry({ nativeTools: getNativeTools({ planMode: true }) }).resolve(call.name)
		expect(descriptor?.name).toBe("request_user_input")
		const toolCallbacks = callbacks()

		await descriptor!.execute({ task: {} as Task, call, callbacks: toolCallbacks })

		expect(handle).toHaveBeenCalledOnce()
		expect(handle).toHaveBeenCalledWith(expect.anything(), call, expect.objectContaining(toolCallbacks))
	})

	it("dispatches parsed cross-task tools through their registered host adapters", async () => {
		const provider = {
			createIndependentTask: vi.fn(
				async (_parent: Task, objective: string, workspaceMode: "shared" | "worktree") => ({
					task_id: "child-1",
					objective,
					lifecycle: "running" as const,
					workspace_mode: workspaceMode,
					updated_at: 1,
				}),
			),
			listIndependentTasks: vi.fn(async () => []),
			waitForIndependentTask: vi.fn(async (_parent: Task, taskId: string) => ({
				task_id: taskId,
				lifecycle: "completed" as const,
				result: "done",
			})),
			sendIndependentTaskMessage: vi.fn(async (_sender: Task, taskId: string) => ({
				task_id: taskId,
				status: "queued",
			})),
			steerIndependentTask: vi.fn(async (_parent: Task, taskId: string) => ({
				task_id: taskId,
				status: "steered",
			})),
			stopIndependentTask: vi.fn(async (_parent: Task, taskId: string) => ({
				task_id: taskId,
				status: "stopped",
			})),
		} satisfies CrossTaskOrchestrationProvider
		const task = {
			taskId: "parent-1",
			taskKind: "primary",
			providerRef: new WeakRef(provider),
		} as unknown as Task
		const results: string[] = []
		const toolCallbacks: ToolCallbacks = {
			askApproval: vi.fn(async () => true),
			handleError: vi.fn(async () => undefined),
			pushToolResult: vi.fn((content) => results.push(String(content))),
			setResultMetadata: vi.fn(),
		}
		const registry = new ToolRegistry({ nativeTools: getNativeTools({ crossTaskRole: "root" }) })
		const invocations: Array<[string, Record<string, unknown>]> = [
			["create_task", { objective: "Inspect the parser", workspace_mode: "worktree" }],
			["list_tasks", {}],
			["wait_task", { task_id: "child-1", timeout_ms: null }],
			["send_task_message", { task_id: "child-1", message: "Keep the report concise." }],
			["steer_task", { task_id: "child-1", message: "Focus on parser recovery." }],
			["stop_task", { task_id: "child-1", reason: null }],
		]

		for (const [name, args] of invocations) {
			const call = parseToolUse(name, args)
			const descriptor = registry.resolve(name)
			expect(descriptor?.name).toBe(name)
			await descriptor!.execute({ task, call, callbacks: toolCallbacks })
		}

		expect(provider.createIndependentTask).toHaveBeenCalledWith(task, "Inspect the parser", "worktree", undefined)
		expect(provider.listIndependentTasks).toHaveBeenCalledWith(task)
		expect(provider.waitForIndependentTask).toHaveBeenCalledWith(task, "child-1", 30_000, undefined)
		expect(provider.sendIndependentTaskMessage).toHaveBeenCalledWith(task, "child-1", "Keep the report concise.")
		expect(provider.steerIndependentTask).toHaveBeenCalledWith(task, "child-1", "Focus on parser recovery.")
		expect(provider.stopIndependentTask).toHaveBeenCalledWith(task, "child-1", undefined)
		expect(toolCallbacks.askApproval).toHaveBeenCalledTimes(4)
		expect(results).toHaveLength(6)
	})
})
