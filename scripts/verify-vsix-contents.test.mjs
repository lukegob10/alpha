import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { zipSync } from "fflate"

import { hostVsixTarget, lanceDbBindingForTarget } from "../src/lancedb-native.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
const verifier = path.join(repository, "scripts/verify-vsix-contents.mjs")
const hostTarget = hostVsixTarget()
const required = [
	"extension.vsixmanifest",
	"extension/package.json",
	"extension/package.nls.json",
	"extension/dist/extension.js",
	"extension/dist/workers/sanitizeDocument.js",
	"extension/dist/workers/validateImage.js",
	"extension/dist/workers/searchCommandOutput.js",
	"extension/dist/workers/magick.wasm",
	"extension/dist/workers/magick-LICENSE",
	"extension/dist/workers/magick-NOTICE",
	"extension/assets/skills/debug/SKILL.md",
	"extension/assets/skills/review-agent/SKILL.md",
	"extension/assets/skills/review-agent/agents/openai.yaml",
	"extension/assets/skills/rich-documents/SKILL.md",
	"extension/assets/skills/skill-builder/SKILL.md",
	"extension/assets/skills/skill-builder/references/evaluation.md",
	"extension/assets/skills/skill-builder/references/standard-and-hosts.md",
	"extension/assets/codicons/codicon.ttf",
	"extension/assets/vscode-material-icons/icons/3d.svg",
	"extension/webview-ui/audio/celebration.wav",
	"extension/webview-ui/build/assets/index.js",
	"extension/webview-ui/build/artifact-kit/v1/kit.css",
	"extension/webview-ui/build/artifact-kit/v1/kit.js",
	"extension/webview-ui/build/artifact-kit/v1/reference.md",
	"extension/webview-ui/build/artifact-kit/v1/examples/review.html",
	"extension/webview-ui/build/artifact-kit/v1/examples/spec.html",
	"extension/webview-ui/build/artifact-kit/v1/examples/report.html",
	"extension/webview-ui/build/artifact-kit/v1/examples/fixture-workspace/images/layout-sample.png",
	"extension/webview-ui/build/html-document/viewer.js",
	"extension/webview-ui/build/html-document/purify.min.js",
	"extension/webview-ui/build/html-document/viewer.css",
]
if (lanceDbBindingForTarget(hostTarget)) required.push(`extension/dist/${lanceDbBindingForTarget(hostTarget)}`)
if (/^(?:win32|darwin)-/u.test(hostTarget))
	required.push(
		`extension/dist/node_modules/@vscode/ripgrep/bin/${hostTarget.startsWith("win32-") ? "rg.exe" : "rg"}`,
	)

const runVerifier = (args, options = {}) =>
	spawnSync(process.execPath, [verifier, ...args], { encoding: "utf8", windowsHide: true, ...options })

async function withArchive(entries, check, target = hostTarget) {
	const root = await mkdtemp(path.join(os.tmpdir(), "alpha-vsix-content-test-"))
	try {
		const content = path.join(root, "content")
		for (const entry of entries) {
			const filePath = path.join(content, entry)
			await mkdir(path.dirname(filePath), { recursive: true })
			await writeFile(
				filePath,
				entry === "extension.vsixmanifest"
					? `<PackageManifest><Metadata><Identity Id="alpha" TargetPlatform="${target}"/></Metadata></PackageManifest>`
					: "owned archive fixture\n",
			)
		}
		const archive = path.join(root, "fixture.vsix")
		const pack = () => {
			const files = Object.create(null)
			const collect = (directory) => {
				for (const item of readdirSync(path.join(content, directory), { withFileTypes: true })) {
					const name = directory ? `${directory}/${item.name}` : item.name
					if (item.isDirectory()) collect(name)
					else files[name] = readFileSync(path.join(content, name))
				}
			}
			collect("")
			writeFileSync(archive, zipSync(files))
		}
		pack()
		await check({ archive, content, pack })
	} finally {
		const resolvedRoot = await realpath(root)
		assert.equal(path.dirname(resolvedRoot), await realpath(os.tmpdir()))
		assert.match(path.basename(resolvedRoot), /^alpha-vsix-content-test-/u)
		await rm(resolvedRoot, { recursive: true, force: true })
	}
}

function updateZipEntry(archive, name, update) {
	const bytes = readFileSync(archive)
	const end = bytes.length - 22
	for (let offset = bytes.readUInt32LE(end + 16); bytes.readUInt32LE(offset) === 0x02014b50; ) {
		const nameLength = bytes.readUInt16LE(offset + 28)
		if (bytes.toString("utf8", offset + 46, offset + 46 + nameLength) === name) {
			update(bytes, offset, bytes.readUInt32LE(offset + 42))
			writeFileSync(archive, bytes)
			return
		}
		offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
	}
	assert.fail(`Missing ZIP fixture entry: ${name}`)
}

