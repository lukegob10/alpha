import {
	getSettingsSectionTarget,
	normalizeSettingsSection,
	revealSettingDetails,
	settingsSectionNames,
} from "../settingsNavigation"

describe("settings navigation", () => {
	it("identifies the four settings groups with permissions inside Preferences", () => {
		expect(settingsSectionNames).toEqual(["providers", "tools", "preferences", "advanced"])
		for (const section of settingsSectionNames) {
			expect(getSettingsSectionTarget(section)).toEqual({ section })
		}
	})

	it.each([
		["permissions", "preferences", "auto-approve-mode"],
		["autoApprove", "preferences", "auto-approve-mode"],
		["skills", "tools", "skills-management"],
		["agents", "tools", "agents-enabled"],
		["mcp", "tools", "mcp-management"],
		["experimental", "tools", "custom-tools-management"],
		["ui", "preferences", "ui-collapse-thinking"],
		["notifications", "preferences", "notifications-sound"],
		["contextManagement", "advanced", "context-open-tabs"],
		["checkpoints", "advanced", "checkpoints-enable"],
	])("preserves the %s deep link at its new home", (legacy, section, settingId) => {
		expect(getSettingsSectionTarget(legacy)).toEqual({ section, settingId })
		expect(normalizeSettingsSection(legacy)).toBe(section)
	})

	it.each([
		["language", "preferences"],
		["terminal", "advanced"],
	])("safely redirects the retired %s destination without targeting a removed control", (legacy, section) => {
		expect(getSettingsSectionTarget(legacy)).toEqual({ section })
		expect(normalizeSettingsSection(legacy)).toBe(section)
	})

	it.each(["worktrees", "about", "unknown", "__proto__", "constructor", "", null, undefined])(
		"does not treat auxiliary or unknown destination %s as a settings group",
		(section) => {
			expect(getSettingsSectionTarget(section)).toBeUndefined()
			expect(normalizeSettingsSection(section)).toBeUndefined()
		},
	)

	it("opens both the home group and nested disclosure while preserving unrelated disclosure state", () => {
		const outer = document.createElement("details")
		const inner = document.createElement("details")
		const setting = document.createElement("div")
		const unrelated = document.createElement("details")
		outer.append(inner)
		inner.append(setting)
		revealSettingDetails(setting)
		expect(outer.open).toBe(true)
		expect(inner.open).toBe(true)
		expect(unrelated.open).toBe(false)
	})

	it("also reveals a disclosure that is itself the navigation target", () => {
		const details = document.createElement("details")
		revealSettingDetails(details)
		expect(details.open).toBe(true)
	})
})
