import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const git = vi.hoisted(() => ({ revision: vi.fn(), status: vi.fn() }))
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execSync: git.revision,
	execFileSync: git.status,
}))

import { ExecaHarnessProcessRunner } from "../../orchestration/index"

import {
	extensionBundleDigest,
	launchExtension,
	orderProblemSolvingPromptVariants,
	readProblemSolvingRunPaths,
	runLiveProblemSolvingCore,
} from "../problemSolvingLive"

const evalRoot = path.resolve(process.cwd(), "../../evals")
const repositoryRoot = path.resolve(process.cwd(), "../..")
const roots: string[] = []
const requireNativeFixture = createRequire(import.meta.url)
const executeNode = promisify(execFile)

async function nativeRunnerRepository(delayedCleanup = false, cleanupVerified = true) {
	const directory = await root()
	const file = path.join(directory, "apps", "vscode-e2e", "out", "runTest.js")
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(
		file,
		[
			"exports.readRunOptions = (args, env) => ({args, env})",
			"exports.started = new Promise(resolve => { exports.startedResolve = resolve })",
			`exports.runExtensionTests = (options, dependencies) => { exports.options = options; exports.dependencies = dependencies; exports.startedResolve();
		 ${
				delayedCleanup
					? "return new Promise(resolve => { exports.completeCleanup = () => resolve({execution:'extension-host',hostCleanupVerified:true}); options.signal.addEventListener('abort',()=>{exports.abortObserved=true}); })"
					: `return Promise.resolve({execution:'extension-host',hostCleanupVerified:${cleanupVerified}})`
			} }`,
		].join("\n"),
	)
	return {
		directory,
		native: requireNativeFixture(file) as {
			started: Promise<void>
			abortObserved?: boolean
			completeCleanup?: () => void
			dependencies?: { launchKind: "development-sidecar" }
			options?: {
				args: string[]
				env: NodeJS.ProcessEnv
				signal: AbortSignal
				executionTimeoutMs: number
				extensionTestsEnv: Record<string, string>
			}
		},
	}
}

beforeEach(() => {
	git.revision.mockReturnValue("a".repeat(40))
	git.status.mockReturnValue(Buffer.alloc(0))
})

async function root() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-live-runner-"))
	roots.push(directory)
	return directory
}

function options(attemptRoot: string, overrides: Partial<Parameters<typeof runLiveProblemSolvingCore>[0]> = {}) {
	return {
		evalRoot,
		repositoryRoot,
		attemptRoot,
		profileDir: path.join(attemptRoot, "profile"),
		taskIds: ["alpha-pr-comparison"],
		...overrides,
	}
}

async function campaignRepository() {
	const directory = await root()
	await fs.mkdir(path.join(directory, "src", "dist"), { recursive: true })
	await fs.writeFile(path.join(directory, "src", "dist", "extension.js"), "controlled frozen extension fixture")
	return directory
}

function campaignReceipts(input: {
	failure?: { category: string; code: string; providerCode?: string }
	grader?: "outcome" | "error"
}) {
	const dispatched: string[] = []
	vi.spyOn(ExecaHarnessProcessRunner.prototype, "run").mockImplementation(async (request) => {
		if (request.args.includes("--scenario-id")) {
			const argument = (name: string) => request.args[request.args.indexOf(name) + 1]!
			const runId = argument("--run-id")
			dispatched.push(runId)
			const receiptDir = path.join(argument("--artifacts-dir"), runId)
			await fs.mkdir(receiptDir, { recursive: true })
			await fs.writeFile(
				path.join(receiptDir, "workflow-result.json"),
				JSON.stringify({
					status: input.failure ? "failed" : "passed",
					requestsUsed: 1,
					requestsByPurpose: { task: 1, "reasoning-summary": 0 },
					model: { id: argument("--model-id"), reasoningEffort: argument("--reasoning-effort") },
					...(input.failure ? { failure: input.failure } : {}),
				}),
			)
		} else if (input.grader === "error") throw new Error("controlled grader failure")
		const failedAssertions =
			input.grader === "outcome" && request.args[0]?.endsWith("nodeTestExecution.mjs")
				? (JSON.parse(request.args[1]!) as { expected: Array<{ file: string; name: string }> }).expected
				: undefined
		return {
			exitCode: request.args.includes("--scenario-id") || failedAssertions ? 0 : 1,
			timedOut: false,
			stdout: failedAssertions
				? JSON.stringify({
						schemaVersion: 1,
						kind: "alpha-expected-node-tests",
						complete: true,
						failed: true,
						timedOut: false,
						tests: failedAssertions.map(({ name }) => ({
							file: path.join(path.dirname(request.args[0]!), "nodeTestContext.cjs"),
							name,
							passed: false,
							skipped: false,
							todo: false,
						})),
						completions: [],
					})
				: "",
			stderr: "",
			durationMs: 0,
			outputTruncated: false,
		}
	})
	return dispatched
}

afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("live problem-solving runner configuration", () => {
	it("loads the compiled native CommonJS boundary through the real namespaced tsImport adapter", async () => {
		const directory = await root()
		const compiled = path.join(directory, "apps", "vscode-e2e", "out")
		await fs.mkdir(compiled, { recursive: true })
		await fs.writeFile(
			path.join(compiled, "dependency.cjs"),
			["const path = require('path')", "exports.marker = path.basename('native-relative-cjs-dependency')"].join(
				"\n",
			),
		)
		await fs.writeFile(
			path.join(compiled, "runTest.js"),
			[
				"const path = require('node:path')",
				"const fs = require('node:fs')",
				"const dependency = require('./dependency.cjs')",
				"exports.readRunOptions = args => ({ args })",
				"exports.runExtensionTests = async (options, dependencies) => {",
				" const workspace = options.args[options.args.indexOf('--workspace') + 1]",
				" fs.writeFileSync(path.join(workspace, 'native-stub.json'), JSON.stringify({marker:dependency.marker,signal:!!options.signal,launchKind:dependencies?.launchKind}))",
				" return {execution:'test-seam',hostCleanupVerified:true}",
				"}",
			].join("\n"),
		)
		const workspace = path.join(directory, "workspace")
		await fs.mkdir(workspace)
		const program = path.join(directory, "invoke.mjs")
		await fs.writeFile(
			program,
			[
				"import { createRequire } from 'node:module'",
				"import path from 'node:path'",
				"import { pathToFileURL } from 'node:url'",
				"const [publicRoot,nativeRoot,workspace] = process.argv.slice(2)",
				"const require = createRequire(path.join(publicRoot,'package.json'))",
				"const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href)",
				"const [,producer] = await Promise.all(['experiments/problemSolvingCampaign.ts','benchmark/problemSolvingLive.ts'].map(relative => tsImport(pathToFileURL(path.join(publicRoot,'packages/evals/src',relative)).href,{parentURL:import.meta.url,tsconfig:false})))",
				"const result = await producer.launchExtension({workspace,profileDir:path.join(nativeRoot,'profile'),artifactsDir:path.join(nativeRoot,'artifacts'),runId:'namespaced-cjs-control',requestLimit:1,provider:'scripted',modelId:'synthetic-model',effort:'high',hostVersion:'1.138.0',taskId:'synthetic-source',promptPath:path.join(workspace,'prompt.md'),experimentEvidence:true},nativeRoot,'synthetic-build',{timeoutMs:5000})",
				"console.log(JSON.stringify(result))",
			].join("\n"),
		)
		const observed = await executeNode(process.execPath, [program, repositoryRoot, directory, workspace], {
			cwd: directory,
			env: process.env,
			timeout: 30_000,
			windowsHide: true,
		})
		expect(JSON.parse(observed.stdout)).toMatchObject({ status: "failed", failureClass: "infrastructure" })
		expect(JSON.parse(await fs.readFile(path.join(workspace, "native-stub.json"), "utf8"))).toEqual({
			marker: "native-relative-cjs-dependency",
			signal: true,
			launchKind: "development-sidecar",
		})
	}, 40_000)
	it("uses only explicitly configured profile and output roots", () => {
		const attemptRoot = path.resolve(os.tmpdir(), "alpha-live-output")
		const profileDir = path.resolve(os.tmpdir(), "alpha-live-profile")
		expect(
			readProblemSolvingRunPaths({
				PROBLEM_SOLVING_ATTEMPT_ROOT: attemptRoot,
				PROBLEM_SOLVING_PROFILE_DIR: profileDir,
			}),
		).toEqual({ attemptRoot, profileDir })
	})

	it.each(["PROBLEM_SOLVING_ATTEMPT_ROOT", "PROBLEM_SOLVING_PROFILE_DIR"])(
		"rejects missing or invalid %s before a live run can select an operator profile",
		(key) => {
			const valid = {
				PROBLEM_SOLVING_ATTEMPT_ROOT: path.resolve(os.tmpdir(), "alpha-live-output"),
				PROBLEM_SOLVING_PROFILE_DIR: path.resolve(os.tmpdir(), "alpha-live-profile"),
			}
			for (const value of [undefined, "", "relative-path", `${path.parse(process.cwd()).root}invalid\0path`]) {
				expect(() => readProblemSolvingRunPaths({ ...valid, [key]: value })).toThrow(
					`${key} must name an explicit absolute path`,
				)
			}
		},
	)

	it.each([
		{
			name: "provider timeout",
			failure: { category: "provider", code: "other", providerCode: "request_timeout" },
			failureClass: "provider",
		},
		{
			name: "model admission",
			failure: { category: "configuration", code: "model-unavailable" },
			failureClass: "provider",
		},
		{
			name: "provider timeout retained under a lifecycle assertion",
			failure: { category: "lifecycle", code: "unexpected_resume_task", providerCode: "request_timeout" },
			failureClass: "task",
		},
		{
			name: "infrastructure with a retained trace",
			failure: { category: "policy", code: "unexpected_tool_approval" },
			failureClass: "infrastructure",
		},
		{
			name: "cancellation",
			failure: { category: "lifecycle", code: "task_cancelled" },
			failureClass: "cancellation",
		},
		{
			name: "grading infrastructure error",
			failure: undefined,
			grader: "error" as const,
			failureClass: "task",
		},
	])(
		"stops further live dispatch after $name while preserving the first attempt evidence",
		async ({ failure, failureClass, grader }) => {
			const parent = await root()
			const attemptRoot = path.join(parent, "campaign")
			const dispatched = campaignReceipts({ failure, grader })
			const report = await runLiveProblemSolvingCore(
				options(attemptRoot, {
					repositoryRoot: await campaignRepository(),
					runId: "controlled-terminal-stop",
					taskIds: ["alpha-pr-comparison", "alpha-change-integration"],
					repetitions: 2,
					promptVariants: ["baseline", "single-command"],
				}),
			)
			expect(dispatched).toEqual(["ps-alpha-pr-comparison-r1-baseline"])
			expect(report.attempts).toHaveLength(1)
			expect(report.attempts[0]).toMatchObject({ failureClass, countsAsSolving: false, usage: { requests: 1 } })
			if (grader === "error") expect(report.attempts[0]!.graderDecision).toBe("grader_error")
			const written = JSON.parse(await fs.readFile(path.join(attemptRoot, "report.json"), "utf8"))
			expect(written.attempts).toEqual(report.attempts)
			const trace = report.attempts[0]!.tracePath
			expect(trace).not.toBeNull()
			expect(JSON.parse(await fs.readFile(trace!, "utf8"))).toMatchObject({
				...(failure ? { failure } : {}),
				requestsUsed: 1,
			})
			expect(await fs.readdir(attemptRoot)).not.toContain("ps-alpha-change-integration-r1-baseline")
		},
	)

	it.each([
		{
			name: "ordinary graded outcome",
			failure: undefined,
			grader: "outcome" as const,
			failureClass: "task",
			graderDecision: "outcome_failed",
		},
		{
			name: "task assertion",
			failure: { category: "assertion", code: "unexpected_completed_verification" },
			grader: "outcome" as const,
			failureClass: "task",
			graderDecision: "outcome_failed",
		},
		{
			name: "task request budget",
			failure: { category: "timeout", code: "request_limit_reached" },
			grader: "outcome" as const,
			failureClass: "budget",
			graderDecision: "outcome_failed",
		},
	])(
		"continues distinct $name observations without treating them as provider admission failure",
		async ({ failure, grader, failureClass, graderDecision }) => {
			const parent = await root()
			const attemptRoot = path.join(parent, "campaign")
			const dispatched = campaignReceipts({ failure, grader })
			const report = await runLiveProblemSolvingCore(
				options(attemptRoot, {
					repositoryRoot: await campaignRepository(),
					runId: "controlled-observations",
					taskIds: ["alpha-pr-comparison", "alpha-change-integration"],
				}),
			)
			expect(dispatched).toEqual([
				"ps-alpha-pr-comparison-r1-baseline",
				"ps-alpha-change-integration-r1-baseline",
			])
			expect(report.attempts).toHaveLength(2)
			for (const attempt of report.attempts)
				expect(attempt).toMatchObject({
					status: "failed",
					countsAsSolving: false,
					failureClass,
					graderDecision,
				})
			expect(JSON.parse(await fs.readFile(path.join(attemptRoot, "report.json"), "utf8"))).toMatchObject({
				attempts: report.attempts,
			})
		},
	)

	it("retains request purposes and provider failure attribution through the actual receipt reader", async () => {
		const directory = await root()
		const request = {
			workspace: directory,
			profileDir: path.join(directory, "profile"),
			artifactsDir: path.join(directory, "artifacts"),
			runId: "receipt-handoff",
			requestLimit: 40,
			provider: "live-copilot" as const,
			modelId: "model",
			effort: "high",
			hostVersion: "1.138.0",
			taskId: "fixture",
			promptPath: path.join(directory, "prompt.md"),
		}
		vi.spyOn(ExecaHarnessProcessRunner.prototype, "run").mockImplementation(async () => {
			const receiptDir = path.join(request.artifactsDir, request.runId)
			await fs.mkdir(receiptDir, { recursive: true })
			await fs.writeFile(
				path.join(receiptDir, "workflow-result.json"),
				JSON.stringify({
					status: "failed",
					requestsUsed: 7,
					requestsByPurpose: { task: 5, "reasoning-summary": 2 },
					failure: { category: "lifecycle", code: "unexpected_resume_task", providerCode: "request_timeout" },
				}),
			)
			return { exitCode: 0, timedOut: false, stdout: "", stderr: "", durationMs: 0, outputTruncated: false }
		})
		const host = await launchExtension(request, repositoryRoot, "frozen-build")
		expect(host.usage).toMatchObject({ requests: 7, taskRequests: 5, summaryRequests: 2 })
		expect(host.failureCode).toBe("unexpected_resume_task")
		expect(host.providerFailureCode).toBe("request_timeout")
	})

	it.each(["live-copilot", "scripted"] as const)(
		"uses bounded shared native launch deadlines for %s and labels unavailable capture",
		async (provider) => {
			const directory = await root()
			const fixture = await nativeRunnerRepository()
			const request = {
				workspace: directory,
				profileDir: path.join(directory, "profile"),
				artifactsDir: path.join(directory, "artifacts"),
				runId: "bounded-capture",
				requestLimit: 2,
				provider,
				modelId: "model",
				effort: "high",
				hostVersion: "1.138.0",
				taskId: "fixture",
				promptPath: path.join(directory, "prompt.md"),
				experimentEvidence: true,
				experimentAssignmentDigest: "sha256:" + "a".repeat(64),
			}
			const execute = vi.spyOn(ExecaHarnessProcessRunner.prototype, "run")
			const result = await launchExtension(request, fixture.directory, "frozen-build", {
				timeoutMs: 1200,
				scenarioTimeoutMs: 1000,
			})
			expect(execute).not.toHaveBeenCalled()
			expect(fixture.native.dependencies).toEqual({ launchKind: "development-sidecar" })
			expect(fixture.native.options?.executionTimeoutMs).toBe(1200)
			expect(fixture.native.options?.extensionTestsEnv.ALPHA_E2E_SCENARIO_TIMEOUT_MS).toBe("1000")
			expect(fixture.native.options?.extensionTestsEnv.ALPHA_E2E_EXPERIMENT_ASSIGNMENT_DIGEST).toBe(
				request.experimentAssignmentDigest,
			)
			expect(fixture.native.options?.args).toContain("--experiment-evidence")
			expect(result.experimentIdentity).toBeNull()
			expect(result.experimentIdentityFailure).toBe("unavailable")
		},
	)

	it("passes cancellation into the owning native runner and waits for its cleanup before returning", async () => {
		const directory = await root()
		const fixture = await nativeRunnerRepository(true)
		const controller = new AbortController()
		let settled = false
		const pending = launchExtension(
			{
				workspace: directory,
				profileDir: path.join(directory, "profile"),
				artifactsDir: path.join(directory, "artifacts"),
				runId: "cancelled-capture",
				requestLimit: 2,
				provider: "scripted",
				modelId: "model",
				effort: "high",
				hostVersion: "1.138.0",
				taskId: "fixture",
				promptPath: path.join(directory, "prompt.md"),
				experimentEvidence: true,
			},
			fixture.directory,
			"frozen-build",
			{ timeoutMs: 2000, signal: controller.signal },
		).then((result) => {
			settled = true
			return result
		})
		await fixture.native.started
		controller.abort(new Error("controlled cancellation"))
		expect(fixture.native.abortObserved).toBe(true)
		await Promise.resolve()
		expect(settled).toBe(false)
		fixture.native.completeCleanup!()
		expect(await pending).toMatchObject({ status: "cancelled", failureClass: "cancellation" })
		expect(settled).toBe(true)
	})

	it("withholds a passing workflow result when native host cleanup is unverified", async () => {
		const directory = await root()
		const fixture = await nativeRunnerRepository(false, false)
		const artifactsDir = path.join(directory, "artifacts")
		await fs.mkdir(path.join(artifactsDir, "uncertain-cleanup"), { recursive: true })
		await fs.writeFile(
			path.join(artifactsDir, "uncertain-cleanup", "workflow-result.json"),
			JSON.stringify({ status: "passed" }),
		)
		const result = await launchExtension(
			{
				workspace: directory,
				profileDir: path.join(directory, "profile"),
				artifactsDir,
				runId: "uncertain-cleanup",
				requestLimit: 2,
				provider: "scripted",
				modelId: "model",
				effort: "high",
				hostVersion: "1.138.0",
				taskId: "fixture",
				promptPath: path.join(directory, "prompt.md"),
				experimentEvidence: true,
			},
			fixture.directory,
			"frozen-build",
			{ timeoutMs: 2000 },
		)
		expect(result).toMatchObject({ status: "failed", failureClass: "infrastructure" })
	})

	it.each([0, -1, NaN, Infinity, 1_100_001])(
		"rejects invalid native launch bounds before staging marker: %s",
		async (timeoutMs) => {
			const directory = await root()
			const execute = vi.spyOn(ExecaHarnessProcessRunner.prototype, "run")
			await expect(
				launchExtension(
					{
						workspace: directory,
						profileDir: path.join(directory, "profile"),
						artifactsDir: path.join(directory, "artifacts"),
						runId: "invalid-bounds",
						requestLimit: 2,
						provider: "live-copilot",
						modelId: "model",
						effort: "high",
						hostVersion: "1.138.0",
						taskId: "fixture",
						promptPath: path.join(directory, "prompt.md"),
					},
					repositoryRoot,
					"frozen-build",
					{ timeoutMs },
				),
			).rejects.toThrow("bounded positive")
			expect(execute).not.toHaveBeenCalled()
			await expect(fs.stat(path.join(directory, ".alpha-e2e-owned.json"))).rejects.toMatchObject({
				code: "ENOENT",
			})
		},
	)

	it("balances prompt-arm order across repetitions", () => {
		expect(orderProblemSolvingPromptVariants(["baseline", "single-command"], 1)).toEqual([
			"baseline",
			"single-command",
		])
		expect(orderProblemSolvingPromptVariants(["baseline", "single-command"], 2)).toEqual([
			"single-command",
			"baseline",
		])
		expect(orderProblemSolvingPromptVariants(["baseline"], 2)).toEqual(["baseline"])
	})

	it("fingerprints the extension bundle selected by the VS Code development host", async () => {
		const repository = await root()
		const bundlePath = path.join(repository, "src", "dist", "extension.js")
		const bundle = Buffer.from("extension bundle bytes")
		await fs.mkdir(path.dirname(bundlePath), { recursive: true })
		await fs.writeFile(bundlePath, bundle)

		expect(await extensionBundleDigest(repository)).toBe(createHash("sha256").update(bundle).digest("hex"))
	})

	it("keeps Terminal-Bench and holdout tasks out of local live grading", async () => {
		const parent = await root()
		const attemptRoot = path.join(parent, "run")
		await expect(
			runLiveProblemSolvingCore(options(attemptRoot, { taskIds: ["session-window-debug"] })),
		).rejects.toThrow("not eligible for live local grading")
		await expect(fs.stat(attemptRoot)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects invalid repetition settings before creating a run directory", async () => {
		const parent = await root()
		const attemptRoot = path.join(parent, "run")
		await expect(runLiveProblemSolvingCore(options(attemptRoot, { repetitions: 4 }))).rejects.toThrow(
			"repetitions must be from 1 to 3",
		)
		await expect(fs.stat(attemptRoot)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects duplicate prompt arms before creating a run directory", async () => {
		const parent = await root()
		const attemptRoot = path.join(parent, "run")
		await expect(
			runLiveProblemSolvingCore(options(attemptRoot, { promptVariants: ["baseline", "baseline"] })),
		).rejects.toThrow("prompt variants must be unique")
		await expect(fs.stat(attemptRoot)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("refuses to reuse a run directory and preserves its contents", async () => {
		const parent = await root()
		const attemptRoot = path.join(parent, "existing-run")
		await fs.mkdir(attemptRoot)
		await fs.writeFile(path.join(attemptRoot, "sentinel"), "preserve")
		await expect(
			runLiveProblemSolvingCore(
				options(attemptRoot, { repositoryRoot: path.join(parent, "missing-repository") }),
			),
		).rejects.toMatchObject({ code: "EEXIST" })
		expect(await fs.readFile(path.join(attemptRoot, "sentinel"), "utf8")).toBe("preserve")
	})
})
