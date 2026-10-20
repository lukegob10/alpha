import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const bootstrapPath = fileURLToPath(new URL("./bootstrap.mjs", import.meta.url))
const { packageManager, engines, devDependencies } = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)
const requiredVersion = packageManager.slice("pnpm@".length)

test("local, extension, CI and evaluator toolchain pins agree", () => {
	const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8")
	const extension = JSON.parse(read("../src/package.json"))
	const action = read("../.github/actions/setup-node-pnpm/action.yml")
	const runner = read("../packages/evals/Dockerfile.runner")
	const inputDefault = (name) =>
		new RegExp(`^    ${name}:\\r?\\n(?:[^\\n]*\\n){2}        default: "([^"]+)"`, "m").exec(action)?.[1]
	const runnerArg = (name) => new RegExp(`^ARG ${name}=([^\\r\\n]+)`, "m").exec(runner)?.[1]

	assert.equal(read("../.nvmrc").trim(), `v${engines.node}`)
	const toolVersions = new Map(
		read("../.tool-versions")
			.trim()
			.split(/\r?\n/u)
			.map((line) => line.trim().split(/\s+/u)),
	)
	assert.equal(toolVersions.get("nodejs"), engines.node)
	assert.equal(toolVersions.get("pnpm"), requiredVersion)
	assert.equal(extension.engines.node, engines.node)
	assert.equal(inputDefault("node-version"), engines.node)
	assert.equal(inputDefault("npm-version"), engines.npm)
	assert.equal(inputDefault("pnpm-version"), requiredVersion)
	assert.equal(runnerArg("NODE_VERSION"), engines.node)
	assert.equal(runnerArg("NPM_VERSION"), engines.npm)
	assert.equal(runnerArg("PNPM_VERSION"), requiredVersion)
	// Evaluations use the reference host independently of the extension's installation minimum.
	assert.equal(runnerArg("VSCODE_VERSION"), "1.138.0")
	for (const workspace of [
		"src",
		"webview-ui",
		"apps/vscode-e2e",
		"packages/build",
		"packages/core",
		"packages/evals",
		"packages/ipc",
		"packages/telemetry",
		"packages/types",
	]) {
		assert.equal(
			JSON.parse(read(`../${workspace}/package.json`)).devDependencies["@types/node"],
			devDependencies["@types/node"],
			workspace,
		)
	}
})

test("the evaluator install stage receives every configured dependency patch", () => {
	const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8")
	const patchFiles = [...workspace.matchAll(/^\s+[^:\r\n]+:\s+(patches\/[^\s]+)\s*$/gmu)].map((match) => match[1])
	assert.ok(patchFiles.length > 0, "The workspace's dependency patches must be checked")
	const runner = readFileSync(new URL("../packages/evals/Dockerfile.runner", import.meta.url), "utf8")
	const install = runner.indexOf("RUN pnpm install --frozen-lockfile")
	assert.notEqual(install, -1, "The evaluator must install from its frozen lockfile")
	const installCopies = [...runner.slice(0, install).matchAll(/^COPY\s+\.\/(\S+)\s+\.\/(\S*)\s*$/gmu)]
	const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8").split(/\r?\n/u)
	for (const patch of patchFiles) {
		assert.ok(existsSync(new URL(`../${patch}`, import.meta.url)), `${patch} must exist`)
		assert.ok(
			installCopies.some(
				([, source, destination]) =>
					source === destination && (patch === source || patch.startsWith(`${source}/`)),
			),
			`${patch} must be copied to its configured path before the frozen install`,
		)
		const directory = patch.slice(0, patch.lastIndexOf("/"))
		assert.ok(dockerignore.includes(`!${directory}/`), `${directory} must be allowed into the build context`)
		assert.ok(dockerignore.includes(`!${directory}/**`), `${patch} must be allowed into the build context`)
	}
})

