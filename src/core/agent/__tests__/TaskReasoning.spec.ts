import type { ModelInfo, ProviderSettings } from "@alpha-code/types"

import { resolveTaskReasoning } from "../TaskReasoning"

const modelInfo = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
	contextWindow: 128_000,
	supportsPromptCache: false,
	...overrides,
})

const configuration = (overrides: Partial<ProviderSettings> = {}): ProviderSettings => ({
	apiProvider: "openai",
	openAiModelId: "test-model",
	...overrides,
})

describe("resolveTaskReasoning", () => {
	it("keeps the requested effort when an explicit custom capability list rejects it", () => {
		const info = modelInfo({ supportsReasoningEffort: ["none", "low"], reasoningEffort: "low" })
		const profile = configuration({ enableReasoningEffort: true, openAiCustomModelInfo: info })
		const result = resolveTaskReasoning(profile, { kind: "effort", effort: "high" }, { id: "test-model", info })
		expect(result.state).toMatchObject({
			requested: { kind: "effort", effort: "high" },
			effective: { kind: "effort", effort: "low" },
			fallbackReason: "unsupported",
			capabilities: { efforts: ["none", "low"] },
		})
	})

	it("resolves legacy custom-profile levels without changing the saved profile", () => {
		const info = modelInfo({ reasoningEffort: "low" })
		const profile = configuration({ enableReasoningEffort: true, openAiCustomModelInfo: info })
		const before = structuredClone(profile)
		for (const effort of ["low", "medium", "high"] as const) {
			const result = resolveTaskReasoning(profile, { kind: "effort", effort }, { id: "test-model", info })
			expect(result.state.capabilities).toEqual({
				kind: "effort",
				efforts: ["low", "medium", "high", "xhigh"],
				canDisable: true,
			})
			expect(result.state.effective).toEqual({ kind: "effort", effort })
			expect(result.configuration.reasoningEffort).toBe(effort)
		}
		expect(resolveTaskReasoning(profile, { kind: "default" }, { id: "test-model", info }).state.effective).toEqual({
			kind: "effort",
			effort: "low",
		})
		expect(profile).toEqual(before)
	})

	it("resolves a default catalogued effort without rebuilding an unchanged configuration", () => {
		const profile = configuration()
		const result = resolveTaskReasoning(
			profile,
			{ kind: "default" },
			{
				id: "test-model",
				info: modelInfo({ supportsReasoningEffort: ["low", "high"], reasoningEffort: "high" }),
			},
		)

		expect(result.configuration).toBe(profile)
		expect(result.state.effective).toEqual({ kind: "effort", effort: "high" })
		expect(result.state.capabilities).toEqual({
			kind: "effort",
			efforts: ["low", "high"],
			canDisable: true,
		})
	})

	it("sanitizes an invalid profile effort to the model default", () => {
		const profile = configuration({ reasoningEffort: "medium", enableReasoningEffort: true })
		const result = resolveTaskReasoning(
			profile,
			{ kind: "default" },
			{
				id: "test-model",
				info: modelInfo({ supportsReasoningEffort: ["low", "high"], reasoningEffort: "high" }),
			},
		)

		expect(result.configuration).not.toBe(profile)
		expect(result.configuration.reasoningEffort).toBe("high")
		expect(result.state.effective).toEqual({ kind: "effort", effort: "high" })
		expect(result.state.fallbackReason).toBe("unsupported")
	})

	it("preserves VS Code LM Default when the profile omits the enable flag", () => {
		const profile = configuration({ apiProvider: "vscode-lm", reasoningEffort: "low" })
		const result = resolveTaskReasoning(
			profile,
			{ kind: "default" },
			{
				id: "copilot-gpt",
				info: modelInfo({ supportsReasoningEffort: ["low", "high"], reasoningEffort: "low" }),
			},
		)

		expect(result.configuration).toBe(profile)
		expect(result.state.effective).toEqual({ kind: "default" })
		expect(result.state.fallbackReason).toBeUndefined()
	})

	it("falls back to a valid effort when a named level is not supported", () => {
		const result = resolveTaskReasoning(
			configuration(),
			{ kind: "effort", effort: "max" },
			{
				id: "test-model",
				info: modelInfo({ supportsReasoningEffort: ["low", "high"], reasoningEffort: "high" }),
			},
		)

		expect(result.state.effective).toEqual({ kind: "effort", effort: "high" })
		expect(result.state.fallbackReason).toBe("unsupported")
		expect(result.configuration.reasoningEffort).toBeUndefined()
	})

	it("keeps an explicitly disabled profile disabled when an effort request is unsupported", () => {
		const profile = configuration({ enableReasoningEffort: false })
		const result = resolveTaskReasoning(
			profile,
			{ kind: "effort", effort: "max" },
			{
				id: "optional-effort-model",
				info: modelInfo({ supportsReasoningEffort: ["low", "high"], reasoningEffort: "high" }),
			},
		)

		expect(result.state.effective).toEqual({ kind: "off" })
		expect(result.state.fallbackReason).toBe("unsupported")
		expect(result.configuration.enableReasoningEffort).toBe(false)
	})

	it("keeps budget-only models numeric and honors the configured thinking budget", () => {
		const result = resolveTaskReasoning(
			configuration({ modelMaxThinkingTokens: 4096 }),
			{ kind: "off" },
			{
				id: "claude-opus-4-6",
				info: modelInfo({ supportsReasoningBudget: true, requiredReasoningBudget: true }),
			},
		)

		expect(result.state.capabilities).toMatchObject({ kind: "budget", canDisable: false, budgetTokens: 4096 })
		expect(result.state.effective).toEqual({ kind: "on" })
		expect(result.state.fallbackReason).toBe("required")
		expect(result.configuration.enableReasoningEffort).toBe(true)
	})

	it("reports the adapter-clamped budget rather than the raw configured value", () => {
		const result = resolveTaskReasoning(
			configuration({ modelMaxTokens: 10_000, modelMaxThinkingTokens: 20_000 }),
			{ kind: "default" },
			{
				id: "claude-opus-4-6",
				info: modelInfo({ supportsReasoningBudget: true, requiredReasoningBudget: true }),
			},
		)

		expect(result.state.capabilities).toMatchObject({ kind: "budget", budgetTokens: 8_000 })
	})

	it("does not turn a retained named effort into budget reasoning", () => {
		const result = resolveTaskReasoning(
			configuration(),
			{ kind: "effort", effort: "high" },
			{ id: "optional-budget-model", info: modelInfo({ supportsReasoningBudget: true }) },
		)

		expect(result.state.effective).toEqual({ kind: "off" })
		expect(result.state.fallbackReason).toBe("budget-only")
		expect(result.configuration.enableReasoningEffort).toBeUndefined()
	})

	it("uses the model/profile default for a cross-provider custom request", () => {
		const profile = configuration({ reasoningEffort: "low", enableReasoningEffort: true })
		const result = resolveTaskReasoning(
			profile,
			{ kind: "custom", value: "provider_token" },
			{
				id: "named-model",
				info: modelInfo({ supportsReasoningEffort: ["low", "high"], reasoningEffort: "high" }),
			},
		)

		expect(result.state.effective).toEqual({ kind: "effort", effort: "low" })
		expect(result.state.fallbackReason).toBe("unsupported")
		expect(result.configuration.reasoningEffort).toBe("low")
	})

	it("does not disable a required model for an unsupported custom request", () => {
		const result = resolveTaskReasoning(
			configuration(),
			{ kind: "custom", value: "provider_token" },
			{
				id: "required-effort-model",
				info: modelInfo({
					supportsReasoningEffort: ["low", "high"],
					requiredReasoningEffort: true,
					reasoningEffort: "high",
				}),
			},
		)

		expect(result.state.effective).toEqual({ kind: "effort", effort: "high" })
		expect(result.state.fallbackReason).toBe("required")
		expect(result.configuration.reasoningEffort).toBe("high")
	})

	it("repairs a disabled legacy default when the model requires named reasoning", () => {
		const result = resolveTaskReasoning(
			configuration({ enableReasoningEffort: false, reasoningEffort: "disable" }),
			{ kind: "default" },
			{
				id: "required-effort-model",
				info: modelInfo({
					supportsReasoningEffort: ["low", "high"],
					requiredReasoningEffort: true,
					reasoningEffort: "high",
				}),
			},
		)

		expect(result.state.effective).toEqual({ kind: "effort", effort: "high" })
		expect(result.state.fallbackReason).toBe("required")
		expect(result.configuration).toMatchObject({ enableReasoningEffort: true, reasoningEffort: "high" })
	})

	it("allows only constrained custom tokens for Stellar", () => {
		const result = resolveTaskReasoning(
			configuration({ apiProvider: "stellar", apiModelId: "Meta-Llama-3.3-70B-Instruct" }),
			{ kind: "custom", value: "balanced_reasoning" },
			{ id: "Meta-Llama-3.3-70B-Instruct", info: modelInfo() },
		)

		expect(result.state.capabilities).toEqual({ kind: "custom", canDisable: true })
		expect(result.state.effective).toEqual({ kind: "custom", value: "balanced_reasoning" })
		expect(result.configuration.taskReasoningCustomEffort).toBe("balanced_reasoning")
		expect(result.configuration.reasoningEffort).toBe("disable")
	})

	it("does not invent capabilities for an unknown model", () => {
		const result = resolveTaskReasoning(
			configuration(),
			{ kind: "effort", effort: "high" },
			{ id: "unknown-model", info: modelInfo() },
		)

		expect(result.state.capabilities).toEqual({ kind: "unavailable", canDisable: true })
		expect(result.state.effective).toEqual({ kind: "off" })
		expect(result.state.fallbackReason).toBe("unavailable")
	})
})
