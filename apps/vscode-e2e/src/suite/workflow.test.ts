import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { isDeepStrictEqual } from "node:util"
import * as vscode from "vscode"

import {
	assertWorkflowResult,
	readWorkflowSelection,
	WorkflowFailure,
	type WorkflowResult,
} from "../scenarios/contracts"
import { ExtensionWorkflowHost, readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { WorkflowRequestBudget } from "../scenarios/requestBudget"
import {
	createRepositoryFixture,
	readFixtureCommit,
	runFixtureTests,
	verifyRepositoryFixture,
} from "../scenarios/repositoryFixture"
import { accumulatedCases } from "../scenarios/scriptedWorkflow"
import {
	createDevelopmentFixture,
	disposeDevelopmentFixture,
	verifyDevelopmentFixture,
} from "../scenarios/developmentFixture"
import { runWorkflowScenario, type WorkflowCheckpoint } from "../scenarios/workflowDriver"

async function writeNewArtifact(filePath: string, value: unknown): Promise<void> {
	if (!path.isAbsolute(filePath)) throw new WorkflowFailure("configuration", "artifact_path_not_absolute", true)
	const parent = path.dirname(filePath)
	// Refuse symlink/reparse-directory destinations and never overwrite another run.
	let current = path.parse(parent).root
	for (const segment of path.relative(current, parent).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment)
		await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error
		})
		const stat = await fs.lstat(current)
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw new WorkflowFailure("configuration", "unsafe_artifact_parent", true)
	}
	await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
}

function parseCheckpoint(value: unknown): WorkflowCheckpoint {
	if (!value || typeof value !== "object") throw new WorkflowFailure("persistence", "invalid_checkpoint")
	const candidate = value as Partial<WorkflowCheckpoint>
	if (
		candidate.schemaVersion !== 1 ||
		candidate.scenarioId !== "reload-continuation" ||
		typeof candidate.taskId !== "string" ||
		typeof candidate.workspace !== "string" ||
		typeof candidate.hostVersion !== "string" ||
		typeof candidate.initialCommit !== "string" ||
		!/^[a-f0-9]{40,64}$/.test(candidate.initialCommit)
	)
		throw new WorkflowFailure("persistence", "invalid_checkpoint")
	return candidate as WorkflowCheckpoint
}

suite("Alpha realistic workflow scenarios", function () {
	if (!process.env.ALPHA_E2E_SCENARIO_ID) {
		test.skip("requires explicit scenario selection and a dedicated workspace", () => {})
		return
	}
	const selection = readWorkflowSelection(process.env)
	this.timeout(selection.timeoutMs + 30_000)

	test(`${selection.scenarioId} (${selection.phase})`, async () => {
		const runId = process.env.ALPHA_E2E_RUN_ID
		assert.ok(runId && /^[a-zA-Z0-9_-]{1,128}$/.test(runId), "A runner-assigned run ID is required")
		const workspacePath = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspacePath && path.isAbsolute(workspacePath), "A dedicated absolute test workspace is required")
		const workspace = await fs.realpath(workspacePath)
		const folders = vscode.workspace.workspaceFolders
		assert.equal(folders?.length, 1, "Workflow fixtures require one dedicated workspace folder")
		assert.equal(
			await fs.realpath(folders![0]!.uri.fsPath),
			workspace,
			"The test workspace must match the actual host",
		)
		const providerMode = process.env.ALPHA_E2E_PROVIDER_MODE ?? "unknown"
		const budget = new WorkflowRequestBudget(
			selection.requestCap,
			providerMode === "live-copilot" ? process.env.ALPHA_E2E_ACTUAL_MODEL_ID : undefined,
		)
		const host = new ExtensionWorkflowHost(globalThis.api, workspace, providerMode, budget, selection.timeoutMs)
		const checkpointPath = path.join(workspace, ".alpha-workflow-checkpoint.json")
		let result: WorkflowResult | undefined
		try {
			result = await runWorkflowScenario(
				{
					...selection,
					runId,
					workspace,
					hostVersion: vscode.version,
					providerMode,
					model: {
						id: process.env.ALPHA_E2E_ACTUAL_MODEL_ID,
						family: process.env.ALPHA_E2E_ACTUAL_MODEL_FAMILY,
						reasoningEffort: process.env.ALPHA_E2E_ACTUAL_REASONING_EFFORT,
					},
				},
				{
					host,
					development: {
						create: (scenarioId) => createDevelopmentFixture(workspace, scenarioId),
						verify: (scenarioId, phase) => verifyDevelopmentFixture(workspace, scenarioId, phase),
					},
					repository: {
						create: () => createRepositoryFixture(workspace),
						verify: (expected) => verifyRepositoryFixture(workspace, expected),
						test: () => runFixtureTests(workspace),
						readCommit: () => readFixtureCommit(workspace),
						verifyAccumulatedCases: async (step) => {
							const actual = await readBoundedJson(path.join(workspace, "test/workflow-cases.json"))
							return [
								{
									name: `dependent_cases_${step}`,
									passed: isDeepStrictEqual(actual, accumulatedCases(step)),
								},
							]
						},
					},
					checkpoint: {
						read: async () => parseCheckpoint(await readBoundedJson(checkpointPath)),
						write: (value) => writeNewArtifact(checkpointPath, value),
					},
				},
			)
		} finally {
			try {
				await host.dispose()
			} catch {
				if (result) {
					result.checks.push({ name: "scenario_cleanup", passed: false })
					if (result.status === "passed" || result.status === "checkpointed") {
						result.status = "failed"
						result.failure = { category: "harness", code: "scenario_cleanup_failed" }
					}
				}
			}
			disposeDevelopmentFixture(workspace)
			if (result) {
				result.model = { ...result.model, ...budget.model }
				result.requestsUsed = budget.used
				assertWorkflowResult(result)
				const output =
					process.env.ALPHA_E2E_SCENARIO_RESULT_PATH ??
					path.join(workspace, `.alpha-workflow-results-${selection.phase}.json`)
				await writeNewArtifact(output, result)
				console.log(`[alpha-workflow] ${JSON.stringify(result)}`)
			}
		}
		assert.ok(result)
		assert.ok(
			result.status === "passed" || result.status === "checkpointed",
			`Workflow ${result.status}: ${result.failure?.category}/${result.failure?.code}`,
		)
	})
})
