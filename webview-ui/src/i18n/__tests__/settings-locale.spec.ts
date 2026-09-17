import settings from "../locales/en/settings.json"

const getValue = (obj: unknown, path: string): unknown =>
	path.split(".").reduce<unknown>((current, segment) => {
		if (!current || typeof current !== "object") {
			return undefined
		}

		return (current as Record<string, unknown>)[segment]
	}, obj)

describe("English settings locale", () => {
	it("defines Google Cloud labels used by Vertex settings", () => {
		const keys = [
			"providers.googleCloudProjectId",
			"providers.googleCloudRegion",
			"providers.googleCloudRegionPicker.searchPlaceholder",
			"providers.googleCloudRegionPicker.noMatchFound",
			"providers.googleCloudRegionPicker.useCustomRegion",
			"providers.googleCloudCredentials",
			"providers.googleCloudKeyFile",
			"providers.googleCloudSetup.title",
			"providers.googleCloudSetup.step1",
			"providers.googleCloudSetup.step2",
			"providers.googleCloudSetup.step3",
			"validation.googleCloud",
		]

		for (const key of keys) {
			expect(getValue(settings, key)).toEqual(expect.any(String))
		}
	})
})
