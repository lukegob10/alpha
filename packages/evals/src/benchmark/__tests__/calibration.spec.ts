import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { evidenceFromText, type GraderContext, type GraderRunResult } from "../../grading/index"
import { runKeylessCalibration } from "../calibration"
import { evaluateAdmission } from "../admission"
import { calibrationReportSchema, type BenchmarkTaskManifest } from "../contracts"

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock("../../grading/index", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../grading/index")>()),
	createDefaultGraderRegistry: () => ({ execute: mocks.execute }),
}))
vi.mock("../loader", () => ({ loadPrivateGraderBundle: async () => null }))

let root: string
const task: BenchmarkTaskManifest = {
	id: "calibration-control",
	version: 1,
	partition: "development",
	admission: "draft",
	fixture: "fixture",
	prompt: "prompt.md",
	repository: { upstream: "local", commit: "fixture" },
	family: "calibration",
	capabilities: ["validation"],
	risk: "low",
	difficulty: "foundation",
	contextBand: "compact",
	editTopology: { kind: "single-file", minFiles: 1, maxFiles: 2, allowedRoots: ["src"] },
	validation: { commands: [{ command: "node", args: ["--test", "test/behavior.test.js"] }], network: "disabled" },
	evidenceRequirements: ["final_workspace", "changed_paths", "usage", "environment", "grader_evidence"],
	graderReferenceDigest: `sha256:${"a".repeat(64)}`,
	environmentDigest: `sha256:${"b".repeat(64)}`,
	restraint: false,
	budgets: { wallSeconds: 120, modelCalls: 10, toolCalls: 10, costUsd: 1 },
	repetitions: { smoke: 1, scored: 1 },
	graders: [{ id: "visible-tests", version: 1, alias: "visible_tests" }],
}

const expected = {
	schemaVersion: 1,
	decision: "outcome_failed",
	diagnostics: [{ graderId: "calibration-control.visible_tests", code: "command_exit_nonzero" }],
}

function result(
	decision: GraderRunResult["decision"],
	options: { code?: string; evidence?: GraderRunResult["results"][number]["evidence"]; timestamp?: string } = {},
): GraderRunResult {
	return {
		decision,
		results: [
			{
				graderId: "calibration-control.visible_tests",
				graderVersion: 1,
				type: "command",
				status: decision === "passed" ? "passed" : decision === "grader_error" ? "error" : "failed",
				hardGate: true,
				failureClass: decision === "safety_failed" ? "safety" : "outcome",
				startedAt: options.timestamp ?? "2026-10-23T00:00:00.000Z",
				finishedAt: options.timestamp ?? "2026-10-23T00:00:00.000Z",
				durationMs: 0,
				diagnostics:
					decision === "passed"
						? []
						: [
								{
									code: options.code ?? "command_exit_nonzero",
									message: "Controlled failure",
									severity: "error",
								},
							],
				evidence: options.evidence ?? [evidenceFromText("observed", "report", "observed")],
			},
		],
	}
}

async function marker(context: GraderContext): Promise<string> {
	return fs.readFile(path.join(context.workspaceRoot, "src", "workflow.js"), "utf8")
}

async function run(selectedTask = task) {
	return runKeylessCalibration({
		task: selectedTask,
		publicRoot: path.join(root, "public"),
		privateRoot: path.join(root, "private"),
		goldRepetitions: 1,
		brokenRepetitions: 1,
		determinismRepetitions: 3,
	})
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "keyless-calibration-"))
	const fixture = path.join(root, "public", "fixture", "src")
	await fs.mkdir(fixture, { recursive: true })
	await fs.writeFile(path.join(fixture, "workflow.js"), "initial")
	await fs.mkdir(path.join(root, "public", "fixture", "test"))
	await fs.writeFile(
		path.join(root, "public", "fixture", "test", "behavior.test.js"),
		'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("original assertion", () => { assert.equal(1, 1) })\n',
	)
	const controls = path.join(root, "private", "calibration", task.id)
	for (const id of ["gold", "broken/one", "broken/two", "broken/three"]) {
		const directory = path.join(controls, id)
		await fs.mkdir(path.join(directory, "overlay", "src"), { recursive: true })
		await fs.writeFile(path.join(directory, "overlay", "src", "workflow.js"), id)
		if (id !== "gold") await fs.writeFile(path.join(directory, "expected.json"), JSON.stringify(expected))
	}
	mocks.execute.mockImplementation(async (_specs, context: GraderContext) =>
		result((await marker(context)) === "gold" ? "passed" : "outcome_failed"),
	)
})

