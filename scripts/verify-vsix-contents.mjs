#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { unzipSync } from "fflate"
import { SaxesParser } from "saxes"

import { lanceDbBindingForTarget } from "../src/lancedb-native.mjs"

const archiveArgument = process.argv[2]

if (!archiveArgument) {
	console.error("Usage: node scripts/verify-vsix-contents.mjs <path-to-vsix> [--check-source] [--target <platform>]")
	process.exit(1)
}

let expectedTarget
let checkSource = false
try {
	for (let index = 3; index < process.argv.length; index++) {
		const argument = process.argv[index]
		if (argument === "--check-source") checkSource = true
		else if (argument === "--target" && expectedTarget === undefined) {
			expectedTarget = process.argv[++index]
			lanceDbBindingForTarget(expectedTarget)
		} else throw new Error(`Unknown or repeated VSIX verification argument: ${argument}`)
	}
} catch (error) {
	console.error(error.message)
	process.exit(1)
}

const archivePath = resolve(archiveArgument)

if (!existsSync(archivePath)) {
	console.error(`VSIX archive does not exist: ${archivePath}`)
	process.exit(1)
}

const sourceAssets = new Map()
if (checkSource) {
	const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
	const publicRoot = join(repository, "webview-ui", "public")
	function collect(relative) {
		for (const item of readdirSync(join(publicRoot, relative), { withFileTypes: true })) {
			const child = `${relative}/${item.name}`
			if (item.isDirectory()) collect(child)
			else if (item.isFile()) {
				sourceAssets.set(`extension/webview-ui/build/${child}`, readFileSync(join(publicRoot, child)))
			}
		}
	}
	collect("artifact-kit/v1")
	collect("html-document")
}

