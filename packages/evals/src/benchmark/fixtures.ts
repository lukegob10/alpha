import path from "node:path"

import pMap from "p-map"

import { ExecaHarnessProcessRunner, type HarnessProcessRunner } from "../orchestration/index"
import type { BenchmarkCatalog } from "./contracts"

export async function certifyInitialFixtureStates(options: {
	catalog: BenchmarkCatalog
	publicRoot: string
	processRunner?: HarnessProcessRunner
	concurrency?: number
}) {
	const runner = options.processRunner ?? new ExecaHarnessProcessRunner()
	const tasks = [...options.catalog.tasks.values()]
		.map(({ task }) => task)
		.filter(({ partition }) => partition === "development" || partition === "regression")
	const results = await pMap(
		tasks,
		async (task) => {
			const workspace = path.join(options.publicRoot, task.fixture)
			const commands: Array<{ command: string; exitCode: number; timedOut: boolean }> = []
			for (const command of task.validation.commands) {
				const result = await runner.run({
					...command,
					cwd: workspace,
					timeoutMs: task.budgets.wallSeconds * 1_000,
					maxOutputBytes: 1_048_576,
				})
				commands.push({
					command: [command.command, ...command.args].join(" "),
					exitCode: result.exitCode ?? -1,
					timedOut: result.timedOut,
				})
				if (result.exitCode !== 0 || result.timedOut) break
			}
			const passed =
				commands.length === task.validation.commands.length &&
				commands.every(({ exitCode, timedOut }) => exitCode === 0 && !timedOut)
			return {
				taskId: task.id,
				restraint: task.restraint,
				declaredStateValid: task.restraint ? passed : !passed,
				commands,
			}
		},
		{ concurrency: options.concurrency ?? 4 },
	)
	return { valid: results.every(({ declaredStateValid }) => declaredStateValid), tasks: results.length, results }
}
