import { formatLanguage } from "../language"

describe("English-only language preferences", () => {
	it.each([
		"en",
		"en-us",
		"ca",
		"de",
		"es",
		"fr",
		"hi",
		"id",
		"it",
		"ja",
		"ko",
		"nl",
		"pl",
		"pt-br",
		"ru",
		"tr",
		"vi",
		"zh-cn",
		"zh-TW",
		"",
		"unknown",
	])("normalizes the editor or saved locale %s to English", (locale) => expect(formatLanguage(locale)).toBe("en"))
	it("handles a missing saved locale", () => {
		expect(formatLanguage(undefined)).toBe("en")
	})
})
