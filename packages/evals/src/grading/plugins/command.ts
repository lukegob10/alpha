import { evidenceFromText } from "../evidence"
import { assertHiddenGraderBoundary } from "../boundary"
import type { CommandGraderSpec, GraderContext, GraderPlugin, GraderResult } from "../types"

export class CommandGrader implements GraderPlugin<CommandGraderSpec> {
	readonly type = "command" as const

	async execute(
		spec: CommandGraderSpec,
		context: GraderContext,
	): Promise<Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs">> {
		if (spec.cwd === "hidden") {
			if (!context.hiddenRoot) throw new Error(`Hidden root is required for grader ${spec.id}`)
			assertHiddenGraderBoundary({ workspaceRoot: context.workspaceRoot, hiddenRoot: context.hiddenRoot })
		}
		const cwd = spec.cwd === "hidden" ? context.hiddenRoot! : context.workspaceRoot
		const diagnostics: GraderResult["diagnostics"] = []
		const evidence: GraderResult["evidence"] = []

		for (const [index, command] of spec.commands.entries()) {
			const result = await context.processRunner.run({
				...command,
				cwd,
				env: spec.cwd === "hidden" ? { EVAL_WORKSPACE_ROOT: context.workspaceRoot } : undefined,
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
			if (result.timedOut) throw new Error(`Grader command timed out: ${command.command}`)
			if (result.exitCode !== 0) {
				diagnostics.push({
					code: "command_exit_nonzero",
					message: `${command.command} exited with ${result.exitCode}`,
					severity: "error",
				})
				return baseResult(spec, "failed", diagnostics, evidence)
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
	status: "passed" | "failed",
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
