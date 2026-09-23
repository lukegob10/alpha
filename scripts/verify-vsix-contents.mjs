#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const archiveArgument = process.argv[2]

if (!archiveArgument) {
	console.error("Usage: node scripts/verify-vsix-contents.mjs <path-to-vsix> [--check-source]")
	process.exit(1)
}

const archivePath = resolve(archiveArgument)

if (!existsSync(archivePath)) {
	console.error(`VSIX archive does not exist: ${archivePath}`)
	process.exit(1)
}

const listing = spawnSync("tar", ["-tf", archivePath], {
	encoding: "utf8",
	windowsHide: true,
})

if (listing.error || listing.status !== 0) {
	console.error(listing.stderr || listing.error?.message || "Unable to inspect VSIX archive")
	process.exit(listing.status ?? 1)
}

const entries = new Set(
	listing.stdout
		.split(/\r?\n/u)
		.map((entry) => entry.trim().replaceAll("\\", "/").replace(/^\.\//u, ""))
		.filter(Boolean),
)

const requiredEntries = [
	"extension/package.json",
	"extension/assets/skills/debug/SKILL.md",
	"extension/assets/skills/rich-documents/SKILL.md",
	"extension/assets/skills/skill-builder/SKILL.md",
	"extension/assets/skills/skill-builder/references/evaluation.md",
	"extension/assets/skills/skill-builder/references/standard-and-hosts.md",
	"extension/webview-ui/build/artifact-kit/v1/kit.css",
	"extension/webview-ui/build/artifact-kit/v1/kit.js",
	"extension/webview-ui/build/artifact-kit/v1/reference.md",
	"extension/webview-ui/build/artifact-kit/v1/examples/review.html",
	"extension/webview-ui/build/artifact-kit/v1/examples/spec.html",
	"extension/webview-ui/build/artifact-kit/v1/examples/fixture-workspace/images/layout-sample.png",
	"extension/webview-ui/build/artifact-kit/v1/examples/report.html",
	"extension/webview-ui/build/html-document/viewer.js",
	"extension/webview-ui/build/html-document/viewer.css",
	"extension/package.nls.json",
	"extension/dist/extension.js",
	"extension/dist/workers/sanitizeDocument.js",
	"extension/webview-ui/audio/celebration.wav",
	"extension/webview-ui/build/assets/index.js",
	"extension/assets/codicons/codicon.ttf",
	"extension/assets/vscode-material-icons/icons/3d.svg",
]

if (process.platform === "win32" || process.platform === "darwin") {
	const ripgrepExecutable = process.platform === "win32" ? "rg.exe" : "rg"
	requiredEntries.push(`extension/dist/node_modules/@vscode/ripgrep/bin/${ripgrepExecutable}`)
}

const missingEntries = requiredEntries.filter((entry) => !entries.has(entry))
const packagedEnvironmentFiles = [...entries].filter((entry) => /(^|\/)\.env(?:\.|$)/u.test(entry))
const packagedLinuxRipgrepFiles = [...entries].filter(
	(entry) =>
		/^extension\/dist\/node_modules\/@vscode\/ripgrep-linux-[^/]+\//u.test(entry) ||
		/^extension\/dist\/node_modules\/@vscode\/ripgrep-universal\/.+\/(?:linux|linux-[^/]+)\//u.test(entry) ||
		(process.platform === "linux" && entry === "extension/dist/node_modules/@vscode/ripgrep/bin/rg"),
)

if (missingEntries.length > 0) {
	console.error(`VSIX is missing required files:\n${missingEntries.map((entry) => `- ${entry}`).join("\n")}`)
	process.exit(1)
}

if (packagedEnvironmentFiles.length > 0) {
	console.error(
		`VSIX must not contain .env files:\n${packagedEnvironmentFiles.map((entry) => `- ${entry}`).join("\n")}`,
	)
	process.exit(1)
}

if (packagedLinuxRipgrepFiles.length > 0) {
	console.error(
		`VSIX must not contain Linux-specific ripgrep binaries:\n${packagedLinuxRipgrepFiles.map((entry) => `- ${entry}`).join("\n")}`,
	)
	process.exit(1)
}

console.log(`Verified ${entries.size} VSIX entries; required files are present and no .env file is packaged.`)

// Opt-in release check: listing files alone cannot detect stale copied public
// assets restored from a build cache with incomplete inputs.
if (process.argv.includes("--check-source")) {
	const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
	const publicRoot = join(repository, "webview-ui", "public")
	const files = []
	function collect(relative) {
		for (const item of readdirSync(join(publicRoot, relative), { withFileTypes: true })) {
			const child = `${relative}/${item.name}`
			if (item.isDirectory()) collect(child)
			else if (item.isFile()) files.push(child)
		}
	}
	collect("artifact-kit/v1")
	collect("html-document")
	for (const relative of files) {
		const entry = `extension/webview-ui/build/${relative}`
		const extracted = spawnSync("tar", ["-xOf", archivePath, entry], {
			windowsHide: true,
			maxBuffer: 8 * 1024 * 1024,
		})
		if (
			extracted.error ||
			extracted.status !== 0 ||
			!extracted.stdout.equals(readFileSync(join(publicRoot, relative)))
		) {
			console.error(`Packaged asset differs from current source: ${entry}`)
			process.exit(1)
		}
	}
	console.log(`Verified ${files.length} document assets match current source bytes.`)
}
