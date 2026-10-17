import { access } from "fs/promises"

/** Load the optional development environment before activation starts network or configuration work. */
export async function loadExtensionEnvironment(envPath: string): Promise<void> {
	try {
		await access(envPath)
	} catch {
		// The extension-level .env is not shipped in production builds.
		return
	}

	try {
		// Avoid initializing dotenvx and its dependencies for the normal production path.
		const dotenvx = await import("@dotenvx/dotenvx")
		dotenvx.config({ path: envPath })
	} catch (error) {
		// Optional environment loading must never fail extension activation.
		console.warn("Failed to load environment variables:", error)
	}
}
