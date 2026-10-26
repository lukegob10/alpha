import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { ExecaHarnessProcessRunner, systemClock } from "../../orchestration/index"
import { resolveGraderAlias, resolveTaskGraderSpecs, taskGradingTimeoutMs } from "../catalog"
import { inspectPrivateDecision } from "../privateDecision"
import { createDefaultGraderRegistry } from "../registry"
import { validateGraderSpec } from "../validation"

function frame(decisionCode = "passed") {
	return JSON.stringify({
		schemaVersion: 1,
		passed: decisionCode === "passed",
		decisionCode,
		evidenceDigest: `sha256:${"a".repeat(64)}`,
		diagnostic: decisionCode === "passed" ? "" : "decision details remain private",
	})
}

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe("private grader decisions", () => {
	it.each(["", "\n", "\r\n"])("accepts the compact decision with terminator %j", (suffix) => {
		expect(inspectPrivateDecision(frame() + suffix, 0)).toBe("passed")
		expect(inspectPrivateDecision(frame("case-regression") + suffix, 1)).toBe("failed")
		expect(inspectPrivateDecision(frame("infrastructure-sandbox-start") + suffix, 2)).toBe("error")
	})

	it.each([
		["", 0],
		["{}", 0],
		[frame() + "\n" + frame(), 0],
		[frame().replace('{"schemaVersion":1,', '{"schemaVersion":1,"schemaVersion":1,'), 0],
		[frame().replace('"passed":true', '"passed":false'), 0],
		[frame().replace('"schemaVersion":1', '"schemaVersion":2'), 0],
		[frame().replace('"diagnostic":""', '"diagnostic":"","extra":true'), 0],
		[frame().replace('"diagnostic":""', `"diagnostic":"${"x".repeat(257)}"`), 0],
		[frame().replace('"diagnostic":""', `"diagnostic":"${"x".repeat(2048)}"`), 0],
		[" " + frame(), 0],
		[frame(), 1],
		[frame("case-regression"), 0],
		[frame("infrastructure-sandbox-start"), 1],
		[frame("case-regression"), 2],
	] as const)("rejects malformed or inconsistent output %#", (stdout, exitCode) => {
		expect(() => inspectPrivateDecision(stdout, exitCode)).toThrow("Invalid private grader decision")
	})

	it.each([
		["passed", 0, "passed", undefined],
		["case-regression", 1, "outcome_failed", "private_grader_rejected"],
		["infrastructure-sandbox-client-timeout", 2, "grader_error", "private_grader_infrastructure"],
		["case-regression", 2, "grader_error", "private_grader_protocol_error"],
	] as const)("executes %s through the production command runner", async (code, exitCode, decision, diagnostic) => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-private-decision-"))
		roots.push(root)
		const workspaceRoot = path.join(root, "workspace"),
			hiddenRoot = path.join(root, "hidden")
		await fs.mkdir(workspaceRoot)
		await fs.mkdir(hiddenRoot)
		await fs.writeFile(
			path.join(hiddenRoot, "grader.mjs"),
			`if(process.execPath!==${JSON.stringify(process.execPath)})throw new Error('Wrong controller runtime');process.stdout.write(${JSON.stringify(frame(code) + "\n")});process.exitCode=${exitCode}`,
		)
		const spec = resolveGraderAlias({ alias: "hidden_tests", taskId: "task", privateEntrypoint: "grader.mjs" })
		const run = await createDefaultGraderRegistry().execute([spec], {
			workspaceRoot,
			hiddenRoot,
			changedPaths: [],
			trace: [],
			processRunner: new ExecaHarnessProcessRunner(),
			clock: systemClock,
		})
		expect(run.decision).toBe(decision)
		if (diagnostic)
			expect(run.results[0]!.diagnostics).toEqual([
				expect.objectContaining({ code: diagnostic, message: expect.not.stringContaining("decision details") }),
			])
	})

	it.each([
		{
			label: "incomplete pass",
			fullStdout: undefined,
			stdout: frame(),
			exitCode: 0,
			decision: "grader_error",
			diagnostic: "private_grader_protocol_error",
		},
		{
			label: "incomplete candidate failure",
			fullStdout: undefined,
			stdout: frame("case-regression"),
			exitCode: 1,
			decision: "grader_error",
			diagnostic: "private_grader_protocol_error",
		},
		{
			label: "complete pass",
			fullStdout: frame(),
			stdout: frame(),
			exitCode: 0,
			decision: "passed",
			diagnostic: undefined,
		},
		{
			label: "complete candidate failure",
			fullStdout: frame("case-regression"),
			stdout: frame(),
			exitCode: 1,
			decision: "outcome_failed",
			diagnostic: "private_grader_rejected",
		},
		{
			label: "complete infrastructure failure",
			fullStdout: frame("infrastructure-sandbox-start"),
			stdout: frame(),
			exitCode: 2,
			decision: "grader_error",
			diagnostic: "private_grader_infrastructure",
		},
		{
			label: "complete protocol failure",
			fullStdout: frame() + "\nextra",
			stdout: frame(),
			exitCode: 0,
			decision: "grader_error",
			diagnostic: "private_grader_protocol_error",
		},
	] as const)("requires complete private decision output from the runner port: $label", async (receipt) => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-private-decision-port-"))
		roots.push(root)
		const workspaceRoot = path.join(root, "workspace")
		const hiddenRoot = path.join(root, "hidden")
		await fs.mkdir(workspaceRoot)
		await fs.mkdir(hiddenRoot)
		const spec = resolveGraderAlias({ alias: "hidden_tests", taskId: "task", privateEntrypoint: "grader.mjs" })
		const run = await createDefaultGraderRegistry().execute([spec], {
			workspaceRoot,
			hiddenRoot,
			changedPaths: [],
			trace: [],
			processRunner: {
				run: async () => ({
					exitCode: receipt.exitCode,
					stdout: receipt.stdout,
					fullStdout: receipt.fullStdout,
					stderr: "",
					durationMs: 1,
					timedOut: false,
					outputTruncated: true,
				}),
			},
			clock: systemClock,
		})

		expect(run.decision).toBe(receipt.decision)
		expect(run.results[0]!.diagnostics.map(({ code }) => code)).toEqual(
			receipt.diagnostic ? [receipt.diagnostic] : [],
		)
	})
})

