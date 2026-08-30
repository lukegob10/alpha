import * as vscode from "vscode"

import type { CustomModePrompts, ModeConfig } from "@alpha-code/types"

import { codeModeSlug, modes, planModeSlug } from "../../../shared/modes"
import { ensureSettingsDirectoryExists } from "../../../utils/globalContext"

export async function getModesSection(context: vscode.ExtensionContext): Promise<string> {
	// Make sure path gets created
	await ensureSettingsDirectoryExists(context)

	// Keep the ordinary model-facing workflow catalog intentionally small. The
	// complete mode registry remains available for restoring and running legacy
	// tasks, but new model-authored routing should converge on Plan and Code. Use
	// prompt-component overrides from Settings without allowing a persisted
	// custom mode with a reserved slug to replace either canonical definition.
	const customModePrompts = context.globalState.get<CustomModePrompts>("customModePrompts") ?? {}
	const primaryModes = modes
		.filter((mode) => mode.slug === planModeSlug || mode.slug === codeModeSlug)
		.map((mode) => ({
			...mode,
			roleDefinition:
				mode.slug === planModeSlug
					? mode.roleDefinition
					: (customModePrompts[mode.slug]?.roleDefinition ?? mode.roleDefinition),
			whenToUse:
				mode.slug === planModeSlug
					? mode.whenToUse
					: (customModePrompts[mode.slug]?.whenToUse ?? mode.whenToUse),
			customInstructions:
				mode.slug === planModeSlug
					? mode.customInstructions
					: (customModePrompts[mode.slug]?.customInstructions ?? mode.customInstructions),
		}))

	const modesContent = `====

MODES

- These are the currently available modes:
${primaryModes
	.map((mode: ModeConfig) => {
		let description: string
		if (mode.whenToUse && mode.whenToUse.trim() !== "") {
			// Use whenToUse as the primary description, indenting subsequent lines for readability
			description = mode.whenToUse.replace(/\n/g, "\n    ")
		} else {
			// Fallback to the first sentence of roleDefinition if whenToUse is not available
			description = mode.roleDefinition.split(".")[0]
		}
		const name = mode.slug === planModeSlug ? "Plan" : "Code"
		return `  * "${name}" mode (${mode.slug}) - ${description}`
	})
	.join("\n")}`

	return modesContent
}
