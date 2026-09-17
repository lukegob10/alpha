import * as fs from "fs/promises"

import { resolveContained } from "../boundary"
import { evidenceFromText } from "../evidence"
import type { GraderContext, GraderPlugin, GraderResult, StaticAnalysisGraderSpec } from "../types"

export class StaticAnalysisGrader implements GraderPlugin<StaticAnalysisGraderSpec> {
	readonly type = "static-analysis" as const

	async execute(
		spec: StaticAnalysisGraderSpec,
		context: GraderContext,
	): Promise<Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs">> {
		const diagnostics: GraderResult["diagnostics"] = []
		const evidence: GraderResult["evidence"] = []
		const files = [...(spec.files ?? [])]
		if (spec.scanChangedFiles) {
			for (const changed of [...new Set(context.changedPaths)].sort()) {
				if (!spec.scanChangedFiles.extensions.some((extension) => changed.endsWith(extension))) continue
				try {
					await fs.access(resolveContained(context.workspaceRoot, changed))
					files.push({ path: changed, forbiddenPatterns: spec.scanChangedFiles.forbiddenPatterns })
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				}
			}
		}
		for (const file of files) {
			const contents = await fs.readFile(resolveContained(context.workspaceRoot, file.path), "utf8")
			evidence.push(evidenceFromText(`${spec.id}:${file.path}`, "file", contents))
			if (file.parseAs === "json") {
				try {
					JSON.parse(contents)
				} catch {
					diagnostics.push({
						code: "invalid_json",
						message: `Invalid JSON: ${file.path}`,
						path: file.path,
						severity: "error",
					})
				}
			}
			for (const pattern of file.requiredPatterns ?? []) {
				if (!new RegExp(pattern, "m").test(contents)) {
					diagnostics.push({
						code: "required_pattern_missing",
						message: `Required pattern missing in ${file.path}: ${pattern}`,
						path: file.path,
						severity: "error",
					})
				}
			}
			for (const pattern of file.forbiddenPatterns ?? []) {
				if (new RegExp(pattern, "m").test(contents)) {
					diagnostics.push({
						code: "forbidden_pattern_present",
						message: `Forbidden pattern present in ${file.path}: ${pattern}`,
						path: file.path,
						severity: "error",
					})
				}
			}
		}
		return {
			graderId: spec.id,
			graderVersion: spec.version,
			type: spec.type,
			status: diagnostics.length === 0 ? "passed" : "failed",
			hardGate: spec.hardGate,
			failureClass: spec.failureClass,
			diagnostics,
			evidence,
		}
	}
}
