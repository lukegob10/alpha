import path from "node:path"
import { require as tsRequire } from "tsx/cjs/api"

const { readBounded } = tsRequire("../../apps/vscode-e2e/src/evidence/paths.ts", import.meta.url)

const countKeys = ["total", "passed", "failed", "skipped", "todo", "cancelled"]
const count = (value) => Number.isSafeInteger(value) && value >= 0

export function validateCounts(value) {
	if (!value || !countKeys.every((key) => count(value[key]))) throw new Error("Invalid execution counts")
	if (value.total !== countKeys.slice(1).reduce((sum, key) => sum + value[key], 0))
		throw new Error("Inconsistent execution counts")
	return Object.fromEntries(countKeys.map((key) => [key, value[key]]))
}

export function repositoryTestPath(root, value) {
	if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Test path must be absolute")
	let relative = path.relative(root, value).replaceAll("\\", "/")
	if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
		throw new Error("Test path is outside the repository")
	// The host runner compiles Node tests before executing them; identify their source, not generated output.
	if (relative.startsWith("apps/vscode-e2e/out/"))
		relative = relative.replace("apps/vscode-e2e/out/", "apps/vscode-e2e/src/").replace(/\.js$/, ".ts")
	if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(relative)) throw new Error("Invalid test source path")
	return relative
}

export function executionState(counts) {
	if (counts.failed || counts.cancelled) return "executed-fail"
	if (counts.skipped || counts.todo || counts.total === 0) return "skipped"
	return "executed-pass"
}

export function normalizeVitestEvidence(value, root) {
	if (!Array.isArray(value?.testResults) || typeof value.success !== "boolean")
		throw new Error("Missing Vitest execution report")
	const files = value.testResults.map((file) => {
		if (!Array.isArray(file.assertionResults)) throw new Error("Missing Vitest assertions")
		const counts = { total: file.assertionResults.length, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 }
		for (const assertion of file.assertionResults) {
			const field = { passed: "passed", failed: "failed", pending: "skipped", skipped: "skipped", todo: "todo" }[
				assertion.status
			]
			if (!field) throw new Error("Unknown Vitest assertion outcome")
			counts[field]++
		}
		return { path: repositoryTestPath(root, file.name), counts: validateCounts(counts) }
	})
	const counts = Object.fromEntries(
		countKeys.map((key) => [key, files.reduce((sum, file) => sum + file.counts[key], 0)]),
	)
	if (
		value.numTotalTests !== counts.total ||
		value.numPassedTests !== counts.passed ||
		value.numFailedTests !== counts.failed ||
		value.numPendingTests !== counts.skipped ||
		value.numTodoTests !== counts.todo
	)
		throw new Error("Vitest totals disagree with assertions")
	return validateTestEvidence({
		schemaVersion: 1,
		kind: "alpha-test-execution",
		runner: "vitest",
		complete: true,
		success: value.success,
		counts,
		files,
	})
}

export function validateTestEvidence(value) {
	if (
		value?.schemaVersion !== 1 ||
		value.kind !== "alpha-test-execution" ||
		!["node", "vitest"].includes(value.runner) ||
		value.complete !== true ||
		typeof value.success !== "boolean" ||
		!Array.isArray(value.files) ||
		value.files.length === 0
	)
		throw new Error("Invalid test execution receipt")
	const counts = validateCounts(value.counts)
	const paths = new Set()
	const files = value.files.map((file) => {
		if (
			typeof file.path !== "string" ||
			file.path.includes("\\") ||
			file.path.includes("\0") ||
			path.posix.isAbsolute(file.path) ||
			path.win32.isAbsolute(file.path) ||
			file.path.split("/").some((part) => !part || part === "." || part === "..") ||
			paths.has(file.path) ||
			!/\.(test|spec)\.[cm]?[jt]sx?$/.test(file.path)
		)
			throw new Error("Invalid or duplicate test identity")
		paths.add(file.path)
		return { path: file.path, counts: validateCounts(file.counts) }
	})
	if (countKeys.some((key) => counts[key] !== files.reduce((sum, file) => sum + file.counts[key], 0)))
		throw new Error("Execution totals disagree with files")
	return {
		schemaVersion: 1,
		kind: value.kind,
		runner: value.runner,
		complete: true,
		success: value.success,
		counts,
		files,
	}
}

export function testEvidenceVerdict(value, requireAllTests = false) {
	try {
		const receipt = validateTestEvidence(value)
		if (!receipt.success || receipt.counts.failed || receipt.counts.cancelled)
			return { status: "failed", reason: "test_execution_failed", receipt }
		if (receipt.counts.passed === 0) return { status: "failed", reason: "no_tests_executed", receipt }
		if (
			requireAllTests &&
			(receipt.counts.skipped || receipt.counts.todo || receipt.files.some((file) => file.counts.total === 0))
		)
			return { status: "failed", reason: "skipped_hard_gate", receipt }
		return { status: "passed", receipt }
	} catch {
		return { status: "failed", reason: "invalid_test_receipt" }
	}
}

/** Reporter output is untrusted. Bound it before parsing and never retain assertion messages or raw test logs. */
export async function readExecutionJson(file, maxBytes = 8 * 1024 * 1024) {
	const bytes = await readBounded(file, maxBytes)
	return JSON.parse(bytes.toString("utf8"))
}
