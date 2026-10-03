import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { ExecaHarnessProcessRunner } from "../../orchestration/index"

import {
	existingExtensionRunnerArguments,
	problemSolvingHostFromReceipts,
	runProblemSolvingAttempt,
	type ProblemSolvingHostResult,
} from "../problemSolvingCampaign"

const evalRoot = path.resolve(process.cwd(), "../../evals")
const repositoryRoot = path.resolve(process.cwd(), "../..")

const usage = { cost: null, inputTokens: null, outputTokens: null, requests: 4 }

function host(overrides: Partial<ProblemSolvingHostResult> = {}): ProblemSolvingHostResult {
	return {
		phase: "sample",
		status: "passed",
		buildIdentity: "sha256:" + "a".repeat(64),
		modelId: "gpt-test",
		effort: "medium",
		tracePath: "trace.json",
		usage,
		...overrides,
	}
}

describe("problem-solving extension campaign", () => {
	it.each(["selector", "modified-check", "deleted-check"])(
		"rejects an unchanged broken solution after %s tampering",
		async (change) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-grader-authority-"))
			try {
				const result = await runProblemSolvingAttempt({
					evalRoot,
					repositoryRoot,
					taskId: "repo-cache-invalidation",
					attemptRoot: root,
					attemptId: "integrity-attempt",
					hostVersion: "1.125.0",
					provider: "live-copilot",
					runExtension: async ({ workspace }) => {
						if (change === "selector") {
							const filename = path.join(workspace, "package.json")
							const manifest = JSON.parse(await fs.readFile(filename, "utf8"))
							manifest.scripts.test = "node --test test/pass.js"
							await fs.writeFile(filename, JSON.stringify(manifest))
							await fs.writeFile(
								path.join(workspace, "test", "pass.js"),
								"import test from 'node:test'; test('pass', () => {})\n",
							)
						} else {
							for (const file of await fs.readdir(path.join(workspace, "test"))) {
								const filename = path.join(workspace, "test", file)
								if (change === "deleted-check") await fs.unlink(filename)
								else
									await fs.writeFile(
										filename,
										"import test from 'node:test'; test('pass', () => {})\n",
									)
							}
						}
						return host()
					},
				})
				expect(result).toMatchObject({
					status: "failed",
					countsAsSolving: false,
					graderDecision: "outcome_failed",
				})
			} finally {
				await fs.rm(root, { recursive: true, force: true })
			}
		},
	)

	it("grades a fresh workspace from the selected task and keeps failure classes distinct", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-problem-solving-campaign-"))
		try {
			let modelWorkspace: string | undefined
			let independentCheckRuns = 0
			const runner = new ExecaHarnessProcessRunner()
			const passed = await runProblemSolvingAttempt({
				evalRoot,
				repositoryRoot,
				taskId: "repo-cache-invalidation",
				attemptRoot: root,
				attemptId: "attempt-a",
				hostVersion: "1.125.0",
				provider: "live-copilot",
				modelId: "gpt-test",
				effort: "medium",
				processRunner: {
					run: async (request) => {
						if (request.command === "node" && request.args.includes("--test")) {
							expect(request.cwd).not.toBe(modelWorkspace)
							expect(path.basename(request.cwd ?? "")).toMatch(/^alpha-grader-/)
							independentCheckRuns++
						}
						return runner.run(request)
					},
				},
				runExtension: async (request) => {
					modelWorkspace = request.workspace
					// A model-authored test remains work product, outside acceptance authority.
					await fs.writeFile(
						path.join(request.workspace, "test", "new-test.js"),
						"import test from 'node:test'; test('additional', () => {})\n",
					)
					await fs.writeFile(
						path.join(request.workspace, "src", "cache.js"),
						"export class ConfigCache {\n" +
							"\t#raw = new Map()\n" +
							"\tset(key, value) { this.#raw.set(key, value) }\n" +
							"\tgetPort() { return Number(this.#raw.get('port') ?? 80) }\n" +
							"\tgetOrigin() { return `http://localhost:${this.getPort()}` }\n" +
							"}\n",
					)
					return host()
				},
			})
			expect(independentCheckRuns).toBe(1)
			const blocked = await runProblemSolvingAttempt({
				evalRoot,
				repositoryRoot,
				taskId: "repo-cache-invalidation",
				attemptRoot: root,
				attemptId: "attempt-b",
				hostVersion: "1.125.0",
				provider: "live-copilot",
				modelId: "gpt-test",
				effort: "medium",
				runExtension: async () => host({ status: "failed", failureClass: "provider", usage }),
			})
			const preflight = await runProblemSolvingAttempt({
				evalRoot,
				repositoryRoot,
				taskId: "repo-cache-invalidation",
				attemptRoot: root,
				attemptId: "attempt-c",
				hostVersion: "1.125.0",
				provider: "scripted",
				runExtension: async () =>
					host({ phase: "preflight", modelId: null, effort: null, usage: { ...usage, requests: null } }),
			})
			const profileBusy = await runProblemSolvingAttempt({
				evalRoot,
				repositoryRoot,
				taskId: "repo-cache-invalidation",
				attemptRoot: root,
				attemptId: "attempt-d",
				hostVersion: "1.125.0",
				provider: "live-copilot",
				modelId: "gpt-test",
				effort: "medium",
				runExtension: async () =>
					host({
						status: "blocked",
						failureClass: "profile_busy",
						failureCategory: "runner",
						failureCode: "profile_busy",
						tracePath: null,
						usage: { cost: null, inputTokens: null, outputTokens: null, requests: null },
					}),
			})
			let baselinePrompt = ""
			let singleCommandPrompt = ""
			const baselinePromptReport = await runProblemSolvingAttempt({
				evalRoot,
				repositoryRoot,
				taskId: "repo-cache-invalidation",
				attemptRoot: root,
				attemptId: "attempt-prompt-baseline",
				repetition: 1,
				hostVersion: "1.125.0",
				provider: "live-copilot",
				modelId: "gpt-test",
				effort: "medium",
				runExtension: async (request) => {
					baselinePrompt = await fs.readFile(request.promptPath, "utf8")
					return host({ phase: "preflight", status: "failed", modelId: null, effort: null })
				},
			})
			const singleCommandPromptReport = await runProblemSolvingAttempt({
				evalRoot,
				repositoryRoot,
				taskId: "repo-cache-invalidation",
				attemptRoot: root,
				attemptId: "attempt-prompt-single-command",
				repetition: 1,
				promptVariant: "single-command",
				hostVersion: "1.125.0",
				provider: "live-copilot",
				modelId: "gpt-test",
				effort: "medium",
				runExtension: async (request) => {
					singleCommandPrompt = await fs.readFile(request.promptPath, "utf8")
					return host({ phase: "preflight", status: "failed", modelId: null, effort: null })
				},
			})

			expect(passed.countsAsSolving).toBe(true)
			expect(passed.graderDecision).toBe("passed")
			expect(passed.failureClass).toBeNull()
			expect(passed.workspace).not.toBe(blocked.workspace)
			expect(passed.profileDir).not.toBe(blocked.profileDir)
			await expect(fs.stat(passed.profileDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
			expect(blocked.failureClass).toBe("provider")
			expect(blocked.countsAsSolving).toBe(false)
			expect(blocked.usage).toEqual(usage)
			expect(preflight.countsAsSolving).toBe(false)
			expect(preflight.graderDecision).toBeNull()
			expect(preflight.usage.requests).toBeNull()
			expect(preflight.usage.cost).toBeNull()
			expect(profileBusy).toMatchObject({ status: "blocked", failureClass: "profile_busy", graderDecision: null })
			expect(baselinePromptReport.promptVariant).toBe("baseline")
			expect(baselinePromptReport.promptSha256).toBe(createHash("sha256").update(baselinePrompt).digest("hex"))
			expect(singleCommandPrompt.startsWith(`${baselinePrompt.trimEnd()}\n\n`)).toBe(true)
			expect(singleCommandPrompt).toContain("Run one direct command at a time")
			expect(singleCommandPromptReport).toMatchObject({
				promptVariant: "single-command",
				promptVariantInstructionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				repetition: 1,
			})
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	it("targets the existing VS Code extension runner", () => {
		const workspace = path.resolve("work", "workspace")
		const profileDir = path.resolve("work", "profile")
		const artifactsDir = path.resolve("work", "artifacts")
		const args = existingExtensionRunnerArguments(
			{
				workspace,
				profileDir,
				provider: "live-copilot",
				modelId: "gpt-test",
				effort: "high",
				hostVersion: "1.125.0",
				taskId: "repo-cache-invalidation",
				promptPath: path.join(workspace, "prompt.md"),
				artifactsDir,
				runId: "attempt-a",
				requestLimit: 40,
			},
			path.join(repositoryRoot, "apps", "vscode-e2e", "out", "runTest.js"),
		)
		expect(args).toEqual(
			expect.arrayContaining([
				"--provider",
				"live-copilot",
				"--vscode-version",
				"1.125.0",
				"--workspace",
				workspace,
				"--profile-dir",
				profileDir,
				"--model-id",
				"gpt-test",
			]),
		)
		expect(args).toEqual(
			expect.arrayContaining(["--scenario-id", "problem-solving-attempt", "--request-limit", "40"]),
		)
		expect(args.join(" ")).not.toMatch(/vscode-shim|apps\/cli/)
	})

	it("keeps a finished attempt gradable and leaves missing usage empty", () => {
		const finished = problemSolvingHostFromReceipts({
			buildIdentity: "abc123",
			tracePath: "C:/work/workflow-result.json",
			workflow: {
				status: "passed",
				requestsUsed: 6,
				requestsByPurpose: { task: 4, "reasoning-summary": 2 },
				usage: { inputTokens: 28000, outputTokens: 1200, cost: 0 },
				model: { id: "gpt-test", reasoningEffort: "high" },
				e2eApprovalPolicySha256: "A".repeat(64),
			},
		})
		const unavailable = problemSolvingHostFromReceipts({
			buildIdentity: "abc123",
			tracePath: null,
			workflow: null,
			runnerFailure: "authentication-required",
		})
		expect(finished.status).toBe("passed")
		expect(finished.usage).toEqual({
			cost: null,
			inputTokens: 28000,
			outputTokens: 1200,
			requests: 6,
			taskRequests: 4,
			summaryRequests: 2,
		})
		expect(finished.e2eApprovalPolicySha256).toBe("a".repeat(64))
		expect(unavailable.status).toBe("blocked")
		expect(unavailable.failureClass).toBe("authentication")
		expect(unavailable.usage.requests).toBeNull()
		const malformed = problemSolvingHostFromReceipts({
			buildIdentity: "abc123",
			tracePath: null,
			workflow: {
				status: "failed",
				requestsUsed: 6,
				requestsByPurpose: { task: 6, "reasoning-summary": 2 },
				failure: { category: "lifecycle", code: "unexpected_resume_task", providerCode: "request_timeout" },
			},
		})
		expect(malformed.usage.taskRequests).toBeUndefined()
		expect(malformed).toMatchObject({
			failureCategory: "lifecycle",
			failureCode: "unexpected_resume_task",
			providerFailureCode: "request_timeout",
		})
	})

	it("retains only allowlisted failure signals from workflow receipts", () => {
		const rejected = problemSolvingHostFromReceipts({
			buildIdentity: "abc123",
			tracePath: "C:/work/workflow-result.json",
			workflow: {
				status: "failed",
				failure: { category: "policy", code: "unexpected_command" },
			},
		})
		const untrusted = problemSolvingHostFromReceipts({
			buildIdentity: "abc123",
			tracePath: "C:/work/workflow-result.json",
			workflow: {
				status: "failed",
				failure: { category: "policy", code: "secret-command-content" },
				e2eApprovalPolicySha256: "secret-content",
			},
		})
		const scopedRejection = problemSolvingHostFromReceipts({
			buildIdentity: "abc123",
			tracePath: "C:/work/workflow-result.json",
			workflow: {
				status: "failed",
				failure: { category: "policy", code: "unexpected_command_outside_workspace_cwd" },
			},
		})
		const busy = problemSolvingHostFromReceipts({
			buildIdentity: "abc123",
			tracePath: null,
			workflow: null,
			runnerFailure: "profile-busy",
		})
		const timeout = problemSolvingHostFromReceipts({
			buildIdentity: "abc123",
			tracePath: null,
			workflow: null,
			runnerFailure: "scenario-timeout",
		})

		expect(rejected).toMatchObject({ failureCategory: "policy", failureCode: "unexpected_command" })
		expect(untrusted).toMatchObject({ failureCategory: "policy", failureCode: "other" })
		expect(untrusted.e2eApprovalPolicySha256).toBeNull()
		expect(scopedRejection).toMatchObject({
			failureCategory: "policy",
			failureCode: "unexpected_command_outside_workspace_cwd",
		})
		expect(busy).toMatchObject({
			status: "blocked",
			failureClass: "profile_busy",
			failureCategory: "runner",
			failureCode: "profile_busy",
		})
		expect(timeout).toMatchObject({
			status: "failed",
			failureClass: "budget",
			failureCategory: "timeout",
			failureCode: "runner_timeout",
		})
		expect(JSON.stringify(untrusted)).not.toContain("secret-command-content")
	})
})
