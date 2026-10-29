import {
	getProviderDefaultModelId,
	type ProviderSettings,
	type ProviderSettingsEntry,
	type ProviderSettingsWithId,
	type TaskReasoningCapabilities,
	type TaskReasoningPreference,
} from "@alpha-code/types"

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
	it("directs a ChatGPT child with an unsupported model to saved-profile discovery", async () => {
		const haikuProfile = {
			id: "haiku-profile",
			name: "Haiku 5.5",
			apiProvider: "vscode-lm" as const,
			vsCodeLmModelSelector: { vendor: "copilot", family: "claude-haiku-5.5" },
		}
		const profileLoader = {
			getProfile: vi.fn(async () => structuredClone(haikuProfile)),
			listConfig: vi.fn(async () => [
				{
					id: haikuProfile.id,
					name: haikuProfile.name,
					apiProvider: haikuProfile.apiProvider,
					modelId: "claude-haiku-5.5",
				},
			]),
		}
		const parent: ProviderSettings = { apiProvider: "openai-codex", apiModelId: "gpt-6.1-sol" }
		await expect(
			resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: parent,
				profileLoader,
				requestedModelId: "haiku-5-5",
			}),
		).rejects.toThrow(/haiku-5-5.*list_provider_profiles.*profile/s)
		expect(profileLoader.getProfile).not.toHaveBeenCalled()
		expect(parent).toEqual({ apiProvider: "openai-codex", apiModelId: "gpt-6.1-sol" })

		const selected = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: parent,
			profileLoader,
			requestedProfile: haikuProfile.name,
		})
		expect(selected.apiConfiguration).toEqual({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: "claude-haiku-5.5" },
		})
		expect(selected.route).toMatchObject({ profileId: haikuProfile.id, provider: "vscode-lm" })
	})

	it.each(["openai-native", "openai-codex", "anthropic", "gemini", "xai", "openrouter", "bedrock", "meta"] as const)(
		"captures curated %s model overrides without changing credentials or the parent",
		async (apiProvider) => {
			const parent = { apiProvider, apiModelId: "parent-model", apiKey: "profile-secret" }
			const modelId = getProviderDefaultModelId(apiProvider)
			const result = await resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: parent,
				profileLoader: loader,
				requestedModelId: modelId,
			})
			expect(result.apiConfiguration).toMatchObject({
				apiProvider,
				apiModelId: modelId,
				apiKey: "profile-secret",
			})
			expect(result.route.modelId).toBe(modelId)
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
		expect(result.route).toMatchObject({ modelId: "scripted-runtime", unboundProfile: true })
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

		expect(result.apiConfiguration.vsCodeLmModelSelector).toEqual({ vendor: "copilot", id: "copilot-gpt-new" })
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

			expect(result.apiConfiguration.vsCodeLmModelSelector).toEqual({
				vendor: "copilot",
				id: "opaque-copilot-route",
			})
			expect(result.route.modelId).toBe("opaque-copilot-route")
		})

		describe.each([
			{ label: "pinned ID", selector: { vendor: "copilot", family: "gpt-6-luna", id: "opaque-route" } },
			{ label: "pinned version", selector: { vendor: "copilot", family: "gpt-6-luna", version: "1.0" } },
			{ label: "legacy family", selector: { vendor: "copilot", family: "legacy-family" } },
			{ label: "legacy selector without a vendor", selector: { id: "opaque-route" } },
			{ label: "absent selector", selector: undefined },
		])("a $label profile", ({ selector }) => {
			it.each(modelOverrideFields)(
				"binds a requested catalog family independently of the old selector for %s",
				async (field) => {
					const result = await resolveSubagentModelRoute({
						role: "worker",
						parentApiConfiguration: { apiProvider: "vscode-lm", vsCodeLmModelSelector: selector },
						profileLoader: loader,
						[field]: "gpt-6.1-sol",
					})

					expect(result.apiConfiguration.vsCodeLmModelSelector).toEqual({
						vendor: "copilot",
						family: "gpt-6.1-sol",
					})
					expect(result.route.modelId).toBe("gpt-6.1-sol")
				},
			)
		})

		it.each(modelOverrideFields)("preserves the selected non-Copilot vendor for %s", async (field) => {
			const result = await resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: {
					apiProvider: "vscode-lm",
					vsCodeLmModelSelector: { vendor: "other", family: "gpt-6-luna", id: "parent-id" },
				},
				profileLoader: loader,
				[field]: "gpt-6.1-sol",
			})

			expect(result.apiConfiguration.vsCodeLmModelSelector).toEqual({ vendor: "other", id: "gpt-6.1-sol" })
			expect(result.route.modelId).toBe("gpt-6.1-sol")
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

