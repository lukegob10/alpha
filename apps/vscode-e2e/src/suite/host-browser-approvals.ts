import { strict as assert } from "node:assert"
import type { BrowserToolName } from "@alpha-code/types"
import * as vscode from "vscode"
import { assertOwnedTestWorkspace } from "../testProfile"

/** Exact-host test facility, never imported by the shipped extension. */
export async function withAutomatedBrowserApprovals(
	run: () => Promise<void>,
	tools: readonly BrowserToolName[] = ["open_browser_page"],
): Promise<void> {
	assert.equal(vscode.version, "1.141.0", "Browser approval fixture requires the audited reference host")
	const provider = process.env.ALPHA_E2E_PROVIDER_MODE
	const profile = process.env.ALPHA_E2E_PROFILE_DIR
	const workspace = process.env.ALPHA_E2E_WORKSPACE
	assert.ok(provider === "scripted" || (provider === "live-copilot" && profile))
	assert.ok(workspace)
	await assertOwnedTestWorkspace(workspace, profile)
	const config = vscode.workspace.getConfiguration("chat.tools")
	const previous = config.inspect<unknown>("global.autoApprove")?.globalValue
	// 1.141.0's shouldAutoConfirm accepts an exact tool-ID map. Its test context
	// suppresses only the one-time opt-in dialog, without persisting that opt-in.
	// Do not replace this map with `true`: unrelated tools must retain approvals.
	const approved = Object.fromEntries(tools.map((tool) => [tool, true]))
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
