import type { ModeConfig } from "@alpha-code/types"
import { codeModeSlug, planMode, planModeSlug } from "@alpha/modes"

export type UserFacingModeSlug = typeof codeModeSlug | typeof planModeSlug

const PRIMARY_BUILT_IN_MODE_NAMES: Readonly<Record<UserFacingModeSlug, string>> = Object.freeze({
	[planModeSlug]: "Plan",
	[codeModeSlug]: "Code",
})

/** Present only Code and Plan, including when displaying historical task state. */
export function getUserFacingModeOptions(
	allModes: readonly ModeConfig[],
	_selectedModes?: string | readonly string[],
): ModeConfig[] {
	// Historical selections never add executable modes to the UI.

	const visibleModes: ModeConfig[] = []
	const seenSlugs = new Set<string>()
	for (const candidate of allModes) {
		if (seenSlugs.has(candidate.slug)) continue
		if (!Object.hasOwn(PRIMARY_BUILT_IN_MODE_NAMES, candidate.slug)) continue
		seenSlugs.add(candidate.slug)

		const mode = candidate.slug === planModeSlug ? planMode : candidate
		const displayName = PRIMARY_BUILT_IN_MODE_NAMES[mode.slug as UserFacingModeSlug]
		visibleModes.push(displayName && mode.name !== displayName ? { ...mode, name: displayName } : mode)
	}

	return visibleModes
}

/** Ignore retired or unknown model-authored mode hints. */
export function normalizeUserFacingSuggestionMode(modeSlug?: string): UserFacingModeSlug | undefined {
	switch (modeSlug?.trim().toLowerCase()) {
		case planModeSlug:
		case "plan":
			return planModeSlug
		case codeModeSlug:
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
