import { describe, expect, it } from "vitest"
import { openAiModelInfoSaneDefaults, type ModelInfo } from "@alpha-code/types"

import { applyCopilotToolPreferences } from "../router-tool-preferences"

describe("Claude Copilot tool preference metadata", () => {
	it.each([
		{ vendor: "copilot", family: "claude-sonnet-4.6", id: "opaque-selected-model" },
		{ vendor: "copilot", id: "anthropic/claude-opus-4.7" },
		{ vendor: "copilot", id: "copilot-claude-haiku-4.5" },
		{ vendor: " Copilot ", family: " Claude-Sonnet-4.6 " },
	])("resolves the selected Claude identity without requiring a catalog lookup: %j", (model) => {
		const result = applyCopilotToolPreferences(model, openAiModelInfoSaneDefaults)

		expect(result.includedTools).toEqual(["edit"])
		expect(result.excludedTools).toBeUndefined()
	})

	it("removes stale GPT preferences without mutating cached Claude capabilities", () => {
		const info: ModelInfo = {
			...openAiModelInfoSaneDefaults,
			supportsImages: true,
			supportsReasoningEffort: ["low", "medium", "high"],
			preserveReasoning: true,
			includedTools: ["apply_patch", "search_and_replace", "browser"],
			excludedTools: ["apply_patch", "execute_command"],
		}
		const original = structuredClone(info)
		Object.freeze(info.includedTools)
		Object.freeze(info.excludedTools)
		Object.freeze(info.supportsReasoningEffort)
		Object.freeze(info)
		const model = { vendor: "copilot", family: "claude-sonnet-4.6", id: "opaque-selected-model" }

		const result = applyCopilotToolPreferences(model, info)

		expect(result).toEqual({
			...original,
			includedTools: ["browser", "edit"],
			excludedTools: ["apply_patch", "exec_command"],
		})
		expect(info).toEqual(original)
		expect(applyCopilotToolPreferences(model, result)).toBe(result)
	})

	it("drops stale surgical preferences when the selected Claude ID conflicts with the family", () => {
		const result = applyCopilotToolPreferences(
			{ vendor: "copilot", family: "gpt-5.5", id: "anthropic/claude-opus-4.7" },
			{ ...openAiModelInfoSaneDefaults, includedTools: ["apply_patch", "edit", "browser"] },
		)

		expect(result.includedTools).toEqual(["browser"])
	})
})
