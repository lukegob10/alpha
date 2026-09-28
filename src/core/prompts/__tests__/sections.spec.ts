import type OpenAI from "openai"
import { addCustomInstructions } from "../sections/custom-instructions"
import { getCapabilitiesSection } from "../sections/capabilities"
import { getSystemInfoSection } from "../sections/system-info"
import { getRulesSection, getCommandChainOperator } from "../sections/rules"
import { getObjectiveSection } from "../sections/objective"
import { getToolUseGuidelinesSection } from "../sections/tool-use-guidelines"
import { McpHub } from "../../../services/mcp/McpHub"
import * as shellUtils from "../../../utils/shell"
import { createShellTool } from "../tools/native-tools/execute_command"

function toolDescription(tool: OpenAI.Chat.ChatCompletionTool): string {
	if (tool.type !== "function") {
		throw new Error("expected function tool")
	}
	return tool.function.description ?? ""
}

describe("addCustomInstructions", () => {
	it("adds vscode language to custom instructions", async () => {
		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/test/path",
			"test-mode",
			{ language: "fr" },
		)

		expect(result).toContain("Language Preference:")
		expect(result).toContain('You should always speak and think in the "Français" (fr) language')
	})

	it("works without vscode language", async () => {
		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/test/path",
			"test-mode",
		)

		expect(result).not.toContain("Language Preference:")
		expect(result).not.toContain("You should always speak and think in")
	})
})

describe("getCapabilitiesSection", () => {
	const cwd = "/test/path"

	it("includes standard capabilities", () => {
		const result = getCapabilitiesSection(cwd)

		expect(result).toContain("CAPABILITIES")
		expect(result).toContain("exec_command")
		expect(result).toContain("write_stdin")
		expect(result).toContain("file and repository inspection")
		expect(result).toContain("available tools for edits and other capabilities")
	})

	it("includes MCP reference when mcpHub is provided", () => {
		const mockMcpHub = {} as McpHub
		const result = getCapabilitiesSection(cwd, mockMcpHub)

		expect(result).toContain("MCP servers")
	})

	it("excludes MCP reference when mcpHub is undefined", () => {
		const result = getCapabilitiesSection(cwd, undefined)

		expect(result).not.toContain("MCP servers")
	})
})

describe("getRulesSection", () => {
	const cwd = "/test/path"

	it("includes standard rules", () => {
		const result = getRulesSection(cwd)

		expect(result).toContain("RULES")
		expect(result).toContain("project base directory")
		expect(result).toContain(cwd)
	})

	it("uses command evidence without requiring user confirmation", () => {
		const result = getToolUseGuidelinesSection()

		expect(result).toContain("Never assume success")
		expect(result).toContain("bounded follow-up")
		expect(result).not.toContain("assume the terminal executed the command successfully")
		expect(result).not.toContain("wait for the user's response after each tool use")
	})

	it("does not invite Desktop-class exploration outside the workspace", () => {
		expect(getCapabilitiesSection(cwd)).not.toContain("Desktop")
		expect(getSystemInfoSection(cwd)).not.toContain("Desktop")
	})

	it("keeps primary rules free of fixed conversation and discovery recipes", () => {
		const result = getRulesSection(cwd)

		expect(result).toContain("Ask necessary user questions directly")
		expect(result).not.toContain("ask_followup_question")
		expect(result).not.toContain("2-4 suggested answers")
		expect(result).not.toContain("Desktop")
		expect(result).not.toContain("list_files tool")
		expect(result).not.toContain('starting your messages with "Great"')
	})

	it("directs Plan questions to its available user-input tool", () => {
		const result = getRulesSection(cwd, undefined, true)

		expect(result).toContain("request_user_input")
		expect(result).not.toContain("ask_followup_question")
	})

	it("uses side-effect-aware MCP batching", () => {
		const result = getToolUseGuidelinesSection()

		expect(result).toContain("Group independent, read-only calls when policy permits")
		expect(result).toContain(
			"Serialize dependent actions, workspace mutations, approvals, and control-flow operations",
		)
		expect(result).not.toContain("MCP operations should be used one at a time")
	})

	it("directs Code and Plan inspection through exec_command", () => {
		expect(getToolUseGuidelinesSection()).toContain("exec_command calls")
		expect(getToolUseGuidelinesSection(undefined, true)).toContain("exec_command calls")
		expect(getToolUseGuidelinesSection()).not.toMatch(/\b(?:read_file|list_files|search_files|codebase_search)\b/)
		expect(getToolUseGuidelinesSection(undefined, true)).not.toMatch(
			/\b(?:read_file|list_files|search_files|codebase_search)\b/,
		)
		expect(getToolUseGuidelinesSection("explore")).not.toContain("exec_command calls")
		expect(getToolUseGuidelinesSection("review")).not.toContain("exec_command calls")
		expect(getToolUseGuidelinesSection("worker")).not.toContain("exec_command calls")
	})

	it("includes vendor confidentiality section when isStealthModel is true", () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			isStealthModel: true,
		}

		const result = getRulesSection(cwd, settings)

		expect(result).toContain("VENDOR CONFIDENTIALITY")
		expect(result).toContain("Never reveal the vendor or company that created you")
		expect(result).toContain("I was created by a team of developers")
		expect(result).toContain("I'm an open-source project maintained by contributors")
		expect(result).toContain("I don't have information about specific vendors")
	})

	it("excludes vendor confidentiality section when isStealthModel is false", () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			isStealthModel: false,
		}

		const result = getRulesSection(cwd, settings)

		expect(result).not.toContain("VENDOR CONFIDENTIALITY")
		expect(result).not.toContain("Never reveal the vendor or company")
	})

	it("excludes vendor confidentiality section when isStealthModel is undefined", () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
		}

		const result = getRulesSection(cwd, settings)

		expect(result).not.toContain("VENDOR CONFIDENTIALITY")
		expect(result).not.toContain("Never reveal the vendor or company")
	})

	it("allows a primary task to finish with a visible ordinary answer", () => {
		const result = getRulesSection(cwd)

		expect(result).not.toContain("visible ordinary assistant answer")
		expect(getObjectiveSection()).toContain(
			"visible ordinary assistant answer when no tool call or continuation is needed",
		)
		expect(result).not.toContain("you must use the attempt_completion tool")
	})

	it("requires fresh file evidence when content or mutation safeguards need it", () => {
		expect(getRulesSection(cwd)).toContain(
			"obtain fresh reads when current content or mutation safeguards require them",
		)
	})

	it("allows managed final answers while reporting blocked constraints", () => {
		const result = getRulesSection(cwd, {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			subagentRole: "worker",
		})

		expect(result).toContain("provide a concise, self-contained final answer")
		expect(result).not.toContain("attempt_completion")
		expect(result).toContain("assigned work and required checks are complete")
		expect(result).toContain("Report any constraint that prevented completion")
	})
})

