import { build } from "esbuild"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

// Isolates optional environment setup; this is not a whole-extension activation benchmark.
// Run from the repository root: node scripts/benchmarks/activation-environment.mjs
const root = fileURLToPath(new URL("../..", import.meta.url))
const require = createRequire(import.meta.url)
const envPath = JSON.stringify(path.join(tmpdir(), `alpha-activation-missing-${randomUUID()}`, ".env"))
const warmup = 5
const iterations = 40
const entries = {
	baseline: `
		import * as fs from "fs"
		import * as dotenvx from "@dotenvx/dotenvx"
		if (fs.existsSync(${envPath})) {
			try { dotenvx.config({ path: ${envPath} }) }
			catch (error) { console.warn("Failed to load environment variables:", error) }
		}
		module.exports.ready = Promise.resolve()
	`,
	updated: `
		import { loadExtensionEnvironment } from "./src/utils/loadEnvironment"
		module.exports.ready = loadExtensionEnvironment(${envPath})
	`,
}

const variants = []
for (const [name, contents] of Object.entries(entries)) {
	const result = await build({
		stdin: { contents, resolveDir: root, sourcefile: "activation-environment.ts", loader: "ts" },
		bundle: true,
		platform: "node",
		format: "cjs",
		write: false,
		logLevel: "silent",
	})
	const code = result.outputFiles[0].text
	variants.push({ name, bytes: Buffer.byteLength(code), script: new vm.Script(code), samples: [] })
}

for (let iteration = 0; iteration < iterations; iteration++) {
	for (const variant of iteration % 2 === 0 ? variants : [...variants].reverse()) {
		const module = { exports: {} }
		const context = vm.createContext({
			require,
			module,
			exports: module.exports,
			process,
			console,
			Buffer,
			__dirname: root,
			__filename: path.join(root, "activation-environment.cjs"),
			setTimeout,
			clearTimeout,
			setImmediate,
			clearImmediate,
		})
		const startedAt = performance.now()
		variant.script.runInContext(context)
		await module.exports.ready
		if (iteration >= warmup) variant.samples.push(performance.now() - startedAt)
	}
}

console.log(
	JSON.stringify({
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		warmup,
		samples: iterations - warmup,
		conditions: "missing .env; fresh VM contexts; precompiled bundles; warm filesystem/module caches",
	}),
)
for (const { name, bytes, samples } of variants) {
	samples.sort((a, b) => a - b)
	console.log(
		JSON.stringify({
			name,
			bytes,
			medianMs: samples[Math.floor(samples.length / 2)],
			p95Ms: samples[Math.floor(samples.length * 0.95)],
		}),
	)
}
