import { describe, expect, it } from "vitest"
import { openAiModelInfoSaneDefaults } from "@alpha-code/types"

import { applyCopilotToolPreferences, applyModelToolPreferences } from "../router-tool-preferences"

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
		expect(result.excludedTools).toBeUndefined()
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
		"canonicalizes an explicit %s edit preference",
		(tool) => {
			const info = { ...openAiModelInfoSaneDefaults, includedTools: [tool], excludedTools: ["write_to_file"] }
			expect(applyCopilotToolPreferences({ vendor: "copilot", family: "gpt-5.5" }, info)).toMatchObject({
				includedTools: ["apply_patch"],
				excludedTools: ["write_to_file"],
			})
		},
	)

	it("canonicalizes stale exclusions while preserving unrelated metadata", () => {
		const excludedAlias = { ...openAiModelInfoSaneDefaults, excludedTools: ["search_and_replace"] }
		expect(
			applyCopilotToolPreferences({ vendor: "copilot", family: "claude-opus-4.7" }, excludedAlias),
		).toMatchObject({
			includedTools: ["edit"],
			excludedTools: [],
		})
		const original = {
			...openAiModelInfoSaneDefaults,
			includedTools: ["browser"],
			excludedTools: ["execute_command"],
		}
		const result = applyCopilotToolPreferences({ vendor: "copilot", family: "gemini-3.1-pro" }, original)
		expect(result).toEqual({
			...original,
			includedTools: ["browser", "edit"],
			excludedTools: ["shell"],
		})
		expect(original.includedTools).toEqual(["browser"])
	})

	it.each([
		[{ provider: "vertex", id: "gpt-5.5" }, "apply_patch"],
		[{ provider: "vertex", id: "xai/grok-4.6" }, "edit"],
		[{ provider: "stellar", id: "Meta-Llama-3.3-70B-Instruct" }, "edit"],
		[{ provider: "openai", id: "o3" }, "apply_patch"],
		[{ provider: "openai", id: "gemini-custom" }, "edit"],
	] as const)("routes %j to the safe canonical editor %s", (identity, preferred) => {
		const result = applyModelToolPreferences(identity, {
			...openAiModelInfoSaneDefaults,
			includedTools: ["apply_diff", "search_replace", "edit_file", "apply_patch"],
			excludedTools: ["apply_diff"],
		})
		expect(result.includedTools).toEqual([preferred])
		expect(result.includedTools).not.toEqual(expect.arrayContaining(["apply_diff", "search_replace", "edit_file"]))
		expect(result.excludedTools).toEqual([])
	})

	it("fails closed on conflicts and stale patch metadata", () => {
		const info = {
			...openAiModelInfoSaneDefaults,
			includedTools: ["apply_patch"],
			excludedTools: ["edit"],
		}
		const result = applyModelToolPreferences({ provider: "vertex", family: "claude-sonnet-5", id: "gpt-5.5" }, info)
		expect(result.includedTools).toEqual([])
		expect(result.excludedTools).toEqual([])
	})

	it("keeps a patch exclusion idempotent by selecting portable edit", () => {
		const info = {
			...openAiModelInfoSaneDefaults,
			includedTools: ["apply_patch"],
			excludedTools: ["apply_patch", "edit"],
		}
		const result = applyModelToolPreferences({ provider: "openai", id: "gpt-5.5" }, info)
		expect(result.includedTools).toEqual(["edit"])
		expect(result.excludedTools).toEqual(["apply_patch"])
		expect(applyModelToolPreferences({ provider: "openai", id: "gpt-5.5" }, result)).toEqual(result)
	})
})
