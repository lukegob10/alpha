import { strict as assert } from "node:assert"
import * as vscode from "vscode"
import { assertOwnedTestRoot } from "../testProfile"

/** Exact-host test facility, never imported by the shipped extension. */
export async function withAutomatedBrowserApprovals(run: () => Promise<void>): Promise<void> {
	assert.equal(vscode.version, "1.122.1", "Browser approval fixture requires the audited reference host")
	assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "live-copilot")
	assert.ok(process.env.ALPHA_E2E_PROFILE_DIR)
	assert.ok(process.env.ALPHA_E2E_WORKSPACE)
	await assertOwnedTestRoot(process.env.ALPHA_E2E_PROFILE_DIR)
	await assertOwnedTestRoot(process.env.ALPHA_E2E_WORKSPACE)
	const config = vscode.workspace.getConfiguration("chat.tools")
	const previous = config.inspect<unknown>("global.autoApprove")?.globalValue
	// 1.122.1's shouldAutoConfirm accepts an exact tool-ID map. Its test context
	// suppresses only the one-time opt-in dialog, without persisting that opt-in.
	// Do not replace this map with `true`: unrelated tools must retain approvals.
	const approved = { open_browser_page: true }
	const testContext = "vscode.chat.tools.global.autoApprove.testMode"
	await vscode.commands.executeCommand("setContext", testContext, true)
	try {
		await config.update("global.autoApprove", approved, vscode.ConfigurationTarget.Global)
		assert.deepEqual(vscode.workspace.getConfiguration("chat.tools").get("global.autoApprove"), approved)
		await run()
	} finally {
		try {
			await config.update("global.autoApprove", previous, vscode.ConfigurationTarget.Global)
		} finally {
			await vscode.commands.executeCommand("setContext", testContext, false)
		}
	}
}
