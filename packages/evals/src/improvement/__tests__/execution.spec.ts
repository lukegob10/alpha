import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	captureExpectedNodeTestCommands,
	inspectNodeTestCompletion,
	nodeTestCompletionCommand,
} from "../../grading/nodeTestCompletion"
import { ContainerCleanupError } from "../../infrastructure/index"
import type { HarnessProcessResult, HarnessProcessRunner, HarnessProcessSpec } from "../../orchestration/ports"
import { ExecaHarnessProcessRunner } from "../../orchestration/processRunner"
import { createRegressionExecutionBoundary, regressionExecutionConfigurationSchema } from "../execution"

const imageId = `sha256:${"a".repeat(64)}`
const configuration = {
	image: `node:24@sha256:${"b".repeat(64)}`,
	limits: { cpus: 0.5, memoryBytes: 256 * 1024 * 1024, pids: 32, timeoutMs: 15_000 },
}
const policyDigest = `sha256:${"c".repeat(64)}`
const helpers = path.dirname(fileURLToPath(new URL("../../grading/nodeTestExecution.mjs", import.meta.url)))
const success = (stdout = ""): HarnessProcessResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
	durationMs: 1,
	timedOut: false,
	outputTruncated: false,
})
const receipt = (file = "/alpha-grader/nodeTestContext.cjs", completion = "/workspace/test/behavior.test.mjs") => ({
	schemaVersion: 1,
	kind: "alpha-expected-node-tests",
	complete: true,
	failed: false,
	timedOut: false,
	tests: [{ file, name: "accepts reference", passed: true, skipped: false, todo: false }],
	completions: [{ kind: "alpha-original-assertions", file: completion, name: "accepts reference" }],
})

class FakeDockerRunner implements HarnessProcessRunner {
	readonly calls: HarnessProcessSpec[] = []
	image = success(JSON.stringify([{ Id: imageId, Os: "linux", Config: {} }]))
	probe = success(JSON.stringify({ node: "24.21.0", platform: "linux" }))
	lists: HarnessProcessResult[] = []
	execute: (spec: HarnessProcessSpec) => Promise<HarnessProcessResult> = async () =>
		success(JSON.stringify(receipt()))
	async run(spec: HarnessProcessSpec): Promise<HarnessProcessResult> {
		this.calls.push(spec)
		if (spec.args[0] === "image") return this.image
		if (spec.args[0] === "run") return spec.args.includes("-p") ? this.probe : this.execute(spec)
		if (spec.args[0] === "ps") return this.lists.shift() ?? success()
		if (spec.args[0] === "rm") return success()
		throw new Error("Unexpected Docker transport command")
	}
	generatedCalls() {
		return this.calls.filter(({ args }) => args.includes("/alpha-grader/nodeTestExecution.mjs"))
	}
}

let root: string
let workspace: string
let runner: FakeDockerRunner
let spec: HarnessProcessSpec
let expected: Awaited<ReturnType<typeof captureExpectedNodeTestCommands>>

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "regression-execution-")))
	workspace = path.join(root, "verification-owned", "reference")
	await fs.mkdir(path.join(workspace, "test"), { recursive: true })
	await fs.writeFile(
		path.join(workspace, "test/behavior.test.mjs"),
		`import test from "node:test"\nimport assert from "node:assert/strict"\ntest("accepts reference", () => { assert.equal(1, 1, "CONTROL_ASSERTION") })\n`,
	)
	expected = await captureExpectedNodeTestCommands(workspace, [
		{ command: "node", args: ["--test", "test/behavior.test.mjs"] },
	])
	spec = {
		...nodeTestCompletionCommand(expected[0]!, workspace, 15_000),
		cwd: workspace,
		timeoutMs: 15_000,
		maxOutputBytes: 65_536,
	}
	runner = new FakeDockerRunner()
})
afterEach(async () => {
	vi.unstubAllEnvs()
	if (root) await fs.rm(root, { recursive: true, force: true })
})

const boundary = () =>
	createRegressionExecutionBoundary({ configuration, ownedRoot: root, policyDigest, processRunner: runner })

