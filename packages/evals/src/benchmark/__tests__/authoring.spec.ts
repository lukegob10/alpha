import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { stringify } from "yaml"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { canonicalJson, sha256 } from "../../evidence/index"
import {
	createTaskTemplate,
	createHoldoutReferenceTemplate,
	loadBenchmarkCatalog,
	runAuthoringCheck,
	writeBenchmarkReleaseLock,
	writeTaskTemplate,
	type BenchmarkSuiteManifest,
	type BenchmarkTaskManifest,
} from "../index"

let root: string

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-authoring-"))
	await fs.writeFile(path.join(root, "benchmark-suites.yaml"), "schemaVersion: 1\nsuites: [suite.yaml]\n")
})

afterEach(async () => fs.rm(root, { recursive: true, force: true }))

describe("benchmark authoring contract", () => {
	it("generates valid compact, medium, long, restraint, and holdout-reference templates", () => {
		const compact = createTaskTemplate({ id: "compact-task", profile: "compact" })
		const medium = createTaskTemplate({ id: "medium-task", profile: "medium", partition: "regression" })
		const long = createTaskTemplate({ id: "long-task", profile: "long" })
		const restraint = createTaskTemplate({ id: "restraint-task", profile: "compact", restraint: true })
		const holdout = createHoldoutReferenceTemplate({
			id: "holdout-task",
			profile: "medium",
			bundleId: "private-v1",
			bundleVersion: 3,
			bundleDigest: `sha256:${"a".repeat(64)}`,
		})
		expect(compact).toMatchObject({ contextBand: "compact", editTopology: { kind: "single-file", maxFiles: 2 } })
		expect(medium).toMatchObject({
			contextBand: "medium",
			partition: "regression",
			editTopology: { kind: "multi-file" },
		})
		expect(long).toMatchObject({ contextBand: "long", editTopology: { kind: "cross-package", minFiles: 3 } })
		expect(restraint).toMatchObject({ restraint: true })
		expect(holdout).toMatchObject({ partition: "holdout", fixture: "tasks/holdout-task/workspace" })
	})

	it("rejects duplicate task identities", async () => {
		const generated = await writeTaskTemplate(root, { id: "duplicate-task", profile: "compact" })
		await writeSuite([generated.task, generated.task])
		await expect(loadBenchmarkCatalog(root)).rejects.toThrow("Duplicate benchmark task identity")
	})

	it("flags noun-substituted prompts and structurally duplicated fixtures", async () => {
		const first = await writeTaskTemplate(root, { id: "cache-repair", profile: "compact" })
		const second = await writeTaskTemplate(root, { id: "session-repair", profile: "compact" })
		await writeSuite([first.task, second.task])
		const report = await runAuthoringCheck({ publicRoot: root, outputRoot: path.join(root, "reports") })
		expect(report.valid).toBe(false)
		expect(report.similarity.duplicatePairs).toEqual([
			expect.objectContaining({ left: "cache-repair@1", right: "session-repair@1", duplicate: true }),
		])
		expect(await fs.readFile(report.jsonPath!, "utf8")).toContain("public_task_duplicate")
		expect(await fs.readFile(report.markdownPath!, "utf8")).toContain("Admission-ready: no")
	})

	it("rejects unknown graders and missing trace evidence", async () => {
		const generated = await writeTaskTemplate(root, { id: "invalid-grader", profile: "compact" })
		const graders = generated.task.graders.map((grader) =>
			grader.alias === "visible_tests" ? { ...grader, alias: "unknown_grader" } : grader,
		)
		await writeSuite([{ ...generated.task, graders, graderReferenceDigest: sha256(canonicalJson(graders)) }])
		await expect(loadBenchmarkCatalog(root)).rejects.toThrow("Unknown grader alias")

		const traceTask = createTaskTemplate({ id: "missing-trace", profile: "compact" })
		await writeTaskTemplate(root, { id: "missing-trace", profile: "compact" })
		await writeSuite([
			{
				...traceTask,
				evidenceRequirements: traceTask.evidenceRequirements.filter((value) => value !== "normalized_trace"),
			},
		])
		await expect(loadBenchmarkCatalog(root)).rejects.toThrow("Trace graders require normalized_trace evidence")
	})

	it("rejects digest-mismatched assets", async () => {
		const generated = await writeTaskTemplate(root, { id: "digest-task", profile: "compact" })
		await writeSuite([{ ...generated.task, promptDigest: `sha256:${"0".repeat(64)}` }])
		await expect(loadBenchmarkCatalog(root)).rejects.toThrow("Prompt digest mismatch")

		const promptDigest = sha256(await fs.readFile(path.join(generated.fixture, "prompt.md")))
		const badFixtureDigest = `sha256:${"1".repeat(64)}`
		await writeSuite([
			{
				...generated.task,
				promptDigest,
				fixtureDigest: badFixtureDigest,
				repository: { ...generated.task.repository, snapshotDigest: badFixtureDigest },
			},
		])
		await expect(loadBenchmarkCatalog(root)).rejects.toThrow("Fixture digest mismatch")
	})

	it("rejects paths escaping the benchmark root", async () => {
		const task = createTaskTemplate({ id: "unsafe-path", profile: "compact" })
		await writeSuite([{ ...task, fixture: "../outside" }])
		await expect(loadBenchmarkCatalog(root)).rejects.toThrow("Path escapes benchmark root")
	})

	it("verifies private references using only the public bundle registry", async () => {
		const bundleDigest = `sha256:${"a".repeat(64)}`
		await fs.writeFile(
			path.join(root, "private-bundles.yaml"),
			stringify({ schemaVersion: 1, bundles: [{ id: "private-v1", version: 3, contentDigest: bundleDigest }] }),
		)
		const base = createTaskTemplate({ id: "holdout-reference", profile: "compact" })
		const graders = [
			{
				id: "private",
				version: 1,
				alias: "hidden_tests",
				bundleId: "private-v1",
				bundleVersion: 3,
				bundleDigest,
			},
		]
		const task = {
			...base,
			partition: "holdout" as const,
			fixture: "tasks/holdout-reference/workspace",
			graders,
			graderReferenceDigest: sha256(canonicalJson(graders)),
		}
		await writeSuite([task])
		await expect(loadBenchmarkCatalog(root)).resolves.toMatchObject({ tasks: expect.any(Map) })

		const mismatched = graders.map((grader) => ({ ...grader, bundleDigest: `sha256:${"b".repeat(64)}` }))
		await writeSuite([{ ...task, graders: mismatched, graderReferenceDigest: sha256(canonicalJson(mismatched)) }])
		await expect(loadBenchmarkCatalog(root)).rejects.toThrow("Private bundle reference mismatch")
	})

	it("rejects mutation of a released suite version", async () => {
		const generated = await writeTaskTemplate(root, { id: "released-smoke", profile: "compact" })
		const task = { ...generated.task, partition: "smoke" as const }
		const suite = await writeSuite([task], "released")
		await writeBenchmarkReleaseLock(root, suite, "2026-07-13T00:00:00.000Z")
		await expect(loadBenchmarkCatalog(root)).resolves.toMatchObject({ tasks: expect.any(Map) })

		await writeSuite([{ ...task, budgets: { ...task.budgets, toolCalls: task.budgets.toolCalls + 1 } }], "released")
		await expect(loadBenchmarkCatalog(root)).rejects.toThrow("modified in place")
	})

	it("detects opaque duplicate gold and grader fingerprints without reading private assets", async () => {
		const first = await writeTaskTemplate(root, { id: "fingerprint-one", profile: "compact" })
		const second = await writeTaskTemplate(root, { id: "fingerprint-two", profile: "long" })
		await fs.writeFile(
			path.join(root, second.task.fixture, "src", "workflow.js"),
			"export function different() { return 'different' }\n",
		)
		await fs.writeFile(
			path.join(root, second.task.fixture, "test", "workflow.test.js"),
			"import test from 'node:test'\ntest('different', () => {})\n",
		)
		await writeSuite([first.task, second.task])
		const fingerprints = path.join(root, "private-fingerprints.json")
		await fs.writeFile(
			fingerprints,
			JSON.stringify({
				schemaVersion: 1,
				tasks: ["fingerprint-one@1", "fingerprint-two@1"].map((taskIdentity) => ({
					taskIdentity,
					goldDiffDigest: `sha256:${"c".repeat(64)}`,
					graderStructureDigest: `sha256:${"d".repeat(64)}`,
				})),
			}),
		)
		const report = await runAuthoringCheck({ publicRoot: root, privateFingerprintsFile: fingerprints })
		expect(report.similarity.privateDuplicatePairs).toHaveLength(2)
		expect(report.issues.some(({ code }) => code === "private_fingerprint_duplicate")).toBe(true)
	})

	it("rejects opaque fingerprints for unknown public identities", async () => {
		const generated = await writeTaskTemplate(root, { id: "known-task", profile: "compact" })
		await writeSuite([generated.task])
		const fingerprints = path.join(root, "private-fingerprints.json")
		await fs.writeFile(
			fingerprints,
			JSON.stringify({
				schemaVersion: 1,
				tasks: [
					{
						taskIdentity: "unknown-task@1",
						goldDiffDigest: `sha256:${"e".repeat(64)}`,
						graderStructureDigest: `sha256:${"f".repeat(64)}`,
					},
				],
			}),
		)
		const report = await runAuthoringCheck({ publicRoot: root, privateFingerprintsFile: fingerprints })
		expect(report.issues).toContainEqual(expect.objectContaining({ code: "unknown_private_fingerprint_identity" }))
	})
})

async function writeSuite(
	tasks: BenchmarkTaskManifest[],
	status: BenchmarkSuiteManifest["status"] = "draft",
): Promise<BenchmarkSuiteManifest> {
	const suite: BenchmarkSuiteManifest = {
		schemaVersion: 1,
		id: "authoring-suite",
		version: 1,
		status,
		primaryModel: "luna-high",
		referenceModel: "sol-high",
		tasks,
	}
	await fs.writeFile(path.join(root, "suite.yaml"), stringify(suite, { lineWidth: 120 }))
	return suite
}