afterEach(async () => {
	vi.clearAllMocks()
	await fs.rm(root, { recursive: true, force: true })
})

describe("keyless calibration acceptance", () => {
	it("prefers revised controls while preserving the legacy controls and their identity", async () => {
		const legacy = path.join(root, "private", "calibration", task.id)
		const versioned = `${legacy}@2`
		await fs.cp(legacy, versioned, { recursive: true })
		const legacyGold = path.join(legacy, "gold", "overlay", "src", "workflow.js")
		await fs.writeFile(legacyGold, "legacy source for the previous task version")
		const bytes = await fs.readFile(legacyGold)
		const report = await run({ ...task, version: 2 })
		expect(report.taskIdentity).toBe(`${task.id}@2`)
		expect(report.gold).toEqual({ repetitions: 1, passed: 1 })
		expect(report.broken.every(({ rejected }) => rejected === 1)).toBe(true)
		expect(await fs.readFile(legacyGold)).toEqual(bytes)
	})

	it.each([0, 5, 1.5, Number.NaN])("rejects an invalid calibration concurrency %s", async (concurrency) => {
		await expect(
			runKeylessCalibration({
				task,
				publicRoot: path.join(root, "public"),
				privateRoot: path.join(root, "private"),
				concurrency,
			}),
		).rejects.toThrow(/concurrency/)
		expect(mocks.execute).not.toHaveBeenCalled()
	})

	it("passes a correct golden source with the captured original checks and rejects the authored broken sources", async () => {
		const actual = await vi.importActual<typeof import("../../grading/index")>("../../grading/index")
		mocks.execute.mockImplementation((specs, context) =>
			actual.createDefaultGraderRegistry().execute(specs, context),
		)
		await fs.writeFile(path.join(root, "public", "fixture", "package.json"), '{"type":"module"}')
		await fs.writeFile(path.join(root, "public", "fixture", "src", "workflow.js"), "export const value = 0\n")
		await fs.writeFile(
			path.join(root, "public", "fixture", "test", "behavior.test.js"),
			'import test from "node:test"\nimport assert from "node:assert/strict"\nimport { value } from "../src/workflow.js"\ntest("original assertion", () => { assert.equal(value, 1) })\n',
		)
		await fs.writeFile(
			path.join(root, "private", "calibration", task.id, "gold", "overlay", "src", "workflow.js"),
			"export const value = 1\n",
		)
		for (const id of ["one", "three", "two"]) {
			const control = path.join(root, "private", "calibration", task.id, "broken", id)
			await fs.writeFile(path.join(control, "overlay", "src", "workflow.js"), "export const value = 0\n")
			await fs.writeFile(
				path.join(control, "expected.json"),
				JSON.stringify({
					...expected,
					diagnostics: [
						{ graderId: "calibration-control.visible_tests", code: "command_test_completion_missing" },
					],
				}),
			)
		}
		const report = await run()
		expect(report.gold).toEqual({ repetitions: 1, passed: 1 })
		expect(report.broken.every(({ rejected }) => rejected === 1)).toBe(true)
		expect(report.determinism.distinctDigests).toBe(1)
	})

	it("rejects changed golden test bytes using the original fixture assertions captured before overlays", async () => {
		const actual = await vi.importActual<typeof import("../../grading/index")>("../../grading/index")
		mocks.execute.mockImplementation((specs, context) =>
			actual.createDefaultGraderRegistry().execute(specs, context),
		)
		await fs.writeFile(
			path.join(root, "public", "fixture", "test", "behavior.test.js"),
			'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("original assertion", () => { assert.equal(1, 0) })\n',
		)
		const editedTests = path.join(root, "private", "calibration", task.id, "gold", "overlay", "test")
		await fs.mkdir(editedTests)
		await fs.writeFile(
			path.join(editedTests, "behavior.test.js"),
			'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("forged success", () => { assert.equal(1, 1) })\n',
		)
		const brokenRoot = path.join(root, "private", "calibration", task.id, "broken")
		await fs.rm(brokenRoot, { recursive: true, force: true })
		await fs.mkdir(brokenRoot)
		expect((await run()).gold).toEqual({ repetitions: 1, passed: 0 })
	})

	it("records execution gates as unmeasured and cannot replace live admission evidence", async () => {
		const report = await run({
			...task,
			graders: [
				...task.graders,
				{ id: "verification", version: 1, alias: "validation_after_last_edit" },
				{ id: "usage", version: 1, alias: "usage_limit" },
			],
		})
		expect(report.calibrationScope).toEqual({
			schemaVersion: 1,
			kind: "keyless-fixture",
			measuredGraderIds: ["calibration-control.visible_tests"],
			unmeasuredGraderIds: ["calibration-control.validation_after_last_edit", "calibration-control.usage_limit"],
			executionEvidence: "not-measured",
			semanticEvidenceVersion: 1,
		})
		for (const [specs, context] of mocks.execute.mock.calls) {
			expect(specs).toHaveLength(1)
			expect(specs[0].type).toBe("command")
			expect(context.trace).toEqual([])
			expect(context.usage).toBeUndefined()
		}
		const completeFixtureReport = {
			...report,
			gold: { repetitions: 20, passed: 20 },
			broken: report.broken.map((control) => ({ ...control, repetitions: 20, rejected: 20 })),
			determinism: { repetitions: 50, distinctDigests: 1 },
			admitted: true,
		}
		expect(calibrationReportSchema.parse(completeFixtureReport).calibrationScope).toEqual(report.calibrationScope)
		expect(evaluateAdmission(completeFixtureReport)).toMatchObject({
			admitted: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: "luna_calibration_missing" })]),
		})
		expect(
			calibrationReportSchema.safeParse({
				...completeFixtureReport,
				calibrationScope: { ...report.calibrationScope, executionEvidence: "passed" },
			}).success,
		).toBe(false)
		const { calibrationScope: _scope, ...legacy } = completeFixtureReport
		expect(calibrationReportSchema.parse(legacy).calibrationScope).toBeUndefined()
	})

	it("requires an authored rejection reason for each broken control", async () => {
		await fs.unlink(path.join(root, "private", "calibration", task.id, "broken", "one", "expected.json"))
		await expect(run()).rejects.toThrow(/expected\.json/)
	})

	it.each(["initial", "gold", "broken/one"])(
		"rejects a grader error in %s instead of crediting failure",
		async (at) => {
			mocks.execute.mockImplementation(async (_specs, context: GraderContext) => {
				const value = await marker(context)
				return result(value === at ? "grader_error" : value === "gold" ? "passed" : "outcome_failed", {
					code: value === at ? "command_timeout" : "command_exit_nonzero",
				})
			})
			await expect(run()).rejects.toThrow(/grader_error/)
		},
	)

	it.each([
		{ decision: "safety_failed" as const, code: "command_exit_nonzero" },
		{ decision: "outcome_failed" as const, code: "forbidden_path_changed" },
	])("rejects a broken control failing for the wrong reason: %j", async ({ decision, code }) => {
		mocks.execute.mockImplementation(async (_specs, context: GraderContext) => {
			const value = await marker(context)
			return value === "broken/one"
				? result(decision, { code })
				: result(value === "gold" ? "passed" : "outcome_failed")
		})
		await expect(run()).rejects.toThrow(/rejection.*reason/i)
	})

	it("retains the authored reason when every broken control is rejected correctly", async () => {
		const report = await run()
		expect(report.fixtureInitiallyFails).toBe(true)
		expect(report.broken).toEqual(
			["one", "three", "two"].map((id) => ({
				id,
				repetitions: 1,
				rejected: 1,
				expectedCode: "command_exit_nonzero",
			})),
		)
	})

	it("retains an escaping broken control as rejected zero instead of converting it to success", async () => {
		mocks.execute.mockImplementation(async (_specs, context: GraderContext) => {
			const value = await marker(context)
			return result(value === "gold" || value === "broken/one" ? "passed" : "outcome_failed")
		})
		expect((await run()).broken.find(({ id }) => id === "one")?.rejected).toBe(0)
	})

	it("accepts an explicitly authored safety rejection", async () => {
		for (const id of ["one", "three", "two"]) {
			await fs.writeFile(
				path.join(root, "private", "calibration", task.id, "broken", id, "expected.json"),
				JSON.stringify({
					...expected,
					decision: "safety_failed",
					diagnostics: [{ graderId: "calibration-control.visible_tests", code: "forbidden_path_changed" }],
				}),
			)
		}
		mocks.execute.mockImplementation(async (_specs, context: GraderContext) => {
			const value = await marker(context)
			return value.startsWith("broken/")
				? result("safety_failed", { code: "forbidden_path_changed" })
				: result(value === "gold" ? "passed" : "outcome_failed")
		})
		expect((await run()).broken.every(({ rejected }) => rejected === 1)).toBe(true)
	})
})

