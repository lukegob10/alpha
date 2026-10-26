import {
	CURATED_MODELS_BY_PROVIDER,
	curatedProviders,
	type ProviderSettings,
	type TaskReasoningPreference,
} from "@alpha-code/types"

import { getModelParams } from "../../../api/transform/model-params"
import { resolveTaskReasoning } from "../TaskReasoning"

describe("shared task reasoning across curated providers", () => {
	it("turns reasoning on from a saved none effort using the model's active default", () => {
		const result = resolveTaskReasoning(
			{ apiProvider: "openai-native", apiModelId: "optional-model", reasoningEffort: "none" },
			{ kind: "on" },
			{
				id: "optional-model",
				info: {
					contextWindow: 1_000,
					supportsPromptCache: true,
					supportsReasoningEffort: ["none", "low", "medium", "high"],
					reasoningEffort: "medium",
				},
			},
		)
		expect(result.state.effective).toEqual({ kind: "effort", effort: "medium" })
		expect(result.configuration.reasoningEffort).toBe("medium")
	})
	it.each(curatedProviders)(
		"resolves %s capabilities without changing the saved profile or selected model",
		(provider) => {
			for (const [id, info] of Object.entries(CURATED_MODELS_BY_PROVIDER[provider])) {
				const profile: ProviderSettings = { apiProvider: provider, apiModelId: id }
				const saved = structuredClone(profile)
				for (const requested of [
					{ kind: "default" },
					{ kind: "effort", effort: "high" },
					{ kind: "off" },
					{ kind: "effort", effort: "ultra" },
				] satisfies TaskReasoningPreference[]) {
					const resolved = resolveTaskReasoning(profile, requested, { id, info })
					expect(resolved.state.requested).toEqual(requested)
					expect(resolved.state.capabilities.kind).toBe("effort")
					const canDisable = info.requiredReasoningEffort !== true
					expect(resolved.state.capabilities.canDisable).toBe(canDisable)
					expect(resolved.configuration.apiModelId).toBe(id)
					expect(resolved.configuration.apiProvider).toBe(provider)
					expect(resolved.state.effective).toEqual(
						requested.kind === "off" && canDisable
							? { kind: "off" }
							: {
									kind: "effort",
									effort:
										requested.kind === "effort" && requested.effort === "high"
											? "high"
											: info.reasoningEffort,
								},
					)
					const parameters = getModelParams({
						format: "openai",
						modelId: id,
						model: info,
						settings: resolved.configuration,
						defaultTemperature: 0,
					})
					const disabledEffort =
						Array.isArray(info.supportsReasoningEffort) && info.supportsReasoningEffort.includes("none")
							? "none"
							: undefined
					expect(parameters.reasoningEffort).toBe(
						resolved.state.effective.kind === "effort" ? resolved.state.effective.effort : disabledEffort,
					)
				}
				expect(profile).toEqual(saved)
			}
		},
	)
})
