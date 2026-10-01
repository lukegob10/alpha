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
import { toOpenAiStrictToolSchema } from "../../../../api/transform/openai-strict-tool-schema"

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
		expect(names(result.tools as any)).not.toContain("report_progress")
		expect(names(result.tools as any)).not.toContain("delegate_task")
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

		const spawnTool = nativeTools.find((tool) => tool.function?.name === "spawn_agent")
		expect(spawnTool?.function?.description).toContain("asynchronously")
		expect(spawnTool?.function?.description).toContain("return its handle immediately")
		expect(spawnTool?.function?.description).toContain(
			"Collect the terminal result through wait_agent before completing",
		)
		expect(spawnTool?.function?.parameters?.required).toEqual(["task_name", "message"])
		expect(spawnTool?.function?.parameters?.properties).toHaveProperty("fork_turns")
		expect(spawnTool?.function?.parameters?.properties).toHaveProperty("agent_type")
		expect(spawnTool?.function?.parameters?.properties).toHaveProperty("model")
		expect(spawnTool?.function?.parameters?.properties).toHaveProperty("reasoning_effort")
		expect(spawnTool?.function?.parameters?.properties).not.toHaveProperty("write_scope")
		expect(spawnTool?.function?.parameters?.properties).not.toHaveProperty("objective")
		expect(nativeTools.find((tool) => tool.function?.name === "attempt_completion")).toBeUndefined()
		const waitTool = (result.tools as any[]).find((tool) => tool.function?.name === "wait_agent")
		expect(waitTool?.function?.description).toContain("mailbox update from any live agent")
		expect(waitTool?.function?.parameters?.properties).not.toHaveProperty("target")
		expect(names(result.tools as any)).not.toContain("report_progress")
	})

	it("can publish strict native schemas for managed lifecycle calls", async () => {
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
		for (const name of orchestrationTools) {
			const tool = (result.tools as Array<{ function?: { name: string; parameters?: unknown } }>).find(
				(candidate) => candidate.function?.name === name,
			)
			expect(tool?.function?.parameters).toBeDefined()
			const strict = toOpenAiStrictToolSchema(tool!.function!.parameters) as {
				additionalProperties: boolean
				properties: Record<string, unknown>
				required: string[]
			}
			expect(strict.additionalProperties).toBe(false)
			expect(strict.required).toEqual(Object.keys(strict.properties))
		}
	})

	it("keeps the spawn entry point while trimming idle lifecycle controls", async () => {
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
		expect(names(result.tools as any)).not.toContain("delegate_task")
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
			expect.arrayContaining(["request_user_input", "exec_command", ...orchestrationTools]),
		)
		for (const legacyName of ["read_file", "list_files", "search_files", "codebase_search"])
			expect(result.allowedFunctionNames, legacyName).not.toContain(legacyName)
		expect(result.surface?.allowedFunctionNames).toContain("exec_command")
		for (const forbidden of ["new_task", "switch_mode", "update_todo_list", "write_to_file", "use_mcp_tool"]) {
			expect(result.allowedFunctionNames).not.toContain(forbidden)
		}

		const planTools = result.tools as any[]
		const execCommand = planTools.find((tool) => tool.function?.name === "exec_command")
		expect(execCommand.function.description).toContain("host-classified")
		expect(execCommand.function.description).toContain("Shell chaining")
		expect(execCommand.function.parameters.required).toEqual(["cmd"])
		expect(execCommand.function.parameters.properties.workdir).toBeDefined()
		expect(execCommand.function.parameters.properties.verification).toBeUndefined()
		expect(execCommand.function.description).not.toContain("npm run dev")
		const spawnAgent = planTools.find((tool) => tool.function?.name === "spawn_agent")
		expect(spawnAgent.function.description).not.toMatch(/worker|quarantined/i)
		expect(spawnAgent.function.parameters.properties.agent_type.type).toBe("string")
		expect(spawnAgent.function.parameters.properties.agent_type.description).not.toContain("worker")
		expect(spawnAgent.function.parameters.properties).not.toHaveProperty("write_scope")

		expect(planTools.find((tool) => tool.function?.name === "delegate_task")).toBeUndefined()
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

		expect(names(result.tools as any)).toEqual(expect.arrayContaining(["exec_command", "spawn_agent"]))
		for (const legacyName of ["read_file", "list_files", "search_files", "codebase_search"])
			expect(names(result.tools as any), legacyName).not.toContain(legacyName)
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
		expect(names(result.tools as any)).not.toContain("attempt_completion")
	})

	it("does not let the stable primary default override a managed child's frozen authority", async () => {
		const allowedToolNames = managedChildAllowedTools(false)
		expect(allowedToolNames).not.toContain("spawn_agent")
		expect(allowedToolNames).not.toContain("report_progress")

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

		for (const tool of orchestrationTools.filter((name) => name !== "send_message")) {
			expect(names(result.tools as any)).not.toContain(tool)
			expect(result.allowedFunctionNames).not.toContain(tool)
		}
		expect(names(result.tools as any)).toContain("send_message")
		expect(result.allowedFunctionNames).toContain("send_message")
		expect(names(result.tools as any)).not.toContain("report_progress")
		expect(result.allowedFunctionNames).not.toContain("report_progress")
	})
})
