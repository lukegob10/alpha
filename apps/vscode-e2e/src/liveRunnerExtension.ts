import * as path from "node:path"
import type { ExtensionContext } from "vscode"

import { assertRunnerAncestry } from "./hostOwnership"
import { assertOwnedTestRoot } from "./testProfile"
import { requireEvidenceRun } from "./evidence/paths"
import {
	validateLiveHostExpected,
	writeLiveHostReceipt,
	type LiveHostExpected,
	type LiveHostReceipt,
} from "./liveHostProtocol"
import { TestRunError, testRunFailureCode } from "./runFailure"

export type LiveSidecarEffects = {
	verifyOwner(): Promise<void>
	write(receipt: LiveHostReceipt): Promise<void>
	runSuite(): Promise<void>
	closeWindow(): PromiseLike<unknown>
}

/** One adapter around the existing suite. It does not own tasks or duplicate the workflow driver. */
export async function executeLiveSidecar(
	identity: LiveHostExpected & { pid: number; ppid: number },
	effects: LiveSidecarEffects,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted()
	validateLiveHostExpected(identity)
	await effects.verifyOwner()
	signal.throwIfAborted()
	const base = { ...identity, schemaVersion: 1 as const, launchKind: "development-sidecar" as const }
	await effects.write({ ...base, status: "started" })
	let outcome: LiveHostReceipt
	try {
		signal.throwIfAborted()
		await effects.runSuite()
		outcome = { ...base, status: "passed" }
	} catch (error) {
		outcome = { ...base, status: "failed", failure: testRunFailureCode(error, "host-failed") }
	}
	// A manual close/deactivation is not successful test completion. Never publish late receipts.
	signal.throwIfAborted()
	await effects.write(outcome)
	signal.throwIfAborted()
	// Normal close flushes VS Code storage. The external launcher, not this call, proves numeric exit.
	await effects.closeWindow()
}

let lifetime: AbortController | undefined

export function activate(context: ExtensionContext): void {
	if (lifetime) return
	const cancellation = new AbortController()
	lifetime = cancellation
	context.subscriptions.push({ dispose: () => cancellation.abort() })
	const start = async () => {
		const vscode = await import("vscode")
		const env = process.env
		const artifactsDir = env.ALPHA_E2E_ARTIFACTS_DIR ?? ""
		const profileDir = env.ALPHA_E2E_PROFILE_DIR ?? ""
		const workspace = env.ALPHA_E2E_WORKSPACE ?? ""
		const expected: LiveHostExpected = {
			runId: env.ALPHA_E2E_RUN_ID ?? "",
			nonce: env.ALPHA_E2E_LAUNCH_NONCE ?? "",
			actualVSCodeVersion: env.ALPHA_E2E_EXPECTED_VSCODE_VERSION ?? "",
		}
		await executeLiveSidecar(
			{ ...expected, pid: process.pid, ppid: process.ppid },
			{
				verifyOwner: async () => {
					if (
						env.ALPHA_E2E_LAUNCH_KIND !== "development-sidecar" ||
						context.extensionMode !== vscode.ExtensionMode.Development ||
						!["live-copilot", "scripted"].includes(env.ALPHA_E2E_PROVIDER_MODE ?? "") ||
						![artifactsDir, profileDir, workspace].every((value) => path.isAbsolute(value)) ||
						path.resolve(env.ALPHA_E2E_SHARED_DATA_DIR ?? "") !==
							path.join(profileDir, expected.actualVSCodeVersion, "shared-data")
					)
						throw new TestRunError("invalid-options", "Invalid development sidecar launch")
					if (vscode.version !== expected.actualVSCodeVersion)
						throw new TestRunError("host-version-mismatch", "Unexpected development host version")
					await assertRunnerAncestry(Number(env.ALPHA_E2E_RUNNER_PID))
					await assertOwnedTestRoot(profileDir, "profile")
					await assertOwnedTestRoot(workspace, "workspace")
					const runDirectory = await requireEvidenceRun(path.dirname(artifactsDir), expected.runId)
					if (path.resolve(artifactsDir) !== runDirectory)
						throw new TestRunError("invalid-options", "Mismatched sidecar evidence directory")
				},
				write: (receipt) => writeLiveHostReceipt(artifactsDir, receipt),
				runSuite: async () => (await import("./suite/index.js")).run(),
				closeWindow: () => vscode.commands.executeCommand("workbench.action.closeWindow"),
			},
			cancellation.signal,
		)
	}
	// Activation must not wait on its own suite or interactive setup. Its lifetime remains explicitly owned.
	void start().catch(() => {
		if (!cancellation.signal.aborted)
			console.error("Alpha live sidecar did not complete; inspect the run-owned receipts and profile lease.")
	})
}

export function deactivate(): void {
	lifetime?.abort()
}
