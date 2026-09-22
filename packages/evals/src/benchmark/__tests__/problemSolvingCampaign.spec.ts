import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

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
	it("grades a fresh workspace from the selected task and keeps failure classes distinct", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-problem-solving-campaign-"))
		try {
			const passed = await runProblemSolvingAttempt({
				evalRoot,
				repositoryRoot,
				taskId: "repo-cache-invalidation",
				attemptRoot: root,
				attemptId: "attempt-a",
				hostVersion: "1.122.1",
				provider: "live-copilot",
				modelId: "gpt-test",
				effort: "medium",
				runExtension: async (request) => {
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
			const blocked = await runProblemSolvingAttempt({
				evalRoot,
				repositoryRoot,
				taskId: "repo-cache-invalidation",
				attemptRoot: root,
				attemptId: "attempt-b",
				hostVersion: "1.122.1",
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
				hostVersion: "1.122.1",
				provider: "scripted",
				runExtension: async () =>
					host({ phase: "preflight", modelId: null, effort: null, usage: { ...usage, requests: null } }),
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
				hostVersion: "1.122.1",
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
				"1.122.1",
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
				usage: { inputTokens: 28000, outputTokens: 1200, cost: 0 },
				model: { id: "gpt-test", reasoningEffort: "high" },
			},
		})
		const unavailable = problemSolvingHostFromReceipts({
			buildIdentity: "abc123",
			tracePath: null,
			workflow: null,
			runnerFailure: "authentication-required",
		})
		expect(finished.status).toBe("passed")
		expect(finished.usage).toEqual({ cost: null, inputTokens: 28000, outputTokens: 1200, requests: 6 })
		expect(unavailable.status).toBe("blocked")
		expect(unavailable.failureClass).toBe("authentication")
		expect(unavailable.usage.requests).toBeNull()
	})
})