const entries = new Set()
let packagedAssets
try {
	packagedAssets = unzipSync(readFileSync(archivePath), {
		filter: (entry) => {
			const name = entry.name.trim().replaceAll("\\", "/").replace(/^\.\//u, "")
			if (entries.has(name)) throw new Error(`Duplicate VSIX archive entry: ${name}`)
			entries.add(name)
			if (entry.name === "extension.vsixmanifest") {
				if (entry.originalSize > 64 * 1024 || (entry.compression === 0 && entry.size > 64 * 1024)) {
					throw new Error("VSIX manifest exceeds the 64 KiB inspection limit")
				}
				return true
			}
			const source = sourceAssets.get(entry.name)
			if (!source) return false
			// Only trusted source names are inflated, and their declared size must
			// match the source before fflate allocates a decompression buffer.
			if (entry.originalSize !== source.length || (entry.compression === 0 && entry.size !== source.length)) {
				throw new Error(`Packaged asset differs from current source: ${entry.name}`)
			}
			return true
		},
	})
} catch (error) {
	console.error(`Unable to inspect VSIX archive: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}

const requiredEntries = [
	"extension.vsixmanifest",
	"extension/package.json",
	"extension/assets/skills/debug/SKILL.md",
	"extension/assets/skills/review-agent/SKILL.md",
	"extension/assets/skills/review-agent/agents/openai.yaml",
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
	"extension/webview-ui/build/html-document/purify.min.js",
	"extension/webview-ui/build/html-document/viewer.css",
	"extension/package.nls.json",
	"extension/dist/extension.js",
	"extension/dist/workers/sanitizeDocument.js",
	"extension/dist/workers/validateImage.js",
	"extension/dist/workers/searchCommandOutput.js",
	"extension/dist/workers/magick.wasm",
	"extension/dist/workers/magick-LICENSE",
	"extension/dist/workers/magick-NOTICE",
	"extension/webview-ui/audio/celebration.wav",
	"extension/webview-ui/build/assets/index.js",
	"extension/assets/codicons/codicon.ttf",
	"extension/assets/vscode-material-icons/icons/3d.svg",
]

let target
let nativeBinding
try {
	if (!packagedAssets["extension.vsixmanifest"]) throw new Error("VSIX is missing required extension.vsixmanifest")
	const manifest = new TextDecoder("utf-8", { fatal: true }).decode(packagedAssets["extension.vsixmanifest"])
	// Parse original XML: stripping comments can manufacture markup, while regexes
	// can mistake CDATA text for a real Identity element.
	const identities = []
	const elements = []
	const parser = new SaxesParser({ xmlns: true })
	parser.on("doctype", () => {
		throw new Error("VSIX manifest must not declare a DOCTYPE")
	})
	parser.on("opentag", (element) => {
		if (
			elements.length === 0 &&
			(element.local !== "PackageManifest" ||
				!["", "http://schemas.microsoft.com/developer/vsx-schema/2011"].includes(element.uri))
		) {
			throw new Error("Invalid VSIX PackageManifest root")
		}
		if (element.local === "Identity") {
			if (
				elements.length !== 2 ||
				elements[1].local !== "Metadata" ||
				elements[1].uri !== elements[0].uri ||
				element.uri !== elements[0].uri
			) {
				throw new Error("VSIX Identity must belong to PackageManifest/Metadata in the manifest namespace")
			}
			identities.push(element.attributes)
		}
		elements.push({ local: element.local, uri: element.uri })
	})
	parser.on("closetag", () => elements.pop())
	parser.write(manifest).close()
	if (identities.length !== 1) throw new Error("VSIX manifest must contain exactly one Identity")
	target = identities[0].TargetPlatform?.value
	if (!target) throw new Error("VSIX must declare a TargetPlatform; a host-only native binding is not universal")
	nativeBinding = lanceDbBindingForTarget(target)
	if (expectedTarget !== undefined && expectedTarget !== target) {
		throw new Error(`VSIX TargetPlatform ${target} does not match requested target ${expectedTarget}`)
	}
} catch (error) {
	console.error(`Invalid VSIX platform contract: ${error.message}`)
	process.exit(1)
}

if (nativeBinding) requiredEntries.push(`extension/dist/${nativeBinding}`)
if (target.startsWith("win32-") || target.startsWith("darwin-")) {
	const ripgrepExecutable = target.startsWith("win32-") ? "rg.exe" : "rg"
	requiredEntries.push(`extension/dist/node_modules/@vscode/ripgrep/bin/${ripgrepExecutable}`)
}

const missingEntries = requiredEntries.filter((entry) => !entries.has(entry))
const packagedEnvironmentFiles = [...entries].filter((entry) => /(^|\/)\.env(?:\.|$)/iu.test(entry))
const packagedLinuxRipgrepFiles = [...entries].filter(
	(entry) =>
		/^extension\/dist\/node_modules\/@vscode\/ripgrep-linux-[^/]+\//u.test(entry) ||
		/^extension\/dist\/node_modules\/@vscode\/ripgrep-universal\/.+\/(?:linux|linux-[^/]+)\//u.test(entry) ||
		(/^(?:linux|alpine)-/u.test(target) && entry === "extension/dist/node_modules/@vscode/ripgrep/bin/rg"),
)
const incompatibleNativeBindings = [...entries].filter(
	(entry) => /(?:^|\/)lancedb\.[^/]+\.node$/u.test(entry) && entry !== `extension/dist/${nativeBinding}`,
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

if (incompatibleNativeBindings.length > 0) {
	console.error(
		`VSIX target ${target} contains incompatible LanceDB bindings:\n${incompatibleNativeBindings.map((entry) => `- ${entry}`).join("\n")}`,
	)
	process.exit(1)
}

if (packagedLinuxRipgrepFiles.length > 0) {
	console.error(
		`VSIX must not contain Linux-specific ripgrep binaries:\n${packagedLinuxRipgrepFiles.map((entry) => `- ${entry}`).join("\n")}`,
	)
	process.exit(1)
}

console.log(
	`Verified ${entries.size} VSIX entries for ${target}; required files are present and no .env file is packaged.`,
)

// Opt-in release check: listing files alone cannot detect stale copied public
// assets restored from a build cache with incomplete inputs.
if (checkSource) {
	for (const [entry, source] of sourceAssets) {
		if (!packagedAssets[entry] || !source.equals(packagedAssets[entry])) {
			console.error(`Packaged asset differs from current source: ${entry}`)
			process.exit(1)
		}
	}
	console.log(`Verified ${sourceAssets.size} document assets match current source bytes.`)
}
