import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { describe, expect, it } from "vitest"

import { loadBenchmarkCatalog } from "../../benchmark/index"
import { ExecaHarnessProcessRunner, systemClock } from "../../orchestration/index"
import { auditGraderControls, createDefaultGraderRegistry, type CommandGraderSpec } from "../index"

const evalRoot = path.resolve(process.cwd(), "../../evals")
const calibrationRoot = path.resolve(process.cwd(), "src/grading/__fixtures__/gold")
const representativeTaskIds = ["smoke-read-edit", "smoke-test-repair", "smoke-multi-file", "smoke-safety"] as const
const taskBankManifestPath = path.join(evalRoot, "grader-controls/smoke-v1.json")

type TaskBankControlKind = "reference" | "alternative-correct" | "broken" | "negative"
type TaskBankControlManifest = {
	schemaVersion: number
	tasks: Array<{
		id: string
		fixture: string
		role: string
		grader: string
		controls: Array<{
			id: string
			kind: TaskBankControlKind
			expectedDecision: "passed" | "outcome_failed"
			changedPaths: string[]
		}>
	}>
}

async function readyFixtures(): Promise<Array<{ id: string; fixture: string }>> {
	const catalog = await loadBenchmarkCatalog(evalRoot)
	return [...catalog.tasks.values()]
		.map(({ task }) => task)
		.filter(({ partition, admission }) => partition === "smoke" && admission === "admitted")
		.map(({ id, fixture }) => ({ id, fixture }))
}

function spec(id: string): CommandGraderSpec {
	return {
		id: `${id}.visible-tests`,
		version: 1,
		type: "command",
		hardGate: true,
		failureClass: "outcome",
		commands: [{ command: "pnpm", args: ["test"] }],
		cwd: "workspace",
		timeoutMs: 30_000,
		maxOutputBytes: 256_000,
	}
}

async function runVisible(commandId: string, workspaceRoot: string, changedPaths: string[] = []) {
	return createDefaultGraderRegistry().execute([spec(commandId)], {
		workspaceRoot,
		changedPaths,
		trace: [],
		processRunner: new ExecaHarnessProcessRunner(),
		clock: systemClock,
	})
}

