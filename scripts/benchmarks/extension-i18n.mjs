import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

import { build } from "esbuild"

// Run: node scripts/benchmarks/extension-i18n.mjs [baseline-ref]
// Isolates translation initialization; excludes bundle compilation, activation, and renderer startup.
const root = fileURLToPath(new URL("../..", import.meta.url))
const require = createRequire(import.meta.url)
const sourcePath = "src/i18n/setup.ts"
const baselineCommit = execFileSync(
	"git",
	["rev-parse", "--verify", "--end-of-options", `${process.argv[2] ?? "HEAD"}^{commit}`],
	{ cwd: root, encoding: "utf8", windowsHide: true },
).trim()
assert.match(baselineCommit, /^[a-f0-9]{40,64}$/)
const sources = {
	baseline: execFileSync("git", ["show", `${baselineCommit}:${sourcePath}`], {
		cwd: root,
		encoding: "utf8",
		windowsHide: true,
	}),
	current: fs.readFileSync(path.join(root, sourcePath), "utf8"),
}
const warmup = 10
const iterations = 80
const variants = []

for (const [name, contents] of Object.entries(sources)) {
	const result = await build({
		stdin: { contents, resolveDir: path.join(root, "src/i18n"), sourcefile: "setup.ts", loader: "ts" },
		bundle: true,
		platform: "node",
		format: "cjs",
		write: false,
		logLevel: "silent",
		minify: true,
	})
	const code = result.outputFiles[0].text
	variants.push({ name, bytes: Buffer.byteLength(code), script: new vm.Script(code), samples: [] })
}

for (let iteration = 0; iteration < iterations; iteration++) {
	for (const variant of iteration % 2 === 0 ? variants : [...variants].reverse()) {
		let fileReads = 0
		let directoryScans = 0
		const instrumentedFs = {
			...fs,
			readFileSync(...args) {
				fileReads++
				return fs.readFileSync(...args)
			},
			readdirSync(...args) {
				directoryScans++
				return fs.readdirSync(...args)
			},
		}
		const module = { exports: {} }
		const context = vm.createContext({
			require: (id) => (id === "fs" || id === "node:fs" ? instrumentedFs : require(id)),
			module,
			exports: module.exports,
			process: { ...process, env: { ...process.env, NODE_ENV: "production" } },
			console: { ...console, log: () => {} },
			Buffer,
			__dirname: path.join(root, "src"),
			__filename: path.join(root, "src", "i18n-startup.cjs"),
			setTimeout,
			clearTimeout,
			setImmediate,
			clearImmediate,
		})
		const startedAt = performance.now()
		variant.script.runInContext(context)
		const durationMs = performance.now() - startedAt
		assert.equal(module.exports.default.isInitialized, true)
		assert.equal(module.exports.default.t("worktrees:selectWorktreeLocation"), "Select Worktree Location")
		if (variant.name === "current") {
			assert.equal(fileReads, 0, "Bundled translations must not read files during module initialization")
			assert.equal(directoryScans, 0, "Bundled translations must not discover locales at runtime")
		}
		if (iteration >= warmup) variant.samples.push({ durationMs, fileReads, directoryScans })
	}
}

console.log(
	JSON.stringify({
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		baselineCommit,
		warmup,
		samples: iterations - warmup,
		conditions: "production environment; fresh VM contexts; precompiled minified bundles; warm filesystem caches",
		variants: variants.map(({ name, bytes, samples }) => {
			samples.sort((a, b) => a.durationMs - b.durationMs)
			return {
				name,
				bytes,
				medianMs: samples[Math.floor(samples.length / 2)].durationMs,
				p95Ms: samples[Math.floor(samples.length * 0.95)].durationMs,
				fileReadsPerLoad: [...new Set(samples.map((sample) => sample.fileReads))],
				directoryScansPerLoad: [...new Set(samples.map((sample) => sample.directoryScans))],
			}
		}),
	}),
)
