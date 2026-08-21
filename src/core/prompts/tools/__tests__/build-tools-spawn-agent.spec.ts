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

	it("exposes spawn_agent to a primary Code task", async () => {
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "F:/workspace",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			includeAllToolsWithRestrictions: true,
		})

		expect(names(result.tools as any)).toContain("spawn_agent")
		expect(names(result.tools as any)).not.toContain("report_progress")
		expect(result.allowedFunctionNames).toContain("spawn_agent")
		expect(result.allowedFunctionNames).not.toContain("report_progress")
		const nativeTools = result.tools as Array<{
			function?: {
				name: string
				description?: string
				parameters?: { required?: string[]; properties?: Record<string, unknown> }
			}
		}>
		const spawnTool = nativeTools.find((tool) => tool.function?.name === "spawn_agent")
		expect(spawnTool?.function?.description).toContain(
			"terminal report is automatically included in the parent's next model request",
		)
		expect(spawnTool?.function?.parameters?.required).toEqual(expect.arrayContaining(["task_name", "fork_turns"]))
		expect(spawnTool?.function?.parameters?.properties).toHaveProperty("fork_turns")

		const delegateTool = nativeTools.find((tool) => tool.function?.name === "delegate_task")
		expect(JSON.stringify(delegateTool?.function?.parameters)).not.toContain("fork_turns")
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
		})

		for (const tool of orchestrationTools) {
			expect(names(result.tools as any)).toContain(tool)
			expect(result.allowedFunctionNames).toContain(tool)
		}
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
		})

		for (const tool of orchestrationTools) {
			expect(names(result.tools as any)).not.toContain(tool)
			expect(result.allowedFunctionNames).not.toContain(tool)
		}
		expect(names(result.tools as any)).toContain("report_progress")
		expect(result.allowedFunctionNames).toContain("report_progress")
	})
})
