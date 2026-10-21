// Temporary diagnostic: exercises the real CLI without modifying the compiler or registry.
/* global require, module, __dirname, __filename, process, Buffer, setTimeout, clearTimeout, console, AbortController */
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node diagnostic and owner preload use CommonJS. */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createHash, randomUUID } = require("node:crypto")
const { builtinModules, createRequire } = require("node:module")
const { performance } = require("node:perf_hooks")
const { pathToFileURL } = require("node:url")

const LIMITS = {
	concurrency: 2,
	samples: 100,
	slowMs: 20_000,
	timeoutMs: 60_000,
	killAfterMs: 1_000,
	closeWaitMs: 2_000,
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const rounded = (value) => Number(value.toFixed(3))
const isLive = (child) => Number.isSafeInteger(child.pid) && child.exitCode === null && child.signalCode === null

// A single rescheduled monitor per active child covers observation, deadline, and cleanup.
async function runCompilerQueue(options) {
	const {
		samples,
		launch,
		validateOutput = async () => ({}),
		captureNativeStack,
		onRow = () => {},
		signal,
		now = () => performance.now(),
		setTimer = setTimeout,
		clearTimer = clearTimeout,
		limits = LIMITS,
	} = options
	assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= LIMITS.samples)
	const active = new Map()
	const rows = []
	let next = 0
	let stopped
	let capture
	let captured = false
	let maximumActive = 0
	let maximumMonitorTimers = 0
	let monitorTimers = 0
	const elapsed = (context) => rounded(now() - context.started)
	const clearMonitor = (context) => {
		if (context.timer !== undefined) {
			clearTimer(context.timer)
			context.timer = undefined
			monitorTimers--
		}
	}
	const complete = (context, forced = false) => {
		if (context.complete || (!forced && (!context.closed || !context.settled))) return
		context.complete = true
		clearMonitor(context)
		context.row.elapsedMs = elapsed(context)
		context.row.closeObserved = context.closed
		context.row.resultSettled = context.settled
		context.row.stdoutEnded = context.child.stdout?.readableEnded ?? null
		context.row.stderrEnded = context.child.stderr?.readableEnded ?? null
		active.delete(context.row.id)
		context.resolve()
	}
	const arm = (context, at) => {
		clearMonitor(context)
		if (context.complete) return
		monitorTimers++
		maximumMonitorTimers = Math.max(maximumMonitorTimers, monitorTimers)
		context.timer = setTimer(
			() => {
				context.timer = undefined
				monitorTimers--
				monitor(context)
			},
			Math.max(1, at - now()),
		)
	}
	const terminate = (context, reason) => {
		if (context.complete || context.terminationAt !== undefined) return
		context.row.terminationReason = reason
		context.terminationAt = now()
		if (isLive(context.child)) context.row.termSent = context.child.kill("SIGTERM")
		else {
			context.child.stdout?.destroy()
			context.child.stderr?.destroy()
		}
		arm(context, context.terminationAt + limits.killAfterMs)
	}
	const stop = (reason, cancelActive = false) => {
		stopped ??= reason
		if (cancelActive) for (const context of active.values()) terminate(context, reason)
	}
	function monitor(context) {
		if (context.complete) return
		if (context.terminationAt !== undefined) {
			if (!context.killAttempted) {
				context.killAttempted = true
				if (isLive(context.child)) context.row.killSent = context.child.kill("SIGKILL")
				arm(context, now() + limits.closeWaitMs)
			} else {
				context.row.failure ??= "Owned child or output streams did not settle after bounded TERM/KILL cleanup"
				context.row.cleanupUnverified = !context.closed
				context.child.stdout?.destroy()
				context.child.stderr?.destroy()
				complete(context, true)
			}
			return
		}
		if (!context.slowObserved) {
			context.slowObserved = true
			context.row.slow = true
			context.row.slowObservedMs = elapsed(context)
			context.row.liveAtSlowObservation = isLive(context.child)
			stop(`Compiler ${context.row.id} exceeded the diagnostic ${limits.slowMs} ms observation threshold`)
			if (isLive(context.child) && !captured) {
				captured = true
				capture = {
					id: context.row.id,
					slot: context.row.slot,
					pid: context.child.pid,
					elapsedMs: elapsed(context),
				}
				try {
					capture.result = captureNativeStack(context.child)
				} catch (error) {
					capture.error = { name: error.name, code: error.code, message: error.message }
				}
			}
			arm(context, context.started + limits.timeoutMs)
			return
		}
		context.row.timedOut = true
		context.row.failure ??= `Compiler exceeded the ${limits.timeoutMs} ms process/stdio bound`
		stop(context.row.failure)
		terminate(context, "process deadline")
	}
	const onAbort = () => stop("Driver cancellation", true)
	signal?.addEventListener("abort", onAbort, { once: true })
	if (signal?.aborted) onAbort()
	async function worker(slot) {
		while (!stopped && next < samples) {
			const row = { id: ++next, slot, timedOut: false, slow: false }
			let context
			try {
				const started = now()
				const child = launch(slot, row.id)
				row.pid = child.pid
				const done = new Promise((resolve) => {
					context = { child, row, started, resolve, closed: false, settled: false, complete: false }
				})
				active.set(row.id, context)
				maximumActive = Math.max(maximumActive, active.size)
				child.once("exit", (code, childSignal) => {
					row.exitCode = code
					row.signal = childSignal
					row.exitElapsedMs = elapsed(context)
				})
				child.once("close", (code, childSignal) => {
					context.closed = true
					row.closeCode = code
					row.closeSignal = childSignal
					row.closeElapsedMs = elapsed(context)
					complete(context)
				})
				child
					.then(
						(result) => {
							context.result = result
						},
						(error) => {
							context.result = error
							row.failure ??= error.shortMessage ?? error.message
						},
					)
					.then(() => {
						context.settled = true
						row.resultElapsedMs = elapsed(context)
						if (context.result.exitCode !== 0 || context.result.failed) {
							row.failure ??= `Compiler exited ${context.result.exitCode ?? context.result.code}`
							stop(row.failure, true)
						}
						complete(context)
					})
				arm(context, started + limits.slowMs)
				await done
				const result = context.result
				for (const stream of ["stdout", "stderr"]) {
					const output = String(result?.[stream] ?? "")
					row[stream] = output.slice(0, 65_536)
					row[`${stream}Bytes`] = Buffer.byteLength(output)
					row[`${stream}Truncated`] = output.length > 65_536
				}
				if (!row.failure && row.exitCode === 0 && row.closeObserved && row.resultSettled) {
					Object.assign(row, await validateOutput(slot, row.id))
				}
			} catch (error) {
				row.failure ??= error.message
				stop(row.failure, true)
				if (context && !context.complete) {
					terminate(context, "driver failure")
					await new Promise((resolve) => {
						const previous = context.resolve
						context.resolve = () => {
							previous()
							resolve()
						}
					})
				}
			}
			rows.push(row)
			try {
				onRow(row)
			} catch (error) {
				row.failure ??= `Recording diagnostic results failed: ${error.message}`
				stop(row.failure, true)
			}
		}
	}
	try {
		await Promise.all(Array.from({ length: limits.concurrency }, (_, slot) => worker(slot)))
	} finally {
		signal?.removeEventListener("abort", onAbort)
		for (const context of active.values()) clearMonitor(context)
	}
	return {
		rows: rows.sort((left, right) => left.id - right.id),
		stopped,
		capture,
		maximumActive,
		maximumMonitorTimers,
		remainingMonitorTimers: monitorTimers,
		allClosed: rows.every((row) => row.closeObserved),
		pass: rows.length === samples && rows.every((row) => !row.failure && !row.slow && row.outputHashMatches),
	}
}

