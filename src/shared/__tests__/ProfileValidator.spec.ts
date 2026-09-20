// npx vitest run src/shared/__tests__/ProfileValidator.spec.ts

import type { ProviderSettings, OrganizationAllowList } from "@alpha-code/types"

import { ProfileValidator } from "../ProfileValidator"

describe("ProfileValidator", () => {
	describe("isProfileAllowed", () => {
		it("should allow any profile when allowAll is true", () => {
			const allowList: OrganizationAllowList = {
				allowAll: true,
				providers: {},
			}
			const profile: ProviderSettings = {
				apiProvider: "openai",
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should reject profiles without an apiProvider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: true },
				},
			}
			const profile: Partial<ProviderSettings> = {}

			expect(ProfileValidator.isProfileAllowed(profile as ProviderSettings, allowList)).toBe(false)
		})

		it("should reject profiles with provider not in allow list", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					vertex: { allowAll: true },
					stellar: { allowAll: false, models: ["partner-model"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: "openai",
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})

		it("should allow providers with allowAll=true regardless of model", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: true },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: "openai",
				openAiModelId: "any-model-id",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should reject if provider exists but model ID is missing", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: false, models: ["gpt-4"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: "openai",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})

		it("should allow if model is in the allowed models list", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: false, models: ["gpt-3.5-turbo", "gpt-4"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: "openai",
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should reject if model is not in the allowed models list", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: false, models: ["gpt-3.5-turbo"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: "openai",
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})

		it("should handle undefined models array in provider config", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: false },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: "openai",
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})

		it("should extract openAiModelId for openai provider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: false, models: ["gpt-4"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: "openai",
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should extract apiModelId for vertex provider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					vertex: { allowAll: false, models: ["claude-3-opus"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: "vertex",
				apiModelId: "claude-3-opus",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		// Test specific providers that use apiModelId
		const apiModelProviders = ["vertex", "stellar"] as const

		apiModelProviders.forEach((provider) => {
			it(`should extract apiModelId for ${provider} provider`, () => {
				const allowList: OrganizationAllowList = {
					allowAll: false,
					providers: {
						[provider]: { allowAll: false, models: ["test-model"] },
					},
				}
				const profile: ProviderSettings = {
					apiProvider: provider,
					apiModelId: "test-model",
				}

				expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
			})
		})

		it("should extract vsCodeLmModelSelector.id for vscode-lm provider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					"vscode-lm": { allowAll: false, models: ["copilot-gpt-3.5"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: "vscode-lm",
				vsCodeLmModelSelector: { id: "copilot-gpt-3.5" },
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should handle providers with undefined models list gracefully", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					"fake-ai": { allowAll: false },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: "fake-ai",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})

		it("should handle empty providers object", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {},
			}
			const profile: ProviderSettings = {
				apiProvider: "openai",
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})
	})
})
