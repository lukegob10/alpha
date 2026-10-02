import { writeFile } from "node:fs/promises"
import path from "node:path"
import { repositoryTestPath, validateTestEvidence } from "./execution-evidence.mjs"

const projectCounts = (value) => ({
	total: value.tests,
	passed: value.passed,
	failed: value.failed,
	skipped: value.skipped,
	todo: value.todo,
	cancelled: value.cancelled,
})

/** Consume Node's structured events, never parse the version-dependent console reporter or copy test output. */
export default async function* reporter(events) {
	const destination = process.env.ALPHA_HARNESS_EVIDENCE_FILE
	const root = process.env.ALPHA_HARNESS_REPOSITORY_ROOT
	const files = []
	let summary
	for await (const event of events) {
		if (!destination || event.type !== "test:summary") continue
		if (event.data.file)
			files.push({ path: repositoryTestPath(root, event.data.file), counts: projectCounts(event.data.counts) })
		else {
			if (summary) throw new Error("Duplicate cumulative test summary")
			summary = event.data
		}
	}
	if (!destination) return
	if (!root || !path.isAbsolute(destination) || !summary) throw new Error("Missing test execution receipt boundary")
	const receipt = validateTestEvidence({
		schemaVersion: 1,
		kind: "alpha-test-execution",
		runner: "node",
		complete: true,
		success: summary.success,
		counts: projectCounts(summary.counts),
		files,
	})
	await writeFile(destination, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 })
}
