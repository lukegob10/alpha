import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isDeepStrictEqual } from "node:util"

import { projectWorkflowResult } from "../extensionAdapter"
import { runWorkflowScenario } from "../../scenarios/workflowDriver"
import { assertWorkflowResult, MAX_WORKFLOW_CHECKS, MAX_WORKFLOW_TURNS } from "../../scenarios/contracts"
import {
	FIXTURE_CONTENT,
	FIXTURE_FILES,
	createRepositoryFixture,
	readFixtureCommit,
	runFixtureTests,
	verifyRepositoryFixture,
} from "../../scenarios/repositoryFixture"
import type { ScenarioRequest } from "../types"

const execFileAsync = promisify(execFile)

test("the maximum-length driver result with real repository checks crosses the campaign boundary", async (context) => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-workflow-contract-")))
	context.after(async () => {
		assert.equal(await fs.realpath(root), root)
		assert.match(path.basename(root), /^alpha-workflow-contract-/)
		await fs.rm(root, { recursive: true, force: true })
	})
	const workspace = path.join(root, "fixture")
	await fs.mkdir(workspace)
	await fs.writeFile(
		path.join(workspace, FIXTURE_FILES.runnerMarker),
		JSON.stringify({ schemaVersion: 1, purpose: "alpha-vscode-e2e", kind: "workspace" }),
	)
	const request: ScenarioRequest = {
		campaignId: "contract-test",
		attemptId: "attempt-0001",
		host: { version: "1.122.1" },
		scenarioId: "long-thread",
		sample: 1,
		phase: "sample",
		provider: { mode: "scripted" },
		requestLimit: 60,
	}
	let completed = 0
	const cases: Array<{ step: number; left: number; right: number; sum: number }> = []
	const write = (relative: string, value: string) => fs.writeFile(path.join(workspace, relative), value)
	const git = (args: string[]) =>
		execFileAsync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=.git/alpha-empty-hooks", ...args], {
			cwd: workspace,
			shell: false,
			windowsHide: true,
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		})
	const unexpected = async () => {
		throw new Error("Unexpected cancellation/reload in the long-thread fixture")
	}
	const result = await runWorkflowScenario(
		{
			runId: "attempt-0001-run",
			scenarioId: "long-thread",
			phase: "run",
			workspace,
			hostVersion: request.host.version,
			providerMode: "scripted",
			model: { id: "fixture" },
			turns: MAX_WORKFLOW_TURNS,
		},
		{
			host: {
				start: async (prompt) => {
					assert.equal(prompt, "review")
					return "task-1"
				},
				followup: async (taskId, prompt, step) => {
					assert.equal(taskId, "task-1")
					if (prompt === "enhance") {
						await write(FIXTURE_FILES.module, FIXTURE_CONTENT.enhancedModule)
						await write(FIXTURE_FILES.primaryTest, FIXTURE_CONTENT.enhancedTest)
					} else if (prompt === "commit") {
						await git(["add", "--", FIXTURE_FILES.module, FIXTURE_FILES.primaryTest])
						await git([
							"-c",
							"user.name=AlphaFixture",
							"-c",
							"user.email=fixture@example.invalid",
							"-c",
							"commit.gpgSign=false",
							"commit",
							"--quiet",
							"--no-verify",
							"-m",
							"Fixture enhancement",
						])
					} else if (prompt === "followup") {
						await write(FIXTURE_FILES.primaryTest, FIXTURE_CONTENT.followupPrimaryTest)
						await write(FIXTURE_FILES.readme, FIXTURE_CONTENT.followupReadme)
					} else {
						assert.equal(prompt, "extend")
						assert.equal(step, cases.length + 1)
						const left = cases.at(-1)?.sum ?? 0
						cases.push({ step: step!, left, right: step!, sum: left + step! })
						await write(FIXTURE_FILES.workflowCases, JSON.stringify(cases))
						await write(FIXTURE_FILES.primaryTest, FIXTURE_CONTENT.extendedTest)
					}
				},
				complete: async () => {
					completed++
				},
				assertUiTask: async (taskId) => {
					assert.equal(taskId, "task-1")
				},
				waitForCommandApproval: unexpected,
				cancel: unexpected,
				resume: unexpected,
				inspect: async () => ({
					callCount: completed,
					resultCount: completed,
					completedTurns: completed,
					failedTurns: 0,
					cancelledTurns: 0,
					errors: [],
				}),
				requestsUsed: () => completed,
			},
			repository: {
				create: () => createRepositoryFixture(workspace),
				verify: (expected) => verifyRepositoryFixture(workspace, expected),
				test: () => runFixtureTests(workspace),
				readCommit: () => readFixtureCommit(workspace),
				verifyAccumulatedCases: async (step) => [
					{
						name: `dependent_cases_${step}`,
						passed: isDeepStrictEqual(
							JSON.parse(await fs.readFile(path.join(workspace, FIXTURE_FILES.workflowCases), "utf8")),
							cases,
						),
					},
				],
			},
			checkpoint: { read: unexpected, write: unexpected },
		},
	)
	assert.equal(result.status, "passed", JSON.stringify(result.failure))
	assert.equal(completed, MAX_WORKFLOW_TURNS)
	assert.ok(result.checks.length > 200, "the actual fixture must exercise the former consumer limit")
	assert.ok(result.checks.length < MAX_WORKFLOW_CHECKS)
	assertWorkflowResult(result)
	const projected = projectWorkflowResult(JSON.parse(JSON.stringify(result)), request, "run")
	assert.equal(projected.result.status, "passed")
	assert.equal(projected.result.usage.requests, completed)
})
