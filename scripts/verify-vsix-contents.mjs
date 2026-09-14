#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const archiveArgument = process.argv[2]

if (!archiveArgument) {
	console.error("Usage: node scripts/verify-vsix-contents.mjs <path-to-vsix>")
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
	"extension/assets/skills/rich-documents/SKILL.md",
	"extension/webview-ui/build/artifact-kit/v1/kit.css",
	"extension/webview-ui/build/artifact-kit/v1/kit.js",
	"extension/webview-ui/build/artifact-kit/v1/reference.md",
	"extension/webview-ui/build/artifact-kit/v1/examples/review.html",
	"extension/webview-ui/build/artifact-kit/v1/examples/spec.html",
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

const missingEntries = requiredEntries.filter((entry) => !entries.has(entry))
const packagedEnvironmentFiles = [...entries].filter((entry) => /(^|\/)\.env(?:\.|$)/u.test(entry))

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

console.log(`Verified ${entries.size} VSIX entries; required files are present and no .env file is packaged.`)
