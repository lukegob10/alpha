import { describe, expect, it } from "vitest"

import type { ModelInfo } from "./model.js"
import type { ProviderSettings } from "./provider-settings.js"
import { modelInfoSchema } from "./model.js"
import { providerSettingsSchema } from "./provider-settings.js"
import { resolveVertexGatewayRoute, resolveVertexOpenAiModelInfo, vertexModels } from "./providers/vertex.js"
import { openAiModelInfoSaneDefaults } from "./providers/openai.js"
import { resolveStellarModelInfo } from "./providers/stellar.js"
import {
	isMaxOutputTokensIncluded,
	resolveOptionalOutputTokenLimit,
	resolveModelParameterApplicability,
	usesOpenAiResponsesApi,
} from "./model-parameters.js"

const model: ModelInfo = {
	contextWindow: 100_000,
	maxTokens: 8_192,
	supportsPromptCache: false,
	supportsTemperature: true,
	supportsVerbosity: true,
}

describe("per-response output limits", () => {
	it.each([true, false, undefined])("matches saved inclusion %s", (includeMaxTokens) => {
		const settings = { includeMaxTokens }
		expect(isMaxOutputTokensIncluded(settings)).toBe(includeMaxTokens === true)
		expect(resolveOptionalOutputTokenLimit({ model, settings })).toBe(includeMaxTokens === true ? 8_192 : undefined)
	})
	it.each([-1, undefined, null])("omits the server-default model limit %s", (maxTokens) => {
		expect(
			resolveOptionalOutputTokenLimit({ model: { ...model, maxTokens }, settings: { includeMaxTokens: true } }),
		).toBeUndefined()
	})
	it("honors a positive explicit override and the override sentinel", () => {
		for (const modelMaxTokens of [1, 1_000, 120_000]) {
			expect(
				resolveOptionalOutputTokenLimit({ model, settings: { includeMaxTokens: true, modelMaxTokens } }),
			).toBe(modelMaxTokens)
		}
		expect(
			resolveOptionalOutputTokenLimit({ model, settings: { includeMaxTokens: true, modelMaxTokens: -1 } }),
		).toBeUndefined()
	})
	it.each([0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid explicit request limits %s without falling back",
		(modelMaxTokens) => {
			expect(() =>
				resolveOptionalOutputTokenLimit({ model, settings: { includeMaxTokens: true, modelMaxTokens } }),
			).toThrow(RangeError)
			expect(() =>
				resolveOptionalOutputTokenLimit({
					model: { ...model, maxTokens: modelMaxTokens },
					settings: { includeMaxTokens: true },
				}),
			).toThrow(RangeError)
		},
	)
	it("preserves invalid imported compatibility fields while they are not requested", () => {
		const saved = providerSettingsSchema.parse({ includeMaxTokens: false, modelMaxTokens: -2 })
		expect(saved.modelMaxTokens).toBe(-2)
		expect(resolveOptionalOutputTokenLimit({ model, settings: saved })).toBeUndefined()
		expect(modelInfoSchema.parse({ ...model, maxTokens: -1 }).maxTokens).toBe(-1)
	})
	it("does not turn context size or managed-tree budgets into a response cap", () => {
		const settings: ProviderSettings = { includeMaxTokens: true, vsCodeLmContextSize: 32_000 }
		expect(resolveOptionalOutputTokenLimit({ model: { ...model, maxTokens: -1 }, settings })).toBeUndefined()
		expect(settings.vsCodeLmContextSize).toBe(32_000)
	})
	it("validates the native Responses minimum without imposing it on compatible servers", () => {
		for (const modelMaxTokens of [1, 15]) {
			const settings = { includeMaxTokens: true, modelMaxTokens }
			expect(() => resolveOptionalOutputTokenLimit({ model, settings, route: "openai-responses" })).toThrow(
				"at least 16",
			)
			expect(resolveOptionalOutputTokenLimit({ model, settings, route: "openai-chat-completions" })).toBe(
				modelMaxTokens,
			)
		}
		for (const modelMaxTokens of [-1, 16]) {
			expect(
				resolveOptionalOutputTokenLimit({
					model,
					settings: { includeMaxTokens: true, modelMaxTokens },
					route: "openai-responses",
				}),
			).toBe(modelMaxTokens === -1 ? undefined : 16)
		}
	})
})

describe("model parameter applicability", () => {
	it.each(["gpt-5.5", "gpt-6.1-sol"])("uses the exact native Responses route for %s", (modelId) => {
		expect(resolveModelParameterApplicability({ provider: "openai", modelId, model })).toEqual({
			route: "openai-responses",
			supportsTemperature: false,
			supportsVerbosity: true,
		})
	})
	it.each(["openai", "stellar"])("keeps %s text-only completions on Chat Completions", (provider) => {
		const settings: ProviderSettings = {
			stellarBaseUrl: "https://api.openai.com/v1",
			modelTemperature: 0.8,
			verbosity: "high",
			includeMaxTokens: true,
			modelMaxTokens: 1,
		}
		const saved = structuredClone(settings)
		const applicability = resolveModelParameterApplicability({
			provider,
			modelId: "gpt-6.1-sol",
			model,
			settings,
			requestKind: "single-completion",
		})
		expect(applicability).toEqual({
			route: "openai-chat-completions",
			supportsTemperature: false,
			supportsVerbosity: true,
		})
		expect(resolveOptionalOutputTokenLimit({ model, settings, route: applicability.route })).toBe(1)
		expect(settings).toEqual(saved)
		expect(resolveModelParameterApplicability({ provider, modelId: "gpt-6.1-sol", model, settings }).route).toBe(
			"openai-responses",
		)
	})
	it.each([false, undefined])("withholds undeclared text-only native verbosity for %s", (supportsVerbosity) => {
		expect(
			resolveModelParameterApplicability({
				provider: "openai",
				modelId: "gpt-6.1-sol",
				model: { ...model, supportsVerbosity },
				requestKind: "single-completion",
			}),
		).toEqual({ route: "openai-chat-completions", supportsTemperature: false, supportsVerbosity: false })
	})
	it.each([
		{ openAiBaseUrl: "https://gateway.example/v1" },
		{ openAiUseAzure: true },
		{ openAiR1FormatEnabled: true },
	])("keeps text-only compatible sampling and omits native verbosity for %j", (settings) => {
		expect(
			resolveModelParameterApplicability({
				provider: "openai",
				modelId: "gpt-6.1-sol",
				model: { ...model, supportsTemperature: undefined },
				settings,
				requestKind: "single-completion",
			}),
		).toEqual({ route: "openai-chat-completions", supportsTemperature: true, supportsVerbosity: false })
	})
	it("does not infer text-only native verbosity from an unknown model name", () => {
		expect(
			resolveModelParameterApplicability({
				provider: "openai",
				modelId: "gpt-6.1-sol-preview",
				model,
				requestKind: "single-completion",
			}),
		).toEqual({ route: "openai-chat-completions", supportsTemperature: true, supportsVerbosity: false })
	})
	it.each([
		{ openAiBaseUrl: "https://gateway.example/v1" },
		{ openAiUseAzure: true },
		{ openAiR1FormatEnabled: true },
	])("keeps compatible route capabilities for %j", (settings) => {
		expect(
			resolveModelParameterApplicability({ provider: "openai", modelId: "gpt-6.1-sol", model, settings }),
		).toEqual({
			route: "openai-chat-completions",
			supportsTemperature: true,
			supportsVerbosity: false,
		})
	})
	it.each(["gpt-6.1-sol-preview", "future-model", "vendor/gpt-6.1-sol"])(
		"does not infer a native capability from %s",
		(modelId) => {
			expect(usesOpenAiResponsesApi(modelId)).toBe(false)
			expect(
				resolveModelParameterApplicability({
					provider: "openai",
					modelId,
					model: { ...model, supportsTemperature: undefined },
				}),
			).toMatchObject({
				route: "openai-chat-completions",
				supportsTemperature: true,
				supportsVerbosity: false,
			})
		},
	)
	it.each(["vscode-lm", "retired-provider"])("ignores imported capability flags on %s", (provider) => {
		expect(resolveModelParameterApplicability({ provider, modelId: "gpt-6.1-sol", model })).toMatchObject({
			supportsTemperature: false,
			supportsVerbosity: false,
		})
	})
	it.each(["vertex", "stellar"])("preserves advertised compatible support on %s", (provider) => {
		expect(resolveModelParameterApplicability({ provider, modelId: "partner-model", model })).toMatchObject({
			supportsTemperature: true,
			supportsVerbosity: false,
		})
	})
	it.each(["claude-sonnet-4", "gemini-2.5-flash"])("preserves Vertex sampling for %s", (modelId) => {
		expect(resolveModelParameterApplicability({ provider: "vertex", modelId, model }).supportsTemperature).toBe(
			true,
		)
		expect(
			resolveModelParameterApplicability({
				provider: "vertex",
				modelId,
				model: { ...model, supportsTemperature: false },
			}).supportsTemperature,
		).toBe(false)
	})
	it("resolves Stellar's effective endpoint rather than unrelated saved OpenAI settings", () => {
		expect(
			resolveModelParameterApplicability({
				provider: "stellar",
				modelId: "gpt-5.5",
				model,
				settings: { stellarBaseUrl: "https://api.openai.com/v1", openAiBaseUrl: "https://stale.example/v1" },
			}),
		).toMatchObject({ route: "openai-responses", supportsTemperature: false, supportsVerbosity: true })
	})
	it.each([
		{ modelRoutingMap: { "partner-model": " o3-custom " } },
		{ modelRoutingMap: { "partner-model": { modelOverride: "o4-deployment" } } },
		{ vertexGatewayModelRoutingMap: '{"partner-model":"o1-deployment"}' },
	])("uses the effective Vertex request model in %j without guessing its capabilities", (settings) => {
		expect(
			resolveModelParameterApplicability({ provider: "vertex", modelId: "partner-model", model, settings }),
		).toMatchObject({
			route: "openai-chat-completions",
			supportsTemperature: false,
		})
	})
	it("keeps malformed routing edits recoverable while request validation rejects them", () => {
		const settings = { modelRoutingMap: "{" }
		expect(
			resolveModelParameterApplicability({ provider: "vertex", modelId: "partner-model", model, settings }),
		).toMatchObject({
			route: "unsupported",
			supportsTemperature: false,
		})
		expect(() => resolveVertexGatewayRoute(settings, "partner-model")).toThrow("Invalid modelRoutingMap JSON")
	})
	it.each(["o1", "o3-mini", "o4-mini"])("reflects the existing reasoning-family route for %s", (modelId) => {
		expect(resolveModelParameterApplicability({ provider: "openai", modelId, model }).supportsTemperature).toBe(
			false,
		)
	})
	it("preserves legacy compatible descriptors and treats an explicit opt-out as authoritative", () => {
		const resolve = (modelInfo?: ModelInfo) =>
			resolveModelParameterApplicability({ provider: "openai", modelId: "custom-model", model: modelInfo })
		expect(resolve().supportsTemperature).toBe(false)
		expect(resolve({ ...model, supportsTemperature: undefined }).supportsTemperature).toBe(true)
		expect(resolve(openAiModelInfoSaneDefaults).supportsTemperature).toBe(true)
		expect(
			resolve({ ...model, supportsTemperature: undefined, supportedParameters: ["max_tokens"] })
				.supportsTemperature,
		).toBe(false)
		expect(
			resolve({ ...model, supportsTemperature: undefined, supportedParameters: ["temperature"] })
				.supportsTemperature,
		).toBe(true)
		expect(
			resolve({ ...model, supportsTemperature: false, supportedParameters: ["temperature"] }).supportsTemperature,
		).toBe(false)
		for (const supportsVerbosity of [false, undefined]) {
			expect(
				resolveModelParameterApplicability({
					provider: "openai",
					modelId: "gpt-5.5",
					model: { ...model, supportsVerbosity },
				}).supportsVerbosity,
			).toBe(false)
		}
	})
	it.each(["claude-unknown", "gemini-unknown"])("withholds undeclared Vertex sampling support for %s", (modelId) => {
		expect(
			resolveModelParameterApplicability({
				provider: "vertex",
				modelId,
				model: { ...model, supportsTemperature: undefined },
			}).supportsTemperature,
		).toBe(false)
	})
	it("projects the same existing Stellar fallback for custom gateway IDs", () => {
		const customId = "custom-deployment"
		expect(
			resolveModelParameterApplicability({
				provider: "stellar",
				modelId: customId,
				model: resolveStellarModelInfo(customId),
			}).supportsTemperature,
		).toBe(true)
	})
	it("projects the same legacy Vertex partner fallback for unknown gateway IDs", () => {
		const modelId = "partner-future"
		expect(resolveVertexOpenAiModelInfo(modelId)).toBe(openAiModelInfoSaneDefaults)
		expect(resolveVertexOpenAiModelInfo("claude-sonnet-4-6")).toBe(vertexModels["claude-sonnet-4-6"])
		expect(
			resolveModelParameterApplicability({
				provider: "vertex",
				modelId,
				model: resolveVertexOpenAiModelInfo(modelId),
				settings: { modelTemperature: 0.8 },
			}),
		).toMatchObject({ route: "openai-chat-completions", supportsTemperature: true, supportsVerbosity: false })
	})
	it.each(["openai", "vertex"])("separates fixed reasoning temperature from editable %s sampling", (provider) => {
		const modelId = provider === "vertex" ? "claude-sonnet-4-6" : "custom-model"
		const reasoningModel = { ...model, supportsReasoningBudget: true }
		expect(resolveModelParameterApplicability({ provider, modelId, model: reasoningModel })).toMatchObject({
			supportsTemperature: true,
		})
		expect(
			resolveModelParameterApplicability({
				provider,
				modelId,
				model: reasoningModel,
				settings: { enableReasoningEffort: true, modelTemperature: 0.4 },
			}),
		).toMatchObject({ supportsTemperature: false, fixedTemperature: 1 })
		expect(
			resolveModelParameterApplicability({
				provider,
				modelId,
				model: { ...reasoningModel, supportsTemperature: false },
				settings: { enableReasoningEffort: true },
			}).fixedTemperature,
		).toBeUndefined()
	})
	it("preserves editable Gemini sampling while reasoning is active", () => {
		expect(
			resolveModelParameterApplicability({
				provider: "vertex",
				modelId: "gemini-2.5-flash",
				model: { ...model, supportsReasoningBudget: true },
				settings: { enableReasoningEffort: true },
			}),
		).toMatchObject({ supportsTemperature: true })
	})
	it("does not change saved preferences when the provider or route changes", () => {
		const settings: ProviderSettings = { openAiModelId: "gpt-5.5", modelTemperature: 0.4, verbosity: "high" }
		const saved = structuredClone(settings)
		for (const provider of ["openai", "vscode-lm", "stellar", "vertex"]) {
			resolveModelParameterApplicability({ provider, modelId: "gpt-5.5", model, settings })
		}
		expect(settings).toEqual(saved)
	})
})