describe("isolated regression execution", () => {
	it("uses a locally inspected immutable Node24 image with only owned fixture and immutable helper mounts", async () => {
		vi.stubEnv("OPENAI_API_KEY", "must-not-inherit-api-key")
		vi.stubEnv("DOCKER_HOST", "tcp://untrusted.example:2375")
		vi.stubEnv("DOCKER_CONFIG", "untrusted-context-and-auth")
		const isolated = await boundary()
		expect(isolated).toMatchObject({ policyDigest, network: "disabled" })
		await isolated.processRunner.run(spec)
		const call = runner.generatedCalls()[0]!
		expect(call.args).toEqual(
			expect.arrayContaining([
				"--pull",
				"never",
				"--network",
				"none",
				"--read-only",
				"--cap-drop",
				"ALL",
				"no-new-privileges=true",
				"--cpus",
				"0.5",
				"--memory",
				String(configuration.limits.memoryBytes),
				"--pids-limit",
				"32",
			]),
		)
		expect(call.args).toContain(imageId)
		expect(call.args).not.toContain(configuration.image)
		expect(call.args).toContain("/usr/bin/env")
		expect(call.args).toContain("-i")
		expect(call.args).not.toContain("--env")
		const mounts = call.args.flatMap((value, index) => (value === "--mount" ? [call.args[index + 1]!] : []))
		expect(mounts).toHaveLength(2)
		expect(mounts[0]).toBe(`type=bind,src=${workspace},dst=/workspace`)
		expect(mounts[1]).toMatch(/,dst=\/alpha-grader,readonly$/)
		const helperSnapshot = mounts[1]!.slice("type=bind,src=".length).split(",dst=")[0]!
		expect(await fs.readdir(helperSnapshot)).toEqual([
			"nodeTestAssertions.cjs",
			"nodeTestContext.cjs",
			"nodeTestExecution.mjs",
		])
		for (const file of await fs.readdir(helperSnapshot))
			expect(await fs.readFile(path.join(helperSnapshot, file))).toEqual(
				await fs.readFile(path.join(helpers, file)),
			)
		for (const transport of runner.calls) {
			expect(transport.command).toBe("docker")
			expect(Object.keys(transport.env!)).toEqual(expect.arrayContaining(["DOCKER_CONFIG"]))
			expect(transport.env).not.toHaveProperty("OPENAI_API_KEY")
			expect(transport.env).not.toHaveProperty("DOCKER_HOST")
			expect(transport.env!.DOCKER_CONFIG).not.toBe("untrusted-context-and-auth")
			expect(await fs.readdir(transport.env!.DOCKER_CONFIG!)).toEqual([])
		}
		expect(JSON.stringify(runner.calls)).not.toContain("must-not-inherit-api-key")
		expect(runner.calls.some(({ args }) => args[0] === "pull")).toBe(false)
	})

	it.each(["passed", "failed"] as const)(
		"maps the real helper contract and %s receipt without changing its verdict",
		async (verdict) => {
			if (verdict === "failed") {
				await fs.writeFile(
					path.join(workspace, "test/behavior.test.mjs"),
					`import test from "node:test"\nimport assert from "node:assert/strict"\ntest("accepts reference", () => { assert.equal(1, 2, "CONTROL_ASSERTION") })\n`,
				)
				expected = await captureExpectedNodeTestCommands(workspace, [
					{ command: "node", args: ["--test", "test/behavior.test.mjs"] },
				])
				spec = { ...spec, ...nodeTestCompletionCommand(expected[0]!, workspace, 15_000) }
			}
			let original: Record<string, unknown> | undefined
			runner.execute = async (call) => {
				const index = call.args.indexOf("/alpha-grader/nodeTestExecution.mjs")
				const mapped = JSON.parse(call.args[index + 1]!)
				expect(mapped.expected[0].file).toBe("/workspace/test/behavior.test.mjs")
				expect(mapped.sourceDigests[0]).toEqual({
					file: "/workspace/test/behavior.test.mjs",
					digest: expected[0]!.testExecution!.sourceDigests![0]!.digest,
				})
				const local = await new ExecaHarnessProcessRunner().run({ ...spec, env: {} })
				original = JSON.parse(local.fullStdout ?? local.stdout)
				const containerPath = (file: string) =>
					path.posix.join(
						file.startsWith(workspace) ? "/workspace" : "/alpha-grader",
						...path.relative(file.startsWith(workspace) ? workspace : helpers, file).split(path.sep),
					)
				const container = {
					...original,
					tests: (original!.tests as Array<{ file: string }>).map((entry) => ({
						...entry,
						file: containerPath(entry.file),
					})),
					completions: (original!.completions as Array<{ file: string }>).map((entry) => ({
						...entry,
						file: containerPath(entry.file),
					})),
				}
				return { ...local, stdout: JSON.stringify(container), fullStdout: JSON.stringify(container) }
			}
			const result = await (await boundary()).processRunner.run(spec)
			expect(
				inspectNodeTestCompletion(
					result.fullStdout ?? result.stdout,
					expected[0]!.testExecution!.expectedTests,
					workspace,
				),
			).toBe(verdict)
			const mapped = JSON.parse(result.fullStdout ?? result.stdout)
			expect({ complete: mapped.complete, failed: mapped.failed, timedOut: mapped.timedOut }).toEqual({
				complete: original!.complete,
				failed: original!.failed,
				timedOut: original!.timedOut,
			})
			expect(result.stderr).toEqual(verdict === "passed" ? "" : expect.stringContaining("CONTROL_ASSERTION"))
		},
	)

	it.each(["node:24", "node:latest", "node:24@sha256:bad"])(
		"rejects unpinned image %s before process execution",
		async (image) => {
			await expect(
				createRegressionExecutionBoundary({
					configuration: { ...configuration, image },
					ownedRoot: root,
					policyDigest,
					processRunner: runner,
				}),
			).rejects.toThrow()
			expect(runner.calls).toHaveLength(0)
		},
	)

	it("rejects configuration environment and unbounded resource injection", () => {
		expect(
			regressionExecutionConfigurationSchema.safeParse({
				...configuration,
				env: { NODE_OPTIONS: "--import=/outside" },
			}).success,
		).toBe(false)
		expect(
			regressionExecutionConfigurationSchema.safeParse({
				...configuration,
				limits: { ...configuration.limits, timeoutMs: 0 },
			}).success,
		).toBe(false)
		expect(
			regressionExecutionConfigurationSchema.safeParse({
				...configuration,
				limits: { ...configuration.limits, pids: 100_000 },
			}).success,
		).toBe(false)
	})

	it("fails closed when Docker, the local image, or Node24 is unavailable", async () => {
		runner.image = { ...success(), exitCode: 1, stderr: "No such image" }
		await expect(boundary()).rejects.toThrow("not available locally")
		expect(runner.calls).toHaveLength(1)
		expect(await fs.readdir(root)).toEqual(["verification-owned"])
		runner.image = success(JSON.stringify([{ Id: imageId, Os: "linux" }]))
		runner.probe = success(JSON.stringify({ node: "22.0.0", platform: "linux" }))
		await expect(boundary()).rejects.toThrow()
		expect(runner.generatedCalls()).toHaveLength(0)
		runner.run = async () => {
			throw new Error("Docker unavailable")
		}
		await expect(boundary()).rejects.toThrow("Docker unavailable")
		expect(await fs.readdir(root)).toEqual(["verification-owned"])
	})

	it("disposes only its exclusive runtime directories and rejects later dispatch", async () => {
		const isolated = await boundary()
		expect(await fs.readdir(root)).toHaveLength(3)
		await isolated.dispose()
		await isolated.dispose()
		expect(await fs.readdir(root)).toEqual(["verification-owned"])
		expect(await fs.readFile(path.join(workspace, "test/behavior.test.mjs"), "utf8")).toContain("CONTROL_ASSERTION")
		const calls = runner.calls.length
		await expect(isolated.processRunner.run(spec)).rejects.toThrow("disposed")
		expect(runner.calls).toHaveLength(calls)
	})

	it("rejects image-declared extra writable volumes", async () => {
		runner.image = success(JSON.stringify([{ Id: imageId, Os: "linux", Config: { Volumes: { "/outside": {} } } }]))
		await expect(boundary()).rejects.toThrow("additional writable volumes")
		expect(runner.calls).toHaveLength(1)
	})

	it.each([
		"environment",
		"python",
		"raw-node",
		"external-workspace",
		"external-test",
		"traversal",
		"missing-source",
		"timeout",
	])("rejects unsupported %s before generated execution", async (kind) => {
		const isolated = await boundary()
		const modified = { ...spec, args: [...spec.args] }
		const contract = JSON.parse(modified.args[1]!)
		if (kind === "environment") modified.env = { NODE_OPTIONS: "--import=/outside", OPENAI_API_KEY: "injected" }
		if (kind === "python") modified.command = "python"
		if (kind === "raw-node") modified.args = ["--test", "test/behavior.test.mjs"]
		if (kind === "external-workspace") modified.cwd = path.dirname(root)
		if (kind === "external-test") {
			contract.expected[0].file = path.join(root, "outside.test.mjs")
			modified.args[1] = JSON.stringify(contract)
		}
		if (kind === "traversal") {
			contract.sourceDigests[0].file =
				path.join(workspace, "test") + `${path.sep}..${path.sep}test${path.sep}behavior.test.mjs`
			modified.args[1] = JSON.stringify(contract)
		}
		if (kind === "missing-source") {
			contract.sourceDigests = []
			modified.args[1] = JSON.stringify(contract)
		}
		if (kind === "timeout") modified.timeoutMs = 60_001
		await expect(isolated.processRunner.run(modified)).rejects.toThrow()
		expect(runner.generatedCalls()).toHaveLength(0)
	})

	it.each([
		"/workspace/../outside",
		"/etc/passwd",
		"/workspace/test/../../outside",
		"/workspace/..\\outside",
		"/workspace/test\\behavior.test.mjs",
		"/workspace/test:alias",
		"/workspace/test\0alias",
	])("rejects external or traversal receipt path %s after cleanup", async (file) => {
		const isolated = await boundary()
		runner.execute = async () => success(JSON.stringify(receipt(file)))
		await expect(isolated.processRunner.run(spec)).rejects.toThrow("receipt")
		expect(runner.calls.at(-1)!.args[0]).toBe("ps")
	})

	it("preserves timeout failure and verifies exact-owner cleanup", async () => {
		const isolated = await boundary()
		runner.execute = async () => ({ ...success(), exitCode: null, timedOut: true })
		runner.lists = [
			success(
				JSON.stringify({ ID: "owned", Names: "control", Status: "Up", Labels: "alpha.evals.managed=true" }),
			),
			success(),
		]
		expect(await isolated.processRunner.run(spec)).toMatchObject({ exitCode: null, timedOut: true })
		const command = runner.generatedCalls()[0]!
		const owner = command.args.find((value) => value.startsWith("alpha.evals.attempt-id="))!
		expect(runner.calls.at(-3)!.args).toContain(`label=${owner}`)
		expect(runner.calls.at(-2)!.args).toEqual(["rm", "--force", "owned"])
		expect(runner.calls.at(-1)!.args[0]).toBe("ps")
	})

	it("fails closed when owned cleanup cannot be established", async () => {
		const isolated = await boundary()
		const row = success(
			JSON.stringify({ ID: "owned", Names: "control", Status: "Up", Labels: "alpha.evals.managed=true" }),
		)
		runner.lists = [row, row]
		await expect(isolated.processRunner.run(spec)).rejects.toBeInstanceOf(ContainerCleanupError)
		const calls = runner.calls.length
		await expect(isolated.processRunner.run(spec)).rejects.toBeInstanceOf(ContainerCleanupError)
		expect(runner.calls).toHaveLength(calls)
	})

	it("propagates cancellation and still cleans without an aborted cleanup signal", async () => {
		const controller = new AbortController()
		const isolated = await createRegressionExecutionBoundary({
			configuration,
			ownedRoot: root,
			policyDigest,
			processRunner: runner,
			signal: controller.signal,
		})
		expect(runner.calls.find(({ args }) => args[0] === "image")!.signal).toBe(controller.signal)
		expect(runner.calls.find(({ args }) => args[0] === "run")!.signal).toBe(controller.signal)
		runner.execute = async (call) => {
			expect(call.signal).toBe(controller.signal)
			controller.abort()
			throw new Error("interrupted")
		}
		await expect(isolated.processRunner.run(spec)).rejects.toThrow("interrupted")
		expect(runner.calls.at(-1)!.args[0]).toBe("ps")
		expect(runner.calls.at(-1)!.signal).toBeUndefined()
		const calls = runner.calls.length
		await expect(isolated.processRunner.run(spec)).rejects.toThrow()
		expect(runner.calls).toHaveLength(calls)
	})

	it("stops setup before launching a probe when inspection is cancelled", async () => {
		const controller = new AbortController()
		const run = runner.run.bind(runner)
		runner.run = async (call) => {
			const result = await run(call)
			controller.abort()
			return result
		}
		await expect(
			createRegressionExecutionBoundary({
				configuration,
				ownedRoot: root,
				policyDigest,
				processRunner: runner,
				signal: controller.signal,
			}),
		).rejects.toThrow()
		expect(runner.calls.map(({ args }) => args[0])).toEqual(["image"])
	})

	it("rejects mixed separator payloads that would traverse on Windows regardless of the test OS", async () => {
		expect(path.win32.resolve("C:\\fixture", "..\\outside")).toBe("C:\\outside")
		const isolated = await boundary()
		runner.execute = async () => success(JSON.stringify(receipt("/workspace/..\\outside")))
		await expect(isolated.processRunner.run(spec)).rejects.toThrow("untrusted file path")
	})
})
