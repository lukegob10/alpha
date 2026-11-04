import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { require as tsRequire } from "tsx/cjs/api"

const { readBounded, rejectSymlinkComponents } = tsRequire(
	"../../apps/vscode-e2e/src/evidence/paths.ts",
	import.meta.url,
)
export const codexReferenceSha = "5a7353f0401b970c44cf7d428ef23d74f3c366d5"
// Only this fixed-message boundary may supply user-visible failure context to the audit summary.
export class AuditEvidenceError extends Error {}
async function readEvidence(operation, reason) {
	try {
		return await operation()
	} catch {
		throw new AuditEvidenceError(reason)
	}
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 16_384
const texts = (value) => Array.isArray(value) && value.length <= 1000 && value.every(text)
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const prose = (value) => text(value) || texts(value)
const boundedData = (value, depth = 0) =>
	depth <= 8 &&
	(value === null ||
		typeof value === "boolean" ||
		text(value) ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(Array.isArray(value) && value.length <= 128 && value.every((entry) => boundedData(entry, depth + 1))) ||
		(object(value) &&
			Object.keys(value).length <= 128 &&
			Object.entries(value).every(([key, entry]) => text(key) && boundedData(entry, depth + 1))))

export function validateReviewReport(value, agent) {
	if (
		!object(value) ||
		value.agent !== agent ||
		!text(value.domain) ||
		!texts(value.coverage) ||
		!object(value.upstream) ||
		!text(value.upstream.sha) ||
		!texts(value.upstream.paths) ||
		!prose(value.upstream.alignment) ||
		!texts(value.upstream.divergences) ||
		!Array.isArray(value.findings) ||
		value.findings.length > 3 ||
		!object(value.validation) ||
		!texts(value.validation.ran) ||
		!texts(value.validation.recommended) ||
		!texts(value.scriptCoverage) ||
		!texts(value.limits) ||
		!["reviewed", "flagged", "not verified", "not present"].includes(value.closure)
	)
		throw new AuditEvidenceError(`Invalid review report ${agent}`)
	const ids = new Set()
	for (const finding of value.findings) {
		if (
			!object(finding) ||
			!text(finding.id) ||
			ids.has(finding.id) ||
			!["Critical", "High", "Medium", "Low"].includes(finding.severity) ||
			!["must-fix", "should-fix", "advisory"].includes(finding.priority) ||
			!["file", "invariant", "smallestFix", "regressionTest"].every((key) => text(finding[key])) ||
			!prose(finding.evidence) ||
			!(
				text(finding.confidence) ||
				(typeof finding.confidence === "number" && finding.confidence >= 0 && finding.confidence <= 1)
			) ||
			!Number.isSafeInteger(finding.line) ||
			finding.line < 1 ||
			!object(finding.performance) ||
			!["metric", "workload", "command"].every((key) => text(finding.performance[key])) ||
			!boundedData(finding.performance.baseline)
		)
			throw new AuditEvidenceError(`Invalid finding in review report ${agent}`)
		ids.add(finding.id)
	}
	return value
}

/** Reviews are bounded evidence of inspected scope, never execution receipts or a resolved-findings ledger. */
export async function aggregateReviewReports(directory) {
	const files = await readEvidence(async () => {
		await rejectSymlinkComponents(directory)
		return readdir(directory)
	}, "Review report directory is unavailable or contains links")
	const expected = Array.from({ length: 30 }, (_, index) => `${String(index + 1).padStart(2, "0")}.json`)
	if (files.length !== 30 || expected.some((file) => !files.includes(file)))
		throw new AuditEvidenceError("Review evidence requires exactly reports 01.json through 30.json")
	const reports = []
	for (const file of expected) {
		const bytes = await readEvidence(
			() => readBounded(path.join(directory, file), 256 * 1024),
			`Review report ${file} is missing, linked or exceeds the size limit`,
		)
		let value
		try {
			value = validateReviewReport(JSON.parse(bytes.toString("utf8")), file.slice(0, 2))
		} catch {
			throw new AuditEvidenceError(`Invalid review report ${file}`)
		}
		reports.push({
			agent: value.agent,
			domain: value.domain,
			sha256: digest(bytes),
			closure: value.closure,
			coverageCount: value.coverage.length,
			referenceSha: value.upstream.sha,
			findings: value.findings.map(({ id, severity, priority, file: findingFile, line }) => ({
				id,
				severity,
				priority,
				file: findingFile,
				line,
			})),
		})
	}
	return {
		kind: "review-evidence-only",
		count: 30,
		reports,
		claim: "Review scope and findings are not passing tests, verified fixes, or behavioral equivalence",
	}
}

export async function inspectCodexReference(root, checkout) {
	await readEvidence(() => rejectSymlinkComponents(checkout), "Codex checkout path contains links")
	const git = (args) => {
		const result = spawnSync("git", args, {
			cwd: checkout,
			encoding: "utf8",
			windowsHide: true,
			timeout: 10_000,
			maxBuffer: 64 * 1024,
		})
		if (result.error || result.status !== 0)
			throw new AuditEvidenceError("Codex reference Git identity unavailable")
		return result.stdout.trim()
	}
	if (git(["rev-parse", "HEAD"]) !== codexReferenceSha || git(["status", "--porcelain"]))
		throw new AuditEvidenceError("Codex reference must be clean at the pinned audit SHA")
	const mapBytes = await readEvidence(
		() => readBounded(path.join(root, "evals/agent-workflows/codex-observable-reference-v1.json"), 128 * 1024),
		"Existing Codex reference map is missing, linked or oversized",
	)
	const map = await readEvidence(
		async () => JSON.parse(mapBytes.toString("utf8")),
		"Invalid existing Codex reference map",
	)
	if (map?.claim !== "observable-reference-map-only" || !Array.isArray(map.contracts) || map.contracts.length !== 6)
		throw new AuditEvidenceError("Invalid existing Codex reference map")
	const references = []
	for (const contract of map.contracts) {
		if (!text(contract.id) || !Array.isArray(contract.upstreamTests) || contract.upstreamTests.length > 10)
			throw new AuditEvidenceError("Invalid Codex reference contract")
		for (const reference of contract.upstreamTests) {
			if (
				!/^codex-rs\/core\/tests\/suite\/[a-z_]+\.rs$/.test(reference.path) ||
				!/^[a-z_]+$/.test(reference.test)
			)
				throw new AuditEvidenceError("Invalid Codex reference path")
			const bytes = await readEvidence(
				() => readBounded(path.join(checkout, reference.path), 2 * 1024 * 1024),
				"Pinned Codex reference test file is missing, linked or oversized",
			)
			if (!bytes.toString("utf8").includes(`fn ${reference.test}(`))
				throw new AuditEvidenceError(`Stale Codex reference test: ${reference.test.slice(0, 128)}`)
			references.push({ contract: contract.id, ...reference, sha256: digest(bytes) })
		}
	}
	const sources = []
	for (const file of ["codex-rs/core/src/session/step_settings.rs", "codex-rs/core/src/tools/parallel.rs"])
		sources.push({
			path: file,
			sha256: digest(
				await readEvidence(
					() => readBounded(path.join(checkout, file), 2 * 1024 * 1024),
					"Pinned Codex source file is missing, linked or oversized",
				),
			),
		})
	if (git(["rev-parse", "HEAD"]) !== codexReferenceSha || git(["status", "--porcelain"]))
		throw new AuditEvidenceError("Codex reference changed during inspection")
	return {
		kind: "pinned-source-reference-only",
		repository: "https://github.com/openai/codex",
		sha: codexReferenceSha,
		retrievedOn: "2026-10-30",
		mapSha256: digest(mapBytes),
		mapReferenceSha: map.upstream?.commit,
		references,
		sources,
		claim: "Source/test references checked; upstream tests were not run and behavioral equivalence is unverified",
		excluded: ["Codex sandbox architecture", "Source/prompt copying", "Parallel runtimes"],
	}
}
