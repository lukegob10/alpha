import { describe, expect, it, vi } from "vitest"

import type { Task } from "../../db/index"
import { ScriptedProcessRunner, VirtualClock } from "../../testing/index"
import { runUnitTest } from "../runUnitTest"
import type { Logger } from "../utils"

const benchmarkMocks = vi.hoisted(() => ({
	findBenchmarkTask: vi.fn(),
	loadPrivateGraderBundle: vi.fn(),
}))

vi.mock("../../benchmark/index", () => ({
	findBenchmarkTask: benchmarkMocks.findBenchmarkTask,
	loadPrivateGraderBundle: benchmarkMocks.loadPrivateGraderBundle,
}))

const logger = { info: vi.fn(), error: vi.fn(), raw: vi.fn(), close: vi.fn() } as unknown as Logger

function task(language: Task["language"]): Task {
	return {
		id: 1,
		runId: 1,
		taskMetricsId: null,
		language,
		exercise: "fixture",
		benchmarkTaskIdentity: null,
		benchmarkPartition: null,
		iteration: 1,
		passed: null,
		startedAt: null,
		finishedAt: null,
		createdAt: new Date(),
	}
}

describe("runUnitTest grader adapter", () => {
	beforeEach(() => {
		benchmarkMocks.findBenchmarkTask.mockImplementation(async (_root: string, fixture: string) => ({
			suite: { id: "smoke-v1" },
			task: { id: fixture.replace("/fixture", "-fixture"), graders: [{ alias: "visible_tests" }] },
		}))
		benchmarkMocks.loadPrivateGraderBundle.mockResolvedValue(undefined)
	})

	it("generates versioned JavaScript commands and persists evidence", async () => {
		const processRunner = new ScriptedProcessRunner([
			{
				type: "result",
				result: {
					exitCode: 0,
					stdout: "installed",
					stderr: "",
					durationMs: 1,
					timedOut: false,
					outputTruncated: false,
				},
			},
			{
				type: "result",
				result: {
					exitCode: 0,
					stdout: "passed",
					stderr: "",
					durationMs: 1,
					timedOut: false,
					outputTruncated: false,
				},
			},
		])
		const persist = vi.fn(async () => undefined)
		const result = await runUnitTest({
			task: task("javascript"),
			attemptId: 99,
			logger,
			processRunner,
			clock: new VirtualClock(),
			changedPaths: [],
			persist,
		})
		expect(result.decision).toBe("passed")
		expect(processRunner.calls.map(({ command, args }) => ({ command, args }))).toEqual([
			{ command: "pnpm", args: ["install"] },
			{ command: "pnpm", args: ["test"] },
		])
		expect(persist).toHaveBeenCalledWith(99, [
			expect.objectContaining({
				graderId: "javascript-fixture.visible_tests",
				graderVersion: 1,
				status: "passed",
			}),
		])
	})

	it("returns an outcome failure instead of a grader error for nonzero tests", async () => {
		const processRunner = new ScriptedProcessRunner([
			{
				type: "result",
				result: {
					exitCode: 1,
					stdout: "",
					stderr: "failed",
					durationMs: 1,
					timedOut: false,
					outputTruncated: false,
				},
			},
		])
		const result = await runUnitTest({
			task: task("go"),
			attemptId: 1,
			logger,
			processRunner,
			clock: new VirtualClock(),
			changedPaths: [],
			persist: async () => undefined,
		})
		expect(result.decision).toBe("outcome_failed")
	})

	it("uses the task manifest validation command instead of the language default", async () => {
		benchmarkMocks.findBenchmarkTask.mockResolvedValue({
			suite: { id: "frontier-v1" },
			task: {
				id: "javascript-fixture",
				validation: { commands: [{ command: "node", args: ["--test", "test/behavior.test.js"] }] },
				graders: [{ alias: "visible_tests" }],
			},
		})
		const processRunner = new ScriptedProcessRunner([
			{
				type: "result",
				result: {
					exitCode: 0,
					stdout: "passed",
					stderr: "",
					durationMs: 1,
					timedOut: false,
					outputTruncated: false,
				},
			},
		])
		await runUnitTest({
			task: task("javascript"),
			attemptId: 3,
			logger,
			processRunner,
			clock: new VirtualClock(),
			changedPaths: [],
			persist: async () => undefined,
		})
		expect(processRunner.calls).toEqual([
			expect.objectContaining({ command: "node", args: ["--test", "test/behavior.test.js"] }),
		])
	})

	it("allows a hidden deterministic grader to reject a visible-test pass", async () => {
		benchmarkMocks.findBenchmarkTask.mockResolvedValue({
			suite: { id: "frontier-v1" },
			task: {
				id: "javascript-fixture",
				graders: [
					{ id: "visible", alias: "visible_tests" },
					{ id: "private", alias: "hidden_tests", bundleId: "private" },
				],
			},
		})
		benchmarkMocks.loadPrivateGraderBundle.mockResolvedValue({
			root: "/trusted/private",
			manifest: {
				graders: [{ id: "javascript-fixture.private", entrypoint: "fixture/grader.mjs" }],
			},
		})
		const processRunner = new ScriptedProcessRunner([
			{
				type: "result",
				result: {
					exitCode: 0,
					stdout: "installed",
					stderr: "",
					durationMs: 1,
					timedOut: false,
					outputTruncated: false,
				},
			},
			{
				type: "result",
				result: {
					exitCode: 0,
					stdout: "visible passed",
					stderr: "",
					durationMs: 1,
					timedOut: false,
					outputTruncated: false,
				},
			},
			{
				type: "result",
				result: {
					exitCode: 1,
					stdout: "",
					stderr: "hidden edge failed",
					durationMs: 1,
					timedOut: false,
					outputTruncated: false,
				},
			},
		])
		const result = await runUnitTest({
			task: task("javascript"),
			attemptId: 2,
			logger,
			workspaceRoot: "/agent/workspace",
			processRunner,
			clock: new VirtualClock(),
			changedPaths: ["src/index.js"],
			persist: async () => undefined,
		})
		expect(result.decision).toBe("outcome_failed")
		expect(result.results.map(({ status }) => status)).toEqual(["passed", "failed"])
		expect(processRunner.calls[2]).toMatchObject({
			command: "node",
			args: ["fixture/grader.mjs"],
			cwd: "/trusted/private",
			env: { EVAL_WORKSPACE_ROOT: "/agent/workspace" },
		})
	})
})
