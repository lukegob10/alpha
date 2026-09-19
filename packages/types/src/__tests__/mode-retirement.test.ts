import { describe, expect, it } from "vitest"

import { DEFAULT_MODES, assertPrimaryMode, groupEntryArraySchema, restoreTaskMode } from "../mode.js"
import { historyItemSchema } from "../history.js"
import { deprecatedToolGroups, toolGroups, toolNames, toolUsageSchema } from "../tool.js"

describe("mode retirement", () => {
	it("keeps only the two canonical execution modes", () => {
		expect(DEFAULT_MODES.map(({ slug }) => slug)).toEqual(["architect", "code"])
		expect(toolNames).not.toContain("switch_mode")
	})

	it.each(["ask", "debug", "orchestrator", "custom-mode", "plan"])("restores %s into Plan idempotently", (mode) => {
		expect(() => assertPrimaryMode(mode)).toThrow("Unsupported mode")
		expect(restoreTaskMode(mode)).toBe("architect")
		expect(restoreTaskMode(restoreTaskMode(mode))).toBe("architect")
	})

	it.each(["code", "architect"])("preserves %s", (mode) => {
		expect(() => assertPrimaryMode(mode)).not.toThrow()
		expect(restoreTaskMode(mode)).toBe(mode)
	})

	it("keeps the historical default and retired tool usage readable", () => {
		expect(restoreTaskMode(undefined)).toBe("code")
		expect(historyItemSchema.shape.mode.parse("debug")).toBe("debug")
		expect(toolUsageSchema.parse({ switch_mode: { attempts: 1, failures: 0 } })).toEqual({
			switch_mode: { attempts: 1, failures: 0 },
		})
	})

	it("retires the GitHub group while stripping it from persisted modes", () => {
		expect(toolGroups).not.toContain("github")
		expect(deprecatedToolGroups).toContain("github")
		expect(DEFAULT_MODES.find((mode) => mode.slug === "code")?.groups).not.toContain("github")
		expect(
			groupEntryArraySchema.parse([
				"read",
				"github",
				["github", { description: "legacy GitHub access" }],
				"edit",
			]),
		).toEqual(["read", "edit"])
	})
})
