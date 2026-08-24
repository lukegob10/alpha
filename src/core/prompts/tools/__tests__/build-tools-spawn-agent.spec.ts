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

	it("keeps an idle primary Code task limited to delegation entry points", async () => {
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
		for (const tool of orchestrationTools.filter((name) => name !== "spawn_agent")) {
			expect(names(result.tools as any)).not.toContain(tool)
			expect(result.allowedFunctionNames).not.toContain(tool)
		}
		const nativeTools = result.tools as Array<{
			function?: {
				name: string
				description?: string
				parameters?: { required?: string[]; properties?: Record<string, unknown> }
			}
		}>
		const spawnTool = nativeTools.find((tool) => tool.function?.name === "spawn_agent")
		expect(spawnTool?.function?.description).toContain(
			"collect terminal results through wait_agent as native tool results",
		)
		expect(spawnTool?.function?.description).not.toContain("automatically included")
		expect(spawnTool?.function?.parameters?.required).toEqual(expect.arrayContaining(["task_name", "fork_turns"]))
		expect(spawnTool?.function?.parameters?.properties).toHaveProperty("fork_turns")
		const delegateTool = nativeTools.find((tool) => tool.function?.name === "delegate_task")
		const delegateTask = (delegateTool?.function?.parameters as any)?.properties?.tasks?.items
		expect(delegateTask?.required).toEqual(expect.arrayContaining(["objective", "fork_turns", "agent_kind"]))
		expect(delegateTask?.properties?.fork_turns).toMatchObject({
			pattern: "^(?:none|all|[1-9][0-9]*)$",
			maxLength: 16,
		})

		const completionTool = nativeTools.find((tool) => tool.function?.name === "attempt_completion")
		expect(completionTool?.function?.parameters?.properties).not.toHaveProperty("outcome")
		expect(completionTool?.function?.description).not.toContain("sub-agents only")
	})

	it("exposes lifecycle controls only after a primary task has managed-agent activity", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "F:/workspace",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			includeAllToolsWithRestrictions: true,
			taskKind: "primary",
			enableAgentLifecycleTools: true,
		})

		for (const tool of orchestrationTools) {
			expect(names(result.tools as any)).toContain(tool)
			expect(result.allowedFunctionNames).toContain(tool)
		}
		const waitTool = (result.tools as any[]).find((tool) => tool.function?.name === "wait_agent")
		expect(waitTool?.function?.description).toContain("sender task/path provenance")
		expect(waitTool?.function?.description).toContain("only after this tool result is persisted")
		expect(names(result.tools as any)).not.toContain("report_progress")
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

	it("omits orchestration tools from a legacy managed child without delegation authority", async () => {
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
