import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import matter from "gray-matter"
import { skillTool } from "../SkillTool"
import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { digestValue } from "../../agent/StepContext"
import type { ToolUse } from "../../../shared/tools"

describe("skillTool", () => {
	let mockTask: any
	let mockCallbacks: any
	let mockSkillsManager: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockSkillsManager = {
			getSkillContent: vi.fn(),
			getSkillContentByPath: vi.fn(),
			getSkillsForMode: vi.fn().mockReturnValue([]),
		}

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			ask: vi.fn().mockResolvedValue({}),
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({ mode: "code" }),
					getSkillsManager: vi.fn().mockReturnValue(mockSkillsManager),
				}),
			},
		}

		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	it("should handle missing skill parameter", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "",
			},
		}

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.recordToolError).toHaveBeenCalledWith("skill")
		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("skill", "skill")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
	})

	it.each(["root", "subagent"])("loads the packaged explicit reviewer through the approved %s path", async (kind) => {
		const skillPath = path.join(__dirname, "../../../assets/skills/review-agent/SKILL.md")
		const parsed = matter(readFileSync(skillPath, "utf8"))
		if (typeof parsed.data.description !== "string") throw new Error("Missing packaged review description")
		const instructions = parsed.content.trim()
		const content = {
			name: "review-agent",
			description: parsed.data.description,
			path: skillPath,
			source: "builtin" as const,
			allowImplicitInvocation: false,
			instructions,
		}
		mockTask.taskKind = kind
		mockTask.getTaskMode = vi.fn().mockResolvedValue("architect")
		mockTask.recordLoadedSkill = vi.fn()
		mockSkillsManager.getSkillContent.mockResolvedValue(content)
		mockSkillsManager.getSkillContentByPath.mockResolvedValue(content)
		if (kind === "subagent") {
			mockTask.getInheritedSubagentSkill = vi.fn(() => ({
				name: content.name,
				path: content.path,
				digest: digestValue(instructions),
				allowImplicitInvocation: false,
			}))
		}

		await skillTool.execute(
			{ action: "load", skill: "review-agent", args: "Review the working changes", cursor: null },
			mockTask as Task,
			mockCallbacks,
		)

		expect(mockCallbacks.handleError).not.toHaveBeenCalled()
		expect(mockCallbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining('"source":"builtin"'))
		expect(mockTask.recordLoadedSkill).toHaveBeenCalledWith("review-agent", skillPath, digestValue(instructions))
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining(instructions))
		if (kind === "subagent") {
			expect(mockSkillsManager.getSkillContentByPath).toHaveBeenCalledWith("review-agent", skillPath)
			expect(mockSkillsManager.getSkillContent).not.toHaveBeenCalled()
		} else {
			expect(mockSkillsManager.getSkillContent).toHaveBeenCalledWith("review-agent", "architect")
		}
	})

	it("loads the task's skill catalog and mode when foreground workspace state differs", async () => {
		mockTask.cwd = "/scheduled/project"
		mockTask.getTaskMode = vi.fn().mockResolvedValue("architect")
		const scopedManager = {
			getSkillContent: vi.fn().mockResolvedValue({
				name: "review",
				description: "Review the scheduled project",
				path: "/scheduled/project/.agents/skills/review/SKILL.md",
				source: "project",
				instructions: "Scheduled project instructions",
			}),
		}
		const provider = mockTask.providerRef.deref()
		provider.getSkillsManager.mockImplementation(async (task?: Task) =>
			task === mockTask ? scopedManager : mockSkillsManager,
		)

		await skillTool.handle(
			mockTask as Task,
			{
				type: "tool_use",
				name: "skill",
				params: {},
				partial: false,
				nativeArgs: { skill: "review" },
			},
			mockCallbacks,
		)

		expect(provider.getSkillsManager).toHaveBeenCalledExactlyOnceWith(mockTask)
		expect(scopedManager.getSkillContent).toHaveBeenCalledWith("review", "architect")
		expect(mockSkillsManager.getSkillContent).not.toHaveBeenCalled()
		expect(provider.getState).not.toHaveBeenCalled()
		expect(mockCallbacks.askApproval).toHaveBeenCalledOnce()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Scheduled project instructions"),
		)
	})

	it("should handle skill not found", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "non-existent",
			},
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(null)
		mockSkillsManager.getSkillsForMode.mockReturnValue([{ name: "create-mcp-server" }])

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Skill 'non-existent' not found. Available skills: create-mcp-server"),
		)
	})

	it("should handle empty available skills list", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "non-existent",
			},
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(null)
		mockSkillsManager.getSkillsForMode.mockReturnValue([])

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Skill 'non-existent' not found. Available skills: (none)"),
		)
	})

	it("keeps explicit-only names out of implicit discovery suggestions", async () => {
		mockSkillsManager.getSkillContent.mockResolvedValue(null)
		mockSkillsManager.getSkillsForMode.mockReturnValue([
			{ name: "hidden-review", allowImplicitInvocation: false },
			{ name: "allowed-review", allowImplicitInvocation: true },
			{ name: "debug", source: "builtin" },
		])

		await skillTool.handle(
			mockTask as Task,
			{ type: "tool_use", name: "skill", params: {}, partial: false, nativeArgs: { skill: "missing" } },
			mockCallbacks,
		)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Skill 'missing' not found. Available skills: allowed-review, debug"),
		)
		expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
	})

	it.each([true, false])(
		"keeps normal approval behavior when an explicit-only skill is approved=%s",
		async (approved) => {
			mockSkillsManager.getSkillContent.mockResolvedValue({
				name: "hidden-review",
				description: "Review on explicit request",
				path: "/project/.agents/skills/hidden-review/SKILL.md",
				source: "project",
				allowImplicitInvocation: false,
				instructions: "Explicit review instructions",
			})
			mockCallbacks.askApproval.mockResolvedValue(approved)

			await skillTool.handle(
				mockTask as Task,
				{ type: "tool_use", name: "skill", params: {}, partial: false, nativeArgs: { skill: "hidden-review" } },
				mockCallbacks,
			)

			expect(mockSkillsManager.getSkillContent).toHaveBeenCalledExactlyOnceWith("hidden-review", "code")
			expect(mockSkillsManager.getSkillsForMode).not.toHaveBeenCalled()
			expect(mockCallbacks.askApproval).toHaveBeenCalledOnce()
			if (approved) {
				expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
					expect.stringContaining("Explicit review instructions"),
				)
			} else {
				expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
			}
		},
	)

	it("should successfully load a global skill", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		const mockSkillContent = {
			name: "create-mcp-server",
			description: "Instructions for creating MCP servers",
			path: "/home/user/.alpha/skills/create-mcp-server/SKILL.md",
			source: "global",
			instructions: "Step 1: Create the server...",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "skill",
				skill: "create-mcp-server",
				args: undefined,
				source: "global",
				description: "Instructions for creating MCP servers",
			}),
		)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Skill: create-mcp-server
