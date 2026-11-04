import { expect, it } from "vitest"
import { globalSettingsSchema } from "../global-settings.js"
import { isLanguage } from "../vscode.js"

it.each(["en", "fr", "ja", "pt-BR", "zh-CN", "", null])(
	"reads legacy locale %s as English without dropping other settings",
	(language) => {
		const settings = globalSettingsSchema.parse({
			language,
			customInstructions: "Keep my instructions",
			soundEnabled: true,
		})
		expect(settings).toMatchObject({
			language: "en",
			customInstructions: "Keep my instructions",
			soundEnabled: true,
		})
		expect(globalSettingsSchema.parse(settings)).toEqual(settings)
	},
)

it("recognizes only English as a supported language", () => {
	expect(isLanguage("en")).toBe(true)
	expect(isLanguage("fr")).toBe(false)
	expect(isLanguage("en-US")).toBe(false)
})