describe("private grading budgets and identity", () => {
	const task = {
		id: "task",
		budgets: { modelCalls: 1, toolCalls: 10, costUsd: 1, wallSeconds: 900 },
		validation: {
			commands: [
				{ command: "node", args: ["--test"] },
				{ command: "node", args: ["check.mjs"] },
			],
		},
		editTopology: { maxFiles: 1, allowedRoots: ["src/"] },
		graders: [
			{ id: "visible", alias: "visible_tests", version: 1 },
			{ id: "private", alias: "hidden_tests", version: 2, bundleId: "private" },
		],
	}
	it("retains the declared grader version and allows the full public wall budget", () => {
		const specs = resolveTaskGraderSpecs({
			task,
			privateGraders: [{ id: "task.private", entrypoint: "grader.mjs" }],
		})
		expect(specs[1]).toMatchObject({ version: 2, timeoutMs: 900_000, decisionFormat: "workspace-v1" })
		expect(taskGradingTimeoutMs(task)).toBe(1_260_000)
		expect(() => validateGraderSpec(specs[1]!)).not.toThrow()
		expect(() => validateGraderSpec({ ...specs[1]!, cwd: "workspace" } as (typeof specs)[number])).toThrow()
	})
	it.each([0, -1, 0.5, Infinity, NaN, 2_147_484])("rejects invalid wall budget %s", (wallSeconds) => {
		expect(() => taskGradingTimeoutMs({ ...task, budgets: { ...task.budgets, wallSeconds } })).toThrow()
	})
})
