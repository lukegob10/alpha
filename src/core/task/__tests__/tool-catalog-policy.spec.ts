import { describe, expect, it, vi } from "vitest"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { validateToolUse } from "../../tools/validateToolUse"
import type { ClineProvider } from "../../webview/ClineProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

describe("effective tool catalog policy", () => {
	it.each(["mcp--calendar--read_events", "mcp__calendar__read_events"])(
		"accepts the canonical MCP tool spelling %s at execution validation",
		(name) => {
			expect(() => validateToolUse(name as never, "code")).not.toThrow()
			expect(() => validateToolUse(name as never, "architect")).toThrow()
		},
	)

	it("returns exactly the captured policy-filtered provider schemas", async () => {
		const provider = { context: {}, getMcpHub: () => undefined } as unknown as ClineProvider
		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: process.cwd(),
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			policy: createToolPolicySnapshot({ visibleTools: ["read_file"] }),
		})
		expect(result.tools).toEqual(result.surface?.schemas)
		expect(result.tools.map((tool) => tool.type === "function" && tool.function.name)).toEqual(["read_file"])
	})
})
