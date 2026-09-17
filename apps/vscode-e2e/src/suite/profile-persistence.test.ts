import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as vscode from "vscode"

import { setDefaultSuiteTimeout } from "./test-utils"

suite("Dedicated profile persistence", function () {
	setDefaultSuiteTimeout(this)

	test("preserves non-secret extension state across owned host restarts", async function () {
		const phase = process.env.ALPHA_E2E_PERSISTENCE_PHASE
		if (!phase) {
			this.skip()
			return
		}
		const nonce = process.env.ALPHA_E2E_PERSISTENCE_NONCE
		const artifactsDir = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(process.env.ALPHA_E2E_PROFILE_DIR, "The persistence probe requires a dedicated owned profile")
		assert.ok(artifactsDir, "The persistence probe requires run-owned evidence")
		assert.ok(phase === "prepare" || phase === "continue", "An explicit persistence phase is required")
		assert.ok(
			nonce && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(nonce),
			"A unique non-secret probe nonce is required",
		)

		// Exercise VS Code's real mementos, not Alpha's separate task-file persistence.
		// This existing host-internal API bridge reads only these probe-owned keys.
		const context = (api as unknown as { context: vscode.ExtensionContext }).context
		assert.ok(context?.globalState && context.workspaceState, "Alpha must expose its real extension context")
		const key = `alpha.e2e.profilePersistence.${nonce}`
		if (phase === "prepare") {
			assert.equal(context.globalState.get(key), undefined, "A probe nonce cannot be reused")
			assert.equal(context.workspaceState.get(key), undefined, "A probe nonce cannot be reused")
			assert.equal(await context.secrets.get(key), undefined, "A probe nonce cannot be reused")
			await context.globalState.update(key, nonce)
			await context.workspaceState.update(key, nonce)
			// This public random marker is not a credential. Never enumerate or read authentication keys.
			await context.secrets.store(key, nonce)
		}

		const globalStateMatches = context.globalState.get(key) === nonce
		const workspaceStateMatches = context.workspaceState.get(key) === nonce
		const syntheticSecretMatches = (await context.secrets.get(key)) === nonce
		await writeFile(
			join(artifactsDir, "profile-persistence.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId: process.env.ALPHA_E2E_RUN_ID,
				actualVSCodeVersion: vscode.version,
				extensionMode: context.extensionMode,
				phase,
				nonce,
				globalStateMatches,
				workspaceStateMatches,
				syntheticSecretMatches,
			}),
			{ flag: "wx", mode: 0o600 },
		)
		assert.equal(globalStateMatches, true, "Global extension state must survive closing and reopening this host")
		assert.equal(
			workspaceStateMatches,
			true,
			"Workspace extension state must survive closing and reopening this host",
		)
		assert.equal(syntheticSecretMatches, true, "The synthetic SecretStorage marker must survive host restart")
	})
})
