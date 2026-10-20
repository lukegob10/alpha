import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import ts from "typescript"

// Run: node scripts/benchmarks/task-history.mjs [baseline-ref]
// Measures in-memory history queries and storage-resolution counts, not extension-host or disk latency.
const root = fileURLToPath(new URL("../..", import.meta.url))
const sourcePath = "src/core/task-persistence/TaskHistoryStore.ts"
const baselineRef = process.argv[2] ?? "e3595d3da3966f8e137a1424f79880d9862c14ae"
const baselineCommit = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${baselineRef}^{commit}`], {
	cwd: root,
	encoding: "utf8",
}).trim()
assert.match(baselineCommit, /^[a-f0-9]{40,64}$/)
const sources = {
	baseline: execFileSync("git", ["show", `${baselineCommit}:${sourcePath}`], { cwd: root, encoding: "utf8" }),
	current: readFileSync(path.join(root, sourcePath), "utf8"),
}
const storage = path.join(root, ".history-benchmark")
const items = Array.from({ length: 10_000 }, (_, index) => ({
	id: `task-${index}`,
	number: index,
	ts: (index * 7919) % 10_000,
	task: `Task ${index}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	workspace: path.join(root, `workspace-${index % 100}`),
}))
const files = new Map(
	items.map((item) => [path.join(storage, "tasks", item.id, "history_item.json"), JSON.stringify(item)]),
)
const fixtureTaskIds = new Set(items.map((item) => item.id))
const workspace = path.join(root, "workspace-1")
const expectedIds = items
	.filter((item) => item.workspace === workspace)
	.sort((a, b) => b.ts - a.ts)
	.map((item) => item.id)
const variants = []
for (const [name, source] of Object.entries(sources)) {
	let storageResolutions = 0
	const dependencies = {
		"fs/promises": {
			readdir: async () => items.map((item) => item.id),
			readFile: async (file) => {
				assert.ok(files.has(file), `Unexpected virtual history file: ${file}`)
				return files.get(file)
			},
		},
		fs: {},
		path,
		"@alpha-code/types": {},
		"fast-deep-equal": { default: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
		"../../shared/globalFileNames": {
			GlobalFileNames: { historyItem: "history_item.json", historyIndex: "_index.json" },
		},
		"../../utils/safeWriteJson": { safeWriteJson: async () => undefined },
		"./atomicWrite": {
			withFileLock: () => assert.fail("Read-only history queries must not acquire a file lock"),
		},
		"../../utils/storage": {
			getStorageBasePath: async () => {
				storageResolutions++
				return storage
			},
			resolveTaskDirectoryPath: (basePath, taskId) => {
				assert.equal(basePath, storage, "Unexpected virtual storage root")
				assert.ok(fixtureTaskIds.has(taskId), `Unexpected virtual task id: ${taskId}`)
				return path.join(basePath, "tasks", taskId)
			},
		},
	}
	const code = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText
	const module = { exports: {} }
	new vm.Script(code, { filename: sourcePath }).runInNewContext({
		module,
		exports: module.exports,
		require: (id) => {
			assert.ok(Object.hasOwn(dependencies, id), `Unexpected import: ${id}`)
			return dependencies[id]
		},
		process: { platform: process.platform },
		console,
		setTimeout: () => 1,
		clearTimeout: () => undefined,
	})
	const store = new module.exports.TaskHistoryStore(storage)
	await store.reconcile()
	assert.equal(JSON.stringify(store.getByWorkspace(workspace).map((item) => item.id)), JSON.stringify(expectedIds))
	variants.push({ name, store, storageResolutions, samples: [] })
}

const warmup = 20
const samples = 7
const queriesPerSample = 100
for (const variant of variants) {
	for (let index = 0; index < warmup; index++) variant.store.getByWorkspace(workspace)
}
for (let sample = 0; sample < samples; sample++) {
	for (const variant of sample % 2 === 0 ? variants : [...variants].reverse()) {
		const start = performance.now()
		for (let index = 0; index < queriesPerSample; index++) variant.store.getByWorkspace(workspace)
		variant.samples.push((performance.now() - start) / queriesPerSample)
	}
}
for (const variant of variants) await variant.store.dispose()
console.log(
	JSON.stringify(
		{
			benchmark: "task-history",
			node: process.version,
			platform: process.platform,
			baselineCommit,
			historyEntries: items.length,
			workspaces: 100,
			selectedWorkspaceEntries: expectedIds.length,
			warmup,
			samples,
			queriesPerSample,
			conditions:
				"virtual filesystem/storage; no provider; warm in-memory cache; alternating variant order; no disk timing",
			variants: variants.map((variant) => ({
				name: variant.name,
				reconciliationStorageResolutions: variant.storageResolutions,
				customStorageValidationIoProxy: 2 * variant.storageResolutions,
				getByWorkspaceMedianMs: [...variant.samples].sort((a, b) => a - b)[Math.floor(samples / 2)],
				samplesMs: variant.samples,
			})),
		},
		null,
		2,
	),
)
