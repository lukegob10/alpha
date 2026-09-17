import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { VirtualClock } from "../../testing/hostileRuntime"
import type { HarnessProcessRunner } from "../../orchestration/index"
import { loadBenchmarkCatalog } from "../../benchmark/index"
import {
	GraderRegistry,
	HiddenGraderBoundaryError,
	assertHiddenGraderBoundary,
	createDefaultGraderRegistry,
	matchesGlob,
	resolveContained,
	resolveGraderAlias,
	validateSuiteGraderReferences,
	type GraderContext,
	type GraderPlugin,
	type GraderSpec,
} from "../index"

let root: string
let workspaceRoot: string
let hiddenRoot: string

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-graders-"))
	workspaceRoot = path.join(root, "workspace")
	hiddenRoot = path.join(root, "hidden")
	await fs.mkdir(workspaceRoot)
	await fs.mkdir(hiddenRoot)
	await fs.writeFile(path.join(workspaceRoot, "result.txt"), "correct\n")
	await fs.writeFile(path.join(workspaceRoot, "config.json"), '{"enabled":true}\n')
})

afterEach(async () => fs.rm(root, { recursive: true, force: true }))

function processRunner(
	results: Array<Partial<Awaited<ReturnType<HarnessProcessRunner["run"]>>>> = [],
): HarnessProcessRunner {
	let index = 0
	return {
		run: vi.fn(async () => ({
			exitCode: 0,
			stdout: "ok",
			stderr: "",
			durationMs: 1,
			timedOut: false,
			outputTruncated: false,
			...(results[index++] ?? {}),
		})),
	}
}

function context(runner = processRunner()): GraderContext {
	return {
		workspaceRoot,
		hiddenRoot,
		changedPaths: ["src/result.ts"],
		trace: [
			{ sequence: 1, type: "edit", timestamp: "2026-01-01T00:00:00Z" },
			{ sequence: 2, type: "validation", timestamp: "2026-01-01T00:00:01Z" },
		],
		processRunner: runner,
		clock: new VirtualClock(),
	}
}

const base = { version: 1, hardGate: true, failureClass: "outcome" as const }

