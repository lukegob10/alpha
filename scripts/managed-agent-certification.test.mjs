import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { format } from "node:util"
import ts from "typescript"
import {
	evaluateIntegrationRow,
	evaluateRow,
	readVitestSummary,
} from "./certification/managed-agent-milestone-certify.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const script = fileURLToPath(new URL("./certification/managed-agent-milestone-certify.mjs", import.meta.url))

function collectDeclaredTestTitles(file, source) {
	const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
	const titles = []
	const visit = (node) => {
		if (
			ts.isCallExpression(node) &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0]) &&
			/^(?:it|test)(?:[.(]|$)/.test(node.expression.getText(parsed))
		) {
			const title = node.arguments[0].text
			const each = node.expression
			let table =
				ts.isCallExpression(each) && /\.each$/.test(each.expression.getText(parsed))
					? each.arguments[0]
					: undefined
			while (table && (ts.isAsExpression(table) || ts.isParenthesizedExpression(table))) table = table.expression
			// Expand only statically known scalar-string rows with one supported placeholder.
			// Dynamic tables remain unresolved; never execute tests or invent concrete identities.
			if (
				table &&
				ts.isArrayLiteralExpression(table) &&
				table.elements.every(ts.isStringLiteralLike) &&
				(title.match(/%(?:%|[a-zA-Z#$])/g) ?? []).filter((token) => token !== "%%").join("") === "%s"
			) {
				for (const row of table.elements) titles.push(format(title, row.text))
			} else titles.push(title)
		}
		ts.forEachChild(node, visit)
	}
	visit(parsed)
	return titles
}

test("managed declaration binding expands literal each rows without executing dynamic fixtures", () => {
	const titles = collectDeclaredTestTitles(
		"fixture.spec.ts",
		`it("plain case", () => {})
		it.each(["canonical", "legacy", "empty-canonical", "matching"] as const)("ACKs %s IDs", () => {})
		it.each(loadCases())("dynamic %s IDs", () => {})
		it.each(["canonical"])("unresolved %s %s IDs", () => {})`,
	)
	assert.deepEqual(titles, [
		"plain case",
		"ACKs canonical IDs",
		"ACKs legacy IDs",
		"ACKs empty-canonical IDs",
		"ACKs matching IDs",
		"dynamic %s IDs",
		"unresolved %s %s IDs",
	])
})

test("managed-agent certification discovers its public lifecycle regression suites exactly once", () => {
	const result = spawnSync(process.execPath, [script, "--list"], {
		cwd: root,
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	})
	assert.equal(result.error, undefined)
	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /^types-build :: pnpm --filter @alpha-code\/types build$/m)
	assert.equal(
		/live-preflight|live-playbook-preflight|prepare-run-c/.test(result.stdout),
		false,
		"Automated certification must not depend on retired live prompts or their fixture preparer",
	)
	const commands = result.stdout.split(/\r?\n/).filter((line) => line.includes(" :: pnpm --dir "))
	for (const file of [
		"core/webview/__tests__/AlphaProvider.managed-owned-disposal.spec.ts",
		"core/webview/__tests__/AlphaProvider.managed-lifecycle-convergence.spec.ts",
		"core/webview/__tests__/AlphaProvider.managed-automatic-cold-followup.spec.ts",
		"core/task/__tests__/Task.managed-unload-ownership-public.spec.ts",
		"core/task/__tests__/Task.managed-unload-output-public.spec.ts",
		"core/task/__tests__/Task.managed-runtime-residency.spec.ts",
		"core/task/__tests__/Task.managed-peer-discovery.spec.ts",
		"src/worktree/__tests__/managed-subagent-worktree.artifact-validation.spec.ts",
		"src/worktree/__tests__/managed-subagent-worktree.environment.spec.ts",
	]) {
		const owners = commands.filter((line) => line.split(/\s+/).includes(file))
		assert.equal(owners.length, 1, `${file} must be selected by exactly one certification track`)
		const owner = file.startsWith("src/worktree/")
			? "worker-worktree :: pnpm --dir packages/core "
			: "lifecycle-routing :: pnpm --dir src "
		assert.ok(owners[0].startsWith(owner), `${file} must retain its certification owner`)
	}
})

test("the public self-check retains strict debt and assertion receipt diagnostics without running tracks", () => {
	const result = spawnSync(process.execPath, [script, "--self-check"], {
		cwd: root,
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	})
	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /PASS certification-self-check .*strictDebt=2; vitestSummary=/)
	assert.doesNotMatch(result.stdout, /\n==>/)
})

const assertionFile = "src/core/agent/__tests__/synthetic.spec.ts"
const tracks = [{ id: "runtime", contents: [{ file: assertionFile, text: '// it("required behavior", () => {})' }] }]
const requirement = {
	id: "SYNTHETIC-REQUIREMENT",
	classification: "baseline",
	trackIds: ["runtime"],
	probes: [
		{
			label: "required behavior",
			assertions: [{ file: assertionFile, pattern: " required behavior$", minimumMatches: 1 }],
		},
	],
}
const assertion = (name = "required behavior", status = "passed") => ({ fullName: `runtime ${name}`, status })
const result = (assertions, file = assertionFile) =>
	new Map([
		[
			"runtime",
			{
				status: "PASS",
				assertionReceipts: [{ path: file, assertions }],
			},
		],
	])

test("a requirement needs its executed assertion in its named file", () => {
	assert.equal(evaluateRow(requirement, tracks, result([assertion()]), true).status, "PASS")
	for (const [label, receipt] of [
		["comment-only probe", result([assertion("unrelated behavior")])],
		["removed assertion", result([])],
		["same title in another file", result([assertion()], "src/core/agent/__tests__/other.spec.ts")],
		["duplicate ambiguous assertion", result([assertion(), assertion()])],
		...["skipped", "pending", "todo", "failed"].map((status) => [
			status,
			result([assertion("required behavior", status)]),
		]),
	]) {
		assert.equal(evaluateRow(requirement, tracks, receipt, true).status, "FAIL", label)
	}
	assert.equal(evaluateRow(requirement, tracks, new Map([["runtime", { status: "PASS" }]]), true).status, "FAIL")
})

test("parameterized requirements need all declared executed cases and reject a skipped sibling", () => {
	const row = structuredClone(requirement)
	row.probes[0].assertions[0] = { file: assertionFile, pattern: " required behavior .+$", minimumMatches: 2 }
	assert.equal(evaluateRow(row, tracks, result([assertion("required behavior a")]), true).status, "FAIL")
	assert.equal(
		evaluateRow(row, tracks, result([assertion("required behavior a"), assertion("required behavior b")]), true)
			.status,
		"PASS",
	)
	assert.equal(
		evaluateRow(
			row,
			tracks,
			result([assertion("required behavior a"), assertion("required behavior b", "skipped")]),
			true,
		).status,
		"FAIL",
	)
})

test("Vitest assertion identities reach requirement admission with their file and status", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "alpha-managed-certification-test-"))
	try {
		const reportPath = path.join(directory, "report.json")
		const report = {
			success: true,
			numTotalTestSuites: 1,
			numPassedTestSuites: 1,
			numFailedTestSuites: 0,
			numPendingTestSuites: 0,
			numTotalTests: 1,
			numPassedTests: 1,
			numFailedTests: 0,
			numPendingTests: 0,
			numTodoTests: 0,
			testResults: [{ name: path.join(root, assertionFile), assertionResults: [assertion()] }],
		}
		await writeFile(reportPath, JSON.stringify(report))
		const summary = readVitestSummary("runtime", reportPath)
		assert.equal(summary.error, undefined)
		assert.deepEqual(summary.assertionReceipts, [{ path: assertionFile, assertions: [assertion()] }])
		assert.equal(
			evaluateRow(requirement, tracks, new Map([["runtime", { status: "PASS", ...summary }]]), true).status,
			"PASS",
		)
		report.testResults[0].assertionResults[0].fullName = ""
		await writeFile(reportPath, JSON.stringify(report))
		assert.match(readVitestSummary("runtime", reportPath).error, /invalid Vitest execution evidence/)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test("every managed requirement binds declared tests in its selected owning tracks", async () => {
	const matrix = JSON.parse(
		await readFile(new URL("./certification/managed-agent-milestone.matrix.json", import.meta.url), "utf8"),
	)
	const cache = new Map()
	for (const row of matrix.rows)
		for (const probe of row.probes)
			for (const binding of probe.assertions) {
				assert.ok(
					row.trackIds.some((id) => {
						const track = matrix.tracks.find((value) => value.id === id)
						return (
							binding.file.startsWith(`${track.packageDir}/`) &&
							track.include.some((pattern) =>
								new RegExp(pattern, "ims").test(binding.file.slice(track.packageDir.length + 1)),
							)
						)
					}),
					`${row.id}: ${binding.file} is outside its tracks`,
				)
				if (!cache.has(binding.file)) {
					const source = await readFile(path.join(root, binding.file), "utf8")
					cache.set(binding.file, collectDeclaredTestTitles(binding.file, source))
				}
				const expression = new RegExp(binding.pattern, "ims")
				assert.ok(
					cache.get(binding.file).some((title) => expression.test(`suite ${title}`)),
					`${row.id}: ${probe.label} has no test declaration`,
				)
			}
})

const bundleDigest = "a".repeat(64)
const sharedStorageReport = (overrides = {}) => ({
	schemaVersion: 1,
	execution: "extension-host",
	status: "passed",
	hostVersion: "1.138.0",
	runId: "shared-run",
	cleanupVerified: true,
	leaseReleased: true,
	captureComplete: true,
	identitiesVerified: true,
	mailboxClaimsVerified: true,
	readyHostCount: 2,
	doneHostCount: 2,
	retention: "held",
	storageAdmission: { complete: true, status: "within_budget" },
	taskIds: ["root-a", "root-b"],
	requests: 8,
	bundleHashBefore: bundleDigest,
	bundleHashAfter: bundleDigest,
	...overrides,
})
const evidence = (report) => [{ report, sha256: createHash("sha256").update(JSON.stringify(report)).digest("hex") }]
const storageRequirement = {
	id: "INT-STORAGE-WRITERS-001",
	evidenceKind: "shared-storage",
	reason: "real shared writers required",
}

test("only compatible actual shared-host evidence can discharge its integration predicate", () => {
	const admitted = evaluateIntegrationRow(storageRequirement, evidence(sharedStorageReport()), bundleDigest)
	assert.equal(admitted.status, "PASS-INTEGRATION")
	assert.equal(admitted.evidence.scope, "scripted-exact-host-built-artifact")
	for (const [label, report, digest] of [
		["unit seam", sharedStorageReport({ execution: "test-seam" }), bundleDigest],
		["minimum host", sharedStorageReport({ hostVersion: "1.125.0" }), bundleDigest],
		["stale build", sharedStorageReport(), "b".repeat(64)],
		["no current build", sharedStorageReport(), undefined],
		["incomplete capture", sharedStorageReport({ captureComplete: false }), bundleDigest],
		["unverified cleanup", sharedStorageReport({ cleanupVerified: false }), bundleDigest],
		["unproven mailbox", sharedStorageReport({ mailboxClaimsVerified: false }), bundleDigest],
		["one writer", sharedStorageReport({ doneHostCount: 1 }), bundleDigest],
		[
			"unrelated host suite",
			{ status: "passed", kind: "alpha-extension-test-run", testFile: "extension.test" },
			bundleDigest,
		],
	])
		assert.equal(
			evaluateIntegrationRow(storageRequirement, evidence(report), digest).status,
			"PENDING-INTEGRATION",
			label,
		)
	assert.equal(evaluateIntegrationRow(storageRequirement, [], bundleDigest).status, "PENDING-INTEGRATION")
	assert.equal(
		evaluateIntegrationRow(storageRequirement, [{ report: sharedStorageReport() }], bundleDigest).status,
		"PENDING-INTEGRATION",
	)
	assert.equal(
		evaluateIntegrationRow(
			{ id: "INT-LIVE-TREE-001", evidenceKind: "shared-storage", reason: "rendered UI required" },
			evidence(sharedStorageReport()),
			bundleDigest,
		).status,
		"PENDING-INTEGRATION",
	)
})

function churnReport() {
	const profileRoot = path.resolve(root, "artifacts", "owned-churn-profile")
	const workload = { rootCount: 16, childCount: 16, rootPromptBytes: 8192, childObjectiveBytes: 2048 }
	const phases = ["populate", "reload"].map((phase) =>
		sharedStorageReport({
			runId: `churn-${phase}`,
			profileRoot,
			taskHistoryChurn: ["a", "b"].map((windowRole, index) => {
				const rootTaskIds = Array.from({ length: 16 }, (_, i) => `${windowRole}-root-${i}`)
				const managedChildTaskIds = Array.from({ length: 16 }, (_, i) => `${windowRole}-child-${i}`)
				const taskIdsSha256 = createHash("sha256")
					.update(
						[...rootTaskIds.map((id) => `root:${id}`), ...managedChildTaskIds.map((id) => `child:${id}`)]
							.sort()
							.join("\n"),
					)
					.digest("hex")
				return {
					schemaVersion: 1,
					scenarioId: "task-history-churn",
					phase,
					runId: `churn-${phase}`,
					hostVersion: "1.138.0",
					extensionHostPid: 100 + index,
					storagePath: path.join(profileRoot, "globalStorage"),
					windowRole,
					windowCount: 2,
					workload,
					rootTaskIds,
					managedChildTaskIds,
					managedChildParentTaskIds: rootTaskIds,
					taskIdsSha256,
					requests: 64,
					taskHistoryMirror: {
						key: "taskHistory",
						budgetBytes: 192 * 1024,
						before: { bytes: 2, items: 0, withinBudget: true },
						after: { bytes: 128000, items: 16, withinBudget: true },
						maxBytes: 128000,
						withinBudget: true,
					},
					...(phase === "reload" ? { reloadedFrom: { rootCount: 16, childCount: 16, taskIdsSha256 } } : {}),
				}
			}),
		}),
	)
	return {
		schemaVersion: 1,
		execution: "extension-host",
		status: "passed",
		cleanupVerified: true,
		liveRequests: 0,
		phases,
	}
}

test("global-state admission requires both real churn phases and canonical budget/reload receipts", () => {
	const row = {
		id: "INT-GLOBAL-STATE-SIZE-001",
		evidenceKind: "task-history-churn",
		reason: "churn and reload required",
	}
	assert.equal(evaluateIntegrationRow(row, evidence(churnReport()), bundleDigest).status, "PASS-INTEGRATION")
	for (const mutate of [
		(report) => report.phases.pop(),
		(report) => (report.phases[1].execution = "test-seam"),
		(report) => (report.phases[1].profileRoot = path.resolve(root, "other-profile")),
		(report) => (report.phases[0].profileRoot = {}),
		(report) => (report.phases[1].taskHistoryChurn[0].reloadedFrom.taskIdsSha256 = "f".repeat(64)),
		(report) => (report.phases[1].taskHistoryChurn[1].taskHistoryMirror.after.bytes = 200000),
		(report) => (report.phases[0].taskHistoryChurn[0].requests = 0),
		(report) => (report.phases[1].taskHistoryChurn[1].windowRole = "a"),
	]) {
		const report = churnReport()
		mutate(report)
		assert.equal(evaluateIntegrationRow(row, evidence(report), bundleDigest).status, "PENDING-INTEGRATION")
	}
	assert.equal(
		evaluateIntegrationRow(row, evidence(sharedStorageReport()), bundleDigest).status,
		"PENDING-INTEGRATION",
	)
})
