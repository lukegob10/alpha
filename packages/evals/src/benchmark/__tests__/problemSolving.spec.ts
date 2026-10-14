import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { auditGraderControls, createDefaultGraderRegistry, type CommandGraderSpec } from "../../grading/index"
import { ExecaHarnessProcessRunner, systemClock } from "../../orchestration/index"
import { coreBankControls } from "../problemSolvingBankControls"
import {
	assertVisibleBankCalibration,
	loadProblemSolvingSet,
	selectLiveMeasurementTasks,
	validateProblemSolvingSet,
	type ProblemSolvingManifest,
} from "../index"

const evalRoot = path.resolve(process.cwd(), "../../evals")

const nativeTasks = [
	{
		id: "alpha-pr-comparison",
		testFile: "test/compare.test.js",
		target: "src/compare.js",
		reference:
			"function lineChanges(text) {\n" +
			"\treturn String(text)\n" +
			"\t\t.split(/\\r?\\n/)\n" +
			'\t\t.filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))\n' +
			"}\n" +
			"export function comparePatches(baseText, candidateText) {\n" +
			"\tconst base = lineChanges(baseText)\n" +
			"\tconst candidate = lineChanges(candidateText)\n" +
			"\tconst equivalent = base.length === candidate.length && base.every((line, index) => line === candidate[index])\n" +
			"\treturn { equivalent, baseChanges: base.length, candidateChanges: candidate.length }\n" +
			"}\n",
		alternative:
			"function lineChanges(text) {\n" +
			"\tconst changes = []\n" +
			"\tfor (const line of String(text).split(/\\r?\\n/)) {\n" +
			'\t\tif (line.startsWith("+++") || line.startsWith("---")) continue\n' +
			'\t\tif (line.startsWith("+") || line.startsWith("-")) changes.push(line)\n' +
			"\t}\n" +
			"\treturn changes\n" +
			"}\n" +
			"export function comparePatches(baseText, candidateText) {\n" +
			"\tconst base = lineChanges(baseText)\n" +
			"\tconst candidate = lineChanges(candidateText)\n" +
			"\treturn {\n" +
			"\t\tequivalent: JSON.stringify(base) === JSON.stringify(candidate),\n" +
			"\t\tbaseChanges: base.length,\n" +
			"\t\tcandidateChanges: candidate.length,\n" +
			"\t}\n" +
			"}\n",
		broken:
			"export function comparePatches() {\n" +
			"\treturn { equivalent: false, baseChanges: 0, candidateChanges: 0 }\n" +
			"}\n",
	},
	{
		id: "alpha-change-integration",
		testFile: "test/router.test.js",
		target: "src/router.js",
		reference:
			'import { archiveRecord } from "./archive.js"\n' +
			"export function route(action, record) {\n" +
			'\tif (action === "create") return { ...record, status: "created" }\n' +
			'\tif (action === "archive") return archiveRecord(record)\n' +
			'\treturn { ...record, status: "unknown" }\n' +
			"}\n",
		alternative:
			"export function route(action, record) {\n" +
			'\tif (action === "create") return { ...record, status: "created" }\n' +
			'\tif (action === "archive") return { ...record, status: "archived" }\n' +
			'\treturn { ...record, status: "unknown" }\n' +
			"}\n",
		broken:
			"export function route(action, record) {\n" +
			'\tif (action === "create") return { ...record, status: "created" }\n' +
			'\tif (action === "archive") return { ...record, status: "deleted" }\n' +
			'\treturn { ...record, status: "unknown" }\n' +
			"}\n",
	},
	{
		id: "alpha-cleanup",
		testFile: "test/report.test.js",
		target: "src/report.js",
		reference:
			"export function formatReport(items) {\n" +
			"\tconst total = items.reduce((sum, item) => sum + item.amount, 0)\n" +
			"\treturn `total=${total}`\n" +
			"}\n",
		alternative:
			"export function formatReport(items) {\n" +
			"\tlet total = 0\n" +
			"\tfor (const item of items) total += item.amount\n" +
			'\treturn "total=" + total\n' +
			"}\n",
		broken:
			"export function formatReport(items) {\n" +
			"\tconst total = items.reduce((sum, item) => sum + item.amount, 0)\n" +
			"\treturn `total=${total} DEBUG:${total}`\n" +
			"}\n",
	},
	{
		id: "alpha-skill-workflow",
		testFile: "test/workflow.test.js",
		target: "src/run.js",
		reference:
			"export function runWorkflow(records) {\n" +
			'\tconst ready = records.filter((record) => record.status === "ready")\n' +
			"\tconst total = ready.reduce((sum, record) => sum + record.amount, 0)\n" +
			'\treturn { kept: ready.length, total, skill: "alpha-workflow" }\n' +
			"}\n",
		alternative:
			"export function runWorkflow(records) {\n" +
			"\tlet kept = 0\n" +
			"\tlet total = 0\n" +
			"\tfor (const record of records) {\n" +
			'\t\tif (record.status !== "ready") continue\n' +
			"\t\tkept += 1\n" +
			"\t\ttotal += record.amount\n" +
			"\t}\n" +
			'\treturn { kept, total, skill: "alpha-workflow" }\n' +
			"}\n",
		broken:
			"export function runWorkflow(records) {\n" +
			'\tconst skipped = records.filter((record) => record.status === "skip")\n' +
			"\tconst total = skipped.reduce((sum, record) => sum + record.amount, 0)\n" +
			'\treturn { kept: skipped.length, total, skill: "alpha-workflow" }\n' +
			"}\n",
	},
] as const

