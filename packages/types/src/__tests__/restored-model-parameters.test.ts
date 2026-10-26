import { describe, expect, it } from "vitest"

import { resolveModelParameterApplicability, resolveOptionalOutputTokenLimit } from "../model-parameters.js"
import { getCuratedProviderModels, type CuratedProvider } from "../provider-settings.js"

describe("curated provider request controls", () => {
	it.each(["openai-native", "anthropic", "gemini", "xai", "openrouter"] satisfies CuratedProvider[])(
		"validates verified %s output ceilings without changing compatible endpoint behavior",
		(provider) => {
			for (const model of Object.values(getCuratedProviderModels(provider))) {
				const maximum = model.maxTokens!
				const settings = { includeMaxTokens: true, modelMaxTokens: maximum + 1 }
				expect(() => resolveOptionalOutputTokenLimit({ model, settings, enforceModelMaximum: true })).toThrow(
					/model maximum/,
				)
				expect(resolveOptionalOutputTokenLimit({ model, settings })).toBe(maximum + 1)
			}
		},
	)
	it.each([
		["openai-native", "openai-responses"],
		["anthropic", "anthropic-messages"],
		["gemini", "gemini"],
		["xai", "xai-responses"],
		["openrouter", "openai-chat-completions"],
	] as const)("uses %s's own model capabilities in both request paths", (provider, route) => {
		for (const [modelId, model] of Object.entries(getCuratedProviderModels(provider))) {
			for (const requestKind of ["task", "single-completion"] as const) {
				const result = resolveModelParameterApplicability({
					provider,
					modelId,
					model,
					requestKind,
					settings: { openAiUseAzure: true, openAiBaseUrl: "https://unrelated.example/v1" },
				})
				expect(result.route).toBe(route)
				expect(result.supportsTemperature).toBe(model.supportsTemperature === true)
				expect(result.supportsVerbosity).toBe(
					(provider === "openai-native" || provider === "openrouter") && model.supportsVerbosity === true,
				)
			}
		}
	})

	it.each(["openai-native", "anthropic", "gemini", "xai", "openrouter"] satisfies CuratedProvider[])(
		"does not grant controls from imported metadata for unknown %s models",
		(provider) => {
			expect(
				resolveModelParameterApplicability({
					provider,
					modelId: "unknown-model",
					model: {
						contextWindow: 1,
						supportsPromptCache: true,
						supportsTemperature: true,
						supportsVerbosity: true,
					},
				}),
			).toEqual({ route: "unsupported", supportsTemperature: false, supportsVerbosity: false })
		},
	)
})