Description: Instructions for creating MCP servers
Source: global
Skill file: /home/user/.alpha/skills/create-mcp-server/SKILL.md
Base directory: /home/user/.alpha/skills/create-mcp-server
Resolve relative file references against this directory unless the skill explicitly specifies another base. Use absolute paths in file tools; do not guess a workspace-relative skills/ path.

--- Skill Instructions ---

Step 1: Create the server...`,
		)
	})

	it("should successfully load skill with arguments", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
				args: "weather API server",
			},
		}

		const mockSkillContent = {
			name: "create-mcp-server",
			description: "Instructions for creating MCP servers",
			path: "/home/user/.alpha/skills/create-mcp-server/SKILL.md",
			source: "global",
			instructions: "Step 1: Create the server...",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Skill: create-mcp-server
Description: Instructions for creating MCP servers
Provided arguments: weather API server
Source: global
Skill file: /home/user/.alpha/skills/create-mcp-server/SKILL.md
Base directory: /home/user/.alpha/skills/create-mcp-server
Resolve relative file references against this directory unless the skill explicitly specifies another base. Use absolute paths in file tools; do not guess a workspace-relative skills/ path.

--- Skill Instructions ---

Step 1: Create the server...`,
		)
	})

	it("should handle user rejection", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		mockSkillsManager.getSkillContent.mockResolvedValue({
			name: "create-mcp-server",
			description: "Test",
			path: "/home/user/.alpha/skills/create-mcp-server/SKILL.md",
			source: "global",
			instructions: "Test instructions",
		})

		mockCallbacks.askApproval.mockResolvedValue(false)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("should handle partial block", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {
				skill: "create-mcp-server",
				args: "",
			},
			partial: true,
		}

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.ask).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "skill",
				skill: "create-mcp-server",
				args: "",
			}),
			true,
		)

		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("should handle errors during execution", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		const error = new Error("Test error")
		mockSkillsManager.getSkillContent.mockRejectedValue(error)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.handleError).toHaveBeenCalledWith("executing skill", error)
	})

	it("should reset consecutive mistake count on valid skill", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		mockTask.consecutiveMistakeCount = 5

		const mockSkillContent = {
			name: "create-mcp-server",
			description: "Test",
			path: "/home/user/.alpha/skills/create-mcp-server/SKILL.md",
			source: "global",
			instructions: "Test instructions",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	it("should handle Skills Manager not available", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
		})

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.recordToolError).toHaveBeenCalledWith("skill")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Skills Manager not available"),
		)
	})

	it("should load project skill", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "my-project-skill",
			},
		}

		const mockSkillContent = {
			name: "my-project-skill",
			description: "A custom project skill",
			path: "/project/.agents/skills/my-project-skill/SKILL.md",
			source: "project",
			instructions: "Follow these project-specific instructions...",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "skill",
				skill: "my-project-skill",
				args: undefined,
				source: "project",
				description: "A custom project skill",
			}),
		)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Skill: my-project-skill
