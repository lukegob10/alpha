import { getModelId, providerSettingsSchema } from "../provider-settings.js"

describe("VS Code LM provider settings", () => {
	it("uses the configured family as model identity without borrowing a stale provider field", () => {
		expect(
			getModelId({
				apiProvider: "vscode-lm",
				apiModelId: "unrelated-stale-model",
				vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6-sol" },
			}),
		).toBe("gpt-6-sol")
		expect(getModelId({ apiProvider: "vscode-lm", apiModelId: "unrelated-stale-model" })).toBeUndefined()
		expect(getModelId({ apiProvider: "vscode-lm", vsCodeLmModelSelector: {} })).toBeUndefined()
	})

	it("preserves exact and empty opaque IDs ahead of the configured family", () => {
		const configuration = {
			apiProvider: "vscode-lm" as const,
			apiModelId: "unrelated-stale-model",
			vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6-sol", id: "opaque-provider-route" },
		}
		expect(getModelId(configuration)).toBe("opaque-provider-route")
		expect(
			getModelId({ ...configuration, vsCodeLmModelSelector: { ...configuration.vsCodeLmModelSelector, id: "" } }),
		).toBe("")
	})

	it("accepts a positive integer context-size override", () => {
		expect(
			providerSettingsSchema.parse({
				apiProvider: "vscode-lm",
				vsCodeLmContextSize: 922_000,
			}),
		).toEqual(
			expect.objectContaining({
				vsCodeLmContextSize: 922_000,
			}),
		)
		expect(() => providerSettingsSchema.parse({ vsCodeLmContextSize: 0 })).toThrow()
		expect(() => providerSettingsSchema.parse({ vsCodeLmContextSize: 922_000.5 })).toThrow()
	})
})