test("VSIX content verification fails without an archive, for a missing file, and for unreadable archive bytes", async () => {
	const absent = runVerifier([])
	assert.equal(absent.status, 1)
	assert.match(absent.stderr, /Usage:/)
	const root = await mkdtemp(path.join(os.tmpdir(), "alpha-vsix-invalid-test-"))
	try {
		const archive = path.join(root, "missing.vsix")
		const missing = runVerifier([archive])
		assert.equal(missing.status, 1)
		assert.match(missing.stderr, /does not exist/)
		await writeFile(archive, "invalid archive")
		assert.notEqual(runVerifier([archive]).status, 0)
	} finally {
		const resolvedRoot = await realpath(root)
		assert.equal(path.dirname(resolvedRoot), await realpath(os.tmpdir()))
		assert.match(path.basename(resolvedRoot), /^alpha-vsix-invalid-test-/u)
		await rm(resolvedRoot, { recursive: true, force: true })
	}
})

test("VSIX content verification reads genuine ZIP packages without a system archive command", async () => {
	await withArchive(required, ({ archive }) => {
		assert.equal(readFileSync(archive).readUInt32LE(0), 0x04034b50)
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"))
		const result = runVerifier([archive], { env: { ...env, PATH: "" } })
		assert.equal(result.status, 0, result.stderr)
		assert.match(result.stdout, /required files are present/)
	})
})

test("VSIX inventory does not inflate arbitrary packaged payloads", async () => {
	await withArchive(required, ({ archive }) => {
		updateZipEntry(archive, "extension/dist/extension.js", (bytes, central, local) => {
			bytes.writeUInt16LE(99, central + 10)
			bytes.writeUInt16LE(99, local + 8)
		})
		const result = runVerifier([archive])
		assert.equal(result.status, 0, result.stderr)
	})
})

test("VSIX content verification rejects ambiguous duplicate entries", async () => {
	const first = "extension/duplicate-a.txt"
	const second = "extension/duplicate-b.txt"
	await withArchive([...required, first, second], ({ archive }) => {
		updateZipEntry(archive, second, (bytes, central, local) => {
			bytes.write(first, central + 46, "utf8")
			bytes.write(first, local + 30, "utf8")
		})
		const result = runVerifier([archive])
		assert.equal(result.status, 1)
		assert.match(result.stderr, /Duplicate VSIX archive entry/u)
	})
})

test("VSIX content verification rejects a truncated ZIP directory", async () => {
	await withArchive(required, ({ archive }) => {
		const bytes = readFileSync(archive)
		writeFileSync(archive, bytes.subarray(0, bytes.length - 22))
		const result = runVerifier([archive])
		assert.equal(result.status, 1)
		assert.match(result.stderr, /Unable to inspect VSIX archive/u)
	})
})

for (const [target, binding] of [
	["win32-x64", "lancedb.win32-x64-msvc.node"],
	["win32-arm64", "lancedb.win32-arm64-msvc.node"],
	["darwin-arm64", "lancedb.darwin-arm64.node"],
	["darwin-x64", null],
	["linux-x64", "lancedb.linux-x64-gnu.node"],
	["linux-arm64", "lancedb.linux-arm64-gnu.node"],
	["alpine-x64", "lancedb.linux-x64-musl.node"],
	["alpine-arm64", "lancedb.linux-arm64-musl.node"],
])
	test(`VSIX verification requires the declared ${target} platform's binding independently of the verifier host`, async () => {
		const platformEntries = required.filter(
			(entry) =>
				!entry.endsWith(".node") && !entry.startsWith("extension/dist/node_modules/@vscode/ripgrep/bin/"),
		)
		if (binding) platformEntries.push(`extension/dist/${binding}`)
		if (/^(?:win32|darwin)-/u.test(target))
			platformEntries.push(
				`extension/dist/node_modules/@vscode/ripgrep/bin/${target.startsWith("win32-") ? "rg.exe" : "rg"}`,
			)
		await withArchive(
			platformEntries,
			async ({ archive, content, pack }) => {
				assert.equal(runVerifier([archive, "--target", target]).status, 0)
				if (binding) {
					await rm(path.join(content, "extension/dist", binding))
					pack()
					const missing = runVerifier([archive])
					assert.equal(missing.status, 1)
					assert.ok(missing.stderr.includes(binding))
				} else {
					await writeFile(path.join(content, "extension/dist/lancedb.darwin-arm64.node"), "wrong platform")
					pack()
					const incompatible = runVerifier([archive])
					assert.equal(incompatible.status, 1)
					assert.match(incompatible.stderr, /incompatible LanceDB bindings/u)
				}
			},
			target,
		)
	})