Description: A custom project skill
Source: project
Skill file: /project/.agents/skills/my-project-skill/SKILL.md
Base directory: /project/.agents/skills/my-project-skill
Resolve relative file references against this directory unless the skill explicitly specifies another base. Use absolute paths in file tools; do not guess a workspace-relative skills/ path.

--- Skill Instructions ---

Follow these project-specific instructions...`,
		)
	})

	it("loads an unchanged skill from a managed child's frozen catalog", async () => {
		const instructions = "Inspect the repository without changing files."
		const inherited = {
			name: "review-repository",
			path: "F:/workspace/.alpha/skills/review-repository/SKILL.md",
			digest: digestValue(instructions),
		}
		Object.assign(mockTask, {
			taskKind: "subagent",
			getTaskMode: vi.fn(async () => "code"),
			getInheritedSubagentSkill: vi.fn((name: string) => (name === inherited.name ? inherited : undefined)),
			getInheritedSubagentSkillNames: vi.fn(() => [inherited.name]),
		})
		mockSkillsManager.getSkillContentByPath.mockResolvedValue({
			...inherited,
			description: "Review repository evidence",
			source: "project",
			instructions,
		})

		await skillTool.handle(
			mockTask as Task,
			{
				type: "tool_use",
				name: "skill",
				params: {},
				partial: false,
				nativeArgs: { skill: inherited.name },
			},
			mockCallbacks,
		)

		expect(mockCallbacks.askApproval).toHaveBeenCalledOnce()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining(instructions))
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining(`Skill file: ${inherited.path}`),
		)
	})

	it("explicitly loads a captured explicit-only skill after live metadata changes", async () => {
		const instructions = "Explicit captured review workflow"
		const inherited = {
			name: "hidden-review",
			path: "F:/workspace/.agents/skills/hidden-review/SKILL.md",
			digest: digestValue(instructions),
			allowImplicitInvocation: false,
		}
		Object.assign(mockTask, {
			taskKind: "subagent",
			getTaskMode: vi.fn(async () => "code"),
			getInheritedSubagentSkill: vi.fn(() => inherited),
			getInheritedSubagentSkillNames: vi.fn(() => [inherited.name]),
		})
		mockSkillsManager.getSkillContentByPath.mockResolvedValue({
			...inherited,
			description: "Explicit review",
			source: "project",
			allowImplicitInvocation: true,
			instructions,
		})

		await skillTool.handle(
			mockTask as Task,
			{ type: "tool_use", name: "skill", params: {}, partial: false, nativeArgs: { skill: inherited.name } },
			mockCallbacks,
		)

		expect(mockSkillsManager.getSkillContentByPath).toHaveBeenCalledExactlyOnceWith(inherited.name, inherited.path)
		expect(mockSkillsManager.getSkillContent).not.toHaveBeenCalled()
		expect(mockCallbacks.askApproval).toHaveBeenCalledOnce()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining(instructions))
		expect(inherited.allowImplicitInvocation).toBe(false)
	})

	it("uses captured policy for a child's suggestions even when live metadata becomes implicit", async () => {
		const skills = [{ name: "hidden-review", allowImplicitInvocation: false }, { name: "visible-review" }]
		Object.assign(mockTask, {
			taskKind: "subagent",
			getTaskMode: vi.fn(async () => "code"),
			getInheritedSubagentSkill: vi.fn((name: string) => skills.find((skill) => skill.name === name)),
			getInheritedSubagentSkillNames: vi.fn(() => skills.map(({ name }) => name)),
		})
		mockSkillsManager.getSkillsForMode.mockReturnValue([{ name: "hidden-review", allowImplicitInvocation: true }])

		await skillTool.handle(
			mockTask as Task,
			{ type: "tool_use", name: "skill", params: {}, partial: false, nativeArgs: { skill: "missing" } },
			mockCallbacks,
		)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError(
				"Skill 'missing' was not included in this child task's frozen catalog. Available skills: visible-review",
			),
		)
		expect(mockSkillsManager.getSkillsForMode).not.toHaveBeenCalled()
	})

	it.each([
		["path", "F:/workspace/.alpha/skills/replaced/SKILL.md", "instructions"],
		["digest", "F:/workspace/.alpha/skills/review-repository/SKILL.md", "changed instructions"],
	] as const)("rejects inherited skill %s drift", async (_kind, resolvedPath, resolvedInstructions) => {
		const capturedInstructions = "original instructions"
		const inherited = {
			name: "review-repository",
			path: "F:/workspace/.alpha/skills/review-repository/SKILL.md",
			digest: digestValue(capturedInstructions),
		}
		Object.assign(mockTask, {
			taskKind: "subagent",
			getTaskMode: vi.fn(async () => "code"),
			getInheritedSubagentSkill: vi.fn(() => inherited),
			getInheritedSubagentSkillNames: vi.fn(() => [inherited.name]),
		})
		mockSkillsManager.getSkillContentByPath.mockResolvedValue({
			name: inherited.name,
			path: resolvedPath,
			description: "Review repository evidence",
			source: "project",
			instructions: resolvedInstructions,
		})

		await skillTool.handle(
			mockTask as Task,
			{
				type: "tool_use",
				name: "skill",
				params: {},
				partial: false,
				nativeArgs: { skill: inherited.name },
			},
			mockCallbacks,
		)

		expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringMatching(/no longer resolves|changed after this child task captured/),
		)
	})

	it("loads the exact captured mode-specific skill instead of a same-name code override", async () => {
		const capturedInstructions = "Architect-specific review workflow"
		const inherited = {
			name: "design-review",
			path: "F:/workspace/.alpha/skills-architect/design-review/SKILL.md",
			digest: digestValue(capturedInstructions),
		}
		Object.assign(mockTask, {
			taskKind: "subagent",
			getTaskMode: vi.fn(async () => "code"),
			getInheritedSubagentSkill: vi.fn(() => inherited),
			getInheritedSubagentSkillNames: vi.fn(() => [inherited.name]),
		})
		mockSkillsManager.getSkillContent.mockResolvedValue({
			name: inherited.name,
			path: "F:/workspace/.alpha/skills-code/design-review/SKILL.md",
			description: "Code override",
			source: "project",
			instructions: "Wrong code-mode instructions",
		})
		mockSkillsManager.getSkillContentByPath.mockResolvedValue({
			name: inherited.name,
			path: inherited.path,
			description: "Architect review",
			source: "project",
			instructions: capturedInstructions,
		})

		await skillTool.handle(
			mockTask as Task,
			{
				type: "tool_use",
				name: "skill",
				params: {},
				partial: false,
				nativeArgs: { skill: inherited.name },
			},
			mockCallbacks,
		)

		expect(mockSkillsManager.getSkillContentByPath).toHaveBeenCalledWith(inherited.name, inherited.path)
		expect(mockSkillsManager.getSkillContent).not.toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining(capturedInstructions))
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Base directory: F:/workspace/.alpha/skills-architect/design-review"),
		)
		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalledWith(
			expect.stringContaining("Wrong code-mode instructions"),
		)
	})
})
