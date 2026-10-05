import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("../", import.meta.url))
const verifier = path.join(repository, "scripts/verify-vsix-contents.mjs")
const required = [
	"extension/package.json",
	"extension/package.nls.json",
	"extension/dist/extension.js",
	"extension/dist/workers/sanitizeDocument.js",
	"extension/assets/skills/debug/SKILL.md",
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
	"extension/webview-ui/build/html-document/viewer.css",
]
if (["win32", "darwin"].includes(process.platform))
	required.push(`extension/dist/node_modules/@vscode/ripgrep/bin/${process.platform === "win32" ? "rg.exe" : "rg"}`)

const runVerifier = (args) => spawnSync(process.execPath, [verifier, ...args], { encoding: "utf8", windowsHide: true })

async function withArchive(entries, check) {
	const root = await mkdtemp(path.join(os.tmpdir(), "alpha-vsix-content-test-"))
	try {
		const content = path.join(root, "content")
		for (const entry of entries) {
			const target = path.join(content, entry)
			await mkdir(path.dirname(target), { recursive: true })
			await writeFile(target, "owned archive fixture\n")
		}
		// The checker owns archive entries and asset bytes. Use tar's portable
		// fixture format; the real pnpm vsix gate separately validates packaging.
		const archive = path.join(root, "fixture.vsix")
		const pack = () => {
			const result = spawnSync("tar", ["-cf", archive, "-C", content, "extension"], {
				encoding: "utf8",
				windowsHide: true,
			})
			assert.equal(result.error, undefined)
			assert.equal(result.status, 0, result.stderr)
		}
		pack()
		await check({ archive, content, pack })
	} finally {
		await rm(root, { recursive: true, force: true })
	}
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
		await rm(root, { recursive: true, force: true })
	}
})

test("VSIX content verification accepts the extension, webview, worker, skill, and platform assets", async () => {
	await withArchive(required, ({ archive }) => {
		const result = runVerifier([archive])
		assert.equal(result.status, 0, result.stderr)
		assert.match(result.stdout, /required files are present/)
	})
})

for (const entry of [
	"extension/dist/extension.js",
	"extension/dist/workers/sanitizeDocument.js",
	"extension/assets/skills/skill-builder/references/evaluation.md",
	"extension/webview-ui/build/html-document/viewer.js",
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
	})
})
