// npx vitest run core/prompts/tools/__tests__/filter-tools-for-mode.spec.ts

import type OpenAI from "openai"

import { filterMcpToolsForMode, filterNativeToolsForMode } from "../filter-tools-for-mode"

function makeTool(name: string): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: {
			name,
			description: `${name} tool`,
			parameters: { type: "object", properties: {} },
		},
	} as OpenAI.Chat.ChatCompletionTool
}

describe("filterNativeToolsForMode - disabledTools", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("shell"),
		makeTool("read_file"),
		makeTool("write_to_file"),
		makeTool("apply_diff"),
		makeTool("edit"),
	]

	it("removes tools listed in settings.disabledTools", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("shell")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).not.toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is empty", () => {
		const settings = {
			disabledTools: [],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("shell")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).not.toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is undefined", () => {
		const settings = {}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("shell")
		expect(resultNames).toContain("read_file")
	})

	it("combines disabledTools with other setting-based exclusions", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("shell")
		expect(resultNames).toContain("read_file")
	})

	it("disables canonical tool when disabledTools contains alias name", () => {
		const settings = {
			disabledTools: ["search_and_replace"],
			modelInfo: {
				includedTools: ["search_and_replace"],
			},
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("search_and_replace")
		expect(resultNames).not.toContain("edit")
	})

	it("keeps canonical schemas when model metadata uses historical aliases", () => {
		const tools = [makeTool("edit"), makeTool("write_to_file")]
		const result = filterNativeToolsForMode(tools, "code", undefined, undefined, undefined, {
			modelInfo: { includedTools: ["search_and_replace", "write_file"] },
		})
		const resultNames = result.map((tool) => (tool as any).function.name)
		expect(resultNames).toEqual(["edit", "write_to_file"])
		expect(resultNames).not.toEqual(expect.arrayContaining(["search_and_replace", "write_file"]))
	})
})

describe("mode-specific user input tool", () => {
	it("advertises request_user_input in Code and Plan while retaining legacy Code questions", () => {
		const tools = [makeTool("ask_followup_question"), makeTool("request_user_input")]
		const codeNames = filterNativeToolsForMode(tools, "code", undefined, undefined, undefined, {}).map(
			(tool) => (tool as any).function.name,
		)
		const planNames = filterNativeToolsForMode(tools, "architect", undefined, undefined, undefined, {}).map(
			(tool) => (tool as any).function.name,
		)

		expect(codeNames).toContain("ask_followup_question")
		expect(codeNames).toContain("request_user_input")
		expect(planNames).toContain("request_user_input")
		expect(planNames).not.toContain("ask_followup_question")
	})
})

describe("filterNativeToolsForMode - command schema aliases", () => {
	it("keeps the exec_command schema visible in Code and Plan while using shell policy", () => {
		const tools = [makeTool("exec_command"), makeTool("read_file")]

		for (const mode of ["code", "architect"]) {
			const result = filterNativeToolsForMode(tools, mode, undefined, undefined, undefined, {})
			expect(result.map((tool) => (tool as any).function.name)).toEqual(["exec_command", "read_file"])
		}
	})

	it("applies disabled command aliases and prefers one exec_command schema", () => {
		const tools = [makeTool("shell"), makeTool("exec_command")]
		const enabled = filterNativeToolsForMode(tools, "code", undefined, undefined, undefined, {})
		const disabled = filterNativeToolsForMode(tools, "code", undefined, undefined, undefined, {
			disabledTools: ["execute_command"],
		})

		expect(enabled.map((tool) => (tool as any).function.name)).toEqual(["exec_command"])
		expect(disabled).toEqual([])
	})
})

describe("filterNativeToolsForMode - canonical update_plan alias", () => {
	it("prefers update_plan and suppresses its saved-history alias when disabled", () => {
		const tools = [makeTool("update_todo_list"), makeTool("update_plan")]
		const enabled = filterNativeToolsForMode(tools, "code", undefined, undefined, undefined, {})
		const disabled = filterNativeToolsForMode(tools, "code", undefined, undefined, undefined, {
			todoListEnabled: false,
		})

		expect(enabled.map((tool) => (tool as any).function.name)).toEqual(["update_plan"])
		expect(disabled).toEqual([])
	})
})

describe("tool filtering - invalid mode fallback", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("read_file"),
		makeTool("write_to_file"),
		makeTool("shell"),
	]
	const mcpTools: OpenAI.Chat.ChatCompletionTool[] = [makeTool("mcp_server_tool")]

	it("uses Plan permissions when a persisted mode no longer exists", () => {
		const codeTools = filterNativeToolsForMode(nativeTools, "architect", undefined, {}, undefined, {})
		const fallbackTools = filterNativeToolsForMode(nativeTools, "deleted-custom-mode", undefined, {}, undefined, {})

		expect(fallbackTools).toEqual(codeTools)
		expect(filterMcpToolsForMode(mcpTools, "deleted-custom-mode", undefined, {})).toEqual(
			filterMcpToolsForMode(mcpTools, "architect", undefined, {}),
		)
	})
})

