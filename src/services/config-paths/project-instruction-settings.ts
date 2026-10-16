import * as vscode from "vscode"

import { Package } from "../../shared/package"
import { getSafeProjectInstructionFilenames, type ProjectInstructionDiscoveryOptions } from "."

/** Workspace content cannot widen the instruction or portable-skill search boundary. */
export function captureProjectInstructionDiscoveryOptions(): ProjectInstructionDiscoveryOptions {
	const configuration = vscode.workspace.getConfiguration(Package.name)
	const markers = configuration.inspect?.<readonly string[]>("projectRootMarkers")
	const fallbacks = configuration.inspect?.<readonly string[]>("projectDocFallbackFilenames")
	return Object.freeze({
		projectRootMarkers: Object.freeze(
			getSafeProjectInstructionFilenames(markers?.globalValue ?? markers?.defaultValue ?? [".git"]),
		),
		projectDocFallbackFilenames: Object.freeze(
			getSafeProjectInstructionFilenames(fallbacks?.globalValue ?? fallbacks?.defaultValue ?? []),
		),
	})
}
