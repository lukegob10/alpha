import { describe, expect, it } from "vitest"

import { applyModelToolPreferences, getModelSurgicalEditTool } from "../router-tool-preferences"

describe("curated provider model tool preferences", () => {
	it.each([
		["openai-native", "gpt-6.1-sol", "apply_patch"],
		["anthropic", "claude-opus-5-5", "edit"],
		["gemini", "gemini-4-argon", "edit"],
		["xai", "grok-4.7", "edit"],
		["openrouter", "openai/gpt-6.1-sol", "apply_patch"],
		["openrouter", "anthropic/claude-sonnet-5.5", "edit"],
		["openrouter", "google/gemini-3.8-flash", "edit"],
	] as const)("uses the established editor for %s / %s", (provider, id, editor) => {
		expect(getModelSurgicalEditTool({ provider, id })).toBe(editor)
		expect(
			applyModelToolPreferences(
				{ provider, id },
				{ contextWindow: 100_000, supportsPromptCache: false, includedTools: ["apply_diff"] },
			).includedTools,
		).toEqual([editor])
	})
})
