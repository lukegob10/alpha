import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

// Run: pnpm exec node scripts/benchmarks/tokenizer-startup.mjs [reference-commit]
// Source-build the clean HEAD tokenizer and the working-tree candidate with the
// extension's single-file CommonJS format. This isolates tokenizer loading, not
// total activation or first-paint latency. Each sample uses a fresh Node process;
// filesystem/OS caches remain warm, and first-use cost is reported separately.
const root = fileURLToPath(new URL("../../", import.meta.url))
const sourcePath = "src/utils/tiktoken.ts"
const referenceCommit = execFileSync(
	"git",
	["rev-parse", "--verify", "--end-of-options", `${process.argv[2] ?? "HEAD"}^{commit}`],
	{ cwd: root, encoding: "utf8" },
).trim()
const referenceSource = execFileSync("git", ["show", `${referenceCommit}:${sourcePath}`], {
	cwd: root,
	encoding: "utf8",
})
const candidateSource = await readFile(path.join(root, sourcePath), "utf8")
const require = createRequire(path.join(root, "src/package.json"))
const tiktokenDirectory = path.dirname(require.resolve("tiktoken/lite"))
const dependencies = {
	esbuild: esbuild.version,
	tiktoken: JSON.parse(await readFile(path.join(tiktokenDirectory, "../package.json"), "utf8")).version,
	pnpmLockSha256: createHash("sha256")
		.update(await readFile(path.join(root, "pnpm-lock.yaml")))
		.digest("hex"),
}
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "alpha-tokenizer-startup-"))
const samples = 15
const fixture = [
	{ type: "text", text: "Alpha Code startup fixture: preserve exact token counting." },
	{ type: "tool_use", id: "fixture-call", name: "read_file", input: { path: "src/extension.ts" } },
	{ type: "tool_result", tool_use_id: "fixture-call", content: "Fixture file contents." },
]
const childScript = `
const assert = require("node:assert/strict")
const { performance } = require("node:perf_hooks")
const start = performance.now()
const { tiktoken } = require(process.argv[1])
const moduleLoadMs = performance.now() - start
;(async () => {
	assert.equal(await tiktoken([]), 0)
	const firstStart = performance.now()
	const firstTokens = await tiktoken(${JSON.stringify(fixture)})
	const firstUseMs = performance.now() - firstStart
	const warmStart = performance.now()
	for (let index = 0; index < 100; index++) {
		assert.equal(await tiktoken(${JSON.stringify(fixture)}), firstTokens)
	}
	console.log(JSON.stringify({ moduleLoadMs, firstUseMs, warmCountMs: (performance.now() - warmStart) / 100, firstTokens }))
})().catch((error) => { console.error(error); process.exitCode = 1 })
`

const builds = []
try {
	await copyFile(path.join(tiktokenDirectory, "tiktoken_bg.wasm"), path.join(temporaryDirectory, "tiktoken_bg.wasm"))
	for (const [name, source] of [
		["reference", referenceSource],
		["candidate", candidateSource],
	]) {
		const outfile = path.join(temporaryDirectory, `${name}.cjs`)
		await esbuild.build({
			stdin: { contents: source, loader: "ts", sourcefile: sourcePath, resolveDir: path.join(root, "src/utils") },
			outfile,
			bundle: true,
			format: "cjs",
			platform: "node",
			minify: true,
			logLevel: "silent",
		})
		builds.push({
			name,
			outfile,
			sourceSha256: createHash("sha256").update(source).digest("hex"),
			bundleBytes: (await readFile(outfile)).length,
			observations: [],
		})
	}
	for (let sample = 0; sample < samples; sample++) {
		// Alternate order so one build does not always benefit from the other's disk reads.
		for (const build of sample % 2 === 0 ? builds : [...builds].reverse()) {
			build.observations.push(
				JSON.parse(execFileSync(process.execPath, ["-e", childScript, build.outfile], { encoding: "utf8" })),
			)
		}
	}
	const expectedTokens = builds[0].observations[0].firstTokens
	const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
	const results = builds.map(({ name, sourceSha256, bundleBytes, observations }) => {
		assert.ok(observations.every(({ firstTokens }) => firstTokens === expectedTokens))
		return {
			name,
			sourceSha256,
			bundleBytes,
			medianModuleLoadMs: median(observations.map(({ moduleLoadMs }) => moduleLoadMs)),
			medianFirstUseMs: median(observations.map(({ firstUseMs }) => firstUseMs)),
			medianWarmCountMs: median(observations.map(({ warmCountMs }) => warmCountMs)),
			observations,
		}
	})
	console.log(
		JSON.stringify(
			{
				benchmark: "tokenizer-startup",
				referenceCommit,
				sourcePath,
				node: process.version,
				platform: `${process.platform}-${process.arch}`,
				dependencies,
				cache: "fresh module cache in each process; warm filesystem/OS caches",
				samples,
				fixture,
				expectedTokens,
				results,
			},
			null,
			2,
		),
	)
} finally {
	// mkdtemp owns this exact directory; no workspace/generated trees are removed.
	assert.equal(path.dirname(temporaryDirectory), path.resolve(tmpdir()))
	assert.ok(path.basename(temporaryDirectory).startsWith("alpha-tokenizer-startup-"))
	await rm(temporaryDirectory, { recursive: true, force: true })
}
