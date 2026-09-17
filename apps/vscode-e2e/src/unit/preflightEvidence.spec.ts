import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"

import Mocha from "mocha"

import {
	createSerializedJsonWriter,
	summarizeMochaFailure,
	writeJsonAtomically,
	type MochaFailureDiagnostic,
} from "../suite/preflightEvidence"

async function runMochaFailure(
	kind: "test" | "hook",
): Promise<{ failures: number; diagnostics: MochaFailureDiagnostic[] }> {
	const mocha = new Mocha({ reporter: class extends Mocha.reporters.Base {} })
	const suite = Mocha.Suite.create(mocha.suite, "diagnostic suite")
	const error = new TypeError("PRIVATE_PROMPT_AND_TOKEN")
	error.stack = [
		"TypeError: PRIVATE_PROMPT_AND_TOKEN",
		"    at kP.init (C:\\Users\\private\\extensions\\copilot\\dist\\extension.js:1167:19963)",
		"    at runScenario (C:\\Users\\private\\Alpha-Code\\apps\\vscode-e2e\\src\\suite\\workflow.test.js:12:4)",
	].join("\n")
	if (kind === "hook") {
		suite.beforeAll(() => assert.fail(error))
		suite.addTest(new Mocha.Test("PRIVATE_DYNAMIC_TEST_TITLE", () => undefined))
	} else suite.addTest(new Mocha.Test("PRIVATE_DYNAMIC_TEST_TITLE", () => assert.fail(error)))
	const diagnostics: MochaFailureDiagnostic[] = []
	return new Promise((resolve) => {
		const runner = mocha.run((failures) => resolve({ failures, diagnostics }))
		runner.on("fail", (runnable, thrown) => diagnostics.push(summarizeMochaFailure(runnable, thrown)))
	})
}