function grader(id: string, testFile: string): CommandGraderSpec {
	return {
		id,
		version: 1,
		type: "command",
		hardGate: true,
		failureClass: "outcome",
		commands: [{ command: "node", args: ["--test", testFile] }],
		cwd: "workspace",
		timeoutMs: 30_000,
		maxOutputBytes: 256_000,
	}
}

async function runVisible(id: string, testFile: string, workspaceRoot: string) {
	return createDefaultGraderRegistry().execute([grader(id, testFile)], {
		workspaceRoot,
		changedPaths: [],
		trace: [],
		processRunner: new ExecaHarnessProcessRunner(),
		clock: systemClock,
	})
}

describe("problem-solving task set", () => {
	it("pins the bank, Terminal-Bench v4.0.0, and native tasks into core, development, and holdout", async () => {
		const manifest = await loadProblemSolvingSet(evalRoot)
		const lanes = new Set(manifest.tasks.map(({ lane }) => lane))
		expect(manifest.sources.map(({ id, release }) => [id, release])).toEqual([
			["alpha-task-bank", "frontier-v1@1"],
			["terminal-bench", "v4.0.0"],
			["alpha-native", "problem-solving-v1@1"],
		])
		expect(lanes).toEqual(new Set(["core", "development", "holdout"]))
		expect(manifest.tasks.filter(({ lane }) => lane === "core").length).toBeGreaterThan(0)
		expect(manifest.tasks.filter(({ source, lane }) => source === "terminal-bench" && lane === "core")).toEqual(
			expect.arrayContaining([expect.objectContaining({ resources: expect.objectContaining({ gpus: 0 }) })]),
		)
		expect(manifest.tasks.filter(({ id }) => id.startsWith("holdout-"))).toHaveLength(12)
		const live = selectLiveMeasurementTasks(manifest.tasks)
		expect(live).toHaveLength(32)
		expect(new Set(live.map(({ source }) => source))).toEqual(new Set(["alpha-task-bank", "alpha-native"]))
		expect(new Set(live.map(({ lane }) => lane))).toEqual(new Set(["core", "development"]))
		expect(live.filter(({ source }) => source === "alpha-native")).toHaveLength(4)
		expect(live.filter(({ lane }) => lane === "core")).toHaveLength(9)
	})

	it("rejects core tasks that need a GPU, network, or an excluded domain", async () => {
		const manifest = await loadProblemSolvingSet(evalRoot)
		const gpu = structuredClone(manifest) as ProblemSolvingManifest
		const core = gpu.tasks.find(({ lane }) => lane === "core")
		expect(core).toBeDefined()
		core!.tags = [...core!.tags, "gpu"]
		core!.resources.gpus = 1
		await expect(validateProblemSolvingSet(gpu, evalRoot)).rejects.toThrow(/excluded tag gpu/)

		const networked = structuredClone(manifest) as ProblemSolvingManifest
		const task = networked.tasks.find(({ lane }) => lane === "core")!
		task.resources.network = "required"
		await expect(validateProblemSolvingSet(networked, evalRoot)).rejects.toThrow(/requires network access/)
	})

	it("requires complete keyless calibration for every visible bank task", async () => {
		const manifest = await loadProblemSolvingSet(evalRoot)
		await assertVisibleBankCalibration(evalRoot, manifest)
		expect(
			manifest.tasks.filter(({ source, lane }) => source === "alpha-task-bank" && lane !== "holdout").length,
		).toBe(28)
	})

	it("passes core bank reference solutions repeatedly and fails no-op and incorrect controls", async () => {
		for (const task of coreBankControls) {
			const source = path.join(evalRoot, "javascript", task.id)
			const root = await fs.mkdtemp(path.join(os.tmpdir(), `alpha-${task.id}-`))
			const referenceRoot = path.join(root, "reference")
			const alternativeRoot = path.join(root, "alternative")
			const brokenRoot = path.join(root, "broken")
			const negativeRoot = path.join(root, "negative")
			try {
				await Promise.all(
					[referenceRoot, alternativeRoot, brokenRoot, negativeRoot].map((target) =>
						fs.cp(source, target, { recursive: true }),
					),
				)
				await fs.writeFile(path.join(referenceRoot, task.target), task.reference)
				await fs.writeFile(path.join(alternativeRoot, task.target), task.alternative)
				await fs.writeFile(path.join(brokenRoot, task.target), task.broken)
				for (let iteration = 0; iteration < 20; iteration++) {
					const result = await runVisible(`${task.id}-reference-${iteration}`, task.testFile, referenceRoot)
					expect(result.decision, `${task.id} repetition ${iteration}`).toBe("passed")
				}
				const audit = await auditGraderControls([
					{
						id: `${task.id}-reference`,
						kind: "reference",
						expectedDecision: "passed",
						run: () => runVisible(`${task.id}-reference`, task.testFile, referenceRoot),
					},
					{
						id: `${task.id}-alternative`,
						kind: "alternative-correct",
						expectedDecision: "passed",
						run: () => runVisible(`${task.id}-alternative`, task.testFile, alternativeRoot),
					},
					{
						id: `${task.id}-broken`,
						kind: "broken",
						expectedDecision: "outcome_failed",
						run: () => runVisible(`${task.id}-broken`, task.testFile, brokenRoot),
					},
					{
						id: `${task.id}-negative`,
						kind: "negative",
						expectedDecision: "outcome_failed",
						run: () => runVisible(`${task.id}-negative`, task.testFile, negativeRoot),
					},
				])
				expect(audit.passed, task.id).toBe(true)
			} finally {
				await fs.rm(root, { recursive: true, force: true })
			}
		}
	}, 180_000)

	it("passes native reference solutions repeatedly and fails no-op and incorrect controls", async () => {
		for (const task of nativeTasks) {
			const source = path.join(evalRoot, "javascript", task.id)
			const root = await fs.mkdtemp(path.join(os.tmpdir(), `alpha-${task.id}-`))
			const referenceRoot = path.join(root, "reference")
			const alternativeRoot = path.join(root, "alternative")
			const brokenRoot = path.join(root, "broken")
			const negativeRoot = path.join(root, "negative")
			try {
				await Promise.all(
					[referenceRoot, alternativeRoot, brokenRoot, negativeRoot].map((target) =>
						fs.cp(source, target, { recursive: true }),
					),
				)
				await fs.writeFile(path.join(referenceRoot, task.target), task.reference)
				await fs.writeFile(path.join(alternativeRoot, task.target), task.alternative)
				await fs.writeFile(path.join(brokenRoot, task.target), task.broken)

				for (let iteration = 0; iteration < 20; iteration++) {
					const result = await runVisible(`${task.id}-reference-${iteration}`, task.testFile, referenceRoot)
					expect(result.decision, `${task.id} repetition ${iteration}`).toBe("passed")
				}

				const audit = await auditGraderControls([
					{
						id: `${task.id}-reference`,
						kind: "reference",
						expectedDecision: "passed",
						run: () => runVisible(`${task.id}-reference`, task.testFile, referenceRoot),
					},
					{
						id: `${task.id}-alternative`,
						kind: "alternative-correct",
						expectedDecision: "passed",
						run: () => runVisible(`${task.id}-alternative`, task.testFile, alternativeRoot),
					},
					{
						id: `${task.id}-broken`,
						kind: "broken",
						expectedDecision: "outcome_failed",
						run: () => runVisible(`${task.id}-broken`, task.testFile, brokenRoot),
					},
					{
						id: `${task.id}-negative`,
						kind: "negative",
						expectedDecision: "outcome_failed",
						run: () => runVisible(`${task.id}-negative`, task.testFile, negativeRoot),
					},
				])
				expect(audit.passed, task.id).toBe(true)
			} finally {
				await fs.rm(root, { recursive: true, force: true })
			}
		}
	}, 120_000)
})