function canonicalCompilerArguments(source, compiler, entrypoint, outfile) {
	const normalized = source.replace(/\r\n/g, "\n")
	assert.ok(normalized.includes("[...builtinModules, ...builtinModules.map((m) => `node:${m}`)]"))
	const banner = /export const COMMONJS_REQUIRE_BANNER = `([^`]+)`/.exec(normalized)?.[1]
	assert.ok(banner, "Current tracked compiler banner must be readable")
	return [
		compiler,
		entrypoint,
		`--outfile=${outfile}`,
		"--format=esm",
		"--platform=node",
		"--target=node18",
		"--bundle",
		"--sourcemap=inline",
		"--packages=bundle",
		...[...builtinModules, ...builtinModules.map((name) => `node:${name}`)].map((name) => `--external:${name}`),
		`--banner:js=${banner}`,
	]
}

async function main() {
	const argument = process.argv[2] ?? "--samples=100"
	assert.ok(
		/^--samples=\d+$/.test(argument) && process.argv.length <= 3,
		"Usage: node scripts/diagnostics/native-compiler-stack.cjs [--samples=1..100]",
	)
	const samples = Number(argument.slice("--samples=".length))
	assert.ok(samples >= 1 && samples <= LIMITS.samples)
	assert.equal(process.version, "v24.21.0")
	assert.deepEqual(process.execArgv, [], "Run the driver without Node flags or preloads")
	assert.ok(!process.env.NODE_OPTIONS?.trim(), "Inherited Node flags/preloads are not permitted")
	const repository = path.resolve(__dirname, "../..")
	const cwd = path.join(repository, "packages/core")
	const evidence = path.join(
		repository,
		"artifacts/harness/release-3.2.7/compiler-stack-stress",
		`${process.platform}-${process.pid}-${randomUUID()}`,
	)
	fs.mkdirSync(evidence, { recursive: true })
	const sourceFile = path.join(cwd, "src/custom-tools/esbuild-runner.ts")
	const entrypoint = path.join(cwd, "src/custom-tools/__tests__/fixtures-override/simple.ts")
	const compiler = path.join(repository, "src/node_modules/esbuild-wasm/bin/esbuild")
	const compilerPackage = path.dirname(path.dirname(compiler))
	const helper = path.join(cwd, "src/custom-tools/__tests__/registry-owner-preload.cjs")
	const env = {
		...process.env,
		NODE_PATH: [path.join(path.dirname(entrypoint), "node_modules"), path.join(cwd, "node_modules")].join(
			path.delimiter,
		),
	}
	for (const key of Object.keys(env)) {
		if (
			key.startsWith("ALPHA_REGISTRY_PROCESS_") ||
			["ALPHA_CUSTOM_TOOL_NATIVE_STACKS", "ALPHA_CUSTOM_TOOL_TRACE_DIR", "ALPHA_TRACE_CUSTOM_TOOLS"].includes(key)
		)
			delete env[key]
	}
	process.env.ALPHA_REGISTRY_PROCESS_TRACE_DIR = evidence
	delete process.env.ALPHA_REGISTRY_PROCESS_SNAPSHOT_AT
	const { captureNativeStack: captureFromObserver } = require(helper)
	const requireFromCore = createRequire(path.join(cwd, "package.json"))
	const execaEntry = requireFromCore.resolve("execa")
	const { execa } = await import(pathToFileURL(execaEntry).href)
	const execaVersion = JSON.parse(
		fs.readFileSync(path.join(path.dirname(execaEntry), "package.json"), "utf8"),
	).version
	assert.equal(execaVersion, "9.6.0")
	const temporaryParent = fs.realpathSync(os.tmpdir())
	const prefix = "alpha-compiler-stack-"
	const temporaryDirectory = fs.mkdtempSync(path.join(temporaryParent, prefix))
	const source = fs.readFileSync(sourceFile, "utf8")
	const outfiles = Array.from({ length: LIMITS.concurrency }, (_, slot) =>
		path.join(temporaryDirectory, `slot-${slot}`, "bundle.mjs"),
	)
	for (const outfile of outfiles) fs.mkdirSync(path.dirname(outfile))
	const args = outfiles.map((outfile) => canonicalCompilerArguments(source, compiler, entrypoint, outfile))
	const inputs = {
		driver: __filename,
		sourceFile,
		entrypoint,
		helper,
		compiler,
		wasm: path.join(compilerPackage, "esbuild.wasm"),
		nodeLoader: path.join(compilerPackage, "wasm_exec_node.js"),
		goLoader: path.join(compilerPackage, "wasm_exec.js"),
	}
	const hashes = () =>
		Object.fromEntries(Object.entries(inputs).map(([name, file]) => [name, sha256(fs.readFileSync(file))]))
	const findExecutable = (name) => {
		for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
			const candidate = path.join(directory, name)
			try {
				fs.accessSync(candidate, fs.constants.X_OK)
				return fs.realpathSync(candidate)
			} catch {
				/* Try next PATH entry. */
			}
		}
		return null
	}
	const gdb = process.platform === "linux" ? findExecutable("gdb") : null
	const report = {
		purpose: "Temporary unmodified compiler stress probe; no production or reliability claim",
		startedAt: new Date().toISOString(),
		pid: process.pid,
		ppid: process.ppid,
		node: process.version,
		versions: process.versions,
		execPath: process.execPath,
		platform: process.platform,
		arch: process.arch,
		osRelease: os.release(),
		cpu: os.cpus()[0]?.model,
		availableParallelism: os.availableParallelism(),
		execaVersion,
		compilerVersion: JSON.parse(fs.readFileSync(path.join(compilerPackage, "package.json"), "utf8")).version,
		limits: { ...LIMITS, samples },
		cwd,
		inputs,
		hashesBefore: hashes(),
		argsBySlot: args,
		NODE_PATH: env.NODE_PATH,
		compilerNodeOptions: env.NODE_OPTIONS ?? null,
		compilerPreload: false,
		compilerFlags: [],
		debugger: {
			path: gdb,
			sha256: gdb ? sha256(fs.readFileSync(gdb)) : null,
			sudoPath: findExecutable("sudo"),
			timeoutPath: findExecutable("timeout"),
			helper,
			helperSha256: sha256(fs.readFileSync(helper)),
		},
		streamBufferBytes: 65_536,
		compiledOutputMaxBytesPerSlot: 8 * 1024 * 1024,
		outputHashContract: "Byte-identical within each fixed outfile slot; inline sourcemaps may differ across slots",
		rows: [],
	}
	const reportFile = path.join(evidence, "results.json")
	const save = () => {
		fs.writeFileSync(`${reportFile}.tmp`, `${JSON.stringify(report, null, 2)}\n`)
		fs.renameSync(`${reportFile}.tmp`, reportFile)
	}
	const controller = new AbortController()
	const cancel = () => controller.abort()
	process.once("SIGINT", cancel)
	process.once("SIGTERM", cancel)
	const slotHashes = new Map()
	let result
	try {
		save()
		result = await runCompilerQueue({
			samples,
			signal: controller.signal,
			launch(slot) {
				fs.rmSync(outfiles[slot], { force: true })
				return execa(process.execPath, args[slot], {
					cwd,
					env,
					stdin: "ignore",
					maxBuffer: 65_536,
					forceKillAfterDelay: false,
				})
			},
			captureNativeStack(child) {
				if (process.platform !== "linux") return { code: "UNSUPPORTED_PLATFORM", platform: process.platform }
				return captureFromObserver(child)
			},
			async validateOutput(slot) {
				assert.ok(
					fs.statSync(outfiles[slot]).size <= report.compiledOutputMaxBytesPerSlot,
					"Compiled output exceeds the diagnostic bound",
				)
				const output = fs.readFileSync(outfiles[slot])
				const outputSha256 = sha256(output)
				if (!slotHashes.has(slot)) {
					slotHashes.set(slot, outputSha256)
					fs.writeFileSync(path.join(evidence, `slot-${slot}.bundle.mjs`), output)
				}
				assert.equal(outputSha256, slotHashes.get(slot), `Compiler output changed within slot ${slot}`)
				return { outputSha256, outputBytes: output.length, outputHashMatches: true }
			},
			onRow(row) {
				report.rows.push(row)
				save()
				console.log(
					`compiler ${row.id}/${samples} slot=${row.slot} pid=${row.pid} elapsed=${row.elapsedMs}ms exit=${row.exitCode} close=${row.closeObserved} ${row.failure ?? ""}`,
				)
			},
		})
		Object.assign(report, result)
		if (result.capture?.result?.file) {
			const stackFile = path.resolve(evidence, result.capture.result.file)
			assert.equal(path.dirname(stackFile), evidence)
			report.capture.stackFile = stackFile
			report.capture.stackSha256 = sha256(fs.readFileSync(stackFile))
		}
	} finally {
		process.removeListener("SIGINT", cancel)
		process.removeListener("SIGTERM", cancel)
		report.hashesAfter = hashes()
		report.inputsUnchanged = JSON.stringify(report.hashesBefore) === JSON.stringify(report.hashesAfter)
		const resolved = fs.realpathSync(temporaryDirectory)
		assert.ok(path.isAbsolute(resolved))
		assert.equal(path.dirname(resolved).toLowerCase(), temporaryParent.toLowerCase())
		assert.ok(path.basename(resolved).startsWith(prefix))
		report.cleanup = { directory: resolved, absoluteContainmentValidated: true, removed: false }
		if (result?.allClosed) {
			fs.rmSync(resolved, { recursive: true, force: true })
			report.cleanup.removed = true
		}
		report.finishedAt = new Date().toISOString()
		report.pass = Boolean(report.pass && report.inputsUnchanged && report.cleanup.removed)
		save()
		console.log(
			JSON.stringify(
				{
					pass: report.pass,
					stopped: report.stopped,
					capture: report.capture,
					completed: report.rows.length,
					evidence,
				},
				null,
				2,
			),
		)
		if (!report.pass) process.exitCode = 1
		if (result && !result.allClosed) process.exit(1)
	}
}

module.exports = { runCompilerQueue, canonicalCompilerArguments, LIMITS }
if (require.main === module)
	main().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
