import type { ProviderSettingsWithId } from "@alpha-code/types"

import { resolveSubagentModelRoute } from "../SubagentModelRouter"

const profiles: Array<ProviderSettingsWithId & { name: string }> = [
	{
		id: "parent-id",
		name: "Parent",
		apiProvider: "openai-native",
		openAiModelId: "parent-model",
		openAiApiKey: "parent-secret",
	},
	{
		id: "default-id",
		name: "Default Agent",
		apiProvider: "openrouter",
		openRouterModelId: "default-model",
		openRouterApiKey: "default-secret",
	},
	{
		id: "explore-id",
		name: "Explorer Renamed",
		apiProvider: "anthropic",
		apiModelId: "explore-model",
		apiKey: "explore-secret",
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
			provider: "anthropic",
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
})