test("VSIX verification refuses untargeted, unsupported, mismatched and ambiguous platform metadata", async () => {
	await withArchive(required, async ({ archive, content, pack }) => {
		const otherTarget = hostTarget === "linux-x64" ? "win32-x64" : "linux-x64"
		const mismatch = runVerifier([archive, "--target", otherTarget])
		assert.equal(mismatch.status, 1)
		assert.match(mismatch.stderr, /does not match requested target/u)
		for (const [attributes, error] of [
			['Id="alpha"', /must declare a TargetPlatform/u],
			['Id="alpha" TargetPlatform="universal"', /Unsupported VSIX target/u],
			[`TargetPlatform="${hostTarget}" TargetPlatform="${otherTarget}"`, /duplicate attribute/u],
			[`Id="alpha TargetPlatform='${hostTarget}'"`, /must declare a TargetPlatform/u],
		]) {
			await writeFile(
				path.join(content, "extension.vsixmanifest"),
				`<PackageManifest><Metadata><Identity ${attributes}/></Metadata></PackageManifest>`,
			)
			pack()
			const result = runVerifier([archive])
			assert.equal(result.status, 1)
			assert.match(result.stderr, error)
		}
	})
})

test("VSIX verification reads Identity elements while ignoring XML comments", async () => {
	await withArchive(required, async ({ archive, content, pack }) => {
		await writeFile(
			path.join(content, "extension.vsixmanifest"),
			`<PackageManifest><Metadata><!-- <Identity TargetPlatform="universal"/> --><Identity Id="alpha" TargetPlatform="${hostTarget}"/></Metadata></PackageManifest>`,
		)
		pack()
		const result = runVerifier([archive, "--target", hostTarget])
		assert.equal(result.status, 0, result.stderr)
	})
})

for (const [label, manifest] of [
	[
		"CDATA identity lookalikes",
		`<PackageManifest><Metadata><![CDATA[<Identity Id="alpha" TargetPlatform="${hostTarget}"/>]]></Metadata></PackageManifest>`,
	],
	[
		"comment delimiters manufactured by stripping",
		`<PackageManifest><Metadata><!<!-- removed -->--><Identity Id="alpha" TargetPlatform="${hostTarget}"/>--></Metadata></PackageManifest>`,
	],
	[
		"identity outside Metadata",
		`<PackageManifest><Assets><Identity Id="alpha" TargetPlatform="${hostTarget}"/></Assets></PackageManifest>`,
	],
	["an unclosed manifest", `<PackageManifest><Metadata><Identity Id="alpha" TargetPlatform="${hostTarget}"/>`],
	[
		"DOCTYPE declarations",
		`<!DOCTYPE PackageManifest><PackageManifest><Metadata><Identity Id="alpha" TargetPlatform="${hostTarget}"/></Metadata></PackageManifest>`,
	],
	[
		"foreign Identity namespaces",
		`<PackageManifest><Metadata><other:Identity xmlns:other="urn:other" Id="alpha" TargetPlatform="${hostTarget}"/></Metadata></PackageManifest>`,
	],
]) {
	test(`VSIX verification refuses ${label}`, async () => {
		await withArchive(required, async ({ archive, content, pack }) => {
			await writeFile(path.join(content, "extension.vsixmanifest"), manifest)
			pack()
			const result = runVerifier([archive, "--target", hostTarget])
			assert.equal(result.status, 1, result.stdout)
			assert.match(result.stderr, /Invalid VSIX platform contract/u)
		})
	})
}

test("VSIX verification refuses extra native platforms and oversized manifest allocations", async () => {
	const otherBinding =
		lanceDbBindingForTarget(hostTarget) === "lancedb.linux-x64-gnu.node"
			? "lancedb.win32-x64-msvc.node"
			: "lancedb.linux-x64-gnu.node"
	await withArchive([...required, `extension/dist/${otherBinding}`], ({ archive }) => {
		const result = runVerifier([archive])
		assert.equal(result.status, 1)
		assert.match(result.stderr, /incompatible LanceDB bindings/u)
	})
	await withArchive(required, ({ archive }) => {
		updateZipEntry(archive, "extension.vsixmanifest", (bytes, central, local) => {
			bytes.writeUInt32LE(32 * 1024 * 1024, central + 24)
			bytes.writeUInt32LE(32 * 1024 * 1024, local + 22)
		})
		const result = runVerifier([archive])
		assert.equal(result.status, 1)
		assert.match(result.stderr, /VSIX manifest exceeds/u)
	})
})

