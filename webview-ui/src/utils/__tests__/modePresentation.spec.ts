import type { ModeConfig } from "@alpha-code/types"

import { modes } from "@alpha/modes"

import {
	getUserFacingModeName,
	getUserFacingModeOptions,
	normalizeUserFacingModeSlug,
	normalizeUserFacingSuggestionMode,
} from "../modePresentation"

const customMode = (slug: string, name = slug): ModeConfig => ({
	slug,
	name,
	roleDefinition: `${name} role`,
	groups: ["read"],
})

describe("getUserFacingModeOptions", () => {
	it("presents the canonical architect and code modes as Plan and Code", () => {
		const visibleModes = getUserFacingModeOptions(modes)

		expect(visibleModes.map(({ slug, name }) => ({ slug, name }))).toEqual([
			{ slug: "architect", name: "Plan" },
			{ slug: "code", name: "Code" },
		])
	})

	it("hides unselected custom modes but preserves a selected custom mode", () => {
		const custom = customMode("security-review", "Security Review")

		expect(getUserFacingModeOptions([...modes, custom]).map((mode) => mode.slug)).toEqual(["architect", "code"])
		expect(getUserFacingModeOptions([...modes, custom], custom.slug).at(-1)).toBe(custom)
	})

	it("keeps the selected legacy mode visible until the user leaves it", () => {
		const visibleModes = getUserFacingModeOptions(modes, "debug")

		expect(visibleModes.map((mode) => mode.slug)).toEqual(["architect", "code", "debug"])
	})

	it("keeps every selected legacy mode visible for multi-mode records", () => {
		const visibleModes = getUserFacingModeOptions(modes, ["ask", "debug"])

		expect(visibleModes.map((mode) => mode.slug)).toEqual(["architect", "code", "ask", "debug"])
	})

	it("ignores an architect override and deduplicates the canonical Plan option", () => {
		const architectOverride = customMode("architect", "Design Review")
		const overriddenModes = [architectOverride, ...modes]

		const [visibleOverride] = getUserFacingModeOptions(overriddenModes)

		expect(visibleOverride).toMatchObject({
			slug: "architect",
			name: "Plan",
			roleDefinition: expect.stringContaining("Plan collaboration mode"),
			groups: ["read", "command", "agents"],
		})
		expect(getUserFacingModeOptions(overriddenModes).filter((mode) => mode.slug === "architect")).toHaveLength(1)
		expect(architectOverride.name).toBe("Design Review")
	})
})

describe("follow-up suggestion mode presentation", () => {
	it.each([
		["architect", "architect"],
		["plan", "architect"],
		["code", "code"],
		["ask", "code"],
		["debug", "code"],
		["orchestrator", "code"],
	] as const)("normalizes %s to %s", (input, expected) => {
		expect(normalizeUserFacingSuggestionMode(input)).toBe(expected)
	})

	it("ignores unknown custom mode hints", () => {
		expect(normalizeUserFacingSuggestionMode("security-review")).toBeUndefined()
	})

	it("uses Plan and Code as the only visible names", () => {
		expect(getUserFacingModeName("architect")).toBe("Plan")
		expect(getUserFacingModeName("code")).toBe("Code")
	})

	it.each([
		["architect", "architect"],
		["code", "code"],
		["ask", "code"],
		["security-review", "code"],
		[undefined, "code"],
	] as const)("defaults a new %s configuration to %s", (input, expected) => {
		expect(normalizeUserFacingModeSlug(input)).toBe(expected)
	})
})