describe("explicit launch reasoning", () => {
	const parent = {
		apiProvider: "openai-native" as const,
		apiModelId: "gpt-5.6-luna",
		reasoningEffort: "high" as const,
		enableReasoningEffort: true,
	}

	it.each(["requestedReasoningEffort", "defaultReasoningEffort", "agentReasoningEffort"] as const)(
		"rejects unsupported %s from the final curated model metadata before host lookup",
		async (field) => {
			const resolveReasoningCapabilities = vi.fn()
			await expect(
				resolveSubagentModelRoute({
					role: "worker",
					parentApiConfiguration: parent,
					profileLoader: loader,
					[field]: "ultra",
					resolveReasoningCapabilities,
				}),
			).rejects.toThrow(/gpt-5.6-luna.*ultra.*Supported levels/)
			expect(resolveReasoningCapabilities).not.toHaveBeenCalled()
		},
	)

	it("rejects an unsupported launch effort before layering a role effort", async () => {
		await expect(
			resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: parent,
				profileLoader: loader,
				requestedReasoningEffort: "ultra",
				agentReasoningEffort: "low",
			}),
		).rejects.toThrow(/gpt-5.6-luna.*ultra/)
	})

	it("validates the role effort after a valid launch effort", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: parent,
			profileLoader: loader,
			requestedReasoningEffort: "high",
			agentReasoningEffort: "low",
		})
		expect(result.apiConfiguration.reasoningEffort).toBe("low")
	})

	it("validates host reasoning against the final selected model rather than the parent's model", async () => {
		const resolveReasoningCapabilities = vi.fn(
			async (): Promise<TaskReasoningCapabilities> => ({
				kind: "effort",
				efforts: ["low", "medium"],
				canDisable: false,
			}),
		)
		await expect(
			resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: {
					apiProvider: "vscode-lm",
					vsCodeLmModelSelector: { id: "opaque-parent-id" },
				},
				profileLoader: loader,
				requestedModelId: "gpt-6.1-sol",
				requestedReasoningEffort: "high",
				resolveReasoningCapabilities,
			}),
		).rejects.toThrow(/gpt-6.1-sol.*high.*low, medium/)
		expect(resolveReasoningCapabilities).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6.1-sol" },
				reasoningEffort: "high",
			}),
		)
	})

	it("does not perform capability lookup for a model's default or inherited effort", async () => {
		const resolveReasoningCapabilities = vi.fn()
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: parent,
			profileLoader: loader,
			requestedModelId: "gpt-5.6-sol",
			resolveReasoningCapabilities,
		})
		expect(result.apiConfiguration.reasoningEffort).toBeUndefined()
		expect(result.reasoningPreference).toEqual({ kind: "default" })
		expect(resolveReasoningCapabilities).not.toHaveBeenCalled()
	})

	it("validates an inherited task effort after a named role changes the model", async () => {
		await expect(
			resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: parent,
				parentReasoningPreference: { kind: "effort", effort: "none" },
				profileLoader: loader,
				agentModelId: "gpt-6.1-sol",
			}),
		).rejects.toThrow(/gpt-6.1-sol.*none/)
	})

	it("reuses host capabilities when a role changes only the effort", async () => {
		const resolveReasoningCapabilities = vi.fn(
			async (): Promise<TaskReasoningCapabilities> => ({
				kind: "effort",
				efforts: ["low", "high"],
				canDisable: false,
			}),
		)
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: {
				apiProvider: "vscode-lm",
				vsCodeLmModelSelector: { vendor: "copilot", id: "opaque-id" },
			},
			profileLoader: loader,
			requestedReasoningEffort: "high",
			agentReasoningEffort: "low",
			resolveReasoningCapabilities,
		})
		expect(result.apiConfiguration.reasoningEffort).toBe("low")
		expect(resolveReasoningCapabilities).toHaveBeenCalledTimes(1)
	})

	it.each([
		{ preference: { kind: "default" } as const, effort: "medium" },
		{ preference: { kind: "effort", effort: "high" } as const, effort: "high" },
	])("captures a role model's retained $effort effort for cold restoration", async ({ preference, effort }) => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration,
			parentReasoningPreference: preference,
			profileLoader: loader,
			agentModelId: "role-model",
			resolveModelDefaultReasoningEffort: async () => "medium",
		})
		expect(result.route.requestedReasoningEffort).toBeUndefined()
		expect(result.route.reasoningConfiguration).toEqual({ enableReasoningEffort: true, reasoningEffort: "medium" })
		const resolution = resolveTaskReasoning(result.apiConfiguration, result.reasoningPreference, {
			id: "role-model",
			info: {
				contextWindow: 128_000,
				supportsPromptCache: false,
				supportsReasoningEffort: ["low", "medium", "high"],
				reasoningEffort: "low",
			},
		})
		expect(resolution.state.effective).toEqual({ kind: "effort", effort })
	})

	it("captures an empty reasoning snapshot when a new model clears inherited flags", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: { ...parentApiConfiguration, enableReasoningEffort: true, reasoningEffort: "high" },
			profileLoader: loader,
			requestedModelId: "new-model",
		})
		expect(result.route.reasoningConfiguration).toEqual({})
		expect(result.route.requestedReasoningEffort).toBeUndefined()
	})
})

