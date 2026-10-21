/* Read-only audit probe: transpile the real tracker with narrow host/storage adapters. */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const root = path.resolve(__dirname, "../..")
const primaryWorkspace = path.join(root, ".review-primary-workspace")
const childWorkspace = path.join(root, ".review-child-workspace")
const watchers = []
const vscode = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: primaryWorkspace } }],
		createFileSystemWatcher(pattern) {
			const watcher = {
				pattern,
				disposed: false,
				onDidChange(callback) {
					this.change = callback
				},
				dispose() {
					this.disposed = true
				},
			}
			watchers.push(watcher)
			return watcher
		},
	},
	Uri: { file: (fsPath) => ({ fsPath }) },
	RelativePattern: class {
		constructor(base, pattern) {
			this.base = base
			this.pattern = pattern
		}
	},
}

const source = fs.readFileSync(path.join(root, "src/core/context-tracking/FileContextTracker.ts"), "utf8")
const compiled = ts.transpileModule(source, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const moduleRecord = { exports: {} }
new Function("require", "exports", "module", compiled)(
	(id) => {
		if (id === "vscode") return vscode
		if (id === "path" || id === "fs/promises") return require(id)
		if (id === "../../utils/safeWriteJson") return { safeWriteJson: async () => {} }
		if (id === "../../utils/storage") return { getTaskDirectoryPath: async () => "/unused" }
		if (id === "../../utils/fs") return { fileExistsAtPath: async () => false }
		if (id === "../../shared/globalFileNames") return { GlobalFileNames: { taskMetadata: "task_metadata.json" } }
		throw new Error(`Unexpected runtime dependency ${id}`)
	},
	moduleRecord.exports,
	moduleRecord,
)
const { FileContextTracker } = moduleRecord.exports

function createTracker() {
	const tracker = new FileContextTracker({}, "review-task")
	let metadata = { files_in_context: [] }
	let bytesWritten = 0
	tracker.getTaskMetadata = async () => structuredClone(metadata)
	tracker.saveTaskMetadata = async (_id, value) => {
		metadata = structuredClone(value)
		bytesWritten += Buffer.byteLength(JSON.stringify(metadata))
	}
	return { tracker, metadata: () => metadata, bytesWritten: () => bytesWritten }
}

async function main() {
	// WriteToFileTool saves first and then calls trackFileContext("roo_edited").
	// This first tracked write creates a watcher only after setting its suppression marker.
	const firstWrite = createTracker()
	await firstWrite.tracker.trackFileContext("src/new.ts", "roo_edited")
	watchers.at(-1).change()
	assert.deepEqual(firstWrite.tracker.captureRecentlyModifiedFiles().files, [])
	console.log(JSON.stringify({ case: "first-human-change-after-first-write", pendingFiles: [] }))
	firstWrite.tracker.dispose()

	const independentRoot = createTracker()
	await independentRoot.tracker.trackFileContext("src/worker.ts", "read_tool")
	const actualRoot = watchers.at(-1).pattern.base
	assert.equal(actualRoot, path.join(primaryWorkspace, "src"))
	assert.notEqual(actualRoot, path.join(childWorkspace, "src"))
	console.log(
		JSON.stringify({ case: "child-workspace-watcher", actualRoot, intendedRoot: path.join(childWorkspace, "src") }),
	)
	independentRoot.tracker.dispose()

	const disposed = createTracker()
	let releaseSave
	let saveStarted
	const saveGate = new Promise((resolve) => {
		releaseSave = resolve
	})
	const enteredSave = new Promise((resolve) => {
		saveStarted = resolve
	})
	disposed.tracker.saveTaskMetadata = async () => {
		saveStarted()
		await saveGate
	}
	const pendingTrack = disposed.tracker.trackFileContext("src/late.ts", "read_tool")
	await enteredSave
	disposed.tracker.dispose()
	const previousWatchers = watchers.length
	releaseSave()
	await pendingTrack
	assert.equal(watchers.length, previousWatchers + 1)
	assert.equal(watchers.at(-1).disposed, false)
	console.log(JSON.stringify({ case: "watcher-after-dispose", leakedWatchers: 1 }))
	disposed.tracker.dispose()

	for (const operations of [64, 128]) {
		const growth = createTracker()
		for (let index = 0; index < operations; index++) {
			await growth.tracker.addFileToFileContextTracker("review-task", "src/repeated.ts", "read_tool")
		}
		const entries = growth.metadata().files_in_context
		assert.equal(entries.length, operations)
		assert.equal(entries.filter((entry) => entry.record_state === "active").length, 1)
		console.log(
			JSON.stringify({
				case: "repeated-single-file-read",
				operations,
				rows: entries.length,
				cumulativeSerializedBytes: growth.bytesWritten(),
			}),
		)
		growth.tracker.dispose()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
