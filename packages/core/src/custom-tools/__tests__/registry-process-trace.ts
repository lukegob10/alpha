import assert from "node:assert/strict"
import { type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const TRACE_PRELOAD = `
const fs = require("node:fs")
const path = require("node:path")
const directory = process.env.ALPHA_REGISTRY_PROCESS_TRACE_DIR
const file = path.join(directory, process.pid + ".child.json")
const events = new Array(512)
let total = 0
function stage(stage, value) {
	events[total++ % events.length] = [Date.now(), stage, value ?? ""]
}
function flush(phase) {
	const start = Math.max(0, total - events.length)
	const snapshot = { phase, at: Date.now(), uptime: process.uptime(), pid: process.pid, ppid: process.ppid, total,
		resources: process.getActiveResourcesInfo(), cpu: process.cpuUsage(),
		events: Array.from({ length: Math.min(total, events.length) }, (_, index) => events[(start + index) % events.length]) }
	fs.writeFileSync(file, JSON.stringify(snapshot))
}
globalThis.__alphaRegistryProcessStage = stage
stage("preload", { executable: process.execPath, entry: process.argv[1] ?? "eval" })
flush("preload")
const snapshotAt = Number(process.env.ALPHA_REGISTRY_PROCESS_SNAPSHOT_AT)
if (Number.isFinite(snapshotAt)) setTimeout(() => {
	stage("deadline snapshot", { resources: process.getActiveResourcesInfo(), cpu: process.cpuUsage() })
	flush("deadline snapshot")
}, Math.max(1, snapshotAt - Date.now())).unref()
process.on("beforeExit", code => { stage("beforeExit", code); flush("beforeExit") })
process.on("exit", code => { stage("exit", code); flush("exit") })
process.on("uncaughtExceptionMonitor", error => { stage("uncaught", { name: error.name, message: error.message }); flush("uncaught") })
`

/** Opt-in investigation fixture; never changes production sources or test deadlines. */
export class RegistryProcessTrace {
	bundle?: string
	readonly preload: string
	readonly env: Record<string, string>
	private events: unknown[] = new Array(512)
	private total = 0
	private children = new Map<number, ChildProcess>()
	private file: string
	private removeAbortListener?: () => void

	constructor(
		readonly directory: string,
		private readonly ownerOnly = false,
	) {
		this.preload = path.join(directory, "preload.cjs")
		this.file = path.join(directory, `${process.pid}.parent.json`)
		this.env = {
			ALPHA_REGISTRY_PROCESS_TRACE_DIR: directory,
			...(!ownerOnly ? { ALPHA_REGISTRY_PROCESS_TRACE_PRELOAD: this.preload } : {}),
		}
		fs.mkdirSync(directory, { recursive: true })
		fs.writeFileSync(
			this.preload,
			ownerOnly
				? fs.readFileSync(fileURLToPath(new URL("./registry-owner-preload.cjs", import.meta.url)))
				: TRACE_PRELOAD,
		)
		this.stage("parent trace start")
		this.flush("start")
	}

	stage(stage: string, value?: unknown): void {
		this.events[this.total++ % this.events.length] = [Date.now(), stage, value ?? ""]
	}

	setSnapshotDeadline(deadlineAt: number): void {
		// Observe just before the existing deadline; this timer never cancels or extends execution.
		const margin =
			process.env.ALPHA_CUSTOM_TOOL_NATIVE_STACKS === "1" && deadlineAt - Date.now() > 10_000 ? 10_000 : 1_000
		this.env.ALPHA_REGISTRY_PROCESS_SNAPSHOT_AT = String(deadlineAt - margin)
	}

	bindSignal(signal: AbortSignal): void {
		const onAbort = () => {
			this.stage("parent signal abort")
			this.flush("abort")
		}
		signal.addEventListener("abort", onAbort, { once: true })
		if (signal.aborted) onAbort()
		this.removeAbortListener = () => signal.removeEventListener("abort", onAbort)
	}

	observe(child: ChildProcess): void {
		this.children.set(child.pid ?? -1, child)
		this.stage("parent child created", child.pid)
		if (!this.ownerOnly) this.flush("child created")
		child.on("spawn", () => {
			this.stage("parent child spawn", child.pid)
			if (!this.ownerOnly) this.flush("child spawn")
		})
		child.on("exit", (code, signal) => {
			this.stage("parent child exit", { pid: child.pid, code, signal })
			this.flush("child exit")
		})
		child.on("close", (code, signal) => {
			this.stage("parent child close", { pid: child.pid, code, signal })
			this.flush("child close")
		})
		child.on("error", (error: NodeJS.ErrnoException) => {
			this.stage("parent child error", { name: error.name, code: error.code })
			this.flush("child error")
		})
		child.stdout?.on("end", () => {
			this.stage("parent child stdout end", child.pid)
		})
		child.stderr?.on("end", () => {
			this.stage("parent child stderr end", child.pid)
		})
	}

	wrapScript(script: string): string {
		// Static imports retain their original linking/evaluation order; the preload runs before linking.
		return `globalThis.__alphaRegistryProcessStage("body start");\n${script}\nglobalThis.__alphaRegistryProcessStage("body complete", process.getActiveResourcesInfo());`
	}

	flush(phase: string): void {
		const start = Math.max(0, this.total - this.events.length)
		fs.writeFileSync(
			this.file,
			JSON.stringify({
				phase,
				at: Date.now(),
				uptime: process.uptime(),
				pid: process.pid,
				total: this.total,
				resources: process.getActiveResourcesInfo(),
				cpu: process.cpuUsage(),
				children: [...this.children.values()].map((child) => ({
					pid: child.pid,
					exitCode: child.exitCode,
					signalCode: child.signalCode,
					killed: child.killed,
					stdin: {
						writableLength: child.stdin?.writableLength,
						writableEnded: child.stdin?.writableEnded,
						destroyed: child.stdin?.destroyed,
					},
					stdout: {
						readableLength: child.stdout?.readableLength,
						readableEnded: child.stdout?.readableEnded,
						readableFlowing: child.stdout?.readableFlowing,
						destroyed: child.stdout?.destroyed,
					},
					stderr: {
						readableLength: child.stderr?.readableLength,
						readableEnded: child.stderr?.readableEnded,
						readableFlowing: child.stderr?.readableFlowing,
						destroyed: child.stderr?.destroyed,
					},
				})),
				events: Array.from(
					{ length: Math.min(this.total, this.events.length) },
					(_, index) => this.events[(start + index) % this.events.length],
				),
			}),
		)
	}

	dispose(): void {
		this.removeAbortListener?.()
		this.stage("parent trace disposed")
		this.flush("disposed")
	}

	async instrumentBundle(bundle: string): Promise<void> {
		if (this.ownerOnly) {
			this.bundle = bundle
			this.stage("parent original registry bundle", bundle)
			return
		}
		let source = await fs.promises.readFile(bundle, "utf8")
		const inject = (before: string, after: string) => {
			assert.ok(source.includes(before), `Registry trace target missing: ${before}`)
			source = source.replaceAll(before, after)
		}
		const replace = (expression: RegExp, replacement: string) => {
			assert.ok(expression.test(source), `Registry trace target missing: ${expression}`)
			source = source.replace(expression, replacement)
		}
		source =
			`function __alphaStage(stage, value) { globalThis.__alphaRegistryProcessStage(stage, value) }\n__alphaStage("registry evaluated");\n` +
			source
		inject(
			"async readDirectorySnapshot(directory, key, force) {",
			'async readDirectorySnapshot(directory, key, force) { __alphaStage("directory begin", directory);',
		)
		replace(/for \(const (file\d*) of (files\d*)\) \{/, 'for (const $1 of $2) { __alphaStage("manifest read", $1);')
		inject(
			"const sourceFingerprint = fingerprint(",
			'__alphaStage("manifest complete", directory); const sourceFingerprint = fingerprint(',
		)
		inject(
			"async importSource(absolutePath, sourceFingerprint, force) {",
			'async importSource(absolutePath, sourceFingerprint, force) { __alphaStage("source", absolutePath);',
		)
		inject(
			"while (pendingModuleLoads.has(key)) {",
			'while (pendingModuleLoads.has(key)) { __alphaStage("module lock wait", key);',
		)
		inject(
			"async function runEsbuild(options, extensionPath) {",
			'async function runEsbuild(options, extensionPath) { __alphaStage("compile begin", options.entryPoint);',
		)
		inject(
			'await execa(process.execPath, args, { env, stdin: "ignore" });',
			'const child = execa(process.execPath, ["--require", process.env.ALPHA_REGISTRY_PROCESS_TRACE_PRELOAD, ...args], { env, stdin: "ignore" }); __alphaStage("compiler created", [child.pid, options.entryPoint]); child.on("spawn", () => __alphaStage("compiler spawn", [child.pid, options.entryPoint])); child.on("exit", (code, signal) => __alphaStage("compiler exit", [child.pid, code, signal])); child.on("close", (code, signal) => __alphaStage("compiler close", [child.pid, code, signal])); child.stdout?.on("end", () => __alphaStage("compiler stdout end", child.pid)); child.stderr?.on("end", () => __alphaStage("compiler stderr end", child.pid)); await child; __alphaStage("compile complete", options.entryPoint);',
		)
		replace(/return import\((url\d*)\);/, '__alphaStage("native import begin", $1); return import($1);')
		replace(
			/const (mod\d*) = await this\.importModule\((url\d*(?:\.href)?)\);/g,
			'const $1 = await this.importModule($2); __alphaStage("native import complete", $2);',
		)
		inject(
			"await this.ensureCacheDirectory();",
			'__alphaStage("ensure cache begin"); await this.ensureCacheDirectory(); __alphaStage("ensure cache complete");',
		)
		inject(
			"await this.pruneDiskCache(stagingDirectory);",
			'__alphaStage("prune begin", stagingDirectory); await this.pruneDiskCache(stagingDirectory); __alphaStage("prune complete", stagingDirectory);',
		)
		inject(
			"await assertSourceCurrent();",
			'__alphaStage("source check begin", absolutePath); await assertSourceCurrent(); __alphaStage("source check complete", absolutePath);',
		)
		replace(
			/const bundle = await (fs\d*)\.promises\.readFile\(tempFile\);/,
			'__alphaStage("bundle read begin", tempFile); const bundle = await $1.promises.readFile(tempFile); __alphaStage("bundle read complete", tempFile);',
		)
		inject(
			"const envFiles = await this.readEnvFiles(toolDir);",
			'__alphaStage("env read begin", toolDir); const envFiles = await this.readEnvFiles(toolDir); __alphaStage("env read complete", toolDir);',
		)
		inject(
			"const retained = retainedCacheDirectories.has(toolCacheDir);",
			'__alphaStage("generation IO begin", toolCacheDir); const retained = retainedCacheDirectories.has(toolCacheDir);',
		)
		inject(
			"retainedCacheDirectories.add(toolCacheDir);",
			'__alphaStage("generation IO complete", toolCacheDir); retainedCacheDirectories.add(toolCacheDir);',
		)
		replace(
			/await (fs\d*)\.promises\.rm\(stagingDirectory, \{ recursive: true, force: true \}\);/,
			'__alphaStage("stage cleanup begin", stagingDirectory); await $1.promises.rm(stagingDirectory, { recursive: true, force: true }); __alphaStage("stage cleanup complete", stagingDirectory);',
		)
		inject(
			"const mod = await this.import(filePath, entry.fingerprint, force);",
			'__alphaStage("file import begin", filePath); const mod = await this.import(filePath, entry.fingerprint, force); __alphaStage("file import complete", filePath);',
		)
		// A timed-out child may still own its bundle while the next scenario starts.
		this.bundle = path.join(path.dirname(bundle), `registry.trace.${path.basename(this.directory)}.mjs`)
		await fs.promises.writeFile(this.bundle, source)
		this.stage("parent instrumented bundle", this.bundle)
	}
}

export function createRegistryProcessTrace(name: string): RegistryProcessTrace | undefined {
	const mode = process.env.ALPHA_TRACE_CUSTOM_TOOLS
	if (mode !== "1" && mode !== "owner-only") return undefined
	const root = process.env.ALPHA_CUSTOM_TOOL_TRACE_DIR
	assert.ok(root, "ALPHA_CUSTOM_TOOL_TRACE_DIR is required for registry process diagnostics")
	return new RegistryProcessTrace(path.join(path.resolve(root), name), mode === "owner-only")
}
