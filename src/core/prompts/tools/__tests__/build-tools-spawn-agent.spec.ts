import { vi } from "vitest"

vi.mock("../../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({
			isFeatureEnabled: false,
			isFeatureConfigured: false,
			isInitialized: false,
		}),
	},
}))

import { buildNativeToolsArrayWithRestrictions } from "../../../task/build-tools"
import { Task } from "../../../task/Task"

const names = (tools: Array<{ type: string; function?: { name: string } }>) =>
	tools.flatMap((tool) => (tool.type === "function" && tool.function ? [tool.function.name] : []))

describe("buildNativeToolsArrayWithRestrictions - asynchronous spawning", () => {
	const orchestrationTools = [
		"spawn_agent",
		"list_agents",
		"wait_agent",
		"send_message",
		"followup_task",
		"interrupt_agent",
		"cancel_agent",
		"close_agent",
	]
	const provider = {
		context: {},
		getMcpHub: () => ({ getServers: () => [] }),
	} as any
	const managedChildAllowedTools = (delegate: boolean) =>
		Task.prototype.getTaskAllowedToolNames.call({
			taskKind: "subagent",
			subagentRole: "review",
			subagentContextManifest: {
				skills: [],
				runtimePolicy: {
					delegate,
					allowedTools: delegate
						? ["read_file", ...orchestrationTools, "attempt_completion"]
						: ["read_file", "attempt_completion"],
				},
			},
		} as unknown as Task)

	it("keeps a stable primary Code lifecycle catalog before managed-agent activity", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "F:/workspace",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			includeAllToolsWithRestrictions: true,
			taskKind: "primary",
		})

		expect(names(result.tools as any)).toContain("spawn_agent")
		expect(names(result.tools as any)).toContain("delegate_task")
		expect(names(result.tools as any)).not.toContain("report_progress")
		expect(result.allowedFunctionNames).toContain("spawn_agent")
		expect(result.allowedFunctionNames).not.toContain("report_progress")
		for (const tool of orchestrationTools) {
			expect(names(result.tools as any)).toContain(tool)
			expect(result.allowedFunctionNames).toContain(tool)
		}
		const nativeTools = result.tools as Array<{
			function?: {
				name: string
				description?: string
				parameters?: { required?: string[]; properties?: Record<string, unknown> }
			}
		}>
		const newTaskDescription = nativeTools.find((tool) => tool.function?.name === "new_task")?.function?.description
		expect(newTaskDescription).toContain("blocking mode/task handoff")
		expect(newTaskDescription).toContain("suspends the caller")
		expect(newTaskDescription).toContain("resumes it with the child result")
		expect(newTaskDescription).not.toContain("wait_agent")

		const spawnTool = nativeTools.find((tool) => tool.function?.name === "spawn_agent")
		expect(spawnTool?.function?.description).toContain("asynchronously")
		expect(spawnTool?.function?.description).toContain("return its handle immediately")
		expect(spawnTool?.function?.description).toContain(
			"Collect terminal results through wait_agent as native tool results",
		)
		expect(spawnTool?.function?.parameters?.required).toEqual(expect.arrayContaining(["task_name", "fork_turns"]))
		expect(spawnTool?.function?.parameters?.properties).toHaveProperty("fork_turns")
		const delegateTool = nativeTools.find((tool) => tool.function?.name === "delegate_task")
		expect(delegateTool?.function?.description).toContain("one blocking delegation group")
		expect(delegateTool?.function?.description).toContain("one structured group result")
		expect(delegateTool?.function?.description).toContain("quarantined proposal")
		expect(delegateTool?.function?.description).not.toContain("handle immediately")
		const delegateTask = (delegateTool?.function?.parameters as any)?.properties?.tasks?.items
		expect(delegateTask?.required).toEqual(expect.arrayContaining(["objective", "fork_turns", "agent_kind"]))
		expect(delegateTask?.properties?.fork_turns).toMatchObject({
			pattern: "^(?:none|all|[1-9][0-9]*)$",
			maxLength: 16,
		})

		const completionTool = nativeTools.find((tool) => tool.function?.name === "attempt_completion")
		expect(completionTool?.function?.parameters?.properties).not.toHaveProperty("outcome")
		expect(completionTool?.function?.description).not.toContain("sub-agents only")
		const waitTool = (result.tools as any[]).find((tool) => tool.function?.name === "wait_agent")
		expect(waitTool?.function?.description).toContain("sender task/path provenance")
		expect(waitTool?.function?.description).toContain("only after this tool result is persisted")
		expect(names(result.tools as any)).not.toContain("report_progress")
	})

	it("keeps delegation entry points while trimming idle lifecycle controls", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "F:/workspace",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			includeAllToolsWithRestrictions: true,
			taskKind: "primary",
			enableAgentLifecycleTools: false,
		})

		expect(names(result.tools as any)).toContain("spawn_agent")
		expect(names(result.tools as any)).toContain("delegate_task")
		for (const tool of orchestrationTools.filter((tool) => tool !== "spawn_agent")) {
			expect(names(result.tools as any)).not.toContain(tool)
			expect(result.allowedFunctionNames).not.toContain(tool)
		}
	})

	it("narrows the Plan catalog and schemas to read-only Explore and Review orchestration", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "F:/workspace",
			mode: "architect",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			includeAllToolsWithRestrictions: true,
			taskKind: "primary",
		})

		expect(result.allowedFunctionNames).toEqual(
			expect.arrayContaining([
				"read_file",
				"search_files",
				"list_files",
				"ask_followup_question",
				"attempt_completion",
				"execute_command",
				"read_command_output",
				"delegate_task",
				...orchestrationTools,
			]),
		)
		for (const forbidden of ["new_task", "switch_mode", "update_todo_list", "write_to_file", "use_mcp_tool"]) {
			expect(result.allowedFunctionNames).not.toContain(forbidden)
		}

		const planTools = result.tools as any[]
		const executeCommand = planTools.find((tool) => tool.function?.name === "execute_command")
		expect(executeCommand.function.description).toContain("host-classified")
		expect(executeCommand.function.description).toContain("Shell chaining")
		expect(executeCommand.function.parameters.properties.verification).toMatchObject({ type: "null" })
		expect(executeCommand.function.description).not.toContain("npm run dev")
		const spawnAgent = planTools.find((tool) => tool.function?.name === "spawn_agent")
		expect(spawnAgent.function.description).not.toMatch(/worker|quarantined/i)
		expect(spawnAgent.function.parameters.properties.agent_kind.enum).toEqual(["explore", "review"])
		expect(spawnAgent.function.parameters.properties.write_scope).toMatchObject({ type: "null" })

		const delegateTask = planTools.find((tool) => tool.function?.name === "delegate_task")
		const delegatedItem = delegateTask.function.parameters.properties.tasks.items
		expect(delegateTask.function.description).not.toMatch(/worker|quarantined/i)
		expect(delegatedItem.properties.agent_kind.enum).toEqual(["explore", "review"])
		expect(delegatedItem.properties.write_scope).toMatchObject({ type: "null" })
	})

	it("ignores persisted architect groups when building the Plan catalog", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "F:/workspace",
			mode: "architect",
			customModes: [
				{
					slug: "architect",
					name: "Unsafe legacy override",
					roleDefinition: "Edit files",
					groups: ["edit", "mcp"],
				},
			],
			experiments: {},
			apiConfiguration: undefined,
			taskKind: "primary",
		})

		expect(names(result.tools as any)).toEqual(
			expect.arrayContaining(["read_file", "execute_command", "read_command_output", "spawn_agent"]),
		)
		expect(names(result.tools as any)).not.toEqual(
			expect.arrayContaining(["write_to_file", "apply_diff", "use_mcp_tool"]),
		)
	})

	it("exposes orchestration tools when a managed child's frozen runtime policy grants delegation", async () => {
		const allowedToolNames = managedChildAllowedTools(true)
		expect(allowedToolNames).toEqual(expect.arrayContaining(orchestrationTools))

		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "F:/workspace",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			allowedToolNames,
			includeAllToolsWithRestrictions: true,
			taskKind: "subagent",
		})

		for (const tool of orchestrationTools) {
			expect(names(result.tools as any)).toContain(tool)
			expect(result.allowedFunctionNames).toContain(tool)
		}
		const completionTool = (result.tools as any[]).find((tool) => tool.function?.name === "attempt_completion")
		expect(completionTool?.function?.parameters?.properties).toHaveProperty("outcome")
		expect(completionTool?.function?.description).toContain("assigned objective")
	})

	it("does not let the stable primary default override a managed child's frozen authority", async () => {
		const allowedToolNames = managedChildAllowedTools(false)
		expect(allowedToolNames).not.toContain("spawn_agent")
		expect(allowedToolNames).toContain("report_progress")

		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "F:/workspace",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			allowedToolNames,
			includeAllToolsWithRestrictions: true,
			taskKind: "subagent",
		})

		for (const tool of orchestrationTools) {
			expect(names(result.tools as any)).not.toContain(tool)
			expect(result.allowedFunctionNames).not.toContain(tool)
		}
		expect(names(result.tools as any)).toContain("report_progress")
		expect(result.allowedFunctionNames).toContain("report_progress")
	})
})
