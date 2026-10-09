import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mock, test } from "node:test"
import {
	normalizeVitestEvidence,
	readExecutionJson,
	testEvidenceVerdict,
	validateTestEvidence,
} from "./execution-evidence.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const file = "scripts/harness/steps.test.mjs"
const counts = { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 }
const receipt = () => ({
	schemaVersion: 1,
	kind: "alpha-test-execution",
	runner: "node",
	complete: true,
	success: true,
	counts: { ...counts },
	files: [{ path: file, counts: { ...counts } }],
})

test("missing, empty, inconsistent, and incomplete execution cannot become a test pass", () => {
	for (const mutate of [
		() => undefined,
		(value) => ({ ...value, complete: false }),
		(value) => ({ ...value, counts: { ...counts, total: 0 } }),
		(value) => ({ ...value, files: [] }),
		(value) => ({ ...value, counts: { ...counts, passed: -1 } }),
		(value) => ({ ...value, files: [value.files[0], value.files[0]] }),
	]) {
		assert.equal(testEvidenceVerdict(mutate(receipt())).status, "failed")
	}
	const empty = receipt()
	empty.counts = { ...counts, total: 0, passed: 0 }
	empty.files[0].counts = { ...empty.counts }
	assert.equal(testEvidenceVerdict(empty).reason, "no_tests_executed")
	const mixed = receipt()
	mixed.files.push({ path: "scripts/harness/empty.test.mjs", counts: empty.counts })
	assert.equal(testEvidenceVerdict(mixed, true).status, "failed")
})

test("partial skips are recorded and fail a hard gate even when the runner returned success", () => {
	const value = receipt()
	value.counts = { ...counts, total: 2, skipped: 1 }
	value.files[0].counts = { ...value.counts }
	assert.equal(testEvidenceVerdict(value).status, "passed")
	assert.equal(testEvidenceVerdict(value, true).reason, "skipped_hard_gate")
	value.success = false
	assert.equal(testEvidenceVerdict(value).reason, "test_execution_failed")
})

test("test source identities are confined and compiled host tests map back to source", () => {
	for (const identity of [
		"../private.test.mjs",
		"/outside.test.mjs",
		"C:/outside.test.mjs",
		"scripts\\a.test.mjs",
		"scripts/./a.test.mjs",
	]) {
		const value = receipt()
		value.files[0].path = identity
		assert.throws(() => validateTestEvidence(value), /identity/)
	}
	const raw = {
		success: true,
		numTotalTests: 1,
		numPassedTests: 1,
		numFailedTests: 0,
		numPendingTests: 0,
		numTodoTests: 0,
		testResults: [
			{
				name: path.join(root, "apps/vscode-e2e/out/unit/runTest.spec.js"),
				assertionResults: [{ status: "passed", fullName: "private", failureMessages: ["secret"] }],
			},
		],
	}
	const normalized = normalizeVitestEvidence(raw, root)
	assert.equal(normalized.files[0].path, "apps/vscode-e2e/src/unit/runTest.spec.ts")
	assert.equal(JSON.stringify(normalized).includes("private"), false)
	assert.equal(JSON.stringify(normalized).includes("secret"), false)
	assert.throws(() => normalizeVitestEvidence({ ...raw, numTotalTests: 2 }, root), /totals/)
})