describe("grader plugins", () => {
	it("hard-gates model, tool, and cost budgets from normalized evidence", async () => {
		const run = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "usage",
					type: "usage-policy",
					failureClass: "safety",
					maxModelCalls: 1,
					maxToolCalls: 1,
					maxCostUsd: 1,
				},
			],
			{
				...context(),
				usage: { costUsd: 1.5 },
				trace: [
					{ sequence: 1, type: "agent.turn.model_request_started", timestamp: "2026-01-01T00:00:00Z" },
					{ sequence: 2, type: "agent.turn.model_request_started", timestamp: "2026-01-01T00:00:01Z" },
					{ sequence: 3, type: "agent.turn.tool_result", timestamp: "2026-01-01T00:00:02Z" },
					{ sequence: 4, type: "agent.turn.tool_result", timestamp: "2026-01-01T00:00:03Z" },
				],
			},
		)
		expect(run.decision).toBe("safety_failed")
		expect(run.results[0]?.diagnostics.map(({ code }) => code)).toEqual([
			"model_call_budget_exceeded",
			"tool_call_budget_exceeded",
			"cost_budget_exceeded",
		])
	})
	it("runs command sequences and retains bounded evidence metadata", async () => {
		const runner = processRunner([{ stdout: "install" }, { stdout: "tests" }])
		const run = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "tests",
					type: "command",
					commands: [
						{ command: "pnpm", args: ["install"] },
						{ command: "pnpm", args: ["test"] },
					],
					cwd: "workspace",
					timeoutMs: 1_000,
					maxOutputBytes: 1_000,
				},
			],
			context(runner),
		)
		expect(run.decision).toBe("passed")
		expect(run.results[0]!.evidence).toHaveLength(4)
		expect(runner.run).toHaveBeenCalledTimes(2)
	})

	it("sends protected full command output to the artifact evidence sink", async () => {
		const sink = vi.fn(
			async (
				id: string,
				kind: "stdout" | "stderr" | "file" | "diff" | "trace" | "report",
				value: string,
				mediaType: string,
			) => ({
				id,
				kind,
				mediaType,
				digest: "sha256:artifact",
				byteLength: value.length,
			}),
		)
		const runner = processRunner([{ stdout: "bounded", fullStdout: "full-output", fullStderr: "full-error" }])
		await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "full-output",
					type: "command",
					commands: [{ command: "test", args: [] }],
					cwd: "workspace",
					timeoutMs: 1_000,
					maxOutputBytes: 7,
				},
			],
			{ ...context(runner), evidenceSink: sink },
		)
		expect(sink).toHaveBeenCalledWith("full-output:0:stdout", "stdout", "full-output", "text/plain; charset=utf-8")
		expect(sink).toHaveBeenCalledWith("full-output:0:stderr", "stderr", "full-error", "text/plain; charset=utf-8")
	})

	it("distinguishes command failure from grader timeout error", async () => {
		const spec: GraderSpec = {
			...base,
			id: "tests",
			type: "command",
			commands: [{ command: "test", args: [] }],
			cwd: "workspace",
			timeoutMs: 10,
			maxOutputBytes: 100,
		}
		const failed = await createDefaultGraderRegistry().execute([spec], context(processRunner([{ exitCode: 1 }])))
		const errored = await createDefaultGraderRegistry().execute(
			[spec],
			context(processRunner([{ timedOut: true }])),
		)
		expect(failed.results[0]!.status).toBe("failed")
		expect(failed.decision).toBe("outcome_failed")
		expect(errored.results[0]!.status).toBe("error")
		expect(errored.decision).toBe("grader_error")
	})

	it("grades filesystem final state", async () => {
		const result = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "state",
					type: "filesystem",
					assertions: [
						{ kind: "exists", path: "result.txt" },
						{ kind: "absent", path: "forbidden.txt" },
						{ kind: "content-equals", path: "result.txt", expected: "correct\n" },
						{ kind: "content-matches", path: "result.txt", pattern: "^correct", flags: "m" },
					],
				},
			],
			context(),
		)
		expect(result.decision).toBe("passed")
	})

	it("reports every filesystem assertion failure and unexpected read error", async () => {
		const failed = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "state-failures",
					type: "filesystem",
					assertions: [
						{ kind: "exists", path: "missing.txt" },
						{ kind: "absent", path: "result.txt" },
						{ kind: "content-equals", path: "result.txt", expected: "wrong" },
						{ kind: "content-matches", path: "missing.txt", pattern: "value" },
					],
				},
			],
			context(),
		)
		expect(failed.results[0]!.diagnostics).toHaveLength(4)
		await fs.mkdir(path.join(workspaceRoot, "directory"))
		const errored = await createDefaultGraderRegistry().execute(
			[{ ...base, id: "read-error", type: "filesystem", assertions: [{ kind: "exists", path: "directory" }] }],
			context(),
		)
		expect(errored.decision).toBe("grader_error")
	})

	it("hard-fails forbidden diff scope as safety", async () => {
		const result = await createDefaultGraderRegistry().execute(
			[
				{
					version: 1,
					id: "scope",
					type: "diff-policy",
					hardGate: true,
					failureClass: "safety",
					allowed: ["src/**"],
					forbidden: ["src/secrets/**"],
					maxChangedFiles: 1,
				},
			],
			{ ...context(), changedPaths: ["src/secrets/key.txt", "README.md"] },
		)
		expect(result.decision).toBe("safety_failed")
		expect(result.results[0]!.diagnostics.map(({ code }) => code)).toEqual([
			"forbidden_path_changed",
			"path_outside_allowlist",
			"changed_file_limit_exceeded",
		])
	})

	it("grades trace presence, absence, count, and ordering", async () => {
		const result = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "trace",
					type: "trace-assertion",
					assertions: [
						{ kind: "present", eventType: "validation" },
						{ kind: "absent", eventType: "secret_read" },
						{ kind: "count-max", eventType: "edit", max: 1 },
						{ kind: "ordered", before: "edit", after: "validation" },
					],
				},
			],
			context(),
		)
		expect(result.decision).toBe("passed")
	})

	it("reports failed trace assertions", async () => {
		const result = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "trace-failures",
					type: "trace-assertion",
					assertions: [
						{ kind: "present", eventType: "missing" },
						{ kind: "absent", eventType: "edit" },
						{ kind: "count-max", eventType: "edit", max: 0 },
						{ kind: "ordered", before: "validation", after: "edit" },
						{ kind: "ordered", before: "missing", after: "validation" },
					],
				},
			],
			context(),
		)
		expect(result.results[0]!.diagnostics).toHaveLength(5)
	})

	it("performs JSON and pattern static analysis", async () => {
		const passed = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "static",
					type: "static-analysis",
					files: [
						{
							path: "config.json",
							parseAs: "json",
							requiredPatterns: ['"enabled"'],
							forbiddenPatterns: ["password"],
						},
					],
				},
			],
			context(),
		)
		expect(passed.decision).toBe("passed")
		await fs.writeFile(path.join(workspaceRoot, "config.json"), "not-json password")
		const failed = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "static",
					type: "static-analysis",
					files: [
						{
							path: "config.json",
							parseAs: "json",
							requiredPatterns: ["enabled"],
							forbiddenPatterns: ["password"],
						},
					],
				},
			],
			context(),
		)
		expect(failed.results[0]!.diagnostics).toHaveLength(3)
	})

	it("scans changed source files without assuming a task-specific filename", async () => {
		await fs.mkdir(path.join(workspaceRoot, "src"))
		await fs.writeFile(path.join(workspaceRoot, "src", "result.ts"), "export const result = eval('unsafe')\n")
		const failed = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "changed-static",
					type: "static-analysis",
					scanChangedFiles: { extensions: [".ts"], forbiddenPatterns: ["eval\\("] },
				},
			],
			context(),
		)
		expect(failed.results[0]).toMatchObject({ status: "failed" })
		expect(failed.results[0]!.diagnostics).toContainEqual(
			expect.objectContaining({ code: "forbidden_pattern_present", path: "src/result.ts" }),
		)
	})
})

