import { getRecommendedModes } from "../modes"
import type { ModeConfig } from "@alpha-code/types"

describe("recommended modes", () => {
	it("recommends only Work and Plan for new selection", () => {
		expect(getRecommendedModes().map((mode) => mode.slug)).toEqual(["work", "plan"])
	})

	it("keeps a selected legacy mode visible for compatibility", () => {
		expect(getRecommendedModes(undefined, "architect").map((mode) => mode.slug)).toEqual([
			"work",
			"plan",
			"architect",
		])
	})

	it("keeps custom configurations selectable", () => {
		const custom = {
			slug: "custom",
			name: "Custom",
			roleDefinition: "Custom role",
			groups: ["read"],
		} satisfies ModeConfig
		expect(getRecommendedModes([custom]).map((mode) => mode.slug)).toEqual(["work", "plan", "custom"])
	})
})
