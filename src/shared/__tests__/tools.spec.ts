import { describe, expect, it } from "vitest"

import { TOOL_ALIASES, expandLegacyThreadToolDisables } from "../tools"

describe("tool alias dictionaries", () => {
	it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
		"preserves the unknown name %s without interpreting inherited properties",
		(name) => {
			expect(TOOL_ALIASES[name]).toBeUndefined()
			expect(expandLegacyThreadToolDisables([name])).toEqual([name])
		},
	)

	it("preserves supported aliases and expands historical thread exclusions once", () => {
		expect(TOOL_ALIASES.execute_command).toBe("exec_command")
		expect(TOOL_ALIASES.update_todo_list).toBe("update_plan")
		expect(expandLegacyThreadToolDisables(["create_task", "create_thread", "create_task"])).toEqual([
			"create_task",
			"create_thread",
			"fork_thread",
		])
	})
})
