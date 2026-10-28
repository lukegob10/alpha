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
import { runReliabilityScenario } from "../scenarios/reliabilityDriver"
import {
	createDevelopmentFixture,
	disposeDevelopmentFixture,
	verifyDevelopmentFixture,
} from "../scenarios/developmentFixture"
import { runWorkflowScenario, type WorkflowCheckpoint } from "../scenarios/workflowDriver"
import { writeNewWorkflowArtifact } from "../scenarios/workflowArtifacts"
import {
	NativeExperimentCapture,
	readExperimentTaskLabel,
	readNativeExperimentContext,
	observedFinalExperimentResponse,
	observedExperimentVariantIdentity,
	writeExperimentArtifact,
} from "../evidence/experimentIdentity"
import { WorkflowProcessCapture } from "../evidence/workflowProcessCapture"

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
		const experimentEnabled = process.env.ALPHA_E2E_EXPERIMENT_EVIDENCE === "1"
		const experimentTask = experimentEnabled ? readExperimentTaskLabel(process.env) : undefined
		const experimentContext = experimentEnabled ? readNativeExperimentContext(process.env) : undefined
		const observedExtension = experimentEnabled
			? vscode.extensions.getExtension(process.env.ALPHA_E2E_EXTENSION_ID ?? "Alpha.alpha")
			: undefined
		const extensionPath =
			observedExtension?.isActive && observedExtension.exports === globalThis.api
				? observedExtension.extensionPath
				: undefined
		const nativeExperiment =
			experimentTask && extensionPath && ["scripted", "live-copilot"].includes(providerMode)
				? new NativeExperimentCapture({
						runDirectory: process.env.ALPHA_E2E_ARTIFACTS_DIR!,
						attemptId: runId,
						task: experimentTask,
						assignmentDigest: process.env.ALPHA_E2E_EXPERIMENT_ASSIGNMENT_DIGEST,
						prelaunchBuildManifestDigest: process.env.ALPHA_E2E_EXPERIMENT_BUILD_MANIFEST_DIGEST,
						executionTimeoutMs:
							process.env.ALPHA_E2E_EXPERIMENT_EXECUTION_TIMEOUT_MS === undefined
								? undefined
								: Number(process.env.ALPHA_E2E_EXPERIMENT_EXECUTION_TIMEOUT_MS),
						providerExtension: vscode.extensions.getExtension("GitHub.copilot-chat"),
						pairDigest: experimentContext?.pairDigest,
						extensionPath,
						hostVersion: vscode.version,
						providerMode: providerMode as "scripted" | "live-copilot",
						requestLimit: selection.requestCap,
						scenarioTimeoutMs: selection.timeoutMs,
						workspace,
						expectedWorkspaceDigest: process.env.ALPHA_E2E_EXPERIMENT_WORKSPACE_DIGEST,
					})
				: undefined
		if (experimentEnabled && !nativeExperiment) throw new Error("Native experiment host identity unavailable")
		await nativeExperiment?.prepare()
		const processCapture =
			nativeExperiment && experimentContext ? new WorkflowProcessCapture({ workspace }) : undefined
		await processCapture?.ready()
		if (nativeExperiment)
			budget.onTaskDispatch = (client, messages, options) => {
				nativeExperiment.onTaskRequest(client, messages, options)
				processCapture?.onModelRequest(messages)
			}
		const host = new ExtensionWorkflowHost(
			globalThis.api,
			workspace,
			providerMode,
			budget,
			selection.timeoutMs,
			"execa",
			nativeExperiment
				? {
						onTaskCreated: (task) => processCapture?.attachTask(task),
						onTaskPrompt: (text) => {
							nativeExperiment.onTaskPrompt(text)
							processCapture?.onTaskPrompt(text)
						},
						onConfiguration: (configuration, policy) =>
							nativeExperiment.onConfiguration(configuration, policy),
					}
				: undefined,
		)
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
					reliability: (options, repository) =>
						runReliabilityScenario(options, host, budget, repository, (name, value) =>
							writeNewWorkflowArtifact(path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, name), value),
						),
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
						write: (value) => writeNewWorkflowArtifact(checkpointPath, value),
					},
				},
			)
		} finally {
			const captureExperiment = async (settle: boolean) => {
				if (!nativeExperiment || !result || !experimentTask) return
				if (budget.dispatchObservationFailures) nativeExperiment.noteObservationFailure()
				const history =
					result.taskIds.length === 1
						? await host.readExperimentHistory(result.taskIds[0]!, settle)
						: undefined
				const capture = await nativeExperiment.finalize({ persist: false })
				const processEvidence =
					processCapture && experimentContext
						? await processCapture.finalize({
								binding: {
									taskIdentity: `${experimentTask.id}@${experimentTask.version}`,
									runId: experimentContext.runId,
									variantIdentity: capture.observedVariant
										? observedExperimentVariantIdentity(capture.observedVariant)
										: "unavailable:executed-variant",
									decisionPlanDigest: experimentContext.decisionPlanDigest,
									pairDigest: experimentContext.pairDigest,
								},
								validationCommands: experimentContext.validationCommands,
								requirements: experimentContext.requirements,
							})
						: undefined
				if (processEvidence)
					await writeExperimentArtifact(
						process.env.ALPHA_E2E_ARTIFACTS_DIR!,
						runId,
						"process-evidence.json",
						processEvidence,
					)
				await nativeExperiment.persist(
					capture,
					processEvidence
						? {
								sourceVersions: processEvidence.capture.sourceVersions,
								instructionDelivery: processEvidence.capture.instructionDelivery,
								hookDelivery: processEvidence.capture.hookDelivery,
							}
						: capture.processCoverage,
				)
				await writeExperimentArtifact(process.env.ALPHA_E2E_ARTIFACTS_DIR!, runId, "final-response.json", {
					schemaVersion: 1,
					kind: "alpha-native-experiment-final-response",
					runId,
					...observedFinalExperimentResponse(history),
					source: "native-task-assistant-history",
				})
			}
			const settledSuccess = result?.status === "passed" || result?.status === "checkpointed"
			if (settledSuccess) {
				try {
					await captureExperiment(true)
				} catch {
					if (result) {
						result.status = "failed"
						result.failure = { category: "harness", code: "experiment_capture_failed" }
					}
				}
			}
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
			if (!settledSuccess) {
				try {
					await captureExperiment(false)
				} catch {
					if (result) result.checks.push({ name: "experiment_capture", passed: false })
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
				await writeNewWorkflowArtifact(output, result)
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
