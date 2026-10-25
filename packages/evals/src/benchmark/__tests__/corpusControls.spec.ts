import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { ExecaHarnessProcessRunner } from "../../orchestration/index"
import { corpusControls } from "../corpusControls"
import { loadBenchmarkCatalog } from "../loader"
import { runAuthoringCheck } from "../authoring"
import { certifyInitialFixtureStates } from "../fixtures"

const candidateRoot = path.resolve(process.cwd(), "../../evals/candidates")

describe("candidate corpus controls", () => {
	it("keeps candidates separate from released gates and measures actual source breadth", async () => {
		const report = await runAuthoringCheck({ publicRoot: candidateRoot })
		expect(report.valid).toBe(true)
		expect(report.similarity.duplicatePairs).toEqual([])
		expect(report.taskCount).toBe(5)
		expect(report.corpus.tasks.find(({ identity }) => identity === "python-inventory-report@1")).toMatchObject({
			sourceFiles: 4,
			languages: ["python"],
		})
		const candidate = await loadBenchmarkCatalog(candidateRoot)
		expect(
			await certifyInitialFixtureStates({ catalog: candidate, publicRoot: candidateRoot, concurrency: 1 }),
		).toMatchObject({ valid: true, tasks: 5 })
		expect(candidate.suites.every(({ status }) => status === "calibrating")).toBe(true)
		expect([...candidate.tasks.values()].every(({ task }) => task.admission === "calibrating")).toBe(true)
		const active = await runAuthoringCheck({ publicRoot: path.resolve(candidateRoot, "..") })
		expect(active.similarity.historicalDuplicatePairs).toHaveLength(28)
		expect(active.corpus.problemSolving).toMatchObject({
			planned: 64,
			localLiveExecutable: 32,
			localLiveLanguages: ["javascript"],
			executed: null,
		})
		expect(
			active.corpus.tasks.find(({ identity }) => identity.startsWith("alpha-context-continuity@")),
		).toMatchObject({ sourceFiles: 1 })
	})

	for (const control of corpusControls) {
		it(`rejects untouched and three incomplete ${control.id} solutions while accepting alternatives`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-corpus-controls-"))
			const runner = new ExecaHarnessProcessRunner()
			try {
				const variants = [
					{ id: "untouched", patch: {}, passes: false, repetitions: 1 },
					{ id: "reference", patch: control.reference, passes: true, repetitions: 20 },
					{ id: "alternative", patch: control.alternative, passes: true, repetitions: 2 },
					...control.mutants.map(({ id, patch }) => ({ id, patch, passes: false, repetitions: 1 })),
				]
				for (const variant of variants) {
					const workspace = path.join(root, variant.id)
					await fs.cp(path.join(candidateRoot, control.fixture), workspace, { recursive: true })
					for (const [file, contents] of Object.entries(variant.patch))
						await fs.writeFile(path.join(workspace, file), contents)
					for (let repetition = 0; repetition < variant.repetitions; repetition++) {
						const result = await runner.run({
							command: control.command,
							args: control.args,
							cwd: workspace,
							timeoutMs: 15_000,
							maxOutputBytes: 64_000,
						})
						expect(result.timedOut, `${control.id}/${variant.id}`).toBe(false)
						expect(result.exitCode, `${control.id}/${variant.id}: ${result.stdout}\n${result.stderr}`).toBe(
							variant.passes ? 0 : 1,
						)
						if (!variant.passes) {
							const output = result.stdout + result.stderr
							expect(output).not.toMatch(/SyntaxError|ModuleNotFoundError|ERR_MODULE_NOT_FOUND/)
							expect(output).toMatch(
								control.command === "python" ? /FAILED \(failures=/ : /(?:#|ℹ) fail [1-9]/,
							)
						}
					}
				}
			} finally {
				await fs.rm(root, { recursive: true, force: true })
			}
		}, 120_000)
	}
})