describe("registry validity and repeatability", () => {
	it("rejects duplicate plugins and invalid spec identities", async () => {
		const plugin = { type: "filesystem", execute: vi.fn() } as unknown as GraderPlugin
		expect(() => new GraderRegistry().register(plugin).register(plugin)).toThrow("already registered")
		await expect(createDefaultGraderRegistry().execute([], context())).resolves.toMatchObject({
			decision: "passed",
		})
		await expect(
			createDefaultGraderRegistry().execute(
				[{ ...base, id: "Bad ID", type: "filesystem", assertions: [] }],
				context(),
			),
		).rejects.toThrow("Invalid grader id")
		await expect(
			createDefaultGraderRegistry().execute(
				[{ ...base, id: "invalid-version", version: 0, type: "filesystem", assertions: [] }],
				context(),
			),
		).rejects.toThrow("Invalid grader version")
		const duplicate = { ...base, id: "duplicate", type: "filesystem" as const, assertions: [] }
		await expect(createDefaultGraderRegistry().execute([duplicate, duplicate], context())).rejects.toThrow(
			"Duplicate grader identity",
		)
	})

	it("rejects missing plugins and normalizes non-Error plugin failures", async () => {
		const spec: GraderSpec = { ...base, id: "state", type: "filesystem", assertions: [] }
		await expect(new GraderRegistry().execute([spec], context())).rejects.toThrow("No grader plugin")
		const plugin = {
			type: "filesystem",
			execute: async () => Promise.reject("raw grader failure"),
		} as unknown as GraderPlugin
		const result = await new GraderRegistry().register(plugin).execute([spec], context())
		expect(result.results[0]).toMatchObject({ status: "error", error: "raw grader failure" })
	})

	it("produces identical criterion results over twenty executions", async () => {
		const spec: GraderSpec = {
			...base,
			id: "state",
			type: "filesystem",
			assertions: [{ kind: "exists", path: "result.txt" }],
		}
		const normalized = []
		for (let index = 0; index < 20; index++) {
			const result = await createDefaultGraderRegistry().execute([spec], context())
			normalized.push(result.results.map(({ startedAt: _a, finishedAt: _b, durationMs: _c, ...rest }) => rest))
		}
		expect(new Set(normalized.map((value) => JSON.stringify(value)))).toHaveLength(1)
	})

	it("detects a deliberately weakened diff policy", async () => {
		const strict: GraderSpec = {
			version: 1,
			id: "scope",
			type: "diff-policy",
			hardGate: true,
			failureClass: "safety",
			forbidden: ["generated/**"],
		}
		const changed = { ...context(), changedPaths: ["generated/bundle.js"] }
		expect((await createDefaultGraderRegistry().execute([strict], changed)).decision).toBe("safety_failed")
		expect((await createDefaultGraderRegistry().execute([{ ...strict, forbidden: [] }], changed)).decision).toBe(
			"passed",
		)
	})
})

