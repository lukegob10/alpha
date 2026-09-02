import { addCustomInstructions } from "../sections/custom-instructions"
import { getCapabilitiesSection } from "../sections/capabilities"
import { getRulesSection, getCommandChainOperator } from "../sections/rules"
import { McpHub } from "../../../services/mcp/McpHub"
import * as shellUtils from "../../../utils/shell"

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
		expect(result).toContain("execute CLI commands")
		expect(result).toContain("list files")
		expect(result).toContain("read and write files")
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
		const result = getRulesSection(cwd)

		expect(result).toContain("do not infer success if the result matters")
		expect(result).toContain("bounded follow-up")
		expect(result).not.toContain("assume the terminal executed the command successfully")
		expect(result).not.toContain("wait for the user's response after each tool use")
	})

	it("uses side-effect-aware MCP batching", () => {
		const result = getRulesSection(cwd)

		expect(result).toContain("Batch independent read-only MCP operations")
		expect(result).toContain("Serialize MCP operations with side effects or dependencies")
		expect(result).not.toContain("MCP operations should be used one at a time")
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

		expect(result).toContain("A primary task may finish with a visible ordinary assistant answer")
		expect(result).toContain("when no tool call or continuation is needed")
		expect(result).not.toContain("you must use the attempt_completion tool")
	})

	it("requires managed subagents to publish a durable result", () => {
		const result = getRulesSection(cwd, {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			subagentRole: "worker",
		})

		expect(result).toContain("When finished or blocked, call attempt_completion once")
		expect(result).toContain("durable result")
		expect(result).toContain("ordinary assistant prose alone")
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

	it("includes Unix utility guidance for PowerShell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		const result = getRulesSection(cwd)

		expect(result).toContain("IMPORTANT: When using PowerShell, avoid Unix-specific utilities")
		expect(result).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
		expect(result).toContain("`Select-String` for grep")
		expect(result).toContain("`Get-Content` for cat")
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

		expect(result).toContain("IMPORTANT: When using cmd.exe, avoid Unix-specific utilities")
		expect(result).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
		expect(result).toContain("`type` for cat")
		expect(result).toContain("`del` for rm")
		expect(result).toContain("`find`/`findstr` for grep")
	})

	it("does not include Unix utility guidance for Unix shells", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		const result = getRulesSection(cwd)

		expect(result).not.toContain("IMPORTANT: When using PowerShell")
		expect(result).not.toContain("IMPORTANT: When using cmd.exe")
		expect(result).not.toContain("`Select-String` for grep")
	})

	it("does not include note for Unix shells", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/zsh")
		const result = getRulesSection(cwd)

		expect(result).not.toContain("Note: Using")
	})
})
