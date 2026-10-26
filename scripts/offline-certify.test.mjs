import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./offline-certify.mjs", import.meta.url))

async function withPnpm(check) {
	const root = await mkdtemp(path.join(os.tmpdir(), "alpha offline certification "))
	try {
		const cli = path.join(root, "pnpm.cjs")
		const log = path.join(root, "calls.jsonl")
		await writeFile(
			cli,
			`const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.OFFLINE_CERTIFY_TEST_LOG, JSON.stringify({
	args, cwd: process.cwd(), offline: process.env.EVALS_OFFLINE_CERTIFICATION,
	hasProviderKey: "OPENAI_API_KEY" in process.env,
}) + "\\n")
process.exit(args.includes("test:contract") ? Number(process.env.OFFLINE_CERTIFY_TEST_STATUS || 0) : 0)
`,
		)
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) =>
					!/^(pnpm_home|npm_execpath|evals_private_benchmark_root|offline_certify_test_.*)$/iu.test(key),
			),
		)
		Object.assign(env, { npm_execpath: cli, OFFLINE_CERTIFY_TEST_LOG: log, OPENAI_API_KEY: "fixture-key" })
		const run = async (args = [], extraEnv = {}) => {
			const result = spawnSync(process.execPath, [script, ...args], {
				cwd: root,
				env: { ...env, ...extraEnv },
				encoding: "utf8",
				timeout: 15_000,
				windowsHide: true,
			})
			const calls = (await readFile(log, "utf8").catch(() => ""))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
			return { result, calls }
		}
		await check(run)
	} finally {
		const resolvedRoot = await realpath(root)
		assert.equal(path.dirname(resolvedRoot), await realpath(os.tmpdir()))
		assert.match(path.basename(resolvedRoot), /^alpha offline certification /u)
		await rm(resolvedRoot, { recursive: true, force: true })
	}
}

test("offline certification reuses its invoking pnpm CLI without a standalone installation", async () => {
	await withPnpm(async (run) => {
		const { result, calls } = await run(["--skip-private"])
		assert.equal(result.error, undefined)
		assert.equal(result.status, 0, result.stderr)
		assert.deepEqual(calls[0].args.slice(0, 5), ["--dir", "src", "exec", "vitest", "run"])
		assert.equal(calls.length, 8)
		assert.ok(calls.every((call) => call.offline === "1" && !call.hasProviderKey))
		assert.match(result.stdout, /Offline certification passed \(8 phases/u)
	})
})

test("offline certification never selects Redis or Docker contracts", async () => {
	await withPnpm(async (run) => {
		const { result, calls } = await run(["--skip-private"])
		assert.equal(result.status, 0, result.stderr)
		assert.deepEqual(
			calls.flatMap((call) =>
				call.args.filter((argument) => ["test:infrastructure", "test:redis", "test:docker"].includes(argument)),
			),
			[],
		)
		for (const command of ["test:unit", "test:contract", "test:certification"])
			assert.ok(
				calls.some((call) => call.args.includes(command)),
				command,
			)
	})
})

test("offline certification preserves full-workspace phases and stops on the first failed phase", async () => {
	await withPnpm(async (run) => {
		const { result, calls } = await run(["--full", "--skip-private"], { OFFLINE_CERTIFY_TEST_STATUS: "23" })
		assert.equal(result.error, undefined)
		assert.equal(result.status, 23, result.stderr)
		assert.deepEqual(
			calls.slice(0, 3).map((call) => call.args),
			[["lint"], ["check-types"], ["test"]],
		)
		assert.equal(calls.length, 5)
		assert.deepEqual(calls.at(-1).args, ["--filter", "@alpha-code/evals", "test:contract"])
		assert.match(result.stderr, /Offline certification stopped at: Eval harness contract tests/u)
		assert.doesNotMatch(result.stdout, /Offline certification passed/u)
	})
})
