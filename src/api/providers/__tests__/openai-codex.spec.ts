// npx vitest run api/providers/__tests__/openai-codex.spec.ts

import { OpenAiCodexHandler } from "../openai-codex"
import { delegate_task } from "../../../core/prompts/tools/native-tools/delegate_task"

describe("OpenAiCodexHandler.getModel", () => {
	it.each([
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-5.5",
		"gpt-5.1",
		"gpt-5",
		"gpt-5.1-codex",
		"gpt-5-codex",
		"gpt-5-codex-mini",
		"gpt-5.3-codex-spark",
	])("should return specified model when a valid model id is provided: %s", (apiModelId) => {
		const handler = new OpenAiCodexHandler({ apiModelId })
		const model = handler.getModel()

		expect(model.id).toBe(apiModelId)
		expect(model.info).toBeDefined()
		// Default reasoning effort for GPT-5 family
		expect(model.info.reasoningEffort).toBe("medium")
	})

	it("should fall back to default model when an invalid model id is provided", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "not-a-real-model" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.6-sol")
		expect(model.info).toBeDefined()
	})

	it("should use GPT-5.6 Sol capabilities and subscription defaults", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.6-sol" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.6-sol")
		expect(model.info.contextWindow).toBe(272_000)
		expect(model.info.maxTokens).toBe(128_000)
		expect(model.info.reasoningEffort).toBe("low")
		expect(model.info.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh", "max"])
	})

	it("should use Spark-specific limits and capabilities", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.3-codex-spark" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.3-codex-spark")
		expect(model.info.contextWindow).toBe(128000)
		expect(model.info.maxTokens).toBe(8192)
		expect(model.info.supportsImages).toBe(false)
	})

	it("should use GPT-5.4 Mini capabilities when selected", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.4-mini" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.4-mini")
		expect(model.info).toBeDefined()
	})
})

describe("OpenAiCodexHandler strict tool schemas", () => {
	it("sends the flat delegate task shape as strict parameters", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.6-luna" })
		const body = (handler as any).buildRequestBody(handler.getModel(), [], "system", undefined, {
			tools: [delegate_task],
		})
		const tool = body.tools[0]
		const task = tool.parameters.properties.tasks.items

		expect(tool.strict).toBe(true)
		expect(task).not.toHaveProperty("anyOf")
		expect(task.required).toEqual(["objective", "fork_turns", "agent_kind", "write_scope", "expected_output"])
		expect(task.properties.fork_turns).toMatchObject({
			pattern: "^(?:none|all|[1-9][0-9]*)$",
			maxLength: 16,
		})
		expect(task.properties.agent_kind.enum).toEqual(["explore", "review", "worker"])
		expect(task.properties.write_scope.anyOf).toEqual([
			expect.objectContaining({ type: "array", minItems: 1, maxItems: 12 }),
			{ type: "null" },
		])
		expect(task.properties.expected_output.type).toEqual(["array", "null"])
	})
})
