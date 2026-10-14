import * as path from "node:path"
import * as vscode from "vscode"

import { resolveRipgrepBinary, type RipgrepResolution } from "../../services/ripgrep"

export function createRipgrepPathOverlay(
	env: NodeJS.ProcessEnv,
	resolution: RipgrepResolution | undefined,
): Record<string, string> {
	if (!resolution || resolution.source === "system" || !path.isAbsolute(resolution.path)) return {}

	const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
	const currentPath = env[pathKey] ?? ""
	const binDirectory = path.dirname(resolution.path)
	const normalize = (directory: string) => {
		const normalized = path.resolve(directory)
		return process.platform === "win32" ? normalized.toLowerCase() : normalized
	}
	if (
		currentPath
			.split(path.delimiter)
			.some((directory) => directory && normalize(directory) === normalize(binDirectory))
	) {
		return {}
	}

	return { [pathKey]: currentPath ? `${binDirectory}${path.delimiter}${currentPath}` : binDirectory }
}

/** Keep Alpha's own terminals portable without changing the user's global PATH. */
export async function getRipgrepPathOverlay(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
	try {
		const resolution = await resolveRipgrepBinary({ appRoot: vscode.env.appRoot })
		return createRipgrepPathOverlay(env, resolution)
	} catch (error) {
		console.warn("[Alpha terminal] Could not resolve ripgrep for agent commands:", error)
		return {}
	}
}
