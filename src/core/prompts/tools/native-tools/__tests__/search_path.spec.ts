import type OpenAI from "openai"
import { afterEach, describe, expect, it, vi } from "vitest"

import { getCommandChainOperator, getRulesSection } from "../../../sections/rules"
import { getToolUseGuidelinesSection } from "../../../sections/tool-use-guidelines"
import * as shellUtils from "../../../../../utils/shell"
import { createExecCommandTool } from "../execute_command"
import { getNativeTools } from ".."

function toolFunction(tool: OpenAI.Chat.ChatCompletionTool) {
	if (tool.type !== "function") {
		throw new Error("expected function tool")
	}
	return tool.function
}

describe("native file inspection surface", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("keeps ; for PowerShell and && for cmd.exe chaining", () => {
		const getShell = vi.spyOn(shellUtils, "getShell")
		getShell.mockReturnValue("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
		expect(getCommandChainOperator()).toBe(";")

		getShell.mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("guides bounded PowerShell repository inspection", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const rules = getRulesSection("/workspace")

		expect(rules).toContain("For bounded repository inspection, use `rg` for text or path matches")
		expect(rules).toContain("`Get-Content` for known files")
		expect(rules).toContain("For mutations, avoid Unix-specific utilities")
		expect(rules).not.toMatch(/\b(?:read_file|list_files|search_files|codebase_search)\b/)
	})

	it("guides bounded cmd.exe repository inspection", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		const rules = getRulesSection("/workspace")

		expect(rules).toContain(
			"For bounded repository inspection, use `rg` where installed and `type` for known files",
		)
		expect(rules).toContain("For mutations, avoid Unix-specific utilities")
		expect(rules).not.toMatch(/\b(?:read_file|list_files|search_files|codebase_search)\b/)
	})

	it.each([
		{ name: "Code", tools: getNativeTools() },
		{ name: "Plan", tools: getNativeTools({ planMode: true }) },
	])("excludes retired file tools from the $name fresh catalog", ({ tools }) => {
		const names = tools.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

		expect(names).toContain("exec_command")
		for (const legacyName of ["read_file", "list_files", "search_files", "codebase_search"])
			expect(names, legacyName).not.toContain(legacyName)
	})

	it("describes bounded exec_command inspection for Code and strict Plan mode", () => {
		expect(toolFunction(createExecCommandTool()).description).toContain(
			"workspace-scoped commands for file inspection",
		)
		expect(toolFunction(createExecCommandTool(true)).description).toContain("strict Plan mode")
		expect(getToolUseGuidelinesSection()).toContain("exec_command calls with rg")
		expect(getToolUseGuidelinesSection(undefined, true)).toContain("exec_command calls with rg")
		expect(getToolUseGuidelinesSection()).not.toMatch(/\b(?:read_file|list_files|search_files|codebase_search)\b/)
	})
})
