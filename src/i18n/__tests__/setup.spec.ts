import { readFileSync, readdirSync } from "node:fs"

describe("extension translations", () => {
	let i18next: typeof import("../setup").default
	let translations: typeof import("..")

	beforeAll(async () => {
		// Exercise shipped resources while the rest of the unit suite keeps translation keys.
		vi.stubEnv("NODE_ENV", "production")
		vi.resetModules()
		i18next = (await import("../setup")).default
		translations = await import("..")
	})

	afterAll(() => {
		vi.unstubAllEnvs()
	})

	beforeEach(async () => {
		await i18next.changeLanguage("en")
	})

	it("initializes every bundled English namespace with its complete resources", () => {
		const localeDirectory = new URL("../locales/en/", import.meta.url)
		const files = readdirSync(localeDirectory).filter((name) => name.endsWith(".json"))
		expect(i18next.isInitialized).toBe(true)
		expect(Object.keys(i18next.store.data.en ?? {}).sort()).toEqual(files.map((name) => name.slice(0, -5)).sort())
		for (const file of files) {
			expect(i18next.getResourceBundle("en", file.slice(0, -5))).toEqual(
				JSON.parse(readFileSync(new URL(file, localeDirectory), "utf8")),
			)
		}
	})

	it("falls back to English for a saved or host language that is no longer shipped", () => {
		translations.initializeI18n("fr-CA")
		expect(translations.t("worktrees:selectWorktreeLocation")).toBe("Select Worktree Location")
		expect(translations.t("htmlDocument:openSource")).toBe("Open source")
	})

	it("preserves interpolation without HTML escaping for native messages", () => {
		expect(translations.t("common:welcome", { name: "<Alpha>", count: 2 })).toBe(
			"Welcome, <Alpha>! You have 2 notifications.",
		)
	})
})
