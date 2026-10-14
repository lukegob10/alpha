import type * as vscode from "vscode"

import type { CustomModePrompts, ModeConfig } from "@alpha-code/types"

import { codeModeSlug, modes, planModeSlug } from "../../../shared/modes"

export async function getModesSection(
	_context: vscode.ExtensionContext,
	_capturedModePrompts?: CustomModePrompts,
): Promise<string> {
	// The catalog describes host-controlled states at developer authority. User
	// prompt overrides are emitted separately at user authority by system.ts.
	const primaryModes = modes.filter((mode) => mode.slug === planModeSlug || mode.slug === codeModeSlug)

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