test("the pinned Node runner emits a sanitized receipt for passing and skipped tests", async () => {
	const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "alpha-execution-evidence-")))
	try {
		const source = path.join(directory, "sample.test.mjs")
		const destination = path.join(directory, "execution.json")
		await writeFile(
			source,
			'import { test } from "node:test"\ntest("private name", () => console.log("private output"))\ntest("skip", {skip:true}, () => {})\n',
		)
		const result = spawnSync(
			process.execPath,
			[
				"--test",
				`--test-reporter=${pathToFileURL(path.join(root, "scripts/harness/node-reporter.mjs")).href}`,
				source,
			],
			{
				encoding: "utf8",
				windowsHide: true,
				env: {
					...process.env,
					NODE_TEST_CONTEXT: undefined,
					ALPHA_HARNESS_EVIDENCE_FILE: destination,
					ALPHA_HARNESS_REPOSITORY_ROOT: directory,
				},
			},
		)
		assert.equal(result.status, 0, result.stderr)
		const output = await readFile(destination, "utf8")
		const value = validateTestEvidence(JSON.parse(output))
		assert.deepEqual(value.counts, { ...counts, total: 2, skipped: 1 })
		assert.equal(value.files[0].path, "sample.test.mjs")
		assert.equal(output.includes("private"), false)
		assert.equal(testEvidenceVerdict(value, true).reason, "skipped_hard_gate")
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

const nodeControls = [
	{
		name: "failed assertions",
		source: 'test("private pass", () => {})\ntest("private failure", () => { throw new Error("private details") })',
		counts: { ...counts, total: 2, failed: 1 },
		success: false,
	},
	{
		name: "cancelled assertions",
		source: 'const controller = new AbortController()\ntest("private cancellation", { signal: controller.signal }, () => { controller.abort(); return new Promise(() => {}) })',
		counts: { ...counts, passed: 0, cancelled: 1 },
		success: false,
	},
	{
		name: "mixed passing and cancelled assertions",
		source: 'test("private pass", () => {})\nconst controller = new AbortController()\ntest("private cancellation", { signal: controller.signal }, () => { controller.abort(); return new Promise(() => {}) })',
		counts: { ...counts, total: 2, cancelled: 1 },
		success: false,
	},
	{
		name: "TODO assertions",
		source: 'test("private pass", () => {})\ntest.todo("private todo")',
		counts: { ...counts, total: 2, todo: 1 },
		success: true,
	},
]

for (const control of nodeControls) {
	test(`the pinned Node reporter preserves ${control.name} without leaking test details`, async () => {
		const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "alpha-node-control-")))
		try {
			const source = path.join(directory, "control.test.mjs")
			const destination = path.join(directory, "execution.json")
			await writeFile(source, `import { test } from "node:test"\n${control.source}\n`)
			const result = spawnSync(
				process.execPath,
				[
					"--test",
					`--test-reporter=${pathToFileURL(path.join(root, "scripts/harness/node-reporter.mjs")).href}`,
					source,
				],
				{
					encoding: "utf8",
					windowsHide: true,
					timeout: 15_000,
					env: {
						...process.env,
						NODE_TEST_CONTEXT: undefined,
						ALPHA_HARNESS_EVIDENCE_FILE: destination,
						ALPHA_HARNESS_REPOSITORY_ROOT: directory,
					},
				},
			)
			assert.equal(result.error, undefined)
			assert.equal(result.signal, null)
			assert.equal(result.status, control.success ? 0 : 1, result.stderr)
			const output = await readFile(destination, "utf8")
			const receipt = validateTestEvidence(JSON.parse(output))
			assert.equal(receipt.success, control.success)
			assert.deepEqual(receipt.counts, control.counts)
			assert.deepEqual(receipt.files, [{ path: "control.test.mjs", counts: control.counts }])
			assert.equal(output.includes("private"), false)
			assert.equal(testEvidenceVerdict(receipt).status, control.success ? "passed" : "failed")
			assert.equal(
				testEvidenceVerdict(receipt, true).reason,
				control.success ? "skipped_hard_gate" : "test_execution_failed",
			)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
}

test("receipt reads reject growth at the stat/read boundary without calling unbounded readFile", async () => {
	const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "alpha-growing-receipt-")))
	const file = path.join(directory, "result.json")
	const original = { stat: fs.stat, lstat: fs.lstat, readFile: fs.readFile }
	let grown = false
	let unboundedReads = 0
	try {
		await writeFile(file, "{}")
		for (const operation of ["stat", "lstat"])
			mock.method(fs, operation, async (...args) => {
				const metadata = await original[operation](...args)
				if (args[0] === file && !grown) {
					grown = true
					await writeFile(file, JSON.stringify({ padding: "x".repeat(1024) }))
				}
				return metadata
			})
		mock.method(fs, "readFile", async (...args) => {
			if (args[0] === file) unboundedReads++
			return original.readFile(...args)
		})
		syncBuiltinESMExports()
		await assert.rejects(readExecutionJson(file, 64))
		assert.equal(grown, true)
		assert.equal(unboundedReads, 0)
	} finally {
		mock.restoreAll()
		syncBuiltinESMExports()
		await rm(directory, { recursive: true, force: true })
	}
})

test("receipt reads reject linked result paths through the existing evidence owner", async () => {
	const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "alpha-linked-receipt-")))
	try {
		const origin = path.join(directory, "origin")
		const linked = path.join(directory, "linked")
		await mkdir(origin)
		await writeFile(path.join(origin, "result.json"), "{}")
		assert.deepEqual(await readExecutionJson(path.join(origin, "result.json"), 64), {})
		await symlink(origin, linked, process.platform === "win32" ? "junction" : "dir")
		await assert.rejects(readExecutionJson(path.join(linked, "result.json"), 64), /cannot contain symlinks/)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