test("an interrupted atomic preflight update leaves the previous receipt valid", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-preflight-atomic-"))
	try {
		const target = path.join(root, "host-preflight.json")
		await fs.writeFile(target, '{"status":"passed"}\n')
		let temporaryPath = ""
		await assert.rejects(
			writeJsonAtomically(
				target,
				{ status: "failed", code: "host-failed" },
				{
					writeFile: async (filePath, content, options) => {
						temporaryPath = filePath
						await fs.writeFile(filePath, content.slice(0, 1), options)
						throw new Error("simulated interruption")
					},
				},
			),
		)
		assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { status: "passed" })
		assert.equal(temporaryPath.endsWith(".tmp"), true)
		const entries = await fs.readdir(root)
		assert.equal(entries.includes("host-preflight.json"), true)
		assert.equal(entries.filter((entry) => entry.endsWith(".tmp")).length, 1)
		await writeJsonAtomically(target, { status: "recovered" })
		assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { status: "recovered" })
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("preflight snapshots serialize in order and continue after an interrupted write", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-preflight-queue-"))
	try {
		const target = path.join(root, "host-preflight.json")
		let writes = 0
		const writer = createSerializedJsonWriter(target, {
			writeFile: async (filePath, content, options) => {
				writes++
				await fs.writeFile(filePath, content, options)
				if (writes === 1) throw new Error("simulated interruption")
			},
		})
		const first = writer({ sequence: 1 })
		const second = writer({ sequence: 2 })
		await assert.rejects(first)
		await second
		assert.equal(JSON.parse(await fs.readFile(target, "utf8")).sequence, 2)
		assert.equal(writes, 2)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("a serialization failure stays behind an in-flight write and cannot let a later snapshot overtake it", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-preflight-serialization-"))
	try {
		const target = path.join(root, "host-preflight.json")
		let releaseFirst!: () => void
		const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve))
		let writes = 0
		let firstWriteStarted = false
		let laterWriteStarted = false
		const writer = createSerializedJsonWriter(target, {
			writeFile: async (filePath, content, options) => {
				writes++
				if (writes === 1) firstWriteStarted = true
				else laterWriteStarted = true
				await fs.writeFile(filePath, content, options)
				if (writes === 1) await firstReleased
			},
		})
		const first = writer({ sequence: 1 })
		await nextTurn()
		assert.equal(firstWriteStarted, true)
		const invalid = writer({ sequence: 2n })
		const later = writer({ sequence: 3 })
		await nextTurn()
		assert.equal(laterWriteStarted, false)
		releaseFirst()
		await first
		await assert.rejects(invalid)
		await later
		assert.equal(JSON.parse(await fs.readFile(target, "utf8")).sequence, 3)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("Mocha test and hook failures retain safe type, origin, and source coordinates only", async () => {
	for (const kind of ["test", "hook"] as const) {
		const result = await runMochaFailure(kind)
		assert.equal(result.failures, 1)
		const diagnostic = result.diagnostics[0]
		assert.equal(diagnostic?.runnable, kind)
		assert.equal(diagnostic?.errorType, "TypeError")
		assert.equal(diagnostic?.origin, "copilot-extension")
		assert.deepEqual(diagnostic?.locations.slice(0, 2), [
			{ origin: "copilot-extension", file: "copilot/dist/extension.js", line: 1167, column: 19963 },
			{ origin: "e2e-suite", file: "e2e-workflow", line: 12, column: 4 },
		])
		assert.equal(JSON.stringify(diagnostic).includes("PRIVATE_"), false)
		assert.equal(JSON.stringify(diagnostic).includes("Users"), false)
	}
})

test("uncaught Mocha failures are marked without retaining the exception text", () => {
	const error = Object.assign(new TypeError("PRIVATE_UNCAUGHT"), { uncaught: true })
	const diagnostic = summarizeMochaFailure(
		{ type: "test", file: "C:\\private\\Alpha-Code\\apps\\vscode-e2e\\src\\suite\\workflow.test.js" },
		error,
	)
	assert.equal(diagnostic.runnable, "uncaught")
	assert.equal(diagnostic.errorType, "TypeError")
	assert.equal(JSON.stringify(diagnostic).includes("PRIVATE_"), false)
})

test("forged stack paths and unsafe coordinates remain closed, classified labels", () => {
	const error = new TypeError("PRIVATE_STACK_MESSAGE")
	error.stack = [
		"TypeError: PRIVATE_STACK_MESSAGE",
		"    at forged (C:\\private\\copilot\\PRIVATE_TOKEN.js:999999999999:999999999999)",
		"    at host (C:\\private\\node_modules\\vscode\\out\\vs\\workbench.js:12:3)",
	].join("\n")
	const diagnostic = summarizeMochaFailure({ type: "test" }, error)
	assert.deepEqual(diagnostic.locations, [{ origin: "vscode", file: "vscode-runtime", line: 12, column: 3 }])
	assert.equal(diagnostic.origin, "vscode")
	assert.equal(JSON.stringify(diagnostic).includes("PRIVATE_"), false)
	assert.equal(JSON.stringify(diagnostic).includes("private"), false)
})

test("valid source coordinates cannot smuggle arbitrary stack or runnable path text", () => {
	const error = new TypeError("PRIVATE_MESSAGE")
	error.stack = "TypeError: PRIVATE_MESSAGE\n    at forged (C:/copilot/PRIVATE_TOKEN.js:17:3)"
	const diagnostic = summarizeMochaFailure({ type: "test", file: "C:/PRIVATE_RUNNABLE.js" }, error)
	assert.deepEqual(diagnostic.locations, [
		{ origin: "copilot-extension", file: "copilot-extension", line: 17, column: 3 },
	])
	assert.equal(JSON.stringify(diagnostic).includes("PRIVATE_"), false)
	const fallback = summarizeMochaFailure({ type: "hook", file: "C:/PRIVATE_RUNNABLE.js" }, {})
	assert.deepEqual(fallback.locations, [{ origin: "unknown", file: "unknown" }])
})

test("failed exclusive temp creation preserves the existing file and last published receipt", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-preflight-exclusive-"))
	try {
		const target = path.join(root, "host-preflight.json")
		await fs.writeFile(target, '{"sequence":1}\n')
		let existingTemporary = ""
		await assert.rejects(
			writeJsonAtomically(
				target,
				{ sequence: 2 },
				{
					writeFile: async (filePath) => {
						existingTemporary = filePath
						await fs.writeFile(filePath, "existing owner", { flag: "wx" })
						throw Object.assign(new Error("exclusive create failed"), { code: "EEXIST" })
					},
				},
			),
			{ code: "EEXIST" },
		)
		assert.equal(await fs.readFile(existingTemporary, "utf8"), "existing owner")
		assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { sequence: 1 })
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
