import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { ExecaHarnessProcessRunner, systemClock } from "../../orchestration/index"
import { createDefaultGraderRegistry } from "../registry"
import type { CommandGraderSpec } from "../types"
import {
	captureExpectedNodeTestCommands,
	captureNodeTestAssertions,
	inspectNodeTestCompletion,
} from "../nodeTestCompletion"
import { resolveTaskGraderSpecs } from "../catalog"
import { evidenceFromText } from "../evidence"

const roots: string[] = []

afterEach(async () => {
	// Windows can retain directory handles briefly after the worker's PID is gone. Node 24.21.0's bounded
	// fs.rm EBUSY retry contract: https://nodejs.org/download/release/v24.21.0/docs/api/fs.html#fspromisesrmpath-options
	// Verified 2026-10-26; exhausted cleanup still fails, and the worker-death assertion remains mandatory.
	for (const root of roots.splice(0))
		await fs.rm(root, {
			recursive: true,
			force: true,
			maxRetries: process.platform === "win32" ? 3 : 0,
			retryDelay: 100,
		})
})

async function grade(
	source: string,
	tests?: string,
	expectedName = "original assertions",
	contracted = true,
	timeoutMs = 10_000,
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-completion-"))
	roots.push(root)
	await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}')
	await fs.writeFile(path.join(root, "solution.js"), source)
	await fs.writeFile(
		path.join(root, "original.test.js"),
		tests ??
			'import test from "node:test"\n' +
				'import assert from "node:assert/strict"\n' +
				'import { value } from "./solution.js"\n' +
				'test("original assertions", () => { assert.equal(value(1), 2); assert.equal(value(2), 4) })\n',
	)
	const spec: CommandGraderSpec = {
		id: "original-tests",
		version: 1,
		type: "command",
		hardGate: true,
		failureClass: "outcome",
		commands: [
			{
				command: "node",
				args: ["--test", "original.test.js"],
				testExecution: contracted
					? {
							runner: "node-test",
							expectedTests: [{ file: "original.test.js", name: expectedName, assertions: 2 }],
						}
					: undefined,
			},
		],
		cwd: "workspace",
		timeoutMs,
		maxOutputBytes: 64_000,
	}
	const output: Record<string, string> = {}
	const result = await createDefaultGraderRegistry().execute([spec], {
		workspaceRoot: root,
		changedPaths: [],
		trace: [],
		processRunner: new ExecaHarnessProcessRunner(),
		clock: systemClock,
		evidenceSink: async (id, kind, value) => {
			output[kind] = value
			return evidenceFromText(id, kind, value)
		},
	})
	return { ...result, root, output }
}