describe("captured parent profile identity", () => {
	const original = {
		apiProvider: "openai" as const,
		openAiApiKey: "original-secret",
		openAiModelId: "original-model",
	}
	const replacement = { id: "replacement-id", name: "Original name", ...original, openAiApiKey: "replacement-secret" }

	it("keeps trusted identity when another account takes the old profile name", async () => {
		const getProfile = vi.fn(async (query: { id: string } | { name: string }) =>
			"id" in query ? { ...original, id: "original-id", name: "Renamed original" } : replacement,
		)
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: original,
			parentApiConfigName: "Original name",
			parentProfileId: "original-id",
			profileLoader: { getProfile },
		})
		expect(result.route).toMatchObject({ profileId: "original-id", profileName: "Renamed original" })
		expect(result.route).not.toHaveProperty("unboundProfile")
		expect(result.apiConfiguration.openAiApiKey).toBe("original-secret")
		expect(getProfile).toHaveBeenCalledExactlyOnceWith({ id: "original-id" })
	})

	it("does not fall back by name when the captured identity was deleted", async () => {
		const getProfile = vi.fn(async (query: { id: string } | { name: string }) => {
			if ("id" in query) throw new Error("Profile not found")
			return replacement
		})
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: original,
			parentApiConfigName: "Original name",
			parentProfileId: "original-id",
			profileLoader: { getProfile },
		})
		expect(result.route.profileId).toBe("original-id")
		expect(result.route).not.toHaveProperty("unboundProfile")
		expect(getProfile).toHaveBeenCalledExactlyOnceWith({ id: "original-id" })
	})

	it.each([undefined, "openai"])(
		"keeps fresh captured credentials unbound when a name belongs to another account (%s)",
		async (requestedProvider) => {
			const result = await resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: original,
				parentApiConfigName: "Original name",
				requestedProvider,
				profileLoader: { getProfile: vi.fn().mockResolvedValue(replacement) },
			})
			expect(result.apiConfiguration).toEqual(original)
			expect(result.apiConfiguration).not.toBe(original)
			expect(result.route).toMatchObject({ unboundProfile: true, provider: "openai", modelId: "original-model" })
			expect(result.route.profileId).toBeUndefined()
			expect(JSON.stringify(result.route)).not.toContain("secret")
		},
	)

	it.each([undefined, "", "Missing profile"])(
		"keeps fresh captured settings unbound without a matching named profile: %s",
		async (name) => {
			const getProfile = vi.fn().mockRejectedValue(new Error("Profile not found"))
			const result = await resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration: original,
				parentApiConfigName: name,
				profileLoader: { getProfile },
			})
			expect(result.apiConfiguration).toEqual(original)
			expect(result.route).toMatchObject({ unboundProfile: true, profileName: name || "Parent profile" })
			expect(result.route.profileId).toBeUndefined()
			if (!name) expect(getProfile).not.toHaveBeenCalled()
		},
	)

	it("marks a matching legacy profile without a stable ID as unbound", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: original,
			parentApiConfigName: "Original name",
			profileLoader: { getProfile: vi.fn().mockResolvedValue({ ...original, name: "Original name" }) },
		})
		expect(result.route).toMatchObject({ unboundProfile: true })
		expect(result.route.profileId).toBeUndefined()
	})

	it("captures the FakeAI registry ID independently of its reported model and current saved profile", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: {
				apiProvider: "fake-ai",
				apiModelId: "reported-model-id",
				fakeAi: { id: "registered-runtime-id", getModel: () => ({ id: "reported-model-id" }) },
			},
			parentApiConfigName: "Original name",
			profileLoader: { getProfile: vi.fn().mockResolvedValue(replacement) },
		})
		expect(result.route).toMatchObject({
			provider: "fake-ai",
			modelId: "registered-runtime-id",
			unboundProfile: true,
		})
		expect(result.apiConfiguration).toMatchObject({
			apiModelId: "reported-model-id",
			fakeAi: { id: "registered-runtime-id" },
		})
		expect(result.route.profileId).toBeUndefined()
	})

	it("allows model/task preference changes while checking the original credential identity", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: {
				...original,
				openAiModelId: "other-model",
				reasoningEffort: "high",
				codeIndexQdrantApiKey: "unrelated-secret",
			},
			parentApiConfigName: "Original name",
			profileLoader: {
				getProfile: vi.fn().mockResolvedValue({ id: "original-id", name: "Original name", ...original }),
			},
		})
		expect(result.route.profileId).toBe("original-id")
		expect(result.apiConfiguration.openAiModelId).toBe("other-model")
	})

	it.each<{
		label: string
		captured: ProviderSettings
		saved: ProviderSettings
	}>([
		{
			label: "compatible model controls and empty defaults",
			captured: original,
			saved: {
				...original,
				openAiModelId: "other-model",
				openAiUseAzure: false,
				openAiHeaders: {},
				openAiBaseUrl: "",
				openAiR1FormatEnabled: true,
				openAiStreamingEnabled: false,
				modelTemperature: 0.6,
				verbosity: "high",
			},
		},
		{
			label: "Vertex context, streaming and token refresh",
			captured: { apiProvider: "vertex", vertexJsonCredentials: "captured-secret", vertexRegion: "us-central1" },
			saved: {
				apiProvider: "vertex",
				vertexJsonCredentials: "captured-secret",
				vertexRegion: "us-central1",
				vertex1MContext: true,
				vertexStreamingEnabled: false,
				refreshIntervalMinutes: 15,
				vertexGatewayTokenRefreshMinutes: 30,
			},
		},
		{
			label: "a canonical curated endpoint and service tier",
			captured: {
				apiProvider: "openai-native",
				openAiNativeApiKey: "captured-secret",
				apiModelId: "gpt-5.6-luna",
			},
			saved: {
				apiProvider: "openai-native",
				openAiNativeApiKey: "captured-secret",
				apiModelId: "gpt-6.1-sol",
				openAiNativeBaseUrl: "https://api.openai.com/v1/",
				openAiNativeServiceTier: "default",
			},
		},
		{
			label: "Copilot context and model pins",
			captured: {
				apiProvider: "vscode-lm",
				vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-5.6-luna", id: "opaque-original" },
			},
			saved: {
				apiProvider: "vscode-lm",
				vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6.1-sol", id: "opaque-new", version: "1" },
				vsCodeLmContextSize: 256000,
			},
		},
		{
			label: "a FakeAI runtime object and its captured ID stub",
			captured: { apiProvider: "fake-ai", fakeAi: { id: "runtime-id" } },
			saved: { apiProvider: "fake-ai", fakeAi: { id: "runtime-id", createMessage: vi.fn() } },
		},
	])("allows $label differences without rebinding account identity", async ({ captured, saved }) => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: captured,
			parentApiConfigName: "Original name",
			profileLoader: {
				getProfile: vi.fn().mockResolvedValue({ id: "original-id", name: "Original name", ...saved }),
			},
		})
		expect(result.route.profileId).toBe("original-id")
	})

	it("keeps the captured VS Code host vendor unbound when a name now selects a different vendor", async () => {
		const result = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: {
				apiProvider: "vscode-lm",
				vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6.1-sol" },
			},
			parentApiConfigName: "Original name",
			profileLoader: {
				getProfile: vi.fn().mockResolvedValue({
					id: "replacement-id",
					name: "Original name",
					apiProvider: "vscode-lm",
					vsCodeLmModelSelector: { vendor: "other", family: "gpt-6.1-sol" },
				}),
			},
		})
		expect(result.route).toMatchObject({ unboundProfile: true, modelId: "gpt-6.1-sol" })
		expect(result.route.profileId).toBeUndefined()
		expect(result.apiConfiguration.vsCodeLmModelSelector?.vendor).toBe("copilot")
	})
})

