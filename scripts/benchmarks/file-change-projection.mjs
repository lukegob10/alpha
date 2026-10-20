import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import ts from "typescript"

// Run: node scripts/benchmarks/file-change-projection.mjs [baseline-ref]
// Counts actual projection work in isolated VMs, not browser or extension-host latency.
const root = fileURLToPath(new URL("../..", import.meta.url))
const sourcePath = "webview-ui/src/components/chat/utils/fileChangesFromMessages.ts"
const baselineRef = process.argv[2] ?? "HEAD"
const gitOptions = { cwd: root, encoding: "utf8", windowsHide: true }
const baselineCommit = execFileSync(
	"git",
	["rev-parse", "--verify", "--end-of-options", `${baselineRef}^{commit}`],
	gitOptions,
).trim()
assert.match(baselineCommit, /^[a-f0-9]{40,64}$/)
const sources = {
	baseline: execFileSync("git", ["show", `${baselineCommit}:${sourcePath}`], gitOptions),
	current: readFileSync(path.join(root, sourcePath), "utf8"),
}

function projection(source) {
	let candidateReads = 0
	const marker = "const candidates: FileChangeCandidate[] = []"
	assert.equal(source.split(marker).length, 2, "Candidate allocation changed; review benchmark instrumentation")
	const measuredSource = source.replace(
		marker,
		`const candidates: FileChangeCandidate[] = new Proxy([], {
			get(target, key, receiver) {
				if (typeof key === "string" && /^[0-9]+$/.test(key)) countRead()
				return Reflect.get(target, key, receiver)
			}
		})`,
	)
	const code = ts.transpileModule(measuredSource, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText
	const module = { exports: {} }
	new vm.Script(code, { filename: sourcePath }).runInNewContext({
		module,
		exports: module.exports,
		countRead: () => candidateReads++,
		require: (id) => {
			assert.equal(id, "@alpha/core", `Unexpected import: ${id}`)
			return {
				safeJsonParse: (text) => {
					try {
						return JSON.parse(text)
					} catch {
						return undefined
					}
				},
			}
		},
	})
	return (messages) => {
		candidateReads = 0
		const output = module.exports.fileChangesFromMessages(messages)
		return { candidateReads, output }
	}
}

const completed = Array.from({ length: 1_000 }, (_, index) => ({
	ts: index + 1,
	type: "say",
	say: "tool",
	partial: false,
	text: JSON.stringify({
		tool: "appliedDiff",
		path: `src/file-${index}.ts`,
		content: `-old-${index}\n+new-${index}`,
		changeStatus: "applied",
		commandExecutionId: `run-${index}`,
	}),
}))
const previews = completed.map((message) => ({ ...message, type: "ask", ask: "tool", isAnswered: true }))
const workloads = {
	completedOnly: completed,
	previewsBeforeCompletions: [...previews, ...completed],
	interleavedPreviews: completed.flatMap((message, index) => [previews[index], message]),
}
const variants = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, projection(source)]))
const results = Object.fromEntries(
	Object.entries(workloads).map(([name, messages]) => {
		const baseline = variants.baseline(messages)
		const current = variants.current(messages)
		assert.equal(JSON.stringify(current.output), JSON.stringify(baseline.output), `${name}: output changed`)
		return [
			name,
			{
				baselineReads: baseline.candidateReads,
				currentReads: current.candidateReads,
				outputEntries: current.output.length,
			},
		]
	}),
)
for (const name of ["completedOnly", "previewsBeforeCompletions"]) {
	assert.ok(
		results[name].currentReads <= 6_000,
		`${name}: repeated-work regression (${results[name].currentReads} reads)`,
	)
}
console.log(
	JSON.stringify(
		{
			benchmark: "file-change-projection",
			node: process.version,
			baselineCommit,
			sourcePath,
			sourceHashes: Object.fromEntries(
				Object.entries(sources).map(([name, source]) => [
					name,
					createHash("sha256").update(source).digest("hex"),
				]),
			),
			conditions:
				"1,000 edits; each workload once; candidate-index reads including output traversal; no provider, global spies, retained cache, or timing loops",
			results,
		},
		null,
		2,
	),
)