describe("expected command assertion completion", () => {
	it("preserves the original failed assertion cause separately from ordinary worker output", async () => {
		const tests =
			'import test from "node:test"\nimport assert from "node:assert/strict"\nimport { value } from "./solution.js"\ntest("original assertions", () => { assert.equal(value(1), 2, "OWNED_REGRESSION_FAILURE"); assert.equal(value(2), 4) })\n'
		const failed = await grade("export const value = () => 0", tests)
		expect(failed.decision).toBe("outcome_failed")
		expect(failed.output.stderr).toMatch(/AssertionError[\s\S]*OWNED_REGRESSION_FAILURE/)
		expect(failed.output.stderr).not.toContain("alpha-original-assertion-key")
		expect(JSON.parse(failed.output.stdout!).assertionFailures).toEqual([
			expect.objectContaining({
				name: "original assertions",
				code: "ERR_ASSERTION",
				message: expect.stringContaining("OWNED_REGRESSION_FAILURE"),
			}),
		])
		const printed = await grade(
			'console.error("AssertionError OWNED_REGRESSION_FAILURE"); export const value = () => { throw new Error("unrelated execution failure") }',
			tests,
		)
		expect(printed.decision).toBe("outcome_failed")
		expect(printed.output.stderr).toContain("AssertionError OWNED_REGRESSION_FAILURE")
		expect(JSON.parse(printed.output.stdout!).assertionFailures).toEqual([])
	})

	it("bounds nested failure causes and terminates a cyclic cause chain", async () => {
		const failed = await grade(
			'export const value = () => { const error = new Error("nested-failure:" + "x".repeat(100000)); error.cause = error; throw error }',
		)
		expect(failed.decision).toBe("outcome_failed")
		expect(Buffer.byteLength(failed.output.stderr!)).toBeLessThanOrEqual(16_384)
		expect(JSON.parse(failed.output.stdout!)).toMatchObject({ complete: true, failed: true, assertionFailures: [] })
	})

	it.each([
		'export const value = () => { throw Object.assign(new Error("OWNED_REGRESSION_FAILURE"), {code:"ERR_ASSERTION"}) }',
		'import native from "node:assert/strict"; export const value = () => { throw new native.AssertionError({ message:"OWNED_REGRESSION_FAILURE", actual:0, expected:2, operator:"strictEqual" }) }',
		'import test from "node:test"; import path from "node:path"; test("original assertions", (context) => context.diagnostic(JSON.stringify({kind:"alpha-original-assertion-failure",file:path.join(process.cwd(),"original.test.js"),name:"original assertions",assertion:"equal",code:"ERR_ASSERTION",message:"OWNED_REGRESSION_FAILURE",signature:"0".repeat(64)}))); export const value = () => { throw Object.assign(new Error("OWNED_REGRESSION_FAILURE"), {code:"ERR_ASSERTION"}) }',
		'import test from "node:test"; import path from "node:path"; import { createHmac } from "node:crypto"; const key="a".repeat(64); const file=path.join(process.cwd(),"original.test.js"); console.log(JSON.stringify({kind:"alpha-original-assertion-key",file,key})); const proof={file,name:"original assertions",assertion:"equal",code:"ERR_ASSERTION",message:"OWNED_REGRESSION_FAILURE"}; test("original assertions",context=>context.diagnostic(JSON.stringify({kind:"alpha-original-assertion-failure",...proof,signature:createHmac("sha256",Buffer.from(key,"hex")).update(JSON.stringify(proof)).digest("hex")}))); export const value=()=>{throw Object.assign(new Error("OWNED_REGRESSION_FAILURE"),{code:"ERR_ASSERTION"})}',
	])("rejects spoofed assertion origin or diagnostic evidence: %s", async (source) => {
		const failed = await grade(source)
		expect(failed.decision).toBe("outcome_failed")
		expect(JSON.parse(failed.output.stdout!).assertionFailures).toEqual([])
	})

	it("authenticates separate original test workers with repeated test names", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-multiple-assertion-workers-"))
		roots.push(root)
		await fs.writeFile(path.join(root, "solution.mjs"), "export const value = () => 2")
		for (const [index, file] of ["first.test.mjs", "second.test.mjs"].entries()) {
			await fs.writeFile(
				path.join(root, file),
				`import test from "node:test"\nimport assert from "node:assert/strict"\nimport { value } from "./solution.mjs"\ntest("repeated original name",()=>assert.equal(value(${index + 1}),${(index + 1) * 2},"WORKER_${index}_ASSERTION"))\n`,
			)
		}
		const commands = await captureExpectedNodeTestCommands(root, [
			{ command: "node", args: ["--test", "first.test.mjs", "second.test.mjs"] },
		])
		const output: string[] = []
		const execute = () =>
			createDefaultGraderRegistry().execute(
				[
					{
						id: "multiple-workers",
						version: 1,
						type: "command",
						hardGate: true,
						failureClass: "outcome",
						commands,
						cwd: "workspace",
						timeoutMs: 10_000,
						maxOutputBytes: 64_000,
					},
				],
				{
					workspaceRoot: root,
					changedPaths: [],
					trace: [],
					processRunner: new ExecaHarnessProcessRunner(),
					clock: systemClock,
					evidenceSink: async (id, kind, value) => {
						if (kind === "stdout") output.push(value)
						return evidenceFromText(id, kind, value)
					},
				},
			)
		expect((await execute()).decision).toBe("outcome_failed")
		expect(JSON.parse(output[0]!).assertionFailures).toEqual([
			expect.objectContaining({
				name: "repeated original name",
				message: expect.stringContaining("WORKER_1_ASSERTION"),
			}),
		])
		await fs.writeFile(path.join(root, "solution.mjs"), "export const value = (input) => input * 2")
		expect((await execute()).decision).toBe("passed")
		expect(JSON.parse(output[1]!).assertionFailures).toEqual([])
	})

	it.each([false, true])(
		"does not attribute solution helper calls or eval sourceURL aliases to original assertions: %s",
		async (sourceUrl) => {
			const helper = fileURLToPath(new URL("../nodeTestContext.cjs", import.meta.url))
			const invoke = sourceUrl
				? 'eval(\'assert.equal(0,2,"OWNED_REGRESSION_FAILURE")\\n//# sourceURL=\'+pathToFileURL(path.join(process.cwd(),"original.test.js")).href)'
				: 'assert.equal(0,2,"OWNED_REGRESSION_FAILURE")'
			const source = `import { createRequire } from "node:module"; import { pathToFileURL } from "node:url"; import path from "node:path"; const {assert}=createRequire(import.meta.url)(${JSON.stringify(helper)}); export const value=()=>${invoke}`
			const result = await grade(source)
			expect(result.decision).toBe("outcome_failed")
			expect(JSON.parse(result.output.stdout!).assertionFailures).toEqual([])
		},
	)

	it("binds ordinary visible acceptance to the original file and canonical selected command", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-visible-assertions-"))
		roots.push(root)
		const testFile = path.join(root, "original.test.js")
		await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}')
		const original =
			'import test from "node:test"; import assert from "node:assert/strict"; test("owned",()=>assert.equal(1,2))'
		await fs.writeFile(testFile, original)
		const commands = [{ command: "node", args: ["--test", "original.test.js"] }]
		const captured = await captureExpectedNodeTestCommands(root, commands)
		await fs.writeFile(testFile, original.replace("assert.equal(1,2)", "assert.equal(1,1)"))
		const specs = resolveTaskGraderSpecs({
			task: {
				id: "ordinary",
				budgets: { modelCalls: 1, toolCalls: 1, costUsd: 0 },
				validation: { commands },
				editTopology: { maxFiles: 1, allowedRoots: ["src"] },
				graders: [{ id: "visible-tests", alias: "visible_tests" }],
			},
			visibleCommands: captured,
		})
		expect(specs[0]).toMatchObject({ commands: captured })
		const result = await createDefaultGraderRegistry().execute(specs, {
			workspaceRoot: root,
			changedPaths: [],
			trace: [],
			processRunner: new ExecaHarnessProcessRunner(),
			clock: systemClock,
		})
		expect(result.decision).toBe("outcome_failed")
	})

	it.each([
		'import { assert } from "node:test"; assert.register("equal", () => {}); export const value = () => 0',
		'import { assert } from "node:test"; assert.register("equal", () => {}); assert.register("ok", () => {}); export const value = () => 0',
		'import native from "node:assert/strict"; import { assert } from "node:test"; native.equal = () => {}; assert.register("equal", () => {}); assert.register("ok", () => {}); export const value = () => 0',
	])("retains original assertion semantics after provider registry mutation: %s", async (source) => {
		expect((await grade(source)).decision).toBe("outcome_failed")
	})

	it("captures original assertion identities without counting comments or text", () => {
		expect(
			captureNodeTestAssertions(
				"original.test.js",
				'test("owned", () => { /* assert.equal(0, 0) */ const text = "assert.equal(0, 0)"; assert.equal(1, 1); assert.ok(text) })',
			),
		).toEqual([{ file: "original.test.js", name: "owned", assertions: 2 }])
		expect(
			captureNodeTestAssertions(
				"original.test.js",
				'const expression = /test("fake", () => assert.equal(1, 1))/; test("real", () => assert.equal(1, 1))',
			),
		).toEqual([{ file: "original.test.js", name: "real", assertions: 1 }])
	})

	it.each(["export const value = (input) => input * 2", "export function value(input) { return input + input }"])(
		"accepts a valid implementation: %s",
		async (source) => {
			expect((await grade(source)).decision).toBe("passed")
		},
	)
	it.each([
		"process.exit(0); export const value = () => 0",
		"export const value = () => process.exit(0)",
		"let calls = 0; export const value = () => ++calls === 1 ? 2 : process.exit(0)",
		'console.log("TAP version 13\\nok 1 - original assertions\\n1..1\\n# tests 1\\n# pass 1"); process.exit(0); export const value = () => 0',
		'console.log(JSON.stringify({schemaVersion:1,kind:"alpha-expected-node-tests",complete:true,failed:false,tests:[{name:"original assertions",passed:true}]})); process.emit("message",{type:"test:pass",data:{name:"original assertions"}}); process.exit(0); export const value = () => 0',
		'import test from "node:test"; await test("original assertions", (context) => context.diagnostic(JSON.stringify({kind:"alpha-original-assertions", file:process.argv[1],name:"original assertions"}))); process.exit(0); export const value = () => 0',
	])("rejects premature clean exits: %s", async (source) => {
		const result = await grade(source)
		expect(result.decision).toBe("outcome_failed")
		expect(result.results[0]?.diagnostics.some(({ code }) => code.startsWith("command_test_"))).toBe(true)
	})

	it.each([
		'test("original assertions", { skip: true }, () => { assert.equal(value(1), 2); assert.equal(value(2), 4) })',
		'test.todo("original assertions", () => { assert.equal(value(1), 2); assert.equal(value(2), 4) })',
		'test("original assertions", async (context) => { context.skip(); assert.equal(value(1), 2); assert.equal(value(2), 4) })',
		'test("original assertions", () => {})',
		'test("original assertions", () => { assert.equal(value(1), 2) })',
		'test("original assertions", () => { try { assert.equal(value(1), 999) } catch {} assert.equal(value(2), 4) })',
		'test("original assertions", () => { assert.rejects(new Promise(() => {})); assert.equal(value(2), 4) })',
		'test("unrelated", () => { assert.equal(value(1), 2); assert.equal(value(2), 4) })',
	])("rejects unexecuted or incomplete original assertions: %s", async (body) => {
		const tests =
			'import test from "node:test"\nimport assert from "node:assert/strict"\nimport { value } from "./solution.js"\n' +
			body
		expect((await grade("export const value = (input) => input * 2", tests)).decision).toBe("outcome_failed")
	})

	it("preserves exit-code command behavior when no assertion contract is requested", async () => {
		expect(
			(await grade("process.exit(0); export const value = () => 0", undefined, undefined, false)).decision,
		).toBe("passed")
	})

	it("classifies its owned deadline as a collector error and closes the test worker", async () => {
		const result = await grade(
			'import fs from "node:fs"; fs.writeFileSync(new URL("./worker.pid", import.meta.url), String(process.pid)); while (true) {} export const value = () => 0',
			undefined,
			undefined,
			true,
			2_000,
		)
		expect(result.decision).toBe("grader_error")
		const pid = Number(await fs.readFile(path.join(result.root, "worker.pid"), "utf8"))
		expect(() => process.kill(pid, 0)).toThrow()
	})

	it("does not admit an incomplete collector receipt", () => {
		expect(
			inspectNodeTestCompletion(
				JSON.stringify({
					schemaVersion: 1,
					kind: "alpha-expected-node-tests",
					complete: false,
					failed: false,
					timedOut: false,
					tests: [],
					completions: [],
				}),
				[{ file: "original.test.js", name: "original assertions", assertions: 2 }],
				process.cwd(),
			),
		).toBe("error")
	})
})