for (const entry of [
	"extension.vsixmanifest",
	"extension/dist/extension.js",
	"extension/dist/workers/sanitizeDocument.js",
	"extension/dist/workers/validateImage.js",
	"extension/dist/workers/searchCommandOutput.js",
	"extension/dist/workers/magick.wasm",
	"extension/dist/workers/magick-LICENSE",
	"extension/dist/workers/magick-NOTICE",
	"extension/assets/skills/skill-builder/references/evaluation.md",
	"extension/assets/skills/review-agent/SKILL.md",
	"extension/assets/skills/review-agent/agents/openai.yaml",
	"extension/webview-ui/build/html-document/viewer.js",
	"extension/webview-ui/build/html-document/purify.min.js",
])
	test(`VSIX content verification refuses a missing ${entry}`, async () => {
		await withArchive(
			required.filter((item) => item !== entry),
			({ archive }) => {
				const result = runVerifier([archive])
				assert.equal(result.status, 1)
				assert.ok(result.stderr.includes(entry))
			},
		)
	})

for (const entry of ["extension/.env", "extension/dist/nested/.env.local", "extension/assets/.env.production"])
	test(`VSIX content verification refuses packaged credentials at ${entry}`, async () => {
		await withArchive([...required, entry], ({ archive }) => {
			const result = runVerifier([archive])
			assert.equal(result.status, 1)
			assert.match(result.stderr, /must not contain .env files/)
			assert.ok(result.stderr.includes(entry))
		})
	})

for (const entry of [
	"extension/dist/node_modules/@vscode/ripgrep-linux-x64/bin/rg",
	"extension/dist/node_modules/@vscode/ripgrep-universal/bin/linux-x64/rg",
])
	test(`VSIX content verification refuses platform-incompatible ${entry}`, async () => {
		await withArchive([...required, entry], ({ archive }) => {
			const result = runVerifier([archive])
			assert.equal(result.status, 1)
			assert.match(result.stderr, /Linux-specific ripgrep binaries/)
		})
	})

test("VSIX source verification accepts fresh document assets and refuses stale copied bytes", async () => {
	await withArchive(required, async ({ archive, content, pack }) => {
		for (const directory of ["artifact-kit/v1", "html-document"])
			await cp(
				path.join(repository, "webview-ui/public", directory),
				path.join(content, "extension/webview-ui/build", directory),
				{ recursive: true },
			)
		pack()
		const current = runVerifier([archive, "--check-source"])
		assert.equal(current.status, 0, current.stderr)
		assert.match(current.stdout, /document assets match current source bytes/)
		await writeFile(path.join(content, "extension/webview-ui/build/html-document/viewer.js"), "stale viewer")
		pack()
		const stale = runVerifier([archive, "--check-source"])
		assert.equal(stale.status, 1)
		assert.match(stale.stderr, /Packaged asset differs from current source/)
		assert.match(stale.stderr, /html-document\/viewer.js/)
		const changed = readFileSync(path.join(repository, "webview-ui/public/html-document/viewer.js"))
		changed[0] ^= 1
		await writeFile(path.join(content, "extension/webview-ui/build/html-document/viewer.js"), changed)
		pack()
		const changedBytes = runVerifier([archive, "--check-source"])
		assert.equal(changedBytes.status, 1)
		assert.match(changedBytes.stderr, /Packaged asset differs from current source/u)
		updateZipEntry(archive, "extension/webview-ui/build/html-document/viewer.js", (bytes, central, local) => {
			bytes.writeUInt32LE(32 * 1024 * 1024, central + 24)
			bytes.writeUInt32LE(32 * 1024 * 1024, local + 22)
			bytes.writeUInt16LE(99, central + 10)
			bytes.writeUInt16LE(99, local + 8)
		})
		const oversized = runVerifier([archive, "--check-source"])
		assert.equal(oversized.status, 1)
		assert.match(oversized.stderr, /Packaged asset differs from current source/u)
		assert.doesNotMatch(oversized.stderr, /unknown compression/u)
		pack()
		updateZipEntry(archive, "extension/webview-ui/build/html-document/viewer.js", (bytes, central, local) => {
			bytes.writeUInt32LE(32 * 1024 * 1024, central + 20)
			bytes.writeUInt32LE(32 * 1024 * 1024, local + 18)
			bytes.writeUInt16LE(0, central + 10)
			bytes.writeUInt16LE(0, local + 8)
		})
		const oversizedStored = runVerifier([archive, "--check-source"])
		assert.equal(oversizedStored.status, 1)
		assert.match(oversizedStored.stderr, /Packaged asset differs from current source/u)
	})
})
