import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import * as vscode from "vscode"

import { ExtensionWorkflowHost } from "../scenarios/extensionWorkflowHost"
import { WorkflowRequestBudget } from "../scenarios/requestBudget"
import { createRepositoryFixture, runFixtureTests, verifyRepositoryFixture } from "../scenarios/repositoryFixture"

suite("Completion review after an implementation thread", function () {
	this.timeout(630_000)
	test("stays idle without accepting completion and admits a same-task follow-up", async function () {
		if (process.env.TEST_FILE !== "completion-idle.test") this.skip()
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		const provider = process.env.ALPHA_E2E_PROVIDER_MODE
		if (!workspace || !artifacts || !["live-copilot", "scripted"].includes(provider ?? "")) this.skip()
		assert.ok(workspace && artifacts && provider)
		assert.equal(await fs.realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath), await fs.realpath(workspace))
		await createRepositoryFixture(workspace)
		const budget = new WorkflowRequestBudget(70, process.env.ALPHA_E2E_ACTUAL_MODEL_ID)
		const host = new ExtensionWorkflowHost(globalThis.api, workspace, provider, budget, 600_000)
		try {
			const id = await host.start("review")
			await host.complete(id, "review")
			for (const phase of ["enhance", "commit", "followup"] as const) {
				await host.followup(id, phase)
				await host.complete(id, "review")
				await fs.appendFile(
					path.join(artifacts, "completion-idle-progress.jsonl"),
					JSON.stringify({ phase, taskId: id, requests: budget.used }) + "\n",
				)
			}
			assert.equal((await runFixtureTests(workspace)).exitCode, 0)
			for (const check of await verifyRepositoryFixture(workspace, "followup"))
				assert.ok(check.passed, check.name)
			await host.followup(id, "completionIdle")
			await host.complete(id, "review")
			const requestsAtReview = budget.used
			const before = await host.captureCompletionReview(id)
			// This measured quiet window intentionally exceeds the UI's 30-second stall threshold.
			// It is the workload under test, not synchronization for a race assertion.
			const began = Date.now()
			await delay(35_000)
			const after = await host.captureCompletionReview(id)
			const evidence = {
				schemaVersion: 1,
				runId: process.env.ALPHA_E2E_RUN_ID,
				hostVersion: vscode.version,
				provider,
				model: budget.model,
				reasoningEffort: process.env.ALPHA_E2E_ACTUAL_REASONING_EFFORT,
				taskId: id,
				elapsedMs: Date.now() - began,
				requestsAtReview,
				requestsAfterIdle: budget.used,
				states: [before, after],
			}
			await fs.writeFile(path.join(artifacts, "completion-idle.json"), JSON.stringify(evidence, null, 2), {
				flag: "wx",
			})
			assert.equal(budget.used, requestsAtReview, "Idle completion must not make another model request")
			assert.equal(after.liveTasksById[id]?.isWaitingForInput, true, "Host must publish the review boundary")
			assert.equal(after.agentLifecycleSnapshots[id]?.phase, "executing", "Exercise the pending completion tool")
			await host.followup(id, "verify")
			await host.complete(id)
			await host.assertUiTask(id)
			const trace = await host.inspect(id)
			assert.deepEqual(trace.errors, [])
			assert.equal(trace.callCount, trace.resultCount)
			assert.equal(trace.failedTurns, 0)
			assert.ok(trace.completedTurns > 0, "The implementation thread must durably complete")
			assert.ok(budget.used > requestsAtReview, "Follow-up must reach Copilot in the same task")
			await fs.writeFile(
				path.join(artifacts, "completion-idle-followup.json"),
				JSON.stringify({
					taskId: id,
					requestsUsed: budget.used,
					completedTurns: trace.completedTurns,
					callCount: trace.callCount,
					resultCount: trace.resultCount,
					errors: trace.errors,
				}),
				{ flag: "wx" },
			)
		} finally {
			await host.dispose()
		}
	})
})
