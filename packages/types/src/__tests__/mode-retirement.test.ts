import { describe, expect, it } from "vitest"

import { assertPrimaryMode, DEFAULT_MODES, restoreTaskMode } from "../mode.js"
import { historyItemSchema } from "../history.js"
import { toolNames, toolUsageSchema } from "../tool.js"

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
})