describe("explicit provider and profile routing", () => {
	const selected = {
		id: "anthropic-id",
		name: "Anthropic Work",
		apiProvider: "anthropic" as const,
		apiModelId: "claude-opus-5-5",
		apiKey: "selected-secret",
		anthropicBaseUrl: "https://api.anthropic.com/v1",
	}
	const makeLoader = (entries: ProviderSettingsEntry[] = [selected]) => ({
		listConfig: vi.fn(async () => entries),
		assertProfileAvailable: vi.fn(async () => undefined),
		getProfile: vi.fn(
			async (query: { id: string } | { name: string }): Promise<ProviderSettingsWithId & { name: string }> => {
				if (("id" in query && query.id === selected.id) || ("name" in query && query.name === selected.name)) {
					return structuredClone(selected)
				}
				throw new Error("Missing profile with a sensitive underlying value")
			},
		),
	})
	const options = {
		role: "worker" as const,
		parentApiConfiguration: {
			apiProvider: "openai" as const,
			openAiModelId: "parent-model",
			openAiApiKey: "parent-secret",
			openAiBaseUrl: "https://parent.example",
		},
		parentReasoningPreference: { kind: "effort", effort: "high" } as const,
	}

	it.each(["anthropic-id", "Anthropic Work"])("selects the complete saved profile by %s", async (profile) => {
		const profileLoader = makeLoader()
		const result = await resolveSubagentModelRoute({
			...options,
			profileLoader,
			requestedProfile: profile,
			requestedProvider: "anthropic",
			requestedModelId: "claude-sonnet-5-5",
			requestedReasoningEffort: "low",
		})

		expect(result.apiConfiguration).toEqual({
			apiProvider: "anthropic",
			apiModelId: "claude-sonnet-5-5",
			apiKey: "selected-secret",
			anthropicBaseUrl: "https://api.anthropic.com/v1",
			openAiModelId: undefined,
			reasoningEffort: "low",
			enableReasoningEffort: true,
		})
		expect(result.apiConfigName).toBe("Anthropic Work")
		expect(result.reasoningPreference).toEqual({ kind: "default" })
		expect(result.route).toMatchObject({
			source: "spawn",
			resolution: "selected",
			profileId: "anthropic-id",
			requestedProfileId: "anthropic-id",
			provider: "anthropic",
			modelId: "claude-sonnet-5-5",
		})
		expect(JSON.stringify(result.route)).not.toContain("secret")
		expect(profileLoader.getProfile).toHaveBeenCalledExactlyOnceWith({ id: "anthropic-id" })
		expect(options.parentApiConfiguration.openAiModelId).toBe("parent-model")
		expect(selected.apiModelId).toBe("claude-opus-5-5")
	})

	it("uses an explicitly selected profile's model instead of the global subagent model default", async () => {
		const result = await resolveSubagentModelRoute({
			...options,
			profileLoader: makeLoader(),
			requestedProfile: selected.id,
			defaultModelId: "gpt-6.1-sol",
		})
		expect(result.apiConfiguration).toMatchObject({
			apiProvider: "anthropic",
			apiModelId: selected.apiModelId,
		})
		expect(result.route.modelId).toBe(selected.apiModelId)
		expect(result.route.requestedModelId).toBeUndefined()
		expect(options.parentApiConfiguration.openAiModelId).toBe("parent-model")
	})

	it("lets an explicit per-call model override the selected profile despite a global model default", async () => {
		const result = await resolveSubagentModelRoute({
			...options,
			profileLoader: makeLoader(),
			requestedProfile: selected.id,
			requestedModelId: "claude-sonnet-5-5",
			defaultModelId: "gpt-6.1-sol",
		})
		expect(result.apiConfiguration.apiModelId).toBe("claude-sonnet-5-5")
		expect(result.route.requestedModelId).toBe("claude-sonnet-5-5")
	})

	it.each([
		{ reasoningEffort: "high" as const, enableReasoningEffort: true },
		{ reasoningEffort: "none" as const, enableReasoningEffort: false },
	])("keeps an explicit profile's configured reasoning over the global default: $reasoningEffort", async (flags) => {
		const profile = {
			id: selected.id,
			name: "Configured connection",
			apiProvider: "openai-codex" as const,
			apiModelId: "gpt-5.6-luna",
			...flags,
		}
		const profileLoader = makeLoader([profile])
		profileLoader.getProfile.mockResolvedValue(profile)
		const result = await resolveSubagentModelRoute({
			...options,
			profileLoader,
			requestedProfile: profile.id,
			defaultReasoningEffort: "low",
		})
		expect(result.apiConfiguration).toMatchObject(flags)
		expect(result.reasoningPreference).toEqual({ kind: "default" })
		expect(result.route.requestedReasoningEffort).toBeUndefined()
	})

	it.each(["high", "ultra"] as const)(
		"validates an explicit per-call effort against the selected profile: %s",
		async (requestedReasoningEffort) => {
			const profile = {
				id: selected.id,
				name: "Configured connection",
				apiProvider: "openai-codex" as const,
				apiModelId: "gpt-5.6-luna",
				reasoningEffort: "none" as const,
				enableReasoningEffort: false,
			}
			const profileLoader = makeLoader([profile])
			profileLoader.getProfile.mockResolvedValue(profile)
			const resolution = resolveSubagentModelRoute({
				...options,
				profileLoader,
				requestedProfile: profile.id,
				defaultReasoningEffort: "low",
				requestedReasoningEffort,
			})
			if (requestedReasoningEffort === "ultra") {
				await expect(resolution).rejects.toThrow(/ultra/)
			} else {
				const result = await resolution
				expect(result.apiConfiguration).toMatchObject({
					reasoningEffort: "high",
					enableReasoningEffort: true,
				})
				expect(result.route.requestedReasoningEffort).toBe("high")
			}
		},
	)

	it.each([
		{ reasoningEffort: "high" as const, enableReasoningEffort: true },
		{ reasoningEffort: "none" as const, enableReasoningEffort: false },
	])(
		"keeps a named-agent profile's configured model and $reasoningEffort effort over global defaults",
		async (flags) => {
			const profile = {
				id: selected.id,
				name: "Configured named connection",
				apiProvider: "openai-codex" as const,
				apiModelId: "gpt-5.6-luna",
				...flags,
			}
			const profileLoader = makeLoader([profile])
			profileLoader.getProfile.mockResolvedValue(profile)
			const result = await resolveSubagentModelRoute({
				...options,
				profileLoader,
				agentProfileId: profile.id,
				defaultModelId: "gpt-6.1-sol",
				defaultReasoningEffort: "low",
			})
			expect(result.apiConfiguration).toMatchObject({ apiModelId: profile.apiModelId, ...flags })
			expect(result.reasoningPreference).toEqual({ kind: "default" })
			expect(result.route.requestedModelId).toBeUndefined()
			expect(result.route.requestedReasoningEffort).toBeUndefined()
		},
	)

	it("lets per-call model and effort override a named-agent profile's configured defaults", async () => {
		const result = await resolveSubagentModelRoute({
			...options,
			profileLoader: makeLoader(),
			agentProfileId: selected.id,
			defaultModelId: "gpt-6.1-sol",
			defaultReasoningEffort: "low",
			requestedModelId: "claude-sonnet-5-5",
			requestedReasoningEffort: "high",
		})
		expect(result.apiConfiguration).toMatchObject({ apiModelId: "claude-sonnet-5-5", reasoningEffort: "high" })
	})

	it("keeps the captured current profile when its provider was explicitly requested", async () => {
		const profileLoader = makeLoader()
		const result = await resolveSubagentModelRoute({ ...options, profileLoader, requestedProvider: "openai" })

		expect(result.apiConfiguration).toEqual(options.parentApiConfiguration)
		expect(result.apiConfiguration).not.toBe(options.parentApiConfiguration)
		expect(result.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
		expect(result.route).toMatchObject({ source: "spawn", provider: "openai", modelId: "parent-model" })
		expect(profileLoader.listConfig).not.toHaveBeenCalled()
	})

	it("selects the unique available profile for a requested provider", async () => {
		const profileLoader = makeLoader([
			selected,
			{ id: "other-id", name: "Other provider", apiProvider: "gemini" },
			{ id: "invalid-id", name: "Invalid Anthropic", apiProvider: "anthropic", availability: "invalid" },
		])
		const result = await resolveSubagentModelRoute({ ...options, profileLoader, requestedProvider: "anthropic" })

		expect(result.apiConfiguration.apiKey).toBe("selected-secret")
		expect(result.apiConfiguration.openAiApiKey).toBeUndefined()
		expect(result.route).toMatchObject({ source: "spawn", profileId: selected.id, provider: "anthropic" })
		expect(result.reasoningPreference).toEqual({ kind: "default" })
		expect(profileLoader.assertProfileAvailable).toHaveBeenCalledExactlyOnceWith({ id: selected.id })
	})

	it("requires an explicit profile when a provider has multiple available profiles", async () => {
		const profileLoader = makeLoader([selected, { ...selected, id: "second-id", name: "Anthropic Personal" }])
		await expect(
			resolveSubagentModelRoute({ ...options, profileLoader, requestedProvider: "anthropic" }),
		).rejects.toThrow(/multiple.*profile.*Anthropic Work.*anthropic-id.*Anthropic Personal.*second-id/i)
		expect(profileLoader.getProfile).not.toHaveBeenCalled()
	})

	it("rejects a provider with no available saved profile", async () => {
		const profileLoader = makeLoader([
			{ ...selected, availability: "unsupported" },
			{ id: "other-id", name: "Other provider", apiProvider: "gemini" },
		])
		await expect(
			resolveSubagentModelRoute({ ...options, profileLoader, requestedProvider: "anthropic" }),
		).rejects.toThrow(/no available.*profile.*anthropic/i)
		expect(profileLoader.getProfile).not.toHaveBeenCalled()
	})

	it.each(["github", "retired-provider", ""])("rejects noncanonical provider %s", async (provider) => {
		const profileLoader = makeLoader()
		await expect(
			resolveSubagentModelRoute({ ...options, profileLoader, requestedProvider: provider }),
		).rejects.toThrow(/provider/i)
		expect(profileLoader.getProfile).not.toHaveBeenCalled()
		expect(profileLoader.listConfig).not.toHaveBeenCalled()
	})

	it("rejects a provider and profile mismatch before applying a model", async () => {
		await expect(
			resolveSubagentModelRoute({
				...options,
				profileLoader: makeLoader(),
				requestedProvider: "gemini",
				requestedProfile: selected.id,
				requestedModelId: "gemini-3.1-pro-preview",
			}),
		).rejects.toThrow(/profile.*anthropic.*gemini/i)
	})

	it("rejects a changed provider after loading a provider-only selection", async () => {
		const profileLoader = makeLoader([{ id: selected.id, name: selected.name, apiProvider: "gemini" }])
		await expect(
			resolveSubagentModelRoute({ ...options, profileLoader, requestedProvider: "gemini" }),
		).rejects.toThrow(/profile.*anthropic.*gemini/i)
	})

	it("rejects a profile selector that matches different saved IDs and names", async () => {
		const profileLoader = makeLoader([selected, { id: "second-id", name: selected.id, apiProvider: "anthropic" }])
		await expect(
			resolveSubagentModelRoute({ ...options, profileLoader, requestedProfile: selected.id }),
		).rejects.toThrow(/profile.*ambiguous/i)
		expect(profileLoader.getProfile).not.toHaveBeenCalled()
	})

	it("fails closed for a missing explicitly requested profile", async () => {
		await expect(
			resolveSubagentModelRoute({ ...options, profileLoader: makeLoader(), requestedProfile: "missing" }),
		).rejects.toThrow(/profile.*missing.*not found/i)
	})

	it("fails closed for an explicitly requested unconfigured profile", async () => {
		const profileLoader = makeLoader([{ id: "empty-id", name: "Incomplete" }])
		profileLoader.getProfile.mockResolvedValueOnce({ id: "empty-id", name: "Incomplete" })
		await expect(
			resolveSubagentModelRoute({ ...options, profileLoader, requestedProfile: "empty-id" }),
		).rejects.toThrow(/profile.*Incomplete.*not configured/i)
	})

	it("loads an active named-agent profile without restoring retired defaults", async () => {
		const result = await resolveSubagentModelRoute({
			...options,
			profileLoader: makeLoader(),
			agentProfileId: selected.id,
			defaultProfileId: "retired-default-id",
			profileByRole: { worker: "retired-role-id" },
		})

		expect(result.route).toMatchObject({ source: "role", profileId: selected.id, provider: "anthropic" })
		expect(result.apiConfiguration.apiKey).toBe("selected-secret")
	})

	it("accepts explicit selections that agree with a fixed named-agent profile", async () => {
		const result = await resolveSubagentModelRoute({
			...options,
			profileLoader: makeLoader(),
			agentProfileId: selected.id,
			requestedProvider: "anthropic",
			requestedProfile: selected.name,
		})
		expect(result.route.profileId).toBe(selected.id)
	})

	it.each([{ requestedProvider: "gemini" }, { requestedProfile: "other-id" }])(
		"rejects an explicit selection conflicting with a named-agent profile: %j",
		async (selection) => {
			const other = { ...selected, id: "other-id", name: "Other Anthropic" }
			const profileLoader = makeLoader([selected, other])
			profileLoader.getProfile.mockImplementation(async (query) =>
				structuredClone("id" in query && query.id === other.id ? other : selected),
			)
			await expect(
				resolveSubagentModelRoute({ ...options, profileLoader, agentProfileId: selected.id, ...selection }),
			).rejects.toThrow(/named.agent.*profile.*conflict/i)
		},
	)

	it("does not infer a different credentialed provider from a bare model ID", async () => {
		const profileLoader = makeLoader()
		const result = await resolveSubagentModelRoute({
			...options,
			profileLoader,
			requestedModelId: "claude-opus-5.5",
		})
		expect(result.apiConfiguration).toMatchObject({
			apiProvider: "openai",
			openAiModelId: "claude-opus-5.5",
			openAiApiKey: "parent-secret",
		})
		expect(profileLoader.listConfig).not.toHaveBeenCalled()
	})

	it("rejects a bare model outside the selected curated provider instead of sending it to that API", async () => {
		await expect(
			resolveSubagentModelRoute({
				...options,
				parentApiConfiguration: { apiProvider: "openai-native", apiModelId: "gpt-6.1-sol" },
				profileLoader: makeLoader(),
				requestedModelId: "claude-sonnet-5-5",
			}),
		).rejects.toThrow(/unsupported openai-native model.*provider.*profile/i)
	})

	it("rejects an unsupported requested model before applying a named agent's model", async () => {
		await expect(
			resolveSubagentModelRoute({
				...options,
				profileLoader: makeLoader(),
				requestedProfile: selected.id,
				requestedModelId: "gpt-6.1-sol",
				agentModelId: "claude-sonnet-5-5",
			}),
		).rejects.toThrow(/unsupported anthropic model/i)
	})

	it("rejects an unknown final curated model from a named agent", async () => {
		await expect(
			resolveSubagentModelRoute({
				...options,
				profileLoader: makeLoader(),
				agentProfileId: selected.id,
				agentModelId: "unknown-model",
			}),
		).rejects.toThrow(/unsupported anthropic model/i)
	})

	it("validates the model in an explicitly selected profile even without a model override", async () => {
		const profileLoader = makeLoader()
		profileLoader.getProfile.mockResolvedValueOnce({ ...selected, apiModelId: "unknown-model" })
		await expect(
			resolveSubagentModelRoute({ ...options, profileLoader, requestedProfile: selected.id }),
		).rejects.toThrow(/unsupported anthropic model/i)
	})

	it("rejects unsupported curated endpoint settings without including their values", async () => {
		const profileLoader = makeLoader()
		profileLoader.getProfile.mockResolvedValueOnce({
			...selected,
			anthropicBaseUrl: "https://credential-sensitive-endpoint.example",
		})
		const pending = resolveSubagentModelRoute({ ...options, profileLoader, requestedProfile: selected.id })
		await expect(pending).rejects.toThrow(/unsupported settings: anthropicBaseUrl/i)
		await expect(pending).rejects.not.toThrow("credential-sensitive-endpoint")
	})

	it("preserves historical inherited curated models when no route change was requested", async () => {
		const result = await resolveSubagentModelRoute({
			...options,
			parentApiConfiguration: { apiProvider: "anthropic", apiModelId: "historical-model" },
			profileLoader: makeLoader(),
		})
		expect(result.apiConfiguration.apiModelId).toBe("historical-model")
	})
})
