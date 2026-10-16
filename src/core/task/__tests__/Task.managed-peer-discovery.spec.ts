import { describe, expect, it, vi } from "vitest"

import type { SubagentRole } from "@alpha-code/types"

import { Task, getSubagentAllowedToolNames } from "../Task"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import type { AlphaProvider } from "../../webview/AlphaProvider"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

const managedChild = (role: SubagentRole, allowedTools?: string[], read = true): Task =>
	Object.assign(Object.create(Task.prototype), {
		taskKind: "subagent",
		subagentRole: role,
		subagentContextManifest: {
			skills: [],
			runtimePolicy: {
				read,
				execute: false,
				mutate: false,
				delegate: false,
				...(allowedTools ? { allowedTools } : {}),
			},
		},
	}) as Task

describe("managed-agent read-only peer discovery", () => {
	it.each(["explore", "review", "worker"] as const)(
		"exposes an identity roster independently of %s delegation authority",
		(role) => {
			const child = managedChild(role, ["attempt_completion"])

			expect(child.getTaskAllowedToolNames()).toEqual(
				expect.arrayContaining(["list_agents", "send_message", "attempt_completion"]),
			)
			expect(child.isToolAllowedForTask("list_agents")).toBe(true)
			expect(child.isToolAllowedForTask("send_message")).toBe(true)
			for (const tool of [
				"spawn_agent",
				"followup_task",
				"interrupt_agent",
				"cancel_agent",
				"close_agent",
			] as const) {
				expect(child.isToolAllowedForTask(tool)).toBe(false)
			}
			for (const tool of ["apply_patch", "exec_command", "manage_command", "use_mcp_tool"] as const) {
				expect(child.isToolAllowedForTask(tool)).toBe(false)
			}
		},
	)

	it.each(["explore", "review", "worker"] as const)(
		"keeps read-only discovery available for a historical %s profile without an allowedTools field",
		(role) => {
			const child = managedChild(role)

			expect(child.getTaskAllowedToolNames()).toContain("list_agents")
			expect(child.isToolAllowedForTask("spawn_agent")).toBe(false)
			expect(child.isToolAllowedForTask("interrupt_agent")).toBe(false)
			expect(getSubagentAllowedToolNames(role, false, false)).toContain("list_agents")
		},
	)

	it("continues to narrow the captured mutation and command grants", () => {
		const child = managedChild("worker", ["list_agents", "send_message", "attempt_completion"])

		expect(child.getTaskAllowedToolNames()).toEqual(
			expect.arrayContaining(["list_agents", "send_message", "attempt_completion"]),
		)
		expect(child.isToolAllowedForTask("apply_patch")).toBe(false)
		expect(child.isToolAllowedForTask("exec_command")).toBe(false)
		expect(child.isToolAllowedForTask("manage_command")).toBe(false)
		expect(child.isToolAllowedForTask("spawn_agent")).toBe(false)
	})

	it("keeps passive identities independent of file-read authority in a historical frozen profile", () => {
		const child = managedChild("review", ["attempt_completion"], false)

		expect(child.isToolAllowedForTask("list_agents")).toBe(true)
		expect(child.isToolAllowedForTask("send_message")).toBe(true)
		expect(child.isToolAllowedForTask("read_file")).toBe(false)
		expect(child.isToolAllowedForTask("exec_command")).toBe(false)
		expect(child.isToolAllowedForTask("spawn_agent")).toBe(false)
	})

	it.each(["explore", "review", "worker"] as const)(
		"publishes the actual list_agents schema and executable grant in a nondelegating %s catalog",
		async (role) => {
			const child = managedChild(role, ["attempt_completion"])
			const provider = { context: {}, getMcpHub: () => ({ getServers: () => [] }) } as unknown as AlphaProvider
			const catalog = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: "F:/workspace",
				mode: "code",
				customModes: undefined,
				experiments: {},
				apiConfiguration: undefined,
				taskKind: "subagent",
				enableAgentLifecycleTools: false,
				allowedToolNames: child.getTaskAllowedToolNames(),
			})
			const names = catalog.tools.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

			expect(names).toContain("list_agents")
			expect(catalog.surface?.allowedFunctionNames).toContain("list_agents")
			expect(catalog.surface?.isCallable("list_agents")).toBe(true)
			for (const control of ["spawn_agent", "wait_agent", "followup_task", "interrupt_agent"]) {
				expect(names).not.toContain(control)
				expect(catalog.surface?.allowedFunctionNames).not.toContain(control)
			}
		},
	)

	it("honors current list_agents revocation in the actual captured catalog", async () => {
		const child = managedChild("review", ["attempt_completion"])
		const provider = { context: {}, getMcpHub: () => ({ getServers: () => [] }) } as unknown as AlphaProvider
		const catalog = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "F:/workspace",
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			taskKind: "subagent",
			enableAgentLifecycleTools: false,
			allowedToolNames: child.getTaskAllowedToolNames(),
			disabledTools: ["list_agents"],
		})
		const names = catalog.tools.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

		expect(child.getTaskAllowedToolNames()).toContain("list_agents")
		expect(names).not.toContain("list_agents")
		expect(catalog.surface?.allowedFunctionNames).not.toContain("list_agents")
		expect(catalog.surface?.isCallable("list_agents")).toBe(false)
	})
})
