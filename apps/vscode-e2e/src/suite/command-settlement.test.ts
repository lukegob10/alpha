import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { ExtensionWorkflowHost, readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { WorkflowRequestBudget } from "../scenarios/requestBudget"
import { SETTLEMENT_ORACLE, settlementRevisions } from "../scenarios/commandSettlement"
import { assertOwnedTestRoot } from "../testProfile"

suite("Command receipt settlement", function () {
	this.timeout(600_000)
	test("injected receipt failure stops the real task at its original error", async () => {
		const workspace = process.env.ALPHA_E2E_WORKSPACE!
		await assertOwnedTestRoot(workspace)
		await fs.writeFile(path.join(workspace, ".alphaignore"), ".alpha-*\n", { flag: "wx" })
		const provider = process.env.ALPHA_E2E_PROVIDER_MODE!
		const budget = new WorkflowRequestBudget(
			12,
			provider === "live-copilot" ? process.env.ALPHA_E2E_ACTUAL_MODEL_ID : undefined,
		)
		const host = new ExtensionWorkflowHost(globalThis.api, workspace, provider, budget, 120_000)
		const fault = host.injectReceiptFailureOnce()
		let taskId: string | undefined
		try {
			taskId = await host.start("commandSettlement")
			await host.complete(taskId, "blocked")
			assert.ok(fault.injected(), "The failure must follow an actual model-requested file edit")
			const trace = await host.inspect(taskId, "blocked")
			assert.deepEqual(trace.errors, [])
			assert.equal(trace.callCount, trace.resultCount)
			assert.equal(trace.completedTurns, 0)
			const settlement = host.captureSettlement(taskId)
			const runtime = settlement.runtime as {
				commands: unknown[]
				obligations: Array<{ pendingReservations: unknown[] }>
			}
			assert.equal(runtime.commands.length, 0, "No later Node command should mask the earlier receipt failure")
			assert.ok(runtime.obligations.some((item) => item.pendingReservations.length > 0))
			const state = await host.captureTaskState(taskId)
			assert.ok(JSON.stringify(state).includes("workspace change receipt could not be finalized"))
			assert.ok(!JSON.stringify(state).includes("runtime settlement did not finish within 30 seconds"))
			await fs.writeFile(
				path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, "receipt-fault.json"),
				JSON.stringify(
					{
						hostVersion: vscode.version,
						provider,
						model: budget.model,
						requests: budget.used,
						injected: fault.injected(),
						taskId,
						trace,
						settlement,
						state,
					},
					null,
					2,
				),
				{ flag: "wx" },
			)
		} finally {
			fault.restore()
			await host.dispose()
		}
	})
	for (const terminalProvider of ["execa", "vscode"] as const) {
		test(`HTML edits and Node output through ${terminalProvider}`, async () => {
			const workspace = process.env.ALPHA_E2E_WORKSPACE!
			await assertOwnedTestRoot(workspace)
			assert.equal(vscode.workspace.workspaceFolders?.length, 1)
			assert.equal(
				await fs.realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath),
				await fs.realpath(workspace),
			)
			// Each invocation owns a fresh workspace; refuse to overwrite a previous run.
			await fs.writeFile(path.join(workspace, ".alphaignore"), ".alpha-*\n", { flag: "wx" })
			await fs.writeFile(path.join(workspace, ".alpha-receipt-oracle.cjs"), SETTLEMENT_ORACLE, { flag: "wx" })
			const provider = process.env.ALPHA_E2E_PROVIDER_MODE!
			const revisions = settlementRevisions(process.env.ALPHA_E2E_SETTLEMENT_TURNS)
			// Keep a finite run budget while allowing the extended workload to finish its additional turns.
			const requestLimit = Math.max(60, revisions.length * 8)
			const budget = new WorkflowRequestBudget(
				requestLimit,
				provider === "live-copilot" ? process.env.ALPHA_E2E_ACTUAL_MODEL_ID : undefined,
			)
			const host = new ExtensionWorkflowHost(
				globalThis.api,
				workspace,
				provider,
				budget,
				570_000,
				terminalProvider,
			)
			const phases: unknown[] = []
			let taskId: string | undefined
			let failure: string | undefined
			try {
				for (const revision of revisions) {
					const began = Date.now()
					const requestsBefore = budget.used
					if (!taskId) taskId = await host.start("commandSettlement")
					else await host.followup(taskId, "commandSettlement", revision)
					await host.complete(taskId)
					await host.assertUiTask(taskId)
					const trace = await host.inspect(taskId)
					assert.deepEqual(trace.errors, [])
					assert.equal(trace.callCount, trace.resultCount)
					assert.equal(trace.failedTurns, 0)
					const settlement = host.captureSettlement(taskId)
					const runtime = settlement.runtime as {
						commands: Array<{ status: string; exitCode?: number }>
						obligations: Array<{ pendingReservations: unknown[]; scopeUnresolved: boolean }>
					}
					assert.ok(runtime.commands.length >= revision)
					assert.ok(
						runtime.commands.every((command) => command.status === "succeeded" && command.exitCode === 0),
					)
					assert.ok(
						runtime.obligations.every(
							(item) => item.pendingReservations.length === 0 && !item.scopeUnresolved,
						),
					)
					assert.equal(
						settlement.shellIntegrationWarnings,
						0,
						"A requested integrated-terminal run must not silently fall back",
					)
					assert.deepEqual(await readBoundedJson(path.join(workspace, "build-receipt.json")), {
						revision,
						checks: 5,
						passed: true,
					})
					assert.equal(
						await fs.readFile(path.join(workspace, ".alpha-receipt-oracle.cjs"), "utf8"),
						SETTLEMENT_ORACLE,
					)
					phases.push({
						revision,
						elapsedMs: Date.now() - began,
						requestsBefore,
						requestsAfter: budget.used,
						trace,
						settlement,
					})
				}
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error)
				throw error
			} finally {
				try {
					const state = taskId ? await host.captureTaskState(taskId) : undefined
					await fs.writeFile(
						path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, "command-settlement.json"),
						JSON.stringify(
							{
								hostVersion: vscode.version,
								provider,
								terminalProvider,
								model: budget.model,
								requests: budget.used,
								requestLimit,
								taskId,
								phases,
								failure,
								state,
							},
							null,
							2,
						),
						{ flag: "wx" },
					)
				} finally {
					await host.dispose()
				}
			}
		})
	}
})