describe("keyless semantic repeatability", () => {
	it("detects changed semantic evidence even when the decision and diagnostics stay identical", async () => {
		let sequence = 0
		mocks.execute.mockImplementation(async (_specs, context: GraderContext) => {
			const value = await marker(context)
			return result(value === "gold" ? "passed" : "outcome_failed", {
				evidence: [evidenceFromText("semantic", "report", `meaningful result ${sequence++}`)],
			})
		})
		expect((await run()).determinism.distinctDigests).toBe(3)
	})

	it("normalizes owned command timing and workspace paths while retaining assertion outcomes", async () => {
		let sequence = 0
		mocks.execute.mockImplementation(async (_specs, context: GraderContext) => {
			const value = await marker(context)
			const output = `TAP version 13\n# Subtest: works\nok 1 - works\n  ---\n  duration_ms: ${++sequence}\n  ...\n# tests 1\n# pass 1\n# duration_ms ${sequence}\n# workspace ${context.workspaceRoot}\n`
			const evidence = await context.evidenceSink?.("command:stdout", "stdout", output, "text/plain")
			return result(value === "gold" ? "passed" : "outcome_failed", {
				timestamp: new Date(sequence * 1000).toISOString(),
				evidence: [evidence ?? evidenceFromText("command:stdout", "stdout", output)],
			})
		})
		expect((await run()).determinism.distinctDigests).toBe(1)
	})

	it("retains changed assertion identities in captured command output", async () => {
		let sequence = 0
		mocks.execute.mockImplementation(async (_specs, context: GraderContext) => {
			const value = await marker(context)
			const output = `TAP version 13\n# Subtest: assertion-${++sequence}\nok 1 - assertion-${sequence}\n# tests 1\n# pass 1\n# duration_ms ${sequence}\n`
			const evidence = await context.evidenceSink!("command:stdout", "stdout", output, "text/plain")
			return result(value === "gold" ? "passed" : "outcome_failed", { evidence: [evidence] })
		})
		expect((await run()).determinism.distinctDigests).toBe(3)
	})

	it("normalizes workspace coordinates inside owned JSON test completion receipts", async () => {
		mocks.execute.mockImplementation(async (_specs, context: GraderContext) => {
			const value = await marker(context)
			const output = JSON.stringify({
				tests: [
					{
						file: path.join(context.workspaceRoot, "test", "behavior.test.js"),
						name: "original assertion",
						passed: true,
					},
				],
			})
			const evidence = await context.evidenceSink!("command:stdout", "stdout", output, "application/json")
			return result(value === "gold" ? "passed" : "outcome_failed", { evidence: [evidence] })
		})
		expect((await run()).determinism.distinctDigests).toBe(1)
	})
})
