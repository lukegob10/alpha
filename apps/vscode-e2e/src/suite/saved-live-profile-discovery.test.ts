import assert from "node:assert/strict"
import { dirname, join, resolve } from "node:path"
import * as vscode from "vscode"

import { readBounded, requireEvidenceRun } from "../evidence/paths"
import { discoverLiveCopilotModels } from "../liveModelSelection"
import { writeJsonAtomically } from "./preflightEvidence"

suite("Saved live profile model discovery", function () {
	this.timeout(30_000)

	test("discovers native models without requests (ALPHA_E2E_SAVED_LIVE_DISCOVERY=1 only)", async function () {
		if (process.env.ALPHA_E2E_SAVED_LIVE_DISCOVERY !== "1") {
			this.skip()
			return
		}
		assert.equal(
			process.env.ALPHA_E2E_PROVIDER_MODE,
			"scripted",
			"Saved-profile discovery requires --provider scripted; live-copilot runs a separate readiness preflight",
		)
		assert.notEqual(process.env.ALPHA_E2E_SETUP, "1", "Run the discovery fixture without --setup")
		assert.equal(vscode.version, "1.125.0", "Saved-profile discovery requires the exact reference host")
		assert.equal(process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION, "1.125.0")
		const profileDir = process.env.ALPHA_E2E_PROFILE_DIR
		const artifactsDir = process.env.ALPHA_E2E_ARTIFACTS_DIR
		const runId = process.env.ALPHA_E2E_RUN_ID
		assert.ok(profileDir, "Saved-profile discovery requires a dedicated owned profile")
		assert.ok(artifactsDir && runId, "Saved-profile discovery requires run-owned evidence")
		assert.equal(resolve(artifactsDir), await requireEvidenceRun(dirname(artifactsDir), runId))
		const hostIdentity = JSON.parse(
			(await readBounded(join(artifactsDir, "host-identity.json"), 4_096)).toString("utf8"),
		) as { runId?: unknown; actualVSCodeVersion?: unknown; ownershipGate?: unknown }
		assert.equal(hostIdentity.runId, runId)
		assert.equal(hostIdentity.actualVSCodeVersion, vscode.version)
		assert.equal(hostIdentity.ownershipGate, "verified", "The existing host ownership gate must run first")

		const context = (
			api as unknown as { context?: Pick<vscode.ExtensionContext, "languageModelAccessInformation"> }
		).context
		assert.ok(context?.languageModelAccessInformation, "Alpha's native model-access context is required")
		let nativeModels: readonly vscode.LanguageModelChat[] = []
		const discoveryLm = new Proxy(vscode.lm, {
			get(target, property, receiver) {
				if (property === "selectChatModels") {
					return async (selector?: vscode.LanguageModelChatSelector) => {
						const selected = await target.selectChatModels(selector)
						nativeModels = [...selected]
						return selected
					}
				}
				return Reflect.get(target, property, receiver)
			},
		})
		const discovery = await discoverLiveCopilotModels(
			{ setup: true, artifactsDir },
			{
				// Observe the native query without enumerating guarded API getters or changing its model snapshot.
				loadVsCode: async () =>
					new Proxy(vscode, {
						get(target, property, receiver) {
							return property === "lm" ? discoveryLm : Reflect.get(target, property, receiver)
						},
					}),
			},
		)
		const receipt = {
			schemaVersion: 1,
			runId,
			actualVSCodeVersion: vscode.version,
			profileDir,
			discoveryStatus: discovery.status,
			modelCount: discovery.modelCount,
			discoveryErrorCode: discovery.error?.code,
			authorizationSource: "alpha-extension-context",
			models: discovery.availableModels.map(({ id, family }, index) => {
				const model = nativeModels[index]
				assert.ok(model, "Authorization requires the corresponding native model")
				assert.equal(model.id, id, "Authorization must retain the discovered model identity")
				return {
					id,
					family,
					// Preserve undefined as unknown instead of reporting a denial.
					canSendRequest: context.languageModelAccessInformation.canSendRequest(model) ?? null,
				}
			}),
			modelRequests: 0,
		}
		assert.ok(
			Buffer.byteLength(`${JSON.stringify(receipt, null, 2)}\n`, "utf8") <= 32_768,
			"Discovery receipt exceeds its limit",
		)
		await writeJsonAtomically(join(artifactsDir, "saved-live-profile-discovery.json"), receipt)
		assert.equal(discovery.artifact?.status, "written", "The sanitized discovery artifact must be written")
		assert.equal(
			discovery.status,
			"available",
			`Saved-profile model discovery failed: ${discovery.error?.code ?? discovery.readiness?.status ?? "unknown"}`,
		)
		assert.ok(discovery.modelCount > 0, "The saved profile must expose at least one real Copilot model")
		assert.equal(nativeModels.length, discovery.modelCount, "Authorization must use the discovered native models")
		// Availability and saved model access do not establish live request success.
	})
})
