import { describe, expect, it, vi } from "vitest"

import type { HistoryItem, ProviderSettingsWithId } from "@alpha-code/types"
import { FakeAIHandler } from "../../../api/providers/fake-ai"
import {
	assertIndependentTaskModelSelectionRequest,
	resolveIndependentTaskModelSelection,
	restoreIndependentTaskModelSelection,
} from "../IndependentTaskModelRouting"

function fixture() {
	const profiles: Array<ProviderSettingsWithId & { id: string; name: string }> = [
		{
			id: "openai-id",
			name: "OpenAI work",
			apiProvider: "openai-native",
			apiModelId: "gpt-6.1-sol",
			openAiNativeApiKey: "openai-test-key",
		},
		{
			id: "claude-id",
			name: "Claude work",
			apiProvider: "anthropic",
			apiModelId: "claude-opus-5-5",
			apiKey: "claude-test-key",
		},
	]
	const profileLoader = {
		listConfig: vi.fn(async () => profiles),
		assertProfileAvailable: vi.fn(async () => undefined),
		getProfile: vi.fn(async (query: { id: string } | { name: string }) => {
			const profile = profiles.find((entry) =>
				"id" in query ? entry.id === query.id : entry.name === query.name,
			)
			if (!profile) throw new Error("Saved profile unavailable")
			return structuredClone(profile)
		}),
	}
	return { profiles, profileLoader }
}

function registerFakeImplementation(id: string) {
	const implementation = {
		id,
		getModel: () => ({ id: "reported-fixture-model", info: { contextWindow: 8_000, maxTokens: 1_000 } }),
		createMessage: async function* () {},
		countTokens: async () => 0,
		completePrompt: async () => "done",
		removeFromCache: undefined as (() => void) | undefined,
	}
	new FakeAIHandler({ fakeAi: implementation })
	return implementation
}