describe("getCommandChainOperator", () => {
	it("returns && for bash shell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for zsh shell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/zsh")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns ; for PowerShell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		expect(getCommandChainOperator()).toBe(";")
	})

	it("returns ; for PowerShell Core (pwsh)", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		expect(getCommandChainOperator()).toBe(";")
	})

	it("returns && for cmd.exe", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for Git Bash on Windows", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Program Files\\Git\\bin\\bash.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for WSL bash", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		expect(getCommandChainOperator()).toBe("&&")
	})
})

describe("getRulesSection shell-aware command chaining", () => {
	const cwd = "/test/path"

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("uses && for Unix shell command chaining", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		const result = getRulesSection(cwd)

		expect(result).toContain("commands must be chained, use `&&`")
		expect(result).not.toContain("commands must be chained, use `;`")
	})

	it("uses ; for PowerShell command chaining", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const result = getRulesSection(cwd)

		expect(result).toContain("commands must be chained, use `;`")
		expect(result).toContain("Note: Using `;` for PowerShell command chaining")
	})

	it("uses && for cmd.exe command chaining", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		const result = getRulesSection(cwd)

		expect(result).toContain("commands must be chained, use `&&`")
		expect(result).toContain("Note: Using `&&` for cmd.exe command chaining")
	})

	it("uses the captured command shell when the VS Code profile differs", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		const result = getRulesSection(cwd, {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			commandShell: "C:\\Windows\\System32\\cmd.exe",
		})

		expect(result).toContain("commands must be chained, use `&&`")
		expect(result).toContain("Note: Using `&&` for cmd.exe command chaining")
	})

	it("includes Unix utility guidance for PowerShell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const result = getRulesSection(cwd)

		expect(result).toContain("For bounded repository inspection, use `rg` for text or path matches")
		expect(result).toContain("For mutations, avoid Unix-specific utilities")
		expect(result).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
		expect(result).not.toContain("`Select-String` for grep")
		expect(result).toContain("`Remove-Item` for rm")
		expect(result).toContain("`Copy-Item` for cp")
		expect(result).toContain("PowerShell's `-replace` operator")
	})

	it("includes PowerShell-safe wait guidance", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const result = getRulesSection(cwd)

		expect(result).toContain("Start-Sleep -Seconds N")
		expect(result).toContain("timeout /t N > nul")
	})

	it("includes Unix utility guidance for cmd.exe", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		const result = getRulesSection(cwd)

		expect(result).toContain(
			"For bounded repository inspection, use `rg` where installed and `type` for known files",
		)
		expect(result).toContain("For mutations, avoid Unix-specific utilities")
		expect(result).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
		expect(result).toContain("`del` for rm")
		expect(result).not.toContain("`type` for cat")
		expect(result).not.toContain("`find`/`findstr` for grep")
	})

	it("does not include Unix utility guidance for Unix shells", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		const result = getRulesSection(cwd)

		expect(result).not.toContain("When using PowerShell")
		expect(result).not.toContain("When using cmd.exe")
		expect(result).not.toContain("`Select-String` for grep")
		expect(result).not.toContain("Select-String")
	})

	it("does not include note for Unix shells", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/zsh")
		const result = getRulesSection(cwd)

		expect(result).not.toContain("Note: Using")
	})

	it("uses bounded command inspection without advertising retired file tools", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const question = "Where is retryLimit defined?"
		const combined = [
			question,
			getRulesSection(cwd),
			getToolUseGuidelinesSection(),
			toolDescription(createShellTool()),
		].join("\n")

		expect(combined).toContain("Use concise, workspace-scoped exec_command calls")
		expect(combined).toContain("Runs a concise command in the task's host terminal")
		expect(combined).toMatch(/\brg\b/)
		expect(combined).not.toMatch(/\b(?:read_file|list_files|search_files|codebase_search)\b/)
		expect(combined).not.toContain("`Select-String` for grep")
		expect(combined).not.toContain("`find`/`findstr` for grep")
	})
})