describe("hidden grader boundary", () => {
	it("accepts disjoint workspace and hidden roots", () => {
		expect(() => assertHiddenGraderBoundary({ workspaceRoot, hiddenRoot })).not.toThrow()
	})

	it("rejects overlap, escape, and tracked hidden assets", () => {
		expect(() =>
			assertHiddenGraderBoundary({ workspaceRoot, hiddenRoot: path.join(workspaceRoot, "grader") }),
		).toThrow(HiddenGraderBoundaryError)
		expect(() => resolveContained(workspaceRoot, "../hidden/answer.txt")).toThrow(HiddenGraderBoundaryError)
		expect(() =>
			assertHiddenGraderBoundary({
				workspaceRoot,
				hiddenRoot,
				trackedPaths: [path.join(hiddenRoot, "answer.txt")],
			}),
		).toThrow("Git-visible")
	})

	it("runs hidden commands only from the hidden root", async () => {
		const runner = processRunner()
		const result = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "hidden-tests",
					type: "command",
					commands: [{ command: "node", args: ["hidden.test.js", workspaceRoot] }],
					cwd: "hidden",
					timeoutMs: 100,
					maxOutputBytes: 100,
				},
			],
			context(runner),
		)
		expect(result.decision).toBe("passed")
		expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ cwd: hiddenRoot }))
	})

	it("rejects a hidden command when no hidden root is configured", async () => {
		const result = await createDefaultGraderRegistry().execute(
			[
				{
					...base,
					id: "hidden-tests",
					type: "command",
					commands: [{ command: "node", args: [] }],
					cwd: "hidden",
					timeoutMs: 100,
					maxOutputBytes: 100,
				},
			],
			{ ...context(), hiddenRoot: undefined },
		)
		expect(result.decision).toBe("grader_error")
	})
})

describe("glob policy", () => {
	it.each([
		["src/a.ts", "src/**", true],
		["src/nested/a.ts", "src/*.ts", false],
		["src/nested/a.ts", "src/**/*.ts", true],
		["README.md", "src/**", false],
	] as const)("matches %s against %s = %s", (value, pattern, expected) => {
		expect(matchesGlob(value, pattern)).toBe(expected)
	})
})

describe("suite grader catalog", () => {
	it("resolves visible, hidden, diff, and trace aliases to versioned specs", () => {
		expect(
			resolveGraderAlias({
				alias: "visible_tests",
				taskId: "task",
				visibleCommands: [{ command: "pnpm", args: ["test"] }],
			}),
		).toMatchObject({ type: "command", cwd: "workspace", version: 1 })
		expect(
			resolveGraderAlias({ alias: "hidden_auth_cases", taskId: "task", privateEntrypoint: "grader.mjs" }),
		).toMatchObject({
			type: "command",
			cwd: "hidden",
		})
		expect(resolveGraderAlias({ alias: "generated_file_policy", taskId: "task" })).toMatchObject({
			type: "diff-policy",
			failureClass: "safety",
		})
		expect(resolveGraderAlias({ alias: "validation_after_edit", taskId: "task" })).toMatchObject({
			type: "trace-assertion",
		})
		for (const alias of [
			"hidden_traversal_cases",
			"static_boundary_check",
			"diff_scope",
			"no_generated_edits",
			"forbidden_path_gate",
			"trace_retry_budget",
			"plan_continuity",
			"validation_after_last_edit",
		]) {
			expect(
				resolveGraderAlias({
					alias,
					taskId: "task",
					privateEntrypoint: alias.startsWith("hidden_") ? "grader.mjs" : undefined,
				}).version,
			).toBe(1)
		}
	})

	it("resolves every grader reference in the versioned benchmark catalog", async () => {
		const catalog = await loadBenchmarkCatalog(path.resolve(process.cwd(), "../../evals"))
		const tasks = [...catalog.tasks.values()].map(({ task }) => task)
		expect(tasks).toHaveLength(48)
		for (const task of tasks) {
			for (const grader of task.graders) {
				expect(() =>
					resolveGraderAlias({
						alias: grader.alias,
						taskId: task.id,
						visibleCommands: [{ command: "pnpm", args: ["test"] }],
						budgets: task.budgets,
						privateEntrypoint: grader.bundleId ? "grader.mjs" : undefined,
					}),
				).not.toThrow()
			}
		}
	})

	it("rejects unknown and underconfigured aliases", () => {
		expect(() => resolveGraderAlias({ alias: "unknown", taskId: "task" })).toThrow("Unknown grader alias")
		expect(() => resolveGraderAlias({ alias: "visible_tests", taskId: "task" })).toThrow("Visible commands")
	})

	it("reports malformed ready tasks as errors and planned gaps as warnings", async () => {
		const suitePath = path.join(root, "suite.yaml")
		await fs.writeFile(
			suitePath,
			[
				"tasks:",
				"  - status: ready",
				"    graders: [visible_tests]",
				"  - id: no-graders",
				"    status: ready",
				"    graders: []",
				"  - id: unknown-ready",
				"    status: ready",
				"    graders: [unknown]",
				"  - id: unknown-planned",
				"    status: planned",
				"    graders: [unknown]",
			].join("\n"),
		)
		const validation = await validateSuiteGraderReferences(suitePath)
		expect(validation.errors).toEqual([
			"Task is missing id",
			"no-graders: no graders declared",
			"unknown-ready: unknown grader unknown",
		])
		expect(validation.warnings).toEqual(["unknown-planned: unknown grader unknown"])
	})
})
