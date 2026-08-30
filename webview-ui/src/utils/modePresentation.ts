import type { ModeConfig } from "@alpha-code/types"
import { codeModeSlug, planMode, planModeSlug } from "@alpha/modes"

export type UserFacingModeSlug = typeof codeModeSlug | typeof planModeSlug

const PRIMARY_BUILT_IN_MODE_NAMES: Readonly<Record<UserFacingModeSlug, string>> = Object.freeze({
	[planModeSlug]: "Plan",
	[codeModeSlug]: "Code",
})

/**
 * Project the complete runtime mode registry into the deliberately small
 * user-facing selection surfaces. Canonical slugs remain unchanged, so this
 * cannot alter task, prompt, tool, or persisted-mode behavior.
 *
 * A selected legacy or custom mode remains visible so restoring an older task
 * never silently changes its mode. Unselected compatibility modes are omitted
 * from ordinary selection surfaces.
 */
export function getUserFacingModeOptions(
	allModes: readonly ModeConfig[],
	selectedModes?: string | readonly string[],
): ModeConfig[] {
	const selectedModeSlugs = new Set(typeof selectedModes === "string" ? [selectedModes] : (selectedModes ?? []))

	const visibleModes: ModeConfig[] = []
	const seenSlugs = new Set<string>()
	for (const candidate of allModes) {
		if (seenSlugs.has(candidate.slug)) continue
		if (!Object.hasOwn(PRIMARY_BUILT_IN_MODE_NAMES, candidate.slug) && !selectedModeSlugs.has(candidate.slug))
			continue
		seenSlugs.add(candidate.slug)

		const mode = candidate.slug === planModeSlug ? planMode : candidate
		if (!Object.hasOwn(PRIMARY_BUILT_IN_MODE_NAMES, mode.slug)) {
			visibleModes.push(mode)
			continue
		}

		const displayName = PRIMARY_BUILT_IN_MODE_NAMES[mode.slug as UserFacingModeSlug]
		visibleModes.push(displayName && mode.name !== displayName ? { ...mode, name: displayName } : mode)
	}

	return visibleModes
}

/**
 * Convert a model-authored follow-up mode hint into the two supported user
 * choices. Legacy execution-oriented modes collapse into Code; unknown custom
 * modes are ignored so a suggestion cannot silently enter a hidden mode.
 */
export function normalizeUserFacingSuggestionMode(modeSlug?: string): UserFacingModeSlug | undefined {
	switch (modeSlug?.trim().toLowerCase()) {
		case planModeSlug:
		case "plan":
			return planModeSlug
		case codeModeSlug:
		case "ask":
		case "debug":
		case "orchestrator":
			return codeModeSlug
		default:
			return undefined
	}
}

export function getUserFacingModeName(modeSlug: UserFacingModeSlug): string {
	return PRIMARY_BUILT_IN_MODE_NAMES[modeSlug]
}

/** Default a new user-authored configuration to one of the two primary modes. */
export function normalizeUserFacingModeSlug(modeSlug?: string): UserFacingModeSlug {
	return modeSlug === planModeSlug ? planModeSlug : codeModeSlug
}
