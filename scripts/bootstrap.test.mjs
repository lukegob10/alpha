import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const bootstrapPath = fileURLToPath(new URL("./bootstrap.mjs", import.meta.url))
const { packageManager } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const requiredVersion = packageManager.slice("pnpm@".length)

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
