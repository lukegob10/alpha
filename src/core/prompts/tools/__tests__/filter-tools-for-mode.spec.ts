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
	const lifecycleTools = ["spawn_agent", "list_agents", "wait_agent", "send_message", "followup_task", "close_agent"]
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		// Retained only as explicit historical fixtures; these must never be
		// re-advertised by the production mode filter.
		makeTool("delegate_task"),
		makeTool("report_progress"),
		makeTool("interrupt_agent"),
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
			expect.arrayContaining(["delegate_task", "report_progress", "interrupt_agent", "cancel_agent"]),
		)
		expect(askNames).not.toEqual(
			expect.arrayContaining(["delegate_task", "report_progress", "interrupt_agent", "cancel_agent"]),
		)
	})

	it("exposes read-only managed orchestration but no legacy or mutating tools in Plan mode", () => {
		const planTools = [
			...nativeTools,
			makeTool("ask_followup_question"),
			makeTool("attempt_completion"),
			makeTool("new_task"),
			makeTool("switch_mode"),
			makeTool("update_todo_list"),
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
				"ask_followup_question",
				"attempt_completion",
				"shell",
				...lifecycleTools,
			]),
		)
		expect(names).not.toEqual(
			expect.arrayContaining(["new_task", "switch_mode", "update_todo_list", "write_to_file", "use_mcp_tool"]),
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
