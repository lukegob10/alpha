import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { ExtensionWorkflowHost } from "../scenarios/extensionWorkflowHost"
import { LiveResponseFaultController } from "../scenarios/liveResponseFault"
import { WorkflowRequestBudget } from "../scenarios/requestBudget"
import { assertOwnedTestRoot } from "../testProfile"

suite("Copilot empty-response recovery", function () {
	this.timeout(210_000)
	test("recovers an injected no-choices failure without Continue or tool auto-approval", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "live-copilot")
		const workspace = process.env.ALPHA_E2E_WORKSPACE!
		await assertOwnedTestRoot(workspace)
		const budget = new WorkflowRequestBudget(6, process.env.ALPHA_E2E_ACTUAL_MODEL_ID)
		const fault = new LiveResponseFaultController()
		const host = new ExtensionWorkflowHost(globalThis.api, workspace, "live-copilot", budget, 180_000)
		let taskId: string | undefined
		let passed = false
		try {
			// This prompt requires only a plain answer. complete() fails on every
			// unexpected approval/resume ask; it never clicks Continue for this test.
			fault.arm("no-choices")
			budget.transformResponse = (response) => fault.wrap(response)
			taskId = await host.start("contextProbe", { autoApprovalEnabled: false })
			await host.complete(taskId)
			assert.ok(fault.injected && fault.observedParts > 0, "The injection must observe a real Copilot response")
			assert.equal(budget.used, 2, "Exactly one automatic retry should reach Copilot")
			const trace = await host.inspect(taskId)
			assert.deepEqual(trace.errors, [])
			assert.equal(trace.callCount, trace.resultCount)
			assert.ok(trace.completedTurns > 0)
			passed = true
		} finally {
			try {
				await host.dispose()
			} finally {
				await fs.writeFile(
					path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, "empty-response-recovery.json"),
					JSON.stringify(
						{
							schemaVersion: 1,
							passed,
							taskId,
							hostVersion: vscode.version,
							model: budget.model,
							requests: budget.used,
							fault: "injected-no-choices",
							injected: fault.injected,
							observedParts: fault.observedParts,
							autoApprovalEnabled: false,
							manualProviderRecovery: false,
						},
						null,
						2,
					),
					{ flag: "wx" },
				)
			}
		}
	})
})