describe("filterMcpToolsForMode", () => {
	const mcpTools = [makeTool("mcp--docs--lookup"), makeTool("mcp--tickets--get")]

	it("keeps direct MCP descriptors for modes with the MCP group", () => {
		expect(filterMcpToolsForMode(mcpTools, "code", undefined, {})).toEqual(mcpTools)
	})

	it("denies direct MCP descriptors when the mode lacks the MCP group", () => {
		const mode = {
			slug: "code",
			name: "MCP disabled",
			roleDefinition: "Read files only",
			groups: ["read"],
		} as any

		expect(filterMcpToolsForMode(mcpTools, mode.slug, [mode], {})).toEqual([])
		expect(filterMcpToolsForMode(mcpTools, "architect", undefined, {})).toEqual([])
	})
})

describe("filterNativeToolsForMode - Code delegation", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("new_task"),
		makeTool("switch_mode"),
		makeTool("read_file"),
	]

	it("keeps task delegation but removes mode switching in Code", () => {
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {})

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("new_task")
		expect(resultNames).not.toContain("switch_mode")
	})
})

describe("filterNativeToolsForMode - bounded sub-agents", () => {
	const lifecycleTools = [
		"spawn_agent",
		"list_agents",
		"wait_agent",
		"send_message",
		"followup_task",
		"interrupt_agent",
	]
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		// Retained only as explicit historical fixtures; these must never be
		// re-advertised by the production mode filter.
		makeTool("delegate_task"),
		makeTool("report_progress"),
		makeTool("close_agent"),
		makeTool("cancel_agent"),
		...lifecycleTools.map(makeTool),
		makeTool("read_file"),
	]

	it("exposes bounded agent tools in Code mode", () => {
		const codeNames = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {}).map(
			(tool) => (tool as any).function.name,
		)
		const askNames = filterNativeToolsForMode(nativeTools, "ask", undefined, undefined, undefined, {}).map(
			(tool) => (tool as any).function.name,
		)

		expect(codeNames).toEqual(expect.arrayContaining(lifecycleTools))
		expect(askNames).toEqual(expect.arrayContaining(lifecycleTools))
		expect(codeNames).not.toEqual(
			expect.arrayContaining(["delegate_task", "report_progress", "cancel_agent", "close_agent"]),
		)
		expect(askNames).not.toEqual(
			expect.arrayContaining(["delegate_task", "report_progress", "cancel_agent", "close_agent"]),
		)
	})

	it("exposes read-only managed orchestration but no legacy or mutating tools in Plan mode", () => {
		const planTools = [
			...nativeTools,
			makeTool("ask_followup_question"),
			makeTool("request_user_input"),
			makeTool("attempt_completion"),
			makeTool("new_task"),
			makeTool("switch_mode"),
			makeTool("update_todo_list"),
			makeTool("update_plan"),
			makeTool("shell"),
			makeTool("manage_command"),
			makeTool("write_to_file"),
			makeTool("use_mcp_tool"),
		]
		const names = filterNativeToolsForMode(planTools, "architect", undefined, undefined, undefined, {}).map(
			(tool) => (tool as any).function.name,
		)

		expect(names).toEqual(
			expect.arrayContaining([
				"read_file",
				"spawn_agent",
				"request_user_input",
				"update_plan",
				"shell",
				...lifecycleTools,
			]),
		)
		expect(names).not.toContain("attempt_completion")
		expect(names).not.toEqual(
			expect.arrayContaining([
				"new_task",
				"switch_mode",
				"ask_followup_question",
				"update_todo_list",
				"write_to_file",
				"use_mcp_tool",
			]),
		)
	})

	it("ignores a persisted architect replacement when deriving native candidates", () => {
		const customModes = [
			{
				slug: "architect",
				name: "Legacy override",
				roleDefinition: "Mutate through MCP",
				groups: ["edit", "mcp"],
			},
		] as any
		const candidates = [
			makeTool("read_file"),
			makeTool("shell"),
			makeTool("write_to_file"),
			makeTool("use_mcp_tool"),
		]

		const names = filterNativeToolsForMode(candidates, "architect", customModes, {}, undefined, {}).map(
			(tool) => (tool as any).function.name,
		)

		expect(names).toEqual(["read_file", "shell"])
	})

	it("respects the existing disabled-tool configuration", () => {
		const names = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			disabledTools: ["delegate_task"],
		}).map((tool) => (tool as any).function.name)

		expect(names).not.toContain("delegate_task")
	})

	it("can disable asynchronous spawning while preserving the remaining lifecycle tools", () => {
		const names = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			disabledTools: ["spawn_agent"],
		}).map((tool) => (tool as any).function.name)

		expect(names).not.toContain("spawn_agent")
		expect(names).toEqual(expect.arrayContaining(lifecycleTools.filter((tool) => tool !== "spawn_agent")))
	})

	it("restores a custom execution mode to the canonical Plan tool policy", () => {
		const customModes = [
			{
				slug: "research",
				name: "Research",
				roleDefinition: "Inspect a repository",
				groups: ["read", "agents"],
			},
		] as any

		const names = filterNativeToolsForMode(nativeTools, "research", customModes, undefined, undefined, {}).map(
			(tool) => (tool as any).function.name,
		)

		expect(names).toContain("spawn_agent")
		expect(names).toEqual(expect.arrayContaining(lifecycleTools))
		expect(names).not.toContain("delegate_task")
	})
})
