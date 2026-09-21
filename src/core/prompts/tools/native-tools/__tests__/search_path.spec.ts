import type OpenAI from "openai"

import { getCommandChainOperator, getRulesSection } from "../../../sections/rules"
import { getToolUseGuidelinesSection } from "../../../sections/tool-use-guidelines"
import * as shellUtils from "../../../../../utils/shell"
import codebaseSearch from "../codebase_search"
import { createShellTool } from "../execute_command"
import listFiles from "../list_files"
import searchFiles from "../search_files"

function toolFunction(tool: OpenAI.Chat.ChatCompletionTool) {
	if (tool.type !== "function") {
		throw new Error("expected function tool")
	}
	return tool.function
}

function toolDescription(tool: OpenAI.Chat.ChatCompletionTool): string {
	return toolFunction(tool).description ?? ""
}

describe("search path policy", () => {
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

	it("does not tell PowerShell users to use Select-String as the grep equivalent", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const rules = getRulesSection("/workspace")

		expect(rules).toContain("Prefer `search_files` for content and path search")
		expect(rules).not.toContain("`Select-String` for grep")
		expect(rules).toContain("For mutations, avoid Unix-specific utilities")
		expect(rules).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
	})

	it("does not tell cmd.exe users to use find/findstr as repository search", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		const rules = getRulesSection("/workspace")

		expect(rules).toContain("Prefer `search_files` for content and path search")
		expect(rules).not.toContain("`find`/`findstr` for grep")
		expect(rules).toContain("For mutations, avoid Unix-specific utilities")
		expect(rules).toContain("`cat`")
	})

	it("describes search_files as the first tool and keeps queries 1-8 as the fan-out", () => {
		const definition = toolFunction(searchFiles)
		const description = definition.description ?? ""
		const queries = (
			definition.parameters as { properties?: { queries?: { minItems?: number; maxItems?: number } } }
		).properties?.queries

		expect(description).toContain("First tool for exact text, symbols, and filenames")
		expect(description).toContain("queries for 1 to 8 independent searches")
		expect(description).toContain("in one round")
		expect(queries?.minItems).toBe(1)
		expect(queries?.maxItems).toBe(8)
	})

	it("limits codebase_search to unknown location and one semantic query", () => {
		const description = toolDescription(codebaseSearch)

		expect(toolFunction(codebaseSearch).name).toBe("codebase_search")
		expect(description).toContain("semantic search")
		expect(description).toContain("Use only when the implementation location is unknown")
		expect(description).toContain("one semantic query")
		expect(description).toContain("Not the first hop for a known token")
	})

	it("forbids recursive list_files as the first lookup or workspace hunt", () => {
		const description = toolDescription(listFiles)

		expect(description).toContain("List the children of a known directory")
		expect(description).toContain("Do not start a lookup or workspace hunt with recursive listing")
	})

	it("says shell is not a search fallback when search_files can run", () => {
		expect(toolDescription(createShellTool())).toContain("Not a search fallback when search_files can run")
		expect(toolDescription(createShellTool(true))).toContain("strict Plan mode")
		expect(toolDescription(createShellTool(true))).not.toContain("Not a search fallback when search_files can run")
	})

	it("does not emit shell or recursive listing as the first search for a definition lookup", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const question = "Where is retryLimit defined?"
		const combined = [
			question,
			getRulesSection("/workspace"),
			getToolUseGuidelinesSection(),
			toolDescription(searchFiles),
			toolDescription(listFiles),
			toolDescription(createShellTool()),
		].join("\n")

		expect(combined).toContain("start with search_files")
		expect(combined).toContain("First tool for exact text, symbols, and filenames")
		expect(combined).toContain("Not a search fallback when search_files can run")
		expect(combined).toContain("Do not start a lookup or workspace hunt with recursive listing")
		expect(combined).toContain("Do not start with recursive list_files or shell search")
		expect(combined).not.toContain("`Select-String` for grep")
		expect(combined).not.toContain("`find`/`findstr` for grep")
	})
})
