export const settingsSectionNames = ["providers", "tools", "preferences", "advanced"] as const

export type SectionName = (typeof settingsSectionNames)[number]

export type LegacySettingsSectionName =
	| "permissions"
	| "autoApprove"
	| "agents"
	| "skills"
	| "mcp"
	| "checkpoints"
	| "notifications"
	| "contextManagement"
	| "terminal"
	| "ui"
	| "experimental"
	| "language"

export type SettingsSectionId = SectionName | LegacySettingsSectionName | "worktrees" | "about"

export interface SettingsSectionTarget {
	section: SectionName
	settingId?: string
}

// Retained message/deep-link names navigate to the control's current group without
// making retired categories first-class settings groups again.
const legacyTargets = {
	permissions: { section: "preferences", settingId: "auto-approve-mode" },
	autoApprove: { section: "preferences", settingId: "auto-approve-mode" },
	agents: { section: "tools", settingId: "agents-enabled" },
	skills: { section: "tools", settingId: "skills-management" },
	mcp: { section: "tools", settingId: "mcp-management" },
	checkpoints: { section: "advanced", settingId: "checkpoints-enable" },
	notifications: { section: "preferences", settingId: "notifications-sound" },
	contextManagement: { section: "advanced", settingId: "context-open-tabs" },
	terminal: { section: "advanced" },
	ui: { section: "preferences", settingId: "ui-collapse-thinking" },
	experimental: { section: "tools", settingId: "custom-tools-management" },
	language: { section: "preferences" },
} satisfies Record<LegacySettingsSectionName, SettingsSectionTarget>

export function getSettingsSectionTarget(section?: string | null): SettingsSectionTarget | undefined {
	if (!section) return undefined
	const canonicalSection = settingsSectionNames.find((name) => name === section)
	if (canonicalSection) {
		return { section: canonicalSection }
	}
	if (Object.hasOwn(legacyTargets, section)) {
		return legacyTargets[section as LegacySettingsSectionName]
	}
	return undefined
}

export function normalizeSettingsSection(section?: string | null): SectionName | undefined {
	return getSettingsSectionTarget(section)?.section
}

// These controls are searchable before the Tools group has been opened. Register
// the metadata with the same index as mounted controls, without starting discovery
// or loading executable integrations merely to build the settings search index.
export const lazyToolsSearchSettings = [
	{ settingId: "skills-management", labelKey: "settings:sections.skills" },
	{ settingId: "agents-settings", labelKey: "agents:title" },
	{ settingId: "agents-enabled", labelKey: "agents:enabled.label" },
	{ settingId: "agents-concurrency", labelKey: "agents:concurrency.label" },
	{ settingId: "agents-total-capacity", labelKey: "agents:totalCapacity.label" },
	{ settingId: "agents-default-model", labelKey: "agents:defaultModel.label" },
	{ settingId: "agents-default-reasoning", labelKey: "agents:defaultReasoning.label" },
	{ settingId: "agents-types", labelKey: "agents:types.title" },
	{ settingId: "mcp-management", labelKey: "mcp:title" },
	{ settingId: "custom-tools-management", labelKey: "settings:customTools.name" },
] as const

/** Search targets can live inside more than one collapsed advanced disclosure. */
export function revealSettingDetails(element: Element): void {
	let details = element.closest<HTMLDetailsElement>("details")
	while (details) {
		details.open = true
		details = details.parentElement?.closest<HTMLDetailsElement>("details") ?? null
	}
}
