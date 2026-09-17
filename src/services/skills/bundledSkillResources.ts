import * as fs from "fs/promises"
import path from "path"

const resources = new Set([
	"webview-ui/build/artifact-kit/v1/reference.md",
	"webview-ui/build/artifact-kit/v1/examples/review.html",
	"webview-ui/build/artifact-kit/v1/examples/spec.html",
	"webview-ui/build/artifact-kit/v1/examples/report.html",
])

/** Packaged authoring references are read-only resources, never additional workspace roots. */
export async function isBundledSkillResource(extensionPath: string | undefined, candidate: string): Promise<boolean> {
	if (!extensionPath || !path.isAbsolute(candidate) || candidate.split(/[\\/]/).includes("..")) return false
	const relative = path.relative(extensionPath, candidate).split(path.sep).join("/")
	if (!resources.has(relative)) return false
	try {
		const root = await fs.realpath(extensionPath)
		const actual = await fs.realpath(candidate)
		const expected = path.join(root, ...relative.split("/"))
		const samePath =
			process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
		return samePath && (await fs.stat(actual)).isFile()
	} catch {
		// Missing or unreadable installed resources do not confer permission to another location.
		return false
	}
}
