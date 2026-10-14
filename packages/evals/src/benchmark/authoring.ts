import fs from "node:fs/promises"
import path from "node:path"

import { parse } from "yaml"

import { privateAuthoringFingerprintsSchema, type PrivateAuthoringFingerprints } from "./contracts"
import { loadBenchmarkCatalog } from "./loader"
import { analyzeBenchmarkSimilarity } from "./similarity"

export type AuthoringIssue = { code: string; message: string; tasks?: string[] }

export async function runAuthoringCheck(options: {
	publicRoot: string
	privateFingerprintsFile?: string
	outputRoot?: string
}): Promise<{
	valid: boolean
	taskCount: number
	issues: AuthoringIssue[]
	similarity: Awaited<ReturnType<typeof analyzeBenchmarkSimilarity>>
	jsonPath?: string
	markdownPath?: string
}> {
	const catalog = await loadBenchmarkCatalog(options.publicRoot)
	const privateFingerprints = options.privateFingerprintsFile
		? privateAuthoringFingerprintsSchema.parse(
				parseOrJson(await fs.readFile(options.privateFingerprintsFile, "utf8")),
			)
		: undefined
	const similarity = await analyzeBenchmarkSimilarity(catalog, options.publicRoot, privateFingerprints)
	const publicIdentities = new Set(catalog.tasks.keys())
	const issues: AuthoringIssue[] = [
		...(privateFingerprints?.tasks ?? [])
			.filter(({ taskIdentity }) => !publicIdentities.has(taskIdentity))
			.map(({ taskIdentity }) => ({
				code: "unknown_private_fingerprint_identity",
				message: `Private fingerprint does not match a public task: ${taskIdentity}`,
				tasks: [taskIdentity],
			})),
		...similarity.duplicatePairs.map((pair) => ({
			code: "public_task_duplicate",
			message: `${pair.left} and ${pair.right} have materially duplicated prompts/source/tests`,
			tasks: [pair.left, pair.right],
		})),
		...similarity.privateDuplicatePairs.map((tasks) => ({
			code: "private_fingerprint_duplicate",
			message: `Opaque private gold/grader fingerprints are duplicated across ${tasks.join(", ")}`,
			tasks,
		})),
	]
	const report = { valid: issues.length === 0, taskCount: catalog.tasks.size, issues, similarity }
	if (!options.outputRoot) return report
	await fs.mkdir(options.outputRoot, { recursive: true })
	const jsonPath = path.join(options.outputRoot, "benchmark-authoring.json")
	const markdownPath = path.join(options.outputRoot, "benchmark-authoring.md")
	await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n")
	await fs.writeFile(markdownPath, renderAuthoringSummary(report))
	return { ...report, jsonPath, markdownPath }
}

function parseOrJson(value: string): unknown {
	try {
		return JSON.parse(value)
	} catch {
		return parse(value)
	}
}

function renderAuthoringSummary(report: {
	valid: boolean
	taskCount: number
	issues: AuthoringIssue[]
	similarity: Awaited<ReturnType<typeof analyzeBenchmarkSimilarity>>
}): string {
	const lines = [
		"# Benchmark Authoring Report",
		"",
		`- Contract-valid tasks: ${report.taskCount}`,
		`- Admission-ready: ${report.valid ? "yes" : "no"}`,
		`- Public duplicate pairs: ${report.similarity.duplicatePairs.length}`,
		`- Private fingerprint duplicate groups: ${report.similarity.privateDuplicatePairs.length}`,
		"",
		"## Issues",
		"",
	]
	if (!report.issues.length) lines.push("No authoring issues detected.")
	else for (const issue of report.issues) lines.push(`- **${issue.code}:** ${issue.message}`)
	return lines.join("\n") + "\n"
}

export async function loadPrivateAuthoringFingerprints(file: string): Promise<PrivateAuthoringFingerprints> {
	return privateAuthoringFingerprintsSchema.parse(parseOrJson(await fs.readFile(file, "utf8")))
}
