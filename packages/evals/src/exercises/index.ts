import * as path from "path"
import * as fs from "fs/promises"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const EVALS_REPO_PATH = path.resolve(
	process.env.ALPHA_EVALS_REPO_PATH ?? path.join(__dirname, "..", "..", "..", "..", "evals"),
)

export function getTaskWorkspacePath(task: {
	language: string
	exercise: string
	benchmarkPartition?: string | null
}): string {
	if (process.env.EVALS_TASK_WORKSPACE_ROOT) return path.resolve(process.env.EVALS_TASK_WORKSPACE_ROOT)
	if (task.benchmarkPartition === "holdout") {
		const privateRoot = process.env.EVALS_PRIVATE_BENCHMARK_ROOT
		if (!privateRoot) throw new Error("EVALS_PRIVATE_BENCHMARK_ROOT is required for holdout tasks")
		return path.resolve(privateRoot, "tasks", task.exercise, "workspace")
	}
	return path.resolve(EVALS_REPO_PATH, task.language, task.exercise)
}

export const exerciseLanguages = ["go", "java", "javascript", "python", "rust"] as const

export type ExerciseLanguage = (typeof exerciseLanguages)[number]

export const listDirectories = async (basePath: string, relativePath: string) => {
	try {
		const targetPath = path.resolve(basePath, relativePath)
		const entries = await fs.readdir(targetPath, { withFileTypes: true })
		return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name)
	} catch (error) {
		console.error(`Error listing directories at ${relativePath}:`, error)
		return []
	}
}

export const getExercisesForLanguage = async (basePath: string, language: ExerciseLanguage) =>
	listDirectories(__dirname, path.join(basePath, language))