describe("local ready eval fixtures", () => {
	it("reproduces the declared initial visible-test baseline for every ready task fixture", async () => {
		const fixtures = await readyFixtures()
		expect(fixtures).toHaveLength(8)
		expect(fixtures.map(({ id }) => id)).toEqual(expect.arrayContaining([...representativeTaskIds]))
		for (const fixture of fixtures) {
			const result = await runVisible(fixture.id, path.join(evalRoot, fixture.fixture))
			expect(result.decision, fixture.id).toBe("outcome_failed")
		}
	})

	it("passes the known-good calibration solution twenty consecutive times", async () => {
		for (let iteration = 0; iteration < 20; iteration++) {
			const result = await createDefaultGraderRegistry().execute([spec("calibration-gold")], {
				workspaceRoot: calibrationRoot,
				changedPaths: [],
				trace: [],
				processRunner: new ExecaHarnessProcessRunner(),
				clock: systemClock,
			})
			expect(result.decision).toBe("passed")
		}
	})

	it("fails a deliberately broken copy for the intended command reason", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-broken-eval-"))
		try {
			await fs.cp(calibrationRoot, tempRoot, { recursive: true })
			await fs.writeFile(path.join(tempRoot, "src/sum.js"), "export function sum() { return 0 }\n")
			const result = await runVisible("broken-calibration", tempRoot, ["src/sum.js"])
			expect(result.decision).toBe("outcome_failed")
			expect(result.results[0]!.diagnostics[0]).toMatchObject({ code: "command_exit_nonzero" })
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true })
		}
	})

	it("audits reference, alternative-correct, broken, and no-op controls", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-grader-controls-"))
		const alternativeRoot = path.join(root, "alternative")
		const brokenRoot = path.join(root, "broken")
		const negativeRoot = path.join(root, "negative")
		try {
			await Promise.all(
				[alternativeRoot, brokenRoot, negativeRoot].map((target) =>
					fs.cp(calibrationRoot, target, { recursive: true }),
				),
			)
			await fs.writeFile(
				path.join(alternativeRoot, "src/sum.js"),
				"export function sum(left, right) { return Number(left) + Number(right) }\n",
			)
			await fs.writeFile(
				path.join(brokenRoot, "src/sum.js"),
				"export function sum(left, right) { return left - right }\n",
			)
			await fs.writeFile(path.join(negativeRoot, "src/sum.js"), "export function sum() { return 0 }\n")

			const audit = await auditGraderControls([
				{
					id: "calibration-reference",
					kind: "reference",
					expectedDecision: "passed",
					run: () => runVisible("calibration-reference", calibrationRoot),
				},
				{
					id: "calibration-alternative-correct",
					kind: "alternative-correct",
					expectedDecision: "passed",
					run: () => runVisible("calibration-alternative-correct", alternativeRoot, ["src/sum.js"]),
				},
				{
					id: "calibration-broken",
					kind: "broken",
					expectedDecision: "outcome_failed",
					run: () => runVisible("calibration-broken", brokenRoot, ["src/sum.js"]),
				},
				{
					id: "calibration-negative-no-op",
					kind: "negative",
					expectedDecision: "outcome_failed",
					run: () => runVisible("calibration-negative-no-op", negativeRoot),
				},
			])

			expect(audit.passed).toBe(true)
			expect(audit.entries.map(({ kind, actualDecision }) => [kind, actualDecision])).toEqual([
				["reference", "passed"],
				["alternative-correct", "passed"],
				["broken", "outcome_failed"],
				["negative", "outcome_failed"],
			])
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	it("audits controls against a representative admitted task fixture", async () => {
		const sourceRoot = path.join(evalRoot, "javascript/smoke-read-edit")
		const manifest = JSON.parse(await fs.readFile(taskBankManifestPath, "utf8")) as TaskBankControlManifest
		const task = manifest.tasks.find(({ id }) => id === "smoke-read-edit")
		expect(manifest.schemaVersion).toBe(1)
		expect(task).toMatchObject({
			fixture: "javascript/smoke-read-edit",
			role: "regression",
			grader: "visible-tests",
		})
		expect(task).toBeDefined()
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-bank-controls-"))
		const referenceRoot = path.join(root, "reference")
		const alternativeRoot = path.join(root, "alternative")
		const brokenRoot = path.join(root, "broken")
		const negativeRoot = path.join(root, "negative")
		try {
			await Promise.all(
				[referenceRoot, alternativeRoot, brokenRoot, negativeRoot].map((target) =>
					fs.cp(sourceRoot, target, { recursive: true }),
				),
			)
			await fs.writeFile(
				path.join(referenceRoot, "src/workflow.js"),
				"export function normalize(value) { return String(value).trim().toUpperCase() }\n" +
					'export const workflowIdentity = "smoke-read-edit"\n',
			)
			await fs.writeFile(
				path.join(alternativeRoot, "src/workflow.js"),
				"export function normalize(value) { const text = `${value}`.trim(); return text.toUpperCase() }\n" +
					'export const workflowIdentity = "smoke-read-edit"\n',
			)
			await fs.writeFile(
				path.join(brokenRoot, "src/workflow.js"),
				"export function normalize(value) { return String(value).trim().toLowerCase() }\n" +
					'export const workflowIdentity = "smoke-read-edit"\n',
			)

			const roots: Record<TaskBankControlKind, string> = {
				reference: referenceRoot,
				"alternative-correct": alternativeRoot,
				broken: brokenRoot,
				negative: negativeRoot,
			}
			const audit = await auditGraderControls(
				task!.controls.map((control) => ({
					...control,
					run: () => runVisible(control.id, roots[control.kind], control.changedPaths),
				})),
			)

			expect(audit.passed).toBe(true)
			expect(audit.entries.map(({ kind, actualDecision }) => [kind, actualDecision])).toEqual([
				["reference", "passed"],
				["alternative-correct", "passed"],
				["broken", "outcome_failed"],
				["negative", "outcome_failed"],
			])
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
