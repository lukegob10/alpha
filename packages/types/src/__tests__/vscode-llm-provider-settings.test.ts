import { providerSettingsSchema } from "../provider-settings.js"

describe("VS Code LM provider settings", () => {
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