describe("independent task model routing", () => {
	it("restores a bound FakeAI snapshot through its captured registry ID and rejects a missing implementation", async () => {
		const { profiles, profileLoader } = fixture()
		const implementation = registerFakeImplementation("bound-fake-snapshot")
		profiles.push({
			id: "fake-profile",
			name: "Fake work",
			apiProvider: "fake-ai",
			fakeAi: { id: "later-edited-profile-id" },
		})
		const history = {
			apiConfigName: "Fake work",
			threadModelRoute: {
				source: "parent",
				resolution: "selected",
				profileId: "fake-profile",
				profileName: "Fake work",
				provider: "fake-ai",
				modelId: implementation.id,
				reasoningConfiguration: {},
			},
		} as HistoryItem
		try {
			const restored = await restoreIndependentTaskModelSelection(history, profileLoader)
			expect(restored.apiConfiguration.fakeAi).toEqual({ id: implementation.id })
			expect(restored.apiConfiguration.apiModelId).toBeUndefined()
			expect(new FakeAIHandler(restored.apiConfiguration).getModel().id).toBe("reported-fixture-model")
			implementation.removeFromCache?.()
			await expect(restoreIndependentTaskModelSelection(history, profileLoader)).rejects.toThrow("not registered")
		} finally {
			implementation.removeFromCache?.()
		}
	})

	it("preserves legacy bound FakeAI profile identity without treating its generic model as a registry ID", async () => {
		const { profiles, profileLoader } = fixture()
		const implementation = registerFakeImplementation("legacy-saved-registry")
		profiles.push({
			id: "legacy-fake-profile",
			name: "Legacy fake",
			apiProvider: "fake-ai",
			apiModelId: "legacy-captured-model",
			fakeAi: { id: implementation.id },
		})
		const history = {
			apiConfigName: "Legacy fake",
			threadModelRoute: {
				source: "parent",
				resolution: "selected",
				profileId: "legacy-fake-profile",
				profileName: "Legacy fake",
				provider: "fake-ai",
				modelId: "legacy-captured-model",
			},
		} as HistoryItem
		try {
			const restored = await restoreIndependentTaskModelSelection(history, profileLoader)
			expect(restored.apiConfiguration.fakeAi).toEqual({ id: implementation.id })
			expect(restored.apiConfiguration.apiModelId).toBe("legacy-captured-model")
			await expect(
				restoreIndependentTaskModelSelection(
					{ ...history, threadModelRoute: { ...history.threadModelRoute!, modelId: "wrong-legacy-model" } },
					profileLoader,
				),
			).rejects.toThrow("saved FakeAI model")
		} finally {
			implementation.removeFromCache?.()
		}
	})

	it("captures inherited inline configuration without borrowing a mismatching saved profile", async () => {
		const { profileLoader } = fixture()
		const route = await resolveIndependentTaskModelSelection({
			apiConfiguration: {
				apiProvider: "openai-native",
				apiModelId: "gpt-6.1-sol",
				openAiNativeApiKey: "inline-only-key",
			},
			apiConfigName: "OpenAI work",
			reasoningPreference: { kind: "effort", effort: "high" },
			selection: {},
			profileLoader,
			preserveReasoning: true,
		})
		expect(route.route).toMatchObject({ unboundProfile: true, provider: "openai-native", modelId: "gpt-6.1-sol" })
		expect(route.route.profileId).toBeUndefined()
		expect(route.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
		expect(route.apiConfiguration.openAiNativeApiKey).toBe("inline-only-key")
		expect(JSON.stringify(route.route)).not.toContain("inline-only-key")
		profileLoader.getProfile.mockClear()
		profileLoader.assertProfileAvailable.mockClear()
		await expect(
			restoreIndependentTaskModelSelection(
				{ apiConfigName: "OpenAI work", threadModelRoute: route.route } as HistoryItem,
				profileLoader,
			),
		).rejects.toThrow("unsaved provider configuration")
		expect(profileLoader.getProfile).not.toHaveBeenCalled()
		expect(profileLoader.assertProfileAvailable).not.toHaveBeenCalled()
	})

	it("preserves the current inline provider but requires a saved profile when changing provider", async () => {
		const { profileLoader } = fixture()
		const route = await resolveIndependentTaskModelSelection({
			apiConfiguration: {
				apiProvider: "openai-native",
				apiModelId: "gpt-6.1-sol",
				openAiNativeApiKey: "inline-only-key",
			},
			apiConfigName: "OpenAI work",
			selection: { provider: "openai-native" },
			profileLoader,
		})
		expect(route.route.unboundProfile).toBe(true)
		expect(route.apiConfiguration.openAiNativeApiKey).toBe("inline-only-key")
		await expect(
			resolveIndependentTaskModelSelection({
				apiConfiguration: route.apiConfiguration,
				apiConfigName: "OpenAI work",
				selection: { provider: "gemini" },
				profileLoader,
			}),
		).rejects.toThrow("No available saved profile")
	})

	it("rehydrates an unbound FakeAI route only through its existing registered implementation", async () => {
		const { profileLoader } = fixture()
		const implementation = {
			id: "independent-route-fake-registry",
			getModel: () => ({ id: "reported-fixture-model", info: { contextWindow: 8_000, maxTokens: 1_000 } }),
			createMessage: async function* () {},
			countTokens: async () => 0,
			completePrompt: async () => "done",
			removeFromCache: undefined as (() => void) | undefined,
		}
		new FakeAIHandler({ fakeAi: implementation })
		try {
			const route = await resolveIndependentTaskModelSelection({
				apiConfiguration: { apiProvider: "fake-ai", fakeAi: implementation },
				apiConfigName: "OpenAI work",
				selection: {},
				profileLoader,
			})
			expect(route.route).toMatchObject({ unboundProfile: true, modelId: implementation.id })
			profileLoader.getProfile.mockClear()
			const restored = await restoreIndependentTaskModelSelection(
				{ apiConfigName: "OpenAI work", threadModelRoute: route.route } as HistoryItem,
				profileLoader,
			)
			expect(restored.apiConfiguration.fakeAi).toEqual({ id: implementation.id })
			expect(restored.apiConfiguration.apiModelId).toBeUndefined()
			expect(profileLoader.getProfile).not.toHaveBeenCalled()
			expect(new FakeAIHandler(restored.apiConfiguration).getModel().id).toBe("reported-fixture-model")
			implementation.removeFromCache?.()
			await expect(
				restoreIndependentTaskModelSelection(
					{ apiConfigName: "OpenAI work", threadModelRoute: route.route } as HistoryItem,
					profileLoader,
				),
			).rejects.toThrow("not registered")
			expect(profileLoader.getProfile).not.toHaveBeenCalled()
		} finally {
			implementation.removeFromCache?.()
		}
	})

	it("inherits the target thread's effort for a sparse model-only update", async () => {
		const { profileLoader } = fixture()
		const route = await resolveIndependentTaskModelSelection({
			apiConfiguration: {
				apiProvider: "openai-native",
				apiModelId: "gpt-6.1-sol",
				openAiNativeApiKey: "openai-test-key",
				reasoningEffort: "high",
				enableReasoningEffort: true,
			},
			apiConfigName: "OpenAI work",
			reasoningPreference: { kind: "effort", effort: "high" },
			selection: { model: "gpt-5.6-terra" },
			profileLoader,
			preserveReasoning: true,
		})
		expect(route.apiConfiguration).toMatchObject({
			apiProvider: "openai-native",
			apiModelId: "gpt-5.6-terra",
			reasoningEffort: "high",
		})
		expect(route.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
	})

	it("gives a newly selected model its own default instead of the parent's custom preference", async () => {
		const { profileLoader } = fixture()
		const route = await resolveIndependentTaskModelSelection({
			apiConfiguration: {
				apiProvider: "openai-native",
				apiModelId: "gpt-6.1-sol",
				openAiNativeApiKey: "openai-test-key",
				reasoningEffort: "high",
			},
			apiConfigName: "OpenAI work",
			reasoningPreference: { kind: "custom", value: "parent-only" },
			selection: { model: "gpt-5.6-terra" },
			profileLoader,
		})
		expect(route.reasoningPreference).toEqual({ kind: "default" })
		expect(route.apiConfiguration.reasoningEffort).toBeUndefined()
	})

	it("switches the complete profile and clears the old provider's preference", async () => {
		const { profileLoader } = fixture()
		const route = await resolveIndependentTaskModelSelection({
			apiConfiguration: {
				apiProvider: "openai-native",
				apiModelId: "gpt-6.1-sol",
				openAiNativeApiKey: "old-key",
			},
			apiConfigName: "OpenAI work",
			reasoningPreference: { kind: "custom", value: "parent-only" },
			selection: { provider: "anthropic", profile: "claude-id" },
			profileLoader,
			preserveReasoning: true,
		})
		expect(route.apiConfiguration).toMatchObject({ apiProvider: "anthropic", apiKey: "claude-test-key" })
		expect(route.apiConfiguration).not.toHaveProperty("openAiNativeApiKey")
		expect(route.reasoningPreference).toEqual({ kind: "default" })
	})

	it("preserves an explicitly disabled setting across sparse selection and reload", async () => {
		const { profileLoader } = fixture()
		const route = await resolveIndependentTaskModelSelection({
			apiConfiguration: {
				apiProvider: "openai-native",
				apiModelId: "gpt-5.6-sol",
				openAiNativeApiKey: "openai-test-key",
				reasoningEffort: "high",
				enableReasoningEffort: false,
			},
			apiConfigName: "OpenAI work",
			reasoningPreference: { kind: "default" },
			selection: { model: "gpt-5.6-terra" },
			profileLoader,
			preserveReasoning: true,
		})
		const restored = await restoreIndependentTaskModelSelection(
			{
				apiConfigName: route.apiConfigName,
				threadModelRoute: route.route,
				reasoningPreference: route.reasoningPreference,
			} as HistoryItem,
			profileLoader,
		)
		expect(route.route.requestedReasoningEffort).toBeUndefined()
		expect(route.route.reasoningConfiguration).toEqual({ reasoningEffort: "high", enableReasoningEffort: false })
		expect(restored.apiConfiguration.enableReasoningEffort).toBe(false)
	})

	it("does not turn an inherited disabled flag into an explicit unsupported effort", async () => {
		const { profiles, profileLoader } = fixture()
		profiles[1].enableReasoningEffort = false
		const route = await resolveIndependentTaskModelSelection({
			apiConfiguration: { apiProvider: "openai-native", apiModelId: "gpt-6.1-sol" },
			selection: { profile: "claude-id" },
			profileLoader,
		})
		expect(route.route.requestedReasoningEffort).toBeUndefined()
		expect(route.route.reasoningConfiguration?.enableReasoningEffort).toBe(false)
		const restored = await restoreIndependentTaskModelSelection(
			{ threadModelRoute: route.route } as HistoryItem,
			profileLoader,
		)
		expect(restored.apiConfiguration.enableReasoningEffort).toBe(false)
	})

	it("keeps deliberately cleared model defaults cleared after reload", async () => {
		const { profiles, profileLoader } = fixture()
		profiles[0].reasoningEffort = "high"
		profiles[0].enableReasoningEffort = true
		const route = await resolveIndependentTaskModelSelection({
			apiConfiguration: {
				apiProvider: "openai-native",
				apiModelId: "gpt-6.1-sol",
				openAiNativeApiKey: "openai-test-key",
				reasoningEffort: "high",
				enableReasoningEffort: true,
			},
			apiConfigName: "OpenAI work",
			selection: { model: "gpt-5.6-terra" },
			profileLoader,
		})
		const persistedCapture = JSON.parse(JSON.stringify(route.route))
		expect(persistedCapture.reasoningConfiguration).toEqual({})
		const restored = await restoreIndependentTaskModelSelection(
			{ threadModelRoute: persistedCapture } as HistoryItem,
			profileLoader,
		)
		expect(restored.apiConfiguration.reasoningEffort).toBeUndefined()
		expect(restored.apiConfiguration.enableReasoningEffort).toBeUndefined()
	})

	it("keeps model-only overrides available to an unsaved in-memory provider", async () => {
		const { profileLoader } = fixture()
		const route = await resolveIndependentTaskModelSelection({
			apiConfiguration: {
				apiProvider: "openai",
				openAiModelId: "local-parent",
				openAiBaseUrl: "http://localhost:9000",
			},
			selection: { model: "local-child" },
			profileLoader,
		})
		expect(route.apiConfiguration.openAiModelId).toBe("local-child")
		expect(route.route.profileId).toBeUndefined()
	})

	it("uses captured identity when another profile takes the old profile name", async () => {
		const { profiles, profileLoader } = fixture()
		profiles[0].name = "Renamed OpenAI"
		profiles.push({
			...profiles[0],
			id: "replacement-id",
			name: "OpenAI work",
			openAiNativeApiKey: "replacement-key",
		})
		const route = await resolveIndependentTaskModelSelection({
			apiConfiguration: {
				apiProvider: "openai-native",
				apiModelId: "gpt-6.1-sol",
				openAiNativeApiKey: "openai-test-key",
			},
			apiConfigName: "OpenAI work",
			parentProfileId: "openai-id",
			selection: { model: "gpt-5.6-terra" },
			profileLoader,
		})
		expect(route.route.profileId).toBe("openai-id")
		expect(route.apiConfigName).toBe("Renamed OpenAI")
		expect(route.apiConfiguration.openAiNativeApiKey).toBe("openai-test-key")
	})

	it("restores by stable ID after a rename and rejects replacement profiles with the old name", async () => {
		const { profiles, profileLoader } = fixture()
		const history = {
			apiConfigName: "OpenAI work",
			threadModelOverride: "gpt-5.6-terra",
			reasoningPreference: { kind: "default" },
			threadModelRoute: {
				source: "spawn",
				resolution: "selected",
				profileId: "openai-id",
				profileName: "OpenAI work",
				provider: "openai-native",
				modelId: "gpt-5.6-terra",
				requestedModelId: "gpt-5.6-terra",
				requestedReasoningEffort: "high",
			},
		} as HistoryItem
		profiles[0].name = "Renamed OpenAI"
		const restored = await restoreIndependentTaskModelSelection(history, profileLoader)
		expect(restored.apiConfigName).toBe("Renamed OpenAI")
		expect(restored.apiConfiguration).toMatchObject({ apiModelId: "gpt-5.6-terra", reasoningEffort: "high" })
		profiles[0] = { ...profiles[0], id: "replacement-id", name: "OpenAI work" }
		await expect(restoreIndependentTaskModelSelection(history, profileLoader)).rejects.toThrow("unavailable")
	})

	it("refuses to restore a captured profile after its provider changes", async () => {
		const { profiles, profileLoader } = fixture()
		profiles[0].apiProvider = "anthropic"
		await expect(
			restoreIndependentTaskModelSelection(
				{
					apiConfigName: "OpenAI work",
					threadModelRoute: {
						source: "spawn",
						resolution: "selected",
						profileId: "openai-id",
						profileName: "OpenAI work",
						provider: "openai-native",
					},
				} as HistoryItem,
				profileLoader,
			),
		).rejects.toThrow("changed provider")
	})

	it("treats a captured default model as authoritative over a stale legacy override", async () => {
		const { profiles, profileLoader } = fixture()
		profiles[1].apiModelId = undefined
		const restored = await restoreIndependentTaskModelSelection(
			{
				apiConfigName: "Claude work",
				threadModelOverride: "gpt-5.6-sol",
				threadModelRoute: {
					source: "spawn",
					resolution: "selected",
					profileId: "claude-id",
					profileName: "Claude work",
					provider: "anthropic",
				},
			} as HistoryItem,
			profileLoader,
		)
		expect(restored.apiConfiguration.apiModelId).toBeUndefined()
		expect(restored.apiConfiguration.apiProvider).toBe("anthropic")
	})

	it("refuses a captured curated model that has been decommissioned", async () => {
		const { profileLoader } = fixture()
		await expect(
			restoreIndependentTaskModelSelection(
				{
					apiConfigName: "OpenAI work",
					threadModelRoute: {
						source: "spawn",
						resolution: "selected",
						profileId: "openai-id",
						profileName: "OpenAI work",
						provider: "openai-native",
						modelId: "retired-model",
					},
				} as HistoryItem,
				profileLoader,
			),
		).rejects.toThrow(/model|available/i)
	})

	it("accepts natural model aliases and explicit reasoning intent while requiring a human selection", () => {
		expect(() =>
			assertIndependentTaskModelSelectionRequest("Create a new thread with GPT 5.6 Sol", {
				model: "gpt-5.6-sol",
			}),
		).not.toThrow()
		expect(() =>
			assertIndependentTaskModelSelectionRequest("Create a new thread and choose its model and reasoning", {
				model: "gpt-5.6-sol",
				reasoningEffort: "high",
			}),
		).not.toThrow()
		expect(() =>
			assertIndependentTaskModelSelectionRequest("Create a new thread to fix the parser", {
				model: "gpt-5.6-sol",
			}),
		).toThrow("latest human request")
		expect(() =>
			assertIndependentTaskModelSelectionRequest("Create a new thread to review model performance", {
				model: "gpt-5.6-sol",
				provider: "anthropic",
			}),
		).toThrow("latest human request")
		expect(() =>
			assertIndependentTaskModelSelectionRequest("Read OpenAI documentation", { provider: "openai" }),
		).toThrow("latest human request")
		expect(() =>
			assertIndependentTaskModelSelectionRequest("Create a new thread using GPT 6.1 Sol", {
				model: "gpt-6.1-sol",
			}),
		).not.toThrow()
		expect(() =>
			assertIndependentTaskModelSelectionRequest("Choose the best model for a new thread", {
				model: "gpt-6.1-sol",
			}),
		).not.toThrow()
		expect(() =>
			assertIndependentTaskModelSelectionRequest("Create a new thread on Anthropic", { provider: "anthropic" }),
		).not.toThrow()
		expect(() =>
			assertIndependentTaskModelSelectionRequest("Launch GPT-5.6 Luna at low reasoning", {
				model: "gpt-5.6-luna",
				reasoningEffort: "low",
			}),
		).not.toThrow()
		expect(() => assertIndependentTaskModelSelectionRequest(undefined, { reasoningEffort: "high" })).toThrow(
			"latest human request",
		)
	})

	it.each(["with Research account", "using my Research account profile"])(
		"authorizes a discovered profile ID from its exact saved name in a human request %s",
		(phrase) => {
			expect(() =>
				assertIndependentTaskModelSelectionRequest(
					`Create a new thread ${phrase}`,
					{ profile: "opaque-profile-id" },
					{ id: "opaque-profile-id", name: "Research account" },
				),
			).not.toThrow()
		},
	)

	it.each([
		"Create a new thread with Research account documentation",
		"Create a new thread to compare Research account performance",
		"Create a new thread to fix the parser",
	])("does not treat a discovered profile name as authorization in %s", (request) => {
		expect(() =>
			assertIndependentTaskModelSelectionRequest(
				request,
				{ profile: "opaque-profile-id" },
				{ id: "opaque-profile-id", name: "Research account" },
			),
		).toThrow("latest human request")
	})

	it("ignores metadata for a different profile when checking a discovered profile ID", () => {
		expect(() =>
			assertIndependentTaskModelSelectionRequest(
				"Create a new thread with Research account",
				{ profile: "other-profile-id" },
				{ id: "opaque-profile-id", name: "Research account" },
			),
		).toThrow("latest human request")
	})

	it("accepts an imperative profile selection after a human asks to discover its saved name", () => {
		expect(() =>
			assertIndependentTaskModelSelectionRequest(
				'Please find my saved profile "Live review 42" and use it to create a new thread in Alpha. Use that profile\'s configured model and reasoning.',
				{ profile: "opaque-profile-id" },
				{ id: "opaque-profile-id", name: "Live review 42" },
			),
		).not.toThrow()
	})

	it("does not mistake discussion of how to use a profile for a selection", () => {
		expect(() =>
			assertIndependentTaskModelSelectionRequest(
				"Create a new thread to compare documentation about how to use that profile",
				{ profile: "opaque-profile-id" },
				{ id: "opaque-profile-id", name: "Live review 42" },
			),
		).toThrow("latest human request")
	})

	it.each(["documentation", "performance", "comparison"])(
		"does not authorize a profile override from a pronoun %s reference",
		(reference) => {
			for (const possessive of ["", "'s", "’s"]) {
				expect(() =>
					assertIndependentTaskModelSelectionRequest(
						`Create a new thread to review the parser. Use that profile${possessive} ${reference} as reference.`,
						{ profile: "opaque-profile-id" },
						{ id: "opaque-profile-id", name: "Live review 42" },
					),
				).toThrow("latest human request")
			}
		},
	)

	it.each(["'s", "’s"])("does not authorize a named profile%s documentation reference", (possessive) => {
		expect(() =>
			assertIndependentTaskModelSelectionRequest(
				`Create a new thread to review the parser with Research account${possessive} documentation.`,
				{ profile: "opaque-profile-id" },
				{ id: "opaque-profile-id", name: "Research account" },
			),
		).toThrow("latest human request")
	})
})
