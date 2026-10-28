import type { ProviderSettingsWithId, TaskReasoningPreference } from "@alpha-code/types"

import { resolveSubagentModelRoute } from "../SubagentModelRouter"
import { resolveTaskReasoning } from "../TaskReasoning"

const profiles: Array<ProviderSettingsWithId & { name: string }> = [
	{
		id: "parent-id",
		name: "Parent",
		apiProvider: "openai",
		openAiModelId: "parent-model",
		openAiApiKey: "parent-secret",
	},
	{
		id: "default-id",
		name: "Default Agent",
		apiProvider: "openai",
		openAiModelId: "default-model",
		openAiApiKey: "default-secret",
	},
	{
		id: "explore-id",
		name: "Explorer Renamed",
		apiProvider: "vertex",
		apiModelId: "explore-model",
		vertexJsonCredentials: "explore-secret",
	},
	{ id: "unconfigured-id", name: "Incomplete" },
]

const loader = {
	async getProfile(query: { id?: string; name?: string }) {
		const profile = profiles.find((candidate) => candidate.id === query.id || candidate.name === query.name)
		if (!profile) throw new Error("Profile not found")
		return structuredClone(profile)
	},
}

const parentApiConfiguration = profiles[0]

describe("resolveSubagentModelRoute", () => {
	it.each(["openai-native", "openai-codex", "anthropic", "gemini", "xai", "openrouter", "bedrock", "meta"] as const)(
		"captures curated %s model overrides without changing credentials or the parent",
		async (apiProvider) => {
			const parent = { apiProvider, apiModelId: "parent-model", apiKey: "profile-secret" }
			const result = await resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: parent,
				profileLoader: loader,
				requestedModelId: "selected-child-model",
			})
			expect(result.apiConfiguration).toMatchObject({
				apiProvider,
				apiModelId: "selected-child-model",
				apiKey: "profile-secret",
			})
			expect(result.route.modelId).toBe("selected-child-model")
			expect(parent.apiModelId).toBe("parent-model")
		},
	)
	it.each([
		{ selector: { vendor: "copilot", family: "gpt-6-luna" }, modelId: "gpt-6-luna" },
		{
			selector: { vendor: "copilot", family: "gpt-6-luna", id: "opaque-copilot-route" },
			modelId: "opaque-copilot-route",
		},
	])(
		"preserves Copilot model identity $modelId in inherited and saved child routes",
		async ({ selector, modelId }) => {
			const profile = {
				id: "copilot-profile-id",
				name: "Copilot",
				apiProvider: "vscode-lm" as const,
				apiModelId: "stale-generic-model",
				vsCodeLmModelSelector: selector,
			}
			const profileLoader = { getProfile: vi.fn(async () => structuredClone(profile)) }
			const inherited = await resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: profile,
				parentApiConfigName: profile.name,
				parentReasoningPreference: { kind: "effort", effort: "high" },
				profileLoader,
			})
			const saved = await resolveSubagentModelRoute({
				role: "review",
				parentApiConfiguration,
				defaultProfileId: profile.id,
				profileLoader,
			})

			expect(inherited.route).toMatchObject({ source: "parent", modelId })
			expect(saved.route).toMatchObject({ source: "default", profileId: profile.id, modelId })
			expect(inherited.apiConfiguration.vsCodeLmModelSelector).toEqual(selector)
			expect(saved.apiConfiguration.vsCodeLmModelSelector).toEqual(selector)
			expect(inherited.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
			expect(saved.reasoningPreference).toEqual({ kind: "default" })
		},
	)

	it("captures the invoking task preference before an awaited profile lookup", async () => {
		const preference: TaskReasoningPreference = { kind: "effort", effort: "high" }
		let release!: (profile: (typeof profiles)[number]) => void
		const profile = new Promise<(typeof profiles)[number]>((resolve) => (release = resolve))
		const pending = resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration,
			parentApiConfigName: "Parent",
			parentReasoningPreference: preference,
			profileLoader: { getProfile: () => profile },
		})
		preference.effort = "low"
		release(profiles[0])
		const result = await pending

		expect(result.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
		expect(result.reasoningPreference).not.toBe(preference)
		expect(result.apiConfiguration).not.toHaveProperty("reasoningEffort")
	})

	it.each([
		{ label: "inherited choice", overrides: {}, effort: "high" },
		{ label: "explicit spawn effort", overrides: { requestedReasoningEffort: "low" }, effort: "low" },
		{ label: "default agent effort", overrides: { defaultReasoningEffort: "low" }, effort: "low" },
		{
			label: "configured agent effort applied last",
			overrides: { requestedReasoningEffort: "low", agentReasoningEffort: "medium" },
			effort: "medium",
		},
	] as const)("keeps $label in the effective child request", async ({ overrides, effort }) => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration,
			parentReasoningPreference: { kind: "effort", effort: "high" },
			profileLoader: loader,
			...overrides,
		})
		const resolved = resolveTaskReasoning(result.apiConfiguration, result.reasoningPreference, {
			id: "parent-model",
			info: {
				contextWindow: 128_000,
				supportsPromptCache: false,
				supportsReasoningEffort: ["low", "medium", "high"],
				reasoningEffort: "medium",
			},
		})

		expect(resolved.state.effective).toEqual({ kind: "effort", effort })
	})

	it.each(["requestedModelId", "defaultModelId"] as const)(
		"uses the selected model default instead of the parent task override for %s",
		async (selection) => {
			const result = await resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration,
				parentReasoningPreference: { kind: "effort", effort: "high" },
				profileLoader: loader,
				[selection]: "parent-model",
			})

			expect(result.reasoningPreference).toEqual({ kind: "default" })
			expect(result.apiConfiguration.reasoningEffort).toBeUndefined()
			expect(result.apiConfiguration.enableReasoningEffort).toBeUndefined()
		},
	)

	it("retains a captured task choice when a configured agent changes only the model", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration,
			parentReasoningPreference: { kind: "effort", effort: "high" },
			profileLoader: loader,
			agentModelId: "configured-model",
			resolveModelDefaultReasoningEffort: async () => "medium",
		})

		expect(result.apiConfiguration.openAiModelId).toBe("configured-model")
		expect(result.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
	})

	it("preserves an omitted VS Code LM Default without materializing a request override", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: {
				apiProvider: "vscode-lm",
				vsCodeLmModelSelector: { id: "copilot-model" },
				reasoningEffort: "low",
			},
			profileLoader: loader,
		})
		const resolved = resolveTaskReasoning(result.apiConfiguration, result.reasoningPreference, {
			id: "copilot-model",
			info: {
				contextWindow: 128_000,
				supportsPromptCache: false,
				supportsReasoningEffort: ["low", "high"],
				reasoningEffort: "low",
			},
		})

		expect(result.reasoningPreference).toEqual({ kind: "default" })
		expect(resolved.configuration).toBe(result.apiConfiguration)
		expect(resolved.state.effective).toEqual({ kind: "default" })
		expect(resolved.configuration.enableReasoningEffort).toBeUndefined()
	})

	it("inherits a captured custom-token choice without writing it into the provider profile", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: { apiProvider: "stellar", apiModelId: "stellar-model" },
			parentReasoningPreference: { kind: "custom", value: "captured_custom" },
			profileLoader: loader,
		})
		const resolved = resolveTaskReasoning(result.apiConfiguration, result.reasoningPreference, {
			id: "stellar-model",
			info: { contextWindow: 128_000, supportsPromptCache: false },
		})

		expect(result.reasoningPreference).toEqual({ kind: "custom", value: "captured_custom" })
		expect(result.apiConfiguration).not.toHaveProperty("taskReasoningCustomEffort")
		expect(resolved.configuration.taskReasoningCustomEffort).toBe("captured_custom")
	})

	it("uses an explicitly selected provider profile instead of the parent task preference", async () => {
		const result = await resolveSubagentModelRoute({
			role: "review",
			parentApiConfiguration,
			parentReasoningPreference: { kind: "effort", effort: "high" },
			defaultProfileId: "default-id",
			profileLoader: loader,
		})

		expect(result.reasoningPreference).toEqual({ kind: "default" })
	})

	it("inherits model and effort unless a default explicitly selects a model", async () => {
		const parent = { ...parentApiConfiguration, reasoningEffort: "high" as const, enableReasoningEffort: true }
		const inherited = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: parent,
			profileLoader: loader,
		})
		expect(inherited.apiConfiguration).toMatchObject({ openAiModelId: "parent-model", reasoningEffort: "high" })
		const selected = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: parent,
			profileLoader: loader,
			defaultModelId: "child-model",
		})
		expect(selected.apiConfiguration.openAiModelId).toBe("child-model")
		expect(selected.apiConfiguration.reasoningEffort).toBeUndefined()
		expect(selected.apiConfiguration.openAiApiKey).toBe("parent-secret")
		expect(parent.reasoningEffort).toBe("high")
	})

	it("uses the model default when an explicit selection repeats the parent model", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: { ...parentApiConfiguration, reasoningEffort: "high", enableReasoningEffort: true },
			profileLoader: loader,
			requestedModelId: "parent-model",
		})
		expect(result.apiConfiguration.reasoningEffort).toBeUndefined()
		expect(result.apiConfiguration.enableReasoningEffort).toBeUndefined()
	})

	it("captures the preceding model's default effort before applying a custom model", async () => {
		const resolveDefault = vi.fn().mockResolvedValue("medium")
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration,
			profileLoader: loader,
			defaultModelId: "default-model",
			agentModelId: "custom-model",
			resolveModelDefaultReasoningEffort: resolveDefault,
		})
		expect(resolveDefault.mock.calls[0]?.[0]).toMatchObject({ openAiModelId: "default-model" })
		expect(result.apiConfiguration).toMatchObject({ openAiModelId: "custom-model", reasoningEffort: "medium" })
		expect(parentApiConfiguration.reasoningEffort).toBeUndefined()
	})

	it("resolves custom agent overrides after spawn, defaults, and parent settings", async () => {
		const selected = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration,
			profileLoader: loader,
			defaultModelId: "default-model",
			defaultReasoningEffort: "low",
			requestedModelId: "spawn-model",
			requestedReasoningEffort: "medium",
			agentModelId: "custom-model",
			agentReasoningEffort: "high",
		})
		expect(selected.apiConfiguration).toMatchObject({
			apiProvider: "openai",
			openAiModelId: "custom-model",
			reasoningEffort: "high",
			openAiApiKey: "parent-secret",
		})
		const modelOnly = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration,
			profileLoader: loader,
			requestedReasoningEffort: "medium",
			agentModelId: "custom-model",
		})
		expect(modelOnly.apiConfiguration.reasoningEffort).toBe("medium")
	})
	it("applies role, default, then parent precedence using stable IDs", async () => {
		const role = await resolveSubagentModelRoute({
			role: "explore",
			parentApiConfiguration,
			parentApiConfigName: "Parent",
			defaultProfileId: "default-id",
			profileByRole: { explore: "explore-id" },
			profileLoader: loader,
		})
		const defaultRoute = await resolveSubagentModelRoute({
			role: "review",
			parentApiConfiguration,
			parentApiConfigName: "Parent",
			defaultProfileId: "default-id",
			profileLoader: loader,
		})
		const inherited = await resolveSubagentModelRoute({
			role: "review",
			parentApiConfiguration,
			parentApiConfigName: "Parent",
			profileLoader: loader,
		})

		expect(role.route).toMatchObject({
			source: "role",
			resolution: "selected",
			profileId: "explore-id",
			profileName: "Explorer Renamed",
			provider: "vertex",
			modelId: "explore-model",
		})
		expect(defaultRoute.route).toMatchObject({
			source: "default",
			profileId: "default-id",
			modelId: "default-model",
		})
		expect(inherited.route).toMatchObject({
			source: "parent",
			resolution: "selected",
			profileId: "parent-id",
			modelId: "parent-model",
		})
	})

	it.each([
		["missing-id", "missing"],
		["unconfigured-id", "unconfigured"],
	] as const)("falls back visibly to the parent for a %s profile", async (profileId, fallbackReason) => {
		const result = await resolveSubagentModelRoute({
			role: "review",
			parentApiConfiguration,
			parentApiConfigName: "Parent",
			profileByRole: { review: profileId },
			profileLoader: loader,
		})

		expect(result.route).toMatchObject({
			source: "role",
			resolution: "fallback",
			requestedProfileId: profileId,
			fallbackReason,
			profileId: "parent-id",
			profileName: "Parent",
		})
		expect(result.apiConfiguration).toMatchObject({ openAiApiKey: "parent-secret" })
		expect(JSON.stringify(result.route)).not.toContain("secret")
	})

	it("returns immutable configuration and display snapshots", async () => {
		const result = await resolveSubagentModelRoute({
			role: "explore",
			parentApiConfiguration,
			parentApiConfigName: "Parent",
			profileByRole: { explore: "explore-id" },
			profileLoader: loader,
		})

		profiles[2].name = "Renamed Again"
		profiles[2].apiModelId = "changed-after-approval"

		expect(result.apiConfigName).toBe("Explorer Renamed")
		expect(result.route.modelId).toBe("explore-model")
		expect(result.apiConfiguration.apiModelId).toBe("explore-model")

		profiles[2].name = "Explorer Renamed"
		profiles[2].apiModelId = "explore-model"
	})

	it("inherits an executable FakeAI provider through a clone-safe registry stub", async () => {
		const createMessage = vi.fn()
		const executableFakeAi = {
			id: "scripted-runtime",
			createMessage,
			getModel: vi.fn(),
			countTokens: vi.fn(),
			completePrompt: vi.fn(),
		}
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: { apiProvider: "fake-ai", fakeAi: executableFakeAi },
			parentApiConfigName: "Scripted parent",
			profileLoader: loader,
		})

		expect(result.apiConfiguration).toMatchObject({
			apiProvider: "fake-ai",
			fakeAi: { id: "scripted-runtime" },
		})
		expect((result.apiConfiguration.fakeAi as Record<string, unknown>).createMessage).toBeUndefined()
		expect(executableFakeAi.createMessage).toBe(createMessage)
	})

	it("applies a per-spawn model and effort after selecting the saved profile", async () => {
		const result = await resolveSubagentModelRoute({
			role: "explore",
			parentApiConfiguration,
			profileByRole: { explore: "explore-id" },
			profileLoader: loader,
			requestedModelId: "claude-sonnet-override",
			requestedReasoningEffort: "high",
		})

		expect(result.route).toMatchObject({
			source: "spawn",
			profileId: "explore-id",
			provider: "vertex",
			modelId: "claude-sonnet-override",
			requestedModelId: "claude-sonnet-override",
			requestedReasoningEffort: "high",
		})
		expect(result.apiConfiguration).toMatchObject({
			apiProvider: "vertex",
			apiModelId: "claude-sonnet-override",
			enableReasoningEffort: true,
			reasoningEffort: "high",
			vertexJsonCredentials: "explore-secret",
		})
		expect(profiles[2].apiModelId).toBe("explore-model")
	})

	it("clears custom OpenAI model metadata when a spawn selects a different model", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: {
				apiProvider: "openai",
				openAiModelId: "parent-model",
				openAiCustomModelInfo: { contextWindow: 128_000, supportsPromptCache: true, supportsImages: true },
			},
			profileLoader: loader,
			requestedModelId: "spawn-model",
		})

		expect(result.apiConfiguration.openAiModelId).toBe("spawn-model")
		expect(result.apiConfiguration.openAiCustomModelInfo).toBeNull()
	})

	it("selects a Copilot model by unique VS Code LM id", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: {
				apiProvider: "vscode-lm",
				vsCodeLmModelSelector: { vendor: "copilot", family: "old-family", id: "old-id" },
			},
			profileLoader: loader,
			requestedModelId: "copilot-gpt-new",
			requestedReasoningEffort: "none",
		})

		expect(result.apiConfiguration.vsCodeLmModelSelector).toEqual({ id: "copilot-gpt-new" })
		expect(result.apiConfiguration.enableReasoningEffort).toBe(false)
		expect(result.route.modelId).toBe("copilot-gpt-new")
	})

	describe("catalog Copilot model overrides", () => {
		const modelOverrideFields = ["requestedModelId", "defaultModelId", "agentModelId"] as const

		describe.each(["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5.5"])("selecting %s", (modelId) => {
			it.each(modelOverrideFields)("retains catalog binding for %s", async (field) => {
				const selector = { vendor: "copilot", family: "gpt-6.1-sol" }
				const parent = {
					apiProvider: "vscode-lm" as const,
					vsCodeLmModelSelector: selector,
					enableReasoningEffort: true,
					reasoningEffort: "medium" as const,
				}
				const result = await resolveSubagentModelRoute({
					role: "worker",
					parentApiConfiguration: parent,
					parentReasoningPreference: { kind: "effort", effort: "high" },
					profileLoader: loader,
					[field]: modelId,
				})
				const family = modelId

				expect(result.apiConfiguration.vsCodeLmModelSelector).toEqual({ vendor: "copilot", family })
				expect(result.route).toMatchObject({ source: "spawn", modelId: family, requestedModelId: modelId })
				expect(result.reasoningPreference).toEqual(
					field === "agentModelId" ? { kind: "effort", effort: "high" } : { kind: "default" },
				)
				expect(result.apiConfiguration.reasoningEffort).toBe(field === "agentModelId" ? "medium" : undefined)
				expect(parent.vsCodeLmModelSelector).toEqual(selector)
				expect(parent.reasoningEffort).toBe("medium")
			})
		})

		it.each(modelOverrideFields)("keeps unknown model IDs exact for %s", async (field) => {
			const result = await resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: {
					apiProvider: "vscode-lm",
					vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6-luna" },
				},
				profileLoader: loader,
				[field]: "opaque-copilot-route",
			})

			expect(result.apiConfiguration.vsCodeLmModelSelector).toEqual({ id: "opaque-copilot-route" })
			expect(result.route.modelId).toBe("opaque-copilot-route")
		})

		describe.each([
			{ label: "pinned ID", selector: { vendor: "copilot", family: "gpt-6-luna", id: "opaque-route" } },
			{ label: "pinned version", selector: { vendor: "copilot", family: "gpt-6-luna", version: "1.0" } },
			{ label: "legacy family", selector: { vendor: "copilot", family: "legacy-family" } },
			{ label: "other vendor", selector: { vendor: "other", family: "gpt-6-luna" } },
		])("a $label profile", ({ selector }) => {
			it.each(modelOverrideFields)("preserves exact override semantics for %s", async (field) => {
				const result = await resolveSubagentModelRoute({
					role: "worker",
					parentApiConfiguration: { apiProvider: "vscode-lm", vsCodeLmModelSelector: selector },
					profileLoader: loader,
					[field]: "gpt-6-sol",
				})

				expect(result.apiConfiguration.vsCodeLmModelSelector).toEqual({ id: "gpt-6-sol" })
				expect(result.route.modelId).toBe("gpt-6-sol")
			})
		})
	})

	it("rejects a model override when the provider has no model selection", async () => {
		await expect(
			resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: { apiProvider: "fake-ai", fakeAi: { id: "scripted-runtime" } },
				profileLoader: loader,
				requestedModelId: "arbitrary-model",
			}),
		).rejects.toThrow("cannot select a spawn model")
	})
})
