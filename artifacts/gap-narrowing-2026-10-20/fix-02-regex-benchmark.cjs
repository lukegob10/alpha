const { Worker } = require("node:worker_threads")
const { performance } = require("node:perf_hooks")
const { mkdtemp, mkdir, rm } = require("node:fs/promises")
const { createRequire } = require("node:module")
const os = require("node:os")
const path = require("node:path")

const repo = path.resolve(__dirname, "../..")
const requireFromExtension = createRequire(path.join(repo, "src/package.json"))
const { build } = requireFromExtension("esbuild")
const samples = 3
const line = "a".repeat(65535) + "!"

async function baseline() {
	const started = performance.now()
	const worker = new Worker(
		`const { parentPort } = require("node:worker_threads")
		const { performance } = require("node:perf_hooks")
		parentPort.once("message", line => {
			const started = performance.now()
			setImmediate(() => parentPort.postMessage({ matched, eventLoopDelayMs: performance.now() - started }))
			const matched = /a+$/i.test(line)
		})`,
		{ eval: true },
	)
	const timer = setTimeout(() => void worker.terminate(), 8_000)
	let result
	try {
		result = await new Promise((resolve, reject) => {
			worker.once("message", resolve)
			worker.on("error", reject)
			worker.once("exit", (code) => {
				if (code !== 0) reject(new Error("Baseline exceeded its 8 second watchdog"))
			})
			worker.postMessage(line)
		})
	} finally {
		clearTimeout(timer)
		await worker.terminate()
	}
	return { phase: "before", wallMs: performance.now() - started, ...result }
}

async function main() {
	const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "alpha-regex-bench-"))
	try {
		const workersPath = path.join(temporaryRoot, "workers")
		await mkdir(workersPath)
		await build({
			entryPoints: [path.join(repo, "src/workers/searchCommandOutput.ts")],
			outfile: path.join(workersPath, "searchCommandOutput.js"),
			bundle: true,
			platform: "node",
			format: "cjs",
		})
		const ownerPath = path.join(temporaryRoot, "owner.cjs")
		await build({
			entryPoints: [path.join(repo, "src/core/tools/helpers/commandOutputSearch.ts")],
			outfile: ownerPath,
			bundle: true,
			platform: "node",
			format: "cjs",
			plugins: [
				{
					name: "benchmark-translation-only",
					setup(builder) {
						builder.onLoad({ filter: /[/\\]i18n[/\\]index\.ts$/ }, () => ({
							contents: "export const t = key => key",
							loader: "js",
						}))
					},
				},
			],
		})
		const { withCommandOutputSearch } = require(ownerPath)
		console.log(JSON.stringify({ node: process.version, samples, bytes: Buffer.byteLength(line), pattern: "a+$" }))
		for (let sample = 1; sample <= samples; sample++) console.log(JSON.stringify({ sample, ...(await baseline()) }))
		for (let sample = 1; sample <= samples; sample++) {
			const started = performance.now()
			const eventLoopDelay = new Promise((resolve) => setImmediate(() => resolve(performance.now() - started)))
			let outcome
			try {
				await withCommandOutputSearch("a+$", undefined, (matcher) =>
					matcher.testBatch({
						lines: [line],
						firstLineNumber: 1,
						remainingBytes: 40 * 1024,
						hasMatches: false,
					}),
				)
				outcome = "completed"
			} catch (error) {
				outcome = error.message
			}
			console.log(
				JSON.stringify({
					sample,
					phase: "after",
					wallMs: performance.now() - started,
					eventLoopDelayMs: await eventLoopDelay,
					outcome,
				}),
			)
		}
	} finally {
		const resolvedRoot = path.resolve(temporaryRoot)
		if (
			path.dirname(resolvedRoot) !== path.resolve(os.tmpdir()) ||
			!path.basename(resolvedRoot).startsWith("alpha-regex-bench-")
		) {
			throw new Error("Unexpected benchmark temporary directory")
		}
		await rm(resolvedRoot, { recursive: true, force: true })
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
