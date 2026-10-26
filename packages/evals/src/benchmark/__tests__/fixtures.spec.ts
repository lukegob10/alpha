import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { HarnessProcessResult, HarnessProcessRunner } from "../../orchestration/index"
import type { BenchmarkCatalog, BenchmarkSuiteManifest } from "../contracts"
import { certifyInitialFixtureStates } from "../fixtures"
import { createTaskTemplate } from "../templates"

let root: string

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-initial-fixture-"))
	await fs.mkdir(path.join(root, "fixture"))
	await fs.writeFile(
		path.join(root, "fixture", "checks.mjs"),
		'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("value", () => assert.equal(1, 2))\n',
	)
})

afterEach(async () =>
	fs.rm(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 3 : 0, retryDelay: 100 }),
)

function catalog(restraint = false): BenchmarkCatalog {
	const task = {
		...createTaskTemplate({ id: "initial-fixture", profile: "compact", restraint }),
		fixture: "fixture",
		validation: { commands: [{ command: "node", args: ["--test", "checks.mjs"] }], network: "disabled" as const },
	}
	const suite: BenchmarkSuiteManifest = {
		schemaVersion: 1,
		id: "initial-fixture",
		version: 1,
		status: "draft",
		primaryModel: "luna-high",
		referenceModel: "luna-high",
		tasks: [task],
	}
	return { suites: [suite], tasks: new Map([[`${task.id}@${task.version}`, { task, suite }]]) }
}

const processResult = (value: Partial<HarnessProcessResult>): HarnessProcessResult => ({
	exitCode: 0,
	stdout: "",
	stderr: "",
	durationMs: 0,
	timedOut: false,
	outputTruncated: false,
	...value,
})

describe("initial fixture verification", () => {
	it.each([
		{ exitCode: null, timedOut: true },
		{ exitCode: null },
		{ exitCode: 1, stderr: "SyntaxError: malformed verifier" },
		{ exitCode: 1, stderr: "Error: Cannot find module fixture" },
		{ exitCode: 127, stderr: "node: command not found" },
		{ exitCode: 0, outputTruncated: true },
	])("does not certify incomplete or infrastructure failure %j", async (result) => {
		const runner: HarnessProcessRunner = { run: async () => processResult(result) }
		const report = await certifyInitialFixtureStates({
			catalog: catalog(),
			publicRoot: root,
			processRunner: runner,
			concurrency: 1,
		})
		expect(report.valid).toBe(false)
		expect(report.results[0]?.declaredStateValid).toBe(false)
	})

	it("certifies an actual original assertion failure", async () => {
		expect(
			await certifyInitialFixtureStates({ catalog: catalog(), publicRoot: root, concurrency: 1 }),
		).toMatchObject({
			valid: true,
		})
	})

	it.each([
		{ prefix: "const invalid = ;", suffix: "" },
		{ prefix: 'throw new Error("verifier failed to load")', suffix: "" },
		{ prefix: "", suffix: 'test("runtime error", () => { assert.ok(true); throw new Error("verifier error") })' },
	])("rejects verifier errors even alongside failed assertions: %j", async ({ prefix, suffix }) => {
		const assertions = await fs.readFile(path.join(root, "fixture", "checks.mjs"), "utf8")
		await fs.writeFile(path.join(root, "fixture", "checks.mjs"), `${prefix}\n${assertions}\n${suffix}\n`)
		expect(
			await certifyInitialFixtureStates({ catalog: catalog(), publicRoot: root, concurrency: 1 }),
		).toMatchObject({
			valid: false,
		})
	})

	it("requires a complete passing verification for a restraint task", async () => {
		await fs.writeFile(
			path.join(root, "fixture", "checks.mjs"),
			'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("value", () => assert.equal(1, 1))\n',
		)
		expect(
			await certifyInitialFixtureStates({ catalog: catalog(true), publicRoot: root, concurrency: 1 }),
		).toMatchObject({
			valid: true,
		})
	})

	it.each([
		{ summary: "FAILED (failures=2)", valid: true },
		{ summary: "FAILED (errors=1)", valid: false },
		{ summary: "FAILED (failures=2, errors=1)", valid: false },
		{ summary: "ModuleNotFoundError: no verifier", valid: false },
	])("distinguishes Python unittest assertions from verifier errors: $summary", async ({ summary, valid }) => {
		const fixtures = catalog()
		fixtures.tasks.values().next().value!.task.validation.commands = [
			{ command: "python", args: ["-B", "-m", "unittest", "discover", "-s", "test", "-v"] },
		]
		const runner: HarnessProcessRunner = {
			run: async () => processResult({ exitCode: 1, stderr: `Ran 3 tests in 0.001s\n\n${summary}\n` }),
		}
		expect(
			await certifyInitialFixtureStates({
				catalog: fixtures,
				publicRoot: root,
				processRunner: runner,
				concurrency: 1,
			}),
		).toMatchObject({ valid })
	})
})
