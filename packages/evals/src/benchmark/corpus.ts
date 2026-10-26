import fs from "node:fs/promises"
import path from "node:path"

import type { BenchmarkCatalog } from "./contracts"
import { loadProblemSolvingSet, selectLiveMeasurementTasks } from "./problemSolving"

const sourceLanguages: Record<string, string> = {
	".js": "javascript",
	".cjs": "javascript",
	".mjs": "javascript",
	".ts": "typescript",
	".tsx": "typescript",
	".jsx": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".cs": "csharp",
	".c": "c",
	".cpp": "cpp",
}

export function benchmarkSourceLanguage(file: string): string | undefined {
	return sourceLanguages[path.extname(file)]
}

/** Counts describe fixture contents, not files changed or runtime transitions exercised by a model. */
export async function measureBenchmarkCorpus(catalog: BenchmarkCatalog, root: string) {
	const tasks: Array<{
		identity: string
		suite: string
		available: boolean
		sourceFiles: number | null
		sourceBytes: number | null
		languages: string[]
	}> = []
	const metadataWarnings: Array<{ identity: string; code: string }> = []
	for (const { task, suite } of catalog.tasks.values()) {
		const identity = `${task.id}@${task.version}`
		if (task.partition === "holdout") {
			tasks.push({
				identity,
				suite: `${suite.id}@${suite.version}`,
				available: false,
				sourceFiles: null,
				sourceBytes: null,
				languages: [],
			})
			continue
		}
		const files = await sourceFiles(path.resolve(root, task.fixture))
		const languages = [...new Set(files.map(({ file }) => benchmarkSourceLanguage(file)!))].sort()
		if (task.editTopology.kind !== "single-file" && files.length < 2) {
			metadataWarnings.push({ identity, code: "declared-multifile-topology-has-one-source-file" })
		}
		tasks.push({
			identity,
			suite: `${suite.id}@${suite.version}`,
			available: true,
			sourceFiles: files.length,
			sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0),
			languages,
		})
	}
	let hasProblemSolving = false
	try {
		await fs.access(path.join(root, "problem-solving", "v1.yaml"))
		hasProblemSolving = true
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
	}
	let problemSolving = null
	if (hasProblemSolving) {
		const manifest = await loadProblemSolvingSet(root)
		const executable = selectLiveMeasurementTasks(manifest.tasks)
		const localLiveLanguages = new Set<string>()
		for (const task of executable) {
			const observed = tasks.find(({ identity }) => identity === `${task.id}@${task.version}`)
			if (observed) for (const language of observed.languages) localLiveLanguages.add(language)
			else if (task.fixture) {
				for (const { file } of await sourceFiles(path.resolve(root, task.fixture))) {
					localLiveLanguages.add(benchmarkSourceLanguage(file)!)
				}
			}
		}
		problemSolving = {
			planned: manifest.tasks.length,
			localLiveExecutable: executable.length,
			excluded: {
				unique: manifest.tasks.length - executable.length,
				terminalBench: manifest.tasks.filter(({ source }) => source === "terminal-bench").length,
				holdout: manifest.tasks.filter(({ lane }) => lane === "holdout").length,
			},
			executed: null,
			executionEvidence: "unavailable-authoring-does-not-consume-run-receipts",
			localLiveLanguages: [...localLiveLanguages].sort(),
		}
	}
	return {
		declared: catalog.tasks.size,
		publicFixturesMeasured: tasks.filter(({ available }) => available).length,
		tasks,
		metadataWarnings,
		problemSolving,
	}
}

async function sourceFiles(root: string): Promise<Array<{ file: string; bytes: number }>> {
	const output: Array<{ file: string; bytes: number }> = []
	async function visit(directory: string): Promise<void> {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (
				[
					"node_modules",
					".git",
					"dist",
					"build",
					"__pycache__",
					".venv",
					"test",
					"tests",
					"__tests__",
				].includes(entry.name)
			)
				continue
			const file = path.join(directory, entry.name)
			if (entry.isDirectory()) await visit(file)
			else if (entry.isFile() && benchmarkSourceLanguage(entry.name)) {
				output.push({ file: path.relative(root, file), bytes: (await fs.stat(file)).size })
			}
		}
	}
	await visit(root)
	return output
}
