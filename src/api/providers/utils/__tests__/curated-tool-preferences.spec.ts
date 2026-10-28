import { describe, expect, it } from "vitest"

import { applyModelToolPreferences, getModelSurgicalEditTool } from "../router-tool-preferences"

describe("curated provider model tool preferences", () => {
	it.each([
		["openai-native", "gpt-6.1-sol", "apply_patch"],
		["openai-codex", "gpt-6.1-sol", "apply_patch"],
		["anthropic", "claude-opus-5-5", "edit"],
		["gemini", "gemini-4-argon", "edit"],
		["xai", "grok-4.7", "edit"],
		["openrouter", "openai/gpt-6.1-sol", "apply_patch"],
		["openrouter", "anthropic/claude-sonnet-5.5", "edit"],
		["openrouter", "google/gemini-4-argon", "edit"],
	] as const)("uses the established editor for %s / %s", (provider, id, editor) => {
		expect(getModelSurgicalEditTool({ provider, id })).toBe(editor)
		expect(
			applyModelToolPreferences(
				{ provider, id },
				{ contextWindow: 100_000, supportsPromptCache: false, includedTools: ["apply_diff"] },
			).includedTools,
		).toEqual([editor])
	})

	it.each([
		["global.openai.gpt-6.1-sol", "gpt-6.1-sol", "apply_patch"],
		["global.anthropic.claude-fable-5-1", "claude-fable-5-1", "edit"],
	] as const)("uses the verified Bedrock %s family for its editor preference", (id, family, editor) => {
		expect(getModelSurgicalEditTool({ provider: "bedrock", id, family })).toBe(editor)
	})

	it("keeps the portable editor for Meta without inheriting another model's patch preference", () => {
		const info = applyModelToolPreferences(
			{ provider: "meta", id: "muse-wonder-1.0" },
			{ contextWindow: 1_048_576, supportsPromptCache: true, includedTools: ["apply_patch"] },
		)
		expect(info.includedTools).not.toContain("apply_patch")
		expect(info.excludedTools ?? []).not.toContain("edit")
	})
})
