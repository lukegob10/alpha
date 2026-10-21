import assert from "node:assert/strict"
import * as fs from "node:fs/promises"

export interface RegistryStageSnapshot {
	pid: number
	total: number
	events: readonly unknown[]
}

/** Diagnostic-only instrumentation of the fresh test bundle; production source stays unchanged. */
export async function traceRegistryBundle(bundle: string): Promise<void> {
	let source = await fs.readFile(bundle, "utf8")
	const inject = (before: string, after: string) => {
		assert.ok(source.includes(before), `Registry trace target missing: ${before}`)
		source = source.replaceAll(before, after)
	}
	const replace = (expression: RegExp, replacement: string) => {
		assert.ok(expression.test(source), `Registry trace target missing: ${expression}`)
		source = source.replace(expression, replacement)
	}
	source =
		`const __alphaStages = new Array(512);
let __alphaStageCount = 0;
function __alphaStage(stage, value) {
	__alphaStages[__alphaStageCount++ % __alphaStages.length] = [Date.now(), stage, value ?? ""];
}
function __alphaStageSnapshot() {
	const length = Math.min(__alphaStageCount, __alphaStages.length);
	const start = Math.max(0, __alphaStageCount - length);
	return { pid: process.pid, total: __alphaStageCount,
		events: Array.from({ length }, (_, index) => __alphaStages[(start + index) % __alphaStages.length]) };
}
export { __alphaStageSnapshot };
` + source
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
		'const child = execa(process.execPath, args, { env, stdin: "ignore" }); child.on("spawn", () => __alphaStage("child spawn", [child.pid, options.entryPoint])); child.on("exit", (code, signal) => __alphaStage("child exit", [child.pid, code, signal])); child.on("close", (code, signal) => __alphaStage("child close", [child.pid, code, signal])); await child; __alphaStage("compile complete", options.entryPoint);',
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
	await fs.writeFile(bundle, source)
}