function runBootstrap(t, { installedVersion, invokedVersion, installStatus = 0 }) {
	const root = mkdtempSync(join(tmpdir(), "alpha-bootstrap-test-"))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	const logPath = join(root, "calls.jsonl")
	const runnerPath = join(root, "package-manager.mjs")
	writeFileSync(
		runnerPath,
		`
import { appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
const [command, ...args] = process.argv.slice(2)
appendFileSync(process.env.BOOTSTRAP_TEST_LOG, JSON.stringify({ command, args, bootstrap: process.env.BOOTSTRAP_IN_PROGRESS }) + "\\n")
if (command === "pnpm" && args[0] === "--version") {
	console.log(process.env.BOOTSTRAP_TEST_VERSION)
	process.exit(0)
}
// Exercise the real lifecycle guard while bounding a regression to one reentry.
if (process.env.BOOTSTRAP_TEST_REENTRY) process.exit(89)
const child = spawnSync(process.execPath, [process.env.BOOTSTRAP_TEST_SCRIPT], {
	env: { ...process.env, BOOTSTRAP_TEST_REENTRY: "1" },
	stdio: "inherit",
})
process.exit(child.status === 0 ? Number(process.env.BOOTSTRAP_TEST_STATUS) : (child.status ?? 1))
`,
	)

	for (const command of installedVersion ? ["pnpm", "npm"] : ["npm"]) {
		if (process.platform === "win32") {
			writeFileSync(
				join(root, `${command}.cmd`),
				`@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "${runnerPath}" ${command} %*\r\n`,
			)
		} else {
			const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
			writeFileSync(
				join(root, command),
				`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runnerPath)} ${command} "$@"\n`,
				{ mode: 0o755 },
			)
		}
	}

	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !/^(path|npm_config_user_agent|bootstrap_in_progress|bootstrap_test_.*)$/i.test(key),
		),
	)
	Object.assign(env, {
		// An isolated PATH ensures these cases cannot invoke a real package manager or network install.
		PATH: root,
		BOOTSTRAP_TEST_LOG: logPath,
		BOOTSTRAP_TEST_SCRIPT: bootstrapPath,
		BOOTSTRAP_TEST_VERSION: installedVersion ?? "",
		BOOTSTRAP_TEST_STATUS: String(installStatus),
	})
	if (invokedVersion) env.npm_config_user_agent = `pnpm/${invokedVersion} npm/? node/${process.version}`
	const result = spawnSync(process.execPath, [bootstrapPath], {
		cwd: root,
		env,
		encoding: "utf8",
		timeout: 10_000,
	})
	assert.equal(result.error, undefined, result.error?.message)
	assert.equal(result.signal, null)
	const calls = existsSync(logPath)
		? readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: []
	return { result, calls }
}

test("does not launch another installer inside the pinned pnpm lifecycle", (t) => {
	const { result, calls } = runBootstrap(t, { invokedVersion: requiredVersion })
	assert.equal(result.status, 0, result.stderr)
	assert.deepEqual(calls, [])
})

test("uses an installed pinned pnpm with a frozen lockfile and prevents lifecycle recursion", (t) => {
	const { result, calls } = runBootstrap(t, { installedVersion: requiredVersion })
	assert.equal(result.status, 0, result.stderr)
	assert.deepEqual(calls, [
		{ command: "pnpm", args: ["--version"] },
		{ command: "pnpm", args: ["install", "--frozen-lockfile"], bootstrap: "1" },
	])
})

for (const installedVersion of [undefined, "10.8.1"]) {
	test(`fetches the exact pinned pnpm when pnpm is ${installedVersion ? "outdated" : "missing"}`, (t) => {
		const { result, calls } = runBootstrap(t, { installedVersion })
		assert.equal(result.status, 0, result.stderr)
		assert.deepEqual(calls, [
			...(installedVersion ? [{ command: "pnpm", args: ["--version"] }] : []),
			{
				command: "npm",
				args: [
					"exec",
					"--yes",
					`--package=pnpm@${requiredVersion}`,
					"--",
					"pnpm",
					"install",
					"--frozen-lockfile",
				],
				bootstrap: "1",
			},
		])
	})
}

for (const [installedVersion, installStatus] of [
	[requiredVersion, 17],
	[undefined, 23],
]) {
	test(`preserves the ${installedVersion ? "installed pnpm" : "npm fallback"} failure status`, (t) => {
		const { result } = runBootstrap(t, { installedVersion, installStatus })
		assert.equal(result.status, installStatus)
		assert.match(result.stderr, /pnpm install failed/u)
		assert.doesNotMatch(result.stdout, /completed successfully/u)
	})
}
