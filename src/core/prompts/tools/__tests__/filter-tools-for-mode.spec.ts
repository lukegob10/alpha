// npx vitest run core/prompts/tools/__tests__/filter-tools-for-mode.spec.ts

import type OpenAI from "openai"

import { filterNativeToolsForMode } from "../filter-tools-for-mode"

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
		makeTool("execute_command"),
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
		expect(resultNames).not.toContain("execute_command")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is empty", () => {
		const settings = {
			disabledTools: [],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("execute_command")
		expect(resultNames).toContain("read_file")
		expect(resultNames).toContain("write_to_file")
		expect(resultNames).toContain("apply_diff")
	})

	it("does not remove any tools when disabledTools is undefined", () => {
		const settings = {}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("execute_command")
		expect(resultNames).toContain("read_file")
	})

	it("combines disabledTools with other setting-based exclusions", () => {
		const settings = {
			disabledTools: ["execute_command"],
		}

		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, settings)

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).not.toContain("execute_command")
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
})

describe("filterNativeToolsForMode - orchestrator delegation", () => {
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("new_task"),
		makeTool("switch_mode"),
		makeTool("read_file"),
	]

	it("keeps delegation tools available in orchestrator mode", () => {
		const result = filterNativeToolsForMode(nativeTools, "orchestrator", undefined, undefined, undefined, {})

		const resultNames = result.map((t) => (t as any).function.name)
		expect(resultNames).toContain("new_task")
		expect(resultNames).toContain("switch_mode")
	})
})

describe("filterNativeToolsForMode - bounded sub-agents", () => {
	const lifecycleTools = [
		"list_agents",
		"wait_agent",
		"send_message",
		"followup_task",
		"interrupt_agent",
		"cancel_agent",
		"close_agent",
	]
	const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
		makeTool("delegate_task"),
		makeTool("spawn_agent"),
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

		expect(codeNames).toContain("delegate_task")
		expect(codeNames).toContain("spawn_agent")
		expect(codeNames).toEqual(expect.arrayContaining(lifecycleTools))
		expect(askNames).not.toContain("delegate_task")
		expect(askNames).not.toContain("spawn_agent")
		expect(askNames.filter((name) => lifecycleTools.includes(name))).toEqual([])
	})

	it("respects the existing disabled-tool configuration", () => {
		const names = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			disabledTools: ["delegate_task"],
		}).map((tool) => (tool as any).function.name)

		expect(names).not.toContain("delegate_task")
	})

	it("can disable asynchronous spawning without disabling legacy delegation", () => {
		const names = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			disabledTools: ["spawn_agent"],
		}).map((tool) => (tool as any).function.name)

		expect(names).not.toContain("spawn_agent")
		expect(names).toContain("delegate_task")
	})

	it("does not grant asynchronous lifecycle controls to a custom mode through the agents group", () => {
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

		expect(names).not.toContain("spawn_agent")
		expect(names.filter((name) => lifecycleTools.includes(name))).toEqual([])
		expect(names).toContain("delegate_task")
	})
})
