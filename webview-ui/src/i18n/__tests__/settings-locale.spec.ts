import settings from "../locales/en/settings.json"
import agents from "../locales/en/agents.json"
import mcp from "../locales/en/mcp.json"
import worktrees from "../locales/en/worktrees.json"
import chat from "../locales/en/chat.json"
import welcome from "../locales/en/welcome.json"

const getValue = (obj: unknown, path: string): unknown =>
	path.split(".").reduce<unknown>((current, segment) => {
		if (!current || typeof current !== "object") {
			return undefined
		}

		return (current as Record<string, unknown>)[segment]
	}, obj)

describe("English settings locale", () => {
	it("names the settings sections", () => {
		expect(settings.sections).toMatchObject({
			providers: "Providers",
			permissions: "Permissions",
			tools: "Tools & agents",
			preferences: "Preferences",
			advanced: "Advanced",
		})
		expect(settings.sections).not.toHaveProperty("language")
		expect(settings.sections).not.toHaveProperty("experimental")
		expect(settings.sections).not.toHaveProperty("terminal")
		expect(settings.advanced).not.toHaveProperty("terminal")
		expect(settings).not.toHaveProperty("terminal")
	})

	it("removes retired anonymous-reporting copy from settings and onboarding", () => {
		expect(settings).not.toHaveProperty("privacy")
		expect(settings.footer).not.toHaveProperty("telemetry")
		expect(welcome).not.toHaveProperty("telemetry")
	})

	it.each([
		[settings, "providers.advancedConnection"],
		[settings, "providers.vertexCredentialsHelp"],
		[settings, "providers.advancedModel"],
		[settings, "preferences.permissions"],
		[settings, "preferences.chatAndSound"],
		[settings, "preferences.memories"],
		[settings, "helpFor"],
		[settings, "home.chooseProvider"],
		[settings, "autoApprove.maxLimits.label"],
		[settings, "common.saveErrors.invalid"],
		[settings, "common.saveErrors.conflict"],
		[settings, "common.saveErrors.saveFailed"],
		[settings, "common.reloadSettings"],
		[settings, "common.saving"],
		[settings, "skills.appliesImmediately"],
		[settings, "tools.managementDescription"],
		[settings, "customTools.saveToLoad"],
		[settings, "customTools.executableWarning"],
		[settings, "memory.costNotice"],
		[settings, "contextManagement.customPromptNotice"],
		[agents, "types.routeUnavailable"],
		[agents, "types.detailsLabel"],
		[agents, "totalCapacity.available"],
		[mcp, "managementDescription"],
		[mcp, "tool.enableDescription"],
		[worktrees, "lockedDeleteUnavailable"],
		[chat, "checkpoint.menu.restoreWorkspaceWarning"],
	] as const)("defines active settings and manager copy %#", (resource, key) => {
		expect(getValue(resource, key)).toEqual(expect.any(String))
		expect(getValue(resource, key)).not.toBe("")
	})

	it("keeps variables needed to identify routes, capacity, and keyboard shortcuts", () => {
		expect(agents.types.routeUnavailable).toContain("{{id}}")
		expect(agents.types.routeProfile).toContain("{{profile}}")
		expect(agents.totalCapacity.available).toContain("{{count}}")
		expect(agents.totalCapacity.available_one).toContain("{{count}} subagent can")
		expect(agents.totalCapacity.available_other).toContain("{{count}} subagents can")
		expect(mcp.serverActions.delete).toContain("{{serverName}}")
		expect(settings.ui.requireCtrlEnterToSend.description).toContain("{{primaryMod}}")
		expect(settings.helpFor).toContain("{{label}}")
		expect(agents.types.detailsLabel).toContain("{{name}}")
	})

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
