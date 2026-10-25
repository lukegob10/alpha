import { evidenceFromText } from "../evidence"
import { resolveHiddenGraderBoundary } from "../boundary"
import { inspectNodeTestCompletion, nodeTestCompletionCommand } from "../nodeTestCompletion"
import type { CommandGraderSpec, GraderContext, GraderPlugin, GraderResult } from "../types"

export class CommandGrader implements GraderPlugin<CommandGraderSpec> {
	readonly type = "command" as const

	async execute(
		spec: CommandGraderSpec,
		context: GraderContext,
	): Promise<Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs">> {
		let cwd = context.workspaceRoot
		let workspaceRoot = context.workspaceRoot
		if (spec.cwd === "hidden") {
			if (!context.hiddenRoot) throw new Error(`Hidden root is required for grader ${spec.id}`)
			const roots = await resolveHiddenGraderBoundary({ workspaceRoot, hiddenRoot: context.hiddenRoot })
			cwd = roots.hiddenRoot
			workspaceRoot = roots.workspaceRoot
		}
		const diagnostics: GraderResult["diagnostics"] = []
		const evidence: GraderResult["evidence"] = []

		for (const [index, command] of spec.commands.entries()) {
			const execution = command.testExecution ? nodeTestCompletionCommand(command, cwd, spec.timeoutMs) : command
			const result = await context.processRunner.run({
				...execution,
				cwd,
				env: spec.cwd === "hidden" ? { EVAL_WORKSPACE_ROOT: workspaceRoot } : undefined,
				timeoutMs: spec.timeoutMs,
				maxOutputBytes: spec.maxOutputBytes,
			})
			evidence.push(
				await captureEvidence(
					context,
					`${spec.id}:${index}:stdout`,
					"stdout",
					result.fullStdout ?? result.stdout,
				),
			)
			evidence.push(
				await captureEvidence(
					context,
					`${spec.id}:${index}:stderr`,
					"stderr",
					result.fullStderr ?? result.stderr,
				),
			)
			if (result.timedOut || result.exitCode === null) {
				diagnostics.push({
					code: result.timedOut ? "command_timeout" : "command_incomplete",
					message: result.timedOut ? "Grader command timed out" : "Grader command ended without an exit code",
					severity: "error",
				})
				return baseResult(spec, "error", diagnostics, evidence)
			}
			if (result.exitCode !== 0) {
				diagnostics.push({
					code: command.testExecution ? "command_test_collector_error" : "command_exit_nonzero",
					message: `${command.command} exited with ${result.exitCode}`,
					severity: "error",
				})
				return baseResult(spec, command.testExecution ? "error" : "failed", diagnostics, evidence)
			}
			if (command.testExecution) {
				const completion = inspectNodeTestCompletion(
					result.fullStdout ?? result.stdout,
					command.testExecution.expectedTests,
					cwd,
				)
				if (completion !== "passed") {
					diagnostics.push({
						code:
							completion === "error" ? "command_test_collector_error" : "command_test_completion_missing",
						message:
							completion === "error"
								? "Test collector did not provide a complete execution receipt"
								: "Expected original test assertions did not complete successfully",
						severity: "error",
					})
					return baseResult(spec, completion, diagnostics, evidence)
				}
			}
		}

		return baseResult(spec, "passed", diagnostics, evidence)
	}
}

function captureEvidence(
	context: GraderContext,
	id: string,
	kind: GraderResult["evidence"][number]["kind"],
	value: string,
): Promise<GraderResult["evidence"][number]> {
	return context.evidenceSink
		? context.evidenceSink(id, kind, value, "text/plain; charset=utf-8")
		: Promise.resolve(evidenceFromText(id, kind, value))
}

function baseResult(
	spec: CommandGraderSpec,
	status: "passed" | "failed" | "error",
	diagnostics: GraderResult["diagnostics"],
	evidence: GraderResult["evidence"],
): Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs"> {
	return {
		graderId: spec.id,
		graderVersion: spec.version,
		type: spec.type,
		status,
		hardGate: spec.hardGate,
		failureClass: spec.failureClass,
		diagnostics,
		evidence,
	}
}
