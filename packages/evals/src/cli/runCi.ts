import pMap from "p-map"

import { EVALS_REPO_PATH, exerciseLanguages, getExercisesForLanguage } from "../exercises/index"
import { createRun, createTask } from "../db/index"
import { assertRunAcceptance } from "../lifecycle/index"
import { findBenchmarkTask, loadPrivateGraderBundle } from "../benchmark/loader"

import { runEvals } from "./runEvals"

export const runCi = async ({
	concurrency = 1,
	exercisesPerLanguage,
}: {
	concurrency?: number
	exercisesPerLanguage?: number
} = {}) => {
	console.log("Running evals in CI mode.")

	const model = process.env.EVALS_MODEL_ID?.trim()
	if (!model) throw new Error("EVALS_MODEL_ID is required for CI evaluation")
	const selected: Array<{ language: (typeof exerciseLanguages)[number]; exercise: string }> = []
	for (const language of exerciseLanguages) {
		let exercises = (await getExercisesForLanguage(EVALS_REPO_PATH, language)).sort()
		if (exercisesPerLanguage) exercises = exercises.slice(0, exercisesPerLanguage)
		for (const exercise of exercises) selected.push({ language, exercise })
	}
	if (!selected.length) throw new Error("CI evaluation requires at least one selected fixture")
	// A missing or stale private grader is an acquisition prerequisite, never a reason to pay for an agent retry.
	for (const { language, exercise } of selected) {
		const { task } = await findBenchmarkTask(EVALS_REPO_PATH, `${language}/${exercise}`)
		const bundle = await loadPrivateGraderBundle(task)
		await bundle?.dispose?.()
	}
	const run = await createRun({
		model,
		settings: {
			apiProvider: "openai",
			openAiModelId: model,
			openAiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
		},
		socketPath: "",
		concurrency,
	})

	await pMap(selected, ({ language, exercise }) => createTask({ runId: run.id, language, exercise }), { concurrency })

	const outcomes = await runEvals(run.id)
	assertRunAcceptance(outcomes, { minimumPassRate: 1 })
}
