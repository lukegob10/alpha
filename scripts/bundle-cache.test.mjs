import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

const require = createRequire(import.meta.url)
const execute = promisify(execFile)

test("bundle cache restores every owned asset and tracks external copy inputs", { timeout: 90_000 }, async () => {
	const temporaryParent = await realpath(os.tmpdir())
	const root = await realpath(await mkdtemp(path.join(temporaryParent, "alpha-bundle-cache-")))
	const write = async (relative, contents) => {
		const destination = path.join(root, relative)
		await mkdir(path.dirname(destination), { recursive: true })
		await writeFile(destination, contents)
	}
	const read = (relative) => readFile(path.join(root, relative), "utf8")
	const run = async (task, filter, extra = []) =>
		execute(
			process.execPath,
			[require.resolve("turbo/bin/turbo"), "run", task, `--filter=${filter}`, "--cache=local:rw", ...extra],
			{
				cwd: root,
				timeout: 20_000,
				maxBuffer: 2 * 1024 * 1024,
				windowsHide: true,
				env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
			},
		)
	const bundleTask = async () => {
		const { stdout } = await run("bundle", "alpha", ["--dry=json"])
		const task = JSON.parse(stdout).tasks.find((item) => item.taskId === "alpha#bundle")
		assert.ok(task?.hash)
		return task
	}
	try {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
		await write(
			"package.json",
			JSON.stringify({ name: "bundle-cache-fixture", private: true, packageManager: manifest.packageManager }),
		)
		await write("pnpm-workspace.yaml", "packages:\n  - src\n  - webview-ui\n")
		await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  src: {}\n  webview-ui: {}\n")
		for (const relative of [
			"turbo.json",
			".gitignore",
			"src/turbo.json",
			"src/.gitignore",
			"webview-ui/turbo.json",
		]) {
			await write(relative, await readFile(new URL(`../${relative}`, import.meta.url)))
		}
		await write("src/package.json", JSON.stringify({ name: "alpha", scripts: { bundle: "node bundle.mjs" } }))
		await write(
			"webview-ui/package.json",
			JSON.stringify({ name: "@alpha-code/vscode-webview", scripts: { build: "node build.mjs" } }),
		)
		await write("webview-ui/src/index.ts", "export const view = 'fixture'\n")
		for (const name of ["README.md", "CHANGELOG.md", "LICENSE"]) await write(name, `${name} source`)
		await write("webview-ui/audio/notification.wav", "source audio")
		await write(
			"src/bundle.mjs",
			`import { copyFile, mkdir, writeFile } from "node:fs/promises"
for (const name of ["README.md", "CHANGELOG.md", "LICENSE"]) await copyFile("../" + name, name)
await mkdir("assets/vscode-material-icons/icons", { recursive: true })
await writeFile("assets/vscode-material-icons/icons/3d.svg", "fixture icon")
await mkdir("webview-ui/audio", { recursive: true })
await copyFile("../webview-ui/audio/notification.wav", "webview-ui/audio/notification.wav")
await mkdir("dist", { recursive: true })
await writeFile("dist/extension.js", "fixture extension")
`,
		)
		await write(
			"webview-ui/build.mjs",
			`import { mkdir, writeFile } from "node:fs/promises"
await mkdir("../src/webview-ui/build/assets", { recursive: true })
await writeFile("../src/webview-ui/build/assets/index.js", "fixture webview")
`,
		)
		await execute("git", ["init", "--initial-branch=main"], { cwd: root, windowsHide: true })
		await execute("git", ["add", "."], { cwd: root, windowsHide: true })
		const warmedBundle = await run("bundle", "alpha")

		// Warm the webview cache while extension-owned audio already exists beside its output.
		await write("webview-ui/src/index.ts", "export const view = 'updated fixture'\n")
		await run("build", "@alpha-code/vscode-webview")
		// Its dependency hash changed; cache the corresponding extension bundle before testing restoration.
		await run("bundle", "alpha")
		await write("src/webview-ui/audio/notification.wav", "owned by extension bundle")
		const restoredWebview = await run("build", "@alpha-code/vscode-webview")
		assert.match(restoredWebview.stdout, /@alpha-code\/vscode-webview:build:[^\r\n]*cache hit/u)
		assert.equal(await read("src/webview-ui/audio/notification.wav"), "owned by extension bundle")
		const beforeCleaning = await bundleTask()

		for (const relative of [
			"README.md",
			"CHANGELOG.md",
			"LICENSE",
			"assets/vscode-material-icons",
			"webview-ui",
			"dist",
		]) {
			const destination = path.resolve(root, "src", relative)
			assert.ok(destination.startsWith(`${root}${path.sep}`))
			await rm(destination, { recursive: true, force: true })
		}
		const afterCleaning = await bundleTask()
		assert.deepEqual(
			afterCleaning.inputs,
			beforeCleaning.inputs,
			"cleaning generated outputs must retain source inputs",
		)
		assert.equal(afterCleaning.hash, beforeCleaning.hash, "cleaning generated outputs must retain the bundle hash")
		const restored = await run("bundle", "alpha")
		assert.match(restored.stdout, /alpha:bundle:[^\r\n]*cache hit/u, warmedBundle.stderr + restored.stderr)
		for (const name of ["README.md", "CHANGELOG.md", "LICENSE"])
			assert.equal(await read(`src/${name}`), `${name} source`)
		assert.equal(await read("src/assets/vscode-material-icons/icons/3d.svg"), "fixture icon")
		assert.equal(await read("src/webview-ui/audio/notification.wav"), "source audio")
		assert.equal(await read("src/webview-ui/build/assets/index.js"), "fixture webview")
		assert.equal(await read("src/dist/extension.js"), "fixture extension")

		let previousHash = (await bundleTask()).hash
		for (const relative of ["README.md", "CHANGELOG.md", "LICENSE", "webview-ui/audio/notification.wav"]) {
			await write(relative, `${relative} changed`)
			const nextHash = (await bundleTask()).hash
			assert.notEqual(nextHash, previousHash, `${relative} must invalidate copied bundle assets`)
			previousHash = nextHash
		}
	} finally {
		assert.equal(path.dirname(root), temporaryParent)
		assert.match(path.basename(root), /^alpha-bundle-cache-/u)
		await rm(root, { recursive: true, force: true })
	}
})
