import type OpenAI from "openai"

import { getNativeTools } from "../index"

type FunctionTool = OpenAI.Chat.ChatCompletionTool & { type: "function" }

const toolNames = (tools: OpenAI.Chat.ChatCompletionTool[]) =>
	tools.map((tool) => (tool as FunctionTool).function.name)

describe("parallel agent native tools", () => {
	it("are hidden by default", () => {
		expect(toolNames(getNativeTools())).not.toContain("spawn_agent")
		expect(toolNames(getNativeTools())).not.toContain("spawn_agents")
		expect(toolNames(getNativeTools())).not.toContain("wait_agent")
	})

	it("are exposed when parallel subagents are enabled", () => {
		const names = toolNames(getNativeTools({ parallelSubagentsEnabled: true }))

		expect(names).toEqual(
			expect.arrayContaining([
				"spawn_agent",
				"spawn_agents",
				"wait_agent",
				"send_input",
				"list_agents",
				"close_agent",
				"integrate_agent_result",
			]),
		)
	})
})
