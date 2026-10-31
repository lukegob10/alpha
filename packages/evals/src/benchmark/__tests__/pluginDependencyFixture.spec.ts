import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { parse } from "yaml"

import {
	captureExpectedNodeTestCommands,
	hasNodeTestAssertionFailure,
	inspectNodeTestCompletion,
	nodeTestCompletionCommand,
} from "../../grading/nodeTestCompletion"
import { ExecaHarnessProcessRunner } from "../../orchestration/index"
import { resolveCalibrationReportPath } from "../calibrationStore"
import { benchmarkSuiteManifestSchema } from "../contracts"
import { digestBenchmarkDirectory, loadBenchmarkCatalog } from "../loader"

const evalRoot = path.resolve(process.cwd(), "../../evals")
const fixture = path.join(evalRoot, "javascript/repo-plugin-dependency-cycle-v2")
const originalFixture = path.join(evalRoot, "javascript/repo-plugin-dependency-cycle")
const reference = `export function loadPlugins(plugins) {
	const definitions = new Map(plugins.map((plugin) => [plugin.name, plugin]))
	const loaded = new Set()
	const visiting = []
	const names = []
	function visit(name) {
		if (loaded.has(name)) return
		const cycle = visiting.indexOf(name)
		if (cycle >= 0) throw Error(visiting.slice(cycle).concat(name).join(" -> "))
		const plugin = definitions.get(name)
		if (!plugin) throw Error("missing " + name)
		visiting.push(name)
		for (const dependency of plugin.requires ?? []) visit(dependency)
		for (const dependency of plugin.optional ?? []) if (definitions.has(dependency)) visit(dependency)
		visiting.pop()
		loaded.add(name)
		names.push(name)
	}
	for (const plugin of plugins) visit(plugin.name)
	return names
}
`

describe("versioned plugin assertion ownership", () => {
	it("preserves historical inputs and keeps the new identity uncalibrated", async () => {
		const catalog = await loadBenchmarkCatalog(evalRoot)
		const active = catalog.tasks.get("repo-plugin-dependency-cycle@2")!
		const historical = benchmarkSuiteManifestSchema.parse(
			parse(await fs.readFile(path.join(evalRoot, "archive/manifests/frontier-v1@6.yaml"), "utf8"), {
				merge: true,
			}),
		)
		const previous = historical.tasks.find(({ id }) => id === active.task.id)!
		expect(historical.version).toBe(6)
		expect(previous).toMatchObject({ version: 1, fixture: "javascript/repo-plugin-dependency-cycle" })
		expect(active.suite).toMatchObject({ version: 7, status: "calibrating" })
		expect(active.task).toMatchObject({
			version: 2,
			admission: "calibrating",
			fixture: "javascript/repo-plugin-dependency-cycle-v2",
		})
		expect(await digestBenchmarkDirectory(originalFixture)).toBe(previous.fixtureDigest)
		expect(await digestBenchmarkDirectory(fixture)).toBe(active.task.fixtureDigest)
		expect(active.task.fixtureDigest).not.toBe(previous.fixtureDigest)
		expect(active.task.promptDigest).toBe(previous.promptDigest)
		expect(await fs.readFile(path.join(fixture, "src/plugins.js"))).toEqual(
			await fs.readFile(path.join(originalFixture, "src/plugins.js")),
		)
		const calibrationDirectory = path.join(evalRoot, "calibration")
		const calibration = JSON.parse(
			await fs.readFile(path.join(calibrationDirectory, "repo-plugin-dependency-cycle.keyless.json"), "utf8"),
		)
		expect(calibration.taskIdentity).toBe("repo-plugin-dependency-cycle@1")
		const fresh = await resolveCalibrationReportPath(calibrationDirectory, "repo-plugin-dependency-cycle@2", {
			write: true,
		})
		expect(fresh).toBe(path.join(calibrationDirectory, "repo-plugin-dependency-cycle@2.keyless.json"))
		await expect(fs.stat(fresh)).rejects.toHaveProperty("code", "ENOENT")
		const previousSubset = parse(await fs.readFile(path.join(evalRoot, "subsets/frontier-t1-v6.yaml"), "utf8"))
		const activeSubset = parse(await fs.readFile(path.join(evalRoot, "subsets/frontier-t1-v7.yaml"), "utf8"))
		expect(activeSubset).toEqual({ ...previousSubset, suiteIdentity: "frontier-v1@7" })
	})

	it("authenticates the untouched failure and accepts an actual reference implementation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-plugin-v2-"))
		try {
			const runner = new ExecaHarnessProcessRunner()
			for (const [name, source] of [
				["untouched", undefined],
				["reference", reference],
			] as const) {
				const workspace = path.join(root, name)
				await fs.cp(fixture, workspace, { recursive: true })
				// Freeze the independent verifier before changing only the candidate implementation.
				const [command] = await captureExpectedNodeTestCommands(workspace, [
					{ command: "node", args: ["--test", "test/behavior.test.js"] },
				])
				expect(command!.testExecution!.expectedTests.map(({ assertions }) => assertions)).toEqual([2, 1])
				if (source) await fs.writeFile(path.join(workspace, "src/plugins.js"), source)
				const execution = nodeTestCompletionCommand(command!, workspace, 15_000)
				const result = await runner.run({
					...execution,
					cwd: workspace,
					timeoutMs: 15_000,
					maxOutputBytes: 64_000,
				})
				expect(result.exitCode, name).toBe(0)
				expect(result.timedOut, name).toBe(false)
				expect(result.outputTruncated, name).toBe(false)
				const output = result.fullStdout ?? result.stdout
				const expected = command!.testExecution!.expectedTests
				expect(inspectNodeTestCompletion(output, expected, workspace), name).toBe(source ? "passed" : "failed")
				expect(hasNodeTestAssertionFailure(output, expected), name).toBe(!source)
				const receipt = JSON.parse(output)
				expect(receipt).toMatchObject({ complete: true, failed: !source, timedOut: false })
				if (source) expect(receipt.completions).toHaveLength(2)
				else
					expect(receipt.assertionFailures.map(({ name }: { name: string }) => name)).toEqual(
						expect.arrayContaining(expected.map(({ name }) => name)),
					)
			}
		} finally {
			await removeOwnedPluginFixture(root)
		}
	})
})

async function removeOwnedPluginFixture(root: string): Promise<void> {
	const resolved = await fs.realpath(root)
	if (
		path.dirname(resolved) !== (await fs.realpath(os.tmpdir())) ||
		!path.basename(resolved).startsWith("alpha-plugin-v2-")
	)
		throw new Error("Unexpected plugin fixture cleanup path")
	await fs.rm(resolved, {
		recursive: true,
		force: true,
		maxRetries: process.platform === "win32" ? 3 : 0,
		retryDelay: 100,
	})
}
