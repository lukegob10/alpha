import common from "../locales/en/common.json"
import settings from "../locales/en/settings.json"
import frenchMarketplace from "../locales/fr/marketplace.json"

const localeFiles = import.meta.glob("../locales/**/*.json", { eager: true })

const collectReplacementCharacters = (value: unknown, path: string, violations: string[]) => {
	if (typeof value === "string") {
		if (value.includes("\uFFFD")) {
			violations.push(path)
		}
		return
	}

	if (!value || typeof value !== "object") {
		return
	}

	for (const [key, child] of Object.entries(value)) {
		collectReplacementCharacters(child, `${path}.${key}`, violations)
	}
}

describe("locale integrity", () => {
	it("contains no Unicode replacement characters", () => {
		const violations: string[] = []

		for (const [path, module] of Object.entries(localeFiles)) {
			const resources = (module as { default?: unknown }).default ?? module
			collectReplacementCharacters(resources, path, violations)
		}

		expect(violations).toEqual([])
	})

	it("defines English fallbacks used by active controls", () => {
		expect(common.dismiss).toBe("Dismiss")
		expect(common.dismissAndDontShowAgain).toBe("Dismiss and don't show again")
		expect(settings.providers.refreshModels.missingConfig).toEqual(expect.any(String))
	})

	it("does not require interpolation for the French clear-tags action", () => {
		expect(frenchMarketplace.filters.tags.clear).toBe("Effacer les étiquettes")
		expect(frenchMarketplace.filters.tags.clear).not.toContain("{{")
	})
})
