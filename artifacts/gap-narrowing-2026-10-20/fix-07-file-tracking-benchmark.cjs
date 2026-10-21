/* Deterministic serialization-work probe using the real tracker and in-memory host/storage adapters. */
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const root = path.resolve(__dirname, "../..")
const cwd = path.join(root, ".tracker-benchmark-worktree")
const source = fs.readFileSync(path.join(root, "src/core/context-tracking/FileContextTracker.ts"), "utf8")
const compiled = ts.transpileModule(source, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText
const moduleRecord = { exports: {} }
new Function("require", "exports", "module", compiled)(
	(id) => {
		if (id === "path" || id === "fs/promises") return require(id)
		if (id === "vscode") return {}
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

async function measure(operations) {
	const tracker = new FileContextTracker({}, "benchmark-task", cwd)
	let persisted = { files_in_context: [] }
	let rowsRead = 0
	let rowsWritten = 0
	let cumulativeSerializedBytes = 0
	tracker.getTaskMetadata = async () => {
		rowsRead += persisted.files_in_context.length
		return structuredClone(persisted)
	}
	tracker.saveTaskMetadata = async (_taskId, metadata) => {
		persisted = structuredClone(metadata)
		rowsWritten += persisted.files_in_context.length
		cumulativeSerializedBytes += Buffer.byteLength(JSON.stringify(persisted))
	}
	for (let index = 0; index < operations; index++) {
		await tracker.addFileToFileContextTracker("benchmark-task", "src/repeated.ts", "read_tool")
	}
	tracker.dispose()
	return {
		operations,
		rowsRead,
		rowsWritten,
		finalRows: persisted.files_in_context.length,
		finalSerializedBytes: Buffer.byteLength(JSON.stringify(persisted)),
		cumulativeSerializedBytes,
	}
}

async function main() {
	const originalNow = Date.now
	Date.now = () => 1_700_000_000_000
	try {
		for (const operations of [64, 128]) console.log(JSON.stringify(await measure(operations)))
	} finally {
		Date.now = originalNow
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
