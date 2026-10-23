import { describe, expect, it, vi } from "vitest"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { validateToolUse } from "../../tools/validateToolUse"
import type { AlphaProvider } from "../../webview/AlphaProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

describe("effective tool catalog policy", () => {
	it("retains inherited MCP and Alpha tools in a child catalog without adding uncaptured tools", async () => {
		const hub = {
			getServers: () => [
				{
					name: "docs",
					status: "connected",
					config: "{}",
					source: "project",
					tools: [
						{
							name: "search",
							description: "Search documentation",
							inputSchema: { type: "object", properties: {} },
						},
					],
				},
			],
		}
		const provider = { context: {}, getMcpHub: () => hub } as unknown as AlphaProvider
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: process.cwd(),
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			taskKind: "subagent",
			allowedToolNames: ["exec_command", "apply_patch", "mcp--docs--search", "create_ticket"],
		})
		for (const name of ["exec_command", "apply_patch", "mcp--docs--search", "create_ticket"]) {
			expect(result.surface?.isCallable(name), name).toBe(true)
		}
		expect(result.surface?.isCallable("delete_ticket")).toBe(false)
		expect(result.surface?.isCallable("spawn_agent")).toBe(false)
	})
	it.each(["mcp--calendar--read_events", "mcp__calendar__read_events"])(
		"accepts the canonical MCP tool spelling %s at execution validation",
		(name) => {
			expect(() => validateToolUse(name as never, "code")).not.toThrow()
			expect(() => validateToolUse(name as never, "architect")).toThrow()
		},
	)

	it("returns exactly the captured policy-filtered provider schemas", async () => {
		const provider = { context: {}, getMcpHub: () => undefined } as unknown as AlphaProvider
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: process.cwd(),
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			policy: createToolPolicySnapshot({ visibleTools: ["exec_command"] }),
		})
		expect(result.tools).toEqual(result.surface?.schemas)
		expect(result.tools.map((tool) => tool.type === "function" && tool.function.name)).toEqual(["exec_command"])
		expect(result.surface?.isCallable("read_file")).toBe(false)
	})
})
