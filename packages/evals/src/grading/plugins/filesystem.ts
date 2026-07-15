import * as fs from "fs/promises"

import { resolveContained } from "../boundary"
import { evidenceFromText } from "../evidence"
import type { FilesystemGraderSpec, GraderContext, GraderPlugin, GraderResult } from "../types"

export class FilesystemGrader implements GraderPlugin<FilesystemGraderSpec> {
	readonly type = "filesystem" as const

	async execute(
		spec: FilesystemGraderSpec,
		context: GraderContext,
	): Promise<Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs">> {
		const diagnostics: GraderResult["diagnostics"] = []
		const evidence: GraderResult["evidence"] = []

		for (const assertion of spec.assertions) {
			const filePath = resolveContained(context.workspaceRoot, assertion.path)
			let contents: string | undefined
			try {
				contents = await fs.readFile(filePath, "utf8")
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}

			let passed = false
			switch (assertion.kind) {
				case "exists":
					passed = contents !== undefined
					break
				case "absent":
					passed = contents === undefined
					break
				case "content-equals":
					passed = contents === assertion.expected
					break
				case "content-matches":
					passed = contents !== undefined && new RegExp(assertion.pattern, assertion.flags).test(contents)
					break
			}
			if (contents !== undefined)
				evidence.push(evidenceFromText(`${spec.id}:${assertion.path}`, "file", contents))
			if (!passed) {
				diagnostics.push({
					code: `filesystem_${assertion.kind}_failed`,
					message: `Filesystem assertion failed: ${assertion.kind} ${assertion.path}`,
					path: assertion.path,
					severity: "error",
				})
			}
		}

		return result(spec, diagnostics.length === 0 ? "passed" : "failed", diagnostics, evidence)
	}
}

function result(
	spec: FilesystemGraderSpec,
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
