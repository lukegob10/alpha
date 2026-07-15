import { evidenceFromText } from "../evidence"
import type { DiffPolicyGraderSpec, GraderContext, GraderPlugin, GraderResult } from "../types"

export class DiffPolicyGrader implements GraderPlugin<DiffPolicyGraderSpec> {
	readonly type = "diff-policy" as const

	async execute(
		spec: DiffPolicyGraderSpec,
		context: GraderContext,
	): Promise<Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs">> {
		const diagnostics: GraderResult["diagnostics"] = []
		for (const changedPath of context.changedPaths) {
			if (spec.forbidden?.some((pattern) => matchesGlob(changedPath, pattern))) {
				diagnostics.push({
					code: "forbidden_path_changed",
					message: `Forbidden path changed: ${changedPath}`,
					path: changedPath,
					severity: "error",
				})
			}
			if (spec.allowed && !spec.allowed.some((pattern) => matchesGlob(changedPath, pattern))) {
				diagnostics.push({
					code: "path_outside_allowlist",
					message: `Changed path is outside the allowlist: ${changedPath}`,
					path: changedPath,
					severity: "error",
				})
			}
		}
		if (spec.maxChangedFiles !== undefined && context.changedPaths.length > spec.maxChangedFiles) {
			diagnostics.push({
				code: "changed_file_limit_exceeded",
				message: `Changed ${context.changedPaths.length} files; limit is ${spec.maxChangedFiles}`,
				severity: "error",
			})
		}
		return {
			graderId: spec.id,
			graderVersion: spec.version,
			type: spec.type,
			status: diagnostics.length === 0 ? "passed" : "failed",
			hardGate: spec.hardGate,
			failureClass: spec.failureClass,
			diagnostics,
			evidence: [evidenceFromText(`${spec.id}:paths`, "diff", context.changedPaths.join("\n"))],
		}
	}
}

export function matchesGlob(value: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
	const regex = escaped.replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("\u0000", ".*")
	return new RegExp(`^${regex}$`).test(value.replaceAll("\\", "/"))
}
