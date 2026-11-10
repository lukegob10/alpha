import * as assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as vscode from "vscode"
import type { GlobalSettings, ProviderSettings } from "@alpha-code/types"
import { uiFixtureBarrier } from "../ui/fixtureBarrier"
import { waitFor } from "./utils"

interface SettingsHost {
	contextProxy: {
		getValue<K extends keyof GlobalSettings>(key: K): GlobalSettings[K]
		setValue<K extends keyof GlobalSettings>(key: K, value: GlobalSettings[K]): Promise<void>
	}
	upsertProviderProfile(name: string, configuration: ProviderSettings): Promise<unknown>
	activateProviderProfile(args: { name: string }): Promise<unknown>
	providerSettingsManager: { getProfile(args: { name: string }): Promise<unknown> }
	postStateToWebview(): Promise<void>
}

suite("Rendered settings", function () {
	this.timeout(300_000)
	test("uses four settings pages, buffered preferences, and contextual resource managers", async function () {
		if (!process.env.ALPHA_UI_ACCEPTANCE_NONCE) this.skip()
		assert.equal(vscode.version, "1.141.0")
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(workspace, "The owned renderer fixture requires its disposable workspace")
		await promisify(execFile)("git", ["init", "--initial-branch=main", workspace], { windowsHide: true })
		const provider = (globalThis.api as unknown as { sidebarProvider: SettingsHost }).sidebarProvider
		const name = "Settings fixture"
		await provider.upsertProviderProfile(name, {
			apiProvider: "openai",
			openAiApiKey: "local-fixture",
			openAiBaseUrl: "http://127.0.0.1:9/v1",
			openAiModelId: "gpt-6-luna",
		})
		await provider.activateProviderProfile({ name })
		await provider.contextProxy.setValue("reasoningBlockCollapsed", true)
		await provider.contextProxy.setValue("soundEnabled", false)
		await provider.contextProxy.setValue("approvalMode", "ask")
		await provider.contextProxy.setValue("enableCheckpoints", true)
		const terminalOverrides = {
			terminalShellIntegrationDisabled: false,
			terminalShellIntegrationTimeout: 17_000,
			terminalCommandDelay: 120,
			terminalPowershellCounter: true,
			terminalZshClearEolMark: false,
			terminalZshOhMy: true,
			terminalZshP10k: true,
			terminalZdotdir: true,
		} satisfies Partial<GlobalSettings>
		const terminalKeys = [
			"terminalShellIntegrationDisabled",
			"terminalShellIntegrationTimeout",
			"terminalCommandDelay",
			"terminalPowershellCounter",
			"terminalZshClearEolMark",
			"terminalZshOhMy",
			"terminalZshP10k",
			"terminalZdotdir",
		] as const
		for (const key of terminalKeys) await provider.contextProxy.setValue(key, terminalOverrides[key])
		const readTerminalOverrides = () =>
			Object.fromEntries(terminalKeys.map((key) => [key, provider.contextProxy.getValue(key)]))
		const profile = await provider.providerSettingsManager.getProfile({ name })
		await vscode.workspace
			.getConfiguration("workbench")
			.update("colorTheme", "Default Dark Modern", vscode.ConfigurationTarget.Global)
		await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
		await waitFor(() => globalThis.api.isReady(), { timeout: 20_000 })
		await provider.postStateToWebview()
		await vscode.commands.executeCommand("alpha.settingsButtonClicked")
		await uiFixtureBarrier("settings-layout", { version: vscode.version })
		await uiFixtureBarrier("settings-buffered-discard")
		assert.equal(
			provider.contextProxy.getValue("reasoningBlockCollapsed"),
			true,
			"Discarding a rendered edit must preserve the stored preference",
		)
		await vscode.commands.executeCommand("alpha.settingsButtonClicked")
		await uiFixtureBarrier("settings-save")
		await waitFor(() => provider.contextProxy.getValue("reasoningBlockCollapsed") === false, {
			timeout: 15_000,
			description: "the rendered preference Save to persist",
		})
		assert.equal(
			provider.contextProxy.getValue("approvalMode"),
			"ask",
			"Saving appearance must preserve permissions",
		)
		assert.equal(
			provider.contextProxy.getValue("soundEnabled"),
			false,
			"Saving appearance must preserve sound opt-out",
		)
		assert.deepEqual(
			await provider.providerSettingsManager.getProfile({ name }),
			profile,
			"Saving a preference must preserve the selected provider profile",
		)
		assert.deepEqual(
			readTerminalOverrides(),
			terminalOverrides,
			"Saving a visible preference must preserve internally supported terminal overrides",
		)
		await provider.postStateToWebview()
		await uiFixtureBarrier("settings-resources")
		await vscode.commands.executeCommand("alpha.settingsButtonClicked")
		await vscode.workspace
			.getConfiguration("workbench")
			.update("colorTheme", "Default Light Modern", vscode.ConfigurationTarget.Global)
		await uiFixtureBarrier("settings-light")
		await uiFixtureBarrier("settings-narrow")
		await uiFixtureBarrier("settings-tiny")
		assert.deepEqual(
			readTerminalOverrides(),
			terminalOverrides,
			"Discarding visible edits must preserve internally supported terminal overrides",
		)
		assert.equal(
			provider.contextProxy.getValue("reasoningBlockCollapsed"),
			false,
			"Discarding in a very narrow sidebar must retain the previously saved preference",
		)
	})
})
