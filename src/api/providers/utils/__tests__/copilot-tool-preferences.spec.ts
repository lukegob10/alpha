import { describe, expect, it } from "vitest"
import { openAiModelInfoSaneDefaults } from "@alpha-code/types"

import { applyCopilotToolPreferences } from "../router-tool-preferences"

describe("Copilot edit-tool preferences", () => {
	it.each([
		["gpt-5.6-luna", "apply_patch"],
		["gpt-5.3-codex", "apply_patch"],
		["o3", "apply_patch"],
		["claude-opus-4.7", "edit"],
		["gemini-3.1-pro-preview", "edit"],
	])("uses the actual %s family without changing write_to_file", (family, preferred) => {
		const result = applyCopilotToolPreferences(
			{ vendor: "copilot", family, id: "opaque-id" },
			openAiModelInfoSaneDefaults,
		)
		expect(result.includedTools).toEqual([preferred])
		expect(result.excludedTools).toEqual(["apply_diff"])
	})

	it.each(["gpt-5.5", "copilot-gpt-5.5", "openai/gpt-5.5"])(
		"uses a recognized id when family is missing: %s",
		(id) => {
			expect(
				applyCopilotToolPreferences({ vendor: "copilot", id }, openAiModelInfoSaneDefaults).includedTools,
			).toEqual(["apply_patch"])
		},
	)

	it.each([
		{ vendor: "copilot" },
		{ vendor: "copilot", family: "auto", id: "custom", name: "GPT-5.5", version: "gpt-5.5" },
		{ vendor: "copilot", family: "raptor-mini", id: "oswe-vscode-prime" },
		{ vendor: "copilot", family: "custom-gpt-5.5-wrapper" },
		{ vendor: "copilot", family: "gpt-5.5", id: "claude-opus-4.7" },
		{ vendor: "vertex", family: "gemini-3.1-pro" },
		{ vendor: "other", family: "gpt-5.5" },
		{ family: "gpt-5.5" },
	])("retains existing preferences for unknown, conflicting, or non-Copilot identity: %j", (model) => {
		expect(applyCopilotToolPreferences(model, openAiModelInfoSaneDefaults)).toBe(openAiModelInfoSaneDefaults)
	})

	it.each(["apply_patch", "edit", "search_replace", "edit_file", "search_and_replace", "apply_diff"])(
		"preserves an explicit %s edit-tool override",
		(tool) => {
			const info = { ...openAiModelInfoSaneDefaults, includedTools: [tool], excludedTools: ["write_to_file"] }
			expect(applyCopilotToolPreferences({ vendor: "copilot", family: "gpt-5.5" }, info)).toBe(info)
		},
	)

	it("respects an explicitly excluded preference and preserves unrelated metadata", () => {
		const excludedAlias = { ...openAiModelInfoSaneDefaults, excludedTools: ["search_and_replace"] }
		expect(applyCopilotToolPreferences({ vendor: "copilot", family: "claude-opus-4.7" }, excludedAlias)).toBe(
			excludedAlias,
		)
		const info = { ...openAiModelInfoSaneDefaults, excludedTools: ["apply_patch"] }
		expect(applyCopilotToolPreferences({ vendor: "copilot", family: "gpt-5.5" }, info)).toBe(info)
		const original = {
			...openAiModelInfoSaneDefaults,
			includedTools: ["browser"],
			excludedTools: ["execute_command"],
		}
		const result = applyCopilotToolPreferences({ vendor: "copilot", family: "gemini-3.1-pro" }, original)
		expect(result).toEqual({
			...original,
			includedTools: ["browser", "edit"],
			excludedTools: ["execute_command", "apply_diff"],
		})
		expect(original.includedTools).toEqual(["browser"])
	})
})
