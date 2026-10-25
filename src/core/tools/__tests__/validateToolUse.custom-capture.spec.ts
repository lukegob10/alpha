import { afterEach, describe, expect, it, vi } from "vitest"
import { customToolRegistry } from "@alpha-code/core"
import type { ToolName } from "@alpha-code/types"

import { captureCustomToolNames, ToolRegistry, type ToolDescriptor } from "../ToolRegistry"
import { isToolAllowedForMode, isValidToolName, validateToolUse } from "../validateToolUse"

const customName = "workspace_a_tool"
const experiments = { customTools: true }

afterEach(() => vi.restoreAllMocks())

function validate(captured: ReadonlySet<string> | undefined, mode = "code", requirements?: Record<string, boolean>) {
	validateToolUse(customName as ToolName, mode, [], requirements, undefined, experiments, undefined, captured)
}

function descriptor(name: string, aliases: string[] = []): ToolDescriptor {
	return {
		name,
		aliases,
		schema: { type: "function", function: { name, parameters: { type: "object" } } },
		capabilities: { concurrency: "serial", sideEffects: "external", controlFlow: false, requiresApproval: true },
		execute: async () => {},
	}
}

describe("captured custom tool validation", () => {
	it("captures custom descriptor names and aliases without native or MCP identities", () => {
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor(customName, ["workspace_a_alias"]))
		registry.register(descriptor("exec_command", ["fixture_native_alias"]))
		registry.register(descriptor("mcp--docs--read"))
		const captured = captureCustomToolNames(registry)
		registry.register(descriptor("workspace_b_tool"))

		expect([...captured]).toEqual([customName, "workspace_a_alias"])
	})

	it("keeps a captured tool valid after a different workspace replaces the live catalog", () => {
		const liveMembership = vi.spyOn(customToolRegistry, "has").mockReturnValue(false)
		const captured = new Set([customName])

		expect(isValidToolName(customName, experiments, captured)).toBe(true)
		expect(
			isToolAllowedForMode(customName, "code", [], undefined, undefined, experiments, undefined, captured),
		).toBe(true)
		expect(() => validate(captured)).not.toThrow()
		expect(liveMembership).not.toHaveBeenCalled()
	})

	it.each([
		{ name: "empty", captured: new Set<string>() },
		{ name: "different workspace", captured: new Set(["workspace_b_tool"]) },
	])("rejects a live tool absent from the supplied $name catalog", ({ captured }) => {
		const liveMembership = vi.spyOn(customToolRegistry, "has").mockReturnValue(true)

		expect(isValidToolName(customName, experiments, captured)).toBe(false)
		expect(
			isToolAllowedForMode(customName, "code", [], undefined, undefined, experiments, undefined, captured),
		).toBe(false)
		expect(() => validate(captured)).toThrow(`Unknown tool "${customName}"`)
		expect(liveMembership).not.toHaveBeenCalled()
	})

	it("retains the custom-tool experiment, Plan, and explicit-disable restrictions", () => {
		const captured = new Set([customName])

		expect(isValidToolName(customName, { customTools: false }, captured)).toBe(false)
		expect(
			isToolAllowedForMode(
				customName,
				"code",
				[],
				undefined,
				undefined,
				{ customTools: false },
				undefined,
				captured,
			),
		).toBe(false)
		expect(() => validate(captured, "architect")).toThrow("not allowed in architect mode")
		expect(() => validate(captured, "code", { [customName]: false })).toThrow("not allowed in code mode")
	})

	it("uses legacy live membership only when the captured catalog is omitted", () => {
		const liveMembership = vi.spyOn(customToolRegistry, "has").mockReturnValue(true)

		expect(() => validate(undefined)).not.toThrow()
		expect(liveMembership).toHaveBeenCalledWith(customName)
	})
})
