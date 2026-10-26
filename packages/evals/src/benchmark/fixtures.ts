import path from "node:path"

import pMap from "p-map"

import { ExecaHarnessProcessRunner, type HarnessProcessRunner } from "../orchestration/index"
import {
	captureExpectedNodeTestCommands,
	hasNodeTestAssertionFailure,
	inspectNodeTestCompletion,
	nodeTestCompletionCommand,
} from "../grading/nodeTestCompletion"
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
		.filter(({ partition }) => partition !== "holdout")
	const results = await pMap(
		tasks,
		async (task) => {
			const workspace = path.join(options.publicRoot, task.fixture)
			const commands: Array<{
				command: string
				exitCode: number
				timedOut: boolean
				verification: "passed" | "failed" | "error"
			}> = []
			const prepared = await captureExpectedNodeTestCommands(workspace, task.validation.commands)
			for (const command of prepared) {
				const timeoutMs = task.budgets.wallSeconds * 1_000
				const execution = command.testExecution
					? nodeTestCompletionCommand(command, workspace, timeoutMs)
					: command
				const result = await runner.run({
					...execution,
					cwd: workspace,
					timeoutMs,
					maxOutputBytes: 1_048_576,
				})
				let verification: "passed" | "failed" | "error" = "error"
				if (!result.timedOut && result.exitCode !== null && !result.outputTruncated) {
					if (command.testExecution && result.exitCode === 0) {
						const output = result.fullStdout ?? result.stdout
						if (
							inspectNodeTestCompletion(output, command.testExecution.expectedTests, workspace) ===
							"passed"
						)
							verification = "passed"
						else if (hasNodeTestAssertionFailure(output, command.testExecution.expectedTests))
							verification = "failed"
					} else if (!command.testExecution) {
						if (result.exitCode === 0) verification = "passed"
						// The Python candidate uses unittest's assertion-only failure summary. Import/runtime errors
						// report errors separately and cannot certify the intended initial assertion failure.
						else if (
							result.exitCode === 1 &&
							["python", "python3"].includes(command.command) &&
							command.args.some((arg, index) => arg === "-m" && command.args[index + 1] === "unittest") &&
							/(?:^|\r?\n)FAILED \(failures=[1-9]\d*\)\s*$/.test(result.fullStderr ?? result.stderr)
						)
							verification = "failed"
					}
				}
				commands.push({
					command: [command.command, ...command.args].join(" "),
					exitCode: result.exitCode ?? -1,
					timedOut: result.timedOut,
					verification,
				})
				if (verification !== "passed") break
			}
			const passed =
				commands.length === task.validation.commands.length &&
				commands.every(({ verification }) => verification === "passed")
			return {
				taskId: task.id,
				restraint: task.restraint,
				declaredStateValid: task.restraint ? passed : commands.at(-1)?.verification === "failed",
				commands,
			}
		},
		{ concurrency: options.concurrency ?? 4 },
	)
	return { valid: results.every(({ declaredStateValid }) => declaredStateValid), tasks: results.length, results }
}
